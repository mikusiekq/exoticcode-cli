import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { c } from './ui.js';
import { loadSkill, listSkills } from './skills.js';
import { todos as todoState } from './todos.js';

const IS_WIN = process.platform === 'win32';
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.cache', '.turbo']);
const MAX_OUTPUT = 30000;

const resolvePath = (p, cwd) => path.resolve(cwd, String(p ?? '.'));
const rel = (p, cwd) => path.relative(cwd, p) || '.';
const toPosix = (p) => p.split(path.sep).join('/');

function clip(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [obcięto ${text.length - max} znaków] …\n\n${text.slice(-half)}`;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function* walk(dir, limit = 50000) {
  const stack = [dir];
  let count = 0;
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (++count > limit) return;
        yield full;
      }
    }
  }
}

export function globToRegex(glob) {
  let g = toPosix(String(glob)).replace(/^\.\//, '');
  if (!g.includes('/')) g = '**/' + g;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += '(?:' + g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = end;
      }
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', IS_WIN ? 'i' : '');
}

function lineDiff(oldStr, newStr, maxLines = 30) {
  const lines = [];
  for (const l of oldStr.split('\n')) lines.push(c.red('- ' + l));
  for (const l of newStr.split('\n')) lines.push(c.green('+ ' + l));
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), c.dim(`… (+${lines.length - maxLines} linii)`)];
  return lines;
}

function killTree(child) {
  if (!child.pid) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export function runShell(command, { cwd, timeout = 120000, signal } = {}) {
  return new Promise((resolve) => {
    const child = IS_WIN
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`],
          { cwd, windowsHide: true })
      : spawn(process.env.SHELL || '/bin/bash', ['-c', command], { cwd, detached: true });
    let output = '';
    let timedOut = false;
    const onData = (d) => {
      output += d.toString('utf8');
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `Nie udało się uruchomić: ${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: output.replace(/\r\n/g, '\n'), timedOut });
    });
  });
}

// ---------- definicje narzędzi ----------

export const TOOLS = [
  {
    name: 'read_file',
    label: 'Read',
    description: 'Read a text file from disk. Returns content with line numbers (format "N\\tline"). Use offset/limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to the working directory)' },
        offset: { type: 'integer', description: '1-based line number to start from' },
        limit: { type: 'integer', description: 'Max number of lines to read (default 2000)' },
      },
      required: ['path'],
    },
    summary: (i) => i.path,
    async run(input, { cwd }) {
      const p = resolvePath(input.path, cwd);
      if (!fs.existsSync(p)) return { isError: true, output: `Plik nie istnieje: ${p}` };
      const st = fs.statSync(p);
      if (st.isDirectory()) return { isError: true, output: `${p} to katalog — użyj list_dir.` };
      if (st.size > 10 * 1024 * 1024) return { isError: true, output: 'Plik jest za duży (>10MB).' };
      const buf = fs.readFileSync(p);
      if (isBinary(buf)) return { isError: true, output: 'To plik binarny.' };
      const lines = buf.toString('utf8').split(/\r?\n/);
      const start = Math.max(1, input.offset || 1);
      const limit = Math.max(1, input.limit || 2000);
      const slice = lines.slice(start - 1, start - 1 + limit);
      const body = slice.map((l, i) => `${start + i}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
      const more = start - 1 + slice.length < lines.length ? `\n\n(plik ma ${lines.length} linii — użyj offset, aby czytać dalej)` : '';
      return { output: (body || '(pusty plik)') + more, display: `Przeczytano ${slice.length} linii` };
    },
  },
  {
    name: 'write_file',
    label: 'Write',
    needsPermission: true,
    description: 'Create a new file or completely overwrite an existing one. Parent directories are created automatically. Prefer edit_file for changes to existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    summary: (i) => i.path,
    preview(input, { cwd }) {
      const p = resolvePath(input.path, cwd);
      const content = String(input.content ?? '');
      const lines = content.split('\n');
      const head = fs.existsSync(p) ? c.yellow(`Nadpisze istniejący plik (${lines.length} linii)`) : c.green(`Nowy plik (${lines.length} linii)`);
      const shown = lines.slice(0, 15).map((l) => c.green('+ ' + l));
      if (lines.length > 15) shown.push(c.dim(`… (+${lines.length - 15} linii)`));
      return [head, ...shown];
    },
    async run(input, { cwd }) {
      const p = resolvePath(input.path, cwd);
      const content = String(input.content ?? '');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const existed = fs.existsSync(p);
      fs.writeFileSync(p, content, 'utf8');
      const n = content.split('\n').length;
      return { output: `${existed ? 'Nadpisano' : 'Utworzono'} ${p} (${n} linii).`, display: `${existed ? 'Nadpisano' : 'Utworzono'} · ${n} linii` };
    },
  },
  {
    name: 'edit_file',
    label: 'Edit',
    needsPermission: true,
    description: 'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    summary: (i) => i.path,
    preview(input) {
      return lineDiff(String(input.old_string ?? ''), String(input.new_string ?? ''));
    },
    async run(input, { cwd }) {
      const p = resolvePath(input.path, cwd);
      if (!fs.existsSync(p)) return { isError: true, output: `Plik nie istnieje: ${p}` };
      let text = fs.readFileSync(p, 'utf8');
      let oldS = String(input.old_string ?? '');
      let newS = String(input.new_string ?? '');
      if (!oldS) return { isError: true, output: 'old_string nie może być pusty.' };
      if (!text.includes(oldS) && text.includes('\r\n')) {
        oldS = oldS.replace(/\r?\n/g, '\r\n');
        newS = newS.replace(/\r?\n/g, '\r\n');
      }
      const count = text.split(oldS).length - 1;
      if (count === 0) return { isError: true, output: 'Nie znaleziono old_string w pliku. Przeczytaj plik ponownie i użyj dokładnego tekstu.' };
      if (count > 1 && !input.replace_all) {
        return { isError: true, output: `old_string występuje ${count} razy. Dodaj więcej kontekstu albo ustaw replace_all.` };
      }
      text = input.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      fs.writeFileSync(p, text, 'utf8');
      const removed = oldS.split('\n').length;
      const added = newS.split('\n').length;
      return { output: `Zmieniono ${p} (${input.replace_all ? count : 1} zamian).`, display: `+${added} −${removed} linii` };
    },
  },
  {
    name: 'list_dir',
    label: 'List',
    description: 'List files and directories in a directory (non-recursive).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: working directory)' } },
    },
    summary: (i) => i.path || '.',
    async run(input, { cwd }) {
      const p = resolvePath(input.path || '.', cwd);
      let entries;
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch (e) {
        return { isError: true, output: `Nie można odczytać katalogu: ${e.message}` };
      }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      const lines = entries.slice(0, 1000).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
      if (entries.length > 1000) lines.push(`… (+${entries.length - 1000})`);
      return { output: lines.join('\n') || '(pusty katalog)', display: `${entries.length} elementów` };
    },
  },
  {
    name: 'glob',
    label: 'Glob',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.{js,jsx}". A pattern without "/" matches at any depth. node_modules and .git are skipped.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search in (default: working directory)' },
      },
      required: ['pattern'],
    },
    summary: (i) => i.pattern + (i.path ? ` w ${i.path}` : ''),
    async run(input, { cwd }) {
      const root = resolvePath(input.path || '.', cwd);
      const re = globToRegex(input.pattern);
      const found = [];
      for (const f of walk(root)) {
        if (re.test(toPosix(path.relative(root, f)))) {
          found.push(f);
          if (found.length >= 1000) break;
        }
      }
      const lines = found.map((f) => toPosix(rel(f, cwd))).sort();
      return { output: lines.join('\n') || 'Brak dopasowań.', display: `${found.length} plików` };
    },
  },
  {
    name: 'grep',
    label: 'Grep',
    description: 'Search file contents with a JavaScript regular expression. Returns "file:line: text" matches. Optionally filter files with a glob.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        path: { type: 'string', description: 'File or directory to search (default: working directory)' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py"' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    summary: (i) => i.pattern + (i.glob ? ` (${i.glob})` : ''),
    async run(input, { cwd }) {
      let re;
      try {
        re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
      } catch (e) {
        return { isError: true, output: `Niepoprawny regex: ${e.message}` };
      }
      const root = resolvePath(input.path || '.', cwd);
      const globRe = input.glob ? globToRegex(input.glob) : null;
      const files = fs.existsSync(root) && fs.statSync(root).isFile() ? [root] : walk(root);
      const matches = [];
      let fileCount = 0;
      outer: for (const f of files) {
        if (globRe && !globRe.test(toPosix(path.relative(root, f)))) continue;
        let buf;
        try {
          if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
          buf = fs.readFileSync(f);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        let hit = false;
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hit = true;
            const l = lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i];
            matches.push(`${toPosix(rel(f, cwd))}:${i + 1}: ${l}`);
            if (matches.length >= 300) break outer;
          }
        }
        if (hit) fileCount++;
      }
      return {
        output: matches.join('\n') || 'Brak dopasowań.',
        display: `${matches.length} dopasowań w ${fileCount} plikach`,
      };
    },
  },
  {
    name: 'bash',
    label: 'Bash',
    needsPermission: true,
    description: IS_WIN
      ? 'Run a shell command in the working directory. On this machine the shell is Windows PowerShell 5.1 (use PowerShell syntax; `&&` is not available, use `;`). Returns combined stdout/stderr and exit code.'
      : 'Run a shell command in the working directory using bash. Returns combined stdout/stderr and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        timeout: { type: 'integer', description: 'Timeout in seconds (default 120, max 600)' },
      },
      required: ['command'],
    },
    summary: (i) => i.command,
    preview: (i) => [c.cyan(String(i.command ?? ''))],
    async run(input, { cwd, signal }) {
      const timeout = Math.min(600, Math.max(1, input.timeout || 120)) * 1000;
      const r = await runShell(String(input.command ?? ''), { cwd, timeout, signal });
      const text = clip(r.output.trimEnd());
      const status = r.timedOut ? `Przekroczono limit czasu (${timeout / 1000}s)` : `Kod wyjścia: ${r.code}`;
      const shown = text.replace(/^(\s*\n)+/, '');
      const lines = shown ? shown.split('\n') : [];
      const preview = lines.slice(0, 6);
      if (lines.length > 6) preview.push(`… (+${lines.length - 6} linii)`);
      return {
        isError: r.code !== 0,
        output: `${text || '(brak wyjścia)'}\n\n[${status}]`,
        display: preview.length ? preview : ['(brak wyjścia)'],
        displayStatus: status,
      };
    },
  },
  {
    name: 'web_fetch',
    label: 'Fetch',
    description: 'Fetch a URL over HTTP(S) and return its content as text (HTML is converted to plain text).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' } },
      required: ['url'],
    },
    summary: (i) => i.url,
    async run(input, { signal }) {
      const url = String(input.url ?? '');
      if (!/^https?:\/\//i.test(url)) return { isError: true, output: 'Dozwolone są tylko adresy http(s).' };
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { 'user-agent': 'Mozilla/5.0 exoticcode' },
      });
      let text = await res.text();
      if ((res.headers.get('content-type') || '').includes('html')) {
        text = text
          .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
          .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\n\s*\n\s*\n+/g, '\n\n');
      }
      return { isError: !res.ok, output: `[HTTP ${res.status}]\n${clip(text.trim(), 20000)}`, display: `HTTP ${res.status} · ${text.length} znaków` };
    },
  },
];

