'use strict';
// The path a migration takes to the before/after view:
//
//   migration SQL -> applySql -> model -> ir.fromModel -> diff
//
//   node --test test/dbschema-diff.test.js
//
// The diff is what the DB panel marks up, so the tests run the whole way: two
// states are each built out of real migration text, and the assertions are on
// what the panel gets - status per row, the changed fields of a column, the
// summary counts on the tab.

const test = require('node:test');
const assert = require('node:assert');

const { createModel, applySql } = require('../src/main/dbschema/sql-ddl');
const ir = require('../src/main/dbschema/ir');
const { diff, describe, countChanges, alignNames } = require('../src/main/dbschema/diff');

/** IR of a project whose migrations are `scripts`, replayed in order. */
function schema(...scripts) {
  const model = createModel();
  for (const sql of scripts) applySql(model, sql);
  return ir.fromModel(model);
}

function tableOf(result, id) {
  const t = result.tables.find((x) => x.id === id);
  assert.ok(t, `${id} is not in the diff`);
  return t;
}

function row(list, name) {
  const r = list.find((x) => x.name === name);
  assert.ok(r, `${name} is not in the diff`);
  return r;
}

// ---------------------------------------------------------------------------
// alignNames - the row order of the before/after view
// ---------------------------------------------------------------------------

