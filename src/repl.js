import {
  VERSION, BUILTIN_MODELS, DEFAULT_BASE_URL, CONFIG_PATH, CONFIG_DIR,
  loadConfig, saveConfig, loadHistory, saveHistory, saveSession, listSessions, newSessionId, SESSIONS_DIR,
} from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { latestVersion, isNewer, runNpmInstall, installedVersion } from './update.js';
import { ApiClient, ApiError, EFFORTS } from './api.js';
import { Agent } from './agent.js';
import { runShell } from './tools.js';
import { c, accent, accent2, out, banner, clearScreen, select, truncateLine, Spinner } from './ui.js';
import { runSetup, EFFORT_ITEMS } from './setup.js';
import { editLine, InputBuffer, stripAnsi } from './editor.js';
import { useInput, pushTypeahead } from './input.js';
import { hud } from './mascot.js';
import { tui, MODES, MODE_ORDER } from './tui.js';
import { planTerminalSetup } from './terminal-setup.js';
import { listSkills, installSkills, availableSkills, removeSkill, RECOMMENDED, SKILLS_DIR } from './skills.js';

const stdin = process.stdin;

const COMMANDS = [
  ['/help', 'Pokaż pomoc'],
  ['/login', 'Zaloguj się tokenem API'],
  ['/logout', 'Usuń zapisany token'],
  ['/model', 'Wybierz model (/model <nazwa> albo lista)'],
  ['/models', 'Pokaż dostępne modele'],
  ['/effort', 'Poziom rozumowania: auto | low | medium | high | max'],
  ['/new', 'Nowy czat'],
  ['/chats', 'Lista czatów z tego katalogu — wybierz, aby wznowić'],
  ['/resume', 'To samo co /chats'],
  ['/rename', 'Zmień nazwę bieżącego czatu'],
  ['/export', 'Zapisz bieżący czat do pliku .md'],
  ['/delete', 'Usuń zapisany czat'],
  ['/clear', 'Wyczyść ekran i zacznij nowy czat'],
  ['/compact', 'Streść rozmowę, żeby zwolnić kontekst'],
  ['/init', 'Utwórz plik EXOTIC.md z opisem projektu'],
  ['/skills', 'Skille: lista · install [nazwy|all] · available · remove <nazwa>'],
  ['/terminal-setup', 'Ustaw Shift+Enter (nowa linia) w Windows Terminal / VS Code'],
  ['/format', 'Format API: auto | anthropic | openai'],
  ['/mode', 'Tryb uprawnień: manual | auto | bypass | plan (albo Shift+Tab)'],
  ['/mascot', 'Pokaż/ukryj maskotkę (on | off)'],
  ['/yolo', 'Przełącz tryb bypass permissions'],
  ['/cost', 'Zużycie tokenów w tej sesji'],
  ['/config', 'Pokaż konfigurację'],
  ['/baseurl', 'Zmień adres API'],
  ['/exit', 'Wyjście'],
];

function parseArgs(argv) {
  const a = { prompt: [], print: null, yolo: false, model: null, help: false, version: false, cont: false, command: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '-p' || v === '--print') a.print = argv[++i] ?? '';
    else if (v === '--yolo' || v === '--dangerously-skip-permissions') a.yolo = true;
    else if (v === '-m' || v === '--model') a.model = argv[++i];
    else if (v === '-c' || v === '--continue') a.cont = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (v === '-v' || v === '--version') a.version = true;
    else if (i === 0 && ['login', 'logout', 'uninstall', 'update'].includes(v)) a.command = v;
    else a.prompt.push(v);
  }
  a.prompt = a.prompt.join(' ').trim();
  return a;
}

function printUsage() {
  out(`${c.bold('EXOTICCODE')} ${VERSION}

  exoticcode             uruchom
  exoticcode login       zaloguj się
  exoticcode update      zaktualizuj
  exoticcode uninstall   odinstaluj`);
}

// Pytanie tak/nie w zwykłym terminalu (poza czatem).
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(/^(t|tak|y|yes)$/i.test(a.trim()));
    });
  });
}

