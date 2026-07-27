import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskHandleStore } from "./store.js";
import { applyVerifiedClaim } from "./claim.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "larkway-claim-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function patch(taskGuid: string) {
  return { botId: "bot-1", threadId: "om_thread", chatId: "oc_chat", taskGuid };
}

/** getTask stub: resolves for known guids, null (404-like) otherwise. */
function client(known: readonly string[], throwFor?: string) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async getTask(guid: string) {
        calls.push(guid);
        if (guid === throwFor) throw new Error("403 permission denied");
        return known.includes(guid) ? ({ guid } as never) : null;
      },
    },
  };
}

describe("applyVerifiedClaim", () => {
  it("records a claim whose guid resolves to a real task", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { client: c, calls } = client(["g-real"]);

    const out = await applyVerifiedClaim(patch("g-real"), { store, client: c, botId: "bot-1", warn: () => {} });

    expect(out).toEqual({ recorded: true, verified: true });
    expect(store.get("om_thread")?.taskGuid).toBe("g-real");
    expect(calls).toEqual(["g-real"]);
  });

  // The 2026-07-27 real-machine failure: an agent declared the TASKLIST guid.
  it("refuses a guid that does not resolve to a task, leaving the store untouched", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { client: c } = client(["g-real"]);
    const warnings: string[] = [];

    const out = await applyVerifiedClaim(patch("tasklist-guid"), {
      store,
      client: c,
      botId: "bot-1",
      warn: (m) => warnings.push(m),
    });

    expect(out).toEqual({ recorded: false, reason: "unresolvable_guid" });
    expect(store.get("om_thread")).toBeUndefined();
    // The old log blamed a missing scope; the message must name the real cause.
    expect(warnings.join(" ")).toContain("TASKLIST guid");
  });

  it("also refuses when the lookup throws (403) rather than returning 404", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { client: c } = client([], "g-forbidden");

    const out = await applyVerifiedClaim(patch("g-forbidden"), {
      store,
      client: c,
      botId: "bot-1",
      warn: () => {},
    });

    expect(out).toEqual({ recorded: false, reason: "unresolvable_guid" });
    expect(store.get("om_thread")).toBeUndefined();
  });

  // A maintaining agent re-declares the same guid every turn — that must not
  // cost an API call, or the guard would tax the steady state.
  it("skips the lookup when the thread already holds this exact guid", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { client: c, calls } = client(["g-real"]);
    await applyVerifiedClaim(patch("g-real"), { store, client: c, botId: "bot-1", warn: () => {} });
    calls.length = 0;

    const out = await applyVerifiedClaim(patch("g-real"), { store, client: c, botId: "bot-1", warn: () => {} });

    expect(out).toEqual({ recorded: true, verified: false });
    expect(calls).toEqual([]);
  });

  it("verifies again when the thread switches to a different guid", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { client: c, calls } = client(["g-one", "g-two"]);
    await applyVerifiedClaim(patch("g-one"), { store, client: c, botId: "bot-1", warn: () => {} });
    calls.length = 0;

    await applyVerifiedClaim(patch("g-two"), { store, client: c, botId: "bot-1", warn: () => {} });

    expect(calls).toEqual(["g-two"]);
    expect(store.get("om_thread")?.taskGuid).toBe("g-two");
  });

  it("reports a store-level rejection without pretending the claim landed", async () => {
    const store = await TaskHandleStore.load(join(dir, "task-handles.json"));
    const { client: c } = client(["g-real"]);
    vi.spyOn(store, "claim").mockResolvedValue({ claimed: false, reason: "already claimed by another thread" });

    const out = await applyVerifiedClaim(patch("g-real"), { store, client: c, botId: "bot-1", warn: () => {} });

    expect(out).toMatchObject({ recorded: false, reason: "store_rejected" });
  });
});
