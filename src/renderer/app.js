'use strict';
/* global Terminal, FitAddon, WebLinksAddon */

const sessions = new Map(); // id -> { meta..., term, fit, paneEl, itemEl }
let activeId = null;
let shells = [];

const $ = (sel) => document.querySelector(sel);
const sessionListEl = $('#session-list');
const terminalsEl = $('#terminals');
const emptyStateEl = $('#empty-state');
const prCardEl = $('#pr-card');
const fileListEl = $('#file-list');

// Erster Treffer gewinnt. Ohne die Linux-/macOS-Schriften fiel die Liste auf
// das generische `monospace` zurueck - zusammen mit lineHeight 1.25 ergab das
// die zu grossen Zeilenabstaende.
const TERM_FONT = [
  '"Cascadia Code"', '"Cascadia Mono"', '"JetBrains Mono"', '"Fira Code"',
  '"Hack"', '"Source Code Pro"', '"DejaVu Sans Mono"', '"Liberation Mono"',
  '"Noto Sans Mono"', '"Ubuntu Mono"', 'Menlo', 'Consolas', 'monospace',
].join(', ');

// Vollbild-Oberflächen wie Claude schalten die Mausmeldung ein; xterm.js gibt
// Klicks dann an die Anwendung weiter statt zu markieren. Mit gedrückter
// Umschalttaste bleibt die Markierung möglich.
function copySelection(term) {
  const text = term.getSelection();
  if (!text) return false;
  window.api.clipboardWrite(text);
  return true;
}

// term.paste() statt window.api.input(): nur so wird der Text im Bracketed-Paste-
// Modus geklammert. Ohne die Klammern liest Claude jede Zeile eines mehrzeiligen
// Einfuegens als abgeschicktes Kommando.
async function pasteInto(term) {
  const text = await window.api.clipboardRead();
  if (text) term.paste(text);
}

// OSC 52 ist die Bitte des Programms im Terminal, etwas in die Zwischenablage zu
// legen - Claude kopiert genau so ("copied via OSC 52"). xterm.js bringt dafuer
// keinen Handler mit, die Meldung stimmte also, die Zwischenablage blieb leer.
function handleOsc52(term) {
  term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(';') + 1);
    // "?" fragt die Zwischenablage ab. Nicht beantworten: sonst koennte jede
    // Ausgabe im Terminal ihren Inhalt auslesen.
    if (!payload || payload === '?') return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      window.api.clipboardWrite(new TextDecoder().decode(bytes));
    } catch { /* kein gueltiges Base64 */ }
    return true;
  });
}

const TERM_THEME = {
  background: '#101116',
  foreground: '#d6dae3',
  cursor: '#4f8cff',
  cursorAccent: '#101116',
  selectionBackground: 'rgba(79,140,255,0.30)',
  black: '#1b1e27', red: '#e05f6a', green: '#4ec97a', yellow: '#d9a441',
  blue: '#4f8cff', magenta: '#a07bf0', cyan: '#4dc4cd', white: '#d6dae3',
  brightBlack: '#5c6270', brightRed: '#ef8089', brightGreen: '#6fe098',
  brightYellow: '#eec06a', brightBlue: '#7baaff', brightMagenta: '#bb9cf6',
  brightCyan: '#72dde5', brightWhite: '#f2f4f8',
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Element per Tastatur bedienbar machen: Enter/Leertaste = Klick
function makeKeyActivatable(el) {
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  });
}

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ---------------------------------------------------------------------------
// Mini-Markdown-Renderer (PR-Beschreibungen, Agent-Zusammenfassungen).
// Kein externes Paket (CSP) - deckt die von Agenten ueblichen Konstrukte ab.
// ---------------------------------------------------------------------------
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>');
}

function mdToHtml(md) {
  if (!md) return '';
  const esc = escapeHtml(md.replace(/\r\n/g, '\n'));
  // Codeblöcke herauslösen, damit sie nicht weiterverarbeitet werden
  const blocks = [];
  const withoutCode = esc.replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre class="md-code">${code}</pre>`);
    return `\x00${blocks.length - 1}\x00`;
  });

  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };

  for (const line of withoutCode.split('\n')) {
    const t = line.trim();
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    const li = t.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl} class="md-h">${mdInline(h[2])}</h${lvl}>`);
    } else if (li) {
      if (!listOpen) { out.push('<ul class="md-list">'); listOpen = true; }
      const chk = li[1].match(/^\[( |x|X)\]\s+(.*)$/);
      out.push(chk
        ? `<li class="md-task">${chk[1].trim() ? '☑' : '☐'} ${mdInline(chk[2])}</li>`
        : `<li>${mdInline(li[1])}</li>`);
    } else if (t.startsWith('&gt;')) {
      closeList();
      out.push(`<blockquote class="md-quote">${mdInline(t.slice(4).trim())}</blockquote>`);
    } else if (/^([-_*])\1{2,}$/.test(t)) {
      closeList();
      out.push('<hr class="md-hr">');
    } else if (!t) {
      closeList();
    } else {
      closeList();
      out.push(`<p class="md-p">${mdInline(t)}</p>`);
    }
  }
  closeList();
  return out.join('\n').replace(/\x00(\d+)\x00/g, (m, i) => blocks[+i]);
}

// Links in gerendertem Markdown extern oeffnen
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) {
    e.preventDefault();
    window.api.openExternal(a.dataset.url);
  }
});

