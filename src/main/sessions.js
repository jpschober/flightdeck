'use strict';
// Sessions: a PTY each, the batched way its output reaches the renderer, and
// the periodic pass that collects git, PR and agent context for it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');
const { TRANSCRIPT_ID_RE } = require('./claude-sessions');
const { availableShells, shellName, spawnArgsFor } = require('./shells');
const { extractCwd } = require('./osc');
const { applyStateFromData, updateAgentBinding } = require('./session-state');
const { getGitInfo, getPrInfo } = require('./gitinfo');
const { getAgentView } = require('./agents');
const { alive, getWindow, send } = require('./window');
const log = require('./log');

const sessions = new Map(); // id -> session
let nextId = 1;

// Environment for the shells: remove inherited variables that switch colours
// off or come from a surrounding tool (Claude Code, Warp) and have no business
// being in a fresh interactive session.
function buildPtyEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_CODE_|CLAUDE_|WARP_)/.test(key)) delete env[key];
  }
  delete env.NO_COLOR;
  delete env.CLAUDECODE;
  delete env.GIT_TERMINAL_PROMPT;
  // Claude Code checks TERM_PROGRAM and only sends the OSC 0 titles (spinner =
  // working, asterisk = waiting) and OSC 9 notifications ("needs your
  // attention") for iTerm. So we pose as iTerm; FLIGHTDECK stays as a marker.
  env.TERM_PROGRAM = 'iTerm.app';
  env.TERM_PROGRAM_VERSION = '3.6.6';
  env.FLIGHTDECK = '1';
  env.COLORTERM = 'truecolor'; // xterm.js can do truecolor
  return env;
}

// The renderer asks for a Claude transcript to be resumed, not for a command line
// of its own choosing: the ID is checked against the UUID form and the command is
// assembled here, so nothing reaches the PTY that was not built in this process.
// The session browser only offers IDs of that form, so a rejected one means the
// request did not come from it.
function resumeCommand(resume) {
  if (!resume || !TRANSCRIPT_ID_RE.test(String(resume.id || ''))) return null;
  return `claude --resume ${resume.id}${resume.fork ? ' --fork-session' : ''}`;
}

// Output batching and flow control
// --------------------------------
// node-pty hands over thousands of chunks per second for `cat` on a large file
// or an install log. One IPC send per chunk means one structured clone and one
// xterm write per chunk; the chunks are collected here and go out together
// after FLUSH_MS or once FLUSH_CHARS have accumulated.
//
// The renderer acknowledges every batch once xterm has processed it. Above
// FLOW_HIGH_WATER_CHARS unacknowledged characters the PTY is paused, below
// FLOW_LOW_WATER_CHARS it is resumed - without this, a producer faster than the
// renderer grows xterm's internal buffer up to its 50 MB limit.
//
// All four limits count UTF-16 code units (String.length), not bytes: node-pty
// hands over decoded strings and that is what crosses the IPC boundary.
const FLUSH_MS = 16;
const FLUSH_CHARS = 65536;
const FLOW_HIGH_WATER_CHARS = 262144;
const FLOW_LOW_WATER_CHARS = 65536;
const GRID_BUFFER_CHARS = 262144;
const GRID_PREVIEW_CHARS = 20480;

function queueOutput(session, data) {
  session.pending.push(data);
  session.pendingSize += data.length;
  if (session.pendingSize >= FLUSH_CHARS) { flushOutput(session); return; }
  if (!session.flushTimer) {
    session.flushTimer = setTimeout(() => flushOutput(session), FLUSH_MS);
  }
}

function flushOutput(session) {
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }
  if (!session.pending.length) return;
  const data = session.pending.length === 1 ? session.pending[0] : session.pending.join('');
  session.pending.length = 0;
  session.pendingSize = 0;

  if (alive()) {
    send('session:data', session.id, data);
    session.unacked += data.length;
    if (!session.flowPaused && session.unacked > FLOW_HIGH_WATER_CHARS) {
      session.flowPaused = true;
      try { session.proc.pause(); } catch (e) { log.debug('flow: PTY not paused, session gone', { session: session.id, err: e }); }
    }
  }

  // Scrollback buffer for the grid preview
  session.outputBuffer.push(data);
  session.outputBufferSize += data.length;
  while (session.outputBufferSize > GRID_BUFFER_CHARS && session.outputBuffer.length > 1) {
    session.outputBufferSize -= session.outputBuffer.shift().length;
  }

  // Alternate screen mode (full-screen TUIs such as vim, htop, Claude dialogs).
  // A batch regularly holds both switches - less quitting into a pager, one
  // Claude dialog closing as the next opens - so the last one in the stream
  // decides, not the order the two checks happen to stand in.
  if (data.includes('\x1b[?')) {
    const enter = Math.max(data.lastIndexOf('\x1b[?1049h'), data.lastIndexOf('\x1b[?47h'));
    const leave = Math.max(data.lastIndexOf('\x1b[?1049l'), data.lastIndexOf('\x1b[?47l'));
    if (enter !== leave) session.altScreen = enter > leave;
  }

  const tailLen = session.oscTail.length;
  const text = session.oscTail + data;
  const found = extractCwd(text);
  applyStateFromData(session, text, tailLen, data);
  session.oscTail = text.slice(-512);
  if (found && found !== session.cwd) adoptCwd(session, found);
}

