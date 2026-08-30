'use strict';
// The stop signal for a Claude subagent is a <task-notification> in the
// caller's transcript. It reaches the transcript in several shapes, and which
// one a given notification lands in depends only on whether the caller was busy
// at the moment the agent finished. Reading just one shape loses the stop for
// every agent that happens to finish mid-turn - the agent then lingers as
// "running" until the 15-minute silence timeout, which is exactly the flaky
// detection this test guards against.
//
//   node --test test/agent-claude-stop.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claude = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'plugins', 'claude'));

const AGENT_ID = 'a1234567890abcdef';

function notifText(status) {
  return `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<status>${status}</status>\n</task-notification>`;
}

// Each carrier as it really appears in a transcript. `ts` is set after the
// meta.json is written so the stop timestamp lies at or after the start.
const CARRIERS = {
  'message text (idle caller)': (ts) => ({
    type: 'user', timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text: notifText('completed') }] },
  }),
  'queue-operation (busy caller)': (ts) => ({
    type: 'queue-operation', operation: 'add', timestamp: ts, sessionId: 'x',
    content: notifText('completed'),
  }),
  'queued_command attachment': (ts) => ({
    type: 'attachment', timestamp: ts,
    attachment: { type: 'queued_command', prompt: notifText('completed') },
  }),
};

// Builds a throwaway session on disk: a transcript file plus the subagent's
// meta.json and (empty) transcript, laid out exactly where the plugin looks.
function makeSession(notifEntry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-claude-stop-'));
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const transcript = path.join(root, sessionId + '.jsonl');
  const subagents = path.join(root, sessionId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, `agent-${AGENT_ID}.meta.json`), JSON.stringify({
    description: 'probe', agentType: 'general-purpose', spawnDepth: 1,
  }));
  fs.writeFileSync(path.join(subagents, `agent-${AGENT_ID}.jsonl`), '');

  // The stop must be timestamped at or after the meta.json's mtime (the start).
  const startedAt = fs.statSync(path.join(subagents, `agent-${AGENT_ID}.meta.json`)).mtimeMs;
  const lines = [];
  if (notifEntry) lines.push(JSON.stringify(notifEntry(new Date(startedAt + 1000).toISOString())));
  fs.writeFileSync(transcript, lines.map((l) => l + '\n').join(''));

  return { ctx: { claudeSessionId: sessionId, claudeTranscript: transcript }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a still-running agent (no notification) reads as running', () => {
  const { ctx, cleanup } = makeSession(null);
  try {
    const { agents } = claude.read(ctx);
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].running, true);
  } finally { cleanup(); }
});

for (const [name, build] of Object.entries(CARRIERS)) {
  test(`stop is detected from ${name}`, () => {
    const { ctx, cleanup } = makeSession(build);
    try {
      const { agents } = claude.read(ctx);
      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].running, false, `stop in "${name}" must mark the agent not running`);
    } finally { cleanup(); }
  });
}
