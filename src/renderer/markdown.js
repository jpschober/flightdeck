// ---------------------------------------------------------------------------
// Mini markdown renderer (PR descriptions, agent summaries).
// No external package (CSP) - covers the constructs agents typically use.
// ---------------------------------------------------------------------------
import { escapeHtml } from './dom.js';

// mdInline sees text that escapeHtml has already been through, so a link target
// arrives with & as &amp; and every quote and angle bracket as an entity. A raw
// & can therefore only be the start of such an entity, and rejecting all of
// them except &amp; and &#39; keeps double quotes and brackets out of the
// attribute - an apostrophe cannot end the double-quoted value it sits in.
// Everything else passes, unicode paths and IDN hosts included; a target that
// fails keeps its literal [label](target) form instead of becoming an anchor.
const MD_URL = /^https?:\/\/[^\s&<>"']*(?:(?:&amp;|&#39;)[^\s&<>"']*)*$/u;

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, label, url) => (
      MD_URL.test(url) ? `<a href="#" data-url="${url}">${label}</a>` : m));
}

export function mdToHtml(md) {
  if (!md) return '';
  const esc = escapeHtml(md.replace(/\r\n/g, '\n'));
  // Pull code blocks out so they are not processed any further
  const blocks = [];
  const withoutCode = esc.replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre class="md-code">${code}</pre>`);
    return `\x00${blocks.length - 1}\x00`;
  });

  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };

  for (const line of withoutCode.split('\n')) {
    const t = line.trim();
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    const li = t.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl} class="md-h">${mdInline(h[2])}</h${lvl}>`);
    } else if (li) {
      if (!listOpen) { out.push('<ul class="md-list">'); listOpen = true; }
      const chk = li[1].match(/^\[( |x|X)\]\s+(.*)$/);
      out.push(chk
        ? `<li class="md-task">${chk[1].trim() ? '☑' : '☐'} ${mdInline(chk[2])}</li>`
        : `<li>${mdInline(li[1])}</li>`);
    } else if (t.startsWith('&gt;')) {
      closeList();
      out.push(`<blockquote class="md-quote">${mdInline(t.slice(4).trim())}</blockquote>`);
    } else if (/^([-_*])\1{2,}$/.test(t)) {
      closeList();
      out.push('<hr class="md-hr">');
    } else if (!t) {
      closeList();
    } else {
      closeList();
      out.push(`<p class="md-p">${mdInline(t)}</p>`);
    }
  }
  closeList();
  return out.join('\n').replace(/\x00(\d+)\x00/g, (m, i) => blocks[+i]);
}

// Open links in rendered markdown externally
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) {
    e.preventDefault();
    window.api.openExternal(a.dataset.url);
  }
});
