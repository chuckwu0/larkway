import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export function defaultResponseSurfacePrototypeConfig() {
  return {
    enabled: false,
    allowed_chats: [] as string[],
    allowed_threads: [] as string[],
    lazy_card_creation: false,
    post_outbound_enabled: false,
    allowed_mention_open_ids: [] as string[],
    max_posts_per_turn: 1,
    max_post_attempts: 3,
    text_threshold_chars: 1200,
  };
}

export const DEFAULT_RESPONSE_SURFACE_PROTOTYPE = defaultResponseSurfacePrototypeConfig();

const responseSurfacePrototypeConfigDefaults = () => ({
  enabled: false,
  allowed_chats: [] as string[],
  allowed_threads: [] as string[],
  lazy_card_creation: false,
  post_outbound_enabled: false,
  allowed_mention_open_ids: [] as string[],
  max_posts_per_turn: 1,
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
     * Master gate. Default false keeps the legacy card-only response path.
     */
    enabled: z.boolean().default(false),
    /**
     * Optional chat allowlist for dark-launch experiments. Empty means no chat
     * is allowlisted by this gate.
     */
    allowed_chats: z.array(z.string().min(1)).default([]),
    /**
     * Optional Larkway session/thread allowlist for narrow dogfood topics.
     * Empty means no thread is allowlisted by this gate.
     */
    allowed_threads: z.array(z.string().min(1)).default([]),
    /**
     * Dark-launch hook for PR2. This does not enable post-only output by itself;
     * the bridge still requires a visible card fallback until post outbound
     * exists and is explicitly enabled in a later PR.
     */
    lazy_card_creation: z.boolean().default(false),
    /**
     * PR3 dark-launch gate for real post outbound. This must stay false by
     * default. PR4's dispatcher also requires this gate before any post path.
     */
    post_outbound_enabled: z.boolean().default(false),
    /**
     * Explicit target allowlist for future real post @ mentions. Empty means no
     * mention target is authorized. Keep real IDs in private bot config, never
     * in public docs/tests.
     */
    allowed_mention_open_ids: z.array(z.string().min(1)).default([]),
    /**
     * Hard cap for surface dispatch. PR4 still keeps production post outbound
     * unavailable, but fake-channel dispatch tests enforce this bounded shape.
     */
    max_posts_per_turn: z.number().int().min(0).max(10).default(1),
    /**
     * Max attempts for one logical post. Retry classification is intentionally
     * narrow in PR3: only 5xx errors are retryable.
     */
    max_post_attempts: z.number().int().min(1).max(5).default(3),
    /**
     * Future channel threshold for lazy card creation. Bounded so config cannot
     * grow unbounded or encode business rules.
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
  const chatAllowed =
    config.allowed_chats.length > 0 && config.allowed_chats.includes(facts.chatId);
  const threadAllowed =
    config.allowed_threads.length > 0 && config.allowed_threads.includes(facts.threadId);
  return chatAllowed || threadAllowed;
}
