import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Event, GitTransport, type GitTransportConfig, SHARED_GITATTRIBUTES, SHARED_GITIGNORE, readAllLogs } from "../../src";
import { tmpDir } from "./tmp";

/**
 * A local bare repo stands in for GitHub; one clone per person stands in for
 * each machine. Hermetic: no global/system git config, file-path remote, no network.
 */
export type Space = {
  base: string;
  remote: string;
  env: NodeJS.ProcessEnv;
  clone(name: string): string;
  stateDir(name: string): string;
  transport(name: string, extra?: Partial<GitTransportConfig>): GitTransport;
  git(cwd: string, ...args: string[]): string;
  goOffline(name: string): void;
  goOnline(name: string): void;
  /** Events on the remote, via a fresh clone. */
  remoteEvents(): Event[];
};

export function makeSpace(names: string[] = ["arun", "krish"]): Space {
  const base = tmpDir("chatlink-space-");
  const gitconfig = path.join(base, "gitconfig");
  writeFileSync(
    gitconfig,
    [
      "[user]",
      "\tname = Test",
      "\temail = test@example.invalid",
      "[commit]",
      "\tgpgsign = false",
      "[core]",
      "\tautocrlf = false",
      "[init]",
      "\tdefaultBranch = main",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const remote = path.join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = path.join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  writeFileSync(path.join(seed, ".gitignore"), SHARED_GITIGNORE);
  writeFileSync(path.join(seed, ".gitattributes"), SHARED_GITATTRIBUTES);
  writeFileSync(
    path.join(seed, "space.json"),
    JSON.stringify({ v: 1, members: Object.fromEntries(names.map((n) => [n, { display: n }])) }, null, 2) + "\n",
  );
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "space setup");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");

  const clones: Record<string, string> = {};
  for (const n of names) {
    clones[n] = path.join(base, "clones", n);
    mkdirSync(path.dirname(clones[n]!), { recursive: true });
    git(base, "clone", "-q", remote, clones[n]!);
  }
  const clone = (n: string) => {
    const c = clones[n];
    if (!c) throw new Error(`no clone for ${n}`);
    return c;
  };
  const stateDir = (n: string) => path.join(base, "state", n);
  let fresh = 0;

  return {
    base,
    remote,
    env,
    clone,
    stateDir,
    git,
    transport: (n, extra = {}) =>
      new GitTransport({ me: n, repoPath: clone(n), stateDir: stateDir(n), env, backoffMs: 20, ...extra }),
    goOffline: (n) => git(clone(n), "remote", "set-url", "origin", path.join(base, "missing", "remote.git")),
    goOnline: (n) => git(clone(n), "remote", "set-url", "origin", remote),
    remoteEvents: () => {
      const dir = path.join(base, `check-${fresh++}`);
      git(base, "clone", "-q", remote, dir);
      return readAllLogs(dir).events;
    },
  };
}
