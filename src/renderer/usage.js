// ---------------------------------------------------------------------------
// Usage limits of the subscription: actual usage, plus the proportionally
// allowed level. After 3 of 7 days, 3/7 = 42.9 % is the target - anyone above
// that will blow the limit if the pace holds.
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { logWarn } from './log.js';
import { t, locale, onLocaleChange } from './i18n.js';
import { makeOverlay } from './overlays.js';

const usageContentEl = $('#usage-content');
const usagePopoverEl = $('#usage-popover');
const limitBarEl = $('#limit-bar');
const lbLabelEl = $('#lb-label');
const lbValueEl = $('#lb-value');
const lbFillEl = $('#lb-fill');
const lbMarkEl = $('#lb-mark');
let usageTimer = null;

// The popover hangs off the limit bar rather than sitting in the panel: it is
// wider than the panel, and the panel clips what sticks out of it.
const usageOverlay = makeOverlay(usagePopoverEl, null, {
  backdrop: false,
  onClose() {
    limitBarEl.classList.remove('open');
    limitBarEl.setAttribute('aria-expanded', 'false');
  },
});

function placeUsagePopover() {
  const bar = limitBarEl.getBoundingClientRect();
  usagePopoverEl.style.bottom = (window.innerHeight - bar.top + 9) + 'px';
  usagePopoverEl.style.right = Math.max(8, window.innerWidth - bar.right + 1) + 'px';
}

export function closeUsagePopover() {
  if (usageOverlay.isOpen()) usageOverlay.close();
}

function openUsagePopover() {
  usageOverlay.open();
  placeUsagePopover();
  limitBarEl.classList.add('open');
  limitBarEl.setAttribute('aria-expanded', 'true');
  // The numbers are two minutes old at worst; opening the panel is the moment
  // someone actually wants them current.
  loadUsage().catch((e) => logWarn('usage: refresh on open failed', { err: e }));
}

limitBarEl.addEventListener('click', () => {
  if (usageOverlay.isOpen()) closeUsagePopover();
  else openUsagePopover();
});
document.addEventListener('click', (e) => {
  if (!usageOverlay.isOpen()) return;
  if (e.target.closest('#usage-popover') || e.target.closest('#limit-bar')) return;
  closeUsagePopover();
});
window.addEventListener('resize', () => { if (usageOverlay.isOpen()) placeUsagePopover(); });

function fmtPct(n) {
  if (typeof n !== 'number') return '–';
  // Decimal separator and grouping follow the chosen language, not the source
  // language - 42,9 % in German and French, 42.9 % in English.
  return (Math.round(n * 10) / 10).toLocaleString(locale) + ' %';
}

// "in 1 h 47" or "in 3 days 5 h"
function fmtUntil(ts) {
  if (!ts) return '';
  let ms = ts - Date.now();
  if (ms <= 0) return t('usage.now');
  const days = Math.floor(ms / 86400000); ms -= days * 86400000;
  const hours = Math.floor(ms / 3600000); ms -= hours * 3600000;
  const mins = Math.floor(ms / 60000);
  if (days) return t('usage.in.days', { count: days, days, hours });
  if (hours) return t('usage.in.hours', { hours, minutes: String(mins).padStart(2, '0') });
  return t('usage.in.minutes', { minutes: mins });
}

