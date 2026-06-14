import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CliContext } from "../types.js";
import { resolveAgentWorkspacePathFromHome } from "../../config/paths.js";
import {
  detectClaudeBinary,
  detectCodexBinary,
  detectCodexLogin,
  detectCodexRuntimeWritable,
} from "../backendHealth.js";
import { checkWorkspacePermissionGrant } from "../../agent/permissionGate.js";
import { detectClaudeLogin } from "../claudeAuth.js";

type Status = "ok" | "warn" | "error";
type PermissionCategory =
  | "read"
  | "write"
  | "deploy"
  | "external-message"
  | "production-impact";

interface Check {
  id: string;
  label: string;
  status: Status;
  message?: string;
}

interface DogfoodCommands {
  create: string;
  grantPermissions: string;
  preflight: string;
  localAcceptance: string;
  startBridge: string;
  readiness: string;
  bridgeReady: string;
  userReady: string;
  sendE2E: string;
  replyE2E: string;
  verifyE2E: string;
}

const DEFAULT_BOT_ID = "larkway-devops";
const SOURCE_CHECKOUT = "/path/to/larkway";
const DOGFOOD_REQUIRED_PERMISSION_CATEGORIES: PermissionCategory[] = [
  "read",
  "write",
  "deploy",
  "external-message",
  "production-impact",
];
const DEFAULT_CREATE_HINT =
  "Create it through the normal onboarding path first: `larkway init --bot-id=larkway-devops --backend=codex --task-description=\"Develop and operate Larkway through Feishu\" --repo-slug=chuckwu0/larkway --repo-branch=main --gitlab-token-env=LARKWAY_DEVOPS_GITLAB_TOKEN --permission-requests=\"GitLab read chuckwu0/larkway;GitLab write/MR;Local shell tests;deploy/restart;external message to Feishu;production-impact operations\" --human-gates=\"deploy/restart;production messages;production-impact operations\"`, or use `larkway bot add` with the same task/repo/permission/backend inputs.";

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0] ?? "preflight";
  const botId = args[1] ?? DEFAULT_BOT_ID;

  if (sub === "guide") {
    const checks = await runPreflight(ctx, botId);
    const exitCode = exitCodeFor(checks);
    const commands = dogfoodCommands(botId);
    const nextSteps = dogfoodNextSteps(checks, commands);

    if (ctx.flags.json) {
      ctx.ui.emitJson({
        ok: true,
        botId,
        preflightOk: exitCode === 0,
        checks,
        commands,
        nextSteps,
      });
      return 0;
    }

    ctx.ui.print(ctx.ui.bold(`v0.3 dogfood guide: ${botId}`));
    ctx.ui.print(`preflight: ${exitCode === 0 ? "ready" : "not ready"}`);
    ctx.ui.print("");
    ctx.ui.print(ctx.ui.bold("下一步按顺序执行:"));
    for (const step of nextSteps) {
      ctx.ui.print(`- ${step}`);
    }
    ctx.ui.print("");
    ctx.ui.print(ctx.ui.bold("命令:"));
    ctx.ui.print(`1. 创建/绑定 Agent: ${commands.create}`);
    ctx.ui.print(`2. 确认权限: ${commands.grantPermissions}`);
    ctx.ui.print(`3. 前置检查: ${commands.preflight}`);
    ctx.ui.print(`4. 本地 acceptance: ${commands.localAcceptance}`);
    ctx.ui.print(`5. 启动 bridge: ${commands.startBridge}`);
    ctx.ui.print(`6. 写 readiness 报告: ${commands.readiness}`);
    ctx.ui.print(`7. 确认 bridge 正在服务当前 backend/runtime: ${commands.bridgeReady}`);
    ctx.ui.print(`8. 确认 lark-cli user 身份可发消息: ${commands.userReady}`);
    ctx.ui.print(`9. 发送测试任务: ${commands.sendE2E}`);
    ctx.ui.print(`10. 同 topic 续接测试: ${commands.replyE2E}`);
    ctx.ui.print(`11. 验证 artifacts: ${commands.verifyE2E}`);
    return 0;
  }

  if (sub !== "preflight") {
    ctx.ui.failure("未知 dogfood 子命令,可用: preflight [bot-id] | guide [bot-id]");
    return 1;
  }

  const checks = await runPreflight(ctx, botId);
  const exitCode = exitCodeFor(checks);

  if (ctx.flags.json) {
    ctx.ui.emitJson({ ok: exitCode === 0, botId, checks, exitCode });
    return exitCode;
  }

  ctx.ui.print(ctx.ui.bold(`v0.3 dogfood preflight: ${botId}`));
  for (const check of checks) {
    const mark = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    ctx.ui.print(`${mark} ${check.label}${check.message ? ` — ${check.message}` : ""}`);
  }
  return exitCode;
}

