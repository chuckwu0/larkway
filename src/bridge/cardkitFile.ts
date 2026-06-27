import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CardKitFileSchema = z.object({
  surface: z.literal("cardkit_stream"),
  status: z
    .enum(["planned", "message_sent", "streaming", "finalized", "fallback_visible", "failed"])
    .default("planned"),
  cardId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().min(1),
  botId: z.string().min(1),
  larkCliProfile: z.string().min(1).optional(),
  replyInThread: z.boolean().default(true),
  idempotencyKey: z.string().min(1),
  sequence: z.number().int().nonnegative().default(0),
  elements: z
    .object({
      status: z.object({ elementId: z.string().min(1) }).optional(),
      thinking: z.object({ elementId: z.string().min(1) }).optional(),
      footer: z.object({ elementId: z.string().min(1) }).optional(),
      final: z.object({ elementId: z.string().min(1) }),
    })
    .optional(),
  lastVisibleFallbackMessageId: z.string().min(1).nullable().default(null),
  retryCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type CardKitFile = z.infer<typeof CardKitFileSchema>;

export function cardkitDirOf(worktreePath: string): string {
  return path.join(worktreePath, ".larkway");
}

export function cardkitFilePathOf(worktreePath: string): string {
  return path.join(cardkitDirOf(worktreePath), "cardkit.json");
}

export async function writeCardKitFile(
  worktreePath: string,
  data: z.input<typeof CardKitFileSchema>,
): Promise<void> {
  const dir = cardkitDirOf(worktreePath);
  const file = cardkitFilePathOf(worktreePath);
  await fs.mkdir(dir, { recursive: true });
  const parsed = CardKitFileSchema.parse(data);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readCardKitFile(
  worktreePath: string,
): Promise<CardKitFile | null> {
  const file = cardkitFilePathOf(worktreePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[cardkitFile] read ${file} failed:`, err);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[cardkitFile] ${file} not valid JSON:`, err);
    return null;
  }
  const result = CardKitFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[cardkitFile] ${file} failed schema validation:`, result.error.issues);
    return null;
  }
  return result.data;
}

export async function deleteCardKitFile(worktreePath: string): Promise<void> {
  const file = cardkitFilePathOf(worktreePath);
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    console.warn(`[cardkitFile] delete ${file} failed (ignoring):`, err);
  }
}
