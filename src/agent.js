import fs from 'node:fs';
import path from 'node:path';
import { c, accent, out, Spinner, MarkdownStream, randomVerb, truncateLine } from './ui.js';
import { getTool, toolDefs, clip } from './tools.js';
import { skillsPrompt } from './skills.js';
import { corePrompt } from './prompt.js';
import { todos } from './todos.js';
import { hud } from './mascot.js';

const MAX_STEPS = 80;
const PROJECT_FILES = ['EXOTIC.md', 'AGENTS.md', 'CLAUDE.md'];

export function buildSystemPrompt(cwd, model) {
  let prompt = corePrompt({ cwd, model });
  prompt += skillsPrompt(cwd);
  for (const name of PROJECT_FILES) {
    const p = path.join(cwd, name);
    try {
      if (fs.existsSync(p)) prompt += `\n\n# Project instructions (${name})\n${clip(fs.readFileSync(p, 'utf8'), 20000)}`;
    } catch {}
  }
  return prompt;
}

// Pojedyncza komenda bez łączenia, przekierowań i podstawień, z listy tylko do odczytu.
const READ_ONLY = new Set(['ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'echo', 'which', 'where', 'whoami',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'select-string', 'get-command', 'test-path', 'tree']);
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'remote', 'blame', 'ls-files', 'describe', 'shortlog', 'tag']);
const VERSION_FLAGS = /^(node|npm|npx|pnpm|yarn|bun|python|python3|py|pip|git|go|cargo|rustc|java|dotnet|deno|tsc)\s+(--version|-v|-V|version)$/i;

