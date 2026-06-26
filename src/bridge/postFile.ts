import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const PostLedgerStatusSchema = z.enum([
  "planned",
  "pending",
  "sent",
  "failed",
  "fallback_visible",
  "policy_blocked",
]);

export type PostLedgerStatus = z.infer<typeof PostLedgerStatusSchema>;

export const POST_LEDGER_TRANSITIONS: Record<PostLedgerStatus, PostLedgerStatus[]> = {
  planned: ["pending", "fallback_visible", "policy_blocked"],
  pending: ["sent", "failed", "fallback_visible", "policy_blocked"],
  sent: [],
  failed: ["fallback_visible"],
  fallback_visible: [],
  policy_blocked: [],
};

export function canTransitionPostStatus(
  from: PostLedgerStatus,
  to: PostLedgerStatus,
): boolean {
  return from === to || POST_LEDGER_TRANSITIONS[from].includes(to);
}

export function assertPostStatusTransition(
  from: PostLedgerStatus,
  to: PostLedgerStatus,
): void {
  if (!canTransitionPostStatus(from, to)) {
    throw new Error(`invalid post ledger transition: ${from} -> ${to}`);
  }
}

const PostAttemptSchema = z.object({
  attemptedAt: z.string(),
  status: z.enum(["sent", "failed"]),
  retryable: z.boolean().default(false),
  error: z.string().optional(),
  code: z.string().optional(),
});

