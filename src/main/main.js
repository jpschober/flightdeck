'use strict';
// The window, and the wiring between the modules that fill it.
const { app, BrowserWindow, shell: electronShell } = require('electron');
const path = require('path');
const { stopWatchingProjects } = require('./claude-sessions');
const { killAll, refreshAll, resetFlowControl } = require('./sessions');
const { registerIpc, isExternalUrl } = require('./ipc');
const { setWindow } = require('./window');
const { startUpdates, stopUpdates } = require('./updater');
const i18n = require('../i18n');
const settings = require('./settings');
const log = require('./log');

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
// This file runs as out/main/main.js - the paths below are relative to that,
// not to src/. electron-vite sets ELECTRON_RENDERER_URL while `npm start` runs;
// then the document comes from the dev server and reloads on a change.
const DEV_SERVER = process.env.ELECTRON_RENDERER_URL;
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
// Only Linux takes the window icon from here; on Windows and macOS it is the
// one electron-builder puts into the executable.
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#101116',
    title: 'Flightdeck',
    icon: ICON,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setWindow(win);
  win.setMenuBarVisibility(false);

  // Coming back from hidden or minimised, the data is up to 30 s old - the
  // window gets a fresh pass instead of showing that.
  win.on('show', () => refreshAll(true));
  win.on('restore', () => refreshAll(true));

  // The preload script runs again on every navigation of this webContents, so a
  // foreign page loaded here would own the full window.api bridge. The interface
  // never navigates - the document below is loaded once via loadFile/loadURL,
  // which these events do not cover - so every navigation that does occur is
  // cancelled. A dropped file is the most common trigger.
  const blockNavigation = (e) => e.preventDefault();
  win.webContents.on('will-navigate', blockNavigation);
  win.webContents.on('will-frame-navigate', blockNavigation);

  // A reload (Ctrl+R still reaches the window; setMenuBarVisibility only hides
  // the bar) leaves the batches in flight unacknowledged. The new document
  // starts with an empty backlog, so the flow control does too.
  win.webContents.on('did-finish-load', resetFlowControl);

  // No new windows either; http(s) links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) electronShell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER) win.loadURL(DEV_SERVER);
  else win.loadFile(INDEX_HTML);
}

// A stored choice wins; otherwise follow the system. Unknown system languages
// fall back to English inside normalize().
app.whenReady().then(() => {
  i18n.setLocale(settings.get('locale') || app.getLocale());
  // First line of a run: without it a log file cannot be told apart from the
  // one before it.
  log.info('app: started', {
    version: app.getVersion(), electron: process.versions.electron, platform: process.platform, level: log.level(),
  });
  // Before createWindow(): the preload asks for i18n:init synchronously while
  // the document is still parsing, and the locale above has to be the one that
  // handler reports.
  registerIpc();
  createWindow();
  // After the window, because the answer to a found update is a dialog and it
  // needs a window to sit on.
  startUpdates();
});

app.on('window-all-closed', () => {
  killAll();
  stopUpdates();
  stopWatchingProjects();
  // The integration directory stays: it is shared with any second instance,
  // whose sessions would otherwise start without the hooks.
  app.quit();
});
