#!/usr/bin/env node
// Builds the Claude Desktop extension, dist/chatlink.mcpb.
//
//   npm run fetch-model     (once; the model ships inside the bundle)
//   npm run pack
//   node scripts/pack-mcpb.mjs --stage-only <dir>   (stage the folder without zipping; tests use this)
//
// The bundle is pure JS + WebAssembly: no native binaries, so one file works
// on Windows and macOS with the Node runtime Claude Desktop ships.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2"; // pinned; run through npx, not a project dependency
const MODEL = "potion-base-32M";
const MODEL_FILES = ["model.safetensors", "tokenizer.json", "config.json", "SOURCE.json"];

export function manifest() {
  return {
    manifest_version: "0.3",
    name: "chatlink",
    display_name: "chatlink: shared chat memory",
    version: pkg.version,
    description: "Lets two or more people's Claude chats share one memory, through a private GitHub repo you all clone.",
    long_description:
      "Every message you share is saved word for word, with who said it and when, in your own folder of a shared private git repo, and synced with your normal git setup. " +
      "At the start of each reply Claude checks the shared memory and can tell you, for example, that a teammate already ruled an idea out, quoting their own words. " +
      "Everything stays on your machines and your repo: no server, no API key. Search runs locally.",
    author: { name: "Arun" },
    server: {
      type: "node",
      entry_point: "server/server.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/server.js"],
        env: { CHATLINK_ME: "${user_config.name}", CHATLINK_REPO: "${user_config.repo}" },
      },
    },
    tools: [
      { name: "sync_turn", description: "Logs your message to the shared memory and returns what's relevant from everyone, plus what's new." },
      { name: "search", description: "Searches everyone's shared messages, notes and decisions." },
      { name: "whats_new", description: "What the others added since you last looked." },
      { name: "mark_status", description: "Marks an item decided, closed, reopened or superseded (when you confirm)." },
      { name: "add_note", description: "Adds a note to the shared memory when you ask." },
      { name: "get_item", description: "Shows one item's full text." },
      { name: "import_transcript", description: "Imports an older chat (e.g. a Claude.ai export) when you ask." },
    ],
    prompts_generated: true,
    keywords: ["memory", "team", "shared", "git", "collaboration"],
    compatibility: { platforms: ["win32", "darwin", "linux"], runtimes: { node: ">=20.0.0" } },
    user_config: {
      name: {
        type: "string",
        title: "Your name",
        description: "Lowercase letters, digits, - or _ (e.g. arun). It names your folder in the shared repo. Each person and each computer needs its own name (e.g. arun and arun-laptop).",
        required: true,
      },
      repo: {
        type: "directory",
        title: "Your clone of the shared repo",
        description: "The folder you cloned the shared private GitHub repo into. Keep it out of OneDrive, Dropbox or iCloud.",
        required: true,
      },
    },
  };
}

export function stage(dir) {
  const modelDir = path.join(root, "models", MODEL);
  for (const f of MODEL_FILES) {
    if (!existsSync(path.join(modelDir, f))) throw new Error(`missing ${path.join(modelDir, f)}: run \`npm run fetch-model\` first`);
  }
  execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--minify"], { cwd: root, stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(path.join(dir, "server"), { recursive: true });
  mkdirSync(path.join(dir, "models", MODEL), { recursive: true });
  for (const f of ["server.js", "node-sqlite3-wasm.wasm"]) copyFileSync(path.join(root, "dist", f), path.join(dir, "server", f));
  copyFileSync(path.join(root, "dist", "THIRD-PARTY-NOTICES.txt"), path.join(dir, "THIRD-PARTY-NOTICES.txt"));
  for (const f of MODEL_FILES) copyFileSync(path.join(modelDir, f), path.join(dir, "models", MODEL, f));
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest(), null, 2) + "\n");
  copyFileSync(path.join(root, "README.md"), path.join(dir, "README.md"));
  return dir;
}

function npx(args) {
  const win = process.platform === "win32";
  // On Windows npx is a .cmd, which needs a shell; quote arguments so paths with spaces survive.
  const q = (a) => (win ? `"${a}"` : a);
  execFileSync(win ? "npx.cmd" : "npx", ["--yes", MCPB_CLI, ...args].map(q), { cwd: root, stdio: "inherit", shell: win });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf("--stage-only");
  if (i >= 0) {
    const dir = path.resolve(process.argv[i + 1] ?? path.join(root, "build", "mcpb"));
    stage(dir);
    console.log(`staged ${dir}`);
  } else {
    const dir = stage(path.join(root, "build", "mcpb"));
    npx(["validate", path.join(dir, "manifest.json")]);
    const out = path.join(root, "dist", "chatlink.mcpb");
    rmSync(out, { force: true });
    npx(["pack", dir, out]);
    console.log(`\n${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  }
}
