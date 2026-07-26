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
 *
 * v3.4 `--adopt` mode (docs/task-handle.md §7) never touches the SDK Client
 * mock above at all — it goes entirely through ../userTasklistOps.js's
 * lark-cli-shelling functions, ALSO mocked here for the same "never spawn a
 * real subprocess in a unit test" reason; that module has its own dedicated
 * test file (../userTasklistOps.test.ts) covering the spawn/parse logic.
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
import type { UserOpResult, UserTasklistSummary } from "../userTasklistOps.js";

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
let mockAddMembersThrows404: boolean;
let mockAddMembersThrowsScope: boolean;
let mockAddMembersThrowsDeleted: boolean;
/**
 * When true, the fake platform silently DROPS every user-type member from
 * create/add_members (apps land fine) — simulating the "member silently
 * dropped" failure mode the membership safety net guards against.
 *
 * This is a flag on the ONE shared SDK mock rather than a per-test
 * `vi.doMock` override, deliberately: re-registering `vi.doMock` for a module
 * the suite-level beforeEach ALREADY queued is flaky. @vitest/mocker's
 * queueMock (vitest 4.1.7) resolves each registration through an async RPC
 * and writes the registry in the `.then()` — so the WINNING factory is
 * whichever RPC completes LAST, not whichever was registered last. Under a
 * cold transform cache or a loaded full-suite run, the beforeEach factory can
 * complete after the per-test one and silently win, making the per-test
 * override a no-op (observed: full `pnpm test` flaked exactly this way while
 * single-file runs stayed green). One doMock per module per test, always.
 */
let mockPlatformDropsUserMembers: boolean;

