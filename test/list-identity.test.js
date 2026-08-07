'use strict';
// The ids the notes panel and the history list find their rows by.
//
//   node --test test/list-identity.test.js
//
// Both lists are updated instead of built again, and a row is found again by
// the id of the note or of the entry it stands for. That only works if the id
// is there and unique - `ts` is neither: two entries from the same millisecond
// share it, and notes from a store written before the ids have none at all.
//
// src/main/todos.js is loaded with `require('electron')` and `./window`
// intercepted, so it writes into a temp directory the way the real app writes
// into userData. addHistory is pulled out of session-state.js as source, the
// way test/terminal-data-path.test.js does it - the module reaches Electron
// through what it loads.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const MAIN = path.join(__dirname, '..', 'src', 'main');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-todos-'));
const changed = [];
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  if (request === './window') return { send: (channel, ...args) => changed.push({ channel, args }) };
  return origLoad.call(this, request, ...rest);
};

const todos = require(path.join(MAIN, 'todos.js'));
const storePath = path.join(userData, 'flightdeck-todos.json');
const session = { gitRoot: '/tmp/project' };

function ids(list) { return list.map((todo) => todo.id); }
function readStore() { return JSON.parse(fs.readFileSync(storePath, 'utf8')); }

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('a note without an id gets one, and setFor answers with it', () => {
  const stored = todos.setFor(session, [
    { text: 'first', done: false, ts: 1 },
    { text: 'second', done: false, ts: 1 },
  ]);
  assert.equal(stored.length, 2);
  for (const todo of stored) assert.ok(todo.id, `${todo.text} has no id`);
  assert.notEqual(stored[0].id, stored[1].id, 'two notes from the same millisecond share their id');
  assert.deepEqual(stored.map((t) => t.text), ['first', 'second'], 'the order changed');
});

test('the id is written to the store and read back unchanged', () => {
  const stored = todos.setFor(session, [{ text: 'kept', done: false, ts: 2 }]);
  assert.deepEqual(ids(readStore()['/tmp/project']), ids(stored), 'the store holds other ids');
  assert.deepEqual(ids(todos.getFor(session).todos), ids(stored), 'reading gives other ids');
});

test('an id that is already there survives a write', () => {
  const first = todos.setFor(session, [{ text: 'a', done: false, ts: 3 }]);
  const second = todos.setFor(session, [{ ...first[0], done: true }]);
  assert.equal(second[0].id, first[0].id, 'ticking a note off changed its id');
  assert.equal(second[0].done, true);
});

test('todos:changed carries the notes with their ids', () => {
  changed.length = 0;
  const stored = todos.setFor(session, [{ text: 'sent', done: false, ts: 4 }]);
  const event = changed.find((c) => c.channel === 'todos:changed');
  assert.ok(event, 'no todos:changed was sent');
  assert.deepEqual(ids(event.args[1]), ids(stored));
});

test('a store written before the ids is repaired on the way in', () => {
  // A store as the earlier version left it, plus the case a repair has to
  // catch: two notes carrying the same id.
  fs.writeFileSync(storePath, JSON.stringify({
    '/tmp/old': [
      { text: 'no id', done: false, ts: 5 },
      { text: 'no id either', done: true, ts: 5 },
      { text: 'duplicate', done: false, ts: 6, id: 'x' },
      { text: 'duplicate too', done: false, ts: 6, id: 'x' },
    ],
  }));
  // The store is read once and kept; the cache has to go with the file.
  delete require.cache[require.resolve(path.join(MAIN, 'todos.js'))];
  const fresh = require(path.join(MAIN, 'todos.js'));

  const list = fresh.getFor({ gitRoot: '/tmp/old' }).todos;
  assert.equal(list.length, 4);
  assert.equal(new Set(ids(list)).size, 4, 'the ids are not unique');
  assert.deepEqual(list.map((t) => t.text),
    ['no id', 'no id either', 'duplicate', 'duplicate too'], 'the order changed');
  assert.equal(list[2].id, 'x', 'the first of the two dropped its id');
});

test('a mangled store does not take the notes down with it', () => {
  fs.writeFileSync(storePath, JSON.stringify({ '/tmp/odd': 'not a list' }));
  delete require.cache[require.resolve(path.join(MAIN, 'todos.js'))];
  const fresh = require(path.join(MAIN, 'todos.js'));
  assert.deepEqual(fresh.getFor({ gitRoot: '/tmp/odd' }).todos, []);
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const stateSrc = fs.readFileSync(path.join(MAIN, 'session-state.js'), 'utf8');
const from = stateSrc.indexOf('const HISTORY_MAX = 200;');
const to = stateSrc.indexOf('function feedInputRecon(session, data) {');
assert.ok(from > 0 && to > from, 'the history block was not found in session-state.js');
const sandbox = { send: () => {} };
vm.runInNewContext(stateSrc.slice(from, to), sandbox);

test('every history entry carries an id of its own', () => {
  const session = { id: 's1', history: [] };
  for (let i = 0; i < 5; i++) sandbox.addHistory(session, `command ${i}`, 'shell');
  const seen = session.history.map((e) => e.id);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, 'two entries share an id');
  for (const id of seen) assert.equal(typeof id, 'string', 'the id is not a string');
});

test('sessions do not hand each other an id', () => {
  const a = { id: 'a', history: [] };
  const b = { id: 'b', history: [] };
  sandbox.addHistory(a, 'in a', 'shell');
  sandbox.addHistory(b, 'in b', 'shell');
  assert.notEqual(a.history[0].id, b.history[0].id);
});

test.after(() => {
  Module._load = origLoad;
  fs.rmSync(userData, { recursive: true, force: true });
});
