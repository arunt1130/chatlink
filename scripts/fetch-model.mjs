#!/usr/bin/env node
// Downloads the embedding model once into models/<name>/ (gitignored).
// Pinned to one Hugging Face revision; every file is hash-checked, and a
// file that fails the check is deleted. Tests never run this (no network in tests).
//
//   node scripts/fetch-model.mjs [destDir]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL = {
  repo: "minishlab/potion-base-32M",
  revision: "1e5a03f8eeb2c98b928fbbd846f22f816360919f",
  license: "MIT",
  files: {
    // LFS file: sha256 of the content.
    "model.safetensors": { size: 129210456, sha256: "99f6c33204c9231a7391871b7a3c91409b532c8f587a9ea44fc282303d8dec28" },
    // Plain git files: git blob sha1 ("blob <size>\0" + content).
    "tokenizer.json": { size: 1493150, gitSha1: "933e7dae4cd4f6a4c5c9c50c53655819ada3e2b3" },
    "config.json": { size: 202, gitSha1: "3f6130f15b009012758abace11f95f5aa8337276" },
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function verify(buf, spec) {
  if (buf.length !== spec.size) return `size ${buf.length} != ${spec.size}`;
  if (spec.sha256) {
    const h = createHash("sha256").update(buf).digest("hex");
    return h === spec.sha256 ? null : `sha256 ${h} != ${spec.sha256}`;
  }
  const h = createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
  return h === spec.gitSha1 ? null : `git sha1 ${h} != ${spec.gitSha1}`;
}

async function main() {
  const dest = path.resolve(process.argv[2] ?? path.join(root, "models", "potion-base-32M"));
  mkdirSync(dest, { recursive: true });
  for (const [name, spec] of Object.entries(MODEL.files)) {
    const file = path.join(dest, name);
    if (existsSync(file) && verify(readFileSync(file), spec) === null) {
      console.log(`ok (cached) ${name}`);
      continue;
    }
    const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${name}`;
    console.log(`fetching ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const bad = verify(buf, spec);
    if (bad) throw new Error(`${name}: ${bad}`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
    console.log(`ok ${name} (${buf.length} bytes)`);
  }
  writeFileSync(path.join(dest, "SOURCE.json"), JSON.stringify({ repo: MODEL.repo, revision: MODEL.revision, license: MODEL.license }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
