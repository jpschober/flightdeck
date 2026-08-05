'use strict';
// Checks the detection both plugin systems share: which plugin wins, what a
// plugin that throws costs the others, and what reaches the caller of a
// detection result.
//
//   node --test test/plugin-registry.test.js
//
// The rules were written twice before, once in agents/ and once in dbschema/.
// They are tested here so a change to one of them cannot pass unnoticed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const registry = require(path.join(MAIN, 'plugin-registry.js'));

// Some of these tests drive the real logger, which writes warnings to the
// console. Silencing it stays around the calls that do: a failure anywhere else
// keeps the output that explains it.
async function quiet(fn) {
  const { error, log } = console;
  console.error = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.log = log;
  }
}

/** A plugin is an id, a label and a detect() - nothing else matters here. */
function plugin(id, detect) {
  return { id, label: id.toUpperCase(), detect };
}

function claims(id, confidence, extra = {}) {
  return plugin(id, async () => ({ confidence, evidence: [`${id} said so`], ...extra }));
}

test('the most confident plugin comes first', async () => {
  const found = await registry.detectAll(
    [claims('weak', 0.2), claims('strong', 0.9), claims('middle', 0.5)],
    {},
  );

  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['strong', 'middle', 'weak']);
});

test('on a tie the registration order decides', async () => {
  const found = await registry.detectAll([claims('first', 0.5), claims('second', 0.5)], {});
  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['first', 'second']);
});

test('a plugin that throws does not take the others down with it', async () => {
  const seen = [];
  const found = await registry.detectAll(
    [
      plugin('broken', () => { throw new Error('detect exploded'); }),
      claims('sound', 0.7),
      plugin('rejects', async () => { throw new Error('detect rejected'); }),
    ],
    {},
    { onError: (p, e) => seen.push([p.id, e.message]) },
  );

  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['sound']);
  // Both kinds of failure - thrown and rejected - reach the caller, with the
  // plugin that caused them. That is what the two sensors log, and what the
  // schema panel turns into a warning.
  assert.deepStrictEqual(seen, [['broken', 'detect exploded'], ['rejects', 'detect rejected']]);
});

test('a failure without onError is still survivable', async () => {
  const found = await registry.detectAll(
    [plugin('broken', () => { throw new Error('detect exploded'); }), claims('sound', 0.7)],
    {},
  );
  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['sound']);
});

test('an onError that throws does not take the run down either', async () => {
  const seen = [];
  const found = await registry.detectAll(
    [
      // `throw null` is what makes this reachable in practice: a reporter that
      // reads `err.message` runs into a TypeError on it.
      plugin('throwsNull', () => { throw null; }),
      claims('sound', 0.7),
      plugin('broken', () => { throw new Error('detect exploded'); }),
    ],
    {},
    {
      onError: (p, e) => {
        seen.push(p.id);
        throw new Error(`reporting ${e.message} failed`);
      },
    },
  );

  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['sound']);
  assert.deepStrictEqual(seen, ['throwsNull', 'broken'], 'every failure was still offered');
});

test('onError stays silent for a plugin that simply does not claim', async () => {
  // "No candidate" and "detection failed" are different statements - the schema
  // panel turns the second one into a warning for the user.
  const seen = [];
  const found = await registry.detectAll(
    [
      plugin('nothing', async () => null),
      plugin('undefinedResult', async () => undefined),
      claims('zero', 0),
      claims('negative', -1),
      claims('yes', 0.4),
    ],
    {},
    { onError: (p) => seen.push(p.id) },
  );

  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['yes']);
  assert.deepStrictEqual(seen, [], 'not claiming is not a failure');
});

test('confidence of zero or less is not a candidate', async () => {
  const found = await registry.detectAll(
    [
      claims('zero', 0),
      claims('negative', -1),
      plugin('nothing', async () => null),
      plugin('undefinedConfidence', async () => ({ evidence: ['no number'] })),
      claims('yes', 0.1),
    ],
    {},
  );

  assert.deepStrictEqual(found.map((f) => f.plugin.id), ['yes']);
});

test('evidence and the extra keys are carried over, missing ones as an empty array', async () => {
  const [withWatch, withoutWatch] = await registry.detectAll(
    [
      claims('watcher', 0.9, { watch: ['supabase/migrations'] }),
      claims('silent', 0.5),
    ],
    {},
    { extraArrayKeys: ['watch'] },
  );

  assert.deepStrictEqual(withWatch.watch, ['supabase/migrations']);
  assert.deepStrictEqual(withWatch.evidence, ['watcher said so']);
  assert.deepStrictEqual(withoutWatch.watch, [], 'a plugin without watch does not produce undefined');
  assert.notStrictEqual(withWatch.watch, withoutWatch.watch, 'no entry shares its list with another');
});

