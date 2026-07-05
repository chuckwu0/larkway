/**
 * src/cli/commands/tasklistInit.ts
 *
 * `larkway tasklist-init` — ONE-TIME provisioning for the task-handle feature
 * (docs/task-handle.md §7, v2 team-shared single-tasklist model). This is
 * the ONLY path that ever creates/adopts the shared "Agent Team" tasklist —
 * bots never auto-create one at startup (main.ts only ever does read-only
 * resolution: yaml config, then the shared registry; see main.ts's F1
 * task-handle block).
 *
 * v3.4 north star: the operator should never have to read a flag reference.
 * Running it with NO arguments must do the right thing — `larkway
 * tasklist-init` alone (or telling Claude Code / Codex "帮我配置一下 Agent
 * Team", since the agent's first move is `--help`, see USAGE below) should
 * provision a working "Agent Team" board for every bot currently configured
 * on this machine:
 *   - `--team` defaults to EVERY bot under `bots/` (ctx.botsStore.listBots())
 *     — no manual enumeration required. Only a truly bot-less machine fails.
 *   - `--name` defaults to "Agent Team".
 *   - Zero-arg CREATES a bot-app-owned board by default (ownership decision,
 *     2026-07). **adopt** — taking over a tasklist the operator built
 *     themselves in the Task Center, so THEY own it — is opt-in only, via
 *     `--adopt "<name>"` / `--adopt-guid <guid>`. Auto-adopting by name was
 *     removed: a company running multiple Larkway fleets would have the
 *     second fleet silently adopt the first's same-named board. Explicit
 *     adopt hard-fails loudly on any lookup problem (not logged in, missing
 *     scope, no match, ambiguous) — never a silent create.
 *   - `--adopt "<name>"` / `--adopt-guid <guid>` / `--team` / `--owner` /
 *     `--force` all remain valid EXPLICIT overrides of the above.
 *
 * Everything here runs non-interactively (no prompts) and every failure
 * message embeds its own next step on stderr/stdout — an agent that has
 * never read the docs must be able to unblock a human using only that text
 * (login command, scope grant, or the exact rerun flag for an ambiguous
 * match).
 *
 * Two reasons the create fallback (unlike adopt) must still exist and still
 * requires a human owner:
 *   1. Feishu's task v2 API has no user-token flow for the CREATE call in
 *      this codebase — the tasklist's API-level `owner`/`creator` field is
 *      whichever identity calls `create` (here, the first team bot's app).
 *      Without a HUMAN member added explicitly, the owner has no way to see
 *      this board in their own Feishu Task Center at all (see resolveOwner
 *      below). Adopt mode sidesteps this entirely — the operator already
 *      owns the board by having made it themselves.
 *   2. The tasklist must exist BEFORE a user can right-click "转任务" a
 *      message into it — provisioning cannot be deferred to "first claim".
 *
 * Steps for the create/reuse-registry fallback (MAJOR fix, unchanged since
 * v3.3: registry is checked BEFORE creating anything — re-running this
 * command, e.g. onboarding a new bot into an existing team, must never end
 * up with two "Agent Team" tasklists):
 *   1. Resolve every team bot's app_id/secret.
 *   2. Resolve the human owner's open_id — `--owner`, else auto-detect via
 *      `lark-cli auth status --profile <profile> --json` for the creator
 *      bot's profile (see ../ownerIdentity.ts). Neither resolving → fail
 *      with a clear message, no tasklist created/touched.
 *   3. Check the shared team registry (`<LARKWAY_HOME>/task-team.json`):
 *      - A guid is already there and `--force` was NOT passed → REUSE it:
 *        `addTasklistMembers` the owner + every team bot's app onto the
 *        EXISTING tasklist (idempotent), create nothing new.
 *      - No guid yet, or `--force` was passed → CREATE ONE new tasklist,
 *        with members = [owner as user/editor, every team bot's app as
 *        app/editor]. NEVER a chat/group member (v2 keeps this list
 *        private — §5.3).
 *   4. Safety net: read the tasklist's membership back
 *      (`TaskListClient.getTasklist`) and warn (not fail) if the owner's
 *      open_id isn't actually present.
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
import {
  searchUserTasklists,
  addTasklistMembersAsUser,
  getUserTasklistMembers,
  type UserTasklistSummary,
} from "../userTasklistOps.js";

interface ParsedFlags {
  team: string[];
  name: string;
  owner?: string;
  force: boolean;
  /** v3.4 --adopt "<清单名>": adopt a tasklist the operator already created themselves via the Task Center UI, instead of creating one via a bot's app credentials. Explicit — forces adopt mode even if lookup fails (no silent fallback to create). */
  adopt?: string;
  /** --adopt-guid: disambiguates the by-name lookup when multiple visible tasklists share the same name in --adopt mode — also usable alone to enter (explicit) adopt mode with a known guid, skipping the lookup entirely. */
  adoptGuid?: string;
}

