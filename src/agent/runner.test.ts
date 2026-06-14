/**
 * Tests for src/agent/runner.ts — registry (registerRunner / createRunner).
 */
import { describe, it, expect, beforeEach } from "vitest";

// We import the real module but use unique backend names per test to avoid
// polluting the module-level singleton registry across tests.
import { registerRunner, createRunner } from "./runner.js";
import type { AgentRunner, RunHandle, RunOptions } from "./runner.js";

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
