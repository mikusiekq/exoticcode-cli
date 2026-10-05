import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// wersja w jednym miejscu — w package.json (podbijana przez `npm version`)
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_BASE_URL = 'https://api.kradnebabci.rent';
export const CONFIG_DIR = process.env.EXOTICCODE_HOME || path.join(os.homedir(), '.exoticcode');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
export const HISTORY_PATH = path.join(CONFIG_DIR, 'history.json');

export const BUILTIN_MODELS = [
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'grok-4.6',
  'grok-4.7',
];

export const DEFAULT_MODEL = 'claude-opus-5-5';

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  token: null,
  model: DEFAULT_MODEL,
  // 'auto' | 'anthropic' | 'openai' — 'auto' wykrywa format osobno dla każdego modelu
  format: 'auto',
  // zapamiętane wyniki auto-wykrywania: { [model]: 'anthropic' | 'openai' }
  formats: {},
  // zmiana wersji kasuje stare wyniki wykrywania formatu
  formatsVersion: 3,
  maxTokens: 16000,
  // pasek z animowaną maskotką na górze terminala
  mascot: true,
  // sprawdzanie i instalowanie nowej wersji z GitHuba przy starcie
  autoUpdate: true,
  // przewijanie czatu kółkiem myszy (zaznaczanie tekstu wtedy z Shift)
  mouse: true,
  // 'auto' (nic nie wysyłamy) | 'low' | 'medium' | 'high' | 'max'
  effort: 'auto',
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  if (saved.formatsVersion !== DEFAULTS.formatsVersion) {
    saved.formats = {};
    saved.formatsVersion = DEFAULTS.formatsVersion;
  }
  const cfg = { ...DEFAULTS, ...saved };
  // nadpisania ze zmiennych środowiskowych nie trafiają do pliku przy zapisie
  const env = {};
  if (process.env.EXOTICCODE_TOKEN) env.token = process.env.EXOTICCODE_TOKEN;
  if (process.env.EXOTICCODE_BASE_URL) env.baseUrl = process.env.EXOTICCODE_BASE_URL;
  if (process.env.EXOTICCODE_MODEL) env.model = process.env.EXOTICCODE_MODEL;
  Object.defineProperty(cfg, '_env', { value: { values: { ...env }, saved: { ...cfg } } });
  return Object.assign(cfg, env);
}

export function saveConfig(cfg) {
  ensureDir(CONFIG_DIR);
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const env = cfg._env;
    out[key] = env && key in env.values && cfg[key] === env.values[key] ? env.saved[key] : cfg[key];
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), { mode: 0o600 });
}

export function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(h) ? h.slice(0, 500) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history) {
  try {
    ensureDir(CONFIG_DIR);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(0, 500)));
  } catch {}
}

// ---------- sesje ----------

export function saveSession(session) {
  try {
    ensureDir(SESSIONS_DIR);
    session.updated = Date.now();
    fs.writeFileSync(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session));
  } catch {}
}

export function listSessions(cwd) {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (!cwd || s.cwd === cwd) sessions.push(s);
    } catch {}
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}
