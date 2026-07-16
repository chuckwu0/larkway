import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import {
  BotScheduler,
  cronEntryKey,
  decideCronDue,
  decideOneShotDue,
  type FireRequest,
} from "./scheduler.js";

let botDir: string;

beforeEach(async () => {
  botDir = await mkdtemp(path.join(tmpdir(), "larkway-scheduler-test-"));
});

afterEach(async () => {
  await rm(botDir, { recursive: true, force: true });
});

function makeScheduler(opts: {
  schedules?: ConstructorParameters<typeof BotScheduler>[0]["schedules"];
  defaultChatId?: string;
  now: () => Date;
  fireResult?: boolean;
}) {
  const fired: FireRequest[] = [];
  const scheduler = new BotScheduler({
    botId: "test-bot",
    botDir,
    schedules: opts.schedules ?? [],
    defaultChatId: opts.defaultChatId,
    now: opts.now,
    log: () => undefined,
    fire: async (req) => {
      fired.push(req);
      return opts.fireResult ?? true;
    },
  });
  return { scheduler, fired };
}

/** Drive one tick without timers — start() arms real intervals; tests use the
 *  public tickOnce() seam instead. */
async function tickOnce(scheduler: BotScheduler): Promise<void> {
  await scheduler.tickOnce();
}

describe("decideCronDue", () => {
  const now = new Date("2026-07-17T08:35:00Z");

  it("not due when next fire is in the future", () => {
    expect(decideCronDue(new Date("2026-07-17T08:36:00Z"), now, 10)).toEqual({ kind: "not_due" });
  });

  it("fires when due within grace", () => {
    expect(decideCronDue(new Date("2026-07-17T08:30:00Z"), now, 10)).toEqual({ kind: "fire" });
  });

  it("skips when overdue beyond grace", () => {
    const d = decideCronDue(new Date("2026-07-17T07:30:00Z"), now, 10);
    expect(d.kind).toBe("misfire_skip");
  });
});

describe("decideOneShotDue", () => {
  const now = new Date("2026-07-17T08:35:00Z");

  it("not due before `at`", () => {
    expect(decideOneShotDue({ at: "2026-07-17T09:00:00Z", prompt: "p" }, now)).toEqual({
      kind: "not_due",
    });
  });

  it("fires after `at` regardless of age by default (fire-on-recovery)", () => {
    expect(decideOneShotDue({ at: "2026-07-16T08:00:00Z", prompt: "p" }, now)).toEqual({
      kind: "fire",
    });
  });

  it("expires when overdue beyond expire_after", () => {
    expect(
      decideOneShotDue({ at: "2026-07-17T08:00:00Z", prompt: "p", expire_after: 10 }, now),
    ).toEqual({ kind: "expired" });
  });

  it("treats unparseable `at` as expired (never loops)", () => {
    expect(decideOneShotDue({ at: "not-a-date", prompt: "p" }, now)).toEqual({ kind: "expired" });
  });
});