test('keys that were not asked for do not reach the result', async () => {
  const [entry] = await registry.detectAll([claims('watcher', 0.9, { watch: ['x'] })], {});
  assert.strictEqual(entry.watch, undefined);
});

test('detect gets the context it was called with', async () => {
  const ctx = { cwd: '/repo', claudeSessionId: 'abc' };
  let seen = null;
  await registry.detectAll([plugin('spy', async (c) => { seen = c; return null; })], ctx);
  assert.strictEqual(seen, ctx);
});

test('pluginInfo is what the surface gets, and null for no winner', async () => {
  const [winner] = await registry.detectAll(
    [claims('supabase', 0.8, { watch: ['supabase'] })],
    {},
    { extraArrayKeys: ['watch'] },
  );

  assert.deepStrictEqual(registry.pluginInfo(winner), {
    id: 'supabase',
    label: 'SUPABASE',
    confidence: 0.8,
    evidence: ['supabase said so'],
  });
  assert.strictEqual(registry.pluginInfo(undefined), null);
  assert.strictEqual(registry.pluginInfo(null), null);
});

// ---------------------------------------------------------------------------
// The two callers
// ---------------------------------------------------------------------------

test('the agent view names the plugin that won', async () => {
  const agents = require(path.join(MAIN, 'agents', 'index.js'));
  const original = agents.PLUGINS.slice();
  agents.PLUGINS.length = 0;
  agents.PLUGINS.push({
    id: 'fake',
    label: 'Fake',
    async detect() { return { confidence: 0.6, evidence: ['bound session'] }; },
    async read() { return { agents: [{ id: 'a1', description: 'work', running: true }] }; },
  });

  try {
    const view = await agents.getAgentView({ cwd: '/repo' });
    assert.deepStrictEqual(view.plugin, {
      id: 'fake',
      label: 'Fake',
      confidence: 0.6,
      evidence: ['bound session'],
    });
    assert.strictEqual(view.running, 1);
  } finally {
    agents.PLUGINS.length = 0;
    agents.PLUGINS.push(...original);
  }
});

test('a failing agent plugin leaves the view empty instead of throwing', async () => {
  const agents = require(path.join(MAIN, 'agents', 'index.js'));
  const original = agents.PLUGINS.slice();
  agents.PLUGINS.length = 0;
  agents.PLUGINS.push({
    id: 'broken',
    label: 'Broken',
    detect() { throw new Error('detect exploded'); },
    read() { throw new Error('never reached'); },
  });

  try {
    // The sensor logs the failure, so this one call is silenced.
    await quiet(async () => {
      assert.strictEqual(await agents.getAgentView({ cwd: '/repo' }), null);
    });
  } finally {
    agents.PLUGINS.length = 0;
    agents.PLUGINS.push(...original);
  }
});

test('the schema reader keeps the watch paths of the winning plugin', async () => {
  const dbschema = require(path.join(MAIN, 'dbschema', 'index.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-registry-'));
  const original = dbschema.PLUGINS.slice();
  dbschema.PLUGINS.length = 0;
  // No `watch` at all: the reader spreads it into the paths it stamps, so a
  // detection result that loses the key would fail here rather than downgrade
  // to "nothing to watch".
  dbschema.PLUGINS.push({
    id: 'watchless',
    label: 'Watchless',
    async detect() { return { confidence: 0.9, evidence: ['a config file'] }; },
    async read() { return require(path.join(MAIN, 'dbschema', 'ir.js')).empty({ plugin: 'watchless', label: 'Watchless', root }); },
  });

  try {
    const view = await dbschema.getSchemaView(root, {});
    assert.strictEqual(view.ok, true);
    assert.deepStrictEqual(view.plugin, {
      id: 'watchless',
      label: 'Watchless',
      confidence: 0.9,
      evidence: ['a config file'],
    });
  } finally {
    dbschema.PLUGINS.length = 0;
    dbschema.PLUGINS.push(...original);
    dbschema.clearCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plugin that throws a non-Error still leaves the schema panel standing', async () => {
  // The schema sensor builds its warning from `e.message`. On `throw null` that
  // is a TypeError inside the reporter - and the panel, which exists to show
  // exactly this failure, would be the thing that disappears.
  const dbschema = require(path.join(MAIN, 'dbschema', 'index.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-registry-'));
  const original = dbschema.PLUGINS.slice();
  dbschema.PLUGINS.length = 0;
  dbschema.PLUGINS.push({
    id: 'throwsNull',
    label: 'ThrowsNull',
    detect() { throw null; },
    read() { throw new Error('never reached'); },
  });

  try {
    const view = await quiet(() => dbschema.getSchemaView(root, {}));
    assert.strictEqual(view.ok, true, 'the view came back instead of rejecting');
    assert.strictEqual(view.plugin, null);
  } finally {
    dbschema.PLUGINS.length = 0;
    dbschema.PLUGINS.push(...original);
    dbschema.clearCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
