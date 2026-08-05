'use strict';
// The clipboard write that the terminal output asks for (OSC 52), from
// src/main/main.js.
//
// main.js requires Electron, so the block around the handler is pulled out of
// the source and run against stubs: the setting, the clipboard and the logger
// are the only things it touches besides its argument.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

const from = src.indexOf('const OSC52_MAX_CHARS');
const to = src.indexOf("ipcMain.handle('osc52:enabled'", from);
assert.ok(from > 0 && to > from, 'the OSC 52 block was not found in main.js');
const block = src.slice(from, to);

const written = [];
const logged = [];
const rec = (level) => (message, data) => logged.push({ level, message, data });
let enabled = true;
const handlers = {};
const sandbox = {
  ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
  clipboard: { writeText: (text) => written.push(text) },
  settings: { get: (key, fallback) => (key === 'osc52Write' ? enabled : fallback) },
  log: { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') },
};
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.LIMIT = OSC52_MAX_CHARS;`, sandbox);
// The handler builds its answer inside the sandbox; spreading it makes it an
// object of this realm, which is what deepStrictEqual compares against.
const write = (text) => ({ ...handlers['clipboard:write-osc52'](null, text) });
const LIMIT = sandbox.LIMIT;

test.beforeEach(() => { written.length = 0; enabled = true; });

test('a plain text lands on the clipboard and is reported by length', () => {
  const res = write('git push --force');
  assert.deepStrictEqual(written, ['git push --force']);
  assert.deepStrictEqual(res, { written: 16, off: false });
});

test('newline and tab survive - Claude copies multi-line code blocks this way', () => {
  const code = 'function f() {\n\tre' + 'turn 1;\n}\n';
  const res = write(code);
  assert.deepStrictEqual(written, [code]);
  assert.strictEqual(res.written, code.length);
});

test('control characters are dropped, the rest of the text stays', () => {
  // An escape sequence on the clipboard would act on the next terminal the text
  // is pasted into, and the reported length would not match what landed there.
  const res = write('rm -rf /\x1b]0;innocent\x07\x00\x07\rtmp');
  assert.deepStrictEqual(written, ['rm -rf /]0;innocenttmp']);
  assert.strictEqual(res.written, written[0].length);
});

test('a payload longer than the cap is cut to it', () => {
  const res = write('x'.repeat(LIMIT + 5000));
  assert.strictEqual(written[0].length, LIMIT);
  assert.strictEqual(res.written, LIMIT);
});

test('switched off, nothing is written and the caller learns why', () => {
  enabled = false;
  const res = write('take this');
  assert.deepStrictEqual(written, []);
  assert.deepStrictEqual(res, { written: 0, off: true });
});

test('an empty payload and a payload of nothing but control characters write nothing', () => {
  assert.deepStrictEqual(write(''), { written: 0, off: false });
  assert.deepStrictEqual(write('\x00\x1b\x07'), { written: 0, off: false });
  assert.deepStrictEqual(write(42), { written: 0, off: false });
  assert.deepStrictEqual(written, []);
});
