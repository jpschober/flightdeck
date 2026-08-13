'use strict';
// Collects git and pull request information for a working directory.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const log = require('./log');

// ---------------------------------------------------------------------------
// Git in a directory nobody chose
//
// The working directory comes from the terminal output (OSC 7): the shell
// changes into it, and four seconds later git runs there. Git reads that
// directory's .git/config, and a config can name a program that git then
// starts. A `git clone` does not carry such settings along - a project handed
// around as an archive with its .git directory included does, and a `cd` into
// it is then enough.
//
// Three mechanisms, because no single one covers the field:
//
//   -c on every call        core.fsmonitor, core.hooksPath. `git status` starts
//                           the fsmonitor; an override on the command line
//                           beats the config file.
//   --no-ext-diff,          diff.external and the per-driver `command` and
//   --no-textconv           `textconv` entries, which .gitattributes points at.
//   (see main.js)           An empty `-c diff.external=` is no use: git then
//                           tries to run the empty command instead of falling
//                           back to its own diff.
//   the check below         filter.<name>.clean/smudge/process. `git status`
//                           runs the clean filter to find out whether a file
//                           differs from the index, the driver names are free,
//                           so there is nothing to override by name and no
//                           switch that turns them off.
//
// So the config is read before git is started in a directory, and if it names a
// program in one of those keys, git is not started there at all. The panel says
// so - staying silent would look like "no repository".
const GIT_NEUTRAL = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null'];

// The keys the check refuses. `include`/`includeIf` are in here because an
// included file can carry any of the others; following the include ourselves
// would mean reproducing git's rules for conditional includes.
const EXECUTING_KEYS = [
  /^filter\..*\.(clean|smudge|process)$/,
  /^include\.path$/,
  /^includeif\..*\.path$/,
];

function exec(cmd, args, cwd, timeout = 8000) {
  const argv = cmd === 'git' ? [...GIT_NEUTRAL, ...args] : args;
  const env = cmd === 'git' ? { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } : process.env;
  return new Promise((resolve) => {
    execFile(cmd, argv, { cwd, env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // `null` is the answer for "nothing there" as well as for "gh is not set
      // up" and "git timed out". The callers cannot tell those apart, so the
      // reason is recorded here.
      if (err) { log.debug('run: command failed', { cmd, args: args.join(' '), cwd, err }); resolve(null); }
      else resolve(stdout.toString());
    });
  });
}

/**
 * Reads a git config file and reports the first key that names a program.
 * Understands what git's own parser understands of the syntax: section headers
 * with and without a subsection, a key on the header's line, `key` without a
 * value, and comments.
 */
function scanConfig(text) {
  let section = '';
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    while (line) {
      if (line.startsWith('#') || line.startsWith(';')) break;
      const head = /^\[([^\]]*)\]/.exec(line);
      if (head) {
        // [filter "evil"] and [filter.evil] name the same thing
        const inner = head[1].trim();
        const quoted = /^(\S+)\s+"(.*)"$/.exec(inner);
        section = quoted ? `${quoted[1].toLowerCase()}.${quoted[2]}` : inner.toLowerCase();
        line = line.slice(head[0].length).trim();
        continue;
      }
      const key = /^([A-Za-z][\w-]*)/.exec(line);
      if (!key) break;
      const full = `${section}.${key[1]}`.toLowerCase();
      if (EXECUTING_KEYS.some((re) => re.test(full))) return full;
      break; // one key per line; its value can hold anything, including ]
    }
  }
  return null;
}

// The verdict per directory: whether a repository is there at all, and which
// key keeps git out of it. A refresh pass starts several git commands in the
// same directory, so the answer is kept - re-read when a config file's
// timestamp moves, and at most held for the length of one pass otherwise.
const verdicts = new Map(); // cwd -> { at, files: [{path, mtimeMs}], risk, repo }
const VERDICT_FRESH_MS = 2000;
const VERDICT_MAX = 100;

async function stamp(file) {
  try { return { path: file, mtimeMs: (await fsp.stat(file)).mtimeMs }; }
  catch { return { path: file, mtimeMs: null }; } // absent counts as a state too
}

function remember(cwd, entry) {
  verdicts.delete(cwd);
  verdicts.set(cwd, entry);
  while (verdicts.size > VERDICT_MAX) verdicts.delete(verdicts.keys().next().value);
  return entry;
}