// ---------------------------------------------------------------------------
// Sessions anlegen / aktivieren / schließen
// ---------------------------------------------------------------------------
async function newSession(shellId, opts) {
  const meta = await window.api.createSession(shellId, opts || {});

  const paneEl = document.createElement('div');
  paneEl.className = 'term-pane inactive';
  terminalsEl.appendChild(paneEl);

  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: 14,
    lineHeight: 1.0,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 8000,
    theme: TERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.api.openExternal(uri)));
  handleOsc52(term);
  term.open(paneEl);

  term.onData((data) => window.api.input(meta.id, data));
  term.onResize(({ cols, rows }) => window.api.resize(meta.id, cols, rows));
  // App-Shortcuts nicht als Steuerzeichen an die Shell durchreichen
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey) return true;
    const k = ev.key.toLowerCase();
    if (!ev.shiftKey && (k === 't' || k === 'g')) return false;
    if (ev.shiftKey && k === 'w') return false;
    // Strg+C ist im Terminal SIGINT, kann also nicht kopieren. Strg+Umschalt+C
    // und Strg+Umschalt+V sind die üblichen Terminal-Entsprechungen.
    // preventDefault(), damit Chromium die Tastenkombination nicht zusaetzlich
    // als eigene auswertet - xterm unterdrueckt bei `false` nur sich selbst.
    if (ev.shiftKey && k === 'c') { ev.preventDefault(); copySelection(term); return false; }
    if (ev.shiftKey && k === 'v') { ev.preventDefault(); pasteInto(term); return false; }
    return true;
  });

  // Rechtsklick: Auswahl kopieren, sonst einfügen - wie in den meisten Terminals
  paneEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) copySelection(term);
    else pasteInto(term);
  });

  const s = {
    id: meta.id,
    shellName: meta.shellName,
    cwd: meta.cwd,
    title: null,
    label: null,
    branch: null,
    files: [],
    pr: null,
    exited: false,
    state: 'idle',
    gitRoot: null,
    agentCwd: null,
    worktree: null,
    history: [],
    unseenHist: 0,
    todoKey: null,
    todos: [],
    term, fit, paneEl,
    itemEl: null,
  };
  sessions.set(meta.id, s);
  s.itemEl = buildSessionItem(s);
  sessionListEl.appendChild(s.itemEl);

  setActive(meta.id);
  return s;
}

function setActive(id) {
  activeId = id;
  for (const s of sessions.values()) {
    const active = s.id === id;
    s.paneEl.classList.toggle('inactive', !active);
    s.itemEl.classList.toggle('active', active);
    if (active) {
      requestAnimationFrame(() => {
        try { s.fit.fit(); } catch { /* Pane evtl. noch 0px */ }
        s.term.focus();
      });
    }
  }
  emptyStateEl.classList.toggle('hidden', sessions.size > 0);
  renderContextPanel();
  const active = id ? sessions.get(id) : null;
  renderHistory(active);
  loadTodosFor(active);
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (gridOpen) closeGrid();
  await window.api.closeSession(id);
  s.term.dispose();
  s.paneEl.remove();
  s.itemEl.remove();
  sessions.delete(id);
  if (activeId === id) {
    const rest = [...sessions.keys()];
    if (rest.length) setActive(rest[rest.length - 1]);
    else {
      activeId = null;
      emptyStateEl.classList.remove('hidden');
      renderContextPanel();
      renderHistory(null);
      renderTodos(null);
    }
  }
}

