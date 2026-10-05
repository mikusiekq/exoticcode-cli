import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.js';

export const SKILLS_DIR = path.join(CONFIG_DIR, 'skills');
// skille dołączone do EXOTICCODE (folder skills/ obok src/)
const BUNDLED_DIR = fileURLToPath(new URL('../skills', import.meta.url));
// Oficjalne katalogi skilli: Anthropic (Claude) i OpenAI (Codex), oba na licencji Apache 2.0.
const SOURCES = {
  anthropic: { repo: 'anthropics/skills', branch: 'main', pattern: /^skills\/([^/]+)\/(.+)$/ },
  openai: { repo: 'openai/skills', branch: 'main', pattern: /^skills\/\.(?:curated|system)\/([^/]+)\/(.+)$/ },
};

// Zestaw instalowany przez `/skills install` bez nazw.
export const RECOMMENDED = [
  'skill-creator', 'frontend-design', 'webapp-testing', 'mcp-builder', 'claude-api',
  'web-artifacts-builder', 'pdf', 'docx', 'xlsx', 'pptx',
  'algorithmic-art', 'canvas-design', 'theme-factory', 'slack-gif-creator', 'doc-coauthoring', 'brand-guidelines', 'internal-comms',
  // z katalogu OpenAI Codex — te, które działają z narzędziami EXOTICCODE (powłoka, pliki, gh, npx)
  'openai:gh-fix-ci', 'openai:gh-address-comments', 'openai:yeet', 'openai:playwright', 'openai:screenshot',
  'openai:security-best-practices', 'openai:security-threat-model', 'openai:security-ownership-map',
  'openai:cli-creator', 'openai:jupyter-notebook', 'openai:vercel-deploy', 'openai:netlify-deploy',
  'openai:render-deploy', 'openai:cloudflare-deploy', 'openai:sentry', 'openai:aspnet-core', 'openai:winui-app',
  'openai:chatgpt-apps',
];

// Skąd wczytujemy skille (pierwszy wygrywa przy tej samej nazwie).
function skillRoots(cwd) {
  return [
    { dir: path.join(cwd, '.exoticcode', 'skills'), source: 'projekt' },
    { dir: path.join(cwd, '.claude', 'skills'), source: 'projekt (.claude)' },
    { dir: SKILLS_DIR, source: 'globalny' },
    { dir: path.join(os.homedir(), '.claude', 'skills'), source: 'Claude Code' },
    { dir: BUNDLED_DIR, source: 'wbudowany' },
  ];
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].replace(/^["']|["']$/g, '').trim();
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = (meta[key] + ' ' + line.trim()).trim();
    }
  }
  for (const k of Object.keys(meta)) meta[k] = meta[k].replace(/^[|>][-+]?\s*/, '').trim();
  return { meta, body: m[2] };
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listSkills(cwd) {
  const found = new Map();
  for (const { dir, source } of skillRoots(cwd)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // dowiązania (symlink/junction) do folderów skilli też się liczą
      if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(path.join(dir, e.name)))) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const name = meta.name || e.name;
        if (!found.has(name)) found.set(name, { name, description: meta.description || '', dir: path.join(dir, e.name), file, source });
      } catch {}
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsPrompt(cwd) {
  const skills = listSkills(cwd);
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description.slice(0, 400)}`);
  return `\n\n# Skills
You have access to skills: folders with expert instructions, scripts and resources for specific tasks, written by experts. They make your output much better than working from general knowledge.
IMPORTANT — this is a blocking requirement: whenever the user's task matches a skill's description (e.g. building a web page or UI → frontend-design, working with PDF/DOCX/XLSX/PPTX files → that skill, building an MCP server → mcp-builder), your FIRST action must be calling the \`skill\` tool with that skill's name — before reading files, planning or writing code. Then follow the loaded instructions. Skip skills that are not relevant to the task.
Skills come from different agents (EXOTICCODE, Claude Code, OpenAI Codex). Translate their tool names to yours: shell / Bash / exec_command → bash · apply_patch / Edit / str_replace → edit_file · Write / create_file → write_file · Read / view → read_file · Glob → glob · Grep / rg → grep · update_plan / TodoWrite → todo_write · WebFetch → web_fetch. Ignore instructions about tools you don't have (MCP servers, image generation, js_repl) and tell the user if a skill needs one. Paths like $CODEX_HOME/skills/<name> or ~/.claude/skills/<name> mean the skill's base directory given when you load it.
Available skills:
${lines.join('\n')}`;
}

