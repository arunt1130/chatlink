# chatlink

A local MCP server that lets two or more people's Claude Desktop chats share one memory.
Each person's server logs their messages verbatim as immutable JSON Lines events in their
own folder of a shared private GitHub repo, syncs with plain `git pull`/`git push` using
their existing credentials, and keeps a local derived SQLite index (FTS5 + vectors) for
retrieval. Store what was said; interpret at read time; always show the source.

**SPEC.md is the source of truth. If a decision changes it, update SPEC.md in the same commit.**

## Workflow

- One milestone per branch: `m0-event-log`, `m1-git-transport`, `m2a-keyword-index`, `m2b-vector-index`, `m3-mcp-server`, `m4-ship`.
- Write that milestone's acceptance tests from SPEC.md and make them pass before committing.
- Record significant choices with reasons in DECISIONS.md.
- Do not build anything in SPEC.md's "Out of scope" section.
- Keep the transport behind a small interface (append my events / fetch everyone's new events) so a Drive transport can be added later.
- Prefer boring, well-known choices and few dependencies.

## Invariants (never break)

- Each person writes only `logs/<me>/`. Refuse any write outside it.
- Logs are append-only. Events are never edited or deleted; a change of mind is a new event.
- Never lose an event. An event is durable once written to the local clone; push is only delivery.
- Derived files (index, embeddings, cursors, queue) are never committed. Shared `.gitignore` allows only `logs/` and `space.json`.
- Readers skip a truncated or malformed last line; never crash on it.
- Ingest is idempotent by `id`. Seeing an event twice changes nothing.
- One file per author per UTC day: `logs/<author>/YYYY-MM-DD.jsonl`. Every event has `v`, `id` (ULID/UUIDv7), `author`, `ts` (UTC ISO 8601), `kind`.
- Latest `status` by `ts` wins; ties broken by `id`.

## Testing

- Multi-user tests: a local bare git repo stands in for GitHub; two clones in temp dirs stand in for two people.
- No network in tests. Ever.
- Each acceptance test in SPEC.md's milestone table maps to at least one named test.

## Commands

TypeScript on Node (see DECISIONS.md). Scripts are created with `package.json` in M0.
- Install deps: `npm ci`
- Test: `npm test` (vitest; offline)
- Typecheck: `npm run typecheck` (tsc --noEmit)
- Build: `npm run build` (esbuild → `dist/chatlink.js` library + `dist/cli.js`; `better-sqlite3` stays external)
- Rebuild index: `node dist/cli.js rebuild --repo <clone> --me <name> --state <dir>` (from M2a)
- Run server (stdio): `node dist/server.js` (from M3)

Approved M0/M1 plan: docs/plan-m0-m1.md.

## Review

After finishing each milestone, run the spec-reviewer agent and fix what it finds before merging.
