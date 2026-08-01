'use strict';
// Agenten-Plugin fuer Claude Code.
//
// Ein Plugin bringt beides selbst mit: die Erkennung ("laeuft hier etwas, das
// ich zaehlen kann?") und das Zaehlen. Der Senser kennt nur diese
// Schnittstelle:
//
//   id, label
//   detect(ctx) -> { confidence, evidence[] } | null
//   read(ctx)   -> { agents: [...] }
//
// Claude Code legt jeden Subagenten einer Session als eigenes Paar ab:
//
//   ~/.claude/projects/<projekt>/<session-uuid>/subagents/
//       agent-<id>.jsonl       Transcript des Agenten
//       agent-<id>.meta.json   Auftrag, Typ, Worktree - beim Start geschrieben
//
// Einen Status ("arbeitet noch") gibt es dort nicht. Er ergibt sich aus drei
// Signalen, und erst zusammen sind sie belastbar:
//
//   Start    die meta.json entsteht in dem Moment, in dem der Agent
//            losgeschickt wird - ihre mtime ist der Startzeitpunkt.
//   Stopp    eine <task-notification> im Transcript des Auftraggebers. Das
//            tool_result des Agent-Aufrufs taugt dafuer nicht: Agenten laufen
//            asynchron, es meldet nur "launched successfully" und steht schon
//            drei Sekunden nach dem Start da.
//   Erneut   ein SendMessage an denselben Agenten. Danach arbeitet er wieder,
//            und die vorige Abschlussmeldung ist verbraucht.
//
// Das ist alles undokumentiertes internes Format. Aendert Claude Code daran
// etwas, faellt hier nichts um: dann findet das Plugin keine Agenten und
// meldet null - die Anzeige verschwindet, statt falsch zu werden.

const fs = require('fs');
const path = require('path');
const { findTranscriptById } = require('../../claude-sessions');

const id = 'claude';
const label = 'Claude Code';

// Ohne Abschlussmeldung wuerde ein Agent ewig als "arbeitet" stehenbleiben -
// etwa wenn Claude abstuerzt oder hart beendet wird. Wer so lange nichts mehr
// geschrieben hat, gilt deshalb als verwaist. Grosszuegig bemessen: ein Agent,
// der auf einen langen Build wartet, schreibt zwischendurch auch nichts.
const SILENCE_MS = 15 * 60 * 1000;

// Erkennung ohne gebundene Session (s. detect)
const CLAUDE_CMD_RE = /(?:^|[\s/\\])claude(?:\s|$)/i;

const META_RE = /^agent-(.+)\.meta\.json$/;
const NOTIF_TASK_RE = /<task-id>([^<]+)<\/task-id>/;
const NOTIF_STATUS_RE = /<status>([^<]+)<\/status>/;

// ---------------------------------------------------------------------------
// Ablage der Session
// ---------------------------------------------------------------------------
// Gebunden wird ueber die Session-ID, nicht ueber den Pfad: wechselt der Agent
// in einen Worktree, wandert das Transcript in ein anderes Projektverzeichnis.
function subagentsDir(sessionId) {
  const transcript = findTranscriptById(sessionId);
  if (!transcript) return null;
  return path.join(path.dirname(transcript), sessionId, 'subagents');
}

const metaCache = new Map(); // Pfad -> { mtimeMs, data }
const META_CACHE_MAX = 400;

// Die meta.json wird beim Start geschrieben und danach nicht mehr angefasst;
// gelesen wird sie trotzdem nur, wenn sich die mtime bewegt hat.
function readMeta(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;

  let data = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      description: parsed.description || null,
      agentType: parsed.agentType || null,
      worktreePath: parsed.worktreePath || null,
      spawnDepth: parsed.spawnDepth || 1,
      startedAt: stat.mtimeMs,
    };
  } catch {
    return null; // halb geschriebene Datei - beim naechsten Durchlauf nochmal
  }
  metaCache.delete(file);
  metaCache.set(file, { mtimeMs: stat.mtimeMs, data });
  while (metaCache.size > META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
  return data;
}

// ---------------------------------------------------------------------------
// Stopp- und Wiederaufnahme-Signale aus den Transcripts
// ---------------------------------------------------------------------------
// Transcripts wachsen nur hinten an. Gemerkt wird deshalb pro Datei, bis wohin
// sie gelesen ist: der erste Durchlauf kostet einmal die ganze Datei, jeder
// weitere nur noch den neuen Rest. Ohne das waere ein Megabyte alle vier
// Sekunden faellig.
const scans = new Map(); // sessionId -> { offsets: Map, events: Map }
const SCAN_MAX = 20;

function scanState(sessionId) {
  let state = scans.get(sessionId);
  if (!state) {
    state = { offsets: new Map(), events: new Map() };
    scans.set(sessionId, state);
    while (scans.size > SCAN_MAX) scans.delete(scans.keys().next().value);
  }
  return state;
}

function eventOf(state, agentId) {
  let ev = state.events.get(agentId);
  if (!ev) { ev = { stoppedAt: 0, resumedAt: 0 }; state.events.set(agentId, ev); }
  return ev;
}

function messageText(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const b of c) if (b && b.type === 'text' && b.text) out += b.text;
  return out;
}

