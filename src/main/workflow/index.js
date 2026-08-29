'use strict';
// The "sensor" for workflows: checks which methodology a Claude session follows
// and asks it which step the session is in right now.
//
// This is the third plugin system after agents and dbschema, and it shares
// their detection core (plugin-registry) - everything at confidence 0 drops
// out, the rest is sorted, a plugin that throws is isolated. Like agents, and
// unlike dbschema, nothing is cached here: "which step right now" is a
// statement about this very moment, and the plugin keeps the only expensive
// part (the incremental transcript scan) to itself.
//
// The sensor knows nothing about SDD, Tore or phase files - only the interface:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null
//   read(ctx)   -> { step: {...} | null }
//
// `ctx` is the terminal observation the refresh has already resolved: cwd,
// gitRoot, branch, pr, and the bound Claude session and transcript. Adding
// another workflow means: create a file under plugins/, register it, done.

const log = require('../log');
const registry = require('../plugin-registry');

const PLUGINS = [
  require('./plugins/sdd'),
];

async function detectAll(ctx) {
  return registry.detectAll(PLUGINS, ctx, {
    onError: (plugin, e) => log.warn('workflow: detection failed', { plugin: plugin.id, session: ctx.claudeSessionId || null, cwd: ctx.cwd || null, err: e }),
  });
}

/**
 * Which workflow does this session follow, and where is it? `null` if no
 * plugin feels responsible - then the tab shows nothing. `step` is `null` while
 * a recognised workflow has no active run (e.g. sitting on `main`).
 *
 * @param {object} ctx  { cwd, agentCwd, command, gitRoot, branch, pr,
 *                        claudeSessionId, claudeTranscript }
 */
async function getWorkflowView(ctx) {
  if (!ctx) return null;

  const found = await detectAll(ctx);
  const winner = found[0];
  if (!winner) return null;

  let step = null;
  try {
    const r = await winner.plugin.read(ctx);
    step = (r && r.step) || null;
  } catch (e) {
    // A failed read does not mean "no workflow" - better to show the label
    // without a step than a wrong one.
    log.warn('workflow: reading failed', { plugin: winner.plugin.id, session: ctx.claudeSessionId || null, err: e });
    return { plugin: registry.pluginInfo(winner), step: null, error: e.message };
  }

  return { plugin: registry.pluginInfo(winner), step };
}

module.exports = { getWorkflowView, PLUGINS };