// ---------------------------------------------------------------------------
// Seitenleiste
// ---------------------------------------------------------------------------
function buildSessionItem(s) {
  const el = document.createElement('div');
  el.className = 'session-item';
  el.dataset.id = s.id;
  el.innerHTML = `
    <div class="si-top">
      <span class="si-status"></span>
      <span class="si-title"></span>
      <span class="si-label hidden"></span>
    </div>
    <div class="si-bottom">
      <span class="si-cwd"></span>
      <span class="si-branch hidden"></span>
    </div>
    <button class="si-close" title="Session schließen" aria-label="Session schließen">✕</button>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.si-close')) return;
    setActive(s.id);
  });
  el.querySelector('.si-close').addEventListener('click', () => closeSession(s.id));
  el.addEventListener('dblclick', (e) => openMetaPopover(s, e));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMetaPopover(s, e); });
  updateSessionItem(s);
  return el;
}

function updateSessionItem(s) {
  const el = s.itemEl;
  if (!el) return;
  el.classList.toggle('exited', s.exited);
  const statusEl = el.querySelector('.si-status');
  const state = s.exited ? 'exited' : (s.state || 'idle');
  statusEl.className = 'si-status ' + state;
  statusEl.title = state === 'busy' ? 'Arbeitet…'
    : state === 'attention' ? 'Eingabe erwartet – du bist dran'
    : state === 'exited' ? 'Beendet' : 'Wartet auf Eingabe';
  el.querySelector('.si-title').textContent =
    s.title || `${basename(s.cwd) || s.shellName}`;
  const labelEl = el.querySelector('.si-label');
  labelEl.classList.toggle('hidden', !s.label);
  labelEl.textContent = s.label || '';
  el.querySelector('.si-cwd').textContent = s.cwd || '';
  el.querySelector('.si-cwd').title = s.cwd || '';
  const branchEl = el.querySelector('.si-branch');
  branchEl.classList.toggle('hidden', !s.branch);
  branchEl.textContent = s.branch || '';
}

// ---------------------------------------------------------------------------
// Rechtes Panel: PR + geänderte Dateien
// ---------------------------------------------------------------------------
function renderContextPanel() {
  const s = activeId ? sessions.get(activeId) : null;
  const wtBannerEl = $('#wt-banner');
  if (!s) {
    prCardEl.innerHTML = '<div class="muted">Keine Session ausgewählt</div>';
    $('#pr-extra').innerHTML = '';
    fileListEl.innerHTML = '';
    wtBannerEl.classList.add('hidden');
    updateBadges(null);
    return;
  }

  // --- Worktree-Hinweis ---
  // Branch und Dateien stammen dann aus dem Verzeichnis des Agenten, nicht
  // aus dem der Shell - ohne Hinweis waere das nicht nachvollziehbar.
  wtBannerEl.classList.toggle('hidden', !s.worktree);
  if (s.worktree) {
    wtBannerEl.innerHTML = `
      <span class="wt-icon">⑂</span>
      <span class="wt-text">Agent arbeitet im Worktree
        <code>${escapeHtml(s.worktree)}</code></span>
      <span class="wt-sub" title="${escapeHtml(s.agentCwd || '')}">Shell: ${escapeHtml(s.cwd)}</span>`;
  }

  // --- PR-Karte ---
  const prExtraEl = $('#pr-extra');
  if (s.pr) {
    const pr = s.pr;
    const stateClass = pr.isDraft ? 'draft' : pr.state.toLowerCase();
    const stateText = pr.isDraft ? 'Draft' : pr.state;
    const checks = pr.checks && pr.checks.total
      ? `<div class="pr-checks">
           ${pr.checks.failure ? `<span class="check-chip failure">✗ ${pr.checks.failure}</span>` : ''}
           ${pr.checks.pending ? `<span class="check-chip pending">● ${pr.checks.pending}</span>` : ''}
           ${pr.checks.success ? `<span class="check-chip success">✓ ${pr.checks.success}</span>` : ''}
         </div>`
      : '';
    prCardEl.innerHTML = `
      <div class="pr-title" title="Im Browser öffnen">#${pr.number} ${escapeHtml(pr.title)}</div>
      <div class="pr-meta">
        <span class="pr-state ${stateClass}">${escapeHtml(stateText)}</span>
        ${pr.author ? `<span>von ${escapeHtml(pr.author)}</span>` : ''}
        ${checks}
      </div>
      <div class="pr-branches">${escapeHtml(pr.headRefName)} → ${escapeHtml(pr.baseRefName)}</div>
      <div class="pr-stats"><span class="add">+${pr.additions ?? 0}</span> <span class="del">−${pr.deletions ?? 0}</span></div>`;
    const prTitleEl = prCardEl.querySelector('.pr-title');
    prTitleEl.setAttribute('role', 'link');
    makeKeyActivatable(prTitleEl);
    prTitleEl.addEventListener('click', () => window.api.openExternal(pr.url));
    renderPrExtra(prExtraEl, pr);
  } else if (s.branch) {
    prCardEl.innerHTML = `<div class="muted">Kein Pull Request für <code>${escapeHtml(s.branch)}</code></div>`;
    prExtraEl.innerHTML = '';
  } else {
    prCardEl.innerHTML = '<div class="muted">Kein Git-Repository</div>';
    prExtraEl.innerHTML = '';
  }

  // --- Dateilisten ---
  fileListEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  // Sobald ein PR existiert, ist dessen Dateiliste die maßgebliche - das
  // lokale Gedächtnis würde sie nur doppeln.
  const hasPr = Boolean(s.pr && s.pr.files && s.pr.files.length);

  if (hasPr) {
    const t = document.createElement('div');
    t.className = 'file-group-title';
    t.textContent = `Im Pull Request (${s.pr.files.length})`;
    frag.appendChild(t);
    for (const f of s.pr.files) {
      frag.appendChild(buildFileItem(s, f, 'pr'));
    }
  } else if (s.files.length) {
    const open = s.files.filter((f) => !f.committed);
    const done = s.files.filter((f) => f.committed);
    if (open.length) {
      const t = document.createElement('div');
      t.className = 'file-group-title';
      t.textContent = 'Arbeitsverzeichnis';
      frag.appendChild(t);
      for (const f of open) frag.appendChild(buildFileItem(s, f, 'wt'));
    }
    if (done.length) {
      const t = document.createElement('div');
      t.className = 'file-group-title';
      t.textContent = `Committet (${done.length})`;
      frag.appendChild(t);
      for (const f of done) frag.appendChild(buildFileItem(s, f, 'wt'));
    }
  }

  if (!frag.childNodes.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = s.branch ? 'Keine Änderungen' : '—';
    frag.appendChild(d);
  }
  fileListEl.appendChild(frag);
  updateBadges(s);
}

// PR-Zusatzsektionen (Beschreibung, Commits, Kommentare) - Aufklappzustand
// ueberlebt die periodischen Re-Renders
const prOpenSections = new Set();

function buildDetails(key, title, innerHtml) {
  const d = document.createElement('details');
  d.className = 'pr-details';
  d.dataset.key = key;
  if (prOpenSections.has(key)) d.open = true;
  d.innerHTML = `<summary>${escapeHtml(title)}</summary><div class="pr-details-body">${innerHtml}</div>`;
  d.addEventListener('toggle', () => {
    if (d.open) prOpenSections.add(key);
    else prOpenSections.delete(key);
  });
  return d;
}

function renderPrExtra(container, pr) {
  container.innerHTML = '';
  const frag = document.createDocumentFragment();

  if (pr.body && pr.body.trim()) {
    frag.appendChild(buildDetails('body', 'Beschreibung', `<div class="md">${mdToHtml(pr.body)}</div>`));
  }

  if (pr.checks && pr.checks.total) {
    const rows = pr.checks.items.map((c) =>
      `<div class="check-row"><span class="check-dot ${c.status}"></span>${escapeHtml(c.name)}</div>`).join('');
    frag.appendChild(buildDetails('checks', `Checks (${pr.checks.success}✓ ${pr.checks.failure}✗ ${pr.checks.pending}●)`, rows));
  }

  if (pr.commits && pr.commits.length) {
    const rows = pr.commits.slice().reverse().map((c) =>
      `<div class="commit-row"><code class="commit-sha">${escapeHtml(c.sha)}</code>${escapeHtml(c.message)}</div>`).join('');
    frag.appendChild(buildDetails('commits', `Commits (${pr.commits.length})`, rows));
  }

  const feedback = [
    ...(pr.reviews || []).map((r) => ({ ...r, kind: 'review', at: r.submittedAt })),
    ...(pr.comments || []).map((c) => ({ ...c, kind: 'comment', at: c.createdAt })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  if (feedback.length) {
    const rows = feedback.map((f) => `
      <div class="fb-row">
        <div class="fb-head">
          <strong>${escapeHtml(f.author || '?')}</strong>
          ${f.kind === 'review' ? `<span class="fb-state ${escapeHtml((f.state || '').toLowerCase())}">${escapeHtml(f.state || '')}</span>` : ''}
          <span class="fb-date">${f.at ? new Date(f.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>
        ${f.body ? `<div class="md">${mdToHtml(f.body)}</div>` : ''}
      </div>`).join('');
    frag.appendChild(buildDetails('feedback', `Kommentare & Reviews (${feedback.length})`, rows));
  }

  container.appendChild(frag);
}

function buildFileItem(s, f, source) {
  const filePath = f.path;
  const isDir = Boolean(f.dir);
  const status = source === 'pr' ? 'M'
    : f.committed ? 'C'
      : f.untracked ? 'U' : f.status;

  const el = document.createElement('div');
  el.className = 'file-item'
    + (f.committed ? ' committed' : '')
    + (isDir ? ' is-dir' : '');
  el.title = isDir
    ? `${filePath} — Verzeichnis, keine Vorschau`
    : filePath;

  const stat = (f.additions !== undefined || f.deletions !== undefined)
    ? `<span class="file-diffstat"><span class="add">+${f.additions ?? 0}</span> <span class="del">−${f.deletions ?? 0}</span></span>`
    : '';
  el.innerHTML = `
    <span class="file-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
    <span class="file-path">&lrm;${escapeHtml(filePath)}&lrm;</span>
    ${stat}`;

  // Verzeichnisse (git meldet sie unversioniert mit Schrägstrich am Ende)
  // sind nicht anklickbar - eine Dateivorschau darauf schlägt zwangsläufig fehl.
  if (!isDir) {
    makeKeyActivatable(el);
    el.addEventListener('click', () => openPreview(s.id, filePath, source));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Eingabe-Verlauf
// ---------------------------------------------------------------------------
const historyListEl = $('#history-list');

function renderHistory(s) {
  historyListEl.innerHTML = '';
  if (!s || !s.history.length) {
    historyListEl.innerHTML = '<div class="muted">Noch keine Eingaben</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of [...s.history].reverse()) {
    const el = document.createElement('div');
    el.className = 'hist-item';
    const time = new Date(entry.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <span class="hist-time">${time}</span>
      <span class="hist-kind ${entry.kind}" title="${entry.kind === 'agent' ? 'Prompt an Agent (z. B. Claude)' : 'Shell-Kommando'}">${entry.kind === 'agent' ? '✳' : '$'}</span>
      <span class="hist-text"></span>
      <button class="hist-send" title="In die Eingabezeile des Terminals einfügen" aria-label="In Terminal einfügen">↩</button>`;
    el.querySelector('.hist-text').textContent = entry.text;
    el.title = 'Klick: kopieren\n\n' + entry.text;
    makeKeyActivatable(el);
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.hist-send')) return;
      try { await navigator.clipboard.writeText(entry.text); } catch { /* egal */ }
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

// ---------------------------------------------------------------------------
// Notizen / TODO (pro Projekt persistiert)
// ---------------------------------------------------------------------------
const todoListEl = $('#todo-list');
const todoInputEl = $('#todo-input');

function renderTodos(s) {
  todoListEl.innerHTML = '';
  const todos = s ? s.todos : [];
  todoInputEl.disabled = !s;
  updateBadges(s);
  if (!todos.length) {
    todoListEl.innerHTML = '<div class="muted">Keine Notizen</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  todos.forEach((t, idx) => {
    const el = document.createElement('div');
    el.className = 'todo-item' + (t.done ? ' done' : '');
    el.innerHTML = `
      <input type="checkbox" ${t.done ? 'checked' : ''} title="Erledigt" />
      <span class="todo-text"></span>
      <button class="todo-del" title="Löschen" aria-label="Notiz löschen">✕</button>`;
    el.querySelector('.todo-text').textContent = t.text;
    el.querySelector('input').addEventListener('change', (e) => {
      s.todos[idx].done = e.target.checked;
      saveTodos(s);
    });
    el.querySelector('.todo-del').addEventListener('click', () => {
      s.todos.splice(idx, 1);
      saveTodos(s);
    });
    frag.appendChild(el);
  });
  todoListEl.appendChild(frag);
}

async function loadTodosFor(s) {
  if (!s) { renderTodos(null); return; }
  const res = await window.api.getTodos(s.id);
  if (!sessions.has(s.id)) return;
  s.todoKey = res.key;
  s.todos = res.todos;
  if (s.id === activeId) renderTodos(s);
}

async function saveTodos(s) {
  await window.api.setTodos(s.id, s.todos);
  if (s.id === activeId) renderTodos(s);
}

todoInputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const s = activeId && sessions.get(activeId);
  const text = todoInputEl.value.trim();
  if (!s || !text) return;
  s.todos.push({ text, done: false, ts: Date.now() });
  todoInputEl.value = '';
  saveTodos(s);
});

