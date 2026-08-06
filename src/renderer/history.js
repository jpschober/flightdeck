// ---------------------------------------------------------------------------
// Input history
// ---------------------------------------------------------------------------
import { $, escapeHtml, makeKeyActivatable } from './dom.js';
import { logWarn } from './log.js';
import { t, locale } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { activePanelTab, updateBadges } from './panel.js';

const historyListEl = $('#history-list');

export function renderHistory(s) {
  historyListEl.innerHTML = '';
  if (!s || !s.history.length) {
    historyListEl.innerHTML = `<div class="muted">${escapeHtml(t('history.empty'))}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of [...s.history].reverse()) {
    const el = document.createElement('div');
    el.className = 'hist-item';
    const time = new Date(entry.ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <span class="hist-time">${time}</span>
      <span class="hist-kind ${entry.kind}" title="${escapeHtml(t(entry.kind === 'agent' ? 'history.agent' : 'history.shell'))}">${entry.kind === 'agent' ? '✳' : '$'}</span>
      <span class="hist-text"></span>
      <button class="hist-send" title="${escapeHtml(t('history.send'))}" aria-label="${escapeHtml(t('history.send.aria'))}">↩</button>`;
    el.querySelector('.hist-text').textContent = entry.text;
    el.title = t('history.copy') + '\n\n' + entry.text;
    makeKeyActivatable(el);
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.hist-send')) return;
      try { await navigator.clipboard.writeText(entry.text); } catch (err) { logWarn('history: entry not copied to the clipboard', { err }); }
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 400);
    });
    el.querySelector('.hist-send').addEventListener('click', () => {
      window.api.input(s.id, entry.text);
      s.term.focus();
    });
    frag.appendChild(el);
  }
  historyListEl.appendChild(frag);
}

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
