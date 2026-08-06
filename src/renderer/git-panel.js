// ---------------------------------------------------------------------------
// Right-hand panel: PR + changed files
// ---------------------------------------------------------------------------
import { $, escapeHtml, makeKeyActivatable } from './dom.js';
import { t, locale, onLocaleChange } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { mdToHtml } from './markdown.js';
import { updateBadges } from './panel.js';
import { openPreview } from './preview.js';

const prCardEl = $('#pr-card');
const fileListEl = $('#file-list');

export function renderContextPanel() {
  const s = activeId ? sessions.get(activeId) : null;
  const wtBannerEl = $('#wt-banner');
  if (!s) {
    prCardEl.innerHTML = `<div class="muted">${escapeHtml(t('common.noSession'))}</div>`;
    $('#pr-extra').innerHTML = '';
    fileListEl.innerHTML = '';
    wtBannerEl.classList.add('hidden');
    updateBadges(null);
    return;
  }

  // --- Worktree notice ---
  // Branch and files then come from the agent's directory, not from the
  // shell's - without a notice that would be impossible to follow.
  wtBannerEl.classList.toggle('hidden', !s.worktree);
  if (s.worktree) {
    wtBannerEl.innerHTML = `
      <span class="wt-icon">⑂</span>
      <span class="wt-text">${escapeHtml(t('git.worktree.notice'))}
        <code>${escapeHtml(s.worktree)}</code></span>
      <span class="wt-sub" title="${escapeHtml(s.agentCwd || '')}">${escapeHtml(t('git.worktree.shell', { path: s.cwd }))}</span>`;
  }

  // --- PR card ---
  const prExtraEl = $('#pr-extra');
  if (s.pr) {
    const pr = s.pr;
    const stateClass = pr.isDraft ? 'draft' : pr.state.toLowerCase();
    const stateText = pr.isDraft ? 'Draft' : pr.state;
    const checks = pr.checks && pr.checks.total
      ? `<div class="pr-checks">
           ${pr.checks.failure ? `<span class="check-chip failure">✗ ${pr.checks.failure}</span>` : ''}
           ${pr.checks.pending ? `<span class="check-chip pending">● ${pr.checks.pending}</span>` : ''}
           ${pr.checks.success ? `<span class="check-chip success">✓ ${pr.checks.success}</span>` : ''}
         </div>`
      : '';
    prCardEl.innerHTML = `
      <div class="pr-title" title="${escapeHtml(t('git.pr.open'))}">#${pr.number} ${escapeHtml(pr.title)}</div>
      <div class="pr-meta">
        <span class="pr-state ${stateClass}">${escapeHtml(stateText)}</span>
        ${pr.author ? `<span>${escapeHtml(t('git.pr.by', { author: pr.author }))}</span>` : ''}
        ${checks}
      </div>
      <div class="pr-branches">${escapeHtml(pr.headRefName)} → ${escapeHtml(pr.baseRefName)}</div>
      <div class="pr-stats"><span class="add">+${pr.additions ?? 0}</span> <span class="del">−${pr.deletions ?? 0}</span></div>`;
    const prTitleEl = prCardEl.querySelector('.pr-title');
    prTitleEl.setAttribute('role', 'link');
    makeKeyActivatable(prTitleEl);
    prTitleEl.addEventListener('click', () => window.api.openExternal(pr.url));
    renderPrExtra(prExtraEl, pr);
  } else if (s.branch) {
    prCardEl.innerHTML = `<div class="muted">${
      escapeHtml(t('git.pr.none', { branch: '\u0000' })).replace('\u0000', `<code>${escapeHtml(s.branch)}</code>`)}</div>`;
    prExtraEl.innerHTML = '';
  } else if (s.gitBlocked) {
    // Not the same as "no repository": there is one here, and git is kept out
    // of it on purpose - see gitinfo.js.
    prCardEl.innerHTML = `<div class="git-blocked">${
      escapeHtml(t('git.blocked', { key: '\u0000' })).replace('\u0000', `<code>${escapeHtml(s.gitBlocked)}</code>`)}</div>`;
    prExtraEl.innerHTML = '';
  } else {
    prCardEl.innerHTML = `<div class="muted">${escapeHtml(t('git.noRepo'))}</div>`;
    prExtraEl.innerHTML = '';
  }

  // --- File lists ---
  fileListEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  // As soon as a PR exists, its file list is the authoritative one - the local
  // memory would only duplicate it.
  const hasPr = Boolean(s.pr && s.pr.files && s.pr.files.length);

  if (hasPr) {
    const t2 = document.createElement('div');
    t2.className = 'file-group-title';
    t2.textContent = t('git.files.inPr', { count: s.pr.files.length });
    frag.appendChild(t2);
    for (const f of s.pr.files) {
      frag.appendChild(buildFileItem(s, f, 'pr'));
    }
  } else if (s.files.length) {
    const open = s.files.filter((f) => !f.committed);
    const done = s.files.filter((f) => f.committed);
    if (open.length) {
      const t2 = document.createElement('div');
      t2.className = 'file-group-title';
      t2.textContent = t('git.files.worktree');
      frag.appendChild(t2);
      for (const f of open) frag.appendChild(buildFileItem(s, f, 'wt'));
    }
    if (done.length) {
      const t2 = document.createElement('div');
      t2.className = 'file-group-title';
      t2.textContent = t('git.files.committed', { count: done.length });
      frag.appendChild(t2);
      for (const f of done) frag.appendChild(buildFileItem(s, f, 'wt'));
    }
  }

  if (!frag.childNodes.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = s.branch ? t('git.files.none') : '—';
    frag.appendChild(d);
  }
  fileListEl.appendChild(frag);
  updateBadges(s);
}

