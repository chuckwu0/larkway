import { describe, expect, it } from "vitest";
import { MAX_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_SECONDS, resolveRunTimeoutMs } from "./runTimeout.js";

describe("native turn wall-clock budget", () => {
  it("disables the deadline by default or explicitly with zero", () => {
    expect(resolveRunTimeoutMs()).toBeUndefined();
    expect(resolveRunTimeoutMs(0)).toBeUndefined();
  });

  it("accepts safe positive budgets without inventing a default", () => {
    expect(resolveRunTimeoutMs(3 * 60 * 60 * 1000)).toBe(10_800_000);
    expect(resolveRunTimeoutMs(MAX_RUN_TIMEOUT_MS)).toBe(MAX_RUN_TIMEOUT_MS);
    expect(resolveRunTimeoutMs(MAX_RUN_TIMEOUT_SECONDS * 1000)).toBe(2_147_483_000);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, MAX_RUN_TIMEOUT_MS + 1])(
    "rejects unsafe timer value %s instead of scheduling an immediate kill",
    (value) => expect(() => resolveRunTimeoutMs(value)).toThrow(RangeError),
  );
});
