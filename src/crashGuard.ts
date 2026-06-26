/**
 * crashGuard.ts — process-level last-resort crash guard (THIN / DELETABLE 护栏).
 *
 * WHY THIS EXISTS:
 *   0.3.15+ enables WS robustness knobs on createLarkChannel (handshakeTimeoutMs,
 *   wsConfig.pingTimeout — see lark/channelClient.ts). When a handshake hangs and
 *   that timeout fires, the SDK aborts the underlying `_WebSocket`, which emits a
 *   RAW 'error' event on the socket. That low-level socket has no 'error' listener
 *   we can reliably attach (node-sdk 1.67.0's WSClient is not an EventEmitter and
 *   keeps the raw ws in a closure — no public accessor). So Node's default rule
 *   applies: an 'error' EventEmitter event with no listener is RE-THROWN as an
 *   uncaughtException (events.js:486 `throw er`). With one bridge process serving
 *   multiple bots, that single unhandled throw kills the WHOLE process → every bot
 *   drops at once (observed twice in one day on the mini). There was no net.
 *
 * WHAT IT DOES:
 *   Install last-resort uncaughtException / unhandledRejection handlers that LOG
 *   the full error (incl. stack) and DELIBERATELY DO NOT call process.exit — the
 *   bridge must stay alive ("bridge never suicides" 铁律). A transient WS handshake
 *   timeout must not take the whole fleet offline.
 *
 * HONEST TRADE-OFF (not zero-risk):
 *   uncaughtException is, in the general case, a signal that the process MAY be in
 *   an indeterminate state, and swallowing it can in theory mask a real corruption.
 *   We accept that because (a) the dominant real-world trigger here is a benign,
 *   well-understood transient (the raw WS 'error' above), (b) we NEVER swallow
 *   silently — every catch logs the full stack so anomalies stay visible, and
 *   (c) an external supervisor (launchd / start-bridge.sh) restarts the process if
 *   it ever does wedge. Staying up for the common case beats a fleet-wide outage.
 *
 * DELETABILITY:
 *   This is a thin, isolated module. Once the transport layer owns these errors
 *   directly (e.g. the split-out `@larksuite/channel` package attaching its own
 *   ws 'error' listener, or a node-sdk that no longer re-throws), delete this file
 *   and its single call site in main.ts.
 */

/** Default logger — overridable in tests so we can assert "logged, never exited". */
export interface CrashGuardLogger {
  error: (...args: unknown[]) => void;
}

/** Handle uncaughtException: log full stack, NEVER exit. Exported for testing. */
export function handleUncaughtException(
  err: Error,
  origin: string,
  log: CrashGuardLogger = console,
): void {
  log.error(
    `[larkway] uncaughtException (origin=${origin}) — bridge STAYS UP (crash guard). ` +
      `Likely a transient WS handshake-timeout raw socket error; if it recurs, investigate:`,
    err,
  );
}

/** Handle unhandledRejection: log full reason, NEVER exit. Exported for testing. */
export function handleUnhandledRejection(reason: unknown, log: CrashGuardLogger = console): void {
  log.error(
    "[larkway] unhandledRejection — bridge STAYS UP (crash guard). Full reason:",
    reason instanceof Error ? reason : new Error(String(reason)),
  );
}

/**
 * Register the process-level crash guard. Idempotent-friendly: callers should
 * invoke once near startup (main.ts). Does not return a teardown — the guard is
 * meant to live for the whole process lifetime.
 */
export function registerCrashGuard(log: CrashGuardLogger = console): void {
  process.on("uncaughtException", (err: Error, origin: string) => {
    handleUncaughtException(err, origin, log);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    handleUnhandledRejection(reason, log);
  });
}
