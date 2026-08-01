// Translation runtime: picks the plural form and fills in placeholders.
//
// This file is loaded twice - the main process and the preload require it, the
// renderer pulls it in as a plain <script> (it has no node access). Hence the
// UMD wrapper: one implementation instead of two that drift apart.
//
// A string entry is either plain text or a set of plural forms:
//
//   'notes.empty':   'No notes'
//   'session.agents': { one: '{count} agent working', other: '{count} agents working' }
//
// The form is chosen by Intl.PluralRules, so every language gets its own rule -
// French counts 0 as singular, English and German do not, and none of that is
// hard-coded here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.I18nRuntime = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLACEHOLDER = /\{(\w+)\}/g;
  const rulesCache = new Map();

  function rulesFor(locale) {
    let rules = rulesCache.get(locale);
    if (!rules) {
      try { rules = new Intl.PluralRules(locale); } catch { rules = new Intl.PluralRules('en'); }
      rulesCache.set(locale, rules);
    }
    return rules;
  }

  // `other` is the last resort: a translation that only fills in the forms its
  // own language needs must not come back empty in another one.
  function pick(entry, locale, params) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;
    const count = params && params.count;
    if (typeof count !== 'number') return entry.other || entry.one || null;
    return entry[rulesFor(locale).select(count)] || entry.other || entry.one || null;
  }

  function interpolate(text, params) {
    if (!params) return text;
    return text.replace(PLACEHOLDER, (match, key) => (
      key in params ? String(params[key]) : match
    ));
  }

  /** Builds the `t` function for one dictionary. */
  function createT(dict, locale) {
    return function t(key, params) {
      const text = pick(dict && dict[key], locale, params);
      // A missing key shows as the key itself. Blanking the interface would
      // hide the gap; this way it names exactly what is missing and where.
      if (text === null || text === undefined) return key;
      return interpolate(text, params);
    };
  }

  return { createT, interpolate };
}));