function dogfoodCommands(botId: string): DogfoodCommands {
  return {
    create: [
      "larkway init",
      "--task-description=\"Develop and operate Larkway through Feishu\"",
      `--bot-id=${botId}`,
      "--backend=codex",
      "--repo-slug=chuckwu0/larkway",
      "--repo-branch=main",
      "--gitlab-token-env=LARKWAY_DEVOPS_GITLAB_TOKEN",
      "--permission-requests=\"GitLab read chuckwu0/larkway;GitLab write/MR;Local shell tests;deploy/restart;external message to Feishu;production-impact operations\"",
      "--human-gates=\"deploy/restart;production messages;production-impact operations\"",
    ].join(" "),
    grantPermissions: `larkway perms ${botId} --grant-from-request --grant-note "confirmed by <host>"`,
    preflight: `larkway dogfood preflight ${botId}`,
    localAcceptance: "pnpm test:v0.3",
    startBridge: "larkway start",
    readiness: "./bin/v0.3-dogfood-e2e.sh readiness",
    bridgeReady: "./bin/v0.3-dogfood-e2e.sh bridge-ready --wait 120",
    userReady: "./bin/v0.3-dogfood-e2e.sh user-ready",
    sendE2E: "./bin/v0.3-dogfood-e2e.sh send \"请在你的 workspace 里确认/clone chuckwu0/larkway,读取 AGENTS.md、README 和 docs/v0.3-phase1-devops-agent.md,在 workspace repo 中创建或更新 docs/v0.3-dogfood-proof.md 并写入本次 thread_id,至少运行 pnpm typecheck、pnpm test 或 pnpm check:links 中一个验证命令,然后在 last_message 中汇报 workspace path、repo path、proof file path、git remote -v、git status、已读取的 AGENTS/docs 证据、验证命令和通过结果。\"",
    replyE2E: "./bin/v0.3-dogfood-e2e.sh reply <thread_id> \"请在同一个 topic 里继续上一轮任务,复用已经确认的 workspace/repo 上下文,并在 last_message 中说明这是同一 topic continuation。\"",
    verifyE2E: "./bin/v0.3-dogfood-e2e.sh verify <thread_id> 2",
  };
}

