'use strict';
// Path containment for the file preview.
//
// The functions under test live in src/main/main.js, which requires electron
// and starts timers, shells and IPC handlers the moment it is loaded. The
// preview block is therefore read out of the source and instantiated here with
// the same dependencies it gets in the app - `run` is the real one, so the git
// calls are real git calls. The tests run against the shipped code, not a copy
// of it; if the block moves, the extraction below fails loudly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('../src/main/gitinfo');

const MAX_PREVIEW = 512 * 1024;
const SRC = path.join(__dirname, '..', 'src', 'main', 'main.js');

// The stub returns the key itself, so the assertions do not depend on wording.
const t = (key, params) => (params ? `${key}:${params.message}` : key);

// Most of what these tests provoke is a refused read, which the preview logs.
// The lines are collected instead of written so the output stays readable; what
// the logger itself does with them is test/log.test.js's business.
const logged = [];
const log = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
function rec(level) { return (message, data) => logged.push({ level, message, data }); }

function loadPreview(pathModule = path) {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('const MAX_PREVIEW');
  const ipc = src.indexOf('\n// IPC\n');
  assert.ok(start !== -1, 'MAX_PREVIEW not found in main.js');
  assert.ok(ipc > start, 'the IPC section no longer follows the preview block');
  const block = src.slice(start, src.lastIndexOf('// -----', ipc));
  for (const name of ['isInside', 'resolveInRoot', 'readForPreview', 'previewFile']) {
    assert.ok(block.includes(`function ${name}`), `${name} is not in the extracted block`);
  }
  const make = new Function('fs', 'path', 't', 'run', 'log',
    `${block}\nreturn { isInside, resolveInRoot, readForPreview, previewFile };`);
  return make(fs, pathModule, t, run, log);
}

const { resolveInRoot, previewFile } = loadPreview();

// --- fixture ----------------------------------------------------------------
// tmp/
//   secret                 the file the attacks are after
//   secrets/id_rsa         same, behind a directory
//   repo/                  the session root
//     ok.md sub/deep.txt empty.txt big.txt huge.txt
//     NOTES.md    -> ../secret        (link out, as a cloned repo can carry)
//     docs        -> ../secrets       (linked directory, leaf is a real file)
//     alias.md    -> ok.md            (link that stays inside)
//   linkroot -> repo       a root reached through a link
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-preview-'));
const root = path.join(tmp, 'repo');

