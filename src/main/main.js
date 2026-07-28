'use strict';
const { app, BrowserWindow, ipcMain, shell: electronShell } = require('electron');
const { listClaudeSessions, getAgentReport } = require('./claude-sessions');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('@lydell/node-pty');
const { getGitInfo, getPrInfo, run } = require('./gitinfo');

let win = null;
const sessions = new Map(); // id -> session
let nextId = 1;

// ---------------------------------------------------------------------------
// Shell-Erkennung
// ---------------------------------------------------------------------------
function firstExisting(paths) {
  return paths.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function detectShells() {
  const shells = [];
  if (process.platform === 'win32') {
    shells.push({ id: 'powershell', name: 'PowerShell', file: 'powershell.exe' });
    const pwsh = firstExisting([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
      path.join(os.homedir(), 'AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'),
    ]);
    if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh });
    const gitBash = firstExisting([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      path.join(os.homedir(), 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
    ]);
    if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', file: gitBash });
    shells.push({ id: 'cmd', name: 'Eingabeaufforderung', file: 'cmd.exe' });
    if (firstExisting(['C:\\Windows\\System32\\wsl.exe'])) {
      shells.push({ id: 'wsl', name: 'WSL', file: 'wsl.exe' });
    }
  } else {
    const bash = firstExisting(['/bin/bash', '/usr/bin/bash']);
    if (bash) shells.push({ id: 'bash', name: 'Bash', file: bash });
    const zsh = firstExisting(['/bin/zsh', '/usr/bin/zsh']);
    if (zsh) shells.push({ id: 'zsh', name: 'Zsh', file: zsh });
    if (!shells.length) shells.push({ id: 'sh', name: 'sh', file: '/bin/sh' });
  }
  return shells;
}
const availableShells = detectShells();

// ---------------------------------------------------------------------------
// Shell-Integration: OSC 7 = aktuelles Verzeichnis, OSC 133 = Busy-/Idle-Status
// (133;C = Kommando gestartet, 133;A/D = Prompt sichtbar, wartet auf Eingabe)
const PS_INIT = [
  'function Global:prompt {',
  '  $p = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath',
  '  $e = [char]27',
  '  $b = [char]7',
  "  Write-Host -NoNewline ($e + ']133;D' + $b + $e + ']133;A' + $b + $e + ']7;file://localhost/' + ($p -replace '\\\\','/') + $b)",
  '  "PS $p> "',
  '}',
  'try {',
  '  Import-Module PSReadLine -ErrorAction Stop',
  '  function Global:PSConsoleHostReadLine {',
  '    $l = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext)',
  '    if ($l) {',
  '      $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($l))',
  "      [Console]::Write([string][char]27 + ']7770;cmd;' + $b64 + [string][char]7)",
  '    }',
  "    [Console]::Write([string][char]27 + ']133;C' + [string][char]7)",
  '    $l',
  '  }',
  '} catch { }',
].join('\n');
const PS_ENCODED = Buffer.from(PS_INIT, 'utf16le').toString('base64');

const BASH_RC = `
[ -f ~/.bashrc ] && source ~/.bashrc
__flightdeck_at_prompt=1
__flightdeck_prompt() {
  __flightdeck_at_prompt=1
  printf '\\033]133;D\\007\\033]133;A\\007\\033]7;file://%s%s\\007' "$HOSTNAME" "$PWD"
}
__flightdeck_preexec() {
  [ -n "$__flightdeck_at_prompt" ] || return 0
  case "$BASH_COMMAND" in __flightdeck_prompt*) return 0 ;; esac
  __flightdeck_at_prompt=
  printf '\\033]7770;cmd;%s\\007' "$(printf %s "$BASH_COMMAND" | base64 2>/dev/null | tr -d '\\n')"
  printf '\\033]133;C\\007'
}
PROMPT_COMMAND=__flightdeck_prompt
trap __flightdeck_preexec DEBUG
`;

let bashRcPath = null;
function getBashRcPath() {
  if (!bashRcPath) {
    bashRcPath = path.join(os.tmpdir(), 'flightdeck-bashrc.sh');
    fs.writeFileSync(bashRcPath, BASH_RC);
  }
  return bashRcPath.replace(/\\/g, '/');
}

