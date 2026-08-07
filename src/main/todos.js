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
 * same millisecond share it, and notes from an older store have none. The id
 * is minted here because here is where the notes are stored and read again,
 * so it survives both.
 */
function withIds(todos) {
  if (!Array.isArray(todos)) return [];
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
    // every reader downstream sees the same id for the same note.
    if (!todosStore || typeof todosStore !== 'object') todosStore = {};
    for (const key of Object.keys(todosStore)) todosStore[key] = withIds(todosStore[key]);
  }
  return todosStore;
}
function rootKeyOf(session) {
  return (session.gitRoot || session.cwd || 'global').toLowerCase();
}

function getFor(session) {
  const key = rootKeyOf(session);
  return { key, todos: loadTodos()[key] || [] };
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
