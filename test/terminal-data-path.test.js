'use strict';
// Batching, flow control and the grid preview tail from src/main/main.js.
//
// main.js requires Electron, so the functions under test are pulled out of the
// source and run against stub sessions. They are pure given a session object:
// they touch `win`, the PTY handle and the state parser only through names the
// sandbox provides.
//
// The tests share `sent`, `ptyLog` and the sandbox's session map and run in the
// order they stand here.

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

// ---------------------------------------------------------------------------
// Load the block from `const FLUSH_MS` up to createSession() into a sandbox
// ---------------------------------------------------------------------------
const from = src.indexOf('const FLUSH_MS = 16;');
const to = src.indexOf('function createSession(shellId, opts = {}) {');
assert.ok(from > 0 && to > from, 'the batching block was not found in main.js');
const block = src.slice(from, to);
for (const fn of ['queueOutput', 'flushOutput', 'ackOutput', 'resetFlowControl']) {
  assert.ok(block.includes(`function ${fn}(`), `${fn} is not in the extracted block`);
}

const sent = [];
const ptyLog = [];
// Both extracted blocks log in their catch blocks - flow control here, the OSC
// dispatch below. Without this a test that reaches one of them would fail with
// a ReferenceError instead of its assertion; what the logger does with a line
// is test/log.test.js's business.
const logged = [];
const rec = (level) => (message, data) => logged.push({ level, message, data });
const log = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };

const sandbox = {
  setTimeout, clearTimeout, console, log,
  sessions: new Map(),
  win: { isDestroyed: () => false, webContents: { send: (ch, id, data) => sent.push({ ch, id, data }) } },
  extractCwd: () => null,
  applyStateFromData: () => {},
  refreshSession: (s) => refreshed.push(s.id),
  // The reported directory is checked before it is taken over. The check runs
  // through fs.promises, and the answers are handed out by the tests below.
  fs: { promises: { stat: (p) => statFor(p) } },
};
const refreshed = [];
let statPlan = new Map(); // path -> 'dir' | 'file' | 'error' | a promise to resolve by hand
function statFor(p) {
  const answer = statPlan.get(p);
  if (answer && typeof answer.then === 'function') return answer;
  if (answer === 'dir') return Promise.resolve({ isDirectory: () => true });
  if (answer === 'file') return Promise.resolve({ isDirectory: () => false });
  return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}
vm.createContext(sandbox);
vm.runInContext(`${block}
this.api = { queueOutput, flushOutput, ackOutput, resetFlowControl };
this.LIMITS = { FLUSH_MS, FLUSH_CHARS, FLOW_HIGH_WATER_CHARS, FLOW_LOW_WATER_CHARS, GRID_BUFFER_CHARS, GRID_PREVIEW_CHARS };`, sandbox);
const { queueOutput, flushOutput, ackOutput, resetFlowControl } = sandbox.api;
const L = sandbox.LIMITS;

// The session:buffer handler is an IPC callback; its body is lifted from the
// source so the test cannot drift from it silently.
const bufFrom = src.indexOf("ipcMain.handle('session:buffer'");
const bufTo = src.indexOf('});', bufFrom);
assert.ok(bufFrom > 0 && bufTo > bufFrom, 'the session:buffer handler was not found');
const bufBody = src.slice(src.indexOf('{', src.indexOf('=>', bufFrom)) + 1, bufTo);
assert.ok(!bufBody.includes('slice(-GRID_PREVIEW_CHARS)'),
  'the handler cuts to an exact length again - that can split a surrogate pair or an escape sequence');
const previewTail = vm.runInContext(
  `(function (session) {
     const sessions = new Map([[session.id, session]]);
     const id = session.id;
     ${bufBody}
   })`, sandbox);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let nextId = 1;