window.api.onTodosChanged((key, todos) => {
  // andere Session im selben Projekt hat Notizen geaendert
  for (const s of sessions.values()) {
    if (s.todoKey === key && s.id !== activeId) s.todos = todos;
  }
  const active = activeId && sessions.get(activeId);
  if (active && active.todoKey === key) {
    active.todos = todos;
    renderTodos(active);
  }
});


// ---------------------------------------------------------------------------
// Nutzungslimits des Abos: Ist-Verbrauch, dazu der anteilig erlaubte Stand.
// Nach 3 von 7 Tagen sind 3/7 = 42,9 % das Soll - wer darueber liegt, reisst
// das Limit, wenn das Tempo bleibt.
// ---------------------------------------------------------------------------
const usageContentEl = $('#usage-content');
const dotUsageEl = $('#dot-usage');
let usageTimer = null;

const STATUS_LABEL = {
  ok: 'im Rahmen',
  warn: 'knapp drüber',
  over: 'Limit wird gerissen',
  early: 'zu früh im Fenster',
  unknown: 'keine Daten',
};

function fmtPct(n) {
  if (typeof n !== 'number') return '–';
  return (Math.round(n * 10) / 10).toLocaleString('de-DE') + ' %';
}

// "in 1 h 47" bzw. "in 3 Tagen 5 h"
function fmtUntil(ts) {
  if (!ts) return '';
  let ms = ts - Date.now();
  if (ms <= 0) return 'jetzt';
  const days = Math.floor(ms / 86400000); ms -= days * 86400000;
  const hours = Math.floor(ms / 3600000); ms -= hours * 3600000;
  const mins = Math.floor(ms / 60000);
  if (days) return `in ${days} ${days === 1 ? 'Tag' : 'Tagen'} ${hours} h`;
  if (hours) return `in ${hours} h ${String(mins).padStart(2, '0')}`;
  return `in ${mins} min`;
}

