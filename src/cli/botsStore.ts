/**
 * src/cli/botsStore.ts
 *
 * CRUD over the bots/ single source of truth (L1 permission yaml + L2 memory.md).
 *
 * Every write is validated against BotConfigSchema (the SAME schema the bridge
 * loads with — no parallel schema) and written atomically (tmp + rename) so a
 * crash mid-write can't corrupt a live bot config.
 *
 * Credential posture (V2.2 decision 1): yaml stores env-var *names*
 * (app_secret_env / gitlab_token_env), never secret values. Secret real values
 * go to ~/.larkway/.env via hostConfig.writeSecret().
 */

import { mkdir, readFile, readdir, rename, writeFile, access, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import yaml from "js-yaml";
import { BotConfigSchema, type BotConfig } from "../config/botLoader.js";
import { larkwayHome } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bots/ directory.
 *
 * Default: <larkwayHome>/bots (follows $LARKWAY_HOME so an isolated instance
 * keeps its bots there). Still overridable via LARKWAY_BOTS_DIR for the central
 * config-repo layout (points bots/ at a checkout elsewhere). Pure path calc.
 */
export function resolveBotsDir(): string {
  const override = process.env.LARKWAY_BOTS_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(larkwayHome(), "bots");
}

/** Ensure the bots/ directory exists (recursive). Returns the resolved dir. */
export async function ensureBotsDir(): Promise<string> {
  const dir = resolveBotsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

const yamlPath = (id: string): string => path.join(resolveBotsDir(), `${id}.yaml`);
const memoryPath = (id: string): string => path.join(resolveBotsDir(), `${id}.memory.md`);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** True if bots/<id>.yaml exists. */
export async function botExists(id: string): Promise<boolean> {
  try {
    await access(yamlPath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * List all bot ids found in bots/ (by *.yaml filename, sorted). Returns []
 * when the directory doesn't exist (no bots configured yet).
 */
export async function listBots(): Promise<string[]> {
  const dir = resolveBotsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

/**
 * Read + validate a single bot's yaml. Returns the parsed BotConfig (without
 * resolved agent_memory — use readMemory for that). Throws a field-level error
 * on schema failure, or ENOENT-flavored error if missing.
 */
export async function readBot(id: string): Promise<BotConfig> {
  const file = yamlPath(id);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Bot "${id}" not found at ${file}`);
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    throw new Error(`Bot "${id}" yaml is invalid: ${String(e)}`);
  }
  return validateBot(parsed, file);
}

/** Read bots/<id>.memory.md content. Throws if missing. */
export async function readMemory(id: string): Promise<string> {
  const file = memoryPath(id);
  try {
    return await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Bot "${id}" memory file not found at ${file}`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value against BotConfigSchema. On failure throws a clear
 * multi-line error listing each offending field path. `where` is included in
 * the message (file path or "input") for context.
 */
export function validateBot(value: unknown, where = "input"): BotConfig {
  const result = BotConfigSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: z.ZodIssue) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Bot config invalid (${where}):\n${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

/** Atomic write: write to a sibling .tmp then rename over the target. */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, file);
}

/**
 * Validate + write a bot config to bots/<id>.yaml (atomic). The config is
 * validated FIRST — an invalid config never touches disk. Serialized via
 * renderBotYaml so the on-disk file keeps the friendly comment header.
 */
export async function writeBot(config: BotConfig): Promise<void> {
  const valid = validateBot(config, `bot "${config.id}"`);
  // agent_memory is a runtime-resolved field, never serialized to yaml.
  const { agent_memory: _ignore, ...persisted } = valid;
  void _ignore;
  await atomicWrite(yamlPath(valid.id), renderBotYaml(persisted as BotConfig));
}

/** Atomic write of bots/<id>.memory.md content. */
export async function writeMemory(id: string, content: string): Promise<void> {
  await atomicWrite(memoryPath(id), content);
}

/**
 * Delete a bot by removing its yaml (required) and memory.md (best-effort).
 * Throws if the yaml does not exist (bot not found).
 */
export async function deleteBot(id: string): Promise<void> {
  const yaml = yamlPath(id);
  try {
    await unlink(yaml);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Bot "${id}" not found`);
    }
    throw e;
  }
  // best-effort: remove memory file if present
  try {
    await unlink(memoryPath(id));
  } catch {
    // not present — ignore
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a BotConfig to a comment-headed YAML string. The header documents
 * the credential posture (env-var names, not values) so a human reading the
 * file on disk understands the contract. The body is plain js-yaml dump (stable
 * key order from the object), which round-trips cleanly through BotConfigSchema.
 */
export function renderBotYaml(config: BotConfig): string {
  // Strip undefined-valued optionals so the dump stays tidy.
  const { agent_memory: _omit, ...rest } = config as BotConfig & { agent_memory?: string };
  void _omit;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) clean[k] = v;
  }
  const body = yaml.dump(clean, { lineWidth: 100, noRefs: true, sortKeys: false });
  const header = [
    "# Larkway bot config (L1) — generated/edited via `larkway` CLI.",
    "# Credentials are env-var NAMES, never values:",
    "#   app_secret_env / gitlab_token_env reference keys in ~/.larkway/.env (chmod 0600).",
    "# L2 职能 memory lives alongside in <id>.memory.md (memory_file points at it).",
    "",
  ].join("\n");
  return header + body;
}

// ---------------------------------------------------------------------------
// Memory template (L2 职能)
// ---------------------------------------------------------------------------

/**
 * Generate an L2 Agent Memory template for a new bot. Mirrors the shape of the
 * bots-examples/*.memory.md: a top note clarifying what belongs here vs. the
 * shared bridge contract vs. the business repo skills, then 职能 / 工作流 /
 * 不做 sections to fill in.
 */
export function genMemoryTemplate(name: string): string {
  return `# ${name} bot — Agent Memory（职能定义 / L2）

> 这份只写「你这个 bot 是谁 + 跨业务永远成立的护栏」。
> - state.json / 卡片渲染 / choices / peer-@ 格式 / 收尾 = bridge 注入的通用契约，所有 bot 共用，不在这里。
> - **具体工作流**（每一步门槛、何时问业务方、commit/部署规范）= **业务 repo 的 \`AGENTS.md\` / \`CLAUDE.md\` / \`.agents/skills\` / \`.claude/skills\`**，不在这里。

你是「${name}」bot，负责 <一句话职能：你代理出去的本地能力是什么>。

## 工作流程（框架；细节以业务 repo skill 为准）

1. 被 @ 触发后，先用 \`lark-cli\` 拉话题历史 + 首楼搞清需求。
2. <你的核心步骤；门槛/gated 流程写在业务 repo skill，这里不复述>。
3. 需要别的能力时：@ 对应 peer（见注入的 \`<peer-bots>\` 清单），说清诉求，等它 @ 回。

## 不做（硬护栏，跨业务永远成立）

- ❌ <不可逆 / 越权操作必须人类确认，例：永远不自主合 MR / 上线>。
- ❌ 关键节点不自己拍板，到点停下来问业务方。
- ❌ 没把握的需求不猜，直接在话题里用 \`choices\` 给运营选项。
`;
}
