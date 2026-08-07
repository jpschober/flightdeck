'use strict';
// The DDL reader: the pieces that turn migration text into a model.
//
//   node --test test/sql-ddl.test.js
//
// Split into the two things the module does. First the reading of the raw
// text - statement boundaries, identifiers, types, a single column definition.
// Then the replay: what the model looks like after a sequence of statements.
// The replay is what the DB panel shows, so the assertions there are on the
// model, not on the parser's intermediate results.

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_SCHEMA,
  createModel, applySql, applyStatement,
  splitStatements, splitTopLevel, readQualified, parseColumnDef, normalizeType,
} = require('../src/main/dbschema/sql-ddl');

/** The model after replaying `sql` - one migration or several in order. */
function model(...sql) {
  const m = createModel();
  for (const script of sql) applySql(m, script);
  return m;
}

function table(m, id) {
  const t = m.tables.get(id);
  assert.ok(t, `table ${id} is not in the model`);
  return t;
}

function column(m, id, name) {
  const c = table(m, id).columns.find((x) => x.name === name);
  assert.ok(c, `column ${name} is not in ${id}`);
  return c;
}

function constraint(m, id, name) {
  return table(m, id).constraints.find((x) => x.name === name) || null;
}

// ---------------------------------------------------------------------------
// splitStatements
// ---------------------------------------------------------------------------

test('a script is split at the semicolons, empty statements fall away', () => {
  assert.deepStrictEqual(
    splitStatements('CREATE TABLE a (id int);\n\n;  ;\nDROP TABLE a;\n'),
    ['CREATE TABLE a (id int)', 'DROP TABLE a'],
  );
});

test('a semicolon inside a string or a quoted identifier does not split', () => {
  const parts = splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0], `INSERT INTO t VALUES ('a;b')`);

  const quoted = splitStatements('CREATE TABLE "a;b" (id int); SELECT 1;');
  assert.strictEqual(quoted.length, 2);
  assert.strictEqual(quoted[0], 'CREATE TABLE "a;b" (id int)');
});

test('a doubled quote inside a literal is an escape, not the end of it', () => {
  const parts = splitStatements(`SELECT 'it''s; here'; SELECT 2;`);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0], `SELECT 'it''s; here'`);
});

test('line and block comments drop out, nested block comments too', () => {
  const parts = splitStatements(`
    -- a comment; with a semicolon
    SELECT 1;
    /* outer /* inner ; */ still outer ; */
    SELECT 2;
  `);
  assert.deepStrictEqual(parts, ['SELECT 1', 'SELECT 2']);
});

