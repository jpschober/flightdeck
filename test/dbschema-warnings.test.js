'use strict';
// Checks that what the schema reader could not do reaches the panel instead of
// only the log: a plugin that throws while detecting, and a migration that is
// listed but cannot be read.
//
//   node --test test/dbschema-warnings.test.js
//
// Both go through the IR - `schema.warnings` is what the DB panel renders.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'src', 'main');

// The logger writes warnings to the console; the test runner owns it here.
console.error = () => {};
console.log = () => {};

// A provider is all a schema plugin sees of the world: four calls, relative
// paths. `null` from read() means "listed, but nothing came back".
function provider(files) {
  return {
    kind: 'test',
    root: '/repo',
    async exists(rel) { return rel in files; },
    async read(rel) { return rel in files ? files[rel] : null; },
    async list(dir, opts = {}) {
      return Object.keys(files)
        .filter((f) => f.startsWith(dir) && (!opts.ext || f.endsWith(opts.ext)))
        .sort();
    },
    async stamp() { return 'stamp'; },
  };
}

test('a migration that cannot be read is named in the warnings', async () => {
  const supabase = require(path.join(MAIN, 'dbschema', 'plugins', 'supabase.js'));
  const schema = await supabase.read(provider({
    'supabase/migrations/1_broken.sql': null,
    'supabase/migrations/2_ok.sql': 'CREATE TABLE t (id int primary key);',
  }));

  assert.strictEqual(schema.tables.length, 1, 'the readable migration still counts');
  assert.ok(
    schema.warnings.some((w) => w.includes('1_broken.sql')),
    `the unreadable one is named: ${JSON.stringify(schema.warnings)}`,
  );
  assert.deepStrictEqual(schema.files, ['supabase/migrations/2_ok.sql']);
});

test('a plugin that throws while detecting says so in the panel', async () => {
  const dbschema = require(path.join(MAIN, 'dbschema', 'index.js'));
  dbschema.PLUGINS.push({
    id: 'broken',
    label: 'Broken',
    detect() { throw new Error('detect exploded'); },
    read() { throw new Error('never reached'); },
  });

  // No plugin claims the directory, so the panel would otherwise say "no DB
  // schema detected" - which would be the wrong sentence here.
  const view = await dbschema.getSchemaView('/definitely/not/a/repo', {});
  assert.strictEqual(view.ok, true);
  assert.strictEqual(view.plugin, null);
  assert.ok(
    view.schema.warnings.some((w) => w.includes('detect exploded') && w.includes('Broken')),
    `the failure is on the IR: ${JSON.stringify(view.schema.warnings)}`,
  );
});

test('an unparsable statement stays a warning, the rest of the file is read', () => {
  const ddl = require(path.join(MAIN, 'dbschema', 'sql-ddl.js'));
  const model = ddl.createModel();
  ddl.applySql(model, 'CREATE TABLE ;\nCREATE TABLE good (id int);');
  assert.strictEqual(model.tables.size, 1);
  assert.ok(model.warnings.length >= 1, 'the broken statement left a warning');
});
