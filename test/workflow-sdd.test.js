'use strict';
// The step an sdd-kit session is in, read the way the tab reads it:
//
//   detect  -> is this repo stamped for SDD (.sdd-contract)?
//   read    -> the highest durable trace present, top down: merged PR, open
//              PR, the Tor-1 marker, the Tor-1 record line, else spec.
//
//   node --test test/workflow-sdd.test.js
//
// The plugin touches the disk, so the fixtures are real: a temp repo root for
// the contract, the work/<N>/ artifacts and the Tor-1 marker.

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

/** Write work/<N>/record.md with the given body, creating the dir. */
function writeRecord(root, n, body) {
  fs.mkdirSync(path.join(root, 'work', String(n)), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', String(n), 'record.md'), body);
}

/** Lay down the Tor-1 approval marker for Vorgang N. */
function writeMarker(root, n) {
  fs.mkdirSync(path.join(root, 'work', String(n)), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', String(n), '.tor1-freigegeben'), '');
}

function step(ctx) {
  return sdd.read(ctx).step;
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
// read - the durable ladder
// ---------------------------------------------------------------------------

test('read: off a feature branch there is no active Vorgang', () => {
  assert.equal(step({ branch: 'main', gitRoot: tmpRepo() }), null);
  assert.equal(step({ branch: 'fix/some-bug', gitRoot: tmpRepo() }), null);
  assert.equal(step({ branch: null, gitRoot: tmpRepo() }), null);
});

test('read: a feature branch with nothing yet is Spec, and carries the Vorgang number', () => {
  const s = step({ branch: 'feature/42-thing', gitRoot: tmpRepo() });
  assert.equal(s.id, 'spec');
  assert.equal(s.index, 1);
  assert.equal(s.total, 5);
  assert.equal(s.vorgang, 42);
});

test('read: a work/<N>/ without the record line is still Spec', () => {
  const root = tmpRepo();
  writeRecord(root, 42, '# Record\n\n## §1 Auftrag\n...\n'); // no "Freigegebener Stand:"
  assert.equal(step({ branch: 'feature/42-thing', gitRoot: root }).id, 'spec');
});

test('read: the Tor-1 record line places the session at Tor 1 before any marker', () => {
  const root = tmpRepo();
  writeRecord(root, 42, '## §4 Freigabe\n\nFreigegebener Stand: a1b2c3d\nFreigabe: durch den Menschen\n');
  const s = step({ branch: 'feature/42-thing', gitRoot: root });
  assert.equal(s.id, 'gate1');
  assert.equal(s.index, 2);
});

test('read: a merely quoted record line does not count as the record', () => {
  const root = tmpRepo();
  writeRecord(root, 42, '> Freigegebener Stand: a1b2c3d\n'); // a quotation, not the record
  assert.equal(step({ branch: 'feature/42-thing', gitRoot: root }).id, 'spec');
});

test('read: the Tor-1 marker lifts the step to Build, over the record', () => {
  const root = tmpRepo();
  writeRecord(root, 42, 'Freigegebener Stand: a1b2c3d\n');
  writeMarker(root, 42);
  assert.equal(step({ branch: 'feature/42-thing', gitRoot: root }).id, 'build');
});

test('read: an open non-draft PR is Tor 2; a merged PR is Merge', () => {
  const base = { branch: 'feature/42-thing', gitRoot: tmpRepo() };
  assert.equal(step({ ...base, pr: { state: 'OPEN', isDraft: false } }).id, 'gate2');
  assert.equal(step({ ...base, pr: { state: 'MERGED' } }).id, 'merge');
});

test('read: a draft PR does not lift the step by itself', () => {
  // The PR that defines Tor 2 is opened non-draft in gate-2.md; a draft PR is
  // not that signal, so the step still rests on the disk traces below it.
  const s = step({ branch: 'feature/42-thing', gitRoot: tmpRepo(), pr: { state: 'OPEN', isDraft: true } });
  assert.equal(s.id, 'spec');
});

test('read: the ladder takes the highest trace even when a lower one is also present', () => {
  // Marker present (build) and the record line present (gate1): the higher of
  // the two wins, and the merged PR above both wins over the marker.
  const root = tmpRepo();
  writeRecord(root, 42, 'Freigegebener Stand: a1b2c3d\n');
  writeMarker(root, 42);
  assert.equal(step({ branch: 'feature/42-thing', gitRoot: root, pr: { state: 'MERGED' } }).id, 'merge');
});

// ---------------------------------------------------------------------------
// getWorkflowView - the sensor the refresh calls
// ---------------------------------------------------------------------------

test('getWorkflowView: a stamped repo on a feature branch reports plugin and step', async () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, '.sdd-contract'), '2');
  const view = await getWorkflowView({ gitRoot: root, branch: 'feature/7-x' });
  assert.equal(view.plugin.id, 'sdd');
  assert.equal(view.step.id, 'spec');
  assert.equal(view.step.vorgang, 7);
});

test('getWorkflowView: a non-SDD repo is nobody\'s business', async () => {
  const view = await getWorkflowView({ gitRoot: tmpRepo(), branch: 'feature/7-x' });
  assert.equal(view, null);
});

test('getWorkflowView: a stamped repo with no active Vorgang has a plugin but no step', async () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, '.sdd-contract'), '2');
  const view = await getWorkflowView({ gitRoot: root, branch: 'main' });
  assert.equal(view.plugin.id, 'sdd');
  assert.equal(view.step, null);
});
