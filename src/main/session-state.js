'use strict';
// What a session is doing right now: busy/idle/attention from the OSC stream,
// which Claude transcript belongs to it, and the input history.
const fs = require('fs');
const path = require('path');
const {
  TRANSCRIPT_ID_RE,
  snapshotTranscripts, detectTranscript, newestTranscript, readAgentCwd,
  findTranscriptById,
} = require('./claude-sessions');
const { isAgentCommand } = require('./agents');
const { OSC_ANY_RE, OSC_EVENT_RE } = require('./osc');
const { send } = require('./window');
const log = require('./log');

// ---------------------------------------------------------------------------
// Busy/idle state
// ---------------------------------------------------------------------------
// "Quiet = waiting for input" holds for the agent CLIs (agentic TUIs: working =
// continuously rendering a spinner/timer/streaming output). Which command lines
// those are is the agent plugins' business - isAgentCommand() asks them.
const ATTENTION_QUIET_MS = 2000;

function setState(session, state) {
  if (session.state === state || session.exited) return;
  session.state = state;
  send('session:state', session.id, state);
}

// "Waiting for you" only applies once the agent has actually received a task.
// Right after `claude` it sits at the prompt by definition - sending that out
// as an attention notice would be a false alarm every single time.
function setAttention(session) {
  if (!session.agentPrompted) return false;
  if (session.state === 'idle') return false;
  setState(session, 'attention');
  return true;
}

