// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { t, onLocaleChange } from './i18n.js';
import { mdToHtml } from './markdown.js';
import { makeOverlay, renderModeButtons } from './overlays.js';

export const previewOverlay = makeOverlay($('#preview-overlay'), $('#preview-close'));
const previewTitle = $('#preview-title');
const previewContent = $('#preview-content');

const previewModesEl = $('#preview-modes');
const MD_EXT = /\.(md|markdown|mdx)$/i;
export let previewState = null; // { sessionId, filePath, source, mode, cache }

function highlightDiff(text) {
  return text.split('\n').map((line) => {
    const esc = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return `<span class="dl-meta">${esc}</span>`;
    }
    if (line.startsWith('@@')) return `<span class="dl-hunk">${esc}</span>`;
    if (line.startsWith('+')) return `<span class="dl-add">${esc}</span>`;
    if (line.startsWith('-')) return `<span class="dl-del">${esc}</span>`;
    return esc;
  }).join('\n');
}

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

  if (res.kind === 'error') {
    previewContent.innerHTML = `<pre class="pv-pre">${escapeHtml(res.text)}</pre>`;
    return;
  }
  if (st.mode === 'md') {
    previewContent.innerHTML = `<div class="pv-md md">${mdToHtml(res.text)}</div>`;
  } else if (res.kind === 'diff') {
    previewContent.innerHTML = `<pre class="pv-pre">${highlightDiff(res.text)}</pre>`;
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
