# Plan: chatlink M0 (event log) + M1 (git transport)

## Context
Repo is set up (`b5e8acc Repo setup`: SPEC.md, CLAUDE.md, DECISIONS.md, spec-reviewer agent, .gitignore). No code exists. This plan covers only M0 and M1 from SPEC.md, plus the language choice. Approved 2026-11-12 with every question default accepted (see DECISIONS.md).

Machine: Node 22.13, npm 11, Python 3.12, git 2.47 (Windows, `core.autocrlf=true`).

## 1. Language: TypeScript (Node)

| Factor | TypeScript | Python |
| --- | --- | --- |
| MCPB packaging | `server.type: "node"`; Claude Desktop ships its own Node runtime, so users install nothing. The best-supported, most-documented path. | `python` type needs the user to have a compatible Python, or the newer `uv` type. Compiled deps (numpy, onnxruntime) must be vendored per platform. |
| Bundle size (M0–M3 code) | esbuild to one JS file, roughly 100s of KB. **No runtime deps in M0/M1.** | Small too, but the vendored `lib/` grows quickly. |
| SQLite + FTS5 | `better-sqlite3` (prebuilt binaries, FTS5 included) or Node's built-in `node:sqlite` if Desktop's Node is new enough. Decide in M2a. | stdlib `sqlite3`. A plus for Python, but `enable_load_extension` is turned off in some builds (macOS system Python, some others), which blocks sqlite-vec. |
| sqlite-vec | npm `sqlite-vec` ships per-platform prebuilt extensions and documents `loadExtension` with better-sqlite3. | `pip install sqlite-vec` works the same way, if extension loading is allowed. |
| Local embeddings | Option A: **model2vec static embeddings** (e.g. `potion-base-8M`, ~30 MB). Embedding is a tokenizer plus a table lookup and mean pool, so pure JS works with no onnxruntime. Option B: transformers.js + ONNX MiniLM (~23 MB quantized model, but onnxruntime-node is heavy). | fastembed/onnxruntime (~15–20 MB wheel per platform) + MiniLM. A more mature ecosystem. |

**Pick: TypeScript.** It has the simplest install story (no user Python), M0/M1 have zero runtime deps, and model2vec keeps the embedding path free of onnxruntime. The embedding model will be the largest part of the bundle either way. Risk: model2vec quality on paraphrases has to be checked against the M2b test. Fallback is transformers.js. I'll record this in DECISIONS.md and verify it at M2b.

Tooling (dev only, not shipped): `typescript`, `vitest`, `esbuild`, `@types/node`. Git is driven through `child_process.execFile`, not a git library (fits "boring, use the user's git").

## 2. Module layout
```
src/
  events/
    schema.ts     Event types, validateEvent(), makeEvent(), AUTHOR_RE
    ulid.ts       monotonic ULID (crypto.randomBytes, ~40 lines, no dep)
    paths.ts      logFileFor(root, author, ts), assertInsideMyDir() (realpath + prefix check)
    writer.ts     appendEvents(root, me, events): fixes a missing trailing \n, appends, fsyncs
    reader.ts     readLogFile() / readAllLogs(root): tolerant, returns {events, skipped[]}
    store.ts      EventStore interface + MemoryStore (M0). ingest() is idempotent by id; resolveStatus()
  transport/
    types.ts      Transport { appendMine(events), fetchNew(): {events, sync} , syncState() }
    gitcli.ts     runGit(args, {cwd, timeoutMs}): GIT_TERMINAL_PROMPT=0, kills the process tree on timeout
    git.ts        GitTransport: recoverDirty, pull, commitTurn, background push queue, retry
    state.ts      local sync state JSON (lastPullAt, lastPushAt, lastError) in a local state dir, never in the repo
  config.ts       { me, repoPath, stateDir, pullTimeoutMs, pushRetries }
tests/
  helpers/gitFixture.ts   bare remote + two clones
  m0/*.test.ts  m1/*.test.ts
```
The Drive transport (out of scope) would later implement `Transport`. `MemoryStore` is replaced or joined by a SQLite store in M2a behind the same `EventStore` interface.

