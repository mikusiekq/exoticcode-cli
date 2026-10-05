import readline from 'node:readline';
import { useInput } from './input.js';
import { tui } from './tui.js';
import { tokenize } from './editor.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const rgb = (r, g, b) => (s) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  rgb,
};

const PINK = [236, 72, 153];
const CYAN = [34, 211, 238];
export const accent = rgb(...PINK);
export const accent2 = rgb(...CYAN);
const codeColor = rgb(186, 230, 253);

export const cols = () => process.stdout.columns || 80;
export const out = (s = '') => process.stdout.write(s + '\n');

// ---------- banner ----------

const FONT = {
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  X: ['██╗  ██╗', '╚██╗██╔╝', ' ╚███╔╝ ', ' ██╔██╗ ', '██╔╝ ██╗', '╚═╝  ╚═╝'],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
};

function gradientLine(line, width) {
  if (!useColor) return line;
  let s = '';
  const chars = [...line];
  chars.forEach((ch, i) => {
    const t = width > 1 ? i / (width - 1) : 0;
    const col = PINK.map((p, k) => Math.round(p + (CYAN[k] - p) * t));
    s += `\x1b[38;2;${col[0]};${col[1]};${col[2]}m${ch}`;
  });
  return s + '\x1b[39m';
}

export function banner() {
  const word = 'EXOTICCODE';
  const rows = Array.from({ length: 6 }, (_, r) => [...word].map((ch) => FONT[ch][r]).join(''));
  const width = [...rows[0]].length;
  out();
  if (cols() >= width + 4) {
    for (const r of rows) out('  ' + gradientLine(r, width));
  } else {
    out('  ' + c.bold(gradientLine('E X O T I C C O D E', 19)));
  }
}

// ---------- spinner ----------

const VERBS = [
  'Kombinuję', 'Myślę', 'Egzotyzuję', 'Mieszam koktajl', 'Koduję', 'Analizuję',
  'Kminię', 'Główkuję', 'Tropię bugi', 'Przędę kod', 'Medytuję', 'Czaruję',
  'Szponcenie', 'Szponcę kod', 'Dłubię w bajtach', 'Parzę kawę', 'Klepię kod', 'Odpalam neurony',
];
export const randomVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  constructor() {
    this.timer = null;
  }
  start(text) {
    if (!process.stdout.isTTY) return;
    this.stop();
    this.text = text;
    this.i = 0;
    this.t0 = Date.now();
    this.timer = setInterval(() => this.render(), 80);
    this.render();
  }
  render() {
    const secs = Math.floor((Date.now() - this.t0) / 1000);
    const frame = gradientLine(FRAMES[this.i++ % FRAMES.length], 1);
    const line = `${accent(frame)} ${accent2(this.text + '…')} ${c.dim(`(${secs}s · Esc przerywa)`)}`;
    // w układzie TUI spinner jest w linii statusu nad polem czatu
    if (tui.active) tui.setStatus(line);
    else process.stdout.write(`\r\x1b[K${line}`);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (tui.active) tui.setStatus(null);
      else process.stdout.write('\r\x1b[K');
    }
  }
}

// ---------- markdown (renderowanie liniami w trakcie streamu) ----------

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => accent2(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x));
}

export class MarkdownStream {
  constructor() {
    this.buf = '';
    this.inCode = false;
    this.lines = 0;
  }
  write(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      this.emit(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
  }
  end() {
    if (this.buf) this.emit(this.buf);
    this.buf = '';
  }
  emit(line) {
    // pomiń puste linie na samym początku odpowiedzi
    if (this.lines === 0 && !line.trim()) return;
    const prefix = this.lines === 0 ? accent('●') + ' ' : '  ';
    this.lines++;
    out(prefix + this.format(line));
  }
  format(line) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      this.inCode = !this.inCode;
      return this.inCode ? c.dim('┌─ ' + (fence[1].trim() || 'kod')) : c.dim('└─');
    }
    if (this.inCode) return c.dim('│ ') + codeColor(line);
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) return c.bold(accent(inline(m[1])));
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) return m[1] + accent('• ') + inline(m[2]);
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) return m[1] + accent(m[2] + '. ') + inline(m[3]);
    if (/^\s*>/.test(line)) return c.gray('│ ') + c.italic(inline(line.replace(/^\s*>\s?/, '')));
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return c.dim('─'.repeat(Math.min(60, cols() - 4)));
    return inline(line);
  }
}