function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
    if (out.length > 200) break;
  }
  return out;
}

export function loadSkill(cwd, name) {
  const skill = listSkills(cwd).find((s) => s.name.toLowerCase() === String(name || '').toLowerCase());
  if (!skill) return null;
  const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
  const files = listFiles(skill.dir).filter((f) => f !== 'SKILL.md');
  return {
    skill,
    text: `# Skill: ${skill.name}
Base directory for this skill: ${skill.dir}
Relative paths mentioned below are relative to that directory (read them with read_file, run scripts with bash).
${files.length ? `Files in the skill:\n${files.slice(0, 100).map((f) => '- ' + f).join('\n')}\n` : ''}
${body.trim()}`,
  };
}

// ---------- instalacja z oficjalnych repozytoriów (Anthropic, OpenAI) ----------

const treeCache = new Map();

async function fetchTree(source) {
  if (treeCache.has(source)) return treeCache.get(source);
  const { repo, branch, pattern } = SOURCES[source];
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, {
    headers: { 'user-agent': 'exoticcode', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GitHub (${repo}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const skills = new Map();
  for (const t of json.tree || []) {
    const m = t.path.match(pattern);
    if (!m || t.type !== 'blob') continue;
    // ten sam skill bywa w .curated i .system — bierzemy pierwszy
    if (!skills.has(m[1])) skills.set(m[1], { prefix: t.path.slice(0, t.path.length - m[2].length), files: [] });
    const entry = skills.get(m[1]);
    if (t.path.startsWith(entry.prefix)) entry.files.push({ rel: m[2], path: t.path, size: t.size });
  }
  treeCache.set(source, skills);
  return skills;
}

/** Wszystkie skille z obu katalogów: [{ name, source, files, size }]. */
export async function availableSkills() {
  const out = [];
  for (const source of Object.keys(SOURCES)) {
    const tree = await fetchTree(source);
    for (const [name, { files }] of tree) out.push({ name, source, files: files.length, size: files.reduce((a, f) => a + (f.size || 0), 0) });
  }
  return out;
}

// "openai:nazwa" / "anthropic:nazwa" albo sama nazwa (szukana najpierw u Anthropic, potem w OpenAI)
async function resolveSkill(spec) {
  const [maybeSource, rest] = spec.includes(':') ? spec.split(':', 2) : [null, spec];
  const sources = maybeSource && SOURCES[maybeSource] ? [maybeSource] : Object.keys(SOURCES);
  const name = maybeSource && SOURCES[maybeSource] ? rest : spec;
  for (const source of sources) {
    const hit = (await fetchTree(source)).get(name);
    if (hit) return { name, source, files: hit.files };
  }
  return { name, source: null, files: null };
}

/** Pobiera skille do ~/.exoticcode/skills. onProgress(name, i, total). */
export async function installSkills(names, onProgress) {
  if (names.includes('all')) {
    const all = await availableSkills();
    const seen = new Set();
    names = all.filter((s) => !seen.has(s.name) && seen.add(s.name)).map((s) => `${s.source}:${s.name}`);
  }
  const results = [];
  for (const spec of names) {
    const { name, source, files } = await resolveSkill(spec);
    if (!files) {
      results.push({ name, ok: false, error: 'nie ma takiego skilla w katalogach Anthropic ani OpenAI' });
      continue;
    }
    const { repo, branch } = SOURCES[source];
    const target = path.join(SKILLS_DIR, name);
    const tmp = `${target}.tmp-${Date.now()}`;
    try {
      let i = 0;
      // pobieramy po kilka plików naraz
      const queue = [...files];
      const worker = async () => {
        while (queue.length) {
          const f = queue.shift();
          const url = `https://raw.githubusercontent.com/${repo}/${branch}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw new Error(`${f.rel}: HTTP ${res.status}`);
          const dest = path.join(tmp, ...f.rel.split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          onProgress?.(name, ++i, files.length);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(tmp, target);
      results.push({ name, source, ok: true, files: files.length });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      results.push({ name, ok: false, error: e.message });
    }
  }
  return results;
}

export function removeSkill(name) {
  const dir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