const verdictInFlight = new Map(); // cwd -> Promise

// Several sessions can share a working directory, and on a cold cache they all
// arrive at the same tick. One probe answers them all - the same arrangement
// the root lookup below makes, for the same reason.
async function verdictFor(cwd) {
  const running = verdictInFlight.get(cwd);
  if (running) return running;
  const pending = lookupVerdict(cwd);
  verdictInFlight.set(cwd, pending);
  try { return await pending; }
  finally { verdictInFlight.delete(cwd); }
}

async function lookupVerdict(cwd) {
  const now = Date.now();
  const known = verdicts.get(cwd);
  if (known) {
    if (now - known.at < VERDICT_FRESH_MS) return known;
    // Without a config file there is nothing to compare against - a directory
    // that `git init` has meanwhile turned into a repository would otherwise
    // keep its old verdict for good.
    if (known.files.length) {
      const fresh = await Promise.all(known.files.map((f) => stamp(f.path)));
      if (fresh.every((f, i) => f.mtimeMs === known.files[i].mtimeMs)) {
        known.at = now;
        return known;
      }
    }
  }

  // Where the config files are is git's own answer. `rev-parse` reads the
  // config but runs nothing out of it - no index refresh, so no filter and no
  // fsmonitor. Its failure is the answer to "is there a repository here".
  const out = await exec('git', ['rev-parse', '--git-dir', '--git-common-dir'], cwd);
  if (out === null) return remember(cwd, { at: now, files: [], risk: null, repo: false });

  const [gitDir, commonDir] = out.trim().split('\n').map((p) => path.resolve(cwd, p.trim()));
  const files = [path.join(commonDir || gitDir, 'config'), path.join(gitDir, 'config.worktree')];
  let risk = null;
  const stamps = [];
  for (const file of files) {
    stamps.push(await stamp(file));
    if (risk) continue;
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    risk = scanConfig(text);
    if (risk) log.warn('git: no git in this directory, its configuration names a program', { cwd, key: risk, file });
  }
  return remember(cwd, { at: now, files: stamps, risk, repo: true });
}

async function run(cmd, args, cwd, timeout = 8000) {
  if (cmd === 'git' && (await verdictFor(cwd)).risk) return null;
  return exec(cmd, args, cwd, timeout);
}

// --- `git status --porcelain=v2 -z` ----------------------------------------
//
// The path is the last field of a record; how many space-separated fields come
// before it follows from the record's first character (git-status(1), "Porcelain
// Format Version 2"). `?` (untracked) carries the path right after its
// one-character type. `!` (ignored) does the same, but only ever appears with
// `--ignored`, which nobody passes; it lands in the same place as a record type
// git has yet to invent - dropped.
const V2_FIELDS = { 1: 8, 2: 9, u: 10 };

/** The rest of a record after `count` space-separated fields, or null. */
function afterFields(record, count) {
  let at = 0;
  for (let n = 0; n < count; n++) {
    at = record.indexOf(' ', at) + 1;
    if (at === 0) return null; // fewer fields than the format has
  }
  return record.slice(at);
}

// Version 2 with `-z`, because of what the short format does to a path. Git
// writes anything non-ASCII there C-quoted (`"src/M\303\274ller.ts"`), and the
// escapes would have to be undone here: a name that stays escaped is shown
// wrong in the file list, and the `git diff -- <path>` the preview runs
// afterwards matches nothing. `-z` writes the path as it is on disk, and it
// puts a rename's original path in a record of its own - the short format
// separates the two paths with ` -> `, which a file name may contain itself.
//
// The format arrived in git 2.11 (2016). An older git rejects the option, and
// `exec` turns that into the same `null` as any other failed call: the file
// list stays empty, the rest of the panel keeps working.
function parseStatus(porcelain) {
  const files = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue; // the trailing NUL, and nothing else
    const kind = record[0];
    if (kind === '#') continue; // branch headers, were they ever asked for
    let xy;
    let p;
    if (kind === '?') {
      xy = '??';
      p = record.slice(2);
    } else {
      const fields = V2_FIELDS[kind];
      if (!fields) continue;
      // A rename or copy is followed by its original path. The list shows the
      // new one, so that record is stepped over.
      if (kind === '2') i++;
      p = afterFields(record, fields);
      if (p === null) continue;
      // An unchanged half is a dot in this format, not a space.
      xy = record.slice(2, 4).replace(/\./g, ' ');
    }
    const code = xy === '??' ? '?' : (xy.trim()[0] || 'M');
    // git reports untracked directories with a trailing slash. Those are not
    // files - a preview of them is bound to fail.
    files.push({ status: code, path: p, untracked: xy === '??', dir: p.endsWith('/') });
  }
  return files;
}

