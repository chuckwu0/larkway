/**
 * src/bridge/stateFile.ts
 *
 * Read/write `<worktree>/.larkway/state.json` — the contract by which the
 * bot (Claude) reports current pipeline progress back to the bridge.
 *
 * Design contract:
 *   - Bridge OWNS bootstrap (writes initial state.json on worktree creation)
 *   - Bot OWNS updates (rewrites state.json before responding)
 *
 * Thin channel: the bridge only needs `status`. It does NOT probe dev_url and
 * does NOT scan agent text for stage transition keywords — the bot is
 * responsible for self-verifying any URL before claiming `ready`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ResponseSurfaceStateSchema,
  parseResponseSurfaceState,
} from "../responseSurface.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * 业务 URL 字段(dev_url / mr_url / grey_url / beta_pipeline_url)。
 *
 * **thin-channel 原则**:bridge 真正需要的只有 `status`。URL 字段是业务内容,
 * bridge 不该校验其格式 —— 否则一个格式不合规的业务字段会让整张 state.json
 * 校验失败被丢弃,连 `status` 一起拖垮 → 卡片停在「本轮未更新状态」+ 工具列表
 * 不隐藏(2026-05-29 E2E 实测:Lee-QA 写相对 `mr_url:"merge_requests/4025"`
 * 被旧的 `z.string().url()` 拒绝,整张 state 被丢)。
 *
 * 所以这里只接受「任意非空字符串」,空串预处理成 `undefined`(占位即缺省)。
 * dev_url 的真实可达性由 bot 自己 curl 验证(thin channel,bridge 不 probe)。
 */
const optionalUrl = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

const imageAlt = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().min(1).max(200).default("图片预览"),
);

const imageTitle = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().min(1).max(200).optional(),
);

const ImageBlockSchema = z.object({
  img_key: z.string().trim().min(1).max(256),
  alt: imageAlt,
  title: imageTitle,
  /**
   * Agent-facing mode maps directly to Feishu Card JSON 2.0 `scale_type`.
   * Keep the enum narrow until we have live-card evidence for more modes.
   */
  mode: z.enum(["crop_center", "fit_horizontal"]).default("fit_horizontal"),
  preview: z.boolean().default(true),
});

const ContentMarkdownBlockSchema = z.object({
  type: z.literal("markdown"),
  content: z.string().trim().min(1).max(20_000),
});

const ContentImageBlockSchema = ImageBlockSchema.extend({
  type: z.literal("image"),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  ContentMarkdownBlockSchema,
  ContentImageBlockSchema,
]);

const ContentBlocksSchema = z
  .array(ContentBlockSchema)
  .max(12)
  .superRefine((blocks, ctx) => {
    const imageCount = blocks.filter((b) => b.type === "image").length;
    if (imageCount > 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: 4,
        inclusive: true,
        message: "content_blocks supports at most 4 image blocks",
      });
    }
  });

