import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AUTHOR_RE, type Event, validateEvent } from "./schema";
import { LOG_FILE_RE } from "./paths";

export type Skipped = { file: string; line: number; reason: string };
export type ReadResult = { events: Event[]; skipped: Skipped[] };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads one JSON Lines log file. Never throws on content: every malformed
 * line (truncated, bad JSON, invalid UTF-8, failed validation, wrong author)
 * is skipped and reported. Blank lines are ignored. CRLF and BOM are stripped.
 */
export function readLogFile(file: string, expectedAuthor?: string): ReadResult {
  const events: Event[] = [];
  const skipped: Skipped[] = [];
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (e) {
    // A locked or vanished file (antivirus, sync tools) must not fail the whole read.
    skipped.push({ file, line: 0, reason: `unreadable: ${(e as NodeJS.ErrnoException).code ?? String(e)}` });
    return { events, skipped };
  }
  let start = 0;
  let lineNo = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    lineNo++;
    const reason = parseLine(buf.subarray(start, end), expectedAuthor, events);
    if (reason) skipped.push({ file, line: lineNo, reason });
    start = end + 1;
  }
  return { events, skipped };
}

function parseLine(raw: Buffer, expectedAuthor: string | undefined, out: Event[]): string | null {
  let text: string;
  try {
    text = utf8.decode(raw);
  } catch {
    return "invalid UTF-8";
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalid JSON";
  }
  const r = validateEvent(parsed);
  if (!r.ok) return r.reason;
  if (expectedAuthor !== undefined && r.event.author !== expectedAuthor) {
    return `author ${JSON.stringify(r.event.author)} does not match folder ${JSON.stringify(expectedAuthor)}`;
  }
  out.push(r.event);
  return null;
}

/**
 * Reads every logs/<author>/YYYY-MM-DD.jsonl under `root`. Events must be
 * authored by the folder's owner. Folders and files that don't fit the
 * layout are ignored. A missing logs/ folder gives an empty result.
 */
export function readAllLogs(root: string): ReadResult {
  const logs = path.join(root, "logs");
  const events: Event[] = [];
  const skipped: Skipped[] = [];
  let authors: string[];
  try {
    authors = readdirSync(logs).filter((a) => AUTHOR_RE.test(a)).sort();
  } catch {
    return { events, skipped };
  }
  for (const author of authors) {
    const dir = path.join(logs, author);
    if (!isDir(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => LOG_FILE_RE.test(f)).sort();
    } catch (e) {
      skipped.push({ file: dir, line: 0, reason: `unreadable: ${(e as NodeJS.ErrnoException).code ?? String(e)}` });
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      if (!isFile(file)) continue;
      const r = readLogFile(file, author);
      events.push(...r.events);
      skipped.push(...r.skipped);
    }
  }
  return { events, skipped };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
