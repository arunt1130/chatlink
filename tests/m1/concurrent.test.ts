import { describe, expect, it } from "vitest";
import { type Event, type GitRunner, makeEvent, readAllLogs, runGit } from "../../src";
import { ids } from "../helpers/events";
import { makeSpace } from "../helpers/gitFixture";

const msg = (author: string, text: string) => makeEvent(author, { kind: "message", text });

describe("M1 concurrent push", () => {
  it("two users write and push at the same moment; both succeed with no lost events (20 rounds)", async () => {
    const s = makeSpace();
    const a = s.transport("arun");
    const k = s.transport("krish");
    const written: Event[] = [];
    for (let i = 0; i < 20; i++) {
      const ea = msg("arun", `arun ${i}`);
      const ek = msg("krish", `krish ${i}`);
      written.push(ea, ek);
      await Promise.all([a.appendMine([ea]), k.appendMine([ek])]);
      await Promise.all([a.whenIdle(), k.whenIdle()]);
    }
    expect((await a.syncState()).unpushed).toBe(0);
    expect((await k.syncState()).unpushed).toBe(0);
    expect(ids(s.remoteEvents())).toEqual(ids(written));

    await a.fetchNew();
    await k.fetchNew();
    expect(ids(readAllLogs(s.clone("arun")).events)).toEqual(ids(written));
    expect(ids(readAllLogs(s.clone("krish")).events)).toEqual(ids(written));
  }, 120_000);

  it("a rejected (non-fast-forward) push pulls and retries until delivered", async () => {
    const s = makeSpace();
    let arunPushes = 0;
    const counting: GitRunner = (args, opts) => {
      if (args[0] === "push") arunPushes++;
      return runGit(args, opts);
    };
    const a = s.transport("arun", { runGit: counting });
    const k = s.transport("krish");

    const ek = msg("krish", "krish first");
    await k.appendMine([ek]);
    await k.whenIdle();
    // arun has not pulled krish's commit, so arun's first push must be rejected.
    const ea = msg("arun", "arun second");
    await a.appendMine([ea]);
    await a.whenIdle();

    expect(arunPushes).toBe(2);
    expect((await a.syncState()).unpushed).toBe(0);
    expect(ids(s.remoteEvents())).toEqual(ids([ek, ea]));
  }, 60_000);

  it("retries are bounded: a push that keeps failing stops and stays queued", async () => {
    const s = makeSpace();
    let pushes = 0;
    const failingPush: GitRunner = (args, opts) => {
      if (args[0] === "push") {
        pushes++;
        return Promise.resolve({ code: 1, stdout: "", stderr: "! [rejected] (fetch first)", timedOut: false });
      }
      return runGit(args, opts);
    };
    const a = s.transport("arun", { runGit: failingPush, pushAttempts: 3 });
    await a.appendMine([msg("arun", "x")]);
    await a.whenIdle();
    expect(pushes).toBe(3);
    const st = await a.syncState();
    expect(st.unpushed).toBe(1);
    expect(st.lastError).toMatch(/push/);
  }, 60_000);
});