function fmtReset(ts) {
  if (!ts) return t('usage.unknownReset');
  return new Date(ts).toLocaleString(locale,
    { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderLimit(title, limit, opts = {}) {
  if (!limit) return '';
  const status = limit.status || 'unknown';
  const used = typeof limit.used === 'number' ? limit.used : 0;
  const budget = typeof limit.budget === 'number' ? limit.budget : null;
  // Only show the target mark where it says something (not at the window edge)
  const showMark = budget !== null && budget > 1 && budget < 99 && !opts.hideMark;

  let verdict = '';
  if (status === 'unknown') {
    verdict = `<div class="uz-note">${escapeHtml(t('usage.limit.none'))}</div>`;
  } else if (status === 'early') {
    verdict = `<div class="uz-note">${escapeHtml(t('usage.early', { budget: '\u0000' }))
      .replace('\u0000', `<strong>${fmtPct(budget)}</strong>`)}</div>`;
  } else {
    const over = used - budget;
    verdict = `<div class="uz-verdict ${status}">
      <span class="uz-target">${escapeHtml(t('usage.allowed', { budget: '\u0000' }))
        .replace('\u0000', `<strong>${fmtPct(budget)}</strong>`)}</span>
      <span class="uz-delta">${escapeHtml(over > 0
        ? t('usage.over', { amount: fmtPct(over) })
        : t('usage.spare', { amount: fmtPct(-over) }))}</span>
      <span class="uz-proj">${escapeHtml(t('usage.projection', { value: '\u0000' }))
        .replace('\u0000', `<strong>${fmtPct(limit.projected)}</strong>`)}</span>
    </div>`;
  }

  return `
    <section class="uz-card ${status}">
      <header class="uz-head">
        <span class="uz-dot ${status}"></span>
        <span class="uz-title">${escapeHtml(title)}</span>
        <span class="uz-status">${escapeHtml(t('usage.status.' + status))}</span>
      </header>
      <div class="uz-bar" role="img" aria-label="${escapeHtml(t('usage.used', { percent: fmtPct(used) }))}">
        <div class="uz-fill ${status}" style="width:${Math.min(used, 100)}%"></div>
        ${showMark ? `<div class="uz-mark" style="left:${budget}%" title="${escapeHtml(t('usage.target', { percent: fmtPct(budget) }))}"></div>` : ''}
      </div>
      <div class="uz-meta">
        <span class="uz-used">${escapeHtml(t('usage.used', { percent: fmtPct(used) }))}</span>
        <span class="uz-reset">${escapeHtml(t('usage.reset', { when: fmtReset(limit.resetsAt), until: fmtUntil(limit.resetsAt) }))}</span>
      </div>
      ${verdict}
    </section>`;
}

// The worst status wins - the bar should show the tightest limit
const SEVERITY = { unknown: 0, early: 0, ok: 1, warn: 2, over: 3 };

// Both windows count. A limit that bites stops work, whichever of the two it
// sits in - a bar that stays green while one of them is exhausted would be
// showing the wrong thing.
function tightestLimit(data) {
  let worst = null;
  for (const l of data.limits || []) {
    if (!l) continue;
    if (!worst) { worst = l; continue; }
    const bySeverity = SEVERITY[l.status] - SEVERITY[worst.status];
    if (bySeverity > 0) { worst = l; continue; }
    // Same severity: the one furthest past its proportional share
    if (bySeverity === 0 && overshoot(l) > overshoot(worst)) worst = l;
  }
  return worst;
}

function overshoot(limit) {
  const used = typeof limit.used === 'number' ? limit.used : 0;
  const budget = typeof limit.budget === 'number' ? limit.budget : 0;
  return used - budget;
}

// The main process passes on these two windows only, so every limit that gets
// here has a translated name.
const WINDOW_LABELS = {
  five_hour: 'usage.window.5h',
  seven_day: 'usage.window.7d',
};

function limitLabel(limit) {
  return t(WINDOW_LABELS[limit.key]);
}

// The bar at the foot of the panel: the one limit that binds first, as a
// percentage against the share that would be proportional by now.
function renderLimitBar(limit) {
  limitBarEl.classList.toggle('hidden', !limit);
  if (!limit) { closeUsagePopover(); return; }
  const status = limit.status || 'unknown';
  const used = typeof limit.used === 'number' ? limit.used : 0;
  const budget = typeof limit.budget === 'number' ? limit.budget : null;
  // Only show the target mark where it says something (not at the window edge)
  const showMark = budget !== null && budget > 1 && budget < 99;

  limitBarEl.classList.remove('ok', 'warn', 'over', 'early', 'unknown');
  limitBarEl.classList.add(status);
  lbLabelEl.textContent = limitLabel(limit);
  lbValueEl.textContent = showMark ? `${fmtPct(used)} / ${fmtPct(budget)}` : fmtPct(used);
  lbFillEl.style.width = Math.min(used, 100) + '%';
  lbMarkEl.classList.toggle('hidden', !showMark);
  if (showMark) lbMarkEl.style.left = budget + '%';
  limitBarEl.title = t('usage.status.' + status);
}

export async function loadUsage(force = false) {
  // Deliberately without a visibility check: the bar at the foot of the panel
  // should be right even while the popover is closed.
  const data = await window.api.getUsage(force);

  if (data.error && !data.stale) {
    // eslint-disable-next-line no-unsanitized/property -- the texts are escaped first, the markup put in afterwards is written here
    usageContentEl.innerHTML = `
      <div class="uz-error">${escapeHtml(data.error)}</div>
      <div class="muted" style="margin-top:8px">${escapeHtml(t('usage.source', { usage: '\u0000' }))
        .replace('\u0000', '<code>/usage</code>')}</div>`;
    renderLimitBar(null);
    return;
  }

  const parts = (data.limits || [])
    .map((limit) => renderLimit(limitLabel(limit), limit))
    .filter(Boolean);

  if (!parts.length) {
    usageContentEl.innerHTML = `<div class="muted">${escapeHtml(t('usage.noLimits'))}</div>`;
    renderLimitBar(null);
    return;
  }

  const stamp = new Date(data.fetchedAt).toLocaleTimeString(locale,
    { hour: '2-digit', minute: '2-digit' });
  // eslint-disable-next-line no-unsanitized/property -- every value goes through escapeHtml; the rule cannot follow the conditionals in between
  usageContentEl.innerHTML = `
    <div class="uz-top">
      ${data.plan ? `<span class="uz-plan">${escapeHtml(data.plan)}</span>` : '<span></span>'}
      <span class="uz-actions">
        <button id="usage-refresh" class="icon-btn" title="${escapeHtml(t('usage.refresh'))}" aria-label="${escapeHtml(t('usage.refresh.aria'))}">↻</button>
        <button id="usage-close" class="icon-btn" title="${escapeHtml(t('usage.close'))}" aria-label="${escapeHtml(t('usage.close'))}">✕</button>
      </span>
      <span class="uz-stamp">${escapeHtml(t('usage.asOf', { time: stamp }))}${data.stale ? ' · ' + escapeHtml(t('usage.stale')) : ''}</span>
    </div>
    ${data.stale ? `<div class="uz-error">${escapeHtml(data.error)}</div>` : ''}
    ${parts.join('')}
    <div class="uz-legend">${escapeHtml(t('usage.legend'))}</div>`;
  usageContentEl.querySelector('#usage-refresh')
    .addEventListener('click', () => loadUsage(true));
  usageContentEl.querySelector('#usage-close')
    .addEventListener('click', () => closeUsagePopover());

  renderLimitBar(tightestLimit(data));
}

// The status words and the number formats come out of the dictionary and the
// locale, so the card has to be built again.
onLocaleChange(() => loadUsage(true)
  .catch((e) => logWarn('language: usage not reloaded', { err: e })));

// Keep running in the background so the limit bar is right without anyone
// having to open the popover
export function startUsagePolling() {
  loadUsage(true).catch((e) => logWarn('usage: first load failed, offline or similar', { err: e }));
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    loadUsage().catch((e) => logWarn('usage: background poll failed', { err: e }));
  }, 120_000);
}
