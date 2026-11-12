# Decisions

Significant implementation choices, newest last. SPEC.md MUST lines are fixed and not recorded here; if a decision changes SPEC.md, update it in the same commit.

## Template

```
### YYYY-MM-DD — <short title>
- **Decision:** what we chose.
- **Alternatives considered:** what else, briefly.
- **Reason:** why this one.
```

## Entries

### 2026-11-12 — Language: TypeScript on Node
- **Decision:** Implement in TypeScript, bundled with esbuild into one JS file, packaged as an MCPB `node` server.
- **Alternatives considered:** Python (stdlib sqlite3, fastembed/onnxruntime).
- **Reason:** Claude Desktop ships its own Node runtime, so users install nothing. With Python, users need a compatible interpreter (or the `uv` type), and compiled wheels have to be vendored per platform. Some Python builds disable `enable_load_extension`, which blocks sqlite-vec. M0/M1 need no runtime deps in TS. For embeddings, model2vec static embeddings (e.g. `potion-base-8M`, ~30 MB) can run in pure JS without onnxruntime. Still to check at M2b: paraphrase quality. Fallback: transformers.js + quantized MiniLM.

### 2026-11-12 — Dev tooling: vitest, esbuild, tsc; git via execFile
- **Decision:** Dev deps are `typescript`, `vitest`, `esbuild`, `@types/node`. No git library: shell out to the `git` CLI with `child_process.execFile` and `GIT_TERMINAL_PROMPT=0`.
- **Alternatives considered:** node:test + tsx; simple-git / isomorphic-git.
- **Reason:** vitest runs TS directly with one dev dep. Using the CLI is the SPEC requirement ("use the user's existing git setup") and is the most boring option.

### 2026-11-12 — IDs: in-house monotonic ULID
- **Decision:** 26-char Crockford ULID, generated with `crypto.randomBytes`, monotonic within a process. No dependency.
- **Alternatives considered:** `ulid` npm package; UUIDv7.
- **Reason:** About 40 lines, sortable, readable in logs. Import ids (M4) will reuse the ULID shape, taking the time part from `original_ts` and the random part from a content+position hash, so re-runs give the same ids.

### 2026-11-12 — Offline queue is the unpushed git commits
- **Decision:** No separate queue file. Unpushed work = `git rev-list --count @{u}..HEAD`. A sync cycle first commits any uncommitted changes in `logs/<me>/` (crash recovery), then pulls.
- **Alternatives considered:** A local queue file of pending events.
- **Reason:** One source of truth that can't drift. An event is durable once written to the clone; git delivers it later.

### 2026-11-12 — Tolerant reader skips any malformed line
- **Decision:** Readers skip every malformed line (bad JSON, invalid UTF-8, missing required fields), report a count with reasons, and never crash. CRLF and BOM are stripped. Unknown `kind` is kept but given no tier. Before appending, the writer adds `\n` if the file doesn't end with one, so a new event never joins onto a partial line.
- **Alternatives considered:** Tolerate only the last line; treat a bad line mid-file as a hard error.
- **Reason:** A crash during a write leaves a partial line, and the next append then puts it in the middle of the file. Durability beats strictness.

### 2026-11-12 — Shared repo gets a `.gitattributes`
- **Decision:** First-run setup writes `.gitattributes` with `*.jsonl text eol=lf` and `space.json text eol=lf`. SPEC.md updated.
- **Alternatives considered:** Rely only on the reader tolerating CRLF.
- **Reason:** With `core.autocrlf=true` (the default on Windows), working-tree line endings would differ across machines. LF everywhere keeps logs byte-stable and easy to diff.

### 2026-11-12 — Sync defaults
- **Decision:** Pull timeout 3 s; up to 3 push attempts with short backoff, each retry preceded by `pull --rebase`; all git operations serialized by an in-process mutex. Assumes one chatlink process per clone. The pull cache window is deferred to M3 latency measurement.
- **Alternatives considered:** Cross-process lockfile; longer timeouts.
- **Reason:** Keeps `sync_turn` near the ~2 s target. Two Desktop entries means two clones, so cross-process locking isn't needed for v1.

