import fs from "node:fs/promises";
import { z } from "zod";

/** Explicit presentation data. Never infer progress from the agent's prose. */
export const CardProgressSchema = z.object({
  message_id: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(2_000),
});

/** One running card observes only declarations addressed to its trigger. */
export class TaskCardProgress {
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<void>;
  private closed = false;
  private latest = "";
  private onProgress?: (text: string) => void;
  constructor(private readonly opts: { stateFile: string; messageId: string; intervalMs?: number }) {}

  get hasProgress(): boolean { return !!this.latest; }
  get latestText(): string { return this.latest; }

  start(onProgress: (text: string) => void): void {
    if (this.closed || this.timer) return;
    this.onProgress = onProgress;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, this.opts.intervalMs ?? 1_000);
    this.timer.unref?.();
  }

  private sample(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.checking) return this.checking;
    this.checking = this.read().catch((err: unknown) => {
      // A temporary/partial state file must not erase the last stable summary.
      if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[task-card-progress] state read failed:", err);
      }
    }).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async read(): Promise<void> {
    const state: unknown = JSON.parse(await fs.readFile(this.opts.stateFile, "utf8"));
    const declaration = CardProgressSchema.safeParse(
      state && typeof state === "object" ? (state as Record<string, unknown>)["card_progress"] : undefined,
    );
    if (this.closed || !declaration.success || declaration.data.message_id !== this.opts.messageId) return;
    const text = declaration.data.text;
    if (text === this.latest) return;
    this.latest = text;
    this.onProgress?.(text);
  }

  /** Stop before finalization; include the last atomic state write. */
  async finish(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.checking;
    await this.sample();
    this.closed = true;
  }
}
