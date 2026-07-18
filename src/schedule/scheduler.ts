/**
 * src/schedule/scheduler.ts
 *
 * Bot scheduler — a dumb alarm clock (docs/schedule.md).
 *
 * Thin-channel contract: the scheduler NEVER interprets prompts, never reads
 * business state (task boards, repos, chat history), and fires unconditionally
 * at the configured instant. "Is there actually anything to do?" is the woken
 * agent's first question, never the bridge's. Two alarm sources:
 *
 *   1. CRON schedules — declared in the bot's yaml (`schedules:`), evaluated
 *      in host-local time. Fire state (next_fire_at) is persisted to
 *      `<LARKWAY_HOME>/<botId>/schedule-state.json` so restarts don't refire.
 *   2. ONE-SHOT wakes — dropped as single JSON files into
 *      `<LARKWAY_HOME>/<botId>/wakes/` by `larkway wake` (typically invoked by
 *      the agent itself: "wake me when this task hits its due time"). A
 *      directory-of-files queue makes CLI-writes and bridge-consumes race-free
 *      without locking: the CLI creates files, the scheduler unlinks them
 *      after a successful fire.
 *
 * Firing is delegated to a callback wired by main.ts ("mirror + local
 * dispatch": one real Feishu note = the durable human-visible record and the
 * new topic anchor, then a synthesized turn pushed onto the bot's own inbound
 * queue — no Feishu inbound dependency). Mirror-first: fire() returning false
 * means the mirror post failed → cron advances anyway (logged; a missed patrol
 * is stale the moment it's late), one-shots stay queued for the next tick.
 *
 * Misfire policy (Mac sleeps; servers don't — same code path either way):
 *   - cron: overdue beyond `misfire_grace_minutes` (default 10) → skip + log,
 *     advance to the next occurrence. A 8:30 morning-report wake fired at 15:00
 *     is worse than none.
 *   - one-shot: fire on recovery regardless of age (default) — the woken agent
 *     re-verifies against its own source of truth (e.g. the task board) before
 *     acting, so a stale alarm degrades to a cheap no-op turn. `expire_after`
 *     minutes in the wake file opts out.
 *
 * Class shape (start/stop + unref'd timer + awaitable in-flight cycle)
 * follows tasklist/commentPoller.ts.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCron, nextFireAfter, type CronSpec } from "./cron.js";

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_MISFIRE_GRACE_MINUTES = 10;

// ---------------------------------------------------------------------------
// Config + persisted shapes
// ---------------------------------------------------------------------------

/** One `schedules:` entry from the bot yaml (already zod-validated). */
export interface BotScheduleConfig {
  cron: string;
  prompt: string;
  /** Short human label shown in the mirror note and logs. */
  note?: string;
  /** Target chat for the wake topic; falls back to the bot's schedule_chat_id. */
  chat_id?: string;
  enabled?: boolean;
  misfire_grace_minutes?: number;
}

/** Persisted cron fire-state — bridge-owned, never touched by the CLI. */
interface ScheduleStateFile {
  version: 1;
  /** key = stable id of the schedule entry → ISO next fire time. */
  cron: Record<string, { next_fire_at: string; last_fired_at?: string }>;
}

/** One-shot wake file dropped into wakes/ by `larkway wake`. */
export interface OneShotWake {
  /** ISO instant to fire at. */
  at: string;
  prompt: string;
  note?: string;
  chat_id?: string;
  /** Minutes after `at` beyond which a missed wake is dropped instead of fired. */
  expire_after?: number;
  created_at?: string;
}

export interface FireRequest {
  prompt: string;
  note?: string;
  chatId: string;
  source: "cron" | "oneshot";
  /** Stable id — cron entry key or wake filename — for logs/idempotency. */
  id: string;
  /**
   * ISO instant of the SCHEDULED occurrence (not the actual fire wall-time):
   * the due next_fire_at for cron, the wake's `at` for one-shots. Stable
   * across retries of the same occurrence, unique across occurrences — the
   * mirror post's idempotency key derives from it so a retried fire whose
   * first mirror actually landed doesn't double-post.
   */
  occurrence: string;
}

