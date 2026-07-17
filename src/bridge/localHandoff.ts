/**
 * src/bridge/localHandoff.ts
 *
 * Peer-handoff fast path: "local dispatch + Feishu mirror".
 *
 * When an agent's state.json declares `handoffs: [{to, text}]`, the bridge
 *   (a) sends ONE real Feishu post into the thread with a true at tag for the
 *       named peer — the durable, human-visible record (the MIRROR), and
 *   (b) when that peer bot lives in this same bridge process, immediately
 *       pushes the just-sent message onto the peer's inbound queue (the LOCAL
 *       DISPATCH), so waking the peer no longer depends on its WS delivery.
 *
 * The local event carries the mirror post's REAL message_id, so when the same
 * message later arrives over the peer's own WS it is deduped by the peer
 * ChannelClient's existing seen/in-flight bookkeeping (ingestLocalEvent).
 * Either copy may win the race; exactly one turn runs.
 *
 * Invariants (thin channel):
 *   - Mirror first: if the Feishu post fails, we do NOT dispatch locally —
 *     Feishu stays the single source of truth; a handoff that isn't on the
 *     record does not happen.
 *   - The bridge never interprets `text`; it is sent verbatim.
 *   - Local dispatch failure degrades silently to today's behavior (the peer
 *     still gets the message via its own WS).
 */

import type { PeerBot } from "../claude/prompt.js";
import type { LarkMessageEvent } from "../lark/transport.js";
import { safeIdempotencyKey, type OutboundPostClient } from "../lark/outboundPostClient.js";
import { buildPostContent } from "../lark/postContent.js";

// ---------------------------------------------------------------------------
// Registry (wired by main.ts, one per bridge process)
// ---------------------------------------------------------------------------

/** The slice of ChannelClient the registry needs — test seam. */
export interface LocalHandoffInbound {
  ingestLocalEvent(ev: LarkMessageEvent, sourceTag: string): boolean;
}

export interface LocalHandoffTargetInfo {
  /** Internal bot config id (bots/*.yaml `id`). */
  botId: string;
  /** Display name (BotConfig.name) — what agents write in `to`. */
  name: string;
  /** The bot's OWN open_id (its own app scope) — used in the synthesized mention metadata. */
  botOpenId?: string;
}

/**
 * botId → inbound client map for every bot hosted in THIS bridge process.
 * Handler deps hold a reference; main.ts registers bots as it wires them.
 */
export class LocalHandoffRegistry {
  private readonly members = new Map<
    string,
    { info: LocalHandoffTargetInfo; client: LocalHandoffInbound }
  >();

  register(info: LocalHandoffTargetInfo, client: LocalHandoffInbound): void {
    this.members.set(info.botId, { info, client });
  }

  describe(botId: string): LocalHandoffTargetInfo | undefined {
    return this.members.get(botId)?.info;
  }

