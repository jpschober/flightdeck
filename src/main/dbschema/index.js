'use strict';
// Der "Senser": prueft, welches Plugin sich fuer ein Arbeitsverzeichnis
// zustaendig fuehlt, laesst es das Schema lesen und stellt dem Panel den
// aktuellen Stand samt Vorher/Nachher-Vergleich hin.
//
// Der Senser selbst weiss nichts ueber Supabase, Drizzle oder SQL. Er kennt nur
// die Plugin-Schnittstelle - Erkennung und Lesen stecken vollstaendig im
// Plugin. Ein weiteres Plugin einzuhaengen heisst: Datei anlegen, in PLUGINS
// eintragen, fertig.

const path = require('path');
const { run } = require('../gitinfo');
const { worktreeProvider, gitProvider } = require('./files');
const { diff, describe, countChanges } = require('./diff');
const ir = require('./ir');

const PLUGINS = [
  require('./plugins/supabase'),
];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
// Das Panel fragt regelmaessig nach, damit die Anzeige am Tab stimmt, ohne dass
// man den Tab offen haben muss. Ein Schema neu zu lesen heisst aber, alle
// Migrationen zu parsen - das darf nicht alle vier Sekunden passieren. Deshalb
// wird pro Stand ein Fingerabdruck der beteiligten Dateien mitgefuehrt: bleibt
// er gleich, bleibt das Ergebnis stehen.
const cache = new Map(); // key -> { stamp, stampPaths, at, result }
const CACHE_MAX = 60;
const NO_PLUGIN_TTL = 15_000;

