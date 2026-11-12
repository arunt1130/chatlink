import { randomBytes } from "node:crypto";

/** Crockford base32 alphabet used by ULID. */
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;
const TIME_MAX = 2 ** 48 - 1;
const RAND_MAX = (1n << 80n) - 1n;

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) throw new RangeError(`ULID time out of range: ${ms}`);
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENC[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRand(r: bigint): string {
  let out = "";
  let x = r;
  for (let i = 0; i < RAND_LEN; i++) {
    out = ENC[Number(x & 31n)] + out;
    x >>= 5n;
  }
  return out;
}

function randomPart(): bigint {
  return BigInt("0x" + randomBytes(10).toString("hex"));
}

/**
 * Returns a monotonic ULID generator: ids from one generator are strictly
 * increasing, even within one millisecond or if the clock steps backwards.
 */
export function monotonicUlid(random: () => bigint = randomPart): (now?: number) => string {
  let lastTime = -1;
  let lastRand = 0n;
  return (now = Date.now()) => {
    if (now > lastTime) {
      lastTime = now;
      lastRand = random() & RAND_MAX;
    } else if (lastRand < RAND_MAX) {
      lastRand += 1n;
    } else {
      // Random part exhausted within this millisecond: borrow the next one.
      lastTime += 1;
      lastRand = random() & RAND_MAX;
    }
    return encodeTime(lastTime) + encodeRand(lastRand);
  };
}

/** Process-wide monotonic ULID. */
export const ulid = monotonicUlid();

/** Decodes the millisecond timestamp of a ULID. */
export function ulidTime(id: string): number {
  if (!ULID_RE.test(id)) throw new Error(`not a ULID: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) t = t * 32 + ENC.indexOf(ch);
  return t;
}
