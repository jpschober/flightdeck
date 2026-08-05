'use strict';
// The "sensor" for agents: checks which plugin feels responsible for a
// terminal and lets it count how many agents are working there right now.
//
// As with the DB schema, the sensor knows nothing about the technology behind
// it - not a word about Claude, transcripts or subagent directories. It only
// knows the plugin interface:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null
//   read(ctx)   -> { agents: [...] }
//
// `ctx` is whatever the shell observation can tell about the terminal:
// directory, running command, bound session, and anything the refresh has
// already resolved for it. Which of those a plugin needs is
// its own business - the Claude plugin recognises itself by the bound session,
// a plugin for a different agent CLI could go by the command.
//
// Adding another plugin means: create a file under plugins/, register it in
// PLUGINS, done.

const log = require('../log');
const registry = require('../plugin-registry');

const PLUGINS = [
  require('./plugins/claude'),
];

// Unlike the schema, the result is *not* cached here: "currently working" is a
// statement about this very moment, and a cached one would be a lie right
// away. The only expensive part is working through the history anyway - and
// the plugin holds on to that itself.

async function detectAll(ctx) {
  return registry.detectAll(PLUGINS, ctx, {
    onError: (plugin, e) => log.warn('agents: detection failed', { plugin: plugin.id, session: ctx.claudeSessionId || null, cwd: ctx.cwd || null, err: e }),
  });
}

/**
 * How many agents are working in this terminal? `null` if no plugin feels
 * responsible - then nothing we know about is running there, and the display
 * stays empty.
 *
 * @param {object} ctx  { cwd, agentCwd, command, claudeSessionId, claudeTranscript }
 */
async function getAgentView(ctx) {
  if (!ctx) return null;

  const found = await detectAll(ctx);
  const winner = found[0];
  if (!winner) return null;

  const view = {
    plugin: registry.pluginInfo(winner),
    running: 0,
    total: 0,
    agents: [],
  };

  let agents;
  try {
    const r = await winner.plugin.read(ctx);
    agents = (r && r.agents) || [];
  } catch (e) {
    // Counting failed does not mean "no agents" - better to show no number at
    // all than a wrong one.
    log.warn('agents: reading failed', { plugin: winner.plugin.id, session: ctx.claudeSessionId || null, err: e });
    return { ...view, error: e.message };
  }

  view.total = agents.length;
  // Only what is actually needed there goes to the surface: the running agents
  // with their task. `lastActivity` stays here - the value changes constantly
  // and would trip the "did anything happen?" comparison in the refresh on
  // every single pass.
  view.agents = agents
    .filter((a) => a.running)
    .map(({ id, description, type, worktree, depth, startedAt }) => ({
      id, description, type, worktree, depth, startedAt,
    }));
  view.running = view.agents.length;
  return view;
}

module.exports = { getAgentView, PLUGINS };
