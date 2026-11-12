import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Event, GitTransport, type GitRunner, type ProcResult, makeEvent, readAllLogs, runGit, runProcess } from "../../src";
import { ids } from "../helpers/events";
import { makeSpace } from "../helpers/gitFixture";

const msg = (author: string, text: string) => makeEvent(author, { kind: "message", text });
const isCommit = (args: string[]) => args.includes("commit") && args.includes("--no-verify");

describe("M1 robustness", () => {
  it("a turn that arrives during a hung push still returns promptly", async () => {
    const s = makeSpace();
    let release!: () => void;
    let hung = false;
    const hangFirstPush: GitRunner = (args, opts) => {
      if (args[0] === "push" && !hung) {
        hung = true;
        return new Promise<ProcResult>((res) => {
          release = () => res({ code: 128, stdout: "", stderr: "fatal: unable to access", timedOut: false });
        });
      }
      return runGit(args, opts);
    };
    const a = s.transport("arun", { runGit: hangFirstPush });
    const e1 = msg("arun", "first");
    await a.appendMine([e1]); // starts the push, which hangs
    for (let i = 0; i < 100 && !hung; i++) await new Promise((r) => setTimeout(r, 100));
    expect(hung).toBe(true);

    const t0 = Date.now();
    const f = await a.fetchNew();
    const e2 = msg("arun", "second");
    await a.appendMine([e2]);
    const st = await a.syncState();
    expect(Date.now() - t0).toBeLessThan(8000); // local git only; nowhere near "until the push gives up"
    expect(f.sync.stale).toBe(false);
    expect(st.unpushed).toBe(2);

    release();
    await a.whenIdle();
    expect((await a.syncState()).unpushed).toBe(0);
    expect(ids(s.remoteEvents())).toEqual(ids([e1, e2]));
  }, 60_000);

  it("a timed-out pull removes the lock files the killed git left behind", async () => {
    const s = makeSpace();
    const gitDir = path.join(s.clone("arun"), ".git");
    const hangingPull: GitRunner = (args, opts) => {
      if (args[0] !== "pull") return runGit(args, opts);
      // Simulate git dying mid-update: it took locks, then hung.
      writeFileSync(path.join(gitDir, "index.lock"), "");
      mkdirSync(path.join(gitDir, "refs", "remotes", "origin"), { recursive: true });
      writeFileSync(path.join(gitDir, "refs", "remotes", "origin", "main.lock"), "");
      writeFileSync(path.join(gitDir, "ORIG_HEAD.lock"), "");
      return runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    };
    const a = s.transport("arun", { runGit: hangingPull, pullTimeoutMs: 300 });
    const f = await a.fetchNew();
    expect(f.sync.stale).toBe(true);
    expect(existsSync(path.join(gitDir, "index.lock"))).toBe(false);
    expect(existsSync(path.join(gitDir, "refs", "remotes", "origin", "main.lock"))).toBe(false);
    expect(existsSync(path.join(gitDir, "ORIG_HEAD.lock"))).toBe(false);

    // The clone works normally afterwards.
    const a2 = s.transport("arun");
    expect((await a2.fetchNew()).sync.stale).toBe(false);
    await a2.appendMine([msg("arun", "after")]);
    await a2.whenIdle();
    expect((await a2.syncState()).unpushed).toBe(0);
  }, 60_000);

  it("a failed commit keeps the events on disk, doesn't throw, is reported, and is committed next cycle", async () => {
    const s = makeSpace();
    let failNext = true;
    const failOnce: GitRunner = (args, opts) => {
      if (isCommit(args) && failNext) {
        failNext = false;
        return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: Unable to create 'index.lock': File exists.", timedOut: false });
      }
      return runGit(args, opts);
    };
    const a = s.transport("arun", { runGit: failOnce });
    const e = msg("arun", "survives a failed commit");
    const r = await a.appendMine([e]);
    expect(r).toEqual({ written: 1, committed: false });
    const st = await a.syncState();
    expect(st.uncommitted).toBe(true);
    expect(st.lastError).toMatch(/commit failed/);
    expect(ids(readAllLogs(s.clone("arun")).events)).toEqual([e.id]);

    const f = await a.fetchNew(); // recovery commit, then push
    expect(f.sync.uncommitted).toBe(false);
    await a.whenIdle();
    expect(ids(s.remoteEvents())).toEqual([e.id]);
  }, 60_000);

  it("if a commit ever includes a path outside logs/<me>/, it is undone and nothing outside is delivered", async () => {
    const s = makeSpace();
    const c = s.clone("arun");
    let trip = true;
    const sneaky: GitRunner = async (args, opts) => {
      if (isCommit(args) && trip) {
        trip = false;
        // Something else got staged and the commit ignored our pathspec.
        writeFileSync(path.join(c, "space.json"), '{"hijacked":true}\n');
        await runGit(["add", "space.json"], opts);
        return runGit(args.slice(0, args.indexOf("--")), opts);
      }
      return runGit(args, opts);
    };
    const a = s.transport("arun", { runGit: sneaky });
    const head0 = s.git(c, "rev-parse", "HEAD").trim();
    const e = msg("arun", "x");
    const r = await a.appendMine([e]);
    expect(r.committed).toBe(false);
    expect(s.git(c, "rev-parse", "HEAD").trim()).toBe(head0); // commit undone
    expect((await a.syncState()).lastError).toMatch(/refusing to commit outside logs\/arun\//);

    await a.fetchNew(); // recovery commits only logs/arun
    await a.whenIdle();
    expect(s.git(s.remote, "show", "main:space.json")).not.toMatch(/hijacked/);
    expect(ids(s.remoteEvents())).toEqual([e.id]);
  }, 60_000);

  it("commit once per turn: N events in one appendMine make one commit", async () => {
    const s = makeSpace();
    const a = s.transport("arun");
    const before = Number(s.git(s.clone("arun"), "rev-list", "--count", "HEAD").trim());
    const evs: Event[] = [msg("arun", "1"), msg("arun", "2"), msg("arun", "3")];
    evs.push(makeEvent("arun", { kind: "note", text: "other day" }, { now: Date.parse(evs[0]!.ts) + 86_400_000 }));
    await a.appendMine(evs);
    await a.whenIdle();
    expect(Number(s.git(s.clone("arun"), "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    expect(ids(s.remoteEvents())).toEqual(ids(evs));
  }, 60_000);

  it("an empty remote (unborn HEAD) degrades to local data, then the first push creates the branch", async () => {
    const s = makeSpace();
    const remote = path.join(s.base, "empty.git");
    s.git(s.base, "init", "-q", "--bare", "-b", "main", remote);
    const c = path.join(s.base, "empty-clone");
    s.git(s.base, "clone", "-q", remote, c);
    const a = new GitTransport({ me: "arun", repoPath: c, stateDir: path.join(s.base, "state-empty"), env: s.env });

    const f0 = await a.fetchNew();
    expect(f0.events).toEqual([]);
    expect(f0.cursor).toBe("");
    const e = msg("arun", "first ever");
    expect((await a.appendMine([e])).committed).toBe(true);
    await a.whenIdle();
    expect(s.git(remote, "ls-tree", "-r", "--name-only", "main").trim()).toBe(`logs/arun/${e.ts.slice(0, 10)}.jsonl`);
    const f1 = await a.fetchNew();
    expect(f1.sync.stale).toBe(false);
    expect(f1.sync.unpushed).toBe(0);
  }, 60_000);

  it("a forged commit into my folder makes pulls fail (stale) but loses nothing and leaves no rebase behind", async () => {
    const s = makeSpace();
    const a = s.transport("arun");
    const mine = msg("arun", "mine, unpushed");
    s.goOffline("arun");
    await a.appendMine([mine]);
    await a.whenIdle();
    s.goOnline("arun");

    // krish writes into logs/arun/ directly with plain git (bypassing chatlink).
    const kc = s.clone("krish");
    const day = mine.ts.slice(0, 10);
    mkdirSync(path.join(kc, "logs", "arun"), { recursive: true });
    writeFileSync(path.join(kc, "logs", "arun", `${day}.jsonl`), JSON.stringify(msg("arun", "forged")) + "\n");
    s.git(kc, "add", "-A");
    s.git(kc, "commit", "-q", "-m", "forged");
    s.git(kc, "push", "-q", "origin", "HEAD:refs/heads/main");

    const f = await a.fetchNew();
    await a.whenIdle();
    expect(f.sync.stale).toBe(true);
    expect(existsSync(path.join(s.clone("arun"), ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(path.join(s.clone("arun"), ".git", "rebase-apply"))).toBe(false);
    expect(ids(readAllLogs(s.clone("arun")).events)).toEqual([mine.id]);
    expect((await a.syncState()).unpushed).toBe(1);
  }, 60_000);
});