// The reported directory becomes the base for git, the file list and the
// preview - and git runs there unprompted every few seconds. Anything writing
// to the terminal can name a directory, so what is named has to exist before it
// is taken over.
//
// The question is put asynchronously. flushOutput is the PTY data path: a stat
// on a hung network mount stands for seconds, and every session's output stands
// with it. Until the answer is in, the session keeps the directory it had.
function adoptCwd(session, dir) {
  if (session.cwdCandidate === dir) return; // the same report is already on its way
  session.cwdCandidate = dir;
  fs.promises.stat(dir).then((st) => {
    // A newer report, a session that has since ended, or a directory that has
    // meanwhile become the current one: in each case this answer is stale.
    if (session.cwdCandidate !== dir || session.exited || session.cwd === dir) return;
    if (!st.isDirectory()) { log.debug('osc7: reported path is not a directory', { session: session.id, path: dir }); return; }
    session.cwd = dir;
    refreshSession(session, true);
  }, (e) => {
    log.debug('osc7: reported directory not usable', { session: session.id, path: dir, err: e });
  }).finally(() => {
    if (session.cwdCandidate === dir) session.cwdCandidate = null;
  });
}

// The renderer reports how many characters xterm has processed. Once the
// backlog is small enough the PTY reads on.
function ackOutput(session, chars) {
  session.unacked = Math.max(0, session.unacked - chars);
  if (session.flowPaused && session.unacked <= FLOW_LOW_WATER_CHARS) {
    session.flowPaused = false;
    // `flowPaused` is already false, so no later ack takes this path again: if
    // the PTY stays paused here, the session delivers nothing for the rest of
    // its life. Worth a line even though the usual cause is a session that ended.
    try { session.proc.resume(); } catch (e) { log.warn('flow: PTY not resumed, the session stays without output', { session: session.id, err: e }); }
  }
}

// A reload of the renderer (Ctrl+R) drops the batches in flight, which are then
// never acknowledged. The lost characters would stay in `unacked` as a
// permanent offset and, once past the low-water mark, leave the session paused
// with no ack able to release it. The backlog belongs to a document that no
// longer exists, so it is dropped with it.
function resetFlowControl() {
  for (const s of sessions.values()) {
    s.unacked = 0;
    if (s.flowPaused) {
      s.flowPaused = false;
      try { s.proc.resume(); } catch (e) { log.warn('flow: PTY not resumed after a renderer reload', { session: s.id, err: e }); }
    }
  }
}

// The grid thumbnail keeps 50 lines of scrollback - the last 20 KB fill them,
// the remaining 236 KB of the ring buffer would only be parsed and thrown away.
//
// Whole chunks only: cutting to exactly 20 KB would leave a lone surrogate half
// or the middle of an escape sequence at the head, and xterm would then print
// the tail of a window title as text or swallow output up to the next
// terminator. The loop stops after the first chunk that reaches the limit, so
// the result is 20 KB plus at most one chunk.
function gridPreview(session) {
  const parts = [];
  let size = 0;
  for (let i = session.outputBuffer.length - 1; i >= 0 && size < GRID_PREVIEW_CHARS; i--) {
    parts.push(session.outputBuffer[i]);
    size += session.outputBuffer[i].length;
  }
  return parts.reverse().join('');
}

