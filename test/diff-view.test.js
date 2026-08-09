'use strict';
// The patch format the preview hands to @pierre/diffs.
//
//   node --test test/diff-view.test.js
//
// The renderer parses the patch itself now (preview.js), and what it parses is
// whatever `git diff --no-color HEAD -- <file>` produced in main/preview.js.
// Those two ends are on either side of the IPC boundary and of a dependency
// that is updated on its own schedule, so the patches below are the actual git
// output for the four cases the file list can produce. A parser change that
// drops one of them shows up here rather than as an empty overlay.

const test = require('node:test');
const assert = require('node:assert');

/** @pierre/diffs is ESM; the tests are CommonJS, so it is loaded per test. */
async function processFile(patch, options) {
  const { processFile: fn } = await import('@pierre/diffs');
  return fn(patch, { isGitDiff: true, throwOnError: true, ...options });
}

const CHANGED = `diff --git a/src/main/session-state.js b/src/main/session-state.js
index 1111111..2222222 100644
--- a/src/main/session-state.js
+++ b/src/main/session-state.js
@@ -30,6 +30,6 @@ function setState(session, state) {
 function setAttention(session) {
-  if (!session.agentPrompted) return false;
+  if (!session.agentPrompted) { setState(session, 'idle'); return false; }
   if (session.state === 'idle') return false;
   setState(session, 'attention');
   return true;
 }
`;

const ADDED = `diff --git a/test/session-state.test.js b/test/session-state.test.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/test/session-state.test.js
@@ -0,0 +1,3 @@
+'use strict';
+const test = require('node:test');
+test('placeholder', () => {});
`;

const DELETED = `diff --git a/src/renderer/pulse.js b/src/renderer/pulse.js
deleted file mode 100644
index 4444444..0000000
--- a/src/renderer/pulse.js
+++ /dev/null
@@ -1,2 +0,0 @@
-// the activity meter used to live here
-export const pulse = () => {};
`;

const RENAMED = `diff --git a/src/renderer/pulse.js b/src/renderer/deck.js
similarity index 87%
rename from src/renderer/pulse.js
rename to src/renderer/deck.js
index 5555555..6666666 100644
--- a/src/renderer/pulse.js
+++ b/src/renderer/deck.js
@@ -1,2 +1,2 @@
 // What the session cards show about running work
-export const pulse = () => {};
+export const tick = () => {};
`;

// `additionLines`/`deletionLines` are the lines of each side, not the counts
// of what changed - the assertions below say so rather than reading as a
// changed-line count that happens to match.
test('a changed file parses with its hunk', async () => {
  const d = await processFile(CHANGED);
  assert.ok(d, 'no file diff came back');
  assert.strictEqual(d.name, 'src/main/session-state.js');
  assert.strictEqual(d.type, 'change');
  assert.strictEqual(d.hunks.length, 1);
  assert.strictEqual(d.additionLines.length, 6, 'the new side of the hunk');
  assert.strictEqual(d.deletionLines.length, 6, 'the old side of the hunk');
});

test('an added file carries its contents, not just a header', async () => {
  const d = await processFile(ADDED);
  assert.strictEqual(d.name, 'test/session-state.test.js');
  assert.strictEqual(d.type, 'new');
  assert.strictEqual(d.additionLines.length, 3);
  assert.strictEqual(d.deletionLines.length, 0, 'a new file has no old side');
});

test('a deleted file keeps the old side', async () => {
  const d = await processFile(DELETED);
  assert.strictEqual(d.name, 'src/renderer/pulse.js');
  assert.strictEqual(d.type, 'deleted');
  assert.strictEqual(d.deletionLines.length, 2);
  assert.strictEqual(d.additionLines.length, 0, 'a deleted file has no new side');
});

test('a rename carries both names', async () => {
  const d = await processFile(RENAMED);
  assert.strictEqual(d.name, 'src/renderer/deck.js');
  assert.strictEqual(d.prevName, 'src/renderer/pulse.js');
  assert.strictEqual(d.type, 'rename-changed');
});

// Text that is not a patch does not raise - it comes back as a diff with no
// hunks, which would render as an empty pane. This is why renderDiffView()
// checks the hunks rather than just the return value.
test('something that is not a patch comes back without hunks', async () => {
  const d = await processFile('this is a plain text file\nwith two lines\n');
  assert.ok(d, 'a return value is expected, just not a usable one');
  assert.strictEqual(d.hunks.length, 0);
  assert.strictEqual(d.name, '');
});
