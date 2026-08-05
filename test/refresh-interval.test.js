'use strict';
// The timing rule of the periodic refresh.
//
// main.js cannot be required outside Electron, so the predicate from its
// setInterval and the guard in refreshAll are replayed here against a fake
// clock. Keep this in step with main.js if the rule there changes.

const test = require('node:test');
const assert = require('node:assert');

const REFRESH_MS = 4000;
const REFRESH_HIDDEN_MS = 30000;

let now = 0;
let lastRefreshAt = 0;
let passes = 0;
let visible = true;

// mirrors refreshAll() in main.js
function refreshAll() {
  if (now - lastRefreshAt < 500) return;
  lastRefreshAt = now;
  passes++;
}

// mirrors the setInterval callback in main.js
function tick() {
  if (now - lastRefreshAt < (visible ? REFRESH_MS : REFRESH_HIDDEN_MS)) return;
  refreshAll();
}

// The tests share the clock and run in the order they stand here: each one
// starts where the one before it left the window.

test('visible: one pass every 4 s', () => {
  for (let i = 1; i <= 15; i++) { now = i * 4000; tick(); }
  assert.strictEqual(passes, 15);
});

test('hidden: 9 passes in 300 s instead of 75, 32 s apart', () => {
  // the pass lands on the first tick at or beyond 30 s
  visible = false; passes = 0;
  const hiddenFrom = now;
  const at = [];
  for (let i = 1; i <= 75; i++) {
    now = hiddenFrom + i * 4000;
    const before = passes;
    tick();
    if (passes > before) at.push(now - hiddenFrom);
  }
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  assert.strictEqual(passes, 9);
  assert.ok(gaps.every((g) => g === 32000), JSON.stringify(gaps));
});

test('coming back to the front: a single pass', () => {
  // restore and show arrive together, app:focus adds its own restore()/show()
  visible = true; passes = 0;
  now += 1000;
  refreshAll(); // 'restore'
  refreshAll(); // 'show'
  now += 100;
  refreshAll(); // app:focus -> restore()
  refreshAll(); // app:focus -> show()
  assert.strictEqual(passes, 1);
});

test('afterwards every 4 s again', () => {
  const resumedFrom = now;
  for (let i = 1; i <= 3; i++) { now = resumedFrom + i * 4000; tick(); }
  assert.strictEqual(passes, 4);
});
