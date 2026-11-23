import { buildAgentEnv } from "../agent/childEnv.js";
import { TurnEventQueue } from "../agent/turnEventQueue.js";
import { runColdJson } from "../agent/coldJsonRunner.js";
import {
  createPerfMarker,
  type AgentRunner, type AgentStreamEvent, type RunHandle, type RunOptions,
} from "../agent/runner.js";

export function antigravityArgs(opts: RunOptions): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
  if (opts.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--mode", opts.permissionMode === "ask" ? "plan" : "accept-edits");
  return args;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export class AntigravityTurnDecoder {
  sessionId?: string;
  // A missing result must fail even if the CLI exits zero.
  assistantError: string | undefined = "stream ended without a terminal result";
  private readonly tools = new Set<number>();
  private invalidSession = false;

  constructor(private readonly expectedSessionId?: string) {}

  *decodeLine(line: string): Generator<AgentStreamEvent> {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const event = object(raw);
    const step = object(event?.step_update);
    const result = object(event?.result);
    const id = event?.conversation_id ?? step?.conversation_id ?? result?.conversation_id;
    const expected = this.sessionId ?? this.expectedSessionId;
    if (typeof id === "string" && id && expected && id !== expected) {
      this.invalidSession = true;
      this.assistantError = "unexpected conversation ID";
    }
    if (this.invalidSession) return;
    if (!this.sessionId && typeof id === "string" && id) {
      this.sessionId = id;
      yield { type: "system_init", sessionId: id, raw };
    }
    if (event?.event === "result" && result) {
      if (result.status === "SUCCESS" && !this.sessionId) {
        this.assistantError = "missing conversation ID";
        return;
      }
      const success = result.status === "SUCCESS";
      this.assistantError = success ? undefined : String(result.error || result.status || "invalid result");
      if (success && typeof result.response === "string") {
        yield { type: "answer_snapshot", text: result.response, raw };
      }
      yield { type: "result", stopReason: String(result.status), raw };
    } else if (event?.event === "step_update" && step?.step_type === "tool" &&
        typeof step.step_index === "number" && typeof step.tool_name === "string") {
      if (!this.tools.has(step.step_index)) {
        this.tools.add(step.step_index);
        yield { type: "tool_use", toolName: step.tool_name, toolInput: object(step.tool_info)?.parameters, raw };
      }
      if (step.state === "DONE") yield { type: "tool_result", raw };
    } else {
      // Agent response steps may precede more tools. Only result.response is final.
      yield { type: "raw", raw };
    }
  }

}

export class AntigravityRunner implements AgentRunner {
  run(opts: RunOptions): RunHandle {
    const env = buildAgentEnv(opts.botGitIdentity, opts.gitlabToken, opts.larkCliConfigDir);
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    delete env.AGY_ADC_AUTH;
    const markPerf = createPerfMarker(opts.onPerfMarker);
    const decoder = new AntigravityTurnDecoder(opts.resumeSessionId);
    const handle = runColdJson(opts, {
      name: "agy",
      bin: opts.agentBinPath ?? "agy",
      args: antigravityArgs(opts),
      input: JSON.stringify({ event: "user", message: { content: opts.prompt } }) + "\n",
      env, markPerf, installHint: "Antigravity CLI",
      decoder,
    });
    // Native result validation must advance even while a card update waits on Feishu.
    const events = new TurnEventQueue();
    const drain = (async () => {
      try {
        for await (const event of handle.events) events.push(event);
      } finally {
        events.end();
      }
    })();
    const done = Promise.all([handle.done, drain]).then(([result]) => result);
    return { ...handle, events, done };
  }
}
