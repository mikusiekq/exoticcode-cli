// Pomocnik konsoli Windows (proces PowerShell w tle):
//  1. Shift: konsola wysyła przy Shift+Enter i Shift+Tab to samo co przy Enter i Tab,
//     więc co kilka milisekund sprawdzamy w systemie, czy Shift jest wciśnięty
//     (GetAsyncKeyState — tylko stan Shift, nic więcej).
//  2. Mysz: Node na Windows pomija zdarzenia myszy. Pomocnik włącza w konsoli tryb
//     ENABLE_VIRTUAL_TERMINAL_INPUT — wtedy terminal przesyła kółko myszy jako tekst
//     (sekwencje SGR), który EXOTICCODE odczytuje i przewija nim czat.

import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';

let shiftDown = false;
let started = false;
let ready = false;
let child = null;
let vtActive = false; // tryb przesyłania myszy jest włączony w konsoli
const waiters = [];

// Awaryjne zdjęcie trybu myszy z konsoli (synchronicznie, osobnym krótkim procesem).
function restoreConsoleSync() {
  const script = `Add-Type -Name C -Namespace X -MemberDefinition '
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);'
$h = [X.C]::CreateFileW('CONIN$', 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$m = 0
if ([X.C]::GetConsoleMode($h, [ref]$m)) { [void][X.C]::SetConsoleMode($h, ($m -band (-bnot 0x200))) }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      stdio: 'ignore',
      timeout: 4000,
    });
  } catch {}
  vtActive = false;
}

const CSHARP = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class ExoConsole {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static readonly object Out = new object();

  static void Say(string s) { lock (Out) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

  static volatile bool wantVt = false;
  static volatile bool closing = false;
  static readonly object VtLock = new object();

  // wszystkie zmiany trybu pod jedną blokadą — po sprzątaniu nic już go nie włączy z powrotem
  static long SetWanted(bool on) {
    lock (VtLock) {
      if (closing) return -1;
      wantVt = on;
      return ApplyVt(on);
    }
  }

  // Sprzątanie po EXOTICCODE: czekamy, aż proces naprawdę zniknie (Node przy wyjściu sam
  // przestawia tryb konsoli), potem zdejmujemy tryb myszy i przywracamy standardowe flagi cmd
  // (wstawianie, zaznaczanie myszą) — inaczej cmd zostawałby w trybie, którego nie rozumie.
  static void Dbg(string s) {
    string f = Environment.GetEnvironmentVariable("EXOTICCODE_DEBUG_HELPER");
    if (f != null) try { System.IO.File.AppendAllText(f, DateTime.Now.ToString("HH:mm:ss.fff") + " C# " + s + "\\r\\n"); } catch {}
  }

  static void Cleanup(int parentPid) {
    lock (VtLock) {
      closing = true;
      wantVt = false;
    }
    Dbg("cleanup start");
    int waited = 0;
    for (int i = 0; i < 150; i++) {
      bool alive;
      try { alive = !Process.GetProcessById(parentPid).HasExited; } catch (Exception e) { alive = false; Dbg("alive? " + e.GetType().Name); }
      if (!alive) break;
      waited++;
      Thread.Sleep(20);
    }
    Dbg("parent gone after " + (waited * 20) + " ms");
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { Dbg("CONIN$ failed"); return; }
    uint mode;
    if (GetConsoleMode(h, out mode)) {
      uint next = mode & ~0x0200u;
      if ((next & 0x0007u) == 0x0007u) next |= 0x01E0u; // tryb zwykły → INSERT | QUICK_EDIT | EXTENDED | AUTO_POSITION
      bool ok = next == mode || SetConsoleMode(h, next);
      Dbg("mode " + mode.ToString("X4") + " -> " + next.ToString("X4") + " ok=" + ok);
    } else Dbg("GetConsoleMode failed");
    CloseHandle(h);
  }

  // ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200 na wspólnym buforze wejścia konsoli.
  // Zwraca tryb po zmianie albo -1 przy błędzie.
  static long ApplyVt(bool on) {
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return -1;
    uint mode;
    long result = -1;
    if (GetConsoleMode(h, out mode)) {
      uint next = on ? (mode | 0x0200u) : (mode & ~0x0200u);
      if (next == mode || SetConsoleMode(h, next)) result = next;
    }
    CloseHandle(h);
    return result;
  }

  public static void Run(int parentPid) {
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "vt1" || line == "vt0") {
          bool on = line == "vt1";
          long m = SetWanted(on);
          Say(m < 0 ? "VE" : (on ? "V1" : "V0"));
        } else if (line == "mode") {
          IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
          uint mode = 0;
          GetConsoleMode(h, out mode);
          CloseHandle(h);
          Say("M" + mode.ToString("X4"));
        }
      }
      // EXOTICCODE się zamknął — zawsze zostaw konsolę bez trybu myszy (cmd by go nie zrozumiał)
      Cleanup(parentPid);
      Environment.Exit(0);
    });
    reader.IsBackground = true;
    reader.Start();
    Say("R");
    bool last = false;
    for (int n = 0; ; n++) {
      bool down = (GetAsyncKeyState(0x10) & 0x8000) != 0;
      if (down != last) { Say(down ? "1" : "0"); last = down; }
      Thread.Sleep(8);
      // pilnuj trybu przesyłania myszy — Node potrafi go nadpisać przy własnych zmianach trybu
      if (wantVt && n % 25 == 0) {
        bool alive = true;
        try { alive = !Process.GetProcessById(parentPid).HasExited; } catch { alive = false; }
        if (!alive) { Cleanup(parentPid); return; }
        lock (VtLock) { if (wantVt && !closing) ApplyVt(true); }
      }
      if (n % 125 == 0) {
        bool alive = true;
        try { alive = !Process.GetProcessById(parentPid).HasExited; } catch { alive = false; }
        if (!alive) { Cleanup(parentPid); return; }
      }
    }
  }
}`;

export function startShiftWatcher() {
  if (started || process.platform !== 'win32' || process.env.EXOTICCODE_NO_SHIFT_WATCH) return;
  started = true;
  const script = `Add-Type -TypeDefinition @'\n${CSHARP}\n'@\n[ExoConsole]::Run(${process.pid})`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    // Pomocnik musi być podłączony do TEJ SAMEJ konsoli co EXOTICCODE (inaczej zmieniałby tryb
    // innej konsoli), więc bez `windowsHide` — ta opcja tworzy osobną, ukrytą konsolę — i bez
    // `detached`. Okno się nie pojawia, bo konsola już istnieje. Pomocnik czyta tylko swój potok,
    // nie klawiaturę, więc nie przeszkadza w pisaniu.
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return;
  }
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  let buf = '';
  const debug = process.env.EXOTICCODE_DEBUG_HELPER;
  child.stderr.on('data', (d) => debug && fs.appendFileSync(debug, `${Date.now()} STDERR ${JSON.stringify(String(d))}\n`));
  child.stderr.unref?.();
  child.stdout.on('data', (d) => {
    if (debug) {
      try {
        fs.appendFileSync(debug, `${Date.now()} ${JSON.stringify(d)}\n`);
      } catch {}
    }
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line === 'R') {
        ready = true;
        for (const w of waiters.splice(0)) w.onReady?.();
      } else if (line === '1') shiftDown = true;
      else if (line === '0') shiftDown = false;
      else if (/^V[01E]$/.test(line)) {
        if (line === 'V1') vtActive = true;
        else if (line === 'V0') vtActive = false;
        waiters.shift()?.resolve(line !== 'VE');
      }
      else if (/^M[0-9A-F]{4}$/.test(line)) modeWaiters.shift()?.(parseInt(line.slice(1), 16));
    }
  });
  child.unref();
  child.stdout.unref?.();
  child.stdin.unref?.();
  // Node na Windows zabija procesy potomne razem ze sobą, więc pomocnik nie zdąży posprzątać.
  // Normalne wyjście wyłącza tryb myszy wcześniej (App.exit → setVtInput(false)); tu jest
  // awaryjne, synchroniczne czyszczenie konsoli na wypadek nieoczekiwanego zamknięcia.
  process.on('exit', () => {
    if (!vtActive) return;
    // najpierw zatrzymaj pomocnika (inaczej zdążyłby z powrotem włączyć tryb), potem wyczyść konsolę
    try {
      child.kill();
    } catch {}
    restoreConsoleSync();
  });
}

const modeWaiters = [];

/** Bieżący tryb wejścia konsoli (diagnostyka) albo null. */
export function consoleMode(timeoutMs = 3000) {
  if (!child || !ready) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    modeWaiters.push((m) => (clearTimeout(t), resolve(m)));
    child.stdin.write('mode\n');
  });
}

/** Czy Shift jest teraz wciśnięty (zawsze false poza Windows / przed startem pomocnika). */
export const isShiftDown = () => ready && shiftDown;

/** Włącza/wyłącza w konsoli tryb, w którym terminal przesyła mysz jako tekst. */
export function setVtInput(on, timeoutMs = 5000) {
  if (process.platform !== 'win32') return Promise.resolve(true);
  if (!child) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter = { resolve: (v) => (clearTimeout(timer), resolve(v)) };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    const send = () => {
      try {
        child.stdin.write(on ? 'vt1\n' : 'vt0\n');
      } catch {
        waiter.resolve(false);
      }
    };
    if (ready) {
      waiters.push(waiter);
      send();
    } else {
      // pomocnik jeszcze się uruchamia — wyślij, gdy będzie gotowy
      waiters.push({ onReady: () => (waiters.push(waiter), send()) });
    }
  });
}
