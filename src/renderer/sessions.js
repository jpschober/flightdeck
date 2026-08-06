// ---------------------------------------------------------------------------
// The open sessions
//
// Every panel reads from here, so this module holds nothing but the registry
// and the id of the session on screen. Creating, activating and closing a
// session lives in terminal.js; keeping the state separate from it lets the
// overlays and the panels reach the registry without reaching the terminal.
// ---------------------------------------------------------------------------
export const sessions = new Map(); // id -> { meta..., term, fit, paneEl, itemEl }

export let activeId = null;

export function setActiveId(id) {
  activeId = id;
}

export function focusActiveTerm() {
  const s = activeId && sessions.get(activeId);
  if (s) s.term.focus();
}