### 2026-11-12 — Names, status values, assistant notes, clone location
- **Decision:** Author names are lowercase slugs `^[a-z0-9][a-z0-9_-]{0,31}$`. A `me` not listed in `space.json` gives a warning, not a refusal. `status` is a fixed set: `decided | closed | reopened | superseded`. `assistant_note` is off by default. First-run setup warns if the clone path is inside OneDrive (or a similar sync folder).
- **Alternatives considered:** Free-text names and statuses; refusing to start for unknown members; logging assistant notes by default.
- **Reason:** Slugs block path traversal and case-collision tricks. A fixed status set keeps "confirmed" meaning clear. Keeping model-written text out by default protects the trust tiers. Sync folders can corrupt `.git`.

### 2026-11-12 — M0 reader and store details
- **Decision:** (1) The reader skips an event whose `author` doesn't match its `logs/<author>/` folder. (2) Validation accepts ULID or UUIDv7 ids and requires `ts` to end in `Z`. Kind-specific fields are checked only for `v: 1`; newer versions are kept on their base fields. (3) Order and status resolution compare `ts` as an instant (parsed ms), then `id`, never `ts` as a string. (4) Ingest compares events by canonical JSON (sorted keys). The same id with different content is counted as a conflict and the canonically smaller event is kept. (5) `MemoryStore` is the M0 `EventStore`; SQLite joins in M2a behind the same interface.
- **Alternatives considered:** Trust `author` as written; compare `ts` strings; first-seen wins on id conflicts.
- **Reason:** (1) stops one member's folder from speaking for another. (3) `"…05Z"` sorts after `"…05.5Z"` as a string, which is wrong. (4) keeps "merge equals union" independent of ingest order even in the should-never-happen conflict case.

### 2026-11-12 — M0 hardening after spec review
- **Decision:** (1) The writer refuses a day file that already exists and is not a regular file, including a dangling symlink. It checks with `lstat`, and opens with `O_NOFOLLOW` where the OS has it. (2) The `logs/<me>` part of the real path must match exactly, including case. Only the repo root may differ in case (win32/darwin). (3) `ts` allows only whole seconds or exactly 3 fractional digits, and must round-trip through `Date` (no Feb 30, no 24:00). UUIDv7 ids must be lowercase, so each id has one spelling. (4) A log file or folder that can't be read (locked, gone) is reported as skipped (`line: 0`, `unreadable: <code>`) instead of failing the whole read. (5) Blank lines are ignored and not counted. (6) The directory fsync is best effort on POSIX (both `logs/<me>` and `logs/`) and skipped on Windows, which can't fsync directories.
- **Alternatives considered:** Trusting `realpath` alone; normalising id case; allowing nanosecond `ts`.
- **Reason:** `realpath` can't resolve a dangling link, and a member could commit one, so a write could escape `logs/<me>/`. A `logs/ARUN/` folder would take arun's writes where readers never look. A string id or `ts` with two spellings would break idempotency or ordering.

### 2026-11-12 — M1 git transport details
- **Decision:**
  - (1) Stage and commit with the pathspec `:(glob)logs/<me>/*.jsonl` only. `git commit -- <pathspec>` leaves anything else someone staged by hand uncommitted. After each commit, `diff-tree` checks it touched only that path. If not, the commit is undone with `reset --soft HEAD~1` and the write is refused.
  - (2) Pull is `git pull --rebase --autostash` with a 3 s timeout, killing the whole process tree (`taskkill /T` / process group). After a failed or killed pull, any rebase in progress is aborted. After a timeout, a leftover `index.lock` is removed (safe because of one process per clone and serialized git).
  - (3) The `fetchNew` cursor is a commit SHA, and the caller keeps it. Events come from log files changed between the cursor and HEAD. A missing or unknown cursor reads everything. Ingest is idempotent, so reading too much is harmless.
  - (4) Push runs under the same mutex as pull and commit, so it never races a rebase. It is single-flight, and a request that arrives during a push queues one more pass. It is `git push <remote> HEAD:<merge ref>` with a 15 s timeout. A failed push is followed by a pull, then a retry, up to 3 attempts with jittered backoff. If the pull fails, we're offline: stop and leave the commits queued.
  - (5) The unpushed count is `rev-list --count HEAD --not --remotes`.
  - (6) Sync state (`lastPullAt`, `lastPushAt`, `lastError`) is saved as JSON in a state dir. The constructor refuses a state dir inside the repo. `stale` is per process: true until a pull succeeds.
  - (7) The shared `.gitignore` allows only `logs/*/*.jsonl` under `logs/`, plus `space.json`, `.gitignore` and `.gitattributes`. The template is in `src/transport/shared.ts` for M4 setup to use.
