// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------
import { CodeView, processFile } from '@pierre/diffs';
import { $, escapeHtml } from './dom.js';
import { t, onLocaleChange } from './i18n.js';
import { mdToHtml } from './markdown.js';
import { makeOverlay, renderModeButtons } from './overlays.js';
import { logWarn } from './log.js';

const previewTitle = $('#preview-title');
const previewContent = $('#preview-content');

const previewModesEl = $('#preview-modes');
const MD_EXT = /\.(md|markdown|mdx)$/i;
export let previewState = null; // { sessionId, filePath, source, mode, cache }

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------
// @pierre/diffs renders the patch itself: syntax highlighting per language,
// within-line changes, and hunks that can be expanded. It builds its own DOM
// below the container and keeps it in a shadow root, so the app's stylesheet
// does not reach inside - what can be set from outside are the `--diffs-*`
// custom properties, which inherit through the shadow boundary.
//
// The view is virtualized and measures the container: it needs the scroll
// container itself, not a box inside one, which is what `.is-diff` below is
// for.
const DIFF_OPTIONS = {
  theme: 'pierre-dark',      // the app has no light mode
  themeType: 'dark',
  diffStyle: 'unified',      // as the previous view showed it
  overflow: 'scroll',
  disableFileHeader: true,   // the file name is already in the overlay header
};

let diffView = null;

/** The view holds observers and a shiki highlighter - both are given back. */
function disposeDiffView() {
  if (!diffView) return;
  try { diffView.cleanUp(); } catch (e) { logWarn('preview: diff view not cleanly disposed', { err: e }); }
  diffView = null;
  previewContent.classList.remove('is-diff');
}

/**
 * Renders the git patch of one file. Reports whether it could - an unparsable
 * patch (a binary file, a format the parser does not know) falls back to the
 * plain text, which is still readable.
 */
function renderDiffView(text, filePath) {
  let fileDiff;
  try {
    fileDiff = processFile(text, { isGitDiff: true, cacheKey: filePath, throwOnError: true });
  } catch (e) {
    logWarn('preview: patch not parsable, showing it as text', { path: filePath, err: e });
    return false;
  }
  // Text the parser cannot make sense of comes back as a diff without hunks
  // rather than as an error, and that renders as an empty pane.
  if (!fileDiff || !fileDiff.hunks || !fileDiff.hunks.length) return false;

  previewContent.replaceChildren();
  previewContent.classList.add('is-diff');
  diffView = new CodeView(DIFF_OPTIONS);
  diffView.setup(previewContent);
  diffView.setItems([{ id: filePath, type: 'diff', fileDiff }]);
  return true;
}

export const previewOverlay = makeOverlay($('#preview-overlay'), $('#preview-close'), {
  onClose: disposeDiffView,
});

// Fetches a view and remembers it - switching between the modes should not go
// over IPC again every time.
async function fetchPreview(wantContent) {
  const key = wantContent ? 'content' : 'default';
  if (previewState.cache[key]) return previewState.cache[key];
  const res = await window.api.previewFile(
    previewState.sessionId, previewState.filePath, previewState.source,
    wantContent ? { content: true } : undefined,
  );
  previewState.cache[key] = res;
  return res;
}

export async function renderPreview() {
  const st = previewState;
  // The formatted view needs the file content, not the diff
  const res = await fetchPreview(st.mode === 'md');
  if (previewState !== st) return; // a different file was opened meanwhile

  // The previous view is torn down before the new one is built, in every mode:
  // it holds a resize observer on the container the other modes write into.
  disposeDiffView();

  if (res.kind === 'error') {
    previewContent.innerHTML = `<pre class="pv-pre">${escapeHtml(res.text)}</pre>`;
    return;
  }
  if (st.mode === 'md') {
    previewContent.innerHTML = `<div class="pv-md md">${mdToHtml(res.text)}</div>`;
  } else if (res.kind === 'diff' && renderDiffView(res.text, st.filePath)) {
    return; // the view scrolls itself, and starts at the top
  } else {
    previewContent.innerHTML = `<pre class="pv-pre">${escapeHtml(res.text)}</pre>`;
  }
  previewContent.scrollTop = 0;
}

export function renderPreviewModes(hasDiff) {
  const modes = [];
  if (hasDiff) modes.push({ id: 'diff', label: t('preview.mode.diff') });
  modes.push({ id: 'raw', label: t(hasDiff ? 'preview.mode.file' : 'preview.mode.source') });
  if (MD_EXT.test(previewState.filePath)) modes.push({ id: 'md', label: t('preview.mode.formatted') });

  renderModeButtons(previewModesEl, modes, previewState.mode, (id) => {
    previewState.mode = id;
    renderPreviewModes(hasDiff);
    renderPreview();
  });
}

// Only the mode buttons and an error text are translated; the file content is
// not, so a closed preview has nothing to redraw.
onLocaleChange(() => {
  if (!previewOverlay.isOpen() || !previewState) return undefined;
  renderPreviewModes(Boolean(previewState.cache.default
    && previewState.cache.default.kind === 'diff'));
  return renderPreview();
});

export async function openPreview(sessionId, filePath, source) {
  previewTitle.textContent = t('preview.loading', { path: filePath });
  disposeDiffView();
  previewContent.innerHTML = '';
  previewModesEl.innerHTML = '';
  previewOverlay.open();

  previewState = { sessionId, filePath, source, mode: 'diff', cache: {} };
  const st = previewState;

  const first = await fetchPreview(false);
  if (previewState !== st) return;
  previewTitle.textContent = first.path;

  const hasDiff = first.kind === 'diff';
  // Show markdown without a diff formatted right away - that is usually why one opens it
  st.mode = hasDiff ? 'diff' : (MD_EXT.test(filePath) ? 'md' : 'raw');
  renderPreviewModes(hasDiff);
  await renderPreview();
}
