import { describe, expect, it } from "vitest";
import { type Event, appendEvents, makeEvent, readAllLogs } from "../../src";
import { ids } from "../helpers/events";
import { makeSpace } from "../helpers/gitFixture";

const msg = (author: string, text: string) => makeEvent(author, { kind: "message", text });

describe("M1 offline queue", () => {
  it("offline writes are queued, readable locally, and delivered once back online (after a restart)", async () => {
    const s = makeSpace();
    const k = s.transport("krish");
    s.goOffline("arun");
    const a = s.transport("arun");

    const written: Event[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await a.fetchNew();
      expect(f.sync.stale).toBe(true);
      const e = msg("arun", `offline ${i}`);
      written.push(e);
      const r = await a.appendMine([e]);
      expect(r).toEqual({ written: 1, committed: true });
      await a.whenIdle();
    }
    const st = await a.syncState();
    expect(st.stale).toBe(true);
    expect(st.unpushed).toBe(3);
    expect(st.lastPullAt).toBeNull();
    expect(st.lastError).toMatch(/pull/);
    expect(ids(readAllLogs(s.clone("arun")).events)).toEqual(ids(written)); // durable locally
    expect((await k.fetchNew()).events).toEqual([]);

    // Simulated restart: a new transport on the same clone and state dir, now online.
    s.goOnline("arun");
    const a2 = s.transport("arun");
    const f = await a2.fetchNew();
    expect(f.sync.stale).toBe(false);
    expect(f.sync.lastPullAt).not.toBeNull();
    await a2.whenIdle();
    expect((await a2.syncState()).unpushed).toBe(0);

    const seen = await k.fetchNew();
    expect(ids(seen.events)).toEqual(ids(written));
    expect(ids(s.remoteEvents())).toEqual(ids(written));
  }, 60_000);

  it("lastPullAt survives a restart, and stale is reported again when offline", async () => {
    const s = makeSpace();
    const a = s.transport("arun");
    const first = await a.fetchNew();
    expect(first.sync.stale).toBe(false);
    s.goOffline("arun");
    const a2 = s.transport("arun");
    const f = await a2.fetchNew();
    expect(f.sync.stale).toBe(true);
    expect(f.sync.lastPullAt).toBe(first.sync.lastPullAt);
  }, 60_000);

  it("crash recovery: an event written but not committed is committed and delivered on the next cycle", async () => {
    const s = makeSpace();
    const e = msg("arun", "written just before a crash");
    appendEvents(s.clone("arun"), "arun", [e]); // on disk, never committed
    const a = s.transport("arun");
    await a.fetchNew();
    await a.whenIdle();
    expect(s.git(s.clone("arun"), "status", "--porcelain", "--", "logs").trim()).toBe("");
    expect(ids(s.remoteEvents())).toEqual([e.id]);
  }, 60_000);

  it("fetchNew with a cursor returns only events from files changed since then", async () => {
    const s = makeSpace();
    const a = s.transport("arun");
    const k = s.transport("krish");
    const ea = msg("arun", "a1");
    await a.appendMine([ea]);
    await a.whenIdle();

    const f1 = await k.fetchNew();
    expect(ids(f1.events)).toEqual([ea.id]);
    const f2 = await k.fetchNew(f1.cursor);
    expect(f2.events).toEqual([]);

    const ea2 = makeEvent("arun", { kind: "message", text: "next day" }, { now: Date.parse(ea.ts) + 86_400_000 });
    await a.appendMine([ea2]);
    await a.whenIdle();
    const f3 = await k.fetchNew(f2.cursor);
    expect(ids(f3.events)).toEqual([ea2.id]); // only the new day file changed

    const all = await k.fetchNew("not-a-commit");
    expect(ids(all.events)).toEqual(ids([ea, ea2]));
  }, 60_000);
});
