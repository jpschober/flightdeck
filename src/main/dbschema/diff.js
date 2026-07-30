'use strict';
// Vergleich zweier Schema-Staende (IR gegen IR).
//
// Der Zweck ist nicht Vollstaendigkeit, sondern Aufmerksamkeit: eine
// Schemaaenderung soll auffallen, damit jemand sie anschaut. Deshalb wird
// nicht nur gezaehlt, sondern pro Tabelle festgehalten, *was* sich geaendert
// hat - genau das braucht die Vorher/Nachher-Ansicht, um die richtigen Zeilen
// zu markieren.
//
// Ausgabe:
//   {
//     changed, summary: { tables:{added,removed,changed}, columns:{...}, ... },
//     tables: [ { id, status, columns: [...], constraints: [...], policies: [...],
//                 rlsChanged, commentChanged } ],
//     enums:  [ { id, status, added[], removed[] } ],
//   }
// `status` ist 'added' | 'removed' | 'changed' | 'same'.

const { COLUMN_FIELDS, constraintSignature, policySignature } = require('./ir');

function indexBy(list, key) {
  const m = new Map();
  for (const item of list || []) m.set(item[key], item);
  return m;
}

/**
 * Bringt zwei Namenslisten in eine gemeinsame Reihenfolge: die neue Reihenfolge
 * gibt den Takt vor, entfallene Namen werden dort eingefuegt, wo sie vorher
 * standen. So kann die Vorher/Nachher-Ansicht beide Seiten Zeile fuer Zeile
 * nebeneinander legen.
 */
function alignNames(oldNames, newNames) {
  const inNew = new Set(newNames);
  const out = [];
  let oi = 0;
  for (const name of newNames) {
    // Alles, was vorher vor diesem Namen stand und heute fehlt, kommt davor
    while (oi < oldNames.length && oldNames[oi] !== name) {
      if (!inNew.has(oldNames[oi])) out.push(oldNames[oi]);
      oi++;
    }
    if (oi < oldNames.length) oi++;
    out.push(name);
  }
  while (oi < oldNames.length) {
    if (!inNew.has(oldNames[oi])) out.push(oldNames[oi]);
    oi++;
  }
  return [...new Set(out)];
}

function diffColumns(oldCols, newCols) {
  const before = indexBy(oldCols, 'name');
  const after = indexBy(newCols, 'name');
  const order = alignNames((oldCols || []).map((c) => c.name), (newCols || []).map((c) => c.name));

  return order.map((name) => {
    const b = before.get(name) || null;
    const a = after.get(name) || null;
    if (!b) return { name, status: 'added', before: null, after: a, fields: [] };
    if (!a) return { name, status: 'removed', before: b, after: null, fields: [] };
    const fields = COLUMN_FIELDS.filter((f) => (b[f] ?? null) !== (a[f] ?? null));
    return { name, status: fields.length ? 'changed' : 'same', before: b, after: a, fields };
  });
}

function diffConstraints(oldList, newList) {
  const before = indexBy(oldList, 'name');
  const after = indexBy(newList, 'name');
  const order = alignNames((oldList || []).map((c) => c.name), (newList || []).map((c) => c.name));

  return order.map((name) => {
    const b = before.get(name) || null;
    const a = after.get(name) || null;
    if (!b) return { name, status: 'added', before: null, after: a };
    if (!a) return { name, status: 'removed', before: b, after: null };
    const same = constraintSignature(b) === constraintSignature(a);
    return { name, status: same ? 'same' : 'changed', before: b, after: a };
  });
}

function diffPolicies(oldT, newT) {
  const oldList = (oldT && oldT.rls.policies) || [];
  const newList = (newT && newT.rls.policies) || [];
  const before = indexBy(oldList, 'name');
  const after = indexBy(newList, 'name');
  const order = alignNames(oldList.map((p) => p.name), newList.map((p) => p.name));

  return order.map((name) => {
    const b = before.get(name) || null;
    const a = after.get(name) || null;
    if (!b) return { name, status: 'added', before: null, after: a };
    if (!a) return { name, status: 'removed', before: b, after: null };
    const same = policySignature(b) === policySignature(a);
    return { name, status: same ? 'same' : 'changed', before: b, after: a };
  });
}

