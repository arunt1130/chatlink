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

### 2026-11-12 — M2b embedding model: model2vec potion-base-32M, pure JS
- **Decision:** Use `minishlab/potion-base-32M` (MIT; 63,091 × 512 float32; 129 MB), pinned to revision `1e5a03f8…` and checked by size and hash in `scripts/fetch-model.mjs`. The files go in gitignored `models/potion-base-32M/`. Inference is ours, in about 150 lines with no dependency: a BERT WordPiece tokenizer read from `tokenizer.json`, row lookup, mean pool, L2-normalize. This mirrors model2vec's `StaticModel.encode`: no special tokens, `[UNK]` dropped, at most 512 tokens. The embedder id includes the revision, and a change re-embeds the index.
- **Alternatives considered:** potion-base-8M (~30 MB); transformers.js with quantized MiniLM (needs onnxruntime-node, a heavy native dependency).
- **Reason:** Arun picked the bigger model for paraphrase quality over bundle size. Static embeddings need no runtime: loading takes ~0.1 s and embedding runs at ~60k texts/s on this machine. A probe set had the right top-1 match for 6/6 paraphrases. Tests never download anything: a missing model fails loudly, so the acceptance test can't silently skip.

### 2026-11-12 — M2b vector storage: BLOBs + exact scan, no sqlite-vec
- **Decision:** Vectors are float32 BLOBs in a `vectors` table keyed by event rowid, inside the same SQLite file. A query scans all vectors that pass the author/since filters and takes dot products in JS. SPEC.md updated.
- **Alternatives considered:** `sqlite-vec` (as SPEC suggested).
- **Reason:** At this scale (thousands to tens of thousands of messages), an exact scan takes milliseconds and is exactly reproducible. That keeps "rebuild equals incremental" easy to prove. sqlite-vec is pre-v1 and would be a second native binary with the same platform/ABI packaging risk as better-sqlite3. It can be added later behind the same `search` without changing the logs.

### 2026-11-12 — M2b hybrid ranking
- **Decision:** `score = (0.5·keyword + 0.5·vector) × recency × tierBoost × statusBoost`, with all knobs in `src/search/ranking.ts`.
  - The keyword score is absolute, not relative to the best hit: the idf-weighted share of query terms the item contains, × (0.5 + 0.5·bm25/best bm25).
  - Common English stopwords are dropped from the keyword part of the query (unless nothing else is left). The vector part always sees the whole query.
  - Vector similarity below 0.25 counts as no match.
  - `tierBoost`: confirmed 1.25, said 1, imported 0.9, model-written 0.75. `statusBoost` applies to an item whose latest status is decided/closed (1.25), superseded (1.1) or reopened (1).
  - Candidates are the top 200 by bm25 plus the top 200 by similarity, merged by id. Ties go to the newer `ts`, then the higher `id`.
  - Every event with text is embedded at ingest, status reasons included. Events that lack a vector (ingested without an embedder, or after a model change) are embedded on open.
  - Each hit reports `match: {keyword, vector}`.
