'use strict';
// The directory git runs in comes from the terminal output (OSC 7), not from a
// click, and git reads the .git/config it finds there. Settings that name a
// program git then starts must not reach the commands this app runs - a `cd`
// into an unpacked archive is otherwise enough to start it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run } = require('../src/main/gitinfo');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-git-'));
const repo = path.join(tmp, 'hostile');
const marker = path.join(tmp, 'it-ran');

let haveGit = true;
try {
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
} catch { haveGit = false; }

if (haveGit) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  // What a hostile .git/config would carry. The command is written so that it
  // leaves a trace behind if git ever starts it.
  const hook = path.join(tmp, 'touch-marker.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.chmodSync(hook, 0o755);
  git('config', 'core.fsmonitor', hook);
  git('config', 'core.hooksPath', path.join(tmp, 'hooks'));
}

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('the fsmonitor of the repository does not reach the commands that are started', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  const value = await run('git', ['config', '--get', 'core.fsmonitor'], repo);
  assert.strictEqual(value, '\n', 'the repository value is still in force');

  const status = await run('git', ['status', '--porcelain'], repo);
  assert.strictEqual(status, '', 'the working tree is clean, so the output is empty');
  assert.strictEqual(fs.existsSync(marker), false, 'git started the program the repository named');
});

test('the hooks directory of the repository does not reach them either', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  const value = await run('git', ['config', '--get', 'core.hooksPath'], repo);
  assert.strictEqual(value, '/dev/null\n');
});

test('what git is asked for still comes back', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  assert.strictEqual(branch.trim(), 'main');
});

test('a command that is not git keeps its arguments', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  // The overrides are git's; anything else - `gh` - must not be handed them.
  const out = await run(process.execPath, ['-e', 'console.log(process.argv.length)'], tmp);
  assert.strictEqual(out.trim(), '1', 'extra arguments were passed to a command that is not git');
});
