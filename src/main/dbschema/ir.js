'use strict';
// The standardised schema format ("IR") that all plugins agree on. Only this
// shape travels over IPC into the renderer, and only this shape is compared by
// the diff - what a plugin reads internally (SQL migrations, TypeScript
// definitions, a running database) no longer matters afterwards.
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
// `kind` is one of: pk, unique, fk, check, index, exclude.

const { DEFAULT_SCHEMA } = require('./sql-ddl');

// Display order: first what identifies the row, then the rules
const KIND_RANK = { pk: 0, unique: 1, fk: 2, check: 3, exclude: 4, index: 5 };

function byName(a, b) {
  return String(a.name).localeCompare(String(b.name), 'en');
}

function qualify(schema, name) {
  return `${schema || DEFAULT_SCHEMA}.${name}`;
}

/** Builds the IR from the DDL reader's model. */
function fromModel(model, meta = {}) {
  const tables = [...model.tables.values()].map((t) => ({
    id: qualify(t.schema, t.name),
    schema: t.schema || DEFAULT_SCHEMA,
    name: t.name,
    comment: t.comment || null,
    // A table the project does not create itself but does define rules on -
    // its columns are unknown here, not empty.
    external: Boolean(t.external),
    // Column order is the author's intent and stays as it is.
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
      // Constraints have no meaningful order of their own; sort them stably so
      // the diff does not trip over reordering.
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
  })).sort((a, b) => a.schema.localeCompare(b.schema, 'en') || byName(a, b));

  const enums = [...model.enums.values()].map((e) => ({
    id: qualify(e.schema, e.name),
    schema: e.schema || DEFAULT_SCHEMA,
    name: e.name,
    values: e.values.slice(),
  })).sort((a, b) => a.schema.localeCompare(b.schema, 'en') || byName(a, b));

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

/** Empty IR - for "nothing here yet" or the baseline of a new project. */
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
// Comparable short forms of individual parts. Diff and display have to agree
// on what "equal" means - which is why it lives here, not there.
// ---------------------------------------------------------------------------

/** The properties of a column that the diff reports individually. */
const COLUMN_FIELDS = ['type', 'nullable', 'default', 'identity', 'generated', 'comment'];

const FIELD_LABEL = {
  type: 'type',
  nullable: 'NULL allowed',
  default: 'default',
  identity: 'identity',
  generated: 'generated',
  comment: 'comment',
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
