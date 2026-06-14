/**
 * Tests for src/config/paths.ts — pure path resolution helpers.
 */

import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  LEGACY_BOT_ID,
  larkwayHome,
  resolveLarkwayDir,
  resolveSessionsPath,
  resolveWorktreePath,
  resolveLogsDir,
  resolveAgentWorkspacePath,
  resolveAgentWorkspaceSessionsDir,
  resolveAgentSessionPath,
  resolveAgentWorkspaceReposDir,
} from "./paths.js";

const HOME = homedir();
const ROOT_V1 = join(HOME, ".larkway");

describe("larkwayHome — $LARKWAY_HOME isolation", () => {
  const saved = process.env.LARKWAY_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.LARKWAY_HOME;
    else process.env.LARKWAY_HOME = saved;
  });

  it("defaults to ~/.larkway when LARKWAY_HOME is unset", () => {
    delete process.env.LARKWAY_HOME;
    expect(larkwayHome()).toBe(ROOT_V1);
  });

  it("honors LARKWAY_HOME (resolved to absolute) when set", () => {
    process.env.LARKWAY_HOME = "/tmp/larkway-iso";
    expect(larkwayHome()).toBe(resolve("/tmp/larkway-iso"));
  });

  it("ignores blank LARKWAY_HOME (treats as unset)", () => {
    process.env.LARKWAY_HOME = "   ";
    expect(larkwayHome()).toBe(ROOT_V1);
  });

  it("derived paths (larkwayDir/sessions/logs) all follow LARKWAY_HOME", () => {
    process.env.LARKWAY_HOME = "/tmp/larkway-iso";
    const root = resolve("/tmp/larkway-iso");
    expect(resolveLarkwayDir()).toBe(root);
    expect(resolveLarkwayDir("bot-x")).toBe(join(root, "bot-x"));
    expect(resolveSessionsPath("bot-x")).toBe(join(root, "bot-x", "sessions.json"));
    expect(resolveLogsDir("bot-x")).toBe(join(root, "bot-x", "logs"));
  });
});

describe("resolveLarkwayDir", () => {
  it("V1 mode (undefined botId) returns ~/.larkway", () => {
    expect(resolveLarkwayDir()).toBe(ROOT_V1);
  });

  it("V1 mode (LEGACY_BOT_ID 'v1-default') returns ~/.larkway", () => {
    expect(resolveLarkwayDir(LEGACY_BOT_ID)).toBe(ROOT_V1);
    expect(resolveLarkwayDir("v1-default")).toBe(ROOT_V1);
  });

  it("V2 mode (real botId) returns ~/.larkway/<botId>", () => {
    expect(resolveLarkwayDir("activity-frontend")).toBe(
      join(HOME, ".larkway", "activity-frontend"),
    );
    expect(resolveLarkwayDir("lee-qa")).toBe(join(HOME, ".larkway", "lee-qa"));
  });
});

describe("resolveSessionsPath", () => {
  it("V1: ~/.larkway/sessions.json", () => {
    expect(resolveSessionsPath()).toBe(join(ROOT_V1, "sessions.json"));
  });

  it("V2: ~/.larkway/<botId>/sessions.json", () => {
    expect(resolveSessionsPath("activity-frontend")).toBe(
      join(HOME, ".larkway", "activity-frontend", "sessions.json"),
    );
  });
});

describe("resolveWorktreePath", () => {
  it("V1: undefined botId → ~/.larkway/worktrees/<threadId>", () => {
    expect(resolveWorktreePath(undefined, "om_abc123")).toBe(
      join(ROOT_V1, "worktrees", "om_abc123"),
    );
  });

  it("V1: LEGACY_BOT_ID treated as V1 → ~/.larkway/worktrees/<threadId>", () => {
    expect(resolveWorktreePath(LEGACY_BOT_ID, "om_abc123")).toBe(
      join(ROOT_V1, "worktrees", "om_abc123"),
    );
  });

  it("V2: real botId → ~/.larkway/<botId>/worktrees/<threadId>", () => {
    expect(resolveWorktreePath("activity-frontend", "om_lucky")).toBe(
      join(HOME, ".larkway", "activity-frontend", "worktrees", "om_lucky"),
    );
  });
});

describe("resolveLogsDir", () => {
  it("V1: ~/.larkway/logs", () => {
    expect(resolveLogsDir()).toBe(join(ROOT_V1, "logs"));
  });

  it("V2: ~/.larkway/<botId>/logs", () => {
    expect(resolveLogsDir("activity-frontend")).toBe(
      join(HOME, ".larkway", "activity-frontend", "logs"),
    );
  });
});

describe("agent workspace paths", () => {
  const saved = process.env.LARKWAY_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.LARKWAY_HOME;
    else process.env.LARKWAY_HOME = saved;
  });

  it("resolves an agent workspace under ~/.larkway/agents/<agentId>/workspace", () => {
    expect(resolveAgentWorkspacePath("larkway-devops")).toBe(
      join(ROOT_V1, "agents", "larkway-devops", "workspace"),
    );
  });

  it("resolves session and repo directories inside the agent workspace", () => {
    const workspace = join(ROOT_V1, "agents", "larkway-devops", "workspace");
    expect(resolveAgentWorkspaceSessionsDir("larkway-devops")).toBe(
      join(workspace, "sessions"),
    );
    expect(resolveAgentSessionPath("larkway-devops", "om_abc123")).toBe(
      join(workspace, "sessions", "om_abc123"),
    );
    expect(resolveAgentWorkspaceReposDir("larkway-devops")).toBe(
      join(workspace, "repos"),
    );
  });

  it("agent workspace paths follow LARKWAY_HOME", () => {
    process.env.LARKWAY_HOME = "/tmp/larkway-iso";
    const root = resolve("/tmp/larkway-iso");
    expect(resolveAgentWorkspacePath("devops")).toBe(
      join(root, "agents", "devops", "workspace"),
    );
  });

  it("keeps larkway-devops workspace separate from this source checkout", () => {
    expect(resolveAgentWorkspacePath("larkway-devops")).not.toBe(
      "/path/to/larkway",
    );
  });

  it("rejects unsafe agent and thread path segments", () => {
    expect(() => resolveAgentWorkspacePath("../x")).toThrow(/safe path segment/);
    expect(() => resolveAgentSessionPath("devops", "../om_x")).toThrow(
      /safe path segment/,
    );
  });
});
