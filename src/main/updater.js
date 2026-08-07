'use strict';
// Updates from the GitHub releases the release workflow publishes.
//
// electron-updater reads app-update.yml, which electron-builder writes into the
// packed app from the `publish` block in electron-builder.yml. An unpacked run
// has no such file, so everything here is off outside a packed build - a check
// would otherwise fail on every start of the dev loop.
//
// What the user sees is one question, and only once the new version is on disk:
// restart now or later. The check and the download run without asking, because
// a dialog before the download would ask about something that may never
// arrive - the download can still fail.
const { app, dialog } = require('electron');
const i18n = require('../i18n');
const log = require('./log');
const { getWindow, alive } = require('./window');

// Long enough for the window to be up and the sessions to have started; the
// first minutes after a start are the ones the user is working in.
const FIRST_CHECK_MS = 60 * 1000;
// A run that stays open for days should not stay on the version it started
// with. Anything shorter would only produce requests nobody reads.
const INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer = null;
let asking = false;

function onDownloaded(updater, info) {
  // A second dialog on top of the first would come from the periodic check
  // finding the same downloaded update again.
  if (asking || !alive()) return;
  asking = true;
  const answer = dialog.showMessageBoxSync(getWindow(), {
    type: 'info',
    buttons: [i18n.t('update.restart'), i18n.t('update.later')],
    defaultId: 0,
    cancelId: 1,
    title: i18n.t('update.ready.title'),
    message: i18n.t('update.ready.title'),
    detail: i18n.t('update.ready.detail', { version: info.version }),
  });
  asking = false;
  if (answer !== 0) return;
  // The shells are children of this process and would be killed with it
  // anyway; quitAndInstall goes through the app's own quit, so the sessions
  // are torn down by the handler in main.js like on any other quit.
  log.info('update: restarting to install', { version: info.version });
  updater.quitAndInstall();
}

/**
 * Starts the update checks. Does nothing outside a packed build, and never
 * throws: an update that cannot be checked for is not a reason to fail a start.
 */
function startUpdates() {
  if (!app.isPackaged) return false;
  let updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    log.warn('update: electron-updater not loadable', { err: e });
    return false;
  }

  updater.autoDownload = true;
  // The install has to wait for the answer to the dialog above.
  updater.autoInstallOnAppQuit = false;
  updater.logger = {
    info: (m) => log.debug('update: ' + m),
    warn: (m) => log.warn('update: ' + m),
    error: (m) => log.warn('update: ' + m),
    debug: (m) => log.debug('update: ' + m),
  };

  updater.on('update-available', (info) => log.info('update: available', { version: info.version }));
  updater.on('update-downloaded', (info) => onDownloaded(updater, info));
  // No release yet, no network, a rate-limited GitHub API: all of them end up
  // here, and none of them is worth interrupting the user for.
  updater.on('error', (e) => log.warn('update: check failed', { err: e }));

  const check = () => {
    // checkForUpdates rejects rather than only emitting 'error' when the feed
    // itself cannot be read.
    updater.checkForUpdates().catch((e) => log.warn('update: check failed', { err: e }));
  };
  // Neither timer keeps the process alive on its own - the window does that.
  const hold = (t) => (t.unref ? t.unref() : t);
  timer = setTimeout(() => {
    check();
    timer = setInterval(check, INTERVAL_MS);
    hold(timer);
  }, FIRST_CHECK_MS);
  hold(timer);
  return true;
}

function stopUpdates() {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  timer = null;
}

module.exports = { startUpdates, stopUpdates };
