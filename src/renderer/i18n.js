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
// text is replaced in place instead - see retranslate(). That pass touches
// every panel, which is why this module imports them all.
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { logWarn } from './log.js';
import { sessions, activeId } from './sessions.js';
import { updateSessionItem } from './terminal.js';
import { buildMoreMenu, buildShellMenu } from './menus.js';
import { panelZoomBtn, panelZoomed } from './panel.js';
import { renderContextPanel } from './git-panel.js';
import { renderHistory } from './history.js';
import { renderTodos } from './notes.js';
import { dbState, loadDbSchema } from './db-schema.js';
import { loadUsage } from './usage.js';
import { previewOverlay, previewState, renderPreviewModes, renderPreview } from './preview.js';

export let locale = window.api.i18n.locale;
export const locales = window.api.i18n.locales;
export let t = I18nRuntime.createT(window.api.i18n.dict, locale);

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

/**
 * Everything visible, again in the new language. Panels that are closed are
 * rebuilt too - their content is what the badge on the tab counts.
 */
export async function retranslate() {
  applyStaticI18n();
  for (const s of sessions.values()) updateSessionItem(s);
  buildMoreMenu();
  buildShellMenu();
  panelZoomBtn.title = panelZoomed ? t('panel.shrink') : t('panel.enlarge');

  const active = activeId ? sessions.get(activeId) : null;
  renderContextPanel();
  renderHistory(active);
  renderTodos(active);
  // The main process builds the schema warnings and baseline labels itself and
  // has just dropped its cache - so this has to go out again, not come from
  // the renderer's own copy.
  dbState.lastJson = '';
  await Promise.all([
    loadDbSchema(true).catch((e) => logWarn('retranslate: db schema not reloaded', { err: e })),
    loadUsage(true).catch((e) => logWarn('retranslate: usage not reloaded', { err: e })),
  ]);
  if (previewOverlay.isOpen() && previewState) {
    renderPreviewModes(Boolean(previewState.cache.default
      && previewState.cache.default.kind === 'diff'));
    renderPreview();
  }
}

export async function setLanguage(code) {
  if (code === locale) return;
  const res = await window.api.setLocale(code);
  locale = res.locale;
  t = I18nRuntime.createT(res.dict, locale);
  await retranslate();
}
