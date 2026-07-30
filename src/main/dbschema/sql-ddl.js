'use strict';
// Minimaler Postgres-DDL-Leser.
//
// Eine Migration ist kein fertiges Schema, sondern eine Folge von Anweisungen:
// erst CREATE TABLE, drei Dateien spaeter ADD COLUMN, dann DROP CONSTRAINT. Wie
// das Schema *jetzt* aussieht, weiss man erst, wenn man die Anweisungen der
// Reihe nach auf einem Modell nachspielt - genau das tut dieses Modul.
//
// Bewusst ohne SQL-Parser-Paket: der Renderer darf per CSP keine fremden
// Skripte laden, und im Main-Prozess wollen wir uns fuer ein Panel keine
// Abhaengigkeit dieser Groesse einkaufen. Abgedeckt ist der DDL-Anteil, den
// Migrationswerkzeuge tatsaechlich erzeugen. Was nicht verstanden wird, wird
// uebersprungen und als Warnung gemeldet - ein unvollstaendiges Schema mit
// Hinweis ist brauchbar, ein Absturz nicht.

const DEFAULT_SCHEMA = 'public';

// ---------------------------------------------------------------------------
// Zerlegen: Kommentare weg, an Semikolons auf oberster Ebene trennen
// ---------------------------------------------------------------------------

/**
 * Trennt ein SQL-Skript in einzelne Anweisungen. Beachtet Zeilen- und
 * Blockkommentare, Zeichenketten, zitierte Bezeichner und Dollar-Quoting
 * ($$ ... $$), in dem Funktions- und Policy-Rumpfe stecken - dort darf ein
 * Semikolon nicht trennen.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl; // das \n selbst bleibt als Trenner erhalten
      buf += ' ';
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1; // Blockkommentare sind in Postgres verschachtelbar
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      buf += ' ';
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = scanQuoted(sql, i);
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const stop = close === -1 ? n : close + tag[0].length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === ';') { out.push(buf); buf = ''; i++; continue; }

    buf += ch;
    i++;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Index hinter dem schliessenden Anfuehrungszeichen ab `at`. */
function scanQuoted(s, at) {
  const q = s[at];
  let j = at + 1;
  while (j < s.length) {
    if (s[j] === q && s[j + 1] === q) { j += 2; continue; } // '' bzw. "" = escape
    if (s[j] === q) return j + 1;
    j++;
  }
  return s.length;
}

// ---------------------------------------------------------------------------
// Hilfsmittel: geklammerte und zitierte Bereiche ausblenden
// ---------------------------------------------------------------------------

/**
 * Ersetzt alles innerhalb von Klammern und Anfuehrungszeichen durch
 * Leerzeichen, laengengleich. Darauf laesst sich nach Schluesselwoertern und Kommas auf
 * oberster Ebene suchen, ohne in Ausdruecke wie `numeric(10,2)` oder
 * `check (status <> 'default')` hineinzugreifen.
 */
function maskNested(s) {
  const a = s.split('');
  let depth = 0;
  let i = 0;
  while (i < a.length) {
    const c = a[i];
    if (depth === 0 && (c === "'" || c === '"')) {
      const end = scanQuoted(s, i);
      for (let k = i; k < end; k++) a[k] = ' ';
      i = end;
      continue;
    }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth > 0) a[i] = ' ';
    i++;
  }
  return a.join('');
}

/** Teilt an Kommas der obersten Ebene. */
function splitTopLevel(s, sep = ',') {
  const masked = maskNested(s);
  const parts = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === sep) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Erster Treffer von `re` auf oberster Ebene, oder null. */
function findTopLevel(s, re) {
  const m = re.exec(maskNested(s));
  return m ? { index: m.index, length: m[0].length } : null;
}

/** Index der zur Klammer bei `at` gehoerenden schliessenden Klammer. */
function matchParen(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { i = scanQuoted(s, i) - 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Inhalt der Klammer am Anfang von `s` plus Rest dahinter. */
function readParens(s) {
  const t = s.trimStart();
  if (!t.startsWith('(')) return null;
  const end = matchParen(t, 0);
  if (end === -1) return null;
  return { inner: t.slice(1, end), rest: t.slice(end + 1) };
}

// ---------------------------------------------------------------------------
// Bezeichner
// ---------------------------------------------------------------------------
// Unzitierte Bezeichner duerfen ausser Buchstaben, Ziffern, _ und $ auch
// Nicht-ASCII enthalten; Klammern, Punkt und Komma beenden sie.
const IDENT_RE = /^(?:"((?:[^"]|"")*)"|([A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*))/;

/** Liest einen Bezeichner. Unzitierte faltet Postgres auf Kleinschreibung. */
function readIdent(s) {
  const m = IDENT_RE.exec(s.trimStart());
  if (!m) return null;
  const t = s.trimStart();
  return {
    name: m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2].toLowerCase(),
    rest: t.slice(m[0].length),
  };
}