async function uninstall() {
  out(`\n  ${c.bold('Odinstalowanie EXOTICCODE')} ${c.dim(VERSION)}\n`);
  if (!(await confirm(`  Usunąć EXOTICCODE z komputera? ${c.dim('[t/N]')} `))) {
    out(c.dim('  Anulowano.'));
    return;
  }
  const removeData = fs.existsSync(CONFIG_DIR)
    ? await confirm(`  Usunąć też ustawienia, token, historię czatów i skille (${CONFIG_DIR})? ${c.dim('[t/N]')} `)
    : false;
  out(c.dim('  Usuwam pakiet (npm uninstall -g exoticcode)…'));
  const isWin = process.platform === 'win32';
  const code = await new Promise((resolve) => {
    const child = spawn(isWin ? 'npm.cmd' : 'npm', ['uninstall', '-g', 'exoticcode', '--loglevel=error'], { stdio: 'inherit', shell: isWin });
    child.on('error', () => resolve(1));
    child.on('close', resolve);
  });
  if (code !== 0) {
    out(c.red('  ✖ Nie udało się odinstalować pakietu. Spróbuj ręcznie: npm uninstall -g exoticcode'));
    return;
  }
  if (removeData) {
    try {
      fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
      out(c.green(`  ✔ Usunięto dane: ${CONFIG_DIR}`));
    } catch (e) {
      out(c.yellow(`  ! Nie udało się usunąć ${CONFIG_DIR}: ${e.message}`));
    }
  } else if (fs.existsSync(CONFIG_DIR)) {
    out(c.dim(`  Ustawienia zostały w ${CONFIG_DIR} (przydadzą się po ponownej instalacji).`));
  }
  out(c.green('  ✔ EXOTICCODE został odinstalowany. Do zobaczenia!\n'));
}

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (d) => (data += d));
    stdin.on('end', () => resolve(data));
  });
}

// Słucha klawiszy w trakcie pracy agenta (Esc / Ctrl+C = przerwij, odpowiedzi na pytania o zgodę).
class KeyListener {
  start(onInterrupt) {
    this.onInterrupt = onInterrupt;
    // w układzie TUI klawisze obsługuje stałe pole czatu (Esc/Ctrl+C przerywają)
    if (!stdin.isTTY || tui.active) return;
    this.handler = (d) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(d);
        return;
      }
      if (d === '\x03' || d === '\x1b') this.onInterrupt?.();
      // zwykłe znaki wpisane w trakcie pracy agenta trafią do następnego pola wpisywania
      else if (!d.startsWith('\x1b')) pushTypeahead(d);
    };
    this.release = useInput(this.handler);
  }
  stop() {
    this.onInterrupt = null;
    if (!this.handler) return;
    this.release?.();
    this.handler = null;
    this.waiter = null;
  }
  get active() {
    return !!this.handler || (tui.active && !!stdin.isTTY);
  }
  nextKey() {
    if (this.handler) return new Promise((resolve) => (this.waiter = resolve));
    // TUI: jeden klawisz przejmujemy na chwilę ponad polem czatu
    return new Promise((resolve) => {
      const release = useInput((d) => {
        release();
        resolve(d);
      });
    });
  }
}

class App {
  constructor(config, opts) {
    this.config = config;
    this.cwd = process.cwd();
    this.mode = opts.yolo ? 'bypass' : 'manual';
    this.queue = [];
    this.busy = false;
    this.controller = null;
    this.pendingAsk = null;
    this.modelOverride = opts.model || null;
    this.client = new ApiClient(config);
    this.agent = new Agent(this);
    this.history = loadHistory();
    this.keys = new KeyListener();
    this.session = { id: newSessionId(), cwd: this.cwd, created: Date.now(), title: '' };
    this.lastSigint = 0;
    this.lastInputTokens = 0;
  }

  get model() {
    return this.modelOverride || this.config.model;
  }

  get yolo() {
    return this.mode === 'bypass';
  }

  set yolo(v) {
    this.mode = v ? 'bypass' : 'manual';
  }

  cycleMode() {
    this.mode = MODE_ORDER[(MODE_ORDER.indexOf(this.mode) + 1) % MODE_ORDER.length];
    this.refreshHud();
  }

  // ---------- stałe pole czatu (TUI) ----------

  startTui() {
    if (!this.input) {
      this.input = new InputBuffer({
        history: this.history,
        commands: () => this.completions(),
        onHistory: (h) => {
          this.history = h;
          saveHistory(h);
        },
        onAction: (a) => this.onInputAction(a),
      });
    }
    tui.showMascot = this.config.mascot !== false;
    const ok = tui.enable({ input: this.input, onKeys: (d) => this.input.feed(d) });
    this.refreshHud();
    return ok;
  }

  resolveAsk(value) {
    const resolve = this.pendingAsk;
    this.pendingAsk = null;
    tui.setPrompt(null);
    resolve?.(value);
  }

