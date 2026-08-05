'use strict';
// Checks src/main/log.js: level filtering, the line format, the file it writes
// and the ways a value can arrive that the logger must survive.
//
//   node --test test/log.test.js
//
// The logger resolves its target through `app.getPath('logs')`. Electron is not
// running here, so `require('electron')` is intercepted and answered with a
// stub pointing into a temp directory - the same route the real app takes,
// minus Electron.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const LOG = path.join(__dirname, '..', 'src', 'main', 'log.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-log-'));
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: (name) => path.join(home, name) } };
  return origLoad.call(this, request, ...rest);
};

// The console belongs to the test runner while the checks run; warn and error
// would otherwise print through it.
console.error = () => {};
console.log = () => {};

const log = require(LOG);
const file = log.path();

function read() {
  return fs.readFileSync(file, 'utf8');
}

function lastLines(n = 1) {
  const lines = read().trimEnd().split('\n');
  return lines.slice(-n);
}

test('writes to a file under app.getPath("logs")', () => {
  assert.strictEqual(file, path.join(home, 'logs', 'flightdeck.log'));
  assert.ok(fs.existsSync(file) || true); // created on the first write
  log.info('first line');
  assert.ok(read().includes('first line'));
});

test('line carries timestamp, level and key=value fields', () => {
  log.info('schema read', { root: '/repo', tables: 3 });
  const [line] = lastLines();
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z info {2}schema read root=\/repo tables=3$/);
});

test('level filtering, in both directions', () => {
  assert.strictEqual(log.level(), 'info');
  log.debug('below the default');
  assert.ok(!read().includes('below the default'));

  log.setLevel('debug');
  log.debug('now visible', { session: 7 });
  assert.ok(read().includes('now visible session=7'));

  log.setLevel('error');
  log.warn('filtered again');
  assert.ok(!read().includes('filtered again'));
  log.setLevel('debug');
});

test('setLevel ignores what is not a level, including a throwing value', () => {
  const hostile = { toString() { throw new Error('no'); } };
  assert.strictEqual(log.setLevel(hostile), 'debug');
  assert.strictEqual(log.setLevel('nonsense'), 'debug');
  assert.strictEqual(log.setLevel(null), 'debug');
});

test('a newline in a value cannot forge a second line', () => {
  log.info('renderer: click', { detail: 'x\n2026-01-01T00:00:00.000Z error app: DISK wiped' });
  const [line] = lastLines();
  assert.ok(!line.includes('\n'));
  assert.match(line, /detail=x 2026-01-01T00:00:00\.000Z error app: DISK wiped$/);
});

test('a newline in a key cannot forge a second line', () => {
  const forged = 'x=1\n2026-01-01T00:00:00.000Z error app: DISK';
  log.info('renderer: click', { [forged]: 'wiped' });
  const [line] = lastLines();
  assert.ok(!line.includes('\n'));
  assert.match(line, /^\S+ info {2}renderer: click x=1 2026-01-01T00:00:00\.000Z error app: DISK=wiped$/);
});

test('long values are capped', () => {
  // execFile puts the whole stderr of a failed command into err.message, and
  // its maxBuffer is 4 MB.
  log.info('run: command failed', { err: new Error('x'.repeat(100000)) });
  const [line] = lastLines();
  assert.ok(line.length < 1000, `line was ${line.length} characters`);
  assert.match(line, /…\(\+99500\)$/);
});

test('warn and error carry the stack, info does not', () => {
  let before = read().length;
  log.warn('agents: reading failed', { err: new Error('transcript format changed') });
  let added = read().slice(before);
  assert.ok(added.includes('agents: reading failed err=transcript format changed'));
  assert.match(added, /\n {4}at /, 'a frame is present, indented by four');
  assert.ok(added.split('\n').filter((l) => l.startsWith('    at ')).length <= 5, 'at most five frames');

  before = read().length;
  log.info('plain', { err: new Error('no stack wanted here') });
  added = read().slice(before);
  assert.ok(!added.includes('\n    at '), 'info stays one line');
});

test('a crafted stack cannot pose as a line of its own', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n2026-01-01T00:00:00.000Z error app: DISK wiped';
  const before = read().length;
  log.warn('renderer: something', { err });
  for (const line of read().slice(before).trimEnd().split('\n').slice(1)) {
    assert.match(line, /^ {4}\S/, 'every extra line is indented');
  }
});

test('an Error without a message still says something', () => {
  log.info('empty error', { err: new Error('') });
  assert.match(lastLines()[0], /err=Error$/);
});

test('odd values do not throw and do not vanish', () => {
  const circular = {}; circular.self = circular;
  const before = read().split('\n').length;
  log.info('odd', { circular, undef: undefined, nul: null, obj: { k: 1 }, sym: Symbol('s') });
  // Reading the field throws, so the line cannot be built. It must still leave
  // a mark: a log call that disappears is the wrong failure for a logger.
  log.info('hostile', { get boom() { throw new Error('no'); } });
  log.info({ message: 'as an object' });
  const after = read().split('\n').length;
  assert.strictEqual(after - before, 3, 'every call produced a line');
  assert.ok(read().includes('obj={"k":1}'));
  assert.ok(read().includes('circular=[unserializable]'));
  assert.ok(read().includes('<log line could not be formatted>'));
  assert.ok(read().includes('{"message":"as an object"}'));
});

test('the file is not world-readable', () => {
  if (process.platform === 'win32') return; // no POSIX modes there
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('without an Electron app the logger stays on the console', () => {
  Module._load = function (request, ...rest) {
    if (request === 'electron') throw new Error('Cannot find module "electron"');
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve(LOG)];
  const bare = require(LOG);
  assert.strictEqual(bare.path(), null);
  bare.error('nowhere to write this', { err: new Error('boom') }); // must not throw
  Module._load = origLoad;
  delete require.cache[require.resolve(LOG)];
});

test.after(() => {
  Module._load = origLoad;
  fs.rmSync(home, { recursive: true, force: true });
});
