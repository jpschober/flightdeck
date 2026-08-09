'use strict';
// Usage limits of the Claude subscription. The numbers come from
// /api/oauth/usage - the same source that feeds /usage in Claude Code. The
// transcripts are no good for this: they contain token counters, but no limit
// state.
//
// The endpoint is undocumented and can change without notice. Everything is
// therefore read defensively, and an error is reported visibly instead of
// silently showing stale numbers.
//
// The access token comes from Claude Code's own login: from
// `~/.claude/.credentials.json`, on macOS from the login keychain. It stays in
// the main process - it goes neither over the bridge to the renderer nor into
// an error message or a log line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { t } = require('../i18n');
const log = require('./log');

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TTL = 60_000;
const TIMEOUT = 10_000;

// macOS keeps the credentials in the login keychain instead of in a file. The
// absolute path is used on purpose: `security` is part of the system, and the
// PATH an Electron app inherits from the Finder is not the user's.
const KEYCHAIN_TOOL = '/usr/bin/security';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// The lookup can put a keychain dialog in front of the user. The timeout is
// long enough that answering it is possible and short enough that a request
// nobody is sitting in front of ends.
const KEYCHAIN_TIMEOUT = 20_000;
// After a failed lookup - denied, cancelled, nothing stored - the keychain is
// left alone for this long. Without it every poll would put the dialog up
// again. It holds off the unasked-for poll, not the user: a refresh they
// pressed themselves goes to the keychain right away.
const KEYCHAIN_RETRY_AFTER = 5 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The two windows the panel shows, in the order it shows them, each with its
// length. The endpoint carries more alongside them - per-model windows,
// `extra_usage`, keys that appear and vanish without notice. Those have no
// translated name, so they would land in the panel as a raw key.
const WINDOWS = { five_hour: 5 * HOUR, seven_day: 7 * DAY };

// Below this fraction of the window the projection is pure noise - a single
// prompt in the first minute would otherwise yield "500 % projected".
const MIN_FRACTION = 0.05;

// How many percent above target the traffic light flips
const AMBER_AT = 100;
const RED_AT = 115;

let cache = { at: 0, data: null };
let keychainRetryAt = 0;

// Where the credentials were looked for. Goes into the "no login found"
// message, so the answer names the place that was actually searched - on macOS
// the file alone would name the one place they are not.
//
// `Keychain` stays English inside a translated message. The alternative would
// be a key per language, and the word is the one the system shows in its own
// dialog. A locale key can replace this later.
const SOURCE = process.platform === 'darwin'
  ? `~/.claude/.credentials.json, Keychain "${KEYCHAIN_SERVICE}"`
  : '~/.claude/.credentials.json';

function readFile() {
  try {
    return fs.readFileSync(CREDENTIALS, 'utf8');
  } catch (e) {
    log.debug('usage: credentials file not readable', { path: CREDENTIALS, err: e });
    return null;
  }
}

// The keychain entry holds the same JSON the file holds on the other systems.
// Everything that can go wrong here - no `security`, no entry, a dialog the
// user cancels, a lookup that hangs - ends in the same `null` as a missing
// file, and from there in the same "no login found" answer.
//
// Untested: this project is developed on Linux, and the path only runs on
// macOS.
function readKeychain(force = false) {
  if (!force && Date.now() < keychainRetryAt) {
    log.debug('usage: keychain lookup skipped, still in backoff');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    // A throw out of execFile would reject this promise and take the usage
    // request with it; the answer here is the same `null` as everywhere else.
    try {
      execFile(
        KEYCHAIN_TOOL,
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: KEYCHAIN_TIMEOUT, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // Only the exit code is logged. `security` writes its diagnostics
            // to stderr and Node hangs both streams off the error object - a
            // logged error would carry the token with it.
            log.debug('usage: keychain lookup failed', {
              service: KEYCHAIN_SERVICE, code: err.code, signal: err.signal,
            });
            keychainRetryAt = Date.now() + KEYCHAIN_RETRY_AFTER;
            resolve(null);
            return;
          }
          // `-w` prints the password and nothing else, with a trailing newline.
          const raw = String(stdout).trim();
          if (!raw) {
            log.debug('usage: keychain entry is empty', { service: KEYCHAIN_SERVICE });
            keychainRetryAt = Date.now() + KEYCHAIN_RETRY_AFTER;
            resolve(null);
            return;
          }
          keychainRetryAt = 0;
          resolve(raw);
        },
      );
    } catch (e) {
      log.debug('usage: keychain lookup could not be started', { name: e.name });
      keychainRetryAt = Date.now() + KEYCHAIN_RETRY_AFTER;
      resolve(null);
    }
  });
}

function parseCredentials(raw, source) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // The parse error itself is not logged: from Node 20 on its message quotes
    // the input it choked on, and that input is the credentials.
    log.warn('usage: credentials not parsable', { source });
    return { error: t('usage.error.unreadable') };
  }
  const oauth = (json && json.claudeAiOauth) || {};
  if (!oauth.accessToken) return { error: t('usage.error.noToken') };
  // expiresAt is a millisecond timestamp; we cannot refresh expired tokens
  // ourselves, Claude Code does that on its next start.
  if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) {
    return { error: t('usage.error.expired') };
  }
  return { token: oauth.accessToken, plan: oauth.subscriptionType || null };
}

// The file first, the keychain second: on macOS both can exist, and reading the
// file costs nothing while the keychain may put a dialog in the way. A source
// that yields no usable token is not the end of the search - the next one gets
// its turn, and only if none of them delivers does the first complaint stand.
async function readToken(force = false) {
  const sources = [{ name: 'file', read: readFile }];
  if (process.platform === 'darwin') {
    sources.push({ name: 'keychain', read: () => readKeychain(force) });
  }

  let firstError = null;
  for (const source of sources) {
    const raw = await source.read();
    if (raw === null) continue;
    const creds = parseCredentials(raw, source.name);
    if (creds.token) return creds;
    if (!firstError) firstError = creds;
  }
  return firstError || { error: t('usage.error.noLogin', { path: SOURCE }) };
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
      return { error: t('usage.error.rejected') };
    }
    if (!res.ok) {
      log.warn('usage: endpoint answered with an error', { endpoint: ENDPOINT, status: res.status });
      return { error: t('usage.error.http', { status: res.status }) };
    }
    return { json: await res.json() };
  } catch (err) {
    // The endpoint is undocumented; a change to it shows up here first.
    log.warn('usage: request failed', { endpoint: ENDPOINT, name: err.name, err });
    if (err.name === 'AbortError') return { error: t('usage.error.timeout') };
    return { error: t('usage.error.network', { message: err.message }) };
  } finally {
    clearTimeout(timer);
  }
}

// Only the windows from WINDOWS become entries, in that order - what the
// server sends beyond them, and in which order, does not reach the panel.
function shape(json, plan) {
  const source = json && typeof json === 'object' ? json : {};
  const limits = [];
  for (const [key, windowMs] of Object.entries(WINDOWS)) {
    const raw = source[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    // A window says how much of it is used up. Without utilization the row
    // would carry a title and nothing else.
    if (typeof raw.utilization !== 'number') continue;
    limits.push({ key, ...pace(raw, windowMs) });
  }
  return { plan, fetchedAt: Date.now(), limits };
}

async function getUsage(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data;

  // `force` is the refresh button. It reaches through to the keychain, whose
  // backoff exists against the background poll, not against the user.
  const creds = await readToken(force);
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

module.exports = { getUsage, pace, parseReset, shape };