function diffEnums(oldEnums, newEnums) {
  const before = indexBy(oldEnums, 'id');
  const after = indexBy(newEnums, 'id');
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  return ids.map((id) => {
    const b = before.get(id) || null;
    const a = after.get(id) || null;
    if (!b) return { id, name: a.name, schema: a.schema, status: 'added', values: a.values, added: a.values, removed: [] };
    if (!a) return { id, name: b.name, schema: b.schema, status: 'removed', values: b.values, added: [], removed: b.values };
    const added = a.values.filter((v) => !b.values.includes(v));
    const removed = b.values.filter((v) => !a.values.includes(v));
    // Reine Umsortierung eines Enums ist eine echte Aenderung (die Sortierung
    // haengt daran), zaehlt aber nicht als hinzugefuegt oder entfernt.
    const reordered = !added.length && !removed.length
      && (b.values.length !== a.values.length
        || b.values.some((v, i) => v !== a.values[i]));
    return {
      id, name: a.name, schema: a.schema,
      status: (added.length || removed.length || reordered) ? 'changed' : 'same',
      values: a.values, before: b.values, added, removed, reordered,
    };
  });
}

function diff(baseIr, currentIr) {
  const before = indexBy(baseIr && baseIr.tables, 'id');
  const after = indexBy(currentIr && currentIr.tables, 'id');
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  const summary = {
    tables: { added: 0, removed: 0, changed: 0 },
    columns: { added: 0, removed: 0, changed: 0 },
    constraints: { added: 0, removed: 0, changed: 0 },
    policies: { added: 0, removed: 0, changed: 0 },
    enums: { added: 0, removed: 0, changed: 0 },
  };

  const tables = ids.map((id) => {
    const b = before.get(id) || null;
    const a = after.get(id) || null;
    const columns = diffColumns(b && b.columns, a && a.columns);
    const constraints = diffConstraints(b && b.constraints, a && a.constraints);
    const policies = diffPolicies(b, a);
    const rlsChanged = Boolean(b) && Boolean(a) && b.rls.enabled !== a.rls.enabled;
    const commentChanged = Boolean(b) && Boolean(a) && (b.comment || null) !== (a.comment || null);

    let status;
    if (!b) status = 'added';
    else if (!a) status = 'removed';
    else {
      const touched = [...columns, ...constraints, ...policies].some((x) => x.status !== 'same');
      status = (touched || rlsChanged || commentChanged) ? 'changed' : 'same';
    }

    if (status !== 'same') summary.tables[status]++;
    // Bei neuen und entfernten Tabellen waeren alle Spalten "neu" bzw. "weg" -
    // das sagt nichts, was die Tabellenzeile nicht schon sagt.
    if (status === 'changed') {
      for (const c of columns) if (c.status !== 'same') summary.columns[c.status]++;
      for (const c of constraints) if (c.status !== 'same') summary.constraints[c.status]++;
      for (const p of policies) if (p.status !== 'same') summary.policies[p.status]++;
    }

    const table = a || b;
    return {
      id,
      schema: table.schema,
      name: table.name,
      status,
      rlsChanged,
      commentChanged,
      columns,
      constraints,
      policies,
    };
  });

  const enums = diffEnums(baseIr && baseIr.enums, currentIr && currentIr.enums);
  for (const e of enums) if (e.status !== 'same') summary.enums[e.status]++;

  const changed = tables.some((t) => t.status !== 'same') || enums.some((e) => e.status !== 'same');
  return { changed, summary, tables, enums };
}

/** Kurzer Satz fuer die Anzeige am Tab bzw. im Kopf des Panels. */
function describe(result) {
  if (!result || !result.changed) return 'Schema unverändert';
  const s = result.summary;
  const bits = [];
  const add = (n, one, many) => { if (n) bits.push(`${n} ${n === 1 ? one : many}`); };
  add(s.tables.added, 'neue Tabelle', 'neue Tabellen');
  add(s.tables.removed, 'entfernte Tabelle', 'entfernte Tabellen');
  add(s.tables.changed, 'geänderte Tabelle', 'geänderte Tabellen');
  add(s.enums.added + s.enums.changed + s.enums.removed, 'Enum-Änderung', 'Enum-Änderungen');
  return bits.join(' · ') || 'Schema geändert';
}

/** Zahl der Aenderungen - fuer das Zaehlerchen am Tab. */
function countChanges(result) {
  if (!result || !result.changed) return 0;
  const s = result.summary;
  return s.tables.added + s.tables.removed + s.tables.changed
    + s.enums.added + s.enums.removed + s.enums.changed;
}

module.exports = { diff, describe, countChanges, alignNames };