function spawnArgsFor(shell) {
  switch (shell.id) {
    case 'powershell':
    case 'pwsh':
      return { file: shell.file, args: ['-NoLogo', '-NoExit', '-EncodedCommand', PS_ENCODED], env: {} };
    case 'gitbash':
    case 'bash':
      return { file: shell.file, args: ['--rcfile', getBashRcPath(), '-i'], env: {} };
    case 'zsh':
      return { file: shell.file, args: ['-i'], env: {} };
    default:
      return { file: shell.file, args: [], env: {} };
  }
}

// ---------------------------------------------------------------------------
// OSC-Parsing: aktuelles Verzeichnis aus dem PTY-Datenstrom extrahieren
// ---------------------------------------------------------------------------
const OSC7_RE = /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const OSC99_RE = /\x1b\]9;9;"?([^"\x07\x1b]+)"?(?:\x07|\x1b\\)/g;
const OSC133_RE = /\x1b\]133;([A-D])[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSCCMD_RE = /\x1b\]7770;cmd;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Claude Code (als iTerm angesprochen): OSC 0/2 = Titel, OSC 9 = Notification
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC9_RE = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

// Kommandos, bei denen "still = wartet auf Eingabe" gilt (agentische TUIs:
// arbeiten = permanentes Rendern von Spinner/Timer/Streaming)
const WATCHED_CMD_RE = /(^|[\s\\/"'])(claude|codex|aider)([\s"'.]|$)/i;
const ATTENTION_QUIET_MS = 2000;

function normalizeOscPath(raw) {
  let p;
  try { p = decodeURIComponent(raw); } catch { p = raw; }
  if (/^\/[A-Za-z]:/.test(p)) {
    // file://localhost/C:/Users/... -> C:\Users\...
    p = p.slice(1).replace(/\//g, '\\');
  } else if (process.platform === 'win32' && /^\/[a-z]\//.test(p)) {
    // Git-Bash-Stil /c/Users/... -> C:\Users\...
    p = p[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\');
  }
  return p;
}

function extractCwd(text) {
  let cwd = null; let m;
  OSC7_RE.lastIndex = 0;
  while ((m = OSC7_RE.exec(text)) !== null) cwd = normalizeOscPath(m[1]);
  OSC99_RE.lastIndex = 0;
  while ((m = OSC99_RE.exec(text)) !== null) cwd = m[1];
  return cwd;
}

// ---------------------------------------------------------------------------
// Busy-/Idle-Status
// ---------------------------------------------------------------------------
function setState(session, state) {
  if (session.state === state || session.exited) return;
  session.state = state;
  if (win && !win.isDestroyed()) win.webContents.send('session:state', session.id, state);
}

// Wertet OSC 133/7770 im Datenstrom aus; Matches, die komplett im bereits
// verarbeiteten Tail liegen, werden uebersprungen (keine Doppelverarbeitung).
function applyStateFromData(session, text, tailLen, rawData) {
  let saw = false; let m;

  // Kommandozeile des gestarteten Befehls (von der Shell-Integration gemeldet)
  OSCCMD_RE.lastIndex = 0;
  while ((m = OSCCMD_RE.exec(text)) !== null) {
    if (m.index + m[0].length <= tailLen) continue;
    let cmd = '';
    try { cmd = Buffer.from(m[1], 'base64').toString('utf8'); } catch { /* egal */ }
    session.currentCmd = cmd;
    session.cmdWatched = WATCHED_CMD_RE.test(cmd);
    addHistory(session, cmd, 'shell');
  }

  OSC133_RE.lastIndex = 0;
  while ((m = OSC133_RE.exec(text)) !== null) {
    if (m.index + m[0].length <= tailLen) continue;
    saw = true;
    if (m[1] === 'C') setState(session, 'busy');
    else if (m[1] === 'A' || m[1] === 'D') {
      setState(session, 'idle');
      session.currentCmd = null;
      session.cmdWatched = false;
      session.hasClaudeOsc = false;
      clearTimeout(session.attnTimer);
      // Zurueck am Prompt: ggf. vorgemerktes Kommando starten (Session-Browser)
      if (session.pendingCommand) {
        const cmd = session.pendingCommand;
        session.pendingCommand = null;
        try { session.proc.write(cmd + '\r'); } catch { /* Session weg */ }
      }
    }
  }

  // Native Claude-Signale (Titel: Spinner = arbeitet, U+2733 = wartet auf dich)
  OSC_TITLE_RE.lastIndex = 0;
  while ((m = OSC_TITLE_RE.exec(text)) !== null) {
    if (m.index + m[0].length <= tailLen) continue;
    const first = m[1].charAt(0);
    if (!first) continue;
    const code = first.charCodeAt(0);
    if (code >= 0x2800 && code <= 0x28ff) {          // Braille-Spinner
      session.hasClaudeOsc = true;
      clearTimeout(session.attnTimer);
      setState(session, 'busy');
    } else if (first === '✳') {                  // Stern: Eingabe erwartet
      session.hasClaudeOsc = true;
      clearTimeout(session.attnTimer);
      if (session.state !== 'idle') setState(session, 'attention');
    }
  }

  // OSC 9: Fortschritt (9;4;...) bzw. explizite Notifications von Claude
  OSC9_RE.lastIndex = 0;
  while ((m = OSC9_RE.exec(text)) !== null) {
    if (m.index + m[0].length <= tailLen) continue;
    const payload = m[1];
    if (payload.startsWith('9;')) continue;           // ConEmu-cwd, s. OSC99_RE
    if (payload.startsWith('4;')) {                   // Fortschrittsanzeige
      const level = payload.split(';')[1];
      if (level === '1' || level === '2' || level === '3') {
        session.hasClaudeOsc = true;
        setState(session, 'busy');
      }
      continue;
    }
    // Explizite Meldung ("Claude needs your attention", Permission-Anfrage, ...)
    if (session.state !== 'idle') setState(session, 'attention');
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:notify', session.id, payload.slice(0, 200));
    }
  }
  if (saw) {
    session.hasOsc133 = true;
    clearTimeout(session.idleTimer);
  } else if (!session.hasOsc133) {
    // Fallback ohne Shell-Integration (cmd, WSL): Ausgabe = arbeitet,
    // 500 ms Stille = wartet auf Eingabe. Laeuft eine Vollbild-TUI
    // (Alternate Screen), bleibt der Status stehen statt zu flackern.
    setState(session, 'busy');
    clearTimeout(session.idleTimer);
    if (!session.altScreen) {
      session.idleTimer = setTimeout(() => setState(session, 'idle'), 500);
    }
  }

  // Stille-Heuristik fuer beobachtete TUIs - nur solange Claude keine
  // nativen Signale liefert (hasClaudeOsc), die sind praeziser.
  if (session.hasOsc133 && session.cmdWatched && !session.hasClaudeOsc && session.state !== 'idle') {
    const visible = rawData.replace(OSC_ANY_RE, '');
    if (visible.includes('\x07')) {
      // Terminal-Bell: Claude meldet Fertigstellung/Rueckfrage
      setState(session, 'attention');
      clearTimeout(session.attnTimer);
    } else {
      // Echo des eigenen Tippens (Claude rendert die Eingabezeile) zaehlt nicht
      const isEcho = Date.now() - (session.lastInputAt || 0) < 300;
      if (visible.length && !isEcho) setState(session, 'busy');
      clearTimeout(session.attnTimer);
      session.attnTimer = setTimeout(() => {
        if (!session.exited && session.state === 'busy' && session.cmdWatched) {
          setState(session, 'attention');
        }
      }, ATTENTION_QUIET_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Eingabe-Verlauf: Shell-Kommandos kommen exakt via OSC 7770; Prompts an
// beobachtete TUIs (Claude) werden aus dem Tastatur-Strom rekonstruiert.
// ---------------------------------------------------------------------------
const HISTORY_MAX = 200;

function addHistory(session, text, kind) {
  text = text.trim();
  if (text.length < 2) return;
  const entry = { ts: Date.now(), text: text.slice(0, 500), kind };
  session.history.push(entry);
  if (session.history.length > HISTORY_MAX) session.history.shift();
  if (win && !win.isDestroyed()) win.webContents.send('session:histadd', session.id, entry);
}

function feedInputRecon(session, data) {
  // Bracketed-Paste-Marker entfernen, eingefuegten Inhalt behalten
  data = data.replace(/\x1b\[20[01]~/g, '');
  let buf = session.inputBuf;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r') {
      const text = buf; buf = '';
      // Shell-Kommandos kommen exakt ueber OSC 7770 - hier nur Agent-Prompts
      if (session.cmdWatched) addHistory(session, text, 'agent');
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') { // Ctrl+C / Ctrl+U: Zeile verwerfen
      buf = '';
    } else if (ch === '\x17') { // Ctrl+W: letztes Wort loeschen
      buf = buf.replace(/\S+\s*$/, '');
    } else if (ch === '\x1b') {
      if (data[i + 1] === '[' || data[i + 1] === 'O') { // CSI/SS3 ueberspringen
        let j = i + 2;
        while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j++;
        i = j;
      }
    } else if (ch === '\n') {
      buf += '\n'; // Teil eines Multiline-Paste
    } else if (ch >= ' ') {
      buf += ch;
    }
  }
  session.inputBuf = buf.length > 2000 ? buf.slice(-2000) : buf;
}

// ---------------------------------------------------------------------------
// TODO-Notizen: pro Projekt (Repo-Root) persistiert
// ---------------------------------------------------------------------------
let todosStore = null;
function todosPath() { return path.join(app.getPath('userData'), 'flightdeck-todos.json'); }
function loadTodos() {
  if (!todosStore) {
    try { todosStore = JSON.parse(fs.readFileSync(todosPath(), 'utf8')); }
    catch {
      // Migration von der frueheren "aibash"-Installation
      try {
        const oldPath = path.join(app.getPath('userData'), '..', 'aibash', 'aibash-todos.json');
        todosStore = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
      } catch { todosStore = {}; }
    }
  }
  return todosStore;
}
function rootKeyOf(session) {
  return (session.gitRoot || session.cwd || 'global').toLowerCase();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
// Umgebung fuer die Shells: geerbte Variablen entfernen, die Farben abschalten
// oder von einem umgebenden Tool (Claude Code, Warp) stammen und in einer
// frischen interaktiven Session nichts verloren haben.
function buildPtyEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_CODE_|CLAUDE_|WARP_)/.test(key)) delete env[key];
  }
  delete env.NO_COLOR;
  delete env.CLAUDECODE;
  delete env.GIT_TERMINAL_PROMPT;
  // Claude Code prueft TERM_PROGRAM und sendet nur bei iTerm die OSC-0-Titel
  // (Spinner = arbeitet, Stern = wartet) und OSC-9-Notifications ("needs your
  // attention"). Wir geben uns daher als iTerm aus; FLIGHTDECK bleibt als Marker.
  env.TERM_PROGRAM = 'iTerm.app';
  env.TERM_PROGRAM_VERSION = '3.6.6';
  env.FLIGHTDECK = '1';
  env.COLORTERM = 'truecolor'; // xterm.js kann Truecolor
  return env;
}

function createSession(shellId, opts = {}) {
  const shell = availableShells.find((s) => s.id === shellId) || availableShells[0];
  const { file, args, env } = spawnArgsFor(shell);
  const cwd = (opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : os.homedir();

  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: buildPtyEnv(env),
  });

  const id = String(nextId++);
  const session = {
    id,
    shellId: shell.id,
    shellName: shell.name,
    proc,
    cwd,
    title: null,   // manuell gesetzter Titel
    label: null,   // manuell gesetztes Label
    oscTail: '',
    lastInfoJson: '',
    branch: null,
    gitRoot: null,
    files: [],
    pr: null,
    exited: false,
    refreshing: false,
    refreshQueued: false,
    state: 'idle',
    hasOsc133: false,
    hasClaudeOsc: false,
    idleTimer: null,
    attnTimer: null,
    currentCmd: null,
    cmdWatched: false,
    history: [],
    inputBuf: '',
    lastInputAt: 0,
    altScreen: false,
    outputBuffer: [],
    outputBufferSize: 0,
    pendingCommand: opts.runCommand || null,
  };
  sessions.set(id, session);

  proc.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('session:data', id, data);

    // Scrollback-Puffer fuer die Grid-Vorschau (max. 256 KB)
    session.outputBuffer.push(data);
    session.outputBufferSize += data.length;
    while (session.outputBufferSize > 262144 && session.outputBuffer.length > 1) {
      session.outputBufferSize -= session.outputBuffer.shift().length;
    }

    // Alternate-Screen-Modus (Vollbild-TUIs wie vim, htop, Claude-Dialoge)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) session.altScreen = true;
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) session.altScreen = false;
    }

    const tailLen = session.oscTail.length;
    const text = session.oscTail + data;
    const found = extractCwd(text);
    applyStateFromData(session, text, tailLen, data);
    session.oscTail = text.slice(-512);
    if (found && found !== session.cwd) {
      session.cwd = found;
      refreshSession(session, true);
    }
  });

  proc.onExit(() => {
    clearTimeout(session.idleTimer);
    clearTimeout(session.attnTimer);
    session.exited = true;
    if (win && !win.isDestroyed()) win.webContents.send('session:exit', id);
  });

  // Fallback fuer Shells ohne Prompt-Erkennung: Startkommando nach 4 s senden
  if (session.pendingCommand) {
    setTimeout(() => {
      if (session.pendingCommand && !session.exited) {
        const cmd = session.pendingCommand;
        session.pendingCommand = null;
        try { proc.write(cmd + '\r'); } catch { /* Session weg */ }
      }
    }, 4000);
  }

  refreshSession(session, true);
  return { id, shellId: shell.id, shellName: shell.name, cwd };
}

