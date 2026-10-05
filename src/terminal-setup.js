import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shift+Enter wysyła ESC+CR (tak jak Alt+Enter) — EXOTICCODE traktuje to jako nową linię.
const SEQ_JSON = '\\u001b\\r';

function windowsTerminalFiles() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
}

function editorKeybindingFiles() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const base =
    process.platform === 'win32' ? appData
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.config');
  return [
    { name: 'VS Code', file: path.join(base, 'Code', 'User', 'keybindings.json') },
    { name: 'Cursor', file: path.join(base, 'Cursor', 'User', 'keybindings.json') },
  ];
}

// Wstawia tekst zaraz po otwierającym "[" tablicy — zachowuje komentarze w pliku.
function insertIntoArray(text, arrayStart, entry) {
  const after = text.slice(arrayStart + 1);
  const isEmpty = /^\s*\]/.test(after.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  return text.slice(0, arrayStart + 1) + `\n    ${entry}${isEmpty ? '' : ','}` + after;
}

function backup(file) {
  fs.copyFileSync(file, `${file}.exoticcode-backup`);
}

/** Zwraca listę plików do zmiany: [{ name, file, apply() }]. */
export function planTerminalSetup() {
  const plan = [];

  for (const file of windowsTerminalFiles()) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('"shift+enter"') || text.includes("'shift+enter'")) {
      plan.push({ name: 'Windows Terminal', file, already: true });
      continue;
    }
    const entry = `{ "command": { "action": "sendInput", "input": "${SEQ_JSON}" }, "keys": "shift+enter" }`;
    plan.push({
      name: 'Windows Terminal',
      file,
      apply() {
        let out;
        const m = text.match(/"actions"\s*:\s*\[/);
        if (m) out = insertIntoArray(text, m.index + m[0].length - 1, entry);
        else {
          const first = text.indexOf('{');
          if (first === -1) throw new Error('nie rozpoznano pliku ustawień');
          out = text.slice(0, first + 1) + `\n    "actions": [ ${entry} ],` + text.slice(first + 1);
        }
        backup(file);
        fs.writeFileSync(file, out, 'utf8');
      },
    });
  }

  for (const { name, file } of editorKeybindingFiles()) {
    if (!fs.existsSync(path.dirname(file))) continue;
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.includes('"shift+enter"') && text.includes('workbench.action.terminal.sendSequence')) {
      plan.push({ name, file, already: true });
      continue;
    }
    const entry = `{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "${SEQ_JSON}" }, "when": "terminalFocus" }`;
    plan.push({
      name,
      file,
      apply() {
        let out;
        const start = text.indexOf('[');
        if (!text.trim() || start === -1) out = `[\n    ${entry}\n]\n`;
        else {
          backup(file);
          out = insertIntoArray(text, start, entry);
        }
        fs.writeFileSync(file, out, 'utf8');
      },
    });
  }
  return plan;
}
