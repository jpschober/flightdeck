# Flightdeck ✈️

Warp-like terminal app for working with parallel AI agents
(Electron + xterm.js + node-pty). Many machines on the deck — you give the
clearance for takeoff.

## Features

- **Multiple shell sessions in parallel**: PowerShell, PowerShell 7, Git Bash,
  CMD, WSL (Windows) or Bash/Zsh (Linux). New session via `+` (default shell)
  or `▾` (shell picker), `Ctrl+T` / `Ctrl+Shift+W`.
- **Sidebar header**: `+` / `▾` start a session, everything rarer (grid
  overview, Claude session browser, interface language) sits in the `⋯` menu —
  a permanent button each turned the header into a row of competing icons.
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
    plus a signal as soon as the current work or PR changes the schema, a
    before/after comparison and a diff-aware ER diagram (see below)
  - **Usage**: the limits of your Claude subscription against the share of the
    window that has already passed — this reads Claude Code's login and an
    undocumented endpoint (see below)
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
src/main/main.js     Electron main: the window and the wiring
src/main/sessions.js PTY sessions (node-pty), output batching, refresh pass
src/main/shells.js   shell detection and how each shell is started
src/main/shell-integration/
                     the scripts the shells run (bash/zsh/fish/PowerShell),
                     read from here and written to userData per session
src/main/osc.js      OSC parsing: cwd, busy/idle, commands
src/main/session-state.js
                     busy/idle heuristic, agent binding, input history