export function isReadOnlyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd || /[;&|><`$(){}\n]/.test(cmd)) return false;
  if (VERSION_FLAGS.test(cmd)) return true;
  const [first, sub, ...rest] = cmd.split(/\s+/);
  const name = first.toLowerCase();
  if (name === 'git') {
    if (!GIT_READ_ONLY.has(String(sub).toLowerCase())) return false;
    // `git branch -D x`, `git tag -d x`, `git remote add …` zmieniają stan
    if (['branch', 'tag', 'remote'].includes(sub) && rest.some((a) => /^(-[dDmMcC]|--delete|--move|--copy|add|remove|rm|rename|set-url)$/.test(a))) return false;
    if (['branch', 'tag'].includes(sub) && rest.some((a) => !a.startsWith('-'))) return false;
    if (rest.some((a) => a.startsWith('--output'))) return false;
    return true;
  }
  return READ_ONLY.has(name);
}

function toolHeader(tool, name, input) {
  const label = tool?.label || name;
  const arg = tool?.summary ? truncateLine(tool.summary(input || {}) ?? '', Math.max(20, (process.stdout.columns || 80) - label.length - 8)) : '';
  out(`${accent('●')} ${c.bold(label)}${arg ? c.dim('(') + arg + c.dim(')') : ''}`);
}

const resultLine = (s, color = c.dim) => out(`  ${c.dim('⎿')}  ${color(s)}`);
const resultMore = (s) => out(`     ${c.dim(s)}`);

export class Agent {
  constructor(app) {
    this.app = app;
    this.messages = [];
    this.usage = { input: 0, output: 0 };
    this.alwaysAllow = new Set();
    this.notes = [];
  }

  reset() {
    this.messages = [];
    this.notes = [];
    this.shellCwd = this.app.cwd;
    todos.clear();
  }

  addUserText(text) {
    const notes = this.notes.splice(0);
    const full = notes.length ? `${notes.join('\n\n')}\n\n${text}` : text;
    const last = this.messages.at(-1);
    if (last?.role === 'user') {
      const arr = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      arr.push({ type: 'text', text: full });
      last.content = arr;
    } else {
      this.messages.push({ role: 'user', content: full });
    }
  }

  async run(text, { signal, askPermission, model }) {
    const snapLen = this.messages.length;
    const snapLast = snapLen ? structuredClone(this.messages[snapLen - 1]) : null;
    this.addUserText(text);
    let system = buildSystemPrompt(this.app.cwd, model);
    if (this.app.mode === 'plan') {
      system += `\n\n# Plan mode
Plan mode is ON. Only read and analyze (read_file, list_dir, glob, grep, web_fetch, skill). Do not write or edit files and do not run commands. Finish with a clear, numbered implementation plan and ask the user to approve it (they switch modes with Shift+Tab).`;
    }
    const turnUsage = { input: 0, output: 0 };

    for (let step = 0; step < MAX_STEPS; step++) {
      const spinner = new Spinner();
      spinner.start(randomVerb());
      hud.setState('thinking');
      let md = new MarkdownStream();
      let partial = '';
      let thinking = false;
      let res;
      try {
        res = await this.app.client.stream(
          { system, messages: this.messages, tools: toolDefs(), model, maxTokens: this.app.config.maxTokens, effort: this.app.config.effort },
          {
            signal,
            onText: (t) => {
              spinner.stop();
              hud.setState('typing');
              thinking = false;
              partial += t;
              md.write(t);
            },
            onThinking: () => {
              if (!thinking) spinner.start('Rozmyślam');
              thinking = true;
            },
            onRetry: (msg) => spinner.start(msg),
            onToolStart: (name) => {
              hud.setState(name === 'write_file' || name === 'edit_file' ? 'typing' : 'thinking');
              md.end();
              md = new MarkdownStream();
              spinner.start(`Przygotowuję ${getTool(name)?.label || name}`);
            },
          },
        );
      } catch (e) {
        spinner.stop();
        md.end();
        if (signal.aborted || e.name === 'AbortError') {
          this.messages.push({ role: 'assistant', content: (partial ? partial + '\n\n' : '') + '[przerwane przez użytkownika]' });
          resultLine('Przerwano.', c.yellow);
          return turnUsage;
        }
        if (step === 0) {
          // przywróć historię sprzed tej wiadomości, żeby można było spokojnie ponowić
          this.messages.length = snapLen;
          if (snapLast) this.messages[snapLen - 1] = snapLast;
        } else {
          this.messages.push({ role: 'assistant', content: `[błąd API: ${e.message}]` });
        }
        throw e;
      }
      spinner.stop();
      md.end();

      turnUsage.input += res.usage.input;
      turnUsage.output += res.usage.output;
      this.usage.input += res.usage.input;
      this.usage.output += res.usage.output;
      this.app.lastInputTokens = res.usage.input;

      const visible = res.content.filter((b) => b.type === 'text' || b.type === 'tool_use');
      const content = visible.length ? res.content : [...res.content, { type: 'text', text: '(pusta odpowiedź)' }];
      const uses = content.filter((b) => b.type === 'tool_use');
      // do historii trafiają tylko pola akceptowane przez API
      this.messages.push({
        role: 'assistant',
        content: content.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : b)),
      });

      if (!uses.length) {
        if (res.stopReason === 'max_tokens') resultLine('Odpowiedź ucięta — osiągnięto limit max_tokens.', c.yellow);
        return turnUsage;
      }

      const results = [];
      for (const tu of uses) {
        if (signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Przerwane przez użytkownika.', is_error: true });
          continue;
        }
        results.push(await this.execTool(tu, { signal, askPermission }));
      }
      this.messages.push({ role: 'user', content: results });
      if (signal.aborted) {
        resultLine('Przerwano.', c.yellow);
        return turnUsage;
      }
    }
    resultLine(`Zatrzymano po ${MAX_STEPS} krokach.`, c.yellow);
    return turnUsage;
  }

  async execTool(tu, { signal, askPermission }) {
    const tool = getTool(tu.name);
    const fail = (msg) => {
      resultLine(msg, c.red);
      return { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true };
    };
    toolHeader(tool, tu.name, tu.input);
    if (!tool) return fail(`Nieznane narzędzie: ${tu.name}`);
    if (tu.parseError) return fail('Nie udało się sparsować argumentów narzędzia (niepoprawny JSON). Spróbuj ponownie.');

    // bieżący katalog (zmienia go `cd` w bash) + katalog projektu; znikły katalog → wracamy do projektu
    if (!this.shellCwd || !fs.existsSync(this.shellCwd)) this.shellCwd = this.app.cwd;
    const ctx = { cwd: this.shellCwd, root: this.app.cwd, signal, setCwd: (dir) => (this.shellCwd = dir) };
    const mode = this.app.mode || 'manual';
    if (tool.needsPermission && mode === 'plan') {
      resultLine('Tryb plan — bez zmian w plikach i komend.', c.yellow);
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'Plan mode is active: you must not modify files or run commands. Present your plan to the user instead; they will switch modes when ready.',
        is_error: true,
      };
    }
    // auto: pliki zapisuje sam, o komendy pyta · bypass: nie pyta o nic
    // komendy tylko do odczytu (git status/diff/log, ls…) nie wymagają zgody w żadnym trybie
    const autoOk =
      mode === 'bypass' ||
      (mode === 'auto' && (tu.name === 'write_file' || tu.name === 'edit_file')) ||
      (tu.name === 'bash' && isReadOnlyCommand(tu.input?.command));
    if (tool.needsPermission && !autoOk && !this.alwaysAllow.has(tu.name)) {
      let preview = [];
      try {
        preview = tool.preview?.(tu.input, ctx) || [];
      } catch {}
      const answer = await askPermission(tool, tu.input, preview);
      if (answer === 'always') this.alwaysAllow.add(tu.name);
      else if (answer !== 'yes') {
        resultLine('Odrzucono przez użytkownika.', c.yellow);
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'The user denied this action. Do not retry it; ask the user how to proceed instead.',
          is_error: true,
        };
      }
    }

    const spinner = new Spinner();
    hud.setState(tu.name === 'bash' ? 'guitar' : tu.name === 'write_file' || tu.name === 'edit_file' ? 'typing' : 'thinking');
    if (tu.name === 'bash' || tu.name === 'web_fetch') spinner.start('Wykonuję');
    try {
      const r = await tool.run(tu.input || {}, ctx);
      spinner.stop();
      const display = Array.isArray(r.display) ? r.display : [r.display || (r.isError ? r.output : 'OK')];
      const color = r.isError ? c.red : c.dim;
      display.forEach((l, i) => (i === 0 ? resultLine(truncateLine(l, 200), color) : resultMore(truncateLine(l, 200))));
      if (r.displayStatus && r.isError) resultMore(r.displayStatus);
      return { type: 'tool_result', tool_use_id: tu.id, content: clip(String(r.output ?? '')), is_error: !!r.isError };
    } catch (e) {
      spinner.stop();
      if (signal.aborted) return fail('Przerwane przez użytkownika.');
      return fail(`Błąd: ${e.message}`);
    }
  }

  async compact({ signal, model }) {
    if (this.messages.length < 2) return false;
    const spinner = new Spinner();
    spinner.start('Kompaktuję rozmowę');
    try {
      const res = await this.app.client.stream(
        {
          system: buildSystemPrompt(this.app.cwd),
          model,
          maxTokens: 4000,
          tools: toolDefs(),
          messages: [
            ...this.messages,
            {
              role: 'user',
              content:
                'Do NOT use any tools. Write a concise but complete summary of this conversation so far so it can continue in a fresh context: the user\'s goals, decisions made, files changed (with paths), current state and the next steps. Write it in the user\'s language.',
            },
          ].reduce(mergeConsecutiveUsers, []),
        },
        { signal },
      );
      const summary = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!summary) return false;
      this.messages = [
        { role: 'user', content: `Podsumowanie wcześniejszej części rozmowy:\n\n${summary}` },
        { role: 'assistant', content: 'Jasne, mam kontekst. Kontynuujmy.' },
      ];
      return summary;
    } finally {
      spinner.stop();
    }
  }
}

function mergeConsecutiveUsers(acc, m) {
  const last = acc.at(-1);
  if (last?.role === 'user' && m.role === 'user') {
    const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
    const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    acc[acc.length - 1] = { role: 'user', content: [...a, ...b] };
  } else acc.push(m);
  return acc;
}
