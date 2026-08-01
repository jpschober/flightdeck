'use strict';
// File access for the schema plugins.
//
// A plugin should not have to know whether it is reading the working directory
// or a git state - otherwise it could only deliver its schema for "now" and
// the before/after comparison would be impossible. It therefore always gets
// the same small interface:
//
//   exists(relPath)              -> boolean
//   read(relPath)                -> string | null
//   list(relDir, { ext })        -> string[]  (recursive, sorted)
//   stamp(relPaths)              -> string    (fingerprint for the cache)
//
// Paths are always relative to the repo root and separated by forward slashes -
// the way git reports them, so the same paths match on both sides.

const fs = require('fs');
const path = require('path');
const { run } = require('../gitinfo');

const MAX_FILE = 2 * 1024 * 1024;

function toRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

// ---------------------------------------------------------------------------
// Working directory: the state currently on disk
// ---------------------------------------------------------------------------
function worktreeProvider(root) {
  const abs = (rel) => path.join(root, ...toRel(rel).split('/').filter(Boolean));

  return {
    kind: 'worktree',
    label: 'working directory',
    root,

    async exists(rel) {
      try { return fs.existsSync(abs(rel)); } catch { return false; }
    },

    async read(rel) {
      try {
        const p = abs(rel);
        if (fs.statSync(p).size > MAX_FILE) return null;
        return fs.readFileSync(p, 'utf8');
      } catch { return null; }
    },

    async list(relDir, opts = {}) {
      const base = toRel(relDir);
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 8) return;
        let entries;
        try { entries = fs.readdirSync(abs(dir), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const rel = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            walk(rel, depth + 1);
          } else if (e.isFile()) {
            if (opts.ext && !rel.toLowerCase().endsWith(opts.ext.toLowerCase())) continue;
            out.push(rel);
          }
        }
      };
      walk(base, 0);
      return out.sort();
    },

    // If the fingerprint does not change, nothing has to be parsed again.
    // Directories count too: their mtime jumps when a migration is added or
    // disappears.
    async stamp(paths) {
      const parts = [];
      for (const rel of paths) {
        try {
          const st = fs.statSync(abs(rel));
          parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
        } catch {
          parts.push(`${rel}:-`);
        }
      }
      return parts.join('|');
    },
  };
}

// ---------------------------------------------------------------------------
// Git state: the same access, but against a commit
// ---------------------------------------------------------------------------
function gitProvider(root, ref, label) {
  let treeCache = null; // Set<relPath>, loaded once per provider

  async function tree() {
    if (treeCache) return treeCache;
    const out = await run('git', ['ls-tree', '-r', '--name-only', '-z', ref], root, 15000);
    treeCache = new Set(
      (out || '').split('\0').map(toRel).filter(Boolean),
    );
    return treeCache;
  }

  return {
    kind: 'git',
    label: label || ref,
    root,
    ref,

    async exists(rel) {
      return (await tree()).has(toRel(rel));
    },

    async read(rel) {
      const out = await run('git', ['show', `${ref}:${toRel(rel)}`], root, 15000);
      return out === null ? null : out.slice(0, MAX_FILE);
    },

    async list(relDir, opts = {}) {
      const base = toRel(relDir);
      const prefix = base ? `${base}/` : '';
      const out = [];
      for (const p of await tree()) {
        if (prefix && !p.startsWith(prefix)) continue;
        if (opts.ext && !p.toLowerCase().endsWith(opts.ext.toLowerCase())) continue;
        out.push(p);
      }
      return out.sort();
    },

    // A commit is immutable - the ref alone is enough as a fingerprint.
    async stamp() {
      return `git:${ref}`;
    },
  };
}

module.exports = { worktreeProvider, gitProvider, toRel };
