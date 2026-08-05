'use strict';
// Persisted app settings (currently only the interface language).
//
// Kept separate from the notes store: notes belong to a project, settings
// belong to the installation, and mixing the two would make either one awkward
// to reason about.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('./log');

let store = null;

function file() {
  return path.join(app.getPath('userData'), 'flightdeck-settings.json');
}

function load() {
  if (!store) {
    try { store = JSON.parse(fs.readFileSync(file(), 'utf8')); }
    // no file yet, or unreadable - start with defaults
    catch (e) { log.debug('settings: not readable, using defaults', { path: file(), err: e }); store = {}; }
  }
  return store;
}

function get(key, fallback = null) {
  const value = load()[key];
  return value === undefined ? fallback : value;
}

function set(key, value) {
  const s = load();
  s[key] = value;
  try { fs.writeFileSync(file(), JSON.stringify(s, null, 2), 'utf8'); }
  catch (e) { log.warn('settings: not written, the setting stays for this run', { path: file(), key, err: e }); }
}

module.exports = { get, set };
