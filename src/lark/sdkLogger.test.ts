import { describe, it, expect, vi, afterEach } from "vitest";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { silentSdkLogger, compactErrorText } from "./sdkLogger.js";

// These tests run against the REAL vendored @larksuiteoapi/node-sdk (no mock,
// no network) so they pin the actual logging seam the bridge self-join hits.
// The SDK's default logger routes each level to a distinct console method
// (error→console.log, warn→console.warn, info→console.info, …), so we spy on
// all of them and assert nothing is emitted.
const CONSOLE_METHODS = ["log", "warn", "info", "debug", "trace", "error"] as const;

function spyConsole() {
  return CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
}
function totalConsoleCalls(spies: ReturnType<typeof vi.spyOn>[]) {
  return spies.reduce((n, s) => n + s.mock.calls.length, 0);
}

// A realistic stand-in for the multi-KB AxiosError the SDK would otherwise dump.
function bigError(): Error {
  const e = new Error("Request failed with status code 404");
  (e as { config?: unknown }).config = { url: "/open-apis/task/v2/tasklists/x/members", method: "post", data: "{...}" };
  (e as { response?: unknown }).response = { status: 404, statusText: "Not Found", data: "404 page not found" };
  return e;
}

afterEach(() => vi.restoreAllMocks());

describe("silentSdkLogger", () => {
  it("emits nothing when its methods are called directly", () => {
    const spies = spyConsole();
    silentSdkLogger.error(bigError());
    silentSdkLogger.warn("w");
    silentSdkLogger.info("i");
    silentSdkLogger.debug("d");
    silentSdkLogger.trace("t");
    expect(totalConsoleCalls(spies)).toBe(0);
  });

  it("silences a REAL node-sdk Client's error dump (the actual self-join seam)", () => {
    // Construct with a no-op logger, then drive the SDK's internal logging seam
    // exactly as a failed request would: client.logger.error(rawAxiosError).
    const client = new Client({ appId: "cli_fake00000000000", appSecret: "fake-secret", logger: silentSdkLogger });
    const spies = spyConsole();
    // `.logger` is the internal LoggerProxy; cast to reach it in the test.
    (client as unknown as { logger: { error: (e: unknown) => void } }).logger.error(bigError());
    expect(totalConsoleCalls(spies)).toBe(0);
  });
});

describe("loggerLevel: fatal is NOT a valid silence (regression guard)", () => {
  // Documents WHY we pass a no-op logger instead of loggerLevel. The vendored
  // SDK builds `new LoggerProxy(params.loggerLevel || LoggerLevel.info, ...)`,
  // and since LoggerLevel.fatal === 0 is falsy, it collapses to `info`. If a
  // future SDK bump fixes this, these assertions flip and prompt a re-review.
  it("coerces fatal (0) back to info, so error-level logs still fire", () => {
    const client = new Client({ appId: "cli_fake00000000000", appSecret: "fake-secret", loggerLevel: LoggerLevel.fatal });
    const level = (client as unknown as { logger: { level: number } }).logger.level;
    expect(level).toBe(LoggerLevel.info); // NOT LoggerLevel.fatal
    expect(level).toBeGreaterThanOrEqual(LoggerLevel.error); // => error logs fire

    const spies = spyConsole();
    (client as unknown as { logger: { error: (e: unknown) => void } }).logger.error(bigError());
    // The dump the real machine still saw with `loggerLevel: fatal`.
    expect(totalConsoleCalls(spies)).toBeGreaterThan(0);
  });
});

describe("compactErrorText", () => {
  it("returns only the message, never the axios cause chain", () => {
    // Mirror wrapErr: a TaskApiError-shaped Error whose .cause is the raw axios
    // error. console.warn(msg, err) would expand this into the same KB dump.
    class TaskApiErrorLike extends Error {
      cause: unknown;
      constructor(message: string, cause: unknown) {
        super(message);
        this.name = "TaskApiError";
        this.cause = cause;
      }
    }
    const err = new TaskApiErrorLike("addTasklistMembers(guid): Request failed with status code 404", bigError());
    const text = compactErrorText(err);
    expect(text).toBe("addTasklistMembers(guid): Request failed with status code 404");
    expect(text).not.toMatch(/config|response|AxiosError|\[cause\]/i);
  });

  it("stringifies non-Error values", () => {
    expect(compactErrorText("boom")).toBe("boom");
    expect(compactErrorText(404)).toBe("404");
  });
});
