/**
 * Tests for src/lark/profileBootstrap.ts
 *
 * Tests four behaviors (BL-19 + self-heal fix):
 *  1. Profile derivation: lark_cli_profile ?? app_id
 *  2. Always provision via config init on every startup (self-healing approach)
 *  3. Create profile when missing; degrade gracefully on failure
 *  4. Self-heal: profile registered but credential unusable → re-init is invoked
 */

import { describe, it, expect, vi } from "vitest";
import { ensureLarkCliProfile, deriveLarkCliProfile, type SpawnSyncFn } from "./profileBootstrap.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOT_ID = "activity-frontend";
const APP_ID = "cli_test_app";
const APP_SECRET = "test-secret";
const PROFILE_NAME = APP_ID; // conventional: profile name = app_id

/** Build a fake spawnSync that returns a canned result. */
function makeSpawn(results: Array<{ status: number | null; stdout?: string; stderr?: string }>): SpawnSyncFn {
  let callIdx = 0;
  return (_command: string, _args: string[]) => {
    const result = results[callIdx] ?? results[results.length - 1]!;
    callIdx++;
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      pid: 0,
      signal: null,
      output: [],
      error: undefined,
    };
  };
}

// ---------------------------------------------------------------------------
// Layer 2: deriveLarkCliProfile
// ---------------------------------------------------------------------------