// v3.4 --adopt mode: controllable results for the mocked userTasklistOps.js functions.
let mockedListUserTasklists: UserOpResult<UserTasklistSummary[]>;
let mockedAddTasklistMembersAsUser: UserOpResult<unknown>;
let mockedGetUserTasklistMembers: UserOpResult<Array<{ id: string; type?: string; role?: string }>>;
let capturedAddMembersAsUserCall: { profile: string; tasklistGuid: string; members: unknown[] } | undefined;

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
  mockAddMembersThrows404 = false;
  mockAddMembersThrowsScope = false;
  mockAddMembersThrowsDeleted = false;
  mockPlatformDropsUserMembers = false;
  mockedAutoResolvedOwner = undefined; // default: auto-detect finds nothing, same as no lark-cli user login
  // v3.4 --adopt mode defaults — individual tests override to exercise each branch.
  mockedListUserTasklists = { ok: true, data: [] };
  mockedAddTasklistMembersAsUser = { ok: true, data: {} };
  mockedGetUserTasklistMembers = { ok: true, data: [] };
  capturedAddMembersAsUserCall = undefined;
  vi.resetModules();
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    Client: class {
      async request(config: { method: string; url: string; data?: unknown }) {
        capturedRequests.push(config);
        if (config.url.endsWith("/tasklists") && config.method === "POST") {
          const data = config.data as { members?: FakeMember[] };
          currentMembers = (data.members ?? []).filter((m) => !mockPlatformDropsUserMembers || m.type !== "user");
          return { data: { tasklist: { guid: "tl-created-1", members: currentMembers } } };
        }
        if (config.url.includes("/add_members") && config.method === "POST") {
          // Throw axios-shaped errors so the REAL TaskListClient.wrapErr path
          // constructs a realistic TaskApiError (status/code) — mirroring the
          // real machine, where a gateway 404 body is plain text (no parseable
          // code) and the message is axios's generic one.
          if (mockAddMembersThrows404) {
            const e = new Error("Request failed with status code 404");
            (e as { response?: unknown }).response = { status: 404, data: "404 page not found" };
            throw e;
          }
          if (mockAddMembersThrowsScope) {
            const e = new Error("Request failed with status code 403");
            (e as { response?: unknown }).response = { status: 403, data: { code: 1470403, msg: "no permission" } };
            throw e;
          }
          if (mockAddMembersThrowsDeleted) {
            // TOCTOU: reused guid deleted → business resource-not-exist WITH a code.
            const e = new Error("Request failed with status code 404");
            (e as { response?: unknown }).response = { status: 404, data: { code: 1470404, msg: "resource not exist" } };
            throw e;
          }
          const data = config.data as { members?: FakeMember[] };
          for (const m of data.members ?? []) {
            if (mockPlatformDropsUserMembers && m.type === "user") continue;
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
  vi.doMock("../userTasklistOps.js", () => ({
    searchUserTasklists: () => mockedListUserTasklists,
    addTasklistMembersAsUser: (profile: string, tasklistGuid: string, members: unknown[]) => {
      capturedAddMembersAsUserCall = { profile, tasklistGuid, members };
      return mockedAddTasklistMembersAsUser;
    },
    getUserTasklistMembers: () => mockedGetUserTasklistMembers,
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
  vi.doUnmock("../userTasklistOps.js");
  vi.resetModules();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("tasklist-init help (v3.4: --help routed here as [\"help\"] by cli/index.ts)", () => {
  it("prints the detailed USAGE and exits 0, with zero config/bots required", async () => {
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["help"]);
    expect(code).toBe(0);
    expect(ui.print).toHaveBeenCalledWith(expect.stringContaining("帮我配置一下 Agent Team"));
    expect(ui.print).toHaveBeenCalledWith(expect.stringContaining("--adopt-guid"));
    expect(ui.failure).not.toHaveBeenCalled();
  });
});

describe("tasklist-init --team", () => {
  it("v3.4: --team omitted with NO bots configured anywhere → clear failure (nothing to provision for)", async () => {
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), []);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("没有配置任何 bot"));
  });

  it("v3.4: --team omitted defaults to every configured bot (zero-arg happy path, create fallback)", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    await makeBot("bot-b", "cli_b", "BOT_B_SECRET");
    mockedListUserTasklists = { ok: true, data: [] }; // no same-named tasklist → auto-select falls through to create
    mockedAutoResolvedOwner = "ou_owner1234567890";
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx({ json: true }), []);
    expect(code).toBe(0);
    expect(ui.emitJson).toHaveBeenCalledWith(expect.objectContaining({ ok: true, team: ["bot-a", "bot-b"], reused: false }));
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

      const addMembersCall = capturedRequests.find(
        (r) => r.url.includes("/add_members") && r.method === "POST",
      );
      expect(addMembersCall?.url).toBe("/open-apis/task/v2/tasklists/tl-pre-existing/add_members");
      expect(addMembersCall?.data).toMatchObject({
        members: [
          { id: "ou_owner", type: "user", role: "editor" },
          { id: "cli_a", type: "app", role: "editor" },
        ],
      });

      // Registry still points at the same pre-existing guid — untouched.
      await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-pre-existing");
    });

    it("BL-32 #2: a 404 from add_members on the reuse path warns + continues (exit 0), not fatal", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { claimTeamTasklistGuid, readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
      await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-pre-existing");
      mockAddMembersThrows404 = true; // bare gateway 404 (no business code) stays best-effort

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      // Same best-effort posture as the bridge self-join — the reused list is fine.
      expect(code).toBe(0);
      expect(ui.warning).toHaveBeenCalled();
      // Did NOT create a duplicate board on the way.
      expect(capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST")).toBeUndefined();
      await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-pre-existing");
    });

    it("BL-32 #2: a NON-404 add_members failure on the reuse path still fails hard (exit 1)", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { claimTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
      await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-pre-existing");
      mockAddMembersThrowsScope = true; // a real scope failure (not a 404) must still surface

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(1);
    });

    it("BL-32 #2 (narrowed): a DELETED-tasklist 'not found' (TOCTOU, not the app-member 404) still fails hard", async () => {
      // The narrowed isMembersEndpoint404 must NOT swallow a resource_not_exist /
      // "tasklist not found" — that means the reused guid was deleted, a real
      // error the operator needs to see, not the benign app-member endpoint 404.
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      const { claimTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
      const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
      await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-pre-existing");
      mockAddMembersThrowsDeleted = true;

      const { run } = await import("./tasklistInit.js");
      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(1);
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
      // Simulate the platform silently dropping the owner member: create/GET
      // only ever report the bot app, never the owner. Flag on the shared SDK
      // mock — NOT a second vi.doMock — see mockPlatformDropsUserMembers's doc
      // comment for the doMock re-registration race this avoids.
      mockPlatformDropsUserMembers = true;
      const { run } = await import("./tasklistInit.js");

      const code = await run(makeCtx(), ["--team", "bot-a", "--owner", "ou_owner"]);
      expect(code).toBe(0);
      expect(ui.warning).toHaveBeenCalledWith(expect.stringContaining("ou_owner"));
    });

    it("reports ownerConfirmedMember:false in JSON mode when the owner is missing from the readback", async () => {
      await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
      mockPlatformDropsUserMembers = true;
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

describe("tasklist-init --adopt (v3.4, docs/task-handle.md §7)", () => {
  it("fails with usage when --adopt is passed an empty name", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "", "--team", "bot-a"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalled();
  });

  it("v3.4: --team still defaults to every configured bot in explicit --adopt mode (no bots → clear failure)", async () => {
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("没有配置任何 bot"));
  });

  it("fails with an actionable auth-login hint when listUserTasklists fails (no user identity / missing scope)", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: false, error: "need_user_authorization" };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("lark-cli auth login"));
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("--domain task"));
  });

  it("fails clearly when no tasklist matches the given name", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-other", name: "Some Other List" }] };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("没找到"));
  });

  it("fails clearly (listing every guid) when MULTIPLE tasklists share the given name", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = {
      ok: true,
      data: [
        { guid: "tl-dup-1", name: "Agent Team" },
        { guid: "tl-dup-2", name: "Agent Team" },
      ],
    };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("tl-dup-1"));
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("tl-dup-2"));
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("--adopt-guid"));
  });

  it("--adopt-guid bypasses the by-name lookup entirely, even when listUserTasklists would fail", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: false, error: "should never be consulted" };
    mockedGetUserTasklistMembers = { ok: true, data: [{ id: "cli_a", type: "app", role: "editor" }] };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a", "--adopt-guid", "tl-explicit"]);
    expect(code).toBe(0);
    expect(capturedAddMembersAsUserCall?.tasklistGuid).toBe("tl-explicit");
  });

  it("--adopt-guid alone (no --adopt) forces adopt mode, skipping the create/reuse path entirely", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedGetUserTasklistMembers = { ok: true, data: [{ id: "cli_a", type: "app", role: "editor" }] };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "bot-a", "--adopt-guid", "tl-explicit"]);
    expect(code).toBe(0);
    expect(capturedAddMembersAsUserCall?.tasklistGuid).toBe("tl-explicit");
    // Never touched the SDK-based create/reuse path.
    expect(capturedRequests.find((r) => r.url.endsWith("/tasklists"))).toBeUndefined();
  });

  it("happy path: finds the single match, adds every --team bot as editor, writes the registry, confirms readback", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    await makeBot("bot-b", "cli_b", "BOT_B_SECRET");
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-adopted-1", name: "Agent Team" }] };
    mockedGetUserTasklistMembers = {
      ok: true,
      data: [
        { id: "cli_a", type: "app", role: "editor" },
        { id: "cli_b", type: "app", role: "editor" },
      ],
    };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx({ json: true }), ["--adopt", "Agent Team", "--team", "bot-a,bot-b"]);

    expect(code).toBe(0);
    expect(capturedAddMembersAsUserCall?.tasklistGuid).toBe("tl-adopted-1");
    expect(capturedAddMembersAsUserCall?.members).toEqual([
      { id: "cli_a", type: "app", role: "editor" },
      { id: "cli_b", type: "app", role: "editor" },
    ]);
    expect(ui.emitJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        mode: "adopt",
        adoptedName: "Agent Team",
        tasklistGuid: "tl-adopted-1",
        missingBots: [],
        registryMismatch: false,
      }),
    );

    const { readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
    const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
    await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-adopted-1");
  });

  it("warns (does not fail) when a bot is missing from the post-add readback", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-adopted-1", name: "Agent Team" }] };
    mockedGetUserTasklistMembers = { ok: true, data: [] }; // bot-a never actually landed
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a"]);
    expect(code).toBe(0);
    expect(ui.warning).toHaveBeenCalledWith(expect.stringContaining("bot-a")); // reports the bot's config id
  });

  it("fails clearly (actionable scope hint) when addTasklistMembersAsUser fails", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-adopted-1", name: "Agent Team" }] };
    mockedAddTasklistMembersAsUser = { ok: false, error: "no permission" };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a"]);
    expect(code).toBe(1);
    expect(ui.failure).toHaveBeenCalledWith(expect.stringContaining("task:tasklist:write"));
  });

  it("does NOT overwrite an already-registered DIFFERENT guid without --force — warns about the mismatch instead", async () => {
    const { claimTeamTasklistGuid, readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
    const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
    await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-preexisting");

    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-adopted-new", name: "Agent Team" }] };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a"]);

    expect(code).toBe(0); // members were still added to the adopted list — only the registry write is skipped
    expect(ui.warning).toHaveBeenCalledWith(expect.stringContaining("--force"));
    await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-preexisting"); // unchanged
  });

  it("--force overwrites an already-registered guid with the newly adopted one", async () => {
    const { claimTeamTasklistGuid, readTeamTasklistGuid } = await import("../../tasklist/teamRegistry.js");
    const { resolveTaskTeamRegistryPath } = await import("../../config/paths.js");
    await claimTeamTasklistGuid(resolveTaskTeamRegistryPath(), "tl-preexisting");

    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-adopted-new", name: "Agent Team" }] };
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--adopt", "Agent Team", "--team", "bot-a", "--force"]);

    expect(code).toBe(0);
    await expect(readTeamTasklistGuid(resolveTaskTeamRegistryPath())).resolves.toBe("tl-adopted-new");
  });
});

