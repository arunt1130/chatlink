import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../../src/server";
import { makeSpace } from "../helpers/gitFixture";
import { tmpDir } from "../helpers/tmp";

const ROOT = path.resolve(__dirname, "..", "..");

type Manifest = {
  version: string;
  server: { entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } };
  user_config: Record<string, { type: string; required?: boolean }>;
  tools: { name: string }[];
};

/** What Claude Desktop does with a manifest: fill in ${__dirname} and ${user_config.*}. */
function substitute(s: string, dir: string, user: Record<string, string>): string {
  return s.replace(/\$\{__dirname\}/g, dir).replace(/\$\{user_config\.([a-z_]+)\}/g, (_, k: string) => user[k] ?? "");
}

describe("M4 the .mcpb bundle", { timeout: 180_000 }, () => {
  let dir = "";
  let manifest: Manifest;
  beforeAll(() => {
    // Not tmpDir(): that one is removed after each test, and the bundle is shared by this file's tests.
    dir = path.join(mkdtempSync(path.join(os.tmpdir(), "chatlink-bundle-")), "chatlink");
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "pack-mcpb.mjs"), "--stage-only", dir], { cwd: ROOT, stdio: "pipe" });
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  });

  afterAll(() => rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 5 }));

  it("has a consistent manifest: entry point exists, two required settings, all tools listed, versions match", () => {
    expect(existsSync(path.join(dir, manifest.server.entry_point))).toBe(true);
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/server.js"]);
    expect(manifest.server.mcp_config.env).toEqual({ CHATLINK_ME: "${user_config.name}", CHATLINK_REPO: "${user_config.repo}" });
    expect(manifest.user_config).toMatchObject({ name: { type: "string", required: true }, repo: { type: "directory", required: true } });
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(["add_note", "get_item", "import_transcript", "mark_status", "search", "sync_turn", "whats_new"]);
    expect(manifest.version).toBe(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
    expect(SERVER_VERSION).toBe(manifest.version);
    // Self-contained: no node_modules, no native binaries.
    expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
    expect(existsSync(path.join(dir, "server", "node-sqlite3-wasm.wasm"))).toBe(true);
    expect(existsSync(path.join(dir, "models", "potion-base-32M", "model.safetensors"))).toBe(true);
  });

  it("runs from the bundle folder as Desktop would: two people, hybrid search with the bundled model", async () => {
    const s = makeSpace();
    const start = async (me: string) => {
      const cfg = manifest.server.mcp_config;
      const user = { name: me, repo: s.clone(me) };
      const env = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, substitute(v, dir, user)]));
      const t = new StdioClientTransport({
        command: process.execPath, // Desktop substitutes its own Node for "node"
        args: cfg.args.map((a) => substitute(a, dir, user)),
        cwd: tmpDir(), // never rely on the working directory
        env: { ...process.env, ...s.env, ...env, CHATLINK_STATE_DIR: s.stateDir(me) } as Record<string, string>,
        stderr: "pipe",
      });
      const err: string[] = [];
      t.stderr?.on("data", (d) => err.push(String(d)));
      const c = new Client({ name: "desktop-sim", version: "0" });
      try {
        await c.connect(t);
      } catch (e) {
        throw new Error(`server failed to start: ${(e as Error).message}
${err.join("")}`);
      }
      return c;
    };
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);

    const krish = await start("krish");
    const k = await call(krish, "sync_turn", { message: "Caching won't help here: every query has a unique timestamp in it." });
    await krish.close(); // close waits for the background push
    await new Promise((r) => setTimeout(r, 1000));

    const arun = await start("arun");
    const a = await call(arun, "sync_turn", { message: "store responses so repeat requests are faster?" }); // no shared words: vectors only
    expect(a.sync.search_mode).toBe("hybrid");
    expect(a.relevant[0]).toMatchObject({ id: k.logged.id, author: "krish", tier: "said" });
    await arun.close();
  });
});
