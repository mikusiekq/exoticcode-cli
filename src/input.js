import fs from 'node:fs';

// Jeden stały odbiornik klawiatury na cały czas działania programu.
// Terminal przełączamy w tryb raw raz, a dane trafiają do aktualnego „właściciela”
// (pole wpisywania, menu, pytanie o zgodę, nasłuch Esc w trakcie pracy agenta).
// Unikamy w ten sposób ciągłego setRawMode/pause/resume, które na Windows potrafi zawiesić wejście.

const stdin = process.stdin;
const debugFile = process.env.EXOTICCODE_DEBUG_KEYS;
let started = false;
const stack = [];
let typeahead = '';

function dispatch(data) {
  if (debugFile) {
    try {
      fs.appendFileSync(debugFile, JSON.stringify({ t: Date.now(), owner: stack.length, data }) + '\n');
    } catch {}
  }
  const handler = stack.at(-1);
  if (handler) return handler(data);
  // nikt nie słucha — Ctrl+C kończy program, resztę zapamiętujemy do następnego pola wpisywania
  if (data === '\x03') process.exit(130);
  typeahead += data;
}

export function inputAvailable() {
  return !!stdin.isTTY;
}

function start() {
  if (started || !stdin.isTTY) return;
  started = true;
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', dispatch);
  stdin.resume();
  process.on('exit', () => {
    try {
      stdin.setRawMode(false);
    } catch {}
  });
}

/** Przejmuje klawiaturę. Zwraca funkcję oddającą ją z powrotem. */
export function useInput(handler) {
  start();
  stack.push(handler);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = stack.lastIndexOf(handler);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Tekst wpisany, gdy nikt nie słuchał (np. w trakcie pracy agenta). */
export function takeTypeahead() {
  const t = typeahead;
  typeahead = '';
  return t;
}

export function pushTypeahead(text) {
  typeahead += text;
}

/**
 * Po zakończeniu procesu potomnego (komendy) przywraca tryb raw —
 * niektóre programy na Windows zmieniają tryb konsoli przy wyjściu.
 */
export function reassertRawMode() {
  if (!started || !stdin.isTTY) return;
  try {
    stdin.setRawMode(false);
    stdin.setRawMode(true);
  } catch {}
}