describe("tasklist-init zero-arg = CREATE by design (adopt is explicit-only, 2026-07 ownership decision)", () => {
  it("CREATES a bot-app-owned board and does NOT auto-adopt, even when a same-named list is visible", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    // A same-named board the operator could see — pre-decision this would have
    // been auto-adopted. Now zero-arg must ignore it and CREATE (owner=bot app).
    mockedListUserTasklists = { ok: true, data: [{ guid: "tl-visible", name: "Agent Team" }] };
    mockedAutoResolvedOwner = "ou_owner1234567890";
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx({ json: true }), ["--team", "bot-a"]);
    expect(code).toBe(0);
    // Went through the SDK create path, NOT the user-identity adopt path.
    expect(capturedRequests.find((r) => r.url.endsWith("/tasklists") && r.method === "POST")).toBeDefined();
    expect(capturedAddMembersAsUserCall).toBeUndefined(); // adopt's user-identity add never ran
    expect(ui.emitJson).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tasklistGuid: "tl-created-1" }));
  });

  it("CREATES even when MULTIPLE same-named lists are visible — no ambiguity failure (never queries)", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    // Pre-decision this hard-failed as ambiguous; now zero-arg never queries, so
    // it just creates.
    mockedListUserTasklists = {
      ok: true,
      data: [
        { guid: "tl-dup-1", name: "Agent Team" },
        { guid: "tl-dup-2", name: "Agent Team" },
      ],
    };
    mockedAutoResolvedOwner = "ou_owner1234567890";
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx({ json: true }), ["--team", "bot-a"]);
    expect(code).toBe(0);
    expect(ui.emitJson).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tasklistGuid: "tl-created-1" }));
  });

  it("CREATES with no loud duplicate-warning (zero-arg has no adopt query to fail)", async () => {
    await makeBot("bot-a", "cli_a", "BOT_A_SECRET");
    mockedListUserTasklists = { ok: false, error: "should never be consulted in zero-arg" };
    mockedAutoResolvedOwner = "ou_owner1234567890";
    const { run } = await import("./tasklistInit.js");
    const code = await run(makeCtx(), ["--team", "bot-a"]); // non-JSON
    expect(code).toBe(0);
    const warnedText = (ui.warning as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(warnedText).not.toContain("重复"); // no duplicate scare — zero-arg doesn't query
  });
});
