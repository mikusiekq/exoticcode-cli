// Animowana maskotka w stałym pasku na górze terminala.
// Pasek to osobny region: treść czatu przewija się pod nim (DECSTBM),
// a maskotka jest rysowana pikselami „▀/▄” w pełnym kolorze (2 piksele na znak).

const stdout = process.stdout;
const W = 22; // szerokość płótna w pikselach (= kolumny terminala)
const H = 16; // wysokość płótna w pikselach (= 8 wierszy terminala)
const DY = 2; // przesunięcie rysunku w dół (miejsce na wyższą koronę)


const PAL = {
  P: '150;60;230', // fiolet
  D: '105;35;175', // ciemny fiolet (ręce)
  K: '236;30;140', // róż
  L: '255;140;200', // jasny róż
  B: '20;15;30', // czarny
  C: '255;120;170', // policzki
  M: '245;245;250', // kubek / biały
  G: '120;125;145', // laptop
  g: '190;195;210', // klawiatura
  S: '60;220;240', // „kod”
  O: '235;140;45', // gitara
  N: '125;75;35', // gryf
  Y: '255;215;80', // nuty / iskierki
  s: '200;200;215', // para
  T: '120;190;255', // łza
};

const CROWN_A = [
  '.K.....KK.....K.',
  '.LK...KKKK...KL.',
  '..LK..KKKK..KL..',
  '..LKKKKKKKKKKL..',
  '...KKKKKKKKKK...',
];
const CROWN_B = [
  'K......KK......K',
  'LK....KKKK....KL',
  '.LK...KKKK...KL.',
  '..LKKKKKKKKKKL..',
  '...KKKKKKKKKK...',
];
const BODY = [
  '..PPPPPPPPPPPP..',
  '.PPPPPPPPPPPPPP.',
  '.PPPPPPPPPPPPPP.',
  'PPPPPPPPPPPPPPPP',
  'PPPPPPPPPPPPPPPP',
  'PPPPPPPPPPPPPPPP',
  '.PPPPPPPPPPPPPP.',
  '..PPPPPPPPPPPP..',
  '..PP.PP..PP.PP..',
  '..PP.PP..PP.PP..',
];

const STATUS = {
  idle: ['♥', 'Czeka na Twoją wiadomość'],
  thinking: ['☕', 'Pije kawę i kmini…'],
  typing: ['⌨', 'Stuka w laptopa…'],
  guitar: ['♪', 'Gra na gitarze, aż komenda się skończy…'],
  asking: ['?', 'Czeka na Twoją zgodę'],
  happy: ['✔', 'Gotowe!'],
  sad: ['✖', 'Ups… coś poszło nie tak'],
};

function canvas() {
  return Array.from({ length: H }, () => Array(W).fill(null));
}

function sprite(cv, rows, ox, oy) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.') px(cv, ox + x, oy + y, ch);
    });
  });
}

function px(cv, x, y, ch) {
  y += DY;
  if (x >= 0 && x < W && y >= 0 && y < H) cv[y][x] = PAL[ch] || null;
}

const pts = (cv, list, ch) => list.forEach(([x, y]) => px(cv, x, y, ch));

function face(cv, eyes, mouth) {
  if (eyes === 'open') pts(cv, [[5, 6], [6, 6], [5, 7], [6, 7], [11, 6], [12, 6], [11, 7], [12, 7]], 'B');
  else if (eyes === 'closed') pts(cv, [[5, 7], [6, 7], [11, 7], [12, 7]], 'B');
  else if (eyes === 'happy') pts(cv, [[5, 6], [6, 6], [4, 7], [7, 7], [11, 6], [12, 6], [10, 7], [13, 7]], 'B');
  pts(cv, [[3, 8], [4, 8], [13, 8], [14, 8]], 'C');
  if (mouth === 'smile') pts(cv, [[7, 8], [10, 8], [8, 9], [9, 9]], 'B');
  else if (mouth === 'open') {
    pts(cv, [[7, 8], [8, 8], [9, 8], [10, 8]], 'B');
    pts(cv, [[8, 9], [9, 9]], 'K');
  } else if (mouth === 'sad') pts(cv, [[8, 8], [9, 8], [7, 9], [10, 9]], 'B');
  else if (mouth === 'o') pts(cv, [[8, 8], [9, 8], [8, 9], [9, 9]], 'B');
}

function note(cv, x, y) {
  pts(cv, [[x, y], [x + 1, y], [x, y + 1], [x - 1, y + 2], [x, y + 2]], 'Y');
}