test.before(() => {
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok.md'), 'inside\n');
  fs.writeFileSync(path.join(root, 'sub', 'deep.txt'), 'deep\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(700 * 1024));
  fs.writeFileSync(path.join(tmp, 'secret'), 'PRIVATE KEY\n');
  fs.mkdirSync(path.join(tmp, 'secrets'));
  fs.writeFileSync(path.join(tmp, 'secrets', 'id_rsa'), 'PRIVATE KEY IN A DIRECTORY\n');
  fs.symlinkSync(path.join(tmp, 'secret'), path.join(root, 'NOTES.md'));
  fs.symlinkSync(path.join(tmp, 'secrets'), path.join(root, 'docs'));
  fs.symlinkSync(path.join(root, 'ok.md'), path.join(root, 'alias.md'));
  fs.symlinkSync(root, path.join(tmp, 'linkroot'));
  // Sparse, so it costs no disk: a bounded read must not care about the size.
  fs.closeSync(fs.openSync(path.join(root, 'huge.txt'), 'w'));
  fs.truncateSync(path.join(root, 'huge.txt'), 3 * 1024 * 1024 * 1024);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const session = (dir = root) => ({ gitRoot: dir, cwd: dir, files: [], pr: null });
const content = { content: true };

// --- resolveInRoot ----------------------------------------------------------
test('resolveInRoot rejects anything that is not a relative path', () => {
  const base = path.resolve(root);
  for (const bad of [42, {}, [], null, undefined, true, () => {}, '']) {
    assert.strictEqual(resolveInRoot(base, bad), null, `accepted ${String(bad)}`);
  }
  assert.strictEqual(resolveInRoot(base, { toString: () => 'ok.md' }), null);
  assert.strictEqual(resolveInRoot(base, ['ok.md']), null);
  assert.strictEqual(resolveInRoot(base, 'ok.md\0.png'), null, 'accepted a NUL byte');
});

test('resolveInRoot rejects absolute paths, even inside the root', () => {
  const base = path.resolve(root);
  assert.strictEqual(resolveInRoot(base, '/etc/passwd'), null);
  assert.strictEqual(resolveInRoot(base, path.join(root, 'ok.md')), null);
});

test('resolveInRoot rejects traversal out of the root', () => {
  const base = path.resolve(root);
  assert.strictEqual(resolveInRoot(base, '../secret'), null);
  assert.strictEqual(resolveInRoot(base, '../../../../etc/passwd'), null);
  assert.strictEqual(resolveInRoot(base, 'sub/../../secret'), null);
  // A sibling whose name starts with the root's name is not inside it.
  assert.strictEqual(resolveInRoot(base, '../repo2/x'), null);
});

test('resolveInRoot accepts paths that stay inside', () => {
  const base = path.resolve(root);
  assert.strictEqual(resolveInRoot(base, 'ok.md'), path.join(base, 'ok.md'));
  assert.strictEqual(resolveInRoot(base, './ok.md'), path.join(base, 'ok.md'));
  assert.strictEqual(resolveInRoot(base, 'sub/deep.txt'), path.join(base, 'sub', 'deep.txt'));
  assert.strictEqual(resolveInRoot(base, 'sub/../ok.md'), path.join(base, 'ok.md'));
});

test('resolveInRoot applies the same rules on Windows paths', () => {
  const resolveWin = loadPreview(path.win32).resolveInRoot;
  const base = 'C:\\repo';
  for (const bad of ['..\\secret', '/etc/passwd', '\\etc\\passwd', 'C:\\Windows\\x', 'D:foo', 'C:..\\secret', '\\\\server\\share\\x']) {
    assert.strictEqual(resolveWin(base, bad), null, `accepted ${bad}`);
  }
  // A drive-relative path on the same drive stays inside.
  assert.strictEqual(resolveWin(base, 'foo'), 'C:\\repo\\foo');
});

// --- reading ----------------------------------------------------------------
test('a file inside the root is read', async () => {
  const res = await previewFile(session(), 'ok.md', null, content);
  assert.strictEqual(res.kind, 'content');
  assert.strictEqual(res.text, 'inside\n');
});

test('an empty file comes back empty', async () => {
  const res = await previewFile(session(), 'empty.txt', null, content);
  assert.deepStrictEqual([res.kind, res.text], ['content', '']);
});

test('traversal is blocked on both the content and the diff path', async () => {
  for (const opts of [content, {}]) {
    const res = await previewFile(session(), '../secret', null, opts);
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.text, 'file.outsideRoot');
  }
});

test('a non-string and an absolute path are blocked end to end', async () => {
  for (const bad of [42, null, path.join(tmp, 'secret')]) {
    const res = await previewFile(session(), bad, null, content);
    assert.strictEqual(res.text, 'file.outsideRoot', `let ${String(bad)} through`);
  }
});

test('a symlink is refused instead of followed', async () => {
  for (const opts of [content, {}]) {
    const res = await previewFile(session(), 'NOTES.md', null, opts);
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.text, 'file.symlink');
    assert.doesNotMatch(res.text, /PRIVATE/);
  }
});

test('a link that stays inside the root is refused as well', async () => {
  // Deliberate: no link is followed, so the check does not depend on where the
  // target happens to point at the moment it is inspected.
  const res = await previewFile(session(), 'alias.md', null, content);
  assert.strictEqual(res.text, 'file.symlink');
});

test('a file behind a symlinked directory is refused', async () => {
  const res = await previewFile(session(), 'docs/id_rsa', null, content);
  assert.strictEqual(res.kind, 'error');
  assert.strictEqual(res.text, 'file.outsideRoot');
  assert.doesNotMatch(res.text, /PRIVATE/);
});

test('a root reached through a symlink still reads its own files', async () => {
  const res = await previewFile(session(path.join(tmp, 'linkroot')), 'ok.md', null, content);
  assert.deepStrictEqual([res.kind, res.text], ['content', 'inside\n']);
});

test('a directory is reported as a directory, a missing file as a read error', async () => {
  assert.strictEqual((await previewFile(session(), 'sub', null, content)).text, 'file.isDir');
  assert.match((await previewFile(session(), 'nope.txt', null, content)).text, /^file\.readError:/);
});

test('an oversized file is truncated at the limit', async () => {
  const res = await previewFile(session(), 'big.txt', null, content);
  assert.strictEqual(res.kind, 'content');
  assert.strictEqual(res.text.length, MAX_PREVIEW + '\n\n'.length + 'file.truncated'.length);
  assert.ok(res.text.endsWith('\n\nfile.truncated'));
});

test('a file far larger than memory is read up to the limit, not in full', async () => {
  const res = await previewFile(session(), 'huge.txt', null, content);
  assert.strictEqual(res.kind, 'content', res.text);
  assert.strictEqual(res.text.length, MAX_PREVIEW + '\n\n'.length + 'file.truncated'.length);
});

// --- git pathspecs ----------------------------------------------------------
test('pathspec magic does not reach git', async (tc) => {
  const repo = path.join(tmp, 'gitrepo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
  } catch {
    return tc.skip('git is not available');
  }
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a changed\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b changed\n');

  // The ordinary case still goes through git and returns that file's diff.
  const ok = await previewFile(session(repo), 'a.txt', null, {});
  assert.strictEqual(ok.kind, 'diff');
  assert.match(ok.text, /a changed/);
  assert.doesNotMatch(ok.text, /b changed/, 'the diff of another file leaked in');

  // `:/` and `:(exclude)` are read as the literal names they are: no match, so
  // no diff, and the read that follows finds no such file.
  for (const magic of [':/', ':(exclude)a.txt', ':!a.txt']) {
    const res = await previewFile(session(repo), magic, null, {});
    assert.notStrictEqual(res.kind, 'diff', `${magic} was interpreted as a pathspec`);
    assert.match(res.text, /^file\.readError:/, `${magic} -> ${res.text}`);
  }
});
