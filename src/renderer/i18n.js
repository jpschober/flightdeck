/* global I18nRuntime */
// ---------------------------------------------------------------------------
// Language
//
// The dictionary arrives ready-made from the main process (see preload.js) and
// the plural/placeholder logic is the same runtime the main process uses - the
// renderer only has to know how to reach it.
//
// Switching does not reload the page: the terminals hang off live PTYs in the
// main process, and a reload would drop the whole session list. So the visible
// text is replaced in place instead.
//
// Each panel registers its own redraw through onLocaleChange(), and this module
// imports no panel. Reaching into them from here put the translation layer
// downstream of every feature it serves, and each of those edges came back as
// an import cycle.
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { logWarn } from './log.js';

export let locale = window.api.i18n.locale;
export const locales = window.api.i18n.locales;
export let t = I18nRuntime.createT(window.api.i18n.dict, locale);

const localeListeners = [];

/**
 * Register a redraw for the language switch. Panels that are closed register
 * too - their content is what the badge on the tab counts.
 *
 * The order of registration decides nothing: no handler reads what another one
 * writes.
 */
export function onLocaleChange(fn) {
  localeListeners.push(fn);
}

// index.html carries the English wording so the file reads on its own; these
// attributes say which key takes its place.
export function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  // The hint has two keys inside it. The surrounding text is ours, so the
  // markup can be assembled here - only the keys are substituted, nothing
  // from outside gets in.
  $('#empty-hint').innerHTML = escapeHtml(t('empty.hint', { plus: '\u0000', shortcut: '\u0001' }))
    .replace('\u0000', '<kbd>+</kbd>')
    .replace('\u0001', `<kbd>${escapeHtml(t('key.ctrl'))}</kbd>+<kbd>T</kbd>`);
}

/** Switch the language, then let everything visible draw itself again. */
export async function setLanguage(code) {
  if (code === locale) return;
  const res = await window.api.setLocale(code);
  locale = res.locale;
  t = I18nRuntime.createT(res.dict, locale);
  applyStaticI18n();
  // A panel that throws must not leave the rest standing in the old language.
  await Promise.all(localeListeners.map(async (fn) => {
    try { await fn(); } catch (e) { logWarn('language: a panel did not redraw', { err: e }); }
  }));
}
