// Opt-in local runtime check. Run after signing in with agy as the bridge user.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityRunner } from "../src/antigravity/runner.js";
import { commandProbeEnv } from "../src/runtimeRequirements.js";

if (process.argv[2] !== "--run") throw new Error("Pass --run to submit three local Antigravity turns.");
process.env.PATH = commandProbeEnv().PATH;
const cwd = await mkdtemp(join(tmpdir(), "larkway-antigravity-"));
console.log("Test workspace:", cwd);
const runner = new AntigravityRunner();

async function ask(prompt: string, resumeSessionId?: string) {
  const handle = runner.run({
    cwd, prompt, resumeSessionId, model: "gemini-4-neon", effort: "high",
    permissionMode: "acceptEdits", timeoutMs: 180_000, pidFilePath: null,
  });
  let answer = "";
  let toolCalls = 0;
  const collect = async () => {
    for await (const event of handle.events) {
      if (event.type === "tool_use") toolCalls++;
      if (event.type === "answer_snapshot") answer = event.text.trim();
    }
  };
  const [outcome] = await Promise.all([handle.done, collect()]);
  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.sessionId);
  return { id: outcome.sessionId, answer, toolCalls };
}

const wordA = randomUUID();
const wordB = randomUUID();
const contents = randomUUID();
const first = await ask(`Remember the topic word ${wordA} only in conversation. Write exactly ${contents} into smoke.txt in the current directory. Reply only WRITTEN.`);
assert.equal((await readFile(join(cwd, "smoke.txt"), "utf8")).trim(), contents);
assert.equal(first.answer, "WRITTEN");
assert.ok(first.toolCalls > 0, "Expected a native tool call");
const other = await ask(`The topic word is ${wordB}. Do not use tools. Reply with just that word.`);
assert.notEqual(other.id, first.id);
assert.equal(other.answer, wordB);
assert.equal(other.toolCalls, 0);
const resumed = await ask("Without tools, return only the topic word from my first message.", first.id);
assert.equal(resumed.id, first.id);
assert.equal(resumed.answer, wordA);
assert.equal(resumed.toolCalls, 0);
console.log("Passed file write, independent topics in one workspace, and cold resume.");
