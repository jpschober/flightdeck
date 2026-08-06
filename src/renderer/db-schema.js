// ---------------------------------------------------------------------------
// DB schema
//
// The main process delivers a finished state: detected plugin, current schema
// in the standardised format, the comparison baseline and the diff. Here it is
// only rendered.
//
// The panel shows table cards, not a diagram: what matters here are columns,
// types and constraints, and inside a diagram box those are either absent or
// illegibly small. Above all, a diagram cannot sensibly be compared row by row -
// which is exactly what the before/after view needs. Relationships are shown as
// foreign keys in plain text, including the target; whoever wants to see the
// shape of them opens the ER diagram (see dbgraph.js).
// ---------------------------------------------------------------------------
import { $, escapeHtml, setText, setTitle, syncChildren, setSlotSentence } from './dom.js';
import { logWarn } from './log.js';
import { t, onLocaleChange } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { onPanelTab } from './panel.js';
import { makeOverlay, renderModeButtons } from './overlays.js';
import { KIND_TAG, constraintText, diffLookup, tagsForColumn, tagsHtml } from './db-model.js';
import { openDbGraph, refreshDbGraph } from './dbgraph.js';

const dbHeadEl = $('#db-head');
const dbSignalEl = $('#db-signal');
const dbTablesEl = $('#db-tables');
const dbSearchEl = $('#db-search');
const badgeDbEl = $('#badge-dbschema');

export const dbState = {
  view: null,
  baseline: 'auto',
  filter: '',
  loading: false,
};
let dbTimer = null;

const STATUS_MARK = { added: '+', removed: '−', changed: '~', same: '' };
// The status word is looked up per render - a language switch has to reach it.
const STATUS_WORD = (status) => (status === 'same' ? '' : t('db.status.' + status));

function fmtDefault(v) {
  return v === null || v === undefined ? '' : String(v);
}

// The diff names the changed column properties by their internal name (`type`,
// `nullable`, ...). Looked up per render, like the status word: a language
// switch has to reach it.
const fieldLabel = (field) => t('db.field.' + field);

/** The extra details of a column, in the order one reads them. */
function colMeta(col) {
  const out = [];
  if (!col.nullable) out.push('NOT NULL');
  if (col.identity) out.push('identity');
  if (col.generated) out.push(t('db.col.generated'));
  if (col.default) out.push('= ' + fmtDefault(col.default));
  return out;
}

