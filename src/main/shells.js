'use strict';
// Which shells this machine offers, and how each of them is started with the
// Flightdeck integration in place.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const { getRcDir, getRc, psEncodedCommand } = require('./shell-integration');
const log = require('./log');

// ---------------------------------------------------------------------------
// Shell detection
// ---------------------------------------------------------------------------
function firstExisting(paths) {
  return paths.find((p) => {
    try { return fs.existsSync(p); } catch (e) { log.debug('shells: candidate not checkable', { path: p, err: e }); return false; }
  });
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
    } catch (e) { log.debug('shells: no /etc/shells (e.g. a minimal container)', { err: e }); }
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
// Starting a shell with the integration scripts in place
// ---------------------------------------------------------------------------
// `integrated` says whether the shell reports its state itself (OSC 133). The
// others - cmd, WSL, nu, elvish, xonsh, ksh, tcsh, dash - are started as they
// are, and their sessions show no state at all instead of a guessed one.
function spawnArgsFor(shell) {
  switch (shell.id) {
    case 'powershell':
    case 'pwsh':
      return { file: shell.file, args: ['-NoLogo', '-NoExit', '-EncodedCommand', psEncodedCommand()], env: {}, integrated: true };
    case 'gitbash':
    case 'bash':
      return { file: shell.file, args: ['--rcfile', getRc('bashrc.sh', 'bashrc.sh'), '-i'], env: {}, integrated: true };
    case 'fish': {
      // -C takes a string that fish parses, and the userData path contains a
      // space on macOS, so the path is quoted. Inside single quotes fish treats
      // only \' and \\ as escapes.
      const rc = getRc('init.fish', 'init.fish').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return {
        file: shell.file,
        args: ['-C', "source '" + rc + "'", '-i'],
        env: {},
        integrated: true,
      };
    }
    case 'zsh': {
      getRc('.zshenv', 'zshenv.zsh');
      getRc('.zshrc', 'zshrc.zsh');
      return {
        file: shell.file,
        args: ['-i'],
        env: {
          ZDOTDIR: getRcDir(),
          FLIGHTDECK_ZDOTDIR: process.env.ZDOTDIR || os.homedir(),
        },
        integrated: true,
      };
    }
    default:
      return { file: shell.file, args: ['-i'], env: {}, integrated: false };
  }
}

module.exports = { availableShells, shellName, spawnArgsFor };