function parseArgs(args: string[]): ParsedFlags {
  let team: string[] = [];
  let name = "Agent Team";
  let owner: string | undefined;
  let force = false;
  let adopt: string | undefined;
  let adoptGuid: string | undefined;

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
    } else if (arg === "--adopt" && i + 1 < args.length) {
      adopt = args[++i];
    } else if (arg.startsWith("--adopt=")) {
      adopt = arg.slice("--adopt=".length);
    } else if (arg === "--adopt-guid" && i + 1 < args.length) {
      adoptGuid = args[++i];
    } else if (arg.startsWith("--adopt-guid=")) {
      adoptGuid = arg.slice("--adopt-guid=".length);
    }
  }
  return { team, name, owner, force, adopt, adoptGuid };
}

const USAGE = `larkway tasklist-init [--team <bot1,bot2,…>] [--name <清单名>] [--owner <open_id>] [--force]
                      [--adopt "<清单名>" | --adopt-guid <guid>]

对着 Claude Code / Codex 说一句「帮我配置一下 Agent Team」就够了 —— 一个没读过这份
帮助的 agent,第一步必然会跑 \`larkway tasklist-init --help\`(就是你正在看的这段),
从这里就能学会怎么把本机所有已配置的 bot 都配成清单成员,不需要你再手动传任何参数。

零参数 Quickstart:
  1. 跑:larkway tasklist-init
     —— 会自动:--team = 本机 bots/ 目录下全部已配置 bot;--name = "Agent Team";
     用第一个 bot 的 app 身份**新建**一个清单(清单 owner = 该 bot app),并把你
     加为 editor 成员(方便在任务中心看到并编辑)。零参数**不会**自动去认领同名清单。
  2. 去飞书任务中心确认这个清单在你的列表里可见,之后右键话题消息选"转任务"即可。

想让清单归**你自己**所有(而不是 bot app)?先在任务中心自己建一个,再用
\`--adopt "<清单名>"\` 认领(见下)。多套 Larkway 部署时,给每套用 --name 改个不同
名字做隔离,避免混用。

以上全部是缺省行为,以下 flag 仅用于覆盖:

  --team <bot1,bot2,…>   显式指定要加入清单的 bot(默认 = 全部已配置 bot)
  --name <清单名>          显式指定要创建/复用的清单名(默认 "Agent Team");多团队
                          部署用它隔离。--adopt/--adopt-guid 会忽略它,按名字/guid 查
  --adopt "<清单名>"       认领你自己在任务中心建好的同名清单(把这些 bot 加为 editor)——
                          查不到/查出多个都直接报错退出,绝不静默回退到创建路径
  --adopt-guid <guid>     跳过按名字查找,直接认领这个 guid 的清单;多个同名清单时消歧
  --owner <open_id>       显式指定人类 owner(仅创建路径用到,adopt 模式下你本来就是
                          owner,不需要这个)
  --force                 覆盖共享注册文件里已有的 guid(默认不覆盖,避免误操作把
                          整个团队切到一个新板)

── 删除/清理(暂无自动子命令)──
  零参数创建的清单 owner 是 bot app,你的用户身份删不掉它。要删除本机注册的清单:
  用创建它的 bot 的 app 凭证(bridge 自己用的那套,tenant_access_token)调
  \`DELETE /open-apis/task/v2/tasklists/{guid}\`(guid 见 <LARKWAY_HOME>/task-team.json),
  再删掉本机状态文件:task-team.json、candidate-alerts-<guid>.json、各 bot 的
  task-handles.json 里对应记录。(自动 --delete 子命令按需再加。)

── adopt 模式内部步骤(仅显式 --adopt/--adopt-guid 触发)──
  1. 以你(操作者)的用户身份按名字精确匹配你能看到的清单(重名 → 报错列出全部
     guid,让你加 --adopt-guid <guid> 消歧重跑;一个都找不到 → 报错提示先去任务
     中心建一个,绝不静默创建)
  2. 把每个 bot 的 app 加为清单成员(role=editor,幂等,已是成员的跳过/无害重复)
  3. 写入共享注册文件 <LARKWAY_HOME>/task-team.json(与创建路径同一套
     first-writer-wins / --force 覆盖语义)
  4. 读回成员列表,核实每个 bot 真的加入成功

前置条件(仅 adopt 需要):这个 profile 必须已经用**用户身份**登录过 lark-cli 且
申请了 task 域权限:
  lark-cli auth login --profile <profile> --domain task
(用哪个 profile:第一个团队 bot 的 lark_cli_profile,缺省时用它的 app_id)。
没有事先登录/缺 scope 会在 adopt 步骤 1 报错,报错信息会带上面这条命令作为提示。

── 创建路径内部步骤(自动回退,或未匹配到同名清单时触发)──
  1. 先查共享注册文件:已有 guid 且未传 --force → 复用;否则建一个新清单
  2. 把你(owner)加为人类成员(role=editor)—— 否则你在飞书任务中心看不到这个清单
  3. 把每个 bot 的 app 都加为清单成员(role=editor)
  4. 读回成员列表,若 owner 未成功加入会打印一条 warning(不会让命令失败)
  5. (仅新建时)把 guid 写进共享注册文件

owner open_id 解析顺序(仅创建路径用到):显式 --owner 优先;省略时尝试从 lark-cli
当前登录的用户身份自动解析(需要你之前对该 profile 跑过 \`lark-cli auth login\`);
两者都拿不到会直接报错退出,不建/不动任何清单。

不会把任何群加为成员 —— v2 清单默认只对 owner 私有;分享给同事看,要给 editor 权限
对方才能把话题转任务进来,给 viewer 只能看不能转(见 docs/task-handle.md §5.3)。

全程非交互:任何歧义都直接非零退出并把候选 + 下一步指引打到 stderr,不会弹任何
交互式问题(这个命令本来就设计给 agent 在 headless 环境里跑)。

⚠️ 首次跑完后,请在飞书任务中心确认这个清单确实可见(见 docs/task-handle.md §7 —
本实现无法在无网络环境下端到端验证 editor 成员的可见性,留给这一步人工确认)。

示例:
  larkway tasklist-init
  larkway tasklist-init --adopt "Agent Team"
  larkway tasklist-init --adopt "Agent Team" --adopt-guid abc-123-guid
  larkway tasklist-init --team larkway-devops,larkway-marketing --name "Agent Team"
  larkway tasklist-init --team larkway-devops --owner ou_1234567890abcdef
  larkway tasklist-init --team larkway-devops --force`;

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  // v3.4: `larkway tasklist-init --help` is routed here as `["help"]` by
  // cli/index.ts (the global `--help` flag is otherwise stripped before any
  // command ever sees it — see index.ts's help branch) — this IS the
  // primary documentation entry point (docs/task-handle.md §7), so it must
  // work with zero other args/config present.
  if (args.includes("help")) {
    ctx.ui.print(USAGE);
    return 0;
  }

  const { team, name, owner: explicitOwner, force, adopt, adoptGuid: explicitAdoptGuid } = parseArgs(args);

  // v3.4 zero-arg happy path: --team omitted → every bot configured on this
  // machine, not a hard failure. Only a genuinely bot-less machine still
  // fails here (nothing sensible to provision a tasklist FOR).
  let team_ = team;
  if (team_.length === 0) {
    team_ = await ctx.botsStore.listBots();
    if (team_.length === 0) {
      const msg = "本机没有配置任何 bot。先运行 `larkway bot add` 添加至少一个 bot,再重跑这个命令。";
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else {
        ctx.ui.failure(msg);
        ctx.ui.print(USAGE);
      }
      return 1;
    }
  }

  const bots: { id: string; app_id: string; appSecret: string; lark_cli_profile?: string }[] = [];
  for (const botId of team_) {
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
  // tasklist when creating one, or drives addTasklistMembers when reusing;
  // in adopt mode, its lark_cli_profile is also the profile the human
  // operator's own `lark-cli auth login --domain task` must have targeted).
  const creator = bots[0]!;
  const creatorProfile = deriveLarkCliProfile(creator.lark_cli_profile, creator.app_id);
  const loginHint = `lark-cli auth login --profile ${creatorProfile} --domain task`;

  // Mode selection — two ways in (user-owned ownership decision, 2026-07):
  //   1. Explicit --adopt/--adopt-guid: adopt the tasklist the operator already
  //      created themselves (they become its true owner). ANY lookup problem
  //      (not logged in, missing scope, no match, ambiguous match) is a HARD
  //      failure — they asked to adopt, so we never silently create a
  //      different/duplicate board instead.
  //   2. Neither flag (zero-arg): CREATE a bot-app-owned board. Auto-adopting
  //      by name is deliberately NOT done — see the create fall-through below
  //      for why (multi-fleet cross-team mixing).
  if (adopt !== undefined || explicitAdoptGuid !== undefined) {
    const adoptName = adopt ?? name;
    if (adoptName.trim().length === 0) {
      const msg = '--adopt 需要一个非空的清单名字,例如 --adopt "Agent Team"。';
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
      else {
        ctx.ui.failure(msg);
        ctx.ui.print(USAGE);
      }
      return 1;
    }
    const target = resolveAdoptTarget(creatorProfile, adoptName, explicitAdoptGuid, loginHint);
    if (!target.ok) {
      if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: target.message });
      else {
        ctx.ui.failure(target.message);
        if (target.reason === "list-failed") ctx.ui.print(USAGE);
      }
      return 1;
    }
    return runAdoptWithGuid(ctx, {
      guid: target.guid,
      matchedName: target.matchedName,
      bots,
      force,
      creatorProfile,
      loginHint,
    });
  }

  // Zero-arg (no --adopt/--adopt-guid): CREATE a bot-app-owned board by design
  // (user-owned ownership decision, 2026-07). Auto-adopting by name is
  // deliberately GONE: a company running MULTIPLE Larkway fleets would have the
  // second fleet silently adopt the first's same-named board (cross-team
  // mixing). Adoption is now opt-in only, via --adopt/--adopt-guid above (which
  // hard-fails loudly on any lookup error — the operator asked to adopt, so a
  // failed lookup must never quietly create). So fall straight through to the
  // create/reuse-registry path below; the tasklist's owner is the creating bot
  // app (the human is added as an editor for visibility — see the output).
  if (!ctx.flags.json) {
    ctx.ui.print(
      ctx.ui.dim(
        `(用 bot app 身份创建/复用清单 "${name}"。想认领你自己在任务中心建的清单请用 ` +
          `--adopt "<清单名>" / --adopt-guid <guid>;多团队部署建议用 --name 改名隔离。)`,
      ),
    );
  }

  // F2: resolve the human owner's open_id BEFORE touching any tasklist — a
  // tasklist with no human member is useless (owner can't see it in their
  // Task Center), and we never want to create/mutate anything just because
  // resolution failed partway through.
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
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isMembersEndpoint404(errMsg)) {
        // Same 404 the bridge's self-join treats as best-effort continuing
        // (main.ts) — the app-type members endpoint 404s (app self-add isn't
        // supported there), but the bots are already members, so the reused
        // list is fully usable. Degrade to a warn instead of a fatal exit;
        // don't blame a scope the app already has.
        if (!ctx.flags.json) {
          ctx.ui.warning(
            `复用清单 ${tasklistGuid} 时 add_members 返回 404(app 类型成员端点不支持自助加入,` +
              "bot 通常已经是成员)——已忽略,不影响使用(与 bridge 启动的自助加入同款降级)。",
          );
        }
      } else {
        const msg = `复用已有清单 ${tasklistGuid} 时补充成员失败: ${errMsg}`;
        if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
        else {
          ctx.ui.failure(msg);
          ctx.ui.print("常见原因:app 未在开放平台后台勾选 task:tasklist:write / task:task:write scope(见 docs/task-handle.md §7)。");
        }
        return 1;
      }
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
      team: team_,
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
  // This is the bot-app CREATE/REUSE path: the tasklist's real owner is the
  // bot app that created it (app-only credentials), NOT the human. The human is
  // added as an EDITOR member so they can see + edit it in their Task Center.
  // (True user ownership only happens on the --adopt path, where the operator
  // created the board themselves in the UI.)
  ctx.ui.print(
    `你(${ownerOpenId})已作为 editor 加入${explicitOwner ? "" : "(open_id 从 lark-cli 当前登录用户自动解析)"} —— ` +
      "清单 owner 是创建它的 bot app;你是 editor 成员(可在任务中心看到并编辑)。",
  );
  ctx.ui.print(`已加入(editor)的 bot: ${bots.map((b) => b.id).join(", ")}`);
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

