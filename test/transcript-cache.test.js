'use strict';
// The transcript lookup in src/main/claude-sessions.js and the way the Claude
// plugin takes the resolved path from ctx.
//
// A ~/.claude/projects tree is built in a temp directory, HOME points at it and
// the real modules are driven against it, counting readdirSync and statSync
// calls - the point of the cache is which of those do not happen. The tests
// share that tree and run in the order they stand here.
//
// Time is faked (see `advance`) so the age limits of the listing can be reached
// without waiting for them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-test-'));
// os.homedir() reads HOME on Linux and macOS and USERPROFILE on Windows, and
// the module reads it while being required - both are set before that happens.
function setHome(dir) { process.env.HOME = dir; process.env.USERPROFILE = dir; }
setHome(home);
const PROJECTS = path.join(home, '.claude', 'projects');
const REPO = path.join(PROJECTS, '-home-me-repo');
const WORKTREE = path.join(PROJECTS, '-home-me-repo-wt-x');
fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(WORKTREE, { recursive: true });
// The size the issue is about: a few hundred project directories
for (let i = 0; i < 150; i++) fs.mkdirSync(path.join(PROJECTS, 'p' + i));

const ID = '11111111-2222-3333-4444-555555555555';
const ID_NEW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ID_WATCH = '99999999-8888-7777-6666-555555555555';
const GHOST = '00000000-1111-2222-3333-444444444444'; // bound, never written
const line = (extra) => JSON.stringify({ type: 'user', cwd: '/home/me/repo', message: { content: 'hi' }, ...extra }) + '\n';
fs.writeFileSync(path.join(REPO, ID + '.jsonl'), line().repeat(5));

const MODULE = path.join(__dirname, '..', 'src', 'main', 'claude-sessions.js');
const PLUGIN = path.join(__dirname, '..', 'src', 'main', 'agents', 'plugins', 'claude.js');

// --- fake clock: real time plus an offset we move by hand ------------------
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };

