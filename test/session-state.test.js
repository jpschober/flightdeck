'use strict';
// Busy/idle/attention as it is read out of the OSC stream.
//
//   node --test test/session-state.test.js
//
// The state is what the session card shows: the dot, the activity meter, and
// whether the window reports that somebody is waiting for you. A state that
// stays standing after the thing it described is over reads like a fact and is
// wrong in the one direction nobody checks - "still working" looks the same as
// "working for a long time".
//
// The sequences below are the ones actually measured from Claude 2.1.226 under
// TERM_PROGRAM=iTerm.app: it announces the wait exactly once, as OSC 0 with a
// leading U+2733, and does not repeat it.

const test = require('node:test');
const assert = require('node:assert');

const { applyStateFromData, feedInputRecon } = require('../src/main/session-state');

const OSC_CMD_CLAUDE = `\x1b]7770;cmd;${Buffer.from('claude').toString('base64')}\x07`;
const OSC_RUN = '\x1b]133;C\x07';
const OSC_PROMPT = '\x1b]133;A\x07';
const OSC_WAITING = '\x1b]0;✳ Claude Code\x07';
const OSC_SPINNER = '\x1b]0;⠋ Working…\x07';
const OSC_NOTIFY = '\x1b]9;Claude needs your attention\x07';

/** A session as the PTY layer holds it, with a shell that reports OSC 133. */
function session(over = {}) {
  return {
    id: 's1',
    cwd: '/nonexistent-for-the-binding',
    state: 'idle',
    exited: false,
    integrated: true,
    history: [],
    inputBuf: '',
    ...over,
  };
}

/** Applies the OSC stream the way the PTY path does, with nothing pre-read. */
function feed(s, data) {
  applyStateFromData(s, data, 0, data);
  return s;
}

/** Timers outlive the test otherwise and hold the runner open. */
function stop(s) {
  clearTimeout(s.attnTimer);
  clearTimeout(s.idleTimer);
}

test('a session waiting for its first prompt is not busy', (t) => {
  const s = session();
  t.after(() => stop(s));

  feed(s, OSC_CMD_CLAUDE + OSC_RUN);
  assert.strictEqual(s.state, 'busy', 'the start of `claude` is a running command');
  assert.strictEqual(s.agentPrompted, false);

  // Claude has drawn its interface and sits at the prompt. No attention notice -
  // nobody asked it anything yet - but it is not working either.
  feed(s, OSC_WAITING);
  assert.strictEqual(s.state, 'idle');
});

test('the wait is announced once, so a dropped one is gone for good', (t) => {
  const s = session();
  t.after(() => stop(s));

  feed(s, OSC_CMD_CLAUDE + OSC_RUN + OSC_WAITING);
  assert.strictEqual(s.state, 'idle');

  // hasClaudeOsc is set from here on, which switches the silence heuristic off:
  // nothing else would have corrected the state afterwards.
  assert.strictEqual(s.hasClaudeOsc, true);
});

test('once a prompt has been sent, waiting means attention', (t) => {
  const s = session();
  t.after(() => stop(s));

  feed(s, OSC_CMD_CLAUDE + OSC_RUN + OSC_WAITING);
  feedInputRecon(s, 'fix the tests\r');
  assert.strictEqual(s.agentPrompted, true);

  feed(s, OSC_SPINNER);
  assert.strictEqual(s.state, 'busy');

  feed(s, OSC_WAITING);
  assert.strictEqual(s.state, 'attention');
});

test('a notification before the first prompt lands as a quiet state', (t) => {
  const s = session();
  t.after(() => stop(s));

  feed(s, OSC_CMD_CLAUDE + OSC_RUN);
  feed(s, OSC_NOTIFY);
  assert.strictEqual(s.state, 'idle');
});

test('back at the shell prompt the agent state is cleared', (t) => {
  const s = session();
  t.after(() => stop(s));

  feed(s, OSC_CMD_CLAUDE + OSC_RUN + OSC_WAITING);
  feedInputRecon(s, 'a prompt\r');
  feed(s, OSC_SPINNER);
  assert.strictEqual(s.state, 'busy');

  feed(s, OSC_PROMPT);
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.cmdWatched, false);
  assert.strictEqual(s.hasClaudeOsc, false);
});

test('a session that has exited keeps its state', (t) => {
  const s = session({ state: 'busy', exited: true });
  t.after(() => stop(s));

  feed(s, OSC_CMD_CLAUDE + OSC_RUN + OSC_WAITING);
  assert.strictEqual(s.state, 'busy');
});