export const StateFileSchema = z.object({
  // Thin channel: the bridge only validates `status`. Any other key the bot
  // writes (incl. a legacy `stage`) is a business field — z.object STRIPS
  // unknown keys, so a bad/extra field never discards the status the bridge
  // needs.
  status: z.enum(["in_progress", "ready", "failed"]),
  dev_url: optionalUrl,
  /**
   * Grey-environment URL operator can preview after stage=internal_test.
   * Bot writes this when grey deploy succeeds; bridge currently doesn't
   * probe it (would need grey-pool cookie/IP whitelist), but persists
   * the value so the card body can show it.
   */
  grey_url: optionalUrl,
  mr_url: optionalUrl,
  /**
   * Beta deploy pipeline URL (bot fills when stage=internal_test 时
   * push beta + 触发 CI 后)。当前 bridge 不主动 probe pipeline 状态,
   * 只透传字段给卡片渲染。schema 显式列出以免 z.object 默认 strip 把
   * bot 写的值丢掉,运营在卡片上看不到。
   */
  beta_pipeline_url: optionalUrl,
  /**
   * Operator-facing one-line summary. Bridge will use this verbatim as the
   * card body when finalizing — bot has full agency over the message text.
   */
  last_message: z.string().optional(),
  error: z.string().optional(),
  /**
   * Optional card-level overrides — when present, bridge uses these verbatim
   * instead of its default rendering. Lets bot fully drive the card UX
   * (success/failure framing, custom title) without changing handler logic.
   */
  card_title: z.string().optional(),
  card_text: z.string().optional(),
  /**
   * Header color override. Semantically "success" | "failure" | "neutral", but
   * the agent naturally writes plain color names ("green"/"red"/"grey") — so we
   * preprocess those to the semantic token. **Crucially, an UNKNOWN value maps to
   * `undefined`, NOT a validation error**: card_color is decorative, and the
   * thin-channel rule is that only `status` is bridge-critical. A strict enum
   * here would reject the WHOLE state.json on an out-of-vocab color (e.g. the
   * agent wrote `"green"`), dropping the status/MR/choices the bridge actually
   * needs and stranding the card (2026-05-30 E2E: `card_color:"green"` nuked a
   * `status:ready` build report — same failure class as the old `stage` enum).
   * Unknown → undefined → bridge falls back to its status-derived color.
   */
  card_color: z.preprocess((v) => {
    if (typeof v !== "string") return undefined;
    const map: Record<string, "success" | "failure" | "neutral"> = {
      green: "success",
      success: "success",
      red: "failure",
      failure: "failure",
      grey: "neutral",
      gray: "neutral",
      blue: "neutral",
      neutral: "neutral",
    };
    return map[v.trim().toLowerCase()]; // unknown → undefined (not a reject)
  }, z.enum(["success", "failure", "neutral"]).optional()),
  /**
   * V2 dynamic-choice card (thin-channel). When the bot wants the operator to
   * pick among options, it declares them here; the bridge renders them VERBATIM
   * as callback buttons on the FINALIZED card. A click sends the bot a NEW turn
   * whose text is the chosen `value` verbatim.
   *
   * **Bridge-opaque** — like all business fields, only `status` is
   * bridge-meaningful. The bridge does NOT interpret label/value, does NOT add a
   * default "其他" choice, does NOT mutate them on click. It renders what the
   * agent declares and hardcodes NOTHING. `label` is the button text the
   * operator sees; `value` is the string round-tripped back to the agent (make
   * it self-describing — it IS the task text the agent receives). Capped at 5.
   * V1 bots never write this field → V1 cards are byte-for-byte unchanged.
   */
  choices: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .max(5)
    .optional(),
  /**
   * V2 image blocks (thin-channel). Agents upload or otherwise obtain `img_key`
   * themselves, then declare generic image previews here. Bridge only renders the
   * already-declared keys into Feishu Card JSON 2.0 image elements; it does not
   * download, upload, choose assets, or interpret platform workflows.
   */
  image_blocks: z.array(ImageBlockSchema).max(4).optional(),
  /**
   * V2 ordered card body blocks (thin-channel). When present and non-empty,
   * these are the authoritative card body sequence and take precedence over
   * legacy `last_message` + tail-appended `image_blocks` rendering. Narrow union
   * only: markdown and image. No raw card JSON escape hatch.
   */
  content_blocks: ContentBlocksSchema.optional(),
  /**
   * Optional one-line prompt rendered above the choice buttons (e.g. "选哪个方案?").
   * Rendered VERBATIM, bridge-opaque. Only meaningful alongside `choices`.
   */
  choice_prompt: z.string().optional(),
  /**
   * Prototype response-surface declaration. Soft-failed by schema design: a bad
   * prototype field becomes undefined and must not discard status/last_message.
   * Runtime behavior is gated by bot config; when disabled, this field is
   * ignored and the legacy card path remains authoritative.
   */
  response_surface: ResponseSurfaceStateSchema.optional(),
  /**
   * Freshness signal for the handler's stale-guard (it compares this against a
   * pre-run snapshot to decide whether the bot rewrote state THIS turn).
   *
   * **OPTIONAL by thin-channel principle.** This used to be the ONE hard-required
   * field, so a bot that wrote a perfectly good `status` + `last_message` but
   * omitted `updated_at` had its ENTIRE state discarded → the card stranded on
   * "本轮没有拿到 agent 的新回复" every single turn (2026-07-02 排障: one shared
   * topic reproduced this on every @). Same failure class as the old
   * `z.string().url()` mr_url and the strict `stage`/`card_color` enums.
   *
   * When absent, {@link readStateFileDetailed} server-stamps it from the file's
   * mtime — which advances only on a real rewrite, so the stale-guard stays
   * correct even for bots that never write the field.
   */
  updated_at: z.string().optional(),
});

export type StateFile = z.infer<typeof StateFileSchema>;

/**
 * 止血 salvage schema for field-level degradation (2026-07-02).
 *
 * When the full {@link StateFileSchema} rejects the whole object over ONE bad
 * field, the bridge still only truly needs `status` (+ the operator-facing
 * `last_message`). This lenient schema keeps those and drops everything else, so
 * a single malformed/absent field can never strand the card on the generic
 * "没拿到新回复" fallback. `z.object` strips unknown keys (structured business
 * fields are simply omitted on this path); scalar fields use `.catch(undefined)`
 * so a wrong-typed one degrades instead of failing salvage. `status` stays
 * hard-required — without a valid status there is genuinely no usable report and
 * the caller falls through to `null`.
 */
