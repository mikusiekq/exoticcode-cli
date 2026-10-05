// Pamięć ekranu czatu: wszystko, co program wypisuje, trafia tu jako wiersze komórek
// (znak + styl), tak jak w terminalu. Dzięki temu czat można przewijać (PgUp/PgDn)
// i odrysować od dowolnego miejsca — terminal sam tego nie zapamiętuje, bo czat
// przewija się w regionie między headerem a polem wpisywania.

export function charWidth(cp) {
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp === 0x2615 || cp === 0x26a1
  ) return 2;
  return 1;
}

export class ChatBuffer {
  constructor(maxRows = 5000) {
    this.maxRows = maxRows;
    this.cols = 80;
    this.viewH = 20; // wysokość widocznego obszaru czatu
    this.screenTop = 1; // numer wiersza terminala, od którego zaczyna się czat
    this.clear();
  }

  clear() {
    this.rows = [[]];
    this.line = 0;
    this.col = 0;
    this.pending = false; // kursor za ostatnią kolumną — następny znak zawija linię
    this.styles = [];
    this.saved = null;
  }

  get sgr() {
    return this.styles.join('');
  }

  /** Indeks pierwszego widocznego wiersza, gdy widok jest „na dole”. */
  get followTop() {
    return Math.max(0, this.rows.length - this.viewH);
  }

  /** Pozycja kursora na ekranie (wiersz w obszarze czatu, kolumna), gdy widok jest na dole. */
  get screenPos() {
    return { row: this.line - this.followTop, col: this.col };
  }

  newline() {
    this.pending = false;
    this.col = 0;
    if (this.line >= this.rows.length - 1) this.rows.push([]);
    this.line++;
    const extra = this.rows.length - this.maxRows;
    if (extra > 0) {
      this.rows.splice(0, extra);
      this.line -= extra;
      if (this.saved) this.saved.line -= extra;
    }
  }

  put(ch, w) {
    if (this.pending) this.newline();
    if (w === 2 && this.col >= this.cols - 1) this.newline();
    const row = this.rows[this.line];
    while (row.length < this.col) row.push(null);
    const style = this.sgr;
    row[this.col] = { c: ch, s: style };
    if (w === 2) row[this.col + 1] = { c: '', s: style };
    this.col += w;
    if (this.col >= this.cols) {
      this.col = this.cols - 1;
      this.pending = true;
    }
  }

  write(text) {
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
        if (text[i + 1] === '7') this.saved = { line: this.line, col: this.col };
        else if (text[i + 1] === '8' && this.saved) {
          this.line = Math.min(this.saved.line, this.rows.length - 1);
          this.col = this.saved.col;
          this.pending = false;
        }
        i += 2;
        continue;
      }
      if (ch === '\n') {
        this.newline();
        i++;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        this.pending = false;
        i++;
        continue;
      }
      if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
        this.pending = false;
        i++;
        continue;
      }
      if (ch === '\t') {
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        i++;
        continue;
      }
      if (ch < ' ') {
        i++;
        continue;
      }
      const cp = text.codePointAt(i);
      const s = String.fromCodePoint(cp);
      const w = charWidth(cp);
      if (w === 0) {
        // znak łączący — dopisz do poprzedniej komórki
        const row = this.rows[this.line];
        const prev = row[this.col - 1];
        if (prev) prev.c += s;
      } else this.put(s, w);
      i += s.length;
    }
  }

  csi(params, fin) {
    if (fin === 'm') {
      if (params === '' || params === '0') this.styles = [];
      else {
        this.styles.push(`\x1b[${params}m`);
        if (this.styles.length > 12) this.styles = this.styles.slice(-12);
      }
      return;
    }
    if (params.startsWith('?')) return;
    const n = parseInt(params, 10) || 1;
    const top = this.followTop;
    const bottom = top + this.viewH - 1;
    switch (fin) {
      case 'A':
        this.line = Math.max(top, this.line - n);
        break;
      case 'B':
        this.line = Math.min(bottom, this.line + n);
        while (this.rows.length <= this.line) this.rows.push([]);
        break;
      case 'C':
        this.col = Math.min(this.cols - 1, this.col + n);
        break;
      case 'D':
        this.col = Math.max(0, this.col - n);
        break;
      case 'G':
        this.col = Math.min(this.cols - 1, n - 1);
        break;
      case 'H':
      case 'f': {
        const [r, c] = params.split(';').map((x) => parseInt(x, 10) || 1);
        this.line = Math.min(bottom, Math.max(top, top + (r - this.screenTop)));
        while (this.rows.length <= this.line) this.rows.push([]);
        this.col = Math.min(this.cols - 1, (c || 1) - 1);
        break;
      }
      case 'K': {
        const mode = parseInt(params, 10) || 0;
        const row = this.rows[this.line];
        if (mode === 0) row.length = Math.min(row.length, this.col);
        else if (mode === 1) for (let k = 0; k <= this.col && k < row.length; k++) row[k] = null;
        else this.rows[this.line] = [];
        return;
      }
      case 'J': {
        const mode = parseInt(params, 10) || 0;
        if (mode === 0) {
          const row = this.rows[this.line];
          row.length = Math.min(row.length, this.col);
          for (let k = this.line + 1; k < this.rows.length; k++) this.rows[k] = [];
        }
        return;
      }
      default:
        return;
    }
    this.pending = false;
  }

  /** Wiersz jako tekst z kodami kolorów (przycięty do `cols`). */
  renderRow(index, cols) {
    const row = this.rows[index];
    if (!row) return '';
    let s = '';
    let cur = '';
    const n = Math.min(row.length, cols);
    for (let i = 0; i < n; i++) {
      const cell = row[i];
      if (!cell) {
        if (cur !== '') {
          s += '\x1b[0m';
          cur = '';
        }
        s += ' ';
        continue;
      }
      if (cell.c === '') continue;
      if (cell.s !== cur) {
        s += '\x1b[0m' + cell.s;
        cur = cell.s;
      }
      s += cell.c;
    }
    return s + '\x1b[0m';
  }
}