/** Liest `name`, `schema.name` oder `db.schema.name`. */
function readQualified(s) {
  const first = readIdent(s);
  if (!first) return null;
  const parts = [first.name];
  let rest = first.rest;
  while (rest.trimStart().startsWith('.')) {
    const next = readIdent(rest.trimStart().slice(1));
    if (!next) break;
    parts.push(next.name);
    rest = next.rest;
  }
  return {
    schema: parts.length > 1 ? parts[parts.length - 2] : null,
    name: parts[parts.length - 1],
    rest,
  };
}

/** Liest eine Spaltenliste `(a, b)`. Ausdruecke bleiben als Text stehen. */
function readColumnList(s) {
  const p = readParens(s);
  if (!p) return null;
  const columns = splitTopLevel(p.inner).map((part) => {
    const id = readIdent(part);
    // Ein Ausdrucks-Index (`lower(email)`) ist keine Spalte - Text behalten
    return id && !id.rest.trim() ? id.name : squash(part);
  });
  return { columns, rest: p.rest };
}

function squash(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------
// Echte Aliase zusammenfuehren, sonst meldet der Diff eine Aenderung, wo sich
// nur die Schreibweise geaendert hat (`varchar` -> `character varying`).
const TYPE_ALIASES = new Map([
  ['int', 'integer'], ['int4', 'integer'],
  ['int2', 'smallint'], ['int8', 'bigint'],
  ['serial', 'integer'], ['serial4', 'integer'],
  ['bigserial', 'bigint'], ['serial8', 'bigint'],
  ['smallserial', 'smallint'], ['serial2', 'smallint'],
  ['varchar', 'character varying'], ['char', 'character'],
  ['bpchar', 'character'],
  ['bool', 'boolean'],
  ['float', 'double precision'], ['float8', 'double precision'],
  ['float4', 'real'],
  ['decimal', 'numeric'],
  ['timestamptz', 'timestamp with time zone'],
  ['timetz', 'time with time zone'],
  ['timestamp', 'timestamp without time zone'],
  ['time', 'time without time zone'],
]);

const SERIAL_RE = /^(?:big|small)?serial[248]?$/i;

/**
 * Normalisiert eine Typangabe: Schluesselwoerter klein, Whitespace einheitlich,
 * bekannte Aliase aufgeloest. Array- und Praezisionsangaben bleiben erhalten.
 */
function normalizeType(raw) {
  let t = squash(raw);
  if (!t) return '';
  // Praezision/Array vom Basisnamen trennen: `varchar(255)[]` -> `varchar` + Rest
  const m = /^([^([]+?)\s*((?:\(.*\))?(?:\s*\[[^\]]*\])*)$/.exec(t);
  if (!m) return t.toLowerCase();
  let base = squash(m[1]);
  const suffix = squash(m[2]).replace(/\s*\(\s*/, '(').replace(/\s*\)/, ')').replace(/\s*,\s*/g, ',');
  // Zitierte bzw. qualifizierte Typen (eigene Enums) unangetastet lassen
  if (base.includes('"')) return base + suffix;
  base = base.toLowerCase();
  const short = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base;
  // `timestamp(3) with time zone`: die Praezision steht mitten im Namen
  if (/^timestamp\b/.test(base) || /^time\b/.test(base)) {
    if (/with\s+time\s+zone/.test(base)) return (base.startsWith('timestamp') ? 'timestamp' : 'time') + suffix + ' with time zone';
    if (/without\s+time\s+zone/.test(base)) return (base.startsWith('timestamp') ? 'timestamp' : 'time') + suffix + ' without time zone';
  }
  if (!base.includes('.') && TYPE_ALIASES.has(short)) return TYPE_ALIASES.get(short) + suffix;
  return base + suffix;
}

// ---------------------------------------------------------------------------
// Modell
// ---------------------------------------------------------------------------
function createModel() {
  return {
    tables: new Map(), // "schema.name" -> Tabelle
    enums: new Map(),  // "schema.name" -> { schema, name, values }
    warnings: [],
  };
}

function keyOf(schema, name) {
  return `${schema || DEFAULT_SCHEMA}.${name}`;
}

function warn(model, message) {
  if (model.warnings.length < 40 && !model.warnings.includes(message)) {
    model.warnings.push(message);
  }
}

function firstWords(s, count = 6) {
  return squash(s).split(' ').slice(0, count).join(' ');
}

function getTable(model, schema, name) {
  // Ohne Schemaangabe zuerst im Standardschema suchen, dann irgendwo -
  // Migrationen mischen `public.x` und `x` munter durcheinander.
  const direct = model.tables.get(keyOf(schema, name));
  if (direct) return direct;
  if (schema) return null;
  for (const t of model.tables.values()) if (t.name === name) return t;
  return null;
}

function findColumn(table, name) {
  return table.columns.find((c) => c.name === name) || null;
}

/**
 * Platzhalter fuer eine Tabelle, die die Migrationen nicht selbst anlegen, auf
 * der sie aber den Zugriff regeln - etwa `storage.objects` bei Supabase. Die
 * Spalten kennen wir nicht (`external: true`), die selbst geschriebenen
 * Policies sind aber sehr wohl Teil des Projekts und gehoeren in den Vergleich:
 * wer welche Dateien lesen darf, ist genau die Art Aenderung, die auffallen soll.
 */
function externalTable(model, schema, name) {
  const key = keyOf(schema, name);
  const existing = model.tables.get(key);
  if (existing) return existing;
  const table = {
    schema: schema || DEFAULT_SCHEMA,
    name,
    external: true,
    columns: [],
    constraints: [],
    rls: { enabled: false, policies: [] },
    comment: null,
  };
  model.tables.set(key, table);
  return table;
}

/** Postgres-Standardnamen, damit unbenannte Constraints im Diff wiedererkannt werden. */
function defaultConstraintName(table, kind, columns) {
  const cols = (columns || []).join('_');
  const suffix = { pk: 'pkey', unique: 'key', fk: 'fkey', check: 'check', exclude: 'excl', index: 'idx' }[kind] || kind;
  if (kind === 'pk') return `${table.name}_pkey`;
  return cols ? `${table.name}_${cols}_${suffix}` : `${table.name}_${suffix}`;
}

function addConstraint(table, c) {
  if (!c.name) c.name = defaultConstraintName(table, c.kind, c.columns);
  // Kollision unbenannter Constraints wie Postgres durchnummerieren
  if (table.constraints.some((x) => x.name === c.name)) {
    let i = 1;
    while (table.constraints.some((x) => x.name === `${c.name}${i}`)) i++;
    c.name = `${c.name}${i}`;
  }
  table.constraints.push(c);
}

// ---------------------------------------------------------------------------
// Spaltendefinition
// ---------------------------------------------------------------------------
// Schluesselwoerter, an denen die Typangabe endet. `with`/`without` fehlen hier
// bewusst - sie gehoeren zu `timestamp with time zone`.
const COL_STOP_RE = /\b(?:CONSTRAINT|PRIMARY\s+KEY|NOT\s+NULL|NULL|DEFAULT|REFERENCES|UNIQUE|CHECK|GENERATED|COLLATE|DEFERRABLE|INITIALLY|NO\s+INHERIT|STORAGE|COMPRESSION)\b/i;

const REF_ACTION = '(?:NO\\s+ACTION|RESTRICT|CASCADE|SET\\s+NULL|SET\\s+DEFAULT)';

/** Liest MATCH/ON DELETE/ON UPDATE hinter einem REFERENCES. */
function readRefOptions(s) {
  let rest = s.trimStart();
  let onDelete = null;
  let onUpdate = null;
  for (let i = 0; i < 5; i++) {
    let m;
    if ((m = /^MATCH\s+(?:FULL|PARTIAL|SIMPLE)/i.exec(rest))) { rest = rest.slice(m[0].length).trimStart(); continue; }
    if ((m = new RegExp(`^ON\\s+DELETE\\s+(${REF_ACTION})`, 'i').exec(rest))) {
      onDelete = squash(m[1]).toLowerCase(); rest = rest.slice(m[0].length).trimStart(); continue;
    }
    if ((m = new RegExp(`^ON\\s+UPDATE\\s+(${REF_ACTION})`, 'i').exec(rest))) {
      onUpdate = squash(m[1]).toLowerCase(); rest = rest.slice(m[0].length).trimStart(); continue;
    }
    break;
  }
  return { onDelete, onUpdate, rest };
}

/**
 * Zerlegt `name typ [constraints...]`. Liefert die Spalte und die dabei
 * anfallenden Constraints (PRIMARY KEY, UNIQUE, REFERENCES, CHECK).
 */
function parseColumnDef(text) {
  const id = readIdent(text);
  if (!id) return null;

  const stop = findTopLevel(id.rest, COL_STOP_RE);
  const typeText = stop ? id.rest.slice(0, stop.index) : id.rest;
  const tail = stop ? id.rest.slice(stop.index) : '';

  const column = {
    name: id.name,
    type: normalizeType(typeText),
    nullable: true,
    default: null,
    identity: false,
    generated: null,
    comment: null,
  };

  // SERIAL ist Kurzschrift fuer integer + eigene Sequenz + NOT NULL
  if (SERIAL_RE.test(squash(typeText))) {
    column.identity = true;
    column.nullable = false;
    column.default = 'nextval(…)';
  }

  const constraints = parseColumnConstraints(tail, column);
  return { column, constraints };
}

function parseColumnConstraints(text, column) {
  const out = [];
  let s = text.trimStart();
  let name = null;

  for (let guard = 0; s && guard < 60; guard++) {
    let m;

    if ((m = /^CONSTRAINT\s+/i.exec(s))) {
      const id = readIdent(s.slice(m[0].length));
      if (!id) break;
      name = id.name;
      s = id.rest.trimStart();
      continue;
    }
    if ((m = /^PRIMARY\s+KEY/i.exec(s))) {
      out.push({ kind: 'pk', name, columns: [column.name] });
      column.nullable = false;
      name = null;
      s = s.slice(m[0].length).trimStart();
      continue;
    }
    if ((m = /^NOT\s+NULL/i.exec(s))) {
      column.nullable = false;
      s = s.slice(m[0].length).trimStart();
      continue;
    }
    if ((m = /^NULL\b/i.exec(s))) {
      column.nullable = true;
      s = s.slice(m[0].length).trimStart();
      continue;
    }
    if ((m = /^UNIQUE\b/i.exec(s))) {
      out.push({ kind: 'unique', name, columns: [column.name] });
      name = null;
      s = s.slice(m[0].length).trimStart();
      continue;
    }
    if ((m = /^DEFAULT\s+/i.exec(s))) {
      const after = s.slice(m[0].length);
      const end = findTopLevel(after, COL_STOP_RE);
      column.default = squash(end ? after.slice(0, end.index) : after);
      s = (end ? after.slice(end.index) : '').trimStart();
      continue;
    }
    if ((m = /^REFERENCES\s+/i.exec(s))) {
      const q = readQualified(s.slice(m[0].length));
      if (!q) break;
      const list = readColumnList(q.rest);
      const opts = readRefOptions(list ? list.rest : q.rest);
      out.push({
        kind: 'fk',
        name,
        columns: [column.name],
        references: { schema: q.schema, table: q.name, columns: list ? list.columns : [] },
        onDelete: opts.onDelete,
        onUpdate: opts.onUpdate,
      });
      name = null;
      s = opts.rest;
      continue;
    }
    if ((m = /^CHECK\s*(?=\()/i.exec(s))) {
      const p = readParens(s.slice(m[0].length));
      if (!p) break;
      out.push({ kind: 'check', name, columns: [column.name], expression: squash(p.inner) });
      name = null;
      s = p.rest.trimStart();
      continue;
    }
    if ((m = /^GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i.exec(s))) {
      column.identity = true;
      column.nullable = false;
      s = s.slice(m[0].length).trimStart();
      const p = readParens(s); // optionale Sequenz-Optionen
      if (p) s = p.rest.trimStart();
      continue;
    }
    if ((m = /^GENERATED\s+ALWAYS\s+AS\s*(?=\()/i.exec(s))) {
      const p = readParens(s.slice(m[0].length));
      if (!p) break;
      column.generated = squash(p.inner);
      s = p.rest.trimStart().replace(/^STORED\b/i, '').trimStart();
      continue;
    }
    if ((m = /^COLLATE\s+/i.exec(s))) {
      const id = readIdent(s.slice(m[0].length));
      s = id ? id.rest.trimStart() : '';
      continue;
    }
    if ((m = /^(?:NOT\s+)?DEFERRABLE|^INITIALLY\s+(?:DEFERRED|IMMEDIATE)|^NO\s+INHERIT/i.exec(s))) {
      s = s.slice(m[0].length).trimStart();
      continue;
    }

    // Unbekanntes Schluesselwort: ein Token weiter, damit nichts haengt
    const tok = /^\S+/.exec(s);
    if (!tok) break;
    s = s.slice(tok[0].length).trimStart();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constraints auf Tabellenebene
// ---------------------------------------------------------------------------
const TABLE_CONSTRAINT_RE = /^(?:CONSTRAINT\s+(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9$]*)\s+)?(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE)\b/i;

function parseTableConstraint(text) {
  let s = text.trimStart();
  let name = null;

  const cm = /^CONSTRAINT\s+/i.exec(s);
  if (cm) {
    const id = readIdent(s.slice(cm[0].length));
    if (!id) return null;
    name = id.name;
    s = id.rest.trimStart();
  }

  let m;
  if ((m = /^PRIMARY\s+KEY/i.exec(s))) {
    const list = readColumnList(s.slice(m[0].length));
    return list ? { kind: 'pk', name, columns: list.columns } : null;
  }
  if ((m = /^UNIQUE(?:\s+NULLS\s+(?:NOT\s+)?DISTINCT)?/i.exec(s))) {
    const list = readColumnList(s.slice(m[0].length));
    return list ? { kind: 'unique', name, columns: list.columns } : null;
  }
  if ((m = /^FOREIGN\s+KEY/i.exec(s))) {
    const list = readColumnList(s.slice(m[0].length));
    if (!list) return null;
    const rm = /^REFERENCES\s+/i.exec(list.rest.trimStart());
    if (!rm) return null;
    const q = readQualified(list.rest.trimStart().slice(rm[0].length));
    if (!q) return null;
    const target = readColumnList(q.rest);
    const opts = readRefOptions(target ? target.rest : q.rest);
    return {
      kind: 'fk',
      name,
      columns: list.columns,
      references: { schema: q.schema, table: q.name, columns: target ? target.columns : [] },
      onDelete: opts.onDelete,
      onUpdate: opts.onUpdate,
    };
  }
  if ((m = /^CHECK\s*(?=\()/i.exec(s))) {
    const p = readParens(s.slice(m[0].length));
    return p ? { kind: 'check', name, columns: [], expression: squash(p.inner) } : null;
  }
  if (/^EXCLUDE\b/i.test(s)) {
    return { kind: 'exclude', name, columns: [], expression: squash(s) };
  }
  return null;
}

/** Ein Element aus der Klammer eines CREATE TABLE: Spalte oder Constraint. */
function addTablePart(model, table, part) {
  if (/^(?:LIKE|INHERITS|PARTITION)\b/i.test(part.trimStart())) return;

  if (TABLE_CONSTRAINT_RE.test(part.trimStart())) {
    const c = parseTableConstraint(part);
    if (c) {
      addConstraint(table, c);
      if (c.kind === 'pk') {
        for (const name of c.columns) {
          const col = findColumn(table, name);
          if (col) col.nullable = false;
        }
      }
    } else {
      warn(model, `Constraint nicht gelesen: ${firstWords(part)}`);
    }
    return;
  }

  const parsed = parseColumnDef(part);
  if (!parsed) {
    warn(model, `Spalte nicht gelesen: ${firstWords(part)}`);
    return;
  }
  table.columns.push(parsed.column);
  for (const c of parsed.constraints) addConstraint(table, c);
}

// ---------------------------------------------------------------------------
// Anweisungen
// ---------------------------------------------------------------------------

function createTable(model, rest) {
  const s = rest.replace(/^\s*IF\s+NOT\s+EXISTS\s+/i, '');
  const q = readQualified(s);
  if (!q) return warn(model, 'CREATE TABLE ohne lesbaren Namen');

  const body = readParens(q.rest);
  if (!body) {
    // CREATE TABLE ... AS SELECT / PARTITION OF: Spalten stehen nicht dabei
    return warn(model, `CREATE TABLE ${q.name}: keine Spaltenliste`);
  }

  const table = {
    schema: q.schema || DEFAULT_SCHEMA,
    name: q.name,
    columns: [],
    constraints: [],
    rls: { enabled: false, policies: [] },
    comment: null,
  };
  model.tables.set(keyOf(table.schema, table.name), table);
  for (const part of splitTopLevel(body.inner)) addTablePart(model, table, part);
}

function dropTable(model, rest) {
  const s = rest.replace(/^\s*IF\s+EXISTS\s+/i, '')
    .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '');
  for (const part of splitTopLevel(s)) {
    const q = readQualified(part);
    if (!q) continue;
    const table = getTable(model, q.schema, q.name);
    if (table) model.tables.delete(keyOf(table.schema, table.name));
  }
}

function alterTable(model, rest) {
  let s = rest.replace(/^\s*IF\s+EXISTS\s+/i, '').replace(/^\s*ONLY\s+/i, '');
  const q = readQualified(s);
  if (!q) return warn(model, 'ALTER TABLE ohne lesbaren Namen');
  const table = getTable(model, q.schema, q.name);
  s = q.rest.trimStart();

  // RENAME ist keine Aktionsliste, sondern steht allein
  let m;
  if ((m = /^RENAME\s+(?:COLUMN\s+)?(?!TO\b|CONSTRAINT\b)/i.exec(s))) {
    const from = readIdent(s.slice(m[0].length));
    const to = from && readIdent(from.rest.trimStart().replace(/^TO\s+/i, ''));
    if (table && from && to) {
      const col = findColumn(table, from.name);
      if (col) {
        renameInConstraints(table, from.name, to.name);
        col.name = to.name;
      }
    }
    return;
  }
  if ((m = /^RENAME\s+CONSTRAINT\s+/i.exec(s))) {
    const from = readIdent(s.slice(m[0].length));
    const to = from && readIdent(from.rest.trimStart().replace(/^TO\s+/i, ''));
    if (table && from && to) {
      const c = table.constraints.find((x) => x.name === from.name);
      if (c) c.name = to.name;
    }
    return;
  }
  if ((m = /^RENAME\s+TO\s+/i.exec(s))) {
    const to = readIdent(s.slice(m[0].length));
    if (table && to) {
      model.tables.delete(keyOf(table.schema, table.name));
      table.name = to.name;
      model.tables.set(keyOf(table.schema, table.name), table);
    }
    return;
  }
  if (/^SET\s+SCHEMA\s+/i.test(s)) {
    const to = readIdent(s.replace(/^SET\s+SCHEMA\s+/i, ''));
    if (table && to) {
      model.tables.delete(keyOf(table.schema, table.name));
      table.schema = to.name;
      model.tables.set(keyOf(table.schema, table.name), table);
    }
    return;
  }

  let target = table;
  if (!target) {
    // `ENABLE ROW LEVEL SECURITY` auf einer fremden Tabelle sagt: die gibt es,
    // und dieses Projekt regelt ihren Zugriff. Dafuer legen wir einen
    // Platzhalter an. Alles andere (ADD COLUMN o. ae.) waere hingegen ein Zeichen,
    // dass wir die Definition verloren haben - das bleibt ein Hinweis.
    if (/ROW\s+LEVEL\s+SECURITY/i.test(s)) {
      target = externalTable(model, q.schema, q.name);
    } else {
      return warn(model, `ALTER TABLE ${q.name}: Tabelle unbekannt`);
    }
  }
  for (const action of splitTopLevel(s)) applyAlterAction(model, target, action);
}

function renameInConstraints(table, from, to) {
  for (const c of table.constraints) {
    if (c.columns) c.columns = c.columns.map((n) => (n === from ? to : n));
  }
}

function applyAlterAction(model, table, action) {
  let s = action.trimStart();
  let m;

  if ((m = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(s))) {
    const body = s.slice(m[0].length);
    // ADD CONSTRAINT / ADD PRIMARY KEY erkennt man am Schluesselwort
    if (TABLE_CONSTRAINT_RE.test(body.trimStart()) && !/^ADD\s+COLUMN/i.test(s)) {
      const c = parseTableConstraint(body);
      if (c) {
        addConstraint(table, c);
        if (c.kind === 'pk') {
          for (const name of c.columns) {
            const col = findColumn(table, name);
            if (col) col.nullable = false;
          }
        }
      } else warn(model, `ADD CONSTRAINT nicht gelesen: ${firstWords(body)}`);
      return;
    }
    const parsed = parseColumnDef(body);
    if (!parsed) return warn(model, `ADD COLUMN nicht gelesen: ${firstWords(body)}`);
    if (!findColumn(table, parsed.column.name)) table.columns.push(parsed.column);
    for (const c of parsed.constraints) addConstraint(table, c);
    return;
  }

  if ((m = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?/i.exec(s))) {
    const id = readIdent(s.slice(m[0].length));
    if (id) table.constraints = table.constraints.filter((c) => c.name !== id.name);
    return;
  }

  if ((m = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?/i.exec(s))) {
    const id = readIdent(s.slice(m[0].length));
    if (!id) return;
    table.columns = table.columns.filter((c) => c.name !== id.name);
    // Constraints, die nur diese Spalte betreffen, fallen mit ihr weg
    table.constraints = table.constraints.filter((c) =>
      !(c.columns && c.columns.length === 1 && c.columns[0] === id.name));
    return;
  }

  if ((m = /^ALTER\s+(?:COLUMN\s+)?/i.exec(s))) {
    const id = readIdent(s.slice(m[0].length));
    if (!id) return;
    const col = findColumn(table, id.name);
    if (!col) return;
    const tail = id.rest.trimStart();
    let a;
    if ((a = /^(?:SET\s+DATA\s+)?TYPE\s+/i.exec(tail))) {
      const after = tail.slice(a[0].length);
      const using = findTopLevel(after, /\bUSING\b/i);
      col.type = normalizeType(using ? after.slice(0, using.index) : after);
      return;
    }
    if (/^SET\s+NOT\s+NULL/i.test(tail)) { col.nullable = false; return; }
    if (/^DROP\s+NOT\s+NULL/i.test(tail)) { col.nullable = true; return; }
    if ((a = /^SET\s+DEFAULT\s+/i.exec(tail))) { col.default = squash(tail.slice(a[0].length)); return; }
    if (/^DROP\s+DEFAULT/i.test(tail)) { col.default = null; return; }
    if (/^(?:ADD|DROP)\s+GENERATED/i.test(tail)) {
      col.identity = /^ADD/i.test(tail);
      return;
    }
    return; // SET STORAGE / SET STATISTICS: fuer die Anzeige belanglos
  }

  if (/^ENABLE\s+(?:ROW\s+LEVEL\s+SECURITY)/i.test(s)) { table.rls.enabled = true; return; }
  if (/^DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(s)) { table.rls.enabled = false; return; }
  if (/^FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(s)) { table.rls.forced = true; return; }
  // OWNER TO, CLUSTER ON, VALIDATE CONSTRAINT, ... : keine Schema-Aussage
}

function createType(model, rest) {
  const s = rest.replace(/^\s*IF\s+NOT\s+EXISTS\s+/i, '');
  const q = readQualified(s);
  if (!q) return;
  const m = /^\s*AS\s+ENUM\s*(?=\()/i.exec(q.rest);
  if (!m) return; // Composite-/Range-Typen zeigen wir nicht
  const p = readParens(q.rest.slice(m[0].length));
  if (!p) return;
  model.enums.set(keyOf(q.schema, q.name), {
    schema: q.schema || DEFAULT_SCHEMA,
    name: q.name,
    values: splitTopLevel(p.inner).map(stripLiteral),
  });
}

function alterType(model, rest) {
  const q = readQualified(rest);
  if (!q) return;
  const e = model.enums.get(keyOf(q.schema, q.name))
    || [...model.enums.values()].find((x) => !q.schema && x.name === q.name);
  if (!e) return;
  let m;
  if ((m = /^\s*ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(q.rest))) {
    const tail = q.rest.slice(m[0].length);
    const lit = /^'((?:[^']|'')*)'/.exec(tail.trimStart());
    if (!lit) return;
    const value = lit[1].replace(/''/g, "'");
    if (e.values.includes(value)) return;
    // BEFORE/AFTER bestimmt die Sortierung des Enums
    const pos = /\b(BEFORE|AFTER)\s+'((?:[^']|'')*)'/i.exec(tail);
    if (pos) {
      const at = e.values.indexOf(pos[2].replace(/''/g, "'"));
      if (at !== -1) {
        e.values.splice(pos[1].toUpperCase() === 'BEFORE' ? at : at + 1, 0, value);
        return;
      }
    }
    e.values.push(value);
    return;
  }
  if ((m = /^\s*RENAME\s+VALUE\s+/i.exec(q.rest))) {
    const pair = /'((?:[^']|'')*)'\s+TO\s+'((?:[^']|'')*)'/i.exec(q.rest);
    if (!pair) return;
    const at = e.values.indexOf(pair[1].replace(/''/g, "'"));
    if (at !== -1) e.values[at] = pair[2].replace(/''/g, "'");
    return;
  }
  if ((m = /^\s*RENAME\s+TO\s+/i.exec(q.rest))) {
    const to = readIdent(q.rest.slice(m[0].length));
    if (!to) return;
    model.enums.delete(keyOf(e.schema, e.name));
    e.name = to.name;
    model.enums.set(keyOf(e.schema, e.name), e);
  }
}

function dropType(model, rest) {
  const s = rest.replace(/^\s*IF\s+EXISTS\s+/i, '').replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '');
  for (const part of splitTopLevel(s)) {
    const q = readQualified(part);
    if (!q) continue;
    if (!model.enums.delete(keyOf(q.schema, q.name)) && !q.schema) {
      for (const [k, e] of model.enums) if (e.name === q.name) model.enums.delete(k);
    }
  }
}

