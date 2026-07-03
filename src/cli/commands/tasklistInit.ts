/**
 * src/cli/commands/tasklistInit.ts
 *
 * `larkway tasklist-init --team <bot1,bot2,…> [--name <name>] [--owner <open_id>] [--force]`
 *
 * ONE-TIME, human-run provisioning for the task-handle feature
 * (docs/task-handle.md §7, v2 team-shared single-tasklist model). This is
 * the ONLY path that ever creates the shared "Agent Team" tasklist — bots
 * never auto-create one at startup (main.ts only ever does read-only
 * resolution: yaml config, then the shared registry; see main.ts's F1
 * task-handle block). Two reasons this must be a human-run CLI, not
 * something a bot can do on its own:
 *   1. Feishu's task v2 API has no user-token flow in this codebase — the
 *      tasklist's API-level `owner`/`creator` field is whichever identity
 *      calls `create` (here, the first team bot's app). Without a HUMAN
 *      member added explicitly, the owner has no way to see this board in
 *      their own Feishu Task Center at all — this command's whole job is to
 *      fix that gap (see resolveOwner below).
 *   2. The tasklist must exist BEFORE a user can right-click "转任务" a
 *      message into it — provisioning cannot be deferred to "first claim"
 *      the way a stateless lazy-init could, because the human's transfer
 *      action is itself the very first write into the list.
 *
 * Steps (MAJOR fix: registry is checked BEFORE creating anything — an owner
 * re-running this command, e.g. onboarding a new bot into an existing team,
 * must never end up with two "Agent Team" tasklists where some bots write to
 * one and the owner keeps transferring tasks into the other):
 *   1. Resolve every `--team` bot's app_id/secret.
 *   2. Resolve the human owner's open_id — `--owner`, else auto-detect via
 *      `lark-cli auth status --profile <profile> --json` for the creator
 *      bot's profile (see ../ownerIdentity.ts for why this is the only
 *      viable auto-detect source and its full best-effort caveats). Neither
 *      resolving → fail with a clear message, no tasklist created/touched.
 *   3. Check the shared team registry (`<LARKWAY_HOME>/task-team.json`):
 *      - A guid is already there and `--force` was NOT passed → REUSE it:
 *        `addTasklistMembers` the owner + every `--team` bot's app onto the
 *        EXISTING tasklist (idempotent), create nothing new.
 *      - No guid yet, or `--force` was passed → CREATE ONE new tasklist
 *        (first team bot's app becomes its API creator), with members =
 *        [owner as user/editor, every team bot's app as app/editor]. NEVER
 *        a chat/group member (v2 keeps this list private — §5.3). `--force`
 *        additionally overwrites the registry via
 *        `overwriteTeamTasklistGuid` (bypassing the normal first-writer-wins
 *        rule) since the operator explicitly asked to replace the shared one.
 *   4. Safety net: read the tasklist's membership back
 *      (`TaskListClient.getTasklist`) and warn (not fail) if the owner's
 *      open_id isn't actually present — a silently-dropped member would
 *      otherwise be a hard-to-notice "board exists, owner still can't see
 *      it" failure mode.
 *
 * NOT on the message path — this is a host-management command, same class
 * as `larkway bot add` / `larkway perms`.
 */

import { Client as LarkSdkClient } from "@larksuiteoapi/node-sdk";
import type { CliContext } from "../types.js";
import { TaskListClient, type LarkTaskRequester, type TaskMember } from "../../tasklist/client.js";
import { resolveTaskTeamRegistryPath } from "../../config/paths.js";
import {
  claimTeamTasklistGuid,
  overwriteTeamTasklistGuid,
  readTeamTasklistGuid,
} from "../../tasklist/teamRegistry.js";
import { resolveOwnerOpenId } from "../ownerIdentity.js";
import { deriveLarkCliProfile } from "../../lark/profileBootstrap.js";

interface ParsedFlags {
  team: string[];
  name: string;
  owner?: string;
  force: boolean;
}

function parseArgs(args: string[]): ParsedFlags {
  let team: string[] = [];
  let name = "Agent Team";
  let owner: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--team" && i + 1 < args.length) {
      team = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--team=")) {
      team = arg.slice("--team=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--name" && i + 1 < args.length) {
      name = args[++i]!;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (arg === "--owner" && i + 1 < args.length) {
      owner = args[++i];
    } else if (arg.startsWith("--owner=")) {
      owner = arg.slice("--owner=".length);
    } else if (arg === "--force") {
      force = true;
    }
  }
  return { team, name, owner, force };
}

