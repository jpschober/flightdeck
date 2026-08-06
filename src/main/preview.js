'use strict';
// File preview: the diff of a changed file, or its content.
const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { run } = require('./gitinfo');
const log = require('./log');

const MAX_PREVIEW = 512 * 1024;

/** Is `p` `root` itself or below it? Both have to be resolved already. */
function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Opening without following a link: not available on Windows, where the lstat
// below stays the only check.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// Git reads `:/`, `:(exclude)x` and `:!x` as pathspec magic, and a repository
// may contain a file with such a name. Both diff calls treat the path as the
// literal name it is.
const GIT_LITERAL = '--literal-pathspecs';

// The repository the shell is standing in can name the program that produces
// the diff - `diff.external`, or a textconv driver via .gitattributes. Both
// stay out; what is shown is git's own diff. The remaining settings of that
// kind are neutralised in gitinfo.js, which starts every git call.
const GIT_OWN_DIFF = ['--no-ext-diff', '--no-textconv'];

// The path comes from the renderer and is foreign input. Anything that is not
// a relative path below the session root is rejected here, before a git command
// or a read sees it. `base` has to be resolved already.
function resolveInRoot(base, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return null;
  if (path.isAbsolute(relPath)) return null;
  const abs = path.resolve(base, relPath);
  return isInside(base, abs) ? abs : null;
}

// Reading for the preview: a symlink is not followed, neither the file itself
// nor a directory on the way to it. A cloned repository can contain a link to
// any file the user can read, and for untracked files the preview reads from
// the file system directly.
//
// The read goes through one file handle opened with O_NOFOLLOW, so the file
// that was checked is the file that is read. It takes at most MAX_PREVIEW + 1
// bytes, which bounds the memory a huge file can claim and decides the
// truncation from what was actually read rather than from an earlier stat.
// `via` names the caller for the log line: the rendered markdown view asks for
// the content directly, the other path arrives here after the diff came back
// empty, and a read error reads differently in each case.
async function readForPreview(base, abs, relPath, via) {
  let fh = null;
  try {
    const stat = await fs.promises.lstat(abs);
    if (stat.isSymbolicLink()) return { kind: 'error', path: relPath, text: t('file.symlink') };
    if (stat.isDirectory()) return { kind: 'error', path: relPath, text: t('file.isDir') };
    const [realRoot, real] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(abs)]);
    if (!isInside(realRoot, real)) return { kind: 'error', path: relPath, text: t('file.outsideRoot') };

    fh = await fs.promises.open(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
    const buf = Buffer.alloc(MAX_PREVIEW + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (!bytesRead) break;   // end of file
      got += bytesRead;
    }
    if (got > MAX_PREVIEW) {
      return { kind: 'content', path: relPath, text: buf.subarray(0, MAX_PREVIEW).toString('utf8') + '\n\n' + t('file.truncated') };
    }
    return { kind: 'content', path: relPath, text: buf.subarray(0, got).toString('utf8') };
  } catch (e) {
    log.warn('preview: file not readable', { path: abs, via, err: e });
    return { kind: 'error', path: relPath, text: t('file.readError', { message: e.message }) };
  } finally {
    if (fh) await fh.close().catch((e) => log.debug('preview: file handle not closable', { path: abs, err: e }));
  }
}

async function previewFile(session, relPath, source, opts = {}) {
  const base = path.resolve(session.gitRoot || session.cwd);
  const abs = resolveInRoot(base, relPath);
  if (!abs) {
    const shown = typeof relPath === 'string' ? relPath : '';
    return { kind: 'error', path: shown, text: t('file.outsideRoot') };
  }

  // The preview can request the file content instead of the diff - for the
  // rendered markdown view, which could show nothing based on the diff.
  if (opts.content) return readForPreview(base, abs, relPath, 'content');

  if (source === 'pr' && session.pr && session.pr.baseRefName) {
    const diff = await run('git', [GIT_LITERAL, 'diff', ...GIT_OWN_DIFF, '--no-color', `origin/${session.pr.baseRefName}...HEAD`, '--', relPath], base);
    if (diff && diff.trim()) return { kind: 'diff', path: relPath, text: diff.slice(0, MAX_PREVIEW) };
  }

  const entry = session.files.find((f) => f.path === relPath);
  if (!entry || !entry.untracked) {
    const diff = await run('git', [GIT_LITERAL, 'diff', ...GIT_OWN_DIFF, '--no-color', 'HEAD', '--', relPath], base);
    if (diff && diff.trim()) return { kind: 'diff', path: relPath, text: diff.slice(0, MAX_PREVIEW) };
  }

  return readForPreview(base, abs, relPath, source || 'worktree');
}

module.exports = { isInside, resolveInRoot, readForPreview, previewFile };
