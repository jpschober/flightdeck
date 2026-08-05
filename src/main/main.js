'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell: electronShell } = require('electron');
const {
  TRANSCRIPT_ID_RE,
  listClaudeSessions,
  snapshotTranscripts, detectTranscript, newestTranscript, readAgentCwd,
  findTranscriptById, stopWatchingProjects,
} = require('./claude-sessions');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('@lydell/node-pty');
const { getGitInfo, getPrInfo, run } = require('./gitinfo');
const { getUsage } = require('./usage');
const { getSchemaView, clearCache: clearSchemaCache } = require('./dbschema');
const { getAgentView } = require('./agents');
const i18n = require('../i18n');
const { t } = i18n;
const settings = require('./settings');

let win = null;
const sessions = new Map(); // id -> session
let nextId = 1;

// ---------------------------------------------------------------------------
// Shell detection
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
    shells.push({ id: 'cmd', nameKey: 'shell.cmd', file: 'cmd.exe' });
    if (firstExisting(['C:\\Windows\\System32\\wsl.exe'])) {
      shells.push({ id: 'wsl', name: 'WSL', file: 'wsl.exe' });
    }
  } else {
    // Whatever the system offers as a login shell, plus the user's own default
    // shell. /etc/shells often lists several paths to the same binary
    // (/bin/fish and /usr/bin/fish) - the id decides, every shell appears once.
    const candidates = [];
    try {
      for (const line of fs.readFileSync('/etc/shells', 'utf8').split('\n')) {
        const p = line.trim();
        if (p && !p.startsWith('#')) candidates.push(p);
      }
    } catch { /* no /etc/shells (e.g. a minimal container) */ }
    candidates.push(process.env.SHELL || '');
    for (const name of ['bash', 'zsh', 'fish', 'nu', 'elvish', 'xonsh', 'ksh', 'tcsh', 'dash']) {
      candidates.push('/usr/bin/' + name, '/bin/' + name, '/usr/local/bin/' + name);
    }

    for (const file of candidates) {
      if (!file || !firstExisting([file])) continue;
      const base = path.basename(file);
      if (SHELL_BLOCKLIST.has(base)) continue;
      const id = base === 'nu' ? 'nushell' : base;
      if (shells.some((s) => s.id === id)) continue;
      shells.push({ id, name: SHELL_NAMES[id] || base, file });
    }
    if (!shells.length) shells.push({ id: 'sh', name: 'sh', file: '/bin/sh' });

    // The user's default shell goes first - it is the new session
    const preferred = path.basename(process.env.SHELL || '');
    const idx = shells.findIndex((s) => path.basename(s.file) === preferred);
    if (idx > 0) shells.unshift(shells.splice(idx, 1)[0]);
  }
  return shells;
}

// Shells that are no good as an interactive terminal, or are not shells at all
const SHELL_BLOCKLIST = new Set([
  'nologin', 'false', 'sync', 'git-shell', 'rbash',
  'systemd-home-fallback-shell', 'screen', 'tmux',
]);

const SHELL_NAMES = {
  bash: 'Bash', zsh: 'Zsh', fish: 'Fish', nushell: 'Nushell',
  elvish: 'Elvish', xonsh: 'Xonsh', ksh: 'Ksh', tcsh: 'Tcsh',
  dash: 'Dash', sh: 'sh',
};
const availableShells = detectShells();

// Shell detection runs at module load, before the language is known, and the
// names of most shells are proper nouns anyway. Only the ones carrying a
// `nameKey` get translated - and freshly on every call, so a language switch
// reaches them too.
function shellName(shell) {
  return shell.nameKey ? t(shell.nameKey) : shell.name;
}

// ---------------------------------------------------------------------------
// Shell integration: OSC 7 = current directory, OSC 133 = busy/idle state
// (133;C = command started, 133;A/D = prompt visible, waiting for input)
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

// Claude wrapper: assigns the session ID itself and reports it before Claude
// starts. Only that makes the mapping terminal -> transcript unambiguous;
// without it, the only option left would be guessing via timestamps - and
// anyone who happens to be working in another window at the same moment would
// get the wrong transcript.
// OSC 7771: session;<uuid> = exact, continue; = the folder's latest session.
const SH_CLAUDE_WRAPPER = `
__flightdeck_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen 2>/dev/null | tr 'A-Z' 'a-z'
  fi
}
claude() {
  __fd_mode=new
  for __fd_a in "$@"; do
    case "$__fd_a" in
      -c|--continue) __fd_mode=continue ;;
      -r|--resume|--resume=*|--session-id|--session-id=*) __fd_mode=other ;;
    esac
  done
  if [ "$__fd_mode" = new ]; then
    __fd_id=$(__flightdeck_uuid)
    if [ -n "$__fd_id" ]; then
      printf '\\033]7771;session;%s\\007' "$__fd_id"
      command claude --session-id "$__fd_id" "$@"
      return $?
    fi
  elif [ "$__fd_mode" = continue ]; then
    printf '\\033]7771;continue;\\007'
  fi
  command claude "$@"
}
`;

const BASH_RC = `
[ -f ~/.bashrc ] && source ~/.bashrc
${SH_CLAUDE_WRAPPER}
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

// Fish has no --rcfile, but -C runs commands before the first prompt. The
// events fish_prompt/fish_preexec deliver the same as PROMPT_COMMAND + the
// DEBUG trap in Bash.
const FISH_RC = `
function __flightdeck_prompt --on-event fish_prompt
    printf '\\033]133;D\\007\\033]133;A\\007\\033]7;file://%s%s\\007' $hostname $PWD
