'use strict';
// Agent plugin for the Codex CLI - recognition only.
//
// The plugin brings its command pattern and nothing else. That covers the part
// of the app that only asks "is an agent running in this terminal?": the
// attention heuristic in main.js treats a quiet agent TUI as waiting for input,
// and it needs the pattern, not a count.
//
// detect() returns null, so this plugin never claims a terminal and read() is
// never called. Counting running agents needs a place where Codex records them,
// and nothing here reads one yet. Until then the agent panel stays empty for a
// Codex terminal, exactly as it was while `codex` sat in main.js's hardcoded
// list. Whoever adds the counting fills in detect() and read() here.

const id = 'codex';
const label = 'Codex';

// Same boundaries as the Claude plugin, see plugins/claude.js.
const commandPattern = /(^|[\s\\/"'])codex([\s"'.]|$)/i;

function detect() { return null; }
function read() { return { agents: [] }; }

module.exports = { id, label, commandPattern, detect, read };
