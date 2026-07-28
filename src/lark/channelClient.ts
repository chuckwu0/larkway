/**
 * lark/channelClient.ts
 *
 * Channel-SDK-backed inbound transport — the ONLY inbound transport. Receives
 * Feishu events over the official Channel SDK's WebSocket long-conn.
 *
 * Why the SDK (stability):
 *   The previous hand-rolled client wrapped `lark-cli event +subscribe` as a
 *   child process and reimplemented WS reconnect/heartbeat/dedup. Its WS
 *   watchdog misfired on close codes 1006/3003 and called `process.exit(1)`
 *   (overnight self-kills, 2026-05-22). Feishu's official Channel SDK reconnects
 *   unconditionally on WS close — never inspects the close code, never exits the
 *   process (spike 2026-05-29, `ws-client/index.ts:406`). Using the SDK removes
 *   that failure mode entirely + drops the lark-cli subscribe subprocess.
 *
 * Both inbound (events) and outbound (card create/PATCH via outboundCardClient())
 * route through the SAME live channel handle.
 *
 * Interface: exposes exactly what BridgeHandler/main use on InboundClient —
 * `events()`, `acknowledgeMessage()`, `close()` — and emits the same
 * `LarkMessageEvent` shape (reconstructed from the raw event body) so
 * `lark/message.ts` parsing is unchanged.
 */

import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LarkMessageEvent, LarkClientOptions } from "./transport.js";
import { AsyncQueue } from "./transport.js";
import { ChannelCardClient, type OutboundLarkChannel } from "./channelCardClient.js";
import {
  ChannelCardKitClient,
  type OutboundCardKitLarkChannel,
} from "./channelCardKitClient.js";
import { ChannelPostClient, type OutboundPostLarkChannel } from "./channelPostClient.js";
import {
  ChannelCotClient,
  type OutboundCotClient,
  type OutboundCotLarkChannel,
} from "./channelCotClient.js";
import { ChannelMessageLookupClient, type MessageLookupClient } from "./messageLookupClient.js";
import type { OutboundCardClient } from "./outboundCardClient.js";
import type { OutboundPostClient } from "./outboundPostClient.js";

const execFile = promisify(execFileCallback);

/** BL-50: env for this bot's lark-cli subprocesses (private config dir). */
function larkCliEnvFor(configDir: string | undefined): NodeJS.ProcessEnv | undefined {
  return configDir ? { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir } : undefined;
}
const LEARNED_CHATS_LIMIT = 100;
const SEEN_MESSAGES_LIMIT = 1000;
/**
 * Poison-message guard: how many times a single message_id may be (re-)dispatched
 * before we give up on it. With self-heal, a message that fails DETERMINISTICALLY
 * (always throws) would otherwise be re-dispatched on every gap-fill forever. At
 * this cap, markUnhandled promotes it to seen (stops retrying) and logs a clear
 * warning so the drop is visible, not silent.
 */
const MAX_MESSAGE_ATTEMPTS = 5;
/**
 * Buffer added on top of the discovery interval for the non-bootstrap targeted
 * look-back, so a chat first seen between two cycles (up to one interval apart)
 * plus any near-boundary @ is always inside the recovered window — no hole
 * between cycles. (The effective look-back is `interval + this`.)
 */
const OPEN_CHAT_DISCOVERY_LOOKBACK_BUFFER_MS = 30_000;
const OPEN_CHAT_DISCOVERY_BOOTSTRAP_LOOKBACK_MS = 30 * 60 * 1000;
const PROCESSING_REACTION_EMOJI = "Typing";

// ── open-chat discovery storm controls (root cause: multi-bot, chats:[]) ──────
/**
 * Default discovery cadence. Was 60s. Combined with the targeted-gap-fill change
 * (a steady-state cycle pulls history for ZERO already-known chats, not all of
 * them), the periodic history-pull load at steady state drops to ~0 — far more
 * than a constant-factor reduction. The longer cadence additionally lowers the
 * cost of the chats-LIST call itself. We still discover newly-invited groups
 * within one interval (and gap-fill them on first sight). Override via
 * LARKWAY_OPEN_CHAT_DISCOVERY_MS.
 */
// Exported (not just an internal tuning constant) because main.ts's v3.2
// handoff-threshold floor warning (docs/task-handle.md §13) cross-references
// this exact value rather than duplicating the magic number — that warning
// only applies to open-mode bots (allowedChatIds.size === 0), the only case
// this periodic cycle actually runs for (see startOpenChatDiscovery's guard).
export const DEFAULT_OPEN_CHAT_DISCOVERY_MS = 300_000;
/**
 * Per-instance startup jitter (ms) added before the FIRST discovery run and
 * baked into the interval phase, so multiple bots on the same host don't fire
 * their discovery (and the history-pull burst it triggers) in lockstep. Spread
 * is a random fraction of the interval, capped here so even a long interval
 * doesn't delay first discovery by more than ~30s.
 */
const OPEN_CHAT_DISCOVERY_JITTER_CAP_MS = 30_000;
/**
 * Consecutive-failure backoff for discovery. When a discovery cycle throws
 * (e.g. +chat-list / gap-fill撞 TLS timeout under storm), we SKIP cycles with
 * exponential backoff (2^failures, capped) instead of hammering the same failing
 * endpoint every interval — the storm's own feedback loop. Reset to 0 on the
 * first clean cycle.
 */
const OPEN_CHAT_DISCOVERY_MAX_BACKOFF_CYCLES = 8;

// ── gap-fill resilience knobs (root cause B: lark-cli history pull撞 TLS timeout) ──
/**
 * Bounded retries for a single chat's lark-cli history pull. The pull itself can
 *撞上 a transient TLS timeout; failing once used to permanently abandon that
 * chat's window. We retry with exponential backoff before giving up on the chat.
 */
const GAP_FILL_MAX_ATTEMPTS = 3;
/** Base backoff (ms): attempt N waits BASE * 2^(N-1) → ~1s / 2s / 4s. */
const GAP_FILL_BACKOFF_BASE_MS = 1000;
/**
 * Failed-window replay cap (bounded, deletable). We track, PER CHAT, the oldest
 * windowStart whose lark-cli pull still failed after all retries, so a later
 * gapFill that actually pulls that chat extends its look-back to cover it (真正补
 * 回漏的 @). Cap the number of tracked chats so a persistently-broken fleet can't
 * grow this unboundedly.
 */
const UNRESOLVED_WINDOW_MAX_CHATS = 50;
/**
 * Drop unresolved windows older than this — beyond it the @ is unrecoverable from
 * history anyway. This is ALSO the replay look-back ceiling: when replaying an old
 * unresolved window we widen the pull window up to this age (instead of the normal
 * 5-min clamp) so the pull can actually reach back far enough to recover it —
 * otherwise an old window could never be covered and would only ever age out.
 */
const UNRESOLVED_WINDOW_MAX_AGE_MS = 30 * 60 * 1000; // 30 min
/**
 * BL-55 洞 A — reconnect-path gap-fill ceiling. Deliberately far larger than
 * {@link UNRESOLVED_WINDOW_MAX_AGE_MS}: a reconnect pull is ONE-SHOT (once per
 * reconnect), while the unresolved-window replay is RECURRING (every timer
 * cycle) — the flood risk the 30-min cap guards against simply isn't the same
 * shape. The real-world case this exists for: a laptop/mini sleeps for hours,
 * and the SDK only notices the socket is dead on wake, so the 30-min ceiling
 * would silently truncate the recovery to the last half hour.
 *
 * This is a CEILING, not a window: the actual look-back is
 * `now - min(lastDisconnectAt, lastHealthyAt)` (see the "reconnected" handler),
 * which stays small whenever the connection was observed healthy recently. So
 * a flapping-but-alive socket keeps pulling tiny windows; only a genuinely
 * blind stretch widens it.
 */
const RECONNECT_GAP_FILL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
/**
 * BL-55 洞 A — how often we sample the SDK's connection state to refresh
 * {@link ChannelClient.lastHealthyAt}. Cheap and in-process (no network): it
 * only reads the SDK's own status object. Doubles as the sleep detector — a
 * suspended machine doesn't fire timers, so the gap between two samples is
 * itself the evidence that we were blind.
 */
const LIVENESS_SAMPLE_MS = 30_000;
/**
 * BL-55 洞 E — page cap for a single chat's history pull. gapFill used to send
 * ONE `--page-size 50` request per chat with `--sort asc`, so any window
 * holding more than 50 messages yielded the OLDEST 50 — dropping exactly the
 * recent @ the pull existed to recover. Paginating fixes that; this cap keeps
 * a pathological window (busy group × wide reconnect window) from turning into
 * an unbounded pull. Hitting it is logged, never silent.
 */
const GAP_FILL_MAX_PAGES = 10;
/**
 * Untrack a chat after this many CONSECUTIVE gap-fill cycles whose history pull
 * failed with Feishu 230002 ("Bot/User can NOT be out of the chat" — the bot is
 * no longer a member). Such a failure is deterministic: retrying within a cycle
 * and replaying the window across cycles both burn quota (and feed 429 rate
 * limiting) without ever succeeding. A small threshold (not 1) tolerates a
 * mislabeled transient; re-tracking is automatic — any live message from the
 * chat (bot re-invited) re-learns it via noteSeenChat.
 */
const CHAT_ACCESS_GONE_UNTRACK_AFTER = 3;

/**
 * Whether a lark-cli history-pull error is Feishu 230002 — the bot has been
 * removed from the chat. Deterministic (not transient): the pull can never
 * succeed until the bot is re-invited, so callers fail fast instead of
 * retrying/replaying. Matched against the error message and the child
 * process's captured stderr/stdout (lark-cli surfaces the code in either,
 * depending on version).
 */
