import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ImportError, importEvents, parseTranscript, readAllLogs, ulidTime } from "../../src";
import { main } from "../../src/cli";
import { createServer } from "../../src/server";
import { closeApp, openApp } from "../helpers/app";
import { makeSpace } from "../helpers/gitFixture";
import { tmpDir } from "../helpers/tmp";

const TEXT = `Human: Should we add caching to the API?
It is slow on repeated queries.

Assistant: Caching could help, but check whether queries repeat.

Human: They don't: every query has a unique timestamp.
Assistant: Then caching won't help.`;

const EXPORT = JSON.stringify([
  {
    uuid: "11111111-aaaa-bbbb-cccc-000000000001",
    name: "API performance",
    chat_messages: [
      { sender: "human", text: "Is the API slow because of the DB?", created_at: "2026-10-01T09:00:00.000000Z" },
      { sender: "assistant", text: "Possibly; profile it.", created_at: "2026-10-01T09:00:05Z" },
      { sender: "human", text: "", content: [{ type: "text", text: "Profiling shows 80% in JSON encoding." }], created_at: "2026-10-01T09:30:00Z" },
    ],
  },
  { uuid: "22222222-aaaa-bbbb-cccc-000000000002", name: "Holiday plans", chat_messages: [{ sender: "human", text: "Where to go?" }] },
]);

const lines = (dir: string) => readdirSync(dir).flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean));

describe("M4 transcript parsing", () => {
  it("splits a labelled text transcript into turns, verbatim and multi-line", () => {
    const t = parseTranscript(TEXT);
    expect(t.turns.map((x) => x.role)).toEqual(["human", "assistant", "human", "assistant"]);
    expect(t.turns[0]!.text).toBe("Should we add caching to the API?\nIt is slow on repeated queries.");
  });

  it("reads a Claude.ai export: needs a pick when there are several; keeps original times", () => {
    expect(() => parseTranscript(EXPORT)).toThrow(/2 conversations.*API performance/s);
    const t = parseTranscript(EXPORT, { conversation: "api perf" });
    expect(t.title).toBe("API performance");
    expect(t.turns).toEqual([
      { role: "human", text: "Is the API slow because of the DB?", ts: "2026-10-01T09:00:00.000Z" },
      { role: "assistant", text: "Possibly; profile it.", ts: "2026-10-01T09:00:05.000Z" },
      { role: "human", text: "Profiling shows 80% in JSON encoding.", ts: "2026-10-01T09:30:00.000Z" },
    ]);
    expect(parseTranscript(EXPORT, { conversation: "22222222-aaaa-bbbb-cccc-000000000002" }).title).toBe("Holiday plans");
  });

  it("reads a JSON array of turns", () => {
    const t = parseTranscript(JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", text: "hello" }]));
    expect(t.turns.map((x) => [x.role, x.text])).toEqual([["human", "hi"], ["assistant", "hello"]]);
  });

  it("refuses what it can't read, clearly", () => {
    expect(() => parseTranscript("")).toThrow(ImportError);
    expect(() => parseTranscript("just some notes\nno labels")).toThrow(/speaker labels/);
    expect(() => parseTranscript("{ nope")).toThrow(/not valid JSON/);
    expect(() => parseTranscript(JSON.stringify([{ role: "narrator", text: "x" }]))).toThrow(/unknown role/);
  });

  it("ids are deterministic from content and position, with the original time in the ULID", () => {
    const t = parseTranscript(EXPORT, { conversation: "API" });
    const a = importEvents("krish", t, { now: Date.parse("2026-11-14T10:00:00Z") });
    const b = importEvents("krish", t, { now: Date.parse("2026-11-20T10:00:00Z") });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(a).toHaveLength(2); // assistant turn skipped by default
    expect(ulidTime(a[0]!.id)).toBe(Date.parse("2026-10-01T09:00:00Z"));
    expect(a[0]).toMatchObject({ kind: "import", role: "human", author: "krish", original_ts: "2026-10-01T09:00:00.000Z", text: "Is the API slow because of the DB?" });
    expect(importEvents("arun", t).map((e) => e.id)).not.toEqual(a.map((e) => e.id)); // per author
    expect(importEvents("krish", t, { includeAssistant: true }).map((e) => (e as { role: string }).role)).toEqual(["human", "assistant", "human"]);
  });
});

describe("M4 importing into the shared memory", { timeout: 60_000 }, () => {
  it("imports my turns verbatim as 'imported' items; re-running adds nothing", async () => {
    const s = makeSpace();
    const file = path.join(tmpDir(), "old-chat.txt");
    writeFileSync(file, TEXT);
    const app = openApp(s, "krish");
    const r = await app.importTranscript({ path: file });
    expect(r).toMatchObject({ turns: 4, imported: 2, already_imported: 0, skipped_assistant_turns: 2 });
    const head = s.git(s.clone("krish"), "rev-parse", "HEAD");
    const logDir = path.join(s.clone("krish"), "logs", "krish");
    const n = lines(logDir).length;

    const again = await app.importTranscript({ path: file });
    expect(again).toMatchObject({ imported: 0, already_imported: 2 });
    expect(lines(logDir).length).toBe(n);
    expect(s.git(s.clone("krish"), "rev-parse", "HEAD")).toBe(head);

    const hits = (await app.search({ query: "unique timestamp" })).items;
    expect(hits[0]).toMatchObject({ author: "krish", kind: "import", tier: "imported", text: "They don't: every query has a unique timestamp." });
    await app.transport.whenIdle();
    // Arun sees it, attributed and tiered.
    const arun = openApp(s, "arun");
    expect((await arun.syncTurn({ message: "caching?" })).new_from_others.items.map((i) => i.tier)).toEqual(["imported", "imported"]);
  });

  it("via the MCP tool, then the CLI after the server closes", async () => {
    const s = makeSpace();
    const file = path.join(tmpDir(), "conversations.json");
    writeFileSync(file, EXPORT);
    const server = openApp(s, "krish");
    const base = ["import", "--repo", s.clone("krish"), "--me", "krish", "--state", s.stateDir("krish"), "--no-model", "--conversation", "API"];

    // Through the running server's tool.
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(server).connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    const res = (await c.callTool({ name: "import_transcript", arguments: { path: file, conversation: "API" } })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ title: "API performance", imported: 2 });
    await closeApp(server);

    // The CLI (server closed): nothing new, since the same ids are already there.
    const out: string[] = [];
    const orig = console.log;
    console.log = (x: string) => out.push(x);
    try {
      expect(await main([...base, file], { env: s.env })).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(out[0]!)).toMatchObject({ imported: 0, already_imported: 2 });
    expect(readAllLogs(s.clone("krish")).events.filter((e) => e.kind === "import")).toHaveLength(2);
  });
});