function stripLiteral(s) {
  const t = squash(s);
  const m = /^'((?:[^']|'')*)'$/.exec(t);
  return m ? m[1].replace(/''/g, "'") : t;
}

function createIndex(model, rest, unique) {
  let s = rest.replace(/^\s*CONCURRENTLY\s+/i, '').replace(/^\s*IF\s+NOT\s+EXISTS\s+/i, '');
  // Der Name ist optional: `CREATE INDEX ON t (...)`
  let name = null;
  if (!/^ON\b/i.test(s.trimStart())) {
    const id = readQualified(s);
    if (!id) return;
    name = id.name;
    s = id.rest;
  }
  const onMatch = /^\s*ON\s+/i.exec(s);
  if (!onMatch) return;
  const q = readQualified(s.slice(onMatch[0].length));
  if (!q) return;
  const table = getTable(model, q.schema, q.name);
  if (!table) return;

  let tail = q.rest.trimStart();
  let method = null;
  const um = /^USING\s+/i.exec(tail);
  if (um) {
    const id = readIdent(tail.slice(um[0].length));
    if (id) { method = id.name; tail = id.rest.trimStart(); }
  }
  const list = readColumnList(tail);
  if (!list) return;
  const where = /\bWHERE\b([\s\S]+)$/i.exec(list.rest);

  addConstraint(table, {
    kind: 'index',
    name,
    columns: list.columns,
    unique: Boolean(unique),
    method,
    expression: where ? squash(where[1]) : null,
  });
}

