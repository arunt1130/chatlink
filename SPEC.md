# Shared Chat Memory — Build Spec

2026-11-12 · Arun · v2: local MCP server + GitHub transport

This spec describes a local MCP server that lets two or more people's Claude Desktop chats share one memory, synced through a private GitHub repo. It is written to be pasted into a Claude Code session, which makes the implementation decisions.

## Instructions for the implementing Claude Code session

Read this whole spec before writing code. Then plan, get approval, and build one milestone at a time with tests.

1. Save this spec in the repo as `SPEC.md` and treat it as the source of truth. If a decision changes it, update it in the same commit.
2. Start in plan mode. Propose a plan for milestones M0 and M1 only, list your questions, and wait for approval before coding.
3. Lines marked **MUST** are fixed requirements. Everything else is your call. Record each significant choice and the reason in `DECISIONS.md`.
4. Pick the language: Python or TypeScript. Both can be packaged as a Claude Desktop extension (`.mcpb`). Prefer whichever gives the smallest, simplest bundle, and justify the pick.
5. Finish each milestone's acceptance tests before starting the next. Commit at the end of each milestone.
6. Prefer boring, well-known choices and few dependencies. Do not build anything listed under Out of scope.

## What we are building

Each person keeps chatting in their own Claude Desktop, and each chat can see what the other people have said. The motivating example: Arun suggests an idea, and his chat replies "Krish already closed this on Nov 3 because of X," quoting Krish's own words.

It is not specific to coding. It is for any ongoing set of ideas two or more people develop with Claude in parallel.

**Working name:** `chatlink` (placeholder; rename freely).

**Core principle: store what was said, interpret when reading.** Every shared message is logged verbatim with who said it and when. Nothing is summarized at write time, so nothing can be misattributed. Claude interprets the raw record at read time and always shows the source.

## Architecture

Three parts. A local MCP server runs on each person's machine. A private GitHub repo moves events between people. A local search index on each machine makes retrieval fast.

1. **Local MCP server.** Launched by Claude Desktop, installed as a `.mcpb` bundle (a one-click Claude Desktop extension). It exposes the tools Claude calls, reads and writes the shared log, and keeps the local index current.
2. **Shared repo (transport).** A normal private GitHub repo that every member has cloned locally. It holds only raw event logs. The server syncs it with ordinary `git pull` and `git push`, using each person's existing git credentials.
3. **Local index.** A SQLite file with keyword search and vector search (search by meaning), built from the logs. It is derived data and can be rebuilt from the logs at any time.

There is no hosted server, no API key, and no database anyone else has to run. Claude Desktop uses each person's own Claude subscription.

## What lives where (MUST)

The shared repo holds only what other people need and cannot recompute. Everything derived, personal, or rebuildable stays on the local machine. The test for anything new: if my laptop died, would the others need this? If yes, it is an event in the shared log. If no, it stays local.

```
Shared repo (GitHub)               Local (each machine)
space.json                         the MCP server program
logs/arun/2026-11-12.jsonl         config: my name, path to my repo clone
logs/krish/2026-11-12.jsonl        index.sqlite (keyword + vector search)
.gitignore                         embedding model files
                                   read cursors (what I have already seen)
                                   queue of unpushed commits
```

| | Shared repo | Local |
| --- | --- | --- |
| Contents | Raw events: messages, status changes, notes, imports | Index, embeddings, cursors, config |
| Who writes | Each person writes **only** their own `logs/<name>/` folder (MUST) | Only the local user |
| If deleted | Shared history is gone; GitHub history is the backup | Nothing is lost; rebuild from the repo |
| Format | JSON Lines: one JSON object per line, UTF-8 | Implementer's choice |

MUST: the index, embeddings, and any other derived file are never committed. `.gitignore` allows only `logs/` and `space.json`.

`space.json` lists members and display names. It is written once at setup and changes rarely.

## Event format

Everything shared is an immutable event: one JSON object per line, appended to the author's file for that day. Events are never edited or deleted. A change of mind is a new event.

MUST:

- One file per author per day: `logs/<author>/YYYY-MM-DD.jsonl` (UTC date).
- Every event has a globally unique, roughly time-sortable `id` (a ULID or UUIDv7), plus `v` (schema version), `author`, `ts` (UTC, ISO 8601) and `kind`.
- Readers tolerate a truncated or malformed last line: skip it, don't crash.
- Ingest is idempotent by `id`. Seeing the same event twice changes nothing.

Event kinds:

| `kind` | What it records | Key fields |
| --- | --- | --- |
| `message` | A human's message, verbatim | `text` |
| `status` | A person marking something decided, closed, reopened, or superseded | `target` (an event id), `status`, `reason` |
| `note` | Something a person explicitly asked to add to the shared memory | `text` |
| `assistant_note` | An optional short summary of a Claude reply, clearly marked as model-written | `text`, `about` (event id) |
| `import` | A message brought in from an older chat (see Importing an existing chat) | `text`, `original_ts` if known, `role` |

