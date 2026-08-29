'use strict';
// The step an sdd-kit session is in, read the way the tab reads it:
//
//   detect  -> is this repo stamped for SDD (.sdd-contract)?
//   read    -> filesystem floor (marker, PR, merge) lifted by the transcript
//              (the phase file the orchestrator last read), their max.
//
//   node --test test/workflow-sdd.test.js
//
// The plugin touches the disk, so the fixtures are real: a temp repo root for
// the contract and the Tor-1 marker, and a real JSONL transcript for the phase
// reads. Passing `claudeTranscript` explicitly keeps it off the user's actual
// ~/.claude tree.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sdd = require('../src/main/workflow/plugins/sdd');
const { getWorkflowView } = require('../src/main/workflow');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
}

/** A transcript with one assistant Read per phase file named, in order. */
function transcriptReading(...phaseNames) {
  const file = path.join(tmpRepo(), 'session.jsonl');
  appendReads(file, ...phaseNames);
  return file;
}

function appendReads(file, ...phaseNames) {
  const lines = phaseNames.map((name, i) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { file_path: `/kit/plugins/sdd/skills/implement-work-item/phases/${name}` },
      }],
    },
  }));
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

/** A step read with no transcript in play - the filesystem floor alone. */
function stepFromFs(ctx) {
  return sdd.read({ claudeTranscript: null, ...ctx }).step;
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

test('detect: a stamped repo is SDD, with the contract version as evidence', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, '.sdd-contract'), '2\n');
  const d = sdd.detect({ gitRoot: root });
  assert.equal(d.confidence, 0.9);
  assert.deepEqual(d.evidence, ['.sdd-contract v2']);
});

test('detect: no contract, no responsibility', () => {
  assert.equal(sdd.detect({ gitRoot: tmpRepo() }), null);
  assert.equal(sdd.detect({ gitRoot: null }), null);
});

// ---------------------------------------------------------------------------
// read - filesystem floor
// ---------------------------------------------------------------------------

test('read: off a feature branch there is no active Vorgang', () => {
  assert.equal(stepFromFs({ branch: 'main', gitRoot: tmpRepo() }), null);
  assert.equal(stepFromFs({ branch: 'fix/some-bug', gitRoot: tmpRepo() }), null);
  assert.equal(stepFromFs({ branch: null, gitRoot: tmpRepo() }), null);
});

test('read: a feature branch with nothing yet is Spec, and carries the Vorgang number', () => {
  const step = stepFromFs({ branch: 'feature/42-thing', gitRoot: tmpRepo() });
  assert.equal(step.id, 'spec');
  assert.equal(step.index, 1);
  assert.equal(step.total, 5);
  assert.equal(step.vorgang, 42);
});

test('read: the Tor-1 marker lifts the floor to Build', () => {
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, 'work', '42'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '42', '.tor1-freigegeben'), '');
  assert.equal(stepFromFs({ branch: 'feature/42-thing', gitRoot: root }).id, 'build');
});

test('read: an open non-draft PR is Tor 2; a merged PR is Merge', () => {
  const base = { branch: 'feature/42-thing', gitRoot: tmpRepo() };
  assert.equal(stepFromFs({ ...base, pr: { state: 'OPEN', isDraft: false } }).id, 'gate2');
  assert.equal(stepFromFs({ ...base, pr: { state: 'MERGED' } }).id, 'merge');
});

test('read: a draft PR does not lift the floor by itself', () => {
  // A draft PR can stand open for the Tor-1 approval; the transcript, not the
  // PR, is what then places Tor 2.
  const step = stepFromFs({ branch: 'feature/42-thing', gitRoot: tmpRepo(), pr: { state: 'OPEN', isDraft: true } });
  assert.equal(step.id, 'spec');
});

// ---------------------------------------------------------------------------
// read - transcript refinement, and the max of the two
// ---------------------------------------------------------------------------

test('read: reading gate-1.md places the session at Tor 1 before any marker', () => {
  const step = sdd.read({
    branch: 'feature/42-thing',
    gitRoot: tmpRepo(),
    claudeTranscript: transcriptReading('step-0-2.md', 'gate-1.md'),
  }).step;
  assert.equal(step.id, 'gate1');
  assert.equal(step.index, 2);
});

test('read: reading gate-2.md shows Tor 2 even before the PR exists', () => {
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, 'work', '42'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '42', '.tor1-freigegeben'), ''); // floor = build
  const step = sdd.read({
    branch: 'feature/42-thing',
    gitRoot: root,
    claudeTranscript: transcriptReading('step-3.md', 'gate-2.md'),
  }).step;
  assert.equal(step.id, 'gate2');
});

test('read: the floor wins when the transcript points further back', () => {
  // Marker present (build), but the last phase read is step-0-2 - the flow only
  // moves forward, so the max keeps it at Build.
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, 'work', '42'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '42', '.tor1-freigegeben'), '');
  const step = sdd.read({
    branch: 'feature/42-thing',
    gitRoot: root,
    claudeTranscript: transcriptReading('gate-1.md', 'step-0-2.md'),
  }).step;
  assert.equal(step.id, 'build');
});

test('read: a later phase read advances the step on the next pass (incremental scan)', () => {
  const file = transcriptReading('step-0-2.md');
  const ctx = { branch: 'feature/42-thing', gitRoot: tmpRepo(), claudeTranscript: file };
  assert.equal(sdd.read(ctx).step.id, 'spec');
  appendReads(file, 'gate-1.md');
  assert.equal(sdd.read(ctx).step.id, 'gate1');
});

test('read: a file merely named like a phase file elsewhere is ignored', () => {
  const file = path.join(tmpRepo(), 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/notes/step-3.md' } }] },
  }) + '\n');
  const step = sdd.read({ branch: 'feature/42-thing', gitRoot: tmpRepo(), claudeTranscript: file }).step;
  assert.equal(step.id, 'spec'); // not build
});

// ---------------------------------------------------------------------------
// getWorkflowView - the sensor the refresh calls
// ---------------------------------------------------------------------------

test('getWorkflowView: a stamped repo on a feature branch reports plugin and step', async () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, '.sdd-contract'), '2');
  const view = await getWorkflowView({ gitRoot: root, branch: 'feature/7-x', claudeTranscript: null });
  assert.equal(view.plugin.id, 'sdd');
  assert.equal(view.step.id, 'spec');
  assert.equal(view.step.vorgang, 7);
});

test('getWorkflowView: a non-SDD repo is nobody\'s business', async () => {
  const view = await getWorkflowView({ gitRoot: tmpRepo(), branch: 'feature/7-x', claudeTranscript: null });
  assert.equal(view, null);
});

test('getWorkflowView: a stamped repo with no active Vorgang has a plugin but no step', async () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, '.sdd-contract'), '2');
  const view = await getWorkflowView({ gitRoot: root, branch: 'main', claudeTranscript: null });
  assert.equal(view.plugin.id, 'sdd');
  assert.equal(view.step, null);
});