test('a dollar-quoted body keeps its semicolons', () => {
  const fn = `CREATE FUNCTION f() RETURNS trigger AS $$
BEGIN
  RAISE NOTICE 'x';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;
  const parts = splitStatements(`${fn}\nSELECT 1;`);
  assert.strictEqual(parts.length, 2);
  assert.match(parts[0], /RETURN NEW;/);
  assert.strictEqual(parts[1], 'SELECT 1');
});

test('a tagged dollar quote is only closed by its own tag', () => {
  const parts = splitStatements(`DO $body$ SELECT $$ inner ; $$; $body$; SELECT 1;`);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[1], 'SELECT 1');
});

test('an unterminated body swallows the rest instead of tearing it apart', () => {
  const parts = splitStatements('DO $$ BEGIN; SELECT 1;');
  assert.strictEqual(parts.length, 1);
});

// ---------------------------------------------------------------------------
// splitTopLevel and readQualified
// ---------------------------------------------------------------------------

test('only top-level commas split - not those in types, calls or literals', () => {
  assert.deepStrictEqual(
    splitTopLevel(`amount numeric(10,2), tags text[], note text DEFAULT 'a,b', CHECK (a in (1,2))`),
    ['amount numeric(10,2)', 'tags text[]', `note text DEFAULT 'a,b'`, 'CHECK (a in (1,2))'],
  );
});

test('a name is read with schema, without one, and quoted', () => {
  assert.deepStrictEqual(readQualified('public.users rest'), { schema: 'public', name: 'users', rest: ' rest' });
  assert.deepStrictEqual(readQualified('users rest'), { schema: null, name: 'users', rest: ' rest' });
  assert.deepStrictEqual(readQualified('db.public.users'), { schema: 'public', name: 'users', rest: '' });
  // Unquoted names are folded to lower case, quoted ones stay as they are
  assert.strictEqual(readQualified('Users').name, 'users');
  assert.strictEqual(readQualified('"Users"').name, 'Users');
  assert.strictEqual(readQualified('"a""b"').name, 'a"b');
  assert.strictEqual(readQualified('123'), null);
});

// ---------------------------------------------------------------------------
// normalizeType
// ---------------------------------------------------------------------------

test('aliases are resolved so that spelling alone is not a change', () => {
  assert.strictEqual(normalizeType('int'), 'integer');
  assert.strictEqual(normalizeType('INT4'), 'integer');
  assert.strictEqual(normalizeType('bool'), 'boolean');
  assert.strictEqual(normalizeType('decimal(10,2)'), 'numeric(10,2)');
  assert.strictEqual(normalizeType('varchar (255)'), 'character varying(255)');
  assert.strictEqual(normalizeType('timestamptz'), 'timestamp with time zone');
  assert.strictEqual(normalizeType('serial'), 'integer');
});

test('precision and array stay, whitespace is unified', () => {
  assert.strictEqual(normalizeType('  NUMERIC ( 10 , 2 )  '), 'numeric(10,2)');
  assert.strictEqual(normalizeType('text []'), 'text[]');
  assert.strictEqual(normalizeType('varchar(20)[]'), 'character varying(20)[]');
  assert.strictEqual(normalizeType(''), '');
});

test('the precision of a timestamp keeps its place in the middle of the name', () => {
  assert.strictEqual(normalizeType('timestamp(3) with time zone'), 'timestamp(3) with time zone');
  assert.strictEqual(normalizeType('TIMESTAMP WITHOUT TIME ZONE'), 'timestamp without time zone');
  assert.strictEqual(normalizeType('timestamp'), 'timestamp without time zone');
});

test('a custom type is left alone, quoted or with a schema', () => {
  assert.strictEqual(normalizeType('public.order_status'), 'public.order_status');
  assert.strictEqual(normalizeType('"Order_Status"'), '"Order_Status"');
  // The alias table must not reach into a schema-qualified name
  assert.strictEqual(normalizeType('my.int'), 'my.int');
});

// ---------------------------------------------------------------------------
// parseColumnDef
// ---------------------------------------------------------------------------

test('a column definition is split into column and its own constraints', () => {
  const { column: col, constraints } = parseColumnDef(
    `email varchar(255) NOT NULL UNIQUE DEFAULT 'x@y.z' CHECK (position('@' in email) > 1)`,
  );
  assert.strictEqual(col.name, 'email');
  assert.strictEqual(col.type, 'character varying(255)');
  assert.strictEqual(col.nullable, false);
  assert.strictEqual(col.default, `'x@y.z'`);
  assert.deepStrictEqual(constraints.map((c) => c.kind), ['unique', 'check']);
  assert.strictEqual(constraints[1].expression, `position('@' in email) > 1`);
});

test('SERIAL is integer plus sequence plus NOT NULL', () => {
  const { column: col } = parseColumnDef('id bigserial PRIMARY KEY');
  assert.strictEqual(col.type, 'bigint');
  assert.strictEqual(col.identity, true);
  assert.strictEqual(col.nullable, false);
  assert.ok(col.default, 'the sequence default is missing');
});

test('a named column constraint keeps its name, the next one does not inherit it', () => {
  const { constraints } = parseColumnDef(
    'user_id uuid CONSTRAINT fk_user REFERENCES auth.users (id) ON DELETE CASCADE UNIQUE',
  );
  assert.strictEqual(constraints[0].kind, 'fk');
  assert.strictEqual(constraints[0].name, 'fk_user');
  assert.deepStrictEqual(constraints[0].references, { schema: 'auth', table: 'users', columns: ['id'] });
  assert.strictEqual(constraints[0].onDelete, 'cascade');
  assert.strictEqual(constraints[1].kind, 'unique');
  assert.strictEqual(constraints[1].name, null);
});

test('GENERATED reaches the column: identity and computed column', () => {
  const identity = parseColumnDef('id int GENERATED ALWAYS AS IDENTITY (START WITH 5)').column;
  assert.strictEqual(identity.identity, true);
  assert.strictEqual(identity.nullable, false);

  const computed = parseColumnDef('total numeric GENERATED ALWAYS AS (price * qty) STORED').column;
  assert.strictEqual(computed.generated, 'price * qty');
  assert.strictEqual(computed.identity, false);
});

test('an unknown keyword costs a token, it does not get stuck', () => {
  const { column: col } = parseColumnDef('a text NOT NULL COMPRESSION pglz WHATEVER NULL');
  assert.strictEqual(col.type, 'text');
  // The last NULL wins - what matters is that parsing arrives there at all
  assert.strictEqual(col.nullable, true);
});

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

test('a table lands in the default schema with its columns in the written order', () => {
  const m = model(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const t = table(m, `${DEFAULT_SCHEMA}.users`);
  assert.strictEqual(t.schema, 'public');
  assert.deepStrictEqual(t.columns.map((c) => c.name), ['id', 'email', 'created_at']);
  assert.strictEqual(column(m, 'public.users', 'id').default, 'gen_random_uuid()');
  assert.strictEqual(column(m, 'public.users', 'created_at').type, 'timestamp with time zone');
  assert.deepStrictEqual(t.constraints.map((c) => [c.kind, c.name]), [['pk', 'users_pkey']]);
});

test('a table-level constraint reaches the table, a PK makes its columns NOT NULL', () => {
  const m = model(`
    CREATE TABLE memberships (
      org_id uuid,
      user_id uuid,
      role text,
      PRIMARY KEY (org_id, user_id),
      CONSTRAINT memberships_role_check CHECK (role in ('owner','member')),
      FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE ON UPDATE RESTRICT
    );
  `);
  const t = table(m, 'public.memberships');
  assert.strictEqual(column(m, 'public.memberships', 'org_id').nullable, false);
  assert.strictEqual(column(m, 'public.memberships', 'user_id').nullable, false);
  assert.strictEqual(column(m, 'public.memberships', 'role').nullable, true);

  const pk = t.constraints.find((c) => c.kind === 'pk');
  assert.deepStrictEqual(pk.columns, ['org_id', 'user_id']);
  const fk = t.constraints.find((c) => c.kind === 'fk');
  assert.strictEqual(fk.name, 'memberships_user_id_fkey');
  assert.strictEqual(fk.onDelete, 'cascade');
  assert.strictEqual(fk.onUpdate, 'restrict');
});

test('unnamed constraints get the Postgres name, collisions are numbered', () => {
  const m = model(`
    CREATE TABLE t (
      a int CHECK (a > 0),
      b int,
      CHECK (a > b)
    );
  `);
  const names = table(m, 'public.t').constraints.filter((c) => c.kind === 'check').map((c) => c.name);
  assert.deepStrictEqual(names, ['t_a_check', 't_check']);

  const twice = model('CREATE TABLE t (a int CHECK (a > 0) CHECK (a < 10));');
  assert.deepStrictEqual(
    table(twice, 'public.t').constraints.map((c) => c.name),
    ['t_a_check', 't_a_check1'],
  );
});

test('a schema-qualified table stays in its schema', () => {
  const m = model('CREATE TABLE auth.sessions (id uuid PRIMARY KEY);');
  assert.ok(m.tables.has('auth.sessions'));
  assert.strictEqual(table(m, 'auth.sessions').schema, 'auth');
});

test('LIKE and INHERITS are not columns', () => {
  const m = model('CREATE TABLE t (LIKE other INCLUDING ALL, a int) INHERITS (base);');
  assert.deepStrictEqual(table(m, 'public.t').columns.map((c) => c.name), ['a']);
  assert.deepStrictEqual(m.warnings, []);
});

test('a table without a column list is a warning, not a table', () => {
  const m = model('CREATE TABLE snapshot AS SELECT * FROM users;');
  assert.strictEqual(m.tables.size, 0);
  assert.match(m.warnings.join('\n'), /snapshot/);
});

// ---------------------------------------------------------------------------
// ALTER TABLE
// ---------------------------------------------------------------------------

test('a later migration adds, changes and drops columns', () => {
  const m = model(
    'CREATE TABLE posts (id uuid PRIMARY KEY, title text, draft boolean);',
    `
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS body text NOT NULL DEFAULT '';
      ALTER TABLE posts ALTER COLUMN title SET NOT NULL;
      ALTER TABLE posts ALTER COLUMN title TYPE varchar(200);
      ALTER TABLE posts DROP COLUMN draft;
    `,
  );
  const t = table(m, 'public.posts');
  assert.deepStrictEqual(t.columns.map((c) => c.name), ['id', 'title', 'body']);
  assert.strictEqual(column(m, 'public.posts', 'title').nullable, false);
  assert.strictEqual(column(m, 'public.posts', 'title').type, 'character varying(200)');
  assert.strictEqual(column(m, 'public.posts', 'body').default, `''`);
});

test('several actions in one ALTER are applied one after another', () => {
  const m = model(
    'CREATE TABLE t (a int, b int);',
    'ALTER TABLE t ADD COLUMN c text, DROP COLUMN b, ALTER COLUMN a SET DEFAULT 0;',
  );
  assert.deepStrictEqual(table(m, 'public.t').columns.map((c) => c.name), ['a', 'c']);
  assert.strictEqual(column(m, 'public.t', 'a').default, '0');
});

test('adding an existing column again does not duplicate it', () => {
  const m = model(
    'CREATE TABLE t (a int);',
    'ALTER TABLE t ADD COLUMN IF NOT EXISTS a int;',
  );
  assert.strictEqual(table(m, 'public.t').columns.length, 1);
});

test('SET and DROP DEFAULT / NOT NULL walk both ways', () => {
  const m = model(
    `CREATE TABLE t (a text NOT NULL DEFAULT 'x');`,
    'ALTER TABLE t ALTER COLUMN a DROP NOT NULL;',
    'ALTER TABLE t ALTER COLUMN a DROP DEFAULT;',
  );
  assert.strictEqual(column(m, 'public.t', 'a').nullable, true);
  assert.strictEqual(column(m, 'public.t', 'a').default, null);
});

test('a USING clause is not part of the new type', () => {
  const m = model(
    'CREATE TABLE t (a text);',
    'ALTER TABLE t ALTER COLUMN a TYPE integer USING a::integer;',
  );
  assert.strictEqual(column(m, 'public.t', 'a').type, 'integer');
});

test('a dropped column takes every constraint that names it with it', () => {
  const m = model(
    'CREATE TABLE t (a int UNIQUE, b int, c int, UNIQUE (a, b), UNIQUE (b, c));',
    'ALTER TABLE t DROP COLUMN a;',
  );
  const remaining = table(m, 'public.t').constraints.map((c) => c.columns.join(','));
  assert.deepStrictEqual(remaining, ['b,c'], 'a constraint over the dropped column is left over');
});

test('ADD CONSTRAINT and DROP CONSTRAINT reach the table', () => {
  const m = model(
    'CREATE TABLE t (a int, b int);',
    'ALTER TABLE t ADD CONSTRAINT t_ab_key UNIQUE (a, b);',
    'ALTER TABLE t ADD PRIMARY KEY (a);',
  );
  assert.ok(constraint(m, 'public.t', 't_ab_key'));
  assert.strictEqual(column(m, 'public.t', 'a').nullable, false);

  const dropped = model(
    'CREATE TABLE t (a int, b int);',
    'ALTER TABLE t ADD CONSTRAINT t_ab_key UNIQUE (a, b);',
    'ALTER TABLE t DROP CONSTRAINT IF EXISTS t_ab_key;',
  );
  assert.strictEqual(constraint(dropped, 'public.t', 't_ab_key'), null);
});

test('a renamed column is renamed in its constraints as well', () => {
  const m = model(
    'CREATE TABLE t (a int, b int, CONSTRAINT t_ab_key UNIQUE (a, b));',
    'ALTER TABLE t RENAME COLUMN a TO c;',
  );
  assert.deepStrictEqual(table(m, 'public.t').columns.map((x) => x.name), ['c', 'b']);
  assert.deepStrictEqual(constraint(m, 'public.t', 't_ab_key').columns, ['c', 'b']);
});

test('a renamed constraint keeps its content', () => {
  const m = model(
    'CREATE TABLE t (a int, CONSTRAINT old_name CHECK (a > 0));',
    'ALTER TABLE t RENAME CONSTRAINT old_name TO new_name;',
  );
  assert.strictEqual(constraint(m, 'public.t', 'old_name'), null);
  assert.strictEqual(constraint(m, 'public.t', 'new_name').expression, 'a > 0');
});

test('a renamed or moved table is found again under the new key', () => {
  const renamed = model('CREATE TABLE t (a int);', 'ALTER TABLE t RENAME TO u;');
  assert.ok(!renamed.tables.has('public.t'));
  assert.strictEqual(table(renamed, 'public.u').name, 'u');

  const moved = model('CREATE TABLE t (a int);', 'ALTER TABLE public.t SET SCHEMA archive;');
  assert.ok(!moved.tables.has('public.t'));
  assert.strictEqual(table(moved, 'archive.t').schema, 'archive');
});

test('ALTER on an unknown table is a warning', () => {
  const m = model('ALTER TABLE ghosts ADD COLUMN a int;');
  assert.strictEqual(m.tables.size, 0);
  assert.match(m.warnings.join('\n'), /ghosts/);
});

test('DROP TABLE removes it, several names in one statement as well', () => {
  const m = model(
    'CREATE TABLE a (x int); CREATE TABLE b (x int); CREATE TABLE c (x int);',
    'DROP TABLE IF EXISTS a, b CASCADE;',
  );
  assert.deepStrictEqual([...m.tables.keys()], ['public.c']);
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

test('an enum is created, extended, reordered, renamed and dropped', () => {
  const m = model(`CREATE TYPE order_status AS ENUM ('new', 'paid');`);
  assert.deepStrictEqual(m.enums.get('public.order_status').values, ['new', 'paid']);

  applySql(m, `ALTER TYPE order_status ADD VALUE 'shipped';`);
  applySql(m, `ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'new';`);
  applySql(m, `ALTER TYPE order_status ADD VALUE 'cancelled' AFTER 'paid';`);
  assert.deepStrictEqual(
    m.enums.get('public.order_status').values,
    ['draft', 'new', 'paid', 'cancelled', 'shipped'],
  );

  // A value that is already there stays where it is
  applySql(m, `ALTER TYPE order_status ADD VALUE 'paid';`);
  assert.strictEqual(m.enums.get('public.order_status').values.filter((v) => v === 'paid').length, 1);

  applySql(m, `ALTER TYPE order_status RENAME VALUE 'draft' TO 'pending';`);
  assert.strictEqual(m.enums.get('public.order_status').values[0], 'pending');

  applySql(m, 'ALTER TYPE order_status RENAME TO status;');
  assert.ok(!m.enums.has('public.order_status'));
  assert.strictEqual(m.enums.get('public.status').name, 'status');

  applySql(m, 'DROP TYPE IF EXISTS status;');
  assert.strictEqual(m.enums.size, 0);
});

test('only enums are taken over from CREATE TYPE', () => {
  const m = model('CREATE TYPE point3 AS (x int, y int, z int);');
  assert.strictEqual(m.enums.size, 0);
});

test('a quoted apostrophe in an enum value survives', () => {
  const m = model(`CREATE TYPE t AS ENUM ('it''s');`);
  assert.deepStrictEqual(m.enums.get('public.t').values, ["it's"]);
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

test('an index becomes a constraint of its table, with method and WHERE', () => {
  const m = model(
    'CREATE TABLE users (id uuid, email text, deleted_at timestamptz);',
    `CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (lower(email))
       WHERE deleted_at IS NULL;`,
  );
  const idx = constraint(m, 'public.users', 'users_email_idx');
  assert.strictEqual(idx.kind, 'index');
  assert.strictEqual(idx.unique, true);
  assert.strictEqual(idx.method, 'btree');
  assert.deepStrictEqual(idx.columns, ['lower(email)']);
  assert.strictEqual(idx.expression, 'deleted_at IS NULL');
});

test('an index without a name gets one, DROP INDEX takes it away again', () => {
  const m = model(
    'CREATE TABLE t (a int);',
    'CREATE INDEX ON t (a);',
  );
  const idx = table(m, 'public.t').constraints.find((c) => c.kind === 'index');
  assert.ok(idx.name, 'the index has no name');
  assert.strictEqual(idx.unique, false);

  applySql(m, `DROP INDEX CONCURRENTLY IF EXISTS ${idx.name};`);
  assert.strictEqual(table(m, 'public.t').constraints.filter((c) => c.kind === 'index').length, 0);
});

test('an index on an unknown table is skipped without an error', () => {
  const m = model('CREATE INDEX i ON ghosts (a);');
  assert.strictEqual(m.tables.size, 0);
});

// ---------------------------------------------------------------------------
// RLS and policies
// ---------------------------------------------------------------------------

test('RLS and a policy reach the table', () => {
  const m = model(
    'CREATE TABLE docs (id uuid, owner uuid);',
    `
      ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "owner reads" ON docs FOR SELECT TO authenticated, anon
        USING (owner = auth.uid());
    `,
  );
  const t = table(m, 'public.docs');
  assert.strictEqual(t.rls.enabled, true);
  assert.strictEqual(t.rls.policies.length, 1);
  const p = t.rls.policies[0];
  assert.strictEqual(p.name, 'owner reads');
  assert.strictEqual(p.command, 'select');
  assert.strictEqual(p.permissive, true);
  assert.deepStrictEqual(p.roles, ['authenticated', 'anon']);
  assert.strictEqual(p.using, 'owner = auth.uid()');
  assert.strictEqual(p.check, null);
});

test('WITH CHECK, RESTRICTIVE and the default command are read', () => {
  const m = model(
    'CREATE TABLE docs (id uuid, owner uuid);',
    `CREATE POLICY p ON docs AS RESTRICTIVE TO authenticated
       USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());`,
  );
  const p = table(m, 'public.docs').rls.policies[0];
  assert.strictEqual(p.command, 'all');
  assert.strictEqual(p.permissive, false);
  assert.strictEqual(p.check, 'owner = auth.uid()');
});

test('a policy of the same name replaces the old one', () => {
  // The migration sequence of a project that redefines a policy without
  // dropping it first - it must not end up in the schema twice.
  const m = model(
    'CREATE TABLE docs (id uuid);',
    'CREATE POLICY p ON docs FOR SELECT USING (true);',
    'CREATE POLICY p ON docs FOR INSERT WITH CHECK (false);',
  );
  const policies = table(m, 'public.docs').rls.policies;
  assert.strictEqual(policies.length, 1);
  assert.strictEqual(policies[0].command, 'insert');
});

test('DROP POLICY removes it, a new one of the same name starts over', () => {
  const m = model(
    'CREATE TABLE docs (id uuid);',
    'CREATE POLICY p ON docs FOR SELECT USING (true);',
    'DROP POLICY p ON docs;',
  );
  assert.deepStrictEqual(table(m, 'public.docs').rls.policies, []);

  applySql(m, 'CREATE POLICY p ON docs FOR INSERT WITH CHECK (false);');
  assert.strictEqual(table(m, 'public.docs').rls.policies[0].command, 'insert');
});

test('ENABLE ROW LEVEL SECURITY creates a placeholder for a foreign table', () => {
  const m = model('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  const t = table(m, 'storage.objects');
  assert.strictEqual(t.external, true);
  assert.strictEqual(t.rls.enabled, true);
  assert.deepStrictEqual(t.columns, []);
  assert.deepStrictEqual(m.warnings, []);
});

test('a policy on a foreign table belongs to the project as well', () => {
  const m = model(`CREATE POLICY "public read" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');`);
  const t = table(m, 'storage.objects');
  assert.strictEqual(t.external, true);
  assert.strictEqual(t.rls.policies[0].name, 'public read');
});

