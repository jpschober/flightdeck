'use strict';
// Reads Claude Code sessions from ~/.claude/projects (JSONL files) so they can
// be shown in the session browser and continued via `claude --resume`.
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./log');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // filePath -> { mtime, data }

// Claude derives the directory name from the cwd: everything except [A-Za-z0-9]
// becomes '-'. A worktree below the repo therefore ends up in its own
// directory whose name starts with the repo's.
function encodeProjectDir(p) { return (p || '').replace(/[^a-zA-Z0-9]/g, '-'); }

// Claude names a transcript after its session UUID. Any other .jsonl in the
// project directory - a backup, a copy - cannot be resumed, so it is kept out of
// the browser instead of offering a Resume button that leads nowhere. The main
// process checks the same form before it builds the command line.
const TRANSCRIPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read the head of the file: cwd, slug and the first user message as a preview.
// file-history-snapshot lines can be huge and are skipped.
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
      // last line may be cut off
      try { entry = JSON.parse(line); } catch (e) { log.debug('sessions: transcript line not parsable', { file: filePath, err: e }); continue; }
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
        if (text && !text.startsWith('<')) preview = text; // skip meta turns
      }
      if (cwd && preview && slug) break;
    }
    return { cwd, slug, preview: preview ? preview.replace(/\s+/g, ' ').trim().slice(0, 160) : null };
  } catch (e) {
    log.warn('sessions: head of the transcript not readable', { file: filePath, err: e });
    return { cwd: null, slug: null, preview: null };
  }
}

// Read the end of the file: the last slug wins (renamed via /rename)
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
  } catch (e) {
    log.debug('sessions: tail of the transcript not readable', { file: filePath, err: e });
    return null;
  }
}

function listClaudeSessions(limit = 200) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch (e) { log.debug('sessions: no project directory', { dir: PROJECTS_DIR, err: e }); return []; }

  const found = [];
  for (const dir of dirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let files;
    // The name check runs here, not on the result: a file that cannot be resumed
    // costs neither a stat, a head read, nor one of the `limit` slots below.
    try {
      files = fs.readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl') && TRANSCRIPT_ID_RE.test(path.basename(f, '.jsonl')));
    } catch (e) { log.debug('sessions: project directory not readable', { dir: dirPath, err: e }); continue; }
    for (const f of files) {
      const filePath = path.join(dirPath, f);
      let stat;
      try { stat = fs.statSync(filePath); } catch (e) { log.debug('sessions: transcript not stattable', { file: filePath, err: e }); continue; }
      if (stat.size < 200) continue; // empty/aborted sessions
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
  // Only sessions with a known project path can be resumed
  return top
    .filter((s) => s.cwd)
    .map(({ id, cwd, slug, preview, mtime }) => ({ id, cwd, slug, preview, mtime }));
}

// ---------------------------------------------------------------------------
// Transcript binding: which Claude session is running in this terminal?
//
// The transcript is the only source that reveals where the agent is really
// working - if it moves into a worktree, the shell's cwd stays where it was.
// The binding goes through the session ID (UUID), not the file path: when
// moving into a worktree the file wanders into a different project directory.
// ---------------------------------------------------------------------------

// Project directories for a cwd: its own plus all worktrees below it
function projectDirsFor(cwd) {
  const prefix = encodeProjectDir(cwd);
  if (!prefix) return [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch (e) { log.debug('sessions: no project directory', { dir: PROJECTS_DIR, cwd, err: e }); return []; }
  return dirs
    .filter((d) => d === prefix || d.startsWith(prefix + '-'))
    .map((d) => path.join(PROJECTS_DIR, d));
}

function eachTranscript(cwd, fn) {
  for (const dir of projectDirsFor(cwd)) {
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { log.debug('sessions: project directory not readable', { dir, err: e }); continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, f)); } catch (e) { log.debug('sessions: transcript not stattable', { file: path.join(dir, f), err: e }); continue; }
      fn(path.basename(f, '.jsonl'), stat, path.join(dir, f));
    }
  }
}

// Capture the state before `claude` starts
function snapshotTranscripts(cwd) {
  const seen = new Map(); // sessionId -> mtimeMs
  eachTranscript(cwd, (id, stat) => seen.set(id, stat.mtimeMs));
  return seen;
}

// After the start: the transcript that has appeared since, or was written to
// first. A newly created file is a reliable signal and therefore beats any
// already existing one.
function detectTranscript(cwd, snapshot, startedAt) {
  let best = null;
  eachTranscript(cwd, (id, stat) => {
    if (stat.size < 200 || stat.mtimeMs < startedAt) return;
    const before = snapshot.get(id);
    if (before !== undefined && stat.mtimeMs <= before) return; // unchanged
    const fresh = before === undefined;
    if (!best || (fresh && !best.fresh)
        || (fresh === best.fresh && stat.mtimeMs < best.mtime)) {
      best = { id, fresh, mtime: stat.mtimeMs };
    }
  });
  return best ? best.id : null;
}

// The most recently used session of a directory - that is the selection rule
// of `claude --continue`. `before` masks out writes that only happened after
// the start (such as the new session itself).
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
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch (e) { log.debug('sessions: no project directory', { dir: PROJECTS_DIR, session: sessionId, err: e }); return null; }
  for (const d of dirs) {
    const fp = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
    // Probing: a miss is the normal case, it only says the session is elsewhere.
    try { if (fs.statSync(fp).size > 0) return fp; } catch { /* not here */ }
  }
  log.debug('sessions: no transcript for this session', { session: sessionId, dirs: dirs.length });
  return null;
}

// The last cwd noted in the transcript = the agent's current working directory
// (on a worktree switch it moves halfway through the file).
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
    try { return JSON.parse('"' + last + '"'); } catch (e) { log.debug('sessions: cwd not unescapable, taken as is', { session: sessionId, value: last, err: e }); return last; }
  } catch (e) {
    log.warn('sessions: agent cwd not readable', { session: sessionId, file, err: e });
    return null;
  }
}

module.exports = {
  TRANSCRIPT_ID_RE,
  listClaudeSessions,
  snapshotTranscripts,
  detectTranscript,
  newestTranscript,
  findTranscriptById,
  readAgentCwd,
};