const PostLedgerEntrySchema = z.object({
  idempotencyKey: z.string().min(1).max(64),
  status: PostLedgerStatusSchema,
  botId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().min(1),
  replyToMessageId: z.string().min(1),
  role: z.enum(["primary", "secondary", "fallback"]),
  logicalIndex: z.number().int().nonnegative(),
  contentDigest: z.string().min(1),
  mentionCount: z.number().int().nonnegative().default(0),
  postMessageId: z.string().optional(),
  fallbackCardMessageId: z.string().optional(),
  error: z.string().optional(),
  attempts: z.array(PostAttemptSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PostFileSchema = z.object({
  version: z.literal(1),
  posts: z.array(PostLedgerEntrySchema).max(50),
});

export type PostAttempt = z.infer<typeof PostAttemptSchema>;
export type PostLedgerEntry = z.infer<typeof PostLedgerEntrySchema>;
export type PostFile = z.infer<typeof PostFileSchema>;

export function emptyPostFile(): PostFile {
  return { version: 1, posts: [] };
}

export function postDirOf(worktreePath: string): string {
  return path.join(worktreePath, ".larkway");
}

export function postFilePathOf(worktreePath: string): string {
  return path.join(postDirOf(worktreePath), "post.json");
}

export async function readPostFile(worktreePath: string): Promise<PostFile | null> {
  const file = postFilePathOf(worktreePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[postFile] read ${file} failed:`, err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[postFile] ${file} not valid JSON:`, err);
    return null;
  }

  const result = PostFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[postFile] ${file} failed schema validation:`, result.error.issues);
    return null;
  }
  return result.data;
}

export async function writePostFile(
  worktreePath: string,
  data: z.input<typeof PostFileSchema>,
): Promise<void> {
  const dir = postDirOf(worktreePath);
  const file = postFilePathOf(worktreePath);
  await fs.mkdir(dir, { recursive: true });

  const parsed = PostFileSchema.parse(data);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function upsertPostLedgerEntry(
  worktreePath: string,
  entry: PostLedgerEntry,
): Promise<PostFile> {
  const existing = (await readPostFile(worktreePath)) ?? emptyPostFile();
  const idx = existing.posts.findIndex((p) => p.idempotencyKey === entry.idempotencyKey);
  const nextPosts = [...existing.posts];
  if (idx >= 0) {
    assertPostStatusTransition(nextPosts[idx].status, entry.status);
    nextPosts[idx] = entry;
  } else {
    nextPosts.push(entry);
  }
  const next = { version: 1 as const, posts: nextPosts };
  await writePostFile(worktreePath, next);
  return next;
}

export interface ReconcilePostLedgerOpts {
  botId: string;
  minAgeMs?: number;
  now?: () => string;
}

export interface ReconcilePostLedgerResult {
  changed: boolean;
  sent: number;
  fallbackVisible: number;
  needsVisibleFallback: number;
  skippedLive: number;
}

const DEFAULT_POST_RECONCILE_MIN_AGE_MS = 60_000;

function timestampAgeMs(iso: string, nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return nowMs - then;
}

function reconcilePostEntry(
  entry: PostLedgerEntry,
  opts: Required<ReconcilePostLedgerOpts>,
): {
  entry: PostLedgerEntry;
  changed: boolean;
  sent: boolean;
  needsVisibleFallback: boolean;
} {
  if (entry.botId !== opts.botId) {
    return { entry, changed: false, sent: false, needsVisibleFallback: false };
  }

  if (
    entry.status === "sent" ||
    entry.status === "fallback_visible" ||
    entry.status === "policy_blocked"
  ) {
    return { entry, changed: false, sent: false, needsVisibleFallback: false };
  }

  const now = opts.now();
  const ageMs = timestampAgeMs(entry.updatedAt, Date.parse(now));
  if (ageMs == null || ageMs < opts.minAgeMs) {
    return { entry, changed: false, sent: false, needsVisibleFallback: false };
  }

  if (entry.postMessageId) {
    return {
      entry: {
        ...entry,
        status: "sent",
        error: undefined,
        updatedAt: now,
        attempts: [
          ...entry.attempts,
          {
            attemptedAt: now,
            status: "sent",
            retryable: false,
          },
        ],
      },
      changed: true,
      sent: true,
      needsVisibleFallback: false,
    };
  }

  return {
    entry,
    changed: false,
    sent: false,
    needsVisibleFallback: true,
  };
}

export function reconcilePostLedgerEntries(
  data: PostFile,
  opts: ReconcilePostLedgerOpts,
): {
  file: PostFile;
  result: ReconcilePostLedgerResult;
  visibleFallbackCandidates: PostLedgerEntry[];
} {
  const normalizedOpts: Required<ReconcilePostLedgerOpts> = {
    botId: opts.botId,
    minAgeMs: opts.minAgeMs ?? DEFAULT_POST_RECONCILE_MIN_AGE_MS,
    now: opts.now ?? (() => new Date().toISOString()),
  };

  let sent = 0;
  const fallbackVisible = 0;
  let needsVisibleFallback = 0;
  let skippedLive = 0;
  const visibleFallbackCandidates: PostLedgerEntry[] = [];
  const posts = data.posts.map((post) => {
    const reconciled = reconcilePostEntry(post, normalizedOpts);
    if (reconciled.changed) {
      if (reconciled.sent) sent += 1;
    } else if (reconciled.needsVisibleFallback) {
      needsVisibleFallback += 1;
      visibleFallbackCandidates.push(reconciled.entry);
    } else if (
      post.botId === normalizedOpts.botId &&
      (post.status === "planned" || post.status === "pending" || post.status === "failed")
    ) {
      skippedLive += 1;
    }
    return reconciled.entry;
  });
  const changed = sent > 0 || fallbackVisible > 0;
  return {
    file: changed ? { version: 1, posts } : data,
    result: { changed, sent, fallbackVisible, needsVisibleFallback, skippedLive },
    visibleFallbackCandidates,
  };
}

export async function reconcilePostFileOrphans(
  worktreePath: string,
  opts: ReconcilePostLedgerOpts,
): Promise<ReconcilePostLedgerResult & { visibleFallbackCandidates: PostLedgerEntry[] }> {
  const existing = await readPostFile(worktreePath);
  if (!existing) {
    return {
      changed: false,
      sent: 0,
      fallbackVisible: 0,
      needsVisibleFallback: 0,
      skippedLive: 0,
      visibleFallbackCandidates: [],
    };
  }

  const { file, result, visibleFallbackCandidates } = reconcilePostLedgerEntries(existing, opts);
  if (result.changed) {
    await writePostFile(worktreePath, file);
  }
  return { ...result, visibleFallbackCandidates };
}

export async function markPostLedgerFallbackVisible(
  worktreePath: string,
  idempotencyKey: string,
  opts: {
    fallbackCardMessageId: string;
    error: string;
    now?: () => string;
  },
): Promise<PostFile> {
  const existing = (await readPostFile(worktreePath)) ?? emptyPostFile();
  const idx = existing.posts.findIndex((post) => post.idempotencyKey === idempotencyKey);
  if (idx < 0) {
    throw new Error(`post ledger entry not found: ${idempotencyKey}`);
  }

  const current = existing.posts[idx];
  assertPostStatusTransition(current.status, "fallback_visible");
  const now = opts.now?.() ?? new Date().toISOString();
  const nextPosts = [...existing.posts];
  nextPosts[idx] = {
    ...current,
    status: "fallback_visible",
    fallbackCardMessageId: opts.fallbackCardMessageId,
    error: opts.error,
    updatedAt: now,
    attempts: [
      ...current.attempts,
      {
        attemptedAt: now,
        status: "failed",
        retryable: false,
        code: "orphan_reconcile",
        error: opts.error,
      },
    ],
  };

  const next = { version: 1 as const, posts: nextPosts };
  await writePostFile(worktreePath, next);
  return next;
}