Example:

```json
{"v":1,"id":"01JCXK2M9Q4E7R8T","author":"krish","ts":"2026-11-03T21:14:05Z","kind":"message","text":"Caching won't help here: every query has a unique timestamp in it."}
{"v":1,"id":"01JCXK7B3W1N2P5S","author":"krish","ts":"2026-11-03T21:16:40Z","kind":"status","target":"01JCXK2M9Q4E7R8T","status":"closed","reason":"caching idea rejected"}
```

**Trust tiers.** Retrieved items carry a tier so Claude never overstates them:

1. **confirmed**: a person explicitly marked it (`status` or `note`).
2. **said**: a verbatim `message`.
3. **imported**: came from an older chat via import.
4. **model-written**: an `assistant_note`. Lowest trust; never presented as anyone's position.

When several `status` events target the same item, the latest by `ts` wins, with ties broken by `id`.

## Sync protocol

Git does the transport. Because each person writes only their own files, merges can never conflict, and a rejected push always succeeds after a pull.

MUST:

- **Pull before reading.** At the start of each `sync_turn`, run `git pull --rebase` with a short timeout. If it fails or times out (offline), continue with local data and report the result as stale.
- **Commit once per turn.** Append this turn's events, then make one commit.
- **Push without blocking the reply.** Push in the background. On a non-fast-forward rejection, pull and retry with a bounded number of attempts. If still failing (offline), keep the commit queued and retry on the next turn.
- **Never lose an event.** An event is durable once it is written to the local clone. Pushing is only delivery.
- **Never touch other people's folders.** Refuse any write outside `logs/<me>/`.
- **Use the user's existing git setup.** Use the git command line and whatever credentials the user already has. No tokens are stored by this program.

Report sync state in every `sync_turn` result: time of the last successful pull, whether results may be stale, and the number of unpushed commits.

## Local index

A single local SQLite file holds keyword search, vector search, and ingest bookkeeping. It is fully derived from the logs.

