'use strict';
// IPC: everything the renderer can ask of the main process.
const { ipcMain, clipboard, shell: electronShell } = require('electron');
const { listClaudeSessions } = require('./claude-sessions');
const { availableShells, shellName } = require('./shells');
const {
  sessions, createSession, closeSession, refreshSession, ackOutput, gridPreview,
} = require('./sessions');
const { setState, feedInputRecon } = require('./session-state');
const { previewFile } = require('./preview');
const todoStore = require('./todos');
const { getUsage } = require('./usage');
const { getSchemaView, clearCache: clearSchemaCache } = require('./dbschema');
const i18n = require('../i18n');
const { t } = i18n;
const settings = require('./settings');
const { getWindow, alive } = require('./window');
const log = require('./log');

// Only http(s) goes to the system browser; file:// and everything else stays put.
function isExternalUrl(url) { return /^https?:\/\//.test(url); }

// Every channel the preload bridge names. Called once from main.js, before the
// window loads its document: the renderer asks for i18n:init synchronously
// while the page is still parsing, so the handler has to stand before then.
// Registering on require instead would tie the whole IPC surface to whether
// somebody still imports something from this module.
function registerIpc() {
  ipcMain.handle('shells:list', () => availableShells.map((s) => ({ id: s.id, name: shellName(s) })));
  ipcMain.handle('session:create', (e, shellId, opts) => createSession(shellId, opts || {}));

  ipcMain.handle('session:buffer', (e, id) => {
    const s = sessions.get(id);
    if (!s) return '';
    return gridPreview(s);
  });

  // Flow control: the renderer reports the batch it has written to xterm. A
  // negative count would inflate `unacked` instead of reducing it and leave the
  // session paused for good, so the count has to be a non-negative integer.
  ipcMain.on('session:ack', (e, id, chars) => {
    const s = sessions.get(id);
    if (s && !s.exited && Number.isInteger(chars) && chars >= 0) ackOutput(s, chars);
  });

  ipcMain.handle('claude:sessions', () => listClaudeSessions());

  ipcMain.handle('usage:get', (e, force) => getUsage(Boolean(force)));

  // The renderer runs sandboxed and has no file access of its own, so its lines
  // come through here and land in the same file as the main process's - one file
  // per report, not two. What arrives here is untrusted input like everything
  // else that crosses the bridge, so it is clamped in three ways: level, field
  // count, and rate. Without the rate limit a page in a loop turns into unbounded
  // synchronous writes on this process's event loop and the interface stops
  // moving; the renderer's own duplicate suppressor sits on the far side of the
  // bridge and proves nothing about what arrives.
  const RENDERER_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
  const RENDERER_RATE = 20; // lines per second, burst of the same size
  let rendererTokens = RENDERER_RATE;
  let rendererRefill = Date.now();
  let rendererDropped = 0;

  ipcMain.on('log:renderer', (e, level, message, data) => {
    const now = Date.now();
    rendererTokens = Math.min(RENDERER_RATE, rendererTokens + ((now - rendererRefill) / 1000) * RENDERER_RATE);
    rendererRefill = now;
    if (rendererTokens < 1) { rendererDropped++; return; }
    rendererTokens -= 1;

    // An unknown level lands on info, not debug: below the default threshold the
    // line would disappear entirely, and a renderer sending a wrong level is
    // itself something to see.
    const method = RENDERER_LEVELS.has(level) ? level : 'info';
    const fields = {};
    if (rendererDropped) { fields.suppressed = rendererDropped; rendererDropped = 0; }
    if (data && typeof data === 'object') {
      // Values go through as they are - log.js flattens and clamps them, and
      // that is where the sink defends itself.
      for (const [key, value] of Object.entries(data).slice(0, 8)) fields[key] = value;
    }
    log[method]('renderer: ' + String(message).slice(0, 300), fields);
  });

  // DB schema: the sensor looks for the responsible plugin and compares against
  // the requested baseline. The repo root is the right root - if the agent works
  // in a worktree, gitRoot already points there.
  ipcMain.handle('dbschema:get', async (e, id, opts = {}) => {
    const s = sessions.get(id);
    if (!s) return { ok: false, reason: 'no-session' };
    const root = s.gitRoot || s.agentCwd || s.cwd;
    try {
      return await getSchemaView(root, {
        pr: s.pr,
        baseline: opts.baseline || 'auto',
        force: Boolean(opts.force),
      });
    } catch (err) {
      log.warn('dbschema: view failed', { root, baseline: opts.baseline || 'auto', err });
      return { ok: false, reason: 'error', error: err.message };
    }
  });


  // The preload asks for this synchronously while the page is still loading -
  // the renderer must not paint a single English label before switching.
  ipcMain.on('i18n:init', (e) => {
    e.returnValue = { locale: i18n.getLocale(), locales: i18n.available(), dict: i18n.dict() };
  });

  ipcMain.handle('i18n:set', (e, code) => {
    const locale = i18n.setLocale(code);
    settings.set('locale', locale);
    // Schemas and baselines carry strings that were translated when they were
    // built - they have to be read again, not served from the cache.
    clearSchemaCache();
    // Sessions carry a shell name; force a refresh so the tabs follow along.
    for (const s of sessions.values()) refreshSession(s, true);
    return { locale, dict: i18n.dict() };
  });

  ipcMain.on('app:focus', () => {
    if (alive()) {
      const win = getWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // Clipboard via the main process: in the renderer `navigator.clipboard.readText()`
  // needs the `clipboard-read` permission, which Electron denies without a custom
  // permission handler - pasting failed silently.
  ipcMain.on('clipboard:write', (e, text) => {
    if (typeof text === 'string' && text) clipboard.writeText(text);
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // ---------------------------------------------------------------------------
  // OSC 52: the program in the terminal asks for the clipboard
  //
  // Its own channel, separate from the copy above: the user clicked for that one,
  // here a line of output is enough - a build script, a downloaded file, any
  // output at all. The setting therefore switches off this path alone.
  //
  // What arrives is cut down to what a clipboard is for. Control characters are
  // dropped, tab and newline stay: Claude copies code blocks over this route, and
  // those are multi-line. An escape sequence in the clipboard would act on the
  // next terminal it is pasted into, and it would not be visible in the report.
  // ---------------------------------------------------------------------------
  const OSC52_MAX_CHARS = 100 * 1024;
  const osc52Enabled = () => settings.get('osc52Write', true) !== false;
  const OSC52_STRIP_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g; // every control character but \t and \n

  // An emoji is two code units, and a cut between them leaves half of it on the
  // clipboard. The cut goes back one unit when it lands between the two.
  function capChars(text) {
    if (text.length <= OSC52_MAX_CHARS) return text;
    const last = text.charCodeAt(OSC52_MAX_CHARS - 1);
    const cut = last >= 0xd800 && last <= 0xdbff ? OSC52_MAX_CHARS - 1 : OSC52_MAX_CHARS;
    return text.slice(0, cut);
  }

  ipcMain.handle('clipboard:write-osc52', (e, text) => {
    if (typeof text !== 'string' || !text) return { written: 0, off: false };
    if (!osc52Enabled()) {
      log.debug('osc52: write refused, switched off', { chars: text.length });
      return { written: 0, off: true };
    }
    const clean = capChars(text.replace(OSC52_STRIP_RE, ''));
    if (!clean) return { written: 0, off: false };
    clipboard.writeText(clean);
    log.debug('osc52: clipboard written', { chars: clean.length, dropped: text.length - clean.length });
    return { written: clean.length, off: false };
  });

  ipcMain.handle('osc52:enabled', () => osc52Enabled());

  ipcMain.handle('osc52:set-enabled', (e, on) => {
    settings.set('osc52Write', Boolean(on));
    return Boolean(on);
  });

  ipcMain.on('session:input', (e, id, data) => {
    const s = sessions.get(id);
    if (s && !s.exited) {
      s.lastInputAt = Date.now();
      feedInputRecon(s, data);
      // Fallback while the integration has not reported yet: Enter = command started
      if (!s.hasOsc133 && s.integrated && data.includes('\r')) setState(s, 'busy');
      s.proc.write(data);
    }
  });

  ipcMain.on('session:resize', (e, id, cols, rows) => {
    const s = sessions.get(id);
    if (s && !s.exited && cols > 0 && rows > 0) {
      try { s.proc.resize(cols, rows); } catch (e) { log.debug('session: resize failed, race while shutting down', { session: id, cols, rows, err: e }); }
    }
  });

  ipcMain.handle('session:close', (e, id) => closeSession(id));

  ipcMain.handle('session:setMeta', (e, id, meta) => {
    const s = sessions.get(id);
    if (!s) return;
    if ('title' in meta) s.title = meta.title || null;
    if ('label' in meta) s.label = meta.label || null;
    refreshSession(s, true);
  });

  ipcMain.handle('file:preview', (e, id, relPath, source, opts) => {
    const s = sessions.get(id);
    if (!s) return { kind: 'error', path: relPath, text: t('file.noSession') };
    return previewFile(s, relPath, source, opts || {});
  });

  ipcMain.on('open-external', (e, url) => {
    if (isExternalUrl(url)) electronShell.openExternal(url);
  });

  ipcMain.handle('history:get', (e, id) => {
    const s = sessions.get(id);
    return s ? s.history : [];
  });

  ipcMain.handle('todos:get', (e, id) => {
    const s = sessions.get(id);
    if (!s) return { key: null, todos: [] };
    return todoStore.getFor(s);
  });

  // Answers with the stored notes - they carry the ids the renderer needs to
  // find a note's row again, and a new note has none yet when it arrives here.
  ipcMain.handle('todos:set', (e, id, todos) => {
    const s = sessions.get(id);
    if (!s) return null;
    return todoStore.setFor(s, todos);
  });
}

module.exports = { registerIpc, isExternalUrl };
