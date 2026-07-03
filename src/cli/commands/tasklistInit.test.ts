/**
 * src/cli/commands/tasklistInit.test.ts
 *
 * Vitest unit tests for `larkway tasklist-init --team <bot1,bot2,…>` (v2:
 * team-shared single tasklist — see docs/task-handle.md §7).
 *
 * Isolation: LARKWAY_HOME points at a temp dir for the whole suite so bots/
 * yaml, .env secrets, and the shared team registry (task-team.json) all land
 * under it — never touching the real ~/.larkway. The Feishu SDK Client is
 * mocked (vi.doMock, same pattern as src/lark/channelClient.test.ts) so no
 * network call is ever made; requests are captured for assertion, and a
 * stateful `currentMembers` list backs GET .../tasklists/:guid so the
 * post-create/post-reuse membership safety-net readback has something
 * realistic to check. The owner open_id auto-resolver (../ownerIdentity.js)
 * is ALSO mocked in every test — its real implementation shells out to the
 * `lark-cli` binary, which must never happen in a unit test (CLAUDE.md: no
 * tests that spawn real subprocesses); resolveOwnerOpenId itself has its own
 * dedicated test file (../ownerIdentity.test.ts) covering the spawn/parse
 * logic with an injected fake spawnSync.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ui from "../ui.js";
import * as botsStore from "../botsStore.js";
import * as hostConfig from "../hostConfig.js";
import type { CliContext } from "../types.js";
import type { BotConfig } from "../../config/botLoader.js";

type FakeMember = { id: string; type: string; role: string };

let tmpDir: string;
let origLarkwayHome: string | undefined;
let capturedRequests: { method: string; url: string; data?: unknown }[];
/** Controls what the mocked ownerIdentity.resolveOwnerOpenId returns for this test. */
let mockedAutoResolvedOwner: string | undefined;
/** Stateful backing store for the fake tasklist — mutated by create/add_members, read by GET. */
let currentMembers: FakeMember[];
/** When true, the fake GET .../tasklists/:guid handler throws instead of responding. */
let mockGetTasklistThrows: boolean;

function makeCtx(overrides: Partial<CliContext["flags"]> = {}): CliContext {
  const botsDir = path.join(tmpDir, "bots");
  return {
    paths: {
      larkwayDir: tmpDir,
      botsDir,
      configJsonPath: path.join(tmpDir, "config.json"),
      envPath: path.join(tmpDir, ".env"),
    },
    ui,
    botsStore,
    hostConfig,
    flags: { json: false, nonInteractive: true, advanced: false, ...overrides },
    cwd: tmpDir,
  };
}

async function makeBot(id: string, appId: string, secretEnv: string): Promise<void> {
  const bot: BotConfig = {
    id,
    name: id,
    description: `${id} description`,
    app_id: appId,
    app_secret_env: secretEnv,
    bot_open_id: `ou_${id}`,
    chats: [],
    peers: [],
    repos: [],
    turn_taking_limit: 10,
  } as unknown as BotConfig;
  await botsStore.writeBot(bot);
  await hostConfig.writeSecret(secretEnv, "shh-secret-value");
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-tasklistinit-test-"));
  origLarkwayHome = process.env.LARKWAY_HOME;
  process.env.LARKWAY_HOME = tmpDir;
  delete process.env.LARKWAY_BOTS_DIR; // ensure botsStore follows LARKWAY_HOME too

  capturedRequests = [];
  currentMembers = [];
  mockGetTasklistThrows = false;
  mockedAutoResolvedOwner = undefined; // default: auto-detect finds nothing, same as no lark-cli user login
  vi.resetModules();
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    Client: class {
      async request(config: { method: string; url: string; data?: unknown }) {
        capturedRequests.push(config);
        if (config.url.endsWith("/tasklists") && config.method === "POST") {
          const data = config.data as { members?: FakeMember[] };
          currentMembers = [...(data.members ?? [])];
          return { data: { tasklist: { guid: "tl-created-1", members: currentMembers } } };
        }
        if (config.url.includes("/members") && config.method === "POST") {
          const data = config.data as { members?: FakeMember[] };
          for (const m of data.members ?? []) {
            if (!currentMembers.some((existing) => existing.id === m.id)) currentMembers.push(m);
          }
          return { data: {} };
        }
        if (/\/tasklists\/[^/]+$/.test(config.url) && config.method === "GET") {
          if (mockGetTasklistThrows) throw new Error("simulated getTasklist failure");
          const guid = config.url.split("/").pop()!;
          return { data: { tasklist: { guid, members: currentMembers } } };
        }
        return { data: {} };
      }
    },
  }));
  vi.doMock("../ownerIdentity.js", () => ({
    resolveOwnerOpenId: () => mockedAutoResolvedOwner,
  }));

  vi.spyOn(ui, "print").mockImplementation(() => {});
  vi.spyOn(ui, "printErr").mockImplementation(() => {});
  vi.spyOn(ui, "success").mockImplementation(() => {});
  vi.spyOn(ui, "warning").mockImplementation(() => {});
  vi.spyOn(ui, "failure").mockImplementation(() => {});
  vi.spyOn(ui, "step").mockImplementation(() => {});
  vi.spyOn(ui, "emitJson").mockImplementation(() => {});
});

