/**
 * lark/transport.ts
 *
 * Transport-neutral types + the AsyncQueue value shared by the inbound
 * clients. Moved out of lark/client.ts (which wrapped the now-removed lark-cli
 * `event +subscribe` subprocess) so the Channel-SDK transport and the rest of
 * the bridge can depend on these without pulling in the lark-cli client.
 *
 * Contents (all relocated AS-IS):
 *   - LarkMessageEvent   (interface) — the inbound message shape
 *   - InboundClient      (interface) — minimal inbound-transport surface
 *   - AsyncQueue<T>      (class)     — VALUE import; bridges events into a generator
 *   - LarkClientOptions  (interface) — inbound client construction options
 *   - ActiveThreadInfo   (interface) — per-thread catch-up high-water mark
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LarkMessageEvent {
  message_id: string;
  chat_id: string;
  /** 'p2p' | 'group' | 'topic_group' etc. */
  chat_type: string;
  thread_id?: string;
  /** open_id of the sender; some SDK paths may pass the raw sender_id object. */
  sender_id: string | Record<string, unknown>;
  mentions?: Array<{
    key?: string;
    id: { open_id?: string; union_id?: string; user_id?: string | null };
    mentioned_type?: string;
    name?: string;
  }>;
  /** Raw JSON string — downstream lark/message.ts is responsible for parsing */
  content: string;
  create_time: string;
  [key: string]: unknown;
}

/**
 * Minimal inbound-transport interface used by BridgeHandler/main. Both the
 * lark-cli-backed `LarkClient` and the Channel-SDK-backed `ChannelClient`
 * implement it, so the transport is swappable behind a flag (main.ts).
 */
export interface InboundClient {
  events(): AsyncIterable<LarkMessageEvent>;
  /**
   * Best-effort visual ack for an inbound message. Implementations may add a
   * temporary Feishu reaction so the operator immediately sees "the bridge got
   * it" before a card is created.
   */
  addProcessingReaction?(messageId: string): Promise<void>;
  /**
   * Best-effort cleanup for the temporary visual ack. Called once the bridge has
   * moved from "received" to the real processing surface (or after hard failure).
   */
  removeProcessingReaction?(messageId: string): Promise<void>;
  acknowledgeMessage(messageId: string): void;
  close(): Promise<void>;
}

/** Per-thread state used by catch-up to decide which messages to recover. */
export interface ActiveThreadInfo {
  /**
   * ms epoch — high-water mark. Messages with create_time STRICTLY GREATER
   * than this are considered "sent while we were down" and get dispatched
   * via maybePush (recover mode). Messages ≤ this are mark-seen-only.
   */
  lastActiveTs: number;
}

export interface LarkClientOptions {
  allowedChatIds: ReadonlySet<string>;
  botOpenId: string;
  /** Defaults to 'lark-cli' */
  larkCliPath?: string;
  /**
   * Optional callback returning currently active threads with their
   * lastActiveTs high-water mark. Used by thread-level catch-up to
   * dispatch (recover) messages newer than the high-water mark — so
   * messages sent while bridge was down get processed automatically,
   * not silently mark-seen-only (which would force the operator to
   * re-send manually — see lessons-learned §B.14.3).
   */
  getActiveThreads?: () => ReadonlyMap<string, ActiveThreadInfo>;
  /**
   * V2 multi-bot: Feishu app_id for this bot.
   * If set, appSecret MUST also be provided (throws otherwise).
   * When both are provided, FEISHU_APPID/FEISHU_APPSECRET are injected
   * into the lark-cli spawn environment so each bot uses its own credentials.
   * When omitted (V1), lark-cli inherits process.env (V1 behaviour unchanged).
   */
  appId?: string;
  /**
   * V2 multi-bot: actual app secret value (read from process.env by caller).
   * Must be provided together with appId; providing only one throws.
   */
  appSecret?: string;
  /**
   * lark-cli named profile (from ~/.lark-cli/config.json) — passed as
   * `--profile <name>` to lark-cli subscribe. **Required for V2 multi-bot**
   * because lark-cli 1.0.38 silently ignores FEISHU_APPID/FEISHU_APPSECRET
   * env injection and falls back to the default profile, causing every bot
   * to subscribe to the same app's events. When undefined, no --profile is
   * passed (V1 single-bot uses default profile naturally).
   */
  larkCliProfile?: string;
  /**
   * V2 multi-bot: per-bot state directory.
   * When set, all 4 state files (recover-attempts, chat-watermarks, seen-messages,
   * pending-messages) are written under this directory instead of the default
   * `~/.larkway/`. Prevents multi-instance concurrent write races.
   * When omitted (V1), defaults to `~/.larkway/` (backward-compatible).
   */
  larkwayDir?: string;
  /**
   * Channel SDK: one-shot pre-connect delay (ms) so a stale Feishu long-conn
   * slot from a just-killed bridge releases before this process opens its own.
   * Precedence: this ctor option > env LARKWAY_CONNECT_GRACE_MS > default 3000.
   * A value of 0 disables the delay (tests / dry-run).
   */
  connectGraceMs?: number;
  /**
   * @deprecated Ignored. The silent-deaf guard (rebuildChannel / staleTimer) has
   * been removed (BL-11): the SDK's autoReconnect fully re-registers on every
   * reconnect, so the guard was only firing false positives on idle bots and
   * tearing down healthy connections (2026-06-01: 25 min / 14 rebuilds / 0 msgs).
   * This field is kept here only so existing callers don't get a TS error;
   * ChannelClient no longer reads it.
   */
  channelStaleMs?: number;
  /**
   * Open-bot fallback discovery interval (ms). When `allowedChatIds` is empty,
   * ChannelClient periodically lists bot-joined chats and gap-fills recent
   * @-messages so newly invited groups still work if WS delivery is flaky.
   * Defaults to env LARKWAY_OPEN_CHAT_DISCOVERY_MS or 60000. A value of 0
   * disables it (tests / dry-run).
   */
  openChatDiscoveryMs?: number;
}

// ---------------------------------------------------------------------------
// AsyncQueue (VALUE export)
// ---------------------------------------------------------------------------

/**
 * Minimal async queue used to bridge readline events into the generator.
 * Items accumulate if the consumer is slower than the producer; the queue
 * is intentionally unbounded because lark-cli event volume is very low.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Signal that no more items will arrive */
  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
