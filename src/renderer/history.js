// ---------------------------------------------------------------------------
// Input history
//
// The list is updated instead of built again, so a selection in an entry and
// the `copied` flash on a row survive the next entry arriving. A row is found
// again by its entry's id, which addHistory in main/session-state.js mints.
// ---------------------------------------------------------------------------
import { $, setText, setTitle, makeKeyActivatable, syncChildren } from './dom.js';
import { logWarn } from './log.js';
import { t, locale, onLocaleChange } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { activePanelTab, updateBadges, onPanelTab } from './panel.js';

const historyListEl = $('#history-list');

export function renderHistory(s) {
  syncChildren(historyListEl, histItems(s), buildHistItem, updateHistItem);
}

/** Newest first, the empty notice as one of the rows. */
function histItems(s) {
  if (!s || !s.history.length) return [{ id: 'empty' }];
  return s.history.map((entry) => ({ id: `hist:${entry.id}`, entry })).reverse();
}

function buildHistItem(item) {
  const el = document.createElement('div');
  if (!item.entry) {
    el.className = 'muted';
    return el;
  }
  el.className = 'hist-item';
  el.innerHTML = `
    <span class="hist-time"></span>
    <span class="hist-kind"></span>
    <span class="hist-text"></span>
    <button class="hist-send">↩</button>`;
  makeKeyActivatable(el);
  // An entry never changes after it was sent, so its text is fixed for as long
  // as the row stands. The session is not: it is whichever one is on screen
  // when the button is pressed.
  const text = item.entry.text;
  el.addEventListener('click', async (e) => {
    if (e.target.closest('.hist-send')) return;
    try { await navigator.clipboard.writeText(text); } catch (err) { logWarn('history: entry not copied to the clipboard', { err }); }
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 400);
  });
  el.querySelector('.hist-send').addEventListener('click', () => {
    const s = activeId && sessions.get(activeId);
    if (!s) return;
    window.api.input(s.id, text);
    s.term.focus();
  });
  return el;
}

function updateHistItem(el, item) {
  const entry = item.entry;
  if (!entry) { setText(el, t('history.empty')); return; }

  setText(el.querySelector('.hist-time'),
    new Date(entry.ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }));

  const kindEl = el.querySelector('.hist-kind');
  kindEl.className = `hist-kind ${entry.kind}`;
  setText(kindEl, entry.kind === 'agent' ? '✳' : '$');
  setTitle(kindEl, t(entry.kind === 'agent' ? 'history.agent' : 'history.shell'));

  setText(el.querySelector('.hist-text'), entry.text);
  setTitle(el, t('history.copy') + '\n\n' + entry.text);

  const send = el.querySelector('.hist-send');
  setTitle(send, t('history.send'));
  send.setAttribute('aria-label', t('history.send.aria'));
}

// Opening the tab is what marks the entries as seen.
onPanelTab('history', (s) => {
  if (!s) return;
  s.unseenHist = 0;
  renderHistory(s);
  updateBadges(s);
});

onLocaleChange(() => renderHistory(activeId ? sessions.get(activeId) : null));

window.api.onHistAdd((id, entry) => {
  const s = sessions.get(id);
  if (!s) return;
  s.history.push(entry);
  if (s.history.length > 200) s.history.shift();
  if (id === activeId && activePanelTab === 'history') {
    renderHistory(s);
  } else {
    s.unseenHist = (s.unseenHist || 0) + 1;
    if (id === activeId) updateBadges(s);
  }
});
