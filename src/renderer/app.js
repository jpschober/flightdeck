'use strict';
/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, I18nRuntime */

// ---------------------------------------------------------------------------
// Language
//
// The dictionary arrives ready-made from the main process (see preload.js) and
// the plural/placeholder logic is the same runtime the main process uses - the
// renderer only has to know how to reach it.
//
// Switching does not reload the page: the terminals hang off live PTYs in the
// main process, and a reload would drop the whole session list. So the visible
// text is replaced in place instead - see retranslate().
// ---------------------------------------------------------------------------
let locale = window.api.i18n.locale;
const locales = window.api.i18n.locales;
let t = I18nRuntime.createT(window.api.i18n.dict, locale);

const sessions = new Map(); // id -> { meta..., term, fit, paneEl, itemEl }
let activeId = null;
let shells = [];

// A file dropped on the window would otherwise navigate the document to it. The
// main process cancels that navigation as well; here the drop is swallowed before
// it becomes one.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => { e.preventDefault(); }, false);
}

// ---------------------------------------------------------------------------
// Logging
//
// The renderer is sandboxed and has no file access, so its lines go over the
// bridge into the main process's log file - one file per bug report. The same
// event repeated inside a few seconds is counted instead of written out again:
// a failing fit() during a divider drag fires with every mouse move. "Same
// event" means level, message and all fields - two sessions failing the same
// way are two events, and the count goes out with the next line so that "twice"
// and "two hundred times" stay distinguishable.
// ---------------------------------------------------------------------------
const logSeen = new Map(); // key -> { at, dropped }
const LOG_REPEAT_MS = 5000;
const LOG_KEYS_MAX = 100;

