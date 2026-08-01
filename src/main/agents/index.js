'use strict';
// Der "Senser" fuer Agenten: prueft, welches Plugin sich fuer ein Terminal
// zustaendig fuehlt, und laesst es zaehlen, wie viele Agenten dort gerade
// arbeiten.
//
// Wie beim DB-Schema weiss der Senser nichts ueber die Technik dahinter - kein
// Wort ueber Claude, Transcripts oder Subagenten-Verzeichnisse. Er kennt nur
// die Plugin-Schnittstelle:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null
//   read(ctx)   -> { agents: [...] }
//
// `ctx` ist, was die Shell-Beobachtung ueber das Terminal hergibt: Verzeichnis,
// laufendes Kommando, gebundene Session. Welche dieser Angaben ein Plugin
// braucht, ist seine Sache - das Claude-Plugin erkennt sich an der gebundenen
// Session, ein Plugin fuer eine andere Agenten-CLI koennte am Kommando gehen.
//
// Ein weiteres Plugin einzuhaengen heisst: Datei unter plugins/ anlegen, in
// PLUGINS eintragen, fertig.

const PLUGINS = [
  require('./plugins/claude'),
];

// Anders als beim Schema wird das Ergebnis hier *nicht* zwischengespeichert:
// "arbeitet gerade" ist eine Aussage ueber den Augenblick, ein gecachter Stand
// waere sofort gelogen. Teuer ist ohnehin nur das Aufarbeiten der Historie -
// und das haelt das Plugin selbst fest.

async function detectAll(ctx) {
  const found = [];
  for (const plugin of PLUGINS) {
    let d = null;
    try {
      d = await plugin.detect(ctx);
    } catch (e) {
      // Ein kaputtes Plugin darf die anderen nicht mitnehmen
      d = null;
    }
    if (d && d.confidence > 0) {
      found.push({ plugin, confidence: d.confidence, evidence: d.evidence || [] });
    }
  }
  // Das ueberzeugteste Plugin gewinnt; bei Gleichstand die Reihenfolge oben.
  return found.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Wie viele Agenten arbeiten in diesem Terminal? `null`, wenn sich kein Plugin
 * zustaendig fuehlt - dann laeuft dort nichts, wovon wir wissen, und die
 * Anzeige bleibt leer.
 *
 * @param {object} ctx  { cwd, agentCwd, command, claudeSessionId }
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
    // Zaehlen fehlgeschlagen heisst nicht "keine Agenten" - lieber gar keine
    // Zahl zeigen als eine falsche.
    return { ...view, error: e.message };
  }

  view.total = agents.length;
  // An die Oberflaeche geht nur, was dort auch gebraucht wird: die laufenden
  // Agenten mit ihrem Auftrag. `lastActivity` bleibt hier - der Wert aendert
  // sich staendig und wuerde den Vergleich "hat sich etwas getan?" im Refresh
  // bei jedem Durchlauf ausloesen.
  view.agents = agents
    .filter((a) => a.running)
    .map(({ id, description, type, worktree, depth, startedAt }) => ({
      id, description, type, worktree, depth, startedAt,
    }));
  view.running = view.agents.length;
  return view;
}

module.exports = { getAgentView, PLUGINS };
