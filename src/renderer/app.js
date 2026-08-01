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

// First match wins. Without the Linux/macOS fonts the list fell back to the
// generic `monospace` - together with lineHeight 1.25 that produced the
// oversized line spacing.
const TERM_FONT = [
  '"Cascadia Code"', '"Cascadia Mono"', '"JetBrains Mono"', '"Fira Code"',
  '"Hack"', '"Source Code Pro"', '"DejaVu Sans Mono"', '"Liberation Mono"',
  '"Noto Sans Mono"', '"Ubuntu Mono"', 'Menlo', 'Consolas', 'monospace',
].join(', ');

// Full-screen interfaces like Claude turn on mouse reporting; xterm.js then
// forwards clicks to the application instead of selecting. Holding Shift keeps
// selection possible.
function copySelection(term) {
  const text = term.getSelection();
  if (!text) return false;
  window.api.clipboardWrite(text);
  return true;
}

// term.paste() rather than window.api.input(): only that wraps the text in
// bracketed-paste mode. Without the brackets Claude reads every line of a
// multi-line paste as a submitted command.
async function pasteInto(term) {
  const text = await window.api.clipboardRead();
  if (text) term.paste(text);
}

// OSC 52 is the request of the program in the terminal to put something on the
// clipboard - that is exactly how Claude copies ("copied via OSC 52"). xterm.js
// ships no handler for it, so the message was true but the clipboard stayed
// empty.
function handleOsc52(term) {
  term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(';') + 1);
    // "?" queries the clipboard. Do not answer: otherwise any output in the
    // terminal could read out its content.
    if (!payload || payload === '?') return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      window.api.clipboardWrite(new TextDecoder().decode(bytes));
    } catch { /* not valid base64 */ }
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

// Make an element keyboard-operable: Enter/Space = click
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
// Mini markdown renderer (PR descriptions, agent summaries).
// No external package (CSP) - covers the constructs agents typically use.
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
  // Pull code blocks out so they are not processed any further
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

// Open links in rendered markdown externally
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) {
    e.preventDefault();
    window.api.openExternal(a.dataset.url);
  }
});