// --- repo root per working directory ---------------------------------------
//
// `rev-parse --show-toplevel` gives the same answer for a working directory
// until the repository underneath it changes: a `git init` in a subdirectory,
// a worktree that takes the directory's place, the directory disappearing. A
// deleted directory is caught by the caller before it gets here; the other two
// happen without announcing themselves, so the entry carries a lifetime. At the
// four-second refresh that is one process per working directory per minute
// instead of fifteen.
const rootCache = new Map(); // cwd -> { root, at }
const rootInFlight = new Map(); // cwd -> Promise
const ROOT_TTL = 60_000;
const ROOT_CACHE_MAX = 64;

async function gitRoot(cwd) {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < ROOT_TTL) return hit.root;

  // Several sessions can share a working directory, and on a cold cache they
  // all arrive at the same tick. One process answers them all.
  const running = rootInFlight.get(cwd);
  if (running) return running;

  const pending = lookupRoot(cwd);
  rootInFlight.set(cwd, pending);
  try {
    return await pending;
  } finally {
    rootInFlight.delete(cwd);
  }
}

async function lookupRoot(cwd) {
  const now = Date.now();
  const out = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const root = out && out.trim() ? out.trim().replace(/\//g, path.sep) : null;
  // A failed or empty answer is not cached: it is a timeout or a directory
  // outside a repository, and both are answered again next time.
  if (!root) return null;
  rootCache.delete(cwd);
  rootCache.set(cwd, { root, at: now });
  while (rootCache.size > ROOT_CACHE_MAX) rootCache.delete(rootCache.keys().next().value);
  return root;
}

async function getGitInfo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  // The verdict answers both questions the first two calls used to ask: whether
  // a repository is there, and whether git may be started in it. Refused and
  // absent stay apart - otherwise a blocked directory reads as one without a
  // repository.
  const verdict = await verdictFor(cwd);
  if (!verdict.repo) return null;
  if (verdict.risk) return { blocked: verdict.risk, branch: null, root: null, files: [] };
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  // The verdict already found a repository here, so a failing branch lookup is a
  // transient git hiccup - a timeout under load, an index or HEAD lock held
  // while the agent commits - not "no repository". Reported apart as transient
  // so the caller keeps the last known branch, root and files instead of
  // blanking them (and, since the notes key hangs off the root, the notes too).
  if (branch === null) return { transient: true };
  // Root and status do not depend on each other, so they run together. The
  // branch above stays the abort condition and therefore stays on its own.
  const [root, status] = await Promise.all([
    gitRoot(cwd),
    run('git', ['status', '--porcelain=v2', '-z'], cwd),
  ]);
  return {
    blocked: null,
    branch: branch.trim(),
    // gitRoot() hands back an already normalised path or null.
    root: root || cwd,
    // null (the call failed) is kept apart from "" (no changes): the first keeps
    // the last file list, the second is genuinely empty. See doRefresh.
    files: status === null ? null : parseStatus(status),
  };
}

// --- Pull request via the GitHub CLI (gh), cached per repo+branch ---
//
// TWO-STAGE, and for cost reasons. `gh pr view --json ...` is a GraphQL query,
// and GitHub bills it by the number of requested nodes -- not per call. Fields
// like `comments`, `reviews`, `files` and `commits` are connections: their price
// grows with the PR. A busy review PR therefore costs a multiple of a fresh one,
// and the GraphQL quota (5000 points/hour, per USER, not per repo) runs out
// faster than you would think -- shared with every other tool that uses `gh`
// under the same account.
//
// Hence two queries with separate lifetimes:
//   * LIGHT -- what changes constantly (CI status, draft, title, line counts).
//     Small, because it has no connections apart from the check rollup. Stays
//     fine-grained.
//   * HEAVY -- files, commits, comments, reviews, body. Changes in minutes, not
//     seconds, and is the actual cost driver.
//
// The assembled result has the same shape as before; callers notice nothing.
const prCache = new Map(); // key -> { pr, lightAt, heavyAt }
const PR_LIGHT_TTL = 45_000;
const PR_TTL = 300_000;

