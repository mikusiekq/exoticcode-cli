import { BUILTIN_MODELS, CONFIG_PATH, saveConfig } from './config.js';
import { ApiError, EFFORTS } from './api.js';
import { c, accent, accent2, out, banner, clearScreen, readSecret, select, waitKey, Spinner } from './ui.js';

const STEPS = ['Token', 'Model', 'Effort', 'Gotowe'];

export const EFFORT_ITEMS = [
  { label: 'auto', hint: 'domyślne zachowanie modelu' },
  { label: 'low', hint: 'szybko, mało rozumowania' },
  { label: 'medium', hint: 'zbalansowane' },
  { label: 'high', hint: 'dokładniej, wolniej' },
  { label: 'max', hint: 'maksimum rozumowania, najwięcej tokenów' },
];

// Czyści ekran i rysuje header + pasek postępu dla danego kroku.
function stepScreen(step, title, subtitle) {
  clearScreen();
  banner();
  out();
  const bar = STEPS.map((name, i) => {
    if (i < step) return accent('● ' + name);
    if (i === step) return c.bold(accent2('◉ ' + name));
    return c.dim('○ ' + name);
  }).join(c.dim('  ──  '));
  out('  ' + bar);
  out();
  out('  ' + c.bold(title));
  if (subtitle) out('  ' + c.dim(subtitle));
  out();
}

export const maskToken = (t) => (t ? (t.length > 10 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••') : '—');

async function tokenStep(app) {
  let error = null;
  while (true) {
    stepScreen(0, 'Krok 1 — token API', 'Wklej swój token. Nie będzie widoczny na ekranie. Esc anuluje.');
    out(`  ${c.dim('API:')} ${accent2(app.config.baseUrl)}`);
    if (app.config.token) out(`  ${c.dim('obecny token:')} ${maskToken(app.config.token)} ${c.dim('(Enter bez wpisywania = zostaw)')}`);
    if (error) {
      out();
      out('  ' + c.red('✖ ' + error));
    }
    out();
    const input = await readSecret(accent('  ❯ ') + 'Token: ');
    if (input === null) return false;
    const token = input || app.config.token;
    if (!token) {
      error = 'Token nie może być pusty.';
      continue;
    }
    const prev = app.config.token;
    app.config.token = token;
    const spinner = new Spinner();
    spinner.start('Sprawdzam token');
    try {
      const models = await app.client.listModels();
      app.availableModels = models.length ? models : null;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        spinner.stop();
        app.config.token = prev;
        error = `Token odrzucony przez API: ${e.message}`;
        continue;
      }
      // brak /v1/models nie oznacza złego tokenu — używamy wbudowanej listy
      app.availableModels = null;
    } finally {
      spinner.stop();
    }
    if (token !== prev) app.config.formats = {};
    saveConfig(app.config);
    return true;
  }
}

async function modelStep(app) {
  let error = null;
  while (true) {
    stepScreen(1, 'Krok 2 — wybierz model', 'Możesz go później zmienić w czacie komendą /model.');
    if (error) {
      out('  ' + c.red('✖ ' + error));
      out();
    }
    const list = app.availableModels || BUILTIN_MODELS;
    const items = [...list.map((m) => ({ label: m, hint: m === app.config.model ? '← aktualny' : '' })), { label: '✎ wpisz własną nazwę…' }];
    const idx = await select(items, { index: Math.max(0, list.indexOf(app.config.model)) });
    if (idx === null) return 'back';
    let model = list[idx];
    if (idx === list.length) {
      const typed = await app.ask(accent('  ❯ ') + 'Nazwa modelu: ');
      if (!typed) continue;
      model = typed;
    }
    app.config.model = model;
    app.modelOverride = null;
    saveConfig(app.config);
    try {
      await app.ensureFormat(model);
      return 'ok';
    } catch (e) {
      error = `${model}: ${e.message}`;
    }
  }
}

async function effortStep(app) {
  stepScreen(2, 'Krok 3 — poziom rozumowania (effort)', 'Ile model ma „myśleć” przed odpowiedzią. Zmienisz to w czacie: /effort.');
  const idx = await select(EFFORT_ITEMS, { index: Math.max(0, EFFORTS.indexOf(app.config.effort)) });
  if (idx === null) return 'back';
  app.config.effort = EFFORTS[idx];
  saveConfig(app.config);
  return 'ok';
}

async function doneStep(app) {
  stepScreen(3, '✔ Konfiguracja zakończona');
  out(`  ${c.dim('token: ')}  ${maskToken(app.config.token)}`);
  out(`  ${c.dim('model: ')}  ${c.bold(app.config.model)}`);
  out(`  ${c.dim('effort:')}  ${app.config.effort}`);
  out(`  ${c.dim('API:   ')}  ${app.config.baseUrl}`);
  out(`  ${c.dim('zapis: ')}  ${c.dim(CONFIG_PATH)}`);
  out();
  out('  ' + accent('Naciśnij dowolny klawisz, aby zacząć kodować…'));
  await waitKey();
}

/** Kreator konfiguracji krok po kroku. Zwraca true, jeśli zakończony. */
export async function runSetup(app) {
  let step = 0;
  while (step < 3) {
    if (step === 0) {
      if (!(await tokenStep(app))) return false;
      step = 1;
    } else if (step === 1) {
      step = (await modelStep(app)) === 'ok' ? 2 : 0;
    } else {
      step = (await effortStep(app)) === 'ok' ? 3 : 1;
    }
  }
  await doneStep(app);
  return true;
}
