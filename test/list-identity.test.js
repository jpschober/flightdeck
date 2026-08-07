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
// Three parts: the notes store, which mints and keeps the ids; addHistory,
// which mints its own; and the two lists themselves, driven through
// syncChildren to the one question the panels are about - does a row that is
// already standing stay the same element.
//
// src/main/todos.js is loaded with `require('electron')` and `./window`
// intercepted, so it writes into a temp directory the way the real app writes
// into userData. The rest is pulled out of the source, the way
// test/terminal-data-path.test.js does it: those modules reach Electron
// through what they load, and the renderer has no DOM here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src');
const TODOS = path.join(SRC, 'main', 'todos.js');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-todos-'));
const changed = [];
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  if (request === './window') return { send: (channel, ...args) => changed.push({ channel, args }) };
  return origLoad.call(this, request, ...rest);
};

// The store is read once and kept in the module. Whatever is written to the
// file behind its back only reaches it through a fresh load.
let notes = require(TODOS);
function reload() {
  delete require.cache[require.resolve(TODOS)];
  notes = require(TODOS);
  return notes;
}

const storePath = path.join(userData, 'flightdeck-todos.json');
const session = { gitRoot: '/tmp/project' };

function ids(list) { return list.map((todo) => todo.id); }
function texts(list) { return list.map((todo) => todo.text); }
function readStore() { return JSON.parse(fs.readFileSync(storePath, 'utf8')); }

// ---------------------------------------------------------------------------
// The notes store
// ---------------------------------------------------------------------------

test('a note without an id gets one, and setFor answers with it', () => {
  const stored = notes.setFor(session, [
    { text: 'first', done: false, ts: 1 },
    { text: 'second', done: false, ts: 1 },
  ]);
  assert.equal(stored.length, 2);
  for (const todo of stored) assert.ok(todo.id, `${todo.text} has no id`);
  assert.notEqual(stored[0].id, stored[1].id, 'two notes from the same millisecond share their id');
  assert.deepEqual(texts(stored), ['first', 'second'], 'the order changed');
});

test('the id is written to the store and reads back unchanged', () => {
  const written = ids(notes.setFor(session, [
    { text: 'kept', done: false, ts: 2 },
    { text: 'kept too', done: false, ts: 2 },
  ]));
  assert.deepEqual(ids(readStore()[session.gitRoot]), written, 'the store holds other ids');
  // From a fresh load, so the answer cannot be the array setFor left behind.
  assert.deepEqual(ids(reload().getFor(session).todos), written, 'reading back gives other ids');
});

test('an id that is already there survives a write', () => {
  const first = notes.setFor(session, [{ text: 'a', done: false, ts: 3 }]);
  const second = notes.setFor(session, [{ ...first[0], done: true }]);
  assert.equal(second[0].id, first[0].id, 'ticking a note off changed its id');
  assert.equal(second[0].done, true);
});

test('todos:changed carries the notes with their ids', () => {
  changed.length = 0;
  const stored = notes.setFor(session, [{ text: 'sent', done: false, ts: 4 }]);
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
  const list = reload().getFor({ gitRoot: '/tmp/old' }).todos;
  assert.equal(list.length, 4);
  assert.equal(new Set(ids(list)).size, 4, 'the ids are not unique');
  assert.deepEqual(texts(list),
    ['no id', 'no id either', 'duplicate', 'duplicate too'], 'the order changed');
  assert.equal(list[2].id, 'x', 'the first of the two dropped its id');
});

test('a key that is not a list is answered empty and left where it is', () => {
  fs.writeFileSync(storePath, JSON.stringify({
    '/tmp/odd': 'not a list',
    '/tmp/mine': [{ text: 'mine', done: false, ts: 7, id: 'm' }],
  }));
  reload();
  assert.deepEqual(notes.getFor({ gitRoot: '/tmp/odd' }).todos, []);
  // Every write carries the whole store back to the file, so a key nobody
  // here understands must not be lost by writing another one.
  notes.setFor({ gitRoot: '/tmp/mine' }, [{ text: 'mine', done: true, ts: 7, id: 'm' }]);
  assert.equal(readStore()['/tmp/odd'], 'not a list');
});

test('a payload that is not a list is refused before the store is touched', () => {
  fs.writeFileSync(storePath, JSON.stringify({
    '/tmp/keep': [{ text: 'safe', done: false, ts: 8, id: 'k' }],
  }));
  reload();
  // An empty list is how the last note is deleted; anything that is not a list
  // is not notes, and taking it for an empty one would erase the project's.
  assert.throws(() => notes.setFor({ gitRoot: '/tmp/keep' }, null));
  assert.deepEqual(texts(readStore()['/tmp/keep']), ['safe'], 'the notes were written over');
});

// ---------------------------------------------------------------------------
// The history ids
// ---------------------------------------------------------------------------

const stateSrc = fs.readFileSync(path.join(SRC, 'main', 'session-state.js'), 'utf8');
const from = stateSrc.indexOf('const HISTORY_MAX = 200;');
const to = stateSrc.indexOf('function feedInputRecon(session, data) {');
assert.ok(from > 0 && to > from, 'the history block was not found in session-state.js');
const histBlock = stateSrc.slice(from, to);
// The counter has to come out of the source with addHistory - standing above
// HISTORY_MAX it would be left behind, and addHistory would fail on a name it
// cannot see instead of on what is being tested here.
for (const name of ['let histSeq', 'function addHistory(']) {
  assert.ok(histBlock.includes(name), `${name} is not in the extracted block`);
}
const histSandbox = { send: () => {} };
vm.runInNewContext(histBlock, histSandbox);

