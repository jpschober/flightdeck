'use strict';
// Reconstruction of the prompts typed into a watched agent TUI.
//
//   node --test test/input-history.test.js
//
// Shell commands arrive verbatim via OSC 7770; what is typed into `claude`
// does not, so it is rebuilt from the keyboard stream. Whatever this function
// gets wrong ends up in the history panel as a wrong or missing prompt, and
// nothing else in the app would notice.
//
// addHistory() sends to the renderer window - there is none here, and window.js
// simply sends nothing then.

const test = require('node:test');
const assert = require('node:assert');

const { addHistory, feedInputRecon } = require('../src/main/session-state');

const ESC = '\x1b';

/** A session as the PTY layer holds it, watched by default. */
function session(over = {}) {
  return {
    id: 's1', history: [], inputBuf: '', cmdWatched: true, agentPrompted: false, ...over,
  };
}

/** Feeds the keystrokes - as one chunk or split up - and returns the session. */
function type(s, ...chunks) {
  for (const chunk of chunks) feedInputRecon(s, chunk);
  return s;
}

function texts(s) {
  return s.history.map((h) => h.text);
}

test('a typed line becomes a history entry when Enter arrives', () => {
  const s = type(session(), 'fix the tests\r');
  assert.deepStrictEqual(texts(s), ['fix the tests']);
  assert.strictEqual(s.history[0].kind, 'agent');
  assert.strictEqual(s.inputBuf, '');
});

test('nothing is recorded before Enter', () => {
  const s = type(session(), 'fix the ');
  assert.deepStrictEqual(texts(s), []);
  assert.strictEqual(s.inputBuf, 'fix the ');
});

test('the keystrokes may arrive in any number of chunks', () => {
  const whole = type(session(), 'hello world\r');
  const split = type(session(), 'hel', 'lo', ' wo', 'rld', '\r');
  assert.deepStrictEqual(texts(split), texts(whole));
});

test('the first prompt is what makes the session count as prompted', () => {
  const s = session();
  type(s, 'still typing');
  assert.strictEqual(s.agentPrompted, false);
  type(s, '\r');
  assert.strictEqual(s.agentPrompted, true);
});

test('outside a watched command nothing is recorded - the shell reports itself', () => {
  const s = type(session({ cmdWatched: false }), 'ls -la\r');
  assert.deepStrictEqual(texts(s), []);
  assert.strictEqual(s.agentPrompted, false);
  // The line is consumed all the same, so it cannot leak into the next prompt
  assert.strictEqual(s.inputBuf, '');
});

test('backspace and delete take back the last character', () => {
  assert.deepStrictEqual(texts(type(session(), 'tesst\x7f\r')), ['tess']);
  assert.deepStrictEqual(texts(type(session(), 'tesst\b\r')), ['tess']);
  // On an empty buffer they do nothing, and what follows is too short to record
  assert.deepStrictEqual(texts(type(session(), '\x7f\x7fa\r')), []);
});

test('Ctrl+C and Ctrl+U discard the line, Ctrl+W the last word', () => {
  assert.deepStrictEqual(texts(type(session(), 'wrong start\x03right one\r')), ['right one']);
  assert.deepStrictEqual(texts(type(session(), 'wrong start\x15right one\r')), ['right one']);
  // Ctrl+W takes the trailing spaces along with the word
  assert.deepStrictEqual(texts(type(session(), 'delete this word \x17added\r')), ['delete this added']);
});

test('cursor keys and other CSI sequences leave no trace', () => {
  const s = type(session(), `abc${ESC}[Ddef${ESC}[1;5Cghi${ESC}Oxjkl\r`);
  assert.deepStrictEqual(texts(s), ['abcdefghijkl']);
});

test('a pasted block keeps its line breaks, the markers fall away', () => {
  const s = type(session(), `${ESC}[200~line one\nline two${ESC}[201~\r`);
  assert.deepStrictEqual(texts(s), ['line one\nline two']);
});

test('a line of one character is not history', () => {
  const s = type(session(), 'y\r', '  \r', 'ok\r');
  assert.deepStrictEqual(texts(s), ['ok']);
});

test('a very long prompt is cut off, the buffer stays bounded', () => {
  const s = type(session(), 'x'.repeat(3000));
  assert.strictEqual(s.inputBuf.length, 2000);
  type(s, '\r');
  assert.strictEqual(s.history[0].text.length, 500);
});

test('the history keeps the last 200 entries', () => {
  const s = session();
  for (let i = 0; i < 205; i++) type(s, `prompt ${i}\r`);
  assert.strictEqual(s.history.length, 200);
  assert.strictEqual(s.history[0].text, 'prompt 5');
  assert.strictEqual(s.history[199].text, 'prompt 204');
});

test('every entry carries an id of its own - the row is found again by it', () => {
  const s = session();
  const other = session({ id: 's2' });
  addHistory(s, 'one', 'shell');
  addHistory(other, 'two', 'shell');
  addHistory(s, 'three', 'agent');
  const ids = [...s.history, ...other.history].map((h) => h.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'two entries share an id');
  assert.deepStrictEqual(s.history.map((h) => h.kind), ['shell', 'agent']);
});
