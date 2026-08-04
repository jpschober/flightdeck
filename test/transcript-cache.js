'use strict';
// Checks the transcript lookup in src/main/claude-sessions.js and the way the
// Claude plugin takes the resolved path from ctx.
//
//   node test/transcript-cache.js
//
// There is no test runner in this repo; the file runs on its own and exits
// non-zero on the first failed check. It builds a ~/.claude/projects tree in a
// temp directory, points HOME at it and drives the real modules, counting
// readdirSync and statSync calls - the point of the cache is which of those do
// not happen.
//
// Time is faked (see `advance`) so the age limits of the listing can be reached
// without waiting for them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-test-'));
process.env.HOME = home;
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

let failed = 0;
function check(name, ok, detail) {
  console.log(ok ? 'ok   ' : 'FAIL ', name, detail === undefined ? '' : `(${detail})`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reload(file) {
  delete require.cache[require.resolve(file)];
  return require(file);
}

let cs = require(MODULE);

async function withRealWatcher() {
  console.log('\n# lookup and cache, real fs.watch');

  const cold = counted(() => cs.findTranscriptById(ID));
  check('cold lookup finds the transcript', cold.value === path.join(REPO, ID + '.jsonl'), cold.value);
  check('cold lookup reads the listing once', cold.readdirs === 1, `readdirs=${cold.readdirs}`);

  const warm = counted(() => cs.findTranscriptById(ID));
  check('warm lookup returns the same path', warm.value === cold.value);
  check('warm lookup does no readdir', warm.readdirs === 0, `readdirs=${warm.readdirs}`);
  check('warm lookup does one stat', warm.stats === 1, `stats=${warm.stats}`);

  const many = counted(() => { for (let i = 0; i < 10; i++) cs.findTranscriptById(ID); });
  check('10 warm lookups stay at 0 readdirs / 10 stats',
    many.readdirs === 0 && many.stats === 10, `readdirs=${many.readdirs} stats=${many.stats}`);

  // The agent moves into a worktree: the transcript lands in another project
  // directory, one that was already in the listing.
  fs.renameSync(path.join(REPO, ID + '.jsonl'), path.join(WORKTREE, ID + '.jsonl'));
  const moved = counted(() => cs.findTranscriptById(ID));
  check('moved transcript is found at its new path',
    moved.value === path.join(WORKTREE, ID + '.jsonl'), moved.value);
  check('the move costs no extra listing', moved.readdirs === 0, `readdirs=${moved.readdirs}`);

  // A project directory created after the listing was taken. The watch event
  // may not have arrived; the forced re-read on a miss covers that.
  advance(5000); // the forced re-read is rate-limited to one per 4 s
  const other = path.join(PROJECTS, '-home-me-other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, ID_NEW + '.jsonl'), line().repeat(3));
  const fresh = counted(() => cs.findTranscriptById(ID_NEW));
  check('a new session ID in a new directory is found',
    fresh.value === path.join(other, ID_NEW + '.jsonl'), fresh.value);
  check('the miss costs at most one extra listing', fresh.readdirs <= 1, `readdirs=${fresh.readdirs}`);
  const again = counted(() => cs.findTranscriptById(ID_NEW));
  check('the next lookup of that ID is warm',
    again.readdirs === 0 && again.stats === 1, `readdirs=${again.readdirs} stats=${again.stats}`);

  fs.unlinkSync(path.join(other, ID_NEW + '.jsonl'));
  const gone = counted(() => cs.findTranscriptById(ID_NEW));
  check('a deleted transcript reports null', gone.value === null, String(gone.value));

  // fs.watch delivering: a directory appears while nothing is being looked up
  await sleep(150);
  const third = path.join(PROJECTS, '-home-me-third');
  fs.mkdirSync(third);
  fs.writeFileSync(path.join(third, ID_WATCH + '.jsonl'), line());
  await sleep(250); // let the watch event land
  const watched = counted(() => cs.findTranscriptById(ID_WATCH));
  check('the watch event lets a new directory through',
    watched.value === path.join(third, ID_WATCH + '.jsonl'), watched.value);
}

async function missState() {
  console.log('\n# a session bound to a transcript that does not exist');
  // `claude --session-id <fresh-uuid>` binds an ID before Claude has written
  // the file. Every lookup misses until it appears - the state must not cost
  // more than the scan it replaces.
  advance(5000);
  const first = counted(() => cs.findTranscriptById(GHOST));
  check('the first miss reports null', first.value === null, String(first.value));
  check('the first miss re-reads the listing once', first.readdirs <= 1, `readdirs=${first.readdirs}`);

  const repeat = counted(() => { for (let i = 0; i < 5; i++) cs.findTranscriptById(GHOST); });
  check('further misses in the same tick read no listing',
    repeat.readdirs === 0, `readdirs=${repeat.readdirs}`);
  const dirCount = fs.readdirSync(PROJECTS).length;
  check('further misses scan once each, not twice',
    repeat.stats <= 5 * dirCount, `stats=${repeat.stats} dirs=${dirCount}`);

  advance(5000);
  const later = counted(() => cs.findTranscriptById(GHOST));
  check('after the rate limit the re-read is allowed again',
    later.readdirs === 1, `readdirs=${later.readdirs}`);

  // A transcript that exists but is still empty counts as a miss as well.
  fs.writeFileSync(path.join(REPO, GHOST + '.jsonl'), '');
  const empty = counted(() => cs.findTranscriptById(GHOST));
  check('an empty transcript is not bound', empty.value === null, String(empty.value));
  fs.writeFileSync(path.join(REPO, GHOST + '.jsonl'), line());
  advance(5000);
  const written = counted(() => cs.findTranscriptById(GHOST));
  check('once written it is found', written.value === path.join(REPO, GHOST + '.jsonl'), written.value);
  fs.unlinkSync(path.join(REPO, GHOST + '.jsonl'));
}

async function readCwd() {
  console.log('\n# readAgentCwd');
  const file = path.join(WORKTREE, ID + '.jsonl');
  const wt = '/home/me/repo/wt/x';
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: wt }) + '\n');
  const p = cs.readAgentCwd(ID, file);
  check('returns a promise', typeof p.then === 'function');
  check('reads the last cwd', (await p) === wt);
  check('resolves the path itself when none is passed', (await cs.readAgentCwd(ID)) === wt);
  check('unknown session -> null', (await cs.readAgentCwd('deadbeef-0000-0000-0000-000000000000')) === null);
  const emptyFile = path.join(REPO, 'empty.jsonl');
  fs.writeFileSync(emptyFile, '');
  check('empty file -> null', (await cs.readAgentCwd(ID, emptyFile)) === null);

  const list = cs.listClaudeSessions(10);
  check('listClaudeSessions still finds the session', list.some((s) => s.id === ID), JSON.stringify(list.map((s) => s.id)));
}