const LIGHT_FIELDS = 'number,title,url,state,isDraft,author,baseRefName,headRefName,'
  + 'additions,deletions,statusCheckRollup';
const HEAVY_FIELDS = 'files,body,commits,comments,reviews';

async function fetchPrJson(cwd, fields) {
  const out = await run('gh', ['pr', 'view', '--json', fields], cwd, 15000);
  if (!out) return null; // no PR / gh not set up
  try {
    return JSON.parse(out);
  } catch (e) {
    log.warn('gitinfo: gh returned unparsable JSON', { cwd, fields, err: e });
    return null;
  }
}

function mapLight(j) {
  return {
    number: j.number,
    title: j.title,
    url: j.url,
    state: j.state,
    isDraft: j.isDraft,
    author: j.author ? j.author.login : null,
    baseRefName: j.baseRefName,
    headRefName: j.headRefName,
    additions: j.additions,
    deletions: j.deletions,
    checks: summarizeChecks(j.statusCheckRollup || []),
  };
}

function mapHeavy(j) {
  return {
    files: (j.files || []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    body: (j.body || '').slice(0, 20000),
    commits: (j.commits || []).slice(-30).map((c) => ({
      sha: (c.oid || '').slice(0, 7),
      message: c.messageHeadline || '',
      date: c.authoredDate || null,
    })),
    comments: (j.comments || []).slice(-20).map((c) => ({
      author: c.author ? c.author.login : null,
      body: (c.body || '').slice(0, 3000),
      createdAt: c.createdAt,
    })),
    reviews: (j.reviews || []).slice(-20).map((r) => ({
      author: r.author ? r.author.login : null,
      state: r.state,
      body: (r.body || '').slice(0, 3000),
      submittedAt: r.submittedAt,
    })),
  };
}

/** Empty shell for the heavy fields -- so a PR never comes out without them. */
const EMPTY_HEAVY = { files: [], body: '', commits: [], comments: [], reviews: [] };

async function getPrInfo(cwd, root, branch, force = false) {
  if (!cwd || !branch || branch === 'HEAD') return null;
  const key = `${root}|${branch}`;
  const hit = prCache.get(key);
  const now = Date.now();

  const lightFresh = !force && hit && now - hit.lightAt < PR_LIGHT_TTL;
  const heavyFresh = !force && hit && now - hit.heavyAt < PR_TTL;
  if (lightFresh && heavyFresh) return hit.pr;

  let pr = hit ? hit.pr : null;
  let lightAt = hit ? hit.lightAt : 0;
  let heavyAt = hit ? hit.heavyAt : 0;

  if (!lightFresh) {
    const j = await fetchPrJson(cwd, LIGHT_FIELDS);
    if (j === null) {
      // No PR (or gh not set up). Set both timestamps so this case is not
      // queried again on every tick.
      prCache.set(key, { pr: null, lightAt: now, heavyAt: now });
      return null;
    }
    pr = { ...EMPTY_HEAVY, ...(pr || {}), ...mapLight(j) };
    lightAt = now;
  }

  if (pr && !heavyFresh) {
    const j = await fetchPrJson(cwd, HEAVY_FIELDS);
    // If only the heavy half fails, the last known state stays -- stale
    // comments are better than a panel that jumps to empty.
    if (j !== null) {
      pr = { ...pr, ...mapHeavy(j) };
      heavyAt = now;
    }
  }

  prCache.set(key, { pr, lightAt, heavyAt });
  return pr;
}

// Boil CI checks down to success/failure/pending/neutral
function summarizeChecks(rollup) {
  const norm = (c) => {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL_SUCCESS'].includes(v)) return 'success';
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) return 'failure';
    if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED'].includes(v)) return 'pending';
    return 'neutral';
  };
  const items = rollup.map((c) => ({ name: c.name || c.context || '?', status: norm(c) })).slice(0, 40);
  return {
    total: rollup.length,
    success: items.filter((i) => i.status === 'success').length,
    failure: items.filter((i) => i.status === 'failure').length,
    pending: items.filter((i) => i.status === 'pending').length,
    items,
  };
}

module.exports = { getGitInfo, getPrInfo, parseStatus, run, scanConfig };
