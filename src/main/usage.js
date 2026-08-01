'use strict';
// Usage limits of the Claude subscription. The numbers come from
// /api/oauth/usage - the same source that feeds /usage in Claude Code. The
// transcripts are no good for this: they contain token counters, but no limit
// state.
//
// The endpoint is undocumented and can change without notice. Everything is
// therefore read defensively, and an error is reported visibly instead of
// silently showing stale numbers.
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

// Below this fraction of the window the projection is pure noise - a single
// prompt in the first minute would otherwise yield "500 % projected".
const MIN_FRACTION = 0.05;

// How many percent above target the traffic light flips
const AMBER_AT = 100;
const RED_AT = 115;

let cache = { at: 0, data: null };

function readToken() {
  let raw;
  try {
    raw = fs.readFileSync(CREDENTIALS, 'utf8');
  } catch {
    return { error: 'No Claude login found (~/.claude/.credentials.json).' };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'Credentials are unreadable.' };
  }
  const oauth = json.claudeAiOauth || {};
  if (!oauth.accessToken) return { error: 'No OAuth token stored - sign in via Claude Code.' };
  // expiresAt is a millisecond timestamp; we cannot refresh expired tokens
  // ourselves, Claude Code does that on its next start.
  if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) {
    return { error: 'Token expired - start Claude Code once to refresh it.' };
  }
  return { token: oauth.accessToken, plan: oauth.subscriptionType || null };
}

// resets_at arrives as an ISO string; older versions deliver epoch seconds
function parseReset(value) {
  if (value == null) return null;
  const asNumber = typeof value === 'number' ? value : Number(value);
  // Tell numbers apart by magnitude: anything from ~2001 onwards is above 1e12
  // in milliseconds, second timestamps stay below that.
  if (Number.isFinite(asNumber) && asNumber > 1e9) {
    return asNumber > 1e12 ? asNumber : asNumber * 1000;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// The heart of the display: actual usage against the fraction of the window
// that has already passed. After 3 of 7 days, 3/7 = 42.9 % is the target -
// anyone above that will blow the limit if the pace holds.
function pace(limit, windowMs) {
  const used = typeof limit.utilization === 'number' ? limit.utilization : null;
  const resetsAt = parseReset(limit.resets_at);
  const base = { used, resetsAt, windowMs };
  if (used === null || resetsAt === null) return { ...base, status: 'unknown' };

  const startedAt = resetsAt - windowMs;
  const elapsed = Math.min(Math.max(Date.now() - startedAt, 0), windowMs);
  const fraction = elapsed / windowMs;
  const budget = fraction * 100;          // maximum value allowed as of now
  const headroom = budget - used;         // positive = room, negative = over

  // Limit already exhausted - that is red regardless of any projection
  if (used >= 100) {
    return { ...base, startedAt, fraction, budget, headroom, projected: 100, status: 'over' };
  }

  // Too early in the window for a meaningful projection
  if (fraction < MIN_FRACTION) {
    return { ...base, startedAt, fraction, budget, headroom, projected: null, status: 'early' };
  }

  const projected = used / fraction;      // usage at the end of the window at the same pace
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
      return { error: 'Token was rejected - sign in again via Claude Code.' };
    }
    if (!res.ok) return { error: `Request failed (HTTP ${res.status}).` };
    return { json: await res.json() };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Request timed out.' };
    return { error: 'Network error: ' + err.message };
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
    // Keep the last good state, but mark it as stale
    if (cache.data) return { ...cache.data, error: res.error, stale: true };
    return { error: res.error };
  }

  const data = shape(res.json, creds.plan);
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getUsage, pace, parseReset };
