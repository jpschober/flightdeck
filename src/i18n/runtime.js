// Translation runtime: picks the plural form and fills in placeholders.
//
// The main process, the preload and the renderer all use this one module. It is
// an ES module because that is the one format all three paths agree on: the
// renderer imports it directly, and the bundler turns the `require` in
// index.js into an import. A CommonJS file here works in the build and not in
// the dev server, which resolves modules without Rollup.
//
// A string entry is either plain text or a set of plural forms:
//
//   'notes.empty':   'No notes'
//   'session.agents': { one: '{count} agent working', other: '{count} agents working' }
//
// The form is chosen by Intl.PluralRules, so every language gets its own rule -
// French counts 0 as singular, English and German do not, and none of that is
// hard-coded here.
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

export function interpolate(text, params) {
  if (!params) return text;
  return text.replace(PLACEHOLDER, (match, key) => (
    key in params ? String(params[key]) : match
  ));
}

/** Builds the `t` function for one dictionary. */
export function createT(dict, locale) {
  return function t(key, params) {
    const text = pick(dict && dict[key], locale, params);
    // A missing key shows as the key itself. Blanking the interface would
    // hide the gap; this way it names exactly what is missing and where.
    if (text === null || text === undefined) return key;
    return interpolate(text, params);
  };
}