function mkSession() {
  const s = {
    id: String(nextId++), oscTail: '', cwd: '/x', altScreen: false, exited: false,
    outputBuffer: [], outputBufferSize: 0,
    pending: [], pendingSize: 0, flushTimer: null, unacked: 0, flowPaused: false,
    proc: { pause: () => ptyLog.push('pause'), resume: () => ptyLog.push('resume') },
  };
  sandbox.sessions.set(s.id, s);
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------
test('1000 single-character chunks become one send', async () => {
  sent.length = 0;
  const s = mkSession();
  for (let i = 0; i < 1000; i++) queueOutput(s, 'x');
  assert.strictEqual(sent.length, 0, 'nothing goes out before the timer fires');
  await sleep(4 * L.FLUSH_MS);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.length, 1000);
  assert.strictEqual(s.pendingSize, 0);
  assert.strictEqual(s.flushTimer, null);
});

test('the character threshold flushes without waiting for a tick', () => {
  sent.length = 0;
  const s = mkSession();
  for (let i = 0; i < 8; i++) queueOutput(s, 'y'.repeat(L.FLUSH_CHARS / 8));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.length, L.FLUSH_CHARS);
});

test('a chunk larger than the threshold goes out whole', () => {
  sent.length = 0;
  const s = mkSession();
  const huge = 'h'.repeat(L.FLUSH_CHARS * 3);
  queueOutput(s, huge);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data, huge);
});

test('the byte stream survives mixed timer and threshold flushes', async () => {
  sent.length = 0;
  const s = mkSession();
  let expected = '';
  for (let i = 0; i < 500; i++) {
    const d = 'a'.repeat(1 + (i % 997));
    expected += d;
    queueOutput(s, d);
    if (i % 137 === 0) await sleep(2 * L.FLUSH_MS);
  }
  await sleep(4 * L.FLUSH_MS);
  assert.strictEqual(sent.map((x) => x.data).join(''), expected);
});

test('flushing an empty queue does nothing', () => {
  sent.length = 0;
  const s = mkSession();
  flushOutput(s);
  flushOutput(s);
  assert.strictEqual(sent.length, 0);
});

test('a destroyed window means no send and no backlog', () => {
  const live = sandbox.win;
  sandbox.win = { isDestroyed: () => true, webContents: { send: () => { throw new Error('must not send'); } } };
  try {
    const s = mkSession();
    queueOutput(s, 'hello');
    flushOutput(s);
    assert.strictEqual(s.unacked, 0);
    assert.strictEqual(s.outputBuffer.join(''), 'hello');
  } finally {
    sandbox.win = live;
  }
});

// ---------------------------------------------------------------------------
// Alternate screen: the last switch in the batch decides
// ---------------------------------------------------------------------------
test('alternate screen follows the order inside the batch', () => {
  const cases = [
    { chunks: ['\x1b[?1049h'], expect: true },
    { chunks: ['\x1b[?1049l'], expect: false },
    // Both in one batch: leaving a pager and entering the next one.
    { chunks: ['\x1b[?1049l' + 'bye', 'hi' + '\x1b[?1049h'], expect: true },
    { chunks: ['\x1b[?1049h' + 'hi', 'bye' + '\x1b[?1049l'], expect: false },
    // Repeated switches in one batch.
    { chunks: ['\x1b[?1049h', '\x1b[?1049l', '\x1b[?1049h'], expect: true },
    { chunks: ['\x1b[?47h', '\x1b[?47l'], expect: false },
    { chunks: ['\x1b[?47l', '\x1b[?1049h'], expect: true },
  ];
  for (const c of cases) {
    const s = mkSession();
    s.altScreen = false;
    for (const chunk of c.chunks) queueOutput(s, chunk);
    flushOutput(s);
    assert.strictEqual(s.altScreen, c.expect,
      `${JSON.stringify(c.chunks)} should end at altScreen=${c.expect}`);
  }
  // No switch in the batch leaves the flag untouched.
  const s = mkSession();
  s.altScreen = true;
  queueOutput(s, 'plain output\x1b[?25l');
  flushOutput(s);
  assert.strictEqual(s.altScreen, true);
});

