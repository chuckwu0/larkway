/**
 * src/cli/commands/memory.ts
 *
 * `larkway memory edit <id>` — edit L2 职能 (bots/<id>.memory.md)
 * `larkway memory show <id>`  — print current content (supports --json)
 * `larkway memory set <id> --file <path>` — non-interactive write from file
 *
 * Memory files are the L2 "职能定义" that shape each bot's behavior.
 * This command edits bots/<id>.memory.md only; never touches the bot yaml.
 *
 * 注意区分两个同名概念,别混淆:
 *   - bots/<id>.memory.md   = L2 职能/身份,投影进 workspace AGENTS.md,本命令编辑的就是它。
 *   - workspace memory/      = 跨 session 长期记忆容器(preferences / decisions / ...),
 *                             由 Agent 在 runtime 维护,本命令不碰。
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { CliContext } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse command-local flags from the remaining args. Returns cleaned positionals + flag values. */
function parseArgs(args: string[]): {
  sub: string | undefined;
  id: string | undefined;
  file: string | undefined;
  positionals: string[];
} {
  let file: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--file" || args[i] === "-f") && i + 1 < args.length) {
      file = args[++i];
    } else if (args[i].startsWith("--file=")) {
      file = args[i].slice("--file=".length);
    } else {
      positionals.push(args[i]);
    }
  }

  const [sub, id] = positionals;
  return { sub, id, file, positionals };
}

/**
 * Open content in $EDITOR (fallback: vi, then nano) using a temp file.
 * Returns the edited content, or null if the user didn't save / editor failed.
 */
async function openInEditor(initial: string): Promise<string | null> {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";

  // Write initial content to a temp file.
  const tmpDir = path.join(tmpdir(), `larkway-memory-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "memory.md");
  try {
    await writeFile(tmpFile, initial, "utf-8");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [tmpFile], {
        stdio: "inherit",
        // shell needed for editor strings like "code --wait"
        shell: editor.includes(" "),
      });
      child.on("error", (e) => reject(new Error(`Failed to launch editor "${editor}": ${e.message}`)));
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`Editor exited with code ${code}`));
        else resolve();
      });
    });

    return await readFile(tmpFile, "utf-8");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Ensure the bot yaml exists (otherwise the memory file would be orphaned).
 * Returns false + emits error if the bot doesn't exist.
 */
async function assertBotExists(ctx: CliContext, id: string): Promise<boolean> {
  const exists = await ctx.botsStore.botExists(id);
  if (!exists) {
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: `Bot "${id}" not found`, id });
    } else {
      ctx.ui.failure(`Bot "${id}" 不存在。运行 larkway bot list 查看已注册的 bot。`);
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sub-command: show
// ---------------------------------------------------------------------------

async function subShow(ctx: CliContext, id: string): Promise<number> {
  if (!(await assertBotExists(ctx, id))) return 1;

  let content: string;
  try {
    content = await ctx.botsStore.readMemory(id);
  } catch (e) {
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: `Bot "${id}" 还没有 memory 文件`, id });
    } else {
      ctx.ui.failure(`Bot "${id}" 还没有 memory 文件。运行 larkway memory edit ${id} 创建。`);
    }
    return 1;
  }

  if (ctx.flags.json) {
    ctx.ui.emitJson({ ok: true, id, content });
  } else {
    ctx.ui.print(content);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Sub-command: set (non-interactive, reads from --file)
// ---------------------------------------------------------------------------

async function subSet(ctx: CliContext, id: string, file: string): Promise<number> {
  if (!(await assertBotExists(ctx, id))) return 1;

  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch (e) {
    const msg = `无法读取文件 "${file}": ${e instanceof Error ? e.message : String(e)}`;
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: msg, id });
    } else {
      ctx.ui.failure(msg);
    }
    return 1;
  }

  await ctx.botsStore.writeMemory(id, content);

  if (ctx.flags.json) {
    ctx.ui.emitJson({ ok: true, id, written: content.length });
  } else {
    ctx.ui.success(`Bot "${id}" memory 已从 ${file} 写入(${content.length} 字节)`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Sub-command: edit (opens $EDITOR)
// ---------------------------------------------------------------------------

async function subEdit(ctx: CliContext, id: string): Promise<number> {
  if (!(await assertBotExists(ctx, id))) return 1;

  // Read existing memory, or create from template if absent.
  let initial: string;
  let isNew = false;
  try {
    initial = await ctx.botsStore.readMemory(id);
  } catch {
    // File doesn't exist yet — seed with template.
    const bot = await ctx.botsStore.readBot(id);
    initial = ctx.botsStore.genMemoryTemplate(bot.name);
    isNew = true;
  }

  if (ctx.flags.nonInteractive) {
    // Non-interactive + edit: refuse (must use --file instead).
    const msg = `非交互模式不支持 edit 子命令,请改用: larkway memory set ${id} --file <path>`;
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: msg, id });
    } else {
      ctx.ui.failure(msg);
    }
    return 1;
  }

  if (isNew) {
    ctx.ui.warning(`Bot "${id}" 还没有 memory 文件,将用模板初始化。`);
  }

  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  ctx.ui.print(ctx.ui.dim(`正在打开编辑器: ${editor}`));

  let edited: string | null;
  try {
    edited = await openInEditor(initial);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: msg, id });
    } else {
      ctx.ui.failure(msg);
    }
    return 1;
  }

  if (edited === null || edited === initial) {
    ctx.ui.warning("内容未变,未写入。");
    return 0;
  }

  await ctx.botsStore.writeMemory(id, edited);
  if (ctx.flags.json) {
    ctx.ui.emitJson({ ok: true, id, written: edited.length });
  } else {
    ctx.ui.success(`Bot "${id}" memory 已保存(${edited.length} 字节)`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const USAGE = `larkway memory <子命令> <id> [flags]

子命令:
  edit <id>             用 $EDITOR 编辑 L2 memory(文件不存在时用模板初始化)
  show <id>             打印当前 memory 内容(--json 机器可读)
  set  <id> --file <p>  从文件读入并写回 memory(非交互友好)

示例:
  larkway memory edit gitlab
  larkway memory show gitlab --json
  larkway memory set gitlab --file /tmp/updated.md --non-interactive`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(ctx: CliContext, args: string[]): Promise<number> {
  const { sub, id, file } = parseArgs(args);

  if (!sub || sub === "help" || sub === "--help") {
    ctx.ui.print(USAGE);
    return sub ? 0 : 1;
  }

  // Validate sub-command early.
  if (sub !== "edit" && sub !== "show" && sub !== "set") {
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: `未知子命令: ${sub}` });
    } else {
      ctx.ui.failure(`未知子命令: ${sub}`);
      ctx.ui.print(USAGE);
    }
    return 1;
  }

  // All sub-commands require an <id>.
  if (!id) {
    if (ctx.flags.json) {
      ctx.ui.emitJson({ ok: false, error: `缺少 bot id 参数` });
    } else {
      ctx.ui.failure(`缺少 bot id 参数`);
      ctx.ui.print(USAGE);
    }
    return 1;
  }

  if (sub === "show") {
    return subShow(ctx, id);
  }

  if (sub === "set") {
    if (!file) {
      if (ctx.flags.json) {
        ctx.ui.emitJson({ ok: false, error: `set 子命令需要 --file <path>` });
      } else {
        ctx.ui.failure(`set 子命令需要 --file <path>`);
        ctx.ui.print(USAGE);
      }
      return 1;
    }
    return subSet(ctx, id, file);
  }

  // sub === "edit"
  return subEdit(ctx, id);
}