- **Alternatives considered:** Unstaging foreign paths; a cursor kept inside the transport; pushing outside the lock; `@{u}..HEAD`.
- **Reason:** Commits by pathspec never pick up anything that isn't mine. A caller-held cursor lets the M2a index own its own progress. Holding the lock for push costs at most one push time on the next turn, and in exchange push never pushes a commit that a rebase is about to rewrite.

### 2026-11-12 — M1 fixes after spec review (supersedes item 4 of "M1 git transport details")
- **Decision:**
  - (1) **Push runs outside the mutex.** Under the lock it resolves HEAD to a SHA and the upstream ref (cached per process). The network part is `git push <remote> <sha>:<merge ref>`, without the lock. Safe because the remote accepts only fast-forwards. If a local rebase runs during the push, the push just gets rejected and the retry loop handles it. Rare risk: the push and a pull can collide on the `refs/remotes/...` lock. That makes that one pull stale, nothing more.
  - (2) Once events are written, `appendMine` never throws. A failed commit, including a tripped post-commit guard, returns `committed: false`. It sets `uncommitted: true` in sync state and records `lastError`, and the next cycle's recovery commits the events. A caller never re-sends, so no duplicates. `WriteRefusedError` is thrown only before anything is written.
  - (3) After a pull timeout, `runProcess` waits for `taskkill` to finish. Then every `*.lock` under the git dir (except `objects/` and `hooks/`) is removed, and any rebase in progress is aborted.
  - (4) chatlink's own commits use `-c commit.gpgsign=false --no-verify`. A signing prompt or a user hook would otherwise hang or block a turn. Everything else (credentials, remotes) is the user's own git setup.
  - (5) Unborn HEAD (an empty remote): `fetchNew` reads local data and returns cursor `""`. The post-commit guard uses `diff-tree --root`, and undoing a root commit deletes the ref.
  - (6) `src/config.ts` from the plan is deferred to M3, where the server reads its config. `GitTransportConfig` covers M1.
- **Known risks, surfaced in M3:**
  - A commit by someone else into `logs/<me>/` on the remote makes every pull conflict. The rebase is aborted, so nothing is lost, but the clone stays stale until a human fixes it. `lastError` says why.
  - `--autostash` can leave conflict markers in a hand-edited file in another person's folder. The reader skips those lines.
- **Reason:** SPEC says push must not block the reply, and a hung network must not stall every turn. Never-throw-after-write keeps "never lose an event" from turning into "duplicate an event".

### 2026-11-12 — M2a SQLite driver: better-sqlite3
- **Decision:** Use `better-sqlite3` (prebuilt native binaries, bundled SQLite 3.53 with FTS5). It is the only runtime dependency. esbuild marks it external, so the bundle ships its `.node` file alongside.
- **Alternatives considered:** Node's built-in `node:sqlite` (zero deps); sql.js / wa-sqlite (WASM).
- **Reason:** `node:sqlite` in Node 22.13 is built without FTS5 ("no such module: fts5"), and Claude Desktop's Node version is outside our control. The WASM builds don't include FTS5 by default and can't load sqlite-vec for M2b. better-sqlite3 is the most-used choice and documents `loadExtension` for sqlite-vec. **Risk for M4:** the native binary must match the platform and the Node ABI of the runtime Claude Desktop uses. Check this when building the `.mcpb`. All SQLite access stays in `src/search/sqliteIndex.ts`, so swapping drivers is a one-file change.