- **Keyword search:** SQLite's built-in full-text search (FTS5).
- **Vector search:** embeddings from a small local embedding model, stored with a SQLite vector extension such as `sqlite-vec` ([repo](https://github.com/asg017/sqlite-vec); note it is pre-v1). No embedding API.
- **Incremental ingest:** after each pull, ingest only new events.
- **Rebuild:** a command that deletes the index and rebuilds it from the logs. Its result must match incremental ingest.
- **Ranking:** combine keyword and vector scores, weight by recency, and boost confirmed items. Exact weights are the implementer's call; make them tunable in one place.

If a local embedding model makes the bundle too heavy or slow to install, ship keyword search plus recency first (M2a) and add vectors second (M2b).

## MCP tools and prompt

`sync_turn` is the core of the system: one call per turn both logs the user's message and returns relevant shared context. Because the call gets Claude useful context, it is the call Claude is most likely to make reliably.

MCP tools are called at the model's discretion, so no tool can be guaranteed to run. Tool descriptions and project instructions (see Behaviour rules) push Claude toward calling `sync_turn` every turn. The design must degrade gracefully when a turn is missed: a missed turn means one unlogged message, not corrupted state.

| Tool | Inputs | Returns |
| --- | --- | --- |
| `sync_turn` | `message` (the user's message, verbatim), `share` (default true) | Relevant past items, the "new from others" digest, sync state, and any items in this message that look like decisions (see below) |
| `search` | `query`, optional `author`, `since`, `limit` | Ranked items |
| `whats_new` | none | Everything from others since my read cursor, then advances the cursor |
| `mark_status` | `target` (event id), `status`, `reason` | The new `status` event |
| `add_note` | `text` | The new `note` event |

Every returned item includes `id`, `author`, `ts`, `kind`, `tier`, and the verbatim `text` (truncated if long, with the id for fetching more).

Also ship one MCP **prompt**, `catch_me_up`: a user-triggered command that calls `whats_new` and presents the digest. Because the user triggers it, the digest is always one click away even when Claude forgets to sync.

The tool description for `sync_turn` MUST tell Claude to call it at the start of every reply, before answering, passing the user's message verbatim.

**Decision detection.** `sync_turn` may flag that the current message looks like it decides or closes something. Claude then asks in one line, for example: "Mark 'drop caching' as closed?" A yes becomes a `mark_status` call. A simple heuristic is fine for v1.

## Behaviour rules for Claude

Ship this as a template users paste into a Claude Desktop Project's instructions. It is the main lever for reliable behaviour.

```markdown
Shared memory rules:
- At the start of every reply, call sync_turn with my message copied verbatim, before you answer.
- When something from another person is relevant, name them, give the date, and quote their own words.
- Be exact about trust: "Krish marked this closed" is different from "Krish said something related". Never present a plain message or a model-written note as someone's decision.
- If sync_turn flags a possible decision, ask me in one line whether to mark it.
- If I say "off the record", call sync_turn with share=false for that message.
- If sync state says results may be stale, mention it once.
```

**Privacy.** `share=false` means the message is not written to the shared log at all. Nothing else is needed for v1.

## Setup flow

Setup should take a few minutes for someone who already uses git.

1. One person creates a private GitHub repo and adds the others as collaborators.
2. Each person clones it to their machine.
3. Each person installs the `.mcpb` in Claude Desktop. The install dialog asks for two settings: their name (their folder under `logs/`) and the path to their clone. MCPB bundles support user-supplied configuration ([MCPB repo](https://github.com/modelcontextprotocol/mcpb)).
4. On first run, the server creates `logs/<name>/`, `.gitignore`, and `space.json` if missing, then builds the index.
5. Each person creates a Claude Desktop Project and pastes the Behaviour rules template into its instructions.

During development (before M4), register the server manually in Claude Desktop's config file instead of using the bundle.

## Importing an existing chat

A one-off command imports an older conversation, such as Krish's weeks-long chat, so the shared memory starts with its history.

- **Input:** a transcript as a text or JSON file, plus the author name.
- **Processing:** split it into turns. The author's turns become `import` events with `role: human`. Claude's turns are either skipped or imported with `role: assistant` (configurable, default skip). Keep original timestamps if the transcript has them.
- **Never summarize.** Import verbatim. Summaries are the model-written tier and are not part of import.
- **Safe to re-run.** Re-running the same transcript must not duplicate events. Derive ids deterministically from content and position.

## Milestones and acceptance tests

Build in this order. Each milestone ends with its tests passing and a commit. Tests for M1 onward simulate multiple users on one machine: a local bare git repo stands in for GitHub, and two clones in temporary folders stand in for two people. No network needed.

| Milestone | Scope | Done when |
| --- | --- | --- |
| M0 Event log | Event schema, append writer, tolerant reader, ingest by id | Round trip works; a truncated last line is skipped; ingesting a log twice changes nothing; merging two logs equals their union |
| M1 Git transport | Pull, commit, background push, retry on rejection, offline queue | Two simulated users write and push at the same moment and both succeed with no lost events; offline writes are delivered once back online; writes outside `logs/<me>/` are refused |
| M2a Keyword index | FTS5 index, incremental ingest, recency ranking, rebuild command | Rebuild equals incremental ingest; newer items outrank older equal matches |
| M2b Vector index | Local embeddings, hybrid ranking, confirmed boost | A paraphrase finds the original ("should we cache results" finds "caching won't help here") |
| M3 MCP server | All tools and the `catch_me_up` prompt over stdio | End-to-end in Claude Desktop with two server entries pointed at two clones: Krish says caching won't help; Arun asks about caching; Claude names Krish, gives the date, and quotes him |
| M4 Ship it | `.mcpb` bundle, first-run setup, Project instructions template, import command | A fresh machine goes from download to a working shared chat by following only the README |
| M5 Dogfood | Arun and Krish use it for real for one week | A written list of what broke and what was missing, fed back into this spec |

## Non-functional requirements

1. **Never lose an event.** Durability beats speed everywhere.
2. **Fast enough to ignore.** Aim for `sync_turn` to return in about two seconds or less on a normal connection. This is a target, not a measurement. Measure it in M3.
3. **Works offline, degraded.** Without a network, search local data, queue pushes, and say results may be stale.
4. **No services to run.** The only network traffic is git talking to the user's own remote.
5. **Small install.** Keep the bundle and its dependencies as small as practical. The embedding model will dominate; pick a small one.
6. **Boring to debug.** Logs are human-readable JSON Lines that anyone can open in a text editor.

## Out of scope for this version

- Any hosted server, or claude.ai web and mobile support (local MCP servers only work in Claude Desktop).
- Automating the claude.ai website through the page itself. It breaks Anthropic's Consumer Terms on automated access, and is not needed.
- Encryption of the logs.
- A Google Drive transport. Planned next, so keep the transport behind a small interface ("append my events", "fetch everyone's new events") that a Drive version can implement.
- Direct sync over Tailscale, a custom chat frontend, and task-claiming between coding agents.

## Open questions for the implementing session to raise

- [ ] Python or TypeScript, given bundle size and embedding-model options?
- [ ] Which local embedding model, and how big is the resulting bundle?
- [ ] Should Claude's replies be logged as `assistant_note` by default, or not at all?
- [ ] How is `sync_turn` latency split between pull, search, and commit, and does pull need a cache window (skip pulling if pulled a few seconds ago)?

## References

- [MCP Bundles (.mcpb) specification and tooling](https://github.com/modelcontextprotocol/mcpb)
- [Anthropic: Desktop Extensions announcement](https://www.anthropic.com/engineering/desktop-extensions)
- [MCP specification: transports](https://modelcontextprotocol.io/specification/latest/basic/transports)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
