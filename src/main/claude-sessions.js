'use strict';
// Reads Claude Code sessions from ~/.claude/projects (JSONL files) so they can
// be shown in the session browser and continued via `claude --resume`.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // filePath -> { mtime, data }

// ---------------------------------------------------------------------------
// Central listing of ~/.claude/projects
//
// Every lookup below starts from the same directory list, and the refresh runs
// several of them per session every few seconds. The listing is therefore read
// once and shared. Three things end its life: a change reported by fs.watch, an
// age limit, and a caller that asks for a fresh read.
//
// The age limit holds while a watcher is installed as well. fs.watch can
// succeed and still never deliver: on a network file system the watch sits on
// the local mount point, and after the directory is deleted and recreated the
// watch follows the dead inode. Neither case emits an error, so a listing that
// only fs.watch could invalidate would stay pinned for the rest of the run -
// and a project directory created after startup would never show up.
// ---------------------------------------------------------------------------
let projectDirsCache = null;
let projectDirsAt = 0;
let projectDirsWatcher = null;
let watchFailedAt = 0;
const PROJECT_DIRS_TTL_WATCHED = 60000;
const PROJECT_DIRS_TTL = 5000;
const WATCH_RETRY_MS = 60000;

function watchProjectsDir() {
  if (projectDirsWatcher) return;
  // PROJECTS_DIR need not exist - fs.watch then throws, and trying again on
  // every lookup would cost more than the listing it is meant to spare.
  if (watchFailedAt && Date.now() - watchFailedAt < WATCH_RETRY_MS) return;
  let watcher;
  try {
    watcher = fs.watch(PROJECTS_DIR, () => { projectDirsCache = null; });
  } catch {
    watchFailedAt = Date.now(); // the age limit carries the invalidation alone
    return;
  }
  watcher.on('error', () => {
    try { watcher.close(); } catch { /* already gone */ }
    // A successor may have been installed in the meantime; this one is then
    // history and must not take it down with it.
    if (projectDirsWatcher === watcher) {
      projectDirsWatcher = null;
      projectDirsCache = null;
      watchFailedAt = Date.now();
    }
  });
  if (watcher.unref) watcher.unref();
  projectDirsWatcher = watcher;
}

function projectDirs(opts = {}) {
  const ttl = projectDirsWatcher ? PROJECT_DIRS_TTL_WATCHED : PROJECT_DIRS_TTL;
  if (!opts.fresh && projectDirsCache && Date.now() - projectDirsAt < ttl) {
    return projectDirsCache;
  }
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { dirs = []; }
  // Handed out to every caller, so it is handed out unchangeable.
  projectDirsCache = Object.freeze(dirs);
  projectDirsAt = Date.now();
  watchProjectsDir();
  return projectDirsCache;
}

// On shutdown; a watch handle otherwise stays open for the rest of the process.
function stopWatchingProjects() {
  if (!projectDirsWatcher) return;
  try { projectDirsWatcher.close(); } catch { /* already gone */ }
  projectDirsWatcher = null;
}

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
      try { entry = JSON.parse(line); } catch { continue; } // last line may be cut off
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
  } catch {
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
  } catch {
    return null;
  }
}

function listClaudeSessions(limit = 200) {
  // The session browser is opened by hand and shows what is there right now, so
  // it reads the listing rather than taking one that is up to a minute old.
  const dirs = projectDirs({ fresh: true });

  const found = [];
  for (const dir of dirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let files;
    // The name check runs here, not on the result: a file that cannot be resumed
    // costs neither a stat, a head read, nor one of the `limit` slots below.
    try {
      files = fs.readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl') && TRANSCRIPT_ID_RE.test(path.basename(f, '.jsonl')));
    } catch { continue; }
    for (const f of files) {
      const filePath = path.join(dirPath, f);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
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
  return projectDirs()
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

// A session keeps its transcript for as long as it runs, so the path is
// remembered per session ID and only checked with one statSync per call. The
// scan over all project directories runs on a miss - the first lookup, or after
// the file has moved into a worktree's directory or been deleted.
const transcriptPaths = new Map(); // sessionId -> filePath
const TRANSCRIPT_PATHS_MAX = 200;

function rememberTranscript(sessionId, filePath) {
  transcriptPaths.delete(sessionId);
  transcriptPaths.set(sessionId, filePath);
  while (transcriptPaths.size > TRANSCRIPT_PATHS_MAX) {
    transcriptPaths.delete(transcriptPaths.keys().next().value);
  }
  return filePath;
}

function scanForTranscript(sessionId, dirs) {
  for (const d of dirs) {
    const fp = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
    try {
      if (fs.statSync(fp).size > 0) return fp;
    } catch { /* not here */ }
  }
  return null;
}

// A miss can also mean the listing is stale - the transcript moved into a
// project directory created since, and the watch event has not arrived yet. So
// a miss reads the listing again before giving up, but at most this often: a
// session can sit in a permanent miss (`claude --session-id <fresh-uuid>` binds
// an ID before Claude has written the file, a deleted transcript keeps its
// binding until the shell leaves the directory), and that must not turn every
// lookup into two full scans.
const MISS_RESCAN_MS = 4000;
let lastMissRescanAt = 0;

function findTranscriptById(sessionId) {
  if (!sessionId) return null;
  const known = transcriptPaths.get(sessionId);
  if (known) {
    try { if (fs.statSync(known).size > 0) return known; } catch { /* gone */ }
    transcriptPaths.delete(sessionId);
  }
  const listedAt = projectDirsAt;
  const hit = scanForTranscript(sessionId, projectDirs());
  if (hit) return rememberTranscript(sessionId, hit);

  const now = Date.now();
  if (projectDirsAt === listedAt && now - lastMissRescanAt >= MISS_RESCAN_MS) {
    lastMissRescanAt = now;
    const rescanned = scanForTranscript(sessionId, projectDirs({ fresh: true }));
    if (rescanned) return rememberTranscript(sessionId, rescanned);
  }
  return null;
}

// The last cwd noted in the transcript = the agent's current working directory
// (on a worktree switch it moves halfway through the file).
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

// `file` is the already resolved transcript of this session; the refresh
// resolves it once and passes it in, so this does not look it up again.
async function readAgentCwd(sessionId, file) {
  const transcript = file || findTranscriptById(sessionId);
  if (!transcript) return null;
  let handle = null;
  try {
    handle = await fsp.open(transcript, 'r');
    const size = (await handle.stat()).size;
    const readSize = Math.min(size, 131072);
    if (readSize <= 0) return null;
    const buf = Buffer.alloc(readSize);
    // Only what was actually read is decoded: a file truncated between stat and
    // read leaves the rest of the buffer at zero bytes.
    const { bytesRead } = await handle.read(buf, 0, readSize, size - readSize);
    if (!bytesRead) return null;
    const text = buf.toString('utf8', 0, bytesRead);
    let last = null; let m;
    CWD_RE.lastIndex = 0;
    while ((m = CWD_RE.exec(text)) !== null) last = m[1];
    if (!last) return null;
    try { return JSON.parse('"' + last + '"'); } catch { return last; }
  } catch {
    return null;
  } finally {
    if (handle) { try { await handle.close(); } catch { /* already closed */ } }
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
  stopWatchingProjects,
};
