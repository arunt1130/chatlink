#!/usr/bin/env node
// Builds dist/: the server, CLI and library as single ES-module files, plus the
// SQLite WebAssembly binary they load from their own folder.
//   node scripts/build.mjs [--minify]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist");
const minify = process.argv.includes("--minify");

// Some bundled CommonJS code (the SQLite wasm loader) uses require/__dirname,
// which ES modules don't have. Recreate them from import.meta.url.
const banner = [
  "import { createRequire as __chatlinkRequire } from 'node:module';",
  "import { fileURLToPath as __chatlinkPath } from 'node:url';",
  "import { dirname as __chatlinkDir } from 'node:path';",
  "const require = __chatlinkRequire(import.meta.url);",
  "const __filename = __chatlinkPath(import.meta.url);",
  "const __dirname = __chatlinkDir(__filename);",
].join(" ");

mkdirSync(out, { recursive: true });
const result = await build({
  metafile: true,
  entryPoints: { chatlink: "src/index.ts", cli: "src/cli.ts", server: "src/server.ts" },
  absWorkingDir: root,
  outdir: out,
  outExtension: { ".js": ".js" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: banner },
  minify,
  legalComments: "none", // notices are collected below, from each bundled package's LICENSE file
  logLevel: "warning",
});
copyFileSync(path.join(root, "node_modules", "node-sqlite3-wasm", "dist", "node-sqlite3-wasm.wasm"), path.join(out, "node-sqlite3-wasm.wasm"));
// THIRD-PARTY-NOTICES.txt: the license of every npm package that ended up in a bundle.
const pkgs = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = input.replace(/\\/g, "/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (m) pkgs.set(m[1], path.join(root, "node_modules", ...m[1].split("/")));
}
const notices = [
  "chatlink bundles the following third-party software. Their licenses follow.",
  "",
  "Embedding model: minishlab/potion-base-32M (MIT License), https://huggingface.co/minishlab/potion-base-32M",
  "SQLite (public domain), compiled to WebAssembly by node-sqlite3-wasm.",
  "",
];
for (const [name, dir] of [...pkgs].sort(([a], [b]) => a.localeCompare(b))) {
  const pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const lic = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  notices.push("=".repeat(72), `${name}@${pj.version} (${pj.license ?? "see below"})`, "=".repeat(72));
  notices.push(lic ? readFileSync(path.join(dir, lic), "utf8").trim() : "(no license file shipped in the package)", "");
}
writeFileSync(path.join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\n") + "\n");
if (!existsSync(path.join(out, "THIRD-PARTY-NOTICES.txt"))) throw new Error("notices not written");
console.log(`built ${out}${minify ? " (minified)" : ""}`);
