// ---------------------------------------------------------------------------
// Meta popover: edit the label
//
// Imports terminal.js and is imported by it. Mutual on purpose - see the note
// at the top of terminal.js.
// ---------------------------------------------------------------------------
import { $ } from './dom.js';
import { sessions } from './sessions.js';
import { updateSessionItem } from './terminal.js';

const metaPopover = $('#meta-popover');
const metaLabelInput = $('#meta-label');
let metaSessionId = null;

export function openMetaPopover(s, ev) {
  metaSessionId = s.id;
  metaLabelInput.value = s.label || '';
  metaPopover.classList.remove('hidden');
  const x = Math.min(ev.clientX, window.innerWidth - 260);
  const y = Math.min(ev.clientY, window.innerHeight - 180);
  metaPopover.style.left = x + 'px';
  metaPopover.style.top = y + 'px';
  metaLabelInput.focus();
  metaLabelInput.select();
}

export function closeMetaPopover() {
  metaPopover.classList.add('hidden');
  metaSessionId = null;
}

$('#meta-save').addEventListener('click', async () => {
  const s = sessions.get(metaSessionId);
  if (s) {
    s.label = metaLabelInput.value.trim() || null;
    await window.api.setMeta(s.id, { title: s.title, label: s.label });
    updateSessionItem(s);
  }
  closeMetaPopover();
});
$('#meta-cancel').addEventListener('click', closeMetaPopover);
metaPopover.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#meta-save').click();
  if (e.key === 'Escape') closeMetaPopover();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#meta-popover') && !e.target.closest('.session-item')) closeMetaPopover();
});