// --- syscall counters ------------------------------------------------------
let readdirs = 0; let stats = 0;
const realReaddir = fs.readdirSync; const realStat = fs.statSync;
fs.readdirSync = function (...a) { readdirs++; return realReaddir.apply(fs, a); };
fs.statSync = function (...a) { stats++; return realStat.apply(fs, a); };
function counted(fn) { readdirs = 0; stats = 0; const value = fn(); return { value, readdirs, stats }; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reload(file) {
  delete require.cache[require.resolve(file)];
  return require(file);
}

let cs = require(MODULE);

test.after(() => {
  fs.readdirSync = realReaddir;
  fs.statSync = realStat;
  Date.now = realNow;
  fs.rmSync(home, { recursive: true, force: true });
});

// --- lookup and cache, real fs.watch ---------------------------------------

test('cold lookup finds the transcript and reads the listing once', () => {
  const cold = counted(() => cs.findTranscriptById(ID));
  assert.strictEqual(cold.value, path.join(REPO, ID + '.jsonl'));
  assert.strictEqual(cold.readdirs, 1);
});

test('a warm lookup costs one stat and no listing', () => {
  const warm = counted(() => cs.findTranscriptById(ID));
  assert.strictEqual(warm.value, path.join(REPO, ID + '.jsonl'));
  assert.strictEqual(warm.readdirs, 0);
  assert.strictEqual(warm.stats, 1);

  const many = counted(() => { for (let i = 0; i < 10; i++) cs.findTranscriptById(ID); });
  assert.strictEqual(many.readdirs, 0, 'readdirs over 10 warm lookups');
  assert.strictEqual(many.stats, 10, 'stats over 10 warm lookups');
});

test('a moved transcript is found at its new path without an extra listing', () => {
  // The agent moves into a worktree: the transcript lands in another project
  // directory, one that was already in the listing.
  fs.renameSync(path.join(REPO, ID + '.jsonl'), path.join(WORKTREE, ID + '.jsonl'));
  const moved = counted(() => cs.findTranscriptById(ID));
  assert.strictEqual(moved.value, path.join(WORKTREE, ID + '.jsonl'));
  assert.strictEqual(moved.readdirs, 0);
});

test('a new session ID in a directory created after the listing is found', () => {
  // The watch event may not have arrived; the forced re-read on a miss covers
  // that. It is rate-limited to one per 4 s.
  advance(5000);
  const other = path.join(PROJECTS, '-home-me-other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, ID_NEW + '.jsonl'), line().repeat(3));
  const fresh = counted(() => cs.findTranscriptById(ID_NEW));
  assert.strictEqual(fresh.value, path.join(other, ID_NEW + '.jsonl'));
  assert.ok(fresh.readdirs <= 1, `the miss cost ${fresh.readdirs} listings`);

  const again = counted(() => cs.findTranscriptById(ID_NEW));
  assert.strictEqual(again.readdirs, 0, 'the next lookup of that ID is warm');
  assert.strictEqual(again.stats, 1);

  fs.unlinkSync(path.join(other, ID_NEW + '.jsonl'));
  const gone = counted(() => cs.findTranscriptById(ID_NEW));
  assert.strictEqual(gone.value, null, 'a deleted transcript reports null');
});

test('the watch event lets a new directory through', async () => {
  await sleep(150);
  const third = path.join(PROJECTS, '-home-me-third');
  fs.mkdirSync(third);
  fs.writeFileSync(path.join(third, ID_WATCH + '.jsonl'), line());
  await sleep(250); // let the watch event land
  const watched = counted(() => cs.findTranscriptById(ID_WATCH));
  assert.strictEqual(watched.value, path.join(third, ID_WATCH + '.jsonl'));
});

// --- a session bound to a transcript that does not exist --------------------

test('a permanent miss does not cost more than the scan it replaces', () => {
  // `claude --session-id <fresh-uuid>` binds an ID before Claude has written
  // the file. Every lookup misses until it appears.
  advance(5000);
  const first = counted(() => cs.findTranscriptById(GHOST));
  assert.strictEqual(first.value, null);
  assert.ok(first.readdirs <= 1, `the first miss read ${first.readdirs} listings`);

  const repeat = counted(() => { for (let i = 0; i < 5; i++) cs.findTranscriptById(GHOST); });
  assert.strictEqual(repeat.readdirs, 0, 'further misses in the same tick read no listing');
  const dirCount = realReaddir(PROJECTS).length;
  assert.ok(repeat.stats <= 5 * dirCount,
    `further misses scan once each, not twice: stats=${repeat.stats} dirs=${dirCount}`);

  advance(5000);
  const later = counted(() => cs.findTranscriptById(GHOST));
  assert.strictEqual(later.readdirs, 1, 'after the rate limit the re-read is allowed again');
});

test('a transcript that exists but is still empty counts as a miss', () => {
  fs.writeFileSync(path.join(REPO, GHOST + '.jsonl'), '');
  assert.strictEqual(counted(() => cs.findTranscriptById(GHOST)).value, null);

  fs.writeFileSync(path.join(REPO, GHOST + '.jsonl'), line());
  advance(5000);
  const written = counted(() => cs.findTranscriptById(GHOST));
  assert.strictEqual(written.value, path.join(REPO, GHOST + '.jsonl'));
  fs.unlinkSync(path.join(REPO, GHOST + '.jsonl'));
});

// --- readAgentCwd -----------------------------------------------------------

test('readAgentCwd reads the last cwd off the transcript', async () => {
  const file = path.join(WORKTREE, ID + '.jsonl');
  const wt = '/home/me/repo/wt/x';
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: wt }) + '\n');

  const p = cs.readAgentCwd(ID, file);
  assert.strictEqual(typeof p.then, 'function', 'returns a promise');
  assert.strictEqual(await p, wt);
  assert.strictEqual(await cs.readAgentCwd(ID), wt, 'resolves the path itself when none is passed');
  assert.strictEqual(await cs.readAgentCwd('deadbeef-0000-0000-0000-000000000000'), null);

  const emptyFile = path.join(REPO, 'empty.jsonl');
  fs.writeFileSync(emptyFile, '');
  assert.strictEqual(await cs.readAgentCwd(ID, emptyFile), null);

  const list = cs.listClaudeSessions(10);
  assert.ok(list.some((s) => s.id === ID), JSON.stringify(list.map((s) => s.id)));
});

// --- the plugin takes the path from ctx -------------------------------------

