import readline from 'node:readline';
import { c, accent } from './ui.js';
import { useInput, takeTypeahead, pushTypeahead } from './input.js';

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export const width = (s) => Array.from(stripAnsi(s)).length;

// Sekwencje oznaczające „nowa linia zamiast wysłania”.
const NEWLINE_SEQS = new Set([
  '\x1b[13;2u', // Shift+Enter (protokół kitty / CSI u)
  '\x1b[27;2;13~', // Shift+Enter (xterm modifyOtherKeys)
  '\x1b[13;5u', // Ctrl+Enter (CSI u)
  '\x1b[27;5;13~', // Ctrl+Enter (xterm)
  '\x1b\r', // Alt+Enter, też Shift+Enter po /terminal-setup
  '\x1b\n',
  '\n', // Ctrl+Enter na Windows
]);

// Shift+Tab (na Windows dociera jak zwykły Tab) i Alt+M — zmiana trybu uprawnień.
const MODE_SEQS = new Set(['\x1b[Z', '\x1bm', '\x1bM']);

const KEYS = {
  '\x1b[A': 'up', '\x1bOA': 'up',
  '\x1b[B': 'down', '\x1bOB': 'down',
  '\x1b[C': 'right', '\x1bOC': 'right',
  '\x1b[D': 'left', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home',
  '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end',
  '\x1b[3~': 'delete',
  '\x1b[1;5D': 'wordleft', '\x1bb': 'wordleft',
  '\x1b[1;5C': 'wordright', '\x1bf': 'wordright',
  '\x1b[200~': 'pastestart', '\x1b[201~': 'pasteend',
};

// Dzieli surowe dane z terminala na pojedyncze klawisze / sekwencje.
export function tokenize(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === '\x1b') {
      const next = data[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < data.length && !/[\x40-\x7e]/.test(data[j])) j++;
        out.push(data.slice(i, j + 1));
        i = j + 1;
      } else if (next === 'O' && i + 2 < data.length) {
        out.push(data.slice(i, i + 3));
        i += 3;
      } else if (next !== undefined && 'bfmM\r\n'.includes(next)) {
        // Alt+b / Alt+f (słowa), Alt+m (tryb), Alt+Enter (nowa linia)
        out.push(data.slice(i, i + 2));
        i += 2;
      } else {
        // samotny Esc (także gdy zaraz po nim przyszła zwykła litera)
        out.push('\x1b');
        i += 1;
      }
    } else {
      const s = String.fromCodePoint(data.codePointAt(i));
      out.push(s);
      i += s.length;
    }
  }
  return out;
}

/**
 * Stan pola wpisywania (tekst, kursor, historia) i obsługa klawiszy.
 * Nie rysuje niczego — robi to editLine (w linii) albo dolny pasek TUI.
 * Zdarzenia: submit · ctrlc · escape · eof · mode · clear.
 */
export class InputBuffer {
  constructor({ history = [], commands = () => [], onHistory, onAction } = {}) {
    this.history = history;
    this.commands = commands;
    this.onHistory = onHistory;
    this.onAction = onAction;
    this.buf = '';
    this.pos = 0;
    this.histIdx = -1;
    this.draft = '';
    this.pasting = false;
    this.sugIdx = 0;
  }

  get text() {
    return this.buf;
  }

  set(text) {
    this.buf = text;
    this.pos = text.length;
    this.histIdx = -1;
  }

  clear() {
    this.set('');
  }

  suggestions() {
    if (!this.buf.startsWith('/') || /\s/.test(this.buf)) return [];
    const q = this.buf.toLowerCase();
    const list = typeof this.commands === 'function' ? this.commands() : this.commands;
    const sugs = list.filter(([n]) => n.toLowerCase().startsWith(q)).slice(0, 8);
    if (this.sugIdx >= sugs.length) this.sugIdx = 0;
    return sugs;
  }

