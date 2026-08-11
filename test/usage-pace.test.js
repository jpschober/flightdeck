'use strict';
// The pace calculation of the usage panel.
//
// pace() turns one limit window of the endpoint into what the panel shows:
// how much of the window has passed, how much may be used up by now, and what
// the current pace projects for the end of the window. It is pure arithmetic
// over a clock, so the clock is fixed here and the real module is used - the
// numbers in the assertions are the numbers the panel prints.
//
// shape() is tested alongside: it decides which windows the endpoint delivers
// reach the panel at all, and in which order.

const test = require('node:test');
const assert = require('node:assert');
const { pace, parseReset, shape } = require('../src/main/usage');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const NOW = Date.parse('2026-08-05T12:00:00.000Z');

// pace() reads the clock itself. Fixing it makes elapsed time exact instead of
// dependent on how long the test run takes.
const realNow = Date.now;
function at(fn) {
  Date.now = () => NOW;
  try { return fn(); } finally { Date.now = realNow; }
}

/** A window of `windowMs` of which `fraction` has passed, `used` percent used. */
function limit(used, fraction, windowMs = WEEK) {
  return { utilization: used, resets_at: new Date(NOW + windowMs * (1 - fraction)).toISOString() };
}

test('halfway through the window: budget, headroom and projection', () => {
  const r = at(() => pace(limit(25, 0.5), WEEK));
  assert.strictEqual(r.fraction, 0.5);
  assert.strictEqual(r.budget, 50);      // half the window, half the quota
  assert.strictEqual(r.headroom, 25);    // 25 of 50 unused
  assert.strictEqual(r.projected, 50);   // the same pace ends at half
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.windowMs, WEEK);
  assert.strictEqual(r.startedAt, NOW - WEEK / 2);
});

test('exactly on target is still ok, one percent above is a warning', () => {
  const onTarget = at(() => pace(limit(50, 0.5), WEEK));
  assert.strictEqual(onTarget.headroom, 0);
  assert.strictEqual(onTarget.projected, 100);
  assert.strictEqual(onTarget.status, 'ok');

  const above = at(() => pace(limit(50.5, 0.5), WEEK));
  assert.strictEqual(above.projected, 101);
  assert.strictEqual(above.status, 'warn');
});

test('the warning holds up to 115 percent projected, above that it is over', () => {
  assert.strictEqual(at(() => pace(limit(57.5, 0.5), WEEK)).projected, 115);
  assert.strictEqual(at(() => pace(limit(57.5, 0.5), WEEK)).status, 'warn');
  assert.strictEqual(at(() => pace(limit(58, 0.5), WEEK)).status, 'over');
});

test('an exhausted limit is over regardless of the projection', () => {
  // At 98 percent of the window the pace is fine, but the quota is gone.
  const r = at(() => pace(limit(100, 0.98), WEEK));
  assert.strictEqual(r.status, 'over');
  assert.strictEqual(r.projected, 100);  // not 102 - there is nothing to project
});

test('too early in the window: no projection', () => {
  const r = at(() => pace(limit(3, 0.01), WEEK));
  assert.strictEqual(r.status, 'early');
  assert.strictEqual(r.projected, null);
  assert.strictEqual(r.used, 3);
  assert.ok(Math.abs(r.budget - 1) < 1e-9);
});

test('from five percent of the window on the projection stands', () => {
  const r = at(() => pace(limit(4, 0.05), WEEK));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.projected, 80);
});

test('a reset in the past counts the window as full, not as more than full', () => {
  // The endpoint reports a window that ended a day ago: elapsed is capped at
  // the window length, so the projection stays at the value used.
  const r = at(() => pace({ utilization: 40, resets_at: new Date(NOW - DAY).toISOString() }, WEEK));
  assert.strictEqual(r.fraction, 1);
  assert.strictEqual(r.budget, 100);
  assert.strictEqual(r.projected, 40);
  assert.strictEqual(r.status, 'ok');
});

test('a reset further away than the window counts as not started', () => {
  // Clock skew between endpoint and machine; negative elapsed would otherwise
  // turn into a negative budget.
  const r = at(() => pace({ utilization: 10, resets_at: new Date(NOW + 2 * WEEK).toISOString() }, WEEK));
  assert.strictEqual(r.fraction, 0);
  assert.strictEqual(r.budget, 0);
  assert.strictEqual(r.status, 'early');
});

test('without utilization or without a reset there is no statement', () => {
  const noUse = at(() => pace({ resets_at: new Date(NOW + DAY).toISOString() }, WEEK));
  assert.strictEqual(noUse.status, 'unknown');
  assert.strictEqual(noUse.used, null);
  assert.strictEqual(noUse.projected, undefined);

  const noReset = at(() => pace({ utilization: 30 }, WEEK));
  assert.strictEqual(noReset.status, 'unknown');
  assert.strictEqual(noReset.resetsAt, null);
});

test('resets_at as ISO string, as seconds and as milliseconds', () => {
  const iso = '2026-08-05T12:00:00.000Z';
  assert.strictEqual(parseReset(iso), NOW);
  assert.strictEqual(parseReset(NOW), NOW);
  assert.strictEqual(parseReset(Math.floor(NOW / 1000)), NOW);
  assert.strictEqual(parseReset(String(Math.floor(NOW / 1000))), NOW);
  assert.strictEqual(parseReset(null), null);
  assert.strictEqual(parseReset('whenever'), null);
});

test('the two windows come with their length, five hours first', () => {
  const data = at(() => shape({
    seven_day: limit(20, 0.5),
    five_hour: limit(10, 0.5, 5 * HOUR),
  }, 'max'));

  assert.deepStrictEqual(data.limits.map((l) => l.key), ['five_hour', 'seven_day']);
  assert.strictEqual(data.limits[0].windowMs, 5 * HOUR);
  assert.strictEqual(data.limits[0].used, 10);
  assert.strictEqual(data.limits[1].windowMs, WEEK);
  assert.strictEqual(data.plan, 'max');
});

test('every other window of the endpoint stays out', () => {
  const data = at(() => shape({
    five_hour: limit(10, 0.5, 5 * HOUR),
    // Windows with the same shape but without a name of their own in the panel
    seven_day_opus: limit(2, 0.5),
    two_day_haiku: limit(30, 0.5, 2 * DAY),
    extra_usage: limit(40, 0.5),
    nimbus_quill: limit(50, 0.5),
  }, null));
  assert.deepStrictEqual(data.limits.map((l) => l.key), ['five_hour']);
});

test('anything that is not a limit window stays out', () => {
  const data = at(() => shape({
    seven_day: limit(20, 0.5),
    subscription: 'max',
    flags: ['a', 'b'],
    account: { id: 'abc', email: 'someone@example.com' },
    // Carries a reset but no utilization: a row from this would show a title
    // and nothing else.
    five_hour: { resets_at: new Date(NOW + DAY).toISOString() },
  }, null));
  assert.deepStrictEqual(data.limits.map((l) => l.key), ['seven_day']);
});

test('an answer without windows gives an empty list, not an error', () => {
  assert.deepStrictEqual(at(() => shape({}, null)).limits, []);
  assert.deepStrictEqual(at(() => shape(null, null)).limits, []);
  assert.deepStrictEqual(at(() => shape(undefined, null)).limits, []);
});