/**
 * True ONLY for the app-type members-endpoint's raw HTTP 404 — `POST
 * /tasklists/{guid}/members` responds "404 page not found" for an app self-add
 * (the bot is already a member). Deliberately narrow: a bare "not found" /
 * 不存在 / resource_not_exist is a DIFFERENT, API-level failure — e.g. the
 * reused tasklist guid was deleted out from under us (TOCTOU) — which must NOT
 * be swallowed as benign. So we key on the endpoint-not-found body string only,
 * not on any generic not-found marker. Message-based because TaskListClient
 * wraps the raw error before it reaches here; the call site guarantees this is
 * an addTasklistMembers failure.
 */
function isMembersEndpoint404(errMsg: string): boolean {
  return /page not found/i.test(errMsg);
}

/** Discriminated result of resolveAdoptTarget — see its doc comment. */
type AdoptTargetResult =
  | { ok: true; guid: string; matchedName: string }
  | { ok: false; reason: "list-failed"; message: string }
  | { ok: false; reason: "not-found"; message: string }
  | { ok: false; reason: "ambiguous"; message: string; matches: UserTasklistSummary[] };

/**
 * docs/task-handle.md §7: resolve WHICH existing tasklist an EXPLICIT adopt
 * (`--adopt`/`--adopt-guid`) should target, without doing any writes. The
 * operator asked to adopt by name/guid, so EVERY failure reason is fatal
 * (list-failed / not-found / ambiguous) — we never silently create a
 * different or duplicate board instead. (Zero-arg no longer calls this: it
 * creates a bot-app-owned board by design, see run().)
 *
 * `explicitGuid`, when given, skips the by-name lookup entirely — the
 * operator (or a previous ambiguous-match error's suggested rerun) already
 * disambiguated, so there's nothing left to look up.
 */
