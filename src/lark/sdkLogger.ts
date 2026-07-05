/**
 * lark/sdkLogger.ts
 *
 * Suppressing the vendored `@larksuiteoapi/node-sdk` (1.67.0) Client's noisy
 * internal error logging for our one-off, best-effort task-v2 REST calls
 * (bridge self-join, `doctor` scope probe, `tasklist-init` reuse). Those calls
 * handle failure ourselves with a clean message, so the SDK's raw dump is pure
 * noise — on a members-endpoint 404 it prints the ENTIRE AxiosError instance
 * (config + ClientRequest + response, thousands of characters) to stdout.
 *
 * ⚠️ `loggerLevel: LoggerLevel.fatal` does NOT silence it. The SDK's public
 * `Client` builds its logger as
 *     new LoggerProxy(params.loggerLevel || LoggerLevel.info, ...)
 * and because `LoggerLevel.fatal === 0` is falsy, `0 || info` collapses back to
 * `info`, so `error`-level logs always fire. (Verified against node-sdk 1.67.0
 * and reproduced on the real machine — the dump survived three rounds of
 * `loggerLevel: fatal`.) The reliable silence is to pass a `logger` whose
 * methods are no-ops: `LoggerProxy.error` unconditionally calls
 * `this.logger.error(...)` once the (mis-computed) level gate passes, so a
 * no-op logger produces no output regardless of the level bug.
 *
 * Only pass this to the throwaway task REST clients — never to the live WS
 * channel client, whose SDK diagnostics we want.
 */

/** No-op logger matching the SDK's `Logger` interface (error/warn/info/debug/trace). */
export const silentSdkLogger = {
  error(..._msg: unknown[]) {},
  warn(..._msg: unknown[]) {},
  info(..._msg: unknown[]) {},
  debug(..._msg: unknown[]) {},
  trace(..._msg: unknown[]) {},
};

/**
 * A one-line, log-safe rendering of an error for our OWN `console.warn`/`error`
 * calls. Passing the raw error object to `console.*` is a second, independent
 * source of AxiosError noise: a `TaskApiError` carries the original axios error
 * on `.cause`, and Node's `util.inspect` expands that cause chain into the same
 * multi-kilobyte dump. Logging just the message keeps the failure visible
 * without the object graph.
 */
export function compactErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
