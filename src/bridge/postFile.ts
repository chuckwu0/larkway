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
  planned: ["pending", "policy_blocked"],
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
