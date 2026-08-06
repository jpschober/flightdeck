/* global dagre */
// ---------------------------------------------------------------------------
// DB schema as an ER diagram
//
// The panel answers "what does this table look like", the diagram answers "what
// hangs off what" - two different questions, so this is a separate view and not
// a replacement for the table cards.
//
// What makes it worth having next to any generic ERD tool: it knows the diff.
// New tables, removed ones and new foreign keys are coloured, and the "changes"
// scope reduces the picture to what moved plus its direct neighbours. On a
// schema with eighty tables that is the difference between a poster and a
// review tool.
//
// Layout comes from dagre (48 KB, pure layout, no rendering of its own), the
// nodes are ordinary DOM - that way they inherit theme, fonts and the tag
// styles of the panel, and their text stays selectable. The edges are one SVG
// layer underneath. Pan and zoom is a transform on the wrapper, so neither
// panning nor searching nor focusing ever triggers a re-layout.
//
// dagre is a UMD bundle loaded as a classic script (see index.html) and reached
// as a global; everything else this module needs comes in as an import. The
// schema itself is handed over by db-schema.js, which holds it - that keeps the
// edge between panel and diagram one-way.
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { t } from './i18n.js';
import { makeOverlay, renderModeButtons } from './overlays.js';
import { constraintText, diffLookup, tagsForColumn, tagsHtml } from './db-model.js';

const overlay = makeOverlay($('#dbgraph-overlay'), $('#dbgraph-close'));
const titleEl = $('#dbgraph-title');
const statsEl = $('#dbgraph-stats');
const searchEl = $('#dbgraph-search');
const scopeEl = $('#dbgraph-scope');
const detailEl = $('#dbgraph-detail');
const canvasEl = $('#dbgraph-canvas');
const worldEl = $('#dbgraph-world');
const nodesEl = $('#dbgraph-nodes');
const edgesEl = $('#dbgraph-edges');
const legendEl = $('#dbgraph-legend');
const emptyEl = $('#dbgraph-empty');

const SVG_NS = 'http://www.w3.org/2000/svg';

// Beyond this a table box is taller than the screen and helps nobody - the
// panel is the place for the full column list.
const MAX_COLS = 24;

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

const state = {
  view: null, // the schema state db-schema.js last handed over
  scope: 'all', // 'all' | 'changed'
  detail: 'tables', // 'tables' | 'columns'
  filter: '',
  focus: null, // table id whose neighbourhood is highlighted
  zoom: 1,
  tx: 0,
  ty: 0,
  // The last laid-out picture: nodes by id with their box, so highlighting
  // and focusing can work without touching the layout again.
  placed: new Map(),
  edges: [],
};

// -------------------------------------------------------------------------
// Model: from the IR plus the diff to nodes and edges
// -------------------------------------------------------------------------

/** Does this FK point at exactly one row on its own side, i.e. is it 1:1? */
function fkIsUnique(table, c) {
  if (!table) return false;
  const cols = [...(c.columns || [])].sort().join(',');
  if (!cols) return false;
  return (table.constraints || []).some((o) => (o.kind === 'pk' || o.kind === 'unique'
    || (o.kind === 'index' && o.unique))
    && [...(o.columns || [])].sort().join(',') === cols);
}

/** A nullable FK column means the child may reference nothing at all. */
function fkIsOptional(table, c) {
  if (!table || !table.columns.length) return false;
  const byName = new Map(table.columns.map((col) => [col.name, col]));
  return (c.columns || []).every((name) => {
    const col = byName.get(name);
    return col ? col.nullable : false;
  });
}

