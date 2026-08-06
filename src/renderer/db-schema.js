// ---------------------------------------------------------------------------
// DB schema
//
// The main process delivers a finished state: detected plugin, current schema
// in the standardised format, the comparison baseline and the diff. Here it is
// only rendered.
//
// Deliberately as table cards and not as an ER diagram: what matters are
// columns, types and constraints, and inside a diagram box those are either
// absent or illegibly small. Above all, a diagram cannot sensibly be compared
// row by row - which is exactly what the before/after view needs.
// Relationships are shown as foreign keys in plain text, including the target.
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { logWarn } from './log.js';
import { t } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { makeOverlay, renderModeButtons } from './overlays.js';

const dbHeadEl = $('#db-head');
const dbSignalEl = $('#db-signal');
const dbTablesEl = $('#db-tables');
const dbSearchEl = $('#db-search');
const badgeDbEl = $('#badge-dbschema');

export const dbState = {
  view: null,
  baseline: 'auto',
  filter: '',
  // Expanded or deliberately collapsed - both have to survive the rebuild,
  // otherwise a table closed by hand pops open again on the next tick.
  open: new Set(),
  closed: new Set(),
  lastJson: '',
  loading: false,
};
let dbTimer = null;

const STATUS_MARK = { added: '+', removed: '−', changed: '~', same: '' };
// The status word is looked up per render - a language switch has to reach it.
const STATUS_WORD = (status) => (status === 'same' ? '' : t('db.status.' + status));

// Short tags for the constraints that affect a column. The abbreviations stay
// as they are - they are read as symbols, and a two-letter marker that changes
// with the language would lose that. The tooltip carries the translation.
const KIND_TAG = {
  pk: { tag: 'PK', key: 'db.tag.pk' },
  fk: { tag: 'FK', key: 'db.tag.fk' },
  unique: { tag: 'UQ', key: 'db.tag.unique' },
  check: { tag: 'CK', key: 'db.tag.check' },
  index: { tag: 'IX', key: 'db.tag.index' },
  exclude: { tag: 'EX', key: 'db.tag.exclude' },
};

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