  onInputAction(a) {
    switch (a.type) {
      case 'submit':
        if (this.pendingAsk) return this.resolveAsk(a.line.trim());
        if (!a.line.trim()) return;
        this.queue.push(a.line);
        this.pump();
        return;
      case 'escape':
        if (this.pendingAsk) return this.resolveAsk(null);
        if (this.controller) return this.controller.abort();
        this.input.clear();
        return;
      case 'ctrlc':
        if (this.pendingAsk) return this.resolveAsk(null);
        if (this.controller) return this.controller.abort();
        if (this.input.text) return this.input.clear();
        if (Date.now() - this.lastSigint < 3000) return this.exit();
        this.lastSigint = Date.now();
        tui.setStatus(c.dim('Naciśnij Ctrl+C jeszcze raz, aby wyjść'));
        setTimeout(() => !this.busy && tui.setStatus(null), 3000).unref?.();
        return;
      case 'eof':
        return this.exit();
      case 'mode':
        return this.cycleMode();
      case 'clear':
        return this.showHome();
    }
  }

  // Wiadomości wpisane w trakcie pracy czekają w kolejce i idą po kolei.
  async pump() {
    this.refreshHud();
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const text = this.queue.shift();
        this.refreshHud();
        const lines = text.split('\n');
        out();
        out(c.bold(accent('❯ ')) + c.bold(lines[0]) + lines.slice(1).map((l) => '\n  ' + c.bold(l)).join(''));
        try {
          await this.handle(text);
        } catch (e) {
          out(c.red(`✖ ${e.message}`));
        }
      }
    } finally {
      this.busy = false;
      this.refreshHud();
    }
  }

  // ---------- wejście ----------

  prompt(promptStr, { main = false } = {}) {
    return editLine({
      prompt: promptStr,
      history: main ? this.history : [],
      commands: main ? this.completions() : [],
      onHistory: main ? (h) => (this.history = h) : undefined,
    });
  }

  // komendy + skille do podpowiedzi po wpisaniu "/"
  completions() {
    const skills = listSkills(this.cwd).map((s) => ['/' + s.name, 'skill · ' + truncateLine(s.description, 70)]);
    return [...COMMANDS, ...skills];
  }

  async ask(question) {
    if (tui.active) {
      // pytanie pojawia się w polu na dole; odpowiedź wraca jako tekst
      const label = stripAnsi(question).trim() + ' ';
      const answer = await new Promise((resolve) => {
        this.pendingAsk = resolve;
        tui.setPrompt(label);
      });
      out(c.dim('  ' + label) + (answer ?? c.dim('(anulowano)')));
      return answer;
    }
    const r = await this.prompt(question);
    return r.type === 'line' ? r.line.trim() : null;
  }

  async askPermission(tool, input, preview) {
    hud.setState('asking');
    out(accent('╭─ ') + c.bold(`${tool.label} — potrzebna zgoda`));
    for (const l of preview) out(accent('│ ') + l);
    out(accent('╰─ ') + `${c.bold('[y]')} tak   ${c.bold('[a]')} zawsze dla ${tool.label} w tej sesji   ${c.bold('[n]')} nie`);
    if (!this.keys.active) {
      out(c.yellow('  Brak terminala interaktywnego — odmowa (użyj --yolo, aby zezwalać automatycznie).'));
      return 'no';
    }
    while (true) {
      const key = (await this.keys.nextKey()).toLowerCase();
      if (key === 'y' || key === 't' || key === '\r') return 'yes';
      if (key === 'a') return 'always';
      if (key === 'n' || key === '\x1b') return 'no';
      if (key === '\x03') {
        this.keys.onInterrupt?.();
        return 'no';
      }
    }
  }

  // ---------- logowanie / modele ----------

  // Pełnoekranowy kreator: header + kroki (token → model → effort).
  async login() {
    // kreator ma własny, pełnoekranowy wygląd — na ten czas wyłączamy układ czatu
    tui.disable();
    const ok = await runSetup(this);
    this.startTui();
    this.showHome(ok ? null : c.yellow('  Konfiguracja przerwana — wpisz /login, aby wrócić.'));
    return ok;
  }

  modelList() {
    return this.availableModels || BUILTIN_MODELS;
  }

  async pickModel() {
    const list = this.modelList();
    out();
    out(c.bold('  Wybierz model:'));
    const items = [...list.map((m) => ({ label: m, hint: m === this.model ? '← aktualny' : '' })), { label: '✎ wpisz własną nazwę…' }];
    const idx = await select(items, { index: Math.max(0, list.indexOf(this.model)) });
    if (idx === null) return;
    let model = list[idx];
    if (idx === list.length) {
      model = await this.ask(accent('  ❯ ') + 'Nazwa modelu: ');
      if (!model) return;
    }
    await this.setModel(model);
  }

  async setModel(model) {
    this.modelOverride = null;
    this.config.model = model;
    saveConfig(this.config);
    out(c.green('✔ Model: ') + c.bold(model));
    this.refreshHud();
    if (this.config.token) await this.ensureFormat(model).catch((e) => out(c.yellow(`! ${e.message}`)));
  }

  async ensureFormat(model) {
    if (this.client.formatFor(model)) return this.client.formatFor(model);
    const spinner = new Spinner();
    spinner.start(`Wykrywam format API dla ${model}`);
    try {
      const fmt = await this.client.detectFormat(model);
      this.config.formats = { ...this.config.formats, [model]: fmt };
      saveConfig(this.config);
      spinner.stop();
      out(c.dim(`  format API: ${fmt}`));
      return fmt;
    } finally {
      spinner.stop();
    }
  }

  // ---------- uruchamianie agenta ----------

  async runAgent(text) {
    if (!this.config.token) {
      out(c.yellow('Najpierw zaloguj się: /login'));
      return;
    }
    if (!this.model) await this.pickModel();
    if (!this.model) return;
    try {
      await this.ensureFormat(this.model);
    } catch (e) {
      out(c.red(`✖ ${e.message}`));
      return;
    }
    if (!this.session.title) this.session.title = truncateLine(text, 60);

    const controller = new AbortController();
    this.controller = controller;
    this.keys.start(() => controller.abort());
    const t0 = Date.now();
    out();
    try {
      const usage = await this.agent.run(text, {
        signal: controller.signal,
        model: this.model,
        askPermission: (tool, input, preview) => this.askPermission(tool, input, preview),
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      out(c.dim(`  ${this.model} · ↑${fmtNum(usage.input)} ↓${fmtNum(usage.output)} tokenów · ${secs}s`));
      hud.setState(controller.signal.aborted ? 'idle' : 'happy', 2500);
    } catch (e) {
      hud.setState('sad', 4000);
      out(c.red(`✖ ${e.message}`));
      if (e.status === 401) out(c.yellow('  Token wygląda na nieprawidłowy — użyj /login.'));
    } finally {
      this.keys.stop();
      this.controller = null;
      this.saveSession();
      this.refreshHud();
    }
  }

  // ---------- pasek z maskotką ----------

  refreshHud() {
    tui.queued = this.queue.length;
    tui.update({
      version: VERSION,
      model: this.model,
      effort: this.config.effort,
      cwd: this.cwd,
      input: this.agent.usage.input,
      output: this.agent.usage.output,
      mode: this.mode,
    });
  }

  saveSession() {
    if (!this.agent.messages.length) return;
    saveSession({ ...this.session, model: this.model, messages: this.agent.messages });
  }

  // ---------- komendy ----------

  async command(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case '/help':
      case '/?':
        out();
        for (const [n, d] of COMMANDS) out(`  ${accent(n.padEnd(10))} ${d}`);
        out();
        out(c.dim('  !<komenda>  uruchom komendę w powłoce (wynik trafi do kontekstu)'));
        out(c.dim('  Shift+Enter / Ctrl+Enter / Alt+Enter = nowa linia (Shift+Enter: najpierw /terminal-setup)'));
        out(c.dim('  Esc / Ctrl+C przerywa odpowiedź · /<skill> <zadanie> uruchamia skill wprost'));
        return;
      case '/login':
        await this.login();
        return;
      case '/logout':
        this.config.token = null;
        saveConfig(this.config);
        out(c.green('✔ Wylogowano — token usunięty.'));
        return;
      case '/model':
        if (arg) await this.setModel(arg);
        else await this.pickModel();
        return;
      case '/models': {
        try {
          const list = await this.client.listModels();
          this.availableModels = list.length ? list : null;
        } catch (e) {
          out(c.dim(`  (API: ${e.message} — pokazuję wbudowaną listę)`));
        }
        for (const m of this.modelList()) out(`  ${m === this.model ? accent('●') : c.dim('○')} ${m}`);
        return;
      }
      case '/format': {
        if (!['auto', 'anthropic', 'openai'].includes(arg)) {
          out(`Format: ${c.bold(this.config.format)}` + (this.model ? c.dim(` (dla ${this.model}: ${this.client.formatFor(this.model) || 'niewykryty'})`) : ''));
          out(c.dim('  Użycie: /format auto | anthropic | openai'));
          return;
        }
        this.config.format = arg;
        if (arg === 'auto') this.config.formats = {};
        saveConfig(this.config);
        out(c.green(`✔ Format API: ${arg}`));
        return;
      }
      case '/effort': {
        let v = arg.toLowerCase();
        if (v && !EFFORTS.includes(v)) {
          out(c.yellow(`  Nieznany poziom. Dostępne: ${EFFORTS.join(' | ')}`));
          return;
        }
        if (!v) {
          out();
          out(c.bold('  Poziom rozumowania (effort):'));
          const idx = await select(EFFORT_ITEMS, { index: Math.max(0, EFFORTS.indexOf(this.config.effort)) });
          if (idx === null) return;
          v = EFFORTS[idx];
        }
        this.config.effort = v;
        this.refreshHud();
        saveConfig(this.config);
        out(c.green(`✔ Effort: ${v}`));
        return;
      }
      case '/new':
        this.saveSession();
        this.agent.reset();
        this.session = { id: newSessionId(), cwd: this.cwd, created: Date.now(), title: '' };
        out(c.green('✔ Nowy czat.'));
        return;
      case '/chats':
        await this.resume();
        return;
      case '/rename':
        if (!arg) {
          out(c.dim('  Użycie: /rename <nowa nazwa>'));
          return;
        }
        this.session.title = arg;
        this.session.titled = true;
        this.saveSession();
        out(c.green(`✔ Nazwa czatu: ${arg}`));
        return;
      case '/export': {
        if (!this.agent.messages.length) {
          out(c.dim('  Czat jest pusty.'));
          return;
        }
        const file = path.resolve(this.cwd, arg || `exoticcode-${this.session.id}.md`);
        fs.writeFileSync(file, exportMarkdown(this.session, this.agent.messages), 'utf8');
        out(c.green(`✔ Zapisano: ${file}`));
        return;
      }
      case '/delete': {
        const sessions = listSessions(this.cwd).slice(0, 15);
        if (!sessions.length) {
          out(c.dim('  Brak zapisanych czatów.'));
          return;
        }
        sessions.forEach((x, i) => out(`  ${c.dim(String(i + 1).padStart(2))}. ${x.title || '(bez tytułu)'} ${c.dim('· ' + new Date(x.updated).toLocaleString())}`));
        const a = await this.ask(accent('Numer czatu do usunięcia: '));
        const s = sessions[Number(a) - 1];
        if (!s) return;
        fs.rmSync(path.join(SESSIONS_DIR, `${s.id}.json`), { force: true });
        if (s.id === this.session.id) {
          this.agent.reset();
          this.session = { id: newSessionId(), cwd: this.cwd, created: Date.now(), title: '' };
        }
        out(c.green(`✔ Usunięto: ${s.title || s.id}`));
        return;
      }
      case '/clear':
        this.saveSession();
        this.agent.reset();
        this.session = { id: newSessionId(), cwd: this.cwd, created: Date.now(), title: '' };
        this.showHome(c.green('  ✔ Nowa rozmowa.'));
        return;
      case '/compact': {
        const controller = new AbortController();
        this.controller = controller;
        this.keys.start(() => controller.abort());
        try {
          const s = await this.agent.compact({ signal: controller.signal, model: this.model });
          out(s ? c.green('✔ Rozmowa skompaktowana.') : c.dim('Nie ma czego kompaktować.'));
        } catch (e) {
          out(c.red(`✖ ${e.message}`));
        } finally {
          this.keys.stop();
          this.controller = null;
          this.saveSession();
        }
        return;
      }
      case '/resume':
        await this.resume();
        return;
      case '/init':
        await this.runAgent(
          'Przeanalizuj ten projekt (struktura, język, jak budować/uruchamiać/testować, konwencje) i utwórz w katalogu głównym plik EXOTIC.md ze zwięzłymi instrukcjami dla agenta AI pracującego w tym repozytorium. Jeśli plik już istnieje, zaktualizuj go.',
        );
        return;
      case '/mascot': {
        const v = (arg || '').toLowerCase();
        const on = v ? ['on', 'tak', '1', 'wlacz', 'włącz'].includes(v) : !tui.showMascot;
        this.config.mascot = on;
        saveConfig(this.config);
        tui.showMascot = on;
        tui.redraw(false);
        out(on ? c.green('  ✔ Maskotka włączona.') : c.green('  ✔ Maskotka ukryta — /mascot on pokazuje ją z powrotem.'));
        return;
      }
      case '/yolo':
        this.mode = this.mode === 'bypass' ? 'manual' : 'bypass';
        this.refreshHud();
        out(this.mode === 'bypass' ? c.yellow('⚠ Tryb bypass permissions — narzędzia wykonują się bez pytania.') : c.green('✔ Tryb ręczny — pytam o zgodę.'));
        return;
      case '/mode': {
        const v = (arg || '').toLowerCase();
        if (v && !MODES[v]) {
          out(c.yellow(`  Nieznany tryb. Dostępne: ${MODE_ORDER.join(' | ')}`));
          return;
        }
        if (v) this.mode = v;
        else {
          out();
          out(c.bold('  Tryb uprawnień:'));
          const items = MODE_ORDER.map((m) => ({ label: m, hint: MODES[m].hint }));
          const idx = await select(items, { index: MODE_ORDER.indexOf(this.mode) });
          if (idx === null) return;
          this.mode = MODE_ORDER[idx];
        }
        this.refreshHud();
        out(c.green(`  ✔ Tryb: ${MODES[this.mode].label} — ${MODES[this.mode].hint}`));
        return;
      }
      case '/cost':
        out(`  Tokeny w tej sesji: ↑${fmtNum(this.agent.usage.input)} wejście · ↓${fmtNum(this.agent.usage.output)} wyjście`);
        out(c.dim(`  Ostatni kontekst: ${fmtNum(this.lastInputTokens)} tokenów · wiadomości: ${this.agent.messages.length}`));
        return;
      case '/config':
        out(`  plik:     ${c.dim(CONFIG_PATH)}`);
        out(`  API:      ${this.config.baseUrl}`);
        out(`  token:    ${this.config.token ? this.config.token.slice(0, 4) + '…' + this.config.token.slice(-4) : c.yellow('brak')}`);
        out(`  model:    ${this.model || c.yellow('brak')}`);
        out(`  format:   ${this.config.format}`);
        out(`  effort:   ${this.config.effort}`);
        out(`  maxTokens:${' '}${this.config.maxTokens}`);
        out(`  tryb:     ${MODES[this.mode].label} — ${MODES[this.mode].hint}`);
        return;
      case '/baseurl':
        if (!arg) {
          out(`  API: ${this.config.baseUrl}  ${c.dim(`(domyślnie ${DEFAULT_BASE_URL}; użycie: /baseurl <url>)`)}`);
          return;
        }
        this.config.baseUrl = arg;
        this.config.formats = {};
        saveConfig(this.config);
        out(c.green(`✔ API: ${arg}`));
        return;
      case '/exit':
      case '/quit':
      case '/q':
        this.exit();
        return;
      case '/terminal-setup': {
        const plan = planTerminalSetup();
        if (!plan.length) {
          out(c.yellow('  Nie znaleziono ustawień Windows Terminal ani VS Code/Cursor.'));
          out(c.dim('  Nową linię zawsze zrobisz też przez Ctrl+Enter, Alt+Enter albo „\” na końcu linii.'));
          return;
        }
        const todo = plan.filter((x) => !x.already);
        for (const x of plan) out(`  ${x.already ? c.green('✔ już ustawione') : accent('+ dopiszę skrót')}  ${c.bold(x.name)} ${c.dim(x.file)}`);
        if (!todo.length) return;
        const a = await this.ask(accent('  ❯ ') + 'Dopisać Shift+Enter = nowa linia? (kopia zapasowa: *.exoticcode-backup) [t/N]: ');
        if (!/^(t|tak|y|yes)$/i.test(a || '')) {
          out(c.dim('  Anulowano.'));
          return;
        }
        for (const x of todo) {
          try {
            x.apply();
            out(c.green(`  ✔ ${x.name}`));
          } catch (e) {
            out(c.red(`  ✖ ${x.name}: ${e.message}`));
          }
        }
        out(c.dim('  Uruchom terminal ponownie (Windows Terminal łapie zmianę od razu).'));
        return;
      }
      case '/skills':
        await this.skillsCommand(rest);
        return;
      default: {
        // /nazwa-skilla [zadanie] — uruchom agenta z tym skillem
        const skill = listSkills(this.cwd).find((x) => '/' + x.name.toLowerCase() === cmd.toLowerCase());
        if (skill) {
          await this.runAgent(`Use the "${skill.name}" skill (load it with the skill tool first).${arg ? '\n\nTask: ' + arg : ''}`);
          return;
        }
        out(c.yellow(`Nieznana komenda ${cmd}. Wpisz /help.`));
      }
    }
  }

  async skillsCommand([sub, ...names]) {
    sub = (sub || '').toLowerCase();
    if (!sub || sub === 'list') {
      const skills = listSkills(this.cwd);
      if (!skills.length) {
        out(c.dim('  Brak zainstalowanych skilli. Zainstaluj oficjalne skille Anthropic: /skills install'));
        return;
      }
      out(c.bold(`  Skille (${skills.length}):`));
      for (const sk of skills) out(`  ${accent('◆')} ${c.bold(sk.name)} ${c.dim('· ' + sk.source)}
    ${c.dim(truncateLine(sk.description, (process.stdout.columns || 80) - 6))}`);
      out(c.dim('  Agent sam dobiera skill do zadania. Możesz też wywołać go wprost: /<nazwa> <zadanie>'));
      return;
    }
    if (sub === 'available') {
      const spinner = new Spinner();
      spinner.start('Pobieram listy z github.com/anthropics/skills i github.com/openai/skills');
      try {
        const list = await availableSkills();
        spinner.stop();
        const installed = new Set(listSkills(this.cwd).map((x) => x.name));
        for (const [source, title] of [['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (Codex)']]) {
          out(c.bold(`  Oficjalne skille ${title}:`));
          for (const x of list.filter((s) => s.source === source)) {
            out(`  ${installed.has(x.name) ? c.green('✔') : c.dim('○')} ${x.name.padEnd(32)} ${c.dim(`${x.files} plików · ${Math.round(x.size / 1024)} KB`)}`);
          }
        }
        out(c.dim('  Instalacja: /skills install <nazwa> · openai:<nazwa> wymusza katalog OpenAI · /skills install all'));
      } catch (e) {
        spinner.stop();
        out(c.red(`✖ ${e.message}`));
      }
      return;
    }
    if (sub === 'install' || sub === 'add') {
      const wanted = names.length ? names : RECOMMENDED;
      const spinner = new Spinner();
      spinner.start('Pobieram skille z GitHuba (Anthropic / OpenAI)');
      try {
        const results = await installSkills(wanted, (name, i, total) => spinner.start(`Pobieram ${name} (${i}/${total})`));
        spinner.stop();
        for (const r of results) out(r.ok ? `  ${c.green('✔')} ${r.name} ${c.dim(`(${r.files} plików)`)}` : `  ${c.red('✖')} ${r.name}: ${r.error}`);
        out(c.dim(`  Zapisano w ${SKILLS_DIR}`));
      } catch (e) {
        spinner.stop();
        out(c.red(`✖ ${e.message}`));
      }
      return;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
      for (const n of names) out(removeSkill(n) ? c.green(`  ✔ Usunięto ${n}`) : c.yellow(`  Nie znaleziono ${n} w ${SKILLS_DIR}`));
      return;
    }
    out(c.dim('  Użycie: /skills [list] · /skills available · /skills install [nazwy…|all] · /skills remove <nazwa>'));
  }

  async resume(latest = false) {
    const sessions = listSessions(this.cwd).filter((s) => s.id !== this.session.id).slice(0, 15);
    if (!sessions.length) {
      out(c.dim('  Brak zapisanych sesji w tym katalogu.'));
      return;
    }
    let s = sessions[0];
    if (!latest) {
      out(c.bold('Czaty w tym katalogu:'));
      sessions.forEach((x, i) => out(`  ${c.dim(String(i + 1).padStart(2))}. ${x.title || '(bez tytułu)'} ${c.dim(`· ${new Date(x.updated).toLocaleString()} · ${x.messages.length} wiad.`)}`));
      const a = await this.ask(accent('Numer czatu do wznowienia: '));
      if (!a) return;
      s = sessions[Number(a) - 1];
      if (!s) {
        out(c.red('Nieprawidłowy numer.'));
        return;
      }
    }
    this.saveSession();
    this.session = { id: s.id, cwd: s.cwd, created: s.created, title: s.title, titled: s.titled };
    this.agent.messages = s.messages;
    out(c.green(`✔ Wznowiono: ${s.title || s.id} (${s.messages.length} wiadomości)`));
  }

  async shell(cmd) {
    const r = await runShell(cmd, { cwd: this.cwd });
    if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n');
    out(c.dim(`  [kod wyjścia: ${r.code}]`));
    this.agent.notes.push(`<user-shell-command>\n$ ${cmd}\n${r.output.slice(-8000)}\n[exit code: ${r.code}]\n</user-shell-command>`);
  }

  async handle(input) {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith('/') && !text.startsWith('//') && !text.includes('\n')) return this.command(text);
    if (text.startsWith('!')) return this.shell(text.slice(1).trim());
    return this.runAgent(text);
  }

  exit() {
    tui.disable({ keep: true });
    saveHistory(this.history);
    this.saveSession();
    out(c.dim('Do zobaczenia!'));
    process.exit(0);
  }

  // ---------- pętla interaktywna ----------

  // Czyści ekran i pokazuje header czatu.
  showHome(note) {
    clearScreen();
    this.welcome();
    if (note) out(note);
  }

  welcome() {
    // w układzie TUI wszystko jest w headerze na górze i w polu na dole
    if (tui.active) return;
    banner();
    out();
    out(`  ${c.dim('v' + VERSION)}  ${accent2('agent AI do kodowania')}  ${c.dim('·')}  ${c.dim(this.config.baseUrl)}`);
    out(`  ${c.dim('model:')} ${this.model ? c.bold(this.model) : c.yellow('nie wybrano')}   ${c.dim('effort:')} ${this.config.effort}   ${c.dim('katalog:')} ${this.cwd}`);
    if (this.yolo) out(`  ${c.yellow('⚠ tryb YOLO — bez pytania o zgodę')}`);
    out(c.dim('  /help — komendy · Esc przerywa · Ctrl+C dwa razy — wyjście'));
    out();
  }

  async interactive(initial, cont) {
    if (!this.config.token) await this.login();
    else {
      this.startTui();
      this.showHome();
    }
    if (tui.active) {
      // stałe pole czatu: wszystko dzieje się w obsłudze zdarzeń (onInputAction → pump)
      if (cont) await this.resume(true);
      if (initial) {
        this.queue.push(initial);
        this.pump();
      }
      return new Promise(() => {});
    }
    // terminal za mały na układ TUI — zwykłe pole wpisywania w linii
    if (cont) await this.resume(true);
    if (initial) await this.handle(initial);
    while (true) {
      out();
      const r = await this.prompt(accent('❯ '), { main: true });
      if (r.type === 'eof') this.exit();
      if (r.type === 'sigint') {
        if (Date.now() - this.lastSigint < 2000) this.exit();
        this.lastSigint = Date.now();
        out(c.dim('  (naciśnij Ctrl+C ponownie, aby wyjść)'));
        continue;
      }
      if (r.type !== 'line') continue;
      saveHistory(this.history);
      await this.handle(r.line);
    }
  }
}

