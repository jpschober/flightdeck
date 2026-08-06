'use strict';
// What comes out of `git status --porcelain=v2 -z`, and what the preview does
// with it.
//
//   node --test test/git-status-parse.test.js
//
// The first half feeds parseStatus records by hand - the names in them are the
// ones the short format would have mangled: umlauts, spaces, an ` -> ` inside a
// file name. The second half runs real git in a temporary repository and takes
// the path it delivers back to git as a pathspec, the way the file preview in
// main.js does. That is where an escaped name shows: the list looks odd, and
// the diff comes back empty.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getGitInfo, parseStatus, run } = require('../src/main/gitinfo');

// The object hashes are not read; one stand-in does for all of them.
const B = '0'.repeat(40);
const rec = (...parts) => parts.join('\0') + '\0';
const entry = (xy, p) => `1 ${xy} N... 100644 100644 100644 ${B} ${B} ${p}`;
const rename = (xy, to) => `2 ${xy} N... 100644 100644 100644 ${B} ${B} R100 ${to}`;

// --- parseStatus ------------------------------------------------------------
test('a path is taken as it stands, umlauts and spaces included', () => {
  const files = parseStatus(rec(entry('.M', 'src/Müller.ts'), entry('M.', 'ein Ordner/日本語.md')));
  assert.deepStrictEqual(files.map((f) => f.path), ['src/Müller.ts', 'ein Ordner/日本語.md']);
});

test('a rename shows the new path, its old one is not a file of its own', () => {
  const files = parseStatus(rec(rename('R.', 'neu ümlaut.txt'), 'old.txt', entry('.M', 'a.txt')));
  assert.deepStrictEqual(files.map((f) => f.path), ['neu ümlaut.txt', 'a.txt']);
  assert.strictEqual(files[0].status, 'R');
});

test('a file name containing an arrow stays whole', () => {
  const files = parseStatus(rec(entry('.M', 'arrow -> file.txt'), rename('R.', 'a -> b.txt'), 'old -> name.txt'));
  assert.deepStrictEqual(files.map((f) => f.path), ['arrow -> file.txt', 'a -> b.txt']);
});

test('the staged half decides the code, an unchanged half is a dot', () => {
  const files = parseStatus(rec(entry('.M', 'a'), entry('M.', 'b'), entry('AM', 'c'), entry('.D', 'd')));
  assert.deepStrictEqual(files.map((f) => f.status), ['M', 'M', 'A', 'D']);
  assert.deepStrictEqual(files.map((f) => f.untracked), [false, false, false, false]);
});

test('untracked and ignored records carry the path right behind their type', () => {
  const files = parseStatus(rec('? untracked ä.txt', '? dir ö/', '! build/'));
  assert.deepStrictEqual(files.map((f) => [f.status, f.path, f.untracked, f.dir]), [
    ['?', 'untracked ä.txt', true, false],
    ['?', 'dir ö/', true, true],
    ['!', 'build/', false, true],
  ]);
});

test('an unmerged record has three more fields before its path', () => {
  const conflict = `u UU N... 100644 100644 100644 100644 ${B} ${B} ${B} both hände.txt`;
  const files = parseStatus(rec(conflict));
  assert.deepStrictEqual(files.map((f) => [f.status, f.path]), [['U', 'both hände.txt']]);
});

test('empty output and records nobody asked for come to nothing', () => {
  assert.deepStrictEqual(parseStatus(''), []);
  assert.deepStrictEqual(parseStatus('\0\0'), []);
  const headers = parseStatus(rec('# branch.oid ' + B, '# branch.head main', entry('.M', 'a.txt')));
  assert.deepStrictEqual(headers.map((f) => f.path), ['a.txt']);
  // A truncated record is dropped rather than turned into a path.
  assert.deepStrictEqual(parseStatus(rec('1 .M N... 100644')), []);
});

// --- against real git -------------------------------------------------------
test('the delivered path is the file on disk and a pathspec git matches', async (tc) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-status-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
  } catch {
    fs.rmSync(repo, { recursive: true, force: true });
    return tc.skip('git is not available');
  }
  try {
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    const tracked = 'Müller.ts';
    fs.writeFileSync(path.join(repo, tracked), 'a\n');
    fs.writeFileSync(path.join(repo, 'old.txt'), 'c\n');
    git('add', '-A');
    git('commit', '-qm', 'initial');
    fs.appendFileSync(path.join(repo, tracked), 'changed\n');
    git('mv', 'old.txt', 'neu ümlaut.txt');
    fs.writeFileSync(path.join(repo, 'untracked ä.txt'), 'u\n');

    const info = await getGitInfo(repo);
    const paths = info.files.map((f) => f.path).sort();
    assert.deepStrictEqual(paths, ['Müller.ts', 'neu ümlaut.txt', 'untracked ä.txt']);
    for (const p of paths) {
      assert.ok(fs.existsSync(path.join(repo, p)), `${p} is not the name on disk`);
    }

    // The preview in main.js hands this path to git as a literal pathspec. A
    // C-quoted name matches nothing there and the diff stays empty.
    const diff = await run('git', ['--literal-pathspecs', 'diff', '--no-color', 'HEAD', '--', tracked], repo);
    assert.match(diff, /^\+changed$/m, `no diff for ${tracked}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
