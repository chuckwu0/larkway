import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSteering } from "./steering.js";

afterEach(() => vi.useRealTimers());
describe("native steering acknowledgements", () => {
  it("binds input to the expected turn and accepts only its acknowledgement", async () => {
    const send = vi.fn(() => 7), broker = new CodexSteering(send);
    const delivery = broker.steer("thread-a", "turn-a", "Please use the corrected requirement");
    expect(send).toHaveBeenCalledWith({ threadId: "thread-a", expectedTurnId: "turn-a", input: [expect.objectContaining({ text: "Please use the corrected requirement" })] });
    expect(broker.response(9, { result: { turnId: "turn-a" } })).toBe(false);
    broker.response(7, { result: { turnId: "turn-a" } });
    expect(await delivery).toEqual({ status: "accepted", threadId: "thread-a", turnId: "turn-a" });
  });
  it.each([-32600, -32601, -32602])("permits ordinary queuing after explicit rejection %s", async (code) => {
    const broker = new CodexSteering(() => 1), delivery = broker.steer("t", "u", "input");
    broker.response(1, { error: { code, message: "not accepted" } });
    expect((await delivery).status).toBe("rejected");
  });
  it("does not claim a lost or mismatched acknowledgement is safe to replay", async () => {
    vi.useFakeTimers();
    const broker = new CodexSteering(() => 1), delivery = broker.steer("t", "u", "input");
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await delivery).status).toBe("unknown");
    expect(broker.response(1, { result: { turnId: "u" } })).toBe(false);
    const next = broker.steer("t", "u", "input");
    broker.response(1, { result: { turnId: "other" } });
    expect((await next).status).toBe("unknown");
  });
  it("settles a disconnected send as unknown and refuses a missing turn without writing", async () => {
    const send = vi.fn(() => 1), broker = new CodexSteering(send);
    expect((await broker.steer("t", undefined, "input")).status).toBe("rejected");
    expect(send).not.toHaveBeenCalled();
    const delivery = broker.steer("t", "u", "input");
    broker.disconnected();
    expect((await delivery).status).toBe("unknown");
  });
});