test('every history entry carries an id of its own', () => {
  const s = { id: 's1', history: [] };
  for (let i = 0; i < 5; i++) histSandbox.addHistory(s, `command ${i}`, 'shell');
  const seen = s.history.map((e) => e.id);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, 'two entries share an id');
  for (const id of seen) assert.equal(typeof id, 'string', 'the id is not a string');
});

test('sessions do not hand each other an id', () => {
  const a = { id: 'a', history: [] };
  const b = { id: 'b', history: [] };
  histSandbox.addHistory(a, 'in a', 'shell');
  histSandbox.addHistory(b, 'in b', 'shell');
  assert.notEqual(a.history[0].id, b.history[0].id);
});

// ---------------------------------------------------------------------------
// The two lists through syncChildren
//
// What the panels are about is one question: does the row that is already
// standing stay the same element. The renderer modules are ES modules and have
// no DOM here, so syncChildren and the two item lists are read out of the
// source and run against a container that keeps its children in an array - the
// handful of members syncChildren touches.
// ---------------------------------------------------------------------------

/** The function starting at `signature`, up to its closing brace. */
function extract(file, signature) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `${signature} was not found in ${path.basename(file)}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${signature} is not closed in ${path.basename(file)}`);
}

const listSandbox = {};
vm.runInNewContext([
  extract(path.join(SRC, 'renderer', 'dom.js'), 'export function syncChildren').replace('export ', ''),
  extract(path.join(SRC, 'renderer', 'notes.js'), 'function todoItems'),
  extract(path.join(SRC, 'renderer', 'history.js'), 'function histItems'),
].join('\n'), listSandbox);
const { syncChildren, todoItems, histItems } = listSandbox;

function fakeContainer() {
  const kids = [];
  const c = {
    kids,
    get children() { return kids; },
    get firstElementChild() { return kids[0] || null; },
    insertBefore(el, at) {
      const was = kids.indexOf(el);
      if (was >= 0) kids.splice(was, 1);
      const to = at ? kids.indexOf(at) : -1;
      kids.splice(to < 0 ? kids.length : to, 0, el);
      el.parent = c;
    },
  };
  return c;
}

let built = 0;
function build() {
  built++;
  const el = {
    dataset: {}, parent: null,
    get nextElementSibling() {
      const i = el.parent ? el.parent.kids.indexOf(el) : -1;
      return i < 0 ? null : (el.parent.kids[i + 1] || null);
    },
    remove() {
      const i = el.parent ? el.parent.kids.indexOf(el) : -1;
      if (i >= 0) el.parent.kids.splice(i, 1);
      el.parent = null;
    },
  };
  return el;
}
function update(el, item) { el.item = item; }

function sync(container, items) {
  built = 0;
  syncChildren(container, items, build, update);
  return container.kids;
}

test('a note keys its row by its id, not by its position', () => {
  const todos = [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }];
  assert.deepEqual(todoItems(todos).map((i) => i.id), ['todo:a', 'todo:b']);
  assert.deepEqual(todoItems([]).map((i) => i.id), ['empty']);
});

test('ticking a note off leaves every row where it was', () => {
  const todos = [{ id: 'a', text: 'a', done: false }, { id: 'b', text: 'b', done: false }];
  const list = fakeContainer();
  const before = [...sync(list, todoItems(todos))];
  assert.equal(built, 2);

  // What the panel does after a note was ticked off: the notes come back from
  // the store as new objects, with the same ids.
  const back = todos.map((todo) => ({ ...todo, done: todo.id === 'b' }));
  const after = sync(list, todoItems(back));
  assert.equal(built, 0, 'a row was built again - the checkbox with the focus is gone');
  assert.deepEqual(after, before);
});

test('deleting a note takes its row and no other', () => {
  const todos = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const list = fakeContainer();
  const before = [...sync(list, todoItems(todos))];
  const after = sync(list, todoItems([todos[0], todos[2]]));
  assert.equal(built, 0);
  assert.deepEqual(after, [before[0], before[2]]);
  assert.equal(before[1].parent, null, 'the deleted row is still in the list');
});

test('an empty list and a filled one do not share a row', () => {
  const list = fakeContainer();
  const empty = [...sync(list, todoItems([]))];
  const filled = sync(list, todoItems([{ id: 'a' }]));
  assert.equal(built, 1, 'the empty notice was reused as a note');
  assert.notEqual(filled[0], empty[0]);
});

test('a new history entry only adds its own row, at the top', () => {
  const s = { history: [{ id: 'h1', ts: 1 }, { id: 'h2', ts: 2 }] };
  const list = fakeContainer();
  const before = [...sync(list, histItems(s))];
  assert.deepEqual(before.map((el) => el.dataset.id), ['hist:h2', 'hist:h1']);

  s.history.push({ id: 'h3', ts: 3 });
  const after = sync(list, histItems(s));
  assert.equal(built, 1, 'a standing row was built again - a selection in it is gone');
  assert.deepEqual(after.slice(1), before);
  assert.equal(after[0].dataset.id, 'hist:h3');
});

test('the oldest entry falls out without touching the rest', () => {
  const s = { history: [{ id: 'h1', ts: 1 }, { id: 'h2', ts: 2 }] };
  const list = fakeContainer();
  const before = [...sync(list, histItems(s))];
  s.history.shift();
  s.history.push({ id: 'h3', ts: 3 });
  const after = sync(list, histItems(s));
  assert.equal(built, 1);
  assert.deepEqual(after.map((el) => el.dataset.id), ['hist:h3', 'hist:h2']);
  assert.equal(after[1], before[0], 'the entry that stayed lost its row');
});

test.after(() => {
  Module._load = origLoad;
  fs.rmSync(userData, { recursive: true, force: true });
});
