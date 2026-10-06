// Układ ekranu w stylu Claude Code:
//   góra  — stały header: logo EXOTICCODE, model/effort/folder, komendy, maskotka po prawej
//   środek — przewijany czat (region przewijania DECSTBM)
//   dół   — stały: linia statusu (spinner + co robi maskotka), pole czatu w ramce, info
// Wszystko, co program wypisuje przez process.stdout, trafia do środkowego regionu.

import { rawWrite, rawWriteErr } from './term.js';
import { hud, MASCOT_W, MASCOT_ROWS } from './mascot.js';
import { renderSuggestions, width as textWidth, tokenize } from './editor.js';
import { useInput } from './input.js';
import { todos } from './todos.js';
import { ChatBuffer, charWidth } from './screenbuf.js';
import { setVtInput } from './winshift.js';

const stdout = process.stdout;
const HEADER = MASCOT_ROWS + 1; // wiersze maskotki + linia oddzielająca
const MAX_INPUT_ROWS = 8;
// raportowanie myszy (przyciski + kółko) w formacie SGR
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';
// osobny ekran terminala (bez historii przewijania)
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';

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
    this.buf = new ChatBuffer();
    this.scroll = 0; // ile wierszy w górę od najnowszych
    this.unseen = false; // przyszła nowa treść, gdy widok był przewinięty
    // przy zmianie rozmiaru okna: chwilę poczekaj (okno zmienia się wieloma krokami),
    // potem wyczyść cały ekran i narysuj wszystko od nowa z pamięci
    this.onResize = () => {
      this.resizing = true;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizing = false;
        this.redraw(false, true);
      }, 80);
    };
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
      const rest = this.handleScrollKeys(d);
      if (rest) onKeys(rest);
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
      this.exitHook = () => this.active && rawWrite(`${MOUSE_OFF}${CSI}r${ALT_OFF}\x1b[?2004l\x1b[?25h`);
      process.on('exit', this.exitHook);
    }
    // Osobny ekran terminala (jak vim/htop): bez historii przewijania, więc bez bocznego paska
    // i bez kopii headera, które terminal spychał do historii przy zmianie rozmiaru okna.
    // Czat przewija się z własnej pamięci (kółko, PgUp/PgDn). ?1007l — kółko nie udaje strzałek.
    rawWrite(`${ALT_ON}\x1b[?1007l\x1b[?2004h`);
    this.redraw(true);
    this.enableMouse();
    return true;
  }

  /** Wyłącza układ i wraca do zwykłego ekranu terminala (tego sprzed uruchomienia). */
  disable() {
    if (!this.active) return;
    this.disableMouse();
    this.active = false;
    delete stdout.write;
    delete process.stderr.write;
    if (stdout.write !== rawWrite) stdout.write = rawWrite;
    if (process.stderr.write !== rawWriteErr) process.stderr.write = rawWriteErr;
    this.releaseInput?.();
    clearInterval(this.timer);
    stdout.off('resize', this.onResize);
    clearTimeout(this.resizeTimer);
    rawWrite(`${CSI}r${CSI}2J${CSI}H${ALT_OFF}\x1b[?2004l\x1b[?25h`);
  }

  // ---------- rysowanie całości ----------

  /** Rysuje header, czat i dół. `clear` — wyczyść też pamięć czatu, `wipe` — wyczyść ekran. */
  redraw(clear, wipe = false) {
    if (!this.active) return;
    this.footerH = this.footerLines().length;
    let s = `${CSI}?25l${CSI}r`;
    if (wipe && !clear) s += `\x1b[0m${CSI}2J${CSI}H`;
    if (clear) {
      s += `${CSI}2J${CSI}3J${CSI}H`;
      this.buf.clear();
      this.scroll = 0;
      this.unseen = false;
    }
    s += `${CSI}${this.top};${this.bottom}r`;
    s += this.headerString();
    this.syncBuf();
    s += this.viewportString();
    rawWrite(s);
    this.drawFooter();
  }

  // wymiary obszaru czatu przekazane do pamięci ekranu
  syncBuf() {
    this.buf.viewH = this.regionH;
    this.buf.cols = this.cols;
    this.buf.screenTop = this.top;
    this.scroll = Math.min(this.scroll, this.buf.followTop);
  }

  /** Odrysowuje widoczną część czatu z pamięci (uwzględnia przewinięcie). */
  viewportString() {
    const start = this.buf.followTop - this.scroll;
    let s = '';
    for (let r = 0; r < this.regionH; r++) s += cup(this.top + r, 1) + `\x1b[0m${CSI}2K` + this.buf.renderRow(start + r, this.cols);
    return s;
  }

  // ---------- przewijanie czatu ----------

  /** Przewija o `n` wierszy (dodatnie — w górę, do starszych wiadomości). */
  scrollBy(n) {
    this.syncBuf();
    const next = Math.max(0, Math.min(this.buf.followTop, this.scroll + n));
    if (next === this.scroll) return;
    this.scroll = next;
    if (!next) this.unseen = false;
    rawWrite(`${CSI}?25l` + this.viewportString() + this.footerString());
  }

  scrollToTop() {
    this.scrollBy(this.buf.followTop);
  }

  /** Wraca na dół czatu (najnowsza treść). */
  follow() {
    if (this.scroll) this.scrollBy(-this.scroll);
  }

  // klawisze przewijania — wyłapywane, zanim reszta trafi do pola wpisywania
  handleScrollKeys(data) {
    const page = Math.max(1, this.regionH - 2);
    let rest = '';
    for (const k of tokenize(data)) {
      if (k === '\x1b[5~') this.scrollBy(page); // PgUp
      else if (k === '\x1b[6~') this.scrollBy(-page); // PgDn
      else if (k === '\x1b[1;2A') this.scrollBy(1); // Shift+↑
      else if (k === '\x1b[1;2B') this.scrollBy(-1); // Shift+↓
      else if (k === '\x1b[1;5H') this.scrollToTop(); // Ctrl+Home
      else if (k === '\x1b[1;5F') this.follow(); // Ctrl+End
      else if (k.startsWith('\x1b[<')) {
        // mysz (SGR): kółko w górę = 64, w dół = 65; kliknięcia i ruch pomijamy
        const m = k.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
        const button = m ? Number(m[1]) & ~(4 | 8 | 16) : -1; // bez bitów Shift/Alt/Ctrl
        if (button === 64) this.scrollBy(3);
        else if (button === 65) this.scrollBy(-3);
      } else rest += k;
    }
    return rest;
  }

  // ---------- mysz ----------

  async enableMouse() {
    if (!this.active || this.mouseOn || this.mouseWanted === false) return false;
    // Windows: najpierw tryb konsoli, w którym terminal przesyła mysz jako tekst
    if (!(await setVtInput(true))) return false;
    if (!this.active) return false;
    rawWrite(MOUSE_ON);
    this.mouseOn = true;
    return true;
  }

  /** Wyłącza mysz. Zwraca obietnicę — przy wyjściu z programu trzeba na nią poczekać. */
  disableMouse() {
    if (!this.mouseOn) return Promise.resolve();
    rawWrite(MOUSE_OFF);
    this.mouseOn = false;
    return setVtInput(false, 2000);
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
    if (!this.active || this.resizing) return;
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
    const scrollText = this.scroll
      ? yellow(`↑ przewinięto o ${this.scroll} ${this.scroll === 1 ? 'wiersz' : 'wierszy'}`) + dim(this.unseen ? ' · jest nowa treść · PgDn / Ctrl+End na dół' : ' · PgDn / Ctrl+End na dół')
      : '';
    const parts = [scrollText, this.status, stepText, mascotText].filter(Boolean);
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
      // Oblicz maksymalną liczbę linii podpowiedzi, żeby nie zabierać całego ekranu
      const usedLines = lines.length; // status + ramka z inputem
      const maxSugLines = Math.max(3, Math.min(12, this.rows - HEADER - usedLines - 2));
      
      // Przewiń okno widoku tak, żeby zaznaczony element był widoczny
      const idx = this.input.sugIdx;
      let start = 0;
      if (sugs.length > maxSugLines) {
        // Zaznaczony element powinien być w środku widocznego zakresu
        start = Math.max(0, Math.min(sugs.length - maxSugLines, idx - Math.floor(maxSugLines / 2)));
      }
      
      const visibleSugs = sugs.slice(start, start + maxSugLines);
      const adjustedIdx = idx - start; // indeks w obrębie widocznych sugestii
      
      for (const l of renderSuggestions(visibleSugs, adjustedIdx, cols)) lines.push(fitAnsi(l, cols));
      if (sugs.length > maxSugLines) {
        const hidden = sugs.length - maxSugLines;
        lines.push(fitAnsi(dim(`    … i jeszcze ${hidden} ${hidden === 1 ? 'komenda' : 'komend'} (wpisz więcej, żeby filtrować)`), cols));
      }
    } else {
      const m = MODES[this.info.mode] || MODES.manual;
      const modeText = `${border(m.icon + ' ' + m.label)} ${dim('(shift+tab)')}`;
      const parts = [
        modeText,
        `↑${fmt(this.info.input)} ↓${fmt(this.info.output)} ${dim('tokenów')}`,
        dim('Shift+Enter nowa linia'),
        dim(this.mouseOn ? 'kółko/PgUp przewijanie' : 'PgUp/PgDn przewijanie'),
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
      // dół zmienił wysokość — nowy region czatu i odrysowanie go z pamięci
      this.footerH = lines.length;
      s += `${CSI}${this.top};${this.bottom}r`;
      this.syncBuf();
      s += this.viewportString();
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
    const b = this.buf;
    this.syncBuf();
    if (this.scroll > 0) {
      // użytkownik przegląda starsze wiadomości — zapisz, ale nie ruszaj widoku
      b.write(text);
      this.unseen = true;
      this.drawFooter();
      return;
    }
    // kursor czatu na ekranie odtwarzamy z pamięci, więc dół nigdy nie zostanie nadpisany
    let prefix = `${CSI}?25l`;
    if (b.pending && /^[^\r\n\x1b]/.test(text)) {
      // zawinięcie linii odkładamy do następnego znaku — tak samo jak terminal
      const { row } = b.screenPos;
      prefix += cup(this.top + row, this.cols) + '\r\n';
      b.newline();
    } else {
      const { row, col } = b.screenPos;
      prefix += cup(this.top + row, col + 1);
    }
    b.write(text);
    rawWrite(prefix + text + this.footerString());
  }
}

export const tui = new Tui();
