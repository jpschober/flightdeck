'use strict';
// Checks the timing rule of the periodic refresh:
//
//   node test/refresh-interval.js
//
// main.js cannot be required outside Electron, so the predicate from its
// setInterval and the guard in refreshAll are replayed here against a fake
// clock. Keep this in step with main.js if the rule there changes.

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

let failed = 0;
function check(name, ok, detail) {
  console.log(ok ? 'ok   ' : 'FAIL ', name, detail === undefined ? '' : `(${detail})`);
  if (!ok) failed++;
}

// 60 s with the window in front
for (let i = 1; i <= 15; i++) { now = i * 4000; tick(); }
check('visible: one pass every 4 s', passes === 15, `passes=${passes}`);

// 300 s hidden; the pass lands on the first tick at or beyond 30 s
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
check('hidden: 9 passes in 300 s instead of 75', passes === 9, `passes=${passes}`);
check('hidden: 32 s apart', gaps.every((g) => g === 32000), JSON.stringify(gaps));

// Back in front: restore and show arrive together, app:focus adds its own
// restore()/show() - one pass covers them.
visible = true; passes = 0;
now += 1000;
refreshAll(); // 'restore'
refreshAll(); // 'show'
now += 100;
refreshAll(); // app:focus -> restore()
refreshAll(); // app:focus -> show()
check('coming back to the front: a single pass', passes === 1, `passes=${passes}`);

// and the regular rhythm resumes from there
const resumedFrom = now;
for (let i = 1; i <= 3; i++) { now = resumedFrom + i * 4000; tick(); }
check('afterwards every 4 s again', passes === 4, `passes=${passes}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