async function refreshSession(session, force = false) {
  if (session.exited) return;
  // Ueberlappende Refreshes vermeiden; bei cwd-Wechsel wird sofort neu angestossen
  if (session.refreshing) { session.refreshQueued = session.refreshQueued || force; return; }
  session.refreshing = true;
  const cwdAtStart = session.cwd;
  try {
    await doRefresh(session, force, cwdAtStart);
  } finally {
    session.refreshing = false;
  }
  if (session.refreshQueued || session.cwd !== cwdAtStart) {
    session.refreshQueued = false;
    refreshSession(session, true);
  }
}

async function doRefresh(session, force, cwdAtStart) {
  const git = await getGitInfo(cwdAtStart);
  if (session.cwd !== cwdAtStart || session.exited) return; // veraltet -> verwerfen
  session.branch = git ? git.branch : null;
  session.gitRoot = git ? git.root : null;
  session.files = git ? git.files : [];
  const pr = git ? await getPrInfo(cwdAtStart, git.root, git.branch, force) : null;
  if (session.cwd !== cwdAtStart || session.exited) return; // waehrenddessen cd -> verwerfen
  session.pr = pr;

  const info = {
    id: session.id,
    shellName: session.shellName,
    cwd: session.cwd,
    title: session.title,
    label: session.label,
    branch: session.branch,
    gitRoot: session.gitRoot,
    files: session.files,
    pr: session.pr,
    exited: session.exited,
    state: session.state,
  };
  const json = JSON.stringify(info);
  if (json !== session.lastInfoJson || force) {
    session.lastInfoJson = json;
    if (win && !win.isDestroyed()) win.webContents.send('session:info', info);
  }
}