// ---------------------------------------------------------------------------
// Create / activate / close sessions
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
  // Do not pass app shortcuts through to the shell as control characters
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey) return true;
    const k = ev.key.toLowerCase();
    if (!ev.shiftKey && (k === 't' || k === 'g')) return false;
    if (ev.shiftKey && k === 'w') return false;
    // Ctrl+C is SIGINT in the terminal, so it cannot copy. Ctrl+Shift+C and
    // Ctrl+Shift+V are the usual terminal equivalents.
    // preventDefault() so Chromium does not additionally evaluate the shortcut
    // as its own - on `false` xterm only suppresses itself.
    if (ev.shiftKey && k === 'c') { ev.preventDefault(); copySelection(term); return false; }
    if (ev.shiftKey && k === 'v') { ev.preventDefault(); pasteInto(term); return false; }
    return true;
  });

  // Right-click: copy the selection, otherwise paste - as in most terminals
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
  // The progress of the new session is not progress that just happened -
  // otherwise the pulse would flash on every session switch.
  pulseProgSeen = null;
  for (const s of sessions.values()) {
    const active = s.id === id;
    s.paneEl.classList.toggle('inactive', !active);
    s.itemEl.classList.toggle('active', active);
    if (active) {
      requestAnimationFrame(() => {
        try { s.fit.fit(); } catch { /* pane may still be 0px */ }
        s.term.focus();
      });
    }
  }
  emptyStateEl.classList.toggle('hidden', sessions.size > 0);
  renderContextPanel();
  const active = id ? sessions.get(id) : null;
  renderHistory(active);
  loadTodosFor(active);
  // Different project, different schema - the expanded state no longer fits
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
// Sidebar
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
    <button class="si-close" title="Close session" aria-label="Close session">✕</button>`;
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
  statusEl.title = state === 'busy' ? 'Working…'
    : state === 'attention' ? 'Input expected – it is your turn'
    : state === 'exited' ? 'Exited' : 'Waiting for input';
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

// How many agents are working in this session? The chip only appears while
// some are running — a permanent "0" would be dead weight in a list you read in
// passing.
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
  el.title = [`${n} ${n === 1 ? 'agent working' : 'agents working'}`, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Right-hand panel: PR + changed files
// ---------------------------------------------------------------------------
function renderContextPanel() {
  const s = activeId ? sessions.get(activeId) : null;
  const wtBannerEl = $('#wt-banner');
  if (!s) {
    prCardEl.innerHTML = '<div class="muted">No session selected</div>';
    $('#pr-extra').innerHTML = '';
    fileListEl.innerHTML = '';
    wtBannerEl.classList.add('hidden');
    updateBadges(null);
    return;
  }

  // --- Worktree notice ---
  // Branch and files then come from the agent's directory, not from the
  // shell's - without a notice that would be impossible to follow.
  wtBannerEl.classList.toggle('hidden', !s.worktree);
  if (s.worktree) {
    wtBannerEl.innerHTML = `
      <span class="wt-icon">⑂</span>
      <span class="wt-text">Agent is working in worktree
        <code>${escapeHtml(s.worktree)}</code></span>
      <span class="wt-sub" title="${escapeHtml(s.agentCwd || '')}">Shell: ${escapeHtml(s.cwd)}</span>`;
  }

  // --- PR card ---
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
      <div class="pr-title" title="Open in browser">#${pr.number} ${escapeHtml(pr.title)}</div>
      <div class="pr-meta">
        <span class="pr-state ${stateClass}">${escapeHtml(stateText)}</span>
        ${pr.author ? `<span>by ${escapeHtml(pr.author)}</span>` : ''}
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
    prCardEl.innerHTML = `<div class="muted">No pull request for <code>${escapeHtml(s.branch)}</code></div>`;
    prExtraEl.innerHTML = '';
  } else {
    prCardEl.innerHTML = '<div class="muted">Not a git repository</div>';
    prExtraEl.innerHTML = '';
  }

  // --- File lists ---
  fileListEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  // As soon as a PR exists, its file list is the authoritative one - the local
  // memory would only duplicate it.
  const hasPr = Boolean(s.pr && s.pr.files && s.pr.files.length);

  if (hasPr) {
    const t = document.createElement('div');
    t.className = 'file-group-title';
    t.textContent = `In the pull request (${s.pr.files.length})`;
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
      t.textContent = 'Working directory';
      frag.appendChild(t);
      for (const f of open) frag.appendChild(buildFileItem(s, f, 'wt'));
    }
    if (done.length) {
      const t = document.createElement('div');
      t.className = 'file-group-title';
      t.textContent = `Committed (${done.length})`;
      frag.appendChild(t);
      for (const f of done) frag.appendChild(buildFileItem(s, f, 'wt'));
    }
  }

  if (!frag.childNodes.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = s.branch ? 'No changes' : '—';
    frag.appendChild(d);
  }
  fileListEl.appendChild(frag);
  updateBadges(s);
}

// PR extra sections (description, commits, comments) - the expanded state
// survives the periodic re-renders
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
    frag.appendChild(buildDetails('body', 'Description', `<div class="md">${mdToHtml(pr.body)}</div>`));
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
          <span class="fb-date">${f.at ? new Date(f.at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>
        ${f.body ? `<div class="md">${mdToHtml(f.body)}</div>` : ''}
      </div>`).join('');
    frag.appendChild(buildDetails('feedback', `Comments & reviews (${feedback.length})`, rows));
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
    ? `${filePath} — directory, no preview`
    : filePath;

  const stat = (f.additions !== undefined || f.deletions !== undefined)
    ? `<span class="file-diffstat"><span class="add">+${f.additions ?? 0}</span> <span class="del">−${f.deletions ?? 0}</span></span>`
    : '';
  el.innerHTML = `
    <span class="file-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
    <span class="file-path">&lrm;${escapeHtml(filePath)}&lrm;</span>
    ${stat}`;

  // Directories (git reports them untracked with a trailing slash) are not
  // clickable - a file preview of them is bound to fail.
  if (!isDir) {
    makeKeyActivatable(el);
    el.addEventListener('click', () => openPreview(s.id, filePath, source));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Input history
// ---------------------------------------------------------------------------
const historyListEl = $('#history-list');

function renderHistory(s) {
  historyListEl.innerHTML = '';
  if (!s || !s.history.length) {
    historyListEl.innerHTML = '<div class="muted">No input yet</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of [...s.history].reverse()) {
    const el = document.createElement('div');
    el.className = 'hist-item';
    const time = new Date(entry.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <span class="hist-time">${time}</span>
      <span class="hist-kind ${entry.kind}" title="${entry.kind === 'agent' ? 'Prompt to an agent (e.g. Claude)' : 'Shell command'}">${entry.kind === 'agent' ? '✳' : '$'}</span>
      <span class="hist-text"></span>
      <button class="hist-send" title="Insert into the terminal input line" aria-label="Insert into terminal">↩</button>`;
    el.querySelector('.hist-text').textContent = entry.text;
    el.title = 'Click: copy\n\n' + entry.text;
    makeKeyActivatable(el);
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.hist-send')) return;
      try { await navigator.clipboard.writeText(entry.text); } catch { /* never mind */ }
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
// Notes / TODO (persisted per project)
// ---------------------------------------------------------------------------
const todoListEl = $('#todo-list');
const todoInputEl = $('#todo-input');

function renderTodos(s) {
  todoListEl.innerHTML = '';
  const todos = s ? s.todos : [];
  todoInputEl.disabled = !s;
  updateBadges(s);
  // A single funnel for both: note ticked off and session switched
  pulseWake();
  if (!todos.length) {
    todoListEl.innerHTML = '<div class="muted">No notes</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  todos.forEach((t, idx) => {
    const el = document.createElement('div');
    el.className = 'todo-item' + (t.done ? ' done' : '');
    el.innerHTML = `
      <input type="checkbox" ${t.done ? 'checked' : ''} title="Done" />
      <span class="todo-text"></span>
      <button class="todo-del" title="Delete" aria-label="Delete note">✕</button>`;
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
  // another session in the same project changed the notes
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
// DB schema
//
// The main process delivers a finished state: detected plugin, current schema
// in the standardised format, the comparison baseline and the diff. Here it is
// only rendered.
//
// Deliberately as table cards and not as an ER diagram: what matters are
// columns, types and constraints, and inside a diagram box those are either
// absent or illegibly small. Above all, a diagram cannot sensibly be compared
// row by row - which is exactly what the before/after view needs.
// Relationships are shown as foreign keys in plain text, including the target.
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
  // Expanded or deliberately collapsed - both have to survive the rebuild,
  // otherwise a table closed by hand pops open again on the next tick.
  open: new Set(),
  closed: new Set(),
  lastJson: '',
  loading: false,
};
let dbTimer = null;

const STATUS_MARK = { added: '+', removed: '−', changed: '~', same: '' };
const STATUS_WORD = { added: 'new', removed: 'removed', changed: 'changed', same: '' };

// Short tags for the constraints that affect a column
const KIND_TAG = {
  pk: { tag: 'PK', title: 'primary key' },
  fk: { tag: 'FK', title: 'foreign key' },
  unique: { tag: 'UQ', title: 'unique' },
  check: { tag: 'CK', title: 'check constraint' },
  index: { tag: 'IX', title: 'index' },
  exclude: { tag: 'EX', title: 'exclusion constraint' },
};

function fmtDefault(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** The extra details of a column, in the order one reads them. */
function colMeta(col) {
  const out = [];
  if (!col.nullable) out.push('NOT NULL');
  if (col.identity) out.push('identity');
  if (col.generated) out.push('generated');
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
  if (p.roles && p.roles.length) bits.push('for ' + p.roles.join(', '));
  if (p.using) bits.push('using ' + p.using);
  if (p.check) bits.push('check ' + p.check);
  return bits.join(' · ');
}

/** Which constraints affect this column? */
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
// Loading
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
    if (s.id !== activeId) return; // switched away in the meantime
    // Unchanged? Then do not rebuild - otherwise the scroll position jumps on
    // every tick of the background poll.
    const json = JSON.stringify(view);
    if (json === dbState.lastJson) return;
    dbState.lastJson = json;
    dbState.view = view;
    dbState.sessionId = s.id;
    renderDbPanel();
    if (!dbDiffOverlay.classList.contains('hidden')) renderDbDiff();
  } catch {
    /* session gone or similar */
  } finally {
    dbState.loading = false;
  }
}

function setDbBadge(count) {
  badgeDbEl.textContent = count > 99 ? '99+' : String(count);
  badgeDbEl.classList.toggle('hidden', !count);
  badgeDbEl.classList.toggle('alert', Boolean(count));
}

// Keep running in the background so the indicator on the tab is right without
// having to keep the tab open - a schema change should stand out, not have to
// be searched for. The sensor serves from the cache as long as no file moves.
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
      ? escapeHtml(view.error) : 'No session selected'}</div>`;
    setDbBadge(0);
    return;
  }

  if (!view.plugin) {
    dbHeadEl.innerHTML = '';
    dbSignalEl.innerHTML = '';
    dbSearchEl.classList.add('hidden');
    dbTablesEl.innerHTML = `
      <div class="muted">No DB schema detected.</div>
      <div class="db-hint">No plugin feels responsible for
        <code>${escapeHtml(view.project || view.root || '')}</code>.
        Currently recognised are Supabase projects
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
    ? `<label class="db-base">Baseline
         <select id="db-baseline">
           ${view.baselines.map((b) => `<option value="${escapeHtml(b.mode)}"${
             view.baseline && view.baseline.mode === b.mode ? ' selected' : ''
           } title="${escapeHtml(b.hint || '')}">${escapeHtml(b.label)}</option>`).join('')}
         </select>
       </label>`
    : '<span class="muted">no git state to compare against</span>';

  dbHeadEl.innerHTML = `
    <div class="db-top">
      <span class="db-plugin" title="${escapeHtml((view.plugin.evidence || []).join('\n'))}">${escapeHtml(view.plugin.label)}</span>
      <span class="db-files">${view.schema.tables.length} tables · ${files} ${files === 1 ? 'file' : 'files'}</span>
      <button id="db-refresh" class="icon-btn" title="Re-read" aria-label="Re-read">↻</button>
    </div>
    <div class="db-baseline-row">${baseSel}</div>
    ${view.schema.warnings.length ? `
      <details class="db-warn">
        <summary>${view.schema.warnings.length} warning${view.schema.warnings.length === 1 ? '' : 's'} while reading</summary>
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
      <span>Schema unchanged compared to <strong>${escapeHtml(view.baseline.label)}</strong></span>
    </div>`;
    return;
  }
  const s = d.summary;
  const detail = [
    partsText(s.columns, 'column', 'columns'),
    partsText(s.constraints, 'constraint', 'constraints'),
    partsText(s.policies, 'policy', 'policies'),
  ].filter(Boolean).join(' · ');

  dbSignalEl.innerHTML = `<div class="db-signal alert">
    <span class="db-signal-icon">⚠</span>
    <div class="db-signal-text">
      <strong>Schema changed</strong> compared to ${escapeHtml(view.baseline.label)}
      <div class="db-signal-sub">${escapeHtml(view.changeText)}${detail ? '<br>' + detail : ''}</div>
    </div>
    <button id="db-open-diff" title="Before and after side by side">Compare</button>
  </div>`;
  dbSignalEl.querySelector('#db-open-diff').addEventListener('click', openDbDiff);
}

function partsText(counts, one, many) {
  const bits = [];
  if (counts.added) bits.push(`${counts.added} new`);
  if (counts.removed) bits.push(`${counts.removed} removed`);
  if (counts.changed) bits.push(`${counts.changed} changed`);
  if (!bits.length) return '';
  const total = counts.added + counts.removed + counts.changed;
  return `${total === 1 ? one : many}: ${bits.join(', ')}`;
}

/** Make the diff status per table/column/constraint look-up-able. */
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

  // --- Removed tables: no longer in the schema, but they have to stand out
  const removed = (view.diff ? view.diff.tables : []).filter((t) => t.status === 'removed');
  for (const t of removed) {
    if (q && !t.name.toLowerCase().includes(q)) continue;
    const el = document.createElement('div');
    el.className = 'db-table removed-table';
    el.innerHTML = `<span class="db-status removed" title="removed">−</span>
      <span class="db-table-name">${escapeHtml(t.schema)}.${escapeHtml(t.name)}</span>
      <span class="db-table-note">removed</span>`;
    frag.appendChild(el);
  }

  // --- Tables ---
  const tables = view.schema.tables.filter((t) => !q
    || t.name.toLowerCase().includes(q)
    || t.columns.some((c) => c.name.toLowerCase().includes(q)));

  for (const t of tables) {
    frag.appendChild(buildDbTableCard(t, look.get(t.id), q));
  }

  if (!frag.childNodes.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = q ? 'No matches' : 'No tables found';
    frag.appendChild(d);
  }
  dbTablesEl.appendChild(frag);
}

function buildDbTableCard(t, d, q) {
  const status = d ? d.status : 'same';
  const box = document.createElement('details');
  box.className = `db-table ${status}`;
  // Expand changed tables and search hits right away - that is what one is
  // looking for. Whatever was collapsed by hand stays collapsed.
  if (dbState.open.has(t.id)
      || (q && q.length > 1)
      || (status !== 'same' && !dbState.closed.has(t.id))) {
    box.open = true;
  }

  const changedCols = d ? [...d.columns.values()].filter((c) => c.status !== 'same').length : 0;
  box.innerHTML = `
    <summary>
      <span class="db-status ${status}" title="${STATUS_WORD[status] || 'unchanged'}">${STATUS_MARK[status] || '·'}</span>
      <span class="db-table-name">${escapeHtml(t.name)}</span>
      ${t.schema !== 'public' ? `<span class="db-schema">${escapeHtml(t.schema)}</span>` : ''}
      ${t.rls.enabled ? `<span class="db-rls${d && d.rlsChanged ? ' changed' : ''}" title="Row level security enabled${
        t.rls.policies.length ? `, ${t.rls.policies.length} policies` : ', no policies'}">RLS</span>` : ''}
      ${t.external
        ? '<span class="db-chip external" title="The project does not create this table itself – it only governs access to it">external</span>'
        : `<span class="db-count">${t.columns.length}</span>`}
      ${changedCols ? `<span class="db-chip changed">${changedCols} changed</span>` : ''}
    </summary>
    <div class="db-body"></div>`;

  const body = box.querySelector('.db-body');
  if (t.external) {
    // We do not know the columns - say so instead of showing an empty list
    const note = document.createElement('div');
    note.className = 'db-hint';
    note.textContent = 'Foreign table – its columns are not known here. '
      + 'What is shown is what this project itself defines for it.';
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
  // Show dropped columns too - otherwise one only sees that the count is smaller
  if (d) {
    for (const cd of d.columns.values()) {
      if (cd.status !== 'removed') continue;
      rows.push(`<div class="db-col removed" title="removed">
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
      <div class="db-con removed" title="removed">
        <span class="db-tag ${c.before.kind}">${(KIND_TAG[c.before.kind] || {}).tag || c.before.kind}</span>
        <span class="db-con-name">${escapeHtml(c.name)}</span>
        <span class="db-con-text">${escapeHtml(constraintText(c.before))}</span>
      </div>`).join('') : ''}`;
  return box;
}

function buildDbPolicies(policies, d) {
  const box = document.createElement('div');
  box.className = 'db-sub';
  box.innerHTML = `<div class="db-sub-title">RLS policies</div>
    ${policies.map((p) => {
      const pd = d && d.policies.get(p.name);
      const st = pd ? pd.status : 'same';
      return `<div class="db-con ${st}">
        <span class="db-tag pol" title="policy">POL</span>
        <span class="db-con-name">${escapeHtml(p.name)}</span>
        <span class="db-con-text">${escapeHtml(policyText(p))}</span>
      </div>`;
    }).join('')}
    ${d ? [...d.policies.values()].filter((p) => p.status === 'removed').map((p) => `
      <div class="db-con removed" title="removed">
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
// Before/after side by side
//
// A character diff would be worth little here - reordered columns or a renamed
// constraint create noise, and what actually happened is not visible. So the
// comparison is structural and both states are placed side by side, row for
// row: the old one on the left, the new one on the right. Both cards of a pair
// sit in the same grid row, so identical columns stand at the same height.
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
  for (const m of [{ id: 'changed', label: 'Changes only' }, { id: 'all', label: 'Whole schema' }]) {
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
  // Nothing left to compare (project switched, baseline gone): better to close
  // than to leave a stale state standing.
  if (!view || !view.ok || !view.plugin || !view.diff) { closeDbDiff(); return; }
  renderDbDiffModes();

  $('#dbdiff-title').textContent = `${view.plugin.label} · ${view.project || ''}`;
  $('#dbdiff-head-old').innerHTML =
    `<strong>Before</strong> <span>${escapeHtml(view.baseline.label)} · ${escapeHtml(view.baseline.ref)}</span>`;
  $('#dbdiff-head-new').innerHTML =
    '<strong>After</strong> <span>working directory</span>';

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

  // --- Tables ---
  const tables = view.diff.tables.filter((t) => dbDiffMode === 'all' || t.status !== 'same');
  if (tables.length) {
    frag.appendChild(dbDiffSpan('Tables'));
    for (const t of tables) {
      frag.appendChild(dbDiffTableCard(t, baseTables.get(t.id) || null, 'before'));
      frag.appendChild(dbDiffTableCard(t, curTables.get(t.id) || null, 'after'));
    }
  }

  if (!frag.childNodes.length) {
    frag.appendChild(dbDiffSpan('No differences'));
  }
  dbDiffBody.appendChild(frag);
  dbDiffBody.scrollTop = 0;
}

/** A row that spans both columns of the grid. */
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
      side === 'before' ? 'did not exist yet' : 'removed'}</span></div>`;
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
      <span class="dbd-absent">${side === 'before' ? 'new table' : 'removed'}</span>
    </div>`;
    return el;
  }

  // The row order comes from the diff and is the same on both sides - which is
  // why identical columns stand at the same height on the left and the right.
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
      ${table.rls.enabled ? `<span class="db-rls${t.rlsChanged ? ' changed' : ''}" title="Row level security enabled">RLS</span>` : ''}
      ${table.external ? '<span class="db-chip external" title="foreign table, only our own rules">external</span>' : ''}
    </div>
    <div class="dbd-rows">${colRows.join('')}</div>
    ${conRows.length ? `<div class="dbd-sub">Constraints</div><div class="dbd-rows">${conRows.join('')}</div>` : ''}
    ${polRows.length ? `<div class="dbd-sub">RLS policies</div><div class="dbd-rows">${polRows.join('')}</div>` : ''}`;
  return el;
}

$('#dbdiff-close').addEventListener('click', closeDbDiff);
dbDiffOverlay.addEventListener('click', (e) => { if (e.target === dbDiffOverlay) closeDbDiff(); });

// ---------------------------------------------------------------------------
// Usage limits of the subscription: actual usage, plus the proportionally
// allowed level. After 3 of 7 days, 3/7 = 42.9 % is the target - anyone above
// that will blow the limit if the pace holds.
// ---------------------------------------------------------------------------
const usageContentEl = $('#usage-content');
const dotUsageEl = $('#dot-usage');
let usageTimer = null;

const STATUS_LABEL = {
  ok: 'within budget',
  warn: 'slightly over',
  over: 'limit will be blown',
  early: 'too early in the window',
  unknown: 'no data',
};

function fmtPct(n) {
  if (typeof n !== 'number') return '–';
  return (Math.round(n * 10) / 10).toLocaleString('en-GB') + ' %';
}

// "in 1 h 47" or "in 3 days 5 h"
function fmtUntil(ts) {
  if (!ts) return '';
  let ms = ts - Date.now();
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / 86400000); ms -= days * 86400000;
  const hours = Math.floor(ms / 3600000); ms -= hours * 3600000;
  const mins = Math.floor(ms / 60000);
  if (days) return `in ${days} ${days === 1 ? 'day' : 'days'} ${hours} h`;
  if (hours) return `in ${hours} h ${String(mins).padStart(2, '0')}`;
  return `in ${mins} min`;
}

function fmtReset(ts) {
  if (!ts) return 'unknown';
  return new Date(ts).toLocaleString('en-GB',
    { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderLimit(title, limit, opts = {}) {
  if (!limit) return '';
  const status = limit.status || 'unknown';
  const used = typeof limit.used === 'number' ? limit.used : 0;
  const budget = typeof limit.budget === 'number' ? limit.budget : null;
  // Only show the target mark where it says something (not at the window edge)
  const showMark = budget !== null && budget > 1 && budget < 99 && !opts.hideMark;

  let verdict = '';
  if (status === 'unknown') {
    verdict = '<div class="uz-note">No data for this limit.</div>';
  } else if (status === 'early') {
    verdict = `<div class="uz-note">Still too early in the window for a projection.
      Allowed so far would be <strong>${fmtPct(budget)}</strong>.</div>`;
  } else {
    const over = used - budget;
    verdict = `<div class="uz-verdict ${status}">
      <span class="uz-target">Allowed so far: <strong>${fmtPct(budget)}</strong></span>
      <span class="uz-delta">${over > 0
        ? `${fmtPct(over)} over`
        : `${fmtPct(-over)} to spare`}</span>
      <span class="uz-proj">Projection at window end: <strong>${fmtPct(limit.projected)}</strong></span>
    </div>`;
  }

  return `
    <section class="uz-card ${status}">
      <header class="uz-head">
        <span class="uz-dot ${status}"></span>
        <span class="uz-title">${escapeHtml(title)}</span>
        <span class="uz-status">${STATUS_LABEL[status]}</span>
      </header>
      <div class="uz-bar" role="img" aria-label="${fmtPct(used)} used">
        <div class="uz-fill ${status}" style="width:${Math.min(used, 100)}%"></div>
        ${showMark ? `<div class="uz-mark" style="left:${budget}%" title="target: ${fmtPct(budget)}"></div>` : ''}
      </div>
      <div class="uz-meta">
        <span class="uz-used">${fmtPct(used)} used</span>
        <span class="uz-reset">Reset ${fmtReset(limit.resetsAt)} · ${fmtUntil(limit.resetsAt)}</span>
      </div>
      ${verdict}
    </section>`;
}

// The worst status wins - the dot on the tab should show the tightest limit
const SEVERITY = { unknown: 0, early: 0, ok: 1, warn: 2, over: 3 };

function worstStatus(data) {
  let worst = 'unknown';
  for (const l of [data.fiveHour, data.sevenDay, data.sevenDayOpus]) {
    if (l && SEVERITY[l.status] > SEVERITY[worst]) worst = l.status;
  }
  return worst;
}

async function loadUsage(force = false) {
  // Deliberately without a visibility check: the dot on the tab should be right
  // even when the tab is closed. Rendering into a hidden page costs nothing.
  const data = await window.api.getUsage(force);

  if (data.error && !data.stale) {
    usageContentEl.innerHTML = `
      <div class="uz-error">${escapeHtml(data.error)}</div>
      <div class="muted" style="margin-top:8px">The numbers come from your
      Claude subscription (the same state as <code>/usage</code>).</div>`;
    dotUsageEl.classList.add('hidden');
    return;
  }

  const parts = [
    renderLimit('5-hour window', data.fiveHour),
    renderLimit('7-day window', data.sevenDay),
    renderLimit('7 days · Opus', data.sevenDayOpus),
  ].filter(Boolean);

  if (!parts.length) {
    usageContentEl.innerHTML = '<div class="muted">No limits reported.</div>';
    dotUsageEl.classList.add('hidden');
    return;
  }

  const stamp = new Date(data.fetchedAt).toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit' });
  usageContentEl.innerHTML = `
    <div class="uz-top">
      ${data.plan ? `<span class="uz-plan">${escapeHtml(data.plan)}</span>` : '<span></span>'}
      <button id="usage-refresh" class="icon-btn" title="Refresh now" aria-label="Refresh">↻</button>
      <span class="uz-stamp">As of ${stamp}${data.stale ? ' · stale' : ''}</span>
    </div>
    ${data.stale ? `<div class="uz-error">${escapeHtml(data.error)}</div>` : ''}
    ${parts.join('')}
    <div class="uz-legend">The mark in the bar shows how much may have been
    used by now if the quota is meant to last evenly across the window.</div>`;
  usageContentEl.querySelector('#usage-refresh')
    .addEventListener('click', () => loadUsage(true));

  const worst = worstStatus(data);
  dotUsageEl.className = 'tab-dot ' + worst;
  dotUsageEl.classList.toggle('hidden', worst !== 'warn' && worst !== 'over');
}

// Keep running in the background so the dot on the tab is right without having
// to keep the tab open
function startUsagePolling() {
  loadUsage(true).catch(() => { /* offline or similar */ });
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    loadUsage().catch(() => { /* never mind */ });
  }, 120_000);
}

// ---------------------------------------------------------------------------
// Panel tabs (git / history / notes / DB schema / usage) with badges
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

// Enlarging the panel: applies to every tab, because the content does not move
// - only the panel itself is made large. The active tab stays the active one.
const contextPanel = $('#context-panel');
const panelBackdrop = $('#panel-backdrop');
const panelZoomBtn = $('#btn-panel-zoom');
let panelZoomed = false;
let panelWidth = '';

function setPanelZoom(on) {
  if (on === panelZoomed) return;
  panelZoomed = on;
  // The width set via the divider is inline and would otherwise beat `inset`.
  if (on) { panelWidth = contextPanel.style.width; contextPanel.style.width = ''; }
  else contextPanel.style.width = panelWidth;
  contextPanel.classList.toggle('zoomed', on);
  panelBackdrop.classList.toggle('hidden', !on);
  panelZoomBtn.textContent = on ? '⤡' : '⤢';
  panelZoomBtn.title = on ? 'Shrink panel (Esc)' : 'Enlarge panel';
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

function updateBadges(s) {
  setBadge(badgeGit, s ? s.files.length : 0);
  setBadge(badgeHistory, s ? (s.unseenHist || 0) : 0);
  setBadge(badgeTodos, s ? s.todos.filter((t) => !t.done).length : 0);
}

// ---------------------------------------------------------------------------
// File preview
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

// Fetches a view and remembers it - switching between the modes should not go
// over IPC again every time.
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
  // The formatted view needs the file content, not the diff
  const res = await fetchPreview(st.mode === 'md');
  if (previewState !== st) return; // a different file was opened meanwhile

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
  modes.push({ id: 'raw', label: hasDiff ? 'File' : 'Source' });
  if (MD_EXT.test(previewState.filePath)) modes.push({ id: 'md', label: 'Formatted' });

  previewModesEl.innerHTML = '';
  if (modes.length < 2) return; // nothing to switch between
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
  previewTitle.textContent = filePath + ' (loading…)';
  previewContent.innerHTML = '';
  previewModesEl.innerHTML = '';
  previewOverlay.classList.remove('hidden');

  previewState = { sessionId, filePath, source, mode: 'diff', cache: {} };
  const st = previewState;

  const first = await fetchPreview(false);
  if (previewState !== st) return;
  previewTitle.textContent = first.path;

  const hasDiff = first.kind === 'diff';
  // Show markdown without a diff formatted right away - that is usually why one opens it
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
// Meta popover: edit title & label
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
// New-session buttons + shell menu
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
// Grid overview: all sessions as live tiles
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

    // Read-only thumbnail: same columns/rows as the real terminal, small font -
    // the PTY size stays untouched
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
// Claude session browser: search, resume and fork old sessions
// ---------------------------------------------------------------------------
const sessionsOverlay = $('#sessions-overlay');
const sessionsListEl = $('#sessions-list');
const sessionsSearchEl = $('#sessions-search');
let claudeSessions = [];

async function openSessionBrowser() {
  sessionsOverlay.classList.remove('hidden');
  sessionsListEl.innerHTML = '<div class="muted">Loading sessions…</div>';
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
    sessionsListEl.innerHTML = `<div class="muted">${q ? 'No matches' : 'No Claude sessions found'}</div>`;
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
        <button class="cs-resume">Resume</button>
        <button class="cs-fork" title="Branch off as a new session">Fork</button>
      </div>`;
    el.querySelector('.cs-title').textContent = cs.slug || (cs.preview ? cs.preview.slice(0, 60) : cs.id.slice(0, 8));
    el.querySelector('.cs-preview').textContent = cs.preview || '';
    el.querySelector('.cs-date').textContent = new Date(cs.mtime).toLocaleString('en-GB', {
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
// Desktop notifications: when an agent needs attention
// ---------------------------------------------------------------------------
const NOTIFY_COOLDOWN_MS = 8000;

function maybeNotify(s, body) {
  // Only when it is not right in front of you anyway
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
// Events from the main process
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
  pulseWake();
  if (state === 'attention' && prev !== 'attention') {
    maybeNotify(s, 'Waiting for your input');
  }
});

window.api.onExit((id) => {
  const s = sessions.get(id);
  if (!s) return;
  s.exited = true;
  s.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
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
  pulseWake(); // the agent count feeds into the pulse
  if (rootChanged) {
    loadTodosFor(s); // different project -> load its notes
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
// Layout: resize panels via the dividers, fit the terminal on resize
// ---------------------------------------------------------------------------
// Fit the active tab's terminal to its area. While the context panel is
// enlarged that area would be wrong - see setPanelZoom().
function fitActive() {
  if (panelZoomed) return;
  const s = activeId && sessions.get(activeId);
  if (s) { try { s.fit.fit(); } catch { /* pane may still be 0px */ } }
}

function setupDivider(dividerEl, panelEl, growsRight) {
  dividerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dividerEl.classList.add('dragging');
    const startX = e.clientX;
    const startW = panelEl.getBoundingClientRect().width;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      panelEl.style.width = (growsRight ? startW + dx : startW - dx) + 'px';
      fitActive();
      sizePulse();
      pulseWake();
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

window.addEventListener('resize', () => { fitActive(); sizePulse(); pulseWake(); });

// ---------------------------------------------------------------------------
// Pulse in the sidebar header
//
// A curve that divides the header into two fields: warm above, cool below,
// both only hinted at. The line stays the main thing - the fields give it a
// horizon that makes the amplitude readable without having to follow the line.
//
// Four quantities, all derived from existing state:
//
//   Amplitude  how much is running at all - `busy` sessions above all, agents
//              with less weight (they keep working in the background while the
//              shell in front of them sits still).
//   Density    how much runs *in parallel*: the more agents are underway, the
//              more wave crests stand side by side. That is the quantity a
//              number shows badly and a picture shows well.
//   Colouring  of the fields picks up with the load; the gradient wanders very
//              slowly through two related tones.
//   Progress   the share of completed notes, as a brightness step in the line
//              and as a mark at the edge. When a note is added, a bright flash
//              runs across it.
//
// The loop only runs while something is moving: if everything is still, one
// last frame is drawn and rAF is unsubscribed. An app that stays open all day
// should not burn a core on decoration.
// ---------------------------------------------------------------------------
const pulseCanvas = $('#pulse-canvas');
const pulseCtx = pulseCanvas.getContext('2d');
const pulseCalm = window.matchMedia('(prefers-reduced-motion: reduce)');
const PULSE = { amp: 0, prog: 0, phase: 0, flash: 0, dens: 1, load: 0, drift: 0 };
let pulseRaf = 0;
let pulseLast = 0;
let pulseProgSeen = null;

function pulseBusy() {
  let n = 0;
  for (const s of sessions.values()) if (!s.exited && s.state === 'busy') n++;
  return n;
}

// All agents across all sessions - the header shows the deck, not one tile
function pulseAgents() {
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.exited && s.agents) n += s.agents.running;
  }
  return n;
}

// null = no denominator. Without notes there is no progress to claim.
function pulseProgress() {
  const s = activeId && sessions.get(activeId);
  const todos = s ? s.todos : null;
  if (!todos || !todos.length) return null;
  return todos.filter((t) => t.done).length / todos.length;
}

function sizePulse() {
  const dpr = window.devicePixelRatio || 1;
  pulseCanvas.width = Math.max(1, Math.round(pulseCanvas.clientWidth * dpr));
  pulseCanvas.height = Math.max(1, Math.round(pulseCanvas.clientHeight * dpr));
  pulseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Two superimposed sines of different length - a single wave looks like a
// screensaver, two look like an instrument. `dens` compresses both at once so
// the pattern gets denser with many agents without losing its character.
function pulseWaveAt(x) {
  const d = PULSE.dens;
  return PULSE.amp * (Math.sin(x * 0.055 * d + PULSE.phase) * 0.6
    + Math.sin(x * 0.021 * d - PULSE.phase * 1.4) * 0.4);
}

// Largest amplitude: the curve should graze the edge, not bump into it.
function pulseMaxAmp(h) {
  return Math.max(0.5, h / 2 - 3);
}

// Two related tones per field, between which the gradient wanders across the
// width. Two tones from the same corner of the colour wheel, not two colours:
// the shift should read as a shimmer, not as a rainbow.
const PULSE_WARM = [[217, 164, 65], [206, 118, 92]];   // amber -> copper
// The lower field carries the panel tone within it: muted tones that only push
// #16181f towards green or blue instead of laying a colour on top.
const PULSE_COOL = [[84, 134, 112], [78, 122, 142]];   // sage -> slate

function pulseMix([ar, ag, ab], [br, bg, bb], t) {
  return `${Math.round(ar + (br - ar) * t)}, `
    + `${Math.round(ag + (bg - ag) * t)}, `
    + `${Math.round(ab + (bb - ab) * t)}`;
}

// The gradient runs cyclically (cos) so the left and right edges match and the
// wandering leaves no seam.
function pulseFieldFill(w, [a, b], alpha) {
  const g = pulseCtx.createLinearGradient(0, 0, w, 0);
  const STOPS = 6;
  for (let i = 0; i <= STOPS; i++) {
    const p = i / STOPS;
    const t = (1 - Math.cos((p + PULSE.drift) * Math.PI * 2)) / 2;
    g.addColorStop(p, `rgba(${pulseMix(a, b, t)}, ${alpha})`);
  }
  return g;
}

function drawPulse() {
  const w = pulseCanvas.clientWidth;
  const h = pulseCanvas.clientHeight;
  if (!w || !h) return;
  const mid = h / 2;
  const edge = PULSE.prog * w;
  pulseCtx.clearRect(0, 0, w, h);

  // Sample the curve once - fields and line use the same points.
  const pts = [];
  for (let x = 0; x <= w; x += 2) pts.push([x, mid + pulseWaveAt(x)]);

  // The curve separates two fields: warm above (activity), cool below (what is
  // done). Kept pale - they should tint the header, not paint over it; wordmark
  // and buttons sit on top. With rising load the colouring picks up, so a full
  // deck still differs from an empty one even when you are not watching the
  // amplitude.
  const wash = 0.085 + PULSE.load * 0.09;

  // Upper field: warm, equally strong across the whole height.
  pulseCtx.beginPath();
  pulseCtx.moveTo(-2, 0);
  pulseCtx.lineTo(-2, pts[0][1]);
  for (const [px, py] of pts) pulseCtx.lineTo(px, py);
  pulseCtx.lineTo(w + 2, pts[pts.length - 1][1]);
  pulseCtx.lineTo(w + 2, 0);
  pulseCtx.closePath();
  pulseCtx.fillStyle = pulseFieldFill(w, PULSE_WARM, wash);
  pulseCtx.fill();

  // Lower field: already sits close to the panel tone by itself and becomes
  // fully transparent towards the bottom. Below the header the session list
  // continues in the same colour - a visible edge in between would be exactly
  // what one does not want here.
  pulseCtx.save();
  pulseCtx.beginPath();
  // The vertical edges lie outside the area: were they exactly on it,
  // half-opaque pixels would remain there that the fade-out can no longer
  // remove.
  pulseCtx.moveTo(-2, h);
  pulseCtx.lineTo(-2, pts[0][1]);
  for (const [px, py] of pts) pulseCtx.lineTo(px, py);
  pulseCtx.lineTo(w + 2, pts[pts.length - 1][1]);
  pulseCtx.lineTo(w + 2, h);
  pulseCtx.closePath();
  pulseCtx.clip();
  pulseCtx.fillStyle = pulseFieldFill(w, PULSE_COOL, wash * 1.15);
  // Beyond the edges: in device pixels the canvas is wider than the CSS width
  // suggests (a fractional devicePixelRatio), and the clipped last column would
  // otherwise be neither fully filled nor fully cleared.
  pulseCtx.fillRect(-2, 0, w + 4, h);
  // Pull the opacity down to zero from the line downwards. The gradient runs
  // across, the fade lengthwise - both in one gradient is impossible, so the
  // second direction is erased out instead of painted in.
  const fade = pulseCtx.createLinearGradient(0, mid, 0, h);
  fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  // Fully transparent just short of the bottom edge: if the ramp ran exactly to
  // h, a remnant would stay in the last pixel row because its centre still lies
  // above.
  fade.addColorStop(0.9, 'rgba(0, 0, 0, 1)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
  pulseCtx.globalCompositeOperation = 'destination-out';
  pulseCtx.fillStyle = fade;
  pulseCtx.fillRect(-2, 0, w + 4, h);
  pulseCtx.restore();

  // The line takes on the colour of the lower field: it is that field's edge,
  // not a stroke of its own. It carries the progress only in its brightness -
  // a little more present left of the mark than right of it. A colour change
  // would be too loud here now that the fields carry the colour.
  pulseCtx.lineWidth = 1.4;
  pulseCtx.lineJoin = 'round';
  const segs = [
    [0, edge, 0.34 + PULSE.load * 0.1],
    [edge, w, 0.24 + PULSE.load * 0.08],
  ];
  for (const [from, to, alpha] of segs) {
    if (to - from < 0.5) continue;
    pulseCtx.save();
    pulseCtx.beginPath();
    pulseCtx.rect(from, 0, to - from, h);
    pulseCtx.clip();
    pulseCtx.beginPath();
    for (const [px, py] of pts) {
      if (px === 0) pulseCtx.moveTo(px, py);
      else pulseCtx.lineTo(px, py);
    }
    pulseCtx.strokeStyle = pulseFieldFill(w, PULSE_COOL, alpha + PULSE.flash * 0.35);
    pulseCtx.stroke();
    pulseCtx.restore();
  }

  // Edge of the progress, briefly lighting up when something is ticked off. A
  // little stronger than the line: since that has withdrawn into the field,
  // this mark is the only place where the level is still readable at all.
  if (edge > 0.5 && edge < w) {
    pulseCtx.fillStyle = `rgba(78, 201, 122, ${0.38 + PULSE.flash * 0.5})`;
    pulseCtx.fillRect(edge - 0.75, mid - PULSE.amp - 3, 1.5, PULSE.amp * 2 + 6);
  }
}

function pulseTick(now) {
  pulseRaf = 0;
  const dt = Math.min(0.05, (now - pulseLast) / 1000) || 0.016;
  pulseLast = now;

  const busy = pulseBusy();
  const agents = pulseAgents();
  const h = pulseCanvas.clientHeight || 1;
  const idle = busy === 0 && agents === 0;

  // Agents count for less than busy sessions: they keep running in the
  // background while the shell in front of them sits still - that is less
  // activity than a terminal in which something visibly happens.
  const targetAmp = idle ? 0.5
    : Math.min(pulseMaxAmp(h), 1.4 + busy * 1.8 + agents * 0.8);
  // Capped: beyond a dozen agents, denser only turns into restless.
  const targetDens = 1 + Math.min(1.1, agents * 0.16);
  const targetLoad = Math.min(1, (busy * 0.3 + agents * 0.15));
  const p = pulseProgress();
  const targetProg = p === null ? 0 : p;
  if (pulseProgSeen !== null && p !== null && p > pulseProgSeen) PULSE.flash = 1;
  pulseProgSeen = p;

  PULSE.amp += (targetAmp - PULSE.amp) * Math.min(1, dt * 4);
  PULSE.prog += (targetProg - PULSE.prog) * Math.min(1, dt * 5);
  // Let the density follow more softly than the amplitude: an agent that
  // finishes should not make the pattern jump.
  PULSE.dens += (targetDens - PULSE.dens) * Math.min(1, dt * 1.5);
  PULSE.load += (targetLoad - PULSE.load) * Math.min(1, dt * 2);
  // Very slow - one cycle takes over a minute. If the deck stands still, so
  // does the gradient: otherwise the loop would run forever for decoration.
  if (!idle) PULSE.drift = (PULSE.drift + dt * 0.016) % 1;
  PULSE.phase += dt * (idle ? 0.7 : 1.4 + busy * 0.8 + agents * 0.3);
  PULSE.flash = Math.max(0, PULSE.flash - dt * 1.6);
  drawPulse();

  // Only keep running while there is still movement pending
  const settled = idle && PULSE.flash <= 0
    && Math.abs(targetAmp - PULSE.amp) < 0.15
    && Math.abs(targetDens - PULSE.dens) < 0.01
    && Math.abs(targetLoad - PULSE.load) < 0.004
    && Math.abs(targetProg - PULSE.prog) < 0.004;
  if (!settled) pulseRaf = requestAnimationFrame(pulseTick);
}

function pulseWake() {
  if (pulseCalm.matches) {
    // Without motion: still show the progress as a calm line.
    // Density and colouring may stay: those are states, not motion.
    const p = pulseProgress();
    const agents = pulseAgents();
    PULSE.amp = 0.5;
    PULSE.dens = 1 + Math.min(1.1, agents * 0.16);
    PULSE.load = Math.min(1, pulseBusy() * 0.3 + agents * 0.15);
    PULSE.prog = p === null ? 0 : p;
    PULSE.flash = 0;
    pulseProgSeen = p;
    drawPulse();
    return;
  }
  if (pulseRaf) return;
  pulseLast = performance.now();
  pulseRaf = requestAnimationFrame(pulseTick);
}

pulseCalm.addEventListener('change', () => {
  if (pulseRaf) { cancelAnimationFrame(pulseRaf); pulseRaf = 0; }
  pulseWake();
});

// Keyboard shortcuts
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
    else if (panelZoomed) setPanelZoom(false);
    else if (gridOpen) closeGrid();
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
(async function init() {
  sizePulse();
  pulseWake();
  shells = await window.api.listShells();
  buildShellMenu();
  await newSession(shells[0] && shells[0].id);
  startUsagePolling();
  startDbPolling();
})();