// ---------- drobne helpery ----------

export function box(title, lines) {
  out(accent('╭─ ') + c.bold(title));
  for (const l of lines) out(accent('│ ') + l);
  out(accent('╰─'));
}

export function truncateLine(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function readSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin });
      rl.question(question, (a) => {
        rl.close();
        resolve(a.trim());
      });
      return;
    }
    process.stdout.write(question);
    let value = '';
    let release = () => {};
    const finish = (v) => {
      release();
      process.stdout.write('\n');
      resolve(v === null ? null : v.trim());
    };
    const onData = (data) => {
      if (data.startsWith('\x1b') && data.length > 1 && !data.startsWith('\x1b[200~')) return;
      data = data.replace(/\x1b\[20[01]~/g, '');
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\x03' || ch === '\x1b') return finish(null);
        if (ch === '\x7f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        process.stdout.write('•');
      }
    };
    release = useInput(onData);
  });
}

// ---------- ekran i interaktywne menu ----------

export function clearScreen() {
  if (tui.active) return tui.clear();
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

// Czeka na jeden klawisz (tryb raw). Zwraca surowy ciąg znaków.
export function waitKey() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return resolve('\r');
    const release = useInput((d) => {
      release();
      resolve(d);
    });
  });
}

/**
 * Menu wyboru strzałkami, rysowane w miejscu.
 * items: [{ label, hint? }] — zwraca indeks albo null (Esc / Ctrl+C).
 */
export function select(items, { index = 0 } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return resolve(index);
    let i = Math.min(Math.max(0, index), items.length - 1);
    let drawn = 0;
    const width = () => cols() - 6;
    const draw = () => {
      if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[J`);
      // menu musi zmieścić się w obszarze czatu (w TUI jest mniejszy niż cały ekran)
      const avail = tui.active ? tui.regionH - 4 : (process.stdout.rows || 30) - 16;
      const max = Math.min(items.length, Math.max(3, avail));
      const start = Math.min(Math.max(0, i - Math.floor(max / 2)), items.length - max);
      const lines = [];
      lines.push(start > 0 ? c.dim('    ↑ więcej') : '');
      for (let k = start; k < start + max; k++) {
        const it = items[k];
        const sel = k === i;
        let text = it.label + (it.hint ? '  ' + it.hint : '');
        if (text.length > width()) text = text.slice(0, width() - 1) + '…';
        const label = text.slice(0, it.label.length);
        const hint = text.slice(it.label.length);
        lines.push((sel ? accent('  ❯ ') : '    ') + (sel ? c.bold(accent2(label)) : label) + c.dim(hint));
      }
      lines.push(start + max < items.length ? c.dim('    ↓ więcej') : '');
      lines.push(c.dim('  ↑/↓ wybierz · Enter zatwierdź · Esc wróć'));
      process.stdout.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };
    let release = () => {};
    const finish = (v) => {
      release();
      process.stdout.write(`\x1b[${drawn}A\r\x1b[J\x1b[?25h`);
      if (v !== null) out(`  ${c.green('✔')} ${c.bold(items[v].label)}`);
      resolve(v);
    };
    const onData = (data) => {
      // kilka klawiszy może przyjść jedną paczką (np. przytrzymana strzałka)
      let moved = false;
      for (const d of tokenize(data)) {
        if (d === '\x1b[A' || d === 'k' || d === '\x1bOA') i = (i - 1 + items.length) % items.length;
        else if (d === '\x1b[B' || d === 'j' || d === '\x1bOB') i = (i + 1) % items.length;
        else if (d === '\x1b[5~') i = Math.max(0, i - 10);
        else if (d === '\x1b[6~') i = Math.min(items.length - 1, i + 10);
        else if (d === '\r' || d === '\n') return finish(i);
        else if (d === '\x1b' || d === '\x03') return finish(null);
        else continue;
        moved = true;
      }
      if (moved) draw();
    };
    process.stdout.write('\x1b[?25l');
    release = useInput(onData);
    draw();
  });
}