function fmtReset(ts) {
  if (!ts) return 'unbekannt';
  return new Date(ts).toLocaleString('de-DE',
    { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderLimit(title, limit, opts = {}) {
  if (!limit) return '';
  const status = limit.status || 'unknown';
  const used = typeof limit.used === 'number' ? limit.used : 0;
  const budget = typeof limit.budget === 'number' ? limit.budget : null;
  // Soll-Marke nur zeigen, wo sie etwas aussagt (nicht am Fensterrand)
  const showMark = budget !== null && budget > 1 && budget < 99 && !opts.hideMark;

  let verdict = '';
  if (status === 'unknown') {
    verdict = '<div class="uz-note">Keine Daten für dieses Limit.</div>';
  } else if (status === 'early') {
    verdict = `<div class="uz-note">Noch zu früh im Fenster für eine Hochrechnung.
      Erlaubt wären bis jetzt <strong>${fmtPct(budget)}</strong>.</div>`;
  } else {
    const over = used - budget;
    verdict = `<div class="uz-verdict ${status}">
      <span class="uz-target">Erlaubt bis jetzt: <strong>${fmtPct(budget)}</strong></span>
      <span class="uz-delta">${over > 0
        ? `${fmtPct(over)} darüber`
        : `${fmtPct(-over)} Luft`}</span>
      <span class="uz-proj">Hochrechnung Fensterende: <strong>${fmtPct(limit.projected)}</strong></span>
    </div>`;
  }

  return `
    <section class="uz-card ${status}">
      <header class="uz-head">
        <span class="uz-dot ${status}"></span>
        <span class="uz-title">${escapeHtml(title)}</span>
        <span class="uz-status">${STATUS_LABEL[status]}</span>
      </header>
      <div class="uz-bar" role="img" aria-label="${fmtPct(used)} verbraucht">
        <div class="uz-fill ${status}" style="width:${Math.min(used, 100)}%"></div>
        ${showMark ? `<div class="uz-mark" style="left:${budget}%" title="Soll: ${fmtPct(budget)}"></div>` : ''}
      </div>
      <div class="uz-meta">
        <span class="uz-used">${fmtPct(used)} verbraucht</span>
        <span class="uz-reset">Reset ${fmtReset(limit.resetsAt)} · ${fmtUntil(limit.resetsAt)}</span>
      </div>
      ${verdict}
    </section>`;
}

// Schlechtester Status gewinnt - der Punkt am Tab soll das knappste Limit zeigen
const SEVERITY = { unknown: 0, early: 0, ok: 1, warn: 2, over: 3 };

function worstStatus(data) {
  let worst = 'unknown';
  for (const l of [data.fiveHour, data.sevenDay, data.sevenDayOpus]) {
    if (l && SEVERITY[l.status] > SEVERITY[worst]) worst = l.status;
  }
  return worst;
}

async function loadUsage(force = false) {
  // Bewusst ohne Sichtbarkeitspruefung: der Punkt am Tab soll auch dann
  // stimmen, wenn der Tab zu ist. In eine versteckte Seite zu rendern kostet
  // nichts.
  const data = await window.api.getUsage(force);

  if (data.error && !data.stale) {
    usageContentEl.innerHTML = `
      <div class="uz-error">${escapeHtml(data.error)}</div>
      <div class="muted" style="margin-top:8px">Die Zahlen stammen aus deinem
      Claude-Abo (derselbe Stand wie <code>/usage</code>).</div>`;
    dotUsageEl.classList.add('hidden');
    return;
  }

  const parts = [
    renderLimit('5-Stunden-Fenster', data.fiveHour),
    renderLimit('7-Tage-Fenster', data.sevenDay),
    renderLimit('7 Tage · Opus', data.sevenDayOpus),
  ].filter(Boolean);

  if (!parts.length) {
    usageContentEl.innerHTML = '<div class="muted">Keine Limits gemeldet.</div>';
    dotUsageEl.classList.add('hidden');
    return;
  }

  const stamp = new Date(data.fetchedAt).toLocaleTimeString('de-DE',
    { hour: '2-digit', minute: '2-digit' });
  usageContentEl.innerHTML = `
    <div class="uz-top">
      ${data.plan ? `<span class="uz-plan">${escapeHtml(data.plan)}</span>` : '<span></span>'}
      <button id="usage-refresh" class="icon-btn" title="Jetzt aktualisieren" aria-label="Aktualisieren">↻</button>
      <span class="uz-stamp">Stand ${stamp}${data.stale ? ' · veraltet' : ''}</span>
    </div>
    ${data.stale ? `<div class="uz-error">${escapeHtml(data.error)}</div>` : ''}
    ${parts.join('')}
    <div class="uz-legend">Der Strich in der Leiste markiert, wie viel zum
    jetzigen Zeitpunkt verbraucht sein dürfte, wenn das Kontingent gleichmäßig
    über das Fenster reichen soll.</div>`;
  usageContentEl.querySelector('#usage-refresh')
    .addEventListener('click', () => loadUsage(true));

  const worst = worstStatus(data);
  dotUsageEl.className = 'tab-dot ' + worst;
  dotUsageEl.classList.toggle('hidden', worst !== 'warn' && worst !== 'over');
}

// Im Hintergrund mitlaufen, damit der Punkt am Tab stimmt, ohne dass man
// den Tab offen haben muss
function startUsagePolling() {
  loadUsage(true).catch(() => { /* offline o. ae. */ });
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    loadUsage().catch(() => { /* egal */ });
  }, 120_000);
}

// ---------------------------------------------------------------------------
// Panel-Tabs (Git / Report / Nutzung / Verlauf / Notizen) mit Badges
// ---------------------------------------------------------------------------
const badgeGit = $('#badge-git');
const badgeHistory = $('#badge-history');
const badgeTodos = $('#badge-todos');
let activePanelTab = 'git';

function setPanelTab(tab) {
  activePanelTab = tab;
  for (const btn of document.querySelectorAll('.panel-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  $('#page-git').classList.toggle('hidden', tab !== 'git');
  $('#page-history').classList.toggle('hidden', tab !== 'history');
  $('#page-todos').classList.toggle('hidden', tab !== 'todos');
  $('#page-usage').classList.toggle('hidden', tab !== 'usage');
  const s = activeId && sessions.get(activeId);
  if (tab === 'usage') loadUsage();
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

function setBadge(el, count) {
  el.textContent = count;
  el.classList.toggle('hidden', !count);
}

function updateBadges(s) {
  setBadge(badgeGit, s ? s.files.length : 0);
  setBadge(badgeHistory, s ? (s.unseenHist || 0) : 0);
  setBadge(badgeTodos, s ? s.todos.filter((t) => !t.done).length : 0);
}

// ---------------------------------------------------------------------------
// Datei-Vorschau
// ---------------------------------------------------------------------------
const previewOverlay = $('#preview-overlay');
const previewTitle = $('#preview-title');
const previewContent = $('#preview-content');

const previewModesEl = $('#preview-modes');
const MD_EXT = /\.(md|markdown|mdx)$/i;
let previewState = null; // { sessionId, filePath, source, mode, cache }

function highlightDiff(text) {
  return text.split('\n').map((line) => {
    const esc = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return `<span class="dl-meta">${esc}</span>`;
    }
    if (line.startsWith('@@')) return `<span class="dl-hunk">${esc}</span>`;
    if (line.startsWith('+')) return `<span class="dl-add">${esc}</span>`;
    if (line.startsWith('-')) return `<span class="dl-del">${esc}</span>`;
    return esc;
  }).join('\n');
}

// Holt eine Ansicht und merkt sie sich - der Wechsel zwischen den Modi soll
// nicht jedes Mal neu über IPC gehen.
async function fetchPreview(wantContent) {
  const key = wantContent ? 'content' : 'default';
  if (previewState.cache[key]) return previewState.cache[key];
  const res = await window.api.previewFile(
    previewState.sessionId, previewState.filePath, previewState.source,
    wantContent ? { content: true } : undefined,
  );
  previewState.cache[key] = res;
  return res;
}

async function renderPreview() {
  const st = previewState;
  // Die formatierte Ansicht braucht den Dateiinhalt, nicht den Diff
  const res = await fetchPreview(st.mode === 'md');
  if (previewState !== st) return; // inzwischen andere Datei geöffnet

  if (res.kind === 'error') {
    previewContent.innerHTML = `<pre class="pv-pre">${escapeHtml(res.text)}</pre>`;
    return;
  }
  if (st.mode === 'md') {
    previewContent.innerHTML = `<div class="pv-md md">${mdToHtml(res.text)}</div>`;
  } else if (res.kind === 'diff') {
    previewContent.innerHTML = `<pre class="pv-pre">${highlightDiff(res.text)}</pre>`;
  } else {
    previewContent.innerHTML = `<pre class="pv-pre">${escapeHtml(res.text)}</pre>`;
  }
  previewContent.scrollTop = 0;
}

function renderPreviewModes(hasDiff) {
  const modes = [];
  if (hasDiff) modes.push({ id: 'diff', label: 'Diff' });
  modes.push({ id: 'raw', label: hasDiff ? 'Datei' : 'Quelltext' });
  if (MD_EXT.test(previewState.filePath)) modes.push({ id: 'md', label: 'Formatiert' });

  previewModesEl.innerHTML = '';
  if (modes.length < 2) return; // nichts umzuschalten
  for (const m of modes) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.className = m.id === previewState.mode ? 'active' : '';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      if (previewState.mode === m.id) return;
      previewState.mode = m.id;
      renderPreviewModes(hasDiff);
      renderPreview();
    });
    previewModesEl.appendChild(b);
  }
}

