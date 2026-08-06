// ---------------------------------------------------------------------------
// Right-hand panel: PR + changed files
// ---------------------------------------------------------------------------
import { $, escapeHtml, makeKeyActivatable, setText, setTitle, syncChildren, setSlotSentence } from './dom.js';
import { t, locale, onLocaleChange } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { mdToHtml } from './markdown.js';
import { updateBadges } from './panel.js';
import { openPreview } from './preview.js';

const prCardEl = $('#pr-card');
const prExtraEl = $('#pr-extra');
const fileListEl = $('#file-list');
const wtBannerEl = $('#wt-banner');

export function renderContextPanel() {
  const s = activeId ? sessions.get(activeId) : null;
  renderWorktreeBanner(s);
  renderPrCard(s);
  renderPrExtra(s ? s.pr : null);
  renderFileList(s);
  updateBadges(s);
}

// Branch and files then come from the agent's directory, not from the shell's
// - without a notice that would be impossible to follow.
function renderWorktreeBanner(s) {
  const worktree = s ? s.worktree : null;
  wtBannerEl.classList.toggle('hidden', !worktree);
  if (!worktree) return;
  if (!wtBannerEl.firstElementChild) {
    wtBannerEl.innerHTML = `
      <span class="wt-icon">⑂</span>
      <span class="wt-text"><span class="wt-notice"></span> <code></code></span>
      <span class="wt-sub"></span>`;
  }
  setText(wtBannerEl.querySelector('.wt-notice'), t('git.worktree.notice'));
  setText(wtBannerEl.querySelector('.wt-text code'), worktree);
  const subEl = wtBannerEl.querySelector('.wt-sub');
  setText(subEl, t('git.worktree.shell', { path: s.cwd }));
  setTitle(subEl, s.agentCwd || '');
}

// The card has five shapes: a pull request, a branch without one, a repository
// git is kept out of (not the same as "no repository": there is one here, and
// it is on purpose - see gitinfo.js), no repository at all, and no session.
// The shape decides the skeleton - it is built when the shape changes, and
// from then on only the fields are set.
const PR_CARD_HTML = `
  <div class="pr-title" role="link"></div>
  <div class="pr-meta">
    <span class="pr-state"></span>
    <span class="pr-author"></span>
    <div class="pr-checks">
      <span class="check-chip failure"></span>
      <span class="check-chip pending"></span>
      <span class="check-chip success"></span>
    </div>
  </div>
  <div class="pr-branches"></div>
  <div class="pr-stats"><span class="add"></span> <span class="del"></span></div>`;

const CHECK_MARK = { failure: '✗', pending: '●', success: '✓' };