  insert(text) {
    this.buf = this.buf.slice(0, this.pos) + text + this.buf.slice(this.pos);
    this.pos += text.length;
    this.histIdx = -1;
  }

  prevPos(p) {
    return p >= 2 && /[\uDC00-\uDFFF]/.test(this.buf[p - 1]) ? p - 2 : Math.max(0, p - 1);
  }

  nextPos(p) {
    return /[\uD800-\uDBFF]/.test(this.buf[p]) ? p + 2 : Math.min(this.buf.length, p + 1);
  }

  lineStart() {
    return this.buf.lastIndexOf('\n', this.pos - 1) + 1;
  }

  lineEnd() {
    const e = this.buf.indexOf('\n', this.pos);
    return e === -1 ? this.buf.length : e;
  }

  setFromHistory(idx) {
    this.buf = idx === -1 ? this.draft : this.history[idx];
    this.histIdx = idx;
    this.pos = this.buf.length;
  }

  emit(action) {
    return this.onAction?.(action);
  }

  submit() {
    // „\” na końcu linii = kontynuacja
    if (this.buf.slice(0, this.pos).endsWith('\\') && this.pos === this.lineEnd()) {
      this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos);
      this.pos -= 1;
      this.insert('\n');
      return;
    }
    const line = this.buf;
    if (line.trim()) {
      const idx = this.history.indexOf(line);
      if (idx !== -1) this.history.splice(idx, 1);
      this.history.unshift(line);
      if (this.history.length > 500) this.history.length = 500;
      this.onHistory?.(this.history);
    }
    this.clear();
    return this.emit({ type: 'submit', line });
  }

  /**
   * Przetwarza surowe dane z klawiatury. Jeśli onAction zwróci 'stop',
   * przerywa i zwraca nieprzetworzoną resztę (np. tekst wpisany po Enterze).
   */
  feed(data) {
    const keys = tokenize(data.replace(/\r\n/g, '\r'));
    // Wklejanie: Enter, po którym w tej samej paczce jest dalszy tekst, to nowa linia.
    // Enter na samym końcu paczki wysyła — przy szybkim pisaniu klawisze też przychodzą paczkami.
    const enters = keys.filter((k) => k === '\r').length;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const isLast = !keys.slice(i + 1).some((x) => x !== '\r');
      const pasteNewline = k === '\r' && (!isLast || (enters > 1 && i > 0 && !keys.slice(0, i).every((x) => x === '\r')));
      if (this.handle(k, pasteNewline) === 'stop') return keys.slice(i + 1).join('');
    }
    return '';
  }

  handle(k, pasteNewline) {
    if (this.pasting) {
      if (k === '\x1b[201~') this.pasting = false;
      else this.insert(k === '\r' ? '\n' : k);
      return;
    }
    if (NEWLINE_SEQS.has(k)) return this.insert('\n');
    if (MODE_SEQS.has(k)) return this.emit({ type: 'mode' });
    const name = KEYS[k];
    if (name === 'pastestart') {
      this.pasting = true;
      return;
    }
    if (name === 'pasteend') return;
    const buf = this.buf;
    switch (k) {
      case '\r':
        if (pasteNewline) return this.insert('\n');
        return this.submit();
      case '\x03':
        return this.emit({ type: 'ctrlc' });
      case '\x04':
        if (!buf) return this.emit({ type: 'eof' });
        this.buf = buf.slice(0, this.pos) + buf.slice(this.nextPos(this.pos));
        return;
      case '\x7f':
      case '\b':
        if (this.pos > 0) {
          const p = this.prevPos(this.pos);
          this.buf = buf.slice(0, p) + buf.slice(this.pos);
          this.pos = p;
        }
        return;
      case '\t': {
        const sugs = this.suggestions();
        if (sugs.length) {
          this.set(sugs[this.sugIdx][0] + ' ');
          return;
        }
        return this.emit({ type: 'mode' });
      }
      case '\x1b':
        return this.emit({ type: 'escape' });
      case '\x01':
        this.pos = this.lineStart();
        return;
      case '\x05':
        this.pos = this.lineEnd();
        return;
      case '\x15': {
        const s = this.lineStart();
        this.buf = buf.slice(0, s) + buf.slice(this.pos);
        this.pos = s;
        return;
      }
      case '\x0b':
        this.buf = buf.slice(0, this.pos) + buf.slice(this.lineEnd());
        return;
      case '\x17': {
        let p = this.pos;
        while (p > 0 && /\s/.test(buf[p - 1])) p--;
        while (p > 0 && !/\s/.test(buf[p - 1])) p--;
        this.buf = buf.slice(0, p) + buf.slice(this.pos);
        this.pos = p;
        return;
      }
      case '\x0c':
        return this.emit({ type: 'clear' });
    }
    switch (name) {
      case 'left':
        this.pos = this.prevPos(this.pos);
        return;
      case 'right':
        this.pos = this.nextPos(this.pos);
        return;
      case 'home':
        this.pos = this.lineStart();
        return;
      case 'end':
        this.pos = this.lineEnd();
        return;
      case 'delete':
        this.buf = buf.slice(0, this.pos) + buf.slice(this.nextPos(this.pos));
        return;
      case 'wordleft':
        while (this.pos > 0 && /\s/.test(buf[this.pos - 1])) this.pos--;
        while (this.pos > 0 && !/\s/.test(buf[this.pos - 1])) this.pos--;
        return;
      case 'wordright':
        while (this.pos < buf.length && /\s/.test(buf[this.pos])) this.pos++;
        while (this.pos < buf.length && !/\s/.test(buf[this.pos])) this.pos++;
        return;
      case 'up': {
        const sugs = this.suggestions();
        if (sugs.length > 1) {
          this.sugIdx = (this.sugIdx - 1 + sugs.length) % sugs.length;
          return;
        }
        if (buf.lastIndexOf('\n', this.pos - 1) !== -1) {
          const col = this.pos - this.lineStart();
          const prevEnd = this.lineStart() - 1;
          const prevStart = buf.lastIndexOf('\n', prevEnd - 1) + 1;
          this.pos = Math.min(prevStart + col, prevEnd);
          return;
        }
        if (this.histIdx + 1 < this.history.length) {
          if (this.histIdx === -1) this.draft = buf;
          this.setFromHistory(this.histIdx + 1);
        }
        return;
      }
      case 'down': {
        const sugs = this.suggestions();
        if (sugs.length > 1) {
          this.sugIdx = (this.sugIdx + 1) % sugs.length;
          return;
        }
        if (buf.indexOf('\n', this.pos) !== -1) {
          const col = this.pos - this.lineStart();
          const nextStart = this.lineEnd() + 1;
          const e = buf.indexOf('\n', nextStart);
          this.pos = Math.min(nextStart + col, e === -1 ? buf.length : e);
          return;
        }
        if (this.histIdx >= 0) this.setFromHistory(this.histIdx - 1);
        return;
      }
    }
    if (k.length && !k.startsWith('\x1b') && k >= ' ') this.insert(k);
  }
}

