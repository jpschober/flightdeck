// ---------------------------------------------------------------------------
// The schema format on screen
//
// Two views read the same IR: the panel with its table cards (db-schema.js) and
// the ER diagram (dbgraph.js). What both of them need to say about a column, a
// constraint or a diff entry lives here, so neither view has to import the
// other for it.
// ---------------------------------------------------------------------------
import { escapeHtml } from './dom.js';
import { t } from './i18n.js';

// Short tags for the constraints that affect a column. The abbreviations stay
// as they are - they are read as symbols, and a two-letter marker that changes
// with the language would lose that. The tooltip carries the translation.
export const KIND_TAG = {
  pk: { tag: 'PK', key: 'db.tag.pk' },
  fk: { tag: 'FK', key: 'db.tag.fk' },
  unique: { tag: 'UQ', key: 'db.tag.unique' },
  check: { tag: 'CK', key: 'db.tag.check' },
  index: { tag: 'IX', key: 'db.tag.index' },
  exclude: { tag: 'EX', key: 'db.tag.exclude' },
};

export function constraintText(c) {
  const cols = (c.columns || []).join(', ');
  if (c.kind === 'fk' && c.references) {
    const r = c.references;
    const target = `${r.schema}.${r.table}${r.columns.length ? `(${r.columns.join(', ')})` : ''}`;
    const actions = [
      c.onDelete ? `on delete ${c.onDelete}` : '',
      c.onUpdate ? `on update ${c.onUpdate}` : '',
    ].filter(Boolean).join(' ');
    return `(${cols}) → ${target}${actions ? ' ' + actions : ''}`;
  }
  if (c.kind === 'check' || c.kind === 'exclude') return c.expression || '';
  if (c.kind === 'index') {
    return `${c.unique ? 'unique ' : ''}(${cols})${c.method ? ' using ' + c.method : ''}`
      + `${c.expression ? ' where ' + c.expression : ''}`;
  }
  return `(${cols})`;
}

/** Which constraints affect this column? */
export function tagsForColumn(table, colName) {
  const kinds = new Set();
  for (const c of table.constraints || []) {
    if ((c.columns || []).includes(colName)) kinds.add(c.kind);
  }
  return [...kinds]
    .filter((k) => KIND_TAG[k])
    .sort((a, b) => Object.keys(KIND_TAG).indexOf(a) - Object.keys(KIND_TAG).indexOf(b))
    .map((k) => KIND_TAG[k]);
}

export function tagsHtml(tags) {
  return tags.map((tag) => `<span class="db-tag ${tag.tag.toLowerCase()}" title="${escapeHtml(t(tag.key))}">${tag.tag}</span>`).join('');
}

/** Make the diff status per table/column/constraint look-up-able. */
export function diffLookup(view) {
  const tables = new Map();
  if (!view.diff) return tables;
  for (const td of view.diff.tables) {
    tables.set(td.id, {
      status: td.status,
      rlsChanged: td.rlsChanged,
      columns: new Map(td.columns.map((c) => [c.name, c])),
      constraints: new Map(td.constraints.map((c) => [c.name, c])),
      policies: new Map(td.policies.map((p) => [p.name, p])),
    });
  }
  return tables;
}
