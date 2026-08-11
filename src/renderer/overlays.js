// ---------------------------------------------------------------------------
// Overlays and mode switches
//
// Preview, database comparison and the session browser differ in content only.
// Each closes on a click on the backdrop, on its close button and on Escape,
// and each hands the focus back to the terminal - the terminal is where typing
// goes on, and a layer that leaves the focus behind swallows the next keystroke.
// ---------------------------------------------------------------------------
import { focusActiveTerm } from './sessions.js';

const overlays = []; // most recently opened first - that is the Escape order

/**
 * @param el        the layer itself
 * @param closeEl   its close button, if it has one
 * @param opts      `backdrop: false` for a layer that fills its own box - there
 *                  is no dimmed surround to click, and its padding is not one.
 *                  `onClose` runs however the layer was closed, Escape included.
 */
export function makeOverlay(el, closeEl, opts = {}) {
  const overlay = {
    isOpen: () => !el.classList.contains('hidden'),
    open() {
      el.classList.remove('hidden');
      const at = overlays.indexOf(overlay);
      if (at > 0) overlays.unshift(...overlays.splice(at, 1));
    },
    close() {
      el.classList.add('hidden');
      if (opts.onClose) opts.onClose();
      focusActiveTerm();
    },
  };
  if (opts.backdrop !== false) {
    el.addEventListener('click', (e) => { if (e.target === el) overlay.close(); });
  }
  if (closeEl) closeEl.addEventListener('click', () => overlay.close());
  overlays.unshift(overlay);
  return overlay;
}

/** Closes the topmost open overlay; reports whether there was one. */
export function closeTopOverlay() {
  const top = overlays.find((o) => o.isOpen());
  if (!top) return false;
  top.close();
  return true;
}

/**
 * The row of mode buttons above preview and comparison. Fewer than two modes
 * leave the row empty - there is nothing to switch between.
 */
export function renderModeButtons(container, modes, current, onPick) {
  container.innerHTML = '';
  if (modes.length < 2) return;
  for (const m of modes) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.className = m.id === current ? 'active' : '';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { if (m.id !== current) onPick(m.id); });
    container.appendChild(b);
  }
}
