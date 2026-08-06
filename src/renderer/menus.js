// ---------------------------------------------------------------------------
// Header: new-session buttons, shell menu and the menu behind the ⋯ button
// ---------------------------------------------------------------------------
import { $ } from './dom.js';
import { logWarn } from './log.js';
import { t, locale, locales, setLanguage } from './i18n.js';
import { newSession } from './terminal.js';
import { toggleGrid } from './grid.js';
import { openSessionBrowser } from './session-browser.js';

const shellMenu = $('#shell-menu');
const moreMenu = $('#more-menu');
let shells = [];

/** The shell the + button starts a session in. */
export function defaultShellId() {
  return shells[0] && shells[0].id;
}

// The shells come from the main process and one of them ("Command Prompt") is
// translated there, so the menu is rebuilt rather than relabelled.
export async function buildShellMenu() {
  shells = await window.api.listShells();
  shellMenu.innerHTML = '';
  for (const sh of shells) {
    const b = document.createElement('button');
    b.textContent = sh.name;
    b.addEventListener('click', () => {
      shellMenu.classList.add('hidden');
      newSession(sh.id);
    });
    shellMenu.appendChild(b);
  }
}

// Whether the terminal output may write the clipboard (OSC 52). The main
// process owns the setting; this is the copy the menu draws itself from.
let osc52On = true;

/**
 * Fetch that copy. A failure must not stop the startup - the setting decides in
 * the main process either way, this is only what the menu draws.
 */
export async function loadOsc52Setting() {
  try { osc52On = await window.api.osc52Enabled(); }
  catch (e) { logWarn('osc52: setting not read, the menu shows the default', { err: e }); }
}

// Everything that is not "start a new session" lives in one menu. Those are
// the rare moves - a permanent button each turned the header into a row of
// competing icons, and the shortcut belongs next to the entry anyway.
export function buildMoreMenu() {
  moreMenu.innerHTML = '';

  const entry = (className, icon, label, shortcut, onClick) => {
    const b = document.createElement('button');
    b.className = className;
    b.innerHTML = '<span class="mi-icon"></span><span class="mi-label"></span><span class="mi-key"></span>';
    b.querySelector('.mi-icon').textContent = icon;
    b.querySelector('.mi-label').textContent = label;
    b.querySelector('.mi-key').textContent = shortcut;
    b.addEventListener('click', () => { moreMenu.classList.add('hidden'); onClick(); });
    moreMenu.appendChild(b);
  };

  entry('menu-item', '⊞', t('header.grid.aria'), `${t('key.ctrl')}+G`, toggleGrid);
  entry('menu-item', '⟲', t('header.sessions.aria'), '', openSessionBrowser);
  // The state travels with the entry: the checkmark is what says whether the
  // terminal output may write the clipboard.
  entry(`menu-item${osc52On ? ' active' : ''}`, osc52On ? '✓' : '', t('menu.osc52'), '', async () => {
    osc52On = await window.api.setOsc52Enabled(!osc52On);
    buildMoreMenu();
  });

  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  moreMenu.appendChild(sep);
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = t('header.language.title');
  moreMenu.appendChild(title);

  for (const l of locales) {
    const active = l.code === locale;
    // The endonym is not translated - see the registry in src/i18n/index.js.
    entry(`menu-item lang${active ? ' active' : ''}`, active ? '✓' : '', l.name, '',
      () => setLanguage(l.code));
  }
}

$('#btn-new').addEventListener('click', () => newSession(defaultShellId()));
$('#btn-new-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  shellMenu.classList.toggle('hidden');
  moreMenu.classList.add('hidden');
});
$('#btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenu.classList.toggle('hidden');
  shellMenu.classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.new-session-wrap')) shellMenu.classList.add('hidden');
  if (!e.target.closest('.more-wrap')) moreMenu.classList.add('hidden');
});

export function menuOpen() {
  return !moreMenu.classList.contains('hidden') || !shellMenu.classList.contains('hidden');
}

export function closeMenus() {
  moreMenu.classList.add('hidden');
  shellMenu.classList.add('hidden');
}
