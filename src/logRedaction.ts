/**
 * logRedaction.ts — one chokepoint that keeps credentials out of the bridge log.
 *
 * WHY THIS EXISTS:
 *   Many call sites do `console.warn("...", err)`. When `err` is (or wraps via
 *   `.cause`) an axios / node-sdk HTTP error, Node's util.inspect renders its
 *   request config — `config.headers.Authorization: 'Bearer <tenant token>'`,
 *   the raw `request._header` text ("Authorization: Bearer …\r\n"), the
 *   `[Symbol(kOutHeaders)]` map, token-endpoint bodies carrying `app_secret`,
 *   responses carrying `tenant_access_token`. The node-sdk's own default logger
 *   does the same through `console.log`. The bridge log is plain stdout/stderr,
 *   so every one of those dumps put a live token on disk.
 *
 * WHAT IT DOES:
 *   `installLogRedaction()` wraps the global console once, first thing in
 *   main(). Each call is rendered exactly as Node would render it
 *   (`util.format`, same default depth), then the resulting TEXT is scrubbed
 *   before it reaches the stream. Scrubbing the final text instead of walking
 *   objects means cause chains, symbol-keyed header maps, getters, circular refs
 *   and any future call site are covered for free: whatever inspect prints is
 *   what gets scanned. Only the credential VALUE is replaced — keys, auth scheme,
 *   error message, status code, `code`, `log_id` all stay readable.
 *
 * WHAT IS SCRUBBED (value → [REDACTED]):
 *   - literal secret values registered at startup: every env var whose NAME ends
 *     in SECRET / TOKEN / PASSWORD / API_KEY / ACCESS_KEY / PRIVATE_KEY /
 *     CREDENTIAL(S) / _PAT, plus each bot's resolved app secret and git token
 *     (main.ts registers them — env-var names are free-form)
 *   - `Bearer <token>` / `Basic <b64>` anywhere; raw `Authorization:` /
 *     `Private-Token:` / `X-Api-Key:` / `X-Auth-Token:` header lines, with
 *     a known scheme (any case) or none
 *   - sensitive keys in inspect / JSON / escaped-JSON / `k=v` form
 *     (authorization, *access_token / accessToken, refresh_token, app_secret,
 *     app_ticket, …) and the WS endpoint URL's access_key / ticket
 *   - raw `Cookie:` / `Set-Cookie:` header lines, and quoted Set-Cookie values
 *     that carry attributes (`'sid=…; Path=/'`, as axios renders `rawHeaders`
 *     / `set-cookie` arrays)
 *   - URL userinfo passwords (`//user:pw@host`)
 *   - bare Feishu token shapes (`t-` / `u-` + ≥30 alphanumerics) at a word
 *     boundary or right after a percent / backslash escape (`%3Dt-…`, `\nt-…`)
 *   Words that only LOOK like a credential slot are left alone: a scheme word
 *   followed by prose ("Bearer authentication failed"), `Bearer undefined`,
 *   `token=null`, `Authorization: required scope …`.
 *
 * BOUNDARY:
 *   Only output that goes through the global `console` is covered. A child
 *   process writing to an inherited fd, or Node's own fatal-exception printer
 *   (before crashGuard registers), bypasses it. Colors are not applied to
 *   inspected objects — the bridge log is a file, and ANSI codes between a key
 *   and its value would defeat the key rules. Known unmatched shapes (none is
 *   how axios/node-sdk render a Feishu credential): an unquoted `key: value`
 *   in hand-written text, Map (`'k' => 'v'`) / pair-array renderings
 *   (`[ 'X-Api-Key', '…' ]` — a Bearer/Basic value there IS caught),
 *   attribute-less Set-Cookie values (`'sid=…'` is indistinguishable from any
 *   `'k=v'` string), raw header lines with an unrecognised scheme
 *   (`Authorization: OAuth …`), a token used as the URL username
 *   (`https://<tok>@host`), a Feishu token glued mid-word (`cache_t-…` — kept so
 *   `commit-<sha>` stays readable), and values containing a quote (redacted
 *   only up to the quote).
 */