describe("BotScheduler cron state", () => {
  it("first boot seeds next_fire_at forward without firing", async () => {
    const { scheduler, fired } = makeScheduler({
      schedules: [{ cron: "30 8 * * *", prompt: "morning", chat_id: "oc_x" }],
      now: () => new Date(2026, 6, 17, 9, 0, 0), // 09:00 local, past today's 08:30
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(0);
    const state = JSON.parse(await readFile(path.join(botDir, "schedule-state.json"), "utf8"));
    const key = cronEntryKey(0, { cron: "30 8 * * *", prompt: "morning" });
    // Seeded to TOMORROW 08:30 local — never backfires on boot.
    expect(new Date(state.cron[key].next_fire_at)).toEqual(new Date(2026, 6, 18, 8, 30, 0));
  });

  it("fires a due entry and advances", async () => {
    // Seed state as if the bridge had scheduled 08:30 today, then tick at 08:31.
    const key = cronEntryKey(0, { cron: "30 8 * * *", prompt: "morning" });
    await writeFile(
      path.join(botDir, "schedule-state.json"),
      JSON.stringify({
        version: 1,
        cron: { [key]: { next_fire_at: new Date(2026, 6, 17, 8, 30, 0).toISOString() } },
      }),
      "utf8",
    );
    const { scheduler, fired } = makeScheduler({
      schedules: [{ cron: "30 8 * * *", prompt: "morning", note: "早报", chat_id: "oc_x" }],
      now: () => new Date(2026, 6, 17, 8, 31, 0),
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ source: "cron", prompt: "morning", chatId: "oc_x", note: "早报" });
    expect(fired[0]!.occurrence).toBe(new Date(2026, 6, 17, 8, 30, 0).toISOString());
    const state = JSON.parse(await readFile(path.join(botDir, "schedule-state.json"), "utf8"));
    expect(new Date(state.cron[key].next_fire_at)).toEqual(new Date(2026, 6, 18, 8, 30, 0));
  });

  it("skips (does not fire) past-grace misses but still advances", async () => {
    const key = cronEntryKey(0, { cron: "30 8 * * *", prompt: "morning" });
    await writeFile(
      path.join(botDir, "schedule-state.json"),
      JSON.stringify({
        version: 1,
        cron: { [key]: { next_fire_at: new Date(2026, 6, 17, 8, 30, 0).toISOString() } },
      }),
      "utf8",
    );
    const { scheduler, fired } = makeScheduler({
      schedules: [{ cron: "30 8 * * *", prompt: "morning", chat_id: "oc_x" }],
      now: () => new Date(2026, 6, 17, 15, 0, 0), // Mac slept through the morning
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(0);
    const state = JSON.parse(await readFile(path.join(botDir, "schedule-state.json"), "utf8"));
    expect(new Date(state.cron[key].next_fire_at)).toEqual(new Date(2026, 6, 18, 8, 30, 0));
  });

  it("drops persisted state for entries removed from config", async () => {
    await writeFile(
      path.join(botDir, "schedule-state.json"),
      JSON.stringify({
        version: 1,
        cron: { "0:0 0 * * *": { next_fire_at: new Date(2027, 0, 1).toISOString() } },
      }),
      "utf8",
    );
    const { scheduler } = makeScheduler({
      schedules: [{ cron: "30 8 * * *", prompt: "morning", chat_id: "oc_x" }],
      now: () => new Date(2026, 6, 17, 9, 0, 0),
    });
    await tickOnce(scheduler);
    const state = JSON.parse(await readFile(path.join(botDir, "schedule-state.json"), "utf8"));
    expect(state.cron["0:0 0 * * *"]).toBeUndefined();
  });

  it("skips disabled and unparseable entries at construction", () => {
    const { scheduler } = makeScheduler({
      schedules: [
        { cron: "30 8 * * *", prompt: "on", chat_id: "oc_x" },
        { cron: "30 8 * * *", prompt: "off", chat_id: "oc_x", enabled: false },
        { cron: "not a cron", prompt: "bad", chat_id: "oc_x" },
      ],
      now: () => new Date(),
    });
    expect(scheduler.cronCount).toBe(1);
  });
});

describe("BotScheduler one-shot wakes", () => {
  it("fires a due wake and consumes the file", async () => {
    const wakesDir = path.join(botDir, "wakes");
    await mkdir(wakesDir, { recursive: true });
    await writeFile(
      path.join(wakesDir, "wake-1.json"),
      JSON.stringify({ at: "2026-07-17T00:00:00Z", prompt: "task due", note: "任务到期" }),
      "utf8",
    );
    const { scheduler, fired } = makeScheduler({
      defaultChatId: "oc_default",
      now: () => new Date("2026-07-17T00:01:00Z"),
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      source: "oneshot",
      prompt: "task due",
      chatId: "oc_default",
      occurrence: "2026-07-17T00:00:00Z",
    });
    expect(await readdir(wakesDir)).toEqual([]);
  });

  it("keeps the file for retry when fire fails", async () => {
    const wakesDir = path.join(botDir, "wakes");
    await mkdir(wakesDir, { recursive: true });
    await writeFile(
      path.join(wakesDir, "wake-1.json"),
      JSON.stringify({ at: "2026-07-17T00:00:00Z", prompt: "task due" }),
      "utf8",
    );
    const { scheduler, fired } = makeScheduler({
      defaultChatId: "oc_default",
      now: () => new Date("2026-07-17T00:01:00Z"),
      fireResult: false,
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(1);
    expect(await readdir(wakesDir)).toEqual(["wake-1.json"]);
  });

  it("leaves future wakes queued", async () => {
    const wakesDir = path.join(botDir, "wakes");
    await mkdir(wakesDir, { recursive: true });
    await writeFile(
      path.join(wakesDir, "wake-1.json"),
      JSON.stringify({ at: "2026-07-18T00:00:00Z", prompt: "later" }),
      "utf8",
    );
    const { scheduler, fired } = makeScheduler({
      defaultChatId: "oc_default",
      now: () => new Date("2026-07-17T00:00:00Z"),
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(0);
    expect(await readdir(wakesDir)).toEqual(["wake-1.json"]);
  });

  it("drops expired and malformed wakes without firing", async () => {
    const wakesDir = path.join(botDir, "wakes");
    await mkdir(wakesDir, { recursive: true });
    await writeFile(
      path.join(wakesDir, "wake-expired.json"),
      JSON.stringify({ at: "2026-07-17T00:00:00Z", prompt: "stale", expire_after: 5 }),
      "utf8",
    );
    await writeFile(path.join(wakesDir, "wake-bad.json"), "{not json", "utf8");
    const { scheduler, fired } = makeScheduler({
      defaultChatId: "oc_default",
      now: () => new Date("2026-07-17T01:00:00Z"),
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(0);
    expect(await readdir(wakesDir)).toEqual([]);
  });

  it("drops a due wake with no resolvable chat", async () => {
    const wakesDir = path.join(botDir, "wakes");
    await mkdir(wakesDir, { recursive: true });
    await writeFile(
      path.join(wakesDir, "wake-1.json"),
      JSON.stringify({ at: "2026-07-17T00:00:00Z", prompt: "task due" }),
      "utf8",
    );
    const { scheduler, fired } = makeScheduler({
      now: () => new Date("2026-07-17T00:01:00Z"),
    });
    await tickOnce(scheduler);
    expect(fired).toHaveLength(0);
    expect(await readdir(wakesDir)).toEqual([]);
  });
});
