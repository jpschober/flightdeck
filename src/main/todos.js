'use strict';
// TODO notes: persisted per project (repo root)
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app } = require('electron');
const { send } = require('./window');
const log = require('./log');

let todosStore = null;
function todosPath() { return path.join(app.getPath('userData'), 'flightdeck-todos.json'); }

/**
 * Give every note an id, and one that no other note in the list carries.
 *
 * The renderer finds a note's row again by that id and updates it instead of
 * building it again, so ticking a note off no longer replaces the checkbox
 * that received the click. `ts` cannot carry that: two notes written in the
 * same millisecond share it, and notes from an older store have none.
 *
 * Minted here, because everything that reaches a note goes through here: the
 * id a note is given on its first write is the one it carries in the store and
 * the one it comes back with. Notes read out of a store from before the ids
 * are given theirs in memory; those reach the file with the next write.
 *
 * Anything but a list throws - what the caller passes is what will be written,
 * so a payload that is not notes has to stop before the store, not turn into
 * an empty list that erases the project's notes.
 */
function withIds(todos) {
  const seen = new Set();
  return todos.map((todo) => {
    const keep = todo && typeof todo.id === 'string' && todo.id && !seen.has(todo.id);
    const id = keep ? todo.id : randomUUID();
    seen.add(id);
    return keep ? todo : { ...todo, id };
  });
}

function loadTodos() {
  if (!todosStore) {
    try { todosStore = JSON.parse(fs.readFileSync(todosPath(), 'utf8')); }
    catch (e) {
      log.debug('todos: store not readable, trying the aibash migration', { path: todosPath(), err: e });
      // Migration from the earlier "aibash" installation
      try {
        const oldPath = path.join(app.getPath('userData'), '..', 'aibash', 'aibash-todos.json');
        todosStore = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
      } catch (e2) { log.debug('todos: no store to migrate, starting empty', { err: e2 }); todosStore = {}; }
    }
    // Notes from a store written before the ids get theirs on the way in, so
    // every reader downstream sees the same id for the same note. A key that
    // holds something other than a list is left standing: it is not this
    // project's business, and the next write would carry the whole store back
    // to the file.
    if (!todosStore || typeof todosStore !== 'object') todosStore = {};
    for (const [key, list] of Object.entries(todosStore)) {
      if (Array.isArray(list)) todosStore[key] = withIds(list);
    }
  }
  return todosStore;
}
function rootKeyOf(session) {
  return (session.gitRoot || session.cwd || 'global').toLowerCase();
}

function getFor(session) {
  const key = rootKeyOf(session);
  const todos = loadTodos()[key];
  return { key, todos: Array.isArray(todos) ? todos : [] };
}

// Returns the stored notes, which is what the caller has to go on with: a new
// note arrives here without an id and leaves with one.
function setFor(session, todos) {
  const store = loadTodos();
  const key = rootKeyOf(session);
  const stored = withIds(todos);
  if (stored.length) store[key] = stored;
  else delete store[key];
  try { fs.writeFileSync(todosPath(), JSON.stringify(store, null, 2)); }
  catch (e) { log.warn('todos: not written, the notes stay in memory', { path: todosPath(), key, err: e }); }
  send('todos:changed', key, stored);
  return stored;
}

module.exports = { getFor, setFor };
