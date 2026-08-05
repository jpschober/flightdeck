'use strict';
// Collects git and pull request information for a working directory.
const { execFile } = require('child_process');
const fs = require('fs');
const log = require('./log');

function run(cmd, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // `null` is the answer for "nothing there" as well as for "gh is not set
      // up" and "git timed out". The callers cannot tell those apart, so the
      // reason is recorded here.
      if (err) { log.debug('run: command failed', { cmd, args: args.join(' '), cwd, err }); resolve(null); }
      else resolve(stdout.toString());
    });
  });
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
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === null) return null;
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const status = await run('git', ['status', '--porcelain'], cwd);
  return {
    branch: branch.trim(),
    root: root ? root.trim().replace(/\//g, require('path').sep) : cwd,
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

module.exports = { getGitInfo, getPrInfo, run };
