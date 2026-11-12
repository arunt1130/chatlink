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
