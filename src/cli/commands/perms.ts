/**
 * src/cli/commands/perms.ts
 *
 * `larkway perms <id>` — 调 L1 权限 / 暴露面(发布即暴露常驻管理入口)。
 *
 * 三层暴露面管理:
 *   1. chats    — 飞书 chat_id 白名单(谁能 @ 这个 bot)
 *   2. repos    — 能碰哪些代码(group/name:branch 格式)
 *   3. token    — gitlab_token_env 引用(scope 提醒;不管理 secret 真值)
 *   4. peers    — 可 @ 的 peer bot ids
 *
 * Non-interactive flags:
 *   --add-chat <oc_xxx>         添加一个 chat_id 到白名单
 *   --remove-chat <oc_xxx>      从白名单移除
 *   --add-repo <group/name>     添加 repo(可带 :branch[:url],默认 master)
 *   --repo-url <url>            给本次 --add-repo 的 repo 补 clone URL 指针
 *   --remove-repo <group/name>  移除 repo(匹配 slug)
 *   --gitlab-token-env <KEY>    设置 per-agent GitLab token env name(只记录 KEY)
 *   --add-peer <id>             添加 peer bot id
 *   --remove-peer <id>          移除 peer bot id
 *   --grant-from-request        将 workspace permissions-request.md 中的请求记录为已确认
 *   --grant-permission <text>   追加一条已确认权限说明(可多次传入)
 *   --grant-note <text>         给本次权限确认追加备注
 *
 * 铁律:绝不添加 max-stage 或让 bridge 感知业务的字段(thin-channel)。
 */

import type { CliContext } from "../types.js";
import type { BotConfig } from "../../config/botLoader.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { permissionItemsFromCapabilities } from "../../agent/permissionPlan.js";
import { resolveAgentWorkspacePathFromHome } from "../../config/paths.js";
import { resetAgentWorkspacePermissions } from "../../agent/workspaceStore.js";

// ---------------------------------------------------------------------------
// Arg parsing (command-local flags only — global flags already stripped)
// ---------------------------------------------------------------------------

interface PermsFlags {
  addChats: string[];
  removeChats: string[];
  addRepos: string[];       // raw strings like "group/name" or "group/name:branch"
  repoUrl?: string;
  removeRepos: string[];    // slug only ("group/name")
  gitlabTokenEnv?: string;
  addPeers: string[];
  removePeers: string[];
  grantFromRequest: boolean;
  grantPermissions: string[];
  grantNote?: string;
  positional: string[];
}

