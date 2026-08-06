// ---------------------------------------------------------------------------
// Panel tabs (git / history / notes / DB schema / usage) with badges
// ---------------------------------------------------------------------------
import { $ } from './dom.js';
import { t } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { fitActive } from './terminal.js';
import { renderHistory } from './history.js';
import { todoInputEl } from './notes.js';
import { loadDbSchema } from './db-schema.js';
import { loadUsage } from './usage.js';

const badgeGit = $('#badge-git');
const badgeHistory = $('#badge-history');
const badgeTodos = $('#badge-todos');
export let activePanelTab = 'git';

function setPanelTab(tab) {
  activePanelTab = tab;
  for (const btn of document.querySelectorAll('.panel-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  $('#page-git').classList.toggle('hidden', tab !== 'git');
  $('#page-history').classList.toggle('hidden', tab !== 'history');
  $('#page-todos').classList.toggle('hidden', tab !== 'todos');
  $('#page-usage').classList.toggle('hidden', tab !== 'usage');
  $('#page-dbschema').classList.toggle('hidden', tab !== 'dbschema');
  const s = activeId && sessions.get(activeId);
  if (tab === 'usage') loadUsage();
  if (tab === 'dbschema') loadDbSchema();
  if (tab === 'history' && s) {
    s.unseenHist = 0;
    renderHistory(s);
    updateBadges(s);
  }
  if (tab === 'todos' && s) todoInputEl.focus();
}

for (const btn of document.querySelectorAll('.panel-tab')) {
  btn.addEventListener('click', () => setPanelTab(btn.dataset.tab));
}

// Enlarging the panel: applies to every tab, because the content does not move
// - only the panel itself is made large. The active tab stays the active one.
const contextPanel = $('#context-panel');
const panelBackdrop = $('#panel-backdrop');
export const panelZoomBtn = $('#btn-panel-zoom');
export let panelZoomed = false;
let panelWidth = '';

export function setPanelZoom(on) {
  if (on === panelZoomed) return;
  panelZoomed = on;
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

function setBadge(el, count) {
  el.textContent = count;
  el.classList.toggle('hidden', !count);
}

export function updateBadges(s) {
  setBadge(badgeGit, s ? s.files.length : 0);
  setBadge(badgeHistory, s ? (s.unseenHist || 0) : 0);
  setBadge(badgeTodos, s ? s.todos.filter((t) => !t.done).length : 0);
}
