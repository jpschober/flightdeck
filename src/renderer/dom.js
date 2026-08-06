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
// Lists that are updated instead of rebuilt
//
// What the user has done to a panel hangs off its elements: which <details>
// is open, where the list is scrolled, what is selected. An element that is
// thrown away and built again takes all of that with it, so the panels find
// their elements again by id and set the fields that changed - the way
// buildSessionItem/updateSessionItem do it for the sidebar.
// ---------------------------------------------------------------------------

/** Set text only when it differs - an equal write drops a selection inside it. */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

export function setTitle(el, text) {
  if (el.title !== text) el.title = text;
}

/**
 * Bring the children of `container` into the order and the content of `items`.
 * `build` creates an empty element for an item, `update` fills it. An item's
 * `id` has to be unique inside the container and to name the kind of element
 * as well, so a heading is never reused as a row.
 */
export function syncChildren(container, items, build, update) {
  const known = new Map();
  for (const el of container.children) {
    if (el.dataset.id && !known.has(el.dataset.id)) known.set(el.dataset.id, el);
  }
  const keep = new Set();
  let at = container.firstElementChild;
  for (const item of items) {
    let el = known.get(item.id);
    if (!el || keep.has(el)) {
      el = build(item);
      el.dataset.id = item.id;
    }
    keep.add(el);
    update(el, item);
    // Everything before `at` is already in place, so the element belongs
    // exactly there - either it is already standing there or it moves there.
    if (el === at) at = at.nextElementSibling;
    else container.insertBefore(el, at);
  }
  for (const el of [...container.children]) if (!keep.has(el)) el.remove();
}

/**
 * A sentence from the dictionary with marked slots in it: the text carries
 * \u0000 and \u0001 where a `tag` element with the matching value goes. Text
 * and value are set separately, so nothing from outside becomes markup.
 */
export function setSlotSentence(el, text, tag, values) {
  const parts = text.split(/[\u0000\u0001]/);
  if (el.children.length !== parts.length * 2 - 1) {
    el.replaceChildren();
    for (let i = 0; i < parts.length; i++) {
      if (i) el.appendChild(document.createElement(tag));
      el.appendChild(document.createElement('span'));
    }
  }
  let slot = 0;
  let part = 0;
  for (const child of el.children) {
    setText(child, child.tagName === tag.toUpperCase() ? (values[slot++] || '') : parts[part++]);
  }
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
