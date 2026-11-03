import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { BotConfigSchema } from "./botLoader.js";
import { botRunLimits } from "./runLimits.js";

const baseYaml = `id: long-task
name: Long Task
description: Native long-running turn
app_id: cli_fixture
app_secret_env: FIXTURE_SECRET
bot_open_id: ou_fixture
`;

describe("bot YAML to runner limits", () => {
  it.each(["", "subprocess_timeout_seconds: 0\n"])("has no default total deadline: %s", (extra) => {
    const bot = BotConfigSchema.parse(yaml.load(baseYaml + extra));
    expect(botRunLimits(bot)).toEqual({
      subprocessTimeoutMs: undefined,
      responseSurfaceIdleTimeoutMs: undefined,
      responseSurfaceIdleKillMs: undefined,
    });
  });

  it("maps an explicit 3-hour budget independently of idle settings", () => {
    const bot = BotConfigSchema.parse(yaml.load(baseYaml + `subprocess_timeout_seconds: 10800
idle_timeout_seconds: 600
idle_kill_seconds: 900
`));
    expect(botRunLimits(bot)).toEqual({
      subprocessTimeoutMs: 10_800_000,
      responseSurfaceIdleTimeoutMs: 600_000,
      responseSurfaceIdleKillMs: 900_000,
    });
  });

  it("changing only the idle notice never enables either kill budget", () => {
    const bot = BotConfigSchema.parse(yaml.load(baseYaml + "idle_timeout_seconds: 600\n"));
    expect(botRunLimits(bot).subprocessTimeoutMs).toBeUndefined();
    expect(botRunLimits(bot).responseSurfaceIdleKillMs).toBeUndefined();
  });

  it.each(["-1", "0.5", ".nan", ".inf", "null", '"3600"', "2147484"])(
    "rejects invalid or overflowing total budget %s",
    (value) => {
      const result = BotConfigSchema.safeParse(yaml.load(baseYaml + `subprocess_timeout_seconds: ${value}\n`));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["subprocess_timeout_seconds"]);
    },
  );

  it("accepts the largest whole-second budget safe for Node", () => {
    const bot = BotConfigSchema.parse(yaml.load(baseYaml + "subprocess_timeout_seconds: 2147483\n"));
    expect(botRunLimits(bot).subprocessTimeoutMs).toBe(2_147_483_000);
  });
});
