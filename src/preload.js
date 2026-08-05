'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The language is fetched synchronously and before anything else: the renderer
// builds its interface as soon as the script runs, and a label that flashes up
// in English and is then replaced would be worse than a moment's delay here.
const i18nInit = ipcRenderer.sendSync('i18n:init');

contextBridge.exposeInMainWorld('api', {
  listShells: () => ipcRenderer.invoke('shells:list'),
  createSession: (shellId, opts) => ipcRenderer.invoke('session:create', shellId, opts),
  getBuffer: (id) => ipcRenderer.invoke('session:buffer', id),
  listClaudeSessions: () => ipcRenderer.invoke('claude:sessions'),
  focusWindow: () => ipcRenderer.send('app:focus'),
  input: (id, data) => ipcRenderer.send('session:input', id, data),
  // Flow control: reports a batch as processed so the main process reads on
  ackData: (id, chars) => ipcRenderer.send('session:ack', id, chars),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  setMeta: (id, meta) => ipcRenderer.invoke('session:setMeta', id, meta),
  previewFile: (id, relPath, source, opts) => ipcRenderer.invoke('file:preview', id, relPath, source, opts),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  getHistory: (id) => ipcRenderer.invoke('history:get', id),
  getDbSchema: (id, opts) => ipcRenderer.invoke('dbschema:get', id, opts || {}),
  getTodos: (id) => ipcRenderer.invoke('todos:get', id),
  setTodos: (id, todos) => ipcRenderer.invoke('todos:set', id, todos),
  getUsage: (force) => ipcRenderer.invoke('usage:get', force),

  // The renderer has no file access of its own; its log lines take this way
  // into the main process's log file.
  log: (level, message, data) => ipcRenderer.send('log:renderer', level, message, data),

  // Language: the starting values come along at load time, a switch goes
  // through the main process (it owns the setting and the strings it builds
  // itself) and hands the new dictionary back.
  i18n: i18nInit,
  setLocale: (code) => ipcRenderer.invoke('i18n:set', code),

  onData: (cb) => ipcRenderer.on('session:data', (e, id, data) => cb(id, data)),
  onState: (cb) => ipcRenderer.on('session:state', (e, id, state) => cb(id, state)),
  onExit: (cb) => ipcRenderer.on('session:exit', (e, id) => cb(id)),
  onInfo: (cb) => ipcRenderer.on('session:info', (e, info) => cb(info)),
  onHistAdd: (cb) => ipcRenderer.on('session:histadd', (e, id, entry) => cb(id, entry)),
  onNotify: (cb) => ipcRenderer.on('session:notify', (e, id, message) => cb(id, message)),
  onTodosChanged: (cb) => ipcRenderer.on('todos:changed', (e, key, todos) => cb(key, todos)),
});
