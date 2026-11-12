import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitTransport, WriteRefusedError, makeEvent, readAllLogs } from "../../src";
import { ids } from "../helpers/events";
import { makeSpace } from "../helpers/gitFixture";

const msg = (author: string, text: string) => makeEvent(author, { kind: "message", text });

/** Every file touched by commits on the remote whose message says they are `me`'s. */
function filesCommittedBy(s: ReturnType<typeof makeSpace>, me: string): string[] {
  const out = s.git(s.remote, "log", "--format=%x00%s", "--name-only", "main");
  const files: string[] = [];
  for (const block of out.split("\0").slice(1)) {
    const [subject, ...rest] = block.split("\n");
    if (subject!.startsWith(`chatlink: ${me} `)) files.push(...rest.filter(Boolean));
  }
  return files;
}

describe("M1 write boundary", () => {
  it("refuses an invalid `me` at construction", () => {
    const s = makeSpace();
    for (const me of ["../krish", "Krish", "", "a/b", "C:\\x", "/etc", "..", "logs/arun"]) {
      expect(() => new GitTransport({ me, repoPath: s.clone("arun"), stateDir: s.stateDir("arun") })).toThrow(WriteRefusedError);
    }
  });

  it("refuses a state dir inside the shared repo", () => {
    const s = makeSpace();
    expect(() => new GitTransport({ me: "arun", repoPath: s.clone("arun"), stateDir: path.join(s.clone("arun"), ".chatlink") })).toThrow(
      /outside the shared repo/,
    );
  });

  it("refuses events authored by someone else; nothing is written or committed", async () => {
    const s = makeSpace();
    const a = s.transport("arun");
    await expect(a.appendMine([msg("krish", "forged")])).rejects.toThrow(WriteRefusedError);
    await a.whenIdle();
    expect(existsSync(path.join(s.clone("arun"), "logs"))).toBe(false);
    expect((await a.syncState()).unpushed).toBe(0);
  }, 60_000);

  it("never stages or commits other people's folders, even when they are dirty", async () => {
    const s = makeSpace();
    const k = s.transport("krish");
    const ek = msg("krish", "krish original");
    await k.appendMine([ek]);
    await k.whenIdle();

    const a = s.transport("arun");
    await a.fetchNew();
    const krishFile = path.join(s.clone("arun"), "logs", "krish", `${ek.ts.slice(0, 10)}.jsonl`);
    const original = readFileSync(krishFile, "utf8");
    writeFileSync(krishFile, original + JSON.stringify(msg("krish", "tampered")) + "\n"); // tracked, modified
    writeFileSync(path.join(s.clone("arun"), "logs", "krish", "2026-01-01.jsonl"), "untracked\n"); // untracked
    // Even if someone staged it by hand, our commit must not include it.
    s.git(s.clone("arun"), "add", "--", krishFile);

    const ea = msg("arun", "arun turn");
    await a.appendMine([ea]);
    await a.whenIdle();
    await a.fetchNew();
    await a.whenIdle();

    expect(filesCommittedBy(s, "arun").every((f) => f.startsWith("logs/arun/"))).toBe(true);
    expect(ids(s.remoteEvents())).toEqual(ids([ek, ea]));
    const check = path.join(s.base, "verify");
    s.git(s.base, "clone", "-q", s.remote, check);
    expect(readFileSync(path.join(check, "logs", "krish", `${ek.ts.slice(0, 10)}.jsonl`), "utf8")).toBe(original);
    expect(existsSync(path.join(check, "logs", "krish", "2026-01-01.jsonl"))).toBe(false);
  }, 60_000);

  it("derived files (index, embeddings, state) are never committed", async () => {
    const s = makeSpace();
    const c = s.clone("arun");
    mkdirSync(path.join(c, "logs", "arun"), { recursive: true });
    mkdirSync(path.join(c, ".chatlink"), { recursive: true });
    mkdirSync(path.join(c, "models"), { recursive: true });
    writeFileSync(path.join(c, "index.sqlite"), "db");
    writeFileSync(path.join(c, "logs", "arun", "index.sqlite"), "db");
    writeFileSync(path.join(c, "logs", "arun", "cursor.json"), "{}");
    writeFileSync(path.join(c, "logs", "index.sqlite"), "db");
    writeFileSync(path.join(c, ".chatlink", "sync-state.json"), "{}");
    writeFileSync(path.join(c, "models", "potion.safetensors"), "x");

    const a = s.transport("arun");
    await a.fetchNew();
    await a.appendMine([msg("arun", "hello")]);
    await a.whenIdle();

    const tracked = s.git(s.remote, "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean).sort();
    expect(tracked.filter((f) => f.startsWith("logs/")).every((f) => /^logs\/[a-z0-9][a-z0-9_-]*\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))).toBe(true);
    expect(tracked.filter((f) => !f.startsWith("logs/"))).toEqual([".gitattributes", ".gitignore", "space.json"]);
    // The shared .gitignore also keeps them out of a plain `git add -A`.
    s.git(c, "add", "-A");
    const staged = s.git(c, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
    expect(staged).toEqual([]);
  }, 60_000);

  it("refuses when logs/<me> is linked into another author's folder", async (ctx) => {
    const s = makeSpace();
    const c = s.clone("arun");
    mkdirSync(path.join(c, "logs", "krish"), { recursive: true });
    try {
      symlinkSync(path.join(c, "logs", "krish"), path.join(c, "logs", "arun"), "junction");
    } catch {
      return ctx.skip();
    }
    const a = s.transport("arun");
    await expect(a.appendMine([msg("arun", "x")])).rejects.toThrow(WriteRefusedError);
    expect(readAllLogs(c).events).toEqual([]);
  }, 60_000);

  it("logs stay LF and readable when a clone has core.autocrlf=true", async () => {
    const s = makeSpace();
    s.git(s.clone("krish"), "config", "core.autocrlf", "true");
    const a = s.transport("arun");
    const k = s.transport("krish");
    const ea = msg("arun", "from arun");
    const ek = msg("krish", "from krish");
    await a.appendMine([ea]);
    await a.whenIdle();
    await k.fetchNew();
    await k.appendMine([ek]);
    await k.whenIdle();

    const day = ea.ts.slice(0, 10);
    expect(readFileSync(path.join(s.clone("krish"), "logs", "arun", `${day}.jsonl`)).includes(0x0d)).toBe(false);
    const blob = s.git(s.remote, "show", `main:logs/krish/${ek.ts.slice(0, 10)}.jsonl`);
    expect(blob.includes("\r")).toBe(false);
    const r = readAllLogs(s.clone("krish"));
    expect(r.skipped).toEqual([]);
    expect(ids(r.events)).toEqual(ids([ea, ek]));
  }, 60_000);
});