function isChatAccessGoneError(e: unknown): boolean {
  const parts: string[] = [];
  if (e instanceof Error) parts.push(e.message);
  if (e && typeof e === "object") {
    for (const key of ["stderr", "stdout"] as const) {
      const v = (e as Record<string, unknown>)[key];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.some((s) => s.includes("230002"));
}

// ---------------------------------------------------------------------------
// Minimal structural types for the SDK surface we use.
// (The SDK's aggregated .d.ts is huge; we only need this slice and cast to it.)
// ---------------------------------------------------------------------------

interface ChannelNormalizedMessage {
  messageId?: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  threadId?: string;
  rootId?: string;
  createTime?: number;
  /** Normalized text (markdown + XML-style tags). Used to synthesize lark
   *  content when the raw lark content JSON isn't available. */
  content?: string;
  rawContentType?: string;
  mentions?: unknown;
  /** Raw im.message.receive_v1 event body (present when includeRawInMessage). */
  raw?: unknown;
}

/** Strip @-mention markup (SDK normalized form `<at ...>name</at>` or bare @name)
 *  from synthesized text — message.ts also strips `@_user_N`, but normalized
 *  content uses a different form. */
function stripAtMarkup(s: string): string {
  return s.replace(/<at\b[^>]*>.*?<\/at>/gi, "").replace(/<at\b[^>]*\/>/gi, "").trim();
}

/** Minimal sleep used by the one-shot pre-connect restart grace. Inlined here
 *  (not imported from the deleted lark-cli client). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default pre-connect grace (ms) — one-shot delay before opening the WS so a
 *  stale Feishu long-conn slot from a just-killed bridge releases first. */
const DEFAULT_CONNECT_GRACE_MS = 3000;

/**
 * Resolve the restart-grace delay: ctor option > env LARKWAY_CONNECT_GRACE_MS >
 * default 3000. A value of 0 disables the delay (tests / dry-run). Negative /
 * non-finite values clamp to 0.
 */
function resolveGraceMs(ctorValue: number | undefined): number {
  let raw: number;
  if (ctorValue !== undefined) {
    raw = ctorValue;
  } else {
    const env = process.env["LARKWAY_CONNECT_GRACE_MS"];
    const parsed = env !== undefined ? Number(env) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : DEFAULT_CONNECT_GRACE_MS;
  }
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Exported (round-2 adversarial review fix) so main.ts's v3.2 handoff-
 * threshold floor warning (docs/task-handle.md §13.4) checks against the
 * REAL resolved discovery cadence — main.ts never passes `openChatDiscoveryMs`
 * to the constructor, so `LARKWAY_OPEN_CHAT_DISCOVERY_MS` (a documented,
 * actually-deployed override knob) always takes effect for it. Comparing
 * against the raw `DEFAULT_OPEN_CHAT_DISCOVERY_MS` constant instead would
 * silently mismatch the doc's own stated basis ("部署实际的 gap-fill 周期")
 * whenever that env var is set.
 */
export function resolveOpenChatDiscoveryMs(ctorValue: number | undefined): number {
  let raw: number;
  if (ctorValue !== undefined) {
    raw = ctorValue;
  } else {
    const env = process.env["LARKWAY_OPEN_CHAT_DISCOVERY_MS"];
    const parsed = env !== undefined ? Number(env) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : DEFAULT_OPEN_CHAT_DISCOVERY_MS;
  }
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function safeFilePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function arrayField(obj: unknown, key: string): unknown[] | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function stringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function nonEmptyStringField(obj: unknown, key: string): string | undefined {
  const value = stringField(obj, key);
  return value && value.length > 0 ? value : undefined;
}

function parseLarkCliMessages(stdout: string): unknown[] | null {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) return parsed;
  const directItems = arrayField(parsed, "items");
  if (directItems) return directItems;
  const directMessages = arrayField(parsed, "messages");
  if (directMessages) return directMessages;
  if (parsed && typeof parsed === "object") {
    const data = (parsed as Record<string, unknown>)["data"];
    return arrayField(data, "messages") ?? arrayField(data, "items") ?? arrayField(data, "chats");
  }
  return null;
}

function expandMessagesWithThreadReplies(messages: unknown[]): unknown[] {
  const expanded: unknown[] = [];
  for (const raw of messages) {
    expanded.push(raw);
    if (!raw || typeof raw !== "object") continue;
    const parent = raw as Record<string, unknown>;
    const parentRootId = nonEmptyStringField(parent, "root_id") ?? nonEmptyStringField(parent, "message_id");
    const replies = arrayField(parent, "thread_replies") ?? [];
    for (const replyRaw of replies) {
      if (!replyRaw || typeof replyRaw !== "object") continue;
      const reply = replyRaw as Record<string, unknown>;
      expanded.push({
        ...reply,
        root_id: nonEmptyStringField(reply, "root_id") ?? parentRootId,
      });
    }
  }
  return expanded;
}

/**
 * Resolve the originating thread anchor (omt_… / message id) for a recovered
 * gap-fill item. Feishu's +chat-messages-list items vary by version: some carry
 * an explicit `thread_id`/`root_id`, others only embed the thread in a
 * `message_app_link` query param (`open_thread_id=omt_…`).
 *
 * Deliberately NOT consulted: `parent_id` / `upper_message_id`. Feishu populates
 * `parent_id` for ANY reply, including an ordinary quote-reply that is NOT in a
 * topic thread (no `root_id`, no `open_thread_id`). Consulting them would
 * misclassify such a quote-reply as a `thread_reply` and re-key it to the quoted
 * message — whereas the SAME message over the live WS path
 * ({@link channelMsgToLarkEvent}, which only looks at `thread_id`/`root_id`/
 * `message_id`) is a plain `mention` keyed to its own id. Restricting the chain
 * to `thread_id → root_id → message_app_link(open_thread_id)` aligns gap-fill
 * thread classification with the live path and removes that false positive.
 *
 * Returns null when nothing thread-like is found (caller falls back to message id).
 */
export function resolveRecoveredThreadId(m: Record<string, unknown>): string | null {
  const explicit =
    nonEmptyStringField(m, "thread_id") ??
    nonEmptyStringField(m, "root_id");
  if (explicit) return explicit;
  const link = nonEmptyStringField(m, "message_app_link");
  if (link) {
    const match = link.match(/open_thread_id=(omt_[A-Za-z0-9_-]+)/);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Whether a +chat-messages-list item was sent by the bot itself. Used by the
 * p2p gap-fill dispatch path, which (unlike the group path) has no mentions
 * gate to implicitly exclude the bot's own replies from a recovered window.
 * Handles both sender shapes lark-cli has returned over time: a bare open_id
 * string, and the object form `{ id, id_type, sender_type }` (bot-sent
 * messages carry sender_type "app").
 */
export function isBotSentMessage(m: Record<string, unknown>, botOpenId: string): boolean {
  const sender = m["sender"];
  if (typeof sender === "string") return sender === botOpenId;
  if (sender && typeof sender === "object") {
    const s = sender as Record<string, unknown>;
    if (s["sender_type"] === "app") return true;
    if (typeof s["id"] === "string" && s["id"] === botOpenId) return true;
  }
  return false;
}

/** A card-button click delivered by the SDK (raw `card.action.trigger`). */
export interface ChannelCardAction {
  messageId: string;
  chatId: string;
  operator: { openId: string; userId?: string; name?: string };
  action: { value: unknown; tag: string; name?: string; option?: string };
}

// LarkChannel extends OutboundLarkChannel so the same handle can be bound into
// a ChannelCardClient for outbound card create/patch (see outboundCardClient()).
interface LarkChannel extends OutboundLarkChannel {
  botIdentity?: { openId?: string; name?: string } | null;
  on(event: "message", handler: (msg: ChannelNormalizedMessage) => void): void;
  on(event: "cardAction", handler: (evt: ChannelCardAction) => void): void;
  on(event: "reconnecting" | "reconnected", handler: () => void): void;
  on(event: "error", handler: (err: { code?: string; message?: string }) => void): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * BL-55 洞 A: the SDK's own view of the socket. Sampled on a timer to keep
   * {@link ChannelClient.lastHealthyAt} honest — "connected" here means the
   * transport is up, independent of whether any MESSAGE happened to arrive
   * (an idle-but-healthy bot must not look like a blind window).
   * Optional because the local `LarkChannel` shape is a hand-written subset;
   * present on node-sdk ≥1.64 (verified against 1.67.0 and 1.71.1 types).
   */
  getConnectionStatus?(): { state?: string } | undefined;
}

// ---------------------------------------------------------------------------
// Card-button value → agent-declared choice text
// ---------------------------------------------------------------------------

/**
 * Resolve a card-button `action.value` to the text the agent receives when the
 * button is clicked. Thin-channel: there is NO bridge-side map of button names
 * to intents — the choice LABEL (operator-facing) and VALUE (agent-facing) both
 * come from the AGENT's `state.json.choices`. card.ts renders each button with
 * `behaviors:[{type:"callback", value:{larkway_choice:<value>}}]`, so on a
 * click the SDK hands us back that `value` object and we recover the agent's
 * declared `larkway_choice` string verbatim — which becomes the next turn's
 * text. A bare-string value is tolerated (forward-compat); anything else
 * (non-string / empty / unrecognized object) → null = safe no-op.
 */
function cardActionChoice(value: unknown): string | null {
  // The shape card.ts emits: { larkway_choice: "<agent-declared value>" }.
  if (value && typeof value === "object") {
    const choice = (value as Record<string, unknown>)["larkway_choice"];
    if (typeof choice === "string" && choice.length > 0) return choice;
    return null;
  }
  // Tolerate a bare non-empty string value (forward-compat / hand-rolled cards).
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * Pure synthesis: card-button click → LarkMessageEvent (or null = safe no-op).
 *
 * THREAD SAFETY (critical): the cardAction event carries only the clicked
 * card's messageId — NOT a thread id. The thread is resolved by looking up
 * messageId in `cardThreads` (populated when the card was created). If the
 * thread cannot be resolved (card created before this process started, or by
 * another bot/transport), this returns null so the caller safely no-ops —
 * NEVER routing to a wrong thread. An unmappable action value also returns null.
 *
 * The card's messageId doubles as the synthesized turn's message_id (the click
 * is "from" that card); thread_id/root_id are the resolved originating topic
 * anchor so parseMessage resumes the right session. content is the same lark
 * TEXT JSON shape message.ts parses (see channelMsgToLarkEvent's fallback).
 *
 * The turn text is the AGENT-DECLARED choice value verbatim (recovered from
 * `value.larkway_choice` via {@link cardActionChoice}) — the bridge holds NO
 * map of button names to meanings. The agent makes `value` a self-describing
 * instruction, so the text it gets back IS its own task statement.
 */
export function synthesizeCardActionEvent(
  evt: ChannelCardAction,
  cardThreads: ReadonlyMap<string, string>,
): LarkMessageEvent | null {
  const threadId = cardThreads.get(evt.messageId);
  if (!threadId) return null; // unresolvable thread → safe no-op (never wrong-route)
  const choice = cardActionChoice(evt.action?.value);
  if (choice === null) return null; // unusable action value → no-op
  return {
    message_id: evt.messageId,
    chat_id: evt.chatId,
    chat_type: "group",
    thread_id: threadId,
    root_id: threadId,
    larkway_trigger_type: "card_action",
    sender_id: evt.operator.openId,
    content: JSON.stringify({ text: choice }),
    create_time: String(Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Raw event → LarkMessageEvent (lark-cli-identical shape)
// ---------------------------------------------------------------------------

/**
 * Reconstruct the lark-cli-compatible LarkMessageEvent from the SDK's raw
 * im.message.receive_v1 body, falling back to the SDK's normalized fields.
 * The RAW `message.content` (text/post JSON string) + `mentions` are preserved
 * verbatim so lark/message.ts parses attachments / post text / @ exactly as before.
 */
export function channelMsgToLarkEvent(
  msg: ChannelNormalizedMessage,
  /**
   * 批F (F1) adversarial-review fix: fallback chat_type when neither the raw
   * event nor the SDK-normalized shape carries one (the im/v1/messages LIST
   * item — the gap-fill source — has no chat_type field). deriveSessionKey's
   * sticky branch keys off chat_type === "p2p", and its contract requires a
   * live delivery and its gap-fill replay to derive the SAME session key —
   * so the replayer passes the chat type it learned from live traffic here.
   */
  fallbackChatType?: string,
): LarkMessageEvent | null {
  const raw = msg.raw as
    | { event?: { message?: Record<string, unknown>; sender?: { sender_id?: { open_id?: string } } } }
    | undefined;
  const m = raw?.event?.message;
  const senderOpenId = raw?.event?.sender?.sender_id?.open_id ?? msg.senderId;

  const message_id = (m?.["message_id"] as string) ?? msg.messageId;
  const chat_id = (m?.["chat_id"] as string) ?? msg.chatId;
  if (!message_id || !chat_id || !senderOpenId) return null; // can't route without these

  // thread_id: Feishu's thread (omt_…) when present — kept for logging/parity.
  const thread_id =
    (m?.["thread_id"] as string) ??
    msg.threadId ??
    (m?.["root_id"] as string) ??
    msg.rootId ??
    message_id;

  // root_id: the thread ROOT message id (the first @ that opened the topic).
  // CRITICAL for the worktree/session key: parseMessage derives threadId =
  // root_id ?? message_id. A top-level @ has no root_id (it IS the root → keyed
  // by message_id); an in-thread reply carries root_id pointing back to that
  // first @, so it must resolve to the SAME key. Previously root_id was NOT
  // carried onto the event → every in-thread reply fell through to its OWN
  // message_id → a fresh worktree per turn, fragmenting multi-turn flows
  // (2026-05-30 full-flow E2E: operator's "package=growth" reply spawned a new
  // worktree instead of resuming the build session).
  const root_id = (m?.["root_id"] as string) ?? msg.rootId ?? undefined;

  // parent_id: the directly-quoted message for a QUOTE reply. Real-deployment
  // fact (2026-07-08): the live push omits root_id entirely for quote replies
  // (the GET API has it; the push doesn't) — parent_id (raw) / the SDK's
  // normalized replyToMessageId is the only live signal left. Carried onto
  // the event for the v4 任务派单 root probe; NOT consulted for session keys
  // (see the deliberate exclusion note above resolveThreadIdOf).
  const parent_id =
    (m?.["parent_id"] as string) ??
    (msg as { replyToMessageId?: string }).replyToMessageId ??
    undefined;

  // Content: prefer the RAW lark content JSON (message.ts parses text/post/
  // image_key with full fidelity). When raw isn't in the expected shape, fall
  // back to synthesizing a lark TEXT content from the SDK's normalized `content`
  // (markdown+tags) so the agent still gets the message text. Without this
  // fallback the agent received an EMPTY user-message (E2E 2026-05-29).
  const rawContent = typeof m?.["content"] === "string" ? (m["content"] as string) : undefined;
  const content =
    rawContent ?? JSON.stringify({ text: stripAtMarkup(msg.content ?? "") });

  return {
    message_id,
    chat_id,
    chat_type: (m?.["chat_type"] as string) ?? msg.chatType ?? fallbackChatType ?? "group",
    thread_id,
    root_id,
    parent_id,
    sender_id: senderOpenId,
    mentions: (m?.["mentions"] as LarkMessageEvent["mentions"]) ?? undefined,
    content,
    create_time: (m?.["create_time"] as string) ?? String(msg.createTime ?? Date.now()),
  };
}

// ---------------------------------------------------------------------------
// ChannelClient
// ---------------------------------------------------------------------------

export class ChannelClient {
  private readonly opts: LarkClientOptions;
  private readonly queue = new AsyncQueue<LarkMessageEvent>();
  private channel: LarkChannel | null = null;
  private connected = false;
  private closed = false;
  /** Ensures the one-shot pre-connect restart grace runs at most once even if
   *  connect() is invoked from both events() and main.ts reconcile. */
  private graceApplied = false;
  /**
   * ms epoch when the last "reconnecting" event fired (0 = no reconnect yet).
   * Used by the gap-fill sweep to bound the history window: we pull messages
   * sent after this timestamp so anything that arrived while the WS was
   * rebuilding gets replayed.
   */
  private lastDisconnectAt = 0;
  /**
   * BL-55 洞 A — ms epoch when we last OBSERVED the transport healthy (0 before
   * the first connect).
   *
   * Why this exists: `lastDisconnectAt` records when we NOTICED the socket was
   * down, which can be arbitrarily later than when it actually went blind. The
   * canonical case is machine sleep — the process is frozen, nothing fires, and
   * on wake the SDK reports "reconnecting" for the first time. Gap-filling from
   * that moment pulls ~30s of history and declares the window covered, while
   * every @ sent during the sleep is lost with no trace (no Typing reaction, no
   * log line). Anchoring the pull at the last CONFIRMED-healthy moment closes
   * that hole.
   *
   * Refreshed by the liveness sampler (transport state, not message traffic) so
   * an idle-but-connected bot never looks like a blind window.
   */
  private lastHealthyAt = 0;
  /** Interval handle for the liveness sampler; cleared in {@link close}. */
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Message_ids that have reached a terminal SUCCESS (handler.markHandled) OR
   * were explicitly acknowledged. These are persisted so open-chat recovery
   * does not replay an already-completed message after a restart. gap-fill
   * skips anything in this set.
   *
   * Bounded: we only add completed/acknowledged messages here (not synthetics
   * like cardAction turns), and Feishu message_id space is stable and
   * non-recycling within any reasonable bridge uptime.
   */
  private readonly seenMessageIds = new Set<string>();
  /**
   * Message_ids that have been DISPATCHED (pushed onto the inbound queue) but
   * whose turn has not yet reached a terminal outcome. This is the no-duplicate
   * guard: gap-fill (and the WS path) skip a message that is already in-flight,
   * so a message delivered live is never also gap-filled, and two overlapping
   * gap-fill windows never double-dispatch the same message.
   *
   * CRITICAL (the core self-heal): a message stays here only while its turn is
   * running. handler.markHandled() promotes it into {@link seenMessageIds} on
   * SUCCESS; handler.markUnhandled() REMOVES it on FAILURE so the next gap-fill
   * window re-dispatches it — one transient blip (e.g. a TLS timeout creating
   * the card) no longer swallows the @ forever. NOT persisted: an in-flight
   * message interrupted by a restart SHOULD be re-dispatchable.
   */
  private readonly inFlightMessageIds = new Set<string>();
  /**
   * Per-message (re-)dispatch counter for the poison-message guard. Incremented
   * ONCE per dispatch — every time a message_id is pushed onto the inbound
   * queue (live WS or either gap-fill branch), and nowhere else, so the cap
   * really means "N dispatches". When a turn fails and the count has reached
   * {@link MAX_MESSAGE_ATTEMPTS}, markUnhandled GIVES UP: it promotes the
   * message to seen (so it stops being re-dispatched) and logs a warning.
   * markHandled clears the entry on terminal success. Not persisted:
   * post-restart, an interrupted message starts fresh — same policy as
   * inFlightMessageIds.
   */
  private readonly messageAttempts = new Map<string, number>();
  /**
   * chatId + create_time for every in-flight message, captured at dispatch.
   * Consumed by {@link markUnhandled}: a FAILED turn records an unresolved gap
   * window for its chat so a later replay actually re-pulls (and re-dispatches)
   * it. Without this there is no steady-state trigger for the re-dispatch that
   * markUnhandled promises — chats-mode bots have no discovery timer at all,
   * and open-mode steady-state discovery pulls 0 for already-known chats — so
   * a turn failing before any visible surface existed was silently dropped.
   * Cleared in markHandled / markUnhandled; bounded by the in-flight set.
   */
  private readonly inFlightMessageMeta = new Map<string, { chatId: string; createTimeMs: number }>();
  /**
   * Chats observed from live WS events during this process lifetime.
   *
   * Product semantics: `allowedChatIds=[]` means "respond in any group that @s
   * the bot". The live Channel SDK can do that, but reconnect gap-fill needs a
   * concrete list of chats to pull history from. Auto-learning live chats keeps
   * the thin "open bot" UX while still giving reconnect recovery a bounded
   * search space.
   */
  private readonly recentlySeenChatIds = new Set<string>();
  /**
   * 批F (F1): chat_id → chat_type learned from live deliveries. Gap-fill's
   * source (im/v1/messages list items) carries no chat_type, but the sticky
   * session key derivation needs it — see channelMsgToLarkEvent's
   * fallbackChatType param. In-memory only (bounded by chats served).
   */
  private readonly chatTypesById = new Map<string, string>();
  /**
   * PER-CHAT unresolved gapFill windows: chatId → the OLDEST windowStart (ms) for
   * which that chat's lark-cli history pull still failed after all retries. On a
   * later gapFill that ACTUALLY pulls this chat, we extend the look-back to cover
   * its oldest unresolved windowStart and only clear it once the pull truly
   * reached back that far (its `--start` <= the tracked windowStart). Per-chat (not
   * a single shared list) so a successful run over chat-set {B} can never falsely
   * resolve chat A's window (BLOCKER 1), and the look-back-vs-clamp mismatch can
   * never mark a window resolved before it was reached (BLOCKER 2).
   *
   * Bounded: one timestamp per chat (so naturally bounded by #chats), pruned by age
   * (UNRESOLVED_WINDOW_MAX_AGE_MS — older = unrecoverable from history anyway) and
   * capped at UNRESOLVED_WINDOW_MAX_CHATS tracked chats.
   */
  private readonly unresolvedGapWindowByChat = new Map<string, number>();
  /**
   * chatId → count of CONSECUTIVE gap-fill cycles whose pull failed with
   * 230002 (bot removed from the chat). At {@link CHAT_ACCESS_GONE_UNTRACK_AFTER}
   * the chat is dropped from gap-fill tracking entirely (see
   * {@link noteChatAccessGone}) — the fix for the 2026-07-17 amplifier where a
   * stale chat's unresolved window was replayed (3 retries each) every cycle,
   * forever, burning quota against a deterministic error. Reset by any
   * successful pull of the chat or any live sighting (noteSeenChat).
   */
  private readonly chatAccessGoneCountByChat = new Map<string, number>();
  /**
   * Backoff sleep used by the per-chat history-pull retry. Indirected through a
   * field purely so tests can observe/await the backoff deterministically; in
   * production it is the real timer-based {@link sleep}.
   */
  private gapFillSleep: (ms: number) => Promise<void> = sleep;
  private openChatDiscoveryTimer: NodeJS.Timeout | null = null;
  private openChatDiscoveryRunning = false;
  private openChatDiscoveryBootstrapped = false;
  /**
   * Chats-mode (allowedChatIds non-empty) counterpart of the open-mode
   * discovery cycle's unresolved-window replay: those bots never start
   * discovery, so without this timer a window recorded by markUnhandled had
   * NO trigger to replay it (the only other gapFill source is a WS reconnect,
   * which a healthy network may not produce for days). Steady state with no
   * pending windows does nothing — zero API calls — so the 0.3.28 storm fix
   * is preserved.
   */
  private unresolvedReplayTimer: NodeJS.Timeout | null = null;
  private unresolvedReplayRunning = false;
  /**
   * Consecutive discovery-cycle failures. Used to SKIP cycles with exponential
   * backoff (storm: a failing +chat-list/gap-fill shouldn't re-fire every
   * interval). Reset to 0 on the first clean cycle. {@link openChatDiscoverySkips}
   * counts how many remaining cycles to skip before the next real attempt.
   */
  private openChatDiscoveryFailures = 0;
  private openChatDiscoverySkips = 0;
  /**
   * Per-instance jitter offset (ms) applied to discovery scheduling so multiple
   * bots on one host don't run discovery (and its history-pull burst) in
   * lockstep. Computed once at startup. `Math.random` is fine here — this is
   * runtime scheduling code, not a determinism-sensitive workflow script.
   */
  private openChatDiscoveryJitterMs = Math.floor(
    Math.random() * OPEN_CHAT_DISCOVERY_JITTER_CAP_MS,
  );
  /** Monotonic suffix so overlapping atomic writes get distinct temp files. */
  private atomicWriteSeq = 0;
  private readonly processingReactions = new Map<string, string>();
  /**
   * Shared messageId -> threadId map. Populated by ChannelCardClient.createCard
   * (the thread each card was posted into) and read here on a cardAction click
   * to route the synthesized turn back to the EXACT originating thread. Shared
   * by reference with the ChannelCardClient returned from outboundCardClient().
   */
  private readonly cardThreads = new Map<string, string>();
  /** Lazily built (after connect) so it can bind the live channel handle. */
  private cardClient: ChannelCardClient | null = null;
  /** Lazily built CardKit client; shares cardThreads with interactive callbacks. */
  private cardKitClient: ChannelCardKitClient | null = null;
  /** Lazily built and only requested by main.ts when post outbound gates are configured. */
  private postClient: ChannelPostClient | null = null;
  /** Lazily built COT (思维链) client; only requested when a bot enables cot != off. */
  private cotClient: ChannelCotClient | null = null;
  /** Lazily built single-message lookup client (v4 任务派单 root-type probe). */
  private messageLookupClient: ChannelMessageLookupClient | null = null;

  constructor(opts: LarkClientOptions) {
    if (!opts.appId || !opts.appSecret) {
      throw new Error(
        "[ChannelClient] appId + appSecret are required (Channel SDK uses raw credentials, " +
          "not a lark-cli profile). Set the bot's app_secret_env.",
      );
    }
    this.opts = opts;
  }

  /**
   * TEST SEAM (deletable): override the gap-fill retry backoff sleep so unit
   * tests can observe the backoff durations and avoid real timers. No-op for
   * production — the default is the real {@link sleep}. Returns the recorded
   * backoff arg via the provided callback's own bookkeeping.
   */
  setGapFillSleepForTest(fn: (ms: number) => Promise<void>): void {
    this.gapFillSleep = fn;
  }

  /**
   * TEST SEAM (deletable): override the per-instance open-chat discovery startup
   * jitter so tests can make the FIRST discovery run fire deterministically
   * (jitter=0) instead of waiting up to {@link OPEN_CHAT_DISCOVERY_JITTER_CAP_MS}.
   * Must be called before connect()/startOpenChatDiscovery(). No-op in production.
   */
  setOpenChatDiscoveryJitterForTest(ms: number): void {
    this.openChatDiscoveryJitterMs = Math.max(0, ms);
  }

  /** TEST-ONLY read of the per-chat unresolved-window replay map (chatId → windowStart). */
  unresolvedGapWindowsForTest(): ReadonlyMap<string, number> {
    return new Map(this.unresolvedGapWindowByChat);
  }

  /** TEST-ONLY read of the tracked (gap-fillable) chat id set. */
  trackedChatIdsForTest(): ReadonlySet<string> {
    return new Set(this.recentlySeenChatIds);
  }

  /**
   * Seed gap-fill's tracked-chat set from durable session history
   * (sessions.json), BEFORE connect. Fix for the 2026-07-17 p2p message-loss
   * incident: p2p chats are invisible to bot-side chat-list discovery (the API
   * returns groups only), so once the in-memory tracking state was gone —
   * restart plus a missing/stale runtime cache — a p2p chat could never
   * re-enter the gap-fill list and its messages dropped during a WS outage
   * were lost forever. sessions.json persists the chatId (and, going forward,
   * chatType) of every thread the bot has served, so seeding from it makes a
   * p2p chat permanently gap-fillable once it has ever been seen.
   *
   * Deliberately does NOT persist to the runtime channel-seen-chats cache:
   * this runs before {@link loadRecentlySeenChatIds} merges the cache in, and
   * persisting the (possibly smaller) seed set here would overwrite cached
   * chats learned in previous runs. The union is persisted by the next
   * ordinary noteSeenChat.
   */
  seedTrackedChats(entries: ReadonlyArray<{ chatId: string; chatType?: string }>): void {
    let added = 0;
    for (const { chatId, chatType } of entries) {
      if (!chatId.startsWith("oc_")) continue;
      const before = this.recentlySeenChatIds.size;
      this.recentlySeenChatIds.add(chatId);
      if (this.recentlySeenChatIds.size > before) added++;
      // Session history is authoritative enough for a cold start; a live
      // delivery (noteSeenChat) still overwrites with the freshest type.
      if (chatType && !this.chatTypesById.has(chatId)) {
        this.chatTypesById.set(chatId, chatType);
      }
    }
    if (added > 0) {
      console.log(
        `[channel.client] seeded ${added} chat(s) from session history for gap-fill`,
      );
    }
  }

  /**
   * TEST-ONLY: run exactly ONE open-chat discovery cycle (same code path the
   * interval timer invokes), awaited to completion. Lets tests assert the
   * storm-control behaviour (steady-state no-pull, new-chat pull, failure
   * backoff skip) deterministically without standing up real timers.
   */
  async discoverOpenChatsForTest(): Promise<void> {
    // Wait out any in-flight (e.g. bootstrap) cycle first so the explicit run we
    // want to assert on isn't swallowed by the openChatDiscoveryRunning guard.
    for (let i = 0; i < 200 && this.openChatDiscoveryRunning; i++) {
      await sleep(5);
    }
    await this.discoverOpenChatsAndGapFill((s) => console.log(`[channel.client] ${s}`));
  }

  /**
   * TEST-ONLY direct gapFill invocation with an explicit chat-set override —
   * mirrors exactly how open-chat discovery calls gapFill on a SUBSET of chats.
   * Used to reproduce the cross-chat-set replay isolation (BLOCKER 1) without
   * standing up the full discovery timer.
   */
  async gapFillForTest(disconnectAt: number, chatIds: ReadonlySet<string>): Promise<void> {
    await this.gapFill(disconnectAt, (s) => console.log(`[channel.client] ${s}`), chatIds);
  }

  /**
   * Async iterator over inbound events — interface-compatible with LarkClient.
   * Connects the WS on first call. The SDK's policy gate (requireMention +
   * groupAllowlist) filters to group-@-bot messages in allowed chats, matching
   * the hand-rolled client's filtering.
   */
  async *events(): AsyncIterable<LarkMessageEvent> {
    await this.connect();
    while (!this.closed) {
      const r = await this.queue.next();
      if (r.done) return;
      yield r.value;
    }
  }

  /**
   * Whether the Channel SDK WS is currently connected (read-only view of the
   * internal `connected` flag). Used by main.ts's status-file heartbeat to
   * report ws=true/false so the Web 管理面 can distinguish 🟢 serving (ws up)
   * from 🟡 degraded (bridge alive but WS not连上 / silently deaf). Does NOT
   * touch connection logic — pure accessor.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Idempotently connect the WS. Safe to call before events() — used by main.ts
   * to ensure the outbound Channel SDK transport is ready before boot
   * reconciliation finalizes any orphaned cards (the reconcile PATCH goes
   * through this same channel handle). No-op if already connected/closed.
   */
  async connect(): Promise<void> {
    if (this.closed || this.connected) return;
    // One-shot restart grace: wait once before opening the WS so a stale Feishu
    // long-conn slot from a just-killed bridge releases (root cause is slot
    // contention on restart, NOT heartbeat). Guarded by graceApplied so it runs
    // at most once even if connect() is called from both events() and reconcile.
    if (!this.graceApplied) {
      this.graceApplied = true;
      const graceMs = resolveGraceMs(this.opts.connectGraceMs);
      if (graceMs > 0) {
        console.log(`[channel.client] restart grace: waiting ${graceMs}ms before connect`);
        await sleep(graceMs);
        if (this.closed) return; // closed during the wait → bail
      }
    }
    await this.connectChannel();
  }

  private async connectChannel(): Promise<void> {
    const log = (s: string) => console.log(`[channel.client] ${s}`);
    await this.loadRecentlySeenChatIds(log);
    await this.loadSeenMessageIds(log);
    const policy: { requireMention: true; groupAllowlist?: string[] } = {
      requireMention: true,
    };
    if (this.opts.allowedChatIds.size > 0) {
      policy.groupAllowlist = [...this.opts.allowedChatIds];
    }
    const channel = createLarkChannel({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      // Always require @. Only pass groupAllowlist when the user explicitly
      // narrows chats; an empty chats list is the product's open mode.
      policy,
      // We need the raw event body to reconstruct the lark-cli-shaped content.
      // (`includeRawInMessage` is the deprecated alias for this.)
      includeRawEvent: true,
      // ── WS robustness knobs (node-sdk ≥1.64; all OFF by default) ──────────
      // Abort a handshake that hangs on a stuck DNS/proxy/NAT path so the retry
      // loop can try again, instead of waiting indefinitely. Successful TLS
      // handshakes are tens of ms; 15s is a wide safety margin. KEPT ON: it is
      // the right behaviour (abort + reconnect beats hanging forever).
      //
      // CAVEAT — raw '_WebSocket' 'error' on abort: when this timeout fires the
      // SDK aborts the underlying ws, which emits a RAW 'error' event on the
      // socket. That socket is owned privately inside node-sdk's WSClient
      // (no public `on()`, no accessor for the raw ws — verified against
      // node-sdk 1.67.0 types: WSClient is not an EventEmitter and keeps the
      // `_WebSocket` in a closure), so we CANNOT attach a precise 'error'
      // listener here. With no listener, Node re-throws it as an
      // uncaughtException → it would kill the whole (multi-bot) process.
      //   → That raw error is instead caught by the process-level crash guard
      //     in main.ts (registerCrashGuard: uncaughtException handler that logs
      //     and never exits). The channel-level `channel.on("error", …)` below
      //     is a DIFFERENT, higher-level error and does NOT cover this raw case.
      //   → Residual uncertainty (left for acceptance load-testing): that the
      //     process guard reliably catches this specific raw abort path under
      //     real network flap. If a future node-sdk / @larksuite/channel exposes
      //     the ws or attaches its own listener, prefer that and drop the guard.
      handshakeTimeoutMs: 15_000,
      // HALF-OPEN DETECTION (SECONDS) — keep this on. It terminates a socket that
      // has gone half-open (server stopped responding but never sent a FIN/close),
      // so the SDK's 'close' handler runs the normal reconnect → our gap-fill
      // recovers anything missed during the dead window.
      //
      // This does NOT mis-fire on healthy idle connections. Verified against
      // node-sdk 1.67.0 source (WSClient liveness):
      //   - clearLiveness() is called on EVERY inbound frame (incl. the server's
      //     pong) — a live connection cancels the watchdog within ms, so an
      //     idle-but-healthy socket that still answers the ~120s server ping is
      //     never killed.
      //   - armLiveness() only (re)arms for pingTimeout SECONDS after each ping and
      //     is a NO-OP when pingTimeout is unset → unsetting it removes half-open
      //     detection ENTIRELY (no 'close' event → no reconnect → no gap-fill).
      //     A silently-half-open WS on a KNOWN chat would then drop an @ that
      //     neither reconnect-gap-fill nor the (now targeted) steady-state
      //     discovery — which pulls 0 for already-known chats — could recover.
      //
      // So this stays as the half-open safety net; the discovery-storm fix is
      // orthogonal and SAFE precisely because this net still triggers reconnect.
      wsConfig: { pingTimeout: 60 },
    } as Parameters<typeof createLarkChannel>[0]) as unknown as LarkChannel;

    channel.on("message", (msg) => {
      if (this.closed) return;
      const ev = channelMsgToLarkEvent(msg);
      if (!ev) {
        log(`dropped (unmappable raw): ${JSON.stringify(msg.messageId ?? "?")}`);
        return;
      }
      // 批F (F1): the chat's type is learned from live traffic so gap-fill
      // reconstruction (whose source list items carry no chat_type) derives
      // the same session key a live delivery would. Persisted alongside the
      // learned-chats cache (2026-07-17 p2p fix): gap-fill's p2p dispatch path
      // needs to KNOW a chat is p2p across restarts, before any live traffic.
      this.noteSeenChat(
        ev.chat_id,
        typeof ev.chat_type === "string" && ev.chat_type.length > 0 ? ev.chat_type : undefined,
      );
      // Guard against double-delivery without permanently marking seen: if this
      // message is already handled (seen) or in-flight, skip. Otherwise mark it
      // in-flight so gap-fill won't also deliver it while the turn runs. It is
      // promoted to seen only on terminal SUCCESS (handler.markHandled), so a
      // failed turn stays re-dispatchable.
      if (this.seenMessageIds.has(ev.message_id) || this.inFlightMessageIds.has(ev.message_id)) {
        return;
      }
      this.inFlightMessageIds.add(ev.message_id);
      this.noteInFlightMeta(ev);
      this.noteDispatchAttempt(ev.message_id);
      log(`dispatching (channel-sdk): message_id=${ev.message_id} thread=${ev.thread_id ?? "?"}`);
      this.queue.push(ev);
    });
    // Card-button click → synthesize a normal turn onto the SAME inbound queue.
    channel.on("cardAction", (evt) => {
      if (this.closed) return;
      this.handleCardAction(evt, log);
    });
    // Stability signals — the whole point of the swap. Never exit the process.
    channel.on("reconnecting", () => {
      // Record the disconnect moment so gap-fill knows how far back to look.
      this.lastDisconnectAt = Date.now();
      log(`WS reconnecting… (disconnect recorded at ${new Date(this.lastDisconnectAt).toISOString()})`);
    });
    channel.on("reconnected", () => {
      const now = Date.now();
      const gapMs = this.lastDisconnectAt > 0 ? now - this.lastDisconnectAt : 0;
      log(
        `WS reconnected ✓ (gap ~${gapMs}ms since disconnect at ` +
          `${this.lastDisconnectAt > 0 ? new Date(this.lastDisconnectAt).toISOString() : "unknown"})`,
      );
      // Gap-fill: pull messages sent during the WS outage and replay any that
      // @ this bot but weren't delivered. Runs in background; never throws into
      // the event handler.
      if (this.lastDisconnectAt > 0) {
        // BL-55 洞 A: anchor the pull at the last CONFIRMED-healthy moment, not
        // at the moment we noticed the socket was down. These are the same
        // instant for an ordinary network blip (the sampler ran seconds ago),
        // and differ by hours exactly when it matters — a suspended machine,
        // where `reconnecting` first fires on wake and the naive window covers
        // ~30s of a multi-hour blind stretch.
        const healthyStart =
          this.lastHealthyAt > 0 ? Math.min(this.lastDisconnectAt, this.lastHealthyAt) : this.lastDisconnectAt;
        const blindMs = now - healthyStart;
        // Only worth a line when the two anchors actually diverge (beyond one
        // sampling period of jitter) — that's the sleep/blind-window case.
        if (blindMs > gapMs + LIVENESS_SAMPLE_MS) {
          log(
            `blind window detected: last healthy sample ${new Date(healthyStart).toISOString()} ` +
              `(~${Math.round(blindMs / 1000)}s ago) is older than the recorded disconnect — ` +
              `widening gap-fill look-back accordingly (likely machine sleep/suspend)`,
          );
        }
        void this.gapFill(healthyStart, log, undefined, blindMs, RECONNECT_GAP_FILL_MAX_AGE_MS);
      }
      // The socket is up again — restart the healthy clock from here, AFTER the
      // window above has been computed off the pre-reconnect value.
      this.lastHealthyAt = now;
    });
    channel.on("error", (e) => log(`WS error (non-fatal): ${e?.code ?? ""} ${e?.message ?? ""}`));

    this.channel = channel;
    await channel.connect();
    this.connected = true;
    // BL-55 洞 A: the connect itself is the first confirmed-healthy moment.
    this.lastHealthyAt = Date.now();
    log(`connected as ${channel.botIdentity?.name ?? "?"} (${channel.botIdentity?.openId ?? "?"})`);
    this.startLivenessSampler();
    this.startOpenChatDiscovery(log);
    this.startUnresolvedReplayTimer(log);
  }

  /**
   * Turn a card-button click into a synthesized LarkMessageEvent pushed onto the
   * inbound queue, so handler.ts processes it as an ordinary turn. Delegates the
   * (thread-safety-critical) synthesis to {@link synthesizeCardActionEvent};
   * a null result means safe no-op (unresolvable thread or unmappable value) —
   * we log and do NOT push.
   */
  private handleCardAction(evt: ChannelCardAction, log: (s: string) => void): void {
    const ev = synthesizeCardActionEvent(evt, this.cardThreads);
    if (!ev) {
      log(
        `cardAction dropped (no-op): messageId=${evt.messageId} ` +
          `value=${JSON.stringify(evt.action?.value)} — unresolvable thread or unmappable value`,
      );
      return;
    }
    log(`cardAction → synthesized turn: value=${JSON.stringify(evt.action?.value)} thread=${ev.thread_id ?? "?"}`);
    this.queue.push(ev);
  }

  /**
   * Local-dispatch fast path (peer handoff): push an event that carries a REAL
   * Feishu message_id — one the bridge itself just sent on a sibling bot's
   * behalf — through the SAME dedup bookkeeping as a live WS delivery. The
   * point of going through here instead of {@link enqueueSyntheticEvent}: the
   * real message WILL also arrive over this bot's own WS (it @-mentions this
   * bot), and marking it in-flight now is what makes that later copy a no-op.
   * Ordering is symmetric — if the WS copy somehow wins the race, THIS call
   * becomes the no-op. Either way exactly one turn runs.
   *
   * Failure keeps the existing self-heal semantics: markUnhandled removes the
   * id from in-flight, so gap-fill can re-dispatch the real message later.
   *
   * @returns true when the event was dispatched, false when it was deduped
   *          (already seen/in-flight) or the client is closed.
   */
  ingestLocalEvent(ev: LarkMessageEvent, sourceTag: string): boolean {
    if (this.closed) return false;
    const log = (s: string) => console.log(`[channel.client] ${s}`);
    this.noteSeenChat(
      ev.chat_id,
      typeof ev.chat_type === "string" && ev.chat_type.length > 0 ? ev.chat_type : undefined,
    );
    if (this.seenMessageIds.has(ev.message_id) || this.inFlightMessageIds.has(ev.message_id)) {
      log(`local-dispatch deduped (${sourceTag}): message_id=${ev.message_id}`);
      return false;
    }
    this.inFlightMessageIds.add(ev.message_id);
    this.noteInFlightMeta(ev);
    this.noteDispatchAttempt(ev.message_id);
    log(`dispatching (local-handoff from ${sourceTag}): message_id=${ev.message_id} thread=${ev.thread_id ?? "?"}`);
    this.queue.push(ev);
    return true;
  }

  /**
   * Push an already-built synthetic LarkMessageEvent onto the inbound queue,
   * so handler.ts processes it as an ordinary turn. Same mechanism as
   * {@link handleCardAction}'s cardAction → queue.push, generalized for other
   * bridge-external signal sources — currently only the task-handle comment
   * poller (src/tasklist/commentPoller.ts), which synthesizes a turn from a
   * new Feishu task comment. Public because the poller lives outside this
   * class (main.ts wires it); the caller is fully responsible for building a
   * well-formed event (thread_id/root_id resolved, etc.) — this method does
   * no validation of its own, mirroring handleCardAction's contract.
   */
  enqueueSyntheticEvent(ev: LarkMessageEvent): void {
    this.queue.push(ev);
  }

  /**
   * Return an OutboundCardClient bound to this client's channel handle.
   *
   * Safe to call before connect: the returned client resolves the live channel
   * handle lazily at create/patch CALL time (by which point events() has
   * connected the WS). Wired into CardRenderer by main.ts, so outbound card
   * create/patch go in-process via the SDK and share cardThreads with the
   * cardAction synthesis above.
   */
  outboundCardClient(): OutboundCardClient {
    if (!this.cardClient) {
      this.cardClient = new ChannelCardClient({
        resolveChannel: () => this.channel,
        cardThreads: this.cardThreads,
      });
    }
    return this.cardClient;
  }

  /**
   * Return an OutboundCardKitClient bound to this client's channel handle.
   *
   * CardKit messages share the same messageId -> threadId map as legacy cards,
   * so final-area choice buttons synthesize normal turns in the originating
   * Feishu topic.
   */
  outboundCardKitClient(): ChannelCardKitClient {
    if (!this.cardKitClient) {
      this.cardKitClient = new ChannelCardKitClient({
        resolveChannel: () =>
          this.channel as unknown as OutboundCardKitLarkChannel | null,
        cardThreads: this.cardThreads,
      });
    }
    return this.cardKitClient;
  }

  /**
   * Return an OutboundCotClient bound to this client's channel handle.
   *
   * main.ts only calls this when the bot's `cot` config is not "off". The COT
   * bubble uses the SDK's generic rawClient.request() (tenant token auto-
   * injected via the same token manager as every other outbound call), so it
   * adds no auth surface. Resolves the live channel lazily at call time.
   */
  outboundCotClient(): OutboundCotClient {
    if (!this.cotClient) {
      this.cotClient = new ChannelCotClient({
        resolveChannel: () =>
          this.channel as unknown as OutboundCotLarkChannel | null,
      });
    }
    return this.cotClient;
  }

  /**
   * Return a MessageLookupClient bound to this client's channel handle
   * (docs/task-handle.md §15.4 — the v4 任务派单 root-type probe). Same lazy
   * channel resolution and generic rawClient.request() auth path as the COT
   * client above; strictly best-effort per the client's own contract.
   */
  outboundMessageLookupClient(): MessageLookupClient {
    if (!this.messageLookupClient) {
      this.messageLookupClient = new ChannelMessageLookupClient({
        resolveChannel: () => this.channel as unknown as OutboundCotLarkChannel | null,
      });
    }
    return this.messageLookupClient;
  }

  /**
   * Return an OutboundPostClient bound to this client's channel handle.
   *
   * main.ts only calls this when the per-bot response-surface config explicitly
   * enables post outbound behind an allowlist. The returned client still resolves
   * the live channel lazily at send time, so default production bots never create
   * or inject a real post client.
   */
  outboundPostClient(): OutboundPostClient {
    if (!this.postClient) {
      this.postClient = new ChannelPostClient({
        resolveChannel: () => this.channel as unknown as OutboundPostLarkChannel | null,
      });
    }
    return this.postClient;
  }

  /**
   * Gap-fill: after a WS reconnect, pull recent history from each allowed chat
   * and dispatch any @-bot messages that arrived during the reconnect window but
   * weren't delivered over the live WS. Deduplicates against seenMessageIds so
   * messages already delivered live are never double-dispatched.
   *
   * Why this is safe to retry:
   *   - We only push each message_id once (seenMessageIds gate).
   *   - We only pull a short window (gapMs + 30 s buffer) to limit chatter.
   *   - lark-cli bot identity has access to the group messages list (same as
   *     the WS subscription scope).
   *   - Failures are logged + swallowed; a missed gap-fill is better than a
   *     crash or a flood of repeated dispatches.
   *
   * Limitations / TODO:
   *   - We only look at messages that mention this bot's openId in the `mentions`
   *     array. If Feishu's chat-messages-list omits mentions metadata in some
   *     SDK versions this could miss messages. A future improvement: also match
   *     on content containing the bot name if mentions are absent.
   *   - The history window is bounded at MAX_GAP_FILL_WINDOW_MS (5 min). A
   *     reconnect gap longer than that could still leave some messages missed.
   *   - lark-cli must be configured with a profile that can list group messages
   *     for reconnect recovery. If larkCliProfile is unset we use the default
   *     profile. Reactions are intentionally skipped because gap-fill only needs
   *     message IDs and mentions.
   */
  private async gapFill(
    disconnectAt: number,
    log: (s: string) => void,
    chatIdsOverride?: ReadonlySet<string>,
    minWindowMs?: number,
    /**
     * BL-55 洞 A — absolute ceiling on how far back this run may reach. Defaults
     * to the recurring-replay cap; the reconnect path passes the (much larger)
     * {@link RECONNECT_GAP_FILL_MAX_AGE_MS} because it fires once per reconnect
     * rather than on every timer tick. See that constant for why the two paths
     * legitimately differ.
     */
    maxAgeMs: number = UNRESOLVED_WINDOW_MAX_AGE_MS,
  ): Promise<void> {
    // Normal clamp ceiling. `minWindowMs` (used by periodic discovery) raises it
    // so a requested look-back of "discovery interval + buffer" isn't truncated
    // below the interval — otherwise a chat first seen BETWEEN two cycles (up to
    // `interval` apart) whose @ was also dropped live would fall outside the
    // window and never be recovered. Bounded by `maxAgeMs` either way.
    const MAX_GAP_FILL_WINDOW_MS = Math.min(
      Math.max(5 * 60 * 1000, minWindowMs ?? 0), // ≥5 minutes, or the caller's floor
      maxAgeMs,
    );
    const BUFFER_MS = 30_000; // 30 s overlap to catch near-boundary messages
    const now = Date.now();
    const larkCli = this.opts.larkCliPath ?? "lark-cli";
    const profileArgs = this.opts.larkCliProfile ? ["--profile", this.opts.larkCliProfile] : [];
    const botOpenId = this.opts.botOpenId;

    let totalFetched = 0;
    let totalDispatched = 0;

    const gapFillChatIds = chatIdsOverride
      ? new Set(chatIdsOverride)
      : new Set([
          ...this.opts.allowedChatIds,
          ...this.recentlySeenChatIds,
        ]);

    // Prune stale per-chat unresolved windows BEFORE we read them for look-back.
    this.pruneUnresolvedGapWindows(now);

    // Extend this run's look-back ONLY to cover the oldest unresolved window of a
    // chat we are ACTUALLY pulling this run (BLOCKER 1: never widen for a chat
    // outside gapFillChatIds, so we also never falsely clear it later). When
    // replaying such an old window, widen the clamp ceiling to the replay max age
    // so the pull truly reaches back far enough (BLOCKER 2: no clamp-vs-clear
    // mismatch — we only clear what `--start` actually covered).
    let oldestRelevantUnresolved = Infinity;
    for (const chatId of gapFillChatIds) {
      const ws = this.unresolvedGapWindowByChat.get(chatId);
      if (ws !== undefined && ws < oldestRelevantUnresolved) oldestRelevantUnresolved = ws;
    }
    const hasReplay = oldestRelevantUnresolved !== Infinity;
    const lookBackFrom = Math.min(disconnectAt, hasReplay ? oldestRelevantUnresolved : disconnectAt);
    // Normal runs clamp at 5 min to avoid flooding; replay runs widen the ceiling
    // to `maxAgeMs` so an old unresolved window can actually be reached.
    const clampCeilingMs = hasReplay ? maxAgeMs : MAX_GAP_FILL_WINDOW_MS;
    const windowStart = Math.max(lookBackFrom - BUFFER_MS, now - clampCeilingMs);
    const startIso = new Date(windowStart).toISOString();
    const endIso = new Date(now + BUFFER_MS).toISOString();

    if (gapFillChatIds.size === 0) {
      log(
        `gap-fill skipped: no known chats for window=${startIso}..${endIso} ` +
          `(allowedChatIds is empty and no live chat has been seen yet)`,
      );
      return;
    }

    let anyChatFailed = false;
    for (const chatId of gapFillChatIds) {
      if (this.closed) break;
      try {
        // BL-55 洞 E: PAGINATE. This used to be a single `--page-size 50` call.
        // Combined with `--sort asc` that silently kept the OLDEST 50 messages
        // of the window and discarded the rest — i.e. exactly the recent @ this
        // pull exists to recover, whenever a chat had >50 messages in the
        // window. Widening the window (洞 A) makes that far more likely to bite,
        // so the two fixes ship together.
        const messages: unknown[] = [];
        let pageToken = "";
        let pagesPulled = 0;
        let truncated = false;
        for (let page = 0; page < GAP_FILL_MAX_PAGES; page++) {
          if (this.closed) break;
          const args = [
            "im",
            "+chat-messages-list",
            "--as", "bot",
            "--chat-id", chatId,
            "--start", startIso,
            "--end", endIso,
            "--sort", "asc",
            "--page-size", "50",
            "--format", "json",
            "--no-reactions",
            ...profileArgs,
          ];
          if (pageToken) args.push("--page-token", pageToken);
          // Bounded retry + exponential backoff: the history pull itself can撞上 a
          // transient TLS timeout. Retrying turns a one-off blip into a recovered
          // window instead of a permanently-dropped @ (root cause B).
          const { stdout } = await this.execWithRetry(larkCli, args, chatId, log);
          pagesPulled++;

          let pageMessages: unknown[];
          try {
            // lark-cli versions have returned all of these envelopes over time:
            //   [ ... ], { items: [...] }, { messages: [...] }, { data: { messages: [...] } }.
            // Treat unknown-but-valid shapes as empty, but keep JSON parse errors visible.
            pageMessages = parseLarkCliMessages(stdout) ?? [];
          } catch {
            log(`gap-fill: failed to parse lark-cli output for chat ${chatId} (page ${page + 1})`);
            break; // keep whatever earlier pages yielded rather than dropping the chat
          }
          messages.push(...pageMessages);

          // Envelope shapes vary the same way the message list does — read
          // has_more/page_token from `data` first, then the top level (mirrors
          // discoverOpenChatsAndGapFill).
          let hasMore = false;
          let nextToken = "";
          try {
            const parsed = JSON.parse(stdout) as unknown;
            const data =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["data"] : undefined;
            hasMore = Boolean(
              (data && typeof data === "object" && (data as Record<string, unknown>)["has_more"]) ??
                (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)["has_more"]),
            );
            nextToken = stringField(data, "page_token") ?? stringField(parsed, "page_token") ?? "";
          } catch {
            /* unparseable envelope → treat as last page; pageMessages already banked */
          }
          if (!hasMore || !nextToken) break;
          if (page === GAP_FILL_MAX_PAGES - 1) truncated = true;
          pageToken = nextToken;
        }
        if (truncated) {
          // Never silent: a capped pull means we may NOT have recovered
          // everything in the window, which is precisely the failure mode 洞 E
          // is about.
          log(
            `gap-fill: chat ${chatId} hit the ${GAP_FILL_MAX_PAGES}-page cap ` +
              `(${messages.length} message(s) pulled) — window may be incompletely covered`,
          );
        } else if (pagesPulled > 1) {
          log(`gap-fill: chat ${chatId} pulled ${pagesPulled} pages (${messages.length} message(s))`);
        }

        const messagesWithReplies = expandMessagesWithThreadReplies(messages);
        totalFetched += messagesWithReplies.length;

        for (const raw of messagesWithReplies) {
          if (this.closed) break;
          const m = raw as Record<string, unknown>;
          const messageId = m["message_id"] as string | undefined;
          if (!messageId) continue;
          // Skip already-handled (terminal success) OR currently in-flight
          // (dispatched live or by an overlapping gap-fill window). Same two-set
          // guard as the WS path — a failed turn is removed from inFlight by
          // handler.markUnhandled, so it becomes re-dispatchable here.
          if (this.seenMessageIds.has(messageId) || this.inFlightMessageIds.has(messageId)) continue;

          // Dispatch gate. Groups: only messages that @ this bot. p2p chats
          // (2026-07-17 message-loss fix): p2p messages carry NO mentions at
          // all, so the mentions gate silently dropped every p2p message from
          // a recovered window — a p2p @ lost during a WS outage was
          // unrecoverable. For a chat KNOWN to be p2p (live-learned, or
          // persisted/seeded across restarts) we instead dispatch every human
          // message and skip only the bot's own replies (also present in the
          // pulled history). An unknown-type chat keeps the mentions gate —
          // same safe behavior as before.
          const isP2pChat = this.chatTypesById.get(chatId) === "p2p";
          if (isP2pChat) {
            if (isBotSentMessage(m, botOpenId)) continue;
          } else {
            const mentions = m["mentions"] as Array<{ id?: string | { open_id?: string } }> | undefined;
            const mentionsBot = Array.isArray(mentions) && mentions.some(
              (mn) => {
                if (typeof mn?.id === "string") return mn.id === botOpenId;
                return mn?.id?.open_id === botOpenId;
              },
            );
            if (!mentionsBot) continue;
          }

          // Resolve the REAL originating thread for a recovered thread-reply.
          // +chat-messages-list items don't always carry root_id directly; the
          // thread may only live in message_app_link (open_thread_id=omt_…).
          // When we recover a real thread anchor that differs from the message's
          // own id, inject it as root_id so (a) channelMsgToLarkEvent derives the
          // right thread_id and (b) handler.ts's triggerType comes out
          // "thread_reply" (it keys off parsed.raw.root_id). A true top-level @
          // resolves to null → root_id stays unset → triggerType "mention".
          const recoveredThread = resolveRecoveredThreadId(m);
          const isThreadReply =
            recoveredThread !== null && recoveredThread !== messageId;
          if (isThreadReply && !nonEmptyStringField(m, "root_id")) {
            m["root_id"] = recoveredThread;
          }

          // Reconstruct a LarkMessageEvent from the raw lark-cli list item.
          // lark-cli +chat-messages-list returns items in the same shape as
          // im.message.receive_v1 → channelMsgToLarkEvent can parse them via
          // its raw fallback path.
          const ev = channelMsgToLarkEvent(
            {
              raw: {
                event: {
                  message: m,
                  sender: { sender_id: { open_id: m["sender"] as string | undefined } },
                },
              },
            },
            // 批F (F1): list items carry no chat_type — use the type learned
            // from this chat's live traffic so sticky-key derivation agrees.
            this.chatTypesById.get((m["chat_id"] as string | undefined) ?? ""),
          );
          if (!ev) {
            // Fall back to direct field mapping from the list item shape.
            const fallbackEv: LarkMessageEvent | null = (() => {
              const mid = messageId;
              const cid = m["chat_id"] as string | undefined;
              const sid = (m["sender"] as Record<string, unknown> | undefined)?.["id"] as string | undefined
                ?? (m["sender_id"] as string | undefined);
              if (!mid || !cid || !sid) return null;
              return {
                message_id: mid,
                chat_id: cid,
                // 批F (F1): same live-learned fallback as the primary path.
                chat_type:
                  (m["chat_type"] as string | undefined) ??
                  this.chatTypesById.get(cid) ??
                  "group",
                thread_id:
                  (m["thread_id"] as string | undefined) ??
                  (isThreadReply ? recoveredThread ?? undefined : undefined) ??
                  (m["root_id"] as string | undefined) ??
                  mid,
                root_id:
                  (m["root_id"] as string | undefined) ??
                  (isThreadReply ? recoveredThread ?? undefined : undefined),
                sender_id: sid,
                content: typeof m["content"] === "string" ? m["content"] : JSON.stringify({ text: "" }),
                create_time: (m["create_time"] as string | undefined) ?? String(Date.now()),
              };
            })();
            if (!fallbackEv) continue;
            // Mark in-flight (NOT seen): the turn hasn't run yet. Promotion to
            // seen happens on terminal success (handler.markHandled); a failed
            // turn is released (handler.markUnhandled) and re-dispatchable.
            this.inFlightMessageIds.add(fallbackEv.message_id);
            this.noteInFlightMeta(fallbackEv);
            this.noteDispatchAttempt(fallbackEv.message_id);
            log(`gap-fill dispatching (fallback): message_id=${fallbackEv.message_id} chat=${chatId}`);
            this.queue.push(fallbackEv);
            totalDispatched++;
            continue;
          }

          // Mark in-flight (NOT seen): see fallback branch above.
          this.inFlightMessageIds.add(ev.message_id);
          this.noteInFlightMeta(ev);
          this.noteDispatchAttempt(ev.message_id);
          log(`gap-fill dispatching: message_id=${ev.message_id} thread=${ev.thread_id ?? "?"} chat=${chatId}`);
          this.queue.push(ev);
          totalDispatched++;
        }
        // PER-CHAT resolve (success path): this chat's pull succeeded. Clear its
        // unresolved window ONLY if THIS run's `--start` actually reached back to
        // (i.e. <=) the tracked windowStart (BLOCKER 2). If the clamp kept
        // windowStart NEWER than the tracked window, the old window wasn't really
        // covered — keep it queued for a later, wider replay.
        this.resolveUnresolvedGapWindow(chatId, windowStart);
        this.chatAccessGoneCountByChat.delete(chatId);
      } catch (e) {
        if (isChatAccessGoneError(e)) {
          // Deterministic access failure (bot removed from the chat): queuing
          // an unresolved window would replay it forever against the same
          // error — strike the chat toward untracking instead.
          this.noteChatAccessGone(chatId, log);
          continue;
        }
        // All retries for this chat exhausted → record THIS chat's window so a
        // later gapFill that pulls it widens the look-back (BLOCKER 1: per-chat —
        // another chat's success can't clear this).
        anyChatFailed = true;
        this.recordUnresolvedGapWindow(chatId, windowStart, log);
        log(
          `gap-fill: lark-cli failed for chat ${chatId} after ${GAP_FILL_MAX_ATTEMPTS} attempt(s): ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    log(
      `gap-fill complete: window=${startIso}..${endIso}, ` +
        `fetched=${totalFetched}, dispatched=${totalDispatched}` +
        (anyChatFailed ? ` (some chats failed — per-chat windows queued for replay)` : ``),
    );
  }

  /**
   * Run a lark-cli history pull with bounded retries + exponential backoff.
   * Retries on ANY thrown error (transient TLS timeout being the motivating case),
   * up to {@link GAP_FILL_MAX_ATTEMPTS}. Backoff is GAP_FILL_BACKOFF_BASE_MS *
   * 2^(attempt-1) (~1s / 2s). Re-throws the last error if all attempts fail so the
   * caller can flag the window for replay. Backoff goes through {@link gapFillSleep}
   * (injectable) so tests can observe it deterministically.
   */
  private async execWithRetry(
    larkCli: string,
    args: string[],
    chatId: string,
    log: (s: string) => void,
  ): Promise<{ stdout: string; stderr: string }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= GAP_FILL_MAX_ATTEMPTS; attempt++) {
      if (this.closed) throw lastErr ?? new Error("closed");
      try {
        {
          // BL-50: only pass an options arg in isolated mode — the 2-arg call
          // shape is a stable seam several test mocks rely on.
          const isoEnv = larkCliEnvFor(this.opts.larkCliConfigDir);
          return isoEnv ? await execFile(larkCli, args, { env: isoEnv }) : await execFile(larkCli, args);
        }
      } catch (e) {
        lastErr = e;
        // 230002 is deterministic (bot removed from the chat) — in-cycle
        // retries can never succeed; fail fast and let the caller strike it.
        if (isChatAccessGoneError(e)) throw e;
        if (attempt < GAP_FILL_MAX_ATTEMPTS) {
          const backoffMs = GAP_FILL_BACKOFF_BASE_MS * 2 ** (attempt - 1);
          log(
            `gap-fill: lark-cli pull failed for chat ${chatId} ` +
              `(attempt ${attempt}/${GAP_FILL_MAX_ATTEMPTS}) — retrying in ${backoffMs}ms: ` +
              (e instanceof Error ? e.message : String(e)),
          );
          await this.gapFillSleep(backoffMs);
        }
      }
    }
    throw lastErr;
  }

  /** Drop per-chat unresolved windows older than the replay max age (unrecoverable). */
  private pruneUnresolvedGapWindows(now: number): void {
    const cutoff = now - UNRESOLVED_WINDOW_MAX_AGE_MS;
    for (const [chatId, windowStart] of this.unresolvedGapWindowByChat) {
      if (windowStart < cutoff) this.unresolvedGapWindowByChat.delete(chatId);
    }
  }

  /**
   * Record (or keep the OLDEST) unresolved window for a chat whose pull failed.
   * Bounded by chat count: if the map is at capacity and this is a new chat, we
   * evict the chat with the NEWEST window (least at risk of aging out) so the
   * oldest at-risk windows survive to be replayed first.
   */
  private recordUnresolvedGapWindow(chatId: string, windowStart: number, log: (s: string) => void): void {
    const existing = this.unresolvedGapWindowByChat.get(chatId);
    if (existing !== undefined && existing <= windowStart) return; // already tracking an older window
    if (existing === undefined && this.unresolvedGapWindowByChat.size >= UNRESOLVED_WINDOW_MAX_CHATS) {
      let newestChat: string | null = null;
      let newestWs = -Infinity;
      for (const [c, ws] of this.unresolvedGapWindowByChat) {
        if (ws > newestWs) { newestWs = ws; newestChat = c; }
      }
      if (newestChat !== null && newestWs > windowStart) this.unresolvedGapWindowByChat.delete(newestChat);
      else if (newestChat !== null) return; // all tracked windows are older — keep them, drop this one
    }
    this.unresolvedGapWindowByChat.set(chatId, windowStart);
    log(
      `gap-fill: queued unresolved window for chat ${chatId} ` +
        `start=${new Date(windowStart).toISOString()} (tracked chats=${this.unresolvedGapWindowByChat.size})`,
    );
  }

  /**
   * Resolve a chat's unresolved window on a SUCCESSFUL pull — but ONLY if this
   * run's `coveredFrom` (its lark-cli `--start`) actually reached back to at or
   * before the tracked windowStart. If the clamp kept `coveredFrom` NEWER than the
   * tracked window, the old window was NOT really covered → keep it queued so a
   * later, wider replay can reach it (BLOCKER 2).
   */
  private resolveUnresolvedGapWindow(chatId: string, coveredFrom: number): void {
    const tracked = this.unresolvedGapWindowByChat.get(chatId);
    if (tracked === undefined) return;
    if (coveredFrom <= tracked) this.unresolvedGapWindowByChat.delete(chatId);
  }

  /**
   * A gap-fill cycle hit 230002 for this chat (bot removed from it). Drop any
   * queued unresolved window IMMEDIATELY — replaying it burns quota against a
   * deterministic error (the 2026-07-17 amplifier) — and count a strike; at
   * {@link CHAT_ACCESS_GONE_UNTRACK_AFTER} consecutive strikes, untrack the
   * chat entirely so no future cycle pulls it. Self-healing: if the bot is
   * re-invited, the next live message (or discovery listing) re-tracks the
   * chat via {@link noteSeenChat}, which also resets the strikes.
   */
  private noteChatAccessGone(chatId: string, log: (s: string) => void): void {
    this.unresolvedGapWindowByChat.delete(chatId);
    const strikes = (this.chatAccessGoneCountByChat.get(chatId) ?? 0) + 1;
    if (strikes < CHAT_ACCESS_GONE_UNTRACK_AFTER) {
      this.chatAccessGoneCountByChat.set(chatId, strikes);
      log(
        `gap-fill: chat ${chatId} inaccessible (230002 — bot not in chat), ` +
          `strike ${strikes}/${CHAT_ACCESS_GONE_UNTRACK_AFTER}`,
      );
      return;
    }
    this.chatAccessGoneCountByChat.delete(chatId);
    const wasTracked = this.recentlySeenChatIds.delete(chatId);
    this.chatTypesById.delete(chatId);
    if (wasTracked) void this.persistRecentlySeenChatIds();
    log(
      `gap-fill: chat ${chatId} untracked after ${CHAT_ACCESS_GONE_UNTRACK_AFTER} ` +
        `consecutive inaccessible cycles (bot removed from chat?) — ` +
        `re-tracks automatically on the next live message`,
    );
  }

  /**
   * BL-55 洞 A — keep {@link lastHealthyAt} honest.
   *
   * Samples the SDK's own connection state (no network, no API call) and
   * advances the healthy clock only while the transport reports "connected".
   * Two properties this buys, both load-bearing for the reconnect gap-fill
   * window:
   *   - an IDLE but connected bot keeps its clock current, so a later reconnect
   *     pulls a small window instead of hours of history it doesn't need;
   *   - a SUSPENDED machine stops ticking entirely, so the clock freezes at the
   *     pre-sleep moment and the post-wake pull reaches back across the sleep.
   *
   * Deliberately does NOT force a reconnect when it sees a non-connected state
   * — that's BL-55 洞 B (self-hosted keepalive), kept as a separate change so
   * this one stays reviewable as "window arithmetic only".
   */
  private startLivenessSampler(): void {
    if (this.livenessTimer) return;
    const timer = setInterval(() => {
      if (this.closed) return;
      let state: string | undefined;
      try {
        state = this.channel?.getConnectionStatus?.()?.state;
      } catch {
        return; // never let a diagnostic read break the client
      }
      if (state === "connected") this.lastHealthyAt = Date.now();
    }, LIVENESS_SAMPLE_MS);
    timer.unref?.();
    this.livenessTimer = timer;
  }

  /**
   * Chats-mode replay loop (see {@link unresolvedReplayTimer}): every discovery
   * interval, IF any unresolved gap window is pending, gapFill exactly those
   * chats. Open-mode bots don't need this — their discovery cycle already
   * includes unresolved-window chats in its target set.
   */
  private startUnresolvedReplayTimer(log: (s: string) => void): void {
    if (this.opts.allowedChatIds.size === 0) return; // open mode: discovery covers replay
    if (this.unresolvedReplayTimer) return;
    const intervalMs = resolveOpenChatDiscoveryMs(this.opts.openChatDiscoveryMs);
    if (intervalMs <= 0) return;
    this.unresolvedReplayTimer = setInterval(() => {
      void this.replayUnresolvedWindows(log);
    }, intervalMs);
    this.unresolvedReplayTimer.unref?.();
  }

  private async replayUnresolvedWindows(log: (s: string) => void): Promise<void> {
    if (this.closed || this.unresolvedReplayRunning) return;
    this.pruneUnresolvedGapWindows(Date.now());
    if (this.unresolvedGapWindowByChat.size === 0) return; // steady state: no API calls
    this.unresolvedReplayRunning = true;
    try {
      const chats = new Set(this.unresolvedGapWindowByChat.keys());
      log(`unresolved-window replay: re-pulling ${chats.size} chat(s)`);
      await this.gapFill(Date.now(), log, chats);
    } catch (e) {
      log(`unresolved-window replay failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.unresolvedReplayRunning = false;
    }
  }

  private startOpenChatDiscovery(log: (s: string) => void): void {
    if (this.opts.allowedChatIds.size > 0) return;
    if (this.openChatDiscoveryTimer) return;
    const intervalMs = resolveOpenChatDiscoveryMs(this.opts.openChatDiscoveryMs);
    if (intervalMs <= 0) return;

    // Per-instance jitter on the FIRST run so a fleet of bots booting together
    // doesn't fire their cold-start chat-list + history-pull burst in lockstep.
    // (Subsequent runs are naturally spread because each bot's interval phase is
    // offset by when its jittered first run landed.) Jitter is clamped to the
    // interval so a small override interval can't be pushed past its own period.
    const firstDelay = Math.min(this.openChatDiscoveryJitterMs, intervalMs);
    const startTimer = setTimeout(() => {
      void this.discoverOpenChatsAndGapFill(log);
      this.openChatDiscoveryTimer = setInterval(() => {
        void this.discoverOpenChatsAndGapFill(log);
      }, intervalMs);
      this.openChatDiscoveryTimer.unref?.();
    }, firstDelay);
    startTimer.unref?.();
    // Park the startup timer in the same handle close() clears, so a close()
    // before the first run still cancels it (and start() stays idempotent).
    this.openChatDiscoveryTimer = startTimer;
  }

  private async discoverOpenChatsAndGapFill(log: (s: string) => void): Promise<void> {
    if (this.closed || this.openChatDiscoveryRunning) return;
    // Consecutive-failure backoff: skip this cycle if we're still backing off
    // from a prior failure, so a failing endpoint isn't hammered every interval.
    if (this.openChatDiscoverySkips > 0) {
      this.openChatDiscoverySkips--;
      return;
    }
    this.openChatDiscoveryRunning = true;
    try {
      const larkCli = this.opts.larkCliPath ?? "lark-cli";
      const profileArgs = this.opts.larkCliProfile ? ["--profile", this.opts.larkCliProfile] : [];
      let pageToken = "";
      let fetched = 0;
      let newlyLearned = 0;
      const discoveredChatIds = new Set<string>();
      // Chats genuinely seen for the FIRST time this cycle (not already known).
      // Only these need a fresh catch-up pull on a steady-state cycle.
      const newChatIds = new Set<string>();

      for (let page = 0; page < 10 && !this.closed; page++) {
        const args = [
          "im",
          "+chat-list",
          "--as", "bot",
          "--page-size", "100",
          "--format", "json",
          ...profileArgs,
        ];
        if (pageToken) args.push("--page-token", pageToken);

        const isoEnv = larkCliEnvFor(this.opts.larkCliConfigDir);
      const { stdout } = isoEnv
        ? await execFile(larkCli, args, { env: isoEnv })
        : await execFile(larkCli, args);
        const parsed = JSON.parse(stdout) as unknown;
        const chats = parseLarkCliMessages(stdout) ?? [];
        fetched += chats.length;
        for (const raw of chats) {
          const chatId = stringField(raw, "chat_id");
          if (!chatId?.startsWith("oc_")) continue;
          discoveredChatIds.add(chatId);
          const before = this.recentlySeenChatIds.size;
          this.noteSeenChat(chatId);
          if (this.recentlySeenChatIds.size > before) {
            newlyLearned++;
            newChatIds.add(chatId);
          }
        }

        const data = parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)["data"]
          : undefined;
        const hasMore = Boolean(
          (data && typeof data === "object" && (data as Record<string, unknown>)["has_more"]) ??
          (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)["has_more"]),
        );
        pageToken =
          stringField(data, "page_token") ??
          stringField(parsed, "page_token") ??
          "";
        if (!hasMore || !pageToken) break;
      }

      if (newlyLearned > 0) {
        log(
          `open-chat discovery: learned ${newlyLearned} new chat(s) ` +
            `(known=${this.recentlySeenChatIds.size}, fetched=${fetched})`,
        );
      }

      // Decide which chats actually need a history pull THIS cycle.
      //
      // STORM FIX: previously every cycle gap-filled EVERY discovered chat — at
      // 60s × N bots × M chats that hammered Feishu's auth endpoint into TLS
      // timeouts. gap-fill's real job is "catch up a window we might have
      // missed", which only applies to:
      //   1. the BOOTSTRAP (first) cycle — cold start, pull all known chats once.
      //   2. a chat seen for the FIRST time this cycle — a newly-invited group we
      //      haven't pulled yet (preserves "newly-discovered groups work").
      //   3. a chat with a PENDING unresolved gap window — a prior pull failed and
      //      is queued for replay (preserves failed-window recovery).
      // A steady-state cycle with no new chats and no pending windows pulls
      // NOTHING — collapsing the periodic storm to ~0. Reconnect-driven gap-fill
      // (the `reconnected` handler) is untouched and still covers real outages.
      const isBootstrap = !this.openChatDiscoveryBootstrapped;
      const targetChatIds = isBootstrap
        ? new Set(discoveredChatIds)
        : new Set<string>([
            ...newChatIds,
            ...[...discoveredChatIds].filter((c) => this.unresolvedGapWindowByChat.has(c)),
          ]);
      this.openChatDiscoveryBootstrapped = true;

      if (targetChatIds.size > 0) {
        // Non-bootstrap look-back must cover the FULL gap between two discovery
        // cycles (+ buffer): a chat first seen on THIS cycle could have been
        // joined — and @'d — anytime since the previous cycle, up to `intervalMs`
        // ago. interval + 30s buffer guarantees no hole. (Bootstrap uses the wider
        // cold-start look-back.) We pass this as the gapFill clamp floor too, so
        // the default 5-min clamp can't truncate it back below the interval.
        const intervalMs = resolveOpenChatDiscoveryMs(this.opts.openChatDiscoveryMs);
        const targetedLookbackMs = intervalMs + OPEN_CHAT_DISCOVERY_LOOKBACK_BUFFER_MS;
        const lookbackMs = isBootstrap
          ? OPEN_CHAT_DISCOVERY_BOOTSTRAP_LOOKBACK_MS
          : targetedLookbackMs;
        await this.gapFill(
          Date.now() - lookbackMs,
          log,
          targetChatIds,
          isBootstrap ? undefined : targetedLookbackMs,
        );
      }
      // Clean cycle → reset the failure backoff.
      this.openChatDiscoveryFailures = 0;
      this.openChatDiscoverySkips = 0;
    } catch (e) {
      // Failure backoff: a failing +chat-list / gap-fill shouldn't re-fire every
      // interval (that feedback loop is part of the storm). Skip an exponentially
      // growing number of subsequent cycles (2^failures, capped) before retrying.
      this.openChatDiscoveryFailures = Math.min(
        this.openChatDiscoveryFailures + 1,
        OPEN_CHAT_DISCOVERY_MAX_BACKOFF_CYCLES,
      );
      this.openChatDiscoverySkips = 2 ** (this.openChatDiscoveryFailures - 1);
      log(
        `open-chat discovery failed (backing off ${this.openChatDiscoverySkips} cycle(s)): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.openChatDiscoveryRunning = false;
    }
  }

  private learnedChatsPath(): string | null {
    if (!this.opts.larkwayDir) return null;
    const identity = this.opts.appId ?? this.opts.botOpenId;
    return path.join(
      this.opts.larkwayDir,
      "runtime",
      "channel-seen-chats",
      `${safeFilePart(identity)}.json`,
    );
  }

  private seenMessagesPath(): string | null {
    if (!this.opts.larkwayDir) return null;
    const identity = this.opts.appId ?? this.opts.botOpenId;
    return path.join(
      this.opts.larkwayDir,
      "runtime",
      "channel-seen-messages",
      `${safeFilePart(identity)}.json`,
    );
  }

  private async loadRecentlySeenChatIds(log: (s: string) => void): Promise<void> {
    const file = this.learnedChatsPath();
    if (!file) return;
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      // Two on-disk shapes: ≤v0.3.55 persisted a bare array of chat ids; the
      // current shape is { chats: string[], chatTypes: { [chatId]: type } } —
      // the types are what let gap-fill's p2p dispatch path (no mentions to
      // match on) survive a restart that precedes any live p2p traffic.
      const ids = Array.isArray(parsed) ? parsed : arrayField(parsed, "chats") ?? [];
      let count = 0;
      for (const chatId of ids) {
        if (typeof chatId !== "string" || !chatId.startsWith("oc_")) continue;
        this.recentlySeenChatIds.add(chatId);
        count++;
      }
      const types =
        !Array.isArray(parsed) && parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)["chatTypes"]
          : undefined;
      if (types && typeof types === "object") {
        for (const [chatId, t] of Object.entries(types as Record<string, unknown>)) {
          if (typeof t !== "string" || t.length === 0) continue;
          if (!this.recentlySeenChatIds.has(chatId)) continue;
          this.chatTypesById.set(chatId, t);
        }
      }
      if (count > 0) log(`loaded ${count} learned chat(s) for gap-fill`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log(`learned chats load failed: ${(err as Error).message}`);
    }
  }

  private noteSeenChat(chatId: string, chatType?: string): void {
    const typeChanged =
      chatType !== undefined && this.chatTypesById.get(chatId) !== chatType;
    if (typeChanged) this.chatTypesById.set(chatId, chatType);
    if (!chatId.startsWith("oc_")) return;
    // Any sighting of the chat (live delivery, discovery list) proves it is
    // reachable again — reset the 230002 untrack strikes.
    this.chatAccessGoneCountByChat.delete(chatId);
    const before = this.recentlySeenChatIds.size;
    this.recentlySeenChatIds.add(chatId);
    if (this.recentlySeenChatIds.size === before && !typeChanged) return;
    void this.persistRecentlySeenChatIds();
  }

  private async loadSeenMessageIds(log: (s: string) => void): Promise<void> {
    const file = this.seenMessagesPath();
    if (!file) return;
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      let count = 0;
      for (const messageId of parsed) {
        if (typeof messageId !== "string" || !messageId.startsWith("om_")) continue;
        this.seenMessageIds.add(messageId);
        count++;
      }
      if (count > 0) log(`loaded ${count} seen message(s) for open-chat recovery`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log(`seen messages load failed: ${(err as Error).message}`);
    }
  }

  private noteSeenMessage(messageId: string): void {
    const before = this.seenMessageIds.size;
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size === before) return;
    void this.persistSeenMessageIds();
  }

  /**
   * Atomic JSON write: serialize to a UNIQUE temp file, then `rename` over the
   * destination. Two concerns motivate this:
   *   1. Atomicity — `rename` is atomic on a POSIX filesystem, so a reader (or a
   *      crash) never observes a half-written file. The persist methods are
   *      fire-and-forget (`void persist…`), so under a multi-bot storm several
   *      writes to the SAME path can overlap; a plain `writeFile` interleaves
   *      their bytes → the "Bad control character in string literal" JSON
   *      corruption we saw. With tmp+rename each write lands whole-or-not-at-all.
   *   2. Per-write unique tmp name — a fixed `${file}.tmp` would itself be raced
   *      by two concurrent writers. The pid + monotonic counter suffix gives each
   *      in-flight write its own tmp so they can't clobber each other before the
   *      rename. Best-effort cleanup on failure; losing the cache is non-fatal.
   */
  private async atomicWriteJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${this.atomicWriteSeq++}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
      await rename(tmp, file);
    } catch {
      // Best effort only; try to not leave a stray tmp behind.
      try {
        await unlink(tmp);
      } catch {
        // ignore — nothing more we can do
      }
    }
  }

  private async persistSeenMessageIds(): Promise<void> {
    const file = this.seenMessagesPath();
    if (!file) return;
    const messages = [...this.seenMessageIds].slice(-SEEN_MESSAGES_LIMIT);
    // Best effort only: losing the cache can at worst replay recent @ messages.
    await this.atomicWriteJson(file, messages);
  }

  private async persistRecentlySeenChatIds(): Promise<void> {
    const file = this.learnedChatsPath();
    if (!file) return;
    const chats = [...this.recentlySeenChatIds].sort().slice(-LEARNED_CHATS_LIMIT);
    // Chat types ride along (bounded by the same chat cap) so a restart still
    // knows which tracked chats are p2p — see loadRecentlySeenChatIds.
    const chatTypes: Record<string, string> = {};
    for (const chatId of chats) {
      const t = this.chatTypesById.get(chatId);
      if (t) chatTypes[chatId] = t;
    }
    // Best effort only: losing the cache can at worst reduce reconnect recovery.
    await this.atomicWriteJson(file, { chats, chatTypes });
  }

  async addProcessingReaction(messageId: string): Promise<void> {
    if (this.processingReactions.has(messageId)) return;
    if (!this.channel) return;
    try {
      const result = await this.channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: PROCESSING_REACTION_EMOJI } },
      });
      const reactionId = result.data?.reaction_id ?? result.reaction_id;
      if (reactionId) {
        this.processingReactions.set(messageId, reactionId);
        console.info(
          `[channel.client] processing reaction added message=${messageId} reaction=${reactionId} emoji=${PROCESSING_REACTION_EMOJI}`,
        );
      }
    } catch (err) {
      console.warn(
        `[channel.client] add processing reaction failed for ${messageId}: ${(err as Error).message}`,
      );
    }
  }

  async removeProcessingReaction(messageId: string): Promise<void> {
    const reactionId = this.processingReactions.get(messageId);
    if (!reactionId) return;
    this.processingReactions.delete(messageId);
    if (!this.channel) return;
    try {
      await this.channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      console.info(
        `[channel.client] processing reaction removed message=${messageId} reaction=${reactionId}`,
      );
    } catch (err) {
      console.warn(
        `[channel.client] remove processing reaction failed for ${messageId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Interface parity with LarkClient. The SDK owns inbound dedup (DataCache),
   * but we still persist seen ids so open-chat recovery does not replay an
   * already handled message after a restart.
   */
  acknowledgeMessage(messageId: string): void {
    this.markHandled(messageId);
  }

  /**
   * Terminal SUCCESS: promote a message out of the in-flight set into the
   * persisted seen set. After this, neither the WS path nor any gap-fill window
   * (this process or post-restart) re-dispatches it. Persistence flows through
   * {@link noteSeenMessage} (the same channel-seen-messages json the success
   * set has always used), so post-restart recovery skips completed messages.
   */
  markHandled(messageId: string): void {
    this.inFlightMessageIds.delete(messageId);
    this.inFlightMessageMeta.delete(messageId);
    this.messageAttempts.delete(messageId);
    this.noteSeenMessage(messageId);
  }

  /**
   * Terminal FAILURE/ABORT: release a message from the in-flight set WITHOUT
   * marking it seen, so the next gap-fill window can re-dispatch it (the core
   * self-heal — one transient blip no longer swallows the @ forever). Does not
   * touch persisted seen state.
   *
   * Poison-message guard: if the message has already been dispatched
   * {@link MAX_MESSAGE_ATTEMPTS} times, GIVE UP — promote it to seen (so it
   * stops being re-dispatched on every gap-fill) and log a visible warning
   * instead of silently looping forever. Otherwise, record an unresolved gap
   * window for the message's chat so the next replay cycle re-dispatches it.
   */
  markUnhandled(messageId: string, opts?: { replay?: boolean }): void {
    this.inFlightMessageIds.delete(messageId);
    const meta = this.inFlightMessageMeta.get(messageId);
    this.inFlightMessageMeta.delete(messageId);
    // Poison-message guard: the counter is bumped once per DISPATCH
    // (noteDispatchAttempt) — deliberately NOT again here, otherwise each
    // dispatch+failure cycle counted double and a message got only 2-3 real
    // tries instead of the documented MAX_MESSAGE_ATTEMPTS.
    const attempts = this.messageAttempts.get(messageId) ?? 0;
    if (attempts >= MAX_MESSAGE_ATTEMPTS) {
      console.warn(
        `[channel.client] giving up on message_id=${messageId} after ${attempts} failed attempts` +
          ` — promoting to seen so it is no longer re-dispatched (poison-message guard)`,
      );
      this.messageAttempts.delete(messageId);
      this.noteSeenMessage(messageId);
      return;
    }
    // Make the promised re-dispatch actually happen: record an unresolved gap
    // window at (just before) this message's create_time so the next replay —
    // open-mode discovery cycle, chats-mode unresolved-replay timer, or a
    // reconnect gapFill — re-pulls this chat far enough back to re-dispatch it.
    // Skipped when the caller says replay:false (agent run already completed;
    // re-running would multiply its side effects — see InboundClient doc).
    if (meta && opts?.replay !== false) {
      this.recordUnresolvedGapWindow(
        meta.chatId,
        meta.createTimeMs - 1_000,
        (s) => console.log(`[channel.client] ${s}`),
      );
    }
  }

  /**
   * Increment the per-message dispatch counter (poison-message guard). Called
   * each time a message_id is pushed onto the inbound queue — and ONLY then;
   * {@link markUnhandled} deliberately reads without bumping, so the cap means
   * "N real dispatches" (see the messageAttempts field doc).
   */
  private noteDispatchAttempt(messageId: string): void {
    this.messageAttempts.set(messageId, (this.messageAttempts.get(messageId) ?? 0) + 1);
  }

  /**
   * Capture chatId + create_time for an in-flight message at dispatch time, so
   * {@link markUnhandled} can queue an unresolved gap window that reaches back
   * to the message itself. An unparseable create_time falls back to "1 min ago"
   * — wide enough to cover the message without flooding the replay pull.
   */
  private noteInFlightMeta(ev: LarkMessageEvent): void {
    const t = Number(ev.create_time);
    const createTimeMs = Number.isFinite(t) && t > 0
      ? (t < 1e12 ? t * 1000 : t) // lark surfaces both s and ms epochs
      : Date.now() - 60_000;
    this.inFlightMessageMeta.set(ev.message_id, { chatId: ev.chat_id, createTimeMs });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.openChatDiscoveryTimer) {
      clearInterval(this.openChatDiscoveryTimer);
      this.openChatDiscoveryTimer = null;
    }
    if (this.unresolvedReplayTimer) {
      clearInterval(this.unresolvedReplayTimer);
      this.unresolvedReplayTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    this.queue.close();
    if (this.channel && this.connected) {
      try {
        await this.channel.disconnect();
      } catch {
        // best-effort; we're shutting down
      }
    }
  }
}