### 2026-11-12 — M2a index design
- **Decision:**
  - (1) One table `events` (one row per id, canonical JSON kept as the source for `get`/`all`), an external-content FTS5 table kept in sync by triggers, and a `meta` table (`cursor`, `source`). The layout version is stored in `PRAGMA user_version`. A mismatch drops everything, and the next sync re-reads all logs.
  - (2) Tokenizer `porter unicode61 remove_diacritics 2`, so "cache" matches "caching" and "cafe" matches "café". Each event's indexed text is `text`, or `reason` for `status`.
  - (3) A query is free text: it is split into letter/digit words, each word is quoted, and the words are OR-ed, so FTS syntax in a query is never interpreted. bm25 rewards matching more words.
  - (4) Ranking is `(-bm25) × recency`, where recency = `floor + (1−floor)·0.5^(age/halfLife)` (defaults: 30-day half-life, floor 0.3). It is computed in SQL through a registered JS function, so LIMIT applies to the final score. Ties go to the newer `ts`, then the higher `id`. All knobs are in `src/search/ranking.ts`. The vector score and the confirmed boost are deferred to M2b (that milestone's scope).
  - (5) Incremental ingest is `syncIndex`: `fetchNew(cursor)`, then ingest plus cursor update in one transaction. Ingest is idempotent, so re-reading after a crash or an unknown cursor is harmless.
  - (6) Rebuild is `rebuildIndex` / `chatlink rebuild`: delete the file (and WAL/SHM), create a fresh index, and run a sync with no cursor. Same code path as incremental, so the results match.
  - (7) The index refuses a file path inside the shared repo. An index opened with a different `source` repo is wiped. A corrupt or non-SQLite file is deleted and recreated (derived data). `synchronous=NORMAL` + WAL: the index favours speed, because the logs are the durable copy.
  - (8) `SqliteIndex` implements M0's `EventStore` with the same conflict rule as `MemoryStore` (keep the canonically smaller event), and resolves status with `ORDER BY ts_ms DESC, id DESC`.
  - (9) Search hits carry `id, author, ts, kind, tier`, verbatim `text` (cut to 1000 chars with `truncated` and `textLength`), `score`, and the item's current `status` if anyone marked it.
- **Alternatives considered:** A contentless FTS table; additive score mixing; re-ranking a bm25 top-N in JS; passing raw FTS5 syntax through.
- **Reason:** One file, one code path for rebuild and incremental ingest, and nothing the user types can break a query. A multiplicative recency factor guarantees "newer outranks older equal match" while still letting a much better match win.

### 2026-11-12 — M2a fixes after spec review
- **Decision:**
  - (1) An index file path must end in `.sqlite`, `.sqlite3` or `.db`, and must lie outside the shared repo, both lexically and after resolving symlinks or junctions on the deepest existing ancestor. `assertIndexPath` checks this before anything opens or deletes the file, and both `rebuildIndex` and `SqliteIndex.open` call it. `deleteIndexFiles` refuses any other extension. The shared `.gitignore` only allows `*.jsonl` and `space.json`, so no index operation can delete a shared file, even with no `source` given.
  - (2) `since` must be an ISO 8601 date (read as UTC midnight) or a date-time with an explicit `Z` or offset. A date-time with no zone is rejected rather than read as local time.
  - (3) Truncated text never splits a UTF-16 surrogate pair.
  - (4) `chatlink search` is a small debugging subcommand next to `rebuild`. It reads the local index only and doesn't sync. The build now emits `dist/chatlink.js` (library) and `dist/cli.js`, with `better-sqlite3` external (a native module can't be bundled).
- **Known, accepted differences:** Rebuild reads every log file at HEAD plus working-tree lines, while incremental ingest only sees files changed in commits. They can differ only if someone deletes a log file (which breaks append-only; incremental keeps those events), or for my lines that are on disk but not yet committed (the next recovery commit brings incremental level). Rebuilding while the index is open elsewhere fails on Windows (EBUSY). The M3 server should rebuild through its own open index (`reset()` + sync) rather than deleting the file.
- **Reason:** The review found that a mistyped `--index` could delete a log, and the recovery commit would then commit and push that deletion. Checking a path before deleting it is the only safe order.