test('the plugin uses ctx.claudeTranscript instead of looking the path up', () => {
  const plugin = require(PLUGIN);
  const transcript = path.join(WORKTREE, ID + '.jsonl');
  const subagents = path.join(WORKTREE, ID, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-a1.meta.json'),
    JSON.stringify({ description: 'do a thing', agentType: 'claude', spawnDepth: 1 }));
  fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), line());

  const ctx = { claudeSessionId: ID, claudeTranscript: transcript };
  const det = counted(() => plugin.detect(ctx));
  assert.ok(det.value && det.value.evidence.includes('subagents/'), JSON.stringify(det.value));
  assert.strictEqual(det.readdirs, 0, 'detect reads no listing');

  const rd = counted(() => plugin.read(ctx));
  assert.strictEqual(rd.value.agents.length, 1);
  assert.strictEqual(rd.value.agents[0].description, 'do a thing');
  assert.strictEqual(rd.readdirs, 1, 'read reads only the subagents directory');
});

test('a null ctx.claudeTranscript is a resolved nothing, not a missing key', () => {
  // The refresh resolved nothing: the key is present and null, and the plugin
  // must not run the scan again for it.
  const plugin = require(PLUGIN);
  advance(5000);
  const nullCtx = { claudeSessionId: GHOST, claudeTranscript: null };

  const nd = counted(() => plugin.detect(nullCtx));
  assert.strictEqual(nd.readdirs, 0);
  assert.strictEqual(nd.stats, 0);

  const nr = counted(() => plugin.read(nullCtx));
  assert.strictEqual(nr.value.agents.length, 0);
  assert.strictEqual(nr.readdirs, 0);
  assert.strictEqual(nr.stats, 0);

  // A caller that only knows the session ID leaves the key out.
  const noKey = plugin.detect({ claudeSessionId: ID });
  assert.ok(noKey && noKey.evidence.includes('subagents/'),
    `without the key the plugin resolves the path itself: ${JSON.stringify(noKey)}`);
});

// --- fs.watch that succeeds and never fires ---------------------------------

test('the listing ages out even when no watch event ever arrives', () => {
  // The case a network file system produces: the watch is installed on the
  // local mount point and no event ever arrives. The listing must age out
  // anyway, otherwise a project directory created later stays invisible.
  const realWatch = fs.watch;
  fs.watch = () => ({ on() {}, close() {}, unref() {} });
  const mod = reload(MODULE);

  assert.ok(mod.listClaudeSessions(50).length > 0, 'the listing is read at all');

  const quiet = path.join(PROJECTS, '-home-me-quiet');
  fs.mkdirSync(quiet);
  const ID_QUIET = '77777777-6666-5555-4444-333333333333';
  // Over the 200-byte mark, otherwise listClaudeSessions drops it as aborted
  fs.writeFileSync(path.join(quiet, ID_QUIET + '.jsonl'), line().repeat(6));

  advance(1000);
  const pinned = counted(() => mod.findTranscriptById('12345678-0000-0000-0000-000000000000'));
  assert.ok(pinned.readdirs <= 1,
    `within the age limit the listing is not re-read every lookup: readdirs=${pinned.readdirs}`);

  advance(61000); // past the age limit for a watched directory
  const aged = counted(() => mod.findTranscriptById(ID_QUIET));
  assert.strictEqual(aged.value, path.join(quiet, ID_QUIET + '.jsonl'));

  // listClaudeSessions reads fresh, so it sees a new directory immediately.
  fs.watch = realWatch;
  const mod2 = reload(MODULE);
  fs.watch = () => ({ on() {}, close() {}, unref() {} });
  assert.ok(mod2.listClaudeSessions(200).some((s) => s.id === ID_QUIET),
    'listClaudeSessions reads the listing fresh');

  fs.watch = realWatch;
  cs = reload(MODULE);
});

// --- ~/.claude/projects does not exist --------------------------------------

test('without a projects directory nothing is scanned and fs.watch is tried once', () => {
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-nohome-'));
  setHome(gone);
  const mod = reload(MODULE);

  let watchCalls = 0;
  const realWatch = fs.watch;
  fs.watch = (...a) => { watchCalls++; return realWatch.apply(fs, a); };

  const empty = mod.listClaudeSessions(10);
  assert.ok(Array.isArray(empty) && empty.length === 0);
  assert.strictEqual(mod.findTranscriptById(ID), null);
  for (let i = 0; i < 5; i++) { advance(6000); mod.findTranscriptById(ID); }
  assert.ok(watchCalls <= 1, `a failing fs.watch is not retried on every lookup: ${watchCalls} calls`);

  fs.watch = realWatch;
  fs.rmSync(gone, { recursive: true, force: true });
  setHome(home);
  cs = reload(MODULE);
});