function constraintText(c) {
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

function policyText(p) {
  const bits = [p.command];
  if (!p.permissive) bits.push('restrictive');
  if (p.roles && p.roles.length) bits.push(t('db.policy.for', { roles: p.roles.join(', ') }));
  if (p.using) bits.push('using ' + p.using);
  if (p.check) bits.push('check ' + p.check);
  return bits.join(' · ');
}

/** Which constraints affect this column? */
function tagsForColumn(table, colName) {
  const kinds = new Set();
  for (const c of table.constraints || []) {
    if ((c.columns || []).includes(colName)) kinds.add(c.kind);
  }
  return [...kinds]
    .filter((k) => KIND_TAG[k])
    .sort((a, b) => Object.keys(KIND_TAG).indexOf(a) - Object.keys(KIND_TAG).indexOf(b))
    .map((k) => KIND_TAG[k]);
}

function tagsHtml(tags) {
  return tags.map((tag) => `<span class="db-tag ${tag.tag.toLowerCase()}" title="${escapeHtml(t(tag.key))}">${tag.tag}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
export async function loadDbSchema(force = false) {
  const s = activeId && sessions.get(activeId);
  if (!s) {
    dbState.view = null;
    dbState.lastJson = '';
    renderDbPanel();
    return;
  }
  if (dbState.loading && !force) return;
  dbState.loading = true;
  try {
    const view = await window.api.getDbSchema(s.id, { baseline: dbState.baseline, force });
    if (s.id !== activeId) return; // switched away in the meantime
    // Unchanged? Then do not rebuild - otherwise the scroll position jumps on
    // every tick of the background poll.
    const json = JSON.stringify(view);
    if (json === dbState.lastJson) return;
    dbState.lastJson = json;
    dbState.view = view;
    renderDbPanel();
    if (dbDiffOverlay.isOpen()) renderDbDiff();
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

  if (!view || !view.ok) {
    dbHeadEl.innerHTML = '';
    dbSignalEl.innerHTML = '';
    dbSearchEl.classList.add('hidden');
    dbTablesEl.innerHTML = `<div class="muted">${escapeHtml(view && view.error
      ? view.error : t('common.noSession'))}</div>`;
    setDbBadge(0);
    return;
  }

  if (!view.plugin) {
    dbHeadEl.innerHTML = '';
    dbSignalEl.innerHTML = '';
    dbSearchEl.classList.add('hidden');
    dbTablesEl.innerHTML = `
      <div class="muted">${escapeHtml(t('db.none'))}</div>
      <div class="db-hint">${escapeHtml(t('db.none.hint', { project: '\u0000', path: '\u0001' }))
        .replace('\u0000', `<code>${escapeHtml(view.project || view.root || '')}</code>`)
        .replace('\u0001', '<code>supabase/migrations</code>')}</div>`;
    // "Nothing detected" and "a plugin broke on the way there" look the same
    // in the panel otherwise. The warnings tell them apart.
    dbTablesEl.insertAdjacentHTML('beforeend', warningsHtml(view.schema));
    setDbBadge(0);
    return;
  }

  renderDbHead(view);
  renderDbSignal(view);
  dbSearchEl.classList.remove('hidden');
  renderDbTables(view);
  setDbBadge(view.changeCount || 0);
}

// What the reader could not make sense of - an unparsable migration, a file it
// could not read, a plugin that threw. The schema on display is incomplete by
// exactly this list, which is why it stands next to it and not only in the log.
function warningsHtml(schema) {
  const warnings = (schema && schema.warnings) || [];
  if (!warnings.length) return '';
  return `
    <details class="db-warn">
      <summary>${escapeHtml(t('db.warnings', { count: warnings.length }))}</summary>
      <ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
    </details>`;
}

function renderDbHead(view) {
  const files = view.schema.files.length;
  const baseSel = view.baselines.length
    ? `<label class="db-base">${escapeHtml(t('db.baseline'))}
         <select id="db-baseline">
           ${view.baselines.map((b) => `<option value="${escapeHtml(b.mode)}"${
             view.baseline && view.baseline.mode === b.mode ? ' selected' : ''
           } title="${escapeHtml(b.hint || '')}">${escapeHtml(b.label)}</option>`).join('')}
         </select>
       </label>`
    : `<span class="muted">${escapeHtml(t('db.baseline.none'))}</span>`;

  dbHeadEl.innerHTML = `
    <div class="db-top">
      <span class="db-plugin" title="${escapeHtml((view.plugin.evidence || []).join('\n'))}">${escapeHtml(view.plugin.label)}</span>
      <span class="db-files">${escapeHtml(t('db.tables', { count: view.schema.tables.length }))} · ${escapeHtml(t('db.files', { count: files }))}</span>
      <button id="db-refresh" class="icon-btn" title="${escapeHtml(t('db.refresh'))}" aria-label="${escapeHtml(t('db.refresh'))}">↻</button>
    </div>
    <div class="db-baseline-row">${baseSel}</div>
    ${warningsHtml(view.schema)}`;

  dbHeadEl.querySelector('#db-refresh').addEventListener('click', () => loadDbSchema(true));
  const sel = dbHeadEl.querySelector('#db-baseline');
  if (sel) {
    sel.addEventListener('change', () => {
      dbState.baseline = sel.value;
      dbState.lastJson = '';
      loadDbSchema(true);
    });
  }
}

function renderDbSignal(view) {
  const d = view.diff;
  if (!d) {
    dbSignalEl.innerHTML = '';
    return;
  }
  if (!d.changed) {
    dbSignalEl.innerHTML = `<div class="db-signal ok">
      <span class="db-signal-icon">✓</span>
      <span>${escapeHtml(t('db.unchanged', { baseline: '\u0000' }))
        .replace('\u0000', `<strong>${escapeHtml(view.baseline.label)}</strong>`)}</span>
    </div>`;
    return;
  }
  const s = d.summary;
  const detail = [
    partsText(s.columns, 'db.parts.columns'),
    partsText(s.constraints, 'db.parts.constraints'),
    partsText(s.policies, 'db.parts.policies'),
  ].filter(Boolean).join(' · ');

  dbSignalEl.innerHTML = `<div class="db-signal alert">
    <span class="db-signal-icon">⚠</span>
    <div class="db-signal-text">
      <strong>${escapeHtml(t('db.changed'))}</strong> ${escapeHtml(t('db.comparedTo', { baseline: view.baseline.label }))}
      <div class="db-signal-sub">${escapeHtml(view.changeText)}${detail ? '<br>' + detail : ''}</div>
    </div>
    <button id="db-open-diff" title="${escapeHtml(t('db.compare.title'))}">${escapeHtml(t('db.compare'))}</button>
  </div>`;
  dbSignalEl.querySelector('#db-open-diff').addEventListener('click', openDbDiff);
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

/** Make the diff status per table/column/constraint look-up-able. */
function diffLookup(view) {
  const tables = new Map();
  if (!view.diff) return tables;
  for (const t of view.diff.tables) {
    tables.set(t.id, {
      status: t.status,
      rlsChanged: t.rlsChanged,
      columns: new Map(t.columns.map((c) => [c.name, c])),
      constraints: new Map(t.constraints.map((c) => [c.name, c])),
      policies: new Map(t.policies.map((p) => [p.name, p])),
    });
  }
  return tables;
}

function renderDbTables(view) {
  const q = dbState.filter.trim().toLowerCase();
  const look = diffLookup(view);
  dbTablesEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  // --- Enums ---
  const enums = view.schema.enums.filter((e) => !q
    || e.name.toLowerCase().includes(q)
    || e.values.some((v) => v.toLowerCase().includes(q)));
  if (enums.length) {
    const enumDiff = new Map((view.diff ? view.diff.enums : []).map((e) => [e.id, e]));
    const box = document.createElement('details');
    box.className = 'db-enums';
    if (dbState.open.has('__enums')) box.open = true;
    box.innerHTML = `<summary>${escapeHtml(t('db.enums', { count: enums.length }))}</summary>
      <div class="db-enum-list">${enums.map((e) => {
        const d = enumDiff.get(e.id);
        const st = d ? d.status : 'same';
        return `<div class="db-enum ${st}">
          <span class="db-enum-name">${escapeHtml(e.name)}</span>
          <span class="db-enum-values">${e.values.map((v) => {
            const added = d && d.added && d.added.includes(v);
            return `<code class="${added ? 'added' : ''}">${escapeHtml(v)}</code>`;
          }).join('')}${(d && d.removed || []).map((v) =>
            `<code class="removed">${escapeHtml(v)}</code>`).join('')}</span>
        </div>`;
      }).join('')}</div>`;
    box.addEventListener('toggle', () => {
      if (box.open) dbState.open.add('__enums'); else dbState.open.delete('__enums');
    });
    frag.appendChild(box);
  }

  // --- Removed tables: no longer in the schema, but they have to stand out
  const removed = (view.diff ? view.diff.tables : []).filter((t) => t.status === 'removed');
  for (const table of removed) {
    if (q && !table.name.toLowerCase().includes(q)) continue;
    const el = document.createElement('div');
    el.className = 'db-table removed-table';
    el.innerHTML = `<span class="db-status removed" title="${escapeHtml(t('db.table.removed'))}">−</span>
      <span class="db-table-name">${escapeHtml(table.schema)}.${escapeHtml(table.name)}</span>
      <span class="db-table-note">${escapeHtml(t('db.table.removed'))}</span>`;
    frag.appendChild(el);
  }

  // --- Tables ---
  const tables = view.schema.tables.filter((t) => !q
    || t.name.toLowerCase().includes(q)
    || t.columns.some((c) => c.name.toLowerCase().includes(q)));

  for (const t of tables) {
    frag.appendChild(buildDbTableCard(t, look.get(t.id), q));
  }

  if (!frag.childNodes.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = q ? t('common.noMatches') : t('db.noTables');
    frag.appendChild(d);
  }
  dbTablesEl.appendChild(frag);
}

function buildDbTableCard(table, d, q) {
  const status = d ? d.status : 'same';
  const box = document.createElement('details');
  box.className = `db-table ${status}`;
  // Expand changed tables and search hits right away - that is what one is
  // looking for. Whatever was collapsed by hand stays collapsed.
  if (dbState.open.has(table.id)
      || (q && q.length > 1)
      || (status !== 'same' && !dbState.closed.has(table.id))) {
    box.open = true;
  }

  const changedCols = d ? [...d.columns.values()].filter((c) => c.status !== 'same').length : 0;
  box.innerHTML = `
    <summary>
      <span class="db-status ${status}" title="${escapeHtml(STATUS_WORD(status) || t('db.status.same'))}">${STATUS_MARK[status] || '·'}</span>
      <span class="db-table-name">${escapeHtml(table.name)}</span>
      ${table.schema !== 'public' ? `<span class="db-schema">${escapeHtml(table.schema)}</span>` : ''}
      ${table.rls.enabled ? `<span class="db-rls${d && d.rlsChanged ? ' changed' : ''}" title="${escapeHtml(
        `${t('db.rls.title')}, ${table.rls.policies.length
          ? t('db.rls.policies', { count: table.rls.policies.length }) : t('db.rls.none')}`)}">RLS</span>` : ''}
      ${table.external
        ? `<span class="db-chip external" title="${escapeHtml(t('db.external.title'))}">${escapeHtml(t('db.external'))}</span>`
        : `<span class="db-count">${table.columns.length}</span>`}
      ${changedCols ? `<span class="db-chip changed">${escapeHtml(t('db.changedCount', { count: changedCols }))}</span>` : ''}
    </summary>
    <div class="db-body"></div>`;

  const body = box.querySelector('.db-body');
  if (table.external) {
    // We do not know the columns - say so instead of showing an empty list
    const note = document.createElement('div');
    note.className = 'db-hint';
    note.textContent = t('db.external.note');
    body.appendChild(note);
  } else {
    body.appendChild(buildDbColumns(table, d));
  }

  const cons = (table.constraints || []).filter((c) => c.kind !== 'pk' || (c.columns || []).length > 1);
  if (cons.length) body.appendChild(buildDbConstraints(cons, d));
  if (table.rls.policies.length) body.appendChild(buildDbPolicies(table.rls.policies, d));
  if (table.comment) {
    const cm = document.createElement('div');
    cm.className = 'db-comment';
    cm.textContent = table.comment;
    body.appendChild(cm);
  }

  box.addEventListener('toggle', () => {
    if (box.open) { dbState.open.add(table.id); dbState.closed.delete(table.id); }
    else { dbState.open.delete(table.id); dbState.closed.add(table.id); }
  });
  return box;
}

function buildDbColumns(table, d) {
  const wrap = document.createElement('div');
  wrap.className = 'db-cols';
  const rows = table.columns.map((c) => {
    const cd = d && d.columns.get(c.name);
    const st = cd ? cd.status : 'same';
    const why = cd && cd.fields && cd.fields.length
      ? cd.fields.map((f) => `${fieldLabel(f)}: ${fmtDefault(cd.before[f])} → ${fmtDefault(cd.after[f])}`).join('\n')
      : '';
    return `<div class="db-col ${st}"${why ? ` title="${escapeHtml(why)}"` : ''}>
      <span class="db-col-mark ${st}">${STATUS_MARK[st] || ''}</span>
      <span class="db-col-name">${escapeHtml(c.name)}</span>
      <span class="db-col-type">${escapeHtml(c.type)}</span>
      <span class="db-col-tags">${tagsHtml(tagsForColumn(table, c.name))}</span>
      <span class="db-col-meta">${escapeHtml(colMeta(c).join(' · '))}</span>
    </div>`;
  });
  // Show dropped columns too - otherwise one only sees that the count is smaller
  if (d) {
    for (const cd of d.columns.values()) {
      if (cd.status !== 'removed') continue;
      rows.push(`<div class="db-col removed" title="${escapeHtml(t('db.status.removed'))}">
        <span class="db-col-mark removed">−</span>
        <span class="db-col-name">${escapeHtml(cd.name)}</span>
        <span class="db-col-type">${escapeHtml(cd.before.type)}</span>
        <span class="db-col-tags"></span>
        <span class="db-col-meta">${escapeHtml(colMeta(cd.before).join(' · '))}</span>
      </div>`);
    }
  }
  wrap.innerHTML = rows.join('');
  return wrap;
}

function buildDbConstraints(cons, d) {
  const box = document.createElement('div');
  box.className = 'db-sub';
  box.innerHTML = `<div class="db-sub-title">${escapeHtml(t('db.section.constraints'))}</div>
    ${cons.map((c) => {
      const cd = d && d.constraints.get(c.name);
      const st = cd ? cd.status : 'same';
      return `<div class="db-con ${st}">
        <span class="db-tag ${c.kind}" title="${escapeHtml(KIND_TAG[c.kind] ? t(KIND_TAG[c.kind].key) : c.kind)}">${(KIND_TAG[c.kind] || {}).tag || c.kind}</span>
        <span class="db-con-name">${escapeHtml(c.name)}</span>
        <span class="db-con-text">${escapeHtml(constraintText(c))}</span>
      </div>`;
    }).join('')}
    ${d ? [...d.constraints.values()].filter((c) => c.status === 'removed').map((c) => `
      <div class="db-con removed" title="${escapeHtml(t('db.status.removed'))}">
        <span class="db-tag ${c.before.kind}">${(KIND_TAG[c.before.kind] || {}).tag || c.before.kind}</span>
        <span class="db-con-name">${escapeHtml(c.name)}</span>
        <span class="db-con-text">${escapeHtml(constraintText(c.before))}</span>
      </div>`).join('') : ''}`;
  return box;
}

function buildDbPolicies(policies, d) {
  const box = document.createElement('div');
  box.className = 'db-sub';
  box.innerHTML = `<div class="db-sub-title">${escapeHtml(t('db.section.policies'))}</div>
    ${policies.map((p) => {
      const pd = d && d.policies.get(p.name);
      const st = pd ? pd.status : 'same';
      return `<div class="db-con ${st}">
        <span class="db-tag pol" title="${escapeHtml(t('db.tag.policy'))}">POL</span>
        <span class="db-con-name">${escapeHtml(p.name)}</span>
        <span class="db-con-text">${escapeHtml(policyText(p))}</span>
      </div>`;
    }).join('')}
    ${d ? [...d.policies.values()].filter((p) => p.status === 'removed').map((p) => `
      <div class="db-con removed" title="${escapeHtml(t('db.status.removed'))}">
        <span class="db-tag pol">POL</span>
        <span class="db-con-name">${escapeHtml(p.name)}</span>
        <span class="db-con-text">${escapeHtml(policyText(p.before))}</span>
      </div>`).join('') : ''}`;
  return box;
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

function openDbDiff() {
  dbDiffOverlay.open();
  renderDbDiff();
}

function renderDbDiffModes() {
  renderModeButtons(
    dbDiffModes,
    [{ id: 'changed', label: t('dbdiff.mode.changed') }, { id: 'all', label: t('dbdiff.mode.all') }],
    dbDiffMode,
    (id) => { dbDiffMode = id; renderDbDiff(); },
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
  dbDiffBody.scrollTop = 0;
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