async function openPreview(sessionId, filePath, source) {
  previewTitle.textContent = filePath + ' (lädt…)';
  previewContent.innerHTML = '';
  previewModesEl.innerHTML = '';
  previewOverlay.classList.remove('hidden');

  previewState = { sessionId, filePath, source, mode: 'diff', cache: {} };
  const st = previewState;

  const first = await fetchPreview(false);
  if (previewState !== st) return;
  previewTitle.textContent = first.path;

  const hasDiff = first.kind === 'diff';
  // Markdown ohne Diff gleich formatiert zeigen - dafür öffnet man es meistens
  st.mode = hasDiff ? 'diff' : (MD_EXT.test(filePath) ? 'md' : 'raw');
  renderPreviewModes(hasDiff);
  await renderPreview();
}

function closePreview() {
  previewOverlay.classList.add('hidden');
  const s = activeId && sessions.get(activeId);
  if (s) s.term.focus();
}
$('#preview-close').addEventListener('click', closePreview);
previewOverlay.addEventListener('click', (e) => { if (e.target === previewOverlay) closePreview(); });

// ---------------------------------------------------------------------------
// Meta-Popover: Titel & Label bearbeiten
// ---------------------------------------------------------------------------
const metaPopover = $('#meta-popover');
const metaTitleInput = $('#meta-title');
const metaLabelInput = $('#meta-label');
let metaSessionId = null;

