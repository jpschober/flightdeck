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
  // Anderes Projekt, anderes Schema - der aufgeklappte Zustand passt nicht mehr
  dbState.lastJson = '';
  dbState.open.clear();
  dbState.closed.clear();
  loadDbSchema();
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
      dbState.view = null;
      dbState.lastJson = '';
      renderDbPanel();
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
      <span class="si-agents hidden"></span>
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
  updateAgentChip(el.querySelector('.si-agents'), s.agents);
  el.querySelector('.si-cwd').textContent = s.cwd || '';
  el.querySelector('.si-cwd').title = s.cwd || '';
  const branchEl = el.querySelector('.si-branch');
  branchEl.classList.toggle('hidden', !s.branch);
  branchEl.textContent = s.branch || '';
}

// Wie viele Agenten arbeiten in dieser Session? Der Chip erscheint nur, wenn
// gerade welche laufen — eine dauerhafte „0" wäre Ballast in einer Liste, die
// man im Vorbeigehen liest.
function updateAgentChip(el, agents) {
  if (!el) return;
  const n = agents ? agents.running : 0;
  el.classList.toggle('hidden', !n);
  if (!n) { el.textContent = ''; el.title = ''; return; }
  el.textContent = `✈ ${n}`;
  const lines = agents.agents.map((a) => {
    const what = a.description || a.type || a.id.slice(0, 8);
    return `• ${what}${a.worktree ? ` (⑂ ${a.worktree})` : ''}`;
  });
  el.title = [`${n} ${n === 1 ? 'Agent arbeitet' : 'Agenten arbeiten'}`, ...lines].join('\n');
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
// DB-Schema
//
// Der Main-Prozess liefert einen fertigen Stand: erkanntes Plugin, aktuelles
// Schema im standardisierten Format, die Vergleichsbasis und den Diff. Hier
// wird das nur noch dargestellt.
//
// Bewusst als Tabellenkarten und nicht als ER-Diagramm: gefragt sind Spalten,
// Typen und Constraints, und die stehen in einem Diagrammkasten entweder nicht
// drin oder unleserlich klein. Vor allem aber laesst sich ein Diagramm nicht
// sinnvoll zeilenweise vergleichen - genau das braucht die Vorher/Nachher-
// Ansicht. Beziehungen zeigen die Fremdschlüssel im Klartext mitsamt Ziel.
// ---------------------------------------------------------------------------
const dbHeadEl = $('#db-head');
const dbSignalEl = $('#db-signal');
const dbTablesEl = $('#db-tables');
const dbSearchEl = $('#db-search');
const badgeDbEl = $('#badge-dbschema');

const dbState = {
  sessionId: null,
  view: null,
  baseline: 'auto',
  filter: '',
  // Aufgeklappt bzw. bewusst zugeklappt - beides muss den Neuaufbau ueberleben,
  // sonst springt eine von Hand geschlossene Tabelle beim naechsten Takt wieder auf.
  open: new Set(),
  closed: new Set(),
  lastJson: '',
  loading: false,
};
let dbTimer = null;

const STATUS_MARK = { added: '+', removed: '−', changed: '~', same: '' };
const STATUS_WORD = { added: 'neu', removed: 'entfernt', changed: 'geändert', same: '' };

// Kurzzeichen fuer die Constraints, die eine Spalte betreffen
const KIND_TAG = {
  pk: { tag: 'PK', title: 'Primärschlüssel' },
  fk: { tag: 'FK', title: 'Fremdschlüssel' },
  unique: { tag: 'UQ', title: 'eindeutig' },
  check: { tag: 'CK', title: 'Prüfbedingung' },
  index: { tag: 'IX', title: 'Index' },
  exclude: { tag: 'EX', title: 'Exclusion-Constraint' },
};

function fmtDefault(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** Die Zusatzangaben einer Spalte in der Reihenfolge, in der man sie liest. */
function colMeta(col) {
  const out = [];
  if (!col.nullable) out.push('NOT NULL');
  if (col.identity) out.push('identity');
  if (col.generated) out.push('berechnet');
  if (col.default) out.push('= ' + fmtDefault(col.default));
  return out;
}

function constraintText(c) {
  const cols = (c.columns || []).join(', ');
  if (c.kind === 'fk' && c.references) {
    const r = c.references;
    const target = `${r.schema}.${r.table}${r.columns.length ? `(${r.columns.join(', ')})` : ''}`;
    const actions = [
      c.onDelete ? `on delete ${c.onDelete}` : '',
      c.onUpdate ? `on update ${c.onUpdate}` : '',
    ].filter(Boolean).join(' ');
    return `(${cols}) → ${target}${actions ? ' ' + actions : ''}`;
  }
  if (c.kind === 'check' || c.kind === 'exclude') return c.expression || '';
  if (c.kind === 'index') {
    return `${c.unique ? 'unique ' : ''}(${cols})${c.method ? ' using ' + c.method : ''}`
      + `${c.expression ? ' where ' + c.expression : ''}`;
  }
  return `(${cols})`;
}

function policyText(p) {
  const bits = [p.command];
  if (!p.permissive) bits.push('restrictive');
  if (p.roles && p.roles.length) bits.push('für ' + p.roles.join(', '));
  if (p.using) bits.push('using ' + p.using);
  if (p.check) bits.push('check ' + p.check);
  return bits.join(' · ');
}

/** Welche Constraints betreffen diese Spalte? */
function tagsForColumn(table, colName) {
  const kinds = new Set();
  for (const c of table.constraints || []) {
    if ((c.columns || []).includes(colName)) kinds.add(c.kind);
  }
  return [...kinds]
    .filter((k) => KIND_TAG[k])
    .sort((a, b) => Object.keys(KIND_TAG).indexOf(a) - Object.keys(KIND_TAG).indexOf(b))
    .map((k) => KIND_TAG[k]);
}

function tagsHtml(tags) {
  return tags.map((t) => `<span class="db-tag ${t.tag.toLowerCase()}" title="${escapeHtml(t.title)}">${t.tag}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------
async function loadDbSchema(force = false) {
  const s = activeId && sessions.get(activeId);
  if (!s) {
    dbState.view = null;
    dbState.lastJson = '';
    renderDbPanel();
    return;
  }
  if (dbState.loading && !force) return;
  dbState.loading = true;
  try {
    const view = await window.api.getDbSchema(s.id, { baseline: dbState.baseline, force });
    if (s.id !== activeId) return; // inzwischen umgeschaltet
    // Unveraendert? Dann nicht neu aufbauen - sonst springt die Scrollposition
    // bei jedem Takt des Hintergrund-Abrufs.
    const json = JSON.stringify(view);
    if (json === dbState.lastJson) return;
    dbState.lastJson = json;
    dbState.view = view;
    dbState.sessionId = s.id;
    renderDbPanel();
    if (!dbDiffOverlay.classList.contains('hidden')) renderDbDiff();
  } catch {
    /* Session weg o. ae. */
  } finally {
    dbState.loading = false;
  }
}

function setDbBadge(count) {
  badgeDbEl.textContent = count > 99 ? '99+' : String(count);
  badgeDbEl.classList.toggle('hidden', !count);
  badgeDbEl.classList.toggle('alert', Boolean(count));
}

// Im Hintergrund mitlaufen, damit das Zeichen am Tab stimmt, ohne dass man den
// Tab offen haben muss - eine Schemaaenderung soll auffallen, nicht gesucht
// werden. Der Senser liefert aus dem Cache, solange sich keine Datei ruehrt.
function startDbPolling() {
  clearInterval(dbTimer);
  dbTimer = setInterval(() => { loadDbSchema().catch(() => {}); }, 10_000);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function renderDbPanel() {
  const view = dbState.view;

  if (!view || !view.ok) {
    dbHeadEl.innerHTML = '';
    dbSignalEl.innerHTML = '';
    dbSearchEl.classList.add('hidden');
    dbTablesEl.innerHTML = `<div class="muted">${view && view.error
      ? escapeHtml(view.error) : 'Keine Session ausgewählt'}</div>`;
    setDbBadge(0);
    return;
  }

  if (!view.plugin) {
    dbHeadEl.innerHTML = '';
    dbSignalEl.innerHTML = '';
    dbSearchEl.classList.add('hidden');
    dbTablesEl.innerHTML = `
      <div class="muted">Kein DB-Schema erkannt.</div>
      <div class="db-hint">Kein Plugin fühlt sich für
        <code>${escapeHtml(view.project || view.root || '')}</code> zuständig.
        Erkannt werden derzeit Supabase-Projekte
        (<code>supabase/migrations</code>).</div>`;
    setDbBadge(0);
    return;
  }

  renderDbHead(view);
  renderDbSignal(view);
  dbSearchEl.classList.remove('hidden');
  renderDbTables(view);
  setDbBadge(view.changeCount || 0);
}

function renderDbHead(view) {
  const files = view.schema.files.length;
  const baseSel = view.baselines.length
    ? `<label class="db-base">Basis
         <select id="db-baseline">
           ${view.baselines.map((b) => `<option value="${escapeHtml(b.mode)}"${
             view.baseline && view.baseline.mode === b.mode ? ' selected' : ''
           } title="${escapeHtml(b.hint || '')}">${escapeHtml(b.label)}</option>`).join('')}
         </select>
       </label>`
    : '<span class="muted">kein Git-Stand zum Vergleichen</span>';

  dbHeadEl.innerHTML = `
    <div class="db-top">
      <span class="db-plugin" title="${escapeHtml((view.plugin.evidence || []).join('\n'))}">${escapeHtml(view.plugin.label)}</span>
      <span class="db-files">${view.schema.tables.length} Tabellen · ${files} ${files === 1 ? 'Datei' : 'Dateien'}</span>
      <button id="db-refresh" class="icon-btn" title="Neu einlesen" aria-label="Neu einlesen">↻</button>
    </div>
    <div class="db-baseline-row">${baseSel}</div>
    ${view.schema.warnings.length ? `
      <details class="db-warn">
        <summary>${view.schema.warnings.length} Hinweis${view.schema.warnings.length === 1 ? '' : 'e'} beim Einlesen</summary>
        <ul>${view.schema.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      </details>` : ''}`;

  dbHeadEl.querySelector('#db-refresh').addEventListener('click', () => loadDbSchema(true));
  const sel = dbHeadEl.querySelector('#db-baseline');
  if (sel) {
    sel.addEventListener('change', () => {
      dbState.baseline = sel.value;
      dbState.lastJson = '';
      loadDbSchema(true);
    });
  }
}

function renderDbSignal(view) {
  const d = view.diff;
  if (!d) {
    dbSignalEl.innerHTML = '';
    return;
  }
  if (!d.changed) {
    dbSignalEl.innerHTML = `<div class="db-signal ok">
      <span class="db-signal-icon">✓</span>
      <span>Schema unverändert gegenüber <strong>${escapeHtml(view.baseline.label)}</strong></span>
    </div>`;
    return;
  }
  const s = d.summary;
  const detail = [
    partsText(s.columns, 'Spalte', 'Spalten'),
    partsText(s.constraints, 'Constraint', 'Constraints'),
    partsText(s.policies, 'Policy', 'Policies'),
  ].filter(Boolean).join(' · ');

  dbSignalEl.innerHTML = `<div class="db-signal alert">
    <span class="db-signal-icon">⚠</span>
    <div class="db-signal-text">
      <strong>Schema geändert</strong> gegenüber ${escapeHtml(view.baseline.label)}
      <div class="db-signal-sub">${escapeHtml(view.changeText)}${detail ? '<br>' + detail : ''}</div>
    </div>
    <button id="db-open-diff" title="Vorher und Nachher nebeneinander">Vergleichen</button>
  </div>`;
  dbSignalEl.querySelector('#db-open-diff').addEventListener('click', openDbDiff);
}

function partsText(counts, one, many) {
  const bits = [];
  if (counts.added) bits.push(`${counts.added} neu`);
  if (counts.removed) bits.push(`${counts.removed} entfernt`);
  if (counts.changed) bits.push(`${counts.changed} geändert`);
  if (!bits.length) return '';
  const total = counts.added + counts.removed + counts.changed;
  return `${total === 1 ? one : many}: ${bits.join(', ')}`;
}

/** Diff-Status je Tabelle/Spalte/Constraint nachschlagbar machen. */
function diffLookup(view) {
  const tables = new Map();
  if (!view.diff) return tables;
  for (const t of view.diff.tables) {
    tables.set(t.id, {
      status: t.status,
      rlsChanged: t.rlsChanged,
      columns: new Map(t.columns.map((c) => [c.name, c])),
      constraints: new Map(t.constraints.map((c) => [c.name, c])),
      policies: new Map(t.policies.map((p) => [p.name, p])),
    });
  }
  return tables;
}

function renderDbTables(view) {
  const q = dbState.filter.trim().toLowerCase();
  const look = diffLookup(view);
  dbTablesEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  // --- Enums ---
  const enums = view.schema.enums.filter((e) => !q
    || e.name.toLowerCase().includes(q)
    || e.values.some((v) => v.toLowerCase().includes(q)));
  if (enums.length) {
    const enumDiff = new Map((view.diff ? view.diff.enums : []).map((e) => [e.id, e]));
    const box = document.createElement('details');
    box.className = 'db-enums';
    if (dbState.open.has('__enums')) box.open = true;
    box.innerHTML = `<summary>Enums (${enums.length})</summary>
      <div class="db-enum-list">${enums.map((e) => {
        const d = enumDiff.get(e.id);
        const st = d ? d.status : 'same';
        return `<div class="db-enum ${st}">
          <span class="db-enum-name">${escapeHtml(e.name)}</span>
          <span class="db-enum-values">${e.values.map((v) => {
            const added = d && d.added && d.added.includes(v);
            return `<code class="${added ? 'added' : ''}">${escapeHtml(v)}</code>`;
          }).join('')}${(d && d.removed || []).map((v) =>
            `<code class="removed">${escapeHtml(v)}</code>`).join('')}</span>
        </div>`;
      }).join('')}</div>`;
    box.addEventListener('toggle', () => {
      if (box.open) dbState.open.add('__enums'); else dbState.open.delete('__enums');
    });
    frag.appendChild(box);
  }

  // --- Entfernte Tabellen: stehen nicht mehr im Schema, muessen aber auffallen
  const removed = (view.diff ? view.diff.tables : []).filter((t) => t.status === 'removed');
  for (const t of removed) {
    if (q && !t.name.toLowerCase().includes(q)) continue;
    const el = document.createElement('div');
    el.className = 'db-table removed-table';
    el.innerHTML = `<span class="db-status removed" title="entfernt">−</span>
      <span class="db-table-name">${escapeHtml(t.schema)}.${escapeHtml(t.name)}</span>
      <span class="db-table-note">entfernt</span>`;
    frag.appendChild(el);
  }

  // --- Tabellen ---
  const tables = view.schema.tables.filter((t) => !q
    || t.name.toLowerCase().includes(q)
    || t.columns.some((c) => c.name.toLowerCase().includes(q)));

  for (const t of tables) {
    frag.appendChild(buildDbTableCard(t, look.get(t.id), q));
  }

  if (!frag.childNodes.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = q ? 'Keine Treffer' : 'Keine Tabellen gefunden';
    frag.appendChild(d);
  }
  dbTablesEl.appendChild(frag);
}

function buildDbTableCard(t, d, q) {
  const status = d ? d.status : 'same';
  const box = document.createElement('details');
  box.className = `db-table ${status}`;
  // Geaenderte Tabellen und Suchtreffer gleich aufklappen - danach sucht man.
  // Was von Hand zugeklappt wurde, bleibt zu.
  if (dbState.open.has(t.id)
      || (q && q.length > 1)
      || (status !== 'same' && !dbState.closed.has(t.id))) {
    box.open = true;
  }

  const changedCols = d ? [...d.columns.values()].filter((c) => c.status !== 'same').length : 0;
  box.innerHTML = `
    <summary>
      <span class="db-status ${status}" title="${STATUS_WORD[status] || 'unverändert'}">${STATUS_MARK[status] || '·'}</span>
      <span class="db-table-name">${escapeHtml(t.name)}</span>
      ${t.schema !== 'public' ? `<span class="db-schema">${escapeHtml(t.schema)}</span>` : ''}
      ${t.rls.enabled ? `<span class="db-rls${d && d.rlsChanged ? ' changed' : ''}" title="Row Level Security aktiv${
        t.rls.policies.length ? `, ${t.rls.policies.length} Policies` : ', keine Policies'}">RLS</span>` : ''}
      ${t.external
        ? '<span class="db-chip external" title="Diese Tabelle legt das Projekt nicht selbst an – es regelt nur den Zugriff darauf">extern</span>'
        : `<span class="db-count">${t.columns.length}</span>`}
      ${changedCols ? `<span class="db-chip changed">${changedCols} geändert</span>` : ''}
    </summary>
    <div class="db-body"></div>`;

  const body = box.querySelector('.db-body');
  if (t.external) {
    // Die Spalten kennen wir nicht - das sagen wir, statt eine leere Liste zu zeigen
    const note = document.createElement('div');
    note.className = 'db-hint';
    note.textContent = 'Fremde Tabelle – Spalten sind hier nicht bekannt. '
      + 'Gezeigt wird, was dieses Projekt selbst dafür festlegt.';
    body.appendChild(note);
  } else {
    body.appendChild(buildDbColumns(t, d));
  }

  const cons = (t.constraints || []).filter((c) => c.kind !== 'pk' || (c.columns || []).length > 1);
  if (cons.length) body.appendChild(buildDbConstraints(cons, d));
  if (t.rls.policies.length) body.appendChild(buildDbPolicies(t.rls.policies, d));
  if (t.comment) {
    const cm = document.createElement('div');
    cm.className = 'db-comment';
    cm.textContent = t.comment;
    body.appendChild(cm);
  }

  box.addEventListener('toggle', () => {
    if (box.open) { dbState.open.add(t.id); dbState.closed.delete(t.id); }
    else { dbState.open.delete(t.id); dbState.closed.add(t.id); }
  });
  return box;
}

function buildDbColumns(t, d) {
  const wrap = document.createElement('div');
  wrap.className = 'db-cols';
  const rows = t.columns.map((c) => {
    const cd = d && d.columns.get(c.name);
    const st = cd ? cd.status : 'same';
    const why = cd && cd.fields && cd.fields.length
      ? cd.fields.map((f) => `${f}: ${fmtDefault(cd.before[f])} → ${fmtDefault(cd.after[f])}`).join('\n')
      : '';
    return `<div class="db-col ${st}"${why ? ` title="${escapeHtml(why)}"` : ''}>
      <span class="db-col-mark ${st}">${STATUS_MARK[st] || ''}</span>
      <span class="db-col-name">${escapeHtml(c.name)}</span>
      <span class="db-col-type">${escapeHtml(c.type)}</span>
      <span class="db-col-tags">${tagsHtml(tagsForColumn(t, c.name))}</span>
      <span class="db-col-meta">${escapeHtml(colMeta(c).join(' · '))}</span>
    </div>`;
  });
  // Entfallene Spalten mitzeigen - sonst sieht man nur, dass die Zahl kleiner ist
  if (d) {
    for (const cd of d.columns.values()) {
      if (cd.status !== 'removed') continue;
      rows.push(`<div class="db-col removed" title="entfernt">
        <span class="db-col-mark removed">−</span>
        <span class="db-col-name">${escapeHtml(cd.name)}</span>
        <span class="db-col-type">${escapeHtml(cd.before.type)}</span>
        <span class="db-col-tags"></span>
        <span class="db-col-meta">${escapeHtml(colMeta(cd.before).join(' · '))}</span>
      </div>`);
    }
  }
  wrap.innerHTML = rows.join('');
  return wrap;
}

function buildDbConstraints(cons, d) {
  const box = document.createElement('div');
  box.className = 'db-sub';
  box.innerHTML = `<div class="db-sub-title">Constraints</div>
    ${cons.map((c) => {
      const cd = d && d.constraints.get(c.name);
      const st = cd ? cd.status : 'same';
      return `<div class="db-con ${st}">
        <span class="db-tag ${c.kind}" title="${escapeHtml((KIND_TAG[c.kind] || {}).title || c.kind)}">${(KIND_TAG[c.kind] || {}).tag || c.kind}</span>
        <span class="db-con-name">${escapeHtml(c.name)}</span>
        <span class="db-con-text">${escapeHtml(constraintText(c))}</span>
      </div>`;
    }).join('')}
    ${d ? [...d.constraints.values()].filter((c) => c.status === 'removed').map((c) => `
      <div class="db-con removed" title="entfernt">
        <span class="db-tag ${c.before.kind}">${(KIND_TAG[c.before.kind] || {}).tag || c.before.kind}</span>
        <span class="db-con-name">${escapeHtml(c.name)}</span>
        <span class="db-con-text">${escapeHtml(constraintText(c.before))}</span>
      </div>`).join('') : ''}`;
  return box;
}

function buildDbPolicies(policies, d) {
  const box = document.createElement('div');
  box.className = 'db-sub';
  box.innerHTML = `<div class="db-sub-title">RLS-Policies</div>
    ${policies.map((p) => {
      const pd = d && d.policies.get(p.name);
      const st = pd ? pd.status : 'same';
      return `<div class="db-con ${st}">
        <span class="db-tag pol" title="Policy">POL</span>
        <span class="db-con-name">${escapeHtml(p.name)}</span>
        <span class="db-con-text">${escapeHtml(policyText(p))}</span>
      </div>`;
    }).join('')}
    ${d ? [...d.policies.values()].filter((p) => p.status === 'removed').map((p) => `
      <div class="db-con removed" title="entfernt">
        <span class="db-tag pol">POL</span>
        <span class="db-con-name">${escapeHtml(p.name)}</span>
        <span class="db-con-text">${escapeHtml(policyText(p.before))}</span>
      </div>`).join('') : ''}`;
  return box;
}

dbSearchEl.addEventListener('input', () => {
  dbState.filter = dbSearchEl.value;
  if (dbState.view && dbState.view.ok && dbState.view.plugin) renderDbTables(dbState.view);
});

// ---------------------------------------------------------------------------
// Vorher/Nachher nebeneinander
//
// Ein Zeichen-Diff waere hier wenig wert - umsortierte Spalten oder ein
// umbenannter Constraint erzeugen Rauschen, und was fachlich passiert ist,
// sieht man nicht. Deshalb wird strukturell verglichen und beide Staende
// werden zeilengleich nebeneinander gestellt: links der alte, rechts der neue.
// Beide Karten eines Paares liegen in derselben Rasterzeile, also stehen
// gleiche Spalten auch auf gleicher Hoehe.
// ---------------------------------------------------------------------------
const dbDiffOverlay = $('#dbdiff-overlay');
const dbDiffBody = $('#dbdiff-body');
const dbDiffModes = $('#dbdiff-modes');
let dbDiffMode = 'changed'; // 'changed' | 'all'

function openDbDiff() {
  dbDiffOverlay.classList.remove('hidden');
  renderDbDiff();
}

function closeDbDiff() {
  dbDiffOverlay.classList.add('hidden');
  const s = activeId && sessions.get(activeId);
  if (s) s.term.focus();
}

function renderDbDiffModes() {
  dbDiffModes.innerHTML = '';
  for (const m of [{ id: 'changed', label: 'Nur Änderungen' }, { id: 'all', label: 'Ganzes Schema' }]) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.className = m.id === dbDiffMode ? 'active' : '';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      if (dbDiffMode === m.id) return;
      dbDiffMode = m.id;
      renderDbDiff();
    });
    dbDiffModes.appendChild(b);
  }
}

function renderDbDiff() {
  const view = dbState.view;
  // Nichts mehr zu vergleichen (Projekt gewechselt, Basis weggefallen): lieber
  // zumachen als einen veralteten Stand stehen lassen.
  if (!view || !view.ok || !view.plugin || !view.diff) { closeDbDiff(); return; }
  renderDbDiffModes();

  $('#dbdiff-title').textContent = `${view.plugin.label} · ${view.project || ''}`;
  $('#dbdiff-head-old').innerHTML =
    `<strong>Vorher</strong> <span>${escapeHtml(view.baseline.label)} · ${escapeHtml(view.baseline.ref)}</span>`;
  $('#dbdiff-head-new').innerHTML =
    '<strong>Nachher</strong> <span>Arbeitsverzeichnis</span>';

  const baseTables = new Map(view.base.tables.map((t) => [t.id, t]));
  const curTables = new Map(view.schema.tables.map((t) => [t.id, t]));

  dbDiffBody.innerHTML = '';
  const frag = document.createDocumentFragment();

  // --- Enums ---
  const enums = view.diff.enums.filter((e) => dbDiffMode === 'all' || e.status !== 'same');
  if (enums.length) {
    frag.appendChild(dbDiffSpan('Enums'));
    for (const e of enums) {
      frag.appendChild(dbDiffEnumCard(e, 'before'));
      frag.appendChild(dbDiffEnumCard(e, 'after'));
    }
  }

  // --- Tabellen ---
  const tables = view.diff.tables.filter((t) => dbDiffMode === 'all' || t.status !== 'same');
  if (tables.length) {
    frag.appendChild(dbDiffSpan('Tabellen'));
    for (const t of tables) {
      frag.appendChild(dbDiffTableCard(t, baseTables.get(t.id) || null, 'before'));
      frag.appendChild(dbDiffTableCard(t, curTables.get(t.id) || null, 'after'));
    }
  }

  if (!frag.childNodes.length) {
    frag.appendChild(dbDiffSpan('Keine Unterschiede'));
  }
  dbDiffBody.appendChild(frag);
  dbDiffBody.scrollTop = 0;
}

/** Zeile, die beide Spalten des Rasters ueberspannt. */
function dbDiffSpan(text) {
  const el = document.createElement('div');
  el.className = 'dbd-span';
  el.textContent = text;
  return el;
}

function dbDiffEnumCard(e, side) {
  const values = side === 'before' ? (e.before || (e.status === 'added' ? [] : e.values)) : e.values;
  const el = document.createElement('div');
  const missing = (side === 'before' && e.status === 'added') || (side === 'after' && e.status === 'removed');
  el.className = `dbd-card ${side}` + (missing ? ' absent' : '');
  if (missing) {
    el.innerHTML = `<div class="dbd-card-head"><span class="dbd-absent">${
      side === 'before' ? 'existierte noch nicht' : 'entfernt'}</span></div>`;
    return el;
  }
  el.innerHTML = `
    <div class="dbd-card-head">
      <span class="dbd-name">${escapeHtml(e.name)}</span>
      <span class="db-tag enum">ENUM</span>
    </div>
    <div class="dbd-rows">${(values || []).map((v) => {
      const gone = side === 'before' && e.removed && e.removed.includes(v);
      const isNew = side === 'after' && e.added && e.added.includes(v);
      return `<div class="dbd-row ${gone ? 'removed' : isNew ? 'added' : 'same'}">
        <span class="dbd-mark">${gone ? '−' : isNew ? '+' : ''}</span>
        <code>${escapeHtml(v)}</code></div>`;
    }).join('')}</div>`;
  return el;
}

function dbDiffTableCard(t, table, side) {
  const el = document.createElement('div');
  const missing = !table;
  el.className = `dbd-card ${side} ${t.status}` + (missing ? ' absent' : '');

  if (missing) {
    el.innerHTML = `<div class="dbd-card-head">
      <span class="dbd-name muted">${escapeHtml(t.schema)}.${escapeHtml(t.name)}</span>
      <span class="dbd-absent">${side === 'before' ? 'neue Tabelle' : 'entfernt'}</span>
    </div>`;
    return el;
  }

  // Die Zeilenfolge kommt aus dem Diff und ist auf beiden Seiten dieselbe -
  // dadurch stehen gleiche Spalten links und rechts auf gleicher Hoehe.
  const colRows = t.columns.map((cd) => {
    const c = side === 'before' ? cd.before : cd.after;
    const st = cd.status;
    if (!c) {
      return `<div class="dbd-row absent"><span class="dbd-mark"></span>
        <span class="dbd-cell muted">—</span></div>`;
    }
    const changedFields = st === 'changed' ? cd.fields : [];
    const meta = colMeta(c).join(' · ');
    return `<div class="dbd-row ${st}"${changedFields.length
      ? ` title="${escapeHtml(changedFields.join(', '))}"` : ''}>
      <span class="dbd-mark">${st === 'added' ? (side === 'after' ? '+' : '') : st === 'removed' ? (side === 'before' ? '−' : '') : st === 'changed' ? '~' : ''}</span>
      <span class="dbd-col-name">${escapeHtml(c.name)}</span>
      <span class="dbd-col-type${changedFields.includes('type') ? ' hot' : ''}">${escapeHtml(c.type)}</span>
      <span class="dbd-col-tags">${tagsHtml(tagsForColumn(table, c.name))}</span>
      <span class="dbd-col-meta${changedFields.some((f) => f !== 'type') ? ' hot' : ''}">${escapeHtml(meta)}</span>
    </div>`;
  });

  const conRows = t.constraints.map((cd) => {
    const c = side === 'before' ? cd.before : cd.after;
    if (!c) return `<div class="dbd-row absent"><span class="dbd-mark"></span><span class="dbd-cell muted">—</span></div>`;
    return `<div class="dbd-row ${cd.status}">
      <span class="dbd-mark">${cd.status === 'added' ? (side === 'after' ? '+' : '') : cd.status === 'removed' ? (side === 'before' ? '−' : '') : cd.status === 'changed' ? '~' : ''}</span>
      <span class="db-tag ${c.kind}">${(KIND_TAG[c.kind] || {}).tag || c.kind}</span>
      <span class="dbd-con-name">${escapeHtml(c.name)}</span>
      <span class="dbd-con-text">${escapeHtml(constraintText(c))}</span>
    </div>`;
  });

  const polRows = t.policies.map((pd) => {
    const p = side === 'before' ? pd.before : pd.after;
    if (!p) return `<div class="dbd-row absent"><span class="dbd-mark"></span><span class="dbd-cell muted">—</span></div>`;
    return `<div class="dbd-row ${pd.status}">
      <span class="dbd-mark">${pd.status === 'added' ? (side === 'after' ? '+' : '') : pd.status === 'removed' ? (side === 'before' ? '−' : '') : pd.status === 'changed' ? '~' : ''}</span>
      <span class="db-tag pol">POL</span>
      <span class="dbd-con-name">${escapeHtml(p.name)}</span>
      <span class="dbd-con-text">${escapeHtml(policyText(p))}</span>
    </div>`;
  });

  el.innerHTML = `
    <div class="dbd-card-head">
      <span class="dbd-name">${escapeHtml(table.name)}</span>
      ${table.schema !== 'public' ? `<span class="db-schema">${escapeHtml(table.schema)}</span>` : ''}
      ${table.rls.enabled ? `<span class="db-rls${t.rlsChanged ? ' changed' : ''}" title="Row Level Security aktiv">RLS</span>` : ''}
      ${table.external ? '<span class="db-chip external" title="fremde Tabelle, nur eigene Regeln">extern</span>' : ''}
    </div>
    <div class="dbd-rows">${colRows.join('')}</div>
    ${conRows.length ? `<div class="dbd-sub">Constraints</div><div class="dbd-rows">${conRows.join('')}</div>` : ''}
    ${polRows.length ? `<div class="dbd-sub">RLS-Policies</div><div class="dbd-rows">${polRows.join('')}</div>` : ''}`;
  return el;
}

$('#dbdiff-close').addEventListener('click', closeDbDiff);
dbDiffOverlay.addEventListener('click', (e) => { if (e.target === dbDiffOverlay) closeDbDiff(); });

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
// Panel-Tabs (Git / Verlauf / Notizen / DB-Schema / Nutzung) mit Badges
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
    agents: info.agents,
    files: info.files,
    pr: info.pr,
    title: info.title,
    label: info.label,
    state: info.state,
  });
  updateSessionItem(s);
  if (rootChanged) {
    loadTodosFor(s); // anderes Projekt -> dessen Notizen laden
    if (info.id === activeId) {
      dbState.lastJson = '';
      dbState.open.clear();
      dbState.closed.clear();
      loadDbSchema();
    }
  }
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
    else if (!dbDiffOverlay.classList.contains('hidden')) closeDbDiff();
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
  startDbPolling();
})();
