// ---------------------------------------------------------------------------
// Logging
//
// The renderer is sandboxed and has no file access, so its lines go over the
// bridge into the main process's log file - one file per bug report. The same
// event repeated inside a few seconds is counted instead of written out again:
// a failing fit() during a divider drag fires with every mouse move. "Same
// event" means level, message and all fields - two sessions failing the same
// way are two events, and the count goes out with the next line so that "twice"
// and "two hundred times" stay distinguishable.
// ---------------------------------------------------------------------------
const logSeen = new Map(); // key -> { at, dropped }
const LOG_REPEAT_MS = 5000;
const LOG_KEYS_MAX = 100;

function logLine(level, message, data) {
  const fields = {};
  for (const [name, value] of Object.entries(data || {})) {
    if (!(value instanceof Error)) { fields[name] = value; continue; }
    // Errors travel as text: whether the bridge can clone an Error depends on
    // the Electron version, and a log line must not depend on that. The first
    // frames go along - a TypeError from a changed data format says what broke,
    // the stack says where.
    fields[name] = `${value.name}: ${value.message}`;
    if (value.stack && !fields.stack) fields.stack = String(value.stack).split('\n').slice(1, 4).join(' | ');
  }
  const key = `${level}|${message}|${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  const now = Date.now();
  const seen = logSeen.get(key);
  // Delete before setting, here and on the suppressed path: a Map keeps
  // insertion order and set() on an existing key does not move it, so without
  // this the message firing most often would be the first one evicted - and
  // eviction resets its throttle.
  if (seen && now - seen.at < LOG_REPEAT_MS) {
    seen.dropped += 1;
    logSeen.delete(key);
    logSeen.set(key, seen);
    return;
  }
  if (seen && seen.dropped) fields.repeats = seen.dropped;
  logSeen.delete(key);
  logSeen.set(key, { at: now, dropped: 0 });
  while (logSeen.size > LOG_KEYS_MAX) logSeen.delete(logSeen.keys().next().value);
  // Called from catch blocks, so it must not throw one of its own: a value the
  // bridge cannot clone would otherwise skip whatever follows the catch.
  try { window.api.log(level, message, fields); } catch { /* bridge gone or a value that will not travel */ }
}

export const logDebug = (message, data) => logLine('debug', message, data);
export const logWarn = (message, data) => logLine('warn', message, data);
