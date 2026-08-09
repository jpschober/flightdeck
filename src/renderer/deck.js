// ---------------------------------------------------------------------------
// What the session cards show about running work
//
// Three things share one second-tick, because all three would otherwise redraw
// on the poll interval and jump:
//
//   Activity meter   how much of the last ten seconds carried terminal output.
//                    Answers the question the status dot cannot: is this
//                    session moving, or has it hung?
//   Subagent rows    one line per running agent, with its elapsed time counted
//                    locally. The poll only ever changes *which* agents there
//                    are - the clock is ours.
//   Deck status      the title bar's one sentence about the whole window.
//
// The tick touches text nodes and one width, never the structure: at six
// sessions with three agents each that is 24 string assignments a second.
// ---------------------------------------------------------------------------
import { $ } from './dom.js';
import { t } from './i18n.js';
import { sessions } from './sessions.js';

const deckStatusEl = $('#deck-status');
const deckCountEl = $('#deck-count');

// ---------------------------------------------------------------------------
// Activity meter
// ---------------------------------------------------------------------------
// Ten one-second slots as bits: the tick shifts, output sets the lowest one.
// Cheaper than an array and it holds exactly the window we want to show.
const SLOTS = 10;
const SLOT_MASK = (1 << SLOTS) - 1;
// A session that is working but silent (a long tool call) would otherwise show
// an empty bar and read as dead.
const MIN_FILL = 8;

/** Terminal output arrived for this session - marks the current second. */
export function noteOutput(id) {
  const s = sessions.get(id);
  if (s) s.actHit = true;
}

function shiftActivity(s) {
  s.actBits = (((s.actBits || 0) << 1) | (s.actHit ? 1 : 0)) & SLOT_MASK;
  s.actHit = false;
}

function activityPercent(s) {
  let bits = s.actBits || 0;
  let n = 0;
  while (bits) { n += bits & 1; bits >>= 1; }
  return Math.max(MIN_FILL, Math.round((n / SLOTS) * 100));
}

// ---------------------------------------------------------------------------
// Subagent rows
// ---------------------------------------------------------------------------
const MAX_ROWS = 3;
// Longer than a subagent normally runs. Not an error - the row only asks to be
// looked at.
const OVERDUE_MS = 10 * 60 * 1000;
// An agent that has just finished stays for this long. Short runs would
// otherwise appear and vanish between two polls and never be seen at all.
const LINGER_MS = 2000;

function agentTask(a) {
  return a.description || a.type || String(a.id).slice(0, 8);
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Reconcile the rows of one card against what the poll reported. Called on
 * every session update, never on the tick - the structure only changes when the
 * set of agents does.
 */
export function syncAgentRows(s) {
  const listEl = s.itemEl && s.itemEl.querySelector('.si-agent-list');
  if (!listEl) return;

  const now = Date.now();
  const rows = s.agentRows || (s.agentRows = new Map());
  const running = (s.agents && s.agents.agents) || [];

  for (const a of running) {
    const row = rows.get(a.id);
    if (row) {
      row.goneAt = 0;
      row.startedAt = a.startedAt || row.startedAt;
      row.task = agentTask(a);
    } else {
      rows.set(a.id, { startedAt: a.startedAt || now, task: agentTask(a), goneAt: 0, el: null });
    }
  }
  // Gone from the poll means finished - the sensor only ever reports running
  // agents, so their disappearance is the only completion signal there is.
  const seen = new Set(running.map((a) => a.id));
  for (const [id, row] of rows) {
    if (seen.has(id)) continue;
    if (!row.goneAt) row.goneAt = now;
    if (now - row.goneAt > LINGER_MS) rows.delete(id);
  }

  drawAgentRows(s, listEl, now);
}

// The oldest first: that is the order the eye keeps between two polls, and the
// row most likely to be overdue ends up on top.
function visibleRows(rows) {
  return [...rows.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function drawAgentRows(s, listEl, now) {
  const all = visibleRows(s.agentRows);
  const shown = all.slice(0, MAX_ROWS);
  const rest = all.length - shown.length;

  // Rebuild only when the set changed - the tick below writes the times.
  const key = shown.map((r) => r.startedAt).join(',') + '|' + rest;
  if (s.agentRowsKey === key && listEl.childElementCount) {
    updateAgentTimes(s, now);
    return;
  }
  s.agentRowsKey = key;

  listEl.textContent = '';
  for (const row of shown) {
    const el = document.createElement('div');
    el.className = 'si-agent';
    const task = document.createElement('span');
    task.className = 'si-agent-task';
    task.textContent = row.task;
    task.title = row.task;
    const time = document.createElement('span');
    time.className = 'si-agent-time';
    el.append(task, time);
    listEl.appendChild(el);
    row.el = el;
    row.timeEl = time;
  }
  if (rest > 0) {
    const more = document.createElement('div');
    more.className = 'si-agent-more';
    more.textContent = t('session.agents.more', { count: rest });
    listEl.appendChild(more);
  }
  updateAgentTimes(s, now);
}

function updateAgentTimes(s, now) {
  if (!s.agentRows) return;
  for (const row of s.agentRows.values()) {
    if (!row.el || !row.el.isConnected) continue;
    const elapsed = (row.goneAt || now) - row.startedAt;
    const text = fmtElapsed(elapsed);
    if (row.timeEl.textContent !== text) row.timeEl.textContent = text;
    row.el.classList.toggle('overdue', !row.goneAt && elapsed >= OVERDUE_MS);
    row.el.classList.toggle('done', Boolean(row.goneAt));
  }
}

// ---------------------------------------------------------------------------
// Title bar: the deck in one sentence
// ---------------------------------------------------------------------------
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

export function updateDeckStatus() {
  let agents = 0;
  let waiting = 0;
  let open = 0;
  for (const s of sessions.values()) {
    if (s.exited) continue;
    open++;
    if (s.agents) agents += s.agents.running;
    if (s.state === 'attention') waiting++;
  }

  const parts = [];
  if (agents) parts.push(t('session.agents', { count: agents }));
  if (waiting) parts.push(t('deck.waiting', { count: waiting }));
  // Neither number stands: say what there is instead of showing an empty pill.
  setText(deckStatusEl, parts.length
    ? parts.join(' · ')
    : (open ? t('deck.sessions', { count: open }) : ''));
  deckStatusEl.classList.toggle('attention', waiting > 0);

  const counts = [t('deck.sessions', { count: open })];
  if (agents) counts.push(t('deck.agents', { count: agents }));
  setText(deckCountEl, open ? counts.join(' · ') : '');
}

// ---------------------------------------------------------------------------
// The one tick
// ---------------------------------------------------------------------------
let tickTimer = null;

export function startDeckTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      shiftActivity(s);
      const fillEl = s.itemEl && s.itemEl.querySelector('.si-meter-fill');
      // Hidden while the card is not busy, so its width need not be kept up
      if (fillEl && s.state === 'busy' && !s.exited) {
        fillEl.style.width = activityPercent(s) + '%';
      }
      if (s.agentRows && s.agentRows.size) {
        // Rows past their linger time leave here as well: without a poll in
        // between they would otherwise stay until the next one.
        let expired = false;
        for (const [id, row] of s.agentRows) {
          if (row.goneAt && now - row.goneAt > LINGER_MS) { s.agentRows.delete(id); expired = true; }
        }
        if (expired) syncAgentRows(s);
        else updateAgentTimes(s, now);
      }
    }
    updateDeckStatus();
  }, 1000);
}
