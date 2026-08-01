# Flightdeck ✈️

Warp-like terminal app for working with parallel AI agents
(Electron + xterm.js + node-pty). Many machines on the deck — you give the
clearance for takeoff.

## Features

- **Multiple shell sessions in parallel**: PowerShell, PowerShell 7, Git Bash,
  CMD, WSL (Windows) or Bash/Zsh (Linux). New session via `+` (default shell)
  or `▾` (shell picker), `Ctrl+T` / `Ctrl+Shift+W`.
- **Session list on the left** – every tab shows:
  - **Status**: 🟡 working · ⭕ waiting for a command · 🔵 agent (e.g. Claude
    Code) is waiting for *your* input — you see at a glance who needs you
  - **running agents**: `✈ 3` when three subagents are working in this session
    right now — the tooltip names their tasks (see below)
  - current directory (live via shell integration / OSC 7) and git branch
  - optional manual **label** (chip) and optional manual **title**
    → double-click/right-click the tab to open the edit popover
- **Context panel on the right** with tabs (follows the active session):
  - **Git**: the associated pull request (via the `gh` CLI) + changed files;
    clicking a file opens the diff/file preview, `Esc` closes it
  - **History**: your input in this session — shell commands verbatim, prompts
    to agents reconstructed; click to copy, `↩` inserts into the terminal
  - **Notes**: short TODOs per project (repo root), persisted across restarts;
    badges show open notes and new history entries
  - **DB schema**: the project's tables, columns, types and constraints —
    plus a signal as soon as the current work or PR changes the schema
    (see below)
- Panels are resizable via the dividers.

## Getting started

```
npm install
npm start
```

