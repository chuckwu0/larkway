/**
 * src/tasklist/candidateAlertStore.ts
 *
 * v3.3 "候选黑洞提示" (docs/task-handle.md §14). A task can land in the shared
 * tasklist (someone converted a topic into it) and never get bound to any
 * thread — the title didn't exact-match any thread's root text (v3 auto-bind,
 * tasklistPoller.ts) AND no agent turn in any thread ever picked it as a
 * candidate match (the agent-path candidate injection). Nothing then ever
 * looks at it again: it sits in TasklistPoller's candidate snapshot forever,
 * structurally invisible to the "claimed = someone's managing it" invariant
 * this whole feature exists to uphold.
 *
 * TasklistPoller (the only caller) tracks, per unclaimed candidate guid, how
 * long it's been CONTINUOUSLY unclaimed; once that exceeds
 * `candidateUnboundAlertMs` (default 1h), it posts a one-time mechanical
 * comment on the task itself pointing a human at the mismatch. "Continuously"
 * matters: a guid that disappears from the poller's eligible-candidate set
 * (claimed, completed, or bridge-touched) and later reappears unclaimed again
 * is treated as a FRESH sighting, not a continuation — see
 * {@link CandidateAlertStore.reconcile}.
 *
 * Persisted (not just in-memory) so a bridge restart doesn't lose the "first
 * seen unbound at" clock (which would perpetually push the alert out) and
 * doesn't re-post an alert it already sent. Home-level, keyed by
 * tasklistGuid — mirrors TaskHandleStore's atomic-write shape (tmp + rename),
 * simplified: no claim semantics, just two timestamps per guid.
 */

import { rename, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface CandidateAlertRecord {
  /** ms epoch — when this guid was FIRST observed continuously unclaimed. */
  firstSeenUnboundAt: number;
  /** ms epoch — when the black-hole alert comment was posted. Undefined = not yet alerted. */
  alertedAt?: number;
}

interface AlertStoreFile {
  version: 1;
  records: Record<string, CandidateAlertRecord>;
}

function isCandidateAlertRecord(value: unknown): value is CandidateAlertRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["firstSeenUnboundAt"] === "number" && (v["alertedAt"] === undefined || typeof v["alertedAt"] === "number");
}

export class CandidateAlertStore {
  readonly #filePath: string;
  readonly #map: Map<string, CandidateAlertRecord>;

  private constructor(filePath: string, map: Map<string, CandidateAlertRecord>) {
    this.#filePath = filePath;
    this.#map = map;
  }

  /**
   * Load an existing file, or start fresh (empty, non-fatal) on any read/parse
   * failure — same best-effort posture as TaskHandleStore.load: this is
   * loaded inline in main.ts's tasklist-poller construction pass, so a thrown
   * error here would take down the whole pass, not just this one guid's alert
   * tracking. Unlike TaskHandleStore, there's no user-visible claim data to
   * lose here — losing this file just means every currently-unbound
   * candidate's "first seen" clock restarts, a delay, not data loss.
   */
  static async load(filePath: string): Promise<CandidateAlertStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return new CandidateAlertStore(filePath, new Map());
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || !("records" in parsed)) {
        return new CandidateAlertStore(filePath, new Map());
      }
      const records = (parsed as { records: unknown }).records;
      if (typeof records !== "object" || records === null) {
        return new CandidateAlertStore(filePath, new Map());
      }
      const map = new Map<string, CandidateAlertRecord>();
      for (const [guid, value] of Object.entries(records as Record<string, unknown>)) {
        if (isCandidateAlertRecord(value)) map.set(guid, value);
        // Malformed individual entries are just dropped (not fatal) — this
        // file is a cache of alert-timing facts, not authoritative state.
      }
      return new CandidateAlertStore(filePath, map);
    } catch {
      return new CandidateAlertStore(filePath, new Map());
    }
  }

  /**
   * Reconcile against THIS cycle's set of unclaimed candidate guids —
   * TasklistPoller calls this once per poll cycle with the guids it just
   * decided are still-eligible candidates. Any tracked guid NOT in that set
   * anymore (claimed / completed / bridge-touched since last cycle) is
   * dropped entirely — both its "first seen" clock and its "already alerted"
   * flag — so a candidate that gets bound and later becomes unbound again
   * (e.g. re-transferred) is treated as a fresh sighting, per the module doc.
   * Any NEW guid not seen before gets a fresh `firstSeenUnboundAt`. Does not
   * flush by itself — see {@link markAlerted}, the only mutation that must be
   * durable before the corresponding comment is trusted to have been sent.
   */
  reconcile(currentUnboundGuids: ReadonlySet<string>, now: number): void {
    for (const guid of this.#map.keys()) {
      if (!currentUnboundGuids.has(guid)) this.#map.delete(guid);
    }
    for (const guid of currentUnboundGuids) {
      if (!this.#map.has(guid)) this.#map.set(guid, { firstSeenUnboundAt: now });
    }
  }

  /** How long (ms) `guid` has been continuously unclaimed, per the current in-memory tracking — undefined if untracked (shouldn't happen right after `reconcile` for a guid that's actually in the current set). */
  unboundDurationMs(guid: string, now: number): number | undefined {
    const record = this.#map.get(guid);
    return record ? now - record.firstSeenUnboundAt : undefined;
  }

  /** Whether the black-hole alert has already been posted for `guid` in its CURRENT unbound streak. */
  isAlerted(guid: string): boolean {
    return this.#map.get(guid)?.alertedAt !== undefined;
  }

  /** Record that the alert comment was just posted, and flush immediately — called right after a successful `addComment`, so a crash between posting and persisting can at worst re-post once, never silently skip forever. */
  async markAlerted(guid: string, now: number): Promise<void> {
    const record = this.#map.get(guid);
    if (!record) return; // reconcile() should always run first in the same cycle
    record.alertedAt = now;
    await this.#flush();
  }

  /** Persist the current reconciled state — TasklistPoller calls this once per cycle after `reconcile`, even if nothing got alerted this cycle, so restarts see accurate `firstSeenUnboundAt` clocks. */
  async flush(): Promise<void> {
    await this.#flush();
  }

  async #flush(): Promise<void> {
    const file: AlertStoreFile = { version: 1, records: Object.fromEntries(this.#map) };
    const json = JSON.stringify(file, null, 2);
    const tmpPath = `${this.#filePath}.tmp`;
    try {
      await mkdir(dirname(this.#filePath), { recursive: true });
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, this.#filePath);
    } catch (err) {
      console.warn(`[tasklist.candidateAlertStore] failed to persist ${this.#filePath} (continuing, best-effort):`, err);
    }
  }
}
