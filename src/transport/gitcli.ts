import { spawn } from "node:child_process";

export type ProcResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type RunOpts = { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
export type GitRunner = (args: string[], opts: RunOpts) => Promise<ProcResult>;

/** Kills a process and everything it started (git spawns ssh/https helpers). */
/** Resolves once the kill has been carried out (taskkill exited), or after 5 s. */
function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL"); // whole process group (child is spawned detached); synchronous
    } catch {
      /* already gone */
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const cap = setTimeout(resolve, 5000);
    cap.unref();
    const done = () => {
      clearTimeout(cap);
      resolve();
    };
    try {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      tk.on("error", done);
      tk.on("exit", done);
    } catch {
      done();
    }
  });
}

/**
 * Runs a command without a shell. Never rejects. On timeout the process tree
 * is killed and the result comes back promptly with timedOut=true.
 */
export function runProcess(cmd: string, args: string[], opts: RunOpts): Promise<ProcResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      err.push(Buffer.from(String(e)));
      return finish(null);
    }
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      err.push(Buffer.from(String(e)));
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        // Wait for the kill itself (so callers can safely clean up after it),
        // but not for a grandchild that keeps the pipes open.
        void killTree(child.pid).then(() => setTimeout(() => finish(null), 200).unref());
      }, opts.timeoutMs);
    }
  });
}

/** git with prompts disabled, so a missing credential fails instead of hanging. */
export const runGit: GitRunner = (args, opts) =>
  runProcess("git", args, {
    ...opts,
    env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
