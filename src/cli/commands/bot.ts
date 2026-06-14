/**
 * src/cli/commands/bot.ts
 *
 * `larkway bot add|list|edit` — manage agents over the bots/ single source.
 *
 * Sub-command is args[0]:
 *   list                    — 列出所有 bot；--json 输出结构化
 *   add                     — 交互新建 bot；id 冲突报错；--non-interactive 走参数
 *   edit <id>               — 交互改已有 bot 字段；--set key=value 非交互
 *
 * Credential posture (V2.2 decision 1):
 *   bot add asks for app_id + env-var NAME (app_secret_env / gitlab_token_env).
 *   The real secret VALUES live in ~/.larkway/.env (written by `larkway init` +
 *   or the user after the fact). This command only stores yaml env-var references.
 *
 * Thin-channel rule: NO business workflow logic here. Stage gates / MR rules /
 * branch conventions belong in memory.md / business skills.
 */

import type { CliContext } from "../types.js";
import type { BotConfig } from "../../config/botLoader.js";
import path from "node:path";
import { ensureAgentWorkspace, resetAgentWorkspacePermissions } from "../../agent/workspaceStore.js";
import { permissionItemsFromCapabilities } from "../../agent/permissionPlan.js";
import { resolveAgentWorkspacePathFromHome } from "../../config/paths.js";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list":
      return runList(ctx, rest);
    case "add":
      return runAdd(ctx, rest);
    case "edit":
      return runEdit(ctx, rest);
    default: {
      if (!sub) {
        ctx.ui.failure("请指定子命令: add | list | edit");
      } else {
        ctx.ui.failure(`未知子命令: ${sub}，可用: add | list | edit`);
      }
      return 1;
    }
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(ctx: CliContext, _args: string[]): Promise<number> {
  const { ui, botsStore, flags } = ctx;

  const ids = await botsStore.listBots();

  if (ids.length === 0) {
    if (flags.json) {
      ui.emitJson({ ok: true, bots: [] });
    } else {
      ui.print(ui.dim("暂无 bot 配置。运行 `larkway bot add` 添加第一个 bot。"));
    }
    return 0;
  }

  const bots: BotConfig[] = [];
  const errors: string[] = [];

  for (const id of ids) {
    try {
      const cfg = await botsStore.readBot(id);
      bots.push(cfg);
    } catch (e) {
      errors.push(`  ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (flags.json) {
    ui.emitJson({
      ok: errors.length === 0,
      bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        repos: b.repos,
        chats: b.chats,
        peers: b.peers,
        turn_taking_limit: b.turn_taking_limit,
        runtime: b.runtime,
        backend: b.backend,
        app_id: b.app_id,
        app_secret_env: b.app_secret_env,
        gitlab_token_env: b.gitlab_token_env,
        memory_file: b.memory_file,
      })),
      errors: errors.length > 0 ? errors : undefined,
    });
    return errors.length > 0 ? 1 : 0;
  }

  // Human-readable table
  ui.print("");
  ui.print(ui.bold(`共 ${bots.length} 个 bot${errors.length > 0 ? `（${errors.length} 个加载失败）` : ""}:`));
  ui.print("");

  for (const b of bots) {
    ui.print(`  ${ui.cyan(b.id)}  ${ui.bold(b.name)}`);
    ui.print(`    ${ui.dim("描述:")} ${b.description}`);
    ui.print(`    ${ui.dim("runtime:")} ${b.runtime}`);
    ui.print(`    ${ui.dim("backend:")} ${b.backend}`);
    ui.print(`    ${ui.dim("repos:")} ${b.repos.length === 0 ? ui.dim("(无)") : b.repos.map((r) => r.slug).join(", ")}`);
    ui.print(`    ${ui.dim("chats:")} ${b.chats.length} 个`);
    if (b.peers.length > 0) {
      ui.print(`    ${ui.dim("peers:")} ${b.peers.join(", ")}`);
    }
    ui.print("");
  }

  if (errors.length > 0) {
    ui.warning("以下 bot 加载失败(yaml 不合法,请用 `larkway doctor` 检查):");
    for (const e of errors) ui.print(ui.err(e));
    ui.print("");
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function runAdd(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, botsStore, flags } = ctx;

  // Parse --set key=value pairs for non-interactive mode
  const setMap = parseSetFlags(args);

  ui.step(1, "新建 bot 配置");

  // ---- id ----
  const id = await ui.prompt("bot id (kebab-case,如 frontend-bot):", {
    default: setMap.get("id"),
    nonInteractive: flags.nonInteractive,
  });

  if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    ui.failure(`id 格式不合法(必须 kebab-case): "${id}"`);
    return 1;
  }

  // Check for existing id conflict
  const exists = await botsStore.botExists(id);
  if (exists) {
    ui.failure(`Bot "${id}" 已存在。使用 \`larkway bot edit ${id}\` 修改。`);
    return 1;
  }

  // ---- name ----
  const name = await ui.prompt("显示名称 (如 前端助手):", {
    default: setMap.get("name"),
    nonInteractive: flags.nonInteractive,
  });
  if (!name) {
    ui.failure("名称不能为空");
    return 1;
  }

  // ---- description ----
  const description = await ui.prompt("一句话描述 bot 能力:", {
    default: setMap.get("description"),
    nonInteractive: flags.nonInteractive,
  });
  if (!description) {
    ui.failure("描述不能为空");
    return 1;
  }

  // ---- task-first workspace seed ----
  const taskDescription = await ui.prompt("这个 Agent 主要要完成什么 Task?:", {
    default: setMap.get("task_description") ?? setMap.get("task") ?? description,
    nonInteractive: flags.nonInteractive,
  });
  if (!taskDescription) {
    ui.failure("Task 描述不能为空");
    return 1;
  }

  // ---- backend ----
  const backend = await ui.prompt("Agent backend (codex / claude):", {
    default: setMap.get("backend") ?? "codex",
    nonInteractive: flags.nonInteractive,
  });
  if (!backend) {
    ui.failure("backend 不能为空");
    return 1;
  }

  // ---- app_id ----
  const app_id = await ui.prompt("飞书 App ID (cli_xxx):", {
    default: setMap.get("app_id"),
    nonInteractive: flags.nonInteractive,
  });
  if (!app_id) {
    ui.failure("app_id 不能为空");
    return 1;
  }

  // ---- app_secret_env ----
  const app_secret_env = await ui.prompt(
    `app_secret 环境变量名 (将引用 ~/.larkway/.env 中的 KEY):`,
    {
      default: setMap.get("app_secret_env") ?? `LARKWAY_${id.toUpperCase().replace(/-/g, "_")}_APP_SECRET`,
      nonInteractive: flags.nonInteractive,
    },
  );
  if (!app_secret_env || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(app_secret_env)) {
    ui.failure(`环境变量名格式不合法: "${app_secret_env}"`);
    return 1;
  }

  // ---- bot_open_id ----
  const bot_open_id = await ui.prompt("Bot 在飞书群内的 open_id (ou_xxx):", {
    default: setMap.get("bot_open_id"),
    nonInteractive: flags.nonInteractive,
  });
  if (!bot_open_id) {
    ui.failure("bot_open_id 不能为空");
    return 1;
  }

  // ---- chats ----
  const chatsRaw = await ui.prompt(
    "允许响应的飞书 chat_id(逗号分隔,oc_xxx,...):",
    {
      default: setMap.get("chats"),
      nonInteractive: flags.nonInteractive,
    },
  );
  const chats = chatsRaw
    ? chatsRaw.split(",").map((c) => c.trim()).filter(Boolean)
    : [];
  if (chats.length === 0) {
    ui.failure("至少要配置一个 chat_id");
    return 1;
  }

  // ---- repos (optional, advanced) ----
  const repos: BotConfig["repos"] = [];
  if (flags.advanced) {
    const repoSlug = await ui.prompt("GitLab repo slug (如 group/repo,留空=无 repo bot):", {
      default: setMap.get("repo_slug") ?? "",
      nonInteractive: flags.nonInteractive,
    });
    if (repoSlug) {
      const repoBranch = await ui.prompt("默认分支:", {
        default: setMap.get("repo_branch") ?? "master",
        nonInteractive: flags.nonInteractive,
      });
      const repoUrl = await ui.prompt("clone URL (可选,留空=用 GitLab 默认推导):", {
        default: setMap.get("repo_url") ?? "",
        nonInteractive: flags.nonInteractive,
      });
      const repoEntry: BotConfig["repos"][number] = { slug: repoSlug, branch: repoBranch || "master" };
      if (repoUrl) repoEntry.url = repoUrl;
      repos.push(repoEntry);
    }
  } else {
    // Check if provided via --set
    const repoSlug = setMap.get("repo_slug");
    if (repoSlug) {
      const repoEntry: BotConfig["repos"][number] = {
        slug: repoSlug,
        branch: setMap.get("repo_branch") ?? "master",
      };
      const repoUrl = setMap.get("repo_url");
      if (repoUrl) repoEntry.url = repoUrl;
      repos.push(repoEntry);
    }
  }

  // ---- gitlab_token_env (required for agent_workspace repo bots) ----
  let gitlab_token_env: string | undefined;
  const defaultGitlabTokenEnv =
    repos.length > 0 ? `LARKWAY_${id.toUpperCase().replace(/-/g, "_")}_GITLAB_TOKEN` : "";
  if (flags.advanced || setMap.has("gitlab_token_env") || repos.length > 0) {
    const rawGitlab = await ui.prompt(
      "GitLab token 环境变量名(仅记录 KEY,真值写 ~/.larkway/.env):",
      {
        default: setMap.get("gitlab_token_env") ?? defaultGitlabTokenEnv,
        nonInteractive: flags.nonInteractive,
      },
    );
    if (rawGitlab && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawGitlab)) {
      gitlab_token_env = rawGitlab;
    } else if (rawGitlab) {
      ui.failure(`gitlab_token_env 格式不合法: "${rawGitlab}"`);
      return 1;
    }
  }
  if (repos.length > 0 && !gitlab_token_env) {
    ui.failure("agent_workspace repo bot 必须声明 gitlab_token_env;v0.3 不继承全局 GITLAB_TOKEN。");
    return 1;
  }

  // ---- lark_cli_profile (optional, advanced) ----
  let lark_cli_profile: string | undefined;
  if (flags.advanced || setMap.has("lark_cli_profile")) {
    const rawProfile = await ui.prompt(
      "lark-cli profile 名称(可选,多 bot 时用于区分订阅):",
      {
        default: setMap.get("lark_cli_profile") ?? "",
        nonInteractive: flags.nonInteractive,
      },
    );
    if (rawProfile) lark_cli_profile = rawProfile;
  }

  const permissionRequestsRaw = await ui.prompt(
    "需要哪些权限?(分号分隔,如 GitLab read;GitLab write/MR;local shell):",
    {
      default: setMap.get("permission_requests") ?? "",
      nonInteractive: flags.nonInteractive,
    },
  );
  const humanGatesRaw = await ui.prompt(
    "哪些动作必须人工确认?(分号分隔,如 deploy/restart;production message):",
    {
      default: setMap.get("human_gates") ?? "",
      nonInteractive: flags.nonInteractive,
    },
  );
  const permissionRequests = parseListSetValue(permissionRequestsRaw);
  const humanGates = parseListSetValue(humanGatesRaw);

  // ---- memory_file (auto-generated) ----
  const memoryFile = `${id}.memory.md`;

  // Assemble config (let BotConfigSchema apply defaults for peers / turn_taking_limit)
  const rawConfig = {
    id,
    name,
    description,
    app_id,
    app_secret_env,
    bot_open_id,
    chats,
    repos,
    peers: [],
    turn_taking_limit: 10,
    runtime: "agent_workspace",
    backend,
    ...(gitlab_token_env ? { gitlab_token_env } : {}),
    ...(lark_cli_profile ? { lark_cli_profile } : {}),
    memory_file: memoryFile,
  };

  let config: BotConfig;
  try {
    config = botsStore.validateBot(rawConfig, "new bot");
  } catch (e) {
    ui.failure(e instanceof Error ? e.message : String(e));
    return 1;
  }

  // Ensure bots/ dir exists
  await botsStore.ensureBotsDir();

  // Write yaml
  await botsStore.writeBot(config);

  // Write L2 memory template
  const memoryContent = botsStore.genMemoryTemplate(name);
  await botsStore.writeMemory(id, memoryContent);

  const workspaceHome = inferLarkwayHome(ctx.paths.botsDir, ctx.paths.larkwayDir);
  const workspacePath = resolveAgentWorkspacePathFromHome(workspaceHome, id);
  const reposPath = path.join(workspacePath, "repos");
  await ensureAgentWorkspace({
    agentId: id,
    workspacePath,
    reposPath,
    sessionPath: path.join(workspacePath, "sessions", "_creation"),
    refreshFacts: true,
    bot: { name, description, chats, gitlab_token_env },
    taskDescription,
    agentMemory: memoryContent,
    repos: repos.map((repo) => ({
      slug: repo.slug,
      branch: repo.branch,
      url: repo.url,
      suggestedPath: path.join(reposPath, repo.slug.split("/").pop() ?? repo.slug),
    })),
    permissionRequests: permissionItemsFromCapabilities(
      mergePermissionRequests(defaultPermissionRequests({ chats, repos, gitlab_token_env }), permissionRequests)
    ),
    humanGates,
  });

  if (flags.json) {
    ui.emitJson({ ok: true, id, memory_file: memoryFile });
  } else {
    ui.success(`Bot "${id}" 已创建`);
    ui.print(`  配置: ${ctx.paths.botsDir}/${id}.yaml`);
    ui.print(`  记忆: ${ctx.paths.botsDir}/${memoryFile}`);
    ui.print(`  Workspace: ${workspacePath}`);
    ui.print("");
    ui.print(ui.dim("下一步:"));
    ui.print(ui.dim(`  1. 把 app_secret 写入 ~/.larkway/.env: 运行 larkway init 或手动 echo "${app_secret_env}=<value>" >> ~/.larkway/.env`));
    ui.print(ui.dim(`  2. 编辑 L2 职能记忆: larkway memory edit ${id}`));
    ui.print(ui.dim(`  3. 启动 bridge: larkway start`));
  }

  return 0;
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

async function runEdit(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, botsStore, flags } = ctx;

  // args[0] = bot id (if provided), rest may contain --set k=v
  let id: string | undefined;
  const setMap = parseSetFlags(args);

  // Find id: first non-flag arg
  for (const a of args) {
    if (!a.startsWith("--")) {
      id = a;
      break;
    }
  }

  // Prompt for id if not given
  if (!id) {
    if (flags.nonInteractive) {
      ui.failure("non-interactive edit 需要提供 bot id (larkway bot edit <id>)");
      return 1;
    }
    const ids = await botsStore.listBots();
    if (ids.length === 0) {
      ui.failure("没有已配置的 bot。先运行 `larkway bot add`。");
      return 1;
    }
    id = await ui.select(
      "选择要编辑的 bot:",
      ids.map((i) => ({ value: i, label: i })),
    );
  }

  // Load existing config
  let config: BotConfig;
  try {
    config = await botsStore.readBot(id);
  } catch (e) {
    ui.failure(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const isNonInteractive = flags.nonInteractive || setMap.size > 0;

  if (isNonInteractive && setMap.size === 0) {
    ui.failure("non-interactive edit 需要至少一个 --set key=value");
    return 1;
  }

  if (!isNonInteractive) {
    // Interactive: walk through editable fields
    ui.step(1, `编辑 bot "${id}"`);
    ui.print(ui.dim("(回车保留当前值)"));

    const name = await ui.prompt("显示名称:", { default: config.name });
    const description = await ui.prompt("描述:", { default: config.description });

    const chatsRaw = await ui.prompt("chat_id 列表(逗号分隔):", {
      default: config.chats.join(","),
    });
    const chats = chatsRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    if (chats.length === 0) {
      ui.failure("至少要配置一个 chat_id");
      return 1;
    }

    const turnLimitRaw = await ui.prompt("最大连续回合数:", {
      default: String(config.turn_taking_limit),
    });
    const turn_taking_limit = parseInt(turnLimitRaw, 10);
    if (!Number.isInteger(turn_taking_limit) || turn_taking_limit < 1) {
      ui.failure(`turn_taking_limit 必须是正整数: "${turnLimitRaw}"`);
      return 1;
    }

    // Advanced fields
    let repos = config.repos;
    let peers = config.peers;
    let gitlab_token_env = config.gitlab_token_env;
    let lark_cli_profile = config.lark_cli_profile;
    let backend = config.backend ?? "claude";

    if (flags.advanced) {
      const reposRaw = await ui.prompt(
        "repos (格式: slug:branch[:url],slug:branch[:url]; 留空=保留原值):",
        { default: config.repos.map((r) => r.url ? `${r.slug}:${r.branch}:${r.url}` : `${r.slug}:${r.branch}`).join(",") },
      );
      if (reposRaw.trim()) {
        repos = reposRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(parseRepoEntry);
      }

      const peersRaw = await ui.prompt("peer bot ids (逗号分隔,留空=清空):", {
        default: config.peers.join(","),
      });
      peers = peersRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      const rawGitlab = await ui.prompt("gitlab_token_env (留空=保留原值):", {
        default: config.gitlab_token_env ?? "",
      });
      gitlab_token_env = rawGitlab || undefined;

      const rawProfile = await ui.prompt("lark_cli_profile (留空=保留原值):", {
        default: config.lark_cli_profile ?? "",
      });
      lark_cli_profile = rawProfile || undefined;
    }

    backend = (await ui.prompt("backend:", { default: backend })).trim() || "codex";

    const updated: BotConfig = {
      ...config,
      name,
      description,
      chats,
      turn_taking_limit,
      repos,
      peers,
      backend,
      ...(gitlab_token_env !== undefined ? { gitlab_token_env } : { gitlab_token_env: undefined }),
      ...(lark_cli_profile !== undefined ? { lark_cli_profile } : { lark_cli_profile: undefined }),
    };

    // Validate before write
    let valid: BotConfig;
    try {
      valid = botsStore.validateBot(updated, `bot "${id}"`);
    } catch (e) {
      ui.failure(e instanceof Error ? e.message : String(e));
      return 1;
    }

    await botsStore.writeBot(valid);
    const resetGrantedPath = await resetPermissionArtifactsIfNeeded(
      ctx,
      config,
      valid,
      "bot permission surface changed through larkway bot edit",
    );

    if (flags.json) {
      ui.emitJson({ ok: true, id, permissions_reset_path: resetGrantedPath });
    } else {
      if (resetGrantedPath) {
        ui.warning(`权限面已变化,已重置授权记录: ${resetGrantedPath}`);
      }
      ui.success(`Bot "${id}" 已更新`);
    }
    return 0;
  }

  // Non-interactive: apply --set key=value patches
  return applySetPatches(ctx, id, config, setMap);
}

// ---------------------------------------------------------------------------
// --set key=value patch (non-interactive edit)
// ---------------------------------------------------------------------------

async function applySetPatches(
  ctx: CliContext,
  id: string,
  config: BotConfig,
  setMap: Map<string, string>,
): Promise<number> {
  const { ui, botsStore, flags } = ctx;

  const updated = { ...config } as Record<string, unknown>;

  for (const [key, value] of setMap) {
    switch (key) {
      case "name":
      case "description":
      case "app_id":
      case "app_secret_env":
      case "bot_open_id":
      case "lark_cli_profile":
      case "gitlab_token_env":
      case "memory_file":
      case "backend":
        updated[key] = value || undefined;
        break;
      case "turn_taking_limit": {
        const n = parseInt(value, 10);
        if (!Number.isInteger(n) || n < 1) {
          ui.failure(`turn_taking_limit 必须是正整数: "${value}"`);
          return 1;
        }
        updated.turn_taking_limit = n;
        break;
      }
      case "chats":
        updated.chats = value.split(",").map((c) => c.trim()).filter(Boolean);
        break;
      case "peers":
        updated.peers = value.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      case "repos": {
        // Format: "slug:branch[:url],slug:branch[:url]" or "" to clear
        if (!value.trim()) {
          updated.repos = [];
        } else {
          updated.repos = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(parseRepoEntry);
        }
        break;
      }
      default:
        ui.failure(`未知字段: "${key}"。可设置: name, description, app_id, app_secret_env, bot_open_id, chats, repos, peers, turn_taking_limit, gitlab_token_env, lark_cli_profile, memory_file, backend`);
        return 1;
    }
  }

  let valid: BotConfig;
  try {
    valid = botsStore.validateBot(updated, `bot "${id}"`);
  } catch (e) {
    ui.failure(e instanceof Error ? e.message : String(e));
    return 1;
  }

  await botsStore.writeBot(valid);
  const resetGrantedPath = await resetPermissionArtifactsIfNeeded(
    ctx,
    config,
    valid,
    "bot permission surface changed through larkway bot edit --set",
  );

  if (flags.json) {
    ui.emitJson({ ok: true, id, patched: [...setMap.keys()], permissions_reset_path: resetGrantedPath });
  } else {
    if (resetGrantedPath) {
      ui.warning(`权限面已变化,已重置授权记录: ${resetGrantedPath}`);
    }
    ui.success(`Bot "${id}" 已更新字段: ${[...setMap.keys()].join(", ")}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single "slug:branch[:url]" repo entry.
 * The url segment may itself contain colons (e.g. https://host/path.git),
 * so we only split on the first two colons and treat the remainder as the url.
 */
function parseRepoEntry(entry: string): BotConfig["repos"][number] {
  const first = entry.indexOf(":");
  if (first === -1) {
    return { slug: entry, branch: "master" };
  }
  const slug = entry.slice(0, first);
  const rest = entry.slice(first + 1);
  const second = rest.indexOf(":");
  if (second === -1) {
    return { slug, branch: rest || "master" };
  }
  const branch = rest.slice(0, second) || "master";
  const url = rest.slice(second + 1);
  const repo: BotConfig["repos"][number] = { slug, branch };
  if (url) repo.url = url;
  return repo;
}

function permissionSurfaceKey(config: BotConfig): string {
  return JSON.stringify({
    chats: [...config.chats].sort(),
    repos: config.repos.map((repo) => ({
      slug: repo.slug,
      branch: repo.branch,
      url: repo.url ?? "",
    })).sort((a, b) => a.slug.localeCompare(b.slug)),
    gitlab_token_env: config.gitlab_token_env ?? "",
  });
}

async function resetPermissionArtifactsIfNeeded(
  ctx: CliContext,
  before: BotConfig,
  after: BotConfig,
  reason: string,
): Promise<string | undefined> {
  if (after.runtime !== "agent_workspace") return undefined;
  if (permissionSurfaceKey(before) === permissionSurfaceKey(after)) return undefined;
  const workspaceHome = inferLarkwayHome(ctx.paths.botsDir, ctx.paths.larkwayDir);
  const workspacePath = resolveAgentWorkspacePathFromHome(workspaceHome, after.id);
  await resetAgentWorkspacePermissions({
    workspacePath,
    reposPath: path.join(workspacePath, "repos"),
    bot: after,
    reason,
  });
  return path.join(workspacePath, "permissions-granted.md");
}

/**
 * Parse `--set key=value` pairs from an args array.
 * All non-`--set` args are ignored (they're handled by the caller for id etc.).
 */
function parseSetFlags(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set" && i + 1 < args.length) {
      const pair = args[++i];
      const eq = pair.indexOf("=");
      if (eq !== -1) {
        map.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    } else if (args[i].startsWith("--set=")) {
      const pair = args[i].slice("--set=".length);
      const eq = pair.indexOf("=");
      if (eq !== -1) {
        map.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
  }
  return map;
}

function parseListSetValue(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergePermissionRequests(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...base, ...extra]) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function defaultPermissionRequests(input: {
  chats: string[];
  repos: BotConfig["repos"];
  gitlab_token_env?: string;
}): string[] {
  const items = ["Feishu IM: receive mentions and reply in allowed chats"];
  if (input.chats.length > 0) {
    items.push(`Feishu chat allowlist: ${input.chats.join(", ")}`);
  }
  for (const repo of input.repos) {
    items.push(`GitLab repo pointer: ${repo.slug} (${repo.branch})`);
  }
  if (input.gitlab_token_env) {
    items.push(`GitLab token env name: ${input.gitlab_token_env}`);
  }
  items.push("Local shell inside the Agent Workspace for task execution and verification");
  return items;
}

function inferLarkwayHome(botsDir: string, fallback: string): string {
  if (path.basename(botsDir) === "bots") return path.dirname(botsDir);
  return fallback === path.dirname(botsDir) ? botsDir : fallback;
}
