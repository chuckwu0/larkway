/**
 * Tests for src/logRedaction.ts — credentials must never reach the bridge log,
 * whatever shape the logged error has.
 *
 * The fixture mirrors what util.inspect prints for a real node-sdk AxiosError
 * (config.headers.Authorization, request._header, the symbol-keyed outgoing
 * header map, response.config, a token-endpoint body) and wraps it in a
 * TaskApiError-style `.cause`. Each test first proves the UNREDACTED rendering
 * really contains the token, so a passing test is not vacuous. All tokens and
 * secrets here are fake.
 */
import { Console } from "node:console";
import { Writable } from "node:stream";
import { format } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import {
  REDACTED,
  clearLogSecretsForTest,
  formatForLog,
  installLogRedaction,
  redactForLog,
  redactText,
  registerLogSecret,
  registerLogSecretsFromEnv,
} from "./logRedaction.js";

const TENANT_TOKEN = "t-g1044FAKEfakeFAKEfakeFAKEfakeFAKEfake00";
const USER_TOKEN = "u-FAKEuserTOKENfakeUSERtokenFAKEuser0000";
const APP_SECRET = "FakeAppSecretValue0123456789ab";
const SECRETS = [TENANT_TOKEN, USER_TOKEN, APP_SECRET];

function expectNoSecrets(out: string): void {
  for (const secret of SECRETS) expect(out).not.toContain(secret);
  // No partial token prefix either (e.g. a token split across inspect lines).
  expect(out).not.toMatch(/FAKEfake|FAKEuser|FakeAppSecret/);
}

/** Shape-compatible stand-in for axios' AxiosError (no axios import in tests). */
class FakeAxiosError extends Error {
  isAxiosError = true;
  code = "ERR_BAD_REQUEST";
  status = 400;
  config: Record<string, unknown>;
  request: Record<string | symbol, unknown>;
  response: Record<string, unknown>;
  constructor() {
    super("Request failed with status code 400");
    this.name = "AxiosError";
    const config = {
      timeout: 0,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "oapi-node-sdk/unknown",
        Authorization: `Bearer ${TENANT_TOKEN}`,
      },
      url: "https://open.feishu.cn/open-apis/im/v1/messages/om_fake/reply",
      method: "post",
      data: JSON.stringify({ app_id: "cli_fake", app_secret: APP_SECRET, msg_type: "interactive" }),
    };
    this.config = config;
    this.request = {
      method: "POST",
      path: "/open-apis/im/v1/messages/om_fake/reply",
      _header:
        "POST /open-apis/im/v1/messages/om_fake/reply HTTP/1.1\r\n" +
        "Accept: application/json, text/plain, */*\r\n" +
        "Content-Type: application/json\r\n" +
        `Authorization: Bearer ${TENANT_TOKEN}\r\n` +
        "Host: open.feishu.cn\r\n\r\n",
      [Symbol("kOutHeaders")]: {
        authorization: ["Authorization", `Bearer ${TENANT_TOKEN}`],
      },
    };
    this.response = {
      status: 400,
      statusText: "Bad Request",
      config,
      data: {
        code: 230011,
        msg: "fake failure",
        error: { log_id: "FAKELOGID0001" },
        // A token endpoint's success body, as it would appear if logged.
        tenant_access_token: TENANT_TOKEN,
        user_access_token: USER_TOKEN,
      },
    };
  }
}

/** TaskApiError-style wrapper: the axios error rides on `.cause`. */
function wrapped(): Error {
  return new Error("task api create failed (code 1470400)", { cause: new FakeAxiosError() });
}

/** A private Console whose stdout+stderr land in one string. */
function captureConsole(): { console: Console; output: () => string } {
  let buf = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  });
  return { console: new Console({ stdout: sink, stderr: sink }), output: () => buf };
}

afterEach(() => {
  clearLogSecretsForTest();
});