function applyLine(state, line) {
  // Vorfiltern, bevor geparst wird: die allermeisten Zeilen sind fuer uns
  // uninteressant, und JSON.parse auf jede waere der teuerste Teil.
  const notif = line.includes('<task-notification>');
  if (!notif && !line.includes('"SendMessage"')) return;

  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const at = Date.parse(entry.timestamp) || Date.now();

  if (notif) {
    const text = messageText(entry);
    const m = NOTIF_TASK_RE.exec(text);
    if (m) {
      // Jede Meldung heisst "haelt an" - der Status sagt nur, wie. Ein Agent,
      // der weitermachen soll, wird per SendMessage neu angestossen.
      const ev = eventOf(state, m[1]);
      if (at > ev.stoppedAt) {
        ev.stoppedAt = at;
        const s = NOTIF_STATUS_RE.exec(text);
        ev.status = s ? s[1] : null;
      }
    }
  }

  const c = entry.message && entry.message.content;
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (!b || b.type !== 'tool_use' || b.name !== 'SendMessage') continue;
    const to = b.input && b.input.to;
    if (!to) continue;
    const ev = eventOf(state, String(to));
    if (at > ev.resumedAt) ev.resumedAt = at;
  }
}

function scanFile(state, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; }

  let from = state.offsets.get(file) || 0;
  if (stat.size < from) from = 0; // Datei ersetzt oder gekuerzt -> von vorn
  if (stat.size === from) return;

  const len = stat.size - from;
  const buf = Buffer.alloc(len);
  let n = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try { n = fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
  } catch {
    return;
  }

  // Nur bis zur letzten vollstaendigen Zeile auswerten. Der Rest wird gerade
  // geschrieben und kommt beim naechsten Durchlauf - der Zeilenumbruch ist
  // zugleich die Grenze, an der das Gelesene sicher gueltiges UTF-8 ist.
  const text = buf.toString('utf8', 0, n);
  const end = text.lastIndexOf('\n');
  if (end < 0) return;
  state.offsets.set(file, from + Buffer.byteLength(text.slice(0, end + 1)));

  for (const line of text.slice(0, end).split('\n')) {
    if (line) applyLine(state, line);
  }
}

// ---------------------------------------------------------------------------
// Schnittstelle zum Senser
// ---------------------------------------------------------------------------

/**
 * Zustaendig ist das Plugin, sobald eine Claude-Session am Terminal haengt.
 * Die Bindung Terminal -> Session stellt die Shell-Beobachtung her (sie sieht
 * den Start von `claude` und weiss, welches Transcript daraufhin entstanden
 * ist); das Plugin nimmt sie als Beleg und macht den Rest selbst.
 */
function detect(ctx) {
  if (ctx.claudeSessionId) {
    const dir = subagentsDir(ctx.claudeSessionId);
    const evidence = [`Session ${ctx.claudeSessionId.slice(0, 8)}`];
    if (dir && fs.existsSync(dir)) evidence.push('subagents/');
    return { confidence: 0.95, evidence };
  }
  // Claude laeuft sichtbar, aber die Bindung ans Transcript fehlt (Start ohne
  // Shell-Integration). Zaehlen laesst sich dann nichts - aber die Zustaendigkeit
  // steht fest, und ein Plugin, das hier mehr kann, gewinnt mit hoeherem Wert.
  if (ctx.command && CLAUDE_CMD_RE.test(ctx.command)) {
    return { confidence: 0.3, evidence: ['Kommando `claude`, keine Session gebunden'] };
  }
  return null;
}

/**
 * Alle Subagenten der gebundenen Session, jeder mit `running`.
 */
function read(ctx) {
  if (!ctx.claudeSessionId) return { agents: [] };
  const dir = subagentsDir(ctx.claudeSessionId);
  if (!dir) return { agents: [] };

  let entries;
  try { entries = fs.readdirSync(dir); } catch { return { agents: [] }; }

  const metas = [];
  for (const f of entries) {
    const m = META_RE.exec(f);
    if (!m) continue;
    const meta = readMeta(path.join(dir, f));
    if (meta) metas.push({ id: m[1], ...meta });
  }
  if (!metas.length) return { agents: [] };

  const state = scanState(ctx.claudeSessionId);
  const transcript = findTranscriptById(ctx.claudeSessionId);
  if (transcript) scanFile(state, transcript);
  // Ein verschachtelter Agent meldet seinen Abschluss an seinen Auftraggeber -
  // und der ist selbst ein Subagent. Nur dann sind deren Transcripts noetig.
  if (metas.some((m) => m.spawnDepth > 1)) {
    for (const m of metas) scanFile(state, path.join(dir, `agent-${m.id}.jsonl`));
  }

  const now = Date.now();
  const agents = metas.map((m) => {
    const ev = state.events.get(m.id) || {};
    // Wiederaufnahme setzt den Startzeitpunkt neu - eine Abschlussmeldung von
    // davor ist damit verbraucht.
    const startedAt = Math.max(m.startedAt, ev.resumedAt || 0);
    const stopped = Boolean(ev.stoppedAt && ev.stoppedAt >= startedAt);

    let lastActivity = m.startedAt;
    try {
      const stat = fs.statSync(path.join(dir, `agent-${m.id}.jsonl`));
      if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
    } catch { /* Transcript noch nicht angelegt */ }

    return {
      id: m.id,
      description: m.description,
      type: m.agentType,
      worktree: m.worktreePath ? path.basename(m.worktreePath) : null,
      depth: m.spawnDepth,
      startedAt,
      lastActivity,
      running: !stopped && now - lastActivity < SILENCE_MS,
    };
  });

  agents.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
  return { agents };
}

module.exports = { id, label, detect, read };
