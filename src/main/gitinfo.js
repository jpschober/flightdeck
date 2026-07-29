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
//
// ZWEISTUFIG, und zwar aus Kostengruenden. `gh pr view --json ...` ist eine
// GraphQL-Abfrage, und GitHub rechnet sie nach der Zahl angeforderter Knoten ab --
// nicht pro Aufruf. Felder wie `comments`, `reviews`, `files` und `commits` sind
// Connections: Ihr Preis waechst mit dem PR. Ein lebhafter Review-PR kostet damit
// ein Vielfaches eines frischen, und das GraphQL-Kontingent (5000 Punkte/Stunde,
// pro NUTZER, nicht pro Repo) ist schneller leer, als man denkt -- geteilt mit
// jedem anderen Werkzeug, das im selben Konto `gh` benutzt.
//
// Deshalb zwei Abfragen mit getrennten Lebensdauern:
//   * LIGHT -- was sich staendig aendert (CI-Status, Draft, Titel, Zeilenzahlen).
//     Klein, weil ohne Connections ausser dem Check-Rollup. Bleibt engmaschig.
//   * HEAVY -- Dateien, Commits, Kommentare, Reviews, Body. Aendert sich in Minuten,
//     nicht in Sekunden, und ist der eigentliche Kostentreiber.
//
// Das zusammengesetzte Ergebnis hat dieselbe Form wie vorher; Aufrufer merken nichts.
const prCache = new Map(); // key -> { pr, lightAt, heavyAt }
const PR_LIGHT_TTL = 45_000;
const PR_TTL = 300_000;

const LIGHT_FIELDS = 'number,title,url,state,isDraft,author,baseRefName,headRefName,'
  + 'additions,deletions,statusCheckRollup';
const HEAVY_FIELDS = 'files,body,commits,comments,reviews';

async function fetchPrJson(cwd, fields) {
  const out = await run('gh', ['pr', 'view', '--json', fields], cwd, 15000);
  if (!out) return null; // kein PR / gh nicht eingerichtet
  try {
    return JSON.parse(out);
  } catch {
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

/** Leere Huelle fuer die schweren Felder -- damit ein PR nie ohne sie herauskommt. */
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
      // Kein PR (oder gh nicht eingerichtet). Beide Zeitstempel setzen, damit der
      // Fall nicht bei jedem Tick erneut abgefragt wird.
      prCache.set(key, { pr: null, lightAt: now, heavyAt: now });
      return null;
    }
    pr = { ...EMPTY_HEAVY, ...(pr || {}), ...mapLight(j) };
    lightAt = now;
  }

  if (pr && !heavyFresh) {
    const j = await fetchPrJson(cwd, HEAVY_FIELDS);
    // Scheitert nur die schwere Haelfte, bleibt der zuletzt bekannte Stand stehen --
    // veraltete Kommentare sind besser als ein Panel, das leer springt.
    if (j !== null) {
      pr = { ...pr, ...mapHeavy(j) };
      heavyAt = now;
    }
  }

  prCache.set(key, { pr, lightAt, heavyAt });
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
