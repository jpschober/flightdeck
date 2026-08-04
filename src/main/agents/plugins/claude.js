'use strict';
// Agent plugin for Claude Code.
//
// A plugin brings both parts itself: the detection ("is something running here
// that I can count?") and the counting. The sensor only knows this interface:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null
//   read(ctx)   -> { agents: [...] }
//
// Claude Code stores every subagent of a session as its own pair:
//
//   ~/.claude/projects/<project>/<session-uuid>/subagents/
//       agent-<id>.jsonl       transcript of the agent
//       agent-<id>.meta.json   task, type, worktree - written on start
//
// There is no status ("still working") in there. It follows from three
// signals, and only together are they reliable:
//
//   Start    the meta.json is created the moment the agent is dispatched -
//            its mtime is the start time.
//   Stop     a <task-notification> in the transcript of the caller. The
//            tool_result of the agent call is no good for this: agents run
//            asynchronously, it only reports "launched successfully" and is
//            already there three seconds after the start.
//   Resume   a SendMessage to the same agent. Afterwards it is working again,
//            and the previous completion message is spent.
//
// All of this is undocumented internal format. If Claude Code changes it,
// nothing breaks here: the plugin simply finds no agents and reports null -
// the display disappears instead of becoming wrong.

const fs = require('fs');
const path = require('path');
const { findTranscriptById } = require('../../claude-sessions');

const id = 'claude';
const label = 'Claude Code';

// Without a completion message an agent would stay at "working" forever - for
// instance when Claude crashes or is killed. Anything that has not written for
// this long therefore counts as orphaned. Generously sized: an agent waiting
// on a long build writes nothing in between either.
const SILENCE_MS = 15 * 60 * 1000;

// Detection without a bound session (see detect)
const CLAUDE_CMD_RE = /(?:^|[\s/\\])claude(?:\s|$)/i;

const META_RE = /^agent-(.+)\.meta\.json$/;
const NOTIF_TASK_RE = /<task-id>([^<]+)<\/task-id>/;
const NOTIF_STATUS_RE = /<status>([^<]+)<\/status>/;

// ---------------------------------------------------------------------------
// Where the session is stored
// ---------------------------------------------------------------------------
// The binding goes through the session ID, not the path: if the agent moves
// into a worktree, the transcript wanders into a different project directory.
//
// The refresh resolves the transcript once per pass and hands it over in
// `ctx.claudeTranscript`; detect and read then work from that single value.
// The key is set even when the path is null - a session whose transcript does
// not exist yet is the expensive case, and looking it up again here would run
// the same fruitless scan three more times per pass. A caller that only knows
// the session ID leaves the key out and gets the lookup.
function transcriptOf(ctx) {
  if (ctx.claudeTranscript !== undefined) return ctx.claudeTranscript;
  return findTranscriptById(ctx.claudeSessionId);
}

function subagentsDir(sessionId, transcript) {
  if (!transcript) return null;
  return path.join(path.dirname(transcript), sessionId, 'subagents');
}

const metaCache = new Map(); // path -> { mtimeMs, data }
const META_CACHE_MAX = 400;

// The meta.json is written on start and never touched again; even so it is
// only read when its mtime has moved.
function readMeta(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;

  let data = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      description: parsed.description || null,
      agentType: parsed.agentType || null,
      worktreePath: parsed.worktreePath || null,
      spawnDepth: parsed.spawnDepth || 1,
      startedAt: stat.mtimeMs,
    };
  } catch {
    return null; // half-written file - try again on the next pass
  }
  metaCache.delete(file);
  metaCache.set(file, { mtimeMs: stat.mtimeMs, data });
  while (metaCache.size > META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
  return data;
}

// ---------------------------------------------------------------------------
// Stop and resume signals from the transcripts
// ---------------------------------------------------------------------------
// Transcripts only ever grow at the end. So for each file we remember how far
// it has been read: the first pass costs the whole file once, every further
// one only the new remainder. Without that, a megabyte would be due every four
// seconds.
const scans = new Map(); // sessionId -> { offsets: Map, events: Map }
const SCAN_MAX = 20;

function scanState(sessionId) {
  let state = scans.get(sessionId);
  if (!state) {
    state = { offsets: new Map(), events: new Map() };
    scans.set(sessionId, state);
    while (scans.size > SCAN_MAX) scans.delete(scans.keys().next().value);
  }
  return state;
}

function eventOf(state, agentId) {
  let ev = state.events.get(agentId);
  if (!ev) { ev = { stoppedAt: 0, resumedAt: 0 }; state.events.set(agentId, ev); }
  return ev;
}

function messageText(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const b of c) if (b && b.type === 'text' && b.text) out += b.text;
  return out;
}