// ---------------------------------------------------------------------------
// Flow control
// ---------------------------------------------------------------------------
test('the PTY pauses above the high-water mark and resumes at the low one', () => {
  sent.length = 0; ptyLog.length = 0;
  const s = mkSession();
  const big = 'z'.repeat(L.FLUSH_CHARS);
  const batches = Math.ceil(L.FLOW_HIGH_WATER_CHARS / L.FLUSH_CHARS) + 1;
  for (let i = 0; i < batches; i++) queueOutput(s, big);
  assert.strictEqual(s.unacked, batches * L.FLUSH_CHARS);
  assert.deepStrictEqual(ptyLog, ['pause']);
  assert.strictEqual(s.flowPaused, true);

  ackOutput(s, s.unacked - L.FLOW_LOW_WATER_CHARS - 1);
  assert.deepStrictEqual(ptyLog, ['pause'], 'no resume while the backlog is above the low-water mark');
  ackOutput(s, 1);
  assert.deepStrictEqual(ptyLog, ['pause', 'resume']);
  assert.strictEqual(s.flowPaused, false);
});

test('an unacknowledged producer pauses once, not repeatedly', () => {
  ptyLog.length = 0;
  const s = mkSession();
  for (let i = 0; i < 200; i++) queueOutput(s, 'q'.repeat(L.FLUSH_CHARS));
  assert.strictEqual(ptyLog.filter((x) => x === 'pause').length, 1);
});

test('an oversized acknowledgement does not drive the backlog negative', () => {
  const s = mkSession();
  s.unacked = 100;
  ackOutput(s, 10 ** 9);
  assert.strictEqual(s.unacked, 0);
});

test('the ack guard rejects everything that is not a non-negative integer', () => {
  // The guard as it stands in main.js, checked against the values that would
  // inflate `unacked` and pause the session for good.
  const guard = src.match(/ipcMain\.on\('session:ack'[\s\S]*?\n\}\);/);
  assert.ok(guard, "the session:ack handler was not found");
  const check = vm.runInContext(
    `(function (chars) { return ${guard[0].match(/if \(s && !s\.exited && ([^)]*\)?[^)]*)\) /)[1]}; })`,
    Object.assign(vm.createContext({}), {}));
  for (const bad of [-1, -1e9, NaN, Infinity, -Infinity, 1.5, '100', null, undefined, {}]) {
    assert.strictEqual(check(bad), false, `${String(bad)} must be rejected`);
  }
  for (const good of [0, 1, 65536, Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual(check(good), true, `${good} must be accepted`);
  }
});

test('a renderer reload clears the backlog and releases a paused session', () => {
  ptyLog.length = 0;
  sandbox.sessions.clear();
  const paused = mkSession();
  paused.unacked = 10 * L.FLOW_HIGH_WATER_CHARS;
  paused.flowPaused = true;
  const running = mkSession();
  running.unacked = 1234;

  resetFlowControl();
  assert.strictEqual(paused.unacked, 0);
  assert.strictEqual(paused.flowPaused, false);
  assert.strictEqual(running.unacked, 0);
  assert.deepStrictEqual(ptyLog, ['resume'], 'only the paused session is resumed');
});

// ---------------------------------------------------------------------------
// Grid preview tail
// ---------------------------------------------------------------------------
test('session:buffer returns the tail in order and at most one chunk over', () => {
  const s = mkSession();
  let all = '';
  for (let i = 0; i < 400; i++) {
    const d = String(i % 10).repeat(1000);
    all += d;
    s.outputBuffer.push(d);
    s.outputBufferSize += d.length;
  }
  const tail = previewTail(s);
  assert.ok(tail.length >= L.GRID_PREVIEW_CHARS);
  assert.ok(tail.length < L.GRID_PREVIEW_CHARS + 1000, 'at most one chunk over the limit');
  assert.strictEqual(all.slice(-tail.length), tail, 'the tail is the end of the stream, in order');
});

