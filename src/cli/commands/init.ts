/**
 * src/cli/commands/init.ts
 *
 * `larkway init` — 交互式 onboarding 向导(QuickStart 默认)。
 *
 * 步骤:
 *   1. 前置自检:node 版本(≥20)/ 默认 backend 登录态 / git 可用
 *   2. registerApp 凭据层:扫码拿 client_id/secret → 写 ~/.larkway/.env(0600)
 *      旁路:--skip-register / 手填 app_id+secret(测试/无网时用)
 *   3. 建第一个 bot:id / name / description / repo / chat → 写 bots/<id>.yaml + memory.md
 *   4. 发布即暴露:醒目确认暴露面(chats 白名单 / repos / token scope)
 *   5. 健康检查收尾:校验 yaml 可被 BotConfigSchema 解析,打印下一步提示
 *
 * flags(从 ctx.flags 读,index.ts 已解析):
 *   --advanced         暴露 worktree 路径 / turn_taking_limit / peers 等高级项
 *   --non-interactive  无人值守(凭据走已存在的 env 引用,问题取参数/默认)
 *   --json             机器可读输出
 *
 * 自验路径:--non-interactive + --skip-register 在临时 LARKWAY_BOTS_DIR 下可无交互完整跑通。
 */

import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { CliContext } from "../types.js";
import type { BotConfig } from "../../config/botLoader.js";
import type { ConfigJsonType } from "../../config.js";
import { detectClaudeLogin, claudeLoginHint } from "../claudeAuth.js";
import {
  detectCodexBinary,
  detectCodexLogin,
  detectCodexRuntimeWritable,
} from "../backendHealth.js";
import { ensureAgentWorkspace, resetAgentWorkspacePermissions } from "../../agent/workspaceStore.js";
import { permissionItemsFromCapabilities } from "../../agent/permissionPlan.js";
import { resolveAgentWorkspacePathFromHome } from "../../config/paths.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types matching the Lark SDK's registerApp API
// (SDK has no bundled .d.ts for this function; we declare our own minimal slice)
// ---------------------------------------------------------------------------

interface RegisterAppOptions {
  domain?: string;
  larkDomain?: string;
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: "polling" | "slow_down" | "domain_switched"; interval?: number }) => void;
}

interface RegisterAppResult {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: "feishu" | "lark" };
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

/** 检测 Node.js 版本是否 ≥ 20。直接用 process.versions。 */
function checkNodeVersion(): { ok: boolean; version: string } {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0], 10);
  return { ok: major >= 20, version };
}

/**
 * 检测目标 backend 是否已登录。
 * macOS 默认存 Keychain,只查 .credentials.json 会在每台 Mac 误判未登录。
 */
async function checkClaudeLogin(): Promise<boolean> {
  return detectClaudeLogin();
}

/** 检测 git 可执行文件存在。 */
async function checkGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Step 1:前置自检。
 * 任一失败 → 打清晰指引 + 返回 false(调用方 return 1)。
 */
