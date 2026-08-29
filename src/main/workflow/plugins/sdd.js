'use strict';
// Workflow plugin for sdd-kit (Spec-Driven Development).
//
// A workflow plugin answers two questions about a Claude session, and the
// sensor knows only this interface:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null   does this repo follow SDD?
//   read(ctx)   -> { step: {...} | null }               which step is it in right now?
//
// Unlike an agent plugin, a workflow is a *methodology*, not a CLI - so the
// signals are the traces the methodology leaves, not the command line.
//
// A project set up with sdd-kit (`/sdd-init`) is stamped at its repo root, and
// its `implement-work-item` flow runs through five phases, each with a marker
// on disk and its own phase file that the orchestrator reads:
//
//   1 spec   Schritt 0-2  phases/step-0-2.md  feature/<N>-, work/<N>/, no marker
//   2 gate1  Tor 1        phases/gate-1.md    (fs only sees "before marker")
//   3 build  Schritt 3    phases/step-3.md    work/<N>/.tor1-freigegeben exists
//   4 gate2  Tor 2        phases/gate-2.md    PR open
//   5 merge  Schritt 4    phases/step-4.md    PR merged
//
// The step is read as a hybrid: the filesystem sets a *floor* (facts that have
// happened - the approval marker, the PR, the merge), the transcript sets the
// *live* position (the phase file the orchestrator last read). The result is
// their max: the flow only moves forward, and the transcript is what reveals
// "standing at Tor 1/2" before the corresponding file marker appears.
//
// All of this is sdd-kit's own layout; if it changes, detect simply stops
// matching and the chip disappears rather than becoming wrong.

const fs = require('fs');
const path = require('path');
const { findTranscriptById } = require('../../claude-sessions');
const log = require('../../log');

const id = 'sdd';
const label = 'SDD';

// The five steps, in order; the index into this array (1-based) is the step
// number the floor and the transcript are compared on.
const STEP_IDS = ['spec', 'gate1', 'build', 'gate2', 'merge'];

// A phase file names its step directly. Anchored on the kit's own path so a
// user's file that happens to be called `step-3.md` cannot trip it.
const PHASE_RE = /implement-work-item\/phases\/(step-0-2|gate-1|step-3|gate-2|step-4)\.md$/;
const PHASE_INDEX = { 'step-0-2': 1, 'gate-1': 2, 'step-3': 3, 'gate-2': 4, 'step-4': 5 };

// Only a Vorgang runs on a `feature/<N>-` branch; the number lives in the
// branch (git-pr-workflow.md §5) and anchors work/<N>/ and the tooltip.
const VORGANG_RE = /^feature\/(\d+)-/;
const MARKER_NAME = '.tor1-freigegeben';

// ---------------------------------------------------------------------------
// Detection: does this repo follow SDD?
// ---------------------------------------------------------------------------
// `/sdd-init` stamps `.sdd-contract` (just the contract version) at the repo
// root - the one unambiguous "this project uses sdd-kit" signal. It is a
// tracked file, so it is present in a linked Vorgang worktree too.
function detect(ctx) {
  const root = ctx.gitRoot;
  if (!root) return null;
  let version;
  try {
    version = fs.readFileSync(path.join(root, '.sdd-contract'), 'utf8').trim();
  } catch (e) {
    log.debug('workflow/sdd: no .sdd-contract', { root, err: e });
    return null; // not an SDD project
  }
  return { confidence: 0.9, evidence: [`.sdd-contract${version ? ' v' + version : ''}`] };
}

// ---------------------------------------------------------------------------
// The transcript: which phase file did the orchestrator last read?
// ---------------------------------------------------------------------------
// Transcripts only grow at the end, so each file is read from where the last
// pass left off. The last phase-file Read in chronological order wins; the
// result carries across passes.
const scans = new Map(); // transcriptPath -> { offset, phase }
const SCAN_MAX = 20;

function scanState(file) {
  let state = scans.get(file);
  if (!state) {
    state = { offset: 0, phase: 0 };
    scans.set(file, state);
    while (scans.size > SCAN_MAX) scans.delete(scans.keys().next().value);
  }
  return state;
}

function phaseOfLine(line) {
  // Pre-filter before parsing: only a Read of a phase file can matter, and
  // JSON.parse on every transcript line would be the expensive part.
  if (!line.includes('phases/')) return 0;
  let entry;
  try { entry = JSON.parse(line); } catch (e) { log.debug('workflow/sdd: transcript line not parsable', { err: e }); return 0; }
  const c = entry.message && entry.message.content;
  if (!Array.isArray(c)) return 0;
  let found = 0;
  for (const b of c) {
    if (!b || b.type !== 'tool_use' || b.name !== 'Read') continue;
    const fp = b.input && b.input.file_path;
    const m = fp && PHASE_RE.exec(fp);
    if (m) found = PHASE_INDEX[m[1]]; // a later block on the same line wins
  }
  return found;
}

function transcriptPhase(ctx) {
  const file = ctx.claudeTranscript !== undefined
    ? ctx.claudeTranscript
    : findTranscriptById(ctx.claudeSessionId);
  if (!file) return 0;

  const state = scanState(file);
  let stat;
  try { stat = fs.statSync(file); } catch (e) { log.debug('workflow/sdd: transcript not stattable', { file, err: e }); return state.phase; }

  let from = state.offset;
  if (stat.size < from) { from = 0; state.phase = 0; } // replaced or truncated
  if (stat.size === from) return state.phase;

  const len = stat.size - from;
  const buf = Buffer.alloc(len);
  let n = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try { n = fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
  } catch (e) {
    log.warn('workflow/sdd: transcript not readable', { file, from, len, err: e });
    return state.phase;
  }

  // Only up to the last complete line; the rest is being written right now and
  // the newline is also where the read is guaranteed valid UTF-8.
  const text = buf.toString('utf8', 0, n);
  const end = text.lastIndexOf('\n');
  if (end < 0) return state.phase;
  state.offset = from + Buffer.byteLength(text.slice(0, end + 1));

  for (const line of text.slice(0, end).split('\n')) {
    if (!line) continue;
    const p = phaseOfLine(line);
    if (p) state.phase = p; // chronological: the last one seen is the current one
  }
  return state.phase;
}

// ---------------------------------------------------------------------------
// The step: filesystem floor, lifted by the transcript
// ---------------------------------------------------------------------------
function read(ctx) {
  const m = VORGANG_RE.exec(ctx.branch || '');
  if (!m) return { step: null }; // no active Vorgang -> nothing to show, no scan

  const root = ctx.gitRoot;
  const pr = ctx.pr;
  let floor;
  if (pr && pr.state === 'MERGED') floor = 5;
  else if (pr && pr.state === 'OPEN' && !pr.isDraft) floor = 4;
  else if (root && fs.existsSync(path.join(root, 'work', m[1], MARKER_NAME))) floor = 3;
  else floor = 1;

  const index = Math.max(floor, transcriptPhase(ctx));
  return {
    step: { id: STEP_IDS[index - 1], index, total: STEP_IDS.length, vorgang: Number(m[1]) },
  };
}

module.exports = { id, label, detect, read };