function openMetaPopover(s, ev) {
  metaSessionId = s.id;
  metaTitleInput.value = s.title || '';
  metaLabelInput.value = s.label || '';
  metaPopover.classList.remove('hidden');
  const x = Math.min(ev.clientX, window.innerWidth - 260);
  const y = Math.min(ev.clientY, window.innerHeight - 180);
  metaPopover.style.left = x + 'px';
  metaPopover.style.top = y + 'px';
  metaTitleInput.focus();
}

function closeMetaPopover() {
  metaPopover.classList.add('hidden');
  metaSessionId = null;
}

$('#meta-save').addEventListener('click', async () => {
  const s = sessions.get(metaSessionId);
  if (s) {
    s.title = metaTitleInput.value.trim() || null;
    s.label = metaLabelInput.value.trim() || null;
    await window.api.setMeta(s.id, { title: s.title, label: s.label });
    updateSessionItem(s);
  }
  closeMetaPopover();
});
$('#meta-cancel').addEventListener('click', closeMetaPopover);
metaPopover.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#meta-save').click();
  if (e.key === 'Escape') closeMetaPopover();
});

// ---------------------------------------------------------------------------
// Neue-Session-Buttons + Shell-Menü
// ---------------------------------------------------------------------------
const shellMenu = $('#shell-menu');

$('#btn-new').addEventListener('click', () => newSession(shells[0] && shells[0].id));
$('#btn-new-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  shellMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.new-session-wrap')) shellMenu.classList.add('hidden');
  if (!e.target.closest('#meta-popover') && !e.target.closest('.session-item')) closeMetaPopover();
});

