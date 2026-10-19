import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WSClient } from "@larksuiteoapi/node-sdk";
import { silentSdkLogger } from "./sdkLogger.js";

// Exercise the pinned SDK without a real socket or credentials. Private seams
// let us reproduce the late-abort race that previously escaped our crash guard.
type Internals = {
  wsConfig: { setWSInstance(socket: unknown): void; getWSInstance(): unknown };
  pullConnectConfig(): Promise<{ ok: boolean; retryable?: boolean }>;
  reConnect(start: boolean): Promise<void>;
};
const clients: WSClient[] = [];
function client() {
  const ws = new WSClient({ appId: "cli_0000000000000000", appSecret: "fixture", logger: silentSdkLogger });
  clients.push(ws);
  return { ws, internals: ws as unknown as Internals };
}
afterEach(() => { for (const ws of clients.splice(0)) ws.close({ force: true }); vi.useRealTimers(); });

describe("pinned SDK WebSocket shutdown regressions", () => {
  it.each([false, true])("absorbs repeated late socket errors after close(force=%s)", (force) => {
    const { ws, internals } = client();
    const socket = Object.assign(new EventEmitter(), { close: vi.fn(), terminate: vi.fn() });
    internals.wsConfig.setWSInstance(socket);
    ws.close({ force });
    expect(force ? socket.terminate : socket.close).toHaveBeenCalledOnce();
    expect(() => {
      socket.emit("error", new Error("handshake aborted"));
      socket.emit("error", new Error("late reset"));
    }).not.toThrow();
    expect(internals.wsConfig.getWSInstance()).toBeNull();
  });

  it("does not resurrect retries when close races with discovery", async () => {
    vi.useFakeTimers();
    const { ws, internals } = client();
    let finish!: (value: { ok: boolean; retryable: boolean }) => void;
    const pull = vi.spyOn(internals, "pullConnectConfig").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const attempt = internals.reConnect(true);
    ws.close({ force: true });
    finish({ ok: false, retryable: true });
    await attempt;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pull).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