test('session:buffer keeps surrogate pairs and escape sequences whole', () => {
  const s = mkSession();
  // A chunk boundary that an exact cut would land inside of.
  const emoji = '🚀';
  const pad = 'p'.repeat(L.GRID_PREVIEW_CHARS);
  s.outputBuffer.push(emoji + '\x1b]0;window title\x07' + pad);
  s.outputBufferSize = s.outputBuffer[0].length;
  const tail = previewTail(s);
  assert.strictEqual(tail, s.outputBuffer[0], 'a single chunk comes back whole');
  for (const ch of tail) assert.ok(ch.codePointAt(0) !== 0xdffe, 'no lone surrogate');
  assert.ok(!/^[\udc00-\udfff]/.test(tail), 'the tail does not start with a low surrogate');
  assert.ok(!/^[^\x1b]*\x07/.test(tail.slice(1)) || tail.includes('\x1b]0;'),
    'an OSC in the tail still has its introducer');
});

test('session:buffer handles short and empty buffers', () => {
  const s = mkSession();
  s.outputBuffer.push('short');
  assert.strictEqual(previewTail(s), 'short');
  assert.strictEqual(previewTail(mkSession()), '');
});

test('the ring buffer stays under its limit', () => {
  const s = mkSession();
  for (let i = 0; i < 200; i++) queueOutput(s, 'r'.repeat(L.FLUSH_CHARS));
  assert.ok(s.outputBufferSize <= L.GRID_BUFFER_CHARS + L.FLUSH_CHARS,
    `ring buffer grew to ${s.outputBufferSize}`);
});

// ---------------------------------------------------------------------------
// The reported working directory
//
// It comes out of the terminal output, so it is taken over only once it turns
// out to be a directory - and the question is asked asynchronously: flushOutput
// is the PTY data path, and a stat on a hung mount would stop the output of
// every session.
// ---------------------------------------------------------------------------
function reportCwd(s, dir) {
  sandbox.extractCwd = () => dir;
  queueOutput(s, 'x');
  flushOutput(s);
  sandbox.extractCwd = () => null;
}
const settled = () => new Promise((r) => setTimeout(r, 0));

test('a reported directory is taken over once the answer is in, not before', async () => {
  refreshed.length = 0;
  statPlan = new Map([['/new', 'dir']]);
  const s = mkSession();
  reportCwd(s, '/new');
  assert.strictEqual(s.cwd, '/x', 'flushOutput waited for the answer');
  assert.deepStrictEqual(refreshed, []);
  await settled();
  assert.strictEqual(s.cwd, '/new');
  assert.deepStrictEqual(refreshed, [s.id]);
});

test('a path that is not a directory, and one that is not there, are not taken over', async () => {
  refreshed.length = 0;
  statPlan = new Map([['/afile', 'file']]);
  const s = mkSession();
  reportCwd(s, '/afile');
  reportCwd(s, '/gone');
  await settled();
  assert.strictEqual(s.cwd, '/x');
  assert.deepStrictEqual(refreshed, []);
});

test('while the answer is outstanding the output goes on', async () => {
  sent.length = 0;
  refreshed.length = 0;
  let release;
  statPlan = new Map([['/slow', new Promise((r) => { release = r; })]]);
  const s = mkSession();
  reportCwd(s, '/slow');
  // The mount is hanging; the session keeps writing and keeps its directory.
  queueOutput(s, 'still running');
  flushOutput(s);
  assert.strictEqual(s.cwd, '/x');
  assert.ok(sent.some((x) => x.data === 'still running'), 'the output stopped at the stat');
  release({ isDirectory: () => true });
  await settled();
  assert.strictEqual(s.cwd, '/slow', 'the answer arrived late and was still used');
});