// periodischer Refresh (Branch-Wechsel, neue Aenderungen, PR-Status)
setInterval(() => {
  for (const s of sessions.values()) refreshSession(s);
}, 4000);

// ---------------------------------------------------------------------------
// Datei-Vorschau
// ---------------------------------------------------------------------------
const MAX_PREVIEW = 512 * 1024;

async function previewFile(session, relPath, source) {
  const root = session.gitRoot || session.cwd;
  const abs = path.resolve(root, relPath);

  if (source === 'pr' && session.pr && session.pr.baseRefName) {
    const diff = await run('git', ['diff', '--no-color', `origin/${session.pr.baseRefName}...HEAD`, '--', relPath], root);
    if (diff && diff.trim()) return { kind: 'diff', path: relPath, text: diff.slice(0, MAX_PREVIEW) };
  }

  const entry = session.files.find((f) => f.path === relPath);
  if (!entry || !entry.untracked) {
    const diff = await run('git', ['diff', '--no-color', 'HEAD', '--', relPath], root);
    if (diff && diff.trim()) return { kind: 'diff', path: relPath, text: diff.slice(0, MAX_PREVIEW) };
  }

  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_PREVIEW) {
      return { kind: 'content', path: relPath, text: fs.readFileSync(abs).slice(0, MAX_PREVIEW).toString('utf8') + '\n\n… (gekuerzt)' };
    }
    return { kind: 'content', path: relPath, text: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { kind: 'error', path: relPath, text: 'Datei konnte nicht gelesen werden: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('shells:list', () => availableShells.map(({ id, name }) => ({ id, name })));
ipcMain.handle('session:create', (e, shellId, opts) => createSession(shellId, opts || {}));

ipcMain.handle('session:buffer', (e, id) => {
  const s = sessions.get(id);
  return s ? s.outputBuffer.join('') : '';
});

ipcMain.handle('claude:sessions', () => listClaudeSessions());

ipcMain.handle('claude:report', (e, id) => {
  const s = sessions.get(id);
  if (!s) return { found: false };
  return getAgentReport(s.cwd, s.gitRoot);
});

ipcMain.on('app:focus', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

ipcMain.on('session:input', (e, id, data) => {
  const s = sessions.get(id);
  if (s && !s.exited) {
    s.lastInputAt = Date.now();
    feedInputRecon(s, data);
    // Fallback ohne Shell-Integration: Enter = Kommando gestartet
    if (!s.hasOsc133 && data.includes('\r')) setState(s, 'busy');
    s.proc.write(data);
  }
});

ipcMain.on('session:resize', (e, id, cols, rows) => {
  const s = sessions.get(id);
  if (s && !s.exited && cols > 0 && rows > 0) {
    try { s.proc.resize(cols, rows); } catch { /* Race beim Beenden */ }
  }
});

ipcMain.handle('session:close', (e, id) => {
  const s = sessions.get(id);
  if (s) {
    try { s.proc.kill(); } catch { /* bereits beendet */ }
    sessions.delete(id);
  }
});

ipcMain.handle('session:setMeta', (e, id, meta) => {
  const s = sessions.get(id);
  if (!s) return;
  if ('title' in meta) s.title = meta.title || null;
  if ('label' in meta) s.label = meta.label || null;
  refreshSession(s, true);
});

ipcMain.handle('file:preview', (e, id, relPath, source) => {
  const s = sessions.get(id);
  if (!s) return { kind: 'error', path: relPath, text: 'Session nicht gefunden' };
  return previewFile(s, relPath, source);
});

ipcMain.on('open-external', (e, url) => {
  if (/^https?:\/\//.test(url)) electronShell.openExternal(url);
});

ipcMain.handle('history:get', (e, id) => {
  const s = sessions.get(id);
  return s ? s.history : [];
});

ipcMain.handle('todos:get', (e, id) => {
  const s = sessions.get(id);
  if (!s) return { key: null, todos: [] };
  const key = rootKeyOf(s);
  return { key, todos: loadTodos()[key] || [] };
});

ipcMain.handle('todos:set', (e, id, todos) => {
  const s = sessions.get(id);
  if (!s) return false;
  const store = loadTodos();
  const key = rootKeyOf(s);
  if (todos.length) store[key] = todos;
  else delete store[key];
  try { fs.writeFileSync(todosPath(), JSON.stringify(store, null, 2)); }
  catch { /* Platte voll o. ae. - Notizen bleiben im Speicher */ }
  if (win && !win.isDestroyed()) win.webContents.send('todos:changed', key, todos);
  return true;
});

// ---------------------------------------------------------------------------
// Fenster
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#101116',
    title: 'Flightdeck',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.proc.kill(); } catch { /* egal */ } }
  app.quit();
});