function buildModel(view) {
  const look = diffLookup(view);
  const baseTables = new Map((view.base ? view.base.tables : []).map((x) => [x.id, x]));
  const nodes = new Map();

  for (const table of view.schema.tables) {
    const d = look.get(table.id);
    nodes.set(table.id, {
      id: table.id,
      schema: table.schema,
      name: table.name,
      table,
      status: d ? d.status : 'same',
      rlsChanged: Boolean(d && d.rlsChanged),
      changedCols: d ? [...d.columns.values()].filter((c) => c.status !== 'same').length : 0,
      diff: d || null,
      ghost: false,
    });
  }

  // Tables that only the baseline still has. Without them a removed relation
  // would simply be missing instead of visibly gone.
  for (const td of (view.diff ? view.diff.tables : [])) {
    if (td.status !== 'removed' || nodes.has(td.id)) continue;
    const table = baseTables.get(td.id);
    if (!table) continue;
    nodes.set(td.id, {
      id: td.id,
      schema: td.schema,
      name: td.name,
      table,
      status: 'removed',
      rlsChanged: false,
      changedCols: 0,
      diff: null,
      ghost: false,
    });
  }

  // An FK may point at a table this project never creates and never governs -
  // then it appears nowhere in the IR. Dropping the edge would hide a real
  // dependency, so the target gets a placeholder box.
  const ghostFor = (ref) => {
    const id = `${ref.schema}.${ref.table}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        schema: ref.schema,
        name: ref.table,
        table: null,
        status: 'same',
        rlsChanged: false,
        changedCols: 0,
        diff: null,
        ghost: true,
      });
    }
    return id;
  };

  const edges = [];
  const addEdge = (node, c, status) => {
    if (!c || c.kind !== 'fk' || !c.references) return;
    const parent = ghostFor(c.references);
    edges.push({
      id: `${node.id}|${c.name}|${edges.length}`,
      // Direction is parent -> child: whoever is referenced comes first. With
      // rankdir LR that reads left to right as the order the rows have to be
      // inserted in.
      parent,
      child: node.id,
      status,
      one: fkIsUnique(node.table, c),
      optional: fkIsOptional(node.table, c),
      name: c.name,
      text: `${node.name} ${constraintText(c)}`,
    });
  };

  for (const node of nodes.values()) {
    if (node.ghost || !node.table) continue;
    for (const c of node.table.constraints || []) {
      if (c.kind !== 'fk') continue;
      const cd = node.diff && node.diff.constraints.get(c.name);
      // On a brand new table every relation is new too, even though the
      // constraint itself carries no status of its own.
      const status = node.status === 'added' ? 'added'
        : node.status === 'removed' ? 'removed'
          : (cd ? cd.status : 'same');
      addEdge(node, c, status);
    }
    // Relations that the baseline still had. They are gone from the schema,
    // so they only exist in the diff.
    if (node.diff) {
      for (const cd of node.diff.constraints.values()) {
        if (cd.status === 'removed') addEdge(node, cd.before, 'removed');
      }
    }
  }

  return { nodes, edges };
}

/**
 * "Changes" scope: everything that moved, plus one hop of context - a new
 * foreign key is unreadable without the table at its other end.
 */
function applyScope(model) {
  if (state.scope !== 'changed') {
    return { nodes: [...model.nodes.values()], edges: model.edges };
  }
  const hot = new Set();
  for (const n of model.nodes.values()) {
    if (n.status !== 'same' || n.rlsChanged || n.changedCols) hot.add(n.id);
  }
  for (const e of model.edges) {
    if (e.status !== 'same') { hot.add(e.parent); hot.add(e.child); }
  }
  const keep = new Set(hot);
  for (const e of model.edges) {
    if (hot.has(e.child)) keep.add(e.parent);
    if (hot.has(e.parent)) keep.add(e.child);
  }
  return {
    nodes: [...model.nodes.values()].filter((n) => keep.has(n.id)),
    edges: model.edges.filter((e) => keep.has(e.parent) && keep.has(e.child)),
    hot,
  };
}

// -------------------------------------------------------------------------
// Nodes as DOM
// -------------------------------------------------------------------------
const MARK = { added: '+', removed: '−', changed: '~', same: '' };

function nodeElement(node) {
  const el = document.createElement('div');
  el.className = `dbg-node ${node.status}`;
  if (node.ghost) el.classList.add('ghost');
  if (node.table && node.table.external) el.classList.add('external');
  if (node.status === 'removed') el.classList.add('gone');
  el.dataset.id = node.id;
  el.tabIndex = 0;

  const cols = node.table ? node.table.columns : [];
  const shown = state.detail === 'columns' ? cols.slice(0, MAX_COLS) : [];
  const rest = cols.length - shown.length;

  const head = `
    <div class="dbg-head">
      ${node.status !== 'same' ? `<span class="dbg-mark ${node.status}">${MARK[node.status]}</span>` : ''}
      <span class="dbg-name">${escapeHtml(node.name)}</span>
      ${node.schema !== 'public' ? `<span class="db-schema">${escapeHtml(node.schema)}</span>` : ''}
      ${node.table && node.table.rls.enabled
  ? `<span class="db-rls${node.rlsChanged ? ' changed' : ''}" title="${escapeHtml(t('db.rls.title'))}">RLS</span>` : ''}
      ${node.ghost
  ? `<span class="db-chip external" title="${escapeHtml(t('dbgraph.unknown.title'))}">${escapeHtml(t('dbgraph.unknown'))}</span>`
  : node.table && node.table.external
    ? `<span class="db-chip external" title="${escapeHtml(t('db.external.short'))}">${escapeHtml(t('db.external'))}</span>`
    : `<span class="dbg-count">${cols.length}</span>`}
      ${node.changedCols && node.status === 'changed' && state.detail === 'tables'
  ? `<span class="db-chip changed">${escapeHtml(t('db.changedCount', { count: node.changedCols }))}</span>` : ''}
    </div>`;

  const body = shown.length
    ? `<div class="dbg-cols">${shown.map((c) => {
      const cd = node.diff && node.diff.columns.get(c.name);
      const st = cd ? cd.status : 'same';
      return `<div class="dbg-col ${st}">
          <span class="dbg-col-mark ${st}">${MARK[st]}</span>
          <span class="dbg-col-name">${escapeHtml(c.name)}</span>
          <span class="dbg-col-type">${escapeHtml(c.type)}</span>
          <span class="dbg-col-tags">${tagsHtml(tagsForColumn(node.table, c.name))}</span>
        </div>`;
    }).join('')}${rest > 0
      ? `<div class="dbg-more">${escapeHtml(t('dbgraph.more', { count: rest }))}</div>` : ''}</div>`
    : '';

  el.innerHTML = head + body;
  return el;
}

// -------------------------------------------------------------------------
// Edges as SVG
// -------------------------------------------------------------------------

/** Smooth polyline that still passes exactly through its end points. */
function pathFrom(points) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M${points[0].x} ${points[0].y}L${points[1].x} ${points[1].y}`;
  }
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const n = points[i + 1];
    d += `Q${p.x} ${p.y} ${(p.x + n.x) / 2} ${(p.y + n.y) / 2}`;
  }
  const last = points[points.length - 1];
  d += `L${last.x} ${last.y}`;
  return d;
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Crow's foot at one end. `dir` points along the edge towards the end point,
 * so everything is drawn backwards from there into the free space.
 */
