'use strict';
// Logging for the main process.
//
// The app reads undocumented internal formats of other programs - Claude Code
// transcripts, the OAuth usage endpoint, SQL migrations. Those are the places
// that break, and a failure there shows up in the interface as an empty panel.
// Without a record of the failure there is nothing to start from.
//
// Two destinations, two levels:
//
//   file      everything down to the configured level, in
//             `app.getPath('logs')/flightdeck.log`
//   terminal  warnings and errors, so `npm start` stays readable
//
// FLIGHTDECK_LOG=debug|info|warn|error raises or lowers both. `debug` is the
// level for expected misses (a file that is not there yet, a probe that came up
// empty); `warn` is for what the user notices.
//
// No dependencies, and nothing here throws: a logger that takes the app down
// with it would be worse than no logger.

const fs = require('fs');
const path = require('path');

const LEVELS = ['error', 'warn', 'info', 'debug'];
const DEFAULT_LEVEL = 'info';
const CONSOLE_LEVEL = 'warn';
// Beyond this the file is moved aside once, at the next start. One generation is
// kept - enough for "it broke yesterday", not enough to fill a disk.
const MAX_BYTES = 4 * 1024 * 1024;

const envLevel = String(process.env.FLIGHTDECK_LOG || '').toLowerCase();
let threshold = LEVELS.indexOf(envLevel);
let consoleThreshold = LEVELS.indexOf(CONSOLE_LEVEL);
if (threshold < 0) threshold = LEVELS.indexOf(DEFAULT_LEVEL);
else consoleThreshold = threshold; // asked for a level explicitly: show it too

let file = null;
let noFile = false; // no Electron app around (a plain node run) - console only

// The logs directory only exists once the app is ready, and modules log while
// they are still loading. So the target is resolved on demand and retried until
// it works.
function logFile() {
  if (file || noFile) return file;
  let app;
  try { ({ app } = require('electron')); } catch { noFile = true; return null; }
  if (!app || typeof app.getPath !== 'function') { noFile = true; return null; }
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'flightdeck.log');
    try {
      if (fs.statSync(target).size > MAX_BYTES) fs.renameSync(target, target + '.old');
    } catch { /* no file yet, or it cannot be moved - then we append to it */ }
    file = target;
  } catch { /* app not ready yet - the next line tries again */ }
  return file;
}

function format(value) {
  if (value instanceof Error) return value.message || String(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// `2026-08-05T09:12:33.412Z warn  dbschema: read failed root=/repo err=EACCES`
function line(level, message, data) {
  let out = `${new Date().toISOString()} ${level.padEnd(5)} ${format(message)}`;
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) out += ` ${key}=${format(value)}`;
  }
  return out;
}

function write(level, message, data) {
  const rank = LEVELS.indexOf(level);
  if (rank > threshold) return;
  let text;
  try { text = line(level, message, data); } catch { return; }
  if (rank <= consoleThreshold) {
    if (rank <= LEVELS.indexOf('warn')) console.error(text);
    else console.log(text);
  }
  const target = logFile();
  if (!target) return;
  try { fs.appendFileSync(target, text + '\n'); } catch { /* log directory gone */ }
}

module.exports = {
  error: (message, data) => write('error', message, data),
  warn: (message, data) => write('warn', message, data),
  info: (message, data) => write('info', message, data),
  debug: (message, data) => write('debug', message, data),
  /** Current level, and a way to change it at runtime (tests, a later setting). */
  level: () => LEVELS[threshold],
  setLevel(name) {
    const rank = LEVELS.indexOf(String(name).toLowerCase());
    if (rank >= 0) { threshold = rank; consoleThreshold = rank; }
    return LEVELS[threshold];
  },
  /** Where the lines go, or null while no file could be opened. */
  path: () => logFile(),
};
