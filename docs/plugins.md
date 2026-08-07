# Plugins

Two things in the panel depend on the technology in front of them: which agent
CLI runs in a terminal, and how a project describes its database schema. Both
go through plugins, so support for a further agent or a further schema source
is one file plus one line in a list — the sensors, the IPC and the UI stay
untouched. This is also the path along which the app is generalised: what used
to be written for one setup is now the coverage of its plugins.

Both registries detect the same way (`src/main/plugin-registry.js`): every
plugin says whether it feels responsible and how sure it is, the most confident
one wins, and a plugin that throws is skipped instead of taking the run down.

| Area | Plugin | What it covers |
| --- | --- | --- |
| Agents | Claude Code | recognises itself by the bound session; counts running subagents and names their tasks |
| Agents | Codex | command pattern only — keeps the busy/attention detection, counts nothing |
| Agents | Aider | command pattern only |
| DB schema | Supabase | detects `supabase/config.toml` or `supabase/migrations/`, reads the schema by replaying the Postgres migrations |

An agent plugin brings two things: the pattern that says its CLI is an agent at
all — that is what the "input expected" heuristic runs on — and, if it wants,
the count of what runs underneath it. A schema plugin brings detection plus a
reader that returns the standardised schema format; it reads through a file
provider, so the same plugin also delivers the state of a git commit, which is
what the before/after comparison compares against.

Not there yet: Drizzle, Prisma and plain SQL migration folders as schema
sources, and any database other than Postgres. Each of them fits the existing
interface described below.

## Agent plugins

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

As with the DB schema, the sensor knows nothing about the technology behind it
— not a word about Claude, transcripts or subagent directories. Detection *and*
counting live in the plugin:

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
every plugin's pattern; the attention heuristic in `session-state.js` goes
through it, so a new plugin brings the recognition of its CLI along with the
counting. The Codex and Aider plugins consist of that pattern alone — they keep
the state detection for those CLIs, `detect()` returns `null` and they count
nothing. What is watched and what is not is written down in
`test/agent-commands.test.js`.

### Claude plugin

Claude Code stores every subagent of a session as its own pair under
`~/.claude/projects/<project>/<session>/subagents/`: `agent-<id>.jsonl` (the
transcript) and `agent-<id>.meta.json` (task, type, worktree). There is no
status field in there — "still working" follows from three signals, and only
together are they reliable:

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

## DB schema plugins

An agent that writes a migration changes the data model — and that is the kind
of change you want to have seen before it goes through. The tab therefore shows
not just the schema, but above all what has changed about it.

```
src/main/dbschema/index.js       Sensor: asks the plugins, caches, picks the baseline
src/main/dbschema/files.js       File access: working tree or git state
src/main/dbschema/sql-ddl.js     Postgres DDL reader (replays migrations)
src/main/dbschema/ir.js          the standardised schema format
src/main/dbschema/diff.js        structural comparison of two states
src/main/dbschema/plugins/       one plugin per technology (currently: supabase.js)
```

The sensor knows nothing about Supabase, Drizzle or SQL. It only knows this
interface — detection *and* reading live entirely in the plugin:

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

A re-read only happens when the fingerprint of the involved files (mtime/size)
changes — which makes the background poll every 10 s essentially free.

### Supabase plugin

Detection via `supabase/config.toml` or `supabase/migrations/`; reading happens
by replaying the migrations in name order (`CREATE`/`ALTER`/`DROP TABLE`, enums,
indexes, RLS policies, `COMMENT ON`). The migrations are the source of truth in
the repo — unlike a running database they are always there, and they live in
git.

### What the diff does with it

The comparison is structural, not character-based: tables, columns (type, NULL,
default, identity, generated, comment), constraints, indexes, enum values and
RLS policies. A character diff would be worth little here — reordered columns
create noise, and what actually happened is not visible. A plugin therefore has
to fill the IR properly; whatever it leaves out cannot show up as a change.

The baseline is selectable: the pull request (merge base with the target
branch), the branch point from main, or HEAD — the last one showing only what
has not been committed yet.
