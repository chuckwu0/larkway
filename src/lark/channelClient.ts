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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LarkMessageEvent, LarkClientOptions } from "./transport.js";
import { AsyncQueue } from "./transport.js";
import { ChannelCardClient, type OutboundLarkChannel } from "./channelCardClient.js";
import { ChannelPostClient, type OutboundPostLarkChannel } from "./channelPostClient.js";
import type { OutboundCardClient } from "./outboundCardClient.js";
import type { OutboundPostClient } from "./outboundPostClient.js";

const execFile = promisify(execFileCallback);
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
const OPEN_CHAT_DISCOVERY_LOOKBACK_MS = 90_000;
const OPEN_CHAT_DISCOVERY_BOOTSTRAP_LOOKBACK_MS = 30 * 60 * 1000;
const PROCESSING_REACTION_EMOJI = "Typing";

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

function resolveOpenChatDiscoveryMs(ctorValue: number | undefined): number {
  let raw: number;
  if (ctorValue !== undefined) {
    raw = ctorValue;
  } else {
    const env = process.env["LARKWAY_OPEN_CHAT_DISCOVERY_MS"];
    const parsed = env !== undefined ? Number(env) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : 60_000;
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
export function channelMsgToLarkEvent(msg: ChannelNormalizedMessage): LarkMessageEvent | null {
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
    chat_type: (m?.["chat_type"] as string) ?? msg.chatType ?? "group",
    thread_id,
    root_id,
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
   * every time a message_id is pushed onto the inbound queue (live WS or either
   * gap-fill branch) and once more when a turn is released as unhandled. When the
   * count reaches {@link MAX_MESSAGE_ATTEMPTS}, markUnhandled GIVES UP: it
   * promotes the message to seen (so it stops being re-dispatched) and logs a
   * warning. markHandled clears the entry on terminal success. Not persisted:
   * post-restart, an interrupted message starts fresh — same policy as
   * inFlightMessageIds.
   */
  private readonly messageAttempts = new Map<string, number>();
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
   * Backoff sleep used by the per-chat history-pull retry. Indirected through a
   * field purely so tests can observe/await the backoff deterministically; in
   * production it is the real timer-based {@link sleep}.
   */
  private gapFillSleep: (ms: number) => Promise<void> = sleep;
  private openChatDiscoveryTimer: NodeJS.Timeout | null = null;
  private openChatDiscoveryRunning = false;
  private openChatDiscoveryBootstrapped = false;
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
  /** Lazily built and only requested by main.ts when post outbound gates are configured. */
  private postClient: ChannelPostClient | null = null;

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

  /** TEST-ONLY read of the per-chat unresolved-window replay map (chatId → windowStart). */
  unresolvedGapWindowsForTest(): ReadonlyMap<string, number> {
    return new Map(this.unresolvedGapWindowByChat);
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
      // Liveness watchdog (SECONDS): if no inbound frame arrives within this
      // window after the last ping, treat the socket as dead and reconnect —
      // catches silently half-open connections that never emit a close event.
      // This IS the 1.64 keepalive fix; the app-level `keepalive` watchdog
      // option only exists in the split-out @larksuite/channel package, not in
      // node-sdk's bundled createLarkChannel, so we don't pass it here.
      wsConfig: { pingTimeout: 60 },
    } as Parameters<typeof createLarkChannel>[0]) as unknown as LarkChannel;

    channel.on("message", (msg) => {
      if (this.closed) return;
      const ev = channelMsgToLarkEvent(msg);
      if (!ev) {
        log(`dropped (unmappable raw): ${JSON.stringify(msg.messageId ?? "?")}`);
        return;
      }
      this.noteSeenChat(ev.chat_id);
      // Guard against double-delivery without permanently marking seen: if this
      // message is already handled (seen) or in-flight, skip. Otherwise mark it
      // in-flight so gap-fill won't also deliver it while the turn runs. It is
      // promoted to seen only on terminal SUCCESS (handler.markHandled), so a
      // failed turn stays re-dispatchable.
      if (this.seenMessageIds.has(ev.message_id) || this.inFlightMessageIds.has(ev.message_id)) {
        return;
      }
      this.inFlightMessageIds.add(ev.message_id);
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
        void this.gapFill(this.lastDisconnectAt, log);
      }
    });
    channel.on("error", (e) => log(`WS error (non-fatal): ${e?.code ?? ""} ${e?.message ?? ""}`));

    this.channel = channel;
    await channel.connect();
    this.connected = true;
    log(`connected as ${channel.botIdentity?.name ?? "?"} (${channel.botIdentity?.openId ?? "?"})`);
    this.startOpenChatDiscovery(log);
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
  ): Promise<void> {
    const MAX_GAP_FILL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
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
    // to the replay max age so an old unresolved window can actually be reached.
    const clampCeilingMs = hasReplay ? UNRESOLVED_WINDOW_MAX_AGE_MS : MAX_GAP_FILL_WINDOW_MS;
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
        // Bounded retry + exponential backoff: the history pull itself can撞上 a
        // transient TLS timeout. Retrying turns a one-off blip into a recovered
        // window instead of a permanently-dropped @ (root cause B).
        const { stdout } = await this.execWithRetry(larkCli, args, chatId, log);

        let messages: unknown[];
        try {
          // lark-cli versions have returned all of these envelopes over time:
          //   [ ... ], { items: [...] }, { messages: [...] }, { data: { messages: [...] } }.
          // Treat unknown-but-valid shapes as empty, but keep JSON parse errors visible.
          messages = parseLarkCliMessages(stdout) ?? [];
        } catch {
          log(`gap-fill: failed to parse lark-cli output for chat ${chatId}`);
          continue;
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

          // Only dispatch messages that @ this bot.
          const mentions = m["mentions"] as Array<{ id?: string | { open_id?: string } }> | undefined;
          const mentionsBot = Array.isArray(mentions) && mentions.some(
            (mn) => {
              if (typeof mn?.id === "string") return mn.id === botOpenId;
              return mn?.id?.open_id === botOpenId;
            },
          );
          if (!mentionsBot) continue;

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
          const ev = channelMsgToLarkEvent({
            raw: {
              event: {
                message: m,
                sender: { sender_id: { open_id: m["sender"] as string | undefined } },
              },
            },
          });
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
                chat_type: (m["chat_type"] as string | undefined) ?? "group",
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
            this.noteDispatchAttempt(fallbackEv.message_id);
            log(`gap-fill dispatching (fallback): message_id=${fallbackEv.message_id} chat=${chatId}`);
            this.queue.push(fallbackEv);
            totalDispatched++;
            continue;
          }

          // Mark in-flight (NOT seen): see fallback branch above.
          this.inFlightMessageIds.add(ev.message_id);
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
      } catch (e) {
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
        return await execFile(larkCli, args);
      } catch (e) {
        lastErr = e;
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

  private startOpenChatDiscovery(log: (s: string) => void): void {
    if (this.opts.allowedChatIds.size > 0) return;
    if (this.openChatDiscoveryTimer) return;
    const intervalMs = resolveOpenChatDiscoveryMs(this.opts.openChatDiscoveryMs);
    if (intervalMs <= 0) return;

    void this.discoverOpenChatsAndGapFill(log);
    this.openChatDiscoveryTimer = setInterval(() => {
      void this.discoverOpenChatsAndGapFill(log);
    }, intervalMs);
    this.openChatDiscoveryTimer.unref?.();
  }

  private async discoverOpenChatsAndGapFill(log: (s: string) => void): Promise<void> {
    if (this.closed || this.openChatDiscoveryRunning) return;
    this.openChatDiscoveryRunning = true;
    try {
      const larkCli = this.opts.larkCliPath ?? "lark-cli";
      const profileArgs = this.opts.larkCliProfile ? ["--profile", this.opts.larkCliProfile] : [];
      let pageToken = "";
      let fetched = 0;
      let newlyLearned = 0;
      const discoveredChatIds = new Set<string>();

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

        const { stdout } = await execFile(larkCli, args);
        const parsed = JSON.parse(stdout) as unknown;
        const chats = parseLarkCliMessages(stdout) ?? [];
        fetched += chats.length;
        for (const raw of chats) {
          const chatId = stringField(raw, "chat_id");
          if (!chatId?.startsWith("oc_")) continue;
          discoveredChatIds.add(chatId);
          const before = this.recentlySeenChatIds.size;
          this.noteSeenChat(chatId);
          if (this.recentlySeenChatIds.size > before) newlyLearned++;
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

      if (discoveredChatIds.size > 0) {
        const lookbackMs = this.openChatDiscoveryBootstrapped
          ? OPEN_CHAT_DISCOVERY_LOOKBACK_MS
          : OPEN_CHAT_DISCOVERY_BOOTSTRAP_LOOKBACK_MS;
        this.openChatDiscoveryBootstrapped = true;
        await this.gapFill(
          Date.now() - lookbackMs,
          log,
          discoveredChatIds,
        );
      }
    } catch (e) {
      log(`open-chat discovery failed: ${e instanceof Error ? e.message : String(e)}`);
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
      if (!Array.isArray(parsed)) return;
      let count = 0;
      for (const chatId of parsed) {
        if (typeof chatId !== "string" || !chatId.startsWith("oc_")) continue;
        this.recentlySeenChatIds.add(chatId);
        count++;
      }
      if (count > 0) log(`loaded ${count} learned chat(s) for gap-fill`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log(`learned chats load failed: ${(err as Error).message}`);
    }
  }

  private noteSeenChat(chatId: string): void {
    if (!chatId.startsWith("oc_")) return;
    const before = this.recentlySeenChatIds.size;
    this.recentlySeenChatIds.add(chatId);
    if (this.recentlySeenChatIds.size === before) return;
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

  private async persistSeenMessageIds(): Promise<void> {
    const file = this.seenMessagesPath();
    if (!file) return;
    const messages = [...this.seenMessageIds].slice(-SEEN_MESSAGES_LIMIT);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(messages, null, 2), "utf8");
    } catch {
      // Best effort only: losing the cache can at worst replay recent @ messages.
    }
  }

  private async persistRecentlySeenChatIds(): Promise<void> {
    const file = this.learnedChatsPath();
    if (!file) return;
    const chats = [...this.recentlySeenChatIds].sort().slice(-LEARNED_CHATS_LIMIT);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(chats, null, 2), "utf8");
    } catch {
      // Best effort only: losing the cache can at worst reduce reconnect recovery.
    }
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
    this.messageAttempts.delete(messageId);
    this.noteSeenMessage(messageId);
  }

  /**
   * Terminal FAILURE/ABORT: release a message from the in-flight set WITHOUT
   * marking it seen, so the next gap-fill window can re-dispatch it (the core
   * self-heal — one transient blip no longer swallows the @ forever). Does not
   * touch persisted seen state.
   *
   * Poison-message guard: count this failed turn as one more attempt. If the
   * message has now failed {@link MAX_MESSAGE_ATTEMPTS} times, GIVE UP — promote
   * it to seen (so it stops being re-dispatched on every gap-fill) and log a
   * visible warning instead of silently looping forever.
   */
  markUnhandled(messageId: string): void {
    this.inFlightMessageIds.delete(messageId);
    const attempts = (this.messageAttempts.get(messageId) ?? 0) + 1;
    this.messageAttempts.set(messageId, attempts);
    if (attempts >= MAX_MESSAGE_ATTEMPTS) {
      console.warn(
        `[channel.client] giving up on message_id=${messageId} after ${attempts} failed attempts` +
          ` — promoting to seen so it is no longer re-dispatched (poison-message guard)`,
      );
      this.messageAttempts.delete(messageId);
      this.noteSeenMessage(messageId);
    }
  }

  /**
   * Increment the per-message dispatch counter (poison-message guard). Called
   * each time a message_id is pushed onto the inbound queue. The counter is also
   * bumped in {@link markUnhandled} so both dispatch and failed settlement
   * contribute toward the cap.
   */
  private noteDispatchAttempt(messageId: string): void {
    this.messageAttempts.set(messageId, (this.messageAttempts.get(messageId) ?? 0) + 1);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.openChatDiscoveryTimer) {
      clearInterval(this.openChatDiscoveryTimer);
      this.openChatDiscoveryTimer = null;
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
