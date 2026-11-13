import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Chatlink } from "../../src";
import { DESCRIPTIONS, createServer } from "../../src/server";
import { appConfig, closeApp, openApp } from "../helpers/app";
import { makeSpace } from "../helpers/gitFixture";

const deleteIndex = (dir: string) => {
  for (const f of readdirSync(dir)) if (f.startsWith("index.sqlite")) rmSync(path.join(dir, f));
};

describe("M3 read cursor after a rebuild (author-folder ingest order)", { timeout: 90_000 }, () => {
  it.each([
    ["krish", ["arun", "krish"]],
    ["arun", ["arun", "bob", "krish"]],
    ["bob", ["arun", "bob", "krish"]],
  ])("me=%s with %j: new events from every other author still show, old ones don't", async (me, names) => {
    const s = makeSpace(names);
    const others = names.filter((n) => n !== me);
    const apps = Object.fromEntries(others.map((n) => [n, openApp(s, n)]));
    // Everyone has history, including me.
    for (const n of others) {
      await apps[n]!.syncTurn({ message: `${n} old` });
      await apps[n]!.transport.whenIdle();
    }
    let mine = openApp(s, me);
    await mine.syncTurn({ message: `${me} old` });
    await mine.whatsNew();
    expect((await mine.whatsNew()).items).toEqual([]);
    await closeApp(mine);

    // Index deleted (upgrade, corruption, `chatlink rebuild`); others keep talking.
    deleteIndex(s.stateDir(me));
    await new Promise((r) => setTimeout(r, 5));
    for (const n of others) {
      await apps[n]!.syncTurn({ message: `${n} new` });
      await apps[n]!.transport.whenIdle();
    }
    mine = openApp(s, me);
    const r = await mine.syncTurn({ message: `${me} back` });
    expect(r.new_from_others.items.map((i) => i.text).sort()).toEqual(others.map((n) => `${n} new`).sort());
    expect((await mine.whatsNew()).items).toEqual([]);

    // And after the rebuild, normal sequence-based tracking resumes.
    await apps[others[0]!]!.syncTurn({ message: "later" });
    await apps[others[0]!]!.transport.whenIdle();
    expect((await mine.syncTurn({ message: "again" })).new_from_others.items.map((i) => i.text)).toEqual(["later"]);
  });
});

describe("M3 review follow-ups", { timeout: 60_000 }, () => {
  it("off the record never suggests a decision", async () => {
    const s = makeSpace();
    const krish = openApp(s, "krish");
    await krish.syncTurn({ message: "Caching won't help here." });
    await krish.transport.whenIdle();
    const r = await openApp(s, "arun").syncTurn({ message: "Let's drop the caching idea.", share: false });
    expect(r.logged).toBeNull();
    expect(r.possible_decision).toBeNull();
  });

  it("every tool result carries sync state", async () => {
    const s = makeSpace();
    const app = openApp(s, "arun");
    const t = await app.syncTurn({ message: "hello" });
    const results = [t, await app.search({ query: "hello" }), await app.whatsNew(), await app.addNote({ text: "n" }), await app.markStatus({ target: t.logged!.id, status: "decided", reason: "r" })];
    for (const r of results) {
      expect(r.sync).toEqual(expect.objectContaining({ last_pull_at: expect.any(String), stale: false, unpushed_commits: expect.any(Number), search_mode: "keyword-only" }));
    }
  });

  it("refuses a state dir or index inside the clone", () => {
    const s = makeSpace();
    expect(() => Chatlink.open(appConfig(s, "arun", { stateDir: path.join(s.clone("arun"), ".chatlink") }), { embedder: null })).toThrow(/outside/);
    expect(() => Chatlink.open(appConfig(s, "arun", { indexFile: path.join(s.clone("arun"), "i.sqlite") }), { embedder: null })).toThrow(/outside/);
  });

  it("the sync_turn description carries the behaviour rules", () => {
    const d = DESCRIPTIONS.sync_turn;
    expect(d).toMatch(/START of EVERY reply, BEFORE answering/);
    expect(d).toMatch(/verbatim/);
    expect(d).toMatch(/name them, give the date, and quote their own words/);
    expect(d).toMatch(/share=false/);
    expect(d).toMatch(/stale/);
  });

  it("catch_me_up mentions staleness and more items when relevant", async () => {
    const s = makeSpace();
    const krish = openApp(s, "krish");
    for (let i = 0; i < 3; i++) await krish.syncTurn({ message: `k${i}` });
    await krish.transport.whenIdle();
    s.goOffline("arun");
    const app = openApp(s, "arun");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(app).connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    const text = ((await c.getPrompt({ name: "catch_me_up" })).messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/sync is stale/);
    // Offline and never pulled: nothing of krish's is local yet, and it says so rather than inventing.
    expect(text).toMatch(/If there is nothing new, say so/);
  });
});
