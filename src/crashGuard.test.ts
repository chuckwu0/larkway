/**
 * Tests for src/crashGuard.ts — the process-level last-resort crash guard.
 *
 * Real uncaughtException is hard to drive deterministically in a test runner, so
 * we test (a) the handler functions log + NEVER call process.exit, and (b)
 * registerCrashGuard wires them onto process without throwing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleUncaughtException,
  handleUnhandledRejection,
  registerCrashGuard,
} from "./crashGuard.js";

describe("crashGuard handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handleUncaughtException logs the full error and NEVER exits", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    const errors: unknown[][] = [];
    const log = { error: (...args: unknown[]) => errors.push(args) };

    const err = new Error("raw _WebSocket handshake abort");
    handleUncaughtException(err, "uncaughtException", log);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    // The actual Error object is passed through (full stack stays visible).
    expect(errors[0]).toContain(err);
    expect(String(errors[0]?.[0])).toContain("STAYS UP");
  });

  it("handleUnhandledRejection logs the reason and NEVER exits", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    const errors: unknown[][] = [];
    const log = { error: (...args: unknown[]) => errors.push(args) };

    handleUnhandledRejection("some non-error reason", log);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    // Non-Error reasons are coerced to an Error so a stack is always logged.
    expect(errors[0]?.[1]).toBeInstanceOf(Error);
    expect((errors[0]?.[1] as Error).message).toBe("some non-error reason");
  });

  it("registerCrashGuard registers process handlers without throwing", () => {
    const before = {
      ue: process.listenerCount("uncaughtException"),
      ur: process.listenerCount("unhandledRejection"),
    };
    const log = { error: () => {} };

    expect(() => registerCrashGuard(log)).not.toThrow();

    expect(process.listenerCount("uncaughtException")).toBe(before.ue + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.ur + 1);

    // Clean up the listeners we just added so we don't leak across the suite.
    const ueListeners = process.listeners("uncaughtException");
    const urListeners = process.listeners("unhandledRejection");
    process.removeListener("uncaughtException", ueListeners[ueListeners.length - 1]!);
    process.removeListener("unhandledRejection", urListeners[urListeners.length - 1]!);
  });
});
