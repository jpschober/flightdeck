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
const { run, getGitInfo, scanConfig } = require('../src/main/gitinfo');

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

// --- filter drivers: no -c helps here, the names are free ------------------
test('a repository with a filter driver gets no git at all', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  const evil = path.join(tmp, 'filtered');
  const marker = path.join(tmp, 'FILTER-RAN');
  fs.mkdirSync(evil);
  const git = (...args) => execFileSync('git', args, { cwd: evil, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(evil, 'a.txt'), 'aaaa\n');
  fs.writeFileSync(path.join(evil, '.gitattributes'), '*.txt filter=evil\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  // `git status` runs the clean filter to find out whether the file differs
  // from the index - this is the route -c cannot close, because the driver
  // names are free. The new content is the same length as the old one on
  // purpose: a different size lets git decide without reading the file.
  git('config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`);
  fs.writeFileSync(path.join(evil, 'a.txt'), 'bbbb\n');

  const info = await getGitInfo(evil);
  assert.strictEqual(info.blocked, 'filter.evil.clean', 'the key is not named');
  assert.strictEqual(info.branch, null);
  assert.deepStrictEqual(info.files, []);
  assert.strictEqual(await run('git', ['status', '--porcelain'], evil), null,
    'git was started in a directory whose configuration names a program');
  assert.strictEqual(fs.existsSync(marker), false, 'the filter of the repository ran');
});

test('an ordinary repository is not blocked', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  const info = await getGitInfo(repo);
  assert.strictEqual(info.blocked, null);
  assert.strictEqual(info.branch, 'main');
});

test('a subdirectory of a blocked repository is blocked as well', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  // The config belongs to the repository, not to the directory the shell
  // happens to stand in - git finds it from a subdirectory just the same.
  const sub = path.join(tmp, 'filtered', 'deep', 'deeper');
  fs.mkdirSync(sub, { recursive: true });
  const info = await getGitInfo(sub);
  assert.strictEqual(info.blocked, 'filter.evil.clean');
});

test('a configuration that no longer names a program lifts the block', async (tc) => {
  if (!haveGit) return tc.skip('git is not available');
  const evil = path.join(tmp, 'filtered');
  execFileSync('git', ['config', '--unset', 'filter.evil.clean'], { cwd: evil, stdio: 'pipe' });
  // The verdict is held for the length of one refresh pass; after that the
  // timestamp of the config file decides, and it has just moved.
  await new Promise((r) => setTimeout(r, 2100));
  const info = await getGitInfo(evil);
  assert.strictEqual(info.blocked, null, 'the block outlives the configuration that caused it');
  assert.strictEqual(info.branch, 'main');
});

// --- the config parser ------------------------------------------------------
test('the scan finds the keys that name a program, in every spelling', () => {
  const cases = [
    ['[filter "evil"]\n\tclean = sh -c "x"\n', 'filter.evil.clean'],
    ['[filter.evil]\n\tsmudge = x\n', 'filter.evil.smudge'],
    ['[filter "a b"]\n\tprocess = x\n', 'filter.a b.process'],
    ['[FILTER "Evil"]\n\tCLEAN = x\n', 'filter.evil.clean'],
    ['[filter "evil"] clean = x\n', 'filter.evil.clean'],
    ['[include]\n\tpath = ../elsewhere\n', 'include.path'],
    ['[includeIf "gitdir:/x/"]\n\tpath = ../elsewhere\n', 'includeif.gitdir:/x/.path'],
  ];
  for (const [text, key] of cases) {
    assert.strictEqual(scanConfig(text), key, `not found in: ${JSON.stringify(text)}`);
  }
});

test('the scan leaves ordinary configurations alone', () => {
  const ordinary = `[core]
\trepositoryformatversion = 0
\tbare = false
\tfsmonitor = true
\thooksPath = .githooks
[remote "origin"]
\turl = git@github.com:jpschober/flightdeck.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
# [filter "evil"] clean = x
;\tsmudge = x
[user]
\temail = mail@example.com
`;
  // core.fsmonitor and core.hooksPath are not in the list: -c neutralises them
  // on every call, and repositories set them for good reasons.
  assert.strictEqual(scanConfig(ordinary), null);
});