Requirements: `git` on the PATH; for PR display additionally the
[GitHub CLI](https://cli.github.com/) (`gh auth login`).

## Architecture

```
src/main/main.js     Electron main: PTY sessions (node-pty), shell detection,
                     OSC parsing (cwd, busy/idle, commands), history,
                     note persistence, IPC
src/main/gitinfo.js  git status/branch + PR info via gh (cached)
src/main/agents/     Running agents: plugin registry ("sensor") + plugins
src/main/dbschema/   DB schema: plugin registry ("sensor"), DDL reader, diff
src/preload.js       contextBridge API for the renderer
src/renderer/        UI: sidebar, xterm terminals, tab panel, preview
```

### Shell integration

When the shell starts, its prompt is extended (PowerShell via
`-EncodedCommand`, Bash via an rc file) and emits:

- `OSC 7` — current directory (file:// URL), as in Warp/WezTerm/VS Code
- `OSC 133` — `C` = command started, `A`/`D` = prompt is back
- `OSC 7770;cmd` — the command line that was submitted (Base64)

The main process parses these sequences out of the PTY stream and derives from
them the directory, branch, changed files, PR (refresh 4 s, PR cache 45 s) and
the busy/idle state. For the agent TUIs we watch (`claude`, `codex`, `aider`)
one more rule applies: >2 s of silence while a command is running = "input
expected" (blue dot), because these TUIs render continuously while working.

### Running agents

An agent that hands work off to further agents looks, from the outside, like
one that is doing nothing: the terminal sits still while four tasks run in the
background. The chip on the tab says how many there are — and the tooltip says
what they are working on.

```
src/main/agents/index.js          Sensor: asks the plugins, picks the most confident one
src/main/agents/plugins/claude.js Claude Code: detection + counting
```

**Plugins.** As with the DB schema, the sensor knows nothing about the
technology behind it — not a word about Claude, transcripts or subagent
directories. Detection *and* counting live in the plugin:

```js
{
  id, label,
  detect(ctx) -> { confidence, evidence[] } | null,
  read(ctx)   -> { agents: [...] },
}
```

`ctx` is whatever the shell observation can tell about the terminal: directory,
running command, bound session. Which of those a plugin needs is its own
business — the Claude plugin recognises itself by the bound session, a plugin
for a different agent CLI could go by the command. If a plugin claims
responsibility, it also delivers the count. Adding another one means: create a
file under `plugins/`, register it in `PLUGINS`, done.

**Claude plugin.** Claude Code stores every subagent of a session as its own
pair under `~/.claude/projects/<project>/<session>/subagents/`:
`agent-<id>.jsonl` (the transcript) and `agent-<id>.meta.json` (task, type,
worktree). There is no status field in there — "still working" follows from
three signals, and only together are they reliable:

- **Start** — the `meta.json` is created when the agent is dispatched; its
  mtime is the start time.
- **Stop** — a `<task-notification>` in the transcript of the caller. The
  `tool_result` of the agent call is no good for this: agents run
  asynchronously, it only reports "launched successfully" and is already there
  seconds after the start.
- **Resume** — a `SendMessage` to the same agent; afterwards it is working
  again, and the previous completion message is spent.

Plus a safety net: anything that has not written for 15 minutes counts as
orphaned. Without that, an agent would stay at "working" forever if Claude
crashes and the completion message never arrives.

Transcripts only ever grow at the end, so the plugin remembers a read offset
per file: the first pass costs the whole file once, every further pass only the
new remainder. That makes the check every 4 s essentially free.

All of this is undocumented internal format. If Claude Code changes it, nothing
breaks: the plugin simply finds no agents and the chip disappears instead of
becoming wrong.

### DB schema

An agent that writes a migration changes the data model — and that is the kind
of change you want to have seen before it goes through. The tab therefore shows
not just the schema, but above all **what has changed about it**.

```
src/main/dbschema/index.js       Sensor: asks the plugins, caches, picks the baseline
src/main/dbschema/files.js       File access: working tree or git state
src/main/dbschema/sql-ddl.js     Postgres DDL reader (replays migrations)
src/main/dbschema/ir.js          the standardised schema format
src/main/dbschema/diff.js        structural comparison of two states
src/main/dbschema/plugins/       one plugin per technology (currently: supabase.js)
```

**Plugins.** The sensor knows nothing about Supabase, Drizzle or SQL. It only
knows this interface — detection *and* reading live entirely in the plugin:

```js
{
  id, label,
  detect(provider) -> { confidence, evidence[], watch[] } | null,
  read(provider)   -> IR,
}
```

For the active working directory the sensor asks every plugin whether it feels
responsible; the most confident one wins and returns the schema in the
standardised format. Adding another plugin means: create a file under
`plugins/`, register it in `PLUGINS`, done.

`provider` abstracts file access (`exists` / `read` / `list` / `stamp`) so a
plugin can read the same schema from the working directory **and** from a git
commit — without that there would be no "before".

**Supabase plugin.** Detection via `supabase/config.toml` or
`supabase/migrations/`; reading happens by replaying the migrations in name
order (`CREATE`/`ALTER`/`DROP TABLE`, enums, indexes, RLS policies,
`COMMENT ON`). The migrations are the source of truth in the repo — unlike a
running database they are always there, and they live in git.

**Diff.** The comparison is structural, not character-based: tables, columns
(type, NULL, default, identity, generated, comment), constraints, indexes,
enum values and RLS policies. A character diff would be worth little here —
reordered columns create noise, and what actually happened is not visible. The
baseline is selectable:

- **PR baseline** — all changes of the pull request (merge base with the target
  branch)
- **Branch point from main** — all changes of this branch
- **HEAD** — only what has not been committed yet

If there are changes, a number appears on the tab (even when it is closed) and
a notice in the panel. "Compare" opens **before/after side by side**: the old
state on the left, the new one on the right, row-aligned — identical columns
sit at the same height, missing ones show as `—`.

It is rendered as table cards, not as an ER diagram: what matters are columns,
types and constraints, and inside a diagram box those are either absent or
illegibly small. Above all, a diagram cannot be compared row by row.
Relationships are shown as foreign keys in plain text, including target and
`on delete` behaviour.

A re-read only happens when the fingerprint of the involved files (mtime/size)
changes — which makes the background poll every 10 s essentially free.