// Evaluates OSC 133/7770 in the data stream; matches that lie entirely within
// the already processed tail are skipped (no double processing).
function applyStateFromData(session, text, tailLen, rawData) {
  let saw = false; let m;

  OSC_EVENT_RE.lastIndex = 0;
  while ((m = OSC_EVENT_RE.exec(text)) !== null) {
    if (m.index + m[0].length <= tailLen) continue;
    const g = m.groups;

    // Command line of the started command (reported by the shell integration)
    if (g.cmdB64 !== undefined) {
      let cmd = '';
      try { cmd = Buffer.from(g.cmdB64, 'base64').toString('utf8'); } catch (e) { log.debug('osc7770: command line not decodable', { session: session.id, err: e }); }
      session.currentCmd = cmd;
      session.cmdWatched = isAgentCommand(cmd);
      if (session.cmdWatched) {
        beginAgentBinding(session, cmd);
        // Freshly started: the agent shows its interface and waits for the first
        // prompt. That is not a "needs you" but the normal state - attention
        // notices only make sense from the first prompt onwards.
        session.agentPrompted = false;
      }
      addHistory(session, cmd, 'shell');

    // Report from the claude wrapper - the shell emits OSC 7770 before the
    // command runs and the wrapper its OSC 7771 afterwards, so stream order
    // already puts the binding after the beginAgentBinding() that resets it.
    } else if (g.sessKind !== undefined) {
      // Only a session UUID is accepted. The sequence arrives in the data
      // stream, so every program writing to the terminal can send one, and the
      // ID becomes part of a file path (findTranscriptById) and of the
      // directory the agent sensor reads.
      if (g.sessKind === 'session' && TRANSCRIPT_ID_RE.test(g.sessId)) bindAgentSession(session, g.sessId, true);
      else if (g.sessKind === 'continue') bindContinuedSession(session);

    } else if (g.mark !== undefined) {
      saw = true;
      if (g.mark === 'C') setState(session, 'busy');
      else if (g.mark === 'A' || g.mark === 'D') {
        setState(session, 'idle');
        session.currentCmd = null;
        session.cmdWatched = false;
        session.hasClaudeOsc = false;
        clearTimeout(session.attnTimer);
        // Back at the prompt: run a queued command if there is one (session browser)
        if (session.pendingCommand) {
          const cmd = session.pendingCommand;
          session.pendingCommand = null;
          try { session.proc.write(cmd + '\r'); } catch (e) { log.debug('session: queued command not sent, session gone', { session: session.id, cmd, err: e }); }
        }
      }

    // Native Claude signals (title: spinner = working, U+2733 = waiting for you)
    } else if (g.title !== undefined) {
      const first = g.title.charAt(0);
      if (!first) continue;
      const code = first.charCodeAt(0);
      if (code >= 0x2800 && code <= 0x28ff) {          // braille spinner
        session.hasClaudeOsc = true;
        clearTimeout(session.attnTimer);
        setState(session, 'busy');
      } else if (first === '✳') {                  // asterisk: input expected
        session.hasClaudeOsc = true;
        clearTimeout(session.attnTimer);
        setAttention(session);
      }

    // OSC 9: progress (9;4;...) or explicit notifications from Claude
    } else if (g.osc9 !== undefined) {
      const payload = g.osc9;
      if (payload.startsWith('9;')) continue;           // ConEmu cwd, see OSC99_RE
      if (payload.startsWith('4;')) {                   // progress indicator
        const level = payload.split(';')[1];
        if (level === '1' || level === '2' || level === '3') {
          session.hasClaudeOsc = true;
          setState(session, 'busy');
        }
        continue;
      }
      // Explicit notification ("Claude needs your attention", permission request, ...)
      if (setAttention(session)) send('session:notify', session.id, payload.slice(0, 200));
    }
  }

  if (saw) {
    session.hasOsc133 = true;
    clearTimeout(session.idleTimer);
  } else if (!session.hasOsc133 && session.integrated) {
    // Fallback while the integration has not reported yet: output = working,
    // 500 ms of silence = waiting for input. While a full-screen TUI is running
    // (alternate screen), the state stays put instead of flickering.
    //
    // Shells Flightdeck cannot instrument (cmd, WSL, nu, elvish, xonsh, ksh,
    // tcsh, dash) keep the state 'unknown': a command that runs quietly for a
    // while would be shown as "waiting for input" here, and a wrong state reads
    // like a fact. If such a shell emits OSC 133 from the user's own
    // configuration, the branch above takes over.
    //
    // cmd and WSL are included, although the heuristic was written for them:
    // there too it is wrong exactly while a command runs quietly, which is when
    // the display is the only thing you have to go by. Decided in #11, not open.
    setState(session, 'busy');
    clearTimeout(session.idleTimer);
    if (!session.altScreen) {
      session.idleTimer = setTimeout(() => setState(session, 'idle'), 500);
    }
  }

  // Silence heuristic for the watched TUIs - only as long as Claude delivers
  // no native signals (hasClaudeOsc), those are more precise.
  if (session.hasOsc133 && session.cmdWatched && !session.hasClaudeOsc && session.state !== 'idle') {
    const visible = rawData.replace(OSC_ANY_RE, '');
    if (visible.includes('\x07')) {
      // Terminal bell: Claude reports completion or a question
      setAttention(session);
      clearTimeout(session.attnTimer);
    } else {
      // The echo of your own typing (Claude renders the input line) does not count
      const isEcho = Date.now() - (session.lastInputAt || 0) < 300;
      if (visible.length && !isEcho) setState(session, 'busy');
      clearTimeout(session.attnTimer);
      session.attnTimer = setTimeout(() => {
        if (!session.exited && session.state === 'busy' && session.cmdWatched) {
          setAttention(session);
        }
      }, ATTENTION_QUIET_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Agent binding: which Claude transcript belongs to this session?
//
// Without this binding the app guesses via "newest file in the project
// directory" - with several chats running in the same repo the report shows the
// wrong one, and a worktree switch by the agent stays invisible.
// ---------------------------------------------------------------------------
const RESUME_RE = /(?:--resume|--session-id|(?:^|\s)-r)[= ]+([0-9a-f-]{36})/i;

function bindAgentSession(session, sessionId, exact) {
  session.claudeSessionId = sessionId;
  session.bindingExact = exact;
  session.transcriptSnapshot = null;
}

// `claude --continue` resumes the directory's most recently used session. We
// apply the same rule at the moment of the start - that is not a heuristic but
// the very selection Claude itself makes.
function bindContinuedSession(session) {
  const id = newestTranscript(session.cwd, session.claudeStartedAt);
  if (id) bindAgentSession(session, id, true);
}

function beginAgentBinding(session, cmd) {
  session.claudeSessionId = null;
  session.bindingExact = false;
  session.agentCwd = null;
  session.transcriptSnapshot = snapshotTranscripts(session.cwd);
  session.claudeStartedAt = Date.now() - 1000; // clock drift / mtime granularity
  session.bindingBase = session.cwd;

  // If the command line names the ID itself, there is nothing more to do. With
  // --fork-session a new ID is created instead - then the wrapper takes over.
  const m = RESUME_RE.exec(cmd);
  if (m && !/--fork-session/.test(cmd)) bindAgentSession(session, m[1], true);
}

async function updateAgentBinding(session) {
  if (!session.bindingBase) { session.transcript = null; return; }
  // If the shell leaves the directory in which `claude` was started, the
  // binding no longer fits.
  if (session.cwd !== session.bindingBase) {
    session.claudeSessionId = null;
    session.bindingExact = false;
    session.agentCwd = null;
    session.bindingBase = null;
    session.transcriptSnapshot = null;
    session.transcript = null;
    return;
  }
  // Last resort for cases without a wrapper report (`command claude`, npx, a
  // shell without integration): guess via timestamps. That can go wrong if
  // somebody is working in another window at the same time - which is why the
  // binding stays marked as uncertain and the report points that out.
  if (!session.claudeSessionId && session.transcriptSnapshot) {
    const id = detectTranscript(
      session.bindingBase, session.transcriptSnapshot, session.claudeStartedAt,
    );
    if (id) bindAgentSession(session, id, false);
  }
  if (!session.claudeSessionId) { session.transcript = null; return; }

  // Resolved once per pass and handed to the agent sensor below, which would
  // otherwise look up the same path three more times. ID and path are stored
  // together: PTY data arriving during the awaits below can bind a different
  // session, and a path from the previous one would then point into a foreign
  // transcript.
  const id = session.claudeSessionId;
  const file = findTranscriptById(id);
  session.transcript = { id, path: file };
  const agentCwd = file ? await readAgentCwd(id, file) : null;
  // Only adopt it if it lies below the shell's directory (i.e. a worktree or
  // similar) - anything else would be a foreign transcript.
  if (agentCwd && agentCwd !== session.cwd
      && agentCwd.startsWith(session.cwd.replace(/[\\/]+$/, '') + path.sep)
      && fs.existsSync(agentCwd)) {
    session.agentCwd = agentCwd;
  } else {
    session.agentCwd = null;
  }
}

// ---------------------------------------------------------------------------
// Input history: shell commands arrive verbatim via OSC 7770; prompts to the
// watched TUIs (Claude) are reconstructed from the keyboard stream.
// ---------------------------------------------------------------------------
const HISTORY_MAX = 200;

function addHistory(session, text, kind) {
  text = text.trim();
  if (text.length < 2) return;
  const entry = { ts: Date.now(), text: text.slice(0, 500), kind };
  session.history.push(entry);
  if (session.history.length > HISTORY_MAX) session.history.shift();
  send('session:histadd', session.id, entry);
}

function feedInputRecon(session, data) {
  // Strip bracketed-paste markers, keep the pasted content
  data = data.replace(/\x1b\[20[01]~/g, '');
  let buf = session.inputBuf;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r') {
      const text = buf; buf = '';
      // Shell commands arrive verbatim via OSC 7770 - only agent prompts here
      if (session.cmdWatched) {
        session.agentPrompted = true;
        addHistory(session, text, 'agent');
      }
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') { // Ctrl+C / Ctrl+U: discard the line
      buf = '';
    } else if (ch === '\x17') { // Ctrl+W: delete the last word
      buf = buf.replace(/\S+\s*$/, '');
    } else if (ch === '\x1b') {
      if (data[i + 1] === '[' || data[i + 1] === 'O') { // skip CSI/SS3
        let j = i + 2;
        while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j++;
        i = j;
      }
    } else if (ch === '\n') {
      buf += '\n'; // part of a multi-line paste
    } else if (ch >= ' ') {
      buf += ch;
    }
  }
  session.inputBuf = buf.length > 2000 ? buf.slice(-2000) : buf;
}

module.exports = {
  setState, setAttention, applyStateFromData,
  updateAgentBinding, addHistory, feedInputRecon,
};
