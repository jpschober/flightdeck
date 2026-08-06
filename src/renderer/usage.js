// ---------------------------------------------------------------------------
// Usage limits of the subscription: actual usage, plus the proportionally
// allowed level. After 3 of 7 days, 3/7 = 42.9 % is the target - anyone above
// that will blow the limit if the pace holds.
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { logWarn } from './log.js';
import { t, locale } from './i18n.js';

const usageContentEl = $('#usage-content');
const dotUsageEl = $('#dot-usage');
let usageTimer = null;

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

// The worst status wins - the dot on the tab should show the tightest limit
const SEVERITY = { unknown: 0, early: 0, ok: 1, warn: 2, over: 3 };

// Every window the endpoint delivers counts, including the ones that used to be
// left out of this (seven days Sonnet) and any that come later. A limit that
// bites stops work, whichever window it sits in - a dot that stays green while
// one of them is exhausted would be showing the wrong thing.
function worstStatus(data) {
  let worst = 'unknown';
  for (const l of data.limits || []) {
    if (l && SEVERITY[l.status] > SEVERITY[worst]) worst = l.status;
  }
  return worst;
}

// The endpoint names its windows itself; these three have a translation. A
// window that is not among them is shown under its raw key - it is visible,
// and the name says where it came from.
const WINDOW_LABELS = {
  five_hour: 'usage.window.5h',
  seven_day: 'usage.window.7d',
  seven_day_opus: 'usage.window.7dOpus',
};

function limitLabel(limit) {
  const key = WINDOW_LABELS[limit.key];
  return key ? t(key) : limit.key;
}

export async function loadUsage(force = false) {
  // Deliberately without a visibility check: the dot on the tab should be right
  // even when the tab is closed. Rendering into a hidden page costs nothing.
  const data = await window.api.getUsage(force);

  if (data.error && !data.stale) {
    usageContentEl.innerHTML = `
      <div class="uz-error">${escapeHtml(data.error)}</div>
      <div class="muted" style="margin-top:8px">${escapeHtml(t('usage.source', { usage: '\u0000' }))
        .replace('\u0000', '<code>/usage</code>')}</div>`;
    dotUsageEl.classList.add('hidden');
    return;
  }

  const parts = (data.limits || [])
    .map((limit) => renderLimit(limitLabel(limit), limit))
    .filter(Boolean);

  if (!parts.length) {
    usageContentEl.innerHTML = `<div class="muted">${escapeHtml(t('usage.noLimits'))}</div>`;
    dotUsageEl.classList.add('hidden');
    return;
  }

  const stamp = new Date(data.fetchedAt).toLocaleTimeString(locale,
    { hour: '2-digit', minute: '2-digit' });
  usageContentEl.innerHTML = `
    <div class="uz-top">
      ${data.plan ? `<span class="uz-plan">${escapeHtml(data.plan)}</span>` : '<span></span>'}
      <button id="usage-refresh" class="icon-btn" title="${escapeHtml(t('usage.refresh'))}" aria-label="${escapeHtml(t('usage.refresh.aria'))}">↻</button>
      <span class="uz-stamp">${escapeHtml(t('usage.asOf', { time: stamp }))}${data.stale ? ' · ' + escapeHtml(t('usage.stale')) : ''}</span>
    </div>
    ${data.stale ? `<div class="uz-error">${escapeHtml(data.error)}</div>` : ''}
    ${parts.join('')}
    <div class="uz-legend">${escapeHtml(t('usage.legend'))}</div>`;
  usageContentEl.querySelector('#usage-refresh')
    .addEventListener('click', () => loadUsage(true));

  const worst = worstStatus(data);
  dotUsageEl.className = 'tab-dot ' + worst;
  dotUsageEl.classList.toggle('hidden', worst !== 'warn' && worst !== 'over');
}

// Keep running in the background so the dot on the tab is right without having
// to keep the tab open
export function startUsagePolling() {
  loadUsage(true).catch((e) => logWarn('usage: first load failed, offline or similar', { err: e }));
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    loadUsage().catch((e) => logWarn('usage: background poll failed', { err: e }));
  }, 120_000);
}