  /** @returns true when the event was locally dispatched (not deduped/unknown). */
  dispatch(botId: string, ev: LarkMessageEvent, sourceTag: string): boolean {
    const member = this.members.get(botId);
    if (!member) return false;
    try {
      return member.client.ingestLocalEvent(ev, sourceTag);
    } catch (err) {
      console.warn(`[local-handoff] dispatch to "${botId}" failed (WS delivery will cover):`, err);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-turn processing (called by handler.ts at finalize)
// ---------------------------------------------------------------------------

export interface HandoffDeclaration {
  to: string;
  text: string;
}

export interface ProcessHandoffsContext {
  handoffs: HandoffDeclaration[];
  /** This bot's resolved peers — open_ids valid in THIS bot's app scope (for the at tag). */
  peers: PeerBot[];
  /** name → internal config id roster (same source as taskHandleMentionRoster). */
  roster: Array<{ name: string; botId: string }>;
  selfBotId: string;
  postClient?: OutboundPostClient;
  registry?: LocalHandoffRegistry;
  /** Message the mirror post replies to (thread anchor). */
  replyAnchorId: string;
  chatId: string;
  /** Session/topic root — the peer's turn must key into the SAME topic. */
  threadId: string;
  /** Trigger message id — stabilizes the idempotency key across retries. */
  triggerMessageId: string;
  /** Kill switch: when false, mirror posts still go out but nothing is dispatched locally. */
  localDispatchEnabled?: boolean;
}

export interface HandoffOutcome {
  to: string;
  posted: boolean;
  localDispatched: boolean;
  detail: string;
}

function normalizeTarget(s: string): string {
  return s.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Resolve + mirror + locally dispatch every declared handoff. Never throws:
 * each entry resolves to an outcome the caller records as a turn event.
 */
export async function processHandoffs(ctx: ProcessHandoffsContext): Promise<HandoffOutcome[]> {
  const outcomes: HandoffOutcome[] = [];
  for (const [i, declared] of ctx.handoffs.entries()) {
    const wanted = normalizeTarget(declared.to);
    const peer = ctx.peers.find((p) => normalizeTarget(p.name) === wanted);
    const rosterEntry = ctx.roster.find(
      (r) => normalizeTarget(r.name) === wanted || normalizeTarget(r.botId) === wanted,
    );

    // The at tag needs a peer open_id in THIS bot's scope. Without it we can't
    // produce the mirror, and mirror-first means we don't dispatch either.
    if (!peer) {
      outcomes.push({
        to: declared.to,
        posted: false,
        localDispatched: false,
        detail: `未在 <peer-bots> 里找到 "${declared.to}"，此条 handoff 跳过`,
      });
      continue;
    }

    if (!ctx.postClient) {
      outcomes.push({
        to: declared.to,
        posted: false,
        localDispatched: false,
        detail: "postClient 不可用，无法发镜像 post，此条 handoff 跳过",
      });
      continue;
    }

    // (a) MIRROR: one real Feishu post with a true at tag, replying in-thread.
    let mirrorMessageId: string;
    try {
      const content = buildPostContent({
        text: declared.text,
        mentions: [{ userId: peer.id, label: peer.name }],
      });
      const sent = await ctx.postClient.createPostReply(ctx.replyAnchorId, content, {
        replyInThread: true,
        // Hashed: raw `handoff:<om_ id>:<i>:<botId>` sits at ~50 chars — right
        // on Feishu's uuid validation cap (99992402). Same-input stability
        // keeps retry dedup working.
        idempotencyKey: safeIdempotencyKey(
          `handoff:${ctx.triggerMessageId}:${i}:${rosterEntry?.botId ?? wanted}`,
        ),
      });
      mirrorMessageId = sent.messageId;
    } catch (err) {
      outcomes.push({
        to: declared.to,
        posted: false,
        localDispatched: false,
        detail: `镜像 post 发送失败（未做本地直递）: ${String((err as Error).message ?? err)}`,
      });
      continue;
    }

    // (b) LOCAL DISPATCH — only for peers hosted in this bridge process.
    let localDispatched = false;
    let detail = `镜像 post 已发 (message_id=${mirrorMessageId})`;
    const targetInfo = rosterEntry && ctx.registry?.describe(rosterEntry.botId);
    if (ctx.localDispatchEnabled === false) {
      detail += "；本地直递已禁用，走 WS 送达";
    } else if (!rosterEntry || !targetInfo) {
      detail += "；目标不在本 bridge 进程内，走 WS 送达";
    } else {
      const ev: LarkMessageEvent = {
        message_id: mirrorMessageId,
        chat_id: ctx.chatId,
        chat_type: "group",
        thread_id: ctx.threadId,
        root_id: ctx.threadId,
        // Informational marker, mirroring "task_comment" — nothing branches on it.
        larkway_trigger_type: "local_handoff",
        sender_id: ctx.selfBotId,
        // Same shape the target's WS copy would carry: an @_user_N placeholder
        // in the text (stripped by extractText) + mention metadata resolving it.
        mentions: targetInfo.botOpenId
          ? [{ key: "@_user_1", id: { open_id: targetInfo.botOpenId }, name: targetInfo.name }]
          : undefined,
        content: JSON.stringify({ text: `@_user_1 ${declared.text}` }),
        create_time: String(Date.now()),
      };
      localDispatched = ctx.registry!.dispatch(rosterEntry.botId, ev, ctx.selfBotId);
      detail += localDispatched
        ? `；已本地直递给 ${rosterEntry.botId}（WS 副本将被去重）`
        : `；本地直递未生效（去重或目标异常），走 WS 送达`;
    }

    outcomes.push({ to: declared.to, posted: true, localDispatched, detail });
  }
  return outcomes;
}