function dogfoodNextSteps(checks: Check[], commands: DogfoodCommands): string[] {
  const byId = new Map(checks.map((check) => [check.id, check]));
  if (byId.get("bot-config")?.status === "error") {
    return [
      `先走正常创建/绑定流程: ${commands.create}`,
      "把真实飞书 App Secret 写入 ~/.larkway/.env;把 GitLab PAT 写入 LARKWAY_DEVOPS_GITLAB_TOKEN。",
      `由 Host 确认权限 scope: ${commands.grantPermissions}`,
      `再跑: ${commands.preflight}`,
    ];
  }

  const missingSecrets = checks.filter((check) =>
    (check.id === "app-secret-env" || check.id === "gitlab-token-env") &&
    check.status === "error"
  );
  if (missingSecrets.length > 0) {
    return [
      `补齐 ~/.larkway/.env 中的 ${missingSecrets.map((check) => check.message).join(", ")} 真值。`,
      `再跑: ${commands.preflight}`,
    ];
  }

  if (byId.get("permissions-granted")?.status === "error") {
    return [
      `权限 artifact 现在只做审计,不会阻塞启动;如需记录 scope 可执行: ${commands.grantPermissions}`,
      `再跑: ${commands.preflight}`,
    ];
  }

  if (byId.get("permissions-current-surface")?.status === "error") {
    return [
      `当前 bot 的 chat / repo / token env 权限面审计记录已过期;如需记录 scope 可执行: ${commands.grantPermissions}`,
      `再跑: ${commands.preflight}`,
    ];
  }

  if (byId.get("high-risk-human-gates")?.status === "error") {
    return [
      "建议在 AGENTS.md 或 permissions-granted.md 记录 deploy / external-message / production-impact 的 human gate 说明。",
      `再跑: ${commands.preflight}`,
    ];
  }

  const errors = checks.filter((check) => check.status === "error");
  if (errors.length > 0) {
    return [
      `修复 preflight error: ${errors.map((check) => `${check.id}=${check.message ?? check.label}`).join("; ")}`,
      `再跑: ${commands.preflight}`,
    ];
  }

  const warnings = checks.filter((check) => check.status === "warn");
  if (warnings.length > 0) {
    return [
      `确认 preflight warning 可接受: ${warnings.map((check) => check.id).join(", ")}`,
      commands.localAcceptance,
      commands.startBridge,
      commands.readiness,
      commands.bridgeReady,
      commands.userReady,
      commands.sendE2E,
      commands.replyE2E,
      commands.verifyE2E,
    ];
  }

  return [
    commands.localAcceptance,
    commands.startBridge,
    commands.readiness,
    commands.bridgeReady,
    commands.userReady,
    commands.sendE2E,
    commands.replyE2E,
    commands.verifyE2E,
  ];
}

async function runPreflight(ctx: CliContext, botId: string): Promise<Check[]> {
  const checks: Check[] = [];
  let bot: Awaited<ReturnType<typeof ctx.botsStore.readBot>> | undefined;

  try {
    bot = await ctx.botsStore.readBot(botId);
    checks.push({ id: "bot-config", label: "bot yaml schema", status: "ok" });
  } catch (err) {
    const baseMessage = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "bot-config",
      label: "bot yaml schema",
      status: "error",
      message: botId === DEFAULT_BOT_ID ? `${baseMessage}. ${DEFAULT_CREATE_HINT}` : baseMessage,
    });
    return checks;
  }

  checks.push({
    id: "runtime",
    label: "runtime is agent_workspace",
    status: bot.runtime === "agent_workspace" ? "ok" : "error",
    message: bot.runtime,
  });
  checks.push(checkBackend(bot.backend, botId));
  checks.push(...await backendHealthChecks(bot.backend, botId));
  checks.push(...await secretPresenceChecks(ctx, botId, bot));

  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.paths.larkwayDir, botId);
  const workspaceAbs = path.resolve(workspacePath);
  const cwdAbs = path.resolve(ctx.cwd);
  const sourceAbs = path.resolve(SOURCE_CHECKOUT);
  const isolated =
    workspaceAbs !== cwdAbs &&
    !workspaceAbs.startsWith(`${cwdAbs}${path.sep}`) &&
    workspaceAbs !== sourceAbs &&
    !workspaceAbs.startsWith(`${sourceAbs}${path.sep}`);
  checks.push({
    id: "workspace-isolation",
    label: "workspace is not current source checkout",
    status: isolated ? "ok" : "error",
    message: workspacePath,
  });

  const artifacts = [
    "AGENTS.md",
    "permissions-request.md",
    "permissions-granted.md",
  ];
  for (const rel of artifacts) {
    checks.push(await checkFile(path.join(workspacePath, rel), `workspace artifact ${rel}`));
  }

  const permissionFile = path.join(workspacePath, "permissions-request.md");
  const permissionText = await readTextOrNull(permissionFile);
  if (permissionText) {
    checks.push({
      id: "permission-env-name",
      label: "permissions request references env names only",
      status:
        bot.gitlab_token_env == null || permissionText.includes(bot.gitlab_token_env)
          ? "ok"
          : "warn",
      message: bot.gitlab_token_env ?? "no gitlab_token_env configured",
    });
    checks.push(checkPermissionCategories(permissionText, botId));
  }
  const grantedText = await readTextOrNull(path.join(workspacePath, "permissions-granted.md"));
  if (grantedText) {
    checks.push(checkPermissionsGranted(grantedText, botId));
    checks.push(await checkPermissionsCurrentSurface(workspacePath, botId, bot));
    checks.push(checkHighRiskHumanGates(grantedText, botId));
  }

  if (botId === DEFAULT_BOT_ID) {
    const hasLarkwayRepo = bot.repos.some((repo) => repo.slug === "chuckwu0/larkway");
    checks.push({
      id: "larkway-repo-pointer",
      label: "larkway-devops has chuckwu0/larkway repo pointer",
      status: hasLarkwayRepo ? "ok" : "error",
      message: bot.repos.map((repo) => repo.slug).join(", ") || "no repos",
    });
  } else if (bot.repos.length === 0) {
    checks.push({
      id: "repo-pointer",
      label: "repo pointer configured",
      status: "warn",
      message: "no repos configured",
    });
  }

  checks.push(...await secretLeakChecks(ctx, botId, workspacePath, bot));
  return checks;
}

