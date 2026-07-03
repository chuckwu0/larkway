/**
 * src/cli/commands/tasklistInit.ts
 *
 * `larkway tasklist-init --bot <botId> --chat <chatId> [--name <name>] [--peer-app <appId>]...`
 *
 * One-time provisioning for the task-handle feature (docs/task-handle.md §7):
 * creates the bot's per-group shared tasklist, adds the group itself as a
 * member (member type=chat — §9.6, one call adds the whole group), and adds
 * any peer apps so multi-bot teams can all see/maintain the same list. NOT on
 * the message path — this is a host-management command, same class as
 * `larkway bot add` / `larkway perms`.
 *
 * Output is the new tasklistGuid; the operator still has to paste it into
 * `bots/<id>.yaml`'s `taskHandle.tasklistGuid` by hand (provisioning produces
 * data, it does not self-mutate the bot's committed config — consistent with
 * how `larkway perms` reports grants without silently rewriting yaml).
 */

import { Client as LarkSdkClient } from "@larksuiteoapi/node-sdk";
import type { CliContext } from "../types.js";
import { TaskListClient, type LarkTaskRequester, type TaskMember } from "../../tasklist/client.js";

interface ParsedFlags {
  botId?: string;
  chatId?: string;
  name: string;
  peerApps: string[];
}

function parseArgs(args: string[]): ParsedFlags {
  const peerApps: string[] = [];
  let botId: string | undefined;
  let chatId: string | undefined;
  let name = "Agent Team";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bot" && i + 1 < args.length) {
      botId = args[++i];
    } else if (arg.startsWith("--bot=")) {
      botId = arg.slice("--bot=".length);
    } else if (arg === "--chat" && i + 1 < args.length) {
      chatId = args[++i];
    } else if (arg.startsWith("--chat=")) {
      chatId = arg.slice("--chat=".length);
    } else if (arg === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (arg === "--peer-app" && i + 1 < args.length) {
      peerApps.push(args[++i]);
    } else if (arg.startsWith("--peer-app=")) {
      peerApps.push(arg.slice("--peer-app=".length));
    }
  }
  return { botId, chatId, name, peerApps };
}

const USAGE = `larkway tasklist-init --bot <botId> --chat <chatId> [--name <清单名>] [--peer-app <appId>]...

为话题↔任务句柄 feature(docs/task-handle.md)provisioning 一个共享清单:
  1. 建清单(默认名 "Agent Team")
  2. 把 --chat 指定的群整体加为清单成员(member type=chat)
  3. 把每个 --peer-app 加为清单成员(member type=app, role=editor)

输出 tasklistGuid —— 需要手动写进 bots/<id>.yaml 的 taskHandle.tasklistGuid。

示例:
  larkway tasklist-init --bot larkway-devops --chat oc_xxx --name "Agent Team" --peer-app cli_yyy`;

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { botId, chatId, name, peerApps } = parseArgs(args);

  if (!botId || !chatId) {
    const msg = "缺少必需参数:--bot <botId> --chat <chatId>";
    if (ctx.flags.json) ctx.ui.emitJson({ ok: false, error: msg });
    else {
      ctx.ui.failure(msg);
      ctx.ui.print(USAGE);
    }
    return 1;
  }

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

  const sdkClient = new LarkSdkClient({ appId: bot.app_id, appSecret });
  const requester: LarkTaskRequester = {
    request: (config) => sdkClient.request(config as Parameters<typeof sdkClient.request>[0]),
  };
  const taskClient = new TaskListClient(requester);

  const members: TaskMember[] = [
    { id: chatId, type: "chat", role: "editor" },
    ...peerApps.map((appId): TaskMember => ({ id: appId, type: "app", role: "editor" })),
  ];

  let tasklistGuid: string;
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

  if (ctx.flags.json) {
    ctx.ui.emitJson({ ok: true, botId, chatId, name, tasklistGuid, peerApps });
    return 0;
  }

  ctx.ui.success(`清单 "${name}" 已创建: ${tasklistGuid}`);
  ctx.ui.print(`已加入成员: 群 ${chatId}${peerApps.length > 0 ? `, peer apps [${peerApps.join(", ")}]` : ""}`);
  ctx.ui.print("");
  ctx.ui.print(ctx.ui.bold("下一步:") + ` 把这个 guid 写进 bots/${botId}.yaml:`);
  ctx.ui.print(`  taskHandle:`);
  ctx.ui.print(`    enabled: true`);
  ctx.ui.print(`    tasklistGuid: "${tasklistGuid}"`);
  return 0;
}
