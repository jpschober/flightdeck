'use strict';
// Persisted app settings (currently only the interface language).
//
// Kept separate from the notes store: notes belong to a project, settings
// belong to the installation, and mixing the two would make either one awkward
// to reason about.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let store = null;

function file() {
  return path.join(app.getPath('userData'), 'flightdeck-settings.json');
}

function load() {
  if (!store) {
    try { store = JSON.parse(fs.readFileSync(file(), 'utf8')); }
    catch { store = {}; } // no file yet, or unreadable - start with defaults
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
  catch { /* disk full or similar - the setting stays for this run */ }
}

module.exports = { get, set };
