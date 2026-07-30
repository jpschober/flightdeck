'use strict';
// Das standardisierte Schema-Format ("IR"), auf das sich alle Plugins
// einigen. Nur diese Form geht ueber IPC in den Renderer, und nur sie
// vergleicht der Diff - was ein Plugin intern liest (SQL-Migrationen,
// TypeScript-Definitionen, eine laufende Datenbank), spielt danach keine
// Rolle mehr.
//
//   {
//     plugin, label, root, files[], watch[], warnings[],
//     enums:  [ { id, schema, name, values[] } ],
//     tables: [ {
//       id, schema, name, comment, rls: { enabled, policies[] },
//       columns:     [ { name, type, nullable, default, identity, generated, comment } ],
//       constraints: [ { kind, name, columns[], references?, onDelete?,
//                        onUpdate?, expression?, unique?, method? } ],
//     } ]
//   }
//
// `kind` ist eines von: pk, unique, fk, check, index, exclude.

const { DEFAULT_SCHEMA } = require('./sql-ddl');

// Reihenfolge in der Anzeige: erst was die Zeile identifiziert, dann Regeln
const KIND_RANK = { pk: 0, unique: 1, fk: 2, check: 3, exclude: 4, index: 5 };

function byName(a, b) {
  return String(a.name).localeCompare(String(b.name), 'de');
}

function qualify(schema, name) {
  return `${schema || DEFAULT_SCHEMA}.${name}`;
}

/** Baut aus dem Modell des DDL-Lesers das IR. */
function fromModel(model, meta = {}) {
  const tables = [...model.tables.values()].map((t) => ({
    id: qualify(t.schema, t.name),
    schema: t.schema || DEFAULT_SCHEMA,
    name: t.name,
    comment: t.comment || null,
    // Tabelle, die das Projekt nicht selbst anlegt, auf der es aber Regeln
    // definiert - Spalten sind hier unbekannt, nicht leer.
    external: Boolean(t.external),
    // Spaltenreihenfolge ist Absicht des Autors und bleibt, wie sie ist.
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type || '',
      nullable: c.nullable !== false,
      default: c.default || null,
      identity: Boolean(c.identity),
      generated: c.generated || null,
      comment: c.comment || null,
    })),
    constraints: t.constraints
      .map((c) => ({
        kind: c.kind,
        name: c.name,
        columns: c.columns || [],
        references: c.references
          ? {
            schema: c.references.schema || DEFAULT_SCHEMA,
            table: c.references.table,
            columns: c.references.columns || [],
          }
          : null,
        onDelete: c.onDelete || null,
        onUpdate: c.onUpdate || null,
        expression: c.expression || null,
        unique: c.unique === undefined ? null : Boolean(c.unique),
        method: c.method || null,
      }))
      // Constraints haben keine sinnvolle Eigenreihenfolge; stabil sortieren,
      // damit der Diff nicht auf Umsortierungen anspringt.
      .sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || byName(a, b)),
    rls: {
      enabled: Boolean(t.rls && t.rls.enabled),
      policies: ((t.rls && t.rls.policies) || []).map((p) => ({
        name: p.name,
        command: p.command || 'all',
        permissive: p.permissive !== false,
        roles: p.roles || [],
        using: p.using || null,
        check: p.check || null,
      })).sort(byName),
    },
  })).sort((a, b) => a.schema.localeCompare(b.schema, 'de') || byName(a, b));

  const enums = [...model.enums.values()].map((e) => ({
    id: qualify(e.schema, e.name),
    schema: e.schema || DEFAULT_SCHEMA,
    name: e.name,
    values: e.values.slice(),
  })).sort((a, b) => a.schema.localeCompare(b.schema, 'de') || byName(a, b));

  return {
    plugin: meta.plugin || null,
    label: meta.label || null,
    root: meta.root || null,
    files: meta.files || [],
    watch: meta.watch || [],
    warnings: model.warnings.slice(),
    tables,
    enums,
  };
}

/** Leeres IR - fuer "hier ist noch nichts" bzw. die Basis eines neuen Projekts. */
function empty(meta = {}) {
  return {
    plugin: meta.plugin || null,
    label: meta.label || null,
    root: meta.root || null,
    files: [],
    watch: [],
    warnings: [],
    tables: [],
    enums: [],
  };
}

// ---------------------------------------------------------------------------
// Vergleichbare Kurzform einzelner Bestandteile. Diff und Anzeige muessen sich
// darueber einig sein, was "gleich" heisst - deshalb steht es hier, nicht dort.
// ---------------------------------------------------------------------------

/** Die Eigenschaften einer Spalte, die der Diff einzeln ausweist. */
const COLUMN_FIELDS = ['type', 'nullable', 'default', 'identity', 'generated', 'comment'];

const FIELD_LABEL = {
  type: 'Typ',
  nullable: 'NULL erlaubt',
  default: 'Vorgabewert',
  identity: 'Identität',
  generated: 'berechnet',
  comment: 'Kommentar',
};

function constraintSignature(c) {
  const parts = [c.kind, (c.columns || []).join(',')];
  if (c.references) {
    parts.push(`->${c.references.schema}.${c.references.table}(${c.references.columns.join(',')})`);
    parts.push(`del:${c.onDelete || '-'}`, `upd:${c.onUpdate || '-'}`);
  }
  if (c.expression) parts.push(`expr:${c.expression}`);
  if (c.unique !== null && c.unique !== undefined) parts.push(`uniq:${c.unique}`);
  if (c.method) parts.push(`using:${c.method}`);
  return parts.join(' ');
}

function policySignature(p) {
  return [
    p.command,
    p.permissive ? 'permissive' : 'restrictive',
    (p.roles || []).join(','),
    `using:${p.using || '-'}`,
    `check:${p.check || '-'}`,
  ].join(' ');
}

module.exports = {
  fromModel,
  empty,
  qualify,
  COLUMN_FIELDS,
  FIELD_LABEL,
  constraintSignature,
  policySignature,
};
