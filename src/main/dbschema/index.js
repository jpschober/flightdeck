'use strict';
// The "sensor": checks which plugin feels responsible for a working directory,
// lets it read the schema and hands the panel the current state including the
// before/after comparison.
//
// The sensor itself knows nothing about Supabase, Drizzle or SQL. It only
// knows the plugin interface - detection and reading live entirely in the
// plugin. Adding another plugin means: create a file, register it in PLUGINS,
// done.

const path = require('path');
const { t } = require('../../i18n');
const { run } = require('../gitinfo');
const { worktreeProvider, gitProvider } = require('./files');
const { diff, describe, countChanges } = require('./diff');
const ir = require('./ir');
const log = require('../log');
const registry = require('../plugin-registry');

const PLUGINS = [
  require('./plugins/supabase'),
];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
// The panel polls regularly so the indicator on the tab is right without
// having to keep the tab open. Re-reading a schema means parsing all
// migrations, though - that must not happen every four seconds. So a
// fingerprint of the involved files is carried along per state: as long as it
// stays the same, the result stays too.
const cache = new Map(); // key -> { stamp, stampPaths, at, result }
const CACHE_MAX = 60;
const NO_PLUGIN_TTL = 15_000;

/**
 * Drops everything cached. Schemas carry translated warnings and the baselines
 * carry translated labels, so a language switch makes the cache wrong - not
 * stale, wrong. The next request reads again in the new language.
 */
function clearCache() {
  cache.clear();
  defaultBranchCache.clear();
}

function cachePut(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------------------
// Detection and reading
// ---------------------------------------------------------------------------
/**
 * @param {object}   provider  file access for the state being read
 * @param {string[]} warnings  collects what the user has to know - a plugin
 *                             that fails here is the difference between "no
 *                             schema" and "no plugin got as far as looking"
 */
async function detectAll(provider, warnings) {
  return registry.detectAll(PLUGINS, provider, {
    // The plugin names the files its schema depends on; the cache stamps them.
    extraArrayKeys: ['watch'],
    onError: (plugin, e) => {
      log.warn('dbschema: detection failed', { plugin: plugin.id, root: provider.root, kind: provider.kind, err: e });
      if (warnings) warnings.push(t('db.detectFailed', { plugin: plugin.label, message: e.message }));
    },
  });
}

/**
 * Reads the schema behind `provider` - with cache. Always returns an object,
 * even if no plugin feels responsible (then `plugin: null`).
 */
async function loadSchema(provider, key, force = false) {
  const hit = cache.get(key);
  if (hit && !force) {
    const fresh = hit.result.plugin
      ? (await provider.stamp(hit.stampPaths)) === hit.stamp
      : Date.now() - hit.at < NO_PLUGIN_TTL;
    if (fresh) return hit.result;
  }

  const warnings = [];
  const found = await detectAll(provider, warnings);
  const winner = found[0] || null;

  let result;
  let stampPaths;
  if (!winner) {
    result = {
      plugin: null,
      candidates: found.map((f) => ({ id: f.plugin.id, label: f.plugin.label })),
      schema: ir.empty({ root: provider.root }),
    };
    // Without a plugin the panel says "no schema detected". If a plugin threw
    // on the way there, that sentence is wrong - the warning says so.
    result.schema.warnings.push(...warnings);
    // Keep an eye on the root: if a `supabase/` appears, its mtime jumps
    stampPaths = ['.'];
  } else {
    let schema;
    try {
      schema = await winner.plugin.read(provider);
    } catch (e) {
      log.warn('dbschema: reading failed', { plugin: winner.plugin.id, root: provider.root, kind: provider.kind, err: e });
      schema = ir.empty({ plugin: winner.plugin.id, label: winner.plugin.label, root: provider.root });
      schema.warnings.push(t('db.readFailed', { message: e.message }));
    }
    schema.warnings.push(...warnings);
    result = {
      plugin: registry.pluginInfo(winner),
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
// Baseline for the comparison
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
 * The possible comparison baselines, best first. Offering more than one is not
 * a luxury: "what did I just change" (HEAD) and "what does this branch change
 * in total" (branch point) are different questions, and when reviewing a PR the
 * second one is the right one.
 */
async function baselineOptions(root, pr) {
  const headOut = await run('git', ['rev-parse', 'HEAD'], root);
  const head = headOut && headOut.trim() ? headOut.trim() : null;
  if (!head) return []; // no commit, so no "before"

  const options = [];
  const seen = new Set();
  const push = (opt) => {
    if (!opt.ref || seen.has(opt.ref)) return;
    seen.add(opt.ref);
    options.push(opt);
  };

  // A branch point that sits on HEAD is not a baseline of its own: you are
  // standing on the target branch, "all changes on the branch" are then the
  // uncommitted ones - and for those HEAD is the more honest label.
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
        label: t('baseline.pr', { number: pr.number, base: pr.baseRefName }),
        hint: t('baseline.pr.hint'),
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
        label: t('baseline.branch', { branch: def.replace(/^origin\//, '') }),
        hint: t('baseline.branch.hint'),
      });
    }
  }

  push({
    mode: 'head',
    ref: head,
    label: t('baseline.head'),
    hint: t('baseline.head.hint'),
  });

  return options;
}

// ---------------------------------------------------------------------------
// Entry point for the panel
// ---------------------------------------------------------------------------

/**
 * Complete state for the DB schema tab: detected plugin, current schema,
 * comparison baseline and diff.
 *
 * @param {string} root       repo root or working directory
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

  // Without git there is no "before" - we still show the schema.
  const baselines = await baselineOptions(root, opts.pr);
  view.baselines = baselines.map(({ mode, label, hint }) => ({ mode, label, hint }));
  if (!baselines.length) return view;

  const wanted = opts.baseline && opts.baseline !== 'auto'
    ? baselines.find((b) => b.mode === opts.baseline)
    : null;
  const chosen = wanted || baselines[0];

  const baseProvider = gitProvider(root, chosen.ref, chosen.label);
  // The baseline gets its own detection: whoever is only just introducing
  // Supabase had no plugin before - then simply everything is new.
  const base = await loadSchema(baseProvider, `ref|${root}|${chosen.ref}`, false);

  view.base = base.schema;
  view.baseline = { mode: chosen.mode, label: chosen.label, hint: chosen.hint, ref: chosen.ref.slice(0, 8) };
  view.diff = diff(base.schema, current.schema);
  view.changeCount = countChanges(view.diff);
  view.changeText = describe(view.diff);
  return view;
}

module.exports = { getSchemaView, clearCache, PLUGINS };
