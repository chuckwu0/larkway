/**
 * src/cli/hostConfig.ts
 *
 * Host-level config (~/.larkway/config.json) + credential writes (~/.larkway/.env).
 *
 * Two single sources, both managed here:
 *   - config.json: conventions / permissions / chats. Validated with the SAME
 *     ConfigJson zod schema the bridge loads (no parallel schema). Atomic write.
 *   - .env: secret REAL values (V2.2 decision 1 — env-ref + 0600, NOT plaintext
 *     in yaml). bot yaml only references the env-var name; the value lives here.
 *
 * Bin-ground rule: this module never touches claude credentials
 * (~/.claude/.credentials.json) — the bridge uses the subscription login as-is
 * (铁律5). The CLI only ever detects claude's presence, never writes its keys.
 */

import { mkdir, readFile, writeFile, rename, chmod, access, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ConfigJson, type ConfigJsonType } from "../config.js";
import { larkwayHome } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The host root (~/.larkway, or $LARKWAY_HOME when set). Single source: config/paths. */
export function resolveLarkwayHome(): string {
  return larkwayHome();
}

/** ~/.larkway/config.json */
export function resolveConfigJsonPath(): string {
  return path.join(resolveLarkwayHome(), "config.json");
}

/** ~/.larkway/.env — secret real values, chmod 0600. */
export function resolveEnvPath(): string {
  return path.join(resolveLarkwayHome(), ".env");
}

/** Ensure ~/.larkway exists. Returns the resolved dir. */
export async function ensureLarkwayDir(): Promise<string> {
  const dir = resolveLarkwayHome();
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// config.json (conventions / permissions / chats)
// ---------------------------------------------------------------------------

/** Atomic write helper (tmp + rename), creating parent dirs as needed. */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

/**
 * Read + validate ~/.larkway/config.json. Returns null when the file does not
 * exist (init not run yet) so callers can branch on first-run vs. edit. Throws
 * a field-level error on schema/JSON failure.
 */
export async function readHostConfig(): Promise<ConfigJsonType | null> {
  const file = resolveConfigJsonPath();
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`~/.larkway/config.json is not valid JSON: ${String(e)}`);
  }
  const result = ConfigJson.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`~/.larkway/config.json invalid:\n${issues}`);
  }
  return result.data;
}

/**
 * Validate + atomically write ~/.larkway/config.json. Config is validated
 * FIRST so an invalid object never lands on disk. Pretty-printed (2-space).
 */
export async function writeHostConfig(config: ConfigJsonType): Promise<void> {
  const result = ConfigJson.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Refusing to write invalid config.json:\n${issues}`);
  }
  await atomicWrite(resolveConfigJsonPath(), JSON.stringify(result.data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// .env secret store (KEY=VALUE lines, chmod 0600)
// ---------------------------------------------------------------------------

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Parse ~/.larkway/.env into a map. Missing file → empty map. */
async function readEnvFile(): Promise<Map<string, string>> {
  const file = resolveEnvPath();
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return map;
    throw e;
  }
  for (const line of raw.split("\n")) {
    const m = ENV_LINE.exec(line.trim());
    if (m) map.set(m[1], stripQuotes(m[2]));
  }
  return map;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Quote a value if it contains characters that would break a bare KEY=VALUE. */
function quoteIfNeeded(v: string): string {
  return /[\s#"'=]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * Write/update one secret in ~/.larkway/.env (KEY=VALUE). Existing keys are
 * replaced in place; new keys appended. The file is re-written atomically and
 * chmod 0600 every time (decision 1 — secret real values, owner-only).
 *
 * `envName` is the env-var NAME a bot yaml references (e.g. GITLAB_BOT_APP_SECRET);
 * `value` is the secret real value.
 */
export async function writeSecret(envName: string, value: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`Invalid env var name "${envName}" (must match [A-Za-z_][A-Za-z0-9_]*)`);
  }
  const map = await readEnvFile();
  map.set(envName, value);
  const body =
    [...map.entries()].map(([k, v]) => `${k}=${quoteIfNeeded(v)}`).join("\n") + "\n";
  const file = resolveEnvPath();
  await atomicWrite(file, body);
  await chmod(file, 0o600);
}

/** Read one secret value from ~/.larkway/.env. Returns null when absent. */
export async function readSecret(envName: string): Promise<string | null> {
  const map = await readEnvFile();
  return map.get(envName) ?? null;
}

/**
 * Remove one secret from ~/.larkway/.env. No-op when the key is absent.
 * Re-writes the file atomically and preserves 0600 permission.
 */
export async function removeSecret(envName: string): Promise<void> {
  const map = await readEnvFile();
  if (!map.has(envName)) return; // key not present — no-op
  map.delete(envName);
  const file = resolveEnvPath();
  // Removing the last secret → drop the now-empty .env entirely rather than
  // leaving a 0-byte file. dotenv treats a missing file the same as empty, and
  // writeSecret recreates it on demand.
  if (map.size === 0) {
    try {
      await unlink(file);
    } catch {
      // already gone — fine
    }
    return;
  }
  const body =
    [...map.entries()].map(([k, v]) => `${k}=${quoteIfNeeded(v)}`).join("\n") + "\n";
  await atomicWrite(file, body);
  // preserve 0600 on the freshly-written file (atomicWrite's tmp defaults to 0644)
  try {
    const s = await stat(file);
    if ((s.mode & 0o777) !== 0o600) await chmod(file, 0o600);
  } catch {
    // if stat fails for some reason, still try to set permissions
    await chmod(file, 0o600);
  }
}

/** True if ~/.larkway/.env exists (regardless of contents). */
export async function envFileExists(): Promise<boolean> {
  try {
    await access(resolveEnvPath());
    return true;
  } catch {
    return false;
  }
}