function policyText(p) {
  const bits = [p.command];
  if (!p.permissive) bits.push('restrictive');
  if (p.roles && p.roles.length) bits.push(t('db.policy.for', { roles: p.roles.join(', ') }));
  if (p.using) bits.push('using ' + p.using);
  if (p.check) bits.push('check ' + p.check);
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
export async function loadDbSchema(force = false) {
  const s = activeId && sessions.get(activeId);
  if (!s) {
    dbState.view = null;
    renderDbPanel();
    refreshDbGraph(null);
    return;
  }
  if (dbState.loading && !force) return;
  dbState.loading = true;
  try {
    const view = await window.api.getDbSchema(s.id, { baseline: dbState.baseline, force });
    if (s.id !== activeId) return; // switched away in the meantime
    dbState.view = view;
    renderDbPanel();
    if (dbDiffOverlay.isOpen()) renderDbDiff();
    // Keep the current viewport - a background tick must not throw away where
    // one was looking.
    refreshDbGraph(view);
  } catch (e) {
    logWarn('dbschema: panel not loaded', { session: s.id, baseline: dbState.baseline, err: e });
  } finally {
    dbState.loading = false;
  }
}

function setDbBadge(count) {
  badgeDbEl.textContent = count > 99 ? '99+' : String(count);
  badgeDbEl.classList.toggle('hidden', !count);
  badgeDbEl.classList.toggle('alert', Boolean(count));
}

/**
 * Throw the table cards away. Called on a project switch: the cards of the old
 * one and what was expanded on them no longer fit.
 */
export function clearDbTables() {
  dbTablesEl.replaceChildren();
}

onPanelTab('dbschema', () => loadDbSchema());

// The main process builds the schema warnings and baseline labels itself and
// has just dropped its cache - so this is fetched again rather than taken from
// the copy the renderer is holding.
onLocaleChange(() => loadDbSchema(true)
  .catch((e) => logWarn('language: db schema not reloaded', { err: e })));

// Keep running in the background so the indicator on the tab is right without
// having to keep the tab open - a schema change should stand out, not have to
// be searched for. The sensor serves from the cache as long as no file moves.
export function startDbPolling() {
  clearInterval(dbTimer);
  dbTimer = setInterval(() => {
    loadDbSchema().catch((e) => logWarn('dbschema: background poll failed', { err: e }));
  }, 10_000);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export function renderDbPanel() {
  const view = dbState.view;
  const ok = Boolean(view && view.ok && view.plugin);
  renderDbHead(ok ? view : null);
  renderDbSignal(ok ? view : null);
  dbSearchEl.classList.toggle('hidden', !ok);
  renderDbTables(view);
  setDbBadge(ok ? (view.changeCount || 0) : 0);
}

// What the reader could not make sense of - an unparsable migration, a file it
// could not read, a plugin that threw. The schema on display is incomplete by
// exactly this list, which is why it stands next to it and not only in the log.
function buildDbWarnings() {
  const el = document.createElement('details');
  el.className = 'db-warn';
  el.innerHTML = '<summary></summary><ul></ul>';
  return el;
}

function updateDbWarnings(el, schema) {
  const warnings = (schema && schema.warnings) || [];
  el.classList.toggle('hidden', !warnings.length);
  setText(el.querySelector('summary'), t('db.warnings', { count: warnings.length }));
  syncChildren(
    el.querySelector('ul'),
    warnings.map((w, i) => ({ id: String(i), text: w })),
    () => document.createElement('li'),
    (li, item) => setText(li, item.text),
  );
}

const DB_HEAD_HTML = `
  <div class="db-top">
    <span class="db-plugin"></span>
    <span class="db-files"></span>
    <button id="db-refresh" class="icon-btn">↻</button>
  </div>
  <div class="db-baseline-row">
    <label class="db-base"><span class="db-base-label"></span><select id="db-baseline"></select></label>
    <span class="db-base-none muted"></span>
    <button id="db-graph" class="db-graph-btn"></button>
  </div>`;

function renderDbHead(view) {
  if (!view) { dbHeadEl.replaceChildren(); return; }
  if (!dbHeadEl.firstElementChild) {
    dbHeadEl.innerHTML = DB_HEAD_HTML;
    dbHeadEl.appendChild(buildDbWarnings());
    dbHeadEl.querySelector('#db-refresh').addEventListener('click', () => loadDbSchema(true));
    dbHeadEl.querySelector('#db-graph')
      .addEventListener('click', () => openDbGraph(dbState.view, dbState.filter));
    dbHeadEl.querySelector('#db-baseline').addEventListener('change', (e) => {
      dbState.baseline = e.target.value;
      loadDbSchema(true);
    });
  }

  const pluginEl = dbHeadEl.querySelector('.db-plugin');
  setText(pluginEl, view.plugin.label);
  setTitle(pluginEl, (view.plugin.evidence || []).join('\n'));
  setText(dbHeadEl.querySelector('.db-files'),
    `${t('db.tables', { count: view.schema.tables.length })} · ${t('db.files', { count: view.schema.files.length })}`);
  const refreshEl = dbHeadEl.querySelector('#db-refresh');
  setTitle(refreshEl, t('db.refresh'));
  refreshEl.setAttribute('aria-label', t('db.refresh'));
  const graphEl = dbHeadEl.querySelector('#db-graph');
  setText(graphEl, t('db.graph'));
  setTitle(graphEl, t('db.graph.title'));

  const hasBaselines = view.baselines.length > 0;
  dbHeadEl.querySelector('.db-base').classList.toggle('hidden', !hasBaselines);
  setText(dbHeadEl.querySelector('.db-base-label'), t('db.baseline'));
  const noneEl = dbHeadEl.querySelector('.db-base-none');
  noneEl.classList.toggle('hidden', hasBaselines);
  setText(noneEl, hasBaselines ? '' : t('db.baseline.none'));

  const sel = dbHeadEl.querySelector('#db-baseline');
  syncChildren(
    sel,
    view.baselines.map((b) => ({ id: b.mode, baseline: b })),
    () => document.createElement('option'),
    (el, item) => {
      el.value = item.baseline.mode;
      setText(el, item.baseline.label);
      setTitle(el, item.baseline.hint || '');
    },
  );
  // While the list is open the choice being made there wins - the pass that
  // runs in between must not put the previous one back.
  if (document.activeElement !== sel) sel.value = (view.baseline && view.baseline.mode) || '';

  updateDbWarnings(dbHeadEl.querySelector('.db-warn'), view.schema);
}

const DB_SIGNAL_OK_HTML = `
  <div class="db-signal ok">
    <span class="db-signal-icon">✓</span>
    <span class="db-signal-note"></span>
  </div>`;

const DB_SIGNAL_ALERT_HTML = `
  <div class="db-signal alert">
    <span class="db-signal-icon">⚠</span>
    <div class="db-signal-text">
      <strong class="db-changed"></strong> <span class="db-compared"></span>
      <div class="db-signal-sub">
        <span class="db-change-text"></span>
        <div class="db-detail"></div>
      </div>
    </div>
    <button id="db-open-diff"></button>
  </div>`;

function renderDbSignal(view) {
  const d = view && view.diff;
  const shape = !d ? 'none' : d.changed ? 'alert' : 'ok';
  if (dbSignalEl.dataset.shape !== shape) {
    dbSignalEl.dataset.shape = shape;
    dbSignalEl.innerHTML = shape === 'ok' ? DB_SIGNAL_OK_HTML
      : shape === 'alert' ? DB_SIGNAL_ALERT_HTML : '';
    if (shape === 'alert') dbSignalEl.querySelector('#db-open-diff').addEventListener('click', openDbDiff);
  }
  if (shape === 'none') return;
  if (shape === 'ok') {
    setSlotSentence(dbSignalEl.querySelector('.db-signal-note'),
      t('db.unchanged', { baseline: '\u0000' }), 'strong', [view.baseline.label]);
    return;
  }

  const sum = d.summary;
  const detail = [
    partsText(sum.columns, 'db.parts.columns'),
    partsText(sum.constraints, 'db.parts.constraints'),
    partsText(sum.policies, 'db.parts.policies'),
  ].filter(Boolean).join(' · ');

  setText(dbSignalEl.querySelector('.db-changed'), t('db.changed'));
  setText(dbSignalEl.querySelector('.db-compared'), t('db.comparedTo', { baseline: view.baseline.label }));
  setText(dbSignalEl.querySelector('.db-change-text'), view.changeText);
  const detailEl = dbSignalEl.querySelector('.db-detail');
  detailEl.classList.toggle('hidden', !detail);
  setText(detailEl, detail);
  const btn = dbSignalEl.querySelector('#db-open-diff');
  setText(btn, t('db.compare'));
  setTitle(btn, t('db.compare.title'));
}

function partsText(counts, nounKey) {
  const bits = [];
  if (counts.added) bits.push(t('db.count.new', { count: counts.added }));
  if (counts.removed) bits.push(t('db.count.removed', { count: counts.removed }));
  if (counts.changed) bits.push(t('db.count.changed', { count: counts.changed }));
  if (!bits.length) return '';
  const total = counts.added + counts.removed + counts.changed;
  return `${t(nounKey, { count: total })}: ${bits.join(', ')}`;
}

function renderDbTables(view) {
  syncChildren(dbTablesEl, dbTableItems(view), buildDbItem, updateDbItem);
}

/**
 * Everything the table list shows, in order. The search hides what does not
 * match instead of dropping it: an open table stays open while one searches
 * past it, and typing does not rebuild the list letter by letter.
 */
function dbTableItems(view) {
  if (!view || !view.ok) {
    return [{ id: 'note', kind: 'note', text: view && view.error ? view.error : t('common.noSession') }];
  }
  if (!view.plugin) {
    // "Nothing detected" and "a plugin broke on the way there" look the same
    // in the panel otherwise. The warnings tell them apart.
    return [
      { id: 'note', kind: 'note', text: t('db.none') },
      { id: 'hint', kind: 'hint', codes: [view.project || view.root || '', 'supabase/migrations'] },
      { id: 'warn', kind: 'warn', schema: view.schema },
    ];
  }

  const q = dbState.filter.trim().toLowerCase();
  const look = diffLookup(view);
  const items = [];

  if (view.schema.enums.length) {
    const enumDiff = new Map((view.diff ? view.diff.enums : []).map((e) => [e.id, e]));
    const rows = view.schema.enums.map((e) => ({
      id: `enum:${e.id}`,
      enumeration: e,
      diff: enumDiff.get(e.id),
      hidden: Boolean(q) && !e.name.toLowerCase().includes(q)
        && !e.values.some((v) => v.toLowerCase().includes(q)),
    }));
    const shown = rows.filter((r) => !r.hidden).length;
    items.push({ id: '__enums', kind: 'enums', rows, count: shown, hidden: !shown });
  }

  // Removed tables: no longer in the schema, but they have to stand out
  for (const td of (view.diff ? view.diff.tables : [])) {
    if (td.status !== 'removed') continue;
    items.push({
      id: `gone:${td.id}`, kind: 'gone', table: td,
      hidden: Boolean(q) && !td.name.toLowerCase().includes(q),
    });
  }

  for (const table of view.schema.tables) {
    items.push({
      id: `table:${table.id}`, kind: 'table', table, diff: look.get(table.id), q,
      hidden: Boolean(q) && !table.name.toLowerCase().includes(q)
        && !table.columns.some((c) => c.name.toLowerCase().includes(q)),
    });
  }

  if (!items.some((item) => !item.hidden)) {
    items.push({ id: 'empty', kind: 'note', text: q ? t('common.noMatches') : t('db.noTables') });
  }
  return items;
}

function buildDbItem(item) {
  if (item.kind === 'note') {
    const el = document.createElement('div');
    el.className = 'muted';
    return el;
  }
  if (item.kind === 'hint') {
    const el = document.createElement('div');
    el.className = 'db-hint';
    return el;
  }
  if (item.kind === 'warn') return buildDbWarnings();
  if (item.kind === 'enums') return buildDbEnums();
  if (item.kind === 'gone') return buildDbGoneTable();
  return buildDbTableCard();
}

function updateDbItem(el, item) {
  el.classList.toggle('hidden', Boolean(item.hidden));
  if (item.kind === 'note') { setText(el, item.text); return; }
  if (item.kind === 'hint') {
    setSlotSentence(el, t('db.none.hint', { project: '\u0000', path: '\u0001' }), 'code', item.codes);
    return;
  }
  if (item.kind === 'warn') { updateDbWarnings(el, item.schema); return; }
  if (item.kind === 'enums') { updateDbEnums(el, item); return; }
  if (item.kind === 'gone') { updateDbGoneTable(el, item); return; }
  updateDbTableCard(el, item);
}

function buildDbEnums() {
  const el = document.createElement('details');
  el.className = 'db-enums';
  el.innerHTML = '<summary></summary><div class="db-enum-list"></div>';
  return el;
}

function updateDbEnums(el, item) {
  setText(el.querySelector('summary'), t('db.enums', { count: item.count }));
  syncChildren(el.querySelector('.db-enum-list'), item.rows, buildDbEnumRow, updateDbEnumRow);
}

function buildDbEnumRow() {
  const el = document.createElement('div');
  el.innerHTML = '<span class="db-enum-name"></span><span class="db-enum-values"></span>';
  return el;
}

function updateDbEnumRow(el, item) {
  const d = item.diff;
  el.className = `db-enum ${d ? d.status : 'same'}`;
  el.classList.toggle('hidden', Boolean(item.hidden));
  setText(el.querySelector('.db-enum-name'), item.enumeration.name);
  const values = item.enumeration.values.map((v) => ({
    id: `v:${v}`, value: v, state: d && d.added && d.added.includes(v) ? 'added' : '',
  }));
  for (const v of (d && d.removed) || []) values.push({ id: `r:${v}`, value: v, state: 'removed' });
  syncChildren(
    el.querySelector('.db-enum-values'), values,
    () => document.createElement('code'),
    (code, value) => { code.className = value.state; setText(code, value.value); },
  );
}

function buildDbGoneTable() {
  const el = document.createElement('div');
  el.className = 'db-table removed-table';
  el.innerHTML = `<span class="db-status removed">−</span>
    <span class="db-table-name"></span>
    <span class="db-table-note"></span>`;
  return el;
}

function updateDbGoneTable(el, item) {
  setTitle(el.querySelector('.db-status'), t('db.table.removed'));
  setText(el.querySelector('.db-table-name'), `${item.table.schema}.${item.table.name}`);
  setText(el.querySelector('.db-table-note'), t('db.table.removed'));
}

const DB_TABLE_HTML = `
  <summary>
    <span class="db-status"></span>
    <span class="db-table-name"></span>
    <span class="db-schema"></span>
    <span class="db-rls">RLS</span>
    <span class="db-chip external"></span>
    <span class="db-count"></span>
    <span class="db-chip changed"></span>
  </summary>
  <div class="db-body"></div>`;

function buildDbTableCard() {
  const el = document.createElement('details');
  el.innerHTML = DB_TABLE_HTML;
  return el;
}

function updateDbTableCard(box, item) {
  const { table, diff: d, q } = item;
  const status = d ? d.status : 'same';
  box.className = `db-table ${status}`;
  box.classList.toggle('hidden', Boolean(item.hidden));

  const statusEl = box.querySelector('.db-status');
  statusEl.className = `db-status ${status}`;
  setText(statusEl, STATUS_MARK[status] || '·');
  setTitle(statusEl, STATUS_WORD(status) || t('db.status.same'));

  setText(box.querySelector('.db-table-name'), table.name);
  const schemaEl = box.querySelector('.db-schema');
  schemaEl.classList.toggle('hidden', table.schema === 'public');
  setText(schemaEl, table.schema);

  const rlsEl = box.querySelector('.db-rls');
  rlsEl.classList.toggle('hidden', !table.rls.enabled);
  rlsEl.classList.toggle('changed', Boolean(d && d.rlsChanged));
  setTitle(rlsEl, `${t('db.rls.title')}, ${table.rls.policies.length
    ? t('db.rls.policies', { count: table.rls.policies.length }) : t('db.rls.none')}`);

  const externalEl = box.querySelector('.db-chip.external');
  externalEl.classList.toggle('hidden', !table.external);
  setText(externalEl, t('db.external'));
  setTitle(externalEl, t('db.external.title'));
  const countEl = box.querySelector('.db-count');
  countEl.classList.toggle('hidden', Boolean(table.external));
  setText(countEl, String(table.columns.length));

  const changedCols = d ? [...d.columns.values()].filter((c) => c.status !== 'same').length : 0;
  const changedEl = box.querySelector('.db-chip.changed');
  changedEl.classList.toggle('hidden', !changedCols);
  setText(changedEl, changedCols ? t('db.changedCount', { count: changedCols }) : '');

  syncChildren(box.querySelector('.db-body'), dbBodyItems(table, d), buildDbBodyPart, updateDbBodyPart);

  // Whether a table is expanded is the user's doing and stays in the element.
  // Two things open one by themselves: a status that has just moved away from
  // "same", and a search that has just found it - that is what one is looking
  // for. Both only on the step, so a table closed by hand stays closed.
  //
  // Nothing here closes a card again. What is expanded stays expanded, no
  // matter what expanded it: a table the search opened is still open when the
  // search ends, and it is the same table one was just looking at.
  const wasStatus = box.dataset.status;
  box.dataset.status = status;
  if (status !== 'same' && status !== wasStatus) box.open = true;
  const wasQuery = box.dataset.query;
  box.dataset.query = q;
  if (q.length > 1 && q !== wasQuery && !item.hidden) box.open = true;
}

function dbBodyItems(table, d) {
  const items = [];
  // We do not know the columns of a foreign table - say so instead of showing
  // an empty list
  if (table.external) items.push({ id: 'external', kind: 'external' });
  else items.push({ id: 'cols', kind: 'cols', table, diff: d });

  const cons = (table.constraints || []).filter((c) => c.kind !== 'pk' || (c.columns || []).length > 1);
  if (cons.length) items.push({ id: 'cons', kind: 'cons', cons, diff: d });
  if (table.rls.policies.length) items.push({ id: 'pols', kind: 'pols', policies: table.rls.policies, diff: d });
  if (table.comment) items.push({ id: 'comment', kind: 'comment', text: table.comment });
  return items;
}

function buildDbBodyPart(item) {
  const el = document.createElement('div');
  if (item.kind === 'external') el.className = 'db-hint';
  else if (item.kind === 'comment') el.className = 'db-comment';
  else if (item.kind === 'cols') el.className = 'db-cols';
  else {
    el.className = 'db-sub';
    el.innerHTML = '<div class="db-sub-title"></div><div class="db-sub-rows"></div>';
  }
  return el;
}

function updateDbBodyPart(el, item) {
  if (item.kind === 'external') { setText(el, t('db.external.note')); return; }
  if (item.kind === 'comment') { setText(el, item.text); return; }
  if (item.kind === 'cols') {
    syncChildren(el, dbColumnItems(item.table, item.diff), buildDbColumn, updateDbColumn);
    return;
  }
  const rows = item.kind === 'cons'
    ? dbConstraintItems(item.cons, item.diff)
    : dbPolicyItems(item.policies, item.diff);
  setText(el.querySelector('.db-sub-title'), t(item.kind === 'cons' ? 'db.section.constraints' : 'db.section.policies'));
  syncChildren(el.querySelector('.db-sub-rows'), rows, buildDbConstraint, updateDbConstraint);
}

function dbColumnItems(table, d) {
  const items = table.columns.map((c) => ({
    id: `col:${c.name}`, table, column: c, diff: d && d.columns.get(c.name),
  }));
  // Show dropped columns too - otherwise one only sees that the count is smaller
  if (d) {
    for (const cd of d.columns.values()) {
      if (cd.status === 'removed') items.push({ id: `gone:${cd.name}`, table, column: cd.before, gone: true });
    }
  }
  return items;
}

function buildDbColumn() {
  const el = document.createElement('div');
  el.innerHTML = `
    <span class="db-col-mark"></span>
    <span class="db-col-name"></span>
    <span class="db-col-type"></span>
    <span class="db-col-tags"></span>
    <span class="db-col-meta"></span>`;
  return el;
}

function updateDbColumn(el, item) {
  const cd = item.diff;
  const status = item.gone ? 'removed' : cd ? cd.status : 'same';
  el.className = `db-col ${status}`;
  const why = cd && cd.fields && cd.fields.length
    ? cd.fields.map((f) => `${fieldLabel(f)}: ${fmtDefault(cd.before[f])} → ${fmtDefault(cd.after[f])}`).join('\n')
    : '';
  setTitle(el, item.gone ? t('db.status.removed') : why);

  const markEl = el.querySelector('.db-col-mark');
  markEl.className = `db-col-mark ${status}`;
  setText(markEl, STATUS_MARK[status] || '');
  setText(el.querySelector('.db-col-name'), item.column.name);
  setText(el.querySelector('.db-col-type'), item.column.type);
  syncChildren(
    el.querySelector('.db-col-tags'),
    item.gone ? [] : tagsForColumn(item.table, item.column.name).map((tag) => ({ id: tag.tag, tag })),
    () => document.createElement('span'),
    (tagEl, tagItem) => {
      tagEl.className = `db-tag ${tagItem.tag.tag.toLowerCase()}`;
      setTitle(tagEl, t(tagItem.tag.key));
      setText(tagEl, tagItem.tag.tag);
    },
  );
  setText(el.querySelector('.db-col-meta'), colMeta(item.column).join(' · '));
}

function dbConstraintItems(cons, d) {
  const items = cons.map((c) => ({
    id: `con:${c.name}`, constraint: c, diff: d && d.constraints.get(c.name),
  }));
  if (d) {
    for (const cd of d.constraints.values()) {
      if (cd.status === 'removed') items.push({ id: `gone:${cd.name}`, constraint: cd.before, gone: true });
    }
  }
  return items;
}

function dbPolicyItems(policies, d) {
  const items = policies.map((p) => ({
    id: `pol:${p.name}`, policy: p, diff: d && d.policies.get(p.name),
  }));
  if (d) {
    for (const pd of d.policies.values()) {
      if (pd.status === 'removed') items.push({ id: `gone:${pd.name}`, policy: pd.before, gone: true });
    }
  }
  return items;
}

function buildDbConstraint() {
  const el = document.createElement('div');
  el.innerHTML = `
    <span class="db-tag"></span>
    <span class="db-con-name"></span>
    <span class="db-con-text"></span>`;
  return el;
}

function updateDbConstraint(el, item) {
  const c = item.constraint || item.policy;
  const status = item.gone ? 'removed' : item.diff ? item.diff.status : 'same';
  el.className = `db-con ${status}`;
  setTitle(el, item.gone ? t('db.status.removed') : '');

  const tagEl = el.querySelector('.db-tag');
  if (item.policy) {
    tagEl.className = 'db-tag pol';
    setText(tagEl, 'POL');
    setTitle(tagEl, t('db.tag.policy'));
  } else {
    tagEl.className = `db-tag ${c.kind}`;
    setText(tagEl, (KIND_TAG[c.kind] || {}).tag || c.kind);
    setTitle(tagEl, KIND_TAG[c.kind] ? t(KIND_TAG[c.kind].key) : c.kind);
  }
  setText(el.querySelector('.db-con-name'), c.name);
  setText(el.querySelector('.db-con-text'), item.policy ? policyText(c) : constraintText(c));
}

dbSearchEl.addEventListener('input', () => {
  dbState.filter = dbSearchEl.value;
  if (dbState.view && dbState.view.ok && dbState.view.plugin) renderDbTables(dbState.view);
});

// ---------------------------------------------------------------------------
// Before/after side by side
//
// A character diff would be worth little here - reordered columns or a renamed
// constraint create noise, and what actually happened is not visible. So the
// comparison is structural and both states are placed side by side, row for
// row: the old one on the left, the new one on the right. Both cards of a pair
// sit in the same grid row, so identical columns stand at the same height.
// ---------------------------------------------------------------------------
const dbDiffOverlay = makeOverlay($('#dbdiff-overlay'), $('#dbdiff-close'));
const dbDiffBody = $('#dbdiff-body');
const dbDiffModes = $('#dbdiff-modes');
let dbDiffMode = 'changed'; // 'changed' | 'all'

// The marker of a row in the before/after view: an addition appears on the
// right, a removal on the left, a change on both sides.
function diffMark(status, side) {
  if (status === 'changed') return STATUS_MARK.changed;
  if (status === 'added' && side === 'after') return STATUS_MARK.added;
  if (status === 'removed' && side === 'before') return STATUS_MARK.removed;
  return '';
}

// The comparison starts at the top, and so does a switch of the mode. A
// refresh while it is open leaves the reader where they were reading.
function openDbDiff() {
  dbDiffOverlay.open();
  renderDbDiff();
  dbDiffBody.scrollTop = 0;
}

function renderDbDiffModes() {
  renderModeButtons(
    dbDiffModes,
    [{ id: 'changed', label: t('dbdiff.mode.changed') }, { id: 'all', label: t('dbdiff.mode.all') }],
    dbDiffMode,
    (id) => { dbDiffMode = id; renderDbDiff(); dbDiffBody.scrollTop = 0; },
  );
}

function renderDbDiff() {
  const view = dbState.view;
  // Nothing left to compare (project switched, baseline gone): better to close
  // than to leave a stale state standing.
  if (!view || !view.ok || !view.plugin || !view.diff) { dbDiffOverlay.close(); return; }
  renderDbDiffModes();

  $('#dbdiff-title').textContent = `${view.plugin.label} · ${view.project || ''}`;
  $('#dbdiff-head-old').innerHTML =
    `<strong>${escapeHtml(t('dbdiff.before'))}</strong> <span>${escapeHtml(view.baseline.label)} · ${escapeHtml(view.baseline.ref)}</span>`;
  $('#dbdiff-head-new').innerHTML =
    `<strong>${escapeHtml(t('dbdiff.after'))}</strong> <span>${escapeHtml(t('dbdiff.workingDir'))}</span>`;

  const baseTables = new Map(view.base.tables.map((t) => [t.id, t]));
  const curTables = new Map(view.schema.tables.map((t) => [t.id, t]));

  dbDiffBody.innerHTML = '';
  const frag = document.createDocumentFragment();

  // --- Enums ---
  const enums = view.diff.enums.filter((e) => dbDiffMode === 'all' || e.status !== 'same');
  if (enums.length) {
    frag.appendChild(dbDiffSpan(t('dbdiff.enums')));
    for (const e of enums) {
      frag.appendChild(dbDiffEnumCard(e, 'before'));
      frag.appendChild(dbDiffEnumCard(e, 'after'));
    }
  }

  // --- Tables ---
  const tables = view.diff.tables.filter((t) => dbDiffMode === 'all' || t.status !== 'same');
  if (tables.length) {
    frag.appendChild(dbDiffSpan(t('dbdiff.tables')));
    for (const t of tables) {
      frag.appendChild(dbDiffTableCard(t, baseTables.get(t.id) || null, 'before'));
      frag.appendChild(dbDiffTableCard(t, curTables.get(t.id) || null, 'after'));
    }
  }

  if (!frag.childNodes.length) {
    frag.appendChild(dbDiffSpan(t('dbdiff.none')));
  }
  dbDiffBody.appendChild(frag);
}

/** A row that spans both columns of the grid. */
function dbDiffSpan(text) {
  const el = document.createElement('div');
  el.className = 'dbd-span';
  el.textContent = text;
  return el;
}

function dbDiffEnumCard(e, side) {
  const values = side === 'before' ? (e.before || (e.status === 'added' ? [] : e.values)) : e.values;
  const el = document.createElement('div');
  const missing = (side === 'before' && e.status === 'added') || (side === 'after' && e.status === 'removed');
  el.className = `dbd-card ${side}` + (missing ? ' absent' : '');
  if (missing) {
    el.innerHTML = `<div class="dbd-card-head"><span class="dbd-absent">${escapeHtml(
      t(side === 'before' ? 'dbdiff.absent.before' : 'dbdiff.absent.after'))}</span></div>`;
    return el;
  }
  el.innerHTML = `
    <div class="dbd-card-head">
      <span class="dbd-name">${escapeHtml(e.name)}</span>
      <span class="db-tag enum">ENUM</span>
    </div>
    <div class="dbd-rows">${(values || []).map((v) => {
      const gone = side === 'before' && e.removed && e.removed.includes(v);
      const isNew = side === 'after' && e.added && e.added.includes(v);
      return `<div class="dbd-row ${gone ? 'removed' : isNew ? 'added' : 'same'}">
        <span class="dbd-mark">${gone ? '−' : isNew ? '+' : ''}</span>
        <code>${escapeHtml(v)}</code></div>`;
    }).join('')}</div>`;
  return el;
}

function dbDiffTableCard(td, table, side) {
  const el = document.createElement('div');
  const missing = !table;
  el.className = `dbd-card ${side} ${td.status}` + (missing ? ' absent' : '');

  if (missing) {
    el.innerHTML = `<div class="dbd-card-head">
      <span class="dbd-name muted">${escapeHtml(td.schema)}.${escapeHtml(td.name)}</span>
      <span class="dbd-absent">${escapeHtml(t(side === 'before' ? 'dbdiff.absent.newTable' : 'dbdiff.absent.after'))}</span>
    </div>`;
    return el;
  }

  // The row order comes from the diff and is the same on both sides - which is
  // why identical columns stand at the same height on the left and the right.
  const colRows = td.columns.map((cd) => {
    const c = side === 'before' ? cd.before : cd.after;
    const st = cd.status;
    if (!c) {
      return `<div class="dbd-row absent"><span class="dbd-mark"></span>
        <span class="dbd-cell muted">—</span></div>`;
    }
    const changedFields = st === 'changed' ? cd.fields : [];
    const meta = colMeta(c).join(' · ');
    return `<div class="dbd-row ${st}"${changedFields.length
      ? ` title="${escapeHtml(changedFields.map(fieldLabel).join(', '))}"` : ''}>
      <span class="dbd-mark">${diffMark(st, side)}</span>
      <span class="dbd-col-name">${escapeHtml(c.name)}</span>
      <span class="dbd-col-type${changedFields.includes('type') ? ' hot' : ''}">${escapeHtml(c.type)}</span>
      <span class="dbd-col-tags">${tagsHtml(tagsForColumn(table, c.name))}</span>
      <span class="dbd-col-meta${changedFields.some((f) => f !== 'type') ? ' hot' : ''}">${escapeHtml(meta)}</span>
    </div>`;
  });

  const conRows = td.constraints.map((cd) => {
    const c = side === 'before' ? cd.before : cd.after;
    if (!c) return `<div class="dbd-row absent"><span class="dbd-mark"></span><span class="dbd-cell muted">—</span></div>`;
    return `<div class="dbd-row ${cd.status}">
      <span class="dbd-mark">${diffMark(cd.status, side)}</span>
      <span class="db-tag ${c.kind}" title="${escapeHtml(KIND_TAG[c.kind] ? t(KIND_TAG[c.kind].key) : c.kind)}">${(KIND_TAG[c.kind] || {}).tag || c.kind}</span>
      <span class="dbd-con-name">${escapeHtml(c.name)}</span>
      <span class="dbd-con-text">${escapeHtml(constraintText(c))}</span>
    </div>`;
  });

  const polRows = td.policies.map((pd) => {
    const p = side === 'before' ? pd.before : pd.after;
    if (!p) return `<div class="dbd-row absent"><span class="dbd-mark"></span><span class="dbd-cell muted">—</span></div>`;
    return `<div class="dbd-row ${pd.status}">
      <span class="dbd-mark">${diffMark(pd.status, side)}</span>
      <span class="db-tag pol">POL</span>
      <span class="dbd-con-name">${escapeHtml(p.name)}</span>
      <span class="dbd-con-text">${escapeHtml(policyText(p))}</span>
    </div>`;
  });

  el.innerHTML = `
    <div class="dbd-card-head">
      <span class="dbd-name">${escapeHtml(table.name)}</span>
      ${table.schema !== 'public' ? `<span class="db-schema">${escapeHtml(table.schema)}</span>` : ''}
      ${table.rls.enabled ? `<span class="db-rls${td.rlsChanged ? ' changed' : ''}" title="${escapeHtml(t('db.rls.title'))}">RLS</span>` : ''}
      ${table.external ? `<span class="db-chip external" title="${escapeHtml(t('db.external.short'))}">${escapeHtml(t('db.external'))}</span>` : ''}
    </div>
    <div class="dbd-rows">${colRows.join('')}</div>
    ${conRows.length ? `<div class="dbd-sub">${escapeHtml(t('db.section.constraints'))}</div><div class="dbd-rows">${conRows.join('')}</div>` : ''}
    ${polRows.length ? `<div class="dbd-sub">${escapeHtml(t('db.section.policies'))}</div><div class="dbd-rows">${polRows.join('')}</div>` : ''}`;
  return el;
}
