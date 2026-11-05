import type { SteerResult } from "../agent/runner.js";

type RecordValue = Record<string, unknown>;
type Pending = { resolve: (result: SteerResult) => void; timer: ReturnType<typeof setTimeout>; threadId: string; turnId: string };

/** JSON-RPC acknowledgements, independent of turn completion and model output. */
export class CodexSteering {
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly send: (params: RecordValue) => number, private readonly timeoutMs = 15_000,
    private readonly forget?: (id: number) => void) {}

  steer(threadId: string | undefined, turnId: string | undefined, prompt: string): Promise<SteerResult> {
    if (!threadId || !turnId) return Promise.resolve({ status: "rejected", reason: "No active native turn" });
    return new Promise((resolve) => {
      // A throwing write can still have reached the pipe. Fail closed.
      let id: number;
      try {
        id = this.send({ threadId, expectedTurnId: turnId, input: [{ type: "text", text: prompt, text_elements: [] }] });
      } catch {
        resolve({ status: "unknown", reason: "Steer write could not be confirmed" });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.forget?.(id);
        resolve({ status: "unknown", reason: "Steer acknowledgement timed out" });
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer, threadId, turnId });
    });
  }

  response(id: number, response: RecordValue): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    this.forget?.(id);
    clearTimeout(pending.timer);
    const error = response.error as RecordValue | undefined;
    const result = response.result as RecordValue | undefined;
    if (error) {
      const rejected = [-32600, -32601, -32602].includes(Number(error.code));
      pending.resolve({ status: rejected ? "rejected" : "unknown", reason: String(error.message ?? "Steer request failed") });
    } else if (result?.turnId === pending.turnId) {
      pending.resolve({ status: "accepted", threadId: pending.threadId, turnId: pending.turnId });
    } else {
      pending.resolve({ status: "unknown", reason: "Steer response did not identify the expected turn" });
    }
    return true;
  }

  disconnected(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.forget?.(id);
      pending.resolve({ status: "unknown", reason: "Connection closed before steer acknowledgement" });
    }
    this.pending.clear();
  }
}