import { format, inspect, type InspectOptions } from "node:util";

export const REDACTED = "[REDACTED]";

/** Registered literal secrets shorter than this are ignored (too likely to collide with ordinary text). */
const MIN_LITERAL_SECRET_LENGTH = 8;

/** Env var NAMES whose values are registered as literal secrets. Suffix match, so `MAX_THINKING_TOKENS` is not one. */
const SECRET_ENV_NAME =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|(?:^|_)PAT)$/i;

/**
 * Keys whose value is a credential. Matched as a whole key (not a suffix of
 * e.g. `page_token`), case-insensitively and with `_` / `-` / no separator
 * (`Authorization`, `appSecret`, `app-secret`, `tenantAccessToken`).
 */
const SENSITIVE_KEY = [
  "(?:proxy-)?authorization",
  "(?:set-)?cookie",
  "x-api-key",
  "api[_-]?key",
  "(?:tenant[_-]?|user[_-]?|app[_-]?)?access[_-]?token",
  "(?:refresh|private|id|session|auth)[_-]?token",
  "(?:app|client)[_-]?secret",
  "secret",
  "access[_-]?key",
  "app[_-]?ticket",
  "encrypt[_-]?key",
  "verification[_-]?token",
  "password",
  "passwd",
  "token",
].join("|");

/** Extra keys redacted only in URL-query / `k=v` form (the Feishu WS endpoint URL) — too generic as object keys. */
const QUERY_ONLY_KEY = "ticket";

/**
 * A credential after an auth scheme: needs a digit, ≥24 chars, or base64
 * padding — so "Bearer authentication failed" stays readable.
 */
const CREDENTIAL = String.raw`(?:(?=[A-Za-z0-9\-._~+/]*\d)[A-Za-z0-9\-._~+/]{8,}=*|[A-Za-z0-9\-._~+/]{24,}=*|[A-Za-z0-9\-._~+/]{8,}={1,2})`;

/** `Bearer <token>` / `Basic <b64>` anywhere (header text, inspect strings, pair arrays). */
const SCHEME_CREDENTIAL = new RegExp(String.raw`\b(Bearer|bearer|BEARER|Basic)[ \t]+${CREDENTIAL}`, "g");

/**
 * Sensitive key with a QUOTED value, in any of the rendered forms:
 *   inspect     `Authorization: 'Bearer …'`, `'Proxy-Authorization': '…'`
 *   JSON        `"app_secret":"…"`
 *   escaped     `{\"app_secret\":\"…\"}`, `{\\"app_secret\\":\\"…\\"}` (JSON in a JSON / inspected string)
 *   k="v"       `token="…"`
 * Groups: 1 key quote, 2 key, 3 separator, 4 value quote, 5 value.
 * Backslash runs are bounded ({0,8}) so a long run of `\` can't go quadratic.
 */
const QUOTED_KEY_VALUE = new RegExp(
  String.raw`(?<!\w)(\\{0,8}["']?)(${SENSITIVE_KEY})\1(\s*[:=]\s*)(\\{0,8}["'\x60])([^"'\x60\\\r\n]*)`,
  "gi",
);

/**
 * Raw credential header line (`request._header`, curl traces) with a known
 * scheme in any case (`authorization: basic …`, `Authorization: Token …`) or
 * none (`Private-Token: …`). The value must look like a credential, so
 * "Authorization: required scope …" / "… missing tenant token1" stay readable.
 */
const AUTH_HEADER_LINE = new RegExp(
  String.raw`(?<!\w)((?:proxy-)?authorization|private-token|x-api-key|x-auth-token|(?:x-)?access-token)([ \t]*:[ \t]*)` +
    String.raw`(?:(Bearer|Basic|Token|Bot|Digest|Negotiate|NTLM)[ \t]+)?${CREDENTIAL}`,
  "gi",
);

/**
 * Raw `Cookie:` / `Set-Cookie:` header line — only when it really carries
 * `name=value` pairs. The name class excludes `:` so a run of "cookie:" can't
 * backtrack quadratically.
 */
