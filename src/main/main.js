'use strict';
// The window, and the wiring between the modules that fill it.
const { app, BrowserWindow, shell: electronShell } = require('electron');
const path = require('path');
const { stopWatchingProjects } = require('./claude-sessions');
const { killAll, refreshAll, resetFlowControl } = require('./sessions');
const { isExternalUrl } = require('./ipc');
const { setWindow } = require('./window');
const i18n = require('../i18n');
const settings = require('./settings');
const log = require('./log');

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#101116',
    title: 'Flightdeck',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
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
  // never navigates - the document below is loaded once via loadFile, which these
  // events do not cover - so every navigation that does occur is cancelled. A
  // dropped file is the most common trigger.
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

  win.loadFile(INDEX_HTML);
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
  createWindow();
});

app.on('window-all-closed', () => {
  killAll();
  stopWatchingProjects();
  // The integration directory stays: it is shared with any second instance,
  // whose sessions would otherwise start without the hooks.
  app.quit();
});
