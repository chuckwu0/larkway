import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);
const CardKitMentionUserIdSchema = NonEmptyString.max(128).regex(/^[A-Za-z0-9_:-]+$/, {
  message: "mention user_id must contain only letters, numbers, underscore, colon, or hyphen",
});

export function defaultResponseSurfacePrototypeConfig() {
  return {
    enabled: true,
    allowed_chats: [] as string[],
    allowed_threads: [] as string[],
    kill_switch: false,
    post_outbound_enabled: true,
    cardkit_streaming_enabled: true,
    allow_agent_mentions: true,
    denied_mention_open_ids: [] as string[],
    allowed_mention_open_ids: [] as string[],
  };
}

export const DEFAULT_RESPONSE_SURFACE_PROTOTYPE = defaultResponseSurfacePrototypeConfig();

const responseSurfacePrototypeConfigDefaults = () => ({
  enabled: true,
  allowed_chats: [] as string[],
  allowed_threads: [] as string[],
  kill_switch: false,
  post_outbound_enabled: true,
  cardkit_streaming_enabled: true,
  allow_agent_mentions: true,
  denied_mention_open_ids: [] as string[],
  allowed_mention_open_ids: [] as string[],
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
  user_id: CardKitMentionUserIdSchema,
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
    mode: ResponseSurfaceModeSchema.optional().default("card"),
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
  return parseResponseSurfaceState(value).state;
}, StrictResponseSurfaceStateSchema.optional());

export type ResponseSurfaceState = z.infer<typeof StrictResponseSurfaceStateSchema>;

export interface ResponseSurfaceParseResult {
  state?: ResponseSurfaceState;
  diagnostics: string[];
}

export function parseResponseSurfaceState(value: unknown): ResponseSurfaceParseResult {
  const result = StrictResponseSurfaceStateSchema.safeParse(value);
  if (result.success) return { state: result.data, diagnostics: [] };
  return {
    diagnostics: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    }),
  };
}

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
     * Optional deny-list for Agent-authored @ mentions. Empty means the Agent
     * may choose mention targets, except broadcast aliases such as @all.
     * Keep real IDs in private bot config, never in public docs/tests.
     */
    denied_mention_open_ids: z.array(z.string().min(1)).default([]),
    /**
     * Deprecated compatibility field. It is still parsed so older private
     * configs do not fail, but mention policy is deny-list/default-allow.
     * Use denied_mention_open_ids for new restrictions.
     */
    allowed_mention_open_ids: z.array(z.string().min(1)).default([]),
  })
  .default(responseSurfacePrototypeConfigDefaults);

export type ResponseSurfacePrototypeConfig = z.infer<
  typeof ResponseSurfacePrototypeConfigSchema
>;

export type MentionPolicyRule =
  | "allowed"
  | "agent_mentions_disabled"
  | "broadcast_blocked"
  | "denied_target";

export interface MentionPolicyResult {
  allowed: boolean;
  rule: MentionPolicyRule;
  reason?: string;
}

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
  return evaluateResponseSurfaceMentionPolicy(config, userId).allowed;
}

export function evaluateResponseSurfaceMentionPolicy(
  config: ResponseSurfacePrototypeConfig | undefined,
  userId: string,
): MentionPolicyResult {
  if (!config?.allow_agent_mentions) {
    return {
      allowed: false,
      rule: "agent_mentions_disabled",
      reason: "Agent-authored mentions are disabled by allow_agent_mentions=false.",
    };
  }
  const normalized = userId.trim().toLowerCase();
  if (normalized === "all" || normalized === "@all") {
    return {
      allowed: false,
      rule: "broadcast_blocked",
      reason: "Broadcast mentions such as @all are blocked.",
    };
  }
  if (config.denied_mention_open_ids.includes(userId)) {
    return {
      allowed: false,
      rule: "denied_target",
      reason: "Mention target is denied by denied_mention_open_ids.",
    };
  }
  return { allowed: true, rule: "allowed" };
}

export function shouldProvideResponseSurfacePostClient(
  config: ResponseSurfacePrototypeConfig | undefined,
): boolean {
  return !!(
    config?.enabled &&
    !config.kill_switch &&
    config.post_outbound_enabled
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
