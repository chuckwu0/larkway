/**
 * src/tasklist/declare.ts — task_handle v5 (BL-48): declarative task signals.
 *
 * The agent declares, the bridge executes mechanically:
 *   - `create`  → create a Feishu task card, put the topic backlink in its
 *                 description (HARD requirement — explicit chat-link fallback,
 *                 never silently missing), add the triggering human as
 *                 follower, attach to the bot's tasklist when configured.
 *                 The caller then records the thread↔task claim.
 *   - `due`     → set/reschedule the claimed task's due; when a reason is
 *                 given, post it as a comment so watchers see WHY it moved.
 *   - `blocked` → post a "needs a human" comment; task comments push-notify
 *                 followers, which is the 信号5 delivery mechanism.
 *
 * All writes are best-effort (swallow-and-warn, docs/task-handle.md §6.1):
 * a partial failure degrades that one signal, never the turn. This module
 * makes no judgment calls — "should this be a task" was decided agent-side.
 */

import type { TaskListClient, TaskMember } from "./client.js";
import type { TaskHandleStore } from "./store.js";
import { formatLocalDateTime } from "./writeback.js";
import type {
  TaskHandleDeclarationPatch,
  TaskHandleDeclarationResult,
} from "./types.js";

export interface DeclareDeps {
  store: TaskHandleStore;
  client: TaskListClient;
  /** Bot's configured tasklist — created tasks attach to it when present. */
  tasklistGuid?: string;
  /** Display name used in the created description's provenance line. */
  botName?: string;
}

/**
 * Parse an agent-written due into task v2's `{timestamp(ms), is_all_day}`.
 * Accepts: ms-epoch string (13 digits), s-epoch (10 digits), `YYYY-MM-DD`
 * (all-day), or anything `Date.parse` understands (ISO 8601 recommended).
 * Returns null on garbage — caller degrades with a diagnostic.
 */