async function runPreflightChecks(ctx: CliContext, backendHint: string): Promise<boolean> {
  const { ui, flags } = ctx;

  ui.step(1, "前置自检");

  let allOk = true;

  // Node 版本
  const node = checkNodeVersion();
  if (node.ok) {
    ui.success(`Node.js ${node.version}`);
  } else {
    ui.failure(`Node.js ${node.version} — 需要 ≥ 20。请升级:https://nodejs.org/`);
    allOk = false;
  }

  // Backend login status. Only require Claude when this init is creating a
  // Claude-backed bot; Codex-backed v0.3 dogfood should not be blocked by it.
  if (backendHint === "claude") {
    const claudeLoggedIn = await checkClaudeLogin();
    if (claudeLoggedIn) {
      ui.success("Claude Code backend 已登录(凭据文件 / macOS Keychain / proxy env 任一)");
    } else {
      ui.failure(claudeLoginHint());
      allOk = false;
    }
  } else if (backendHint === "codex") {
    const binary = await detectCodexBinary();
    if (binary.found) {
      ui.success(`Codex CLI 可用${binary.version ? `(${binary.version})` : ""}`);
    } else {
      ui.failure("未找到 `codex` binary。选择 backend=codex 前请先安装 Codex CLI 并确保 PATH 可见。");
      allOk = false;
    }
    const codexLoggedIn = await detectCodexLogin();
    if (codexLoggedIn) {
      ui.success("Codex CLI 已登录(auth.json)");
    } else {
      ui.failure("未检测到 Codex 登录态(~/.codex/auth.json)。请先运行 `codex login`。");
      allOk = false;
    }
    const runtime = await detectCodexRuntimeWritable();
    if (runtime.ok) {
      ui.success(`Codex 状态目录可写(${runtime.codexHome})`);
    } else {
      ui.failure(
        `${runtime.message ?? "Codex 状态目录不可写"}。请执行: ` +
          `sudo chown -R "$USER":staff ~/.codex && chmod -R u+rwX ~/.codex, 然后 codex login。`,
      );
      allOk = false;
    }
  } else {
    ui.print(ui.dim(`backend=${backendHint}: 跳过 Claude 登录硬检查;请用 larkway doctor 检查对应 backend。`));
  }

  // git
  const gitOk = await checkGitAvailable();
  if (gitOk) {
    ui.success("git 可用");
  } else {
    ui.failure("git 未找到。请安装 git:https://git-scm.com/");
    allOk = false;
  }

  if (!allOk) {
    if (flags.json) {
      ui.emitJson({ ok: false, step: "preflight", errors: ["见上方检查失败项"] });
    }
    return false;
  }

  if (flags.json) {
    ui.emitJson({ ok: true, step: "preflight" });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 2: registerApp 凭据层
// ---------------------------------------------------------------------------

interface AppCredentials {
  app_id: string;
  app_secret: string;
  app_secret_env: string;
  user_open_id?: string;
}

/**
 * 通过 registerApp 设备码流获取凭据。
 * 调用 Lark SDK 的 registerApp,回调渲染二维码。
 */
async function registerViaQRCode(ctx: CliContext, botId: string): Promise<AppCredentials> {
  const { ui } = ctx;

  // 动态 import 已装的 Lark SDK(@larksuiteoapi/node-sdk)(照抄 channelClient.ts 的 import 方式)
  const sdk = await import("@larksuiteoapi/node-sdk") as {
    registerApp: (opts: RegisterAppOptions) => Promise<RegisterAppResult>;
  };

  const spin = ui.spinner("等待飞书扫码...");

  let qrShown = false;
  const result = await sdk.registerApp({
    // P1-B fix: onQRCodeReady must be synchronous — the SDK types it as
    // (info) => void and does NOT await it, so an async callback causes the
    // QR code to not be shown before polling resumes. renderQRCode() is now
    // synchronous (qrcode-terminal.generate callback fires synchronously).
    onQRCodeReady: (info) => {
      spin.stop();
      qrShown = true;
      ui.print("");
      ui.print(ui.bold("请用飞书扫描以下二维码完成应用创建:"));
      ui.print(ui.dim(`(二维码 ${info.expireIn}s 后过期)`));
      ui.renderQRCode(info.url);
      ui.print(ui.cyan(info.url));
      ui.print("");
    },
    onStatusChange: (info) => {
      if (!qrShown) return;
      // Write carriage-return progress to stderr in JSON mode (stdout must stay clean).
      const out = ui.isJsonMode() ? process.stderr : process.stdout;
      if (info.status === "polling") {
        out.write("\r" + ui.dim("等待扫码确认...") + " ");
      } else if (info.status === "slow_down") {
        out.write("\r" + ui.warn("轮询降速中,请稍候...") + " ");
      }
    },
  });

  spin.stop();
  // Newline after carriage-return progress output; same stream as above.
  const progressOut = ui.isJsonMode() ? process.stderr : process.stdout;
  progressOut.write("\n");

  const app_secret_env = `LARKWAY_${botId.toUpperCase().replace(/-/g, "_")}_APP_SECRET`;

  return {
    app_id: result.client_id,
    app_secret: result.client_secret,
    app_secret_env,
    user_open_id: result.user_info?.open_id,
  };
}

/**
 * 手动填入 app_id / app_secret 旁路(--skip-register / 测试时用)。
 */
async function registerManual(ctx: CliContext, botId: string): Promise<AppCredentials> {
  const { ui, flags } = ctx;

  const niOpts = { nonInteractive: flags.nonInteractive };
  const app_secret_env_default = `LARKWAY_${botId.toUpperCase().replace(/-/g, "_")}_APP_SECRET`;

  const app_id = await ui.prompt("飞书 App ID (cli_...):", {
    default: process.env["LARKWAY_APP_ID"] ?? "",
    nonInteractive: flags.nonInteractive,
  });
  if (!app_id) throw new Error("App ID 不能为空");

  const app_secret = await ui.prompt("飞书 App Secret:", {
    default: process.env["LARKWAY_APP_SECRET"] ?? "",
    ...niOpts,
  });
  if (!app_secret) throw new Error("App Secret 不能为空");

  const app_secret_env = await ui.prompt("写入 ~/.larkway/.env 的变量名:", {
    default: app_secret_env_default,
    ...niOpts,
  });

  return { app_id, app_secret, app_secret_env };
}

/**
 * Step 2:凭据层。
 * --skip-register 走手填旁路;否则调 registerApp 扫码流。
 */
async function runRegisterApp(
  ctx: CliContext,
  botId: string,
  skipRegister: boolean,
): Promise<AppCredentials> {
  const { ui, hostConfig, flags } = ctx;

  ui.step(2, "飞书应用凭据");

  let creds: AppCredentials;

  if (skipRegister) {
    ui.warning("--skip-register:跳过扫码,手动填入凭据(仅测试/离线场景)");
    creds = await registerManual(ctx, botId);
  } else {
    ui.print(ui.dim("调用 registerApp 设备码流:自动配置 34 scope + 事件 + 回调长连接"));
    creds = await registerViaQRCode(ctx, botId);
  }

  // 写 secret 真值到 ~/.larkway/.env(chmod 0600)
  await hostConfig.ensureLarkwayDir();
  await hostConfig.writeSecret(creds.app_secret_env, creds.app_secret);

  ui.success(`App Secret 已写入 ~/.larkway/.env (${creds.app_secret_env}),权限 0600`);
  ui.print(ui.dim(`  App ID: ${creds.app_id}`));
  ui.print(ui.dim(`  变量名: ${creds.app_secret_env}`));

  if (flags.json) {
    ui.emitJson({ ok: true, step: "register", app_id: creds.app_id, app_secret_env: creds.app_secret_env });
  }

  return creds;
}

// ---------------------------------------------------------------------------
// Step 3: 建第一个 bot
// ---------------------------------------------------------------------------

/** 扫描常见目录找本地已 clone 的 Git repo。 */
async function detectLocalRepos(cwd: string): Promise<string[]> {
  const candidates: string[] = [cwd];
  // 扫 cwd 的兄弟目录(同层 repo 常见布局)
  const parent = path.dirname(cwd);
  try {
    const { readdir } = await import("node:fs/promises");
    const siblings = await readdir(parent);
    for (const name of siblings.slice(0, 20)) {
      const p = path.join(parent, name);
      try {
        const s = await stat(p);
        if (s.isDirectory()) candidates.push(p);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  // 只保留有 .git 目录的
  const repos: string[] = [];
  for (const p of candidates) {
    try {
      await access(path.join(p, ".git"));
      repos.push(p);
    } catch { /* not a git repo */ }
  }
  return repos;
}

interface BotBasics {
  id: string;
  name: string;
  description: string;
  chatId: string;
  repos: Array<{ slug: string; branch: string; url?: string }>;
  bot_open_id: string;
  taskDescription: string;
  permissionRequests: string[];
  humanGates: string[];
  gitName?: string;
  gitEmail?: string;
  turnLimit?: number;
  backend: string;
  gitlabTokenEnv?: string;
}

async function collectPermissionPlan(
  ctx: CliContext,
  repos: Array<{ slug: string; branch: string; url?: string }>,
  argMap: Record<string, string>,
): Promise<{ permissionRequests: string[]; humanGates: string[] }> {
  const { ui, flags } = ctx;
  const explicitRequests = parseListArg(argMap["permission-requests"]);
  const explicitGates = parseListArg(argMap["human-gates"]);

  if (flags.nonInteractive) {
    return { permissionRequests: explicitRequests, humanGates: explicitGates };
  }

  const permissionRequests = [...explicitRequests];
  const humanGates = [...explicitGates];
  const niOpts = { nonInteractive: false };
  const repoNames = repos.map((repo) => repo.slug).join(", ");

  if (explicitRequests.length === 0) {
    ui.print(ui.dim("── 权限需求 ──"));
    if (repos.length > 0) {
      if (await ui.confirm(`需要读取这些 Git repo 吗? (${repoNames})`, true, niOpts)) {
        permissionRequests.push(`Git read ${repoNames}`);
      }
      if (await ui.confirm("需要写代码、提交分支或开 MR 吗?", false, niOpts)) {
        permissionRequests.push("Git write/MR");
      }
    }
    if (await ui.confirm("需要在本地 workspace 里跑测试、构建或链接检查吗?", repos.length > 0, niOpts)) {
      permissionRequests.push("Local shell tests/build/checks");
    }
    if (await ui.confirm("需要读取服务器日志或运行状态吗?", false, niOpts)) {
      permissionRequests.push("Server log/status read");
    }
    if (await ui.confirm("需要执行部署、回滚或重启服务吗?", false, niOpts)) {
      permissionRequests.push("deploy/restart");
      humanGates.push("deploy/restart requires explicit human confirmation");
    }
    if (await ui.confirm("需要向生产群、真实运营或外部对象主动发消息吗?", false, niOpts)) {
      permissionRequests.push("external message to Feishu");
      humanGates.push("production/external messages require explicit human confirmation");
    }
    if (await ui.confirm("是否可能影响生产用户、线上数据或生产服务?", false, niOpts)) {
      permissionRequests.push("production-impact operations");
      humanGates.push("production-impact operations require explicit human confirmation");
    }
  }

  if (explicitGates.length === 0) {
    const hasDeploy = permissionRequests.some((item) => /deploy|restart|rollback|部署|重启|回滚/i.test(item));
    const hasExternal = permissionRequests.some((item) => /external|message|notify|外发|发消息|通知/i.test(item));
    const hasProduction = permissionRequests.some((item) => /production|prod|生产|线上/i.test(item));
    if (hasDeploy && !humanGates.some((gate) => /deploy|restart|部署|重启/i.test(gate))) {
      humanGates.push("deploy/restart requires explicit human confirmation");
    }
    if (hasExternal && !humanGates.some((gate) => /external|message|外发|发消息/i.test(gate))) {
      humanGates.push("production/external messages require explicit human confirmation");
    }
    if (hasProduction && !humanGates.some((gate) => /production|prod|生产|线上/i.test(gate))) {
      humanGates.push("production-impact operations require explicit human confirmation");
    }
  }

  return { permissionRequests, humanGates };
}

/**
 * Step 3:收集 bot 配置信息。
 */
async function collectBotBasics(
  ctx: CliContext,
  appId: string,
  args: string[],
): Promise<BotBasics> {
  const { ui, flags } = ctx;
  const niOpts = { nonInteractive: flags.nonInteractive };

  // 从 CLI args 提取可选参数(--bot-id / --chat-id 等,非交互时用)
  const argMap = parseInitArgs(args);

  // bot id
  const id = (
    argMap["bot-id"] ??
    (await ui.prompt("Bot ID (kebab-case,如 frontend-bot):", {
      default: "my-bot",
      ...niOpts,
    }))
  ).trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`Bot ID "${id}" 不合法,必须是 kebab-case(小写字母+数字+连字符)`);
  }

  // name
  const name = (
    argMap["bot-name"] ??
    (await ui.prompt("Bot 显示名(如「前端 Bot」):", {
      default: id,
      ...niOpts,
    }))
  ).trim();
  if (!name) throw new Error("Bot 名称不能为空");

  // description
  const description = (
    argMap["bot-desc"] ??
    (await ui.prompt("一句话描述(peer bots 看到的能力介绍):", {
      default: `${name} — 请填写能力描述`,
      ...niOpts,
    }))
  ).trim();
  const taskDescription = (
    argMap["task-description"] ??
    argMap["task"] ??
    (await ui.prompt("这个 Agent 主要要完成什么 Task?:", {
      default: description,
      ...niOpts,
    }))
  ).trim();

  // bot_open_id
  const bot_open_id = (
    argMap["bot-open-id"] ??
    (await ui.prompt("Bot 的 Feishu open_id(群内 bot open_id,形如 ou_...):", {
      default: argMap["bot-open-id"] ?? "ou_placeholder",
      ...niOpts,
    }))
  ).trim();

  // 可选允许群限制—— 留空 = 任何群 @ 都起话题回复(默认低摩擦)。要收窄才填 chat_id。
  const rawChatId = (
    argMap["chat-id"] ??
    (flags.nonInteractive
      ? ""
      : await ui.prompt("可选允许群限制 chat_id(oc_ 开头;留空 = 任何群都能 @,推荐):", {
          default: "",
          nonInteractive: false,
        }))
  ).trim();
  if (rawChatId && !rawChatId.startsWith("oc_")) {
    throw new Error(`chat_id "${rawChatId}" 必须以 oc_ 开头(或留空表示任何群都响应)`);
  }

  // repos(可选). 读写不再由配置区分 —— bridge 给环境 + token,读还是写 agent 自己定
  // (见 docs/provisioning-model.md). init 创建的是 agent_workspace bot,这里的
  // url/slug/branch 只是 repo pointer;Agent 自己决定是否/何处 clone。
  const repos: Array<{ slug: string; branch: string; url?: string }> = [];
  if (flags.nonInteractive) {
    if (argMap["repo-slug"]) {
      const entry: { slug: string; branch: string; url?: string } = {
        slug: argMap["repo-slug"],
        branch: argMap["repo-branch"] ?? "master",
      };
      if (argMap["repo-url"]) entry.url = argMap["repo-url"];
      repos.push(entry);
    }
    // nonInteractive + 无 repo-slug = repo-less bot,合法
  } else {
    const localRepos = await detectLocalRepos(ctx.cwd);
    const addRepo = await ui.confirm("是否为此 bot 配置 Git repo?(repo-less bot 可选 N)", true, niOpts);
    if (addRepo) {
      let repoSlug = argMap["repo-slug"] ?? "";
      if (!repoSlug) {
        if (localRepos.length > 0) {
          ui.print(ui.dim("检测到本地 git repo:"));
          localRepos.slice(0, 5).forEach((r) => ui.print(ui.dim(`  ${r}`)));
        }
        repoSlug = (await ui.prompt("Git 仓库路径(如 group/repo):", { default: "group/repo", ...niOpts })).trim();
      }
      const branch = (await ui.prompt("目标分支:", { default: "master", ...niOpts })).trim();
      const url = (
        argMap["repo-url"] ??
        (await ui.prompt("Repo clone URL(可选;仅作为 Agent 自行 clone 的指针):", {
          default: "",
          ...niOpts,
        }))
      ).trim();
      if (repoSlug) {
        const entry: { slug: string; branch: string; url?: string } = {
          slug: repoSlug,
          branch: branch || "master",
        };
        if (url) entry.url = url;
        repos.push(entry);
      }
    }
  }

  // Advanced: git identity / turn_taking_limit
  let gitName: string | undefined;
  let gitEmail: string | undefined;
  let turnLimit: number | undefined;

  if (flags.advanced) {
    ui.print(ui.dim("── 高级选项 ──"));
    const configIdentity = await ui.confirm("配置 Git 提交身份?(可选)", false, niOpts);
    if (configIdentity) {
      gitName = (await ui.prompt("Git 用户名:", { default: name, ...niOpts })).trim() || undefined;
      gitEmail = (await ui.prompt("Git 邮箱:", { default: "", ...niOpts })).trim() || undefined;
    }
    const rawLimit = await ui.prompt("最大连续 turn 数:", { default: "10", ...niOpts });
    const parsed = parseInt(rawLimit, 10);
    turnLimit = Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
  }

  const { permissionRequests, humanGates } = await collectPermissionPlan(ctx, repos, argMap);
  const backend = (
    argMap["backend"] ??
    (flags.nonInteractive
      ? "codex"
      : await ui.prompt("Agent backend (codex / claude):", { default: "codex", ...niOpts }))
  ).trim();
  if (!backend) {
    throw new Error("backend 不能为空");
  }
  const gitlabTokenEnv = (
    argMap["gitlab-token-env"] ??
    (repos.length > 0 ? `LARKWAY_${id.toUpperCase().replace(/-/g, "_")}_GITLAB_TOKEN` : "")
  ).trim() || undefined;

  void appId; // used by caller

  return {
    id,
    name,
    description,
    chatId: rawChatId,
    repos,
    bot_open_id,
    taskDescription,
    permissionRequests,
    humanGates,
    gitName,
    gitEmail,
    turnLimit,
    backend,
    gitlabTokenEnv,
  };
}

/**
 * Step 3:写 bot yaml + memory.md。
 */
async function runCreateBot(
  ctx: CliContext,
  creds: AppCredentials,
  basics: BotBasics,
): Promise<BotConfig> {
  const { ui, botsStore, flags } = ctx;

  await botsStore.ensureBotsDir();

  // 检查 id 是否已存在
  let previousConfig: BotConfig | undefined;
  if (await botsStore.botExists(basics.id)) {
    previousConfig = await botsStore.readBot(basics.id);
    const overwrite = await ui.confirm(
      `Bot "${basics.id}" 已存在,覆盖?`,
      false,
      { nonInteractive: flags.nonInteractive },
    );
    if (!overwrite) throw new Error(`Bot "${basics.id}" 已存在,取消。`);
  }

  const memoryFile = `${basics.id}.memory.md`;

  const config: BotConfig = {
    id: basics.id,
    name: basics.name,
    description: basics.description,
    app_id: creds.app_id,
    app_secret_env: creds.app_secret_env,
    bot_open_id: basics.bot_open_id,
    // 空 = 任何群都响应(默认);有值 = 只在允许群限制内响应
    chats: basics.chatId ? [basics.chatId] : [],
    peers: [],
    repos: basics.repos,
    turn_taking_limit: basics.turnLimit ?? 10,
    read_only: false,
    runtime: "agent_workspace",
    backend: basics.backend,
    memory_file: memoryFile,
    ...(basics.gitlabTokenEnv ? { gitlab_token_env: basics.gitlabTokenEnv } : {}),
    ...(basics.gitName && basics.gitEmail
      ? { git_identity: { name: basics.gitName, email: basics.gitEmail } }
      : {}),
  };

  // 先 validate
  botsStore.validateBot(config, `bot "${basics.id}"`);

  // 写 yaml
  await botsStore.writeBot(config);
  ui.success(`bots/${basics.id}.yaml 已写入`);

  // 写 memory 模板
  const memoryContent = botsStore.genMemoryTemplate(basics.name);
  await botsStore.writeMemory(basics.id, memoryContent);
  ui.success(`bots/${memoryFile} 已写入(请编辑填写职能)`);

  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.paths.larkwayDir, basics.id);
  const reposPath = path.join(workspacePath, "repos");
  await ensureAgentWorkspace({
    agentId: basics.id,
    workspacePath,
    reposPath,
    refreshFacts: true,
    bot: {
      name: basics.name,
      description: basics.description,
      chats: basics.chatId ? [basics.chatId] : [],
      gitlab_token_env: basics.gitlabTokenEnv,
    },
    taskDescription: basics.taskDescription,
    agentMemory: memoryContent,
    repos: basics.repos.map((repo) => ({
      slug: repo.slug,
      branch: repo.branch,
      url: repo.url,
      suggestedPath: path.join(reposPath, repo.slug.split("/").pop() ?? repo.slug),
    })),
    permissionRequests: permissionItemsFromCapabilities(initPermissionRequests(basics)),
    humanGates: basics.humanGates,
  });
  if (previousConfig && permissionSurfaceKey(previousConfig) !== permissionSurfaceKey(config)) {
    await resetAgentWorkspacePermissions({
      workspacePath,
      reposPath,
      bot: config,
      reason: "larkway init overwrite changed bot permission surface",
      taskDescription: basics.taskDescription,
      permissionRequests: permissionItemsFromCapabilities(initPermissionRequests(basics)),
      humanGates: basics.humanGates,
    });
    ui.warning("权限面已变化,permissions-granted.md 已刷新为审计记录;基础运行不需要二次授权。");
  }
  ui.success(`Agent Workspace 已初始化: ${workspacePath}`);

  if (flags.json) {
    ui.emitJson({ ok: true, step: "create-bot", id: basics.id, yaml: `bots/${basics.id}.yaml` });
  }

  return config;
}

// ---------------------------------------------------------------------------
// Step 4: 发布即暴露
// ---------------------------------------------------------------------------

/**
 * Step 4:显式确认暴露面。
 * 这一步让 host 有意识地确认:谁能 @ 这个 bot、能碰哪些 repo、需要什么 token scope。
 * 不新增 schema 字段;用现有三层(飞书 chats 白名单 / repos / token scope)做确认。
 */
async function runPublishExposure(ctx: CliContext, config: BotConfig): Promise<boolean> {
  const { ui, flags } = ctx;

  ui.step(4, "发布即暴露 — 确认暴露面");

  ui.print("");
  ui.print(ui.bold("═══ 你的 bot 发布后,以下资源将对外可用 ═══"));
  ui.print("");

  // 谁能 @
  ui.print(ui.bold("  谁能 @ 这个 bot:"));
  if (config.chats.length === 0) {
    ui.print(`    • ${ui.warn("任何群")} —— 未设白名单,任何群 @ 都会起话题回复(含 DM 单聊)`);
    ui.print(ui.dim("      要收窄到指定群:larkway perms " + config.id + " --add-chat oc_xxx"));
  } else {
    config.chats.forEach((c) => ui.print(`    • ${ui.cyan(c)}`));
    ui.print(ui.dim("      只在以上群响应。"));
  }
  ui.print("");

  // 能碰哪些 repo
  if (config.repos && config.repos.length > 0) {
    ui.print(ui.bold("  可操作的 Git repo:"));
    config.repos.forEach((r) => ui.print(`    • ${ui.cyan(r.slug)} (branch: ${r.branch})`));
    ui.print(ui.warn("  ⚠ 需要配置 git_token_env 指向有权限的 Git access token"));
  } else {
    ui.print(ui.bold("  Repo:") + ui.dim(" 无(repo-less bot)"));
  }
  ui.print("");

  // token scope 提醒
  ui.print(ui.bold("  凭据安全:"));
  ui.print(`    • App Secret 存储在 ~/.larkway/.env(chmod 0600)`);
  ui.print(`    • bot yaml 只引用变量名,不含真值`);
  if (flags.advanced) {
    ui.print(`    • 建议 Git access token 只开 read_repository + write_repository + api scope`);
    ui.print(`    • 飞书应用权限已由 registerApp 自动预配(34 scope)`);
  }
  ui.print("");

  ui.print(ui.warn("请确认以上暴露面符合你的预期。如需调整:larkway perms <id>"));
  ui.print("");

  const confirmed = await ui.confirm(
    "确认发布?(按 n 取消,可修改配置后重新 larkway init)",
    true,
    { nonInteractive: flags.nonInteractive },
  );

  if (!confirmed) {
    ui.warning("已取消。配置文件已写入,可用 larkway bot edit 调整后再发布。");
    return false;
  }

  ui.success("暴露面确认");

  if (flags.json) {
    ui.emitJson({ ok: true, step: "exposure", chats: config.chats, repos: config.repos });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 5: 健康检查收尾
// ---------------------------------------------------------------------------

/**
 * Step 5:健康检查。
 * 校验写入的 yaml 可被 BotConfigSchema 解析。
 * 不尝试起真实长连接(需要真正扫码完成的飞书 App)。
 */
async function runHealthCheck(ctx: CliContext, botId: string): Promise<boolean> {
  const { ui, botsStore, flags } = ctx;

  ui.step(5, "健康检查");

  // 重新从磁盘读取 + 校验
  let config: BotConfig;
  try {
    config = await botsStore.readBot(botId);
    void config;
    ui.success("bot yaml 解析 + schema 校验通过");
  } catch (e) {
    ui.failure(`bot yaml 校验失败:${e instanceof Error ? e.message : String(e)}`);
    if (flags.json) ui.emitJson({ ok: false, step: "health-check", error: String(e) });
    return false;
  }

  // 检查 memory.md 存在
  try {
    const mem = await botsStore.readMemory(botId);
    if (mem.length > 0) ui.success(`memory.md 存在(${mem.length} chars)`);
  } catch (e) {
    ui.warning(`memory.md 读取失败(可手动创建):${e instanceof Error ? e.message : String(e)}`);
  }

  // 检查 env secret 写入
  const envVal = await ctx.hostConfig.readSecret(
    `LARKWAY_${botId.toUpperCase().replace(/-/g, "_")}_APP_SECRET`,
  );
  if (envVal) {
    ui.success("App Secret 在 ~/.larkway/.env 中确认存在");
  } else {
    ui.warning("App Secret 未在 ~/.larkway/.env 找到,请手动补充(larkway init 重跑或直接编辑 .env)");
  }

  if (flags.json) {
    ui.emitJson({ ok: true, step: "health-check", botId });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/**
 * 解析 init 本地 args(init 命令收到的已去除全局 flags 的参数)。
 * 支持: --skip-register, --bot-id=xxx, --chat-id=xxx, --repo-slug=xxx, 等。
 */
function parseInitArgs(args: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tok of args) {
    if (tok === "--skip-register") {
      map["skip-register"] = "1";
      continue;
    }
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(tok);
    if (m) {
      map[m[1]] = m[2] ?? "1";
    }
  }
  return map;
}

function parseListArg(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultInitPermissionRequests(basics: BotBasics): string[] {
  const items = ["Feishu IM: receive mentions and reply in allowed chats"];
  if (basics.chatId) {
    items.push(`Feishu chat allowlist: ${basics.chatId}`);
  }
  for (const repo of basics.repos) {
    items.push(`Git repo pointer: ${repo.slug} (${repo.branch})`);
  }
  if (basics.gitlabTokenEnv) {
    items.push(`Git access token env name: ${basics.gitlabTokenEnv}`);
  }
  items.push("Local shell inside the Agent Workspace for task execution and verification");
  return items;
}

function initPermissionRequests(basics: BotBasics): string[] {
  const seen = new Set<string>();
  return [...defaultInitPermissionRequests(basics), ...basics.permissionRequests].filter((item) => {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function permissionSurfaceKey(bot: Pick<BotConfig, "chats" | "repos" | "git_token_env" | "gitlab_token_env">): string {
  return JSON.stringify({
    chats: [...bot.chats].sort(),
    repos: bot.repos.map((repo) => ({
      slug: repo.slug,
      branch: repo.branch,
      url: repo.url ?? "",
    })).sort((a, b) => a.slug.localeCompare(b.slug)),
    git_token_env: bot.git_token_env ?? bot.gitlab_token_env ?? "",
  });
}

function deriveBotIdFromTaskDescription(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4);
  return words.join("-") || "my-bot";
}

// ---------------------------------------------------------------------------
// Host config bootstrap (config.json)
// ---------------------------------------------------------------------------

/**
 * 确保 ~/.larkway/config.json 存在;如果不存在,用最小值初始化。
 * conventions.devHostname 是必填,nonInteractive 时用 "localhost" 兜底。
 */
async function ensureHostConfig(ctx: CliContext): Promise<void> {
  const { ui, hostConfig, flags } = ctx;
  const niOpts = { nonInteractive: flags.nonInteractive };

  const existing = await hostConfig.readHostConfig();
  if (existing) return; // 已存在,不覆盖

  ui.print(ui.dim("首次 init:初始化 ~/.larkway/config.json"));

  const devHostname = await ui.prompt("本机 LAN IP(dev server 的 hostname,如 192.168.1.100):", {
    default: "localhost",
    ...niOpts,
  });

  const cfg: ConfigJsonType = {
    conventions: {
      devHostname: devHostname || "localhost",
      portRangeStart: 3001,
      portRangeEnd: 3050,
    },
    permissions: { allowExtra: [] },
    chats: [],
  };

  await hostConfig.ensureLarkwayDir();
  await hostConfig.writeHostConfig(cfg);
  ui.success("~/.larkway/config.json 已初始化");
}

// ---------------------------------------------------------------------------
// Main run()
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, flags } = ctx;
  const argMap = parseInitArgs(args);
  const skipRegister = "skip-register" in argMap;

  // --json 时禁止人类文案塞进 stdout(emitJson 走 stdout,print 走 stdout — 二者不混)
  // 实际 --json 模式下每步结束 emit 一个 JSON 对象;人类文案通过 printErr 输出。
  // 这里保持简单:非 --json 正常 print;--json 则只 emitJson + printErr diagnostic。

  if (!flags.json) {
    ui.print(ui.bold("larkway init — 飞书 ↔ 本地 CLI Agent 薄通道 Onboarding 向导"));
    ui.print(ui.dim("QuickStart 模式。--advanced 暴露更多配置项。"));
  }

  // ── Step 1: 前置自检 ────────────────────────────────────────────────────
  const preflightOk = await runPreflightChecks(ctx, argMap["backend"] ?? "codex");
  if (!preflightOk) return 1;

  // ── 确保 host config.json 存在 ──────────────────────────────────────────
  try {
    await ensureHostConfig(ctx);
  } catch (e) {
    ui.failure(`初始化 config.json 失败:${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // ── Task-first:先确定 Agent 要完成什么,再派生技术配置 ───────────────
  // registerApp 的 env var name 需要 bot id,所以在扫码前只先收 task + bot id,
  // 后续 collectBotBasics 会复用 task-description,不会重复追问。
  const taskDescription = (
    argMap["task-description"] ??
    argMap["task"] ??
    (flags.nonInteractive
      ? ""
      : await ui.prompt("这个 Agent 主要要完成什么 Task?:", {
          default: "",
          nonInteractive: false,
        }))
  ).trim();
  const botIdDefault = argMap["bot-id"] ?? deriveBotIdFromTaskDescription(taskDescription);
  const botId: string = flags.nonInteractive
    ? botIdDefault
    : (
        await ui.prompt("Bot ID (kebab-case,用于生成凭据变量名和 bots/<id>.yaml):", {
          default: botIdDefault,
          nonInteractive: false,
        })
      ).trim();

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(botId)) {
    ui.failure(`Bot ID "${botId}" 不合法,必须是 kebab-case`);
    return 1;
  }

  // ── Step 2: 凭据层 ──────────────────────────────────────────────────────
  let creds: AppCredentials;
  try {
    creds = await runRegisterApp(ctx, botId, skipRegister);
  } catch (e) {
    ui.failure(`凭据获取失败:${e instanceof Error ? e.message : String(e)}`);
    if (flags.json) ui.emitJson({ ok: false, step: "register", error: String(e) });
    return 1;
  }

  // ── Step 3: 建第一个 bot ────────────────────────────────────────────────
  ui.step(3, "建第一个 bot");

  // basics 的 id 字段复用已输入的 botId,跳过重复询问
  // 把 botId/taskDescription 塞进 argMap 让 collectBotBasics 直接取
  const mergedArgMap = {
    ...argMap,
    "bot-id": botId,
    ...(taskDescription ? { "task-description": taskDescription } : {}),
  };

  let basics: BotBasics;
  try {
    basics = await collectBotBasics(ctx, creds.app_id, Object.entries(mergedArgMap).map(([k, v]) => `--${k}=${v}`));
  } catch (e) {
    ui.failure(`bot 信息收集失败:${e instanceof Error ? e.message : String(e)}`);
    if (flags.json) ui.emitJson({ ok: false, step: "create-bot", error: String(e) });
    return 1;
  }

  let botConfig: BotConfig;
  try {
    botConfig = await runCreateBot(ctx, creds, basics);
  } catch (e) {
    ui.failure(`写入 bot 配置失败:${e instanceof Error ? e.message : String(e)}`);
    if (flags.json) ui.emitJson({ ok: false, step: "create-bot", error: String(e) });
    return 1;
  }

  // ── Step 4: 发布即暴露 ──────────────────────────────────────────────────
  const exposureConfirmed = await runPublishExposure(ctx, botConfig);
  // 用户选择取消时配置已写,仍视为成功(exit 0);用户可以稍后 larkway perms 调整

  // ── Step 5: 健康检查 ────────────────────────────────────────────────────
  const healthOk = await runHealthCheck(ctx, botConfig.id);
  if (!healthOk) return 1;

  // ── 收尾 ────────────────────────────────────────────────────────────────
  if (!flags.json) {
    ui.print("");
    ui.print(ui.bold("══════════════════════════════════════════════"));
    ui.success("你的 bot 配好了!");
    ui.print("");
    ui.print("下一步:");
    ui.print(`  ${ui.cyan("larkway start")}       启动 bridge(本地模式)`);
    ui.print(`  ${ui.cyan("larkway doctor")}      体检 + 修复`);
    ui.print(`  ${ui.cyan("larkway memory edit " + botConfig.id)}  编辑 L2 职能 memory`);
    if (!exposureConfirmed) {
      ui.print(`  ${ui.cyan("larkway perms " + botConfig.id)}     调整暴露面`);
    }
    ui.print("");
  } else {
    ui.emitJson({
      ok: true,
      step: "done",
      botId: botConfig.id,
      yamlPath: `bots/${botConfig.id}.yaml`,
    });
  }

  return 0;
}
