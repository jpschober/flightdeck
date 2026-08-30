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
// its `implement-work-item` flow runs through five phases. Each phase leaves a
// *durable* trace on disk or in the PR - one that outlives the session that
// made it:
//
//   1 spec   Schritt 0-2  feature/<N>-, work/<N>/, nothing below yet
//   2 gate1  Tor 1        work/<N>/record.md carries a "Freigegebener Stand:"
//   3 build  Schritt 3    work/<N>/.tor1-freigegeben exists
//   4 gate2  Tor 2        PR open (non-draft) - work/<N>/ is deleted here
//   5 merge  Schritt 4    PR merged
//
// The step is read as a priority ladder from the top: the highest trace that
// is present is the current step. Every trace is a fact that stays put once
// the flow passes it (the record line, the approval marker, the PR, the
// merge), so the ladder only moves forward without needing to remember a
// previous position - and it does not depend on which Claude session is bound.
// A Vorgang runs across several sessions (spec in one, build in another, the
// gates in a third), so reading the live phase from the bound transcript alone
// dropped whenever that session was not the one on screen; the disk does not.
//
// All of this is sdd-kit's own layout; if it changes, detect simply stops
// matching and the chip disappears rather than becoming wrong.

const fs = require('fs');
const path = require('path');
const log = require('../../log');

const id = 'sdd';
const label = 'SDD';

// The five steps, in order; the index into this array (1-based) is the step
// number the ladder resolves to.
const STEP_IDS = ['spec', 'gate1', 'build', 'gate2', 'merge'];

// Only a Vorgang runs on a `feature/<N>-` branch; the number lives in the
// branch (git-pr-workflow.md §5) and anchors work/<N>/ and the tooltip.
const VORGANG_RE = /^feature\/(\d+)-/;
const MARKER_NAME = '.tor1-freigegeben';

// The Tor-1 record lives in `work/<N>/record.md §4`; its recognition mark is a
// `Freigegebener Stand: <sha>` line (gate-1.md §"Record"), the same line
// sdd-kit's own check-process-integrity.py keys on (RECORD_SHA_RE there). The
// leading class allows list/emphasis decoration but not `>`, so a quotation of
// the line (`> Freigegebener Stand:`) does not count as the record.
const RECORD_NAME = 'record.md';
const RECORD_SHA_RE = /^[\s*_-]*Freigegebener\s+Stand[\s*_]*:[\s*_`]*[0-9a-f]{7,40}\b/im;

function tor1RecordPresent(root, n) {
  let body;
  try { body = fs.readFileSync(path.join(root, 'work', n, RECORD_NAME), 'utf8'); }
  catch (e) { log.debug('workflow/sdd: no record.md', { root, n, err: e }); return false; }
  return RECORD_SHA_RE.test(body);
}

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
// The step: the highest durable trace on disk / in the PR
// ---------------------------------------------------------------------------
function read(ctx) {
  const m = VORGANG_RE.exec(ctx.branch || '');
  if (!m) return { step: null }; // no active Vorgang -> nothing to show

  const n = m[1];
  const root = ctx.gitRoot;
  const pr = ctx.pr;
  let index;
  if (pr && pr.state === 'MERGED') index = 5;
  else if (pr && pr.state === 'OPEN' && !pr.isDraft) index = 4;
  else if (root && fs.existsSync(path.join(root, 'work', n, MARKER_NAME))) index = 3;
  else if (root && tor1RecordPresent(root, n)) index = 2;
  else index = 1;

  return {
    step: { id: STEP_IDS[index - 1], index, total: STEP_IDS.length, vorgang: Number(n) },
  };
}

module.exports = { id, label, detect, read };