function buildShellMenu() {
  shellMenu.innerHTML = '';
  for (const sh of shells) {
    const b = document.createElement('button');
    b.textContent = sh.name;
    b.addEventListener('click', () => {
      shellMenu.classList.add('hidden');
      newSession(sh.id);
    });
    shellMenu.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Grid-Übersicht: alle Sessions als Live-Kacheln
// ---------------------------------------------------------------------------
const gridViewEl = $('#grid-view');
const gridContainerEl = $('#grid-container');
const gridCards = new Map(); // sessionId -> { term, statusEl }
let gridOpen = false;

function openGrid() {
  if (gridOpen || sessions.size === 0) return;
  gridOpen = true;
  gridContainerEl.innerHTML = '';
  gridViewEl.classList.remove('hidden');

  for (const s of sessions.values()) {
    const card = document.createElement('div');
    card.className = 'grid-card';
    card.innerHTML = `
      <div class="grid-card-header">
        <span class="si-status"></span>
        <span class="gc-title"></span>
        <span class="gc-branch hidden"></span>
      </div>
      <div class="grid-card-term"></div>`;
    card.querySelector('.gc-title').textContent = s.title || basename(s.cwd) || s.shellName;
    const branchEl = card.querySelector('.gc-branch');
    branchEl.classList.toggle('hidden', !s.branch);
    branchEl.textContent = s.branch || '';
    const statusEl = card.querySelector('.si-status');
    statusEl.className = 'si-status ' + (s.exited ? 'exited' : (s.state || 'idle'));
    card.addEventListener('click', () => { closeGrid(); setActive(s.id); });
    makeKeyActivatable(card);
    gridContainerEl.appendChild(card);

    // Read-only-Miniatur: gleiche Spalten/Zeilen wie das echte Terminal,
    // kleine Schrift - die PTY-Groesse bleibt unangetastet
    const mini = new Terminal({
      cols: s.term.cols,
      rows: s.term.rows,
      fontSize: 7,
      fontFamily: TERM_FONT,
      lineHeight: 1.0,
      theme: TERM_THEME,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 50,
    });
    mini.open(card.querySelector('.grid-card-term'));
    gridCards.set(s.id, { term: mini, statusEl });
    window.api.getBuffer(s.id).then((buf) => {
      const entry = gridCards.get(s.id);
      if (entry && entry.term === mini && buf) mini.write(buf);
    });
  }
}

function closeGrid() {
  if (!gridOpen) return;
  gridOpen = false;
  gridViewEl.classList.add('hidden');
  for (const { term } of gridCards.values()) term.dispose();
  gridCards.clear();
  const s = activeId && sessions.get(activeId);
  if (s) s.term.focus();
}

function toggleGrid() { gridOpen ? closeGrid() : openGrid(); }
$('#btn-grid').addEventListener('click', toggleGrid);

// ---------------------------------------------------------------------------
// Claude-Session-Browser: alte Sessions durchsuchen, fortsetzen, forken
// ---------------------------------------------------------------------------
const sessionsOverlay = $('#sessions-overlay');
const sessionsListEl = $('#sessions-list');
const sessionsSearchEl = $('#sessions-search');
let claudeSessions = [];

async function openSessionBrowser() {
  sessionsOverlay.classList.remove('hidden');
  sessionsListEl.innerHTML = '<div class="muted">Lade Sessions…</div>';
  sessionsSearchEl.value = '';
  sessionsSearchEl.focus();
  claudeSessions = await window.api.listClaudeSessions();
  renderClaudeSessions();
}

function closeSessionBrowser() {
  sessionsOverlay.classList.add('hidden');
  const s = activeId && sessions.get(activeId);
  if (s) s.term.focus();
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
    sessionsListEl.innerHTML = `<div class="muted">${q ? 'Keine Treffer' : 'Keine Claude-Sessions gefunden'}</div>`;
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
        <button class="cs-resume">Fortsetzen</button>
        <button class="cs-fork" title="Als neue Session abzweigen">Fork</button>
      </div>`;
    el.querySelector('.cs-title').textContent = cs.slug || (cs.preview ? cs.preview.slice(0, 60) : cs.id.slice(0, 8));
    el.querySelector('.cs-preview').textContent = cs.preview || '';
    el.querySelector('.cs-date').textContent = new Date(cs.mtime).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const start = (fork) => {
      closeSessionBrowser();
      newSession(shells[0] && shells[0].id, {
        cwd: cs.cwd,
        runCommand: `claude --resume ${cs.id}${fork ? ' --fork-session' : ''}`,
      });
    };
    el.querySelector('.cs-resume').addEventListener('click', () => start(false));
    el.querySelector('.cs-fork').addEventListener('click', () => start(true));
    frag.appendChild(el);
  }
  sessionsListEl.appendChild(frag);
}

$('#btn-claude-sessions').addEventListener('click', openSessionBrowser);
$('#sessions-close').addEventListener('click', closeSessionBrowser);
sessionsSearchEl.addEventListener('input', renderClaudeSessions);
sessionsOverlay.addEventListener('click', (e) => { if (e.target === sessionsOverlay) closeSessionBrowser(); });

// ---------------------------------------------------------------------------
// Desktop-Benachrichtigungen: wenn ein Agent Aufmerksamkeit braucht
// ---------------------------------------------------------------------------
const NOTIFY_COOLDOWN_MS = 8000;

function maybeNotify(s, body) {
  // Nur wenn man es nicht ohnehin vor Augen hat
  if (document.hasFocus() && s.id === activeId) return;
  const now = Date.now();
  if (now - (s.lastNotifyAt || 0) < NOTIFY_COOLDOWN_MS) return;
  s.lastNotifyAt = now;
  const title = s.title || basename(s.cwd) || s.shellName;
  const n = new Notification(`Flightdeck – ${title}`, { body, silent: false });
  n.onclick = () => {
    window.api.focusWindow();
    setActive(s.id);
  };
}

window.api.onNotify((id, message) => {
  const s = sessions.get(id);
  if (s) maybeNotify(s, message);
});

// ---------------------------------------------------------------------------
// Events aus dem Main-Prozess
// ---------------------------------------------------------------------------
window.api.onData((id, data) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
  const gridEntry = gridCards.get(id);
  if (gridEntry) gridEntry.term.write(data);
});

window.api.onState((id, state) => {
  const s = sessions.get(id);
  if (!s) return;
  const prev = s.state;
  s.state = state;
  updateSessionItem(s);
  const gridEntry = gridCards.get(id);
  if (gridEntry) gridEntry.statusEl.className = 'si-status ' + (s.exited ? 'exited' : state);
  if (state === 'attention' && prev !== 'attention') {
    maybeNotify(s, 'Wartet auf deine Eingabe');
  }
});

window.api.onExit((id) => {
  const s = sessions.get(id);
  if (!s) return;
  s.exited = true;
  s.term.write('\r\n\x1b[90m[Prozess beendet]\x1b[0m\r\n');
  updateSessionItem(s);
});

window.api.onInfo((info) => {
  const s = sessions.get(info.id);
  if (!s) return;
  const rootChanged = s.gitRoot !== info.gitRoot;
  Object.assign(s, {
    cwd: info.cwd,
    branch: info.branch,
    gitRoot: info.gitRoot,
    agentCwd: info.agentCwd,
    worktree: info.worktree,
    files: info.files,
    pr: info.pr,
    title: info.title,
    label: info.label,
    state: info.state,
  });
  updateSessionItem(s);
  if (rootChanged) loadTodosFor(s); // anderes Projekt -> dessen Notizen laden
  if (info.id === activeId) renderContextPanel();
});

// ---------------------------------------------------------------------------
// Layout: Panels per Trenner skalieren, Terminal-Fit bei Resize
// ---------------------------------------------------------------------------
function setupDivider(dividerEl, panelEl, growsRight) {
  dividerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dividerEl.classList.add('dragging');
    const startX = e.clientX;
    const startW = panelEl.getBoundingClientRect().width;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      panelEl.style.width = (growsRight ? startW + dx : startW - dx) + 'px';
      const s = activeId && sessions.get(activeId);
      if (s) { try { s.fit.fit(); } catch { /* ignorieren */ } }
    };
    const onUp = () => {
      dividerEl.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}
setupDivider($('#divider-left'), $('#sidebar'), true);
setupDivider($('#divider-right'), $('#context-panel'), false);

window.addEventListener('resize', () => {
  const s = activeId && sessions.get(activeId);
  if (s) { try { s.fit.fit(); } catch { /* ignorieren */ } }
});

// Tastenkürzel
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    newSession(shells[0] && shells[0].id);
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w' && activeId) {
    e.preventDefault();
    closeSession(activeId);
  }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    toggleGrid();
  }
  if (e.key === 'Escape') {
    if (!previewOverlay.classList.contains('hidden')) closePreview();
    else if (!sessionsOverlay.classList.contains('hidden')) closeSessionBrowser();
    else if (gridOpen) closeGrid();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function init() {
  shells = await window.api.listShells();
  buildShellMenu();
  await newSession(shells[0] && shells[0].id);
  startUsagePolling();
})();