function endMarker(group, at, dir, opts) {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const d = { x: dir.x / len, y: dir.y / len };
  const n = { x: -d.y, y: d.x };
  const back = (dist, side = 0) => ({
    x: at.x - d.x * dist + n.x * side,
    y: at.y - d.y * dist + n.y * side,
  });

  if (opts.many) {
    // Three lines fanning out backwards from the box - "many rows here"
    for (const side of [-6, 0, 6]) {
      const p = back(11, side);
      group.appendChild(svgEl('path', { class: 'dbg-foot', d: `M${at.x} ${at.y}L${p.x} ${p.y}` }));
    }
  } else {
    const a = back(9, 5.5);
    const b = back(9, -5.5);
    group.appendChild(svgEl('path', { class: 'dbg-foot', d: `M${a.x} ${a.y}L${b.x} ${b.y}` }));
  }

  if (opts.optional) {
    const c = back(opts.many ? 16 : 15);
    group.appendChild(svgEl('circle', { class: 'dbg-opt', cx: c.x, cy: c.y, r: 3.4 }));
  } else {
    const a = back(opts.many ? 15 : 14, 5.5);
    const b = back(opts.many ? 15 : 14, -5.5);
    group.appendChild(svgEl('path', { class: 'dbg-foot', d: `M${a.x} ${a.y}L${b.x} ${b.y}` }));
  }
}

