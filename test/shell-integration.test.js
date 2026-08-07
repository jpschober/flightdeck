'use strict';
// The shell integration from src/main/shell-integration/: it has to add its
// hooks to what the user's configuration already installed instead of assigning
// over it.
//
// The scripts are files, and they are read here through readScript() - the same
// function the app uses, so the `# flightdeck:include` line is resolved the way
// a session gets it. What the assertions and the real bash below see is the text
// that is written into the integration directory, not a copy of it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { execFileSync } = require('child_process');

// The module under test requires electron for `app.getPath('userData')`, which
// readScript() does not touch. From Electron 42 on, `require('electron')`
// outside Electron fetches the ~100 MB binary if it is not there yet, so the
// require is intercepted here - the same route test/log.test.js takes.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: null };
  return origLoad.call(this, request, ...rest);
};

const { readScript } = require('../src/main/shell-integration');
Module._load = origLoad;

const MAIN = path.join(__dirname, '..', 'src', 'main');

const BASH_RC = readScript('bashrc.sh');
const PS_INIT = readScript('init.ps1');
const ZSH_RC = readScript('zshrc.zsh');

// The wrapper is a file of its own, and both rc scripts name it in an include
// line. Reading a script that still carries the line would test nothing.
test('the claude wrapper is included, not left as a marker', () => {
  for (const [name, text] of [['bashrc.sh', BASH_RC], ['zshrc.zsh', ZSH_RC]]) {
    assert.ok(!/# flightdeck:include/.test(text), `${name} still carries the include line`);
    assert.ok(text.includes('__flightdeck_uuid()'), `${name} did not get the claude wrapper`);
  }
});

// ---------------------------------------------------------------------------
// The texts themselves
// ---------------------------------------------------------------------------
test('bash does not assign PROMPT_COMMAND or the DEBUG trap', () => {
  assert.ok(!/PROMPT_COMMAND=__flightdeck_prompt\s*$/m.test(BASH_RC),
    'PROMPT_COMMAND is assigned, which drops starship, direnv and the title hook');
  assert.ok(!/^trap __flightdeck_preexec DEBUG\s*$/m.test(BASH_RC),
    'the DEBUG trap is assigned, which drops bash-preexec and starship');
  assert.ok(BASH_RC.includes('PROMPT_COMMAND=(__flightdeck_prompt "${PROMPT_COMMAND[@]}"'),
    'the array form of PROMPT_COMMAND (bash 5.1) is not preserved');
});

test('zsh keeps using add-zsh-hook', () => {
  assert.ok(ZSH_RC.includes('add-zsh-hook precmd __flightdeck_prompt'));
  assert.ok(ZSH_RC.includes('add-zsh-hook preexec __flightdeck_preexec'));
});

test('powershell calls the prompt and the read line it found', () => {
  assert.ok(PS_INIT.includes('Get-Command prompt -CommandType Function'),
    'the existing prompt is not looked up');
  assert.ok(PS_INIT.includes('if ($Global:__flightdeckPrevPrompt) { & $Global:__flightdeckPrevPrompt }'),
    'the existing prompt is not called');
  assert.ok(PS_INIT.includes('Get-Command PSConsoleHostReadLine -CommandType Function'),
    'the existing PSConsoleHostReadLine is not looked up');
  assert.ok(PS_INIT.includes('if ($Global:__flightdeckPrevReadLine) { $l = & $Global:__flightdeckPrevReadLine }'),
    'the existing PSConsoleHostReadLine is not called');
  // Without the guard a second run would chain our own function onto itself.
  // The file carries a comment header, so the guard is the first line that runs
  // rather than the first line of the text - and it has to wrap all of it.
  const code = PS_INIT.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.strictEqual(code[0], 'if (-not (Test-Path Variable:Global:__flightdeckInstalled)) {',
    'the installation guard is missing, or something runs ahead of it');
  assert.strictEqual(code[code.length - 1], '}',
    'the guard no longer closes at the end - part of the script runs unguarded');
});

// ---------------------------------------------------------------------------
// The bash part in a real bash
// ---------------------------------------------------------------------------
const BASH = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find((p) => {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-shell-'));
const rc = path.join(tmp, 'bashrc.sh');
fs.writeFileSync(rc, BASH_RC);

// The user's configuration: a prompt hook, a preexec hook whose handler carries
// single quotes (that is how `trap -p` has to quote it), and a marker for the
// order the hooks run in.
const USER_RC = `PS1='> '
__user_precmd() { printf '[precmd:%s]' "$?"; }
__user_preexec() { printf '[preexec:%s]' "$BASH_COMMAND"; }
PROMPT_COMMAND='__user_precmd'
trap '__user_preexec '"'"'x'"'"'' DEBUG
`;

// TERM=dumb keeps the system-wide /etc/bash.bashrc from adding its own
// window-title entry to PROMPT_COMMAND, so what the assertions see is the
// user's configuration plus ours.
function runBash(args, input, userRc) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.writeFileSync(path.join(home, '.bashrc'), userRc || USER_RC);
  return execFileSync(BASH, ['--rcfile', rc, '-i', ...args], {
    input: input || '',
    env: { PATH: process.env.PATH, HOME: home, TERM: 'dumb' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const cmdOsc = (s) => `\x1b]7770;cmd;${Buffer.from(s).toString('base64')}\x07`;

test('bash keeps the user\'s PROMPT_COMMAND and their DEBUG trap', { skip: !BASH }, () => {
  const out = runBash(['-c', 'declare -p PROMPT_COMMAND; trap -p DEBUG']);

  // declare -p quotes the newlines it holds: PROMPT_COMMAND=$'a\nb\nc'
  assert.match(out, /PROMPT_COMMAND=\$'__flightdeck_prompt\\n__user_precmd\\n__flightdeck_arm'/);
  // The handler is chained in front of ours, with its quoting intact.
  assert.match(out, /trap -- '__user_preexec '\\''x'\\''\n__flightdeck_preexec' DEBUG/);
});

test('bash extends an array PROMPT_COMMAND instead of flattening it', { skip: !BASH }, () => {
  // Since bash 5.1 PROMPT_COMMAND may be an array; a string assignment would
  // leave nothing but its first element.
  const out = runBash(['-c', 'declare -p PROMPT_COMMAND'], '');
  const version = Number(execFileSync(BASH, ['-c', 'echo "${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim());
  if (version < 51) return;

  const home = fs.mkdtempSync(path.join(tmp, 'home-array-'));
  fs.writeFileSync(path.join(home, '.bashrc'), USER_RC + 'PROMPT_COMMAND=(__user_precmd __user_second)\n');
  const arr = execFileSync(BASH, ['--rcfile', rc, '-i', '-c', 'declare -p PROMPT_COMMAND'], {
    env: { PATH: process.env.PATH, HOME: home, TERM: 'dumb' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.match(arr, /declare -a PROMPT_COMMAND=/);
  assert.match(arr, /\[0\]="__flightdeck_prompt" \[1\]="__user_precmd" \[2\]="__user_second" \[3\]="__flightdeck_arm"/);
  assert.ok(out.includes('__user_precmd'), 'the scalar case lost the user entry');
});

test('at the prompt both hooks run, and only the typed command is reported',
  { skip: !BASH }, () => {
    // `exit 0`, because the exit status of the shell is that of `false` otherwise
    const out = runBash([], 'false\nexit 0\n');

    // The command line as OSC 7770 (base64 "false") plus 133;C for "started"
    assert.ok(out.includes('\x1b]7770;cmd;ZmFsc2U=\x07\x1b]133;C\x07'),
      'the typed command was not reported');
    // The entries of PROMPT_COMMAND are not commands you typed
    assert.ok(!out.includes('X191c2VyX3ByZWNtZA=='), '__user_precmd was reported as a command');
    // The user's preexec ran for the same command
    assert.ok(out.includes('[preexec:false]'), 'the user\'s DEBUG handler did not run');
    // Their precmd ran too, and saw the exit status of `false`
    assert.ok(out.includes('[precmd:1]'),
      'the user\'s prompt hook did not run, or $? no longer reaches it');
    assert.ok(out.includes('\x1b]133;D\x07\x1b]133;A\x07'), 'the prompt was not reported');
  });

test('an exported PROMPT_COMMAND keeps its value and loses the export',
  { skip: !BASH }, () => {
    // Exported, our function names would reach every child bash, where they do
    // not exist and each prompt answers with "command not found".
    const userRc = `PS1='> '\nexport PROMPT_COMMAND='__user_precmd'\n__user_precmd() { :; }\n`;
    const out = runBash(['-c', 'declare -p PROMPT_COMMAND; env | grep -c "^PROMPT_COMMAND=" || true'], '', userRc);
    assert.match(out, /declare -- PROMPT_COMMAND=/, 'the export attribute is still on it');
    assert.match(out, /__user_precmd/, 'the value was lost with the attribute');
    assert.match(out, /^0$/m, 'PROMPT_COMMAND is still in the environment of child processes');
  });

// A `return` in the trap string is the one handler form the chaining does not
// carry, and these two tests hold where the line runs. Inside a function the
// handler calls, `return` is harmless - that is the form bash-preexec and
// starship use, and the tests above cover it.
test('a return that only strikes later leaves the reporting alone', { skip: !BASH }, () => {
  // The condition is false while the file is sourced, true from the moment the
  // variable is set. At the prompt `return` is nothing but an error message,
  // and the rest of the trap string still runs.
  const userRc = `PS1='> '
trap '[ -n "$LATER" ] && return; :' DEBUG
`;
  const out = runBash([], 'echo one\nLATER=1\necho two\nexit 0\n', userRc);
  assert.ok(out.includes(cmdOsc('echo one')), 'the command before the return was not reported');
  assert.ok(out.includes(cmdOsc('echo two')), 'the command after the return was not reported');
});

test('a return in the trap string at startup leaves the session without hooks',
  { skip: !BASH }, () => {
    // Measured boundary, not a fixable case: the handler is already installed
    // while our file is being sourced, and a `return` there ends the sourcing.
    // Nothing of ours is installed then - not the reporting, not the directory,
    // not the claude wrapper. Whoever changes this file should know that this
    // is what it looks like.
    const userRc = `PS1='> '
trap 'return' DEBUG
`;
    const out = runBash([], 'echo one\nexit 0\n', userRc);
    assert.ok(!out.includes(cmdOsc('echo one')), 'the reporting is back - the boundary has moved');
    assert.ok(!out.includes('\x1b]133;'), 'a state marker arrived although the file was cut short');

    const defined = runBash(['-c', 'declare -F __flightdeck_preexec || echo none'], '', userRc);
    assert.match(defined, /none/, 'the file ran to the end after all - the comment above needs correcting');
  });

// ---------------------------------------------------------------------------
// Shells the integration does not reach
// ---------------------------------------------------------------------------
const stateSrc = fs.readFileSync(path.join(MAIN, 'session-state.js'), 'utf8');
const oscFrom = stateSrc.indexOf('const ATTENTION_QUIET_MS');
const oscTo = stateSrc.indexOf('// Agent binding: which Claude transcript belongs to this session?');
assert.ok(oscFrom > 0 && oscTo > oscFrom, 'the state block was not found in session-state.js');
const osc = require('../src/main/osc');
const stateCalls = [];
const oscSandbox = {
  console, Buffer, setTimeout, clearTimeout, Date,
  log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  OSC_ANY_RE: osc.OSC_ANY_RE,
  OSC_EVENT_RE: osc.OSC_EVENT_RE,
  TRANSCRIPT_ID_RE: require('../src/main/claude-sessions').TRANSCRIPT_ID_RE,
  isAgentCommand: () => false,
  send: (ch, id, v) => stateCalls.push(v),
  beginAgentBinding: () => {},
  bindAgentSession: () => {},
  bindContinuedSession: () => {},
  addHistory: () => {},
};
vm.createContext(oscSandbox);
vm.runInContext(
  `${stateSrc.slice(oscFrom, stateSrc.lastIndexOf('// ------', oscTo))}\nthis.applyStateFromData = applyStateFromData;`,
  oscSandbox);

function ptySession(integrated) {
  return {
    id: 'x', state: integrated ? 'idle' : 'unknown', integrated, exited: false,
    hasOsc133: false, hasClaudeOsc: false, cmdWatched: false, currentCmd: null,
    agentPrompted: false, altScreen: false, pendingCommand: null,
    idleTimer: null, attnTimer: null, lastInputAt: 0, proc: { write: () => {} },
  };
}

function feed(s, text) {
  oscSandbox.applyStateFromData(s, text, 0, text);
  clearTimeout(s.idleTimer);
}

test('a shell without integration is not talked into a state by its output', () => {
  stateCalls.length = 0;
  const s = ptySession(false);
  feed(s, 'compiling, this takes a while\n');
  assert.strictEqual(s.state, 'unknown');
  assert.deepStrictEqual(stateCalls, [], 'a state was sent although none is known');
});

test('with integration, output before the first marker counts as busy', () => {
  stateCalls.length = 0;
  const s = ptySession(true);
  feed(s, 'compiling, this takes a while\n');
  assert.strictEqual(s.state, 'busy');
  assert.deepStrictEqual(stateCalls, ['busy']);
});

test('OSC 133 out of the user\'s own configuration counts in either case', () => {
  stateCalls.length = 0;
  const s = ptySession(false);
  feed(s, '\x1b]133;C\x07');
  assert.strictEqual(s.state, 'busy');
  assert.strictEqual(s.hasOsc133, true);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