function cachePut(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------------------
// Erkennung und Lesen
// ---------------------------------------------------------------------------
async function detectAll(provider) {
  const found = [];
  for (const plugin of PLUGINS) {
    let d = null;
    try {
      d = await plugin.detect(provider);
    } catch (e) {
      // Ein kaputtes Plugin darf die anderen nicht mitnehmen
      d = null;
    }
    if (d && d.confidence > 0) {
      found.push({
        plugin,
        confidence: d.confidence,
        evidence: d.evidence || [],
        watch: d.watch || [],
      });
    }
  }
  // Das ueberzeugteste Plugin gewinnt; bei Gleichstand die Reihenfolge oben.
  return found.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Liest das Schema hinter `provider` - mit Cache. Liefert immer ein Objekt,
 * auch wenn sich kein Plugin zustaendig fuehlt (dann `plugin: null`).
 */
async function loadSchema(provider, key, force = false) {
  const hit = cache.get(key);
  if (hit && !force) {
    const fresh = hit.result.plugin
      ? (await provider.stamp(hit.stampPaths)) === hit.stamp
      : Date.now() - hit.at < NO_PLUGIN_TTL;
    if (fresh) return hit.result;
  }

  const found = await detectAll(provider);
  const winner = found[0] || null;

  let result;
  let stampPaths;
  if (!winner) {
    result = {
      plugin: null,
      candidates: found.map((f) => ({ id: f.plugin.id, label: f.plugin.label })),
      schema: ir.empty({ root: provider.root }),
    };
    // Die Wurzel im Blick behalten: kommt ein `supabase/` dazu, springt ihre mtime
    stampPaths = ['.'];
  } else {
    let schema;
    try {
      schema = await winner.plugin.read(provider);
    } catch (e) {
      schema = ir.empty({ plugin: winner.plugin.id, label: winner.plugin.label, root: provider.root });
      schema.warnings.push(`Lesen fehlgeschlagen: ${e.message}`);
    }
    result = {
      plugin: {
        id: winner.plugin.id,
        label: winner.plugin.label,
        confidence: winner.confidence,
        evidence: winner.evidence,
      },
      candidates: found.map((f) => ({ id: f.plugin.id, label: f.plugin.label })),
      schema,
    };
    stampPaths = [...new Set([...winner.watch, ...schema.files])];
  }

  cachePut(key, {
    stamp: await provider.stamp(stampPaths),
    stampPaths,
    at: Date.now(),
    result,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Basis fuer den Vergleich
// ---------------------------------------------------------------------------
const defaultBranchCache = new Map(); // root -> ref | null

async function defaultBranch(root) {
  if (defaultBranchCache.has(root)) return defaultBranchCache.get(root);
  let ref = null;
  const sym = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (sym && sym.trim()) {
    ref = sym.trim();
  } else {
    for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
      const ok = await run('git', ['rev-parse', '--verify', '--quiet', cand], root);
      if (ok && ok.trim()) { ref = cand; break; }
    }
  }
  defaultBranchCache.set(root, ref);
  return ref;
}

/**
 * Die moeglichen Vergleichsbasen, beste zuerst. Mehr als eine anzubieten ist
 * kein Luxus: "was habe ich gerade geaendert" (HEAD) und "was aendert dieser
 * Branch insgesamt" (Abzweigpunkt) sind verschiedene Fragen, und beim Pruefen
 * eines PR ist die zweite die richtige.
 */
async function baselineOptions(root, pr) {
  const headOut = await run('git', ['rev-parse', 'HEAD'], root);
  const head = headOut && headOut.trim() ? headOut.trim() : null;
  if (!head) return []; // kein Commit, also kein "vorher"

  const options = [];
  const seen = new Set();
  const push = (opt) => {
    if (!opt.ref || seen.has(opt.ref)) return;
    seen.add(opt.ref);
    options.push(opt);
  };

  // Ein Abzweigpunkt, der auf HEAD liegt, ist keine eigene Basis: man steht auf
  // dem Zielbranch, "alle Änderungen des Branches" sind dann die nicht
  // committeten - und dafuer ist HEAD die ehrlichere Beschriftung.
  const branchPoint = async (ref) => {
    const mb = await run('git', ['merge-base', 'HEAD', ref], root);
    const sha = mb && mb.trim() ? mb.trim() : null;
    return sha && sha !== head ? sha : null;
  };

  if (pr && pr.baseRefName) {
    const ref = await branchPoint(`origin/${pr.baseRefName}`);
    if (ref) {
      push({
        mode: 'pr',
        ref,
        label: `PR #${pr.number} · gegen ${pr.baseRefName}`,
        hint: 'alle Änderungen dieses Pull Requests',
      });
    }
  }

  const def = await defaultBranch(root);
  if (def) {
    const ref = await branchPoint(def);
    if (ref) {
      push({
        mode: 'branch',
        ref,
        label: `Abzweig von ${def.replace(/^origin\//, '')}`,
        hint: 'alle Änderungen dieses Branches',
      });
    }
  }

  push({
    mode: 'head',
    ref: head,
    label: 'letzter Commit (HEAD)',
    hint: 'nur was noch nicht committet ist',
  });

  return options;
}

// ---------------------------------------------------------------------------
// Einstieg fuer das Panel
// ---------------------------------------------------------------------------

/**
 * Kompletter Stand fuer den DB-Schema-Tab: erkanntes Plugin, aktuelles Schema,
 * Vergleichsbasis und Diff.
 *
 * @param {string} root       Repo-Wurzel bzw. Arbeitsverzeichnis
 * @param {object} opts       { pr, baseline: 'auto'|'pr'|'branch'|'head', force }
 */
async function getSchemaView(root, opts = {}) {
  if (!root) return { ok: false, reason: 'no-root' };

  const provider = worktreeProvider(root);
  const current = await loadSchema(provider, `wt|${root}`, Boolean(opts.force));

  const view = {
    ok: true,
    root,
    project: path.basename(root),
    plugin: current.plugin,
    candidates: current.candidates,
    schema: current.schema,
    base: null,
    baseline: null,
    baselines: [],
    diff: null,
    changeCount: 0,
    changeText: null,
  };

  if (!current.plugin) return view;

  // Ohne Git gibt es kein "vorher" - das Schema zeigen wir trotzdem.
  const baselines = await baselineOptions(root, opts.pr);
  view.baselines = baselines.map(({ mode, label, hint }) => ({ mode, label, hint }));
  if (!baselines.length) return view;

  const wanted = opts.baseline && opts.baseline !== 'auto'
    ? baselines.find((b) => b.mode === opts.baseline)
    : null;
  const chosen = wanted || baselines[0];

  const baseProvider = gitProvider(root, chosen.ref, chosen.label);
  // Die Basis bekommt ihre eigene Erkennung: wer Supabase gerade erst
  // einfuehrt, hat vorher kein Plugin - dann ist schlicht alles neu.
  const base = await loadSchema(baseProvider, `ref|${root}|${chosen.ref}`, false);

  view.base = base.schema;
  view.baseline = { mode: chosen.mode, label: chosen.label, hint: chosen.hint, ref: chosen.ref.slice(0, 8) };
  view.diff = diff(base.schema, current.schema);
  view.changeCount = countChanges(view.diff);
  view.changeText = describe(view.diff);
  return view;
}

module.exports = { getSchemaView, PLUGINS };
