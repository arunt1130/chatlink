import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvents, makeEvent, readAllLogs } from "../../src";
import { closeApp, openApp } from "../helpers/app";
import { makeSpace } from "../helpers/gitFixture";

const logLines = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) : [];

describe("M3 sync_turn guarantees", { timeout: 60_000 }, () => {
  it("logs the message verbatim, once per turn, as one commit", async () => {
    const s = makeSpace();
    const app = openApp(s, "arun");
    const before = Number(s.git(s.clone("arun"), "rev-list", "--count", "HEAD").trim());
    const msg = "  Exact text, with  spacing,\nnewlines and émoji 😀  ";
    const r = await app.syncTurn({ message: msg });
    const events = readAllLogs(s.clone("arun")).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: r.logged!.id, author: "arun", kind: "message", text: msg });
    expect(Number(s.git(s.clone("arun"), "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    expect(r.timing_ms.total).toBeGreaterThanOrEqual(0);
  });

  it("share=false (off the record) writes nothing and commits nothing, but still returns context", async () => {
    const s = makeSpace();
    const krish = openApp(s, "krish");
    await krish.syncTurn({ message: "Caching won't help here." });
    await krish.transport.whenIdle();

    const app = openApp(s, "arun");
    const head = s.git(s.clone("arun"), "rev-parse", "HEAD");
    const r = await app.syncTurn({ message: "secret: should we cache?", share: false });
    expect(r.logged).toBeNull();
    expect(r.relevant.map((i) => i.author)).toContain("krish");
    expect(logLines(path.join(s.clone("arun"), "logs", "arun"))).toEqual([]);
    // The pull may fast-forward to krish's commit, but nothing of mine was committed.
    expect(s.git(s.clone("arun"), "log", "--format=%s", `${head.trim()}..HEAD`)).not.toMatch(/arun/);
    expect(app.index.size).toBe(1);
  });

  it("an empty message logs nothing", async () => {
    const s = makeSpace();
    const r = await openApp(s, "arun").syncTurn({ message: "   " });
    expect(r.logged).toBeNull();
    expect(readAllLogs(s.clone("arun")).events).toEqual([]);
  });

  it("works offline: logs locally, says stale, counts unpushed, delivers later", async () => {
    const s = makeSpace();
    s.goOffline("arun");
    const app = openApp(s, "arun");
    const r = await app.syncTurn({ message: "offline thought" });
    await app.transport.whenIdle();
    expect(r.logged).not.toBeNull();
    expect(r.sync.stale).toBe(true);
    expect(r.sync.last_error).toMatch(/pull/);
    const st = await app.search({ query: "thought" });
    expect(st.items).toHaveLength(1); // searchable locally
    expect(st.sync.unpushed_commits).toBe(1);

    s.goOnline("arun");
    const r2 = await app.syncTurn({ message: "back online" });
    await app.transport.whenIdle();
    expect(r2.sync.stale).toBe(false);
    expect(s.remoteEvents().map((e) => (e as { text: string }).text).sort()).toEqual(["back online", "offline thought"]);
  });
});

describe("M3 whats_new and the read cursor", { timeout: 60_000 }, () => {
  it("shows others' events once, never my own, survives a restart, and pages with `more`", async () => {
    const s = makeSpace();
    const krish = openApp(s, "krish");
    for (let i = 0; i < 3; i++) await krish.syncTurn({ message: `k${i}` });
    await krish.transport.whenIdle();

    let arun = openApp(s, "arun");
    const w = await arun.whatsNew({ limit: 2 });
    expect(w.items.map((i) => i.text)).toEqual(["k0", "k1"]);
    expect(w.more).toBe(true);
    await closeApp(arun);

    arun = openApp(s, "arun"); // restart: the cursor is in the state dir
    const t = await arun.syncTurn({ message: "mine" });
    expect(t.new_from_others).toEqual({ items: [expect.objectContaining({ text: "k2" })], more: false });
    expect((await arun.whatsNew()).items).toEqual([]); // my own "mine" never shows as new
  });

  it("an event that arrives late with an old timestamp still counts as new", async () => {
    const s = makeSpace();
    const arun = openApp(s, "arun");
    await arun.syncTurn({ message: "hello" });
    expect((await arun.whatsNew()).items).toEqual([]);

    // Krish wrote this a week ago while offline; it is pushed only now.
    const old = makeEvent("krish", { kind: "message", text: "written offline last week" }, { now: Date.now() - 7 * 86_400_000 });
    appendEvents(s.clone("krish"), "krish", [old]);
    s.git(s.clone("krish"), "add", "logs");
    s.git(s.clone("krish"), "commit", "-q", "-m", "late");
    s.git(s.clone("krish"), "pull", "-q", "--rebase");
    s.git(s.clone("krish"), "push", "-q", "origin", "HEAD:refs/heads/main");

    const r = await arun.syncTurn({ message: "anything new?" });
    expect(r.new_from_others.items.map((i) => i.id)).toEqual([old.id]);
  });

  it("after an index rebuild the cursor re-anchors on time, not sequence", async () => {
    const s = makeSpace();
    const krish = openApp(s, "krish");
    await krish.syncTurn({ message: "before" });
    await krish.transport.whenIdle();
    let arun = openApp(s, "arun");
    await arun.syncTurn({ message: "mine" });
    expect((await arun.whatsNew()).items).toEqual([]); // "before" was shown by sync_turn
    await closeApp(arun);

    // Delete the index; the restarted app rebuilds it from the logs (new epoch).
    for (const f of readdirSync(s.stateDir("arun"))) if (f.startsWith("index.sqlite")) {
      (await import("node:fs")).rmSync(path.join(s.stateDir("arun"), f));
    }
    await new Promise((r) => setTimeout(r, 5));
    await krish.syncTurn({ message: "after" });
    await krish.transport.whenIdle();
    arun = openApp(s, "arun");
    const r = await arun.syncTurn({ message: "back" });
    expect(r.new_from_others.items.map((i) => i.text)).toEqual(["after"]);
  });
});

describe("M3 mark_status, add_note, get_item", { timeout: 60_000 }, () => {
  it("marks a known item; refuses bad or unknown ids and bad statuses", async () => {
    const s = makeSpace();
    const app = openApp(s, "arun");
    const r = await app.syncTurn({ message: "Use Postgres." });
    const m = await app.markStatus({ target: r.logged!.id, status: "decided", reason: "team agreed" });
    expect(m.event).toMatchObject({ author: "arun", kind: "status", tier: "confirmed", target: r.logged!.id, marks: "decided", text: "team agreed" });
    expect(app.index.resolveStatus(r.logged!.id)?.status).toBe("decided");

    await expect(app.markStatus({ target: "not-an-id", status: "closed", reason: "" })).rejects.toThrow(/event id/);
    await expect(app.markStatus({ target: "01JCXK2M9Q4E7R8T00000000AA", status: "closed", reason: "" })).rejects.toThrow(/unknown event id/);
    await expect(app.markStatus({ target: r.logged!.id, status: "maybe" as never, reason: "" })).rejects.toThrow(/status must be/);
    expect(readAllLogs(s.clone("arun")).events).toHaveLength(2); // nothing written by the refusals
  });

  it("adds a verbatim note; get_item returns full text that other tools cut", async () => {
    const s = makeSpace();
    const app = openApp(s, "arun");
    const long = `Remember: ${"x".repeat(3000)}`;
    const n = await app.addNote({ text: long });
    expect(n.event).toMatchObject({ kind: "note", tier: "confirmed", truncated: true });
    expect((await app.getItem({ id: n.event.id })).item).toMatchObject({ text: long, truncated: false });
    expect((await app.getItem({ id: "01JCXK2M9Q4E7R8T00000000AA" })).item).toBeNull();
    await expect(app.addNote({ text: "  " })).rejects.toThrow(/empty/);
  });
});