onLocaleChange(renderContextPanel);

// PR extra sections (description, commits, comments) - the expanded state
// survives the periodic re-renders
const prOpenSections = new Set();

function buildDetails(key, title, innerHtml) {
  const d = document.createElement('details');
  d.className = 'pr-details';
  d.dataset.key = key;
  if (prOpenSections.has(key)) d.open = true;
  d.innerHTML = `<summary>${escapeHtml(title)}</summary><div class="pr-details-body">${innerHtml}</div>`;
  d.addEventListener('toggle', () => {
    if (d.open) prOpenSections.add(key);
    else prOpenSections.delete(key);
  });
  return d;
}

function renderPrExtra(container, pr) {
  container.innerHTML = '';
  const frag = document.createDocumentFragment();

  if (pr.body && pr.body.trim()) {
    frag.appendChild(buildDetails('body', t('git.pr.description'), `<div class="md">${mdToHtml(pr.body)}</div>`));
  }

  if (pr.checks && pr.checks.total) {
    const rows = pr.checks.items.map((c) =>
      `<div class="check-row"><span class="check-dot ${c.status}"></span>${escapeHtml(c.name)}</div>`).join('');
    frag.appendChild(buildDetails('checks', t('git.pr.checks', {
      success: pr.checks.success, failure: pr.checks.failure, pending: pr.checks.pending,
    }), rows));
  }

  if (pr.commits && pr.commits.length) {
    const rows = pr.commits.slice().reverse().map((c) =>
      `<div class="commit-row"><code class="commit-sha">${escapeHtml(c.sha)}</code>${escapeHtml(c.message)}</div>`).join('');
    frag.appendChild(buildDetails('commits', t('git.pr.commits', { count: pr.commits.length }), rows));
  }

  const feedback = [
    ...(pr.reviews || []).map((r) => ({ ...r, kind: 'review', at: r.submittedAt })),
    ...(pr.comments || []).map((c) => ({ ...c, kind: 'comment', at: c.createdAt })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  if (feedback.length) {
    const rows = feedback.map((f) => `
      <div class="fb-row">
        <div class="fb-head">
          <strong>${escapeHtml(f.author || '?')}</strong>
          ${f.kind === 'review' ? `<span class="fb-state ${escapeHtml((f.state || '').toLowerCase())}">${escapeHtml(f.state || '')}</span>` : ''}
          <span class="fb-date">${f.at ? new Date(f.at).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>
        ${f.body ? `<div class="md">${mdToHtml(f.body)}</div>` : ''}
      </div>`).join('');
    frag.appendChild(buildDetails('feedback', t('git.pr.feedback', { count: feedback.length }), rows));
  }

  container.appendChild(frag);
}

function buildFileItem(s, f, source) {
  const filePath = f.path;
  const isDir = Boolean(f.dir);
  const status = source === 'pr' ? 'M'
    : f.committed ? 'C'
      : f.untracked ? 'U' : f.status;

  const el = document.createElement('div');
  el.className = 'file-item'
    + (f.committed ? ' committed' : '')
    + (isDir ? ' is-dir' : '');
  el.title = isDir ? t('git.files.dir', { path: filePath }) : filePath;

  const stat = (f.additions !== undefined || f.deletions !== undefined)
    ? `<span class="file-diffstat"><span class="add">+${f.additions ?? 0}</span> <span class="del">−${f.deletions ?? 0}</span></span>`
    : '';
  el.innerHTML = `
    <span class="file-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
    <span class="file-path">&lrm;${escapeHtml(filePath)}&lrm;</span>
    ${stat}`;

  // Directories (git reports them untracked with a trailing slash) are not
  // clickable - a file preview of them is bound to fail.
  if (!isDir) {
    makeKeyActivatable(el);
    el.addEventListener('click', () => openPreview(s.id, filePath, source));
  }
  return el;
}
