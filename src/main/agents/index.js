'use strict';
// The "sensor" for agents: checks which plugin feels responsible for a
// terminal and lets it count how many agents are working there right now.
//
// As with the DB schema, the sensor knows nothing about the technology behind
// it - not a word about Claude, transcripts or subagent directories. It only
// knows the plugin interface:
//
//   id, label
//   commandPattern  RegExp matching the command line that starts the agent
//   detect(ctx) -> { confidence, evidence[] } | null
//   read(ctx)   -> { agents: [...] }
//
// `ctx` is whatever the shell observation can tell about the terminal:
// directory, running command, bound session, and anything the refresh has
// already resolved for it. Which of those a plugin needs is
// its own business - the Claude plugin recognises itself by the bound session,
// a plugin for a different agent CLI could go by the command.
//
// `commandPattern` answers a second question, and for the whole app: which
// CLIs are agents at all. main.js asks it through isAgentCommand() before it
// applies the attention heuristic to a terminal, so a plugin brings the
// recognition of its own CLI along with the counting.
//
// Adding another plugin means: create a file under plugins/, register it in
// PLUGINS, done.

const log = require('../log');

const PLUGINS = [
  require('./plugins/claude'),
  // Recognition only, no counting - see the files.
  require('./plugins/codex'),
  require('./plugins/aider'),
];

/**
 * Is an agent CLI running here? The command line comes from the shell
 * integration, and every plugin's `commandPattern` gets to say yes.
 *
 * @param {string} cmd  command line as reported for the terminal
 */
function isAgentCommand(cmd) {
  if (!cmd) return false;
  return PLUGINS.some((p) => p.commandPattern && p.commandPattern.test(cmd));
}

// Unlike the schema, the result is *not* cached here: "currently working" is a
// statement about this very moment, and a cached one would be a lie right
// away. The only expensive part is working through the history anyway - and
// the plugin holds on to that itself.

async function detectAll(ctx) {
  const found = [];
  for (const plugin of PLUGINS) {
    let d = null;
    try {
      d = await plugin.detect(ctx);
    } catch (e) {
      // A broken plugin must not take the others down with it
      log.warn('agents: detection failed', { plugin: plugin.id, session: ctx.claudeSessionId || null, cwd: ctx.cwd || null, err: e });
      d = null;
    }
    if (d && d.confidence > 0) {
      found.push({ plugin, confidence: d.confidence, evidence: d.evidence || [] });
    }
  }
  // The most confident plugin wins; on a tie, the order above decides.
  return found.sort((a, b) => b.confidence - a.confidence);
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
    plugin: {
      id: winner.plugin.id,
      label: winner.plugin.label,
      confidence: winner.confidence,
      evidence: winner.evidence,
    },
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

module.exports = { getAgentView, isAgentCommand, PLUGINS };