function drawEdge(edge, points) {
  const g = svgEl('g', { class: `dbg-edge ${edge.status}` });
  g.dataset.parent = edge.parent;
  g.dataset.child = edge.child;
  g.dataset.id = edge.id;

  g.appendChild(svgEl('path', { class: 'dbg-line', d: pathFrom(points) }));

  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  // Parent end: exactly one row, optional when the FK column may be null.
  endMarker(g, first, { x: first.x - second.x, y: first.y - second.y },
    { many: false, optional: edge.optional });
  // Child end: many rows, unless the FK is unique - then it is a 1:1.
  endMarker(g, last, { x: last.x - prev.x, y: last.y - prev.y },
    { many: !edge.one, optional: false });

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = `${edge.name}\n${edge.text}`;
  g.appendChild(title);
  return g;
}

/** A self reference gets no rank of its own - it is a loop on the right. */
function selfLoop(box) {
  const x = box.x + box.w;
  const y1 = box.y + box.h * 0.35;
  const y2 = box.y + box.h * 0.65;
  return [
    { x, y: y1 },
    { x: x + 34, y: y1 - 6 },
    { x: x + 34, y: y2 + 6 },
    { x, y: y2 },
  ];
}

// -------------------------------------------------------------------------
// Layout
// -------------------------------------------------------------------------
function layout(nodes, edges) {
  // Measuring only works at scale 1 - getBoundingClientRect would otherwise
  // hand back the zoomed size and every box would drift.
  worldEl.style.transform = 'none';

  nodesEl.innerHTML = '';
  const els = new Map();
  for (const node of nodes) {
    const el = nodeElement(node);
    el.classList.add('measuring');
    nodesEl.appendChild(el);
    els.set(node.id, el);
  }

  const boxes = new Map();
  for (const [id, el] of els) {
    boxes.set(id, { w: el.offsetWidth, h: el.offsetHeight });
  }

  const selfEdges = edges.filter((e) => e.parent === e.child);
  const realEdges = edges.filter((e) => e.parent !== e.child);
  const connected = new Set();
  for (const e of realEdges) { connected.add(e.parent); connected.add(e.child); }

  // Tables without any relation would form a tall column of their own in the
  // first rank and stretch the whole picture. They get a wrapped block below
  // instead - they have nothing to say about the graph anyway.
  const islands = nodes.filter((n) => !connected.has(n.id));
  const linked = nodes.filter((n) => connected.has(n.id));

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: 'LR',
    ranksep: state.detail === 'columns' ? 110 : 80,
    nodesep: 28,
    edgesep: 16,
    marginx: 24,
    marginy: 24,
    acyclicer: 'greedy',
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of linked) {
    const b = boxes.get(n.id);
    g.setNode(n.id, { width: b.w, height: b.h });
  }
  for (const e of realEdges) g.setEdge(e.parent, e.child, {}, e.id);

  dagre.layout(g);

  const placed = new Map();
  let maxX = 0;
  let maxY = 0;
  for (const n of linked) {
    const gn = g.node(n.id);
    const box = { x: gn.x - gn.width / 2, y: gn.y - gn.height / 2, w: gn.width, h: gn.height };
    placed.set(n.id, box);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }

  // Islands as a wrapped row underneath, roughly as wide as the graph itself
  if (islands.length) {
    const gap = 14;
    const rowWidth = Math.max(maxX, 900);
    let x = 24;
    let y = (linked.length ? maxY + 56 : 24);
    let rowH = 0;
    for (const n of islands) {
      const b = boxes.get(n.id);
      if (x > 24 && x + b.w > rowWidth) { x = 24; y += rowH + gap; rowH = 0; }
      placed.set(n.id, { x, y, w: b.w, h: b.h });
      x += b.w + gap;
      rowH = Math.max(rowH, b.h);
      maxX = Math.max(maxX, x);
    }
    maxY = y + rowH;
  }

  for (const [id, el] of els) {
    const box = placed.get(id);
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.classList.remove('measuring');
  }

  // --- Edges ---
  edgesEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const e of realEdges) {
    const ge = g.edge({ v: e.parent, w: e.child, name: e.id });
    if (!ge || !ge.points || ge.points.length < 2) continue;
    frag.appendChild(drawEdge(e, ge.points));
  }
  for (const e of selfEdges) {
    const box = placed.get(e.child);
    if (!box) continue;
    frag.appendChild(drawEdge(e, selfLoop(box)));
    maxX = Math.max(maxX, box.x + box.w + 40);
  }
  edgesEl.appendChild(frag);

  const width = maxX + 24;
  const height = maxY + 24;
  edgesEl.setAttribute('width', width);
  edgesEl.setAttribute('height', height);
  edgesEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
  worldEl.style.width = `${width}px`;
  worldEl.style.height = `${height}px`;

  state.placed = placed;
  state.edges = edges;
  return { width, height, islands: islands.length };
}

