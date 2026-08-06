'use strict';
// Which command lines count as an agent CLI.
//
//   node --test test/agent-commands.test.js
//
// The answer drives the attention heuristic: for a watched command main.js
// reads two seconds of silence as "waiting for you" and reconstructs typed
// input as an agent prompt (applyStateFromData, feedInputRecon). A command that
// falls out of the set loses its state detection, a command that falls in gets
// false attention notices - so the set is written down here as a table of real
// command lines rather than as a regexp.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AGENTS = path.join(__dirname, '..', 'src', 'main', 'agents');
const { isAgentCommand, PLUGINS } = require(AGENTS);
const claudePlugin = require(path.join(AGENTS, 'plugins', 'claude'));

// What main.js carried before the plugins owned the answer. Kept here as the
// yardstick: the tables below must produce the same verdict, otherwise the move
// into the plugins changed which terminals are watched.
const LEGACY_MAIN_RE = /(^|[\s\\/"'])(claude|codex|aider)([\s"'.]|$)/i;

// The Claude plugin's own pattern before the merge. It was narrower on both
// sides; the cases where the merged pattern says more are listed explicitly.
const LEGACY_PLUGIN_RE = /(?:^|[\s/\\])claude(?:\s|$)/i;

const WATCHED = [
  'claude',
  'claude --resume',
  'claude --resume 11111111-2222-3333-4444-555555555555',
  'claude -p "summarise this"',
  'claude --dangerously-skip-permissions',
  './claude',
  '/usr/local/bin/claude',
  'C:\\Users\\x\\AppData\\claude',
  'npx claude',
  'command claude',
  'sudo claude',
  'git log | claude -p "what changed"',
  'CLAUDE',            // the pattern is case-insensitive
  '"claude"',          // quoted, as a shell may report it
  "'claude'",
  'claude.exe',        // Windows
  'claude.',           // trailing sentence punctuation counts as a boundary
  'echo claude',       // a mention, not a start - watched all the same
  'codex',
  'codex --model o3',
  '/opt/homebrew/bin/codex',
  'aider',
  'aider --model sonnet src/main.js',
  '/usr/bin/aider',
];

const NOT_WATCHED = [
  '',
  'ls',
  'npm test',
  'git status',
  'vim src/main/main.js',
  'claudia',           // longer word, not the CLI
  'myclaude',
  'claude-code',       // the hyphen is not a boundary in this pattern
  'codexa',
  'xcodex',
  'aiderly',
  'spider',
  'cat README.md',
];

test('the agent CLIs are watched', () => {
  for (const cmd of WATCHED) {
    assert.strictEqual(isAgentCommand(cmd), true, `not watched: ${cmd}`);
  }
});

test('everything else is not', () => {
  for (const cmd of NOT_WATCHED) {
    assert.strictEqual(isAgentCommand(cmd), false, `wrongly watched: ${cmd}`);
  }
});

test('a missing command line is not an agent', () => {
  assert.strictEqual(isAgentCommand(null), false);
  assert.strictEqual(isAgentCommand(undefined), false);
  assert.strictEqual(isAgentCommand(''), false);
});

test('the verdict is the one main.js gave before the plugins owned it', () => {
  for (const cmd of [...WATCHED, ...NOT_WATCHED]) {
    assert.strictEqual(isAgentCommand(cmd), LEGACY_MAIN_RE.test(cmd),
      `the set of watched commands changed at: ${cmd}`);
  }
});

test('codex and aider keep their state detection without a plugin that counts', () => {
  // They have no counting - the point of their plugin files is that the
  // attention heuristic still applies to them.
  for (const cmd of ['codex', 'aider']) {
    assert.strictEqual(isAgentCommand(cmd), true);
  }
  for (const id of ['codex', 'aider']) {
    const p = PLUGINS.find((x) => x.id === id);
    assert.ok(p, `no plugin registered for ${id}`);
    assert.strictEqual(p.detect({ command: id }), null,
      `${id} claims a terminal, so the agent panel would appear with nothing in it`);
  }
});

test('codex and aider carry a placeholder read() that nothing calls today', () => {
  // The sensor only calls read() on the plugin that won detection, and neither
  // of these two ever claims a terminal. What is checked here is the shape a
  // later detect() would find waiting for it, not behaviour the app reaches.
  for (const id of ['codex', 'aider']) {
    const p = PLUGINS.find((x) => x.id === id);
    assert.deepStrictEqual(p.read({ command: id }), { agents: [] },
      `${id}'s placeholder does not return the empty agent list the sensor expects`);
  }
});

test('every plugin brings a usable command pattern', () => {
  for (const p of PLUGINS) {
    assert.ok(p.commandPattern instanceof RegExp, `${p.id} has no commandPattern`);
    // test() on a global pattern carries lastIndex from call to call and would
    // answer "no" to every other identical command.
    assert.strictEqual(p.commandPattern.global, false, `${p.id}'s pattern is global`);
    assert.strictEqual(p.commandPattern.test('claude'), p.commandPattern.test('claude'),
      `${p.id}'s pattern answers differently on the second call`);
  }
});

// ---------------------------------------------------------------------------
// The plugin's own detection now runs off the same pattern
// ---------------------------------------------------------------------------

test('the Claude plugin claims a command it recognises, with no session bound', () => {
  const d = claudePlugin.detect({ command: 'claude --resume' });
  assert.ok(d && d.confidence > 0, 'the plugin does not feel responsible for `claude`');
  assert.strictEqual(claudePlugin.detect({ command: 'npm test' }), null);
});

test('the merged pattern widens the plugin only by quotes and a trailing dot', () => {
  const widened = [];
  for (const cmd of [...WATCHED, ...NOT_WATCHED]) {
    const now = claudePlugin.commandPattern.test(cmd);
    if (now !== LEGACY_PLUGIN_RE.test(cmd)) widened.push(cmd);
  }
  assert.deepStrictEqual(widened.sort(), ['"claude"', "'claude'", 'claude.', 'claude.exe'].sort());
});

// ---------------------------------------------------------------------------
// One place, not two
// ---------------------------------------------------------------------------

// Prose may name any CLI it likes - the check applies to code. Trailing and
// block comments come out as well as whole comment lines, otherwise a line like
// `foo(); // as with codex` would fail a test about hardcoded lists.
//
// A `//` preceded by a backslash, a colon or a slash is left alone: those are
// the escaped ones inside regex literals (`/^\/[a-z]\//`) and the ones in URLs,
// and cutting there would swallow the code behind them. Stripping can only
// remove text, so anything it gets wrong costs the check a hit, never invents
// one.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^\\:/])\/\/.*$/gm, '$1');
}

test('session-state.js names no agent CLI of its own', () => {
  const dir = path.join(__dirname, '..', 'src', 'main');
  const state = fs.readFileSync(path.join(dir, 'session-state.js'), 'utf8');
  assert.ok(!state.includes('WATCHED_CMD_RE'), 'the hardcoded command pattern is back in session-state.js');
  assert.ok(state.includes('isAgentCommand'), 'session-state.js no longer asks the plugins');
  for (const file of ['session-state.js', 'sessions.js', 'main.js']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/\b(codex|aider)\b/i.test(stripComments(src)),
      `${file} names an agent CLI again - the answer belongs to the plugins`);
  }
});

test('the comment stripping keeps code and drops every form of comment', () => {
  const kept = stripComments([
    'const re = /^\\/[a-z]\\//;',
    "const url = 'https://example.invalid/codex';",
  ].join('\n'));
  assert.ok(kept.includes('/^\\/[a-z]\\//'), 'an escaped slash in a regex was taken for a comment');
  assert.ok(kept.includes('example.invalid'), 'a URL was taken for a comment');

  const gone = stripComments([
    'foo(); // as with codex',
    '// aider does the same',
    '/* codex\n   aider */',
    'bar(); /* codex */',
  ].join('\n'));
  assert.ok(!/\b(codex|aider)\b/i.test(gone), 'a comment survived the stripping');
  assert.ok(gone.includes('foo();') && gone.includes('bar();'), 'the code around the comments went too');
});