function parsePermsArgs(args: string[]): PermsFlags {
  const flags: PermsFlags = {
    addChats: [],
    removeChats: [],
    addRepos: [],
    repoUrl: undefined,
    removeRepos: [],
    gitlabTokenEnv: undefined,
    addPeers: [],
    removePeers: [],
    grantFromRequest: false,
    grantPermissions: [],
    positional: [],
  };

  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    switch (tok) {
      case "--add-chat":
        if (++i < args.length) flags.addChats.push(args[i]);
        break;
      case "--remove-chat":
        if (++i < args.length) flags.removeChats.push(args[i]);
        break;
      case "--add-repo":
        if (++i < args.length) flags.addRepos.push(args[i]);
        break;
      case "--repo-url":
        if (++i < args.length) flags.repoUrl = args[i];
        break;
      case "--remove-repo":
        if (++i < args.length) flags.removeRepos.push(args[i]);
        break;
      case "--gitlab-token-env":
        if (++i < args.length) flags.gitlabTokenEnv = args[i];
        break;
      case "--add-peer":
        if (++i < args.length) flags.addPeers.push(args[i]);
        break;
      case "--remove-peer":
        if (++i < args.length) flags.removePeers.push(args[i]);
        break;
      case "--grant-from-request":
        flags.grantFromRequest = true;
        break;
      case "--grant-permission":
        if (++i < args.length) flags.grantPermissions.push(args[i]);
        break;
      case "--grant-note":
        if (++i < args.length) flags.grantNote = args[i];
        break;
      default:
        flags.positional.push(tok);
    }
    i++;
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Repo spec parsing ("group/name" or "group/name:branch")
// ---------------------------------------------------------------------------

interface RepoSpec {
  slug: string;
  branch: string;
  url?: string;
}

function parseRepoSpec(raw: string): RepoSpec {
  const first = raw.indexOf(":");
  if (first === -1) {
    return { slug: raw, branch: "master" };
  }
  const slug = raw.slice(0, first);
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(":");
  if (second === -1) {
    return { slug, branch: rest || "master" };
  }
  const branch = rest.slice(0, second) || "master";
  const url = rest.slice(second + 1);
  return { slug, branch, ...(url ? { url } : {}) };
}

// ---------------------------------------------------------------------------
// Exposure summary render
// ---------------------------------------------------------------------------

function renderSummary(config: BotConfig, ui: CliContext["ui"]): void {
  const { bold, cyan, dim, ok, warn } = ui;

  ui.print("");
  ui.print(bold(`暴露面摘要 — ${config.name} (${config.id})`));
  ui.print("");

  // chats
  ui.print(bold("Chats 白名单 (谁能 @):"));
  if (config.chats.length === 0) {
    ui.print("  " + warn("(空 = 任何群 @ 都响应,未设白名单;含 DM 单聊)"));
  } else {
    for (const c of config.chats) {
      ui.print(`  ${ok("•")} ${cyan(c)}`);
    }
  }
  ui.print("");

  // repos
  ui.print(bold("Repos (可碰的代码):"));
  if (config.repos.length === 0) {
    ui.print("  " + dim("(无 — 无代码库访问;适合纯 operator bot)"));
  } else {
    for (const r of config.repos) {
      ui.print(`  ${ok("•")} ${cyan(r.slug)} ${dim(`(branch: ${r.branch})`)}`);
    }
  }
  ui.print("");

  // token
  ui.print(bold("GitLab token:"));
  if (config.gitlab_token_env) {
    ui.print(`  ${ok("•")} env var 引用: ${cyan(config.gitlab_token_env)}`);
    ui.print("  " + dim("  (scope 提醒: 需要 read_api + write_repository + api — 手动确认 PAT scope)"));
  } else {
    ui.print("  " + dim("(未配置 — repo 型 agent_workspace bot 启动前必须补 per-agent token env)"));
  }
  ui.print("");

  // peers
  ui.print(bold("Peer bots (可 @ 的 peers):"));
  if (config.peers.length === 0) {
    ui.print("  " + dim("(无)"));
  } else {
    for (const p of config.peers) {
      ui.print(`  ${ok("•")} ${cyan(p)}`);
    }
  }
  ui.print("");
}

// ---------------------------------------------------------------------------
// Mutation helpers (pure — return new arrays/config, no side effects)
// ---------------------------------------------------------------------------

function defaultGitlabTokenEnv(botId: string): string {
  return `LARKWAY_${botId.toUpperCase().replace(/-/g, "_")}_GITLAB_TOKEN`;
}

function applyNonInteractiveMutations(
  botId: string,
  config: BotConfig,
  flags: PermsFlags,
): BotConfig {
  let { chats, repos, peers } = config;
  let gitlabTokenEnv = flags.gitlabTokenEnv ?? config.gitlab_token_env;

  // chats
  for (const c of flags.addChats) {
    if (!chats.includes(c)) chats = [...chats, c];
  }
  for (const c of flags.removeChats) {
    chats = chats.filter((x) => x !== c);
  }

  // repos
  for (const raw of flags.addRepos) {
    const parsed = parseRepoSpec(raw);
    const spec = {
      ...parsed,
      ...(parsed.url || !flags.repoUrl ? {} : { url: flags.repoUrl }),
    };
    if (!repos.some((r) => r.slug === spec.slug)) {
      repos = [...repos, spec];
    }
  }
  for (const slug of flags.removeRepos) {
    repos = repos.filter((r) => r.slug !== slug);
  }

  // peers
  for (const p of flags.addPeers) {
    if (!peers.includes(p)) peers = [...peers, p];
  }
  for (const p of flags.removePeers) {
    peers = peers.filter((x) => x !== p);
  }

  if (config.runtime === "agent_workspace" && repos.length > 0 && !gitlabTokenEnv) {
    gitlabTokenEnv = defaultGitlabTokenEnv(botId);
  }

  return { ...config, chats, repos, peers, gitlab_token_env: gitlabTokenEnv };
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
  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.paths.larkwayDir, after.id);
  await resetAgentWorkspacePermissions({
    workspacePath,
    reposPath: path.join(workspacePath, "repos"),
    bot: after,
    reason,
  });
  return path.join(workspacePath, "permissions-granted.md");
}

