'use strict';
// Nutzungslimits des Claude-Abos. Die Zahlen kommen von /api/oauth/usage -
// derselben Quelle, aus der sich /usage in Claude Code speist. Die Transcripts
// taugen dafuer nicht: sie enthalten Token-Zaehler, aber keinen Limit-Stand.
//
// Der Endpoint ist nicht dokumentiert und kann sich ohne Ankuendigung aendern.
// Deshalb wird alles defensiv gelesen und ein Fehler sichtbar gemeldet, statt
// stillschweigend veraltete Zahlen anzuzeigen.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TTL = 60_000;
const TIMEOUT = 10_000;

const WINDOWS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  seven_day_opus: 7 * 24 * 60 * 60 * 1000,
  seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
};

// Unterhalb dieses Anteils des Fensters ist die Hochrechnung reines Rauschen -
// ein einziger Prompt in der ersten Minute ergaebe sonst "500 % projiziert".
const MIN_FRACTION = 0.05;

// Ab wie viel Prozent ueber dem Ziel die Ampel umschlaegt
const AMBER_AT = 100;
const RED_AT = 115;

let cache = { at: 0, data: null };

function readToken() {
  let raw;
  try {
    raw = fs.readFileSync(CREDENTIALS, 'utf8');
  } catch {
    return { error: 'Keine Claude-Anmeldung gefunden (~/.claude/.credentials.json).' };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'Anmeldedaten sind unlesbar.' };
  }
  const oauth = json.claudeAiOauth || {};
  if (!oauth.accessToken) return { error: 'Kein OAuth-Token hinterlegt - in Claude Code anmelden.' };
  // expiresAt ist ein Millisekunden-Zeitstempel; abgelaufene Token koennen wir
  // nicht selbst erneuern, das macht Claude Code beim naechsten Start.
  if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) {
    return { error: 'Token abgelaufen - Claude Code einmal starten, um es zu erneuern.' };
  }
  return { token: oauth.accessToken, plan: oauth.subscriptionType || null };
}

// resets_at kommt als ISO-String; aeltere Fassungen liefern Epoch-Sekunden
function parseReset(value) {
  if (value == null) return null;
  const asNumber = typeof value === 'number' ? value : Number(value);
  // Zahlen anhand der Groessenordnung unterscheiden: alles ab ~2001 in
  // Millisekunden liegt ueber 1e12, Sekunden-Zeitstempel darunter.
  if (Number.isFinite(asNumber) && asNumber > 1e9) {
    return asNumber > 1e12 ? asNumber : asNumber * 1000;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Kern der Anzeige: Ist-Verbrauch gegen den Anteil des Fensters, der schon
// vorbei ist. Nach 3 von 7 Tagen sind 3/7 = 42,9 % das Soll - wer darueber
// liegt, reisst das Limit, wenn das Tempo bleibt.
function pace(limit, windowMs) {
  const used = typeof limit.utilization === 'number' ? limit.utilization : null;
  const resetsAt = parseReset(limit.resets_at);
  const base = { used, resetsAt, windowMs };
  if (used === null || resetsAt === null) return { ...base, status: 'unknown' };

  const startedAt = resetsAt - windowMs;
  const elapsed = Math.min(Math.max(Date.now() - startedAt, 0), windowMs);
  const fraction = elapsed / windowMs;
  const budget = fraction * 100;          // erlaubter Maximalwert zum Jetzt-Zeitpunkt
  const headroom = budget - used;         // positiv = Luft, negativ = drueber

  // Limit bereits ausgeschoepft - das ist unabhaengig von jeder Hochrechnung rot
  if (used >= 100) {
    return { ...base, startedAt, fraction, budget, headroom, projected: 100, status: 'over' };
  }

  // Zu frueh im Fenster fuer eine belastbare Hochrechnung
  if (fraction < MIN_FRACTION) {
    return { ...base, startedAt, fraction, budget, headroom, projected: null, status: 'early' };
  }

  const projected = used / fraction;      // Verbrauch am Fensterende bei gleichem Tempo
  let status = 'ok';
  if (projected > RED_AT) status = 'over';
  else if (projected > AMBER_AT) status = 'warn';
  return { ...base, startedAt, fraction, budget, headroom, projected, status };
}

async function fetchUsage(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { error: 'Token wurde abgelehnt - in Claude Code neu anmelden.' };
    }
    if (!res.ok) return { error: `Abruf fehlgeschlagen (HTTP ${res.status}).` };
    return { json: await res.json() };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Zeitueberschreitung beim Abruf.' };
    return { error: 'Netzwerkfehler: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

function shape(json, plan) {
  const pick = (key) => {
    const raw = json && json[key];
    if (!raw || typeof raw !== 'object') return null;
    return pace(raw, WINDOWS[key] || WINDOWS.seven_day);
  };
  return {
    plan,
    fetchedAt: Date.now(),
    fiveHour: pick('five_hour'),
    sevenDay: pick('seven_day'),
    sevenDayOpus: pick('seven_day_opus'),
    sevenDaySonnet: pick('seven_day_sonnet'),
  };
}

async function getUsage(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data;

  const creds = readToken();
  if (creds.error) return { error: creds.error };

  const res = await fetchUsage(creds.token);
  if (res.error) {
    // Letzten guten Stand behalten, aber als veraltet kennzeichnen
    if (cache.data) return { ...cache.data, error: res.error, stale: true };
    return { error: res.error };
  }

  const data = shape(res.json, creds.plan);
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getUsage, pace, parseReset };
