/** Largest delay Node can schedule without overflowing to a 1 ms timer. */
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;
export const MAX_RUN_TIMEOUT_SECONDS = Math.floor(MAX_RUN_TIMEOUT_MS / 1000);

/**
 * Optional wall-clock budget for one native turn, including startup and tools.
 * Omitted or 0 means disabled, never a zero-delay (or Infinity) timer. Activity
 * does not renew an explicit budget. Resolve before allocating run resources.
 */
export function resolveRunTimeoutMs(value?: number): number | undefined {
  if (value === undefined || value === 0) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RUN_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be 0 (disabled) or an integer from 1 to ${MAX_RUN_TIMEOUT_MS}`);
  }
  return value;
}
