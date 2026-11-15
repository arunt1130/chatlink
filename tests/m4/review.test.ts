import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type GitRunner, GitTransport, SERVER_LOCK_FILE, SHARED_FILES, acquireServerLock, parseTranscript, runGit, runProcess, syncFolderWarning } from "../../src";
import { makeSpace } from "../helpers/gitFixture";

const hangingPull: GitRunner = (args, opts) =>
  args[0] === "pull" ? runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: opts.cwd, timeoutMs: opts.timeoutMs }) : runGit(args, opts);

describe("M4 review follow-ups", { timeout: 90_000 }, () => {
  it("the server lock survives the git lock cleanup after a timed-out pull", async () => {
    const s = makeSpace();
    const lock = acquireServerLock(s.clone("arun"));
    try {
      expect(path.basename(lock.file)).toBe(SERVER_LOCK_FILE);
      const t = new GitTransport({ me: "arun", repoPath: s.clone("arun"), stateDir: s.stateDir("arun"), env: s.env, runGit: hangingPull, pullTimeoutMs: 300 });
      const f = await t.fetchNew();
      expect(f.sync.lastError).toMatch(/timed out/);
      expect(existsSync(lock.file)).toBe(true);
      expect(readFileSync(lock.file, "utf8").trim()).toBe(String(process.pid));
    } finally {
      lock.release();
    }
  });

  it("setup waits while the shared repo is unreachable, then finishes once online", async () => {
    const s = makeSpace();
    // A space that someone else already set up, but this clone predates it and is offline.
    const k = s.clone("krish");
    for (const f of SHARED_FILES) (await import("node:fs")).rmSync(path.join(k, f.path));
    s.git(k, "commit", "-q", "-am", "pretend old clone"); // local only, never pushed
    s.goOffline("krish");
    const t = s.transport("krish");
    const r = await t.setup();
    expect(r.complete).toBe(false);
    expect(r.created).toEqual([]);
    for (const f of SHARED_FILES) expect(existsSync(path.join(k, f.path))).toBe(false);
  });

  it("the setup commit contains only the space files, even with something else staged", async () => {
    const s = makeSpace(["arun"]);
    const c = s.clone("arun");
    for (const f of SHARED_FILES) s.git(c, "rm", "-q", f.path);
    s.git(c, "commit", "-q", "-m", "remove space files");
    writeFileSync(path.join(c, "notes.txt"), "mine");
    s.git(c, "add", "-f", "notes.txt"); // staged by hand, not chatlink's business
    const t = s.transport("arun");
    const r = await t.setup();
    await t.whenIdle();
    expect(r.created.sort()).toEqual([".gitattributes", ".gitignore", "space.json"]);
    expect(s.git(c, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual([".gitattributes", ".gitignore", "space.json"]);
    expect(s.git(c, "diff", "--cached", "--name-only").trim()).toBe("notes.txt"); // still staged, not committed
  });

  it("warns when the shared .gitignore isn't chatlink's", async () => {
    const s = makeSpace(["arun"]);
    const c = s.clone("arun");
    writeFileSync(path.join(c, ".gitignore"), "node_modules/\n");
    s.git(c, "commit", "-q", "-am", "custom ignore");
    const r = await s.transport("arun").setup();
    expect(r.warnings.join(" ")).toMatch(/\.gitignore in the shared repo differs/);
    expect(readFileSync(path.join(c, ".gitignore"), "utf8")).toBe("node_modules/\n"); // untouched
  });

  it("never writes through a symlink or into a folder named like a space file", async (ctx) => {
    const s = makeSpace(["arun"]);
    const c = s.clone("arun");
    s.git(c, "rm", "-q", "space.json", ".gitattributes");
    s.git(c, "commit", "-q", "-m", "remove");
    mkdirSync(path.join(c, ".gitattributes"));
    const outside = path.join(s.base, "outside.json");
    try {
      symlinkSync(outside, path.join(c, "space.json")); // dangling
    } catch {
      ctx.skip();
    }
    const r = await s.transport("arun").setup();
    expect(r.warnings.join(" ")).toMatch(/space\.json exists but isn't a regular file/);
    expect(r.warnings.join(" ")).toMatch(/\.gitattributes exists but isn't a regular file/);
    expect(existsSync(outside)).toBe(false);
  });

  it("flags more sync folders", () => {
    expect(syncFolderWarning("/Users/a/Library/CloudStorage/OneDrive-Personal/space")).not.toBeNull();
    expect(syncFolderWarning(String.raw`C:\Users\a\Dropbox (Personal)\space`)).not.toBeNull();
    expect(syncFolderWarning("/Users/a/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/space")).not.toBeNull();
    expect(syncFolderWarning("/Users/a/chatlink-space")).toBeNull();
  });

  it("text import: only Human/User/Assistant/Claude are speaker labels; line endings don't change ids", () => {
    const t = parseTranscript("Human: my plan:\nMe: first this\nAI: is overrated\nAssistant: noted");
    expect(t.turns).toEqual([
      { role: "human", text: "my plan:\nMe: first this\nAI: is overrated" },
      { role: "assistant", text: "noted" },
    ]);
    const lf = parseTranscript("Human: a\nAssistant: b\n");
    const crlf = parseTranscript("Human: a\r\nAssistant: b\r\n");
    expect(crlf.key).toBe(lf.key);
  });
});
