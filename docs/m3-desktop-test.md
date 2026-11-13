# M3 acceptance check in Claude Desktop

SPEC's M3 test: in Claude Desktop with two server entries pointed at two clones, Krish says caching won't help; Arun asks about caching; Claude names Krish, gives the date, and quotes him.

The automated version of this runs in `tests/m3/e2e.test.ts` (an MCP client instead of Claude). This page is the manual check with real Claude Desktop. It takes about 10 minutes.

## 1. Build, and get the model

```bash
npm ci
npm run fetch-model
npm run build
```

## 2. Make a local test space (no GitHub needed)

Put it **outside OneDrive** (sync tools can corrupt `.git`):

```bash
node scripts/dev-space.mjs C:/chatlink-test
```

This creates `C:/chatlink-test/remote.git` (it stands in for GitHub) and the clones `C:/chatlink-test/arun` and `C:/chatlink-test/krish`. It prints two `mcpServers` entries.

## 3. Register both servers

Open Claude Desktop → Settings → Developer → Edit Config (`%APPDATA%\Claude\claude_desktop_config.json`). Paste the two printed entries inside `"mcpServers": { … }` and restart Claude Desktop. Each entry looks like this:

```json
"chatlink-krish": {
  "command": "node",
  "args": ["C:\\Users\\ArunT\\OneDrive\\Desktop\\Claude2Claude MCP\\dist\\server.js"],
  "env": { "CHATLINK_ME": "krish", "CHATLINK_REPO": "C:\\chatlink-test\\krish" }
}
```

Both servers expose tools with the same names, so **turn on only one per chat**. Use the tools / connectors menu in the message box: for chat 1, only `chatlink-krish`; for chat 2, only `chatlink-arun`.

Server logs: `%APPDATA%\Claude\logs\mcp-server-chatlink-*.log` (the server writes only to stderr).

## 4. Add the behaviour rules

Create a Project (or use each chat's instructions) with the rules from SPEC.md "Behaviour rules for Claude":

```markdown
Shared memory rules:
- At the start of every reply, call sync_turn with my message copied verbatim, before you answer.
- When something from another person is relevant, name them, give the date, and quote their own words.
- Be exact about trust: "Krish marked this closed" is different from "Krish said something related". Never present a plain message or a model-written note as someone's decision.
- If sync_turn flags a possible decision, ask me in one line whether to mark it.
- If I say "off the record", call sync_turn with share=false for that message.
- If sync state says results may be stale, mention it once.
```

## 5. The script

1. **Chat 1 (chatlink-krish):** "Caching won't help here: every query has a unique timestamp in it."
   Check: Claude calls `sync_turn`, and `C:/chatlink-test/krish/logs/krish/<today>.jsonl` has the line.
2. **Chat 2 (chatlink-arun):** "Should we cache the query results to speed things up?"
   **Pass:** Claude names **Krish**, gives the **date**, and **quotes** "Caching won't help here: every query has a unique timestamp in it." It should present it as something Krish *said*, not as a decision.
3. Optional. **Chat 2:** "Agreed, let's drop the caching idea."
   Check: Claude asks one line, roughly *Mark "Caching won't help here…" as closed?* Answer yes, and it calls `mark_status`.
4. Optional. **Chat 1:** run the **catch_me_up** prompt (the "+" / prompts menu). It shows Arun's messages and his "closed" mark as confirmed.
5. Optional. **Chat 2:** "off the record: I think Krish is wrong." Check that nothing is added to `logs/arun/`.

Record what happened (pass/fail, and the `timing_ms` from a `sync_turn` result) in the M3 section of DECISIONS.md or the M5 notes.

## Clean up

Remove the two entries from the config, then delete `C:/chatlink-test` and the state folders under `%LOCALAPPDATA%\chatlink\`.