function resolveAdoptTarget(
  creatorProfile: string,
  name: string,
  explicitGuid: string | undefined,
  loginHint: string,
): AdoptTargetResult {
  if (explicitGuid) {
    return { ok: true, guid: explicitGuid, matchedName: name };
  }

  const listResult = searchUserTasklists(creatorProfile, name);
  if (!listResult.ok) {
    return {
      ok: false,
      reason: "list-failed",
      message:
        `无法以你的用户身份查询清单:${listResult.error}\n\n` +
        `请先确认已用这个 profile 登录过用户身份、且申请了 task 域权限:\n  ${loginHint}\n` +
        `(可用 \`lark-cli auth status --profile ${creatorProfile} --json\` 检查当前状态)`,
    };
  }

  // The search filters by keyword server-side; still require an EXACT name
  // match so a fuzzy/substring hit never adopts the wrong board.
  const matches = listResult.data.filter((t) => t.name === name);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      message:
        `在你能看到的清单里没找到名为 "${name}" 的清单。请先去飞书任务中心新建一个同名清单,` +
        "再重跑这个命令;或者检查名字是否完全一致(注意全半角字符、多余空格)。",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message:
        `找到 ${matches.length} 个同名清单 "${name}",无法确定要 adopt 哪一个:\n` +
        matches.map((t) => `  - ${t.guid}`).join("\n") +
        "\n请加 --adopt-guid <guid> 显式指定其中一个重跑,或去飞书任务中心把其中一个改名后再重跑。",
      matches,
    };
  }

  return { ok: true, guid: matches[0]!.guid, matchedName: matches[0]!.name };
}

