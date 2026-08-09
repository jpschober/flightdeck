// ---------------------------------------------------------------------------
// Entry point: wire the panels to the main process, the window and the
// keyboard. Everything that draws something lives in its own module - this file
// only says when.
// ---------------------------------------------------------------------------
import { $, basename } from './dom.js';
import { t, applyStaticI18n } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { newSession, setActive, closeSession, updateSessionItem, defaultShellId } from './terminal.js';
import { buildShellMenu, buildMoreMenu, loadOsc52Setting, menuOpen, closeMenus } from './menus.js';
import { closeTopOverlay } from './overlays.js';
import { renderContextPanel } from './git-panel.js';
import { loadTodosFor } from './notes.js';
import { loadDbSchema, startDbPolling, clearDbTables } from './db-schema.js';
import { startUsagePolling } from './usage.js';
import { panelZoomed, setPanelZoom, fitActive } from './panel.js';
import { gridCards, gridOpen, closeGrid, toggleGrid, setGridCardState } from './grid.js';
import { noteOutput, startDeckTick, updateDeckStatus } from './deck.js';

// A file dropped on the window would otherwise navigate the document to it. The
// main process cancels that navigation as well; here the drop is swallowed before
// it becomes one.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => { e.preventDefault(); }, false);
}

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
  noteOutput(id); // feeds the activity meter on the session card
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
  setGridCardState(id, s.exited ? 'exited' : state);
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
  // Without this the grid card of a session that was waiting keeps its gold dot
  // and border until the next state event - which for an exited PTY never comes.
  setGridCardState(id, 'exited');
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
  if (rootChanged) {
    loadTodosFor(s); // different project -> load its notes
    if (info.id === activeId) {
      clearDbTables(); // different schema, different cards
      loadDbSchema();
    }
  }
  if (info.id === activeId) renderContextPanel();
});

// ---------------------------------------------------------------------------
// Layout: resize panels via the dividers, fit the terminal on resize
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
      fitActive();
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

window.addEventListener('resize', () => { fitActive(); });

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    newSession(defaultShellId());
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
  await loadOsc52Setting();
  buildMoreMenu();
  updateDeckStatus();
  await buildShellMenu();
  await newSession(defaultShellId());
  startDeckTick();
  startUsagePolling();
  startDbPolling();
})();
