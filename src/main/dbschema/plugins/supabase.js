'use strict';
// Schema-Plugin fuer Supabase.
//
// Ein Plugin bringt beides selbst mit: die Erkennung ("bin ich hier
// zustaendig?") und das Lesen. Der Senser kennt nur diese Schnittstelle:
//
//   id, label
//   detect(provider) -> { confidence, evidence[], watch[] } | null
//   read(provider)   -> IR
//
// Supabase legt sein Schema als durchnummerierte SQL-Migrationen ab. Die sind
// die Quelle der Wahrheit im Repo - anders als eine laufende Datenbank sind sie
// da, ohne dass etwas gestartet sein muss, und sie liegen im Git, womit auch
// der Vorher/Nachher-Vergleich funktioniert.

const ddl = require('../sql-ddl');
const ir = require('../ir');

const MIGRATIONS_DIR = 'supabase/migrations';
const CONFIG = 'supabase/config.toml';
// Von `supabase db dump` bzw. aelteren Projekten: ein Schema-Abzug am Stueck
const DUMPS = ['supabase/schema.sql', 'supabase/dump.sql'];

// Schemata, die Supabase selbst mitbringt und verwaltet
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
    evidence.push(`${MIGRATIONS_DIR} (${migrations.length} Migrationen)`);
    // Migrationen sind das eigentliche Schema; ohne sie kann das Plugin nichts
    // liefern, auch wenn eine config.toml herumliegt.
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
    // Woran der Senser merkt, dass neu gelesen werden muss
    watch: [MIGRATIONS_DIR, CONFIG, ...DUMPS],
  };
}

async function read(provider) {
  const model = ddl.createModel();
  const files = [];

  // Reihenfolge ist alles: die Migrationen bauen aufeinander auf. Supabase
  // stellt den Zeitstempel voran, damit die Namenssortierung der zeitlichen
  // Reihenfolge entspricht.
  const migrations = (await provider.list(MIGRATIONS_DIR, { ext: '.sql' })).sort();

  for (const rel of migrations) {
    const sql = await provider.read(rel);
    if (sql === null) continue;
    files.push(rel);
    ddl.applySql(model, sql);
  }

  // Ohne Migrationen: ein Schema-Abzug am Stueck ist der naechstbeste Stand
  if (!files.length) {
    for (const rel of DUMPS) {
      const sql = await provider.read(rel);
      if (sql === null) continue;
      files.push(rel);
      ddl.applySql(model, sql);
    }
  }

  // Die von Supabase selbst verwalteten Schemata sind nicht Sache des Projekts
  // und wuerden die Anzeige nur zumuellen. Ausnahme: hat das Projekt dort eigene
  // RLS-Policies definiert (typisch `storage.objects` fuer Datei-Zugriff), dann
  // gehoeren die sehr wohl dazu - eine Aenderung daran will man sehen.
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
