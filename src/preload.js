'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listShells: () => ipcRenderer.invoke('shells:list'),
  createSession: (shellId, opts) => ipcRenderer.invoke('session:create', shellId, opts),
  getBuffer: (id) => ipcRenderer.invoke('session:buffer', id),
  listClaudeSessions: () => ipcRenderer.invoke('claude:sessions'),
  focusWindow: () => ipcRenderer.send('app:focus'),
  input: (id, data) => ipcRenderer.send('session:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  setMeta: (id, meta) => ipcRenderer.invoke('session:setMeta', id, meta),
  previewFile: (id, relPath, source, opts) => ipcRenderer.invoke('file:preview', id, relPath, source, opts),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  getHistory: (id) => ipcRenderer.invoke('history:get', id),
  getTodos: (id) => ipcRenderer.invoke('todos:get', id),
  setTodos: (id, todos) => ipcRenderer.invoke('todos:set', id, todos),
  getUsage: (force) => ipcRenderer.invoke('usage:get', force),

  onData: (cb) => ipcRenderer.on('session:data', (e, id, data) => cb(id, data)),
  onState: (cb) => ipcRenderer.on('session:state', (e, id, state) => cb(id, state)),
  onExit: (cb) => ipcRenderer.on('session:exit', (e, id) => cb(id)),
  onInfo: (cb) => ipcRenderer.on('session:info', (e, info) => cb(info)),
  onHistAdd: (cb) => ipcRenderer.on('session:histadd', (e, id, entry) => cb(id, entry)),
  onNotify: (cb) => ipcRenderer.on('session:notify', (e, id, message) => cb(id, message)),
  onTodosChanged: (cb) => ipcRenderer.on('todos:changed', (e, key, todos) => cb(key, todos)),
});