function applyLine(state, line) {
  // Pre-filter before parsing: the vast majority of lines are of no interest
  // to us, and running JSON.parse on each would be the most expensive part.
  const notif = line.includes('<task-notification>');
  if (!notif && !line.includes('"SendMessage"')) return;

  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const at = Date.parse(entry.timestamp) || Date.now();

  if (notif) {
    const text = messageText(entry);
    const m = NOTIF_TASK_RE.exec(text);
    if (m) {
      // Every notification means "stops" - the status only says how. An agent
      // that is meant to carry on is nudged again via SendMessage.
      const ev = eventOf(state, m[1]);
      if (at > ev.stoppedAt) {
        ev.stoppedAt = at;
        const s = NOTIF_STATUS_RE.exec(text);
        ev.status = s ? s[1] : null;
      }
    }
  }

  const c = entry.message && entry.message.content;
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (!b || b.type !== 'tool_use' || b.name !== 'SendMessage') continue;
    const to = b.input && b.input.to;
    if (!to) continue;
    const ev = eventOf(state, String(to));
    if (at > ev.resumedAt) ev.resumedAt = at;
  }
}

function scanFile(state, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; }

  let from = state.offsets.get(file) || 0;
  if (stat.size < from) from = 0; // file replaced or truncated -> start over
  if (stat.size === from) return;

  const len = stat.size - from;
  const buf = Buffer.alloc(len);
  let n = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try { n = fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
  } catch {
    return;
  }

  // Only evaluate up to the last complete line. The rest is being written right
  // now and will come on the next pass - the line break is at the same time the
  // boundary at which what we read is guaranteed to be valid UTF-8.
  const text = buf.toString('utf8', 0, n);
  const end = text.lastIndexOf('\n');
  if (end < 0) return;
  state.offsets.set(file, from + Buffer.byteLength(text.slice(0, end + 1)));

  for (const line of text.slice(0, end).split('\n')) {
    if (line) applyLine(state, line);
  }
}

// ---------------------------------------------------------------------------
// Interface to the sensor
// ---------------------------------------------------------------------------

/**
 * The plugin is responsible as soon as a Claude session hangs off the
 * terminal. The binding terminal -> session is established by the shell
 * observation (it sees `claude` start and knows which transcript appeared as a
 * result); the plugin takes that as evidence and does the rest itself.
 */
function detect(ctx) {
  if (ctx.claudeSessionId) {
    const dir = subagentsDir(ctx.claudeSessionId, transcriptOf(ctx));
    const evidence = [`session ${ctx.claudeSessionId.slice(0, 8)}`];
    if (dir && fs.existsSync(dir)) evidence.push('subagents/');
    return { confidence: 0.95, evidence };
  }
  // Claude is visibly running, but the binding to the transcript is missing
  // (started without shell integration). Nothing can be counted then - but the
  // responsibility is settled, and a plugin that can do more here wins with a
  // higher value.
  if (ctx.command && CLAUDE_CMD_RE.test(ctx.command)) {
    return { confidence: 0.3, evidence: ['`claude` command, no session bound'] };
  }
  return null;
}

/**
 * All subagents of the bound session, each with `running`.
 */
function read(ctx) {
  if (!ctx.claudeSessionId) return { agents: [] };
  const transcript = transcriptOf(ctx);
  const dir = subagentsDir(ctx.claudeSessionId, transcript);
  if (!dir) return { agents: [] };

  let entries;
  try { entries = fs.readdirSync(dir); } catch { return { agents: [] }; }

  const metas = [];
  for (const f of entries) {
    const m = META_RE.exec(f);
    if (!m) continue;
    const meta = readMeta(path.join(dir, f));
    if (meta) metas.push({ id: m[1], ...meta });
  }
  if (!metas.length) return { agents: [] };

  const state = scanState(ctx.claudeSessionId);
  if (transcript) scanFile(state, transcript);
  // A nested agent reports its completion to its caller - and that caller is
  // itself a subagent. Only then are their transcripts needed.
  if (metas.some((m) => m.spawnDepth > 1)) {
    for (const m of metas) scanFile(state, path.join(dir, `agent-${m.id}.jsonl`));
  }

  const now = Date.now();
  const agents = metas.map((m) => {
    const ev = state.events.get(m.id) || {};
    // A resume resets the start time - a completion message from before it is
    // thereby spent.
    const startedAt = Math.max(m.startedAt, ev.resumedAt || 0);
    const stopped = Boolean(ev.stoppedAt && ev.stoppedAt >= startedAt);

    let lastActivity = m.startedAt;
    try {
      const stat = fs.statSync(path.join(dir, `agent-${m.id}.jsonl`));
      if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
    } catch { /* transcript not created yet */ }

    return {
      id: m.id,
      description: m.description,
      type: m.agentType,
      worktree: m.worktreePath ? path.basename(m.worktreePath) : null,
      depth: m.spawnDepth,
      startedAt,
      lastActivity,
      running: !stopped && now - lastActivity < SILENCE_MS,
    };
  });

  agents.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
  return { agents };
}

module.exports = { id, label, detect, read };
