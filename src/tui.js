// Układ ekranu w stylu Claude Code:
//   góra  — stały header: logo EXOTICCODE, model/effort/folder, komendy, maskotka po prawej
//   środek — przewijany czat (region przewijania DECSTBM)
//   dół   — stały: linia statusu (spinner + co robi maskotka), pole czatu w ramce, info
// Wszystko, co program wypisuje przez process.stdout, trafia do środkowego regionu.

import { rawWrite, rawWriteErr } from './term.js';
import { hud, MASCOT_W, MASCOT_ROWS } from './mascot.js';
import { renderSuggestions, width as textWidth } from './editor.js';
import { useInput } from './input.js';
import { todos } from './todos.js';

const stdout = process.stdout;
const HEADER = MASCOT_ROWS + 1; // wiersze maskotki + linia oddzielająca
const MAX_INPUT_ROWS = 8;

const CSI = '\x1b[';
const cup = (row, col) => `${CSI}${row};${col}H`;
const rgb = (r, g, b) => (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const pink = rgb(236, 72, 153);
const cyan = rgb(34, 211, 238);
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;

const FONT = {
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  X: ['██╗  ██╗', '╚██╗██╔╝', ' ╚███╔╝ ', ' ██╔██╗ ', '██╔╝ ██╗', '╚═╝  ╚═╝'],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
};
const BANNER = Array.from({ length: 6 }, (_, r) => [...'EXOTICCODE'].map((ch) => FONT[ch][r]).join(''));
const BANNER_W = [...BANNER[0]].length;

function gradient(text, total = [...text].length) {
  const a = [236, 72, 153];
  const b = [34, 211, 238];
  return [...text]
    .map((ch, i) => {
      const t = total > 1 ? i / (total - 1) : 0;
      const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
      return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${ch}`;
    })
    .join('') + '\x1b[39m';
}

function charWidth(cp) {
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp === 0x2615 || cp === 0x26a1
  ) return 2;
  return 1;
}

/** Przycina tekst z kodami ANSI do `max` kolumn (kody zostają nietknięte). */
export function fitAnsi(s, max) {
  let out = '';
  let w = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > max) {
      out += '\x1b[0m';
      break;
    }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}

const fitPath = (p, n) => (p.length > n ? '…' + p.slice(p.length - n + 1) : p);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));

export const MODES = {
  manual: { icon: '⏵', label: 'ręczny', hint: 'pyta o zgodę na zapis i komendy' },
  auto: { icon: '⏵⏵', label: 'auto', hint: 'sam edytuje pliki, pyta o komendy' },
  bypass: { icon: '⚠', label: 'bypass permissions', hint: 'nie pyta o nic' },
  plan: { icon: '⏸', label: 'plan', hint: 'tylko czyta i planuje' },
};
export const MODE_ORDER = ['manual', 'auto', 'bypass', 'plan'];

class Tui {
  constructor() {
    this.active = false;
    this.info = {};
    this.status = null;
    this.prompt = null; // własna etykieta pola (np. przy pytaniu)
    this.queued = 0;
    this.showMascot = true;
    this.footerH = 0;
    this.o = { row: 0, col: 0, pending: false, saved: null };
    this.onResize = () => this.redraw(false);
    this.cursor = { row: 1, col: 1 };
  }

  get rows() {
    return stdout.rows || 24;
  }
  get cols() {
    return stdout.columns || 80;
  }
  get top() {
    return HEADER + 1;
  }
  get bottom() {
    return this.rows - this.footerH;
  }
  get regionH() {
    return Math.max(1, this.bottom - this.top + 1);
  }

  /** Włącza układ. `input` — InputBuffer, `onKeys` — obsługa klawiszy pola. */
  enable({ input, onKeys }) {
    if (this.active) return true;
    if (!stdout.isTTY || this.rows < 18 || this.cols < 50) return false;
    this.active = true;
    this.input = input;
    stdout.write = (chunk, enc, cb) => {
      this.print(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    process.stderr.write = stdout.write;
    this.releaseInput = useInput((d) => {
      onKeys(d);
      this.drawFooter();
    });
    if (!this.hudHooked) {
      this.hudHooked = true;
      hud.onChange(() => this.active && this.drawFooter());
      todos.onChange(() => this.active && this.drawFooter());
    }
    this.timer = setInterval(() => this.tick(), 180);
    this.timer.unref?.();
    stdout.on('resize', this.onResize);
    if (!this.exitHook) {
      this.exitHook = () => this.active && rawWrite(`${CSI}r${cup(this.rows, 1)}\n\x1b[?2004l\x1b[?25h`);
      process.on('exit', this.exitHook);
    }
    rawWrite('\x1b[?2004h');
    this.redraw(true);
    return true;
  }

  /** Wyłącza układ. `keep` — zostaw treść na ekranie (przy wyjściu z programu). */
  disable({ keep = false } = {}) {
    if (!this.active) return;
    this.active = false;
    delete stdout.write;
    delete process.stderr.write;
    if (stdout.write !== rawWrite) stdout.write = rawWrite;
    if (process.stderr.write !== rawWriteErr) process.stderr.write = rawWriteErr;
    this.releaseInput?.();
    clearInterval(this.timer);
    stdout.off('resize', this.onResize);
    if (keep) rawWrite(`${CSI}r${cup(this.rows, 1)}\n\x1b[?2004l\x1b[?25h`);
    else rawWrite(`${CSI}r${CSI}2J${CSI}3J${CSI}H\x1b[?2004l\x1b[?25h`);
  }

  // ---------- rysowanie całości ----------

  /** Rysuje header i dół. `clear` — wyczyść też czat. */
  redraw(clear) {
    if (!this.active) return;
    this.footerH = this.footerLines().length;
    let s = `${CSI}?25l${CSI}r`;
    if (clear) {
      s += `${CSI}2J${CSI}3J${CSI}H`;
      this.o = { row: 0, col: 0, pending: false, saved: null };
    } else {
      this.o.row = Math.min(this.o.row, this.regionH - 1);
      this.o.col = Math.min(this.o.col, this.cols - 1);
    }
    s += `${CSI}${this.top};${this.bottom}r`;
    s += this.headerString();
    rawWrite(s);
    this.drawFooter();
  }

  clear() {
    this.redraw(true);
  }

  // ---------- header ----------

  headerString() {
    const cols = this.cols;
    const mascotOn = this.showMascot && !process.env.NO_COLOR;
    const leftW = cols - (mascotOn ? MASCOT_W + 3 : 1);
    const i = this.info;
    const lines = [];
    if (leftW >= BANNER_W + 2) {
      for (const row of BANNER) lines.push(' ' + bold(gradient(row, BANNER_W)));
    } else {
      lines.push('', ' ' + bold(gradient('EXOTICCODE')) + ' ' + dim('v' + (i.version || '')), ' ' + cyan('agent AI do kodowania'), '', '', '');
    }
    const folder = fitPath(i.cwd || '', Math.max(10, leftW - 40 - (i.model || '').length));
    lines.push(` ${dim('model:')} ${bold(i.model || '—')}  ${dim('·')}  ${dim('effort:')} ${i.effort || 'auto'}  ${dim('·')}  ${dim('folder:')} ${folder}`);
    const key = (k, d) => (d ? `${cyan(k)} ${dim(d)}` : cyan(k));
    lines.push(
      ' ' +
        // od najważniejszych — w wąskim oknie ucina się koniec
        [
          key('/help', 'pomoc'),
          key('/model'),
          key('Ctrl+C×2', 'wyjście'),
          key('Shift+Tab', 'tryb'),
          key('/new', 'nowy czat'),
          key('/skills'),
          key('/effort'),
        ].join(dim(' · ')),
    );
    let s = '';
    for (let r = 0; r < MASCOT_ROWS; r++) s += cup(r + 1, 1) + `${CSI}2K` + fitAnsi(lines[r] || '', leftW);
    s += cup(HEADER, 1) + `${CSI}2K` + dim('─'.repeat(cols));
    if (mascotOn) s += this.mascotString();
    return s;
  }

  mascotString() {
    const x0 = this.cols - MASCOT_W;
    const sprite = hud.sprite();
    let s = '';
    for (let r = 0; r < sprite.length; r++) s += cup(r + 1, x0) + sprite[r];
    return s + '\x1b[0m';
  }

  tick() {
    if (!this.active) return;
    hud.tick();
    if (this.showMascot && !process.env.NO_COLOR) rawWrite('\x1b7' + this.mascotString() + '\x1b8');
  }

  update(info) {
    Object.assign(this.info, info);
    if (!this.active) return;
    rawWrite('\x1b7' + this.headerString() + '\x1b8');
    this.drawFooter();
  }

  // ---------- dół: status + pole czatu + info ----------

  setStatus(text) {
    this.status = text;
    if (this.active) this.drawFooter();
  }

  setPrompt(label) {
    this.prompt = label;
    if (this.active) this.drawFooter();
  }

  footerLines() {
    const cols = this.cols;
    const lines = [];
    // 1. status: spinner + co robi maskotka
    const [icon, label] = hud.label();
    const mascotText = `${pink(icon)} ${hud.state === 'idle' ? dim(label) : label}`;
    // bieżący krok z listy zadań (todo_write)
    const step = todos.current();
    const stepText = step ? `${yellow('◐')} ${dim(`${step.done + 1}/${step.total}`)} ${bold(step.item.content)}` : '';
    const parts = [this.status, stepText, mascotText].filter(Boolean);
    lines.push(fitAnsi(' ' + parts.join('   ' + dim('·') + '  '), cols));

    // 2. pole w ramce
    const inner = cols - 4;
    const label0 = this.prompt || '❯ ';
    const pw = textWidth(label0);
    const textW = Math.max(5, inner - pw);
    const buf = this.input?.text || '';
    const pos = this.input?.pos || 0;
    const rows = [];
    let cur = { row: 0, col: 0 };
    let offset = 0;
    const logical = buf.split('\n');
    logical.forEach((line, li) => {
      const chars = Array.from(line);
      const start = rows.length;
      if (!chars.length) rows.push('');
      for (let k = 0; k < chars.length; k += textW) rows.push(chars.slice(k, k + textW).join(''));
      if (pos >= offset && pos <= offset + line.length) {
        const x = Array.from(line.slice(0, pos - offset)).length;
        let r = Math.floor(x / textW);
        if (r >= rows.length - start) rows.push('');
        cur = { row: start + r, col: x - r * textW };
      }
      offset += line.length + 1;
      void li;
    });
    let first = 0;
    if (rows.length > MAX_INPUT_ROWS) first = Math.min(Math.max(0, cur.row - MAX_INPUT_ROWS + 1), rows.length - MAX_INPUT_ROWS);
    const shown = rows.slice(first, first + MAX_INPUT_ROWS);
    const border = this.info.mode === 'bypass' ? yellow : this.info.mode === 'plan' ? cyan : pink;
    lines.push(border('╭' + '─'.repeat(cols - 2) + '╮'));
    const inputTop = lines.length;
    shown.forEach((text, k) => {
      const pre = first + k === 0 ? (this.prompt ? bold(label0) : pink(label0)) : ' '.repeat(pw);
      const content = text || (first + k === 0 && !buf ? dim(this.prompt ? '' : 'Napisz wiadomość albo / dla komend…') : '');
      const visible = textWidth(pre) + textWidth(content);
      lines.push(border('│') + ' ' + pre + fitAnsi(content, textW) + ' '.repeat(Math.max(0, inner - visible)) + ' ' + border('│'));
    });
    lines.push(border('╰' + '─'.repeat(cols - 2) + '╯'));
    this.cursor = { row: inputTop + (cur.row - first), col: 3 + pw + cur.col };

    // 3. podpowiedzi komend albo linia info
    const sugs = this.input?.suggestions() || [];
    if (sugs.length && !this.prompt) {
      for (const l of renderSuggestions(sugs, this.input.sugIdx, cols)) lines.push(fitAnsi(l, cols));
    } else {
      const m = MODES[this.info.mode] || MODES.manual;
      const modeText = `${border(m.icon + ' ' + m.label)} ${dim('— ' + m.hint + ' (shift+tab)')}`;
      const parts = [
        modeText,
        `↑${fmt(this.info.input)} ↓${fmt(this.info.output)} ${dim('tokenów')}`,
        dim('Shift+Enter nowa linia'),
      ];
      if (this.queued) parts.push(yellow(`${this.queued} w kolejce`));
      lines.push(fitAnsi(' ' + parts.join(dim('  ·  ')), cols));
    }
    return lines;
  }

  /** Zwraca sekwencję rysującą dół; dopasowuje region czatu do wysokości dołu. */
  footerString() {
    const lines = this.footerLines();
    let s = `${CSI}?25l`;
    if (lines.length !== this.footerH) {
      const oldBottom = this.bottom;
      const newH = lines.length;
      const newBottom = this.rows - newH;
      if (newH > this.footerH) {
        // dół rośnie — przesuń czat w górę, żeby nic nie zostało zasłonięte
        const overflow = Math.max(0, this.top + this.o.row - newBottom);
        if (overflow) {
          s += cup(oldBottom, 1) + '\n'.repeat(overflow);
          this.o.row -= overflow;
        }
      } else {
        for (let r = oldBottom + 1; r <= newBottom; r++) s += cup(r, 1) + `${CSI}2K`;
      }
      this.footerH = newH;
      s += `${CSI}${this.top};${this.bottom}r`;
    }
    const top = this.rows - this.footerH + 1;
    lines.forEach((l, k) => (s += cup(top + k, 1) + `${CSI}2K` + l));
    s += '\x1b[0m' + cup(top + this.cursor.row, this.cursor.col) + `${CSI}?25h`;
    return s;
  }

  drawFooter() {
    if (!this.active) return;
    rawWrite(this.footerString());
  }

  // ---------- wypisywanie do czatu ----------

  print(text) {
    if (!text) return;
    if (/\x1b\[2J/.test(text)) {
      this.clear();
      text = text.replace(/\x1b\[[23]J|\x1b\[H/g, '');
      if (!text) return;
    }
    // nie pozwól, żeby czat nadpisał dół — kursor zawsze wewnątrz regionu
    const s = `${CSI}?25l` + cup(this.top + this.o.row, this.o.col + 1) + text;
    this.track(text);
    rawWrite(s + this.footerString());
  }

  // śledzi pozycję kursora czatu na podstawie wypisanego tekstu
  track(text) {
    const o = this.o;
    const cols = this.cols;
    const maxRow = this.regionH - 1;
    for (let i = 0; i < text.length; ) {
      const ch = text[i];
      if (ch === '\x1b') {
        if (text[i + 1] === '[') {
          let j = i + 2;
          while (j < text.length && !/[\x40-\x7e]/.test(text[j])) j++;
          this.csi(text.slice(i + 2, j), text[j]);
          i = j + 1;
          continue;
        }
        if (text[i + 1] === '7') o.saved = { row: o.row, col: o.col };
        else if (text[i + 1] === '8' && o.saved) Object.assign(o, o.saved, { pending: false });
        i += 2;
        continue;
      }
      if (ch === '\n') {
        o.pending = false;
        o.col = 0;
        o.row = Math.min(o.row + 1, maxRow);
        i++;
        continue;
      }
      if (ch === '\r') {
        o.col = 0;
        o.pending = false;
        i++;
        continue;
      }
      if (ch === '\b') {
        o.col = Math.max(0, o.col - 1);
        o.pending = false;
        i++;
        continue;
      }
      if (ch < ' ') {
        i++;
        continue;
      }
      const cp = text.codePointAt(i);
      const w = charWidth(cp);
      if (o.pending && w > 0) {
        o.pending = false;
        o.col = 0;
        o.row = Math.min(o.row + 1, maxRow);
      }
      o.col += w;
      if (o.col >= cols) {
        o.col = cols - 1;
        o.pending = true;
      }
      i += cp > 0xffff ? 2 : 1;
    }
  }

  csi(params, fin) {
    const o = this.o;
    if (params.startsWith('?')) return;
    const n = parseInt(params, 10) || 1;
    const maxRow = this.regionH - 1;
    switch (fin) {
      case 'A': o.row = Math.max(0, o.row - n); break;
      case 'B': o.row = Math.min(maxRow, o.row + n); break;
      case 'C': o.col = Math.min(this.cols - 1, o.col + n); break;
      case 'D': o.col = Math.max(0, o.col - n); break;
      case 'G': o.col = Math.min(this.cols - 1, n - 1); break;
      case 'H':
      case 'f': {
        const [r, c] = params.split(';').map((x) => parseInt(x, 10) || 1);
        o.row = Math.min(maxRow, Math.max(0, r - this.top));
        o.col = Math.min(this.cols - 1, (c || 1) - 1);
        break;
      }
      default:
        return;
    }
    o.pending = false;
  }
}

export const tui = new Tui();
