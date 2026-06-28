import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export function defaultResponseSurfacePrototypeConfig() {
  return {
    enabled: true,
    allowed_chats: [] as string[],
    allowed_threads: [] as string[],
    lazy_card_creation: true,
    kill_switch: false,
    post_outbound_enabled: true,
    cardkit_streaming_enabled: true,
    allow_agent_mentions: true,
    allowed_mention_open_ids: [] as string[],
    max_posts_per_turn: 1,
    max_posts_per_window: 4,
    post_window_ms: 60_000,
    max_post_attempts: 3,
    text_threshold_chars: 1200,
  };
}

export const DEFAULT_RESPONSE_SURFACE_PROTOTYPE = defaultResponseSurfacePrototypeConfig();

const responseSurfacePrototypeConfigDefaults = () => ({
  enabled: true,
  allowed_chats: [] as string[],
  allowed_threads: [] as string[],
  lazy_card_creation: true,
  kill_switch: false,
  post_outbound_enabled: true,
  cardkit_streaming_enabled: true,
  allow_agent_mentions: true,
  allowed_mention_open_ids: [] as string[],
  max_posts_per_turn: 1,
  max_posts_per_window: 4,
  post_window_ms: 60_000,
  max_post_attempts: 3,
  text_threshold_chars: 1200,
});

export const ResponseSurfaceModeSchema = z.enum(["card", "post", "hybrid"]);
export const ResponseSurfacePrimarySchema = z.enum(["card", "post"]);

export const ResponseSurfaceCapabilitySchema = z.enum([
  "choices",
  "image_blocks",
  "content_blocks",
  "fallback",
  "audit",
]);

const MentionTargetSchema = z.object({
  user_id: NonEmptyString.max(128),
  label: z.string().trim().min(1).max(80).optional(),
});

const ResponseSurfacePostSchema = z.object({
  mentions: z.array(MentionTargetSchema).max(5).default([]),
});

const ResponseSurfaceCardSchema = z.object({
  compact: z.boolean().default(false),
  capabilities: z.array(ResponseSurfaceCapabilitySchema).max(8).default([]),
});

const StrictResponseSurfaceStateSchema = z
  .object({
    mode: ResponseSurfaceModeSchema,
    primary: ResponseSurfacePrimarySchema.optional(),
    post: ResponseSurfacePostSchema.optional(),
    card: ResponseSurfaceCardSchema.optional(),
  })
  .superRefine((surface, ctx) => {
    if (surface.mode === "card" && surface.primary === "post") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primary"],
        message: "response_surface.primary=post is incompatible with mode=card",
      });
    }
  });

/**
 * Agent-authored response_surface is intentionally soft-failed. A typo in this
 * prototype field must never discard the status/last_message fields needed to
 * finalize the legacy card path.
 */
export const ResponseSurfaceStateSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  const result = StrictResponseSurfaceStateSchema.safeParse(value);
  return result.success ? result.data : undefined;
}, StrictResponseSurfaceStateSchema.optional());

export type ResponseSurfaceState = z.infer<typeof StrictResponseSurfaceStateSchema>;

