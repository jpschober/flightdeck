'use strict';
// Schema plugin for Supabase.
//
// A plugin brings both parts itself: the detection ("am I responsible here?")
// and the reading. The sensor only knows this interface:
//
//   id, label
//   detect(provider) -> { confidence, evidence[], watch[] } | null
//   read(provider)   -> IR
//
// Supabase stores its schema as numbered SQL migrations. Those are the source
// of truth in the repo - unlike a running database they are there without
// anything having to be started, and they live in git, which is what makes the
// before/after comparison work.

const ddl = require('../sql-ddl');
const ir = require('../ir');
const log = require('../../log');
const { t } = require('../../../i18n');

const MIGRATIONS_DIR = 'supabase/migrations';
const CONFIG = 'supabase/config.toml';
// From `supabase db dump` or older projects: a schema dump in one piece
const DUMPS = ['supabase/schema.sql', 'supabase/dump.sql'];

// Schemas that Supabase ships and manages itself
const MANAGED_SCHEMA = /^(auth|storage|realtime|supabase_\w+|graphql\w*|extensions|vault|pgsodium\w*|net|cron)$/;

const id = 'supabase';
const label = 'Supabase';

async function detect(provider) {
  const evidence = [];
  let confidence = 0;

  if (await provider.exists(CONFIG)) {
    evidence.push(CONFIG);
    confidence = 0.9;
  }

  const migrations = await provider.list(MIGRATIONS_DIR, { ext: '.sql' });
  if (migrations.length) {
    evidence.push(`${MIGRATIONS_DIR} (${migrations.length} migrations)`);
    // The migrations are the actual schema; without them the plugin cannot
    // deliver anything, even if a config.toml is lying around.
    confidence = Math.max(confidence, 0.95);
  }

  const dumps = [];
  for (const d of DUMPS) {
    if (await provider.exists(d)) { dumps.push(d); evidence.push(d); }
  }
  if (dumps.length) confidence = Math.max(confidence, 0.6);

  if (!confidence || (!migrations.length && !dumps.length)) return null;

  return {
    confidence,
    evidence,
    // How the sensor notices that a re-read is due
    watch: [MIGRATIONS_DIR, CONFIG, ...DUMPS],
  };
}

async function read(provider) {
  const model = ddl.createModel();
  const files = [];

  // Order is everything: the migrations build on one another. Supabase puts the
  // timestamp first so that sorting by name matches the chronological order.
  const migrations = (await provider.list(MIGRATIONS_DIR, { ext: '.sql' })).sort();

  for (const rel of migrations) {
    const sql = await provider.read(rel);
    // Listed, but not readable: too large, gone in the meantime, no permission.
    // The schema that comes out is missing whatever this migration changed, so
    // the panel says which file it was.
    if (sql === null) {
      log.warn('dbschema/supabase: migration not readable', { root: provider.root, kind: provider.kind, file: rel });
      ddl.warn(model, t('db.fileUnreadable', { file: rel }));
      continue;
    }
    files.push(rel);
    ddl.applySql(model, sql);
  }

  // Without migrations: a schema dump in one piece is the next best state
  if (!files.length) {
    for (const rel of DUMPS) {
      const sql = await provider.read(rel);
      if (sql === null) continue;
      files.push(rel);
      ddl.applySql(model, sql);
    }
  }

  // The schemas Supabase manages itself are none of the project's business and
  // would only clutter the display. Exception: if the project has defined its
  // own RLS policies there (typically `storage.objects` for file access), those
  // very much belong - a change to them is something you want to see.
  for (const [key, table] of model.tables) {
    if (!MANAGED_SCHEMA.test(table.schema)) continue;
    if (table.rls.policies.length) continue;
    model.tables.delete(key);
  }

  return ir.fromModel(model, {
    plugin: id,
    label,
    root: provider.root,
    files,
    watch: [MIGRATIONS_DIR, CONFIG, ...DUMPS],
  });
}

module.exports = { id, label, detect, read };