export interface BotSchedulerDeps {
  botId: string;
  /** `<LARKWAY_HOME>/<botId>` — state file + wakes/ live under here. */
  botDir: string;
  schedules: BotScheduleConfig[];
  /** Default target chat when a schedule/wake doesn't name one. */
  defaultChatId?: string;
  /** Mirror + local dispatch. Resolves true when the wake turn was dispatched. */
  fire: (req: FireRequest) => Promise<boolean>;
  /**
   * Hot-reload poll (docs/schedule.md): called at the top of every tick.
   * Resolve to a fresh config slice when the bot yaml's schedules changed,
   * null when unchanged or unreadable (null NEVER clears armed schedules).
   * Editing yaml `schedules:` therefore goes live within one tick — no
   * bridge restart. Unchanged entries (same index + cron expr) keep their
   * persisted next_fire_at; edited/added entries seed forward from now.
   */
  reloadConfig?: () => Promise<{
    schedules: BotScheduleConfig[];
    schedule_chat_id?: string;
  } | null>;
  log?: (line: string) => void;
  /** Test seam. */
  now?: () => Date;
}

export interface BotSchedulerOptions {
  /** @default 30_000 */
  tickMs?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without I/O)
// ---------------------------------------------------------------------------

/**
 * Stable identity for a cron entry: index + expression. Editing an entry's
 * cron/prompt in the yaml intentionally resets its persisted fire-state.
 */
export function cronEntryKey(index: number, entry: BotScheduleConfig): string {
  return `${index}:${entry.cron}`;
}

export type CronDueDecision =
  | { kind: "not_due" }
  | { kind: "fire" }
  | { kind: "misfire_skip"; overdueMinutes: number };

export function decideCronDue(
  nextFireAt: Date,
  now: Date,
  graceMinutes: number,
): CronDueDecision {
  if (nextFireAt.getTime() > now.getTime()) return { kind: "not_due" };
  const overdueMinutes = (now.getTime() - nextFireAt.getTime()) / 60_000;
  if (overdueMinutes > graceMinutes) return { kind: "misfire_skip", overdueMinutes };
  return { kind: "fire" };
}

export type OneShotDecision = { kind: "not_due" } | { kind: "fire" } | { kind: "expired" };

/** Stable identity of an applied schedule config, for silent-when-unchanged reloads. */
export function fingerprintConfig(
  schedules: BotScheduleConfig[],
  defaultChatId: string | undefined,
): string {
  return JSON.stringify([schedules, defaultChatId ?? null]);
}

