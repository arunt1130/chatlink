#!/usr/bin/env node
// Creates a local test space for trying chatlink in Claude Desktop without GitHub:
// a bare repo standing in for GitHub, plus one clone per person.
//
//   npm run build
//   node scripts/dev-space.mjs <folder> [names...]     (default names: arun krish)
//
// Put <folder> OUTSIDE OneDrive/Dropbox/iCloud: sync tools can corrupt .git.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(root, "dist", "chatlink.js");
if (!existsSync(lib)) {
  console.error("run `npm run build` first");
  process.exit(1);
}
const { SHARED_GITIGNORE, SHARED_GITATTRIBUTES } = await import(pathToFileURL(lib).href);

const [dirArg, ...namesArg] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage: node scripts/dev-space.mjs <folder> [names...]");
  process.exit(2);
}
const base = path.resolve(dirArg);
if (/onedrive|dropbox|icloud/i.test(base)) console.warn(`warning: ${base} looks like a sync folder; git may get corrupted there`);
if (existsSync(base) && readdirSync(base).length) {
  console.error(`${base} is not empty; pick a new folder`);
  process.exit(1);
}
const names = namesArg.length ? namesArg : ["arun", "krish"];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();

mkdirSync(base, { recursive: true });
const remote = path.join(base, "remote.git");
git(base, "init", "-q", "--bare", "-b", "main", remote);
const seed = path.join(base, "seed");
git(base, "clone", "-q", remote, seed);
writeFileSync(path.join(seed, ".gitignore"), SHARED_GITIGNORE);
writeFileSync(path.join(seed, ".gitattributes"), SHARED_GITATTRIBUTES);
writeFileSync(path.join(seed, "space.json"), JSON.stringify({ v: 1, members: Object.fromEntries(names.map((n) => [n, { display: n }])) }, null, 2) + "\n");
git(seed, "add", "-A");
git(seed, "-c", "user.name=chatlink", "-c", "user.email=chatlink@localhost", "commit", "-q", "-m", "space setup");
git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");

const server = path.join(root, "dist", "server.js");
const entries = {};
for (const n of names) {
  const clone = path.join(base, n);
  git(base, "clone", "-q", remote, clone);
  entries[`chatlink-${n}`] = { command: "node", args: [server], env: { CHATLINK_ME: n, CHATLINK_REPO: clone } };
}
console.log(`Created ${base}\n  remote: ${remote}\n  clones: ${names.map((n) => path.join(base, n)).join(", ")}\n`);
console.log("Add these under \"mcpServers\" in claude_desktop_config.json:\n");
console.log(JSON.stringify(entries, null, 2));