afterEach(async () => {
  if (origLarkwayHome === undefined) delete process.env.LARKWAY_HOME;
  else process.env.LARKWAY_HOME = origLarkwayHome;
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.doUnmock("../ownerIdentity.js");
  vi.resetModules();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("tasklist-init --team", () => {
  it("fails with usage when --team is missing", async () => {
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), []);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalled();
  });

  it("fails cleanly (no tasklist created) when owner can't be resolved and --owner is omitted (F2)", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "bot-a"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalled();
    // No tasklist was created — resolution must happen BEFORE any create call.
    expect(capturedRequests.find((r) => r.url.endsWith("/tasklists"))).toBeUndefined();
  });

  it("creates a tasklist with the owner as a user/editor member plus every team bot's app as editor, and writes the shared registry (--owner explicit)", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    await makeBot("bot-b", "cli_b", "BOT_B_SECRET");

    const { run } = await import("./tasklistInit.js");
    const { readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
    const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");

    const code = await run(makeCtx(), [
      "--team",
      "bot-a,bot-b",
      "--name",
      "Agent Team",
      "--owner",
      "ou_owner_explicit",
    ]);
    expect(code).toBe(0);

    const createCall = capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST");
    expect(createCall?.data).toMatchObject({
      name: "Agent Team",
      members: [
        { id: "ou_owner_explicit", type: "user", role: "editor" },
        { id: "cli_a", type: "app", role: "editor" },
        { id: "cli_b", type: "app", role: "editor" },
      ],
    });

    // No chat/group member ever added (v2: owner-private, never shared to a group).
    const memberTypes = (createCall?.data as { members: { type: string }[] }).members.map((m) => m.type);
    expect(memberTypes).not.toContain("chat");

    await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-created-1");
  });

  it("auto-resolves the owner via lark-cli when --owner is omitted and resolution succeeds", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedAutoResolvedOwner = "ou_owner_from_lark_cli";

    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "bot-a"]);
    expect(code).toBe(0);

    const createCall = capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST");
    expect(createCall?.data).toMatchObject({
      members: [
        { id: "ou_owner_from_lark_cli", type: "user", role: "editor" },
        { id: "cli_a", type: "app", role: "editor" },
      ],
    });
  });

  it("--owner explicit takes precedence over the auto-resolved value", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedAutoResolvedOwner = "ou_should_be_ignored";

    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_explicit_wins"]);
    expect(code).toBe(0);

    const createCall = capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST");
    const members = (createCall?.data as { members: { id: string }[] }).members;
    expect(members[0]?.id).toBe("ou_explicit_wins");
  });

  it("--team accepts comma-separated ids with surrounding whitespace", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    await makeBot("bot-b", "cli_b", "BOT_B_SECRET");
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", " bot-a , bot-b ", "--owner", "ou_owner"]);
    expect(code).toBe(0);
  });

  it("fails cleanly (no throw) when a listed bot id doesn't exist", async () => {
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "does-not-exist", "--owner", "ou_owner"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalled();
  });

  it("fails cleanly when a bot's app_secret_env has no secret written", async () => {
    const bot: BotConfig = {
      id: "no-secret-bot",
      name: "no-secret-bot",
      description: "desc",
      app_id: "cli_no_secret",
      app_secret_env: "NO_SECRET_ENV",
      bot_open_id: "ou_no_secret",
      chats: [],
      peers: [],
      repos: [],
      turn_taking_limit: 10,
    } as unknown as BotConfig;
    await botsStore.writeBot(bot);
    // Deliberately skip writeSecret().

    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "no-secret-bot", "--owner", "ou_owner"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalled();
  });

  describe("MAJOR fix: registry checked BEFORE creating (no duplicate boards)", () => {
    it("reuses the existing registry guid — zero createTasklist calls, add_members onto the existing tasklist instead", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { claimTeamTasklistGuid, readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
      await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-pre-existing");

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);

      // The whole point of the fix: no POST /tasklists (create) call at all.
      expect(capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST")).toBeUndefined();

      const addMembersCall = capturedRequests.find((r) => r.url.includes("/members") && r.method === "POST");
      expect(addMembersCall?.url).toBe("/open-apis/task/v2/tasklists/tl-pre-existing/members");
      expect(addMembersCall?.data).toMatchObject({
        members: [
          { id: "ou_owner", type: "user", role: "editor" },
          { id: "cli_a", type: "app", role: "editor" },
        ],
      });

      // Registry still points at the same pre-existing guid — untouched.
      await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-pre-existing");
    });

    it("reports reused:true in JSON mode when reusing", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { claimTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
      await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-pre-existing");

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx({ json: true }), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(ui.emitJson).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, reused: true, tasklistGuid: "tl-pre-existing" }),
      );
    });

    it("--force creates a NEW tasklist even when the registry already has a guid, and overwrites the registry", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { claimTeamTasklistGuid, readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
      await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-pre-existing");

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner", "--force"]);
      expect(code).toBe(0);

      const createCall = capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST");
      expect(createCall).toBeDefined();

      // Registry now points at the freshly-created guid, NOT the pre-existing one.
      await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-created-1");
    });

    it("without --force and no pre-existing registry guid, still creates normally (unchanged happy path)", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST")).toBeDefined();
      await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-created-1");
    });
  });

  describe("membership safety net", () => {
    it("warns (but still exits 0) when the owner does not appear in the post-create membership readback", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      // Simulate the platform silently dropping the owner member: the fake
      // create/GET responses below never include the owner, only the bot app.
      // vi.doMock must be registered BEFORE the dynamic import below — once a
      // module is evaluated its already-resolved imports can't be swapped out
      // by a later doMock call (no re-import happens inside run()).
      vi.doMock("@larksuiteoapi/node-sdk", () => ({
        Client: class {
          async request(config: { method: string; url: string; data?: unknown }) {
            capturedRequests.push(config);
            if (config.url.endsWith("/tasklists") && config.method === "POST") {
              return { data: { tasklist: { guid: "tl-created-1", members: [{ id: "cli_a", type: "app", role: "editor" }] } } };
            }
            if (/\/tasklists\/[^/]+$/.test(config.url) && config.method === "GET") {
              return { data: { tasklist: { guid: "tl-created-1", members: [{ id: "cli_a", type: "app", role: "editor" }] } } };
            }
            return { data: {} };
          }
        },
      }));
      const { run } = await import("./tasklistInit.js");

      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(ui.warning).toHaveBeenCalledWith(expect.stringContaining("ou_owner"));
    });

    it("reports ownerConfirmedMember:false in JSON mode when the owner is missing from the readback", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      vi.doMock("@larksuiteoapi/node-sdk", () => ({
        Client: class {
          async request(config: { method: string; url: string; data?: unknown }) {
            capturedRequests.push(config);
            if (config.url.endsWith("/tasklists") && config.method === "POST") {
              return { data: { tasklist: { guid: "tl-created-1", members: [] } } };
            }
            if (/\/tasklists\/[^/]+$/.test(config.url) && config.method === "GET") {
              return { data: { tasklist: { guid: "tl-created-1", members: [] } } };
            }
            return { data: {} };
          }
        },
      }));
      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx({ json: true }), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(ui.emitJson).toHaveBeenCalledWith(expect.objectContaining({ ownerConfirmedMember: false }));
    });

    it("does NOT fail the command when the membership readback itself throws — just warns", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      mockGetTasklistThrows = true;
      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(ui.warning).toHaveBeenCalledWith(expect.stringContaining("无法读回"));
    });

    it("confirms ownerConfirmedMember:true in JSON mode on the normal happy path (owner present in readback)", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx({ json: true }), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(ui.emitJson).toHaveBeenCalledWith(expect.objectContaining({ ownerConfirmedMember: true }));
    });
  });

  it("JSON mode reports ok/ownerOpenId/tasklistGuid/reused", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx({ json: true }), ["--team", "bot-a", "--owner", "ou_owner"]);
    expect(code).toBe(0);
    expect(ui.emitJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        ownerOpenId: "ou_owner",
        tasklistGuid: "tl-created-1",
        reused: false,
      }),
    );
  });
});
