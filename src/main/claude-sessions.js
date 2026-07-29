'use strict';
// Liest Claude-Code-Sessions aus ~/.claude/projects (JSONL-Dateien), um sie
// im Session-Browser anzuzeigen und per `claude --resume` fortsetzen zu koennen.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // filePath -> { mtime, data }

// Claude leitet den Verzeichnisnamen aus dem cwd ab: alles ausser [A-Za-z0-9]
// wird zu '-'. Ein Worktree unterhalb des Repos landet daher in einem eigenen
// Verzeichnis, dessen Name mit dem des Repos beginnt.
function encodeProjectDir(p) { return (p || '').replace(/[^a-zA-Z0-9]/g, '-'); }

// Kopf der Datei lesen: cwd, Slug und erste Nutzer-Nachricht als Vorschau.
// file-history-snapshot-Zeilen koennen riesig sein und werden uebersprungen.
function readHeadSignals(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(262144);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n');
    let cwd = null; let slug = null; let preview = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // letzte Zeile evtl. abgeschnitten
      if (entry.type === 'file-history-snapshot') continue;
      if (!cwd && entry.cwd) cwd = entry.cwd;
      if (!slug && entry.slug) slug = entry.slug;
      if (!preview && entry.type === 'user' && entry.message) {
        const c = entry.message.content;
        let text = null;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          const t = c.find((x) => x && x.type === 'text' && x.text);
          if (t) text = t.text;
        }
        if (text && !text.startsWith('<')) preview = text; // Meta-Turns ueberspringen
      }
      if (cwd && preview && slug) break;
    }
    return { cwd, slug, preview: preview ? preview.replace(/\s+/g, ' ').trim().slice(0, 160) : null };
  } catch {
    return { cwd: null, slug: null, preview: null };
  }
}

// Ende der Datei lesen: der letzte Slug gewinnt (Umbenennung via /rename)
function readTailSlug(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    const readSize = Math.min(size, 16384);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const matches = buf.toString('utf8').match(/"slug"\s*:\s*"([^"]+)"/g);
    if (!matches) return null;
    const last = matches[matches.length - 1].match(/"slug"\s*:\s*"([^"]+)"/);
    return last ? last[1] : null;
  } catch {
    return null;
  }
}

function listClaudeSessions(limit = 200) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return []; }

  const found = [];
  for (const dir of dirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let files;
    try { files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const filePath = path.join(dirPath, f);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (stat.size < 200) continue; // leere/abgebrochene Sessions
      found.push({ id: path.basename(f, '.jsonl'), file: filePath, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const top = found.slice(0, limit);

  for (const s of top) {
    const hit = cache.get(s.file);
    if (hit && hit.mtime === s.mtime) {
      Object.assign(s, hit.data);
    } else {
      const head = readHeadSignals(s.file);
      const data = { ...head, slug: readTailSlug(s.file) || head.slug };
      cache.set(s.file, { mtime: s.mtime, data });
      Object.assign(s, data);
    }
  }
  // Nur Sessions mit bekanntem Projektpfad sind fortsetzbar
  return top
    .filter((s) => s.cwd)
    .map(({ id, cwd, slug, preview, mtime }) => ({ id, cwd, slug, preview, mtime }));
}

// ---------------------------------------------------------------------------
// Transcript-Bindung: welche Claude-Session laeuft in diesem Terminal?
//
// Das Transcript ist die einzige Quelle, die verraet, wo der Agent wirklich
// arbeitet - wechselt er in einen Worktree, bleibt der cwd der Shell stehen.
// Gebunden wird ueber die Session-ID (UUID), nicht ueber den Dateipfad: beim
// Wechsel in einen Worktree wandert die Datei in ein anderes Projektverzeichnis.
// ---------------------------------------------------------------------------

// Projektverzeichnisse zu einem cwd: das eigene plus alle Worktrees darunter
function projectDirsFor(cwd) {
  const prefix = encodeProjectDir(cwd);
  if (!prefix) return [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return []; }
  return dirs
    .filter((d) => d === prefix || d.startsWith(prefix + '-'))
    .map((d) => path.join(PROJECTS_DIR, d));
}

function eachTranscript(cwd, fn) {
  for (const dir of projectDirsFor(cwd)) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, f)); } catch { continue; }
      fn(path.basename(f, '.jsonl'), stat, path.join(dir, f));
    }
  }
}

// Zustand vor dem Start von `claude` festhalten
function snapshotTranscripts(cwd) {
  const seen = new Map(); // sessionId -> mtimeMs
  eachTranscript(cwd, (id, stat) => seen.set(id, stat.mtimeMs));
  return seen;
}

// Nach dem Start: das Transcript, das seither entstanden ist bzw. als erstes
// geschrieben wurde. Eine neu angelegte Datei ist ein sicheres Signal und
// schlaegt daher jede bereits vorhandene.
function detectTranscript(cwd, snapshot, startedAt) {
  let best = null;
  eachTranscript(cwd, (id, stat) => {
    if (stat.size < 200 || stat.mtimeMs < startedAt) return;
    const before = snapshot.get(id);
    if (before !== undefined && stat.mtimeMs <= before) return; // unveraendert
    const fresh = before === undefined;
    if (!best || (fresh && !best.fresh)
        || (fresh === best.fresh && stat.mtimeMs < best.mtime)) {
      best = { id, fresh, mtime: stat.mtimeMs };
    }
  });
  return best ? best.id : null;
}

// Zuletzt benutzte Session eines Verzeichnisses - das ist die Auswahlregel
// von `claude --continue`. `before` blendet Schreibvorgaenge aus, die erst
// nach dem Start passiert sind (etwa die neue Session selbst).
function newestTranscript(cwd, before) {
  let best = null;
  eachTranscript(cwd, (id, stat) => {
    if (stat.size < 200) return;
    if (before && stat.mtimeMs > before) return;
    if (!best || stat.mtimeMs > best.mtime) best = { id, mtime: stat.mtimeMs };
  });
  return best ? best.id : null;
}

function findTranscriptById(sessionId) {
  if (!sessionId) return null;
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    const fp = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
    try { if (fs.statSync(fp).size > 0) return fp; } catch { /* nicht hier */ }
  }
  return null;
}

// Letztes im Transcript vermerktes cwd = aktuelles Arbeitsverzeichnis des
// Agenten (bei Worktree-Wechsel zieht es mitten in der Datei um).
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function readAgentCwd(sessionId) {
  const file = findTranscriptById(sessionId);
  if (!file) return null;
  try {
    const size = fs.statSync(file).size;
    const readSize = Math.min(size, 131072);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    let last = null; let m;
    CWD_RE.lastIndex = 0;
    while ((m = CWD_RE.exec(text)) !== null) last = m[1];
    if (!last) return null;
    try { return JSON.parse('"' + last + '"'); } catch { return last; }
  } catch {
    return null;
  }
}

module.exports = {
  listClaudeSessions,
  snapshotTranscripts,
  detectTranscript,
  newestTranscript,
  findTranscriptById,
  readAgentCwd,
};