export function decideOneShotDue(wake: OneShotWake, now: Date): OneShotDecision {
  const at = Date.parse(wake.at);
  if (Number.isNaN(at)) return { kind: "expired" }; // unparseable → drop, never loop
  if (at > now.getTime()) return { kind: "not_due" };
  if (wake.expire_after !== undefined) {
    const overdueMinutes = (now.getTime() - at) / 60_000;
    if (overdueMinutes > wake.expire_after) return { kind: "expired" };
  }
  return { kind: "fire" };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class BotScheduler {
  readonly #deps: BotSchedulerDeps;
  readonly #tickMs: number;
  readonly #statePath: string;
  readonly #wakesDir: string;
  #cron: Array<{ key: string; entry: BotScheduleConfig; spec: CronSpec }> = [];
  #defaultChatId: string | undefined;
  /** Fingerprint of the applied config — reload no-ops (and stays silent) when unchanged. */
  #configFingerprint: string;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  /** Awaitable current cycle — same M1 shutdown-drain shape as CommentPoller. */
  #inFlight: Promise<void> = Promise.resolve();

  constructor(deps: BotSchedulerDeps, opts?: BotSchedulerOptions) {
    this.#deps = deps;
    this.#tickMs = opts?.tickMs ?? DEFAULT_TICK_MS;
    this.#statePath = path.join(deps.botDir, "schedule-state.json");
    this.#wakesDir = path.join(deps.botDir, "wakes");
    this.#defaultChatId = deps.defaultChatId;
    this.#configFingerprint = fingerprintConfig(deps.schedules, deps.defaultChatId);
    this.#applyCronConfig(deps.schedules);
  }

  /** (Re)build the parsed cron entry list from a config slice. */
  #applyCronConfig(schedules: BotScheduleConfig[]): void {
    const next: Array<{ key: string; entry: BotScheduleConfig; spec: CronSpec }> = [];
    for (const [i, entry] of schedules.entries()) {
      if (entry.enabled === false) continue;
      try {
        next.push({ key: cronEntryKey(i, entry), entry, spec: parseCron(entry.cron) });
      } catch (err) {
        this.#log(`schedule entry ${i} skipped (bad cron "${entry.cron}"): ${String(err)}`);
      }
    }
    this.#cron = next;
  }

  #log(line: string): void {
    (this.#deps.log ?? ((s: string) => console.log(`[schedule] ${s}`)))(
      `bot "${this.#deps.botId}": ${line}`,
    );
  }

  #now(): Date {
    return this.#deps.now ? this.#deps.now() : new Date();
  }

  /** Number of active cron entries (post-parse). Exposed for startup logging. */
  get cronCount(): number {
    return this.#cron.length;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#timer = setInterval(() => {
      this.#inFlight = this.#inFlight.then(() => this.#tick()).catch(() => undefined);
    }, this.#tickMs);
    this.#timer.unref?.();
    // First tick soon after boot (not immediately: give the WS a moment to
    // connect so the mirror post has a live channel).
    setTimeout(() => {
      this.#inFlight = this.#inFlight.then(() => this.#tick()).catch(() => undefined);
    }, 5_000).unref?.();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  /**
   * Run exactly one tick, regardless of running state. Test seam + manual
   * ops poke — production cadence always goes through start()'s interval.
   */
  async tickOnce(): Promise<void> {
    const wasRunning = this.#running;
    this.#running = true;
    try {
      await this.#tick();
    } finally {
      this.#running = wasRunning;
    }
  }

  // -- state file ------------------------------------------------------------

  async #readState(): Promise<ScheduleStateFile> {
    try {
      const raw = await readFile(this.#statePath, "utf8");
      const parsed = JSON.parse(raw) as ScheduleStateFile;
      if (parsed && parsed.version === 1 && parsed.cron && typeof parsed.cron === "object") {
        return parsed;
      }
    } catch {
      /* first run / unreadable → fresh state */
    }
    return { version: 1, cron: {} };
  }

  async #writeState(state: ScheduleStateFile): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const tmp = `${this.#statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.#statePath);
  }

  // -- tick ------------------------------------------------------------------

  async #tick(): Promise<void> {
    if (!this.#running) return;
    try {
      await this.#maybeReloadConfig();
    } catch (err) {
      this.#log(`config reload failed (keeping current schedules): ${String(err)}`);
    }
    try {
      await this.#tickCron();
    } catch (err) {
      this.#log(`cron tick failed (next tick retries): ${String(err)}`);
    }
    try {
      await this.#tickOneShots();
    } catch (err) {
      this.#log(`one-shot tick failed (next tick retries): ${String(err)}`);
    }
  }

  /** Hot-reload: apply a changed yaml schedules slice mid-flight (docs/schedule.md). */
  async #maybeReloadConfig(): Promise<void> {
    if (!this.#deps.reloadConfig) return;
    const next = await this.#deps.reloadConfig();
    if (!next) return; // unchanged or unreadable — keep current
    const fingerprint = fingerprintConfig(next.schedules, next.schedule_chat_id);
    if (fingerprint === this.#configFingerprint) return;
    this.#configFingerprint = fingerprint;
    this.#defaultChatId = next.schedule_chat_id;
    this.#applyCronConfig(next.schedules);
    this.#log(
      `schedules hot-reloaded from yaml: ${this.#cron.length} active cron entr${this.#cron.length === 1 ? "y" : "ies"} (no restart needed)`,
    );
  }

  async #tickCron(): Promise<void> {
    if (this.#cron.length === 0) return;
    const now = this.#now();
    const state = await this.#readState();
    let dirty = false;

    for (const { key, entry, spec } of this.#cron) {
      const persisted = state.cron[key]?.next_fire_at;
      let nextFireAt = persisted ? new Date(persisted) : undefined;
      if (!nextFireAt || Number.isNaN(nextFireAt.getTime())) {
        // First boot for this entry: schedule forward from now, never backfire.
        const next = nextFireAfter(spec, now);
        if (!next) {
          this.#log(`cron "${entry.cron}" has no future occurrence — entry idle`);
          continue;
        }
        state.cron[key] = { next_fire_at: next.toISOString() };
        dirty = true;
        continue;
      }

      const grace = entry.misfire_grace_minutes ?? DEFAULT_MISFIRE_GRACE_MINUTES;
      const decision = decideCronDue(nextFireAt, now, grace);
      if (decision.kind === "not_due") continue;

      const advance = nextFireAfter(spec, now);
      if (decision.kind === "misfire_skip") {
        this.#log(
          `cron "${entry.cron}" missed by ${decision.overdueMinutes.toFixed(1)}min ` +
            `(> grace ${grace}min) — skipped, next at ${advance?.toISOString() ?? "never"}`,
        );
      } else {
        const chatId = entry.chat_id ?? this.#defaultChatId;
        if (!chatId) {
          this.#log(`cron "${entry.cron}" due but no chat_id/schedule_chat_id — skipped`);
        } else {
          const ok = await this.#deps.fire({
            prompt: entry.prompt,
            note: entry.note,
            chatId,
            source: "cron",
            id: key,
            occurrence: nextFireAt.toISOString(),
          });
          this.#log(
            `cron "${entry.cron}" fired (${entry.note ?? "no note"}): ` +
              (ok ? "dispatched" : "mirror/dispatch failed — advancing anyway"),
          );
          const cur = state.cron[key];
          if (cur) cur.last_fired_at = now.toISOString();
        }
      }
      state.cron[key] = {
        ...(state.cron[key] ?? {}),
        next_fire_at: advance ? advance.toISOString() : new Date(8640000000000000).toISOString(),
      };
      dirty = true;
    }

    // Drop persisted state for entries no longer in the config.
    for (const key of Object.keys(state.cron)) {
      if (!this.#cron.some((c) => c.key === key)) {
        delete state.cron[key];
        dirty = true;
      }
    }

    if (dirty) await this.#writeState(state);
  }

  async #tickOneShots(): Promise<void> {
    let files: string[];
    try {
      files = (await readdir(this.#wakesDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return; // wakes/ doesn't exist yet — nothing queued
    }
    if (files.length === 0) return;
    const now = this.#now();

    for (const file of files.sort()) {
      const full = path.join(this.#wakesDir, file);
      let wake: OneShotWake;
      try {
        wake = JSON.parse(await readFile(full, "utf8")) as OneShotWake;
      } catch (err) {
        this.#log(`wake file ${file} unreadable — removing: ${String(err)}`);
        await unlink(full).catch(() => undefined);
        continue;
      }
      if (!wake || typeof wake.at !== "string" || typeof wake.prompt !== "string") {
        this.#log(`wake file ${file} malformed (need {at, prompt}) — removing`);
        await unlink(full).catch(() => undefined);
        continue;
      }

      const decision = decideOneShotDue(wake, now);
      if (decision.kind === "not_due") continue;
      if (decision.kind === "expired") {
        this.#log(`wake ${file} expired (at=${wake.at}) — dropped without firing`);
        await unlink(full).catch(() => undefined);
        continue;
      }

      const chatId = wake.chat_id ?? this.#defaultChatId;
      if (!chatId) {
        this.#log(`wake ${file} due but no chat_id/schedule_chat_id — dropped`);
        await unlink(full).catch(() => undefined);
        continue;
      }
      const ok = await this.#deps.fire({
        prompt: wake.prompt,
        note: wake.note,
        chatId,
        source: "oneshot",
        id: file,
        occurrence: wake.at,
      });
      if (ok) {
        await unlink(full).catch(() => undefined);
        this.#log(`wake ${file} fired (${wake.note ?? "no note"})`);
      } else {
        // Keep the file — the next tick retries (mirror send may have hit a
        // transient Feishu failure). expire_after still bounds total retries.
        this.#log(`wake ${file} fire failed — kept for retry`);
      }
    }
  }
}
