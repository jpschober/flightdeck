'use strict';
// Shared detection for the plugin systems.
//
// Agents and DB schema both keep a list of plugins that report by themselves
// whether they feel responsible for a terminal or a working directory. The
// interface is the same in both:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null
//
// So is the way the answers are weighed: everything at confidence 0 or below
// drops out, the rest is sorted by confidence, and a plugin that throws is
// skipped instead of taking the run down with it. A third system - linters,
// test runners - gets the same behaviour from here instead of a third copy.
//
// What the systems do differ in stays with them. Detection failures go to the
// caller through `onError` rather than being logged here: the agents sensor
// records session and directory, the schema sensor records repo root and state
// and additionally shows the user a warning, because "no plugin got as far as
// looking" is not the same as "no schema". A catch inside this module would
// have to drop one of the two.
//
// `onError` is called inside a catch of its own. Reporting a failure is allowed
// to fail: the schema sensor reads `err.message` for its warning text, and a
// plugin doing `throw null` turns that into a TypeError. Without the guard the
// whole detection would reject and getSchemaView would lose the panel instead of
// showing a warning in it.

/**
 * Asks every plugin whether it feels responsible, best answer first.
 *
 * @param {object[]} plugins                 the registered plugins, in the order
 *                                           that decides a tie
 * @param {object}   ctx                     whatever the plugins detect on - the
 *                                           terminal observation or a file
 *                                           provider
 * @param {object}   [opts]
 * @param {string[]} [opts.extraArrayKeys]   further keys to carry over from the
 *                                           detection result, each holding a
 *                                           list; a plugin that omits one gets
 *                                           an empty array for it
 * @param {function} [opts.onError]          `(plugin, err)` for a plugin that
 *                                           threw; the run continues afterwards,
 *                                           and so it does if this throws
 * @returns {Promise<object[]>}              `{ plugin, confidence, evidence, ...extraArrayKeys }`
 */
async function detectAll(plugins, ctx, opts = {}) {
  const { extraArrayKeys = [], onError = null } = opts;
  const found = [];
  for (const plugin of plugins) {
    let d = null;
    try {
      d = await plugin.detect(ctx);
    } catch (e) {
      // A broken plugin must not take the others down with it - and neither
      // must a reporter that breaks on the broken plugin's error.
      if (onError) {
        try { onError(plugin, e); } catch { /* nothing left to report it to */ }
      }
      d = null;
    }
    if (d && d.confidence > 0) {
      const entry = { plugin, confidence: d.confidence, evidence: d.evidence || [] };
      // Every one of these is a list; `|| []` gives each entry its own.
      for (const key of extraArrayKeys) entry[key] = d[key] || [];
      found.push(entry);
    }
  }
  // The most confident plugin wins; on a tie, the order above decides.
  return found.sort((a, b) => b.confidence - a.confidence);
}

/**
 * What the surface gets to know about the plugin that won: who it is and how
 * sure it was. `null` for no winner, so a caller can pass a lookup straight
 * through.
 *
 * @param {object} winner  an entry from detectAll()
 */
function pluginInfo(winner) {
  if (!winner) return null;
  return {
    id: winner.plugin.id,
    label: winner.plugin.label,
    confidence: winner.confidence,
    evidence: winner.evidence,
  };
}

module.exports = { detectAll, pluginInfo };
