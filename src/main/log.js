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
// empty); `warn` is for what the user notices. Debug is a diagnostic mode, not
// a setting to leave on: it writes a line per unparsable transcript line and
// per failed command, synchronously, on this process's event loop. At the
// default `info` almost nothing is written.
//
// One event is one line, plus the stack at warn and error. Keys and values both
// go through format(), so a newline in either cannot forge a second line - the
// renderer sends log lines over the bridge and its input is not trusted.
//
// No dependencies, and nothing here throws: a logger that takes the app down
// with it would be worse than no logger.

const fs = require('fs');
const path = require('path');

const LEVELS = ['error', 'warn', 'info', 'debug'];
const DEFAULT_LEVEL = 'info';
const CONSOLE_LEVEL = 'warn';
// Beyond this the file is moved aside once, at the next start. One generation is
// kept - enough for "it broke yesterday", not enough to fill a disk. The check
// runs once per process, so a run that stays at debug for days grows past it
// until the next restart.
const MAX_BYTES = 4 * 1024 * 1024;
// Per key and per value. `execFile` puts the whole stderr of a failed command
// into err.message, and maxBuffer there is 4 MB.
const MAX_FIELD = 500;
const MAX_STACK_FRAMES = 5;
// The log records repo paths, working directories, project names, command
// output and SQL fragments - the user's business, not the machine's.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

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
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // mkdirSync leaves an existing directory as it is, and a file from an
    // earlier version keeps its mode through appendFileSync.
    try { fs.chmodSync(dir, DIR_MODE); } catch { /* not ours, or a platform without modes */ }
    const target = path.join(dir, 'flightdeck.log');
    try {
      if (fs.statSync(target).size > MAX_BYTES) fs.renameSync(target, target + '.old');
      else fs.chmodSync(target, FILE_MODE);
    } catch { /* no file yet, or it cannot be moved - then we append to it */ }
    file = target;
  } catch { /* app not ready yet - the next line tries again */ }
  return file;
}

function clamp(text) {
  return text.length > MAX_FIELD ? text.slice(0, MAX_FIELD) + `…(+${text.length - MAX_FIELD})` : text;
}

function format(value) {
  if (value instanceof Error) return clamp(String(value.message || value.name || 'Error').replace(/\s+/g, ' '));
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return clamp(value.replace(/\s+/g, ' '));
  if (typeof value === 'object') {
    try { return clamp(JSON.stringify(value).replace(/\s+/g, ' ')); } catch { return '[unserializable]'; }
  }
  return clamp(String(value).replace(/\s+/g, ' '));
}

// At warn and error the stack goes with the line. For the case this logging
// exists for - Claude Code changes its transcript format and a plugin throws a
// TypeError - the message says what happened and only the stack says where.
function stackOf(data) {
  let out = '';
  for (const value of Object.values(data || {})) {
    if (!(value instanceof Error) || !value.stack) continue;
    // A stack is the one multi-line field there is. Every frame goes through
    // format() and is indented, so a crafted one cannot pose as a line of its
    // own - lines of the log itself start with the timestamp, in column one.
    const frames = String(value.stack).split('\n').slice(1, 1 + MAX_STACK_FRAMES);
    for (const frame of frames) out += `\n    ${format(frame).trim()}`;
  }
  return out;
}

// `2026-08-05T09:12:33.412Z warn  dbschema: read failed root=/repo err=EACCES`
function line(level, message, data) {
  let out = `${new Date().toISOString()} ${level.padEnd(5)} ${format(message)}`;
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) out += ` ${format(key)}=${format(value)}`;
  }
  return out;
}

function write(level, message, data) {
  const rank = LEVELS.indexOf(level);
  if (rank > threshold) return;
  let text;
  try {
    text = line(level, message, data);
    if (rank <= LEVELS.indexOf('warn')) text += stackOf(data);
  } catch {
    // A value that cannot be formatted is itself worth knowing about; a log
    // call that vanishes is not.
    try { text = `${new Date().toISOString()} ${level.padEnd(5)} <log line could not be formatted>`; } catch { return; }
  }
  if (rank <= consoleThreshold) {
    if (rank <= LEVELS.indexOf('warn')) console.error(text);
    else console.log(text);
  }
  const target = logFile();
  if (!target) return;
  try { fs.appendFileSync(target, text + '\n', { mode: FILE_MODE }); } catch { /* log directory gone */ }
}

module.exports = {
  error: (message, data) => write('error', message, data),
  warn: (message, data) => write('warn', message, data),
  info: (message, data) => write('info', message, data),
  debug: (message, data) => write('debug', message, data),
  /** Current level, and a way to change it at runtime (tests, a later setting). */
  level: () => LEVELS[threshold],
  setLevel(name) {
    let wanted = '';
    try { wanted = String(name).toLowerCase(); } catch { /* a value whose toString throws is not a level */ }
    const rank = LEVELS.indexOf(wanted);
    if (rank >= 0) { threshold = rank; consoleThreshold = rank; }
    return LEVELS[threshold];
  },
  /** Where the lines go, or null while no file could be opened. */
  path: () => logFile(),
};
