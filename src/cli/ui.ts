/**
 * src/cli/ui.ts
 *
 * Interaction + output helpers for the larkway CLI.
 *
 * No third-party UI deps: prompts use node:readline/promises, colors are
 * inline ANSI, the QR code uses qrcode-terminal (gracefully degrading to a
 * highlighted URL print if the package is unavailable).
 *
 * Non-interactive contract: prompt/confirm/select/multiSelect take an
 * `opts.nonInteractive` flag. When set, they either return a provided default
 * or throw a clear error — they NEVER block on stdin. Callers (commands) pass
 * ctx.flags.nonInteractive through.
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// JSON mode flag
// ---------------------------------------------------------------------------

/**
 * When true, all human-readable output (print/success/step/warning/spinner)
 * is redirected to stderr so stdout stays clean for emitJson() JSON lines.
 * This is the standard CLI convention: --json → only structured JSON on stdout.
 *
 * Call setJsonMode(true) immediately after parsing flags (in index.ts / tests).
 */
let _jsonMode = false;

/** Enable or disable JSON mode. Affects print/success/step/warning/spinner. */
export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

/** Current JSON mode state (readable by tests / commands). */
export function isJsonMode(): boolean {
  return _jsonMode;
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const useColor = stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (open: string, close: string) => (s: string): string =>
  useColor ? `[${open}m${s}[${close}m` : s;

/** Green success text. */
export const ok = wrap("32", "39");
/** Yellow warning text. */
export const warn = wrap("33", "39");
/** Red error text. */
export const err = wrap("31", "39");
/** Dim/grey secondary text. */
export const dim = wrap("2", "22");
/** Bold emphasis. */
export const bold = wrap("1", "22");
/** Cyan accent (used for URLs / values). */
export const cyan = wrap("36", "39");

// ---------------------------------------------------------------------------
// Plain output
// ---------------------------------------------------------------------------

/**
 * Write a line to the appropriate output stream.
 * In JSON mode: stderr (keeps stdout clean for emitJson JSON lines).
 * Otherwise: stdout.
 */
function writeLine(line: string): void {
  if (_jsonMode) {
    process.stderr.write(line + "\n");
  } else {
    stdout.write(line + "\n");
  }
}

/** Print a line. In --json mode goes to stderr to avoid polluting JSON stdout. */
export function print(line = ""): void {
  writeLine(line);
}

/** Print a line to stderr (diagnostics that shouldn't pollute --json stdout). */
export function printErr(line = ""): void {
  process.stderr.write(line + "\n");
}

/** Numbered wizard step header, e.g. step(2, "扫码登录飞书"). */
export function step(n: number, title: string): void {
  print("");
  print(bold(`[${n}] ${title}`));
}

/** Success line with a check mark. */
export function success(msg: string): void {
  print(ok(`✓ ${msg}`));
}

/** Warning line. */
export function warning(msg: string): void {
  print(warn(`! ${msg}`));
}

/** Error line (to stderr). */
export function failure(msg: string): void {
  printErr(err(`✗ ${msg}`));
}

// ---------------------------------------------------------------------------
// Structured (--json) output
// ---------------------------------------------------------------------------

/** Emit a single JSON object on stdout (machine-readable, --json mode). */
export function emitJson(obj: unknown): void {
  stdout.write(JSON.stringify(obj) + "\n");
}

// ---------------------------------------------------------------------------
// Spinner (minimal, no deps)
// ---------------------------------------------------------------------------

export interface Spinner {
  /** Stop the spinner; optionally print a final line. */
  stop: (finalLine?: string) => void;
}

/**
 * Start a lightweight braille spinner. No-op (just prints the label once) when
 * stdout is not a TTY or in JSON mode, so logs/CI/machine output stays clean.
 * In JSON mode spinner output goes to stderr to keep stdout pure for emitJson.
 */
export function spinner(label: string): Spinner {
  if (_jsonMode || !stdout.isTTY) {
    process.stderr.write(dim(label + " ...") + "\n");
    return {
      stop: (finalLine?: string) => {
        if (finalLine) process.stderr.write(finalLine + "\n");
      },
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    stdout.write(`\r${cyan(frames[i++ % frames.length])} ${label}`);
  }, 80);
  return {
    stop: (finalLine?: string) => {
      clearInterval(timer);
      stdout.write("\r[K"); // clear line
      if (finalLine) print(finalLine);
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

export interface PromptOpts {
  /** Default value used when input is empty (interactive) or always (non-int). */
  default?: string;
  /** When true: never read stdin; return default or throw. */
  nonInteractive?: boolean;
}

function nonInteractiveValue<T>(
  question: string,
  fallback: T | undefined,
): T {
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Non-interactive mode requires a value for: ${question.replace(/[:?]\s*$/, "")}`,
  );
}

/** Free-text prompt. Returns trimmed input or default. */
export async function prompt(question: string, opts: PromptOpts = {}): Promise<string> {
  if (opts.nonInteractive) return nonInteractiveValue(question, opts.default);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = opts.default ? dim(` (${opts.default})`) : "";
    const answer = (await rl.question(`${question}${suffix} `)).trim();
    return answer === "" && opts.default !== undefined ? opts.default : answer;
  } finally {
    rl.close();
  }
}

export interface ConfirmOpts {
  nonInteractive?: boolean;
}

/** Yes/no confirm. `def` is the default returned on empty input / non-int. */
export async function confirm(
  question: string,
  def = false,
  opts: ConfirmOpts = {},
): Promise<boolean> {
  if (opts.nonInteractive) return def;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const hint = def ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${dim(hint)} `)).trim().toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export interface Choice<T = string> {
  /** Stable value returned on selection. */
  value: T;
  /** Human-readable label shown in the list. */
  label: string;
  /** Optional dim hint after the label. */
  hint?: string;
}

export interface SelectOpts<T> {
  /** Index of the default choice (returned on empty input / non-int). */
  defaultIndex?: number;
  nonInteractive?: boolean;
}

/** Single-choice select. Returns the chosen choice's value. */
export async function select<T>(
  question: string,
  choices: Choice<T>[],
  opts: SelectOpts<T> = {},
): Promise<T> {
  if (choices.length === 0) throw new Error(`select("${question}"): no choices`);
  if (opts.nonInteractive) {
    const idx = opts.defaultIndex ?? 0;
    return choices[idx].value;
  }
  print(question);
  choices.forEach((c, i) => {
    const marker = i === opts.defaultIndex ? cyan("›") : " ";
    const hint = c.hint ? dim(` — ${c.hint}`) : "";
    print(`  ${marker} ${i + 1}) ${c.label}${hint}`);
  });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const def = opts.defaultIndex !== undefined ? String(opts.defaultIndex + 1) : undefined;
      const raw = (await rl.question(`选择 ${dim(`1-${choices.length}`)}${def ? dim(` (${def})`) : ""} `)).trim();
      const pick = raw === "" && def ? Number(def) : Number(raw);
      if (Number.isInteger(pick) && pick >= 1 && pick <= choices.length) {
        return choices[pick - 1].value;
      }
      warning(`请输入 1-${choices.length} 之间的数字`);
    }
  } finally {
    rl.close();
  }
}

export interface MultiSelectOpts<T> {
  /** Values pre-selected by default (returned as-is in non-int mode). */
  defaults?: T[];
  nonInteractive?: boolean;
}

/**
 * Multi-choice select. User enters comma/space separated indices (e.g. "1,3").
 * Returns the chosen values. Empty input → defaults (or []).
 */
export async function multiSelect<T>(
  question: string,
  choices: Choice<T>[],
  opts: MultiSelectOpts<T> = {},
): Promise<T[]> {
  if (opts.nonInteractive) return opts.defaults ?? [];
  print(question);
  choices.forEach((c, i) => {
    const pre = opts.defaults?.includes(c.value) ? cyan("●") : "○";
    const hint = c.hint ? dim(` — ${c.hint}`) : "";
    print(`  ${pre} ${i + 1}) ${c.label}${hint}`);
  });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const raw = (await rl.question(dim("逗号/空格分隔序号(回车=默认) "))).trim();
    if (raw === "") return opts.defaults ?? [];
    const idxs = raw
      .split(/[\s,]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length);
    return idxs.map((i) => choices[i - 1].value);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// QR code rendering (registerApp device-code flow)
// ---------------------------------------------------------------------------

/**
 * Render a QR code for `url` in the terminal. Uses qrcode-terminal when
 * available; degrades to a highlighted URL print if the package failed to
 * install (so init never hard-blocks on a missing optional dep).
 *
 * This function is SYNCHRONOUS. qrcode-terminal.generate() calls its callback
 * synchronously (verified), so we use createRequire (CJS-compatible) to load
 * it without an async dynamic import. This allows callers (onQRCodeReady SDK
 * callbacks typed as `(info) => void`) to remain synchronous — fixing the
 * fire-and-forget async bug (P1-B).
 */
const _require = createRequire(import.meta.url);

export function renderQRCode(url: string): void {
  try {
    const mod = _require("qrcode-terminal") as {
      default?: { generate: (u: string, o: { small: boolean }, cb: (s: string) => void) => void };
      generate?: (u: string, o: { small: boolean }, cb: (s: string) => void) => void;
    };
    const generate = mod.default?.generate ?? mod.generate;
    if (!generate) throw new Error("qrcode-terminal has no generate()");
    // generate() calls back synchronously (qrcode-terminal is CJS, no async I/O).
    generate(url, { small: true }, (qr: string) => {
      print(qr);
    });
  } catch {
    // Graceful degrade: highlight the URL boldly so it's still actionable.
    print("");
    print(warn("(无法渲染二维码,请手动打开下方链接用飞书扫码登录)"));
    print(bold(cyan(url)));
    print("");
  }
}