describe("installLogRedaction — console chokepoint", () => {
  it("console.warn(msg, axiosError) writes no token, keeps message/status/code/log_id", () => {
    const err = new FakeAxiosError();
    // Control: the unredacted rendering really carries the secrets.
    const raw = format("[bridge.handler] Failed to start card:", err);
    expect(raw).toContain(`Authorization: 'Bearer ${TENANT_TOKEN}'`);
    expect(raw).toContain(`Authorization: Bearer ${TENANT_TOKEN}\\r\\n`);
    expect(raw).toContain(APP_SECRET);

    const { console: c, output } = captureConsole();
    installLogRedaction(c, {});
    c.warn("[bridge.handler] Failed to start card:", err);
    const out = output();

    expectNoSecrets(out);
    expect(out).toContain("[bridge.handler] Failed to start card:");
    expect(out).toContain("AxiosError: Request failed with status code 400");
    expect(out).toContain("status: 400");
    expect(out).toContain("code: 'ERR_BAD_REQUEST'");
    expect(out).toContain("url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_fake/reply'");
    // Header key + auth scheme stay readable; only the credential is gone.
    expect(out).toContain(`Authorization: 'Bearer ${REDACTED}'`);
    expect(out).toContain(`Authorization: Bearer ${REDACTED}\\r\\n`);
    expect(out).toContain(`"app_secret":"${REDACTED}"`);
    expect(out).toContain(`"app_id":"cli_fake"`);
  });

  it("covers the .cause chain, console.error, console.dir(depth:null) and %O", () => {
    const err = wrapped();
    const deep = format("%O", err);
    expect(deep).toContain(TENANT_TOKEN); // control: depth-4 render reaches response.data

    const { console: c, output } = captureConsole();
    installLogRedaction(c, {});
    c.error("[larkway] tasklist create failed:", err);
    c.dir(err, { depth: null });
    c.log("%O", err);
    c.info(err);
    c.debug(err);
    const out = output();

    expectNoSecrets(out);
    expect(out).toContain("task api create failed (code 1470400)");
    expect(out).toMatch(/\[cause\]: \w*AxiosError: Request failed with status code 400/);
    expect(out).toContain("code: 230011");
    expect(out).toContain("log_id: 'FAKELOGID0001'");
    expect(out).toContain(`tenant_access_token: '${REDACTED}'`);
  });

  it("covers the node-sdk default logger shape: console.log('[error]:', [err])", () => {
    const { console: c, output } = captureConsole();
    installLogRedaction(c, {});
    const err = new FakeAxiosError();
    expect(format("[error]:", [err])).toContain(TENANT_TOKEN); // control
    c.log("[error]:", [err]);
    expectNoSecrets(output());
    expect(output()).toContain("Request failed with status code 400");
  });

  it("console.trace and console.assert route through the redaction too", () => {
    const { console: c, output } = captureConsole();
    installLogRedaction(c, {});
    c.trace(`probe Bearer ${TENANT_TOKEN}`);
    c.assert(false, `assert Bearer ${TENANT_TOKEN}`);
    expectNoSecrets(output());
    expect(output()).toContain(`Trace: probe Bearer ${REDACTED}`);
    expect(output()).toContain(`Assertion failed: assert Bearer ${REDACTED}`);
  });

  it("console.trace keeps the native shape: stack starts at the caller, not the wrapper", () => {
    const { console: c, output } = captureConsole();
    installLogRedaction(c, {});
    c.trace("where %s", "am-i");
    const [head, firstFrame] = output().split("\n");
    expect(head).toBe("Trace: where am-i");
    expect(firstFrame).toContain("logRedaction.test.ts");
  });

  it("preserves ordinary formatting: %s substitution and a lone '%%' string", () => {
    const { console: c, output } = captureConsole();
    installLogRedaction(c, {});
    c.log("bot %s ready (%d chats)", "alpha", 3);
    c.log("100%% literal");
    c.log();
    expect(output()).toBe("bot alpha ready (3 chats)\n100%% literal\n\n");
  });

  it("is idempotent and uninstallable", () => {
    const { console: c } = captureConsole();
    const originalWarn = c.warn;
    const originalMethods = { log: c.log, info: c.info, warn: c.warn, error: c.error, debug: c.debug, trace: c.trace, dir: c.dir };
    const uninstall = installLogRedaction(c, {});
    const wrappedWarn = c.warn;
    expect(wrappedWarn).not.toBe(originalWarn);
    expect(installLogRedaction(c, {})).toBe(uninstall);
    expect(c.warn).toBe(wrappedWarn); // not double-wrapped
    const methods = ["log", "info", "warn", "error", "debug", "trace", "dir"] as const;
    const before = Object.fromEntries(methods.map((m) => [m, originalMethods[m]]));
    uninstall();
    expect(c.warn).toBe(originalWarn);
    for (const m of methods) expect(c[m]).toBe(before[m]);
  });

  it("registers secret-named env values as literal secrets (suffix match on the name)", () => {
    registerLogSecretsFromEnv({
      AWS_SECRET_ACCESS_KEY: "fakeAwsSecret/abc123",
      GH_PAT: "fakeGithubPat000111",
      DEPLOY_CREDENTIALS: "fakeCredsValue999",
      PATH: "/usr/local/bin:/usr/bin",
      COMPAT_MODE: "legacy-compat-on", // ends in PAT but not _PAT
    });
    expect(redactText("fakeAwsSecret/abc123 fakeGithubPat000111 fakeCredsValue999")).toBe(
      `${REDACTED} ${REDACTED} ${REDACTED}`,
    );
    expect(redactText("/usr/local/bin:/usr/bin legacy-compat-on")).toBe("/usr/local/bin:/usr/bin legacy-compat-on");
  });

  it("registers secret-named env values as literal secrets", () => {
    const { console: c, output } = captureConsole();
    installLogRedaction(c, {
      MYBOT_APP_SECRET: APP_SECRET,
      MAX_THINKING_TOKENS: "31999999", // name ends in TOKENS, not TOKEN — not a secret
    });
    c.log(`secret in prose: ${APP_SECRET}; budget 31999999`);
    expect(output()).toBe(`secret in prose: ${REDACTED}; budget 31999999\n`);
  });
});

