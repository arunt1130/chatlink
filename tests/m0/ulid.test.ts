import { describe, expect, it } from "vitest";
import { ULID_RE, monotonicUlid, ulid, ulidTime } from "../../src";

describe("M0 ULID", () => {
  it("is 26 Crockford chars and encodes the time", () => {
    const now = Date.parse("2026-11-12T12:00:00.123Z");
    const id = ulid(now + 1e6); // ahead of any earlier call in this process
    expect(id).toMatch(ULID_RE);
    expect(ulidTime(id)).toBe(now + 1e6);
  });

  it("is strictly increasing within one millisecond and when the clock goes back", () => {
    const gen = monotonicUlid();
    const t = Date.parse("2026-11-12T12:00:00Z");
    const out = [gen(t), gen(t), gen(t), gen(t - 5000), gen(t + 1)];
    expect([...out].sort()).toEqual(out);
    expect(new Set(out).size).toBe(out.length);
  });

  it("borrows the next millisecond when the random part overflows", () => {
    const max = (1n << 80n) - 1n;
    const gen = monotonicUlid(() => max);
    const t = 1_000_000;
    const a = gen(t);
    const b = gen(t);
    expect(b > a).toBe(true);
    expect(ulidTime(b)).toBe(t + 1);
  });

  it("10k ids are unique and sorted", () => {
    const gen = monotonicUlid();
    const out = Array.from({ length: 10_000 }, () => gen());
    expect(new Set(out).size).toBe(out.length);
    expect([...out].sort()).toEqual(out);
  });
});