// -------------------------------------------------------------------------
// Pan, zoom, focus, search
// -------------------------------------------------------------------------
function applyTransform() {
  worldEl.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.zoom})`;
}

function fit() {
  const w = worldEl.offsetWidth;
  const h = worldEl.offsetHeight;
  const cw = canvasEl.clientWidth;
  const ch = canvasEl.clientHeight;
  if (!w || !h || !cw || !ch) return;
  const pad = 28;
  // Never blow a small schema up beyond its natural size - three tables
  // filling the screen look like a mistake.
  const z = Math.min((cw - pad * 2) / w, (ch - pad * 2) / h, 1.15);
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  state.tx = (cw - w * state.zoom) / 2;
  state.ty = (ch - h * state.zoom) / 2;
  applyTransform();
}

function zoomAt(cx, cy, factor) {
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * factor));
  if (next === state.zoom) return;
  // Keep the point under the cursor where it is
  state.tx = cx - (cx - state.tx) * (next / state.zoom);
  state.ty = cy - (cy - state.ty) * (next / state.zoom);
  state.zoom = next;
  applyTransform();
}

function applyHighlight() {
  const q = state.filter.trim().toLowerCase();
  worldEl.classList.toggle('searching', Boolean(q));
  worldEl.classList.toggle('focused', Boolean(state.focus));

  const near = new Set();
  if (state.focus) {
    near.add(state.focus);
    for (const e of state.edges) {
      if (e.parent === state.focus) near.add(e.child);
      if (e.child === state.focus) near.add(e.parent);
    }
  }

  for (const el of nodesEl.children) {
    const id = el.dataset.id;
    // In the table-level view there are no column rows to search - the name
    // is all there is, and that is what the panel search matches too.
    const hit = Boolean(q) && (id.toLowerCase().includes(q)
      || [...el.querySelectorAll('.dbg-col-name')].some((c) => c.textContent.toLowerCase().includes(q)));
    el.classList.toggle('hit', hit);
    el.classList.toggle('focus', state.focus === id);
    el.classList.toggle('near', Boolean(state.focus) && state.focus !== id && near.has(id));
  }

  for (const el of edgesEl.children) {
    const on = Boolean(state.focus)
      && (el.dataset.parent === state.focus || el.dataset.child === state.focus);
    el.classList.toggle('near', on);
  }
}

function setFocus(id) {
  state.focus = state.focus === id ? null : id;
  applyHighlight();
}

// -------------------------------------------------------------------------
// Render
// -------------------------------------------------------------------------
function renderLegend(view) {
  const items = [];
  if (view.diff && view.diff.changed) {
    items.push(`<span class="dbg-key added">${escapeHtml(t('db.status.added'))}</span>`);
    items.push(`<span class="dbg-key changed">${escapeHtml(t('db.status.changed'))}</span>`);
    items.push(`<span class="dbg-key removed">${escapeHtml(t('db.status.removed'))}</span>`);
  }
  items.push(`<span class="dbg-key note">${escapeHtml(t('dbgraph.legend.direction'))}</span>`);
  items.push(`<span class="dbg-key note">${escapeHtml(t('dbgraph.legend.optional'))}</span>`);
  legendEl.innerHTML = items.join('');
}

/**
 * @param {boolean} refit  keep the current view (background refresh) or fit
 *                         the picture to the window (open, mode change)
 */
function render(refit) {
  const view = state.view;
  if (!view || !view.ok || !view.plugin) { overlay.close(); return; }

  titleEl.textContent = `${view.plugin.label} · ${view.project || ''}`;
  renderModeButtons(scopeEl, [
    { id: 'all', label: t('dbgraph.scope.all') },
    { id: 'changed', label: t('dbgraph.scope.changed') },
  ], state.scope, (id) => { state.scope = id; render(true); });
  renderModeButtons(detailEl, [
    { id: 'tables', label: t('dbgraph.detail.tables') },
    { id: 'columns', label: t('dbgraph.detail.columns') },
  ], state.detail, (id) => { state.detail = id; render(true); });
  // Without a baseline there is nothing to reduce to
  scopeEl.classList.toggle('hidden', !view.diff || !view.diff.changed);
  if ((!view.diff || !view.diff.changed) && state.scope === 'changed') state.scope = 'all';

  searchEl.placeholder = t('dbgraph.search');
  renderLegend(view);

  const model = buildModel(view);
  const picked = applyScope(model);

  const empty = !picked.nodes.length;
  emptyEl.classList.toggle('hidden', !empty);
  canvasEl.classList.toggle('is-empty', empty);
  if (empty) {
    emptyEl.textContent = state.scope === 'changed'
      ? t('dbgraph.empty.changed')
      : t('dbgraph.empty');
    nodesEl.innerHTML = '';
    edgesEl.innerHTML = '';
    statsEl.textContent = '';
    return;
  }

  // A node the scope no longer shows must not keep dimming everything else
  if (state.focus && !picked.nodes.some((n) => n.id === state.focus)) state.focus = null;

  layout(picked.nodes, picked.edges);
  statsEl.textContent = `${t('db.tables', { count: picked.nodes.length })} · ${
    t('dbgraph.relations', { count: picked.edges.length })}`;

  if (refit) fit(); else applyTransform();
  applyHighlight();
}

// -------------------------------------------------------------------------
// Open / refresh
//
// Backdrop click, the close button, Escape and the focus back into the terminal
// all come from makeOverlay - the diagram only says what to draw.
// -------------------------------------------------------------------------

/**
 * @param {object} view    the schema state as db-schema.js holds it
 * @param {string} filter  what was searched for in the panel
 */
export function openDbGraph(view, filter) {
  if (typeof dagre === 'undefined') return; // layout library missing - nothing to show
  state.view = view;
  overlay.open();
  // Whatever was searched for in the panel is what one is looking for here too
  state.filter = filter || '';
  searchEl.value = state.filter;
  state.focus = null;
  render(true);
  searchEl.focus();
}

/**
 * New data or a new language. Draws without fitting, so a background tick does
 * not throw away where one was looking.
 */
export function refreshDbGraph(view) {
  state.view = view;
  if (overlay.isOpen()) render(false);
}

// -------------------------------------------------------------------------
// Wiring
// -------------------------------------------------------------------------
searchEl.addEventListener('input', () => {
  state.filter = searchEl.value;
  applyHighlight();
});

$('#dbgraph-tools').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const cx = canvasEl.clientWidth / 2;
  const cy = canvasEl.clientHeight / 2;
  if (btn.dataset.act === 'in') zoomAt(cx, cy, 1.25);
  if (btn.dataset.act === 'out') zoomAt(cx, cy, 1 / 1.25);
  if (btn.dataset.act === 'fit') fit();
});

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvasEl.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
}, { passive: false });

// Panning starts anywhere, including on a box - a click only counts as a
// click if the pointer stayed put.
let drag = null;
canvasEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false };
  // A pointer that is already gone (window lost focus mid-click) must not
  // take the whole drag down with it.
  try { canvasEl.setPointerCapture(e.pointerId); } catch { /* nothing to capture */ }
  canvasEl.classList.add('panning');
});
canvasEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  state.tx = drag.tx + dx;
  state.ty = drag.ty + dy;
  applyTransform();
});
canvasEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const wasDrag = drag.moved;
  drag = null;
  canvasEl.classList.remove('panning');
  try { canvasEl.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
  if (wasDrag) return;
  const node = e.target.closest('.dbg-node');
  if (node) setFocus(node.dataset.id);
  else if (state.focus) setFocus(state.focus);
});
canvasEl.addEventListener('pointercancel', () => {
  drag = null;
  canvasEl.classList.remove('panning');
});

// Keyboard: a box can be reached by tab, Enter focuses its neighbourhood
nodesEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const node = e.target.closest('.dbg-node');
  if (!node) return;
  e.preventDefault();
  setFocus(node.dataset.id);
});
