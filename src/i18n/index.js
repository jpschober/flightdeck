'use strict';
// Registry of the available languages plus the currently selected one.
//
// English is both the source language and the fallback: a key a translation
// has not filled in yet comes out English instead of raw. That way an
// incomplete language file degrades into a mixed interface, not a broken one.
//
// Only the main process and the preload use this module. The renderer gets the
// finished dictionary handed to it (see preload.js) and runs the same runtime.

const runtime = require('./runtime');

// The names are endonyms - a language picker that lists languages in a
// language you cannot read is of no use to the person looking for theirs.
const LOCALES = {
  en: { name: 'English', strings: require('./locales/en') },
  de: { name: 'Deutsch', strings: require('./locales/de') },
  fr: { name: 'Français', strings: require('./locales/fr') },
  it: { name: 'Italiano', strings: require('./locales/it') },
  es: { name: 'Español', strings: require('./locales/es') },
};

const FALLBACK = 'en';

let current = FALLBACK;
let translate = runtime.createT(LOCALES[FALLBACK].strings, FALLBACK);

function available() {
  return Object.keys(LOCALES).map((code) => ({ code, name: LOCALES[code].name }));
}

/** `de-DE`, `de_AT`, `DE` -> `de`; anything unknown -> English. */
function normalize(tag) {
  const code = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return LOCALES[code] ? code : FALLBACK;
}

/** The complete dictionary of a language, English filling in the gaps. */
function dict(code) {
  const c = normalize(code || current);
  return c === FALLBACK
    ? { ...LOCALES[FALLBACK].strings }
    : { ...LOCALES[FALLBACK].strings, ...LOCALES[c].strings };
}

function setLocale(tag) {
  current = normalize(tag);
  translate = runtime.createT(dict(current), current);
  return current;
}

function getLocale() { return current; }

function t(key, params) { return translate(key, params); }

module.exports = { t, setLocale, getLocale, available, normalize, dict, FALLBACK };
