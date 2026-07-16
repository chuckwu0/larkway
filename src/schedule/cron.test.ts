import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, nextFireAfter } from "./cron.js";

// Helper: local-time Date without ISO/UTC ambiguity.
function local(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe("parseCron", () => {
  it("parses the workday morning-report shape", () => {
    const spec = parseCron("30 8 * * 1-5");
    expect([...spec.minute]).toEqual([30]);
    expect([...spec.hour]).toEqual([8]);
    expect(spec.domIsWildcard).toBe(true);
    expect(spec.dowIsWildcard).toBe(false);
    expect([...spec.dayOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("supports lists, ranges, and steps", () => {
    const spec = parseCron("*/15 9-17 1,15 * *");
    expect([...spec.minute]).toEqual([0, 15, 30, 45]);
    expect([...spec.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...spec.dayOfMonth]).toEqual([1, 15]);
  });

  it("normalizes Sunday 7 → 0", () => {
    const spec = parseCron("0 0 * * 7");
    expect(spec.dayOfWeek.has(0)).toBe(true);
    expect(spec.dayOfWeek.has(7)).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("30 8 * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 8 * * *")).toThrow(/out of range/);
    expect(() => parseCron("a b c d e")).toThrow();
    expect(() => parseCron("30 8 * * 1-5/0")).toThrow(/step/);
  });
});

describe("cronMatches", () => {
  const workdays = parseCron("30 8 * * 1-5");

  it("matches a weekday at 8:30 local", () => {
    // 2026-07-17 is a Friday.
    expect(cronMatches(workdays, local(2026, 7, 17, 8, 30))).toBe(true);
  });

  it("rejects the same time on a weekend", () => {
    // 2026-07-18 is a Saturday.
    expect(cronMatches(workdays, local(2026, 7, 18, 8, 30))).toBe(false);
  });

  it("rejects the wrong minute", () => {
    expect(cronMatches(workdays, local(2026, 7, 17, 8, 31))).toBe(false);
  });

  it("applies the vixie dom/dow OR rule only when both are restricted", () => {
    // dom=13, dow=Fri: fires on the 13th OR any Friday.
    const both = parseCron("0 0 13 * 5");
    expect(cronMatches(both, local(2026, 7, 13, 0, 0))).toBe(true); // Monday the 13th → dom side
    expect(cronMatches(both, local(2026, 7, 17, 0, 0))).toBe(true); // Friday the 17th → dow side
    expect(cronMatches(both, local(2026, 7, 14, 0, 0))).toBe(false); // Tuesday the 14th → neither
  });
});

describe("nextFireAfter", () => {
  it("finds the next slot strictly after `from`", () => {
    const spec = parseCron("30 8 * * 1-5");
    // From Friday 08:30 exactly → next is Monday 08:30 (strictly after).
    const next = nextFireAfter(spec, local(2026, 7, 17, 8, 30));
    expect(next).toEqual(local(2026, 7, 20, 8, 30));
  });

  it("lands on the same day when still ahead", () => {
    const spec = parseCron("30 20 * * 1-5");
    const next = nextFireAfter(spec, local(2026, 7, 17, 9, 0));
    expect(next).toEqual(local(2026, 7, 17, 20, 30));
  });

  it("rolls over month boundaries", () => {
    const spec = parseCron("0 9 1 * *");
    const next = nextFireAfter(spec, local(2026, 7, 17, 12, 0));
    expect(next).toEqual(local(2026, 8, 1, 9, 0));
  });

  it("handles month-restricted expressions", () => {
    const spec = parseCron("0 9 1 12 *");
    const next = nextFireAfter(spec, local(2026, 7, 17, 12, 0));
    expect(next).toEqual(local(2026, 12, 1, 9, 0));
  });

  it("returns null for unsatisfiable expressions", () => {
    expect(nextFireAfter(parseCron("0 0 30 2 *"), local(2026, 7, 17, 0, 0))).toBeNull();
  });
});