## 3. Event schema in code
```ts
export const SCHEMA_VERSION = 1;
type Base = { v: 1; id: string; author: string; ts: string };   // ts = new Date().toISOString(), UTC
export type Event =
  | Base & { kind: "message"; text: string }
  | Base & { kind: "status"; target: string; status: "decided"|"closed"|"reopened"|"superseded"; reason: string }
  | Base & { kind: "note"; text: string }
  | Base & { kind: "assistant_note"; text: string; about: string }
  | Base & { kind: "import"; text: string; role: "human"|"assistant"; original_ts?: string };
export type Tier = "confirmed" | "said" | "imported" | "model-written";
```
- `id`: 26-char ULID, monotonic within one process. (The SPEC example's 16-char ids are just illustrative.)
- `author` must match `^[a-z0-9][a-z0-9_-]{0,31}$`. This blocks `..`, slashes, and case tricks on case-insensitive filesystems.
- File: `logs/<author>/<ts.slice(0,10)>.jsonl`. The day comes from the event's own `ts`.
- Validation: `v`, `id`, `author`, `ts`, `kind` are required. Unknown extra fields are kept (forward-compatible). Unknown `kind` is read and ingested but has no tier (forward-compatible, not a crash).
- Reader: splits on `\n`, strips a trailing `\r`, strips a BOM, and skips malformed lines with a reason (see Q3). Invalid UTF-8 counts as malformed.
- Writer: if the file is non-empty and doesn't end with `\n` (a crash left a partial line), it writes `\n` first so the new event is never glued onto garbage. Then it appends and calls `fsync`.
- `resolveStatus(targetId)`: latest by `ts`, ties broken by `id`.

## 4. M1 sync behaviour (GitTransport)
One `sync_turn` cycle (M3 calls these pieces in order):
1. **Recover:** if `logs/<me>/` has uncommitted changes (a crash after write and before commit), commit them first. Never lose an event.
2. **Pull:** `git pull --rebase` with a timeout (default 3 s). On failure or timeout, `stale=true`. On success, update `lastPullAt`.
3. **Append + commit once:** `appendEvents`, `git add -- logs/<me>`, then a guard: `git diff --cached --name-only` must only contain paths under `logs/<me>/`, otherwise refuse and unstage. One commit: `chatlink: <me> +N events`.
4. **Push in background:** single-flight promise that is not awaited by the caller. If a push is already running, set a "push again" flag. On non-fast-forward: pull --rebase, retry, up to 3 attempts with short backoff. On failure the commit stays local. **The offline queue is the unpushed git commits themselves**, so there's no separate queue file that could drift.
5. **Sync state:** `{lastPullAt, stale, unpushed}` where `unpushed = git rev-list --count @{u}..HEAD`.

All git calls go through an in-process mutex, so pull, commit and push never overlap in one clone. Assumption: one server process per clone (see Q7).

## 5. Two-clone test harness (`tests/helpers/gitFixture.ts`)
- `mkdtemp` → `remote.git` (`git init --bare -b main`) → seed clone writes `space.json` + shared `.gitignore` + `.gitattributes`, commits, pushes → clones `arun/` and `krish/`.
- Hermetic git: `GIT_CONFIG_GLOBAL=<empty tmp file>`, `GIT_CONFIG_NOSYSTEM=1`, per-repo `user.name/email`, `commit.gpgsign=false`, `core.autocrlf=false` (plus one test with `true`, matching this machine). The remote is a file path, so there's no network.
- `goOffline(clone)` / `goOnline(clone)`: `git remote set-url origin <missing path>` and back. Fails fast and is deterministic.
- Timeout path: unit test with `runGit` pointed at a command that hangs, to check the kill works and the result is stale.
- Teardown removes temp dirs (with retry on Windows for file locks).

## 6. Acceptance tests
**M0** (`tests/m0/`)
- round trip: one event of each kind written then read back deep-equal; files land at the right per-author, per-day path.
- truncated last line: chop bytes off the last line → reader returns the earlier events and reports 1 skipped; a new append after that is readable.
- idempotent ingest: ingest the same log twice → second pass reports added=0, store unchanged.
- merge = union: logs A and B with overlap; A then B, B then A, and both at once all give the same id set.
- status resolution: latest `ts` wins; equal `ts` → higher `id` wins.
- validation: bad author, missing fields, CRLF/BOM lines.

**M1** (`tests/m1/`)
- concurrent push: arun and krish each append + commit, then `Promise.all` push. Both succeed, the remote has all events, and each clone after pull reads the union. Looped 20× for races, plus one deterministic forced rejection (krish pushes first, arun's push is stale) to make sure the retry path runs.
- offline queue: go offline, three turns → `stale=true`, `unpushed=3`, events readable locally. A new `GitTransport` instance (simulated restart) goes online → next turn delivers everything, `unpushed=0`, krish sees all events.
- crash recovery: write without commit → next cycle commits it.
- write boundary: author `../krish`, absolute paths, another author's name, a dirty file in `logs/krish/` (never staged), symlink out of `logs/arun/` (skipped if Windows lacks symlink permission). All refused.
- derived files never committed: index or state files placed in the clone are never staged.

## 7. Delivery
- Branch `m0-event-log` → tests pass → spec-reviewer → fixes → commit → merge to main. Same for `m1-git-transport`.
- Fill in CLAUDE.md Commands (`npm ci`, `npm test`, `npm run typecheck`). Add DECISIONS.md entries for language, ULID, test runner, offline queue = git commits, tolerant-reader policy, and the Q2 outcome. If Q2 = yes, update SPEC.md in the same commit.

## Verification
`npm test` runs the M0 and M1 suites offline (temp dirs, file-path remote). Then the spec-reviewer agent runs per milestone and returns a READY verdict.

## Resolved questions (default in brackets was accepted for every one)
1. **Language:** OK with TypeScript? [yes]
2. **`.gitattributes` in the shared repo** (`*.jsonl text eol=lf`): stops `autocrlf=true` (which you have) from changing line endings. SPEC says the shared repo has only `logs/`, `space.json`, `.gitignore`. Add it and update SPEC? [yes; the reader tolerates CRLF regardless]
3. **Malformed lines in the middle of a file** (not just the last line): skip with a warning and count, or treat as an error? [skip + report count; never crash]
4. **Pull timeout / retries:** 3 s pull timeout, 3 push attempts? Cache window (skip the pull if one ran in the last N seconds) is deferred to M3 measurement. [yes]
5. **Shared-repo clone location:** your code repo is under OneDrive. A git clone inside OneDrive can corrupt `.git` or hit file locks. Will the shared clone live outside OneDrive (e.g. `C:\Users\ArunT\chatlink-space`)? Should first-run setup warn if `repoPath` is inside OneDrive? [yes, warn]
6. **Author names:** lowercase slug only (`arun`, `krish`)? Should the server refuse to start if `me` isn't in `space.json` members? [slug only; warn, don't refuse]
7. **One server per clone:** fine to assume only one chatlink process uses a given clone (two Desktop entries → two clones, as in M3)? [yes]
8. **Status values:** fixed set `decided | closed | reopened | superseded`, or free text? [fixed set]
9. **`assistant_note` default** (SPEC open question, needed by M3): off by default? [off]