test('the new order sets the beat', () => {
  assert.deepStrictEqual(alignNames(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('a dropped name keeps the place it used to hold', () => {
  assert.deepStrictEqual(alignNames(['a', 'b', 'c'], ['a', 'c']), ['a', 'b', 'c']);
  assert.deepStrictEqual(alignNames(['gone', 'a'], ['a']), ['gone', 'a']);
  assert.deepStrictEqual(alignNames(['a', 'gone'], ['a']), ['a', 'gone']);
});

test('a new name stands where it was written', () => {
  assert.deepStrictEqual(alignNames(['a', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('added and dropped at once keeps both sides readable', () => {
  assert.deepStrictEqual(
    alignNames(['id', 'title', 'draft'], ['id', 'title', 'body']),
    ['id', 'title', 'draft', 'body'],
  );
});

test('empty sides and duplicates do not break the order', () => {
  assert.deepStrictEqual(alignNames([], ['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(alignNames(['a', 'b'], []), ['a', 'b']);
  assert.deepStrictEqual(alignNames([], []), []);
  // A name may only appear once, no matter what comes in
  assert.deepStrictEqual(alignNames(['a', 'a'], ['a']), ['a']);
});

// ---------------------------------------------------------------------------
// fromModel - the shape the diff compares
// ---------------------------------------------------------------------------

test('the IR sorts tables by schema and name, columns stay in the written order', () => {
  const s = schema(`
    CREATE TABLE public.zebra (b int, a int);
    CREATE TABLE auth.users (id uuid);
    CREATE TABLE public.alpha (id uuid);
  `);
  assert.deepStrictEqual(s.tables.map((t) => t.id), ['auth.users', 'public.alpha', 'public.zebra']);
  assert.deepStrictEqual(
    s.tables.find((t) => t.id === 'public.zebra').columns.map((c) => c.name),
    ['b', 'a'],
  );
});

test('constraints are sorted by kind so that reordering is not a change', () => {
  const s = schema(`
    CREATE TABLE t (
      a int,
      b int,
      CONSTRAINT z_check CHECK (a > 0),
      CONSTRAINT a_fk FOREIGN KEY (b) REFERENCES other (id),
      CONSTRAINT m_pk PRIMARY KEY (a)
    );
  `);
  assert.deepStrictEqual(
    s.tables[0].constraints.map((c) => c.kind),
    ['pk', 'fk', 'check'],
  );
});

test('an empty IR compares against anything without an error', () => {
  const s = schema('CREATE TABLE t (a int);');
  const result = diff(ir.empty(), s);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.summary.tables.added, 1);
  assert.strictEqual(diff(ir.empty(), ir.empty()).changed, false);
  assert.strictEqual(diff(null, null).changed, false);
});

// ---------------------------------------------------------------------------
// diff over a real migration sequence
// ---------------------------------------------------------------------------

const BASE = `
  CREATE TYPE order_status AS ENUM ('new', 'paid');

  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    nickname text
  );

  CREATE TABLE orders (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users (id),
    status order_status NOT NULL DEFAULT 'new',
    total numeric(10,2)
  );

  CREATE TABLE legacy_carts (id uuid PRIMARY KEY);

  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "own orders" ON orders FOR SELECT USING (user_id = auth.uid());
`;

test('an unchanged schema is unchanged - the same migrations twice', () => {
  const result = diff(schema(BASE), schema(BASE));
  assert.strictEqual(result.changed, false);
  assert.strictEqual(countChanges(result), 0);
  assert.ok(result.tables.every((t) => t.status === 'same'));
  assert.ok(result.enums.every((e) => e.status === 'same'));
});

test('a following migration shows up per table, column and constraint', () => {
  const NEXT = `
    ALTER TABLE users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE users DROP COLUMN nickname;
    ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2);
    ALTER TABLE orders ADD CONSTRAINT orders_total_check CHECK (total >= 0);
    DROP TABLE legacy_carts;
    CREATE TABLE invoices (id uuid PRIMARY KEY, order_id uuid REFERENCES orders (id));
    ALTER TYPE order_status ADD VALUE 'shipped';
  `;
  const result = diff(schema(BASE), schema(BASE, NEXT));
  assert.strictEqual(result.changed, true);

  assert.deepStrictEqual(result.summary.tables, { added: 1, removed: 1, changed: 2 });
  assert.deepStrictEqual(result.summary.columns, { added: 1, removed: 1, changed: 1 });
  assert.deepStrictEqual(result.summary.constraints, { added: 1, removed: 0, changed: 0 });
  assert.deepStrictEqual(result.summary.enums, { added: 0, removed: 0, changed: 1 });

  assert.strictEqual(tableOf(result, 'public.invoices').status, 'added');
  assert.strictEqual(tableOf(result, 'public.legacy_carts').status, 'removed');

  const users = tableOf(result, 'public.users');
  assert.strictEqual(users.status, 'changed');
  assert.strictEqual(row(users.columns, 'id').status, 'same');
  assert.strictEqual(row(users.columns, 'nickname').status, 'removed');
  assert.strictEqual(row(users.columns, 'created_at').status, 'added');
  // The dropped column keeps its old place, the new one comes after it
  assert.deepStrictEqual(users.columns.map((c) => c.name), ['id', 'email', 'nickname', 'created_at']);

  const total = row(tableOf(result, 'public.orders').columns, 'total');
  assert.strictEqual(total.status, 'changed');
  assert.deepStrictEqual(total.fields, ['type']);
  assert.strictEqual(total.before.type, 'numeric(10,2)');
  assert.strictEqual(total.after.type, 'numeric(12,2)');

  const status = result.enums.find((e) => e.id === 'public.order_status');
  assert.strictEqual(status.status, 'changed');
  assert.deepStrictEqual(status.added, ['shipped']);
  assert.deepStrictEqual(status.removed, []);
});

test('the columns of an added table are not counted a second time', () => {
  const result = diff(schema(BASE), schema(BASE, 'CREATE TABLE t (a int, b int, c int);'));
  assert.strictEqual(result.summary.tables.added, 1);
  assert.deepStrictEqual(result.summary.columns, { added: 0, removed: 0, changed: 0 });
});

test('every property of a column that changes is named', () => {
  const before = schema('CREATE TABLE t (a text);');
  const after = schema(`
    CREATE TABLE t (a integer NOT NULL DEFAULT 0);
    COMMENT ON COLUMN t.a IS 'the number';
  `);
  const fields = row(tableOf(diff(before, after), 'public.t').columns, 'a').fields;
  assert.deepStrictEqual([...fields].sort(), ['comment', 'default', 'nullable', 'type']);

  const commented = row(tableOf(diff(after, after), 'public.t').columns, 'a');
  assert.strictEqual(commented.status, 'same');
});

test('a constraint counts as changed only if its content changes', () => {
  const before = schema('CREATE TABLE t (a int, b int, CONSTRAINT t_fk FOREIGN KEY (a) REFERENCES u (id));');
  const renamedTarget = schema('CREATE TABLE t (a int, b int, CONSTRAINT t_fk FOREIGN KEY (a) REFERENCES u (id) ON DELETE CASCADE);');
  const changed = row(tableOf(diff(before, renamedTarget), 'public.t').constraints, 't_fk');
  assert.strictEqual(changed.status, 'changed');

  // Same constraint, written differently: not a change
  const rewritten = schema('CREATE TABLE t (b int, a int, CONSTRAINT t_fk FOREIGN KEY (a) REFERENCES public.u (id));');
  const same = row(tableOf(diff(before, rewritten), 'public.t').constraints, 't_fk');
  assert.strictEqual(same.status, 'same');
});

test('RLS and the table comment are their own kind of change', () => {
  const before = schema('CREATE TABLE t (a int);');
  const rls = schema('CREATE TABLE t (a int); ALTER TABLE t ENABLE ROW LEVEL SECURITY;');
  const commented = schema(`CREATE TABLE t (a int); COMMENT ON TABLE t IS 'x';`);

  const withRls = tableOf(diff(before, rls), 'public.t');
  assert.strictEqual(withRls.status, 'changed');
  assert.strictEqual(withRls.rlsChanged, true);
  assert.strictEqual(withRls.commentChanged, false);

  const withComment = tableOf(diff(before, commented), 'public.t');
  assert.strictEqual(withComment.status, 'changed');
  assert.strictEqual(withComment.commentChanged, true);
});

test('a changed policy is counted and shown with both sides', () => {
  const after = schema(BASE, `
    DROP POLICY "own orders" ON orders;
    CREATE POLICY "own orders" ON orders FOR SELECT TO authenticated USING (user_id = auth.uid());
    CREATE POLICY "admins see all" ON orders FOR ALL USING (is_admin());
  `);
  const result = diff(schema(BASE), after);
  assert.deepStrictEqual(result.summary.policies, { added: 1, removed: 0, changed: 1 });

  const policies = tableOf(result, 'public.orders').policies;
  const own = row(policies, 'own orders');
  assert.strictEqual(own.status, 'changed');
  assert.deepStrictEqual(own.before.roles, []);
  assert.deepStrictEqual(own.after.roles, ['authenticated']);
  assert.strictEqual(row(policies, 'admins see all').status, 'added');
});

test('a reordered enum is a change without additions or removals', () => {
  const before = schema(`CREATE TYPE s AS ENUM ('a', 'b');`);
  const after = schema(`CREATE TYPE s AS ENUM ('a'); ALTER TYPE s ADD VALUE 'b' BEFORE 'a';`);
  const e = diff(before, after).enums[0];
  assert.strictEqual(e.status, 'changed');
  assert.strictEqual(e.reordered, true);
  assert.deepStrictEqual(e.added, []);
  assert.deepStrictEqual(e.removed, []);
  assert.deepStrictEqual(e.before, ['a', 'b']);
  assert.deepStrictEqual(e.values, ['b', 'a']);
});

test('a dropped enum is reported with its values', () => {
  const before = schema(`CREATE TYPE s AS ENUM ('a', 'b');`);
  const e = diff(before, ir.empty()).enums[0];
  assert.strictEqual(e.status, 'removed');
  assert.deepStrictEqual(e.removed, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// The short forms on the tab
// ---------------------------------------------------------------------------

test('the counter counts tables and enums, not every single column', () => {
  const result = diff(schema(BASE), schema(BASE, `
    ALTER TABLE users ADD COLUMN a int;
    ALTER TABLE users ADD COLUMN b int;
    CREATE TABLE t (x int);
    ALTER TYPE order_status ADD VALUE 'shipped';
  `));
  assert.strictEqual(countChanges(result), 3); // users, t, order_status
});

test('the sentence names what changed, and says so when nothing did', () => {
  // The dictionary is English here, so the wording can be asserted directly.
  const unchanged = diff(schema(BASE), schema(BASE));
  assert.strictEqual(describe(unchanged), 'Schema unchanged');
  assert.strictEqual(describe(null), 'Schema unchanged');

  const added = diff(schema(BASE), schema(BASE, 'CREATE TABLE t (x int);'));
  assert.strictEqual(describe(added), '1 new table');

  const mixed = diff(schema(BASE), schema(BASE, `
    CREATE TABLE t (x int);
    DROP TABLE legacy_carts;
    ALTER TABLE users ADD COLUMN a int;
    ALTER TYPE order_status ADD VALUE 'shipped';
  `));
  assert.strictEqual(describe(mixed), '1 new table · 1 removed table · 1 changed table · 1 enum change');
});