end
function __flightdeck_preexec --on-event fish_preexec
    printf '\\033]7770;cmd;%s\\007' (printf '%s' $argv[1] | base64 | string join '')
    printf '\\033]133;C\\007'
end
function __flightdeck_uuid
    if test -r /proc/sys/kernel/random/uuid
        cat /proc/sys/kernel/random/uuid
    else
        uuidgen 2>/dev/null | string lower
    end
end
function claude
    set -l mode new
    for a in $argv
        switch $a
            case -c --continue
                set mode continue
            case -r --resume '--resume=*' --session-id '--session-id=*'
                set mode other
        end
    end
    if test $mode = new
        set -l id (__flightdeck_uuid)
        if test -n "$id"
            printf '\\033]7771;session;%s\\007' $id
            command claude --session-id $id $argv
            return $status
        end
    else if test $mode = continue
        printf '\\033]7771;continue;\\007'
    end
    command claude $argv
end
`;

// Zsh loads its configuration from $ZDOTDIR. We point that at our own directory
// (see getRcDir), which first loads the user's real configuration and then
// installs the hooks.
// Important: after loading the user's .zshenv, ZDOTDIR must point back at our
// directory, otherwise zsh will not find our .zshrc in the next step.
const ZSH_ENV = `
__flightdeck_rcdir="$ZDOTDIR"
ZDOTDIR="\${FLIGHTDECK_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"
ZDOTDIR="$__flightdeck_rcdir"
unset __flightdeck_rcdir
`;

const ZSH_RC = `
ZDOTDIR="\${FLIGHTDECK_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
${SH_CLAUDE_WRAPPER}
__flightdeck_prompt() {
  printf '\\033]133;D\\007\\033]133;A\\007\\033]7;file://%s%s\\007' "\${HOST:-localhost}" "$PWD"
}
__flightdeck_preexec() {
  printf '\\033]7770;cmd;%s\\007' "$(printf %s "$1" | base64 2>/dev/null | tr -d '\\n')"
  printf '\\033]133;C\\007'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __flightdeck_prompt
add-zsh-hook preexec __flightdeck_preexec
`;

// The integration files live in their own directory under userData; zsh needs a
// directory (ZDOTDIR), the others only a file. A world-writable location such as
// os.tmpdir() lets another local user create the directory first and place files
// in it, and zsh sources everything it finds in ZDOTDIR.

// Zsh startup files that Flightdeck never writes but would source from ZDOTDIR.
// One of them left behind by an older version or another writer runs on every
// session, so they are removed. Other entries are left alone: a second instance
// may be writing its own temporary file at any moment.
const ZSH_STALE_FILES = ['.zprofile', '.zlogin', '.zlogout'];

let rcDir = null;
function getRcDir() {
  if (!rcDir) {
    const dir = path.join(app.getPath('userData'), 'shell-integration');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync with recursive: true also accepts a symlink to a directory, and
    // the chmod and the removals below would then apply to the target.
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('not a directory: ' + dir);
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    for (const name of ZSH_STALE_FILES) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* never mind */ }
    }
    rcDir = dir;
  }
  return rcDir;
}

// Written to a separate file and renamed over the old one, so a session started
// by a second Flightdeck instance reads either the previous or the new content
// and never a half-written file. Other users are kept out by the 0700 directory;
// the temporary name only needs to be unique per instance.
function writeRc(name, content) {
  const p = path.join(getRcDir(), name);
  const tmp = p + '.' + process.pid + '.tmp';
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, p);
  return p.replace(/\\/g, '/');
}

let rcPaths = {};
function getRc(name, content) {
  if (!rcPaths[name]) rcPaths[name] = writeRc(name, content);
  return rcPaths[name];
}

function spawnArgsFor(shell) {
  switch (shell.id) {
    case 'powershell':
    case 'pwsh':
      return { file: shell.file, args: ['-NoLogo', '-NoExit', '-EncodedCommand', PS_ENCODED], env: {} };
    case 'gitbash':
    case 'bash':
      return { file: shell.file, args: ['--rcfile', getRc('bashrc.sh', BASH_RC), '-i'], env: {} };
    case 'fish': {
      // -C takes a string that fish parses, and the userData path contains a
      // space on macOS, so the path is quoted. Inside single quotes fish treats
      // only \' and \\ as escapes.
      const rc = getRc('init.fish', FISH_RC).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return {
        file: shell.file,
        args: ['-C', "source '" + rc + "'", '-i'],
        env: {},
      };
    }
    case 'zsh': {
      getRc('.zshenv', ZSH_ENV);
      getRc('.zshrc', ZSH_RC);
      return {
        file: shell.file,
        args: ['-i'],
        env: {
          ZDOTDIR: getRcDir(),
          FLIGHTDECK_ZDOTDIR: process.env.ZDOTDIR || os.homedir(),
        },
      };
    }
    default:
      return { file: shell.file, args: ['-i'], env: {} };
  }
}

// ---------------------------------------------------------------------------
// OSC parsing: extract the current directory from the PTY data stream
// ---------------------------------------------------------------------------
const OSC7_RE = /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const OSC99_RE = /\x1b\]9;9;"?([^"\x07\x1b]+)"?(?:\x07|\x1b\\)/g;
const OSC133_RE = /\x1b\]133;(?<mark>[A-D])[^\x07\x1b]*(?:\x07|\x1b\\)/;
const OSCCMD_RE = /\x1b\]7770;cmd;(?<cmdB64>[A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/;
const OSCSESS_RE = /\x1b\]7771;(?<sessKind>[a-z]+);(?<sessId>[^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Claude Code (addressed as iTerm): OSC 0/2 = title, OSC 9 = notification
const OSC_TITLE_RE = /\x1b\](?:0|2);(?<title>[^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC9_RE = /\x1b\]9;(?<osc9>[^\x07\x1b]*)(?:\x07|\x1b\\)/;

// The state sequences are scanned in one pass. Seven separate scans grouped
// their effects by sequence type: OSC 7770 was evaluated in full before
// OSC 133, so a batch holding "133;D (previous command finished) ... 7770;cmd
// (claude starts) ... 133;C" first marked the session as watched and then
// cleared that again from the earlier D. With one pass the matches are
// dispatched in the order they stand in the stream.
//
// None of the alternatives can start at the same position as another (they
// differ from the character after `\x1b]` onwards) and none can match inside
// another (the payloads exclude \x1b and \x07), so the combined scan finds
// exactly the matches the individual expressions found.
const OSC_EVENT_RE = new RegExp(
  [OSCCMD_RE, OSCSESS_RE, OSC133_RE, OSC_TITLE_RE, OSC9_RE]
    .map((r) => `(?:${r.source})`).join('|'), 'g');

// Commands for which "quiet = waiting for input" holds (agentic TUIs:
// working = continuously rendering a spinner/timer/streaming output)
const WATCHED_CMD_RE = /(^|[\s\\/"'])(claude|codex|aider)([\s"'.]|$)/i;
const ATTENTION_QUIET_MS = 2000;

function normalizeOscPath(raw) {
  let p;
  try { p = decodeURIComponent(raw); } catch { p = raw; }
  if (/^\/[A-Za-z]:/.test(p)) {
    // file://localhost/C:/Users/... -> C:\Users\...
    p = p.slice(1).replace(/\//g, '\\');
  } else if (process.platform === 'win32' && /^\/[a-z]\//.test(p)) {
    // Git Bash style /c/Users/... -> C:\Users\...
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
// Busy/idle state
// ---------------------------------------------------------------------------
function setState(session, state) {
  if (session.state === state || session.exited) return;
  session.state = state;
  if (win && !win.isDestroyed()) win.webContents.send('session:state', session.id, state);
}

// "Waiting for you" only applies once the agent has actually received a task.
// Right after `claude` it sits at the prompt by definition - sending that out
// as an attention notice would be a false alarm every single time.
function setAttention(session) {
  if (!session.agentPrompted) return false;
  if (session.state === 'idle') return false;
  setState(session, 'attention');
  return true;
}

// Evaluates OSC 133/7770 in the data stream; matches that lie entirely within
// the already processed tail are skipped (no double processing).
function applyStateFromData(session, text, tailLen, rawData) {
  let saw = false; let m;

  OSC_EVENT_RE.lastIndex = 0;
  while ((m = OSC_EVENT_RE.exec(text)) !== null) {
    if (m.index + m[0].length <= tailLen) continue;
    const g = m.groups;

    // Command line of the started command (reported by the shell integration)
    if (g.cmdB64 !== undefined) {
      let cmd = '';
      try { cmd = Buffer.from(g.cmdB64, 'base64').toString('utf8'); } catch { /* never mind */ }
      session.currentCmd = cmd;
      session.cmdWatched = WATCHED_CMD_RE.test(cmd);
      if (session.cmdWatched) {
        beginAgentBinding(session, cmd);
        // Freshly started: the agent shows its interface and waits for the first
        // prompt. That is not a "needs you" but the normal state - attention
        // notices only make sense from the first prompt onwards.
        session.agentPrompted = false;
      }
      addHistory(session, cmd, 'shell');

    // Report from the claude wrapper - the shell emits OSC 7770 before the
    // command runs and the wrapper its OSC 7771 afterwards, so stream order
    // already puts the binding after the beginAgentBinding() that resets it.
    } else if (g.sessKind !== undefined) {
      if (g.sessKind === 'session' && g.sessId) bindAgentSession(session, g.sessId, true);
      else if (g.sessKind === 'continue') bindContinuedSession(session);

    } else if (g.mark !== undefined) {
      saw = true;
      if (g.mark === 'C') setState(session, 'busy');
      else if (g.mark === 'A' || g.mark === 'D') {
        setState(session, 'idle');
        session.currentCmd = null;
        session.cmdWatched = false;
        session.hasClaudeOsc = false;
        clearTimeout(session.attnTimer);
        // Back at the prompt: run a queued command if there is one (session browser)
        if (session.pendingCommand) {
          const cmd = session.pendingCommand;
          session.pendingCommand = null;
          try { session.proc.write(cmd + '\r'); } catch { /* session gone */ }
        }
      }

    // Native Claude signals (title: spinner = working, U+2733 = waiting for you)
    } else if (g.title !== undefined) {
      const first = g.title.charAt(0);
      if (!first) continue;
      const code = first.charCodeAt(0);
      if (code >= 0x2800 && code <= 0x28ff) {          // braille spinner
        session.hasClaudeOsc = true;
        clearTimeout(session.attnTimer);
        setState(session, 'busy');
      } else if (first === '✳') {                  // asterisk: input expected
        session.hasClaudeOsc = true;
        clearTimeout(session.attnTimer);
        setAttention(session);
      }

    // OSC 9: progress (9;4;...) or explicit notifications from Claude
    } else if (g.osc9 !== undefined) {
      const payload = g.osc9;
      if (payload.startsWith('9;')) continue;           // ConEmu cwd, see OSC99_RE
      if (payload.startsWith('4;')) {                   // progress indicator
        const level = payload.split(';')[1];
        if (level === '1' || level === '2' || level === '3') {
          session.hasClaudeOsc = true;
          setState(session, 'busy');
        }
        continue;
      }
      // Explicit notification ("Claude needs your attention", permission request, ...)
      if (setAttention(session) && win && !win.isDestroyed()) {
        win.webContents.send('session:notify', session.id, payload.slice(0, 200));
      }
    }
  }

  if (saw) {
    session.hasOsc133 = true;
    clearTimeout(session.idleTimer);
  } else if (!session.hasOsc133) {
    // Fallback without shell integration (cmd, WSL): output = working,
    // 500 ms of silence = waiting for input. While a full-screen TUI is running
    // (alternate screen), the state stays put instead of flickering.
    setState(session, 'busy');
    clearTimeout(session.idleTimer);
    if (!session.altScreen) {
      session.idleTimer = setTimeout(() => setState(session, 'idle'), 500);
    }
  }

  // Silence heuristic for the watched TUIs - only as long as Claude delivers
  // no native signals (hasClaudeOsc), those are more precise.
  if (session.hasOsc133 && session.cmdWatched && !session.hasClaudeOsc && session.state !== 'idle') {
    const visible = rawData.replace(OSC_ANY_RE, '');
    if (visible.includes('\x07')) {
      // Terminal bell: Claude reports completion or a question
      setAttention(session);
      clearTimeout(session.attnTimer);
    } else {
      // The echo of your own typing (Claude renders the input line) does not count
      const isEcho = Date.now() - (session.lastInputAt || 0) < 300;
      if (visible.length && !isEcho) setState(session, 'busy');
      clearTimeout(session.attnTimer);
      session.attnTimer = setTimeout(() => {
        if (!session.exited && session.state === 'busy' && session.cmdWatched) {
          setAttention(session);
        }
      }, ATTENTION_QUIET_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Agent binding: which Claude transcript belongs to this session?
//
// Without this binding the app guesses via "newest file in the project
// directory" - with several chats running in the same repo the report shows the
// wrong one, and a worktree switch by the agent stays invisible.
// ---------------------------------------------------------------------------
const RESUME_RE = /(?:--resume|--session-id|(?:^|\s)-r)[= ]+([0-9a-f-]{36})/i;

function bindAgentSession(session, sessionId, exact) {
  session.claudeSessionId = sessionId;
  session.bindingExact = exact;
  session.transcriptSnapshot = null;
}

// `claude --continue` resumes the directory's most recently used session. We
// apply the same rule at the moment of the start - that is not a heuristic but
// the very selection Claude itself makes.
function bindContinuedSession(session) {
  const id = newestTranscript(session.cwd, session.claudeStartedAt);
  if (id) bindAgentSession(session, id, true);
}

function beginAgentBinding(session, cmd) {
  session.claudeSessionId = null;
  session.bindingExact = false;
  session.agentCwd = null;
  session.transcriptSnapshot = snapshotTranscripts(session.cwd);
  session.claudeStartedAt = Date.now() - 1000; // clock drift / mtime granularity
  session.bindingBase = session.cwd;

  // If the command line names the ID itself, there is nothing more to do. With
  // --fork-session a new ID is created instead - then the wrapper takes over.
  const m = RESUME_RE.exec(cmd);
  if (m && !/--fork-session/.test(cmd)) bindAgentSession(session, m[1], true);
}

async function updateAgentBinding(session) {
  if (!session.bindingBase) { session.transcript = null; return; }
  // If the shell leaves the directory in which `claude` was started, the
  // binding no longer fits.
  if (session.cwd !== session.bindingBase) {
    session.claudeSessionId = null;
    session.bindingExact = false;
    session.agentCwd = null;
    session.bindingBase = null;
    session.transcriptSnapshot = null;
    session.transcript = null;
    return;
  }
  // Last resort for cases without a wrapper report (`command claude`, npx, a
  // shell without integration): guess via timestamps. That can go wrong if
  // somebody is working in another window at the same time - which is why the
  // binding stays marked as uncertain and the report points that out.
  if (!session.claudeSessionId && session.transcriptSnapshot) {
    const id = detectTranscript(
      session.bindingBase, session.transcriptSnapshot, session.claudeStartedAt,
    );
    if (id) bindAgentSession(session, id, false);
  }
  if (!session.claudeSessionId) { session.transcript = null; return; }

  // Resolved once per pass and handed to the agent sensor below, which would
  // otherwise look up the same path three more times. ID and path are stored
  // together: PTY data arriving during the awaits below can bind a different
  // session, and a path from the previous one would then point into a foreign
  // transcript.
  const id = session.claudeSessionId;
  const file = findTranscriptById(id);
  session.transcript = { id, path: file };
  const agentCwd = file ? await readAgentCwd(id, file) : null;
  // Only adopt it if it lies below the shell's directory (i.e. a worktree or
  // similar) - anything else would be a foreign transcript.
  if (agentCwd && agentCwd !== session.cwd
      && agentCwd.startsWith(session.cwd.replace(/[\\/]+$/, '') + path.sep)
      && fs.existsSync(agentCwd)) {
    session.agentCwd = agentCwd;
  } else {
    session.agentCwd = null;
  }
}

// ---------------------------------------------------------------------------
// Input history: shell commands arrive verbatim via OSC 7770; prompts to the
// watched TUIs (Claude) are reconstructed from the keyboard stream.
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
  // Strip bracketed-paste markers, keep the pasted content
  data = data.replace(/\x1b\[20[01]~/g, '');
  let buf = session.inputBuf;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r') {
      const text = buf; buf = '';
      // Shell commands arrive verbatim via OSC 7770 - only agent prompts here
      if (session.cmdWatched) {
        session.agentPrompted = true;
        addHistory(session, text, 'agent');
      }
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') { // Ctrl+C / Ctrl+U: discard the line
      buf = '';
    } else if (ch === '\x17') { // Ctrl+W: delete the last word
      buf = buf.replace(/\S+\s*$/, '');
    } else if (ch === '\x1b') {
      if (data[i + 1] === '[' || data[i + 1] === 'O') { // skip CSI/SS3
        let j = i + 2;
        while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j++;
        i = j;
      }
    } else if (ch === '\n') {
      buf += '\n'; // part of a multi-line paste
    } else if (ch >= ' ') {
      buf += ch;
    }
  }
  session.inputBuf = buf.length > 2000 ? buf.slice(-2000) : buf;
}

// ---------------------------------------------------------------------------
// TODO notes: persisted per project (repo root)
// ---------------------------------------------------------------------------
let todosStore = null;
function todosPath() { return path.join(app.getPath('userData'), 'flightdeck-todos.json'); }
function loadTodos() {
  if (!todosStore) {
    try { todosStore = JSON.parse(fs.readFileSync(todosPath(), 'utf8')); }
    catch {
      // Migration from the earlier "aibash" installation
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
// Environment for the shells: remove inherited variables that switch colours
// off or come from a surrounding tool (Claude Code, Warp) and have no business
// being in a fresh interactive session.
function buildPtyEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_CODE_|CLAUDE_|WARP_)/.test(key)) delete env[key];
  }
  delete env.NO_COLOR;
  delete env.CLAUDECODE;
  delete env.GIT_TERMINAL_PROMPT;
  // Claude Code checks TERM_PROGRAM and only sends the OSC 0 titles (spinner =
  // working, asterisk = waiting) and OSC 9 notifications ("needs your
  // attention") for iTerm. So we pose as iTerm; FLIGHTDECK stays as a marker.
  env.TERM_PROGRAM = 'iTerm.app';
  env.TERM_PROGRAM_VERSION = '3.6.6';
  env.FLIGHTDECK = '1';
  env.COLORTERM = 'truecolor'; // xterm.js can do truecolor
  return env;
}

// The renderer asks for a Claude transcript to be resumed, not for a command line
// of its own choosing: the ID is checked against the UUID form and the command is
// assembled here, so nothing reaches the PTY that was not built in this process.
// The session browser only offers IDs of that form, so a rejected one means the
// request did not come from it.
function resumeCommand(resume) {
  if (!resume || !TRANSCRIPT_ID_RE.test(String(resume.id || ''))) return null;
  return `claude --resume ${resume.id}${resume.fork ? ' --fork-session' : ''}`;
}

// Output batching and flow control
// --------------------------------
// node-pty hands over thousands of chunks per second for `cat` on a large file
// or an install log. One IPC send per chunk means one structured clone and one
// xterm write per chunk; the chunks are collected here and go out together
// after FLUSH_MS or once FLUSH_CHARS have accumulated.
//
// The renderer acknowledges every batch once xterm has processed it. Above
// FLOW_HIGH_WATER_CHARS unacknowledged characters the PTY is paused, below
// FLOW_LOW_WATER_CHARS it is resumed - without this, a producer faster than the
// renderer grows xterm's internal buffer up to its 50 MB limit.
//
// All four limits count UTF-16 code units (String.length), not bytes: node-pty
// hands over decoded strings and that is what crosses the IPC boundary.
const FLUSH_MS = 16;
const FLUSH_CHARS = 65536;
const FLOW_HIGH_WATER_CHARS = 262144;
const FLOW_LOW_WATER_CHARS = 65536;
const GRID_BUFFER_CHARS = 262144;
const GRID_PREVIEW_CHARS = 20480;

function queueOutput(session, data) {
  session.pending.push(data);
  session.pendingSize += data.length;
  if (session.pendingSize >= FLUSH_CHARS) { flushOutput(session); return; }
  if (!session.flushTimer) {
    session.flushTimer = setTimeout(() => flushOutput(session), FLUSH_MS);
  }
}

function flushOutput(session) {
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }
  if (!session.pending.length) return;
  const data = session.pending.length === 1 ? session.pending[0] : session.pending.join('');
  session.pending.length = 0;
  session.pendingSize = 0;

  if (win && !win.isDestroyed()) {
    win.webContents.send('session:data', session.id, data);
    session.unacked += data.length;
    if (!session.flowPaused && session.unacked > FLOW_HIGH_WATER_CHARS) {
      session.flowPaused = true;
      try { session.proc.pause(); } catch { /* session gone */ }
    }
  }

  // Scrollback buffer for the grid preview
  session.outputBuffer.push(data);
  session.outputBufferSize += data.length;
  while (session.outputBufferSize > GRID_BUFFER_CHARS && session.outputBuffer.length > 1) {
    session.outputBufferSize -= session.outputBuffer.shift().length;
  }

  // Alternate screen mode (full-screen TUIs such as vim, htop, Claude dialogs).
  // A batch regularly holds both switches - less quitting into a pager, one
  // Claude dialog closing as the next opens - so the last one in the stream
  // decides, not the order the two checks happen to stand in.
  if (data.includes('\x1b[?')) {
    const enter = Math.max(data.lastIndexOf('\x1b[?1049h'), data.lastIndexOf('\x1b[?47h'));
    const leave = Math.max(data.lastIndexOf('\x1b[?1049l'), data.lastIndexOf('\x1b[?47l'));
    if (enter !== leave) session.altScreen = enter > leave;
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
}

// The renderer reports how many characters xterm has processed. Once the
// backlog is small enough the PTY reads on.
function ackOutput(session, chars) {
  session.unacked = Math.max(0, session.unacked - chars);
  if (session.flowPaused && session.unacked <= FLOW_LOW_WATER_CHARS) {
    session.flowPaused = false;
    try { session.proc.resume(); } catch { /* session gone */ }
  }
}

// A reload of the renderer (Ctrl+R) drops the batches in flight, which are then
// never acknowledged. The lost characters would stay in `unacked` as a
// permanent offset and, once past the low-water mark, leave the session paused
// with no ack able to release it. The backlog belongs to a document that no
// longer exists, so it is dropped with it.
function resetFlowControl() {
  for (const s of sessions.values()) {
    s.unacked = 0;
    if (s.flowPaused) {
      s.flowPaused = false;
      try { s.proc.resume(); } catch { /* session gone */ }
    }
  }
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
    shellName: shellName(shell),
    proc,
    cwd,
    title: null,   // manually set title
    label: null,   // manually set label
    oscTail: '',
    lastInfoJson: '',
    branch: null,
    gitRoot: null,
    files: [],
    fileMemory: new Map(),   // path -> entry; survives commits
    pr: null,
    claudeSessionId: null,   // transcript of the running Claude session
    transcript: null,        // { id, path }, resolved once per refresh
    bindingExact: false,     // ID reported by the wrapper instead of guessed via timestamps
    agentCwd: null,          // the agent's working directory (a worktree, if any)
    agents: null,            // running subagents (from the agent sensor)
    bindingBase: null,
    transcriptSnapshot: null,
    claudeStartedAt: 0,
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
    pending: [],          // PTY chunks not yet sent to the renderer
    pendingSize: 0,
    flushTimer: null,
    unacked: 0,           // characters sent but not yet processed by xterm
    flowPaused: false,
    pendingCommand: resumeCommand(opts.resume),
  };
  sessions.set(id, session);

  proc.onData((data) => queueOutput(session, data));

  proc.onExit(() => {
    clearTimeout(session.idleTimer);
    clearTimeout(session.attnTimer);
    flushOutput(session);
    session.exited = true;
    if (win && !win.isDestroyed()) win.webContents.send('session:exit', id);
  });

  // Fallback for shells without prompt detection: send the start command after 4 s
  if (session.pendingCommand) {
    setTimeout(() => {
      if (session.pendingCommand && !session.exited) {
        const cmd = session.pendingCommand;
        session.pendingCommand = null;
        try { proc.write(cmd + '\r'); } catch { /* session gone */ }
      }
    }, 4000);
  }

  refreshSession(session, true);
  return { id, shellId: shell.id, shellName: shellName(shell), cwd };
}

async function refreshSession(session, force = false) {
  if (session.exited) return;
  // Avoid overlapping refreshes; on a cwd change a new one is triggered right away
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

// While working, commits happen in between - then the files disappear from
// `git status` and the list jumps to empty. Whatever was once in there
// therefore stays and is marked as committed, until the directory changes or a
// PR takes over the list.
function mergeFileMemory(session, current) {
  if (!session.fileMemory) session.fileMemory = new Map();
  const memory = session.fileMemory;
  const seen = new Set();

  for (const f of current) {
    seen.add(f.path);
    memory.set(f.path, { ...f, committed: false });
  }
  for (const [p, entry] of memory) {
    if (!seen.has(p)) memory.set(p, { ...entry, committed: true });
  }
  // Order: open changes first, committed ones below
  return [...memory.values()].sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

function resetFileMemory(session) {
  session.fileMemory = new Map();
}

async function doRefresh(session, force, cwdAtStart) {
  await updateAgentBinding(session);
  if (session.cwd !== cwdAtStart || session.exited) return; // stale -> discard
  // If the agent works in a worktree, that worktree's branch counts - not the
  // one of the shell that stayed behind in the repo.
  const gitCwd = session.agentCwd || cwdAtStart;
  const git = await getGitInfo(gitCwd);
  if (session.cwd !== cwdAtStart || session.exited) return; // stale -> discard
  // If the repo or branch changes, the memory starts over - otherwise one would
  // drag along files from a foreign branch.
  if (git && (session.gitRoot !== git.root || session.branch !== git.branch)) {
    resetFileMemory(session);
  }
  session.branch = git ? git.branch : null;
  session.gitRoot = git ? git.root : null;
  if (!git) resetFileMemory(session);
  session.files = git ? mergeFileMemory(session, git.files) : [];
  const pr = git ? await getPrInfo(gitCwd, git.root, git.branch, force) : null;
  if (session.cwd !== cwdAtStart || session.exited) return; // cd in the meantime -> discard
  session.pr = pr;

  // Who is working here right now? The sensor puts that question to the
  // plugins - which agent CLI runs in the terminal is none of the refresh's
  // business.
  const ctx = {
    cwd: cwdAtStart,
    agentCwd: session.agentCwd,
    command: session.currentCmd,
    claudeSessionId: session.claudeSessionId,
  };
  // The binding can have moved on while the git and PR lookups above were
  // running. The resolved path only travels with the ID it was resolved for;
  // otherwise the key stays out and the plugin resolves it itself.
  if (session.transcript && session.transcript.id === session.claudeSessionId) {
    ctx.claudeTranscript = session.transcript.path;
  }
  session.agents = await getAgentView(ctx);
  if (session.cwd !== cwdAtStart || session.exited) return;

  const shell = availableShells.find((s) => s.id === session.shellId);
  const info = {
    id: session.id,
    shellName: shell ? shellName(shell) : session.shellName,
    cwd: session.cwd,
    title: session.title,
    label: session.label,
    branch: session.branch,
    gitRoot: session.gitRoot,
    agentCwd: session.agentCwd,
    worktree: session.agentCwd ? path.basename(session.agentCwd) : null,
    agents: session.agents,
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

// periodic refresh (branch switches, new changes, PR status). Nobody reads the
// result while the window is hidden or minimised, so the pass then runs every
// 30 s instead of every 4 s; showing the window refreshes right away.
const REFRESH_MS = 4000;
const REFRESH_HIDDEN_MS = 30000;
let lastRefreshAt = 0;

function refreshAll(force = false) {
  // Restoring a minimised window emits `restore` and `show`, and app:focus
  // calls restore() and show() itself - one pass covers all of that.
  const now = Date.now();
  if (now - lastRefreshAt < 500) return;
  lastRefreshAt = now;
  for (const s of sessions.values()) refreshSession(s, force);
}

setInterval(() => {
  // A minimised window still counts as visible on some platforms, so it is
  // asked separately.
  const visible = Boolean(win) && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (Date.now() - lastRefreshAt < (visible ? REFRESH_MS : REFRESH_HIDDEN_MS)) return;
  refreshAll();
}, REFRESH_MS);

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------
const MAX_PREVIEW = 512 * 1024;

/** Is `p` `root` itself or below it? Both have to be resolved already. */
function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Opening without following a link: not available on Windows, where the lstat
// below stays the only check.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// Git reads `:/`, `:(exclude)x` and `:!x` as pathspec magic, and a repository
// may contain a file with such a name. Both diff calls treat the path as the
// literal name it is.
const GIT_LITERAL = '--literal-pathspecs';

// The path comes from the renderer and is foreign input. Anything that is not
// a relative path below the session root is rejected here, before a git command
// or a read sees it. `base` has to be resolved already.
function resolveInRoot(base, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return null;
  if (path.isAbsolute(relPath)) return null;
  const abs = path.resolve(base, relPath);
  return isInside(base, abs) ? abs : null;
}

// Reading for the preview: a symlink is not followed, neither the file itself
// nor a directory on the way to it. A cloned repository can contain a link to
// any file the user can read, and for untracked files the preview reads from
// the file system directly.
//
// The read goes through one file handle opened with O_NOFOLLOW, so the file
// that was checked is the file that is read. It takes at most MAX_PREVIEW + 1
// bytes, which bounds the memory a huge file can claim and decides the
// truncation from what was actually read rather than from an earlier stat.
async function readForPreview(base, abs, relPath) {
  let fh = null;
  try {
    const stat = await fs.promises.lstat(abs);
    if (stat.isSymbolicLink()) return { kind: 'error', path: relPath, text: t('file.symlink') };
    if (stat.isDirectory()) return { kind: 'error', path: relPath, text: t('file.isDir') };
    const [realRoot, real] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(abs)]);
    if (!isInside(realRoot, real)) return { kind: 'error', path: relPath, text: t('file.outsideRoot') };

    fh = await fs.promises.open(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
    const buf = Buffer.alloc(MAX_PREVIEW + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (!bytesRead) break;   // end of file
      got += bytesRead;
    }
    if (got > MAX_PREVIEW) {
      return { kind: 'content', path: relPath, text: buf.subarray(0, MAX_PREVIEW).toString('utf8') + '\n\n' + t('file.truncated') };
    }
    return { kind: 'content', path: relPath, text: buf.subarray(0, got).toString('utf8') };
  } catch (e) {
    return { kind: 'error', path: relPath, text: t('file.readError', { message: e.message }) };
  } finally {
    if (fh) await fh.close().catch(() => { /* nothing left to do about it */ });
  }
}

async function previewFile(session, relPath, source, opts = {}) {
  const base = path.resolve(session.gitRoot || session.cwd);
  const abs = resolveInRoot(base, relPath);
  if (!abs) {
    const shown = typeof relPath === 'string' ? relPath : '';
    return { kind: 'error', path: shown, text: t('file.outsideRoot') };
  }

  // The preview can request the file content instead of the diff - for the
  // rendered markdown view, which could show nothing based on the diff.
  if (opts.content) return readForPreview(base, abs, relPath);

  if (source === 'pr' && session.pr && session.pr.baseRefName) {
    const diff = await run('git', [GIT_LITERAL, 'diff', '--no-color', `origin/${session.pr.baseRefName}...HEAD`, '--', relPath], base);
    if (diff && diff.trim()) return { kind: 'diff', path: relPath, text: diff.slice(0, MAX_PREVIEW) };
  }

  const entry = session.files.find((f) => f.path === relPath);
  if (!entry || !entry.untracked) {
    const diff = await run('git', [GIT_LITERAL, 'diff', '--no-color', 'HEAD', '--', relPath], base);
    if (diff && diff.trim()) return { kind: 'diff', path: relPath, text: diff.slice(0, MAX_PREVIEW) };
  }

  return readForPreview(base, abs, relPath);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('shells:list', () => availableShells.map((s) => ({ id: s.id, name: shellName(s) })));
ipcMain.handle('session:create', (e, shellId, opts) => createSession(shellId, opts || {}));

// The grid thumbnail keeps 50 lines of scrollback - the last 20 KB fill them,
// the remaining 236 KB of the ring buffer would only be parsed and thrown away.
//
// Whole chunks only: cutting to exactly 20 KB would leave a lone surrogate half
// or the middle of an escape sequence at the head, and xterm would then print
// the tail of a window title as text or swallow output up to the next
// terminator. The loop stops after the first chunk that reaches the limit, so
// the result is 20 KB plus at most one chunk.
ipcMain.handle('session:buffer', (e, id) => {
  const s = sessions.get(id);
  if (!s) return '';
  const parts = [];
  let size = 0;
  for (let i = s.outputBuffer.length - 1; i >= 0 && size < GRID_PREVIEW_CHARS; i--) {
    parts.push(s.outputBuffer[i]);
    size += s.outputBuffer[i].length;
  }
  return parts.reverse().join('');
});

// Flow control: the renderer reports the batch it has written to xterm. A
// negative count would inflate `unacked` instead of reducing it and leave the
// session paused for good, so the count has to be a non-negative integer.
ipcMain.on('session:ack', (e, id, chars) => {
  const s = sessions.get(id);
  if (s && !s.exited && Number.isInteger(chars) && chars >= 0) ackOutput(s, chars);
});

ipcMain.handle('claude:sessions', () => listClaudeSessions());

ipcMain.handle('usage:get', (e, force) => getUsage(Boolean(force)));

// DB schema: the sensor looks for the responsible plugin and compares against
// the requested baseline. The repo root is the right root - if the agent works
// in a worktree, gitRoot already points there.
ipcMain.handle('dbschema:get', async (e, id, opts = {}) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: 'no-session' };
  const root = s.gitRoot || s.agentCwd || s.cwd;
  try {
    return await getSchemaView(root, {
      pr: s.pr,
      baseline: opts.baseline || 'auto',
      force: Boolean(opts.force),
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }
});


// The preload asks for this synchronously while the page is still loading -
// the renderer must not paint a single English label before switching.
ipcMain.on('i18n:init', (e) => {
  e.returnValue = { locale: i18n.getLocale(), locales: i18n.available(), dict: i18n.dict() };
});

ipcMain.handle('i18n:set', (e, code) => {
  const locale = i18n.setLocale(code);
  settings.set('locale', locale);
  // Schemas and baselines carry strings that were translated when they were
  // built - they have to be read again, not served from the cache.
  clearSchemaCache();
  // Sessions carry a shell name; force a refresh so the tabs follow along.
  for (const s of sessions.values()) refreshSession(s, true);
  return { locale, dict: i18n.dict() };
});

ipcMain.on('app:focus', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// Clipboard via the main process: in the renderer `navigator.clipboard.readText()`
// needs the `clipboard-read` permission, which Electron denies without a custom
// permission handler - pasting failed silently.
ipcMain.on('clipboard:write', (e, text) => {
  if (typeof text === 'string' && text) clipboard.writeText(text);
});

ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.on('session:input', (e, id, data) => {
  const s = sessions.get(id);
  if (s && !s.exited) {
    s.lastInputAt = Date.now();
    feedInputRecon(s, data);
    // Fallback without shell integration: Enter = command started
    if (!s.hasOsc133 && data.includes('\r')) setState(s, 'busy');
    s.proc.write(data);
  }
});

ipcMain.on('session:resize', (e, id, cols, rows) => {
  const s = sessions.get(id);
  if (s && !s.exited && cols > 0 && rows > 0) {
    try { s.proc.resize(cols, rows); } catch { /* race while shutting down */ }
  }
});

ipcMain.handle('session:close', (e, id) => {
  const s = sessions.get(id);
  if (s) {
    // A refresh may be in flight; without this it would run to the end and send
    // session:info for a session that no longer exists.
    s.exited = true;
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
    try { s.proc.kill(); } catch { /* already terminated */ }
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

ipcMain.handle('file:preview', (e, id, relPath, source, opts) => {
  const s = sessions.get(id);
  if (!s) return { kind: 'error', path: relPath, text: t('file.noSession') };
  return previewFile(s, relPath, source, opts || {});
});

// Only http(s) goes to the system browser; file:// and everything else stays put.
function isExternalUrl(url) { return /^https?:\/\//.test(url); }

ipcMain.on('open-external', (e, url) => {
  if (isExternalUrl(url)) electronShell.openExternal(url);
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
  catch { /* disk full or similar - the notes stay in memory */ }
  if (win && !win.isDestroyed()) win.webContents.send('todos:changed', key, todos);
  return true;
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#101116',
    title: 'Flightdeck',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);

  // Coming back from hidden or minimised, the data is up to 30 s old - the
  // window gets a fresh pass instead of showing that.
  win.on('show', () => refreshAll(true));
  win.on('restore', () => refreshAll(true));

  // The preload script runs again on every navigation of this webContents, so a
  // foreign page loaded here would own the full window.api bridge. The interface
  // never navigates - the document below is loaded once via loadFile, which these
  // events do not cover - so every navigation that does occur is cancelled. A
  // dropped file is the most common trigger.
  const blockNavigation = (e) => e.preventDefault();
  win.webContents.on('will-navigate', blockNavigation);
  win.webContents.on('will-frame-navigate', blockNavigation);

  // A reload (Ctrl+R still reaches the window; setMenuBarVisibility only hides
  // the bar) leaves the batches in flight unacknowledged. The new document
  // starts with an empty backlog, so the flow control does too.
  win.webContents.on('did-finish-load', resetFlowControl);

  // No new windows either; http(s) links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) electronShell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(INDEX_HTML);
}

// A stored choice wins; otherwise follow the system. Unknown system languages
// fall back to English inside normalize().
app.whenReady().then(() => {
  i18n.setLocale(settings.get('locale') || app.getLocale());
  createWindow();
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.proc.kill(); } catch { /* never mind */ } }
  stopWatchingProjects();
  // The integration directory stays: it is shared with any second instance,
  // whose sessions would otherwise start without the hooks.
  app.quit();
});
