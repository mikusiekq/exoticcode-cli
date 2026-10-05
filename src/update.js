// Automatyczna aktualizacja przy starcie: jeśli na GitHubie jest nowsze wydanie,
// instaluje je przez npm i uruchamia program ponownie z tymi samymi argumentami.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, loadConfig } from './config.js';

export const REPO = 'mikusiekq/exoticcode-cli';
export const TARBALL_URL = `https://github.com/${REPO}/releases/latest/download/exoticcode.tgz`;
// Adres z konkretną wersją — stały adres „latest” npm trzyma w pamięci podręcznej
// i potrafi zainstalować starą paczkę zamiast nowej.
export const tarballFor = (version) => `https://github.com/${REPO}/releases/download/v${String(version).replace(/^v/, '')}/exoticcode.tgz`;
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const pink = (s) => (useColor ? `\x1b[38;2;236;72;153m${s}\x1b[39m` : s);
const cyan = (s) => (useColor ? `\x1b[38;2;34;211;238m${s}\x1b[39m` : s);
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[39m` : s);
const yellow = (s) => (useColor ? `\x1b[33m${s}\x1b[39m` : s);

/** Czy wersja a jest nowsza niż b (porównanie liczbowe, nie tekstowe). */
export function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** Numer najnowszego wydania — z przekierowania /releases/latest (bez limitów API GitHuba). */
export async function latestVersion(timeoutMs = 2500) {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: 'manual',
    headers: { 'user-agent': 'exoticcode' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const location = res.headers.get('location') || '';
  const m = location.match(/\/releases\/tag\/v?([0-9][^/?#]*)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Wersja zapisana w package.json na dysku (czytana na nowo, nie z pamięci procesu). */
export function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

export function runNpmInstall(version, stdio = ['ignore', 'pipe', 'pipe']) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const args = ['install', '-g', tarballFor(version), '--prefer-online', '--no-fund', '--no-audit', '--loglevel=error'];
    const child = spawn(isWin ? 'npm.cmd' : 'npm', args, {
      stdio,
      shell: isWin,
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/**
 * Sprawdza i instaluje aktualizację. Zwraca true, gdy uruchomiono już nową wersję
 * (wtedy bieżący proces tylko czeka na jej zakończenie).
 */
export async function maybeUpdate(argv) {
  if (process.env.EXOTICCODE_NO_UPDATE || process.env.EXOTICCODE_UPDATED) return false;
  // tylko przy zwykłym, interaktywnym starcie
  if (argv.some((a) => ['-p', '--print', '-v', '--version', '-h', '--help'].includes(a))) return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  // kopia robocza z gita (tu się programuje) — nie nadpisujemy jej wydaniem
  if (fs.existsSync(path.join(PKG_ROOT, '.git'))) return false;
  if (loadConfig().autoUpdate === false) return false;

  let latest;
  try {
    latest = await latestVersion();
  } catch {
    return false; // brak internetu albo GitHub nie odpowiada — startujemy normalnie
  }
  if (!latest || !isNewer(latest, VERSION)) return false;

  const out = process.stdout;
  out.write(`\n  ${pink('⬇')} Jest nowa wersja ${pink('EXOTICCODE')} ${dim(VERSION)} → ${cyan(latest)}\n`);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const t0 = Date.now();
  let i = 0;
  const tick = () => out.write(`\r\x1b[K  ${pink(frames[i++ % frames.length])} Instaluję nową wersję… ${dim(`(${Math.floor((Date.now() - t0) / 1000)}s)`)}`);
  tick();
  const timer = setInterval(tick, 80);
  const result = await runNpmInstall(latest);
  clearInterval(timer);
  out.write('\r\x1b[K');
  // upewnij się, że na dysku naprawdę jest nowa wersja (a nie np. stara z pamięci podręcznej npm)
  if (result.ok && installedVersion() !== latest) {
    result.ok = false;
    result.output = `po instalacji na dysku jest wersja ${installedVersion()}, a nie ${latest}`;
  }

  if (!result.ok) {
    out.write(`  ${yellow('!')} Nie udało się zainstalować aktualizacji — uruchamiam obecną wersję ${VERSION}.\n`);
    const tail = result.output.trim().split('\n').slice(-3).join('\n    ');
    if (tail) out.write(dim(`    ${tail}\n`));
    out.write(dim(`    Ręcznie: npm install -g ${tarballFor(latest)}\n\n`));
    await new Promise((r) => setTimeout(r, 1500));
    return false;
  }

  out.write(`  ${green('✔')} Zainstalowano wersję ${cyan(latest)} — uruchamiam…\n`);
  await new Promise((r) => setTimeout(r, 700));
  const child = spawn(process.execPath, [process.argv[1], ...argv], {
    stdio: 'inherit',
    env: { ...process.env, EXOTICCODE_UPDATED: latest },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    out.write(`  ${yellow('!')} Nie udało się uruchomić nowej wersji: ${e.message}\n`);
    process.exit(1);
  });
  return true;
}