/** Rysuje jedną klatkę animacji dla danego stanu. */
export function frame(state, t) {
  const cv = canvas();
  const wiggle = state === 'happy' ? t % 2 : Math.floor(t / 6) % 2;
  sprite(cv, wiggle ? CROWN_B : CROWN_A, 1, -1);
  sprite(cv, BODY, 1, 4);
  const blink = t % 28 === 0 || t % 28 === 1;

  switch (state) {
    case 'typing': {
      face(cv, blink ? 'closed' : 'open', t % 8 < 4 ? 'smile' : 'o');
      sprite(cv, ['GGGGGGGGGG', 'GGGGKKGGGG', 'GGGGGGGGGG'], 4, 9);
      sprite(cv, ['gggggggggggggg'], 2, 12);
      if (t % 2) pts(cv, [[2, 11], [3, 11], [14, 12], [15, 12]], 'D');
      else pts(cv, [[2, 12], [3, 12], [14, 11], [15, 11]], 'D');
      for (let k = 0; k < 3; k++) px(cv, k % 2 ? 19 : 21, 8 - ((t + k * 3) % 9), 'S');
      break;
    }
    case 'thinking': {
      const sip = t % 14 >= 11;
      face(cv, sip || blink ? 'closed' : 'open', sip ? 'o' : 'smile');
      sprite(cv, ['MMMM', 'MKKMM', 'MMMMM', 'MMMM'], 17, 8);
      pts(cv, [[16, 9], [16, 10]], 'D');
      for (let k = 0; k < 3; k++) px(cv, 18 + ((t + k) % 2), 7 - ((t + k * 2) % 6), 's');
      break;
    }
    case 'guitar': {
      face(cv, blink ? 'closed' : 'happy', t % 4 < 2 ? 'o' : 'smile');
      sprite(cv, ['.OOOO.', 'OONNOO', 'OONNOO', '.OOOO.'], 2, 9);
      sprite(cv, ['NNNNNNNNNN'], 8, 10);
      pts(cv, [[18, 9], [19, 9], [18, 10], [19, 10]], 'D');
      pts(cv, [[20, 9], [20, 10]], 'Y');
      if (t % 2) pts(cv, [[7, 9], [7, 10]], 'D');
      else pts(cv, [[7, 11], [7, 12]], 'D');
      pts(cv, [[15, t % 4 < 2 ? 9 : 11]], 'D');
      note(cv, 20, 5 - (t % 6));
      note(cv, 17, 5 - ((t + 3) % 6));
      break;
    }
    case 'happy': {
      face(cv, 'happy', 'open');
      const on = t % 2 === 0;
      pts(cv, on ? [[0, 2], [21, 4], [19, 0]] : [[1, 5], [20, 1], [21, 7]], 'Y');
      break;
    }
    case 'sad': {
      face(cv, 'open', 'sad');
      px(cv, 5, 8 + (t % 3), 'T');
      break;
    }
    case 'asking': {
      face(cv, blink ? 'closed' : 'open', 'o');
      pts(cv, [[19, 1], [20, 1], [21, 2], [20, 3], [20, 5]], 'Y');
      break;
    }
    default: {
      face(cv, blink ? 'closed' : 'open', 'smile');
      // od czasu do czasu macha ręką
      if (t % 60 >= 50) pts(cv, t % 2 ? [[17, 6], [17, 5]] : [[18, 6], [18, 5]], 'D');
    }
  }
  return cv;
}

/** Zamienia płótno na wiersze tekstu z kolorami ANSI (2 piksele na znak). */
export function toAnsi(cv) {
  const lines = [];
  for (let r = 0; r < H; r += 2) {
    let s = '';
    for (let x = 0; x < W; x++) {
      const top = cv[r][x];
      const bot = cv[r + 1][x];
      if (!top && !bot) s += '\x1b[0m ';
      else if (top && bot) s += `\x1b[38;2;${top}m\x1b[48;2;${bot}m▀`;
      else if (top) s += `\x1b[0m\x1b[38;2;${top}m▀`;
      else s += `\x1b[0m\x1b[38;2;${bot}m▄`;
    }
    lines.push(s + '\x1b[0m');
  }
  return lines;
}

// ---------- stan maskotki ----------

class MascotState {
  constructor() {
    this.state = 'idle';
    this.until = 0;
    this.t = 0;
    this.listeners = new Set();
  }

  /** Zmienia animację. `ms` — na ile (potem wraca do „idle”). */
  setState(state, ms = 0) {
    this.until = ms ? Date.now() + ms : 0;
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  /** Wywoływane co klatkę animacji. Zwraca true, gdy zmienił się stan. */
  tick() {
    this.t++;
    if (this.until && Date.now() > this.until) {
      this.until = 0;
      this.state = 'idle';
      for (const fn of this.listeners) fn();
      return true;
    }
    return false;
  }

  sprite() {
    return toAnsi(frame(this.state, this.t));
  }

  /** [ikona, opis] tego, co teraz robi maskotka. */
  label() {
    return STATUS[this.state] || STATUS.idle;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }
}

export const hud = new MascotState();
export const MASCOT_W = W;
export const MASCOT_ROWS = H / 2;