test('a newer report wins over an answer that arrives late', async () => {
  refreshed.length = 0;
  let releaseSlow;
  statPlan = new Map([
    ['/slow', new Promise((r) => { releaseSlow = r; })],
    ['/fast', 'dir'],
  ]);
  const s = mkSession();
  reportCwd(s, '/slow');
  reportCwd(s, '/fast');
  await settled();
  assert.strictEqual(s.cwd, '/fast');
  releaseSlow({ isDirectory: () => true });
  await settled();
  assert.strictEqual(s.cwd, '/fast', 'the older answer overwrote the newer directory');
  assert.deepStrictEqual(refreshed, [s.id], 'the discarded answer triggered a refresh');
});

// ---------------------------------------------------------------------------
// OSC dispatch: applyStateFromData in a second sandbox
// ---------------------------------------------------------------------------
const oscFrom = src.indexOf('const OSC7_RE =');
const oscTo = src.indexOf('// Agent binding: which Claude transcript belongs to this session?');
assert.ok(oscFrom > 0 && oscTo > oscFrom, 'the OSC block was not found in main.js');
const oscBlock = src.slice(oscFrom, src.lastIndexOf('// ------', oscTo));
assert.ok(oscBlock.includes('const OSC_EVENT_RE = new RegExp('),
  'the OSC sequences are scanned per type again - the effects are then grouped by type instead of ordered by position');