async function backendHealthChecks(backend: string, botId: string): Promise<Check[]> {
  if (backend === "claude") {
    const binary = await detectClaudeBinary();
    if (!binary.found) {
      return [{
        id: "claude-binary",
        label: "Claude Code CLI is runnable",
        status: "warn",
        message: "未找到 `claude` binary;如要用 Claude backend,请先安装 Claude Code CLI 并确保 PATH 可见。",
      }];
    }

    const loggedIn = await detectClaudeLogin();
    return [
      {
        id: "claude-binary",
        label: "Claude Code CLI is runnable",
        status: "ok",
        message: binary.version ? `claude ${binary.version}` : undefined,
      },
      {
        id: "claude-login",
        label: "Claude Code CLI is logged in",
        status: loggedIn ? "ok" : "warn",
        message: loggedIn
          ? undefined
          : "未检测到 Claude 登录态;请先运行 `claude` 登录,或配置 ANTHROPIC_AUTH_TOKEN 供本地/服务器订阅态使用。",
      },
    ];
  }

  if (backend !== "codex") {
    return [];
  }

  const binary = await detectCodexBinary();
  if (!binary.found) {
    return [{
      id: "codex-binary",
      label: "codex CLI is runnable",
      status: botId === DEFAULT_BOT_ID ? "error" : "warn",
      message: "未找到 `codex` binary;请先安装 Codex CLI 并确保 PATH 可见。",
    }];
  }

  const loggedIn = await detectCodexLogin();
  const runtime = await detectCodexRuntimeWritable();
  return [
    {
      id: "codex-binary",
      label: "codex CLI is runnable",
      status: "ok",
      message: binary.version ? `codex ${binary.version}` : undefined,
    },
    {
      id: "codex-login",
      label: "codex CLI is logged in",
      status: loggedIn ? "ok" : botId === DEFAULT_BOT_ID ? "error" : "warn",
      message: loggedIn
        ? undefined
        : "未检测到 ~/.codex/auth.json;请先运行 `codex login`。OPENAI_API_KEY 不作为 dogfood 登录态,因为 Larkway 的 Codex runner 会剥离 API key。",
    },
    {
      id: "codex-runtime-writable",
      label: "codex runtime state is writable",
      status: runtime.ok ? "ok" : botId === DEFAULT_BOT_ID ? "error" : "warn",
      message: runtime.ok
        ? runtime.codexHome
        : `${runtime.message ?? "Codex 状态目录不可写"}。请执行: sudo chown -R "$USER":staff ~/.codex && chmod -R u+rwX ~/.codex, 然后 codex login。`,
    },
  ];
}

