import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Chatlink } from "../../src";
import { createServer } from "../../src/server";
import { openApp } from "../helpers/app";
import { makeSpace } from "../helpers/gitFixture";
import { realModel } from "../helpers/model";

/** An MCP client talking to a chatlink server in-process. */
async function connect(app: Chatlink): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(app);
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  if (r.isError) throw new Error(r.content[0]!.text);
  return JSON.parse(r.content[0]!.text);
}

const KRISH = "Caching won't help here: every query has a unique timestamp in it.";

describe("M3 end to end over MCP, two users", { timeout: 120_000 }, () => {
  it("Krish says caching won't help; Arun asks about caching and gets Krish's own words, with name and date", async () => {
    const s = makeSpace();
    const krishApp = openApp(s, "krish", { embedder: realModel() });
    const krish = await connect(krishApp);
    const arunApp = openApp(s, "arun", { embedder: realModel() });
    const arun = await connect(arunApp);

    const k = await call(krish, "sync_turn", { message: KRISH });
    expect(k.logged.id).toMatch(/^[0-9A-Z]{26}$/);
    await krishApp.transport.whenIdle(); // Krish's push runs in the background; let it land

    const a = await call(arun, "sync_turn", { message: "Should we cache the query results to speed things up?" });
    const top = a.relevant[0];
    expect(top).toMatchObject({ author: "krish", kind: "message", tier: "said", text: KRISH, id: k.logged.id, ts: k.logged.ts });
    expect(a.new_from_others.items.map((i: { id: string }) => i.id)).toEqual([k.logged.id]);
    expect(a.sync).toMatchObject({ stale: false, search_mode: "hybrid" });
    expect(a.possible_decision).toBeNull(); // a question isn't a decision

    // Seen once: the next turn doesn't repeat it as new.
    const a2 = await call(arun, "sync_turn", { message: "ok, thinking about it" });
    expect(a2.new_from_others.items).toEqual([]);

    // Arun closes it; Krish's next turn shows it as confirmed closed by Arun.
    const a3 = await call(arun, "sync_turn", { message: "Agreed, let's drop the caching idea." });
    expect(a3.possible_decision).toMatchObject({ status: "closed", target: k.logged.id });
    expect(a3.possible_decision.ask).toMatch(/^Mark "Caching won't help here.*" as closed\?$/);
    await call(arun, "mark_status", { target: a3.possible_decision.target, status: "closed", reason: "unique timestamps" });
    await arunApp.transport.whenIdle();
    const kt = await call(krish, "sync_turn", { message: "What did we conclude about caching?" });
    const item = kt.relevant.find((i: { id: string }) => i.id === k.logged.id);
    expect(item.status).toMatchObject({ author: "arun", status: "closed", reason: "unique timestamps" });
    // Arun's status mark reaches Krish as new, confirmed, and pointing at his message.
    expect(kt.new_from_others.items).toContainEqual(expect.objectContaining({ kind: "status", tier: "confirmed", target: k.logged.id, marks: "closed" }));
  });

  it("lists the five SPEC tools plus get_item and import_transcript, and the catch_me_up prompt runs whats_new", async () => {
    const s = makeSpace();
    const krishApp = openApp(s, "krish");
    const krish = await connect(krishApp);
    const arun = await connect(openApp(s, "arun"));
    const tools = (await arun.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["add_note", "get_item", "import_transcript", "mark_status", "search", "sync_turn", "whats_new"]);
    const st = tools.find((t) => t.name === "sync_turn")!;
    expect(st.description).toMatch(/START of EVERY reply, BEFORE answering/);
    expect(st.description).toMatch(/verbatim/);
    expect(st.inputSchema.required).toEqual(["message"]);

    await call(krish, "add_note", { text: "Deploys are frozen until Monday." });
    await krishApp.transport.whenIdle();
    const prompts = (await arun.listPrompts()).prompts;
    expect(prompts.map((p) => p.name)).toEqual(["catch_me_up"]);
    const p = await arun.getPrompt({ name: "catch_me_up" });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain("Deploys are frozen until Monday.");
    expect(text).toContain('"author": "krish"');
    // It advanced the cursor: a second catch-up has nothing new.
    expect((await call(arun, "whats_new", {})).items).toEqual([]);
  });
});
