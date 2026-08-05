'use strict';
// What the two git callers in the refresh loop no longer start.
//
//   node --test test/git-process-cache.test.js
//
// `child_process.execFile` is replaced before the modules under test are
// loaded, so every git process shows up in `calls` and none is actually
// started. The answers are canned; the point of the tests is the number of
// calls and their order, not git's output.
//
// Time is faked (see `advance`) so the lifetimes of the entries can be reached
// without waiting for them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The logger writes warnings to the console; the test runner owns it here.
console.error = () => {};
console.log = () => {};

// --- fake clock: real time plus an offset we move by hand ------------------
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };

// --- fake execFile: counts the processes and answers them ------------------
const child = require('node:child_process');
const realExecFile = child.execFile;

let calls = [];
let inFlight = 0;
let maxInFlight = 0;
// cmd + args -> string (stdout) or null (the command failed)
let answers = {};

child.execFile = function (cmd, args, opts, cb) {
  const line = [cmd, ...args].join(' ');
  calls.push(line);
  inFlight++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  // Deferred, like a real process: whoever starts two of them before the first
  // answer arrives has started them side by side.
  setTimeout(() => {
    inFlight--;
    const out = Object.prototype.hasOwnProperty.call(answers, line) ? answers[line] : null;
    if (out === null || out === undefined) cb(new Error(`no answer for: ${line}`), '', '');
    else cb(null, out, '');
  }, 5);
  return { pid: 0 };
};

function counted(fn) {
  calls = [];
  maxInFlight = 0;
  return Promise.resolve(fn()).then((value) => ({ value, calls, max: maxInFlight }));
}

const gitinfo = require(path.join(__dirname, '..', 'src', 'main', 'gitinfo.js'));
const dbschema = require(path.join(__dirname, '..', 'src', 'main', 'dbschema', 'index.js'));

test.after(() => {
  child.execFile = realExecFile;
  Date.now = realNow;
});

// ---------------------------------------------------------------------------
// getGitInfo: the repo root per working directory, and the two calls in parallel
// ---------------------------------------------------------------------------

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
const parallel = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));

test.after(() => {
  for (const dir of [repo, parallel, other]) fs.rmSync(dir, { recursive: true, force: true });
});

function gitAnswers(root) {
  return {
    'git rev-parse --abbrev-ref HEAD': 'feature/x\n',
    'git rev-parse --show-toplevel': `${root}\n`,
    'git status --porcelain': ' M src/main/gitinfo.js\n?? note.txt\n',
  };
}

test('the first getGitInfo starts three processes, the next one two', async () => {
  answers = gitAnswers(repo);

  const cold = await counted(() => gitinfo.getGitInfo(repo));
  assert.strictEqual(cold.value.branch, 'feature/x');
  assert.strictEqual(cold.value.root, repo);
  assert.deepStrictEqual(cold.value.files.map((f) => f.path), ['src/main/gitinfo.js', 'note.txt']);
  assert.strictEqual(cold.calls.length, 3, cold.calls.join(', '));

  const warm = await counted(() => gitinfo.getGitInfo(repo));
  assert.strictEqual(warm.calls.length, 2, warm.calls.join(', '));
  assert.ok(!warm.calls.includes('git rev-parse --show-toplevel'),
    `the root comes from the cache: ${warm.calls.join(', ')}`);
  assert.strictEqual(warm.value.root, repo, 'and it is the same root');

  const many = await counted(async () => { for (let i = 0; i < 5; i++) await gitinfo.getGitInfo(repo); });
  assert.strictEqual(many.calls.length, 10, `five refreshes: ${many.calls.join(', ')}`);
});

test('root and status run side by side, branch stays the abort condition', async () => {
  answers = gitAnswers(parallel);
  const run = await counted(() => gitinfo.getGitInfo(parallel));
  assert.strictEqual(run.calls[0], 'git rev-parse --abbrev-ref HEAD');
  assert.strictEqual(run.max, 2, 'two of the three processes were in flight at once');
});

test('a working directory without a repo stops after the first call', async () => {
  answers = {}; // every command fails
  const none = await counted(() => gitinfo.getGitInfo(parallel));
  assert.strictEqual(none.value, null);
  assert.strictEqual(none.calls.length, 1, none.calls.join(', '));
});

test('a vanished working directory starts nothing at all', async () => {
  const gone = path.join(os.tmpdir(), 'flightdeck-git-gone');
  const nothing = await counted(() => gitinfo.getGitInfo(gone));
  assert.strictEqual(nothing.value, null);
  assert.strictEqual(nothing.calls.length, 0);
});

