/**
 * src/cli/commands/init.test.ts
 *
 * vitest 自验:--non-interactive + --skip-register 路径在临时 LARKWAY_BOTS_DIR
 * 下能跑通生成合法 bot yaml。
 *
 * 不依赖网络 / 真凭据 / 飞书扫码 / 常驻进程。
 * 隔离:每个 test 用独立 tmp 目录,用后清理。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, access, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { BotConfigSchema } from "../../config/botLoader.js";

// ---------------------------------------------------------------------------
// Test isolation helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origBotsDir: string | undefined;
let origHome: string | undefined;
let origPath: string | undefined;
let origCodexHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "larkway-init-test-"));
  origBotsDir = process.env["LARKWAY_BOTS_DIR"];
  origHome = process.env["HOME"];
  origPath = process.env["PATH"];
  origCodexHome = process.env["CODEX_HOME"];
  // 隔离 bots 目录
  process.env["LARKWAY_BOTS_DIR"] = path.join(tmpDir, "bots");
  // 隔离 ~/.larkway 写入(用 HOME override)
  process.env["HOME"] = tmpDir;
  const fakeCodexHome = path.join(tmpDir, ".codex");
  process.env["CODEX_HOME"] = fakeCodexHome;

  // P1-C: 删除外部 CI 可能注入的凭据变量,保证测试自隔离。
  // 不删的话,CI 预设了这俩变量时,"缺 App Secret 应 exit 1" 测试会误通过。
  delete process.env["LARKWAY_APP_ID"];
  delete process.env["LARKWAY_APP_SECRET"];

  // 创建 fake .claude/.credentials.json 让 preflight claude 检测通过
  const claudeDir = path.join(tmpDir, ".claude");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({ fake: true }), "utf-8");

  // 创建 fake codex binary + auth.json,让 --backend=codex 测试不依赖本机真实登录态。
  const fakeBin = path.join(tmpDir, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCodex = path.join(fakeBin, "codex");
  await writeFile(fakeCodex, "#!/usr/bin/env sh\necho 'codex 0.0.0-test'\n", "utf-8");
  await chmod(fakeCodex, 0o755);
  await mkdir(fakeCodexHome, { recursive: true });
  await writeFile(path.join(fakeCodexHome, "auth.json"), JSON.stringify({ fake: true }), "utf-8");
  process.env["PATH"] = `${fakeBin}${path.delimiter}${origPath ?? ""}`;
});

afterEach(async () => {
  // 恢复 env
  if (origBotsDir === undefined) {
    delete process.env["LARKWAY_BOTS_DIR"];
  } else {
    process.env["LARKWAY_BOTS_DIR"] = origBotsDir;
  }
  if (origHome !== undefined) {
    process.env["HOME"] = origHome;
  }
  if (origPath === undefined) {
    delete process.env["PATH"];
  } else {
    process.env["PATH"] = origPath;
  }
  if (origCodexHome === undefined) {
    delete process.env["CODEX_HOME"];
  } else {
    process.env["CODEX_HOME"] = origCodexHome;
  }
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Build a minimal CliContext wired to the temp dirs
// ---------------------------------------------------------------------------

async function buildCtx(flags?: Partial<{ json: boolean; nonInteractive: boolean; advanced: boolean }>) {
  // 动态 import 以拿到已经被 HOME/LARKWAY_BOTS_DIR 覆盖后的路径解析
  // 注意:由于 Node 模块缓存,我们直接用真实模块但 env 已经改了,
  // resolveBotsDir/resolveLarkwayHome 是纯函数(读 env),每次调用都重新算。
  const ui = await import("../ui.js");
  const botsStore = await import("../botsStore.js");
  const hostConfig = await import("../hostConfig.js");

  const effectiveFlags = {
    json: false,
    nonInteractive: true,
    advanced: false,
    ...flags,
  };

  return {
    paths: {
      larkwayDir: hostConfig.resolveLarkwayHome(),
      botsDir: botsStore.resolveBotsDir(),
      configJsonPath: hostConfig.resolveConfigJsonPath(),
      envPath: hostConfig.resolveEnvPath(),
    },
    ui,
    botsStore,
    hostConfig,
    flags: effectiveFlags,
    cwd: tmpDir,
  };
}

// ---------------------------------------------------------------------------
// Suppress stdout during tests (don't pollute test output)
// ---------------------------------------------------------------------------

function silenceOutput() {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("larkway init --non-interactive --skip-register", () => {
  it("完整跑通:生成合法 bot yaml + memory.md + .env + config.json", async () => {
    silenceOutput();

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    // --non-interactive + --skip-register + 所有必填参数通过 args 传入
    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=test-bot",
      "--bot-name=测试 Bot",
      "--bot-desc=集成测试用临时 bot",
      "--bot-open-id=ou_test123",
      "--chat-id=oc_test_chat_id",
      "--backend=codex",
      "--task-description=通过飞书维护 Larkway",
      "--permission-requests=GitLab read/write MR;Local shell tests",
      "--human-gates=deploy/restart;production messages",
      // 提供手填凭据(--skip-register 模式)
    ]);

    // 需要提供 LARKWAY_APP_ID / LARKWAY_APP_SECRET 给手填旁路
    // 重新跑:用 env 注入
    process.env["LARKWAY_APP_ID"] = "cli_test_app_id_12345";
    process.env["LARKWAY_APP_SECRET"] = "test_app_secret_abc";

    const code2 = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=test-bot",
      "--bot-name=测试 Bot",
      "--bot-desc=集成测试用临时 bot",
      "--bot-open-id=ou_test123",
      "--chat-id=oc_test_chat_id",
      "--backend=codex",
      "--task-description=通过飞书维护 Larkway",
      "--permission-requests=GitLab read/write MR;Local shell tests",
      "--human-gates=deploy/restart;production messages",
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(code2).toBe(0);

    // 验证 bots/test-bot.yaml 存在且合法
    const botsDir = process.env["LARKWAY_BOTS_DIR"]!;
    const yamlPath = path.join(botsDir, "test-bot.yaml");
    const rawYaml = await readFile(yamlPath, "utf-8");
    const parsed = yaml.load(rawYaml);
    const result = BotConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("test-bot");
      expect(result.data.app_id).toBe("cli_test_app_id_12345");
      expect(result.data.chats).toContain("oc_test_chat_id");
      expect(result.data.backend).toBe("codex");
    }

    // 验证 memory.md 存在
    const memPath = path.join(botsDir, "test-bot.memory.md");
    await expect(access(memPath)).resolves.toBeUndefined();
    const mem = await readFile(memPath, "utf-8");
    expect(mem.length).toBeGreaterThan(0);
    expect(mem).toContain("测试 Bot");

    // 验证 Agent Workspace creation artifacts 存在且不含 app secret 真值
    const workspace = path.join(tmpDir, ".larkway", "agents", "test-bot", "workspace");
    const agentsMd = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("通过飞书维护 Larkway");
    const permissions = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    expect(permissions).toContain("GitLab read/write MR");
    expect(permissions).toContain("type=write");
    expect(permissions).toContain("deploy/restart");
    expect(permissions).not.toContain("test_app_secret_abc");
    await expect(access(path.join(workspace, "tasks", "_creation", "task.md"))).rejects.toThrow();
    await expect(access(path.join(workspace, "permissions-granted.md"))).resolves.toBeUndefined();

    // 验证 ~/.larkway/.env 中有 secret
    const envPath = path.join(tmpDir, ".larkway", ".env");
    const envContent = await readFile(envPath, "utf-8");
    expect(envContent).toContain("LARKWAY_TEST_BOT_APP_SECRET");
    expect(envContent).toContain("test_app_secret_abc");

    // 验证 config.json 存在
    const configPath = path.join(tmpDir, ".larkway", "config.json");
    const configRaw = await readFile(configPath, "utf-8");
    const config = JSON.parse(configRaw);
    expect(config).toHaveProperty("conventions");
    expect(config.conventions).toHaveProperty("devHostname");
  });

  it("repo bot writes gitlab_token_env name into yaml and permission artifact", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_test_app_id_12345";
    process.env["LARKWAY_APP_SECRET"] = "test_app_secret_abc";

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=larkway-devops",
      "--bot-name=Larkway DevOps",
      "--bot-desc=Develop and operate Larkway",
      "--bot-open-id=ou_devops",
      "--chat-id=oc_test_chat_id",
      "--backend=codex",
      "--repo-slug=chuckwu0/larkway",
      "--repo-branch=main",
      "--gitlab-token-env=LARKWAY_DEVOPS_GITLAB_TOKEN",
      "--task-description=Develop and operate Larkway through Feishu",
      "--permission-requests=GitLab read chuckwu0/larkway;GitLab write/MR;Local shell tests",
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(code).toBe(0);
    const botsDir = process.env["LARKWAY_BOTS_DIR"]!;
    const rawYaml = await readFile(path.join(botsDir, "larkway-devops.yaml"), "utf-8");
    const parsed = BotConfigSchema.parse(yaml.load(rawYaml));
    expect(parsed.runtime).toBe("agent_workspace");
    expect(parsed.backend).toBe("codex");
    expect(parsed.gitlab_token_env).toBe("LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(rawYaml).not.toContain("glpat-");

    const workspace = path.join(tmpDir, ".larkway", "agents", "larkway-devops", "workspace");
    const permissions = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    expect(permissions).toContain("LARKWAY_DEVOPS_GITLAB_TOKEN");
    expect(permissions).toContain("type=read");
    expect(permissions).toContain("type=write");
    expect(permissions).not.toContain("test_app_secret_abc");
  });

  it("normal dogfood path: init -> perms grant -> dogfood preflight passes in isolation", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_test_app_id_12345";
    process.env["LARKWAY_APP_SECRET"] = "test_app_secret_abc";

    const ctx = await buildCtx({ nonInteractive: true, json: true });
    const { run: initRun } = await import("./init.js");
    const { run: permsRun } = await import("./perms.js");
    const { run: dogfoodRun } = await import("./dogfood.js");

    const initCode = await initRun(ctx as Parameters<typeof initRun>[0], [
      "--skip-register",
      "--bot-id=larkway-devops",
      "--bot-name=Larkway DevOps",
      "--bot-desc=Develop and operate Larkway",
      "--bot-open-id=ou_devops",
      "--chat-id=oc_test_chat_id",
      "--backend=codex",
      "--repo-slug=chuckwu0/larkway",
      "--repo-branch=main",
      "--gitlab-token-env=LARKWAY_DEVOPS_GITLAB_TOKEN",
      "--task-description=Develop and operate Larkway through Feishu",
      "--permission-requests=GitLab read chuckwu0/larkway;GitLab write/MR;Local shell tests;deploy/restart;external message to Feishu;production-impact operations",
      "--human-gates=deploy/restart;production messages;production-impact operations",
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(initCode).toBe(0);
    await writeFile(
      path.join(tmpDir, ".larkway", ".env"),
      "LARKWAY_DEVOPS_GITLAB_TOKEN=glpat-test-token\n",
      { flag: "a" },
    );

    const permsCode = await permsRun(ctx as Parameters<typeof permsRun>[0], [
      "larkway-devops",
      "--grant-from-request",
      "--grant-note",
      "confirmed by isolated normal-path test",
    ]);
    expect(permsCode).toBe(0);

    const dogfoodCtx = { ...ctx, cwd: process.cwd() };
    const dogfoodCode = await dogfoodRun(dogfoodCtx as Parameters<typeof dogfoodRun>[0], [
      "preflight",
      "larkway-devops",
    ]);
    expect(dogfoodCode).toBe(0);

    const workspace = path.join(tmpDir, ".larkway", "agents", "larkway-devops", "workspace");
    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf8");
    expect(granted).toContain("gate=explicit-human-confirmation");
    expect(granted).not.toContain("glpat-test-token");
  });

  it("uses task-description as the first creation input when bot-id is omitted", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_task_first";
    process.env["LARKWAY_APP_SECRET"] = "secret_task_first";

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-open-id=ou_task_first",
      "--task-description=Develop and operate Larkway through Feishu",
      "--backend=claude",
    ]);

    expect(code).toBe(0);
    const botId = "develop-and-operate-larkway";
    const yamlRaw = await readFile(path.join(tmpDir, "bots", `${botId}.yaml`), "utf8");
    const parsed = BotConfigSchema.parse(yaml.load(yamlRaw));
    expect(parsed.id).toBe(botId);

    const agentsMd = await readFile(
      path.join(tmpDir, ".larkway", "agents", botId, "workspace", "AGENTS.md"),
      "utf8",
    );
    expect(agentsMd).toContain("Develop and operate Larkway through Feishu");
  });

  it("非法 bot-id 返回 exit 1", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_xxx";
    process.env["LARKWAY_APP_SECRET"] = "sec_xxx";

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=INVALID_ID",  // 大写 → 非法
      "--bot-open-id=ou_x",
      "--chat-id=oc_x",
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(code).toBe(1);
  });

  it("chat-id 不以 oc_ 开头返回 exit 1", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_xxx";
    process.env["LARKWAY_APP_SECRET"] = "sec_xxx";

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=valid-bot",
      "--bot-open-id=ou_x",
      "--chat-id=gc_bad_prefix",  // 错误前缀
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(code).toBe(1);
  });

  it("缺 App Secret 时 exit 1(skip-register 手填旁路)", async () => {
    silenceOutput();
    // 不设置 LARKWAY_APP_ID / LARKWAY_APP_SECRET → prompt default 为空 → 报错
    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=valid-bot",
      "--bot-open-id=ou_x",
      "--chat-id=oc_x",
    ]);

    expect(code).toBe(1);
  });

  it("--json 模式:stdout 只含可解析 JSON 行(无人类文案混入),覆盖 P1-A", async () => {
    // P1-C: 此 case 专门验证 P1-A 修复 — stdout 不能混入非 JSON 人类文案。
    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      const s = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
      // 收集 stdout 的每一行(含空行),用于纯净度验证
      for (const line of s.split("\n")) {
        stdoutLines.push(line);
      }
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env["LARKWAY_APP_ID"] = "cli_json_test";
    process.env["LARKWAY_APP_SECRET"] = "secret_json_test";

    // P1-A: 必须在 run() 前激活 json 模式,否则测试绕过了 index.ts 的 setJsonMode 调用。
    const uiModule = await import("../ui.js");
    uiModule.setJsonMode(true);

    const ctx = await buildCtx({ nonInteractive: true, json: true });
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=json-bot",
      "--bot-open-id=ou_json",
      "--chat-id=oc_json_chat",
    ]);

    // 恢复 json 模式(afterEach 不会自动重置 ui 模块状态)
    uiModule.setJsonMode(false);
    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(code).toBe(0);

    // P1-A 断言:stdout 的每一个非空行必须是合法 JSON —— 不允许人类文案混入。
    const nonEmptyLines = stdoutLines.filter((l) => l.trim() !== "");
    for (const line of nonEmptyLines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          `stdout 包含非 JSON 行(P1-A 污染):\n  ${JSON.stringify(line)}\n` +
          `  全部 stdout 行:\n${stdoutLines.map((l) => "    " + JSON.stringify(l)).join("\n")}`,
        );
      }
      // 每行必须是对象(emitJson 的产出)
      expect(typeof parsed).toBe("object");
    }

    // 至少一行 JSON 表示成功,且含 step=done
    const parsed = nonEmptyLines
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((o): o is Record<string, unknown> => o !== null);
    const doneMsg = parsed.find((o) => o?.["step"] === "done");
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.["ok"]).toBe(true);
  });

  it("第二次 init 同 bot-id(nonInteractive 默认不覆盖)仍 exit 0(overwrite confirm defaults false)", async () => {
    // 第一次写入
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_first";
    process.env["LARKWAY_APP_SECRET"] = "sec_first";

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const code1 = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=repeat-bot",
      "--bot-open-id=ou_r",
      "--chat-id=oc_r",
    ]);
    expect(code1).toBe(0);

    // 第二次 — nonInteractive 时 confirm(overwrite) 默认 false → throw → exit 1
    const code2 = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=repeat-bot",
      "--bot-open-id=ou_r2",
      "--chat-id=oc_r2",
    ]);
    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    // nonInteractive + confirm(false default) → not overwriting → error → exit 1
    expect(code2).toBe(1);
  });

  it("overwrite resets stale permission grants when permission surface changes", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_overwrite";
    process.env["LARKWAY_APP_SECRET"] = "sec_overwrite";

    const ctx = await buildCtx({ nonInteractive: true });
    const { run } = await import("./init.js");

    const first = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=overwrite-bot",
      "--bot-open-id=ou_overwrite",
      "--chat-id=oc_old",
      "--backend=codex",
      "--repo-slug=chuckwu0/old",
      "--repo-branch=main",
      "--gitlab-token-env=OLD_TOKEN_ENV",
      "--task-description=Old task",
    ]);
    expect(first).toBe(0);

    const workspace = path.join(tmpDir, ".larkway", "agents", "overwrite-bot", "workspace");
    await writeFile(
      path.join(workspace, "permissions-granted.md"),
      "- type=write GitLab repo pointer: chuckwu0/old confirmed env=OLD_TOKEN_ENV\n",
      "utf8",
    );

    const overwriteCtx = {
      ...ctx,
      ui: { ...ctx.ui, confirm: vi.fn(async () => true) },
    };
    const second = await run(overwriteCtx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=overwrite-bot",
      "--bot-open-id=ou_overwrite",
      "--chat-id=oc_new",
      "--backend=codex",
      "--repo-slug=chuckwu0/larkway",
      "--repo-branch=main",
      "--gitlab-token-env=NEW_TOKEN_ENV",
      "--permission-requests=Git write/MR",
      "--task-description=New task",
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(second).toBe(0);
    const request = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    const granted = await readFile(path.join(workspace, "permissions-granted.md"), "utf8");

    expect(request).toContain("Feishu chat allowlist: oc_new");
    expect(request).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(request).toContain("Git token env name: NEW_TOKEN_ENV");
    expect(request).toContain("Git write/MR");
    expect(request).not.toContain("oc_old");
    expect(request).not.toContain("OLD_TOKEN_ENV");
    expect(granted).toContain("This file is an audit note, not a startup gate.");
    expect(granted).toContain("Feishu chat allowlist: oc_new");
    expect(granted).toContain("Git repo pointer: chuckwu0/larkway (main)");
    expect(granted).toContain("env=NEW_TOKEN_ENV");
    expect(granted).toContain("larkway init overwrite changed bot permission surface");
    expect(granted).not.toContain("confirmed env=OLD_TOKEN_ENV");
  });

  it("interactive init asks task permissions and writes high-risk gates", async () => {
    silenceOutput();
    process.env["LARKWAY_APP_ID"] = "cli_interactive_perm";
    process.env["LARKWAY_APP_SECRET"] = "sec_interactive_perm";

    const baseCtx = await buildCtx({ nonInteractive: false });
    const prompt = vi.fn(async (_question: string, opts?: { default?: string }) => opts?.default ?? "");
    const confirm = vi.fn(async (question: string, def = false) => {
      if (question.includes("是否为此 bot 配置 GitLab repo")) return true;
      if (question.includes("需要读取这些 GitLab repo")) return true;
      if (question.includes("需要写代码、提交分支或开 MR")) return true;
      if (question.includes("需要在本地 workspace 里跑测试")) return true;
      if (question.includes("需要读取服务器日志")) return true;
      if (question.includes("需要执行部署")) return true;
      if (question.includes("需要向生产群")) return true;
      if (question.includes("是否可能影响生产用户")) return true;
      if (question.includes("确认发布")) return true;
      return def;
    });
    const ctx = {
      ...baseCtx,
      ui: {
        ...baseCtx.ui,
        prompt,
        confirm,
      },
    };
    const { run } = await import("./init.js");

    const code = await run(ctx as Parameters<typeof run>[0], [
      "--skip-register",
      "--bot-id=interactive-devops",
      "--bot-open-id=ou_interactive",
      "--chat-id=oc_interactive",
      "--backend=codex",
      "--repo-slug=chuckwu0/larkway",
      "--repo-url=https://gitlab.example.com/chuckwu0/larkway.git",
      "--task-description=Develop and operate Larkway through Feishu",
    ]);

    delete process.env["LARKWAY_APP_ID"];
    delete process.env["LARKWAY_APP_SECRET"];

    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("需要写代码、提交分支或开 MR"),
      false,
      expect.any(Object),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("是否可能影响生产用户"),
      false,
      expect.any(Object),
    );

    const workspace = path.join(tmpDir, ".larkway", "agents", "interactive-devops", "workspace");
    const request = await readFile(path.join(workspace, "permissions-request.md"), "utf8");
    expect(request).toContain("Develop and operate Larkway through Feishu");
    expect(request).toContain("type=read Git read chuckwu0/larkway");
    expect(request).toContain("type=write Git write/MR");
    expect(request).toContain("type=write Local shell tests/build/checks");
    expect(request).toContain("type=read Server log/status read");
    expect(request).toContain("type=deploy deploy/restart gate=explicit-human-confirmation");
    expect(request).toContain("type=external-message external message to Feishu gate=explicit-human-confirmation");
    expect(request).toContain("type=production-impact production-impact operations gate=explicit-human-confirmation");
    expect(request).toContain("deploy/restart requires explicit human confirmation");
    expect(request).toContain("production/external messages require explicit human confirmation");
    expect(request).toContain("production-impact operations require explicit human confirmation");
  });
});

describe("init preflight checks", () => {
  it("node 版本检查:当前 Node ≥ 20 应通过(CI 环境)", () => {
    const version = process.versions.node;
    const major = parseInt(version.split(".")[0], 10);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