src/main/preview.js  file preview: diff or content, bounded and inside the root
src/main/todos.js    note persistence per repo root
src/main/ipc.js      IPC handlers
src/main/window.js   the renderer window, and sending to it
src/main/gitinfo.js  git status/branch + PR info via gh (cached)
src/main/agents/     Running agents: plugin registry ("sensor") + plugins
src/main/dbschema/   DB schema: plugin registry ("sensor"), DDL reader, diff
src/main/usage.js    limits of the Claude subscription (OAuth usage endpoint)
src/main/settings.js persisted settings (interface language, OSC 52 clipboard)
src/i18n/            interface languages: runtime, registry, one file per language
src/preload.js       contextBridge API for the renderer
src/renderer/        UI: sidebar, xterm terminals, tab panel, preview
src/renderer/dbgraph.js  DB schema as an ER diagram (dagre layout)
```

### Languages

The interface ships in English, German, French, Italian and Spanish. On first
start it follows the system language and falls back to English for anything
else; the `⋯` menu in the sidebar header switches at any time and the choice is
remembered.

```
src/i18n/runtime.js     plural forms and placeholders (used by both processes)
src/i18n/index.js       registry, current language, English as the fallback
src/i18n/locales/*.js   one file per language, flat key -> text
```

English is the source language and the fallback: a key a translation has not
filled in yet comes out English rather than blank, so an incomplete language
file degrades into a mixed interface instead of a broken one. Plural forms come
from `Intl.PluralRules`, so every language brings its own rule - French counts
zero as singular, the others do not, and none of that is hard-coded.

A string entry is either plain text or a set of plural forms:

```js
'notes.empty':    'No notes',
'session.agents': { one: '{count} agent working', other: '{count} agents working' },
```

Switching does **not** reload the window. The terminals hang off live PTYs in
the main process, and a reload would drop the whole session list - so the
visible text is replaced in place. Strings the main process builds itself
(schema warnings, comparison baselines, the shell name `Command Prompt`) are
translated there; a switch therefore clears the schema cache, because those
strings were translated when the cache was filled.

Adding a language means: copy `locales/en.js`, translate it, register it in
`LOCALES` in `src/i18n/index.js`, done.

### Shell integration

The scripts live in `src/main/shell-integration/` as the shell files they are.
Starting a session copies them into a directory under `userData` — zsh is
pointed at it via `ZDOTDIR`, the others load a single file from it — and the
shell then runs from there. PowerShell gets its script as `-EncodedCommand`.

The prompt is extended and emits:

- `OSC 7` — current directory (file:// URL), as in Warp/WezTerm/VS Code
- `OSC 133` — `C` = command started, `A`/`D` = prompt is back
- `OSC 7770;cmd` — the command line that was submitted (Base64)

The main process parses these sequences out of the PTY stream and derives from
them the directory, branch, changed files, PR (refresh 4 s, PR cache 45 s) and
the busy/idle state. For the agent TUIs one more rule applies: >2 s of silence
while a command is running = "input expected" (blue dot), because these TUIs
render continuously while working. Which command lines are agent TUIs comes
from the agent plugins (`claude`, `codex`, `aider`), see below.

The hooks are added to what your configuration installed: `PROMPT_COMMAND` and
the `DEBUG` trap in Bash keep their previous contents (starship, direnv,
bash-preexec), zsh goes through `add-zsh-hook`, fish through its events, and
PowerShell calls the `prompt` and `PSConsoleHostReadLine` it found.

Bash, Zsh, Fish, Git Bash and PowerShell get this integration. The other shells
that Flightdeck offers - CMD, WSL, Nushell, Elvish, Xonsh, Ksh, Tcsh, Dash -
are started as they are, and their sessions show no status (empty dot,
"No status available") instead of one guessed from output and silence.

A reported directory is taken over only once a check says it exists.

Git then runs in a directory nobody clicked on, which is why it is not handed
that directory's configuration: `core.fsmonitor` and `core.hooksPath` are
overridden per call, `--no-ext-diff --no-textconv` keeps the diff drivers out,
and the system configuration stays out. Filter drivers (`filter.<name>.clean`
and friends) cannot be overridden — their names are free — so before the first
git call the repository configuration is read, and if it names a program in one
of those keys, git is not started in that directory at all. The panel says so
and names the key.

`OSC 52` writes the clipboard — that is how Claude copies. Every write is shown
in the app with the number of characters, control characters other than tab and
newline are dropped and the payload is capped at 100 KB. The clipboard is still
replaced without a prompt; the report is what makes it visible before the next
paste. "Clipboard from terminal output" in the ⋯ menu switches the write off.

### Running agents

An agent that hands work off to further agents looks, from the outside, like
one that is doing nothing: the terminal sits still while four tasks run in the
background. The chip on the tab says how many there are — and the tooltip says
what they are working on.

```
src/main/agents/index.js          Sensor: asks the plugins, picks the most confident one
src/main/agents/plugins/claude.js Claude Code: detection + counting
src/main/agents/plugins/codex.js  Codex: command pattern only
src/main/agents/plugins/aider.js  Aider: command pattern only
```

**Plugins.** As with the DB schema, the sensor knows nothing about the
technology behind it — not a word about Claude, transcripts or subagent
directories. Detection *and* counting live in the plugin:

```js
{
  id, label,
  commandPattern,                                  // RegExp on the command line
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

`commandPattern` answers a second question, and for the whole app: which CLIs
are agents at all. `agents/index.js` exports `isAgentCommand(cmd)`, which asks
every plugin's pattern; the attention heuristic in `session-state.js` goes through it,
so a new plugin brings the recognition of its CLI along with the counting.
The Codex and Aider plugins consist of that pattern alone — they keep the state
detection for those CLIs, `detect()` returns `null` and they count nothing.
What is watched and what is not is written down in `test/agent-commands.test.js`.

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

The panel itself is rendered as table cards, not as an ER diagram: what matters
there are columns, types and constraints, and inside a diagram box those are
either absent or illegibly small. Above all, a diagram cannot be compared row by
row. Relationships are shown as foreign keys in plain text, including target and
`on delete` behaviour.

**ER diagram.** "Diagram" opens the other question — what hangs off what — as a
graph (`src/renderer/dbgraph.js`). It knows the diff: new tables are green,
removed ones struck through in red, changed ones amber, and new foreign keys are
drawn in colour. Two levels of detail (table names only, or with columns),
search highlights matches, a click on a box dims everything that is not its
direct neighbourhood, and the mouse wheel zooms.

"Changes + neighbours" keeps what moved plus one hop of context. Both ends of a
changed foreign key count as moved as well, so a table that is created or
dropped makes every table it references count as moved. How much is left
therefore depends on the migration. Measured against a generated schema of 80
tables and 202 foreign keys, five of which most other tables reference:

| migration | tables shown |
| --- | --- |
| columns added to three tables | 7 of 80 |
| two tables added, one dropped, two altered, all in one area | 62 of 82 |
| four added, two dropped, three altered, one of them a referenced hub | 79 of 84 |

The scope reduces sharply for column changes. Once a migration creates or drops
a table in a schema where most tables hang off a few central ones, one hop
reaches most of the schema and little is filtered out.

At that size the whole schema is not readable in one view either: with table
names only it fits the window at about 22 % zoom, with columns it runs past the
15 % zoom floor and has to be panned. Search and click focus are the way through
a schema of that size.

Opening the whole schema at that size takes around 270 ms, the reduced picture
around 25 ms. Once the picture stands, search, focus, zoom and panning stay
under 25 ms — they move a transform and toggle classes, nothing is laid out
again.

Relations use crow's foot notation, read out of the schema itself: many on the
referencing side unless its foreign key is unique, and a circle where the
foreign key may be null. Tables without any relation are set below the graph
instead of stretching it, and a foreign key pointing at a table the project does
not define (`auth.users`) gets a dashed placeholder rather than being dropped.

The layout comes from [dagre](https://github.com/dagrejs/dagre) — 48 KB of pure
layout, no rendering of its own. The boxes are ordinary DOM (they inherit theme,
fonts and the tag styles of the panel, and their text stays selectable), the
relations are one SVG layer underneath, and panning and zooming is a single
transform on the wrapper — so neither panning nor searching nor focusing ever
costs a new layout.

A re-read only happens when the fingerprint of the involved files (mtime/size)
changes — which makes the background poll every 10 s essentially free.

### Usage limits

The tab shows how much of each limit window of your Claude subscription is used
up, against the share of the window that has already passed: after three of
seven days, 42.9 % is the target, and above that the limit falls before the
window ends. The mark in the bar sits at that target. The dot on the tab
follows the tightest of all reported windows, so a limit about to fall is
visible with the tab closed.

The numbers come from `https://api.anthropic.com/api/oauth/usage`, the endpoint
behind `/usage` in Claude Code. It is undocumented and can change or disappear
without notice; the tab then shows an error instead of numbers. Which windows
appear is up to the endpoint: a window it adds shows up without a change here,
its length read out of the key name, sorted in by that length. Until it has a
translation it carries its raw key from the endpoint as its title.

Reaching the endpoint takes Claude Code's own login. Flightdeck reads the OAuth
access token from `~/.claude/.credentials.json`, on macOS from the login
keychain entry `Claude Code-credentials`, which macOS asks permission for the
first time it is read. The token stays in the main process: it does not go over
the bridge to the renderer, it appears in no error message and in no log line,
and it is sent to the endpoint above and to no other address. Without a Claude
Code login the tab says so and stays empty; nothing else in the app depends on
it.
