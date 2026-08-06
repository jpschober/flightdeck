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
// Put back afterwards, otherwise a later failure loses its diagnosis.
const realConsoleError = console.error;
const realConsoleLog = console.log;
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
let rawCalls = [];
let inFlight = 0;
let maxInFlight = 0;
// cmd + args -> string (stdout) or null (the command failed)
let answers = {};

// Every git command carries the options that keep the repository's own
// configuration from naming a program (GIT_NEUTRAL in gitinfo.js). The table
// and the assertions are keyed on the command line without them - otherwise
// every entry here would have to repeat them. `rawCalls` keeps what was really
// started, so their presence can be checked where it belongs.
function readable(cmd, args) {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') { i++; continue; } // the option and its value
    kept.push(args[i]);
  }
  return [cmd, ...kept].join(' ');
}

child.execFile = function (cmd, args, opts, cb) {
  const line = readable(cmd, args);
  rawCalls.push([cmd, ...args].join(' '));
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
  rawCalls = [];
  maxInFlight = 0;
  return Promise.resolve(fn()).then((value) => ({ value, calls, raw: rawCalls, max: maxInFlight }));
}

const gitinfo = require(path.join(__dirname, '..', 'src', 'main', 'gitinfo.js'));
const dbschema = require(path.join(__dirname, '..', 'src', 'main', 'dbschema', 'index.js'));

test.after(() => {
  child.execFile = realExecFile;
  Date.now = realNow;
  console.error = realConsoleError;
  console.log = realConsoleLog;
});

// ---------------------------------------------------------------------------
// getGitInfo: the repo root per working directory, and the two calls in parallel
// ---------------------------------------------------------------------------

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
const parallel = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));

test.after(() => {
  for (const dir of [repo, parallel, other, shared]) fs.rmSync(dir, { recursive: true, force: true });
});

// Before git is started in a directory, its configuration is read - see
// gitinfo.js. That costs the one `rev-parse` below per working directory; where
// the answer points, nothing exists, so nothing names a program and git runs.
const VERDICT = 'git rev-parse --git-dir --git-common-dir';
const VERDICT_ANSWER = '.git\n.git\n';

// The object hashes in a status record are not read; one stand-in does for all
// of them. What the format looks like is test/git-status-parse.test.js's business.
const BLOB = '0'.repeat(40);

function gitAnswers(root) {
  return {
    [VERDICT]: VERDICT_ANSWER,
    'git rev-parse --abbrev-ref HEAD': 'feature/x\n',
    'git rev-parse --show-toplevel': `${root}\n`,
    'git status --porcelain=v2 -z': `1 .M N... 100644 100644 100644 ${BLOB} ${BLOB} src/main/gitinfo.js\0? note.txt\0`,
  };
}

test('the first getGitInfo starts four processes, the next one two', async () => {
  answers = gitAnswers(repo);

  const cold = await counted(() => gitinfo.getGitInfo(repo));
  assert.strictEqual(cold.value.branch, 'feature/x');
  assert.strictEqual(cold.value.root, repo);
  assert.strictEqual(cold.value.blocked, null);
  assert.deepStrictEqual(cold.value.files.map((f) => f.path), ['src/main/gitinfo.js', 'note.txt']);
  // The verdict on the configuration, the branch, the root, the status
  assert.strictEqual(cold.calls.length, 4, cold.calls.join(', '));
  assert.strictEqual(cold.calls[0], VERDICT, 'the configuration is read before git works in the directory');

  const warm = await counted(() => gitinfo.getGitInfo(repo));
  assert.strictEqual(warm.calls.length, 2, warm.calls.join(', '));
  assert.ok(!warm.calls.includes('git rev-parse --show-toplevel'),
    `the root comes from the cache: ${warm.calls.join(', ')}`);
  assert.ok(!warm.calls.includes(VERDICT),
    `the verdict on the configuration is kept too: ${warm.calls.join(', ')}`);
  assert.strictEqual(warm.value.root, repo, 'and it is the same root');

  const many = await counted(async () => { for (let i = 0; i < 5; i++) await gitinfo.getGitInfo(repo); });
  assert.strictEqual(many.calls.length, 10, `five refreshes: ${many.calls.join(', ')}`);
});

test('root and status run side by side, branch stays the abort condition', async () => {
  answers = gitAnswers(parallel);
  const run = await counted(() => gitinfo.getGitInfo(parallel));
  assert.deepStrictEqual(run.calls.slice(0, 2), [VERDICT, 'git rev-parse --abbrev-ref HEAD'],
    `the verdict and the branch each stand on their own: ${run.calls.join(', ')}`);
  assert.strictEqual(run.max, 2, 'two of the four processes were in flight at once');
});

