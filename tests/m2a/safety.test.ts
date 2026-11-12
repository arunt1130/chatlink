import { existsSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteIndex, deleteIndexFiles, logFileFor, makeEvent, rebuildIndex } from "../../src";
import { main } from "../../src/cli";
import { makeSpace } from "../helpers/gitFixture";
import { openIndex } from "../helpers/index";
import { tmpDir } from "../helpers/tmp";

describe("M2a index never deletes or writes shared files", { timeout: 60_000 }, () => {
  it("rebuild and open refuse a log file, space.json, or any path in the repo, and delete nothing", async () => {
    const s = makeSpace();
    const arun = s.transport("arun");
    const krish = s.transport("krish");
    const a = makeEvent("arun", { kind: "message", text: "mine" });
    const k = makeEvent("krish", { kind: "message", text: "theirs" });
    await arun.appendMine([a]);
    await krish.appendMine([k]);
    await krish.whenIdle();
    await arun.fetchNew();
    await arun.whenIdle();

    const repo = s.clone("arun");
    const mine = logFileFor(repo, "arun", a.ts);
    const theirs = logFileFor(repo, "krish", k.ts);
    const space = path.join(repo, "space.json");
    const before = [mine, theirs, space].map((f) => readFileSync(f));

    for (const f of [mine, theirs, space, path.join(repo, "index.sqlite")]) {
      await expect(rebuildIndex(f, arun, { source: repo })).rejects.toThrow();
      if (!f.endsWith(".sqlite")) {
        // Even without a source, a log or space.json can never be opened or deleted as an index.
        await expect(rebuildIndex(f, arun)).rejects.toThrow(/must end in/);
        expect(() => SqliteIndex.open(f)).toThrow(/must end in/);
      }
      await expect(
        main(["rebuild", "--repo", repo, "--me", "arun", "--state", s.stateDir("arun"), "--index", f, "--no-model"], { env: s.env }),
      ).rejects.toThrow();
    }
    expect(() => deleteIndexFiles(mine)).toThrow(/non-index/);
    expect([mine, theirs, space].map((f) => readFileSync(f))).toEqual(before);
    expect(existsSync(path.join(repo, "index.sqlite"))).toBe(false);
    expect(s.git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses an index reached through a symlink or junction into the repo", (ctx) => {
    const repo = tmpDir();
    const link = path.join(tmpDir(), "state");
    try {
      symlinkSync(repo, link, "junction");
    } catch {
      ctx.skip();
    }
    expect(() => SqliteIndex.open(path.join(link, "index.sqlite"), { source: repo })).toThrow(/outside/);
    expect(existsSync(path.join(repo, "index.sqlite"))).toBe(false);
  });
});

describe("M2a search input edge cases", () => {
  it("rejects a since without a timezone; accepts a plain date as UTC", () => {
    const idx = openIndex();
    idx.ingest([makeEvent("arun", { kind: "message", text: "caching" }, { now: Date.parse("2026-11-12T10:00:00Z") })]);
    for (const bad of ["2026-11-12T10:00:00", "Nov 12 2026", "2026-11-12 10:00"]) {
      expect(() => idx.search("caching", { since: bad })).toThrow(RangeError);
    }
    expect(idx.search("caching", { since: "2026-11-12" })).toHaveLength(1);
    expect(idx.search("caching", { since: "2026-11-12T11:00:00+01:00" })).toHaveLength(1);
    expect(idx.search("caching", { since: "2026-11-12T10:00:01Z" })).toHaveLength(0);
  });

  it("truncation never splits a surrogate pair", () => {
    const idx = openIndex();
    idx.ingest([makeEvent("arun", { kind: "message", text: `caching ${"😀".repeat(50)}` })]);
    const [h] = idx.search("caching", { maxTextChars: 10 }); // "caching " is 8 units, then a pair at 8-9, 10-11
    expect(h!.truncated).toBe(true);
    expect(h!.text).toBe("caching 😀");
    const [h2] = idx.search("caching", { maxTextChars: 11 });
    expect(h2!.text).toBe("caching 😀");
  });

  it("the search command prints ranked hits from the local index", async () => {
    const s = makeSpace();
    const state = s.stateDir("arun");
    const idx = SqliteIndex.open(path.join(state, "index.sqlite"), { source: s.clone("arun") });
    const e = makeEvent("krish", { kind: "message", text: "Caching won't help here." });
    idx.ingest([e, makeEvent("arun", { kind: "message", text: "unrelated" })]);
    idx.close();
    const out: string[] = [];
    const orig = console.log;
    console.log = (x: string) => out.push(x);
    try {
      expect(await main(["search", "--repo", s.clone("arun"), "--state", state, "--no-model", "should", "we", "cache?"])).toBe(0);
    } finally {
      console.log = orig;
    }
    const hits = JSON.parse(out[0]!);
    expect(hits.map((h: { id: string }) => h.id)).toEqual([e.id]);
    expect(hits[0]).toMatchObject({ author: "krish", tier: "said", text: "Caching won't help here." });
  });
});
