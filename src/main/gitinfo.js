'use strict';
// Sammelt Git- und Pull-Request-Informationen fuer ein Arbeitsverzeichnis.
const { execFile } = require('child_process');
const fs = require('fs');

function run(cmd, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
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
    // Rename: "R  alt -> neu" -> nur den neuen Pfad anzeigen
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const code = xy === '??' ? '?' : (xy.trim()[0] || 'M');
    files.push({ status: code, path: p, untracked: xy === '??' });
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

// --- Pull Request via GitHub CLI (gh), gecacht pro Repo+Branch ---
const prCache = new Map(); // key -> { at, pr }
const PR_TTL = 45_000;

async function getPrInfo(cwd, root, branch, force = false) {
  if (!cwd || !branch || branch === 'HEAD') return null;
  const key = `${root}|${branch}`;
  const hit = prCache.get(key);
  if (!force && hit && Date.now() - hit.at < PR_TTL) return hit.pr;

  const out = await run('gh', [
    'pr', 'view', '--json',
    'number,title,url,state,isDraft,author,baseRefName,headRefName,additions,deletions,files,'
    + 'body,commits,statusCheckRollup,comments,reviews',
  ], cwd, 15000);

  let pr = null;
  if (out) {
    try {
      const j = JSON.parse(out);
      pr = {
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
        files: (j.files || []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
        body: (j.body || '').slice(0, 20000),
        commits: (j.commits || []).slice(-30).map((c) => ({
          sha: (c.oid || '').slice(0, 7),
          message: c.messageHeadline || '',
          date: c.authoredDate || null,
        })),
        checks: summarizeChecks(j.statusCheckRollup || []),
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
    } catch { /* kein PR / gh nicht eingerichtet */ }
  }
  prCache.set(key, { at: Date.now(), pr });
  return pr;
}

// CI-Checks auf success/failure/pending/neutral eindampfen
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