/**
 * v3.4 (docs/task-handle.md §7): given an ALREADY-RESOLVED tasklist guid
 * (from either the explicit --adopt/--adopt-guid path or the implicit
 * auto-select path in run()), add every team bot's app as an editor member
 * and report the outcome. Ownership is correct by construction — the
 * operator IS the tasklist's real owner the moment they made it — so unlike
 * the create path, this never resolves/adds a human owner member.
 *
 * Every read/write here goes through userTasklistOps.ts's lark-cli
 * subprocess calls (AS THE HUMAN USER, `--as user`) — `TaskListClient`'s SDK-
 * based app-credential flow has no user-identity mode at all, so this
 * deliberately does NOT touch it.
 */
async function runAdoptWithGuid(
  ctx: CliContext,
  opts: {
    guid: string;
    matchedName: string;
    bots: { id: string; app_id: string; appSecret: string; lark_cli_profile?: string }[];
    force: boolean;
    creatorProfile: string;
    loginHint: string;
  },
): Promise<number> {
  const { guid: tasklistGuid, matchedName, bots, force, creatorProfile, loginHint } = opts;

  const members: TaskMember[] = bots.map((b) => ({ id: b.app_id, type: "app", role: "editor" }));
  const addResult = addTasklistMembersAsUser(creatorProfile, tasklistGuid, members);
  if (!addResult.ok) {
    const msg =
      `把 bot app 加为清单 ${tasklistGuid} 的 editor 失败:${addResult.error}\n\n` +
      `常见原因:这个 profile 的用户身份缺 task:tasklist:write scope —— 重新登录并申请 task 域权限:\n  ${loginHint}`;
    if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
    else ctx.ui.failure(msg);
    return 1;
  }

  // Registry write — same first-writer-wins / --force semantics as the
  // --team-only create path. Unlike that path, the operator here explicitly
  // picked ONE SPECIFIC existing tasklist to adopt — silently keeping some
  // OTHER already-registered guid (claimTeamTasklistGuid's normal behavior)
  // would defeat that explicit intent without saying so, so this checks the
  // outcome and reports a mismatch clearly instead of staying silent about it.
  const registryPath = resolveTaskTeamRegistryPath();
  let registeredGuid: string;
  if (force) {
    await overwriteTeamTasklistGuid(registryPath, tasklistGuid);
    registeredGuid = tasklistGuid;
  } else {
    registeredGuid = await claimTeamTasklistGuid(registryPath, tasklistGuid);
  }
  const registryMismatch = registeredGuid !== tasklistGuid;

  // Safety net: read the membership back and warn (never fail) for any bot
  // that didn't actually land — mirrors the --team-only path's ownerConfirmedMember check.
  const membersResult = getUserTasklistMembers(creatorProfile, tasklistGuid);
  const missingBots: string[] = [];
  let membershipCheckError: string | undefined;
  if (membersResult.ok) {
    for (const b of bots) {
      if (!membersResult.data.some((m) => m.id === b.app_id)) missingBots.push(b.id);
    }
  } else {
    membershipCheckError = membersResult.error;
  }

  if (ctx.flags.json) {
    ctx.ui.emitJson({
      ok: true,
      mode: "adopt",
      adoptedName: matchedName,
      tasklistGuid,
      addedMembers: bots.map((b) => b.id),
      missingBots,
      membershipCheckError: membershipCheckError ?? null,
      registeredGuid,
      registryMismatch,
    });
    return 0;
  }

  ctx.ui.success(`已 adopt 清单 "${matchedName}": ${tasklistGuid}`);
  ctx.ui.print(`已加入成员(editor): ${bots.map((b) => b.id).join(", ")}`);
  ctx.ui.print("");
  if (missingBots.length > 0) {
    ctx.ui.warning(
      `以下 bot 的 app 未出现在清单成员列表里——可能被静默丢弃:${missingBots.join(", ")}。` +
        "请检查 app_id 是否正确,或手动在飞书任务中心把它们加为该清单的 editor。",
    );
  } else if (membershipCheckError) {
    ctx.ui.warning(`无法读回清单 ${tasklistGuid} 的成员列表以核实是否加入成功(继续,不影响本次结果): ${membershipCheckError}`);
  }
  if (registryMismatch) {
    ctx.ui.warning(
      `共享注册文件里已经绑定了另一个清单(${registeredGuid}),这次 adopt 的清单(${tasklistGuid})` +
        "未写入共享注册文件——避免破坏现有团队绑定。如果确实想切换到这个新清单,加 --force 重跑。",
    );
  } else {
    ctx.ui.print(
      `已写入共享注册文件 ${registryPath} —— 团队里的 bot 下次重启会自动发现并使用这个 guid,` +
        "不需要手工改 yaml。",
    );
  }
  ctx.ui.print("");
  ctx.ui.print(
    ctx.ui.bold("可选:") +
      " 如果想固定绑定、不依赖共享注册文件的自动发现,也可以把 guid 手写进各 bot 的 bots/<id>.yaml:",
  );
  ctx.ui.print(`  taskHandle:`);
  ctx.ui.print(`    tasklistGuid: "${tasklistGuid}"`);
  return 0;
}