function exportMarkdown(session, messages) {
  const parts = [`# ${session.title || 'Czat EXOTICCODE'}`];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === 'text') parts.push(`**${m.role === 'user' ? 'Ty' : 'EXOTICCODE'}:**\n\n${b.text}`);
      else if (b.type === 'tool_use') parts.push(`> 🔧 \`${b.name}\` \`${JSON.stringify(b.input).slice(0, 300)}\``);
      else if (b.type === 'tool_result') parts.push(`> ⎿ ${String(typeof b.content === 'string' ? b.content : '').split('\n')[0].slice(0, 200)}`);
    }
  }
  return parts.join('\n\n') + '\n';
}

const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  if (args.version) return out(VERSION);
  // zawsze przywróć kursor (menu wyboru go ukrywa)
  process.on('exit', () => process.stdout.isTTY && process.stdout.write('\x1b[?25h'));
  // wyjście przekierowane do programu, który się zamknął (np. `| head`) — kończymy po cichu
  process.stdout.on('error', (e) => e.code === 'EPIPE' && process.exit(0));

  const config = loadConfig();
  const app = new App(config, { yolo: args.yolo, model: args.model });

  if (args.command === 'login') {
    const ok = await runSetup(app);
    clearScreen();
    out(ok ? c.green('✔ Skonfigurowano. Uruchom: exoticcode') : c.yellow('Konfiguracja przerwana.'));
    return process.exit(0);
  }
  if (args.command === 'logout') {
    config.token = null;
    saveConfig(config);
    out('Wylogowano.');
    return;
  }
  if (args.command === 'uninstall') return uninstall();
  if (args.command === 'update') {
    const latest = await latestVersion(8000).catch(() => null);
    if (!latest) return out(c.yellow('  Nie udało się sprawdzić wersji na GitHubie (brak internetu albo brak wydań).'));
    if (!isNewer(latest, VERSION)) return out(c.green(`  ✔ Masz najnowszą wersję (${VERSION}).`));
    out(`  Instaluję wersję ${latest}…`);
    const r = await runNpmInstall(latest, 'inherit');
    const ok = r.ok && installedVersion() === latest;
    return out(ok ? c.green(`  ✔ Zaktualizowano do ${latest}.`) : c.red(`  ✖ Aktualizacja nie powiodła się (na dysku: ${installedVersion()}).`));
  }

  // tryb jednorazowy: -p albo dane na stdin
  if (args.print !== null || !stdin.isTTY) {
    let prompt = args.print || args.prompt;
    if (!stdin.isTTY) {
      const piped = (await readAllStdin()).trim();
      prompt = [prompt, piped].filter(Boolean).join('\n\n');
    }
    if (!prompt) throw new Error('Brak zadania. Użycie: exoticcode -p "zadanie"');
    if (!config.token) throw new Error('Brak tokenu — uruchom najpierw: exoticcode login');
    if (args.cont) await app.resume(true);
    await app.runAgent(prompt);
    return process.exit(0);
  }

  await app.interactive(args.prompt, args.cont);
}
