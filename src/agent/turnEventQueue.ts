/**
 * src/agent/turnEventQueue.ts
 *
 * Minimal pull-based async queue, one per in-flight turn. Shared by every
 * warm-process pool (src/codex/pool.ts, src/claude/pool.ts): a pooled runner
 * multiplexes several turns' wire-protocol notifications onto one (codex) or
 * several (claude — one per warm child) shared streams, and each turn needs
 * its own ordered event sink independent of the others' consumption pace.
 *
 * Extracted here (rather than duplicated per backend) once a second pool
 * implementation needed the exact same class — see CodexProcessPool's
 * original inline copy, moved here unchanged.
 */

import type { AgentStreamEvent } from "./runner.js";

export class TurnEventQueue implements AsyncIterable<AgentStreamEvent> {
  private readonly buffer: AgentStreamEvent[] = [];
  private readonly waiters: Array<(v: IteratorResult<AgentStreamEvent>) => void> = [];
  private ended = false;

  push(ev: AgentStreamEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.buffer.push(ev);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentStreamEvent> {
    for (;;) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<AgentStreamEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
