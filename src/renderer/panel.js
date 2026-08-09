// ---------------------------------------------------------------------------
// Panel tabs (git / history / notes / DB schema) with badges
//
// Opening a tab costs something in three of the four - a fetch, a rebuild, a
// focus. What that is belongs to the tab, so each one registers it through
// onPanelTab(). This module therefore imports no panel; reaching into them
// from here put it in a ring with all of them.
//
// fitActive() lives here because the zoom is what decides whether a fit is
// allowed at all.
// ---------------------------------------------------------------------------
import { $ } from './dom.js';
import { logDebug } from './log.js';
import { t, onLocaleChange } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { closeUsagePopover } from './usage.js';

const badgeGit = $('#badge-git');
const badgeHistory = $('#badge-history');
const badgeTodos = $('#badge-todos');
export let activePanelTab = 'git';

const tabListeners = new Map(); // tab -> [fn]

/**
 * Register what happens when a tab becomes visible. The handler is called with
 * the active session, and there may be none.
 */
export function onPanelTab(tab, fn) {
  const list = tabListeners.get(tab);
  if (list) list.push(fn);
  else tabListeners.set(tab, [fn]);
}

function setPanelTab(tab) {
  activePanelTab = tab;
  for (const btn of document.querySelectorAll('.panel-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  $('#page-git').classList.toggle('hidden', tab !== 'git');
  $('#page-history').classList.toggle('hidden', tab !== 'history');
  $('#page-todos').classList.toggle('hidden', tab !== 'todos');
  $('#page-dbschema').classList.toggle('hidden', tab !== 'dbschema');
  const s = activeId && sessions.get(activeId);
  for (const fn of tabListeners.get(tab) || []) fn(s);
}

for (const btn of document.querySelectorAll('.panel-tab')) {
  btn.addEventListener('click', () => setPanelTab(btn.dataset.tab));
}

// Enlarging the panel: applies to every tab, because the content does not move
// - only the panel itself is made large. The active tab stays the active one.
const contextPanel = $('#context-panel');
const panelBackdrop = $('#panel-backdrop');
const panelZoomBtn = $('#btn-panel-zoom');
export let panelZoomed = false;
let panelWidth = '';

export function setPanelZoom(on) {
  if (on === panelZoomed) return;
  panelZoomed = on;
  // The popover is anchored to the limit bar, and that bar is about to move.
  closeUsagePopover();
  // The width set via the divider is inline and would otherwise beat `inset`.
  if (on) { panelWidth = contextPanel.style.width; contextPanel.style.width = ''; }
  else contextPanel.style.width = panelWidth;
  contextPanel.classList.toggle('zoomed', on);
  panelBackdrop.classList.toggle('hidden', !on);
  panelZoomBtn.textContent = on ? '⤡' : '⤢';
  panelZoomBtn.title = on ? t('panel.shrink') : t('panel.enlarge');
  // Only fit when shrinking: while the panel is large, the terminal lies
  // underneath it and `#terminal-area` is too wide - a fit would report the
  // wrong size to the PTY and wreck the agent's display.
  if (!on) fitActive();
}

panelZoomBtn.addEventListener('click', () => setPanelZoom(!panelZoomed));
panelBackdrop.addEventListener('click', () => setPanelZoom(false));

onLocaleChange(() => {
  panelZoomBtn.title = panelZoomed ? t('panel.shrink') : t('panel.enlarge');
});

// Fit the active tab's terminal to its area. While the context panel is
// enlarged that area would be wrong - see setPanelZoom().
export function fitActive() {
  if (panelZoomed) return;
  const s = activeId && sessions.get(activeId);
  if (s) { try { s.fit.fit(); } catch (e) { logDebug('terminal: fit failed, pane may still be 0px', { session: s.id, err: e }); } }
}

function setBadge(el, count) {
  el.textContent = count;
  el.classList.toggle('hidden', !count);
}

export function updateBadges(s) {
  setBadge(badgeGit, s ? s.files.length : 0);
  setBadge(badgeHistory, s ? (s.unseenHist || 0) : 0);
  setBadge(badgeTodos, s ? s.todos.filter((t) => !t.done).length : 0);
}
