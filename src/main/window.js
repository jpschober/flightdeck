'use strict';
// The one renderer window, held where every module that reports to it can
// reach it. The window itself is built in main.js and handed over here.
//
// Nothing is sent while the window is gone: after `destroy()` the object is
// still there, and webContents.send() on it throws.
let win = null;

function setWindow(w) { win = w; }
function getWindow() { return win; }
function alive() { return Boolean(win) && !win.isDestroyed(); }

function send(channel, ...args) {
  if (alive()) win.webContents.send(channel, ...args);
}

module.exports = { setWindow, getWindow, alive, send };
