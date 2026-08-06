'use strict';
// The IPC surface, checked against the bridge that uses it.
//
// The handlers used to be registered while ipc.js was being required, so the
// whole surface hung on somebody still importing something from that module.
// Removing the last import would have left the app starting, the window
// painting and every renderer call answering nothing, without an error. They
// are registered by a call now, and these tests keep it that way.
//
// ipc.js and preload.js both require Electron, so the channels are read out of
// the source.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ipcSrc = fs.readFileSync(path.join(SRC, 'main', 'ipc.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');

const handled = new Set(
  [...ipcSrc.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1]),
);
const asked = new Set(
  [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\('([^']+)'/g)].map((m) => m[1]),
);

test('main.js registers the handlers itself', () => {
  assert.ok(/\bregisterIpc\b/.test(ipcSrc), 'ipc.js no longer names registerIpc');
  assert.match(ipcSrc, /module\.exports = \{[^}]*\bregisterIpc\b/, 'registerIpc is not exported');
  assert.match(mainSrc, /\bregisterIpc\(\)/, 'main.js never calls registerIpc()');
});

test('no channel is registered outside registerIpc', () => {
  const from = ipcSrc.indexOf('function registerIpc() {');
  assert.ok(from > 0, 'registerIpc is not a function declaration in ipc.js');
  const outside = ipcSrc.slice(0, from);
  assert.ok(!/ipcMain\.(?:handle|on)\(/.test(outside),
    'a handler is registered while the module is being required');
});

// The window is built after registerIpc(), and the preload asks for i18n:init
// synchronously while the document is still parsing. Registered afterwards, the
// bridge would come up without a dictionary.
test('the handlers are registered before the window is created', () => {
  const register = mainSrc.indexOf('registerIpc()');
  const create = mainSrc.indexOf('createWindow()', register);
  assert.ok(register > 0 && create > register,
    'createWindow() no longer follows registerIpc()');
});

test('every channel the bridge asks for is answered', () => {
  for (const channel of asked) {
    assert.ok(handled.has(channel), `${channel} is asked for but not registered`);
  }
});

// The other direction is not an error - the main process may push channels the
// bridge only listens on - so only the ones the bridge calls are compared.
test('the bridge asks for something at all', () => {
  assert.ok(asked.size > 20, `only ${asked.size} channels found - the extraction is off`);
});