function createSession(shellId, opts = {}) {
  const shell = availableShells.find((s) => s.id === shellId) || availableShells[0];
  const { file, args, env, integrated } = spawnArgsFor(shell);
  const cwd = (opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : os.homedir();

  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: buildPtyEnv(env),
  });

  const id = String(nextId++);
  const session = {
    id,
    shellId: shell.id,
    shellName: shellName(shell),
    proc,
    cwd,
    title: null,   // manually set title
    label: null,   // manually set label
    oscTail: '',
    cwdCandidate: null,      // a reported directory whose stat is still running
    lastInfoJson: '',
    branch: null,
    gitRoot: null,
    gitBlocked: null,        // the config key that keeps git out of this directory
    files: [],
    fileMemory: new Map(),   // path -> entry; survives commits
    pr: null,
    claudeSessionId: null,   // transcript of the running Claude session
    transcript: null,        // { id, path }, resolved once per refresh
    bindingExact: false,     // ID reported by the wrapper instead of guessed via timestamps
    agentCwd: null,          // the agent's working directory (a worktree, if any)
    agents: null,            // running subagents (from the agent sensor)
    bindingBase: null,
    transcriptSnapshot: null,
    claudeStartedAt: 0,
    exited: false,
    refreshing: false,
    refreshQueued: false,
    state: integrated ? 'idle' : 'unknown',
    integrated,
    hasOsc133: false,
    hasClaudeOsc: false,
    idleTimer: null,
    attnTimer: null,
    currentCmd: null,
    cmdWatched: false,
    history: [],
    inputBuf: '',
    inputEsc: '',
    lastInputAt: 0,
    altScreen: false,
    outputBuffer: [],
    outputBufferSize: 0,
    pending: [],          // PTY chunks not yet sent to the renderer
    pendingSize: 0,
    flushTimer: null,
    unacked: 0,           // characters sent but not yet processed by xterm
    flowPaused: false,
    pendingCommand: resumeCommand(opts.resume),
  };
  sessions.set(id, session);

  proc.onData((data) => queueOutput(session, data));

  proc.onExit(() => {
    clearTimeout(session.idleTimer);
    clearTimeout(session.attnTimer);
    flushOutput(session);
    session.exited = true;
    send('session:exit', id);
  });

  // Fallback for shells without prompt detection: send the start command after 4 s
  if (session.pendingCommand) {
    setTimeout(() => {
      if (session.pendingCommand && !session.exited) {
        const cmd = session.pendingCommand;
        session.pendingCommand = null;
        try { proc.write(cmd + '\r'); } catch (e) { log.debug('session: start command not sent, session gone', { session: id, cmd, err: e }); }
      }
    }, 4000);
  }

  refreshSession(session, true);
  return { id, shellId: shell.id, shellName: shellName(shell), cwd, state: session.state };
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  // A refresh may be in flight; without this it would run to the end and send
  // session:info for a session that no longer exists.
  s.exited = true;
  clearTimeout(s.flushTimer);
  s.flushTimer = null;
  try { s.proc.kill(); } catch (e) { log.debug('session: kill failed, already terminated', { session: id, err: e }); }
  sessions.delete(id);
}

function killAll() {
  for (const s of sessions.values()) {
    try { s.proc.kill(); } catch (e) { log.debug('shutdown: kill failed', { session: s.id, err: e }); }
  }
}

async function refreshSession(session, force = false) {
  if (session.exited) return;
  // Avoid overlapping refreshes; on a cwd change a new one is triggered right away
  if (session.refreshing) { session.refreshQueued = session.refreshQueued || force; return; }
  session.refreshing = true;
  const cwdAtStart = session.cwd;
  try {
    await doRefresh(session, force, cwdAtStart);
  } finally {
    session.refreshing = false;
  }
  if (session.refreshQueued || session.cwd !== cwdAtStart) {
    session.refreshQueued = false;
    refreshSession(session, true);
  }
}