function renderPrCard(s) {
  const pr = s ? s.pr : null;
  const shape = !s ? 'nosession'
    : pr ? 'pr'
      : s.branch ? 'branch'
        : s.gitBlocked ? 'blocked' : 'norepo';

  if (prCardEl.dataset.shape !== shape) {
    prCardEl.dataset.shape = shape;
    if (shape === 'pr') {
      prCardEl.innerHTML = PR_CARD_HTML;
      const titleEl = prCardEl.querySelector('.pr-title');
      makeKeyActivatable(titleEl);
      // The PR of the session that is showing now, not the one that was
      // showing when the card was built.
      titleEl.addEventListener('click', () => {
        const cur = activeId && sessions.get(activeId);
        if (cur && cur.pr) window.api.openExternal(cur.pr.url);
      });
    } else {
      prCardEl.innerHTML = `<div class="${shape === 'blocked' ? 'git-blocked' : 'muted'}"></div>`;
    }
  }

  const lineEl = prCardEl.firstElementChild;
  if (shape === 'nosession') { setText(lineEl, t('common.noSession')); return; }
  if (shape === 'norepo') { setText(lineEl, t('git.noRepo')); return; }
  if (shape === 'branch') {
    setSlotSentence(lineEl, t('git.pr.none', { branch: '\u0000' }), 'code', [s.branch]);
    return;
  }
  if (shape === 'blocked') {
    setSlotSentence(lineEl, t('git.blocked', { key: '\u0000' }), 'code', [s.gitBlocked]);
    return;
  }

  const titleEl = prCardEl.querySelector('.pr-title');
  setText(titleEl, `#${pr.number} ${pr.title}`);
  setTitle(titleEl, t('git.pr.open'));

  const stateEl = prCardEl.querySelector('.pr-state');
  stateEl.className = 'pr-state ' + (pr.isDraft ? 'draft' : pr.state.toLowerCase());
  setText(stateEl, pr.isDraft ? 'Draft' : pr.state);

  const authorEl = prCardEl.querySelector('.pr-author');
  authorEl.classList.toggle('hidden', !pr.author);
  setText(authorEl, pr.author ? t('git.pr.by', { author: pr.author }) : '');

  const checks = pr.checks && pr.checks.total ? pr.checks : null;
  prCardEl.querySelector('.pr-checks').classList.toggle('hidden', !checks);
  for (const kind of Object.keys(CHECK_MARK)) {
    const chipEl = prCardEl.querySelector('.check-chip.' + kind);
    const count = checks ? checks[kind] : 0;
    chipEl.classList.toggle('hidden', !count);
    setText(chipEl, count ? `${CHECK_MARK[kind]} ${count}` : '');
  }

  setText(prCardEl.querySelector('.pr-branches'), `${pr.headRefName} → ${pr.baseRefName}`);
  setText(prCardEl.querySelector('.pr-stats .add'), `+${pr.additions ?? 0}`);
  setText(prCardEl.querySelector('.pr-stats .del'), `−${pr.deletions ?? 0}`);
}

// PR extra sections (description, checks, commits, feedback). Which of them is
// open is the user's doing and stays in the DOM, so the sections are found
// again by their id and only their content is replaced.
function renderPrExtra(pr) {
  const items = [];

  if (pr && pr.body && pr.body.trim()) {
    items.push({ id: 'body', title: t('git.pr.description'), html: `<div class="md">${mdToHtml(pr.body)}</div>` });
  }

  if (pr && pr.checks && pr.checks.total) {
    items.push({
      id: 'checks',
      title: t('git.pr.checks', {
        success: pr.checks.success, failure: pr.checks.failure, pending: pr.checks.pending,
      }),
      html: pr.checks.items.map((c) =>
        `<div class="check-row"><span class="check-dot ${c.status}"></span>${escapeHtml(c.name)}</div>`).join(''),
    });
  }

  if (pr && pr.commits && pr.commits.length) {
    items.push({
      id: 'commits',
      title: t('git.pr.commits', { count: pr.commits.length }),
      html: pr.commits.slice().reverse().map((c) =>
        `<div class="commit-row"><code class="commit-sha">${escapeHtml(c.sha)}</code>${escapeHtml(c.message)}</div>`).join(''),
    });
  }

  const feedback = pr ? [
    ...(pr.reviews || []).map((r) => ({ ...r, kind: 'review', at: r.submittedAt })),
    ...(pr.comments || []).map((c) => ({ ...c, kind: 'comment', at: c.createdAt })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)) : [];
  if (feedback.length) {
    items.push({
      id: 'feedback',
      title: t('git.pr.feedback', { count: feedback.length }),
      html: feedback.map((f) => `
        <div class="fb-row">
          <div class="fb-head">
            <strong>${escapeHtml(f.author || '?')}</strong>
            ${f.kind === 'review' ? `<span class="fb-state ${escapeHtml((f.state || '').toLowerCase())}">${escapeHtml(f.state || '')}</span>` : ''}
            <span class="fb-date">${f.at ? new Date(f.at).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
          </div>
          ${f.body ? `<div class="md">${mdToHtml(f.body)}</div>` : ''}
        </div>`).join(''),
    });
  }

  syncChildren(prExtraEl, items, buildPrDetails, updatePrDetails);
}

function buildPrDetails() {
  const d = document.createElement('details');
  d.className = 'pr-details';
  d.innerHTML = '<summary></summary><div class="pr-details-body"></div>';
  return d;
}