const COOKIE_HEADER = /(?<!\w)((?:set-)?cookie)([ \t]*:[ \t]*)[^\s=;:'"`\\[{]+=[^\r\n'"`\\]*/gi;

/**
 * A quoted Set-Cookie value — `'sid=<value>; Path=/; HttpOnly'` — as axios
 * renders it inside `rawHeaders` / `'set-cookie': [ … ]`. Keeps the cookie
 * name and attributes. Requires real attribute SYNTAX right after the value
 * (`; Path=`, `; secure;` — a flag must end the attribute), so an error message
 * like "limit=100; max-age exceeded" or "PATH=/usr/bin; export PATH" is left
 * alone.
 */
const SET_COOKIE_VALUE =
  /(['"])([^'"=;\s\\]{1,128})=[^'";\r\n\\]+(?=;[ \t]*(?:(?:path|expires|max-age|domain|samesite|version|priority)=|(?:httponly|secure|partitioned)(?=[;'"]|$)))/gi;

/** Query string / form / `k=v` with an unquoted value. */
const UNQUOTED_KEY_VALUE = new RegExp(
  String.raw`(?<!\w)(${SENSITIVE_KEY}|${QUERY_ONLY_KEY})=(?!["'\x60[])([^&\s"'\x60\\#,;]+)`,
  "gi",
);

/** Password in URL userinfo: `https://oauth2:<token>@host/...`. Scheme length is bounded to keep this linear. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,15}:\/\/[^\s:/@'"`\\]+:)[^\s@/'"`\\]+@/gi;

/**
 * Bare Feishu tenant/user access tokens (`t-` / `u-` + 40 alphanumerics in
 * practice), at a word boundary or right after a percent / backslash escape
 * (`%3Dt-…`, `Bearer%20t-…`, `\nt-…`, `\u0022t-…`). Not mid-word, so
 * `commit-<sha>` stays readable.
 */
const BARE_FEISHU_TOKEN =
  /(?:\b|(?<=%[0-9A-Fa-f]{2}|\\[nrtbfv]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}))([tu])-[A-Za-z0-9]{30,}/g;

const literalSecrets = new Set<string>();
let literalSecretPattern: RegExp | null = null;

/**
 * Register a known secret VALUE (an app secret, a git token) so any literal
 * occurrence in log output is replaced, whatever key or context it appears in.
 * Values shorter than 8 chars are ignored.
 */
export function registerLogSecret(value: string | undefined | null): void {
  if (typeof value !== "string" || value.length < MIN_LITERAL_SECRET_LENGTH) return;
  if (literalSecrets.has(value)) return;
  literalSecrets.add(value);
  literalSecretPattern = null;
}

/** Register every env value whose NAME ends in SECRET / TOKEN / PASSWORD / API_KEY. */
export function registerLogSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(name)) registerLogSecret(value);
  }
}

/** Test-only: forget registered literal secrets. */
export function clearLogSecretsForTest(): void {
  literalSecrets.clear();
  literalSecretPattern = null;
}

function getLiteralSecretPattern(): RegExp | null {
  if (literalSecrets.size === 0) return null;
  if (!literalSecretPattern) {
    // Longest first so a secret that contains another is replaced whole.
    const alternatives = [...literalSecrets]
      .sort((a, b) => b.length - a.length)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    literalSecretPattern = new RegExp(alternatives.join("|"), "g");
  }
  return literalSecretPattern;
}

/** Redact one credential value, keeping an auth scheme and "no value" markers readable. */
function scrubValue(value: string): string {
  const scheme = /^(Bearer|Basic|Digest|Token)\s+/i.exec(value);
  const credential = scheme ? value.slice(scheme[0].length) : value;
  if (/^(?:|undefined|null|none|true|false|\[REDACTED\])$/i.test(credential)) return value;
  return scheme ? `${scheme[1]} ${REDACTED}` : REDACTED;
}

/** Scrub credentials out of already-rendered log text. Idempotent. */
export function redactText(text: string): string {
  let out = text;
  const literal = getLiteralSecretPattern();
  if (literal) out = out.replace(literal, REDACTED);
  return out
    .replace(SCHEME_CREDENTIAL, `$1 ${REDACTED}`)
    .replace(
      QUOTED_KEY_VALUE,
      (_m, keyQuote: string, key: string, sep: string, valueQuote: string, value: string) =>
        `${keyQuote}${key}${keyQuote}${sep}${valueQuote}${scrubValue(value)}`,
    )
    .replace(
      AUTH_HEADER_LINE,
      (_m, key: string, sep: string, scheme: string | undefined) =>
        `${key}${sep}${scheme ? `${scheme} ` : ""}${REDACTED}`,
    )
    .replace(COOKIE_HEADER, `$1$2${REDACTED}`)
    .replace(SET_COOKIE_VALUE, `$1$2=${REDACTED}`)
    .replace(UNQUOTED_KEY_VALUE, (_m, key: string, value: string) => `${key}=${scrubValue(value)}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(BARE_FEISHU_TOKEN, `$1-${REDACTED}`);
}

/**
 * A log-safe rendering of any value — an error, an axios error with its whole
 * request config, a plain object, a string. Objects are rendered the way
 * `console.*` would render them (util.inspect), then scrubbed.
 */
export function redactForLog(value: unknown, options?: InspectOptions): string {
  return redactText(typeof value === "string" ? value : inspect(value, options));
}

/** `util.format(...args)` (what `console.log(...args)` prints), scrubbed. */
export function formatForLog(args: readonly unknown[]): string {
  return redactText(format(...args));
}

const WRAPPED_METHODS = ["log", "info", "warn", "error", "debug"] as const;
const INSTALLED = Symbol.for("larkway.logRedaction.uninstall");

type RedactableConsole = Console & { [INSTALLED]?: () => void };

/**
 * Wrap `target`'s output methods so every call is formatted and scrubbed
 * before it is written, and register env-provided secrets. Idempotent: a
 * second call only re-scans env and returns the existing uninstall.
 *
 * `assert`, `table`, `count`, `group`, `timeLog` all route through the
 * wrapped `log` / `warn`, so wrapping log/info/warn/error/debug + trace + dir
 * covers the console. Each wrapped method passes ONE pre-formatted string to
 * the original, which Node writes verbatim (a lone string argument is not
 * re-parsed for `%s`).
 */
export function installLogRedaction(
  target: Console = console,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  registerLogSecretsFromEnv(env);
  const redactable = target as RedactableConsole;
  const existing = redactable[INSTALLED];
  if (existing) return existing;

  const originals = new Map<string, unknown>();
  const wrap = <K extends "log" | "info" | "warn" | "error" | "debug" | "trace" | "dir">(
    method: K,
    replacement: Console[K],
  ): void => {
    originals.set(method, target[method]);
    target[method] = replacement;
  };

  const originalLog = target.log;
  const originalError = target.error;
  for (const method of WRAPPED_METHODS) {
    const original = target[method];
    wrap(method, (...args: unknown[]) => original.call(target, formatForLog(args)));
  }
  // Mirrors Console#trace, capturing the stack from THIS function so it starts
  // at the caller rather than inside the wrapper.
  wrap("trace", function trace(...args: unknown[]): void {
    const err: { name: string; message: string; stack?: string } = { name: "Trace", message: format(...args) };
    Error.captureStackTrace(err, trace);
    originalError.call(target, redactText(err.stack ?? ""));
  });
  // Mirrors Console#dir: inspect with customInspect off + caller options, to stdout.
  wrap("dir", (item?: unknown, options?: InspectOptions) =>
    originalLog.call(target, redactText(inspect(item, { customInspect: false, ...options }))),
  );

  const uninstall = (): void => {
    for (const [method, original] of originals) {
      (target as unknown as Record<string, unknown>)[method] = original;
    }
    delete redactable[INSTALLED];
  };
  redactable[INSTALLED] = uninstall;
  return uninstall;
}