// ---------------------------------------------------------------------------
// COMMENT ON
// ---------------------------------------------------------------------------

test('a comment reaches table and column, NULL takes it away again', () => {
  const m = model(
    'CREATE TABLE users (id uuid, email text);',
    `
      COMMENT ON TABLE public.users IS 'The people';
      COMMENT ON COLUMN public.users.email IS 'lower case, unique';
    `,
  );
  assert.strictEqual(table(m, 'public.users').comment, 'The people');
  assert.strictEqual(column(m, 'public.users', 'email').comment, 'lower case, unique');

  applySql(m, 'COMMENT ON TABLE users IS NULL;');
  assert.strictEqual(table(m, 'public.users').comment, null);
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('what is not DDL says nothing about the schema and stays silent', () => {
  const m = model(`
    GRANT SELECT ON users TO anon;
    INSERT INTO users (id) VALUES ('x');
    CREATE TRIGGER trg BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();
  `);
  assert.strictEqual(m.tables.size, 0);
  assert.deepStrictEqual(m.warnings, []);
});

test('a statement that throws becomes a warning, the following one still runs', () => {
  const m = createModel();
  // The throw is provoked by a table without a `columns` list, which the
  // reader itself never builds - if a guard is added there one day, this test
  // needs another way to make a statement fail. What it is about is applySql:
  // a failed statement is a warning, not an aborted migration sequence.
  m.tables.set('public.broken', { schema: 'public', name: 'broken' });
  applySql(m, 'ALTER TABLE broken ADD COLUMN a int; CREATE TABLE ok (x int);');
  assert.ok(m.tables.has('public.ok'), 'the replay stopped at the failed statement');
  assert.strictEqual(m.warnings.length, 1);
  assert.match(m.warnings[0], /ALTER TABLE broken/);
});

test('warnings stay unique and bounded', () => {
  const m = createModel();
  for (let i = 0; i < 60; i++) applySql(m, `ALTER TABLE ghost${i} ADD COLUMN a int;`);
  assert.strictEqual(m.warnings.length, 40);
  assert.strictEqual(new Set(m.warnings).size, 40);

  const same = createModel();
  for (let i = 0; i < 5; i++) applySql(same, 'ALTER TABLE ghost ADD COLUMN a int;');
  assert.strictEqual(same.warnings.length, 1);
});

test('applyStatement takes a single statement without a semicolon', () => {
  const m = createModel();
  applyStatement(m, '  CREATE TABLE t (a int)  ');
  assert.ok(m.tables.has('public.t'));
});

test('a mixed sequence of qualified and unqualified names hits the same table', () => {
  const m = model(
    'CREATE TABLE public.users (id uuid);',
    'ALTER TABLE users ADD COLUMN email text;',
    'COMMENT ON TABLE users IS \'x\';',
  );
  assert.strictEqual(m.tables.size, 1);
  assert.deepStrictEqual(table(m, 'public.users').columns.map((c) => c.name), ['id', 'email']);
});