TOOLS.push({
  name: 'skill',
  label: 'Skill',
  description: 'Load a skill (expert instructions + resources for a specific kind of task) by name. Use it before starting a task that matches one of the available skills listed in the system prompt.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name' } },
    required: ['name'],
  },
  summary: (i) => i.name,
  async run(input, { cwd }) {
    const loaded = loadSkill(cwd, input.name);
    if (!loaded) {
      const names = listSkills(cwd).map((s) => s.name).join(', ') || 'brak';
      return { isError: true, output: `Nie ma skilla "${input.name}". Dostępne: ${names}` };
    }
    return { output: loaded.text, display: `Załadowano skill ${loaded.skill.name}` };
  },
});

// Lista zadań, którą model prowadzi przy większych zadaniach (jak TodoWrite w Claude Code / plan w Codexie).
TOOLS.push({
  name: 'todo_write',
  label: 'Todo',
  description:
    'Create or update the task list for the current multi-step task. Always send the FULL list. Each item: content (short imperative step) and status: pending | in_progress | completed. Keep exactly one item in_progress while working, and mark items completed immediately after finishing them. Use for tasks with 3+ steps; skip for trivial requests.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summary: (i) => {
    const list = Array.isArray(i.todos) ? i.todos : [];
    return `${list.filter((t) => t.status === 'completed').length}/${list.length}`;
  },
  async run(input) {
    if (!Array.isArray(input.todos)) return { isError: true, output: 'todos must be an array' };
    const items = input.todos.map((t) => ({ content: String(t.content || ''), status: ['in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
    todoState.set(items);
    const display = items.map((t) =>
      t.status === 'completed' ? c.green('☑ ') + c.dim(t.content) : t.status === 'in_progress' ? c.yellow('◐ ') + c.bold(t.content) : '☐ ' + t.content,
    );
    const done = items.filter((t) => t.status === 'completed').length;
    return { output: `Todo list updated (${done}/${items.length} completed).`, display: display.length ? display : ['(pusta lista)'] };
  },
});

export const toolDefs = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
export const getTool = (name) => TOOLS.find((t) => t.name === name);
export { clip };