assert.ok(!/while \(\(m = OSC(133|CMD|SESS|_TITLE|9)_RE\.exec/.test(oscBlock),
  'a per-type scan loop is back in applyStateFromData');

const calls = [];
const oscSandbox = {
  console, Buffer, setTimeout, clearTimeout, Date, log,
  // The dispatch checks the session ID against the form claude-sessions names
  // its transcripts by; main.js imports it from there.
  TRANSCRIPT_ID_RE: require('../src/main/claude-sessions').TRANSCRIPT_ID_RE,
  win: { isDestroyed: () => false, webContents: { send: (ch, id, v) => calls.push(`${ch}:${v}`) } },
  beginAgentBinding: (s, cmd) => calls.push('bind:' + cmd),
  bindAgentSession: (s, id) => calls.push('session:' + id),
  bindContinuedSession: () => calls.push('continue'),
  addHistory: (s, cmd) => calls.push('history:' + cmd),
};
vm.createContext(oscSandbox);
vm.runInContext(`${oscBlock}\nthis.applyStateFromData = applyStateFromData;`, oscSandbox);
const applyStateFromData = oscSandbox.applyStateFromData;

const osc = {
  cmd: (s) => `\x1b]7770;cmd;${Buffer.from(s).toString('base64')}\x07`,
  sess: (id) => `\x1b]7771;session;${id}\x07`,
  mark: (c) => `\x1b]133;${c}\x07`,
  title: (s) => `\x1b]0;${s}\x07`,
  nine: (s) => `\x1b]9;${s}\x07`,
};
function stateSession() {
  return {
    id: 'osc', state: 'idle', exited: false, hasOsc133: true, hasClaudeOsc: false,
    cmdWatched: false, currentCmd: null, agentPrompted: false, altScreen: false,
    pendingCommand: null, idleTimer: null, attnTimer: null, lastInputAt: 0,
    proc: { write: () => {} },
  };
}

test('a batch that ends one command and starts claude keeps the new one watched', () => {
  calls.length = 0;
  const s = stateSession();
  s.state = 'busy';
  s.currentCmd = 'npm test';
  // The exact sequence from the review: the previous command finishes, claude
  // starts, claude runs - all inside one 16 ms batch.
  const id = '11111111-2222-3333-4444-555555555555';
  const text = osc.mark('D') + 'npm test output\n' + osc.cmd('claude') + osc.sess(id) + osc.mark('C');
  applyStateFromData(s, text, 0, text);

  assert.strictEqual(s.currentCmd, 'claude', 'the D marker must not clear the command that comes after it');
  assert.strictEqual(s.cmdWatched, true, 'the freshly started agent stays watched');
  assert.strictEqual(s.state, 'busy');
  assert.deepStrictEqual(calls, ['session:state:idle', 'bind:claude', 'history:claude', `session:${id}`, 'session:state:busy']);
});

test('a batch ending in a prompt marker still clears the command', () => {
  calls.length = 0;
  const s = stateSession();
  const text = osc.cmd('claude') + osc.mark('C') + 'work\n' + osc.mark('D');
  applyStateFromData(s, text, 0, text);
  assert.strictEqual(s.currentCmd, null);
  assert.strictEqual(s.cmdWatched, false);
  assert.strictEqual(s.state, 'idle');
});

test('the session binding is applied after the command that resets it', () => {
  calls.length = 0;
  const s = stateSession();
  const text = osc.cmd('claude') + osc.sess('11111111-2222-3333-4444-555555555555');
  applyStateFromData(s, text, 0, text);
  assert.deepStrictEqual(calls, ['bind:claude', 'history:claude', 'session:11111111-2222-3333-4444-555555555555']);
});

// The sequence comes out of the data stream, so anything writing to the
// terminal can send one - and the ID becomes part of a file path.
test('only a session UUID binds a transcript', () => {
  for (const id of ['abc', '../../foo', '', '11111111-2222-3333-4444-55555555555', 'x'.repeat(36)]) {
    calls.length = 0;
    const s = stateSession();
    const text = osc.sess(id);
    applyStateFromData(s, text, 0, text);
    assert.deepStrictEqual(calls, [], `"${id}" must not bind a session`);
  }
});

test('the continue report is unaffected by the ID check', () => {
  calls.length = 0;
  const s = stateSession();
  const text = '\x1b]7771;continue;\x07';
  applyStateFromData(s, text, 0, text);
  assert.deepStrictEqual(calls, ['continue']);
});

test('every sequence type is still recognised, each exactly once', () => {
  calls.length = 0;
  const s = stateSession();
  s.cmdWatched = true;
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const text = osc.cmd('ls') + osc.sess(id) + osc.title('⠋ working') + osc.nine('4;3') + osc.mark('C');
  applyStateFromData(s, text, 0, text);
  // 'ls' is not a watched command, so no agent binding starts for it.
  assert.deepStrictEqual(calls, ['history:ls', `session:${id}`, 'session:state:busy']);
  assert.strictEqual(s.hasClaudeOsc, true, 'the spinner title and the progress report both arrived');
  assert.strictEqual(s.cmdWatched, false);
});

test('an OSC 9 notification reaches the renderer, a ConEmu cwd does not', () => {
  calls.length = 0;
  const s = stateSession();
  s.state = 'busy';
  s.agentPrompted = true;
  const text = osc.nine('9;C:\\Users\\x') + osc.nine('Claude needs your attention');
  applyStateFromData(s, text, 0, text);
  assert.deepStrictEqual(calls, ['session:state:attention', 'session:notify:Claude needs your attention']);
});

test('matches inside the already processed tail are skipped', () => {
  calls.length = 0;
  const s = stateSession();
  const tail = osc.cmd('old');
  const text = tail + osc.cmd('new');
  applyStateFromData(s, text, tail.length, text.slice(tail.length));
  assert.deepStrictEqual(calls, ['history:new'], 'the command from the tail is not processed a second time');
  assert.strictEqual(s.currentCmd, 'new');
});

test('the title asterisk raises attention only once the agent was prompted', () => {
  calls.length = 0;
  const s = stateSession();
  s.state = 'busy';
  applyStateFromData(s, osc.title('✳ waiting'), 0, osc.title('✳ waiting'));
  assert.deepStrictEqual(calls, [], 'no attention before the first prompt');
  s.agentPrompted = true;
  applyStateFromData(s, osc.title('✳ waiting'), 0, osc.title('✳ waiting'));
  assert.deepStrictEqual(calls, ['session:state:attention']);
});
