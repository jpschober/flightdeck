# Flightdeck ✈️

Warp-like terminal app for working with parallel AI agents. Many machines on the deck — you give the
clearance.

## Status

Flightdeck is written for one workstation first: the shells, the agent CLIs and
the project layouts its author works with. It runs elsewhere, and it is being
generalised step by step. Until then, expect defaults and detection that follow
that one setup.

> **Warning: vibe coded.** This code was written by AI agents from prompts and
> has not been reviewed line by line. It starts shells, reads your
> repositories, and reads Claude Code's files under `~/.claude`. Tests cover
> the parts whose behaviour is hard to see; everything else rests on daily use.

## What it is for

Three agents in three terminals, and the moment you look away you have lost
track: who is still working, who is waiting for an answer, and what was that
one even about. Flightdeck answers those three questions without you switching
tabs and scrolling back.

### Keeping the overview

- **Every session in one list**, each with a status at a glance: 🟡 working ·
  ⭕ waiting for a command · 🔵 the agent is waiting for **you**.
- **Subagents counted**: `✈ 3` on a tab means three agents are working
  underneath this one right now — the tooltip names what they are working on.
  A terminal that sits still is not the same as work that has stopped.
- **Where the session is**: current directory and git branch, live. Plus your
  own label and title if the directory name is not enough.
- **Grid overview**: all sessions as live tiles, click to jump into one.
- **A notification when it is your turn**, so a waiting agent does not sit
  unnoticed in a background window. Clicking it takes you to that session.

### Getting back into it quickly

An agent asks a question, and you have not looked at this session for twenty
minutes. The panel on the right follows the active session and holds what you
need to answer:

- **Git**: the pull request belonging to this branch — description, checks,
  commits, comments and reviews — and the changed files. Click a file for the
  diff or the file itself. If the agent works in a worktree, the panel says so.
- **History**: what you sent into this session — shell commands verbatim,
  prompts to agents reconstructed. Click to copy, `↩` puts it back in the
  terminal.
- **Notes**: short TODOs per project, kept across restarts.
- **Past Claude sessions of all projects**, searchable by name, first prompt
  and directory — resume one or fork it into a new terminal.

### Keeping control

- **DB schema**: the project's tables, columns, types and constraints — and a
  signal as soon as the current work or the pull request changes them. Migrations
  are the kind of change you want to have seen before it goes through, so the tab
  shows above all *what changed*: a number on the tab even when it is closed,
  before/after side by side, and an ER diagram that marks what is new, gone or
  altered. The comparison runs against the pull request, against the branch
  point, or against your last commit.
- **Usage**: how much of your Claude subscription's limits is used up, against
  the share of the limit window that has already passed — so you see a limit
  about to fall before it falls.

### Sessions and shells

Sessions start via `+` (default shell), `▾` (shell picker) or `Ctrl+T`. On
Windows: PowerShell, PowerShell 7, Git Bash, CMD and WSL; on Linux and macOS
what the system offers — Bash, Zsh, Fish, Nushell, Elvish, Xonsh, Ksh, Tcsh,
Dash. Bash, Zsh, Fish, Git Bash and PowerShell report status; the others run
as they are and show no status rather than a guessed one.

The interface ships in English, German, French, Italian and Spanish and follows
the system language on first start.

## Getting started

```
npm install
npm start
```

Requirements: Node.js 22.12 or newer and `git` on the PATH; for PR display
additionally the [GitHub CLI](https://cli.github.com/) (`gh auth login`).

Recognised today: Claude Code (status and subagent count), Codex and Aider
(status only) as agents, Supabase migrations as the schema source. Further
agents and schema sources are one plugin file each — see
[docs/plugins.md](docs/plugins.md).

## Security

**Git runs in directories nobody clicked on.** Flightdeck calls `git` in
whatever directory a session reports, which means in repositories you may only
have cloned. It is therefore not handed that repository's configuration:
`core.fsmonitor` and `core.hooksPath` are overridden per call,
`--no-ext-diff --no-textconv` keeps the diff drivers out, and the system
configuration stays out. Filter drivers (`filter.<name>.clean` and friends)
cannot be overridden, because their names are free — so the repository
configuration is read before the first git call, and if it names a program in
one of those keys, git is not started in that directory at all. The panel says
so and names the key.

**Terminal output can write your clipboard** (`OSC 52` — that is how Claude
copies). Every write is shown in the app with the number of characters, control
characters other than tab and newline are dropped, and the payload is capped at
100 KB. The clipboard is still replaced without a prompt; the report is what
makes it visible before your next paste. "Clipboard from terminal output" in the
⋯ menu switches the write off.

**The usage tab reads Claude Code's login.** The OAuth access token comes from
`~/.claude/.credentials.json`, on macOS from the login keychain entry
`Claude Code-credentials`, which macOS asks permission for the first time it is
read. The token stays in the main process: it does not go over the bridge to the
renderer, it appears in no error message and in no log line, and it is sent to
`https://api.anthropic.com/api/oauth/usage` and to no other address. That
endpoint is the one behind `/usage` in Claude Code, undocumented, and can change
or disappear without notice — the tab then shows an error instead of numbers.
Without a Claude Code login the tab says so and stays empty; nothing else in the
app depends on it.

**File preview stays inside the project root**, and reading Claude Code's
session files is read-only — Flightdeck never writes under `~/.claude`.