export function parseDueInput(raw: string): { timestamp: string; is_all_day?: boolean } | null {
  const s = raw.trim();
  if (/^\d{13}$/.test(s)) return { timestamp: s };
  if (/^\d{10}$/.test(s)) return { timestamp: `${Number(s) * 1000}` };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00`);
    if (Number.isNaN(ms)) return null;
    return { timestamp: `${ms}`, is_all_day: true };
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return { timestamp: `${ms}` };
}

function formatDueForComment(due: { timestamp: string; is_all_day?: boolean }): string {
  const d = new Date(Number(due.timestamp));
  if (Number.isNaN(d.getTime())) return due.timestamp;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return due.is_all_day ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Description body for a bridge-created task — backlink first, always present. */
export function renderCreateDescription(patch: TaskHandleDeclarationPatch, botName?: string): string {
  const lines: string[] = [];
  // Markdown LINK syntax renders in the Feishu task description (BL-49 round-3
  // real-machine probe) — a bare applink URL wraps to three unreadable lines,
  // `[text](url)` collapses to one clickable label. Bold/italic do NOT render
  // (they are swallowed along with their text), so links are the only markdown
  // used here.
  if (patch.topicLink) {
    lines.push(`话题：[点击进入工作话题](${patch.topicLink})`);
  } else if (patch.chatLink) {
    lines.push(`话题深链不可用（非话题消息），所在群：[打开群聊](${patch.chatLink})`);
  } else {
    lines.push("话题深链不可用（未解析到话题/群链接）");
  }
  // Local time, not `toISOString()` (BL-49 round-3): the raw UTC `…T08:22:37.894Z`
  // is unreadable in the Feishu client and off by the operator's UTC offset.
  // writeback.ts's status block was fixed for exactly this reason in dogfood V3;
  // the create description was simply missed at the time.
  lines.push(`由 ${botName ?? patch.botId} 创建 · ${formatLocalDateTime(new Date())}`);
  return lines.join("\n");
}

/**
 * Execute the turn's declarations. Never throws; each signal resolves to a
 * one-line outcome the handler records to the runtime event log.
 */
export async function applyTaskHandleDeclarations(
  patch: TaskHandleDeclarationPatch,
  deps: DeclareDeps,
): Promise<TaskHandleDeclarationResult> {
  const outcomes: string[] = [];
  let createdGuid: string | undefined;

  // ── create (信号1) ────────────────────────────────────────────────────────
  if (patch.create) {
    const existing = deps.store.get(patch.threadId);
    if (existing) {
      outcomes.push(`create 跳过：话题已认领任务 ${existing.taskGuid}`);
    } else {
      try {
        const due = patch.create.due ? parseDueInput(patch.create.due) : null;
        if (patch.create.due && !due) {
          outcomes.push(`create.due "${patch.create.due}" 无法解析，任务将无截止时间`);
        }
        const members: TaskMember[] = patch.senderOpenId
          ? [{ id: patch.senderOpenId, type: "user", role: "follower" }]
          : [];
        const { guid } = await deps.client.createTask({
          summary: patch.create.summary,
          description: renderCreateDescription(patch, deps.botName),
          ...(due ? { due } : {}),
          ...(members.length > 0 ? { members } : {}),
          ...(deps.tasklistGuid ? { tasklists: [{ tasklist_guid: deps.tasklistGuid }] } : {}),
        });
        createdGuid = guid;
        outcomes.push(
          `已建任务 ${guid}（${patch.create.summary.slice(0, 40)}${due ? ` · 截止 ${formatDueForComment(due)}` : ""}` +
            `${patch.senderOpenId ? " · 发起人已加关注" : ""}${patch.topicLink ? "" : "，话题深链缺失已降级为群链接"}）`,
        );
      } catch (err) {
        outcomes.push(`create 失败（本轮跳过，不影响交付）：${String((err as Error).message ?? err)}`);
      }
    }
  }

  // due / blocked act on the claimed task — resolved AFTER create so a fresh
  // guid is targetable in the same turn. Fallback order: this turn's created
  // task → the thread's stored claim → the guid the agent declared alongside
  // (first-claim turn: store not yet written — the handler claims after us).
  const targetGuid =
    patch.due || patch.blocked
      ? createdGuid ?? deps.store.get(patch.threadId)?.taskGuid ?? patch.declaredGuid
      : undefined;

  // ── due (信号3) ───────────────────────────────────────────────────────────
  if (patch.due) {
    if (!targetGuid) {
      outcomes.push("due 声明被忽略：本话题没有已认领/新建的任务");
    } else {
      const due = parseDueInput(patch.due);
      if (!due) {
        outcomes.push(`due "${patch.due}" 无法解析，未改期`);
      } else {
        try {
          await deps.client.patchDue(targetGuid, due);
          const line = `⏰ 截止改为 ${formatDueForComment(due)}${patch.dueReason ? `：${patch.dueReason}` : ""}`;
          await deps.client.addComment(targetGuid, line).catch((err) => {
            console.warn(`[tasklist.declare] due comment failed (due itself applied):`, err);
          });
          outcomes.push(`已改期 ${formatDueForComment(due)}${patch.dueReason ? `（${patch.dueReason}）` : ""}`);
        } catch (err) {
          outcomes.push(`改期失败：${String((err as Error).message ?? err)}`);
        }
      }
    }
  }

  // ── blocked (信号5) ───────────────────────────────────────────────────────
  if (patch.blocked) {
    if (!targetGuid) {
      outcomes.push("blocked 声明被忽略：本话题没有已认领/新建的任务");
    } else {
      try {
        await deps.client.addComment(targetGuid, `🚧 阻塞，需要人处理：${patch.blocked}`);
        outcomes.push("阻塞已落任务评论（关注人将收到通知）");
      } catch (err) {
        outcomes.push(`阻塞评论失败：${String((err as Error).message ?? err)}`);
      }
    }
  }

  return { createdGuid, outcomes };
}