- **Alternatives considered:** Normalizing bm25 by the best hit (M2a's first version); reciprocal rank fusion.
- **Reason:** With per-query normalization, a hit on a filler word like "the" scored a perfect 1.0 and drowned out a strong vector match, which a test caught. An absolute, idf-weighted keyword score keeps the two parts on one scale. Multiplying in recency and boosts keeps M2a's guarantee (newer outranks older equal match) and SPEC's "boost confirmed items". An item someone marked decided or closed counts as confirmed too.

### 2026-11-12 — M2b notes after spec review (supersedes item 4 of "M2a index design")
- **Decision:**
  - (1) Final scoring now happens in JS over a merged candidate set: the top 200 by raw bm25 plus the top 200 by vector similarity. It no longer happens in SQL. So LIMIT no longer applies to the final score: when a term appears in more than 200 items, a recent or confirmed item just below the bm25 cut can be missed by keyword (vector search can still bring it in). This is accepted for v1, and `candidatePool` can be tuned.
  - (2) Measured on this machine (Windows, Node 22, synthetic worst case where every message shares common words): ingest with embedding runs at ~8k events/s. Hybrid search averages 12 ms at 1k events, 118 ms at 10k and 234 ms at 20k, growing linearly with the vector scan and term coverage. That fits inside the ~2 s `sync_turn` target. If it doesn't hold up in M3/M5, keep the vectors in memory or add sqlite-vec.
  - (3) Known limits: an embedder's id comes from `SOURCE.json` (written by `fetch-model` only after every hash check passes). Vectors are stored in native byte order: they are local, derived data, never shared. A model change re-embeds the whole index synchronously on open, which takes about 1 s per 8k events.
  - (4) better-sqlite3 no longer needs to load extensions (sqlite-vec isn't used). It stays because FTS5 is the deciding reason.
- **Reason:** Spec-review follow-ups. These are recorded so M3 can measure them against real use.

### 2026-11-12 — M3 MCP server
- **Decision:**
  - (1) The official `@modelcontextprotocol/sdk` (1.32.2) over stdio, with `zod` 4.6.7. zod 3 has a high-severity advisory, and the SDK accepts zod 4. esbuild bundles only the stdio server parts: `dist/server.js` is ~1.4 MB unminified, minified in M4. Logs go to stderr only; stdout is the protocol.
  - (2) The logic lives in `Chatlink` (`src/app/chatlink.ts`), independent of MCP. `src/server.ts` only maps tools to it, so tests drive it directly and through an in-memory MCP client. All calls are serialized with a mutex.
  - (3) Config comes from `CHATLINK_ME` and `CHATLINK_REPO` (required), plus optional `CHATLINK_STATE_DIR`, `CHATLINK_INDEX` and `CHATLINK_MODEL_DIR` (`none` = keyword-only), or the same as flags. This is what Claude Desktop's `env` and MCPB `user_config` provide. The default state dir is per user and per clone (`%LOCALAPPDATA%\chatlink\<me>-<hash(clone path)>`, Application Support on macOS, XDG state elsewhere). So two entries on one machine never share state, and the state is never inside the repo.
  - (4) `sync_turn` order: pull + ingest, then **write my message first** (durable before anything else), then search (excluding the message just written), then the new-from-others digest, then decision detection. A missing or broken model is a warning and leaves search keyword-only, never a startup failure.
  - (5) The read cursor (`read-cursor.json` in the state dir) is a position in the index's ingest order, plus the index epoch and the newest `ts` seen. Ingest order means an event that arrives late from someone who was offline still counts as new. After a rebuild (new epoch), the cursor re-anchors on `ts`. `sync_turn`'s digest and `whats_new` share the cursor: anything shown counts as seen. The digest shows 20 items per turn, and `more: true` says there are more.
  - (6) A sixth tool, `get_item(id)`, returns the full text. SPEC says long texts are "truncated … with the id for fetching more", and this is that fetch. Items are cut to 600 characters elsewhere.
  - (7) `mark_status` refuses ids that aren't in the index, so a guessed id can't create a status pointing at nothing. Nothing is written when it refuses.
  - (8) `catch_me_up` runs `whats_new` on the server side and embeds the result in the prompt text. The digest arrives even if Claude doesn't call a tool.
  - (9) Decision detection (v1 heuristic, `src/app/decisions.ts`): regexes for closing cues ("let's drop…", "ruled out", "not going to build…") and deciding cues ("we decided…", "let's go with…", "agreed on…"). Questions never trigger it. A close targets the best related item that is someone else's statement and not already closed. A decision targets this message. The result carries a ready-made one-line `ask`.
  - (10) Latency (see SPEC open question): 1.1–1.7 s per `sync_turn` against a local remote, nearly all git process start-up. Accepted for now; re-measure against GitHub in M5. If it's too slow, the options are batching git calls, a longer-lived `git cat-file --batch`, or moving the commit off the reply path. The last one needs care with "durable before reply".
- **Alternatives considered:** A hand-written JSON-RPC loop; a ts-based read cursor; having `catch_me_up` only tell Claude to call `whats_new`.
- **Reason:** The SDK is the best-known path and tracks protocol changes. A ts cursor would lose late events. Server-side `catch_me_up` is the "always one click away" guarantee.
- **Manual acceptance:** The Claude Desktop run with two entries is described in `docs/m3-desktop-test.md`, with `scripts/dev-space.mjs` to create a local two-person space. The same flow is automated in `tests/m3/e2e.test.ts`.

### 2026-11-12 — M3 fixes after spec review (supersedes the re-anchor part of item 5 of "M3 MCP server")
- **Decision:**
  - (1) **Re-anchoring the read cursor after a rebuild.** A rebuild ingests in author-folder order, not time order. So a "position at ts ≤ last seen" can land past new events from authors whose folders sort earlier. With me = krish, arun's new messages vanished from the digest. Now a cursor from an older epoch becomes a *floor*: the rebuilt rows (sequence ≤ the index's max at re-anchor) count as new only if their `ts` is after the newest `ts` already seen. Rows ingested later count as new as usual. The floor is dropped once the cursor passes the rebuilt rows. Tested with me first, middle and last among 2–3 authors. Residual: an event that was on its way late, with an old `ts`, at the moment of a rebuild is treated as seen. It is still searchable.
  - (2) `share=false` never returns `possible_decision`, so a yes can't put off-record words into the log through a `mark_status` reason.
  - (3) The SPEC tools table now lists `get_item` and `whats_new`'s optional `limit`.
  - (4) The `sync_turn` description says `unpushed_commits > 0` right after a write is normal (background push).
- **Known risks, deferred to M4 (setup/packaging):**
  - Only one server process per clone is assumed, not enforced. If Desktop restarts a server while the old one is still in `close()` (up to 5 s), two processes share a clone. M1's lock cleanup after a pull timeout could then remove the other process's live `index.lock`. Plan: an exclusive lockfile in the state dir with pid and stale-pid takeover.
  - On Windows, a hard kill skips `close()`. Safe: commits stay queued.
  - The default state dir hashes the lowercased clone path. Two clones whose paths differ only in case, on a case-sensitive file system, would share state.
- **Reason:** Spec-review findings. The Claude Desktop acceptance run is manual and is recorded below once done.

### 2026-11-14 — M3 acceptance in Claude Desktop: passed
- **Result:** Arun ran `docs/m3-desktop-test.md` on one Windows laptop: two server entries (`chatlink-arun`, `chatlink-krish`) pointed at two clones of a local bare repo. Krish said caching won't help. In Arun's chat, "Should we cache the query results…" got an answer that named Krish, gave the date and quoted his words. The optional checks also passed: the decision prompt and mark as closed, Krish seeing Arun's close, and off the record writing nothing. Claude used the right server's tools in each chat.
- **Learned:** Claude Desktop keeps each server's tools separate, so two chatlink entries don't collide. There was no per-chat toggle to be found. Instead, one Project per person, whose instructions name that person's server ("use ONLY the chatlink-krish tools"), worked reliably. `docs/m3-desktop-test.md` is updated to match. `timing_ms` from real Desktop use wasn't captured; measure it in M5.

### 2026-11-14 — M4 SQLite driver: node-sqlite3-wasm (supersedes "M2a SQLite driver: better-sqlite3")
- **Decision:** The index uses `node-sqlite3-wasm` 0.8.61 (SQLite 3.54 compiled to WebAssembly, MIT; FTS5 included, persists to a normal file). `better-sqlite3` is removed. All driver access goes through `src/search/db.ts`, which mirrors the slice of the better-sqlite3 API the index used, so `sqliteIndex.ts` barely changed:
  - statements are prepared once and cached;
  - each statement is reset right after use, because the driver otherwise keeps a read open and the file locked;
  - all statements are finalized on close.
  Vectors are also held in memory after the first vector search. Copying blobs out of WASM per query was slow.
- **Alternatives considered:** better-sqlite3 with per-platform/ABI prebuilds; Node's `node:sqlite` (no FTS5 in Node 22.13); sql.js (in-memory, no FTS5 by default).
- **Reason:** Claude Desktop runs node bundles on its own runtime. Its Windows install has no `node.exe`, which points to Electron's built-in Node, whose ABI differs from system Node and changes with Desktop updates. A native `.node` file would break on install or after an update, and would need one bundle per OS. WASM has no ABI: one bundle works on Windows, macOS and Linux. Measured with the real model: search 22 ms at 1k events and 56 ms at 10k (better-sqlite3: 12 / 118 ms); ingest with embedding ~3k events/s. WAL isn't available, and that's fine: one process, and the data is derived.

### 2026-11-14 — M4 packaging: one .mcpb with the model inside
- **Decision:** `npm run pack` (`scripts/pack-mcpb.mjs`) builds a minified bundle with `scripts/build.mjs` and stages `manifest.json` (MCPB 0.3), `server/server.js`, `server/node-sqlite3-wasm.wasm`, `models/potion-base-32M/*`, README and THIRD-PARTY-NOTICES.txt. It validates the manifest, then runs `mcpb pack`. Result: 116.6 MB, almost all model. `user_config` asks for two things, `name` (string) and `repo` (directory), passed as `CHATLINK_ME` / `CHATLINK_REPO`. ESM output gets a `require`/`__dirname` banner for the WASM loader. Notices are generated from the esbuild metafile (every bundled npm package's license file: 9 packages, all MIT/ISC/BSD-3) plus the model and SQLite.
- **Alternatives considered:** downloading the model on first run (smaller bundle); `@anthropic-ai/mcpb` as a devDependency.
- **Reason:** SPEC NFR 4: the only runtime network traffic is git. A first-run download would add Hugging Face. The `mcpb` CLI runs pinned through `npx`, so its own dev-only dependencies (old zod 3, `tmp` via inquirer) don't land in the project's `npm ci` or audit. Packing is a maintainer step that already needs network. `tests/m4/bundle.test.ts` stages the bundle and runs it the way Desktop does (manifest substitutions, a foreign working directory) for a two-person hybrid-search exchange.

### 2026-11-14 — M4 first-run setup, git identity, one server per clone, import
- **Decision:**
  - (1) **Setup** (`GitTransport.setup()`, run once per process before the first sync):
    - It pulls first. Then, for each of `.gitignore`, `.gitattributes` and `space.json` that the repo doesn't track, it writes the file with fixed contents and commits it as "chatlink: space setup".
    - The commit has its own guard: only those files, otherwise undone and refused.
    - It never overwrites an existing file; one that differs from the template is a warning. Two people setting up an empty repo at once write identical files, and the rebase drops the duplicate commit (tested).
    - It warns, through `sync.warnings`, when the clone has no upstream or the remote is unreachable. A brand-new empty remote isn't "unreachable": that's checked with `ls-remote`.
    - The sync-folder warning (OneDrive, Dropbox, iCloud, Google Drive) is also surfaced in `sync.warnings`.
    - This is the one SPEC-sanctioned write outside `logs/<me>/` (SPEC setup flow, step 4).
  - (2) **Git identity:** if `user.name`/`user.email` aren't set (a fresh machine), chatlink's own commits pass `-c user.name=<me> -c user.email=<me>@chatlink.invalid`. The user's identity wins when set.
  - (3) **One server per clone:** `.git/chatlink-server.lock` holds a pid, taken with `O_EXCL`. A new process waits up to 6 s for a live holder (Desktop restarting a server) and takes over a dead one's lock. Otherwise it refuses with a message saying what to do. The lock is in `.git`, so it holds across different state dirs. `chatlink import` and `chatlink rebuild` take it too. This closes the M3 known risk.
  - (4) **Import:** `src/import/transcript.ts` reads a Claude.ai export (`conversations.json`; with several conversations, one is picked by name or uuid), a JSON array of turns, or text with `Human:`/`Assistant:` labels.
    - Ids are ULIDs: the time part is the turn's original time (0 if unknown); the random part is a hash of (author, transcript key = conversation uuid or content hash, position, role, text).
    - Ids already in my log or the index are skipped, so a re-run adds no lines and no commit.
    - The author is always me, since I write only my own folder. Claude's turns are skipped by default (SPEC).
    - It is exposed as the CLI command and as the `import_transcript` tool. SPEC.md is updated.
  - (5) Version 0.4.0. `SERVER_VERSION` equals the package and manifest version (tested).
- **Reason:** M4's bar is "a fresh machine … following only the README". A missing git identity, an empty remote, two people setting up at once, and someone with no Node all happen on day one.

### 2026-11-14 — M4 fixes after spec review
- **Decision:**
  - (1) The server lock is now `.git/chatlink-server.pid`. As `*.lock` it was deleted by M1's lock cleanup after a timed-out pull, which happens on any offline turn. The takeover of a dead holder's lock re-reads the file right before deleting it, so it only removes the stale one. A tiny race remains; the loser's exclusive create then fails and it waits. The "already running" message names the file to delete after a crash, which covers Windows pid reuse. Tested: the lock survives a timed-out pull.
  - (2) **One name per computer.** Each install needs its own clone *and its own name*. Two clones writing `logs/<name>/<day>.jsonl` would both append to the same file, so every `pull --rebase` would conflict, be aborted, and leave that machine stale forever. The README now says to use names like `arun` and `arun-laptop`, and so does the install dialog's hint. Per-device files under one person's name are a candidate for M5 feedback (SPEC unchanged: one writer per folder).
  - (3) **Setup while offline:** if the pull fails and the remote isn't known to be empty, setup writes nothing (`complete: false`). The others may have set the space up already, and different files would clash on the next pull. The first attempt runs before the first sync; retries run only after a sync that reached the remote, so an offline turn doesn't pay a second pull timeout. Setup files are written with `wx` (never clobbered). A symlink (even dangling) or a folder with a space file's name is never written through: it's a warning instead. A *tracked* `.gitignore` that differs from the template gets a warning; chatlink still commits only its own log paths, so nothing derived can be shared either way.
  - (4) **README for a fresh machine:** install git first (Windows: Git for Windows with Credential Manager; macOS: command line tools, then GitHub CLI `gh auth login` + `gh auth setup-git`) *before* cloning. Then check that `ls-remote` runs without a prompt, and restart Claude Desktop if git was installed while it was open. The `.mcpb` (about 120 MB) is shared as a file link.
  - (5) **Import:** text transcripts recognise only `Human:`/`User:` and `Assistant:`/`Claude:` as speaker labels, so a line starting "Me:" or "AI:" inside a message stays in it. Line endings are normalized before the transcript key is hashed, so a CRLF re-save imports nothing new. Import events have `ts` = when they entered the shared memory and `original_ts` = when they were said, with the ULID's time part = `original_ts` (0 if unknown). Ordering and status ties use `ts` then `id`, so this only affects id sortability, and only for imports.
  - (6) More sync folders are flagged: macOS `CloudStorage/…` (OneDrive, Google Drive), `Dropbox (Personal)`.
- **Known, not fixed:**
  - `import_transcript` reads whatever path Claude passes. The tool description limits it to explicit user requests, and only transcript-shaped files parse.
  - bundle.test.ts runs system Node, not Claude Desktop's runtime. The real install on Krish's machine is M4's manual acceptance.
- **Reason:** Spec-review findings for M4.

### 2026-11-15 — 0.4.1: sign-in failures are reported, not hidden
- **Found in the first real install:** Arun has two GitHub accounts. Git Credential Manager wanted to ask which one to use. chatlink runs git with `GCM_INTERACTIVE=never`, so the push failed at once. The retry loop then pulled, and on a brand-new empty repo that pull fails too ("no such ref"). The pull error overwrote the push error, so Claude reported a pull problem and the real cause was invisible. Nothing was lost: the commits stayed queued.
- **Decision:**
  - (1) When the pull before a push retry fails, `lastError` keeps the push error and adds the pull error after it.
  - (2) `credentialHint()` recognises credential-prompt failures (GCM "cannot prompt", "could not read Username", 403/denied) and appends a one-line fix to `lastError`: pick the account for this folder with `git config credential.https://github.com.username <name>`, or run `ls-remote` once to sign in.
  - (3) The README tells people with several GitHub accounts to set that once, after cloning.
- **Reason:** A fresh setup has no other way to find out why its messages never arrive.

### 2026-11-14 — M4 acceptance on two computers: passed
- **Result:** Krish set up chatlink on his own computer from the v0.4.1 release, following the README's steps (driven by a Claude Code prompt built from them): git and GitHub sign-in, cloning `our-chatlink`, installing `chatlink.mcpb`, and the Project rules. His message "Caching won't help here: every query has a unique timestamp in it." went through `sync_turn` and reached the shared repo, and the exchange with Arun's laptop worked.
- **Learned:** The one real-install problem (several GitHub accounts, so the credential prompt failed silently in the background) was found on Arun's machine and fixed in 0.4.1 before Krish installed. `timing_ms` from real use still wasn't captured; measure it in M5.
