// ---------------------------------------------------------------------------
// Claude session browser: search, resume and fork old sessions
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { t, locale } from './i18n.js';
import { makeOverlay } from './overlays.js';
import { newSession, defaultShellId } from './terminal.js';

const sessionsOverlay = makeOverlay($('#sessions-overlay'), $('#sessions-close'));
const sessionsListEl = $('#sessions-list');
const sessionsSearchEl = $('#sessions-search');
let claudeSessions = [];

export async function openSessionBrowser() {
  sessionsOverlay.open();
  sessionsListEl.innerHTML = `<div class="muted">${escapeHtml(t('browser.loading'))}</div>`;
  sessionsSearchEl.value = '';
  sessionsSearchEl.focus();
  claudeSessions = await window.api.listClaudeSessions();
  renderClaudeSessions();
}

function renderClaudeSessions() {
  const q = sessionsSearchEl.value.trim().toLowerCase();
  const list = q
    ? claudeSessions.filter((s) =>
        (s.slug || '').toLowerCase().includes(q) ||
        (s.preview || '').toLowerCase().includes(q) ||
        (s.cwd || '').toLowerCase().includes(q))
    : claudeSessions;

  sessionsListEl.innerHTML = '';
  if (!list.length) {
    sessionsListEl.innerHTML = `<div class="muted">${escapeHtml(q ? t('common.noMatches') : t('browser.none'))}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  let lastProject = null;
  for (const cs of list) {
    if (cs.cwd !== lastProject) {
      lastProject = cs.cwd;
      const p = document.createElement('div');
      p.className = 'cs-project';
      p.textContent = cs.cwd;
      frag.appendChild(p);
    }
    const el = document.createElement('div');
    el.className = 'cs-item';
    el.innerHTML = `
      <div class="cs-main">
        <div class="cs-title"></div>
        <div class="cs-preview"></div>
      </div>
      <span class="cs-date"></span>
      <div class="cs-actions">
        <button class="cs-resume">${escapeHtml(t('browser.resume'))}</button>
        <button class="cs-fork" title="${escapeHtml(t('browser.fork.title'))}">${escapeHtml(t('browser.fork'))}</button>
      </div>`;
    el.querySelector('.cs-title').textContent = cs.slug || (cs.preview ? cs.preview.slice(0, 60) : cs.id.slice(0, 8));
    el.querySelector('.cs-preview').textContent = cs.preview || '';
    el.querySelector('.cs-date').textContent = new Date(cs.mtime).toLocaleString(locale, {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const start = (fork) => {
      sessionsOverlay.close();
      newSession(defaultShellId(), {
        cwd: cs.cwd,
        resume: { id: cs.id, fork },
      });
    };
    el.querySelector('.cs-resume').addEventListener('click', () => start(false));
    el.querySelector('.cs-fork').addEventListener('click', () => start(true));
    frag.appendChild(el);
  }
  sessionsListEl.appendChild(frag);
}

sessionsSearchEl.addEventListener('input', renderClaudeSessions);