function checkBackend(backend: string, botId: string): Check {
  if (botId !== DEFAULT_BOT_ID) {
    return {
      id: "backend",
      label: "backend is configured",
      status: backend ? "ok" : "warn",
      message: backend || "missing",
    };
  }
  return {
    id: "backend",
    label: "larkway-devops backend is codex",
    status: backend === "codex" ? "ok" : "error",
    message: backend,
  };
}

async function secretPresenceChecks(
  ctx: CliContext,
  botId: string,
  bot: Awaited<ReturnType<typeof ctx.botsStore.readBot>>,
): Promise<Check[]> {
  const checks: Check[] = [];
  const appSecret = await ctx.hostConfig.readSecret(bot.app_secret_env);
  checks.push({
    id: "app-secret-env",
    label: "app_secret_env has a local secret value",
    status: appSecret ? "ok" : "error",
    message: bot.app_secret_env,
  });

  if (bot.gitlab_token_env) {
    const gitlabToken = await ctx.hostConfig.readSecret(bot.gitlab_token_env);
    checks.push({
      id: "gitlab-token-env",
      label: "gitlab_token_env has a local secret value",
      status: gitlabToken ? "ok" : botId === DEFAULT_BOT_ID ? "error" : "warn",
      message: bot.gitlab_token_env,
    });
  } else if (botId === DEFAULT_BOT_ID) {
    checks.push({
      id: "gitlab-token-env",
      label: "gitlab_token_env has a local secret value",
      status: "error",
      message: "larkway-devops must declare gitlab_token_env for repo clone/write dogfood",
    });
  }

  return checks;
}

function checkPermissionCategories(permissionText: string, botId: string): Check {
  const found = new Set<PermissionCategory>();
  for (const category of DOGFOOD_REQUIRED_PERMISSION_CATEGORIES) {
    if (permissionText.includes(`type=${category}`)) found.add(category);
  }
  if (botId !== DEFAULT_BOT_ID) {
    return {
      id: "permission-categories",
      label: "permissions request has category labels",
      status: found.size > 0 ? "ok" : "warn",
      message: found.size > 0 ? [...found].join(", ") : "no type=... labels found",
    };
  }
  const missing = DOGFOOD_REQUIRED_PERMISSION_CATEGORIES.filter((category) => !found.has(category));
  return {
    id: "permission-categories",
    label: "larkway-devops permission categories",
    status: missing.length === 0 ? "ok" : "error",
    message:
      missing.length === 0
        ? [...found].join(", ")
        : `missing ${missing.map((category) => `type=${category}`).join(", ")}`,
  };
}

function checkPermissionsGranted(grantedText: string, botId: string): Check {
  const normalized = grantedText.trim().toLowerCase();
  const hasGrant =
    normalized.length > 0 &&
    !normalized.includes("no permissions have been granted yet") &&
    !normalized.includes("no permissions granted");
  return {
    id: "permissions-granted",
    label: botId === DEFAULT_BOT_ID
      ? "larkway-devops permission audit notes"
      : "permission audit notes",
    status: hasGrant ? "ok" : "warn",
    message: hasGrant
      ? "permissions-granted.md contains confirmed scope notes"
      : `permissions-granted.md is still a placeholder; startup is allowed, and \`larkway perms ${botId} --grant-from-request --grant-note "confirmed by <host>"\` is now audit-only`,
  };
}

