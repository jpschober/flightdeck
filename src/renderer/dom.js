// ---------------------------------------------------------------------------
// The small helpers every panel needs: element lookup, escaping, keyboard
// operability - and the toast line, which has no panel of its own.
// ---------------------------------------------------------------------------
export const $ = (sel) => document.querySelector(sel);

// Quotes are escaped as well: almost every caller interpolates the result into
// a double-quoted attribute value (title=, value=), and PR bodies, review
// comments and SQL migrations from a cloned repo are written by third parties.
export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Make an element keyboard-operable: Enter/Space = click
export function makeKeyActivatable(el) {
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  });
}

export function basename(p) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ---------------------------------------------------------------------------
// Toast: one line for what happened without being asked for
//
// One message at a time, the next one replaces it. A stack would grow with
// every clipboard write a loop in the terminal sends and cover the screen, and
// only the last one says what is on the clipboard now. Nothing here takes the
// focus - typing goes on in the terminal while the line stands.
// ---------------------------------------------------------------------------
const toastEl = $('#toast');
const TOAST_MS = 4000;
let toastTimer = null;

export function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
    toastEl.textContent = '';
  }, TOAST_MS);
}
