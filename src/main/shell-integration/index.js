'use strict';
// Shell integration: the scripts next to this file are the ones the shells run.
//
// They are read from here and written into a directory under userData, from
// where the shells load them. Two locations because the two have different
// requirements: this directory ships with the app and is read-only in a packed
// build (inside app.asar), and zsh needs a directory of its own it can be
// pointed at via ZDOTDIR.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('../log');

// A script checked out on Windows can carry CRLF, and a \r at the end of a line
// is part of the command for bash and zsh. The scripts are read as LF.
function readScript(name) {
  const text = fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
  // Bash and zsh share the claude wrapper. The line naming it is replaced by
  // the file's content, which keeps every script a script the shell and
  // shellcheck can read on its own.
  return text.replace(/^# flightdeck:include (\S+)$/gm, (m, file) => readScript(file));
}

const PS_ENCODED_FROM = 'init.ps1';
let psEncoded = null;
function psEncodedCommand() {
  if (!psEncoded) psEncoded = Buffer.from(readScript(PS_ENCODED_FROM), 'utf16le').toString('base64');
  return psEncoded;
}

// The integration files live in their own directory under userData; zsh needs a
// directory (ZDOTDIR), the others only a file. A world-writable location such as
// os.tmpdir() lets another local user create the directory first and place files
// in it, and zsh sources everything it finds in ZDOTDIR.

// Zsh startup files that Flightdeck never writes but would source from ZDOTDIR.
// One of them left behind by an older version or another writer runs on every
// session, so they are removed. Other entries are left alone: a second instance
// may be writing its own temporary file at any moment.
const ZSH_STALE_FILES = ['.zprofile', '.zlogin', '.zlogout'];

let rcDir = null;
function getRcDir() {
  if (!rcDir) {
    const dir = path.join(app.getPath('userData'), 'shell-integration');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync with recursive: true also accepts a symlink to a directory, and
    // the chmod and the removals below would then apply to the target.
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('not a directory: ' + dir);
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    for (const name of ZSH_STALE_FILES) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (e) { log.debug('shell: stale integration file not removed', { file: path.join(dir, name), err: e }); }
    }
    rcDir = dir;
  }
  return rcDir;
}

// Written to a separate file and renamed over the old one, so a session started
// by a second Flightdeck instance reads either the previous or the new content
// and never a half-written file. Other users are kept out by the 0700 directory;
// the temporary name only needs to be unique per instance.
function writeRc(name, content) {
  const p = path.join(getRcDir(), name);
  const tmp = p + '.' + process.pid + '.tmp';
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, p);
  return p.replace(/\\/g, '/');
}

const rcPaths = {};
// `name` is the file the shell loads, `script` the one shipped next to this file.
function getRc(name, script) {
  if (!rcPaths[name]) rcPaths[name] = writeRc(name, readScript(script));
  return rcPaths[name];
}

// readScript is exported for test/shell-integration.test.js, which runs a real
// bash against exactly the text a session gets.
module.exports = { getRcDir, getRc, psEncodedCommand, readScript };
