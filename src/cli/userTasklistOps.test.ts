/**
 * Tests for src/cli/userTasklistOps.ts
 *
 * Mirrors ownerIdentity.test.ts's injectable-spawnSync pattern — a fake
 * spawnSync stands in for the real `lark-cli task tasklists ...` subprocess
 * call so no test ever spawns a real process.
 */

import { describe, it, expect } from "vitest";
import {
  searchUserTasklists,
  addTasklistMembersAsUser,
  getUserTasklistMembers,
  type SpawnSyncFn,
} from "./userTasklistOps.js";

const PROFILE = "cli_test_app";

function makeSpawn(result: { status: number | null; stdout?: string; stderr?: string }): SpawnSyncFn {
  return (_command: string, _args: string[]) => ({
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    pid: 0,
    signal: null,
    output: [],
    error: undefined,
  });
}

describe("searchUserTasklists", () => {
  it("calls the +tasklist-search skill (not the raw list) with --as user + --query (BL-32)", () => {
    let capturedArgs: string[] = [];
    const spawn: SpawnSyncFn = (_cmd, args) => {
      capturedArgs = args;
      return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: "", pid: 0, signal: null, output: [], error: undefined };
    };
    searchUserTasklists(PROFILE, "Agent Team", spawn);
    // The raw `tasklists list` command false-negatives its own scope precheck;
    // the working call is the skill + a name query.
    expect(capturedArgs).toContain("+tasklist-search");
    expect(capturedArgs).not.toContain("list");
    expect(capturedArgs).toEqual(expect.arrayContaining(["--as", "user", "--query", "Agent Team", "--profile", PROFILE]));
  });

  it("parses guid + name out of a successful search response (items shape)", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({ items: [{ guid: "tl-1", name: "Agent Team" }, { guid: "tl-2", name: "个人清单" }] }),
    });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result).toEqual({ ok: true, data: [{ guid: "tl-1", name: "Agent Team" }, { guid: "tl-2", name: "个人清单" }] });
  });

  it("also parses a `tasklists`-keyed or top-level-array envelope (shape-robust)", () => {
    const keyed = makeSpawn({ status: 0, stdout: JSON.stringify({ tasklists: [{ guid: "tl-1", name: "Agent Team" }] }) });
    expect(searchUserTasklists(PROFILE, "Agent Team", keyed)).toEqual({ ok: true, data: [{ guid: "tl-1", name: "Agent Team" }] });
    const topArray = makeSpawn({ status: 0, stdout: JSON.stringify([{ guid: "tl-9", name: "Agent Team" }]) });
    expect(searchUserTasklists(PROFILE, "Agent Team", topArray)).toEqual({ ok: true, data: [{ guid: "tl-9", name: "Agent Team" }] });
  });

  it("treats an empty result array as a valid no-match (not an error)", () => {
    const spawn = makeSpawn({ status: 0, stdout: JSON.stringify({ items: [] }) });
    expect(searchUserTasklists(PROFILE, "Agent Team", spawn)).toEqual({ ok: true, data: [] });
  });

  it("falls back to a placeholder name when an item has no name", () => {
    const spawn = makeSpawn({ status: 0, stdout: JSON.stringify({ items: [{ guid: "tl-1" }] }) });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result).toEqual({ ok: true, data: [{ guid: "tl-1", name: "(无标题)" }] });
  });

  it("skips malformed items (no guid) without failing the whole call", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({ items: [{ name: "no guid here" }, { guid: "tl-2", name: "ok" }] }),
    });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result).toEqual({ ok: true, data: [{ guid: "tl-2", name: "ok" }] });
  });

  it("surfaces lark-cli's own error message + hint on a scope/token failure (the common real case)", () => {
    const spawn = makeSpawn({
      status: 3,
      stdout: JSON.stringify({
        ok: false,
        error: {
          message: "need_user_authorization (user: )",
          hint: "run: lark-cli auth login to re-authorize\ncurrent command requires scope(s): task:tasklist:read",
        },
      }),
    });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("need_user_authorization");
      expect(result.error).toContain("task:tasklist:read");
    }
  });

  it("fails clearly on an unrecognized shape (no array anywhere) rather than silently returning empty", () => {
    // Silent-empty here would fall through to CREATE and accrete a duplicate.
    const spawn = makeSpawn({ status: 0, stdout: JSON.stringify({ notItems: "nope" }) });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result.ok).toBe(false);
  });

  it("fails clearly on malformed JSON stdout", () => {
    const spawn = makeSpawn({ status: 0, stdout: "not json" });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result.ok).toBe(false);
  });

  it("fails clearly on empty stdout", () => {
    const spawn = makeSpawn({ status: 1, stdout: "" });
    const result = searchUserTasklists(PROFILE, "Agent Team", spawn);
    expect(result.ok).toBe(false);
  });

  it("never throws — surfaces a clear error when spawnSync itself throws (e.g. lark-cli not installed, ENOENT)", () => {
    const throwingSpawn: SpawnSyncFn = () => {
      throw new Error("spawnSync ENOENT");
    };
    expect(() => searchUserTasklists(PROFILE, "Agent Team", throwingSpawn)).not.toThrow();
    const result = searchUserTasklists(PROFILE, "Agent Team", throwingSpawn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lark-cli");
  });
});

describe("addTasklistMembersAsUser", () => {
  it("passes --as user and the tasklist-guid/data through to lark-cli", () => {
    let capturedArgs: string[] = [];
    const spawn: SpawnSyncFn = (_cmd, args) => {
      capturedArgs = args;
      return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", pid: 0, signal: null, output: [], error: undefined };
    };
    const result = addTasklistMembersAsUser(
      PROFILE,
      "tl-1",
      [{ id: "cli_app1", type: "app", role: "editor" }],
      spawn,
    );
    expect(result.ok).toBe(true);
    expect(capturedArgs).toContain("--as");
    expect(capturedArgs).toContain("user");
    expect(capturedArgs).toContain("--tasklist-guid");
    expect(capturedArgs).toContain("tl-1");
    const dataIdx = capturedArgs.indexOf("--data");
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    const dataArg = capturedArgs[dataIdx + 1]!;
    expect(JSON.parse(dataArg)).toEqual({ members: [{ id: "cli_app1", type: "app", role: "editor" }] });
  });

  it("surfaces a scope-missing error the same way searchUserTasklists does", () => {
    const spawn = makeSpawn({
      status: 3,
      stdout: JSON.stringify({
        ok: false,
        error: { message: "no permission", hint: "requires scope(s): task:tasklist:write" },
      }),
    });
    const result = addTasklistMembersAsUser(PROFILE, "tl-1", [{ id: "cli_app1", type: "app", role: "editor" }], spawn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("task:tasklist:write");
  });
});

describe("getUserTasklistMembers", () => {
  it("parses the member list out of a successful get response", () => {
    const spawn = makeSpawn({
      status: 0,
      stdout: JSON.stringify({
        tasklist: { guid: "tl-1", members: [{ id: "cli_app1", type: "app", role: "editor" }] },
      }),
    });
    const result = getUserTasklistMembers(PROFILE, "tl-1", spawn);
    expect(result).toEqual({ ok: true, data: [{ id: "cli_app1", type: "app", role: "editor" }] });
  });

  it("fails clearly when tasklist.members is missing", () => {
    const spawn = makeSpawn({ status: 0, stdout: JSON.stringify({ tasklist: { guid: "tl-1" } }) });
    const result = getUserTasklistMembers(PROFILE, "tl-1", spawn);
    expect(result.ok).toBe(false);
  });
});