// What a section body was last built from. Keyed by the element, so the entry
// goes when the section goes - and the body is only rebuilt when its content
// has actually changed. A PR whose checks turn green sends an info tick every
// few seconds; without this, a selection in the description would not survive
// one of them.
const prDetailsHtml = new WeakMap();

function updatePrDetails(el, item) {
  setText(el.querySelector('summary'), item.title);
  const body = el.querySelector('.pr-details-body');
  if (prDetailsHtml.get(body) === item.html) return;
  prDetailsHtml.set(body, item.html);
  body.innerHTML = item.html;
}

function renderFileList(s) {
  syncChildren(fileListEl, fileItems(s), buildFileItem, updateFileItem);
}

/**
 * Headings and rows of the file list in the order they are shown. The id names
 * the group as well, so the same path can stand in the committed and in the
 * changed group without the two sharing an element.
 */
function fileItems(s) {
  const items = [];
  if (!s) return items;

  // As soon as a PR exists, its file list is the authoritative one - the local
  // memory would only duplicate it.
  if (s.pr && s.pr.files && s.pr.files.length) {
    items.push({ id: 'title:pr', title: t('git.files.inPr', { count: s.pr.files.length }) });
    for (const f of s.pr.files) items.push({ id: `pr:${f.path}`, file: f, source: 'pr' });
  } else if (s.files.length) {
    const open = s.files.filter((f) => !f.committed);
    const done = s.files.filter((f) => f.committed);
    if (open.length) {
      items.push({ id: 'title:worktree', title: t('git.files.worktree') });
      for (const f of open) items.push({ id: `wt:${f.path}`, file: f, source: 'wt' });
    }
    if (done.length) {
      items.push({ id: 'title:committed', title: t('git.files.committed', { count: done.length }) });
      for (const f of done) items.push({ id: `committed:${f.path}`, file: f, source: 'wt' });
    }
  }

  if (!items.length) items.push({ id: 'empty', title: s.branch ? t('git.files.none') : '—', muted: true });
  return items;
}

function buildFileItem(item) {
  const el = document.createElement('div');
  if (!item.file) {
    el.className = item.muted ? 'muted' : 'file-group-title';
    return el;
  }
  el.className = 'file-item';
  el.innerHTML = `
    <span class="file-status"></span>
    <span class="file-path"></span>
    <span class="file-diffstat"><span class="add"></span> <span class="del"></span></span>`;
  makeKeyActivatable(el);
  // Directories (git reports them untracked with a trailing slash) are not
  // clickable - a file preview of them is bound to fail.
  el.addEventListener('click', () => {
    if (!el.classList.contains('is-dir')) openPreview(activeId, item.file.path, item.source);
  });
  return el;
}

function updateFileItem(el, item) {
  const f = item.file;
  if (!f) { setText(el, item.title); return; }

  const isDir = Boolean(f.dir);
  const status = item.source === 'pr' ? 'M'
    : f.committed ? 'C'
      : f.untracked ? 'U' : f.status;

  el.classList.toggle('committed', Boolean(f.committed));
  el.classList.toggle('is-dir', isDir);
  el.tabIndex = isDir ? -1 : 0;
  setTitle(el, isDir ? t('git.files.dir', { path: f.path }) : f.path);

  const statusEl = el.querySelector('.file-status');
  statusEl.className = `file-status ${status}`;
  setText(statusEl, status);
  // Between the marks the path reads from the left even though the box lays it
  // out from the right (see .file-path in the stylesheet).
  setText(el.querySelector('.file-path'), `\u200e${f.path}\u200e`);

  const statEl = el.querySelector('.file-diffstat');
  statEl.classList.toggle('hidden', f.additions === undefined && f.deletions === undefined);
  setText(statEl.querySelector('.add'), `+${f.additions ?? 0}`);
  setText(statEl.querySelector('.del'), `−${f.deletions ?? 0}`);
}

// Headings, status tooltips and the worktree notice come from the dictionary,
// and the panel updates in place - so the same pass that draws an info tick
// draws the new language.
onLocaleChange(renderContextPanel);