const SalvageStateSchema = z.object({
  status: z.enum(["in_progress", "ready", "failed"]),
  last_message: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  card_title: z.string().optional().catch(undefined),
  card_text: z.string().optional().catch(undefined),
  updated_at: z.string().optional().catch(undefined),
});

export interface StateFileReadResult {
  state: StateFile | null;
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function stateDirOf(worktreePath: string): string {
  return path.join(worktreePath, ".larkway");
}

export function stateFilePathOf(worktreePath: string): string {
  return path.join(stateDirOf(worktreePath), "state.json");
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/**
 * Idempotent: ensure `<worktree>/.larkway/` exists and contains an initial
 * state.json. Does NOT overwrite an existing state.json (the bot's writes
 * win on subsequent boots — bootstrap is one-time).
 */
export async function ensureStateFile(worktreePath: string): Promise<void> {
  const dir = stateDirOf(worktreePath);
  const file = stateFilePathOf(worktreePath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.stat(file);
    return; // already exists — leave it alone
  } catch {
    // missing — write initial
  }
  const initial: StateFile = {
    status: "in_progress",
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(initial, null, 2), "utf8");
}

/**
 * Read + zod-validate state.json. Returns null if the file is absent or
 * malformed (caller decides whether that's an error or expected).
 *
 * On parse / validation failure, logs a warning with the underlying issue
 * and returns null — never throws (handler.ts treats absence as
 * "no report from bot this turn").
 */
export async function readStateFile(
  worktreePath: string,
): Promise<StateFile | null> {
  return (await readStateFileDetailed(worktreePath)).state;
}

export async function readStateFileDetailed(
  worktreePath: string,
): Promise<StateFileReadResult> {
  const file = stateFilePathOf(worktreePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: null, diagnostics: [] };
    }
    console.warn(`[stateFile] read ${file} failed:`, err);
    return { state: null, diagnostics: [] };
  }

  // mtime is the server-side freshness fallback for a missing `updated_at`
  // (advances only on a real rewrite → keeps the handler's stale-guard correct).
  // Best-effort: never fail the read over a missing stat.
  let mtimeIso: string | undefined;
  try {
    mtimeIso = (await fs.stat(file)).mtime.toISOString();
  } catch {
    /* leave undefined; withStampedUpdatedAt falls back to now() */
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Bot frequently writes last_message containing markdown like
    // **"Squash commits when merge request is accepted"** which has bare
    // `"` inside the JSON string value → JSON.parse fails. Try a
    // narrow-scope repair: escape bare `"` between `"last_message": "..."`.
    const repaired = tryRepairBareQuotesInLastMessage(raw);
    if (repaired !== raw) {
      try {
        parsed = JSON.parse(repaired);
        console.info(
          `[stateFile] ${file} parsed after bare-quote repair in last_message`,
        );
      } catch (err2) {
        console.warn(
          `[stateFile] ${file} not valid JSON (repair also failed):`,
          err2,
        );
        return { state: null, diagnostics: [] };
      }
    } else {
      console.warn(`[stateFile] ${file} not valid JSON:`, err);
      return { state: null, diagnostics: [] };
    }
  }

  const result = StateFileSchema.safeParse(parsed);
  if (result.success) {
    const state = withStampedUpdatedAt(result.data, mtimeIso);
    const diagnostics = diagnoseStateFile(parsed, result.data);
    for (const diagnostic of diagnostics) {
      console.warn(`[stateFile] ${file}: ${diagnostic}`);
    }
    return { state, diagnostics };
  }

  // Field-level degradation (止血, 2026-07-02): the full schema rejected the
  // whole object over some field, but the bridge only truly needs `status`
  // (+ the operator-facing last_message). Salvage those instead of discarding
  // everything — otherwise one malformed/absent field strands the card on the
  // generic "本轮没有拿到 agent 的新回复" fallback every turn.
  const salvaged = SalvageStateSchema.safeParse(parsed);
  if (salvaged.success) {
    const droppedFields = summarizeRejectedTopFields(result.error);
    const state = withStampedUpdatedAt(salvaged.data, mtimeIso);
    const diagnostic = `state.json 部分字段无效已忽略，保留 status/last_message（受影响字段：${droppedFields}）`;
    console.warn(`[stateFile] ${file}: ${diagnostic}`);
    return { state, diagnostics: [diagnostic] };
  }

  // Unsalvageable — not even a valid `status`. Genuine "no usable report".
  console.warn(
    `[stateFile] ${file} failed schema validation (unsalvageable):`,
    result.error.issues,
  );
  return { state: null, diagnostics: [] };
}