/** Lista podpowiedzi komend jako wiersze tekstu. */
export function renderSuggestions(sugs, sugIdx, cols) {
  const nameW = Math.max(12, ...sugs.map(([n]) => n.length));
  return sugs.map(([n, d], k) => {
    let text = `${n.padEnd(nameW)}  ${d}`;
    if (text.length > cols - 5) text = text.slice(0, cols - 6) + '…';
    return k === sugIdx ? accent('  › ') + c.bold(text.slice(0, nameW)) + c.dim(text.slice(nameW)) : '    ' + c.dim(text);
  });
}

/**
 * Pole wpisywania rysowane w miejscu (gdy nie działa dolny pasek TUI).
 * Zwraca { type: 'line', line } | { type: 'sigint' } | { type: 'cancel' } | { type: 'eof' }.
 */
export function editLine({ prompt = accent('❯ '), history = [], commands = [], onHistory, hint } = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
      rl.question(stripAnsi(prompt), (line) => {
        rl.close();
        resolve({ type: 'line', line });
      });
      rl.once('close', () => resolve({ type: 'eof' }));
    });
  }

  return new Promise((resolve) => {
    const pw = width(prompt);
    const indent = ' '.repeat(pw);
    let cursorRow = 0;
    let done = false;
    let result = null;
    const cols = () => stdout.columns || 80;

    const input = new InputBuffer({
      history,
      commands,
      onHistory,
      onAction: (a) => {
        if (a.type === 'submit') result = { type: 'line', line: a.line };
        else if (a.type === 'ctrlc') result = input.text ? { type: 'cancel' } : { type: 'sigint' };
        else if (a.type === 'eof') result = { type: 'eof' };
        else if (a.type === 'escape') input.clear();
        else if (a.type === 'clear') {
          stdout.write('\x1b[2J\x1b[H');
          cursorRow = 0;
        }
        return result ? 'stop' : undefined;
      },
    });

    const layout = (buf, pos) => {
      const lines = buf.split('\n');
      const W = cols();
      let row = 0;
      let cur = null;
      let offset = 0;
      for (let li = 0; li < lines.length; li++) {
        const len = Array.from(lines[li]).length;
        const used = Math.max(1, Math.ceil((pw + len) / W));
        if (cur === null && pos <= offset + lines[li].length) {
          const x = Array.from(lines[li].slice(0, pos - offset)).length;
          let r = Math.floor((pw + x) / W);
          let col = (pw + x) % W;
          if (x === len && x > 0 && (pw + x) % W === 0) {
            r -= 1;
            col = W - 1;
          }
          cur = { row: row + r, col };
        }
        row += used;
        offset += lines[li].length + 1;
      }
      return { lines, total: row, cur: cur || { row: row - 1, col: 0 } };
    };

    const render = (final = false) => {
      const shownBuf = final && result?.type === 'line' ? result.line : input.text;
      const { lines, total, cur } = layout(shownBuf, final ? shownBuf.length : input.pos);
      let s = '\x1b[?25l';
      if (cursorRow > 0) s += `\x1b[${cursorRow}A`;
      s += '\r\x1b[J';
      s += lines.map((l, i) => (i === 0 ? prompt : indent) + l).join('\r\n');
      if (final) {
        stdout.write(s + '\r\n\x1b[?25h');
        return;
      }
      const sugs = input.suggestions();
      let extra = 0;
      if (sugs.length) {
        s += '\r\n' + renderSuggestions(sugs, input.sugIdx, cols()).join('\r\n');
        extra = sugs.length;
      } else if (!input.text) {
        s += '\r\n' + c.dim(hint || '  Enter wyślij · Shift+Enter nowa linia · / komendy · Esc przerwij');
        extra = 1;
      }
      const endRow = total - 1 + extra;
      const up = endRow - cur.row;
      if (up > 0) s += `\x1b[${up}A`;
      s += '\r' + (cur.col > 0 ? `\x1b[${cur.col}C` : '') + '\x1b[?25h';
      stdout.write(s);
      cursorRow = cur.row;
    };

    const onData = (data) => {
      if (done) return;
      const rest = input.feed(data);
      if (result) {
        done = true;
        release();
        stdout.off('resize', onResize);
        render(true);
        stdout.write('\x1b[?2004l');
        if (rest) pushTypeahead(rest);
        resolve(result);
        return;
      }
      render();
    };
    const onResize = () => render();

    stdout.write('\x1b[?2004h'); // bracketed paste
    const release = useInput(onData);
    stdout.on('resize', onResize);
    const ahead = takeTypeahead();
    if (ahead) onData(ahead);
    else render();
  });
}