describe("deriveLarkCliProfile — profile name derivation (Layer 2)", () => {
  it("returns explicit profile when lark_cli_profile is set in yaml", () => {
    expect(deriveLarkCliProfile("my-custom-profile", APP_ID)).toBe("my-custom-profile");
  });

  it("falls back to app_id when lark_cli_profile is undefined (no yaml field)", () => {
    expect(deriveLarkCliProfile(undefined, APP_ID)).toBe(APP_ID);
  });

  it("falls back to app_id when lark_cli_profile is undefined and app_id differs", () => {
    const OTHER_APP_ID = "cli_other_app";
    expect(deriveLarkCliProfile(undefined, OTHER_APP_ID)).toBe(OTHER_APP_ID);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: ensureLarkCliProfile — always provisions (self-healing approach)
// ---------------------------------------------------------------------------

describe("ensureLarkCliProfile — always provisions via config init on startup (Layer 3)", () => {
  it("calls config init on every startup, even when profile already appears registered", () => {
    // Self-heal rationale: config show returning exit 0 + correct appId does NOT
    // prove the stored credential is usable (e.g. keychain drift, legacy nameless
    // profile). Always re-provisioning is the only way to guarantee usability.
    const initArgs = vi.fn();
    const spawn: SpawnSyncFn = (_cmd, args, _opts) => {
      if (args.includes("init")) initArgs(args);
      return {
        status: 0,
        stdout: `{"appId": "${APP_ID}"}`,
        stderr: "",
        pid: 0,
        signal: null,
        output: [],
        error: undefined,
      };
    };
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole);

    // config init must have been called (self-healing: always re-provision)
    expect(initArgs).toHaveBeenCalledOnce();
    const capturedArgs = initArgs.mock.calls[0]![0] as string[];
    // --name invariant: must always include --name to avoid clobbering
    // the shared default profile
    expect(capturedArgs).toContain("--name");
    expect(capturedArgs).toContain(PROFILE_NAME);
    expect(fakeConsole.warn).not.toHaveBeenCalled();
  });

  it("logs success when config init exits 0", () => {
    const spawn = makeSpawn([{ status: 0 }]);
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole);

    expect(fakeConsole.log).toHaveBeenCalledWith(
      expect.stringContaining("provisioned OK"),
    );
    expect(fakeConsole.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 3: ensureLarkCliProfile — self-heal: credential unusable → re-init
// ---------------------------------------------------------------------------

describe("ensureLarkCliProfile — self-heal: registered profile with unusable credential (Layer 3)", () => {
  it("re-inits when profile exists in config show but credential is unreadable at runtime", () => {
    // Simulates the production incident: a legacy profile whose `name` field was
    // absent (created without --name) reports the correct appId via config show,
    // but its secret cannot be decrypted. The self-healing approach always runs
    // config init, so the credential is unconditionally re-written from .env.
    const initArgs = vi.fn();
    const showCalled = vi.fn();
    const spawn: SpawnSyncFn = (_cmd, args, _opts) => {
      if (args.includes("show")) {
        showCalled();
        // Profile appears registered (exit 0 + correct appId) but credential
        // is actually corrupt — this is indistinguishable via config show alone.
        return {
          status: 0,
          stdout: `{"appId": "${APP_ID}"}`,
          stderr: "",
          pid: 0,
          signal: null,
          output: [],
          error: undefined,
        };
      }
      if (args.includes("init")) {
        initArgs(args);
        return { status: 0, stdout: "", stderr: "", pid: 0, signal: null, output: [], error: undefined };
      }
      return { status: 1, stdout: "", stderr: "", pid: 0, signal: null, output: [], error: undefined };
    };
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole);

    // config init must be called regardless of what config show reports
    expect(initArgs).toHaveBeenCalledOnce();
    const capturedArgs = initArgs.mock.calls[0]![0] as string[];
    expect(capturedArgs).toContain("--app-id");
    expect(capturedArgs).toContain(APP_ID);
    expect(capturedArgs).toContain("--app-secret-stdin");
    expect(capturedArgs).toContain("--name");
    expect(capturedArgs).toContain(PROFILE_NAME);
    // app_secret must NOT appear in the argument list
    expect(capturedArgs.join(" ")).not.toContain(APP_SECRET);
    expect(fakeConsole.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 3: ensureLarkCliProfile — profile missing → create
// ---------------------------------------------------------------------------

describe("ensureLarkCliProfile — profile missing, create succeeds (Layer 3)", () => {
  it("calls config init with --app-id, --app-secret-stdin, --name", () => {
    const initArgs = vi.fn();
    const spawn: SpawnSyncFn = (_cmd, args) => {
      if (args.includes("init")) initArgs(args);
      return {
        status: 0,
        stdout: "",
        stderr: "",
        pid: 0,
        signal: null,
        output: [],
        error: undefined,
      };
    };
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole);

    expect(initArgs).toHaveBeenCalledOnce();
    const capturedArgs = initArgs.mock.calls[0]![0] as string[];
    expect(capturedArgs).toContain("--app-id");
    expect(capturedArgs).toContain(APP_ID);
    expect(capturedArgs).toContain("--app-secret-stdin");
    expect(capturedArgs).toContain("--name");
    expect(capturedArgs).toContain(PROFILE_NAME);
    // app_secret must NOT appear in the argument list
    expect(capturedArgs.join(" ")).not.toContain(APP_SECRET);
    expect(fakeConsole.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 3: ensureLarkCliProfile — creation fails → non-fatal warn
// ---------------------------------------------------------------------------

describe("ensureLarkCliProfile — profile provisioning fails, degrades gracefully (Layer 3)", () => {
  it("emits a WARNING when config init exits non-zero, does not throw", () => {
    const spawn = makeSpawn([
      { status: 1, stderr: "unsupported flag" },  // init: failure
    ]);
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    // Must NOT throw
    expect(() =>
      ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole),
    ).not.toThrow();

    expect(fakeConsole.warn).toHaveBeenCalledOnce();
    const warnMsg = fakeConsole.warn.mock.calls[0]![0] as string;
    expect(warnMsg).toContain("WARNING");
    expect(warnMsg).toContain(BOT_ID);
    expect(warnMsg).toContain(PROFILE_NAME);
    // Warn message must include the manual fix hint
    expect(warnMsg).toContain("lark-cli config init");
    expect(warnMsg).toContain(APP_ID);
    // Must NOT leak the secret
    expect(warnMsg).not.toContain(APP_SECRET);
  });

  it("emits a WARNING when spawnSync throws (e.g. lark-cli not found), does not rethrow", () => {
    const spawn: SpawnSyncFn = (_cmd, _args) => {
      throw new Error("spawn ENOENT");
    };
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    expect(() =>
      ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole),
    ).not.toThrow();

    expect(fakeConsole.warn).toHaveBeenCalledOnce();
    const warnMsg = fakeConsole.warn.mock.calls[0]![0] as string;
    expect(warnMsg).toContain("WARNING");
    expect(warnMsg).not.toContain(APP_SECRET);
  });

  it("never leaks appSecret in logged messages on success path", () => {
    const spawn = makeSpawn([
      { status: 0 },  // init: success
    ]);
    const fakeConsole = { log: vi.fn(), warn: vi.fn() };

    ensureLarkCliProfile(BOT_ID, PROFILE_NAME, APP_ID, APP_SECRET, spawn, fakeConsole);

    const allLogs = [
      ...fakeConsole.log.mock.calls.flat(),
      ...fakeConsole.warn.mock.calls.flat(),
    ].join(" ");
    expect(allLogs).not.toContain(APP_SECRET);
  });
});
