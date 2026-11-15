import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Chatlink } from "./app/chatlink";
import { ConfigError, loadConfig } from "./config";
import { STATUS_VALUES } from "./events/schema";

export const SERVER_NAME = "chatlink";
export const SERVER_VERSION = "0.4.0";

/** Tool descriptions are the main lever for reliable behaviour (see SPEC "Behaviour rules"). */
export const DESCRIPTIONS = {
  sync_turn:
    "Shared memory with your collaborators. Call this at the START of EVERY reply, BEFORE answering, passing the user's latest message copied verbatim (exact text, no paraphrase). " +
    "It logs the message to the shared log and returns: relevant past items from everyone (with author, date, kind, trust tier and verbatim text), what's new from others since last time, sync state, and possibly a decision to confirm. " +
    "When an item from another person is relevant, name them, give the date, and quote their own words. Be exact about trust: tier 'confirmed' means a person explicitly marked/noted it; 'said' is just a message; 'model-written' is never anyone's position. " +
    "If possible_decision is present, ask the user in one line (its 'ask' text) whether to mark it; only call mark_status on a yes. " +
    "If the user says 'off the record', pass share=false: nothing is written. If sync.stale is true, mention once that results may be missing others' newest messages. (unpushed_commits > 0 right after a write is normal: delivery runs in the background.)",
  search: "Search the shared memory (everyone's messages, notes and status marks) by meaning and keywords. Optional author filter, since (ISO date, UTC) and limit. Returns ranked items with author, date, tier and verbatim text.",
  whats_new: "Everything other people added since you last looked (oldest first), then marks it as seen. Use for 'catch me up' / 'what did I miss'.",
  mark_status:
    "Mark an item (by its event id) as decided, closed, reopened or superseded, with a short reason. Only when the user explicitly confirms. Creates a 'confirmed' status event attributed to the user.",
  add_note: "Add something to the shared memory because the user explicitly asked you to remember/share it. Stored verbatim as a 'confirmed' note by the user.",
  get_item: "Fetch one item's full text by event id (other tools cut long texts and say truncated: true).",
  import_transcript:
    "Import an older chat into the shared memory, verbatim, ONLY when the user explicitly asks and gives the file path. Accepts a Claude.ai data export (conversations.json; pass conversation = its name or uuid when the export has several), a JSON array of turns, or plain text with 'Human:'/'Assistant:' labels. The user's turns become 'imported' items; Claude's turns are skipped unless include_assistant is true. Safe to re-run: nothing is imported twice.",
} as const;

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 1) }] });

/** Builds the MCP server around a Chatlink instance (no transport attached yet). */
export function createServer(app: Chatlink): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: "Shared chat memory. Call sync_turn at the start of every reply with the user's message verbatim, before answering." },
  );

  server.registerTool(
    "sync_turn",
    {
      title: "Sync this turn with shared memory",
      description: DESCRIPTIONS.sync_turn,
      inputSchema: {
        message: z.string().describe("The user's latest message, copied verbatim."),
        share: z.boolean().optional().describe("Default true. false = off the record: the message is not written to the shared log."),
      },
    },
    async ({ message, share }) => json(await app.syncTurn({ message, share })),
  );

  server.registerTool(
    "search",
    {
      title: "Search shared memory",
      description: DESCRIPTIONS.search,
      inputSchema: {
        query: z.string(),
        author: z.string().optional(),
        since: z.string().optional().describe("ISO 8601 date or date-time with zone, e.g. 2026-11-03 or 2026-11-03T09:00:00Z"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => json(await app.search(a)),
  );

  server.registerTool(
    "whats_new",
    { title: "What's new from others", description: DESCRIPTIONS.whats_new, inputSchema: { limit: z.number().int().min(1).max(200).optional() } },
    async (a) => json(await app.whatsNew(a)),
  );

  server.registerTool(
    "mark_status",
    {
      title: "Mark an item's status",
      description: DESCRIPTIONS.mark_status,
      inputSchema: {
        target: z.string().describe("Event id of the item being marked."),
        status: z.enum(STATUS_VALUES),
        reason: z.string().describe("Short reason, ideally in the user's words."),
      },
    },
    async (a) => json(await app.markStatus(a)),
  );

  server.registerTool(
    "add_note",
    { title: "Add a note to shared memory", description: DESCRIPTIONS.add_note, inputSchema: { text: z.string().min(1) } },
    async (a) => json(await app.addNote(a)),
  );

  server.registerTool(
    "get_item",
    { title: "Get one item's full text", description: DESCRIPTIONS.get_item, inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async (a) => json(await app.getItem(a)),
  );

  server.registerTool(
    "import_transcript",
    {
      title: "Import an older chat",
      description: DESCRIPTIONS.import_transcript,
      inputSchema: {
        path: z.string().describe("Full path to the transcript file on this computer."),
        conversation: z.string().optional().describe("For a Claude.ai export with many conversations: its name (or part of it) or uuid."),
        include_assistant: z.boolean().optional().describe("Also import Claude's replies (as role assistant). Default false."),
      },
    },
    async (a) => json(await app.importTranscript({ path: a.path, conversation: a.conversation, includeAssistant: a.include_assistant })),
  );

  // User-triggered, so the digest is one click away even when Claude forgets to sync.
  // The server runs whats_new itself and hands Claude the result to present.
  server.registerPrompt(
    "catch_me_up",
    { title: "Catch me up", description: "What did the others add since I last looked?" },
    async () => {
      const d = await app.whatsNew();
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                "Catch me up on what the others added to our shared memory since I last looked. " +
                "Group it by person, give each item's date, quote their own words, and say which items are confirmed (marked/noted) versus just said. " +
                "If there is nothing new, say so in one line." +
                (d.more ? " There is more than shown; offer to continue (call whats_new)." : "") +
                (d.sync.stale ? " Mention once that sync is stale, so the newest messages may be missing." : "") +
                "\n\nwhats_new result:\n" +
                JSON.stringify(d, null, 1),
            },
          },
        ],
      };
    },
  );

  return server;
}

const log = (...a: unknown[]) => console.error("[chatlink]", ...a); // stdout is the MCP channel

export async function main(): Promise<void> {
  let app: Chatlink;
  try {
    const cfg = loadConfig();
    app = Chatlink.open(cfg);
    log(`me=${cfg.me} repo=${cfg.repoPath} state=${cfg.stateDir} search=${app.embedder ? "hybrid" : "keyword-only"}`);
    for (const w of app.warnings) log("warning:", w);
  } catch (e) {
    log(e instanceof ConfigError ? `config error: ${e.message}` : (e as Error).stack ?? e);
    process.exit(1);
  }
  const server = createServer(app);
  await server.connect(new StdioServerTransport());
  // Catch up in the background; the first tool call waits for it (calls are serialized).
  app.warmUp().catch((e) => log("warm-up failed:", (e as Error).message));

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isEntry = process.argv[1] !== undefined && /server\.(js|ts|mjs)$/.test(process.argv[1]);
if (isEntry) void main();
