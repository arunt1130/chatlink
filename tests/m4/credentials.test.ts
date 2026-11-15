import { describe, expect, it } from "vitest";
import { type GitRunner, credentialHint, makeEvent, runGit } from "../../src";
import { makeSpace } from "../helpers/gitFixture";

const GCM_REFUSED = "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled";

describe("M4 sign-in failures are reported, not hidden", { timeout: 60_000 }, () => {
  it("recognises credential-prompt failures and says how to fix them", () => {
    const h = credentialHint(`push ${GCM_REFUSED.split("\n")[0]}`, "C:/space");
    expect(h).toMatch(/more than one GitHub account/);
    expect(h).toContain(`git -C "C:/space" config credential.https://github.com.username`);
    expect(credentialHint("push ! [rejected] main -> main (fetch first)", "C:/space")).toBeNull();
    expect(credentialHint("pull timed out", "C:/space")).toBeNull();
  });

  it("a failed push stays visible even when the retry pull fails too (empty or unreachable remote)", async () => {
    const s = makeSpace(["arun"]);
    // Push can't sign in; the pull before the retry fails as well (as on a brand-new empty repo).
    const git: GitRunner = async (args, opts) => {
      if (args[0] === "push") return { code: 128, stdout: "", stderr: GCM_REFUSED, timedOut: false };
      if (args[0] === "pull") return { code: 1, stdout: "", stderr: "Your configuration specifies to merge with the ref 'refs/heads/main'", timedOut: false };
      return runGit(args, opts);
    };
    const t = s.transport("arun", { runGit: git });
    await t.appendMine([makeEvent("arun", { kind: "message", text: "hi" })]);
    await t.whenIdle();
    const st = await t.syncState();
    expect(st.unpushed).toBe(1); // still queued, never lost
    expect(st.lastError).toMatch(/^push fatal: Cannot prompt/);
    expect(st.lastError).toMatch(/the pull before retrying failed too: pull Your configuration specifies/);
    expect(st.lastError).toMatch(/more than one GitHub account/);
  });
});
