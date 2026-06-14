/**
 * src/web/restartMachine.test.ts
 *
 * BL-18:重启状态机纯函数单测。
 * 覆盖 computeRestartTransition / restartDisplayLive / restartStepIndex 三个纯函数。
 *
 * 重点场景:
 *   - floor 前不收敛(防假收敛)
 *   - 全 serving 且过 floor → 收敛
 *   - 40s 超时 → timeout
 *   - recovered 计数正确驱动显示覆盖
 */

import { describe, it, expect } from "vitest";
import {
  computeRestartTransition,
  restartDisplayLive,
  restartStepIndex,
  LK_RESTART_TIMEOUT_SECS,
  LK_RESTART_FLOOR_SECS,
  type RestartState,
} from "./restartMachine.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkState(
  status: RestartState["status"],
  startedSecsAgo: number,
): RestartState {
  return {
    status,
    startedAt: status === "serving" ? null : Date.now() - startedSecsAgo * 1000,
    elapsed: startedSecsAgo,
  };
}

// ---------------------------------------------------------------------------
// computeRestartTransition
// ---------------------------------------------------------------------------

describe("computeRestartTransition", () => {
  it("非 restarting 状态直接原样返回(serving)", () => {
    const restart = mkState("serving", 0);
    const result = computeRestartTransition(restart, Date.now(), 3, 3);
    expect(result.status).toBe("serving");
  });

  it("非 restarting 状态直接原样返回(timeout)", () => {
    const restart = mkState("timeout", 50);
    const result = computeRestartTransition(restart, Date.now(), 0, 3);
    expect(result.status).toBe("timeout");
  });

  it("floor 前不收敛:elapsed=2s, 全部 serving → 仍 restarting", () => {
    const restart = mkState("restarting", 2);
    const now = restart.startedAt! + 2000;
    const result = computeRestartTransition(restart, now, 3, 3);
    expect(result.status).toBe("restarting");
    expect(result.elapsed).toBe(2);
  });

  it("floor 前不收敛:elapsed=3s(刚好 floor-1), 全部 serving → 仍 restarting", () => {
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + (LK_RESTART_FLOOR_SECS - 1) * 1000;
    const result = computeRestartTransition(restart, now, 3, 3);
    expect(result.status).toBe("restarting");
  });

  it("全 serving 且过 floor → 收敛到 serving", () => {
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + LK_RESTART_FLOOR_SECS * 1000;
    const result = computeRestartTransition(restart, now, 3, 3);
    expect(result.status).toBe("serving");
    expect(result.elapsed).toBe(LK_RESTART_FLOOR_SECS);
  });

  it("过 floor 但未全恢复 → 仍 restarting", () => {
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + 10 * 1000;
    const result = computeRestartTransition(restart, now, 2, 3);
    expect(result.status).toBe("restarting");
  });

  it("超时(40s)且未全恢复 → timeout", () => {
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + LK_RESTART_TIMEOUT_SECS * 1000;
    const result = computeRestartTransition(restart, now, 1, 3);
    expect(result.status).toBe("timeout");
    expect(result.elapsed).toBe(LK_RESTART_TIMEOUT_SECS);
  });

  it("超时且全部已恢复:收敛优先于超时(全 serving → serving)", () => {
    // 边界:elapsed === timeout 但 recovered === total → 应收敛(不升 timeout)
    // 逻辑顺序:先判超时(elapsed>=40 且 <total)→ 再判收敛;全部 serving 不进超时分支
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + LK_RESTART_TIMEOUT_SECS * 1000;
    const result = computeRestartTransition(restart, now, 3, 3);
    // recoveredCount >= totalCount → 收敛分支生效(timeout 分支要求 <)
    expect(result.status).toBe("serving");
  });

  it("total=0 时不收敛(无 bot)", () => {
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + 10 * 1000;
    const result = computeRestartTransition(restart, now, 0, 0);
    // totalCount=0 → 收敛条件 totalCount>0 不满足 → restarting
    expect(result.status).toBe("restarting");
  });

  it("elapsed 计算正确(四舍五入)", () => {
    const restart = mkState("restarting", 0);
    const now = restart.startedAt! + 7500; // 7.5s → round 到 8
    const result = computeRestartTransition(restart, now, 0, 3);
    expect(result.elapsed).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// restartDisplayLive
// ---------------------------------------------------------------------------

describe("restartDisplayLive", () => {
  it("serving 状态直接透传真实 liveness", () => {
    expect(restartDisplayLive("offline", "serving")).toBe("offline");
    expect(restartDisplayLive("serving", "serving")).toBe("serving");
    expect(restartDisplayLive("degraded", "serving")).toBe("degraded");
  });

  it("restarting:真实 serving → 显 serving(驱动 recovered 进度)", () => {
    expect(restartDisplayLive("serving", "restarting")).toBe("serving");
  });

  it("restarting:真实非 serving → 显 transitioning(sky 呼吸点)", () => {
    expect(restartDisplayLive("offline", "restarting")).toBe("transitioning");
    expect(restartDisplayLive("degraded", "restarting")).toBe("transitioning");
    expect(restartDisplayLive("unknown", "restarting")).toBe("transitioning");
  });

  it("timeout:真实 serving → 显 serving", () => {
    expect(restartDisplayLive("serving", "timeout")).toBe("serving");
  });

  it("timeout:真实非 serving → 显 offline(红)", () => {
    expect(restartDisplayLive("offline", "timeout")).toBe("offline");
    expect(restartDisplayLive("degraded", "timeout")).toBe("offline");
    expect(restartDisplayLive("unknown", "timeout")).toBe("offline");
  });

  it("recovered 计数逻辑:3 bot 中 2 已 serving", () => {
    const bots = ["serving", "serving", "offline"];
    const recoveredCount = bots.filter((b) => restartDisplayLive(b, "restarting") === "serving").length;
    expect(recoveredCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// restartStepIndex
// ---------------------------------------------------------------------------

describe("restartStepIndex", () => {
  it("serving → step 2(已恢复)", () => {
    expect(restartStepIndex("serving", 0, 3, 3)).toBe(2);
    expect(restartStepIndex("serving", 100, 0, 3)).toBe(2);
  });

  it("restarting + elapsed<3 且 recovered=0 → step 0(服务重启中)", () => {
    expect(restartStepIndex("restarting", 0, 0, 3)).toBe(0);
    expect(restartStepIndex("restarting", 2, 0, 3)).toBe(0);
  });

  it("restarting + elapsed>=3 → step 1(助手重连中)", () => {
    expect(restartStepIndex("restarting", 3, 0, 3)).toBe(1);
    expect(restartStepIndex("restarting", 10, 1, 3)).toBe(1);
  });

  it("restarting + elapsed<3 但有 recovered → step 1", () => {
    expect(restartStepIndex("restarting", 1, 1, 3)).toBe(1);
  });

  it("timeout → step 1(助手重连中,仍在等)", () => {
    expect(restartStepIndex("timeout", 40, 1, 3)).toBe(1);
  });
});
