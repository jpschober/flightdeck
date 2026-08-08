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
// The version the user said "later" to. The periodic check finds the same
// downloaded update again every six hours and reports it again; without this
// the same question would come back all day. It is not remembered past the
// run - the next start asks once more.
let declined = null;

async function onDownloaded(updater, info) {
  if (asking || declined === info.version || !alive()) return;
  asking = true;
  try {
    // Not showMessageBoxSync: this dialog appears unasked for, and the sync
    // one stops the main process while it stands. Every terminal would sit
    // there without output until somebody answered it.
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info',
      buttons: [i18n.t('update.restart'), i18n.t('update.later')],
      defaultId: 0,
      cancelId: 1,
      title: i18n.t('update.ready.title'),
      message: i18n.t('update.ready.title'),
      detail: i18n.t('update.ready.detail', { version: info.version }),
    });
    if (response !== 0) {
      declined = info.version;
      log.info('update: declined for this run', { version: info.version });
      return;
    }
    // The shells are children of this process and would be killed with it
    // anyway; quitAndInstall goes through the app's own quit, so the sessions
    // are torn down by the handler in main.js like on any other quit.
    log.info('update: restarting to install', { version: info.version });
    updater.quitAndInstall();
  } finally {
    asking = false;
  }
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
  // Nothing is installed unless the dialog was answered with yes. On quit is
  // where electron-updater would otherwise do it, and for a .deb that means
  // dpkg through pkexec: closing the window would put a password prompt in
  // front of somebody who never agreed to an install. "Later" therefore means
  // later, and the question comes back on the next start.
  updater.autoInstallOnAppQuit = false;
  // electron-updater's narration. Its own warn and error stay at warn - the
  // stderr of a failed installer is logged there and nowhere else. The
  // 'error' event below repeats some of it; a second line about a failure is
  // cheaper than losing the only line that says why.
  const say = (level) => (m) => log[level]('update: ' + (m instanceof Error ? m.message : m));
  updater.logger = { debug: say('debug'), info: say('debug'), warn: say('warn'), error: say('warn') };

  updater.on('update-available', (info) => log.info('update: available', { version: info.version }));
  // onDownloaded is async, and a rejection with nobody holding the promise
  // takes the process down in Node 22.
  updater.on('update-downloaded', (info) => {
    onDownloaded(updater, info).catch((e) => log.warn('update: the question could not be put', { err: e }));
  });
  // No release yet, no network, a rate-limited GitHub API, a download that
  // broke off: all of them end up here. None is worth interrupting the user
  // for, and none of them stops the app working - hence warn and not error.
  updater.on('error', (e) => log.warn('update: failed', { err: e }));

  // checkForUpdates rejects on top of emitting 'error', so the rejection is
  // swallowed here rather than reported a second time.
  const check = () => updater.checkForUpdates().catch(() => {});
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
