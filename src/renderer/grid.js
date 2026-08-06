/* global Terminal */
// ---------------------------------------------------------------------------
// Grid overview: all sessions as live tiles
// ---------------------------------------------------------------------------
import { $, basename, makeKeyActivatable } from './dom.js';
import { sessions, focusActiveTerm } from './sessions.js';
import { setActive, TERM_FONT, TERM_THEME } from './terminal.js';

const gridViewEl = $('#grid-view');
const gridContainerEl = $('#grid-container');
export const gridCards = new Map(); // sessionId -> { term, statusEl }
export let gridOpen = false;

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

export function closeGrid() {
  if (!gridOpen) return;
  gridOpen = false;
  gridViewEl.classList.add('hidden');
  for (const { term } of gridCards.values()) term.dispose();
  gridCards.clear();
  focusActiveTerm();
}

export function toggleGrid() { gridOpen ? closeGrid() : openGrid(); }