async function pluginCtx() {
  console.log('\n# the plugin takes the path from ctx');
  const plugin = require(PLUGIN);
  const transcript = path.join(WORKTREE, ID + '.jsonl');
  const subagents = path.join(WORKTREE, ID, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-a1.meta.json'),
    JSON.stringify({ description: 'do a thing', agentType: 'claude', spawnDepth: 1 }));
  fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), line());

  const ctx = { claudeSessionId: ID, claudeTranscript: transcript };
  const det = counted(() => plugin.detect(ctx));
  check('detect sees the subagents directory',
    det.value && det.value.evidence.includes('subagents/'), JSON.stringify(det.value));
  check('detect reads no listing', det.readdirs === 0, `readdirs=${det.readdirs}`);

  const rd = counted(() => plugin.read(ctx));
  check('read lists the agent',
    rd.value.agents.length === 1 && rd.value.agents[0].description === 'do a thing',
    JSON.stringify(rd.value.agents));
  check('read reads only the subagents directory', rd.readdirs === 1, `readdirs=${rd.readdirs}`);

  // The refresh resolved nothing: the key is present and null, and the plugin
  // must not run the scan again for it.
  advance(5000);
  const nullCtx = { claudeSessionId: GHOST, claudeTranscript: null };
  const nd = counted(() => plugin.detect(nullCtx));
  check('detect with a null path does not look it up',
    nd.readdirs === 0 && nd.stats === 0, `readdirs=${nd.readdirs} stats=${nd.stats}`);
  const nr = counted(() => plugin.read(nullCtx));
  check('read with a null path returns nothing and looks nothing up',
    nr.value.agents.length === 0 && nr.readdirs === 0 && nr.stats === 0,
    `readdirs=${nr.readdirs} stats=${nr.stats}`);

  // A caller that only knows the session ID leaves the key out.
  const noKey = plugin.detect({ claudeSessionId: ID });
  check('without the key the plugin resolves the path itself',
    noKey && noKey.evidence.includes('subagents/'), JSON.stringify(noKey));
}