test('a second working directory gets its own root, and both age out', async () => {
  answers = gitAnswers(other);
  const second = await counted(() => gitinfo.getGitInfo(other));
  assert.strictEqual(second.value.root, other);
  assert.ok(second.calls.includes('git rev-parse --show-toplevel'),
    'a cwd that was not asked about yet costs the call');

  answers = gitAnswers(repo);
  const still = await counted(() => gitinfo.getGitInfo(repo));
  assert.strictEqual(still.calls.length, 2, 'the first cwd is still cached');

  advance(61_000); // past the lifetime of the root entry
  const aged = await counted(() => gitinfo.getGitInfo(repo));
  assert.strictEqual(aged.calls.length, 3, `after the lifetime it is asked again: ${aged.calls.join(', ')}`);
});

// ---------------------------------------------------------------------------
// baselineOptions: everything but the HEAD lookup hangs on the commit
// ---------------------------------------------------------------------------

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BRANCH_POINT = 'c'.repeat(40);
const PR_POINT = 'd'.repeat(40);

function baselineAnswers(head) {
  return {
    'git rev-parse HEAD': `${head}\n`,
    'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
    [`git merge-base HEAD origin/main`]: `${BRANCH_POINT}\n`,
    [`git merge-base HEAD origin/release`]: `${PR_POINT}\n`,
  };
}

const PR = { number: 42, baseRefName: 'release' };

test('the first baselineOptions asks git, the next one only for HEAD', async () => {
  answers = baselineAnswers(HEAD_A);

  const cold = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.deepStrictEqual(cold.value.map((o) => o.mode), ['pr', 'branch', 'head']);
  assert.deepStrictEqual(cold.value.map((o) => o.ref), [PR_POINT, BRANCH_POINT, HEAD_A]);
  // HEAD, the merge base against the PR base, the default branch, its merge base
  assert.strictEqual(cold.calls.length, 4, cold.calls.join(', '));

  const warm = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.deepStrictEqual(warm.calls, ['git rev-parse HEAD']);
  assert.deepStrictEqual(warm.value.map((o) => o.ref), [PR_POINT, BRANCH_POINT, HEAD_A]);

  const many = await counted(async () => { for (let i = 0; i < 5; i++) await dbschema.baselineOptions('/repo', PR); });
  assert.strictEqual(many.calls.length, 5, `five polls, five processes: ${many.calls.join(', ')}`);
});

test('time passing alone does not invalidate the options', async () => {
  advance(120_000);
  const later = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.deepStrictEqual(later.calls, ['git rev-parse HEAD']);
});

test('a commit invalidates them', async () => {
  answers = baselineAnswers(HEAD_B);
  const after = await counted(() => dbschema.baselineOptions('/repo', PR));
  // Both merge bases again; the default branch has its own cache and stays.
  assert.strictEqual(after.calls.length, 3, `HEAD moved: ${after.calls.join(', ')}`);
  assert.strictEqual(after.value.find((o) => o.mode === 'head').ref, HEAD_B);

  // The old commit is still in the cache, it was not overwritten.
  answers = baselineAnswers(HEAD_A);
  const back = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.deepStrictEqual(back.calls, ['git rev-parse HEAD']);
  assert.strictEqual(back.value.find((o) => o.mode === 'head').ref, HEAD_A);
});

test('another repository and another PR get their own entries', async () => {
  const elsewhere = await counted(() => dbschema.baselineOptions('/other', PR));
  assert.strictEqual(elsewhere.calls.length, 4, `another root: ${elsewhere.calls.join(', ')}`);

  const noPr = await counted(() => dbschema.baselineOptions('/repo', null));
  assert.strictEqual(noPr.calls.length, 2, `without a PR the labels differ: ${noPr.calls.join(', ')}`);
  assert.deepStrictEqual(noPr.value.map((o) => o.mode), ['branch', 'head']);

  const noPrAgain = await counted(() => dbschema.baselineOptions('/repo', null));
  assert.deepStrictEqual(noPrAgain.calls, ['git rev-parse HEAD']);
});

test('a fetch that moves the base ref is caught by the lifetime', async () => {
  advance(301_000); // past the lifetime of the baseline entry
  const aged = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.strictEqual(aged.calls.length, 3, `after the lifetime git is asked again: ${aged.calls.join(', ')}`);
});

test('the refresh button in the panel asks git again', async () => {
  const forced = await counted(() => dbschema.baselineOptions('/repo', PR, true));
  assert.strictEqual(forced.calls.length, 3, `forced: ${forced.calls.join(', ')}`);
});

test('a language switch drops the translated labels', async () => {
  const warm = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.deepStrictEqual(warm.calls, ['git rev-parse HEAD']);

  dbschema.clearCache();
  const fresh = await counted(() => dbschema.baselineOptions('/repo', PR));
  assert.strictEqual(fresh.calls.length, 4, `cleared: ${fresh.calls.join(', ')}`);
});

test('without a commit there is no baseline and no further call', async () => {
  answers = { 'git rev-parse HEAD': '' };
  const empty = await counted(() => dbschema.baselineOptions('/fresh', PR));
  assert.deepStrictEqual(empty.value, []);
  assert.deepStrictEqual(empty.calls, ['git rev-parse HEAD']);
});