/**
 * Server-stamp a missing/blank `updated_at` from the file's mtime. mtime advances
 * only when the bot actually rewrites state.json, so the handler's stale-guard
 * (`updated_at !== preRunUpdatedAt`) keeps working even for bots that never write
 * the field. Falls back to now() only if mtime was unavailable (stat failed).
 */
function withStampedUpdatedAt(
  state: StateFile,
  mtimeIso: string | undefined,
): StateFile {
  if (state.updated_at != null && state.updated_at !== "") return state;
  return { ...state, updated_at: mtimeIso ?? new Date().toISOString() };
}

/** Distinct top-level field names that failed full-schema validation. */
function summarizeRejectedTopFields(error: z.ZodError): string {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    const top = issue.path[0];
    fields.add(top === undefined ? "(root)" : String(top));
  }
  return [...fields].join(", ") || "(unknown)";
}

function diagnoseStateFile(parsed: unknown, state: StateFile): string[] {
  if (parsed === null || typeof parsed !== "object") return [];
  if (!Object.prototype.hasOwnProperty.call(parsed, "response_surface")) return [];
  const rawSurface = (parsed as { response_surface?: unknown }).response_surface;
  if (rawSurface === undefined || state.response_surface !== undefined) return [];
  const parsedSurface = parseResponseSurfaceState(rawSurface);
  const details =
    parsedSurface.diagnostics.length > 0
      ? parsedSurface.diagnostics.join("; ")
      : "unknown parse failure";
  return [`response_surface ignored: ${details}`];
}

// ---------------------------------------------------------------------------
// Lenient JSON repair: bare-quote escape in last_message
// ---------------------------------------------------------------------------

/**
 * Narrow-scope JSON repair for the most common state.json corruption:
 * bot writes `last_message` containing markdown with bare `"` (e.g.
 * `**"Squash commits"**`), which violates JSON string escape rules.
 *
 * Strategy:
 *   1. Locate `"last_message": "<start>...<end>"` value range.
 *   2. End is heuristically detected as the rightmost `",\s*\n\s*"<key>":"`
 *      pattern OR `"\s*\n\s*}` (object close) inside the file.
 *   3. Within the value range, escape every bare `"` (not preceded by `\`).
 *
 * Returns the original raw if no last_message field found or no plausible
 * end found — caller should treat unchanged return as "no repair possible".
 *
 * Only handles last_message because that's the field that consistently
 * carries free-form markdown. Other string fields (dev_url, mr_url, etc.)
 * are URLs or short titles where bot is unlikely to write bare `"`.
 */
function tryRepairBareQuotesInLastMessage(raw: string): string {
  const startRe = /"last_message"\s*:\s*"/;
  const startMatch = raw.match(startRe);
  if (!startMatch || startMatch.index === undefined) return raw;
  const valueStart = startMatch.index + startMatch[0].length;

  const tail = raw.slice(valueStart);
  // Prefer the "next-key" end pattern (`",\n  "next_key":`): take the LAST
  // occurrence of it in tail. last_message itself may contain `",\n  "key":`
  // substrings (e.g. quoted JSON example in markdown), but the rightmost
  // such match within the document is by construction the actual closing
  // — there's no key after the last `"key":` pair.
  //
  // Fallback to `"\n}` (object close) only if no next-key match found —
  // i.e. last_message is the FINAL field, which is rare given schema always
  // includes updated_at.
  const nextKeyRe = /",[\s\r\n]+"[a-z_]+"\s*:/g;
  const nextKeyMatches = [...tail.matchAll(nextKeyRe)];
  let bestEnd = -1;
  if (nextKeyMatches.length > 0) {
    const last = nextKeyMatches[nextKeyMatches.length - 1];
    if (last && last.index !== undefined) bestEnd = last.index;
  } else {
    // Fallback: last_message is final field, value ends with `"\n}` or `"}`.
    const closeRe = /"[\s\r\n]*\}/g;
    const closeMatches = [...tail.matchAll(closeRe)];
    if (closeMatches.length > 0) {
      const last = closeMatches[closeMatches.length - 1];
      if (last && last.index !== undefined) bestEnd = last.index;
    }
  }
  if (bestEnd < 0) return raw;

  const valueText = tail.slice(0, bestEnd);
  // Escape bare " (not preceded by \). Conservative: don't touch \" sequences.
  // We can't use lookbehind without modern Node, but Node v20 supports it.
  const escaped = valueText.replace(/(?<!\\)"/g, '\\"');

  return raw.slice(0, valueStart) + escaped + tail.slice(bestEnd);
}
