// ---------------------------------------------------------------------------
// Sessions: create, activate, close - and the sidebar entry that belongs to
// each of them.
//
// Two of the imports below point back at this module, and both are mutual on
// purpose. grid.js: closing a session has to tear the grid down, because a tile
// would otherwise point at a disposed terminal, and a tile activates the session
// it shows. meta-popover.js: the sidebar entry opens the editor, and the editor
// writes title and label back into that entry. Neither one is a layer above the
// other, so neither import can be turned around.
//
// Both are safe under the module evaluation order because nothing on either
// side's top level calls across the boundary - the top levels look up elements
// and register listeners. A call added there would throw at load time, and the
// error would depend on which module the graph reaches first.
// ---------------------------------------------------------------------------
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { $, basename, showToast } from './dom.js';
import { logDebug, logWarn } from './log.js';
import { t, onLocaleChange } from './i18n.js';
import { sessions, activeId, setActiveId } from './sessions.js';
import { renderContextPanel } from './git-panel.js';
import { renderHistory } from './history.js';
import { loadTodosFor, renderTodos } from './notes.js';
import { dbState, loadDbSchema, renderDbPanel, clearDbTables } from './db-schema.js';
import { gridOpen, closeGrid } from './grid.js';
import { openMetaPopover } from './meta-popover.js';
import { pulseForgetProgress } from './pulse.js';

const sessionListEl = $('#session-list');
const terminalsEl = $('#terminals');
const emptyStateEl = $('#empty-state');

// The shells a session can start in. One of the names ("Command Prompt") is
// translated in the main process, so the list is fetched again on a language
// switch rather than relabelled - see buildShellMenu() in menus.js.
export let shells = [];

export async function refreshShells() {
  shells = await window.api.listShells();
  return shells;
}

/** The shell the + button, Ctrl+T and a resumed session start in. */
export function defaultShellId() {
  return shells[0] && shells[0].id;
}

// First match wins. Without the Linux/macOS fonts the list fell back to the
// generic `monospace` - together with lineHeight 1.25 that produced the
// oversized line spacing.
export const TERM_FONT = [
  '"Cascadia Code"', '"Cascadia Mono"', '"JetBrains Mono"', '"Fira Code"',
  '"Hack"', '"Source Code Pro"', '"DejaVu Sans Mono"', '"Liberation Mono"',
  '"Noto Sans Mono"', '"Ubuntu Mono"', 'Menlo', 'Consolas', 'monospace',
].join(', ');

export const TERM_THEME = {
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
  let webgl = null;
  try {
    webgl = new WebglAddon();
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

export async function newSession(shellId, opts) {
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
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => window.api.openExternal(uri)));
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
    // 'unknown' for shells without integration - see spawnArgsFor in main.js
    state: meta.state || 'idle',
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

export function setActive(id) {
  setActiveId(id);
  // The progress of the new session is not progress that just happened -
  // otherwise the pulse would flash on every session switch.
  pulseForgetProgress();
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
  clearDbTables();
  loadDbSchema();
}

export async function closeSession(id) {
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
      setActiveId(null);
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

export function updateSessionItem(s) {
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
    state === 'busy' || state === 'attention' || state === 'exited' || state === 'unknown'
      ? state : 'idle'));
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

// Status tooltip, close button and the agent chip all carry translated text.
onLocaleChange(() => {
  for (const s of sessions.values()) updateSessionItem(s);
});