export const ResponseSurfacePrototypeConfigSchema = z
  .object({
    /**
     * Master gate. Default true makes response surfaces available unless the
     * runtime kill switch disables them.
     */
    enabled: z.boolean().default(true),
    /**
     * Optional chat allowlist for staged rollout. Empty means all chats are
     * allowed by this gate.
     */
    allowed_chats: z.array(z.string().min(1)).default([]),
    /**
     * Optional Larkway session/thread allowlist for staged rollout. Empty means
     * all threads are allowed by this gate.
     */
    allowed_threads: z.array(z.string().min(1)).default([]),
    /**
     * Historical post-first gate retained for config compatibility. The default
     * runtime no longer uses post-first lazy card creation; CardKit is the main
     * surface and legacy cards remain the visible fallback.
     */
    lazy_card_creation: z.boolean().default(true),
    /**
     * Runtime kill switch for emergency rollback. When true, every response
     * surface post path is treated as disabled even if enabled/allowlists are
     * otherwise configured.
     */
    kill_switch: z.boolean().default(false),
    /**
     * Gate for real post outbound. Defaults on so create-only visible fallback
     * posts remain available when CardKit and legacy card rendering both fail.
     */
    post_outbound_enabled: z.boolean().default(true),
    /**
     * CardKit streaming response surface gate. Defaults on: normal turns use a
     * streaming CardKit card during execution and finalize that same card into
     * a clean answer + interaction surface. Disabling this gate rolls back to
     * the legacy visible card path, not post in-place editing.
     */
    cardkit_streaming_enabled: z.boolean().default(true),
    /**
     * Allows Agent-authored post mentions. This powers handoff to peer bots.
     * Keep this false only when the operator wants to suppress every real @.
     */
    allow_agent_mentions: z.boolean().default(true),
    /**
     * Optional target allowlist for real post @ mentions. Empty means the Agent
     * may choose mention targets; non-empty narrows mentions to this exact set.
     * Keep real IDs in private bot config, never in public docs/tests.
     */
    allowed_mention_open_ids: z.array(z.string().min(1)).default([]),
    /**
     * Historical post dispatch cap retained for schema compatibility and
     * isolated dispatcher tests.
     */
    max_posts_per_turn: z.number().int().min(0).max(10).default(1),
    /**
     * Sliding-window hard cap for real post sends within one bot/chat/thread
     * runtime scope. This is enforced in the production handler before a post
     * transport call is attempted; exhausted windows degrade to visible cards.
     */
    max_posts_per_window: z.number().int().min(0).max(100).default(4),
    /**
     * Sliding-window duration for max_posts_per_window.
     */
    post_window_ms: z.number().int().min(1_000).max(86_400_000).default(60_000),
    /**
     * Max attempts for one logical post. Retry classification is intentionally
     * narrow in PR3: only 5xx errors are retryable.
     */
    max_post_attempts: z.number().int().min(1).max(5).default(3),
    /**
     * Historical threshold for removed lazy card creation experiments. Bounded
     * so older config remains parseable without growing arbitrary business rules.
     */
    text_threshold_chars: z.number().int().min(1).max(20_000).default(1200),
  })
  .default(responseSurfacePrototypeConfigDefaults);

export type ResponseSurfacePrototypeConfig = z.infer<
  typeof ResponseSurfacePrototypeConfigSchema
>;

export function isResponseSurfacePrototypeAllowlisted(
  config: ResponseSurfacePrototypeConfig | undefined,
  facts: { chatId: string; threadId: string },
): boolean {
  if (!config?.enabled) return false;
  if (config.kill_switch) return false;
  const hasScopedAllowlist =
    config.allowed_chats.length > 0 || config.allowed_threads.length > 0;
  if (!hasScopedAllowlist) return true;
  const chatAllowed =
    config.allowed_chats.length > 0 && config.allowed_chats.includes(facts.chatId);
  const threadAllowed =
    config.allowed_threads.length > 0 && config.allowed_threads.includes(facts.threadId);
  return chatAllowed || threadAllowed;
}

export function isResponseSurfaceMentionAllowed(
  config: ResponseSurfacePrototypeConfig | undefined,
  userId: string,
): boolean {
  if (!config?.allow_agent_mentions) return false;
  const normalized = userId.trim().toLowerCase();
  if (normalized === "all" || normalized === "@all") return false;
  if (config.allowed_mention_open_ids.length === 0) return true;
  return config.allowed_mention_open_ids.includes(userId);
}

export function shouldProvideResponseSurfacePostClient(
  config: ResponseSurfacePrototypeConfig | undefined,
): boolean {
  return !!(
    config?.enabled &&
    !config.kill_switch &&
    config.post_outbound_enabled &&
    config.max_posts_per_turn >= 1 &&
    config.max_posts_per_window >= 1
  );
}

export function shouldProvideResponseSurfaceCardKitClient(
  config: ResponseSurfacePrototypeConfig | undefined,
): boolean {
  return !!(
    config?.enabled &&
    !config.kill_switch &&
    config.cardkit_streaming_enabled
  );
}

export function isResponseSurfaceCardKitAvailable(
  config: ResponseSurfacePrototypeConfig | undefined,
  facts: { chatId: string; threadId: string },
  opts: { cardKitClientAvailable: boolean },
): boolean {
  return !!(
    opts.cardKitClientAvailable &&
    shouldProvideResponseSurfaceCardKitClient(config) &&
    isResponseSurfacePrototypeAllowlisted(config, facts)
  );
}

export function isResponseSurfacePostOutboundAvailable(
  config: ResponseSurfacePrototypeConfig | undefined,
  facts: { chatId: string; threadId: string },
  opts: { postClientAvailable: boolean },
): boolean {
  return !!(
    opts.postClientAvailable &&
    shouldProvideResponseSurfacePostClient(config) &&
    isResponseSurfacePrototypeAllowlisted(config, facts)
  );
}