function logLine(level, message, data) {
  const fields = {};
  for (const [name, value] of Object.entries(data || {})) {
    if (!(value instanceof Error)) { fields[name] = value; continue; }
    // Errors travel as text: whether the bridge can clone an Error depends on
    // the Electron version, and a log line must not depend on that. The first
    // frames go along - a TypeError from a changed data format says what broke,
    // the stack says where.
    fields[name] = `${value.name}: ${value.message}`;
    if (value.stack && !fields.stack) fields.stack = String(value.stack).split('\n').slice(1, 4).join(' | ');
  }
  const key = `${level}|${message}|${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  const now = Date.now();
  const seen = logSeen.get(key);
  // Delete before setting, here and on the suppressed path: a Map keeps
  // insertion order and set() on an existing key does not move it, so without
  // this the message firing most often would be the first one evicted - and
  // eviction resets its throttle.
  if (seen && now - seen.at < LOG_REPEAT_MS) {
    seen.dropped += 1;
    logSeen.delete(key);
    logSeen.set(key, seen);
    return;
  }
  if (seen && seen.dropped) fields.repeats = seen.dropped;
  logSeen.delete(key);
  logSeen.set(key, { at: now, dropped: 0 });
  while (logSeen.size > LOG_KEYS_MAX) logSeen.delete(logSeen.keys().next().value);
  // Called from catch blocks, so it must not throw one of its own: a value the
  // bridge cannot clone would otherwise skip whatever follows the catch.
  try { window.api.log(level, message, fields); } catch { /* bridge gone or a value that will not travel */ }
}

const logDebug = (message, data) => logLine('debug', message, data);
const logWarn = (message, data) => logLine('warn', message, data);

const $ = (sel) => document.querySelector(sel);
const sessionListEl = $('#session-list');
const shellMenu = $('#shell-menu');
const moreMenu = $('#more-menu');
const terminalsEl = $('#terminals');
const emptyStateEl = $('#empty-state');
const prCardEl = $('#pr-card');
const prExtraEl = $('#pr-extra');
const fileListEl = $('#file-list');
const wtBannerEl = $('#wt-banner');

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
//
// The request is granted, and every granted one is shown: the sender is any
// output at all, a build script or a downloaded file included, and swapping the
// clipboard for a command the user then pastes into a shell is the point of the
// exercise. The report is what stands between the swap and the paste. Whoever
// does not want the write at all switches it off in the menu.
function handleOsc52(term) {
  term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(';') + 1);
    // "?" queries the clipboard. Do not answer: otherwise any output in the
    // terminal could read out its content.
    if (!payload || payload === '?') return true;
    let text = '';
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch (e) { logDebug('osc52: payload is not valid base64', { err: e }); return true; }
    if (!text) return true;
    window.api.clipboardWriteOsc52(text).then((res) => {
      if (res.off) showToast(t('osc52.off'));
      else if (res.written) showToast(t('osc52.written', { count: res.written }));
    }).catch((e) => logDebug('osc52: clipboard not written', { err: e }));
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

// Quotes are escaped as well: almost every caller interpolates the result into
// a double-quoted attribute value (title=, value=), and PR bodies, review
// comments and SQL migrations from a cloned repo are written by third parties.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
// Lists that are updated instead of rebuilt
//
// What the user has done to a panel hangs off its elements: which <details>
// is open, where the list is scrolled, what is selected. An element that is
// thrown away and built again takes all of that with it, so the panels find
// their elements again by id and set the fields that changed - the way
// buildSessionItem/updateSessionItem do it for the sidebar.
// ---------------------------------------------------------------------------

/** Set text only when it differs - an equal write drops a selection inside it. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setTitle(el, text) {
  if (el.title !== text) el.title = text;
}

/**
 * Bring the children of `container` into the order and the content of `items`.
 * `build` creates an empty element for an item, `update` fills it. An item's
 * `id` has to be unique inside the container and to name the kind of element
 * as well, so a heading is never reused as a row.
 */
function syncChildren(container, items, build, update) {
  const known = new Map();
  for (const el of container.children) {
    if (el.dataset.id && !known.has(el.dataset.id)) known.set(el.dataset.id, el);
  }
  const keep = new Set();
  let at = container.firstElementChild;
  for (const item of items) {
    let el = known.get(item.id);
    if (!el || keep.has(el)) {
      el = build(item);
      el.dataset.id = item.id;
    }
    keep.add(el);
    update(el, item);
    // Everything before `at` is already in place, so the element belongs
    // exactly there - either it is already standing there or it moves there.
    if (el === at) at = at.nextElementSibling;
    else container.insertBefore(el, at);
  }
  for (const el of [...container.children]) if (!keep.has(el)) el.remove();
}

/**
 * A sentence from the dictionary with marked slots in it: the text carries
 * \u0000 and \u0001 where a `tag` element with the matching value goes. Text
 * and value are set separately, so nothing from outside becomes markup.
 */
function setSlotSentence(el, text, tag, values) {
  const parts = text.split(/[\u0000\u0001]/);
  if (el.children.length !== parts.length * 2 - 1) {
    el.replaceChildren();
    for (let i = 0; i < parts.length; i++) {
      if (i) el.appendChild(document.createElement(tag));
      el.appendChild(document.createElement('span'));
    }
  }
  let slot = 0;
  let part = 0;
  for (const child of el.children) {
    setText(child, child.tagName === tag.toUpperCase() ? (values[slot++] || '') : parts[part++]);
  }
}

// ---------------------------------------------------------------------------
// Toast: one line for what happened without being asked for
//
// One message at a time, the next one replaces it. A stack would grow with
// every clipboard write a loop in the terminal sends and cover the screen, and
// only the last one says what is on the clipboard now. Nothing here takes the
// focus - typing goes on in the terminal while the line stands.
// ---------------------------------------------------------------------------
const toastEl = $('#toast');
const TOAST_MS = 4000;
let toastTimer = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
    toastEl.textContent = '';
  }, TOAST_MS);
}

// ---------------------------------------------------------------------------
// Overlays and mode switches
//
// Preview, database comparison and the session browser differ in content only.
// Each closes on a click on the backdrop, on its close button and on Escape,
// and each hands the focus back to the terminal - the terminal is where typing
// goes on, and a layer that leaves the focus behind swallows the next keystroke.
// ---------------------------------------------------------------------------
const overlays = []; // most recently opened first - that is the Escape order

function focusActiveTerm() {
  const s = activeId && sessions.get(activeId);
  if (s) s.term.focus();
}

function makeOverlay(el, closeEl) {
  const overlay = {
    isOpen: () => !el.classList.contains('hidden'),
    open() {
      el.classList.remove('hidden');
      const at = overlays.indexOf(overlay);
      if (at > 0) overlays.unshift(...overlays.splice(at, 1));
    },
    close() {
      el.classList.add('hidden');
      focusActiveTerm();
    },
  };
  el.addEventListener('click', (e) => { if (e.target === el) overlay.close(); });
  if (closeEl) closeEl.addEventListener('click', () => overlay.close());
  overlays.unshift(overlay);
  return overlay;
}

/** Closes the topmost open overlay; reports whether there was one. */
function closeTopOverlay() {
  const top = overlays.find((o) => o.isOpen());
  if (!top) return false;
  top.close();
  return true;
}

/**
 * The row of mode buttons above preview and comparison. Fewer than two modes
 * leave the row empty - there is nothing to switch between.
 */
function renderModeButtons(container, modes, current, onPick) {
  container.innerHTML = '';
  if (modes.length < 2) return;
  for (const m of modes) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.className = m.id === current ? 'active' : '';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { if (m.id !== current) onPick(m.id); });
    container.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Mini markdown renderer (PR descriptions, agent summaries).
// No external package (CSP) - covers the constructs agents typically use.
// ---------------------------------------------------------------------------
// mdInline sees text that escapeHtml has already been through, so a link target
// arrives with & as &amp; and every quote and angle bracket as an entity. A raw
// & can therefore only be the start of such an entity, and rejecting all of
// them except &amp; and &#39; keeps double quotes and brackets out of the
// attribute - an apostrophe cannot end the double-quoted value it sits in.
// Everything else passes, unicode paths and IDN hosts included; a target that
// fails keeps its literal [label](target) form instead of becoming an anchor.
const MD_URL = /^https?:\/\/[^\s&<>"']*(?:(?:&amp;|&#39;)[^\s&<>"']*)*$/u;

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, label, url) => (
      MD_URL.test(url) ? `<a href="#" data-url="${url}">${label}</a>` : m));
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

// index.html carries the English wording so the file reads on its own; these
// attributes say which key takes its place.
function applyStaticI18n() {
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
async function retranslate() {
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
  // has just dropped its cache - so both are fetched again rather than taken
  // from the copy the renderer is holding.
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

async function setLanguage(code) {
  if (code === locale) return;
  const res = await window.api.setLocale(code);
  locale = res.locale;
  t = I18nRuntime.createT(res.dict, locale);
  await retranslate();
}

// The shells come from the main process and one of them ("Command Prompt") is
// translated there, so the menu is rebuilt rather than relabelled.
async function buildShellMenu() {
  shells = await window.api.listShells();
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

// Whether the terminal output may write the clipboard (OSC 52). The main
// process owns the setting; this is the copy the menu draws itself from.
let osc52On = true;

// Everything that is not "start a new session" lives in one menu. Those are
// the rare moves - a permanent button each turned the header into a row of
// competing icons, and the shortcut belongs next to the entry anyway.
function buildMoreMenu() {
  moreMenu.innerHTML = '';

  const entry = (className, icon, label, shortcut, onClick) => {
    const b = document.createElement('button');
    b.className = className;
    b.innerHTML = '<span class="mi-icon"></span><span class="mi-label"></span><span class="mi-key"></span>';
    b.querySelector('.mi-icon').textContent = icon;
    b.querySelector('.mi-label').textContent = label;
    b.querySelector('.mi-key').textContent = shortcut;
    b.addEventListener('click', () => { moreMenu.classList.add('hidden'); onClick(); });
    moreMenu.appendChild(b);
  };

  entry('menu-item', '⊞', t('header.grid.aria'), `${t('key.ctrl')}+G`, toggleGrid);
  entry('menu-item', '⟲', t('header.sessions.aria'), '', openSessionBrowser);
  // The state travels with the entry: the checkmark is what says whether the
  // terminal output may write the clipboard.
  entry(`menu-item${osc52On ? ' active' : ''}`, osc52On ? '✓' : '', t('menu.osc52'), '', async () => {
    osc52On = await window.api.setOsc52Enabled(!osc52On);
    buildMoreMenu();
  });

  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  moreMenu.appendChild(sep);
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = t('header.language.title');
  moreMenu.appendChild(title);

  for (const l of locales) {
    const active = l.code === locale;
    // The endonym is not translated - see the registry in src/i18n/index.js.
    entry(`menu-item lang${active ? ' active' : ''}`, active ? '✓' : '', l.name, '',
      () => setLanguage(l.code));
  }
}

// ---------------------------------------------------------------------------
// Create / activate / close sessions
// ---------------------------------------------------------------------------
// The WebGL renderer draws the terminal on the GPU instead of building a DOM
// node per cell. The addon has to be loaded after term.open(), because it needs
// the element. A lost GPU context (driver reset, suspend) cannot be restored by
// the addon; it is disposed and xterm falls back to the DOM renderer.
//
// Inactive panes keep their context: they are hidden with `visibility`, not
// removed. Chromium caps the contexts per page at around 16 and evicts the
// oldest one beyond that, which costs the affected terminal a redraw and the
// three seconds the addon waits for a restore before it falls back.
function loadWebgl(term) {
  if (typeof WebglAddon === 'undefined') return;
  let webgl = null;
  try {
    webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (e) {
    // No WebGL context, or activate() failed partway and left the addon
    // registered with only some of its disposables attached. The terminal falls
    // back to the DOM renderer and gets slower, which is what the user sees.
    logWarn('terminal: WebGL renderer not available, falling back to the DOM one', { err: e });
    if (webgl) { try { webgl.dispose(); } catch (e2) { logDebug('terminal: WebGL addon not disposable', { err: e2 }); } }
  }
}

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
  loadWebgl(term);

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
    gitBlocked: null,
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
        try { s.fit.fit(); } catch (e) { logDebug('terminal: fit failed, pane may still be 0px', { session: s.id, err: e }); }
        s.term.focus();
      });
    }
  }
  emptyStateEl.classList.toggle('hidden', sessions.size > 0);
  renderContextPanel();
  const active = id ? sessions.get(id) : null;
  renderHistory(active);
  loadTodosFor(active);
  // Different project, different schema - the cards of the old one and what
  // was expanded on them no longer fit
  dbTablesEl.replaceChildren();
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
    <button class="si-close"></button>`;
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
  const closeEl = el.querySelector('.si-close');
  closeEl.textContent = '✕';
  closeEl.title = t('session.close');
  closeEl.setAttribute('aria-label', t('session.close'));
  el.classList.toggle('exited', s.exited);
  const statusEl = el.querySelector('.si-status');
  const state = s.exited ? 'exited' : (s.state || 'idle');
  statusEl.className = 'si-status ' + state;
  statusEl.title = t('session.state.' + (
    state === 'busy' || state === 'attention' || state === 'exited' ? state : 'idle'));
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
  el.title = [t('session.agents', { count: n }), ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Right-hand panel: PR + changed files
// ---------------------------------------------------------------------------
function renderContextPanel() {
  const s = activeId ? sessions.get(activeId) : null;
  renderWorktreeBanner(s);
  renderPrCard(s);
  renderPrExtra(s ? s.pr : null);
  renderFileList(s);
  updateBadges(s);
}

// Branch and files then come from the agent's directory, not from the shell's
// - without a notice that would be impossible to follow.
function renderWorktreeBanner(s) {
  const worktree = s ? s.worktree : null;
  wtBannerEl.classList.toggle('hidden', !worktree);
  if (!worktree) return;
  if (!wtBannerEl.firstElementChild) {
    wtBannerEl.innerHTML = `
      <span class="wt-icon">⑂</span>
      <span class="wt-text"><span class="wt-notice"></span> <code></code></span>
      <span class="wt-sub"></span>`;
  }
  setText(wtBannerEl.querySelector('.wt-notice'), t('git.worktree.notice'));
  setText(wtBannerEl.querySelector('.wt-text code'), worktree);
  const subEl = wtBannerEl.querySelector('.wt-sub');
  setText(subEl, t('git.worktree.shell', { path: s.cwd }));
  setTitle(subEl, s.agentCwd || '');
}

// The card has five shapes: a pull request, a branch without one, a repository
// git is kept out of (not the same as "no repository": there is one here, and
// it is on purpose - see gitinfo.js), no repository at all, and no session.
// The shape decides the skeleton - it is built when the shape changes, and
// from then on only the fields are set.
const PR_CARD_HTML = `
  <div class="pr-title" role="link"></div>
  <div class="pr-meta">
    <span class="pr-state"></span>
    <span class="pr-author"></span>
    <div class="pr-checks">
      <span class="check-chip failure"></span>
      <span class="check-chip pending"></span>
      <span class="check-chip success"></span>
    </div>
  </div>
  <div class="pr-branches"></div>
  <div class="pr-stats"><span class="add"></span> <span class="del"></span></div>`;

const CHECK_MARK = { failure: '✗', pending: '●', success: '✓' };

function renderPrCard(s) {
  const pr = s ? s.pr : null;
  const shape = !s ? 'nosession'
    : pr ? 'pr'
      : s.branch ? 'branch'
        : s.gitBlocked ? 'blocked' : 'norepo';

  if (prCardEl.dataset.shape !== shape) {
    prCardEl.dataset.shape = shape;
    if (shape === 'pr') {
      prCardEl.innerHTML = PR_CARD_HTML;
      const titleEl = prCardEl.querySelector('.pr-title');
      makeKeyActivatable(titleEl);
      // The PR of the session that is showing now, not the one that was
      // showing when the card was built.
      titleEl.addEventListener('click', () => {
        const cur = activeId && sessions.get(activeId);
        if (cur && cur.pr) window.api.openExternal(cur.pr.url);
      });
    } else {
      prCardEl.innerHTML = `<div class="${shape === 'blocked' ? 'git-blocked' : 'muted'}"></div>`;
    }
  }

  const lineEl = prCardEl.firstElementChild;
  if (shape === 'nosession') { setText(lineEl, t('common.noSession')); return; }
  if (shape === 'norepo') { setText(lineEl, t('git.noRepo')); return; }
  if (shape === 'branch') {
    setSlotSentence(lineEl, t('git.pr.none', { branch: '\u0000' }), 'code', [s.branch]);
    return;
  }
  if (shape === 'blocked') {
    setSlotSentence(lineEl, t('git.blocked', { key: '\u0000' }), 'code', [s.gitBlocked]);
    return;
  }

  const titleEl = prCardEl.querySelector('.pr-title');
  setText(titleEl, `#${pr.number} ${pr.title}`);
  setTitle(titleEl, t('git.pr.open'));

  const stateEl = prCardEl.querySelector('.pr-state');
  stateEl.className = 'pr-state ' + (pr.isDraft ? 'draft' : pr.state.toLowerCase());
  setText(stateEl, pr.isDraft ? 'Draft' : pr.state);

  const authorEl = prCardEl.querySelector('.pr-author');
  authorEl.classList.toggle('hidden', !pr.author);
  setText(authorEl, pr.author ? t('git.pr.by', { author: pr.author }) : '');

  const checks = pr.checks && pr.checks.total ? pr.checks : null;
  prCardEl.querySelector('.pr-checks').classList.toggle('hidden', !checks);
  for (const kind of Object.keys(CHECK_MARK)) {
    const chipEl = prCardEl.querySelector('.check-chip.' + kind);
    const count = checks ? checks[kind] : 0;
    chipEl.classList.toggle('hidden', !count);
    setText(chipEl, count ? `${CHECK_MARK[kind]} ${count}` : '');
  }

  setText(prCardEl.querySelector('.pr-branches'), `${pr.headRefName} → ${pr.baseRefName}`);
  setText(prCardEl.querySelector('.pr-stats .add'), `+${pr.additions ?? 0}`);
  setText(prCardEl.querySelector('.pr-stats .del'), `−${pr.deletions ?? 0}`);
}

// PR extra sections (description, checks, commits, feedback). Which of them is
// open is the user's doing and stays in the DOM, so the sections are found
// again by their id and only their content is replaced.
function renderPrExtra(pr) {
  const items = [];

  if (pr && pr.body && pr.body.trim()) {
    items.push({ id: 'body', title: t('git.pr.description'), html: `<div class="md">${mdToHtml(pr.body)}</div>` });
  }

  if (pr && pr.checks && pr.checks.total) {
    items.push({
      id: 'checks',
      title: t('git.pr.checks', {
        success: pr.checks.success, failure: pr.checks.failure, pending: pr.checks.pending,
      }),
      html: pr.checks.items.map((c) =>
        `<div class="check-row"><span class="check-dot ${c.status}"></span>${escapeHtml(c.name)}</div>`).join(''),
    });
  }

  if (pr && pr.commits && pr.commits.length) {
    items.push({
      id: 'commits',
      title: t('git.pr.commits', { count: pr.commits.length }),
      html: pr.commits.slice().reverse().map((c) =>
        `<div class="commit-row"><code class="commit-sha">${escapeHtml(c.sha)}</code>${escapeHtml(c.message)}</div>`).join(''),
    });
  }

  const feedback = pr ? [
    ...(pr.reviews || []).map((r) => ({ ...r, kind: 'review', at: r.submittedAt })),
    ...(pr.comments || []).map((c) => ({ ...c, kind: 'comment', at: c.createdAt })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)) : [];
  if (feedback.length) {
    items.push({
      id: 'feedback',
      title: t('git.pr.feedback', { count: feedback.length }),
      html: feedback.map((f) => `
        <div class="fb-row">
          <div class="fb-head">
            <strong>${escapeHtml(f.author || '?')}</strong>
            ${f.kind === 'review' ? `<span class="fb-state ${escapeHtml((f.state || '').toLowerCase())}">${escapeHtml(f.state || '')}</span>` : ''}
            <span class="fb-date">${f.at ? new Date(f.at).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
          </div>
          ${f.body ? `<div class="md">${mdToHtml(f.body)}</div>` : ''}
        </div>`).join(''),
    });
  }

  syncChildren(prExtraEl, items, buildPrDetails, updatePrDetails);
}

function buildPrDetails() {
  const d = document.createElement('details');
  d.className = 'pr-details';
  d.innerHTML = '<summary></summary><div class="pr-details-body"></div>';
  return d;
}

// What a section body was last built from. Keyed by the element, so the entry
// goes when the section goes - and the body is only rebuilt when its content
// has actually changed. A PR whose checks turn green sends an info tick every
// few seconds; without this, a selection in the description would not survive
// one of them.
const prDetailsHtml = new WeakMap();

function updatePrDetails(el, item) {
  setText(el.querySelector('summary'), item.title);
  const body = el.querySelector('.pr-details-body');
  if (prDetailsHtml.get(body) === item.html) return;
  prDetailsHtml.set(body, item.html);
  body.innerHTML = item.html;
}

function renderFileList(s) {
  syncChildren(fileListEl, fileItems(s), buildFileItem, updateFileItem);
}

/**
 * Headings and rows of the file list in the order they are shown. The id names
 * the group as well, so the same path can stand in the committed and in the
 * changed group without the two sharing an element.
 */
function fileItems(s) {
  const items = [];
  if (!s) return items;

  // As soon as a PR exists, its file list is the authoritative one - the local
  // memory would only duplicate it.
  if (s.pr && s.pr.files && s.pr.files.length) {
    items.push({ id: 'title:pr', title: t('git.files.inPr', { count: s.pr.files.length }) });
    for (const f of s.pr.files) items.push({ id: `pr:${f.path}`, file: f, source: 'pr' });
  } else if (s.files.length) {
    const open = s.files.filter((f) => !f.committed);
    const done = s.files.filter((f) => f.committed);
    if (open.length) {
      items.push({ id: 'title:worktree', title: t('git.files.worktree') });
      for (const f of open) items.push({ id: `wt:${f.path}`, file: f, source: 'wt' });
    }
    if (done.length) {
      items.push({ id: 'title:committed', title: t('git.files.committed', { count: done.length }) });
      for (const f of done) items.push({ id: `committed:${f.path}`, file: f, source: 'wt' });
    }
  }

  if (!items.length) items.push({ id: 'empty', title: s.branch ? t('git.files.none') : '—', muted: true });
  return items;
}

function buildFileItem(item) {
  const el = document.createElement('div');
  if (!item.file) {
    el.className = item.muted ? 'muted' : 'file-group-title';
    return el;
  }
  el.className = 'file-item';
  el.innerHTML = `
    <span class="file-status"></span>
    <span class="file-path"></span>
    <span class="file-diffstat"><span class="add"></span> <span class="del"></span></span>`;
  makeKeyActivatable(el);
  // Directories (git reports them untracked with a trailing slash) are not
  // clickable - a file preview of them is bound to fail.
  el.addEventListener('click', () => {
    if (!el.classList.contains('is-dir')) openPreview(activeId, item.file.path, item.source);
  });
  return el;
}

function updateFileItem(el, item) {
  const f = item.file;
  if (!f) { setText(el, item.title); return; }

  const isDir = Boolean(f.dir);
  const status = item.source === 'pr' ? 'M'
    : f.committed ? 'C'
      : f.untracked ? 'U' : f.status;

  el.classList.toggle('committed', Boolean(f.committed));
  el.classList.toggle('is-dir', isDir);
  el.tabIndex = isDir ? -1 : 0;
  setTitle(el, isDir ? t('git.files.dir', { path: f.path }) : f.path);

  const statusEl = el.querySelector('.file-status');
  statusEl.className = `file-status ${status}`;
  setText(statusEl, status);
  // Between the marks the path reads from the left even though the box lays it
  // out from the right (see .file-path in the stylesheet).
  setText(el.querySelector('.file-path'), `\u200e${f.path}\u200e`);

  const statEl = el.querySelector('.file-diffstat');
  statEl.classList.toggle('hidden', f.additions === undefined && f.deletions === undefined);
  setText(statEl.querySelector('.add'), `+${f.additions ?? 0}`);
  setText(statEl.querySelector('.del'), `−${f.deletions ?? 0}`);
}

// ---------------------------------------------------------------------------
// Input history
// ---------------------------------------------------------------------------
const historyListEl = $('#history-list');

function renderHistory(s) {
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
    todoListEl.innerHTML = `<div class="muted">${escapeHtml(t('notes.empty'))}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  todos.forEach((todo, idx) => {
    const el = document.createElement('div');
    el.className = 'todo-item' + (todo.done ? ' done' : '');
    el.innerHTML = `
      <input type="checkbox" ${todo.done ? 'checked' : ''} title="${escapeHtml(t('notes.done'))}" />
      <span class="todo-text"></span>
      <button class="todo-del" title="${escapeHtml(t('notes.delete'))}" aria-label="${escapeHtml(t('notes.delete.aria'))}">✕</button>`;
    el.querySelector('.todo-text').textContent = todo.text;
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
  view: null,
  baseline: 'auto',
  filter: '',
  loading: false,
};
let dbTimer = null;

const STATUS_MARK = { added: '+', removed: '−', changed: '~', same: '' };
// The status word is looked up per render - a language switch has to reach it.
const STATUS_WORD = (status) => (status === 'same' ? '' : t('db.status.' + status));

// Short tags for the constraints that affect a column. The abbreviations stay
// as they are - they are read as symbols, and a two-letter marker that changes
// with the language would lose that. The tooltip carries the translation.
const KIND_TAG = {
  pk: { tag: 'PK', key: 'db.tag.pk' },
  fk: { tag: 'FK', key: 'db.tag.fk' },
  unique: { tag: 'UQ', key: 'db.tag.unique' },
  check: { tag: 'CK', key: 'db.tag.check' },
  index: { tag: 'IX', key: 'db.tag.index' },
  exclude: { tag: 'EX', key: 'db.tag.exclude' },
};

function fmtDefault(v) {
  return v === null || v === undefined ? '' : String(v);
}

// The diff names the changed column properties by their internal name (`type`,
// `nullable`, ...). Looked up per render, like the status word: a language
// switch has to reach it.
const fieldLabel = (field) => t('db.field.' + field);

/** The extra details of a column, in the order one reads them. */
function colMeta(col) {
  const out = [];
  if (!col.nullable) out.push('NOT NULL');
  if (col.identity) out.push('identity');
  if (col.generated) out.push(t('db.col.generated'));
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
  if (p.roles && p.roles.length) bits.push(t('db.policy.for', { roles: p.roles.join(', ') }));
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
  return tags.map((tag) => `<span class="db-tag ${tag.tag.toLowerCase()}" title="${escapeHtml(t(tag.key))}">${tag.tag}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function loadDbSchema(force = false) {
  const s = activeId && sessions.get(activeId);
  if (!s) {
    dbState.view = null;
    renderDbPanel();
    return;
  }
  if (dbState.loading && !force) return;
  dbState.loading = true;
  try {
    const view = await window.api.getDbSchema(s.id, { baseline: dbState.baseline, force });
    if (s.id !== activeId) return; // switched away in the meantime
    dbState.view = view;
    renderDbPanel();
    if (dbDiffOverlay.isOpen()) renderDbDiff();
  } catch (e) {
    logWarn('dbschema: panel not loaded', { session: s.id, baseline: dbState.baseline, err: e });
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
  dbTimer = setInterval(() => {
    loadDbSchema().catch((e) => logWarn('dbschema: background poll failed', { err: e }));
  }, 10_000);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function renderDbPanel() {
  const view = dbState.view;
  const ok = Boolean(view && view.ok && view.plugin);
  renderDbHead(ok ? view : null);
  renderDbSignal(ok ? view : null);
  dbSearchEl.classList.toggle('hidden', !ok);
  renderDbTables(view);
  setDbBadge(ok ? (view.changeCount || 0) : 0);
}

// What the reader could not make sense of - an unparsable migration, a file it
// could not read, a plugin that threw. The schema on display is incomplete by
// exactly this list, which is why it stands next to it and not only in the log.
function buildDbWarnings() {
  const el = document.createElement('details');
  el.className = 'db-warn';
  el.innerHTML = '<summary></summary><ul></ul>';
  return el;
}

function updateDbWarnings(el, schema) {
  const warnings = (schema && schema.warnings) || [];
  el.classList.toggle('hidden', !warnings.length);
  setText(el.querySelector('summary'), t('db.warnings', { count: warnings.length }));
  syncChildren(
    el.querySelector('ul'),
    warnings.map((w, i) => ({ id: String(i), text: w })),
    () => document.createElement('li'),
    (li, item) => setText(li, item.text),
  );
}

const DB_HEAD_HTML = `
  <div class="db-top">
    <span class="db-plugin"></span>
    <span class="db-files"></span>
    <button id="db-refresh" class="icon-btn">↻</button>
  </div>
  <div class="db-baseline-row">
    <label class="db-base"><span class="db-base-label"></span><select id="db-baseline"></select></label>
    <span class="db-base-none muted"></span>
  </div>`;

function renderDbHead(view) {
  if (!view) { dbHeadEl.replaceChildren(); return; }
  if (!dbHeadEl.firstElementChild) {
    dbHeadEl.innerHTML = DB_HEAD_HTML;
    dbHeadEl.appendChild(buildDbWarnings());
    dbHeadEl.querySelector('#db-refresh').addEventListener('click', () => loadDbSchema(true));
    dbHeadEl.querySelector('#db-baseline').addEventListener('change', (e) => {
      dbState.baseline = e.target.value;
      loadDbSchema(true);
    });
  }

  const pluginEl = dbHeadEl.querySelector('.db-plugin');
  setText(pluginEl, view.plugin.label);
  setTitle(pluginEl, (view.plugin.evidence || []).join('\n'));
  setText(dbHeadEl.querySelector('.db-files'),
    `${t('db.tables', { count: view.schema.tables.length })} · ${t('db.files', { count: view.schema.files.length })}`);
  const refreshEl = dbHeadEl.querySelector('#db-refresh');
  setTitle(refreshEl, t('db.refresh'));
  refreshEl.setAttribute('aria-label', t('db.refresh'));

  const hasBaselines = view.baselines.length > 0;
  dbHeadEl.querySelector('.db-base').classList.toggle('hidden', !hasBaselines);
  setText(dbHeadEl.querySelector('.db-base-label'), t('db.baseline'));
  const noneEl = dbHeadEl.querySelector('.db-base-none');
  noneEl.classList.toggle('hidden', hasBaselines);
  setText(noneEl, hasBaselines ? '' : t('db.baseline.none'));

  const sel = dbHeadEl.querySelector('#db-baseline');
  syncChildren(
    sel,
    view.baselines.map((b) => ({ id: b.mode, baseline: b })),
    () => document.createElement('option'),
    (el, item) => {
      el.value = item.baseline.mode;
      setText(el, item.baseline.label);
      setTitle(el, item.baseline.hint || '');
    },
  );
  // While the list is open the choice being made there wins - the pass that
  // runs in between must not put the previous one back.
  if (document.activeElement !== sel) sel.value = (view.baseline && view.baseline.mode) || '';

  updateDbWarnings(dbHeadEl.querySelector('.db-warn'), view.schema);
}

const DB_SIGNAL_OK_HTML = `
  <div class="db-signal ok">
    <span class="db-signal-icon">✓</span>
    <span class="db-signal-note"></span>
  </div>`;

const DB_SIGNAL_ALERT_HTML = `
  <div class="db-signal alert">
    <span class="db-signal-icon">⚠</span>
    <div class="db-signal-text">
      <strong class="db-changed"></strong> <span class="db-compared"></span>
      <div class="db-signal-sub">
        <span class="db-change-text"></span>
        <div class="db-detail"></div>
      </div>
    </div>
    <button id="db-open-diff"></button>
  </div>`;

function renderDbSignal(view) {
  const d = view && view.diff;
  const shape = !d ? 'none' : d.changed ? 'alert' : 'ok';
  if (dbSignalEl.dataset.shape !== shape) {
    dbSignalEl.dataset.shape = shape;
    dbSignalEl.innerHTML = shape === 'ok' ? DB_SIGNAL_OK_HTML
      : shape === 'alert' ? DB_SIGNAL_ALERT_HTML : '';
    if (shape === 'alert') dbSignalEl.querySelector('#db-open-diff').addEventListener('click', openDbDiff);
  }
  if (shape === 'none') return;
  if (shape === 'ok') {
    setSlotSentence(dbSignalEl.querySelector('.db-signal-note'),
      t('db.unchanged', { baseline: '\u0000' }), 'strong', [view.baseline.label]);
    return;
  }

  const sum = d.summary;
  const detail = [
    partsText(sum.columns, 'db.parts.columns'),
    partsText(sum.constraints, 'db.parts.constraints'),
    partsText(sum.policies, 'db.parts.policies'),
  ].filter(Boolean).join(' · ');

  setText(dbSignalEl.querySelector('.db-changed'), t('db.changed'));
  setText(dbSignalEl.querySelector('.db-compared'), t('db.comparedTo', { baseline: view.baseline.label }));
  setText(dbSignalEl.querySelector('.db-change-text'), view.changeText);
  const detailEl = dbSignalEl.querySelector('.db-detail');
  detailEl.classList.toggle('hidden', !detail);
  setText(detailEl, detail);
  const btn = dbSignalEl.querySelector('#db-open-diff');
  setText(btn, t('db.compare'));
  setTitle(btn, t('db.compare.title'));
}

function partsText(counts, nounKey) {
  const bits = [];
  if (counts.added) bits.push(t('db.count.new', { count: counts.added }));
  if (counts.removed) bits.push(t('db.count.removed', { count: counts.removed }));
  if (counts.changed) bits.push(t('db.count.changed', { count: counts.changed }));
  if (!bits.length) return '';
  const total = counts.added + counts.removed + counts.changed;
  return `${t(nounKey, { count: total })}: ${bits.join(', ')}`;
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
  syncChildren(dbTablesEl, dbTableItems(view), buildDbItem, updateDbItem);
}

/**
 * Everything the table list shows, in order. The search hides what does not
 * match instead of dropping it: an open table stays open while one searches
 * past it, and typing does not rebuild the list letter by letter.
 */
function dbTableItems(view) {
  if (!view || !view.ok) {
    return [{ id: 'note', kind: 'note', text: view && view.error ? view.error : t('common.noSession') }];
  }
  if (!view.plugin) {
    // "Nothing detected" and "a plugin broke on the way there" look the same
    // in the panel otherwise. The warnings tell them apart.
    return [
      { id: 'note', kind: 'note', text: t('db.none') },
      { id: 'hint', kind: 'hint', codes: [view.project || view.root || '', 'supabase/migrations'] },
      { id: 'warn', kind: 'warn', schema: view.schema },
    ];
  }

  const q = dbState.filter.trim().toLowerCase();
  const look = diffLookup(view);
  const items = [];

  if (view.schema.enums.length) {
    const enumDiff = new Map((view.diff ? view.diff.enums : []).map((e) => [e.id, e]));
    const rows = view.schema.enums.map((e) => ({
      id: `enum:${e.id}`,
      enumeration: e,
      diff: enumDiff.get(e.id),
      hidden: Boolean(q) && !e.name.toLowerCase().includes(q)
        && !e.values.some((v) => v.toLowerCase().includes(q)),
    }));
    const shown = rows.filter((r) => !r.hidden).length;
    items.push({ id: '__enums', kind: 'enums', rows, count: shown, hidden: !shown });
  }

  // Removed tables: no longer in the schema, but they have to stand out
  for (const td of (view.diff ? view.diff.tables : [])) {
    if (td.status !== 'removed') continue;
    items.push({
      id: `gone:${td.id}`, kind: 'gone', table: td,
      hidden: Boolean(q) && !td.name.toLowerCase().includes(q),
    });
  }

  for (const table of view.schema.tables) {
    items.push({
      id: `table:${table.id}`, kind: 'table', table, diff: look.get(table.id), q,
      hidden: Boolean(q) && !table.name.toLowerCase().includes(q)
        && !table.columns.some((c) => c.name.toLowerCase().includes(q)),
    });
  }

  if (!items.some((item) => !item.hidden)) {
    items.push({ id: 'empty', kind: 'note', text: q ? t('common.noMatches') : t('db.noTables') });
  }
  return items;
}

function buildDbItem(item) {
  if (item.kind === 'note') {
    const el = document.createElement('div');
    el.className = 'muted';
    return el;
  }
  if (item.kind === 'hint') {
    const el = document.createElement('div');
    el.className = 'db-hint';
    return el;
  }
  if (item.kind === 'warn') return buildDbWarnings();
  if (item.kind === 'enums') return buildDbEnums();
  if (item.kind === 'gone') return buildDbGoneTable();
  return buildDbTableCard();
}

function updateDbItem(el, item) {
  el.classList.toggle('hidden', Boolean(item.hidden));
  if (item.kind === 'note') { setText(el, item.text); return; }
  if (item.kind === 'hint') {
    setSlotSentence(el, t('db.none.hint', { project: '\u0000', path: '\u0001' }), 'code', item.codes);
    return;
  }
  if (item.kind === 'warn') { updateDbWarnings(el, item.schema); return; }
  if (item.kind === 'enums') { updateDbEnums(el, item); return; }
  if (item.kind === 'gone') { updateDbGoneTable(el, item); return; }
  updateDbTableCard(el, item);
}

function buildDbEnums() {
  const el = document.createElement('details');
  el.className = 'db-enums';
  el.innerHTML = '<summary></summary><div class="db-enum-list"></div>';
  return el;
}

function updateDbEnums(el, item) {
  setText(el.querySelector('summary'), t('db.enums', { count: item.count }));
  syncChildren(el.querySelector('.db-enum-list'), item.rows, buildDbEnumRow, updateDbEnumRow);
}

function buildDbEnumRow() {
  const el = document.createElement('div');
  el.innerHTML = '<span class="db-enum-name"></span><span class="db-enum-values"></span>';
  return el;
}

function updateDbEnumRow(el, item) {
  const d = item.diff;
  el.className = `db-enum ${d ? d.status : 'same'}`;
  el.classList.toggle('hidden', Boolean(item.hidden));
  setText(el.querySelector('.db-enum-name'), item.enumeration.name);
  const values = item.enumeration.values.map((v) => ({
    id: `v:${v}`, value: v, state: d && d.added && d.added.includes(v) ? 'added' : '',
  }));
  for (const v of (d && d.removed) || []) values.push({ id: `r:${v}`, value: v, state: 'removed' });
  syncChildren(
    el.querySelector('.db-enum-values'), values,
    () => document.createElement('code'),
    (code, value) => { code.className = value.state; setText(code, value.value); },
  );
}

function buildDbGoneTable() {
  const el = document.createElement('div');
  el.className = 'db-table removed-table';
  el.innerHTML = `<span class="db-status removed">−</span>
    <span class="db-table-name"></span>
    <span class="db-table-note"></span>`;
  return el;
}

function updateDbGoneTable(el, item) {
  setTitle(el.querySelector('.db-status'), t('db.table.removed'));
  setText(el.querySelector('.db-table-name'), `${item.table.schema}.${item.table.name}`);
  setText(el.querySelector('.db-table-note'), t('db.table.removed'));
}

const DB_TABLE_HTML = `
  <summary>
    <span class="db-status"></span>
    <span class="db-table-name"></span>
    <span class="db-schema"></span>
    <span class="db-rls">RLS</span>
    <span class="db-chip external"></span>
    <span class="db-count"></span>
    <span class="db-chip changed"></span>
  </summary>
  <div class="db-body"></div>`;

function buildDbTableCard() {
  const el = document.createElement('details');
  el.innerHTML = DB_TABLE_HTML;
  return el;
}

function updateDbTableCard(box, item) {
  const { table, diff: d, q } = item;
  const status = d ? d.status : 'same';
  box.className = `db-table ${status}`;
  box.classList.toggle('hidden', Boolean(item.hidden));

  const statusEl = box.querySelector('.db-status');
  statusEl.className = `db-status ${status}`;
  setText(statusEl, STATUS_MARK[status] || '·');
  setTitle(statusEl, STATUS_WORD(status) || t('db.status.same'));

  setText(box.querySelector('.db-table-name'), table.name);
  const schemaEl = box.querySelector('.db-schema');
  schemaEl.classList.toggle('hidden', table.schema === 'public');
  setText(schemaEl, table.schema);

  const rlsEl = box.querySelector('.db-rls');
  rlsEl.classList.toggle('hidden', !table.rls.enabled);
  rlsEl.classList.toggle('changed', Boolean(d && d.rlsChanged));
  setTitle(rlsEl, `${t('db.rls.title')}, ${table.rls.policies.length
    ? t('db.rls.policies', { count: table.rls.policies.length }) : t('db.rls.none')}`);

  const externalEl = box.querySelector('.db-chip.external');
  externalEl.classList.toggle('hidden', !table.external);
  setText(externalEl, t('db.external'));
  setTitle(externalEl, t('db.external.title'));
  const countEl = box.querySelector('.db-count');
  countEl.classList.toggle('hidden', Boolean(table.external));
  setText(countEl, String(table.columns.length));

  const changedCols = d ? [...d.columns.values()].filter((c) => c.status !== 'same').length : 0;
  const changedEl = box.querySelector('.db-chip.changed');
  changedEl.classList.toggle('hidden', !changedCols);
  setText(changedEl, changedCols ? t('db.changedCount', { count: changedCols }) : '');

  syncChildren(box.querySelector('.db-body'), dbBodyItems(table, d), buildDbBodyPart, updateDbBodyPart);

  // Whether a table is expanded is the user's doing and stays in the element.
  // Two things open one by themselves: a status that has just moved away from
  // "same", and a search that has just found it - that is what one is looking
  // for. Both only on the step, so a table closed by hand stays closed.
  //
  // Nothing here closes a card again. What is expanded stays expanded, no
  // matter what expanded it: a table the search opened is still open when the
  // search ends, and it is the same table one was just looking at.
  const wasStatus = box.dataset.status;
  box.dataset.status = status;
  if (status !== 'same' && status !== wasStatus) box.open = true;
  const wasQuery = box.dataset.query;
  box.dataset.query = q;
  if (q.length > 1 && q !== wasQuery && !item.hidden) box.open = true;
}

function dbBodyItems(table, d) {
  const items = [];
  // We do not know the columns of a foreign table - say so instead of showing
  // an empty list
  if (table.external) items.push({ id: 'external', kind: 'external' });
  else items.push({ id: 'cols', kind: 'cols', table, diff: d });

  const cons = (table.constraints || []).filter((c) => c.kind !== 'pk' || (c.columns || []).length > 1);
  if (cons.length) items.push({ id: 'cons', kind: 'cons', cons, diff: d });
  if (table.rls.policies.length) items.push({ id: 'pols', kind: 'pols', policies: table.rls.policies, diff: d });
  if (table.comment) items.push({ id: 'comment', kind: 'comment', text: table.comment });
  return items;
}

function buildDbBodyPart(item) {
  const el = document.createElement('div');
  if (item.kind === 'external') el.className = 'db-hint';
  else if (item.kind === 'comment') el.className = 'db-comment';
  else if (item.kind === 'cols') el.className = 'db-cols';
  else {
    el.className = 'db-sub';
    el.innerHTML = '<div class="db-sub-title"></div><div class="db-sub-rows"></div>';
  }
  return el;
}

function updateDbBodyPart(el, item) {
  if (item.kind === 'external') { setText(el, t('db.external.note')); return; }
  if (item.kind === 'comment') { setText(el, item.text); return; }
  if (item.kind === 'cols') {
    syncChildren(el, dbColumnItems(item.table, item.diff), buildDbColumn, updateDbColumn);
    return;
  }
  const rows = item.kind === 'cons'
    ? dbConstraintItems(item.cons, item.diff)
    : dbPolicyItems(item.policies, item.diff);
  setText(el.querySelector('.db-sub-title'), t(item.kind === 'cons' ? 'db.section.constraints' : 'db.section.policies'));
  syncChildren(el.querySelector('.db-sub-rows'), rows, buildDbConstraint, updateDbConstraint);
}

function dbColumnItems(table, d) {
  const items = table.columns.map((c) => ({
    id: `col:${c.name}`, table, column: c, diff: d && d.columns.get(c.name),
  }));
  // Show dropped columns too - otherwise one only sees that the count is smaller
  if (d) {
    for (const cd of d.columns.values()) {
      if (cd.status === 'removed') items.push({ id: `gone:${cd.name}`, table, column: cd.before, gone: true });
    }
  }
  return items;
}

function buildDbColumn() {
  const el = document.createElement('div');
  el.innerHTML = `
    <span class="db-col-mark"></span>
    <span class="db-col-name"></span>
    <span class="db-col-type"></span>
    <span class="db-col-tags"></span>
    <span class="db-col-meta"></span>`;
  return el;
}

function updateDbColumn(el, item) {
  const cd = item.diff;
  const status = item.gone ? 'removed' : cd ? cd.status : 'same';
  el.className = `db-col ${status}`;
  const why = cd && cd.fields && cd.fields.length
    ? cd.fields.map((f) => `${fieldLabel(f)}: ${fmtDefault(cd.before[f])} → ${fmtDefault(cd.after[f])}`).join('\n')
    : '';
  setTitle(el, item.gone ? t('db.status.removed') : why);

  const markEl = el.querySelector('.db-col-mark');
  markEl.className = `db-col-mark ${status}`;
  setText(markEl, STATUS_MARK[status] || '');
  setText(el.querySelector('.db-col-name'), item.column.name);
  setText(el.querySelector('.db-col-type'), item.column.type);
  syncChildren(
    el.querySelector('.db-col-tags'),
    item.gone ? [] : tagsForColumn(item.table, item.column.name).map((tag) => ({ id: tag.tag, tag })),
    () => document.createElement('span'),
    (tagEl, tagItem) => {
      tagEl.className = `db-tag ${tagItem.tag.tag.toLowerCase()}`;
      setTitle(tagEl, t(tagItem.tag.key));
      setText(tagEl, tagItem.tag.tag);
    },
  );
  setText(el.querySelector('.db-col-meta'), colMeta(item.column).join(' · '));
}

function dbConstraintItems(cons, d) {
  const items = cons.map((c) => ({
    id: `con:${c.name}`, constraint: c, diff: d && d.constraints.get(c.name),
  }));
  if (d) {
    for (const cd of d.constraints.values()) {
      if (cd.status === 'removed') items.push({ id: `gone:${cd.name}`, constraint: cd.before, gone: true });
    }
  }
  return items;
}

function dbPolicyItems(policies, d) {
  const items = policies.map((p) => ({
    id: `pol:${p.name}`, policy: p, diff: d && d.policies.get(p.name),
  }));
  if (d) {
    for (const pd of d.policies.values()) {
      if (pd.status === 'removed') items.push({ id: `gone:${pd.name}`, policy: pd.before, gone: true });
    }
  }
  return items;
}

function buildDbConstraint() {
  const el = document.createElement('div');
  el.innerHTML = `
    <span class="db-tag"></span>
    <span class="db-con-name"></span>
    <span class="db-con-text"></span>`;
  return el;
}

function updateDbConstraint(el, item) {
  const c = item.constraint || item.policy;
  const status = item.gone ? 'removed' : item.diff ? item.diff.status : 'same';
  el.className = `db-con ${status}`;
  setTitle(el, item.gone ? t('db.status.removed') : '');

  const tagEl = el.querySelector('.db-tag');
  if (item.policy) {
    tagEl.className = 'db-tag pol';
    setText(tagEl, 'POL');
    setTitle(tagEl, t('db.tag.policy'));
  } else {
    tagEl.className = `db-tag ${c.kind}`;
    setText(tagEl, (KIND_TAG[c.kind] || {}).tag || c.kind);
    setTitle(tagEl, KIND_TAG[c.kind] ? t(KIND_TAG[c.kind].key) : c.kind);
  }
  setText(el.querySelector('.db-con-name'), c.name);
  setText(el.querySelector('.db-con-text'), item.policy ? policyText(c) : constraintText(c));
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
const dbDiffOverlay = makeOverlay($('#dbdiff-overlay'), $('#dbdiff-close'));
const dbDiffBody = $('#dbdiff-body');
const dbDiffModes = $('#dbdiff-modes');
let dbDiffMode = 'changed'; // 'changed' | 'all'

// The marker of a row in the before/after view: an addition appears on the
// right, a removal on the left, a change on both sides.
function diffMark(status, side) {
  if (status === 'changed') return STATUS_MARK.changed;
  if (status === 'added' && side === 'after') return STATUS_MARK.added;
  if (status === 'removed' && side === 'before') return STATUS_MARK.removed;
  return '';
}

// The comparison starts at the top, and so does a switch of the mode. A
// refresh while it is open leaves the reader where they were reading.
function openDbDiff() {
  dbDiffOverlay.open();
  renderDbDiff();
  dbDiffBody.scrollTop = 0;
}

function renderDbDiffModes() {
  renderModeButtons(
    dbDiffModes,
    [{ id: 'changed', label: t('dbdiff.mode.changed') }, { id: 'all', label: t('dbdiff.mode.all') }],
    dbDiffMode,
    (id) => { dbDiffMode = id; renderDbDiff(); dbDiffBody.scrollTop = 0; },
  );
}

function renderDbDiff() {
  const view = dbState.view;
  // Nothing left to compare (project switched, baseline gone): better to close
  // than to leave a stale state standing.
  if (!view || !view.ok || !view.plugin || !view.diff) { dbDiffOverlay.close(); return; }
  renderDbDiffModes();

  $('#dbdiff-title').textContent = `${view.plugin.label} · ${view.project || ''}`;
  $('#dbdiff-head-old').innerHTML =
    `<strong>${escapeHtml(t('dbdiff.before'))}</strong> <span>${escapeHtml(view.baseline.label)} · ${escapeHtml(view.baseline.ref)}</span>`;
  $('#dbdiff-head-new').innerHTML =
    `<strong>${escapeHtml(t('dbdiff.after'))}</strong> <span>${escapeHtml(t('dbdiff.workingDir'))}</span>`;

  const baseTables = new Map(view.base.tables.map((t) => [t.id, t]));
  const curTables = new Map(view.schema.tables.map((t) => [t.id, t]));

  dbDiffBody.innerHTML = '';
  const frag = document.createDocumentFragment();

  // --- Enums ---
  const enums = view.diff.enums.filter((e) => dbDiffMode === 'all' || e.status !== 'same');
  if (enums.length) {
    frag.appendChild(dbDiffSpan(t('dbdiff.enums')));
    for (const e of enums) {
      frag.appendChild(dbDiffEnumCard(e, 'before'));
      frag.appendChild(dbDiffEnumCard(e, 'after'));
    }
  }

  // --- Tables ---
  const tables = view.diff.tables.filter((t) => dbDiffMode === 'all' || t.status !== 'same');
  if (tables.length) {
    frag.appendChild(dbDiffSpan(t('dbdiff.tables')));
    for (const t of tables) {
      frag.appendChild(dbDiffTableCard(t, baseTables.get(t.id) || null, 'before'));
      frag.appendChild(dbDiffTableCard(t, curTables.get(t.id) || null, 'after'));
    }
  }

  if (!frag.childNodes.length) {
    frag.appendChild(dbDiffSpan(t('dbdiff.none')));
  }
  dbDiffBody.appendChild(frag);
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
    el.innerHTML = `<div class="dbd-card-head"><span class="dbd-absent">${escapeHtml(
      t(side === 'before' ? 'dbdiff.absent.before' : 'dbdiff.absent.after'))}</span></div>`;
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

function dbDiffTableCard(td, table, side) {
  const el = document.createElement('div');
  const missing = !table;
  el.className = `dbd-card ${side} ${td.status}` + (missing ? ' absent' : '');

  if (missing) {
    el.innerHTML = `<div class="dbd-card-head">
      <span class="dbd-name muted">${escapeHtml(td.schema)}.${escapeHtml(td.name)}</span>
      <span class="dbd-absent">${escapeHtml(t(side === 'before' ? 'dbdiff.absent.newTable' : 'dbdiff.absent.after'))}</span>
    </div>`;
    return el;
  }

  // The row order comes from the diff and is the same on both sides - which is
  // why identical columns stand at the same height on the left and the right.
  const colRows = td.columns.map((cd) => {
    const c = side === 'before' ? cd.before : cd.after;
    const st = cd.status;
    if (!c) {
      return `<div class="dbd-row absent"><span class="dbd-mark"></span>
        <span class="dbd-cell muted">—</span></div>`;
    }
    const changedFields = st === 'changed' ? cd.fields : [];
    const meta = colMeta(c).join(' · ');
    return `<div class="dbd-row ${st}"${changedFields.length
      ? ` title="${escapeHtml(changedFields.map(fieldLabel).join(', '))}"` : ''}>
      <span class="dbd-mark">${diffMark(st, side)}</span>
      <span class="dbd-col-name">${escapeHtml(c.name)}</span>
      <span class="dbd-col-type${changedFields.includes('type') ? ' hot' : ''}">${escapeHtml(c.type)}</span>
      <span class="dbd-col-tags">${tagsHtml(tagsForColumn(table, c.name))}</span>
      <span class="dbd-col-meta${changedFields.some((f) => f !== 'type') ? ' hot' : ''}">${escapeHtml(meta)}</span>
    </div>`;
  });

  const conRows = td.constraints.map((cd) => {
    const c = side === 'before' ? cd.before : cd.after;
    if (!c) return `<div class="dbd-row absent"><span class="dbd-mark"></span><span class="dbd-cell muted">—</span></div>`;
    return `<div class="dbd-row ${cd.status}">
      <span class="dbd-mark">${diffMark(cd.status, side)}</span>
      <span class="db-tag ${c.kind}" title="${escapeHtml(KIND_TAG[c.kind] ? t(KIND_TAG[c.kind].key) : c.kind)}">${(KIND_TAG[c.kind] || {}).tag || c.kind}</span>
      <span class="dbd-con-name">${escapeHtml(c.name)}</span>
      <span class="dbd-con-text">${escapeHtml(constraintText(c))}</span>
    </div>`;
  });

  const polRows = td.policies.map((pd) => {
    const p = side === 'before' ? pd.before : pd.after;
    if (!p) return `<div class="dbd-row absent"><span class="dbd-mark"></span><span class="dbd-cell muted">—</span></div>`;
    return `<div class="dbd-row ${pd.status}">
      <span class="dbd-mark">${diffMark(pd.status, side)}</span>
      <span class="db-tag pol">POL</span>
      <span class="dbd-con-name">${escapeHtml(p.name)}</span>
      <span class="dbd-con-text">${escapeHtml(policyText(p))}</span>
    </div>`;
  });

  el.innerHTML = `
    <div class="dbd-card-head">
      <span class="dbd-name">${escapeHtml(table.name)}</span>
      ${table.schema !== 'public' ? `<span class="db-schema">${escapeHtml(table.schema)}</span>` : ''}
      ${table.rls.enabled ? `<span class="db-rls${td.rlsChanged ? ' changed' : ''}" title="${escapeHtml(t('db.rls.title'))}">RLS</span>` : ''}
      ${table.external ? `<span class="db-chip external" title="${escapeHtml(t('db.external.short'))}">${escapeHtml(t('db.external'))}</span>` : ''}
    </div>
    <div class="dbd-rows">${colRows.join('')}</div>
    ${conRows.length ? `<div class="dbd-sub">${escapeHtml(t('db.section.constraints'))}</div><div class="dbd-rows">${conRows.join('')}</div>` : ''}
    ${polRows.length ? `<div class="dbd-sub">${escapeHtml(t('db.section.policies'))}</div><div class="dbd-rows">${polRows.join('')}</div>` : ''}`;
  return el;
}

// ---------------------------------------------------------------------------
// Usage limits of the subscription: actual usage, plus the proportionally
// allowed level. After 3 of 7 days, 3/7 = 42.9 % is the target - anyone above
// that will blow the limit if the pace holds.
// ---------------------------------------------------------------------------
const usageContentEl = $('#usage-content');
const dotUsageEl = $('#dot-usage');
let usageTimer = null;

function fmtPct(n) {
  if (typeof n !== 'number') return '–';
  // Decimal separator and grouping follow the chosen language, not the source
  // language - 42,9 % in German and French, 42.9 % in English.
  return (Math.round(n * 10) / 10).toLocaleString(locale) + ' %';
}

// "in 1 h 47" or "in 3 days 5 h"
function fmtUntil(ts) {
  if (!ts) return '';
  let ms = ts - Date.now();
  if (ms <= 0) return t('usage.now');
  const days = Math.floor(ms / 86400000); ms -= days * 86400000;
  const hours = Math.floor(ms / 3600000); ms -= hours * 3600000;
  const mins = Math.floor(ms / 60000);
  if (days) return t('usage.in.days', { count: days, days, hours });
  if (hours) return t('usage.in.hours', { hours, minutes: String(mins).padStart(2, '0') });
  return t('usage.in.minutes', { minutes: mins });
}

function fmtReset(ts) {
  if (!ts) return t('usage.unknownReset');
  return new Date(ts).toLocaleString(locale,
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
    verdict = `<div class="uz-note">${escapeHtml(t('usage.limit.none'))}</div>`;
  } else if (status === 'early') {
    verdict = `<div class="uz-note">${escapeHtml(t('usage.early', { budget: '\u0000' }))
      .replace('\u0000', `<strong>${fmtPct(budget)}</strong>`)}</div>`;
  } else {
    const over = used - budget;
    verdict = `<div class="uz-verdict ${status}">
      <span class="uz-target">${escapeHtml(t('usage.allowed', { budget: '\u0000' }))
        .replace('\u0000', `<strong>${fmtPct(budget)}</strong>`)}</span>
      <span class="uz-delta">${escapeHtml(over > 0
        ? t('usage.over', { amount: fmtPct(over) })
        : t('usage.spare', { amount: fmtPct(-over) }))}</span>
      <span class="uz-proj">${escapeHtml(t('usage.projection', { value: '\u0000' }))
        .replace('\u0000', `<strong>${fmtPct(limit.projected)}</strong>`)}</span>
    </div>`;
  }

  return `
    <section class="uz-card ${status}">
      <header class="uz-head">
        <span class="uz-dot ${status}"></span>
        <span class="uz-title">${escapeHtml(title)}</span>
        <span class="uz-status">${escapeHtml(t('usage.status.' + status))}</span>
      </header>
      <div class="uz-bar" role="img" aria-label="${escapeHtml(t('usage.used', { percent: fmtPct(used) }))}">
        <div class="uz-fill ${status}" style="width:${Math.min(used, 100)}%"></div>
        ${showMark ? `<div class="uz-mark" style="left:${budget}%" title="${escapeHtml(t('usage.target', { percent: fmtPct(budget) }))}"></div>` : ''}
      </div>
      <div class="uz-meta">
        <span class="uz-used">${escapeHtml(t('usage.used', { percent: fmtPct(used) }))}</span>
        <span class="uz-reset">${escapeHtml(t('usage.reset', { when: fmtReset(limit.resetsAt), until: fmtUntil(limit.resetsAt) }))}</span>
      </div>
      ${verdict}
    </section>`;
}

// The worst status wins - the dot on the tab should show the tightest limit
const SEVERITY = { unknown: 0, early: 0, ok: 1, warn: 2, over: 3 };

// Every window the endpoint delivers counts, including the ones that used to be
// left out of this (seven days Sonnet) and any that come later. A limit that
// bites stops work, whichever window it sits in - a dot that stays green while
// one of them is exhausted would be showing the wrong thing.
function worstStatus(data) {
  let worst = 'unknown';
  for (const l of data.limits || []) {
    if (l && SEVERITY[l.status] > SEVERITY[worst]) worst = l.status;
  }
  return worst;
}

// The endpoint names its windows itself; these three have a translation. A
// window that is not among them is shown under its raw key - it is visible,
// and the name says where it came from.
const WINDOW_LABELS = {
  five_hour: 'usage.window.5h',
  seven_day: 'usage.window.7d',
  seven_day_opus: 'usage.window.7dOpus',
};

function limitLabel(limit) {
  const key = WINDOW_LABELS[limit.key];
  return key ? t(key) : limit.key;
}

async function loadUsage(force = false) {
  // Deliberately without a visibility check: the dot on the tab should be right
  // even when the tab is closed. Rendering into a hidden page costs nothing.
  const data = await window.api.getUsage(force);

  if (data.error && !data.stale) {
    usageContentEl.innerHTML = `
      <div class="uz-error">${escapeHtml(data.error)}</div>
      <div class="muted" style="margin-top:8px">${escapeHtml(t('usage.source', { usage: '\u0000' }))
        .replace('\u0000', '<code>/usage</code>')}</div>`;
    dotUsageEl.classList.add('hidden');
    return;
  }

  const parts = (data.limits || [])
    .map((limit) => renderLimit(limitLabel(limit), limit))
    .filter(Boolean);

  if (!parts.length) {
    usageContentEl.innerHTML = `<div class="muted">${escapeHtml(t('usage.noLimits'))}</div>`;
    dotUsageEl.classList.add('hidden');
    return;
  }

  const stamp = new Date(data.fetchedAt).toLocaleTimeString(locale,
    { hour: '2-digit', minute: '2-digit' });
  usageContentEl.innerHTML = `
    <div class="uz-top">
      ${data.plan ? `<span class="uz-plan">${escapeHtml(data.plan)}</span>` : '<span></span>'}
      <button id="usage-refresh" class="icon-btn" title="${escapeHtml(t('usage.refresh'))}" aria-label="${escapeHtml(t('usage.refresh.aria'))}">↻</button>
      <span class="uz-stamp">${escapeHtml(t('usage.asOf', { time: stamp }))}${data.stale ? ' · ' + escapeHtml(t('usage.stale')) : ''}</span>
    </div>
    ${data.stale ? `<div class="uz-error">${escapeHtml(data.error)}</div>` : ''}
    ${parts.join('')}
    <div class="uz-legend">${escapeHtml(t('usage.legend'))}</div>`;
  usageContentEl.querySelector('#usage-refresh')
    .addEventListener('click', () => loadUsage(true));

  const worst = worstStatus(data);
  dotUsageEl.className = 'tab-dot ' + worst;
  dotUsageEl.classList.toggle('hidden', worst !== 'warn' && worst !== 'over');
}

// Keep running in the background so the dot on the tab is right without having
// to keep the tab open
function startUsagePolling() {
  loadUsage(true).catch((e) => logWarn('usage: first load failed, offline or similar', { err: e }));
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    loadUsage().catch((e) => logWarn('usage: background poll failed', { err: e }));
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

function updateBadges(s) {
  setBadge(badgeGit, s ? s.files.length : 0);
  setBadge(badgeHistory, s ? (s.unseenHist || 0) : 0);
  setBadge(badgeTodos, s ? s.todos.filter((t) => !t.done).length : 0);
}

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------
const previewOverlay = makeOverlay($('#preview-overlay'), $('#preview-close'));
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
  if (hasDiff) modes.push({ id: 'diff', label: t('preview.mode.diff') });
  modes.push({ id: 'raw', label: t(hasDiff ? 'preview.mode.file' : 'preview.mode.source') });
  if (MD_EXT.test(previewState.filePath)) modes.push({ id: 'md', label: t('preview.mode.formatted') });

  renderModeButtons(previewModesEl, modes, previewState.mode, (id) => {
    previewState.mode = id;
    renderPreviewModes(hasDiff);
    renderPreview();
  });
}

async function openPreview(sessionId, filePath, source) {
  previewTitle.textContent = t('preview.loading', { path: filePath });
  previewContent.innerHTML = '';
  previewModesEl.innerHTML = '';
  previewOverlay.open();

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
$('#btn-new').addEventListener('click', () => newSession(shells[0] && shells[0].id));
$('#btn-new-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  shellMenu.classList.toggle('hidden');
  moreMenu.classList.add('hidden');
});
$('#btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenu.classList.toggle('hidden');
  shellMenu.classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.new-session-wrap')) shellMenu.classList.add('hidden');
  if (!e.target.closest('.more-wrap')) moreMenu.classList.add('hidden');
  if (!e.target.closest('#meta-popover') && !e.target.closest('.session-item')) closeMetaPopover();
});

function menuOpen() {
  return !moreMenu.classList.contains('hidden') || !shellMenu.classList.contains('hidden');
}

function closeMenus() {
  moreMenu.classList.add('hidden');
  shellMenu.classList.add('hidden');
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
  focusActiveTerm();
}

function toggleGrid() { gridOpen ? closeGrid() : openGrid(); }

// ---------------------------------------------------------------------------
// Claude session browser: search, resume and fork old sessions
// ---------------------------------------------------------------------------
const sessionsOverlay = makeOverlay($('#sessions-overlay'), $('#sessions-close'));
const sessionsListEl = $('#sessions-list');
const sessionsSearchEl = $('#sessions-search');
let claudeSessions = [];

async function openSessionBrowser() {
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
      newSession(shells[0] && shells[0].id, {
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
// The acknowledgement runs through xterm's write callback: it fires once the
// batch has been parsed, so the main process learns the actual backlog and
// pauses the PTY while xterm is behind.
window.api.onData((id, data) => {
  // The thumbnail write stays unacknowledged on purpose: the pane terminal
  // parses the same batch and is the slower of the two, so its ack already
  // covers the backlog. With `scrollback: 50` the thumbnail cannot fall behind
  // far enough to matter.
  const gridEntry = gridCards.get(id);
  if (gridEntry) gridEntry.term.write(data);
  const s = sessions.get(id);
  if (s) s.term.write(data, () => window.api.ackData(id, data.length));
  else window.api.ackData(id, data.length);
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
    maybeNotify(s, t('notify.attention'));
  }
});

window.api.onExit((id) => {
  const s = sessions.get(id);
  if (!s) return;
  s.exited = true;
  s.term.write(`\r\n\x1b[90m${t('term.exited')}\x1b[0m\r\n`);
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
    gitBlocked: info.gitBlocked,
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
      dbTablesEl.replaceChildren(); // different schema, different cards
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
  if (s) { try { s.fit.fit(); } catch (e) { logDebug('terminal: fit failed, pane may still be 0px', { session: s.id, err: e }); } }
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
    if (menuOpen()) closeMenus();
    else if (closeTopOverlay()) { /* the layer opened last has taken the key */ }
    else if (panelZoomed) setPanelZoom(false);
    else if (gridOpen) closeGrid();
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
(async function init() {
  applyStaticI18n();
  // Before the menu is built: the entry shows the state, and a checkmark that
  // has to be corrected a moment later is worse than a menu that appears late.
  // A failure here must not stop the startup - the setting decides in the main
  // process either way, this is only what the menu draws.
  try { osc52On = await window.api.osc52Enabled(); }
  catch (e) { logWarn('osc52: setting not read, the menu shows the default', { err: e }); }
  buildMoreMenu();
  sizePulse();
  pulseWake();
  await buildShellMenu();
  await newSession(shells[0] && shells[0].id);
  startUsagePolling();
  startDbPolling();
})();