async function silentWatcher() {
  console.log('\n# fs.watch that succeeds and never fires');
  // The case a network file system produces: the watch is installed on the
  // local mount point and no event ever arrives. The listing must age out
  // anyway, otherwise a project directory created later stays invisible.
  const realWatch = fs.watch;
  fs.watch = () => ({ on() {}, close() {}, unref() {} });
  const mod = reload(MODULE);

  const before = mod.listClaudeSessions(50).length;
  check('the listing is read at all', before > 0, `sessions=${before}`);

  const quiet = path.join(PROJECTS, '-home-me-quiet');
  fs.mkdirSync(quiet);
  const ID_QUIET = '77777777-6666-5555-4444-333333333333';
  // Over the 200-byte mark, otherwise listClaudeSessions drops it as aborted
  fs.writeFileSync(path.join(quiet, ID_QUIET + '.jsonl'), line().repeat(6));

  advance(1000);
  const pinned = counted(() => mod.findTranscriptById('12345678-0000-0000-0000-000000000000'));
  check('within the age limit the listing is not re-read every lookup',
    pinned.readdirs <= 1, `readdirs=${pinned.readdirs}`);

  advance(61000); // past the age limit for a watched directory
  const aged = counted(() => mod.findTranscriptById(ID_QUIET));
  check('after the age limit the new directory is found',
    aged.value === path.join(quiet, ID_QUIET + '.jsonl'), aged.value);

  // listClaudeSessions reads fresh, so it sees a new directory immediately.
  fs.watch = realWatch;
  const mod2 = reload(MODULE);
  fs.watch = () => ({ on() {}, close() {}, unref() {} });
  const seen = mod2.listClaudeSessions(200).some((s) => s.id === ID_QUIET);
  check('listClaudeSessions reads the listing fresh', seen);

  fs.watch = realWatch;
  cs = reload(MODULE);
}

async function missingProjectsDir() {
  console.log('\n# ~/.claude/projects does not exist');
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-nohome-'));
  process.env.HOME = gone;
  const mod = reload(MODULE);
  let watchCalls = 0;
  const realWatch = fs.watch;
  fs.watch = (...a) => { watchCalls++; return realWatch.apply(fs, a); };
  const empty = mod.listClaudeSessions(10);
  check('no projects directory -> empty list', Array.isArray(empty) && empty.length === 0);
  check('lookup reports null', mod.findTranscriptById(ID) === null);
  for (let i = 0; i < 5; i++) { advance(6000); mod.findTranscriptById(ID); }
  check('a failing fs.watch is not retried on every lookup', watchCalls <= 1, `watch calls=${watchCalls}`);
  fs.watch = realWatch;
  fs.rmSync(gone, { recursive: true, force: true });
  process.env.HOME = home;
  cs = reload(MODULE);
}

(async () => {
  await withRealWatcher();
  await missState();
  await readCwd();
  await pluginCtx();
  await silentWatcher();
  await missingProjectsDir();

  fs.rmSync(home, { recursive: true, force: true });
  Date.now = realNow;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