test('every git process carries the neutralising options', async () => {
  answers = gitAnswers(parallel);
  const run = await counted(() => gitinfo.getGitInfo(parallel));
  assert.ok(run.raw.length > 0);
  for (const line of run.raw) {
    assert.match(line, /^git -c core\.fsmonitor= -c core\.hooksPath=\/dev\/null /,
      `started without the options that keep the repository configuration out: ${line}`);
  }
});

test('a working directory without a repo stops after the first call', async () => {
  answers = {}; // every command fails
  // Nobody has asked about this one yet, so the first call is the verdict - and
  // a failing `rev-parse` is the answer to "is there a repository here".
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
  const none = await counted(() => gitinfo.getGitInfo(fresh));
  assert.strictEqual(none.value, null);
  assert.deepStrictEqual(none.calls, [VERDICT]);
  fs.rmSync(fresh, { recursive: true, force: true });

  // And where the verdict is already in, the branch stays the abort condition.
  const known = await counted(() => gitinfo.getGitInfo(parallel));
  assert.strictEqual(known.value, null);
  assert.deepStrictEqual(known.calls, ['git rev-parse --abbrev-ref HEAD']);
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

test('two sessions in the same working directory share one root lookup', async () => {
  answers = gitAnswers(shared);
  const both = await counted(() => Promise.all([
    gitinfo.getGitInfo(shared),
    gitinfo.getGitInfo(shared),
  ]));
  const toplevel = both.calls.filter((c) => c === 'git rev-parse --show-toplevel');
  assert.strictEqual(toplevel.length, 1, `cold cache, one lookup: ${both.calls.join(', ')}`);
  const verdicts = both.calls.filter((c) => c === VERDICT);
  assert.strictEqual(verdicts.length, 1, `and one verdict for both: ${both.calls.join(', ')}`);
  assert.deepStrictEqual(both.value.map((g) => g.root), [shared, shared]);
});

// ---------------------------------------------------------------------------
// baselineOptions: everything but the HEAD lookup hangs on the commit
// ---------------------------------------------------------------------------

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'e'.repeat(40);
const BRANCH_POINT = 'c'.repeat(40);
const PR_POINT = 'd'.repeat(40);

function baselineAnswers(head) {
  return {
    [VERDICT]: VERDICT_ANSWER,
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
  // The verdict on the configuration, HEAD, the merge base against the PR base,
  // the default branch, its merge base
  assert.strictEqual(cold.calls.length, 5, cold.calls.join(', '));
  assert.strictEqual(cold.calls[0], VERDICT);

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
  // Another directory, so its configuration is read once as well.
  assert.strictEqual(elsewhere.calls.length, 5, `another root: ${elsewhere.calls.join(', ')}`);

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
  answers = { [VERDICT]: VERDICT_ANSWER, 'git rev-parse HEAD': '' };
  const empty = await counted(() => dbschema.baselineOptions('/fresh', PR));
  assert.deepStrictEqual([...empty.value], []);
  // A directory nobody has asked about: its configuration, then HEAD - and an
  // empty HEAD ends it.
  assert.deepStrictEqual(empty.calls, [VERDICT, 'git rev-parse HEAD']);
});

test('two panels on the same repository share one run over the merge bases', async () => {
  answers = baselineAnswers(HEAD_C); // a commit nobody has asked about yet
  const both = await counted(() => Promise.all([
    dbschema.baselineOptions('/repo', PR),
    dbschema.baselineOptions('/repo', PR),
  ]));
  const mergeBases = both.calls.filter((c) => c.startsWith('git merge-base'));
  assert.strictEqual(mergeBases.length, 2, `one per baseline, not one per caller: ${both.calls.join(', ')}`);
  assert.strictEqual(both.value[0], both.value[1], 'both callers get the same list');
});

test('the options cannot be changed by whoever receives them', async () => {
  const options = await dbschema.baselineOptions('/repo', PR);
  assert.ok(Object.isFrozen(options), 'the list is frozen');
  assert.ok(Object.isFrozen(options[0]), 'the entries are frozen too');
  assert.throws(() => options.push({ mode: 'x' }), TypeError);
  assert.throws(() => { options[0].ref = 'nonsense'; }, TypeError);

  // What the caller does get: reading, and copies of its own.
  assert.strictEqual(options.find((o) => o.mode === 'head').ref, HEAD_C);
  assert.strictEqual([...options].sort((a, b) => a.mode.localeCompare(b.mode)).length, options.length);
});