describe("redactText — individual shapes", () => {
  it("scrubs raw header lines with any scheme and keeps the scheme", () => {
    expect(redactText("Authorization: Basic ZmFrZTpmYWtlZmFrZQ==\r\nHost: x")).toBe(
      `Authorization: Basic ${REDACTED}\r\nHost: x`,
    );
    expect(redactText("Cookie: session=fakecookievalue; other=1")).toBe(`Cookie: ${REDACTED}`);
  });

  it("scrubs query-string and k=v credentials", () => {
    expect(redactText(`GET /cb?code=1&access_token=${USER_TOKEN}&state=ok`)).toBe(
      `GET /cb?code=1&access_token=${REDACTED}&state=ok`,
    );
    expect(redactText("lark-cli --profile p --token=fakeflagtoken123")).toBe(
      `lark-cli --profile p --token=${REDACTED}`,
    );
  });

  it("scrubs JSON and escaped-JSON bodies", () => {
    expect(redactText(`{"code":0,"tenant_access_token":"${TENANT_TOKEN}","expire":7200}`)).toBe(
      `{"code":0,"tenant_access_token":"${REDACTED}","expire":7200}`,
    );
    expect(redactText(`'{\\"appSecret\\":\\"${APP_SECRET}\\"}'`)).toBe(`'{\\"appSecret\\":\\"${REDACTED}\\"}'`);
  });

  it("scrubs camelCase token keys", () => {
    expect(redactText(`{ accessToken: '${USER_TOKEN}', refreshToken: 'ur-fakeRefresh123', expiresIn: 7200 }`)).toBe(
      `{ accessToken: '${REDACTED}', refreshToken: '${REDACTED}', expiresIn: 7200 }`,
    );
    expect(redactText(`"tenantAccessToken":"x-fake-123456"`)).toBe(`"tenantAccessToken":"${REDACTED}"`);
  });

  it("scrubs the WS endpoint's access_key / ticket but keeps the other query params", () => {
    expect(redactText("wss://ws.example.invalid/ws?device_id=42&access_key=fakeAccessKey123&service_id=7&ticket=fakeTicket456")).toBe(
      `wss://ws.example.invalid/ws?device_id=42&access_key=${REDACTED}&service_id=7&ticket=${REDACTED}`,
    );
  });

  it("scrubs URL userinfo passwords", () => {
    expect(redactText("git clone https://oauth2:glpat-fake000@git.example.com/g/r.git failed")).toBe(
      `git clone https://oauth2:${REDACTED}@git.example.com/g/r.git failed`,
    );
    expect(redactText("http://localhost:3000/@scope/pkg")).toBe("http://localhost:3000/@scope/pkg");
  });

  it("scrubs doubly-escaped JSON (a JSON string inside an inspected string)", () => {
    const text = format("%o", { body: JSON.stringify({ msg: JSON.stringify({ app_secret: APP_SECRET }) }) });
    expect(text).toContain(APP_SECRET); // control
    expectNoSecrets(redactText(text));
  });

  it("scrubs every pair on a raw Cookie header line", () => {
    expect(redactText("Cookie: session=fakeSess123; csrf=fakeCsrf456\r\nHost: x")).toBe(
      `Cookie: ${REDACTED}\r\nHost: x`,
    );
  });

  it("scrubs raw credential header lines whatever the scheme's case", () => {
    expect(redactText("authorization: basic ZmFrZTpmYWtlZmFrZQ==\r\n")).toBe(`authorization: basic ${REDACTED}\r\n`);
    expect(redactText("Authorization: Token fake0token0value\r\n")).toBe(`Authorization: Token ${REDACTED}\r\n`);
    expect(redactText("Private-Token: glpat-fake0000000000\r\n")).toBe(`Private-Token: ${REDACTED}\r\n`);
    expect(redactText("X-Auth-Token: fakeAuth0token1\r\n")).toBe(`X-Auth-Token: ${REDACTED}\r\n`);
  });

  it("does not mistake a long all-letter credential for a scheme (redacts it, idempotently)", () => {
    const once = redactText("X-Api-Key: ZZabcdefghijklmnopqrstuvwxyz extra");
    expect(once).toBe(`X-Api-Key: ${REDACTED} extra`);
    expect(redactText(once)).toBe(once);
  });

  it("scrubs hyphenated / other token-ish keys and app_ticket", () => {
    expect(redactText(`{ 'app-secret': 'fakeSecret0', 'access-token': 'fakeAccess0', id_token: 'fakeId0', app_ticket: 'fakeTicket0' }`)).toBe(
      `{ 'app-secret': '${REDACTED}', 'access-token': '${REDACTED}', id_token: '${REDACTED}', app_ticket: '${REDACTED}' }`,
    );
  });

  it("scrubs Set-Cookie values in axios' rawHeaders and set-cookie array renderings", () => {
    const rendered = format("%o", {
      rawHeaders: ["Content-Type", "application/json", "set-cookie", "sid=fakeSid0123; Path=/; HttpOnly"],
      headers: { "set-cookie": ["lang=zh; Path=/", "sess=fakeSess0456; Max-Age=60; Secure"] },
    });
    expect(rendered).toContain("fakeSid0123"); // control
    const out = redactText(rendered);
    expect(out).not.toMatch(/fakeSid|fakeSess/);
    expect(out).toContain(`'sid=${REDACTED}; Path=/; HttpOnly'`);
    expect(out).toContain("'application/json'");
    // First attribute in any case / a bare flag.
    expect(redactText(`'a=fakeA0; secure' 'b=fakeB0; HTTPONLY; path=/' 'c=fakeC0; Partitioned'`)).toBe(
      `'a=${REDACTED}; secure' 'b=${REDACTED}; HTTPONLY; path=/' 'c=${REDACTED}; Partitioned'`,
    );
  });

  it("scrubs bare Feishu tokens after a percent-escape but not mid-word", () => {
    expect(redactText(`q=Bearer%20${TENANT_TOKEN}&x=%3D${USER_TOKEN}`)).toBe(
      `q=Bearer%20t-${REDACTED}&x=%3Du-${REDACTED}`,
    );
    expect(redactText(`"line1\\n${TENANT_TOKEN}" "\\u0022${USER_TOKEN}"`)).toBe(
      `"line1\\nt-${REDACTED}" "\\u0022u-${REDACTED}"`,
    );
    const sha = "commit-0123456789abcdef0123456789abcdef01234567";
    expect(redactText(sha)).toBe(sha);
  });

  it("stays linear on adversarial input (no catastrophic backtracking)", () => {
    const size = 200_000;
    for (const unit of ["cookie:", "set-cookie:", "a.", "\\", '"token":', "secret=' ", "authorization:", "'a=", "t-"]) {
      const input = unit.repeat(Math.ceil(size / unit.length));
      const t0 = performance.now();
      redactText(input);
      // Linear is a few ms; the quadratic cookie bug this guards took ~3 s at this size.
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it("does not eat prose that merely mentions a credential slot", () => {
    for (const prose of [
      "[lark] Authorization: required scope im:message:send_as_bot missing (log_id=FAKELOG)",
      "Cookie: not set, falling back",
      "HTTP 401: Bearer authentication failed",
      "retrying with Basic auth",
      "Basic internationalization",
      "{ ticket: 'JIRA-12345' }",
      "Authorization: missing tenant token1",
      // quoted k=v strings that are NOT Set-Cookie values (error messages, shell snippets)
      `{"error":"limit=100; max-age exceeded","code":99991400}`,
      "'PATH=/usr/local/bin:/usr/bin; export PATH'",
      "'NODE_ENV=production; secure cookies on'",
      '"retry=3; request expires in 30s"',
      "token=null access_token=undefined",
    ]) {
      expect(redactText(prose)).toBe(prose);
    }
  });

  it("scrubs bare Feishu token shapes", () => {
    expect(redactText(`token cache hit ${TENANT_TOKEN} for app`)).toBe(`token cache hit t-${REDACTED} for app`);
  });

  it("scrubs registered literal secrets anywhere", () => {
    const plain = "spawn lark-cli --app-secret gitFakeToken-abc123 (short)";
    expect(redactText(plain)).toBe(plain); // control: no pattern rule catches this shape
    registerLogSecret("gitFakeToken-abc123");
    registerLogSecret("short"); // < 8 chars: ignored
    expect(redactText(plain)).toBe(`spawn lark-cli --app-secret ${REDACTED} (short)`);
  });

  it("registerLogSecretsFromEnv only takes secret-shaped names", () => {
    registerLogSecretsFromEnv({ GITLAB_TOKEN: "glpat-fakefakefake", HOME: "/home/fakeuser" });
    expect(redactText("glpat-fakefakefake /home/fakeuser")).toBe(`${REDACTED} /home/fakeuser`);
  });

  it("leaves non-credentials and diagnostics alone", () => {
    const text =
      "page_token: 'pgFAKE123456', message_id: 'om_fake', Authorization: 'Bearer undefined', " +
      "tokens: 1234, token budget exceeded, msg: 'Request failed with status code 401'";
    expect(redactText(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactText(format("x", new FakeAxiosError()));
    expect(redactText(once)).toBe(once);
  });
});

describe("redactForLog / formatForLog", () => {
  it("renders an object like console would, minus secrets", () => {
    const out = redactForLog(wrapped());
    expectNoSecrets(out);
    expect(out).toContain("task api create failed (code 1470400)");
  });

  it("formatForLog is util.format + redaction", () => {
    expect(formatForLog(["%s=%d", "retries", 2])).toBe("retries=2");
    expect(formatForLog([`Bearer ${TENANT_TOKEN}`])).toBe(`Bearer ${REDACTED}`);
  });
});