// While working, commits happen in between - then the files disappear from
// `git status` and the list jumps to empty. Whatever was once in there
// therefore stays and is marked as committed, until the directory changes or a
// PR takes over the list.
function mergeFileMemory(session, current) {
  if (!session.fileMemory) session.fileMemory = new Map();
  const memory = session.fileMemory;
  const seen = new Set();

  for (const f of current) {
    seen.add(f.path);
    memory.set(f.path, { ...f, committed: false });
  }
  for (const [p, entry] of memory) {
    if (!seen.has(p)) memory.set(p, { ...entry, committed: true });
  }
  // Order: open changes first, committed ones below
  return [...memory.values()].sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

function resetFileMemory(session) {
  session.fileMemory = new Map();
}

async function doRefresh(session, force, cwdAtStart) {
  await updateAgentBinding(session);
  if (session.cwd !== cwdAtStart || session.exited) return; // stale -> discard
  // If the agent works in a worktree, that worktree's branch counts - not the
  // one of the shell that stayed behind in the repo.
  const gitCwd = session.agentCwd || cwdAtStart;
  const git = await getGitInfo(gitCwd);
  if (session.cwd !== cwdAtStart || session.exited) return; // stale -> discard
  // A transient git failure ({ transient: true } - a timeout, a lock held while
  // the agent commits) leaves branch, root, files and the PR standing. The null
  // of a failed call would otherwise blank the panel and the tab's branch and,
  // because the notes key hangs off gitRoot, flip that key to the bare cwd and
  // empty the notes until the next pass. Genuine "no repository" (git === null)
  // and a refused directory (git.blocked) still fall through and clear it.
  if (!(git && git.transient)) {
    // If the repo or branch changes, the memory starts over - otherwise one would
    // drag along files from a foreign branch.
    if (git && (session.gitRoot !== git.root || session.branch !== git.branch)) {
      resetFileMemory(session);
    }
    session.branch = git ? git.branch : null;
    session.gitRoot = git ? git.root : null;
    // Git was refused in this directory (see gitinfo.js). The panel says so, and
    // nothing further is asked of git here.
    session.gitBlocked = git ? git.blocked || null : null;
    if (!git) resetFileMemory(session);
    // git.files is null when the status call failed though the repo is there:
    // keep the last list, since [] through mergeFileMemory would mark every
    // remembered file committed and jump the list about.
    if (git && git.files != null) session.files = mergeFileMemory(session, git.files);
    else if (!git) session.files = [];
    const pr = git && !git.blocked ? await getPrInfo(gitCwd, git.root, git.branch, force) : null;
    if (session.cwd !== cwdAtStart || session.exited) return; // cd in the meantime -> discard
    session.pr = pr;
  }

  // Who is working here right now? The sensor puts that question to the
  // plugins - which agent CLI runs in the terminal is none of the refresh's
  // business.
  const ctx = {
    cwd: cwdAtStart,
    agentCwd: session.agentCwd,
    command: session.currentCmd,
    claudeSessionId: session.claudeSessionId,
  };
  // The binding can have moved on while the git and PR lookups above were
  // running. The resolved path only travels with the ID it was resolved for;
  // otherwise the key stays out and the plugin resolves it itself.
  if (session.transcript && session.transcript.id === session.claudeSessionId) {
    ctx.claudeTranscript = session.transcript.path;
  }
  session.agents = await getAgentView(ctx);
  if (session.cwd !== cwdAtStart || session.exited) return;

  const shell = availableShells.find((s) => s.id === session.shellId);
  const info = {
    id: session.id,
    shellName: shell ? shellName(shell) : session.shellName,
    cwd: session.cwd,
    title: session.title,
    label: session.label,
    branch: session.branch,
    gitRoot: session.gitRoot,
    gitBlocked: session.gitBlocked,
    agentCwd: session.agentCwd,
    worktree: session.agentCwd ? path.basename(session.agentCwd) : null,
    agents: session.agents,
    files: session.files,
    pr: session.pr,
    exited: session.exited,
    state: session.state,
  };
  const json = JSON.stringify(info);
  if (json !== session.lastInfoJson || force) {
    session.lastInfoJson = json;
    send('session:info', info);
  }
}

// periodic refresh (branch switches, new changes, PR status). Nobody reads the
// result while the window is hidden or minimised, so the pass then runs every
// 30 s instead of every 4 s; showing the window refreshes right away.
const REFRESH_MS = 4000;
const REFRESH_HIDDEN_MS = 30000;
let lastRefreshAt = 0;

function refreshAll(force = false) {
  // Restoring a minimised window emits `restore` and `show`, and app:focus
  // calls restore() and show() itself - one pass covers all of that.
  const now = Date.now();
  if (now - lastRefreshAt < 500) return;
  lastRefreshAt = now;
  for (const s of sessions.values()) refreshSession(s, force);
}

setInterval(() => {
  // A minimised window still counts as visible on some platforms, so it is
  // asked separately.
  const win = getWindow();
  const visible = alive() && win.isVisible() && !win.isMinimized();
  if (Date.now() - lastRefreshAt < (visible ? REFRESH_MS : REFRESH_HIDDEN_MS)) return;
  refreshAll();
}, REFRESH_MS);

module.exports = {
  sessions, createSession, closeSession, killAll,
  refreshSession, refreshAll, resetFlowControl,
  queueOutput, flushOutput, ackOutput, gridPreview,
};
