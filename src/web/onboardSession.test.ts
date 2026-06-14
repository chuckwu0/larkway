/**
 * src/web/onboardSession.test.ts
 *
 * Tests for the页面内扫码优先 onboarding session backend.
 *
 * HARD RULE: registerApp真扫会建真飞书 app — we NEVER run the real registerApp.
 * Two layers tested:
 *   1. createBotFromCreds (the落盘核心,纯函数) against tmp botsDir/envPath with
 *      FAKE creds — asserts .env 0600 + yaml + BotConfigSchema 通过 + id 冲突报错.
 *   2. The session state machine (startOnboard/getOnboard/cancelOnboard/finalizeOnboard)
 *      driven by an INJECTED fake registerApp stub:
 *        a. QR fire → awaiting-scan → polling → awaiting-name + prefill 断言
 *        b. finalizeOnboard → done 落盘
 *        c. cancel-after-creds (awaiting-name) → 默认名落盘 no-orphan + done
 *        d. cancel-before-creds (awaiting-scan) → cancelled 不落盘
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  createBotFromCreds,
  deriveBotId,
  startOnboard,
  getOnboard,
  cancelOnboard,
  finalizeOnboard,
  _resetSessionsForTest,
  type RegisterAppFn,
  type RegisterAppResult,
  type OnboardForm,
} from "./onboardSession.js";
import { BotConfigSchema } from "../config/botLoader.js";

const FAKE_CREDS: RegisterAppResult = {
  client_id: "cli_fake12345",
  client_secret: "fakesecret-value-do-not-leak",
  user_info: { open_id: "ou_userfake", tenant_brand: "feishu" },
};

let dir: string;
let botsDir: string;
let envPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "onboard-test-"));
  botsDir = path.join(dir, "bots");
  envPath = path.join(dir, ".env");
  _resetSessionsForTest();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deriveBotId
// ---------------------------------------------------------------------------

describe("deriveBotId", () => {
  it("kebab-cases a display name", () => {
    expect(deriveBotId("Frontend Bot")).toBe("frontend-bot");
    expect(deriveBotId("Frontend_Helper!")).toBe("frontend-helper");
    expect(deriveBotId("前端 Bot 2")).toBe("bot-2");
    expect(deriveBotId("---weird---")).toBe("weird");
  });

  it("returns empty when nothing usable remains", () => {
    expect(deriveBotId("前端助手")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// createBotFromCreds — the落盘核心
// ---------------------------------------------------------------------------

describe("createBotFromCreds", () => {
  it("writes secret (0600) + yaml + memory; yaml passes BotConfigSchema", async () => {
    const form: OnboardForm = {
      name: "Frontend Bot",
      description: "builds landing pages",
      chatId: "oc_room1",
    };

    const { botId, config } = await createBotFromCreds({
      creds: FAKE_CREDS,
      form,
      botsDir,
      envPath,
      resolveBotIdentity: async () => ({ open_id: "ou_botgroup", avatar_url: "https://x/a.png" }),
    });

    expect(botId).toBe("frontend-bot");

    // .env: secret value written under the derived env name, file mode 0600.
    const envName = "LARKWAY_FRONTEND_BOT_APP_SECRET";
    expect(config.app_secret_env).toBe(envName);
    const envRaw = await readFile(envPath, "utf-8");
    expect(envRaw).toContain(`${envName}=fakesecret-value-do-not-leak`);
    const envStat = await stat(envPath);
    expect(envStat.mode & 0o777).toBe(0o600);

    // yaml: parse + schema-validate from disk; secret VALUE never in yaml.
    const yamlRaw = await readFile(path.join(botsDir, "frontend-bot.yaml"), "utf-8");
    expect(yamlRaw).not.toContain("fakesecret-value-do-not-leak");
    const parsed = yaml.load(yamlRaw);
    const valid = BotConfigSchema.parse(parsed);
    expect(valid.id).toBe("frontend-bot");
    expect(valid.name).toBe("Frontend Bot");
    expect(valid.app_id).toBe("cli_fake12345");
    expect(valid.app_secret_env).toBe(envName);
    expect(valid.bot_open_id).toBe("ou_botgroup");
    expect(valid.chats).toEqual(["oc_room1"]);
    expect(valid.memory_file).toBe("frontend-bot.memory.md");

    // memory template written.
    const mem = await readFile(path.join(botsDir, "frontend-bot.memory.md"), "utf-8");
    expect(mem).toContain("Frontend Bot");
  });

  it("keeps default permission surface when user supplies extra permission requests", async () => {
    const { botId } = await createBotFromCreds({
      creds: FAKE_CREDS,
      form: {
        name: "DevOps Bot",
        description: "develops and operates Larkway",
        chatId: "oc_room1",
        repos: [{ slug: "chuckwu0/larkway", branch: "main" }],
        gitlab_token_value: "glpat-onboard-secret-xyz",
        permission_requests: [
          "deploy/restart",
          "external message to Feishu",
        ],
        human_gates: ["deploy/restart requires explicit human confirmation"],
      },
      botsDir,
      envPath,
      resolveBotIdentity: async () => ({ open_id: "ou_devops", name: "DevOps Bot" }),
    });

    const workspace = path.join(dir, "agents", botId, "workspace");
    const request = await readFile(path.join(workspace, "permissions-request.md"), "utf8");

    expect(request).toContain("Feishu chat allowlist: oc_room1");
    expect(request).toContain("GitLab repo pointer: chuckwu0/larkway (main)");
    expect(request).toContain(`LARKWAY_BOT_${botId.toUpperCase().replace(/-/g, "_")}_GITLAB_TOKEN`);
    expect(request).toContain("deploy/restart");
    expect(request).toContain("external message to Feishu");
    expect(request).not.toContain("glpat-onboard-secret-xyz");
  });

  it("falls back to ou_pending_<id> when identity resolve yields nothing", async () => {
    const { config } = await createBotFromCreds({
      creds: { client_id: "cli_x", client_secret: "s" }, // no user_info
      form: { name: "No Identity" },
      botsDir,
      envPath,
      resolveBotIdentity: async () => ({}),
    });
    expect(config.bot_open_id).toBe("ou_pending_no-identity");
  });

  it("empty chatId → chats: [] (any group can @)", async () => {
    const { config } = await createBotFromCreds({
      creds: FAKE_CREDS,
      form: { name: "Open Bot", chatId: "" },
      botsDir,
      envPath,
    });
    expect(config.chats).toEqual([]);
  });

  it("auto-suffixes on botId conflict (never overwrites, never fails)", async () => {
    const form: OnboardForm = { name: "Dup Bot" };
    const first = await createBotFromCreds({ creds: FAKE_CREDS, form, botsDir, envPath });
    expect(first.botId).toBe("dup-bot");
    // 重试同名:不报错、不覆盖,自动 -2(扫码已建 app,绝不能因冲突而失败)
    const second = await createBotFromCreds({ creds: FAKE_CREDS, form, botsDir, envPath });
    expect(second.botId).toBe("dup-bot-2");
  });

  it("falls back to a client_id-based id when name derives nothing (中文名)", async () => {
    // 纯中文名 deriveBotId→"" → 用 client_id 兜底出合法 id,绝不抛错留孤儿 app
    const { botId, config } = await createBotFromCreds({
      creds: FAKE_CREDS,
      form: { name: "前端助手" },
      botsDir,
      envPath,
    });
    expect(botId).toMatch(/^bot-[a-z0-9]+$/);
    expect(config.id).toBe(botId);
  });

  it("honors an explicit form.botId override", async () => {
    const { botId, config } = await createBotFromCreds({
      creds: FAKE_CREDS,
      form: { name: "前端助手", botId: "qianduan" },
      botsDir,
      envPath,
    });
    expect(botId).toBe("qianduan");
    expect(config.app_secret_env).toBe("LARKWAY_QIANDUAN_APP_SECRET");
  });

  it("writes repos + turn_taking_limit into yaml", async () => {
    const form: OnboardForm = {
      name: "Code Bot",
      repos: [
        { slug: "acme/web-fe", branch: "master", url: "https://gitlab.example.com/acme/web-fe.git" },
        { slug: "acme/web-app" }, // branch defaults to "master"
      ],
      turn_taking_limit: 5,
    };

    const { config } = await createBotFromCreds({ creds: FAKE_CREDS, form, botsDir, envPath });
    expect(config.repos).toHaveLength(2);
    expect(config.repos[0].slug).toBe("acme/web-fe");
    expect(config.repos[0].url).toBe("https://gitlab.example.com/acme/web-fe.git");
    expect(config.repos[0].branch).toBe("master");
    expect(config.repos[1].slug).toBe("acme/web-app");
    expect(config.repos[1].branch).toBe("master"); // defaulted
    expect(config.turn_taking_limit).toBe(5);

    // Verify it landed on disk (schema-valid yaml).
    const yamlRaw = await readFile(path.join(botsDir, "code-bot.yaml"), "utf-8");
    const parsed = BotConfigSchema.parse(yaml.load(yamlRaw));
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.turn_taking_limit).toBe(5);
  });

  it("chats[] takes precedence over chatId when both provided", async () => {
    const form: OnboardForm = {
      name: "Chat Bot",
      chatId: "oc_legacy",
      chats: ["oc_primary", "oc_secondary"],
    };
    const { config } = await createBotFromCreds({ creds: FAKE_CREDS, form, botsDir, envPath });
    expect(config.chats).toEqual(["oc_primary", "oc_secondary"]);
  });

  it("gitlab_token_value: non-empty → writes .env secret + sets gitlab_token_env", async () => {
    const form: OnboardForm = {
      name: "Token Bot",
      gitlab_token_value: "glpat-supersecret-abc123",
      task_description: "Operate through Feishu",
      permission_requests: ["GitLab write/MR", "Local shell tests"],
      human_gates: ["deploy/restart"],
      repos: [
        {
          slug: "chuckwu0/larkway",
          branch: "main",
          url: "https://oauth2:glpat-url-secret@gitlab.example.com/chuckwu0/larkway.git",
        },
      ],
    };

    const { botId, config } = await createBotFromCreds({ creds: FAKE_CREDS, form, botsDir, envPath });
    const expectedEnvName = `LARKWAY_BOT_${botId.toUpperCase().replace(/-/g, "_")}_GITLAB_TOKEN`;
    expect(config.gitlab_token_env).toBe(expectedEnvName);

    // Secret written to .env.
    const envRaw = await readFile(envPath, "utf-8");
    expect(envRaw).toContain(`${expectedEnvName}=glpat-supersecret-abc123`);

    // yaml must NOT contain the real secret value.
    const yamlRaw = await readFile(path.join(botsDir, `${botId}.yaml`), "utf-8");
    expect(yamlRaw).not.toContain("glpat-supersecret-abc123");
    expect(yamlRaw).toContain(expectedEnvName);

    const workspace = path.join(dir, "agents", botId, "workspace");
    const permissions = await readFile(path.join(workspace, "permissions-request.md"), "utf-8");
    expect(permissions).toContain("GitLab write/MR");
    expect(permissions).toContain("type=write");
    expect(permissions).toContain("deploy/restart");
    expect(permissions).toContain(expectedEnvName);
    expect(permissions).not.toContain("glpat-supersecret-abc123");
    expect(permissions).not.toContain("fakesecret-value-do-not-leak");
    const agentsMd = await readFile(path.join(workspace, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("Operate through Feishu");
    expect(agentsMd).toContain("https://gitlab.example.com/chuckwu0/larkway.git");
    expect(agentsMd).not.toContain("glpat-url-secret");
    await expect(readFile(path.join(workspace, "tasks", "_creation", "task.md"), "utf-8")).rejects.toThrow();
    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf-8");
    expect(granted).toContain("This file is an audit note, not a startup gate.");
    expect(granted).toContain("GitLab repo pointer: chuckwu0/larkway (main)");
    expect(granted).toContain(`env=${expectedEnvName}`);
  });

  it("gitlab_token_value: empty / absent → no gitlab_token_env on new bot", async () => {
    const form: OnboardForm = {
      name: "No Token Bot",
      gitlab_token_value: "", // explicitly empty
    };
    const { config } = await createBotFromCreds({ creds: FAKE_CREDS, form, botsDir, envPath });
    expect(config.gitlab_token_env).toBeUndefined();
  });

  it("gitlab_token_value absent → no gitlab_token_env", async () => {
    const { config } = await createBotFromCreds({
      creds: FAKE_CREDS,
      form: { name: "Pure QA Bot" }, // no gitlab_token_value
      botsDir,
      envPath,
    });
    expect(config.gitlab_token_env).toBeUndefined();
    expect(config.repos).toEqual([]);
    expect(config.turn_taking_limit).toBe(10); // schema default
  });
});

// ---------------------------------------------------------------------------
// Session state machine — driven by a fake registerApp
// ---------------------------------------------------------------------------

/** Poll until getOnboard(sessionId).status === target (or throw on timeout). */
async function waitForStatus(sessionId: string, target: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getOnboard(sessionId)?.status === target) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timeout waiting for status "${target}"; got "${getOnboard(sessionId)?.status}"`,
  );
}

describe("startOnboard state machine (扫码优先)", () => {
  it("starting → awaiting-scan → polling → awaiting-name + prefill", async () => {
    // Fake registerApp: fire QR, then polling, then resolve with fake creds.
    // Defer the QR/polling callbacks past the first await so startOnboard
    // returns while still "starting" (mirrors the real SDK).
    const fakeRegister: RegisterAppFn = async (opts) => {
      await new Promise((r) => setTimeout(r, 0));
      opts.onQRCodeReady({ url: "https://feishu/qr/abc", expireIn: 300 });
      opts.onStatusChange?.({ status: "polling" });
      await new Promise((r) => setTimeout(r, 20));
      return FAKE_CREDS;
    };

    const { sessionId, status } = startOnboard({
      botsDir,
      envPath,
      registerApp: fakeRegister,
      renderQrSvg: async () => "<svg>fake</svg>",
      resolveBotIdentity: async () => ({
        open_id: "ou_flowbot",
        avatar_url: "https://x/avatar.png",
        name: "活动小助手",
      }),
    });
    expect(status).toBe("starting");

    // QR rendered → awaiting-scan → polling. The awaiting-scan→polling hop is
    // sub-ms (the fake fires onQRCodeReady + onStatusChange back-to-back), so we
    // observe at "polling"; the dedicated cancel test below observes awaiting-scan.
    await waitForStatus(sessionId, "polling");
    const polling = getOnboard(sessionId)!;
    expect(polling.url).toBe("https://feishu/qr/abc");
    expect(polling.expireIn).toBe(300);
    expect(polling.qrSvg).toBe("<svg>fake</svg>");

    // registerApp resolve → awaiting-name (NOT done — no bot written yet).
    await waitForStatus(sessionId, "awaiting-name");
    const awaitingName = getOnboard(sessionId)!;
    expect(awaitingName.status).toBe("awaiting-name");

    // prefill populated from resolveBotIdentity
    expect(awaitingName.prefill).toBeDefined();
    expect(awaitingName.prefill!.appId).toBe("cli_fake12345");
    expect(awaitingName.prefill!.openId).toBe("ou_flowbot");
    expect(awaitingName.prefill!.avatar).toBe("https://x/avatar.png");
    expect(awaitingName.prefill!.suggestedName).toBe("活动小助手");

    // Secret must NEVER appear in the browser-facing view
    expect(JSON.stringify(awaitingName)).not.toContain("fakesecret-value-do-not-leak");

    // No bot written yet.
    await expect(readFile(path.join(botsDir, "flow-bot.yaml"), "utf-8")).rejects.toThrow();
  });

  it("finalizeOnboard → done + bot written to disk", async () => {
    const fakeRegister: RegisterAppFn = async (opts) => {
      await new Promise((r) => setTimeout(r, 0));
      opts.onQRCodeReady({ url: "https://feishu/qr/abc", expireIn: 300 });
      return FAKE_CREDS;
    };

    const { sessionId } = startOnboard({
      botsDir,
      envPath,
      registerApp: fakeRegister,
      renderQrSvg: async () => "<svg/>",
      resolveBotIdentity: async () => ({ open_id: "ou_flowbot", name: "活动小助手" }),
    });

    await waitForStatus(sessionId, "awaiting-name");

    // Now finalize with user-supplied form.
    const result = await finalizeOnboard(sessionId, {
      name: "Flow Bot",
      description: "handles events",
      chatId: "oc_room1",
    });

    expect(result).not.toBeNull();
    expect(result!.botId).toBe("flow-bot");

    const done = getOnboard(sessionId)!;
    expect(done.status).toBe("done");
    expect(done.botId).toBe("flow-bot");
    // secret never in view
    expect(JSON.stringify(done)).not.toContain("fakesecret-value-do-not-leak");

    // Bot landed on disk.
    const yamlRaw = await readFile(path.join(botsDir, "flow-bot.yaml"), "utf-8");
    const valid = BotConfigSchema.parse(yaml.load(yamlRaw));
    expect(valid.bot_open_id).toBe("ou_flowbot");
    expect(valid.name).toBe("Flow Bot");
    expect(valid.chats).toEqual(["oc_room1"]);
    expect(valid.backend).toBe("codex");
  });

  it("finalizeOnboard returns null for unknown session", async () => {
    const result = await finalizeOnboard("nonexistent", { name: "X" });
    expect(result).toBeNull();
  });

  it("finalizeOnboard throws when session is not in awaiting-name", async () => {
    const fakeRegister: RegisterAppFn = async () => {
      // hang forever
      await new Promise(() => {});
      return FAKE_CREDS;
    };
    const { sessionId } = startOnboard({ botsDir, envPath, registerApp: fakeRegister });
    // Session is "starting" — calling finalize should throw.
    await expect(finalizeOnboard(sessionId, { name: "X" })).rejects.toThrow(/awaiting-name/);
  });

  it("cancel-after-creds (awaiting-name) → no-orphan: default name落盘 + done", async () => {
    const fakeRegister: RegisterAppFn = async (opts) => {
      await new Promise((r) => setTimeout(r, 0));
      opts.onQRCodeReady({ url: "https://feishu/qr/abc", expireIn: 300 });
      return FAKE_CREDS;
    };

    const { sessionId } = startOnboard({
      botsDir,
      envPath,
      registerApp: fakeRegister,
      renderQrSvg: async () => "<svg/>",
      resolveBotIdentity: async () => ({ name: "答疑值班助手" }),
    });

    await waitForStatus(sessionId, "awaiting-name");

    // Cancel while in awaiting-name (creds already obtained). cancelOnboard now
    // AWAITS the no-orphan create, so it returns the resulting botId directly.
    const r = await cancelOnboard(sessionId);
    expect(r.cancelled).toBe(true);
    expect(r.defaultNamed).toBe(true);
    expect(r.botId).toBeDefined();

    // No-orphan: session is "done" with the default-name bot written.
    const done = getOnboard(sessionId)!;
    expect(done.status).toBe("done");
    expect(done.botId).toBe(r.botId);

    // A bot file was written (default name from suggestedName).
    const yamlRaw = await readFile(path.join(botsDir, `${r.botId}.yaml`), "utf-8");
    const valid = BotConfigSchema.parse(yaml.load(yamlRaw));
    expect(valid.name).toBe("答疑值班助手");
  });

  it("cancel-before-creds (awaiting-scan) → cancelled, no bot written", async () => {
    let abortSeen = false;
    const fakeRegister: RegisterAppFn = async (opts) => {
      opts.onQRCodeReady({ url: "https://feishu/qr/xyz", expireIn: 300 });
      // hang until aborted
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          abortSeen = true;
          reject(new Error("aborted"));
        });
      });
      return FAKE_CREDS;
    };

    const { sessionId } = startOnboard({
      botsDir,
      envPath,
      registerApp: fakeRegister,
      renderQrSvg: async () => "<svg/>",
    });
    await waitForStatus(sessionId, "awaiting-scan");

    expect((await cancelOnboard(sessionId)).cancelled).toBe(true);
    expect(getOnboard(sessionId)!.status).toBe("cancelled");
    // give the rejected promise a tick to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(abortSeen).toBe(true);

    // No bot file written.
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(botsDir).catch(() => [] as string[]),
    );
    expect(entries.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);

    // cancel on a terminal/unknown session → cancelled:false
    expect((await cancelOnboard(sessionId)).cancelled).toBe(false);
    expect((await cancelOnboard("nonexistent")).cancelled).toBe(false);
  });

  it("registerApp reject → error status with message", async () => {
    const fakeRegister: RegisterAppFn = async () => {
      throw new Error("device code expired");
    };
    const { sessionId } = startOnboard({ botsDir, envPath, registerApp: fakeRegister });
    await waitForStatus(sessionId, "error");
    expect(getOnboard(sessionId)!.error).toContain("device code expired");
  });

  it("getOnboard returns null for unknown session", () => {
    expect(getOnboard("nope")).toBeNull();
  });

  it("prefill falls back to suggestedName='新助手' when identity has no name", async () => {
    const fakeRegister: RegisterAppFn = async (opts) => {
      await new Promise((r) => setTimeout(r, 0));
      opts.onQRCodeReady({ url: "https://feishu/qr/abc", expireIn: 300 });
      return FAKE_CREDS;
    };

    const { sessionId } = startOnboard({
      botsDir,
      envPath,
      registerApp: fakeRegister,
      renderQrSvg: async () => "<svg/>",
      resolveBotIdentity: async () => ({}), // no name
    });

    await waitForStatus(sessionId, "awaiting-name");
    const view = getOnboard(sessionId)!;
    expect(view.prefill!.suggestedName).toBe("新助手");
  });
});