function splitPermissionList(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(/[;,]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractRequestLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") && line.includes("type="));
}

function renderGrantLine(line: string): string {
  return line.startsWith("-") ? line : `- ${line}`;
}

function renderCapabilityGrantLines(capabilities: string[]): string[] {
  return permissionItemsFromCapabilities(capabilities).map((item) => {
    const parts = [`- type=${item.category}`, item.capability];
    if (item.gate) parts.push(`gate=${item.gate}`);
    return parts.join(" ");
  });
}

async function writePermissionGrants(
  ctx: CliContext,
  id: string,
  flags: PermsFlags,
): Promise<{ filePath: string; grants: string[] }> {
  const workspacePath = resolveAgentWorkspacePathFromHome(ctx.paths.larkwayDir, id);
  const requestPath = path.join(workspacePath, "permissions-request.md");
  const grantedPath = path.join(workspacePath, "permissions-granted.md");
  const grants: string[] = [];

  if (flags.grantFromRequest) {
    const requestText = await readFile(requestPath, "utf8").catch(() => "");
    grants.push(...extractRequestLines(requestText));
  }

  grants.push(...renderCapabilityGrantLines(splitPermissionList(flags.grantPermissions)));

  if (grants.length === 0) {
    throw new Error("没有可确认的权限。请先生成 permissions-request.md,或传 --grant-permission。");
  }

  const now = new Date().toISOString();
  const note = flags.grantNote?.trim();
  const body = [
    "# Permissions Granted",
    "",
    `confirmed_at: ${now}`,
    note ? `note: ${note}` : undefined,
    "",
    ...grants.map(renderGrantLine),
    "",
    "Do not record secret values here.",
    "",
  ].filter((line): line is string => line !== undefined).join("\n");

  await mkdir(path.dirname(grantedPath), { recursive: true });
  await writeFile(grantedPath, body, "utf8");
  return { filePath: grantedPath, grants };
}

// ---------------------------------------------------------------------------
// Interactive edit sub-menus
// ---------------------------------------------------------------------------

async function editChatsInteractive(config: BotConfig, ctx: CliContext): Promise<BotConfig> {
  const { ui, flags } = ctx;
  const { bold, cyan, dim } = ui;

  for (;;) {
    ui.print("");
    ui.print(bold("Chats 白名单:"));
    if (config.chats.length === 0) {
      ui.print("  " + dim("(空)"));
    } else {
      config.chats.forEach((c, i) => ui.print(`  ${i + 1}. ${cyan(c)}`));
    }

    const action = await ui.select(
      "操作:",
      [
        { value: "add", label: "添加 chat_id" },
        { value: "remove", label: "移除 chat_id" },
        { value: "done", label: "完成" },
      ],
      { defaultIndex: 2, nonInteractive: flags.nonInteractive },
    );

    if (action === "done") break;

    if (action === "add") {
      const raw = await ui.prompt("chat_id (oc_ 开头):", { nonInteractive: flags.nonInteractive });
      const chatId = raw.trim();
      if (!chatId.startsWith("oc_")) {
        ui.warning("chat_id 必须以 oc_ 开头,已跳过");
      } else if (config.chats.includes(chatId)) {
        ui.warning(`${chatId} 已在白名单,跳过`);
      } else {
        config = { ...config, chats: [...config.chats, chatId] };
        ui.success(`已添加 ${chatId}`);
      }
    } else {
      // remove
      if (config.chats.length === 0) {
        ui.warning("白名单已空");
        continue;
      }
      const choices = config.chats.map((c) => ({ value: c, label: c }));
      const toRemove = await ui.select("选择要移除的 chat:", choices, {
        nonInteractive: flags.nonInteractive,
      });
      config = { ...config, chats: config.chats.filter((c) => c !== toRemove) };
      ui.success(`已移除 ${toRemove}`);
    }
  }

  return config;
}

async function editReposInteractive(config: BotConfig, ctx: CliContext): Promise<BotConfig> {
  const { ui, flags } = ctx;
  const { bold, cyan, dim } = ui;

  for (;;) {
    ui.print("");
    ui.print(bold("Repos:"));
    if (config.repos.length === 0) {
      ui.print("  " + dim("(无)"));
    } else {
      config.repos.forEach((r, i) =>
        ui.print(`  ${i + 1}. ${cyan(r.slug)} ${dim(`branch: ${r.branch}`)}`),
      );
    }

    const action = await ui.select(
      "操作:",
      [
        { value: "add", label: "添加 repo" },
        { value: "remove", label: "移除 repo" },
        { value: "done", label: "完成" },
      ],
      { defaultIndex: 2, nonInteractive: flags.nonInteractive },
    );

    if (action === "done") break;

    if (action === "add") {
      const raw = await ui.prompt("repo slug (格式 group/name 或 group/name:branch):", {
        nonInteractive: flags.nonInteractive,
      });
      const spec = parseRepoSpec(raw.trim());
      if (!spec.slug) {
        ui.warning("无效 slug,已跳过");
      } else if (config.repos.some((r) => r.slug === spec.slug)) {
        ui.warning(`${spec.slug} 已存在,跳过`);
      } else {
        config = { ...config, repos: [...config.repos, spec] };
        ui.success(`已添加 ${spec.slug} (branch: ${spec.branch})`);
      }
    } else {
      // remove
      if (config.repos.length === 0) {
        ui.warning("Repos 列表已空");
        continue;
      }
      const choices = config.repos.map((r) => ({
        value: r.slug,
        label: `${r.slug} (${r.branch})`,
      }));
      const toRemove = await ui.select("选择要移除的 repo:", choices, {
        nonInteractive: flags.nonInteractive,
      });
      config = { ...config, repos: config.repos.filter((r) => r.slug !== toRemove) };
      ui.success(`已移除 ${toRemove}`);
    }
  }

  return config;
}

async function editPeersInteractive(config: BotConfig, ctx: CliContext): Promise<BotConfig> {
  const { ui, flags } = ctx;
  const { bold, cyan, dim } = ui;

  for (;;) {
    ui.print("");
    ui.print(bold("Peer bots:"));
    if (config.peers.length === 0) {
      ui.print("  " + dim("(无)"));
    } else {
      config.peers.forEach((p, i) => ui.print(`  ${i + 1}. ${cyan(p)}`));
    }

    const action = await ui.select(
      "操作:",
      [
        { value: "add", label: "添加 peer bot id" },
        { value: "remove", label: "移除 peer bot id" },
        { value: "done", label: "完成" },
      ],
      { defaultIndex: 2, nonInteractive: flags.nonInteractive },
    );

    if (action === "done") break;

    if (action === "add") {
      const raw = await ui.prompt("peer bot id (kebab-case):", {
        nonInteractive: flags.nonInteractive,
      });
      const peerId = raw.trim();
      if (!peerId) {
        ui.warning("无效 id,已跳过");
      } else if (config.peers.includes(peerId)) {
        ui.warning(`${peerId} 已在 peers 列表,跳过`);
      } else {
        config = { ...config, peers: [...config.peers, peerId] };
        ui.success(`已添加 peer ${peerId}`);
      }
    } else {
      if (config.peers.length === 0) {
        ui.warning("Peers 列表已空");
        continue;
      }
      const choices = config.peers.map((p) => ({ value: p, label: p }));
      const toRemove = await ui.select("选择要移除的 peer:", choices, {
        nonInteractive: flags.nonInteractive,
      });
      config = { ...config, peers: config.peers.filter((p) => p !== toRemove) };
      ui.success(`已移除 peer ${toRemove}`);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Main interactive loop
// ---------------------------------------------------------------------------

async function runInteractive(config: BotConfig, ctx: CliContext): Promise<BotConfig> {
  const { ui, flags } = ctx;

  for (;;) {
    const section = await ui.select(
      "编辑哪个暴露面?",
      [
        { value: "chats", label: "Chats 白名单", hint: "谁能 @ 这个 bot" },
        { value: "repos", label: "Repos", hint: "能碰哪些代码库" },
        { value: "peers", label: "Peer bots", hint: "可 @ 的 peers" },
        { value: "token", label: "GitLab token_env", hint: "查看 scope 提醒(只读env引用名)" },
        { value: "done", label: "完成 / 保存" },
      ],
      { defaultIndex: 4, nonInteractive: flags.nonInteractive },
    );

    if (section === "done") break;

    if (section === "chats") {
      config = await editChatsInteractive(config, ctx);
    } else if (section === "repos") {
      config = await editReposInteractive(config, ctx);
    } else if (section === "peers") {
      config = await editPeersInteractive(config, ctx);
    } else if (section === "token") {
      ui.print("");
      if (config.gitlab_token_env) {
        ui.print(`  env 引用名: ${ui.cyan(config.gitlab_token_env)}`);
        ui.print(
          "  " +
            ui.dim(
              "scope 提醒: 该 PAT 需要 read_api + write_repository + api 权限。" +
                "请在 GitLab Settings → Access Tokens 确认。",
            ),
        );
        ui.print(
          "  " + ui.dim("修改 token 真值:") + " larkway doctor --fix  或手动编辑 ~/.larkway/.env",
        );
      } else {
        ui.warning("gitlab_token_env 未配置 — repo 型 agent_workspace bot 启动前必须补 per-agent token env");
        ui.print(
          "  " +
            ui.dim(
              "如需为此 bot 单独配置 token,先在 ~/.larkway/.env 写入 KEY=<token值>," +
                "再用 larkway bot edit 设置 gitlab_token_env: KEY",
            ),
        );
      }
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { ui, botsStore, flags } = ctx;

  const permsFlags = parsePermsArgs(args);
  const id = permsFlags.positional[0];

  if (!id) {
    ui.failure("用法: larkway perms <bot-id> [--add-chat oc_xxx] [--remove-chat oc_xxx] [--add-repo group/name[:branch[:url]]] [--repo-url url] [--gitlab-token-env KEY] [--remove-repo group/name] [--add-peer id] [--remove-peer id] [--grant-from-request] [--grant-permission text]");
    return 1;
  }

  // Load existing bot config
  let config: BotConfig;
  try {
    config = await botsStore.readBot(id);
  } catch (e) {
    ui.failure(`Bot "${id}" 不存在或配置损坏: ${String(e)}`);
    if (flags.json) ui.emitJson({ ok: false, error: String(e), id });
    return 1;
  }

  // Check if we have any non-interactive mutations requested
  const hasConfigMutations =
    permsFlags.addChats.length > 0 ||
    permsFlags.removeChats.length > 0 ||
    permsFlags.addRepos.length > 0 ||
    permsFlags.repoUrl !== undefined ||
    permsFlags.removeRepos.length > 0 ||
    permsFlags.gitlabTokenEnv !== undefined ||
    permsFlags.addPeers.length > 0 ||
    permsFlags.removePeers.length > 0;
  const hasGrantMutations =
    permsFlags.grantFromRequest || permsFlags.grantPermissions.length > 0;

  if (hasConfigMutations || hasGrantMutations) {
    // Apply mutations directly (non-interactive / scripted path)
    const beforeConfig = config;
    let resetGrantedPath: string | undefined;
    if (hasConfigMutations) {
      config = applyNonInteractiveMutations(id, config, permsFlags);

      // Validate before writing
      try {
        botsStore.validateBot(config, `bot "${id}" (perms mutation)`);
      } catch (e) {
        ui.failure(`变更后配置校验失败: ${String(e)}`);
        if (flags.json) ui.emitJson({ ok: false, error: String(e), id });
        return 1;
      }

      await botsStore.writeBot(config);
      resetGrantedPath = await resetPermissionArtifactsIfNeeded(
        ctx,
        beforeConfig,
        config,
        "bot exposure changed through larkway perms",
      );
    }

    let grantResult: Awaited<ReturnType<typeof writePermissionGrants>> | undefined;
    if (hasGrantMutations) {
      try {
        grantResult = await writePermissionGrants(ctx, id, permsFlags);
      } catch (e) {
        ui.failure(`权限确认写入失败: ${String(e)}`);
        if (flags.json) ui.emitJson({ ok: false, error: String(e), id });
        return 1;
      }
    }

    if (flags.json) {
      ui.emitJson({
        ok: true,
        id,
        chats: config.chats,
        repos: config.repos,
        peers: config.peers,
        gitlab_token_env: config.gitlab_token_env ?? null,
        permissions_reset_path: resetGrantedPath,
        permissions_granted_path: grantResult?.filePath,
        permissions_granted_count: grantResult?.grants.length,
      });
    } else {
      renderSummary(config, ui);
      if (grantResult) {
        ui.success(`${id} 已记录权限确认: ${grantResult.filePath}`);
      }
      if (resetGrantedPath && !grantResult) {
        ui.warning(`权限面已变化,已重置授权记录: ${resetGrantedPath}`);
      }
      ui.success(`${id} 暴露面已更新`);
    }
    return 0;
  }

  // Interactive path (or read-only display in non-interactive with no mutations)
  if (flags.nonInteractive) {
    // Non-interactive with no mutations = display only
    if (flags.json) {
      ui.emitJson({
        ok: true,
        id,
        chats: config.chats,
        repos: config.repos,
        peers: config.peers,
        gitlab_token_env: config.gitlab_token_env ?? null,
      });
    } else {
      renderSummary(config, ui);
    }
    return 0;
  }

  // Interactive: show current state → let user edit → save if changed
  renderSummary(config, ui);

  const original = JSON.stringify({
    chats: config.chats,
    repos: config.repos,
    peers: config.peers,
  });
  const beforeConfig = config;

  config = await runInteractive(config, ctx);

  const updated = JSON.stringify({
    chats: config.chats,
    repos: config.repos,
    peers: config.peers,
  });

  if (original === updated) {
    ui.print("");
    ui.print(ui.dim("无变更,未写入磁盘。"));
    return 0;
  }

  // Validate + write
  try {
    botsStore.validateBot(config, `bot "${id}" (perms interactive edit)`);
  } catch (e) {
    ui.failure(`配置校验失败: ${String(e)}`);
    return 1;
  }

  await botsStore.writeBot(config);
  const resetGrantedPath = await resetPermissionArtifactsIfNeeded(
    ctx,
    beforeConfig,
    config,
    "bot exposure changed through larkway perms interactive edit",
  );

  ui.print("");
  renderSummary(config, ui);
  if (resetGrantedPath) {
    ui.warning(`权限面已变化,已重置授权记录: ${resetGrantedPath}`);
  }
  ui.success(`${id} 暴露面已保存`);

  return 0;
}
