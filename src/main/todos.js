'use strict';
// TODO notes: persisted per project (repo root)
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { send } = require('./window');
const log = require('./log');

let todosStore = null;
function todosPath() { return path.join(app.getPath('userData'), 'flightdeck-todos.json'); }
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

function setFor(session, todos) {
  const store = loadTodos();
  const key = rootKeyOf(session);
  if (todos.length) store[key] = todos;
  else delete store[key];
  try { fs.writeFileSync(todosPath(), JSON.stringify(store, null, 2)); }
  catch (e) { log.warn('todos: not written, the notes stay in memory', { path: todosPath(), key, err: e }); }
  send('todos:changed', key, todos);
  return true;
}

module.exports = { getFor, setFor };
