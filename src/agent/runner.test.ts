/**
 * Tests for src/agent/runner.ts — registry (registerRunner / createRunner).
 */
import { describe, it, expect, beforeEach } from "vitest";

// We import the real module but use unique backend names per test to avoid
// polluting the module-level singleton registry across tests.
import { registerRunner, createRunner, createPerfMarker, markPerfForEventType } from "./runner.js";
import type { AgentRunner, RunHandle, RunOptions, AgentStreamEvent, PerfMarkerName } from "./runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeRunner(): AgentRunner {
  return {
    run(_opts: RunOptions): RunHandle {
      const events = (async function* () {})();
      return {
        events,
        done: Promise.resolve({ exitCode: 0 }),
        kill: () => {},
      };
    },
  };
}

// Use a unique prefix per describe block so parallel test files can't collide.
let counter = 0;
function uniqueName(label: string): string {
  return `test-${label}-${++counter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerRunner / createRunner", () => {
  // Each test uses unique backend names, so no beforeEach cleanup needed.

  it("returns the registered runner instance after registerRunner", () => {
    const name = uniqueName("fake");
    const fake = makeFakeRunner();

    registerRunner(name, () => fake);

    const runner = createRunner(name);
    expect(runner).toBe(fake);
  });

  it("throws for an unknown backend and error message contains registered names", () => {
    const known = uniqueName("known");
    registerRunner(known, () => makeFakeRunner());

    const unknown = uniqueName("does-not-exist");

    expect(() => createRunner(unknown)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(known),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// A0 (perf plan): createPerfMarker / markPerfForEventType
// ---------------------------------------------------------------------------

describe("createPerfMarker", () => {
  it("invokes the sink with a numeric (monotonic) timestamp", () => {
    const calls: Array<{ marker: PerfMarkerName; atMs: number }> = [];
    const mark = createPerfMarker((marker, atMs) => calls.push({ marker, atMs }));

    mark("spawn");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.marker).toBe("spawn");
    expect(typeof calls[0]!.atMs).toBe("number");
    expect(Number.isFinite(calls[0]!.atMs)).toBe(true);
  });

  it("fires each marker name at most once — later calls for the same name are no-ops", () => {
    const calls: PerfMarkerName[] = [];
    const mark = createPerfMarker((marker) => calls.push(marker));

    mark("first_line");
    mark("first_line");
    mark("first_line");
    mark("session_init");

    expect(calls).toEqual(["first_line", "session_init"]);
  });

  it("is a safe no-op when no sink is provided", () => {
    const mark = createPerfMarker(undefined);
    expect(() => mark("spawn")).not.toThrow();
  });

  it("swallows a throwing sink — the runner must never break because of a perf marker", () => {
    const mark = createPerfMarker(() => {
      throw new Error("sink boom");
    });
    expect(() => mark("spawn")).not.toThrow();
  });
});

describe("markPerfForEventType", () => {
  function collect(): { mark: (m: PerfMarkerName) => void; calls: PerfMarkerName[] } {
    const calls: PerfMarkerName[] = [];
    return { mark: (m) => calls.push(m), calls };
  }

  it("maps system_init to the session_init marker", () => {
    const { mark, calls } = collect();
    markPerfForEventType(mark, "system_init");
    expect(calls).toEqual(["session_init"]);
  });

  it.each<AgentStreamEvent["type"]>([
    "answer_delta",
    "answer_snapshot",
    "internal_text",
    "text_delta",
  ])("maps %s to the first_content marker", (eventType) => {
    const { mark, calls } = collect();
    markPerfForEventType(mark, eventType);
    expect(calls).toEqual(["first_content"]);
  });

  it.each<AgentStreamEvent["type"]>(["tool_use", "tool_result", "result", "raw"])(
    "is a no-op for %s (not a perf-marker-relevant event type)",
    (eventType) => {
      const { mark, calls } = collect();
      markPerfForEventType(mark, eventType);
      expect(calls).toEqual([]);
    },
  );
});
