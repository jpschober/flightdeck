'use strict';
// OSC parsing: the sequences the shells and the agent CLIs write into the PTY
// data stream, and the working directory extracted from it.
const log = require('./log');

const OSC7_RE = /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const OSC99_RE = /\x1b\]9;9;"?([^"\x07\x1b]+)"?(?:\x07|\x1b\\)/g;
const OSC133_RE = /\x1b\]133;(?<mark>[A-D])[^\x07\x1b]*(?:\x07|\x1b\\)/;
const OSCCMD_RE = /\x1b\]7770;cmd;(?<cmdB64>[A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/;
// The payload class is deliberately wide so that a malformed report is still
// consumed as one sequence; what counts as a session ID is decided in
// applyStateFromData.
const OSCSESS_RE = /\x1b\]7771;(?<sessKind>[a-z]+);(?<sessId>[^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Claude Code (addressed as iTerm): OSC 0/2 = title, OSC 9 = notification
const OSC_TITLE_RE = /\x1b\](?:0|2);(?<title>[^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC9_RE = /\x1b\]9;(?<osc9>[^\x07\x1b]*)(?:\x07|\x1b\\)/;

// The state sequences are scanned in one pass. Seven separate scans grouped
// their effects by sequence type: OSC 7770 was evaluated in full before
// OSC 133, so a batch holding "133;D (previous command finished) ... 7770;cmd
// (claude starts) ... 133;C" first marked the session as watched and then
// cleared that again from the earlier D. With one pass the matches are
// dispatched in the order they stand in the stream.
//
// None of the alternatives can start at the same position as another (they
// differ from the character after `\x1b]` onwards) and none can match inside
// another (the payloads exclude \x1b and \x07), so the combined scan finds
// exactly the matches the individual expressions found.
const OSC_EVENT_RE = new RegExp(
  [OSCCMD_RE, OSCSESS_RE, OSC133_RE, OSC_TITLE_RE, OSC9_RE]
    .map((r) => `(?:${r.source})`).join('|'), 'g');

function normalizeOscPath(raw) {
  let p;
  try { p = decodeURIComponent(raw); } catch (e) { log.debug('osc7: path not decodable, taken as is', { raw, err: e }); p = raw; }
  if (/^\/[A-Za-z]:/.test(p)) {
    // file://localhost/C:/Users/... -> C:\Users\...
    p = p.slice(1).replace(/\//g, '\\');
  } else if (process.platform === 'win32' && /^\/[a-z]\//.test(p)) {
    // Git Bash style /c/Users/... -> C:\Users\...
    p = p[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\');
  }
  return p;
}

function extractCwd(text) {
  let cwd = null; let m;
  OSC7_RE.lastIndex = 0;
  while ((m = OSC7_RE.exec(text)) !== null) cwd = normalizeOscPath(m[1]);
  OSC99_RE.lastIndex = 0;
  while ((m = OSC99_RE.exec(text)) !== null) cwd = m[1];
  return cwd;
}

module.exports = { OSC_ANY_RE, OSC_EVENT_RE, normalizeOscPath, extractCwd };
