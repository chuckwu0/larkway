import { createHash } from "node:crypto";

/** Mechanical version of the declared question/options; no interpretation of the answer. */
export function decisionVersion(choices: readonly { label: string; value: string }[], prompt?: string): string {
  return createHash("sha256").update(JSON.stringify([prompt ?? "", choices])).digest("hex").slice(0, 24);
}
