import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { makeSpace } from "../helpers/gitFixture";

const ROOT = path.resolve(__dirname, "..", "..");
const SERVER = path.join(ROOT, "dist", "server.js");

describe("M3 the built server over stdio", { timeout: 120_000 }, () => {
  beforeAll(() => {
    // Build exactly what Claude Desktop runs (local esbuild, no network).
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { cwd: ROOT });
  });

  it("starts, speaks MCP on stdout only, syncs a turn, and exits cleanly when stdin closes", async () => {
    const s = makeSpace();
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: ROOT,
      env: { ...process.env, ...s.env, CHATLINK_ME: "arun", CHATLINK_REPO: s.clone("arun"), CHATLINK_STATE_DIR: s.stateDir("arun"), CHATLINK_MODEL_DIR: "none" } as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d) => stderr.push(String(d)));
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport); // a stray stdout write would break this handshake

    expect(client.getServerVersion()?.name).toBe("chatlink");
    const r = (await client.callTool({ name: "sync_turn", arguments: { message: "hello from stdio" } })) as { content: { text: string }[] };
    const body = JSON.parse(r.content[0]!.text);
    expect(body.logged.id).toBeTruthy();
    expect(body.sync.search_mode).toBe("keyword-only");
    await client.close();
    await new Promise((res) => setTimeout(res, 500));
    expect(stderr.join("")).toContain("[chatlink] me=arun");
    expect(s.git(s.clone("arun"), "log", "-1", "--format=%s")).toMatch(/chatlink: arun \+1 event/);
  });

  it("exits with a clear message on bad config", () => {
    let out = "";
    try {
      execFileSync(process.execPath, [SERVER], { env: { ...process.env, CHATLINK_ME: "Bad Name", CHATLINK_REPO: ROOT }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out = String((e as { stderr: Buffer }).stderr);
      expect((e as { status: number }).status).toBe(1);
    }
    expect(out).toMatch(/config error: invalid name/);
  });
});
