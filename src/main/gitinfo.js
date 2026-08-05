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

async function verdictFor(cwd) {
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

function parseStatus(porcelain) {
  const files = [];
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    // Rename: "R  old -> new" -> only show the new path
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const code = xy === '??' ? '?' : (xy.trim()[0] || 'M');
    // git reports untracked directories with a trailing slash. Those are not
    // files - a preview of them is bound to fail.
    files.push({ status: code, path: p, untracked: xy === '??', dir: p.endsWith('/') });
  }
  return files;
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
  if (branch === null) return null;
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const status = await run('git', ['status', '--porcelain'], cwd);
  return {
    blocked: null,
    branch: branch.trim(),
    root: root ? root.trim().replace(/\//g, path.sep) : cwd,
    files: status ? parseStatus(status) : [],
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

module.exports = { getGitInfo, getPrInfo, run, scanConfig };