function dropIndex(model, rest) {
  const s = rest.replace(/^\s*CONCURRENTLY\s+/i, '').replace(/^\s*IF\s+EXISTS\s+/i, '')
    .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '');
  for (const part of splitTopLevel(s)) {
    const q = readQualified(part);
    if (!q) continue;
    for (const t of model.tables.values()) {
      t.constraints = t.constraints.filter((c) => !(c.kind === 'index' && c.name === q.name));
    }
  }
}

function createPolicy(model, rest) {
  const s = rest.replace(/^\s*IF\s+NOT\s+EXISTS\s+/i, '');
  const id = readIdent(s);
  if (!id) return;
  const onMatch = /^\s*ON\s+/i.exec(id.rest);
  if (!onMatch) return;
  const q = readQualified(id.rest.slice(onMatch[0].length));
  if (!q) return;
  // Auch auf einer fremden Tabelle (`storage.objects`) ist die Policy vom
  // Projekt geschrieben und gehoert damit ins Schema.
  const table = getTable(model, q.schema, q.name) || externalTable(model, q.schema, q.name);

  const tail = q.rest;
  const masked = maskNested(tail);
  const grab = (re) => { const m = re.exec(masked); return m ? m[1] : null; };
  // Die Ausdruecke stehen in Klammern - dafuer muss im Original gesucht werden
  const clause = (re) => {
    const m = re.exec(masked);
    if (!m) return null;
    const p = readParens(tail.slice(m.index + m[0].length));
    return p ? squash(p.inner) : null;
  };

  const policy = {
    name: id.name,
    permissive: !/\bAS\s+RESTRICTIVE\b/i.test(masked),
    command: (grab(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i) || 'all').toLowerCase(),
    roles: (grab(/\bTO\s+([\s\S]*?)(?=\bUSING\b|\bWITH\s+CHECK\b|$)/i) || '')
      .split(',').map((r) => squash(r).toLowerCase()).filter(Boolean),
    using: clause(/\bUSING\s*(?=\()/i),
    check: clause(/\bWITH\s+CHECK\s*(?=\()/i),
  };
  table.rls.policies = table.rls.policies.filter((p) => p.name !== policy.name);
  table.rls.policies.push(policy);
}

function dropPolicy(model, rest) {
  const s = rest.replace(/^\s*IF\s+EXISTS\s+/i, '');
  const id = readIdent(s);
  if (!id) return;
  const onMatch = /^\s*ON\s+/i.exec(id.rest);
  if (!onMatch) return;
  const q = readQualified(id.rest.slice(onMatch[0].length));
  if (!q) return;
  const table = getTable(model, q.schema, q.name);
  if (table) table.rls.policies = table.rls.policies.filter((p) => p.name !== id.name);
}

function commentOn(model, rest) {
  let m;
  if ((m = /^\s*TABLE\s+/i.exec(rest))) {
    const q = readQualified(rest.slice(m[0].length));
    if (!q) return;
    const table = getTable(model, q.schema, q.name);
    if (table) table.comment = commentText(q.rest);
    return;
  }
  if ((m = /^\s*COLUMN\s+/i.exec(rest))) {
    // `schema.tabelle.spalte` - die Spalte ist das letzte Glied
    const parts = [];
    let s = rest.slice(m[0].length);
    for (let i = 0; i < 4; i++) {
      const id = readIdent(s);
      if (!id) break;
      parts.push(id.name);
      s = id.rest.trimStart();
      if (!s.startsWith('.')) break;
      s = s.slice(1);
    }
    if (parts.length < 2) return;
    const colName = parts.pop();
    const name = parts.pop();
    const schema = parts.pop() || null;
    const table = getTable(model, schema, name);
    const col = table && findColumn(table, colName);
    if (col) col.comment = commentText(s);
  }
}

function commentText(s) {
  const m = /^\s*IS\s+([\s\S]+)$/i.exec(s);
  if (!m) return null;
  const t = squash(m[1]);
  if (/^NULL$/i.test(t)) return null;
  return stripLiteral(t);
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------
function applyStatement(model, statement) {
  const s = statement.trimStart();
  let m;

  if ((m = /^CREATE\s+(?:(?:UNLOGGED|TEMP|TEMPORARY|GLOBAL|LOCAL)\s+)*TABLE\b/i.exec(s))) return createTable(model, s.slice(m[0].length));
  if ((m = /^ALTER\s+TABLE\b/i.exec(s))) return alterTable(model, s.slice(m[0].length));
  if ((m = /^DROP\s+TABLE\b/i.exec(s))) return dropTable(model, s.slice(m[0].length));
  if ((m = /^CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\b/i.exec(s))) return createType(model, s.slice(m[0].length));
  if ((m = /^ALTER\s+TYPE\b/i.exec(s))) return alterType(model, s.slice(m[0].length));
  if ((m = /^DROP\s+TYPE\b/i.exec(s))) return dropType(model, s.slice(m[0].length));
  if ((m = /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.exec(s))) return createIndex(model, s.slice(m[0].length), Boolean(m[1]));
  if ((m = /^DROP\s+INDEX\b/i.exec(s))) return dropIndex(model, s.slice(m[0].length));
  if ((m = /^CREATE\s+POLICY\b/i.exec(s))) return createPolicy(model, s.slice(m[0].length));
  if ((m = /^DROP\s+POLICY\b/i.exec(s))) return dropPolicy(model, s.slice(m[0].length));
  if ((m = /^COMMENT\s+ON\b/i.exec(s))) return commentOn(model, s.slice(m[0].length));
  // Alles andere (Funktionen, Trigger, Rechte, Daten) sagt nichts ueber die
  // Tabellenform aus und wird still uebergangen.
}

/** Spielt ein SQL-Skript auf dem Modell nach. */
function applySql(model, sql) {
  for (const statement of splitStatements(sql)) {
    try {
      applyStatement(model, statement);
    } catch (e) {
      warn(model, `Anweisung übersprungen (${e.message}): ${firstWords(statement)}`);
    }
  }
  return model;
}

module.exports = {
  DEFAULT_SCHEMA,
  createModel,
  applySql,
  applyStatement,
  splitStatements,
  normalizeType,
  // fuer Tests und weitere Plugins
  splitTopLevel,
  readQualified,
  parseColumnDef,
};