const USAGE = `larkway tasklist-init --team <bot1,bot2,…> [--name <清单名>] [--owner <open_id>] [--force]

为话题↔任务句柄 feature(docs/task-handle.md,v2 团队共享单清单)一次性 provisioning
(只能由人手动跑一次;bot 自己在 startup 时只读、从不自动建清单):
  1. 先查共享注册文件 <LARKWAY_HOME>/task-team.json:
     - 已有 guid 且未传 --force → **复用**已有清单,只把 owner + --team 里的 bot app
       补为成员(不会建出第二个「Agent Team」板)
     - 还没有 guid,或传了 --force → 建一个新清单(默认名 "Agent Team")
  2. 把你(owner)加为人类成员(role=editor)—— 否则你在飞书任务中心看不到这个清单
  3. 把 --team 列出的每个 bot 的 app 都加为清单成员(role=editor)
  4. 读回成员列表,若 owner 未成功加入会打印一条 warning(不会让命令失败)
  5. (仅新建时)把 guid 写进共享注册文件 —— 团队里的 bot 下次重启会自动从这个文件
     发现并使用同一个 guid,**不需要**手工改 yaml;也可以选择手写进各 bot 的
     bots/<id>.yaml 的 taskHandle.tasklistGuid 固定绑定

owner open_id 解析顺序:显式 --owner 优先;省略时尝试从 lark-cli 当前登录的用户身份
自动解析(团队第一个 bot 的 lark-cli profile,需要你之前对该 profile 跑过
\`lark-cli auth login\`);两者都拿不到会直接报错退出,不建/不动任何清单。

--force:显式要求建一个新清单并覆盖共享注册文件里已有的 guid(默认不覆盖,
避免误操作把整个团队切到一个新板)。

不会把任何群加为成员 —— v2 清单默认只对 owner 私有。

⚠️ 首次跑完后,请在飞书任务中心确认这个清单确实可见(见 docs/task-handle.md §7 —
本实现无法在无网络环境下端到端验证 editor 成员的可见性,留给这一步人工确认)。

示例:
  larkway tasklist-init --team larkway-devops,larkway-marketing --name "Agent Team"
  larkway tasklist-init --team larkway-devops --owner ou_1234567890abcdef
  larkway tasklist-init --team larkway-devops --force`;

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { team, name, owner: explicitOwner, force } = parseArgs(args);

  if (team.length === 0) {
    const msg = "缺少必需参数:--team <bot1,bot2,…>";
    if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
    else {
      ctx.ui.failure(msg);
      ctx.ui.print(USAGE);
    }
    return 1;
  }

  const bots: { id: string; app_id: string; appSecret: string; lark_cli_profile?: string }[] = [];
  for (const botId of team) {
    let bot;
    try {
      bot = await ctx.botsStore.readBot(botId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else ctx.ui.failure(msg);
      return 1;
    }
    const appSecret = await ctx.hostConfig.readSecret(bot.app_secret_env);
    if (!appSecret) {
      const msg = `Bot "${botId}" 的 app_secret_env "${bot.app_secret_env}" 在 ~/.larkway/.env 中未设置。`;
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else ctx.ui.failure(msg);
      return 1;
    }
    bots.push({ id: bot.id, app_id: bot.app_id, appSecret, lark_cli_profile: bot.lark_cli_profile });
  }

  // First bot in --team is used for every task-API call (creates the
  // tasklist when creating one, or drives addTasklistMembers when reusing).
  const creator = bots[0]!;

  // F2: resolve the human owner's open_id BEFORE touching any tasklist — a
  // tasklist with no human member is useless (owner can't see it in their
  // Task Center), and we never want to create/mutate anything just because
  // resolution failed partway through.
  const creatorProfile = deriveLarkCliProfile(creator.lark_cli_profile, creator.app_id);
  const ownerOpenId = explicitOwner ?? resolveOwnerOpenId(creatorProfile);
  if (!ownerOpenId) {
    const msg =
      "无法确定清单的人类 owner:未传 --owner,且无法从 lark-cli 当前登录的用户身份自动解析" +
      `(尝试的 profile: "${creatorProfile}")。请显式传入 --owner <open_id>` +
      `(可用 \`lark-cli auth status --profile ${creatorProfile} --json\` 查看是否已登录用户身份,` +
      "或用 lark-cli contact 按姓名/邮箱查 open_id)。不会建/不会动任何清单。";
    if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
    else {
      ctx.ui.failure(msg);
      ctx.ui.print(USAGE);
    }
    return 1;
  }

  const sdkClient = new LarkSdkClient({ appId: creator.app_id, appSecret: creator.appSecret });
  const requester: LarkTaskRequester = {
    request: (config) => sdkClient.request(config as Parameters<typeof sdkClient.request>[0]),
  };
  const taskClient = new TaskListClient(requester);

  // Human owner first (visibility is the whole point of F2), then every team
  // bot's app. NEVER a chat/group member — v2 keeps this list private by
  // construction (docs/task-handle.md §5.3). Role "editor", not "owner": the
  // TaskMember role union (client.ts) only models assignee/follower/editor/
  // viewer — the platform's real tasklist "owner" is an immutable creator
  // field set at create-time, not settable via the members array, so
  // "editor" is the closest real grant (full read/write/visibility) rather
  // than an unverified role string that risks failing the whole call.
  const members: TaskMember[] = [
    { id: ownerOpenId, type: "user", role: "editor" },
    ...bots.map((b): TaskMember => ({ id: b.app_id, type: "app", role: "editor" })),
  ];

  const registryPath = resolveTaskTeamRegistryPath();
  const existingGuid = await readTeamTasklistGuid(registryPath);

  let tasklistGuid: string;
  let reused: boolean;

  if (existingGuid && !force) {
    // MAJOR fix: reuse the fleet's existing tasklist instead of creating a
    // second "Agent Team" board — an owner re-running this command (e.g. to
    // onboard one more bot) must never end up with tasks split across two
    // boards where some bots can't see the one the owner keeps using.
    tasklistGuid = existingGuid;
    reused = true;
    try {
      await taskClient.addTasklistMembers(tasklistGuid, members);
    } catch (err) {
      const msg = `复用已有清单 ${tasklistGuid} 时补充成员失败: ${err instanceof Error ? err.message : String(err)}`;
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else {
        ctx.ui.failure(msg);
        ctx.ui.print("常见原因:app 未在开放平台后台勾选 task:tasklist:write / task:task:write scope(见 docs/task-handle.md §7)。");
      }
      return 1;
    }
  } else {
    reused = false;
    try {
      const created = await taskClient.createTasklist(name, members);
      tasklistGuid = created.guid;
    } catch (err) {
      const msg = `建清单失败: ${err instanceof Error ? err.message : String(err)}`;
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else {
        ctx.ui.failure(msg);
        ctx.ui.print("常见原因:app 未在开放平台后台勾选 task:tasklist:write / task:task:write scope(见 docs/task-handle.md §7)。");
      }
      return 1;
    }
    if (force && existingGuid) {
      // Explicit, human-confirmed override — bypass the normal
      // first-writer-wins rule that protects against accidental clobbers.
      await overwriteTeamTasklistGuid(registryPath, tasklistGuid);
    } else {
      await claimTeamTasklistGuid(registryPath, tasklistGuid);
    }
  }

  // Safety net: read the membership back and warn (never fail the command
  // over this) if the owner didn't actually land as a member — guards the
  // "board exists, owner still can't see it" failure mode where a member
  // entry is silently dropped by the API. Messages are collected here rather
  // than printed directly so --json mode can fold them into the JSON payload
  // instead of writing stray non-JSON lines to stdout (ctx.ui.warning/print
  // both write to stdout, which would corrupt --json output for a machine
  // consumer parsing it).
  let ownerConfirmedMember: boolean | undefined;
  let membershipCheckError: string | undefined;
  try {
    const snapshot = await taskClient.getTasklist(tasklistGuid);
    ownerConfirmedMember = snapshot?.members.some((m) => m.id === ownerOpenId) ?? undefined;
  } catch (err) {
    // Best-effort verification only — a failed readback must never fail the
    // whole command (the tasklist itself was already created/updated fine).
    membershipCheckError = err instanceof Error ? err.message : String(err);
  }

  if (ctx.flags.json) {
    ctx.ui.emitJson({
      ok: true,
      team,
      name,
      ownerOpenId,
      tasklistGuid,
      reused,
      ownerConfirmedMember: ownerConfirmedMember ?? null,
      membershipCheckError: membershipCheckError ?? null,
    });
    return 0;
  }

  if (ownerConfirmedMember === false) {
    ctx.ui.warning(
      `owner(${ownerOpenId})未出现在清单 ${tasklistGuid} 的成员列表里——可能被静默丢弃,` +
        "owner 大概率看不到这个板。请检查 open_id 是否正确、是否跨租户,或手动在飞书任务" +
        "中心把 owner 加为该清单成员。",
    );
  } else if (membershipCheckError) {
    ctx.ui.warning(
      `无法读回清单 ${tasklistGuid} 的成员列表以核实 owner 是否加入成功(继续,不影响本次结果): ${membershipCheckError}`,
    );
  }

  if (reused) {
    ctx.ui.success(`复用已有清单: ${tasklistGuid}`);
  } else {
    ctx.ui.success(`清单 "${name}" 已创建: ${tasklistGuid}`);
  }
  ctx.ui.print(`owner 成员: ${ownerOpenId}${explicitOwner ? "" : "(从 lark-cli 当前登录用户自动解析)"}`);
  ctx.ui.print(`已加入成员(editor): ${bots.map((b) => b.id).join(", ")}`);
  ctx.ui.print("");
  if (!reused) {
    ctx.ui.print(
      `已写入共享注册文件 ${registryPath} —— 团队里的 bot 下次重启会自动发现并使用这个 guid,` +
        "不需要手工改 yaml。",
    );
    ctx.ui.print("");
  }
  ctx.ui.print(
    ctx.ui.bold("可选:") +
      " 如果想固定绑定、不依赖共享注册文件的自动发现,也可以把 guid 手写进各 bot 的 bots/<id>.yaml:",
  );
  ctx.ui.print(`  taskHandle:`);
  ctx.ui.print(`    tasklistGuid: "${tasklistGuid}"`);
  ctx.ui.print("");
  ctx.ui.print(
    ctx.ui.bold("⚠️ 请手动确认:") + " 去飞书任务中心确认这个清单确实可见(见 docs/task-handle.md §7)。",
  );
  return 0;
}
