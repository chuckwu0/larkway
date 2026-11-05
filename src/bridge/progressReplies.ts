import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { OutboundPostClient } from "../lark/outboundPostClient.js";
import { buildPostContent } from "../lark/postContent.js";
import { safeIdempotencyKey } from "../lark/outboundPostClient.js";

const PAGE_BYTES = 6_000;

/** Completed native user-facing messages; no interpretation, summarisation or task writeback. */
export class ProgressReplies {
  private readonly messages = new Map<string, string>();
  private readonly links = new Map<number, string | undefined>();
  private tail: Promise<void> = Promise.resolve();
  private archiveFailed = false;
  private cachedPages?: string[];
  private latest = "";
  onChange?: () => void;
  constructor(private readonly opts: { file: string; replyTo: string; postClient?: OutboundPostClient; replyInThread: boolean;
    messageLink?: (messageId: string) => Promise<string | undefined> }) {}

  add(itemId: string, text: string): void {
    if (!text.trim() || this.messages.has(itemId)) return;
    this.messages.set(itemId, text);
    this.latest = text;
    this.cachedPages = undefined;
    this.tail = this.tail.then(async () => {
      // Keep the full record even when a platform card reaches its size budget.
      await fs.mkdir(path.dirname(this.opts.file), { recursive: true });
      const temp = this.opts.file + "." + randomUUID() + ".tmp";
      await fs.writeFile(temp, JSON.stringify([...this.messages]), { mode: 0o600 });
      await fs.rename(temp, this.opts.file);
      const pages = this.pages();
      for (let i = 0; i < pages.length - 1; i++) {
        if (this.links.has(i) || !this.opts.postClient) continue;
        const digest = createHash("sha256").update(pages[i]!).digest("hex");
        const sent = await this.opts.postClient.createPostReply(this.opts.replyTo, buildPostContent({
          text: `较早回复 · 第 ${i + 1} 段\n\n${pages[i]}`, mentions: [],
          links: i > 0 && this.links.get(i - 1) ? [{ text: "更早回复", href: this.links.get(i - 1)! }] : [],
        }), { replyInThread: this.opts.replyInThread, idempotencyKey: safeIdempotencyKey(this.opts.file + digest) });
        // Record the successful post BEFORE resolving its optional deep link.
        this.links.set(i, undefined);
        const link = await this.opts.messageLink?.(sent.messageId).catch(() => undefined);
        if (link) this.links.set(i, link);
        this.onChange?.();
      }
    }).catch((err: unknown) => { this.archiveFailed = true; this.onChange?.(); console.warn("[progress-replies] archive failed:", err); });
  }
  private pages(): string[] {
    if (this.cachedPages) return this.cachedPages;
    const pages: string[] = []; let parts: string[] = [], bytes = 0, first = true;
    for (const text of this.messages.values()) {
      for (const char of (first ? "" : "\n\n---\n\n") + text) {
        const size = Buffer.byteLength(char);
        if (bytes + size > PAGE_BYTES) { pages.push(parts.join("")); parts = []; bytes = 0; }
        parts.push(char); bytes += size;
      }
      first = false;
    }
    if (parts.length) pages.push(parts.join(""));
    this.cachedPages = pages;
    return pages;
  }
  get hasMessages(): boolean { return this.messages.size > 0; }
  get latestText(): string {
    return Buffer.byteLength(this.latest) <= PAGE_BYTES ? this.latest : "…\n\n" + Array.from(this.latest).slice(-1_400).join("");
  }
  render(): string {
    const pages = this.pages();
    if (!pages.length) return "";
    const links = [...this.links].slice(-5).filter(([, link]) => !!link).map(([i, link]) => `[第 ${i + 1} 段](${link})`).join(" · ");
    const unlinked = [...this.links.values()].filter((link) => !link).length;
    const pending = pages.length - 1 - this.links.size;
    const note = pending > 0 && (this.archiveFailed || !this.opts.postClient) ? `\n\n_${pending} 段较早回复暂未能显示。_` : "";
    return `${links ? `较早回复：${links}\n\n` : ""}${unlinked ? `${unlinked} 段较早回复已发在本话题。\n\n` : ""}${pages.at(-1)}${note}`;
  }
  async drain(): Promise<void> { await this.tail; }
}