async function checkPermissionsCurrentSurface(
  workspacePath: string,
  botId: string,
  bot: Awaited<ReturnType<CliContext["botsStore"]["readBot"]>>,
): Promise<Check> {
  if (bot.runtime !== "agent_workspace" || !bot.gitlab_token_env) {
    return {
      id: "permissions-current-surface",
      label: "permissions cover current bot surface",
      status: "ok",
      message: "not a write-capable agent_workspace repo bot",
    };
  }

  const gate = await checkWorkspacePermissionGrant(workspacePath, bot);
  return {
    id: "permissions-current-surface",
    label: botId === DEFAULT_BOT_ID
      ? "larkway-devops permission audit covers current bot surface"
      : "permission audit covers current bot surface",
    status: gate.ok ? "ok" : "warn",
    message: gate.ok ? "chat/repo/token env surface is covered by audit notes" : `${gate.reason}; startup is allowed`,
  };
}

function checkHighRiskHumanGates(grantedText: string, botId: string): Check {
  const normalized = grantedText.toLowerCase();
  const highRiskScopes = [
    { label: "deploy", patterns: ["deploy", "restart"] },
    { label: "external-message", patterns: ["external-message", "external message"] },
    { label: "production-impact", patterns: ["production-impact", "production impact"] },
  ];
  const missing = highRiskScopes.filter((scope) => {
    const hasScope = scope.patterns.some((pattern) => normalized.includes(pattern));
    if (!hasScope) return true;
    const scopeLines = normalized
      .split("\n")
      .filter((line) => scope.patterns.some((pattern) => line.includes(pattern)));
    return !scopeLines.some(
      (line) =>
        line.includes("gate") ||
        line.includes("gated") ||
        line.includes("confirmation") ||
        line.includes("confirm"),
    );
  });

  return {
    id: "high-risk-human-gates",
    label: botId === DEFAULT_BOT_ID
      ? "larkway-devops high-risk permissions have audit notes"
      : "high-risk permissions have audit notes",
    status: missing.length === 0 ? "ok" : "warn",
    message: missing.length === 0
      ? "deploy/external-message/production-impact gates are recorded"
      : `missing explicit gate/confirmation audit notes for ${missing.map((scope) => scope.label).join(", ")}; startup is allowed`,
  };
}

async function checkFile(filePath: string, label: string): Promise<Check> {
  try {
    await access(filePath);
    return { id: `file:${label}`, label, status: "ok", message: filePath };
  } catch {
    return { id: `file:${label}`, label, status: "error", message: `${filePath} missing` };
  }
}

async function secretLeakChecks(
  ctx: CliContext,
  botId: string,
  workspacePath: string,
  bot: Awaited<ReturnType<typeof ctx.botsStore.readBot>>,
): Promise<Check[]> {
  const secretNames = [bot.app_secret_env, bot.gitlab_token_env].filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
  const secretValues: string[] = [];
  for (const name of secretNames) {
    const value = await ctx.hostConfig.readSecret(name);
    if (value && value.length >= 6) secretValues.push(value);
  }

  if (secretValues.length === 0) {
    return [{
      id: "secret-scan",
      label: "workspace/yaml secret leak scan",
      status: "warn",
      message: "no secret values found in .env to compare",
    }];
  }

  const scanFiles = [
    path.join(ctx.paths.botsDir, `${botId}.yaml`),
    ...await listMarkdownFiles(workspacePath),
  ];
  for (const file of scanFiles) {
    const text = await readTextOrNull(file);
    if (!text) continue;
    const leaked = secretValues.find((secret) => text.includes(secret));
    if (leaked) {
      return [{
        id: "secret-scan",
        label: "workspace/yaml secret leak scan",
        status: "error",
        message: `${file} contains a secret value (${leaked.slice(0, 4)}...)`,
      }];
    }
  }
  return [{
    id: "secret-scan",
    label: "workspace/yaml secret leak scan",
    status: "ok",
    message: `${scanFiles.length} files scanned`,
  }];
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function exitCodeFor(checks: Check[]): number {
  if (checks.some((check) => check.status === "error")) return 2;
  if (checks.some((check) => check.status === "warn")) return 1;
  return 0;
}
