'use strict';
// Liest Claude-Code-Sessions aus ~/.claude/projects (JSONL-Dateien), um sie
// im Session-Browser anzuzeigen und per `claude --resume` fortsetzen zu koennen.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // filePath -> { mtime, data }

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
// Agent-Report: strukturierte Auswertung eines Session-Transcripts
// ---------------------------------------------------------------------------
const reportCache = new Map(); // filePath -> { mtime, report }
const MAX_REPORT_READ = 16 * 1024 * 1024;
const TEST_CMD_RE = /\b(npm (run )?test|pytest|vitest|jest|go test|cargo test|dotnet test|mvn test|gradle(w)? test|phpunit|rspec)\b/i;

function buildReport(filePath) {
  const stat = fs.statSync(filePath);
  const hit = reportCache.get(filePath);
  if (hit && hit.mtime === stat.mtimeMs) return hit.report;

  // Bei sehr grossen Transcripts nur das Ende lesen
  const readSize = Math.min(stat.size, MAX_REPORT_READ);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');

  const files = new Map();      // path -> edit count
  const commands = [];          // { cmd, desc, isTest }
  const commits = [];
  const questions = [];
  let slug = null;
  let summary = null;
  let firstTs = null;
  let lastTs = null;
  let turns = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'file-history-snapshot') continue;
    if (e.slug) slug = e.slug;
    if (e.timestamp) { if (!firstTs) firstTs = e.timestamp; lastTs = e.timestamp; }

    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    turns++;
    let textParts = [];
    for (const item of e.message.content) {
      if (item.type === 'text' && item.text) textParts.push(item.text);
      if (item.type !== 'tool_use' || !item.input) continue;
      const name = item.name || '';
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name) && item.input.file_path) {
        files.set(item.input.file_path, (files.get(item.input.file_path) || 0) + 1);
      } else if ((name === 'Bash' || name === 'PowerShell') && item.input.command) {
        const cmd = String(item.input.command).slice(0, 300);
        if (/\bgit commit\b/.test(cmd)) {
          const m = cmd.match(/-m\s+"([^"]{1,200})/) || cmd.match(/-m\s+'([^']{1,200})/)
            || cmd.match(/@'\s*\n([^\n]{1,200})/);
          commits.push(m ? m[1] : cmd.slice(0, 120));
        } else if (commands.length < 100) {
          commands.push({
            cmd,
            desc: item.input.description ? String(item.input.description).slice(0, 120) : null,
            isTest: TEST_CMD_RE.test(cmd),
          });
        }
      } else if (name === 'AskUserQuestion' && Array.isArray(item.input.questions)) {
        for (const q of item.input.questions) {
          if (q && q.question && questions.length < 20) questions.push(String(q.question).slice(0, 300));
        }
      }
    }
    const text = textParts.join('\n').trim();
    if (text) summary = text.slice(0, 4000); // letzte Assistant-Textnachricht gewinnt
  }

  const report = {
    slug,
    firstTs,
    lastTs,
    turns,
    truncated: stat.size > MAX_REPORT_READ,
    summary,
    files: [...files.entries()]
      .map(([p, edits]) => ({ path: p, edits }))
      .sort((a, b) => b.edits - a.edits)
      .slice(0, 100),
    tests: commands.filter((c) => c.isTest).slice(-15),
    commands: commands.slice(-40),
    commits: commits.slice(-20),
    questions,
  };
  reportCache.set(filePath, { mtime: stat.mtimeMs, report });
  return report;
}

// Transcript-Datei zum Arbeitsverzeichnis einer Flightdeck-Session finden
function normPath(p) { return (p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase(); }

function findSessionFile(cwds) {
  const wanted = cwds.filter(Boolean).map(normPath);
  if (!wanted.length) return null;

  const candidates = [];
  // Schneller Pfad: Claudes Verzeichnisname ist der codierte Pfad
  for (const cwd of cwds.filter(Boolean)) {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dirPath = path.join(PROJECTS_DIR, encoded);
    try {
      for (const f of fs.readdirSync(dirPath).filter((x) => x.endsWith('.jsonl'))) {
        const fp = path.join(dirPath, f);
        const stat = fs.statSync(fp);
        if (stat.size > 200) candidates.push({ file: fp, mtime: stat.mtimeMs });
      }
    } catch { /* Verzeichnis existiert nicht */ }
  }
  // Fallback: ueber die Kopf-Signale aller Sessions matchen
  if (!candidates.length) {
    for (const s of listClaudeSessions(300)) {
      if (wanted.includes(normPath(s.cwd))) {
        candidates.push({ file: path.join(PROJECTS_DIR, ''), mtime: s.mtime, id: s.id, cwd: s.cwd });
      }
    }
    // listClaudeSessions liefert keinen Dateipfad nach aussen - erneut aufloesen
    if (candidates.length) {
      const best = candidates.sort((a, b) => b.mtime - a.mtime)[0];
      for (const dir of fs.readdirSync(PROJECTS_DIR)) {
        const fp = path.join(PROJECTS_DIR, dir, best.id + '.jsonl');
        if (fs.existsSync(fp)) return fp;
      }
      return null;
    }
    return null;
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0].file;
}

function getAgentReport(cwd, gitRoot) {
  try {
    const file = findSessionFile([cwd, gitRoot]);
    if (!file) return { found: false };
    return { found: true, file, report: buildReport(file) };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

module.exports = { listClaudeSessions, getAgentReport };
