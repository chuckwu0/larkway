/**
 * src/web/restartMachine.ts
 *
 * BL-18:重启过渡态状态机 — 纯函数逻辑(无 DOM 依赖,可单测)。
 * 照 restartKit.jsx useRestartMachine 的判断规则。
 *
 * 顶层常量 + 函数从这里导出,app.js 里的同名变量从此处摘出、独立可测。
 */

/** 超时阈值(秒)。超过此时长未全恢复 → status='timeout'(升红)。 */
export const LK_RESTART_TIMEOUT_SECS = 40;

/** 防假收敛 floor(秒)。至少等这么久才能判定收敛,给 bridge 真正停+起来的时间。 */
export const LK_RESTART_FLOOR_SECS = 4;

export type RestartStatus = "serving" | "restarting" | "timeout";

export interface RestartState {
  status: RestartStatus;
  startedAt: number | null;
  elapsed: number;
}

export interface RestartTransitionResult {
  status: RestartStatus;
  elapsed: number;
}

/**
 * 纯函数:计算重启机器的下一状态。
 *
 * @param restart   当前状态
 * @param now       Date.now() 毫秒
 * @param recoveredCount  当前真实 liveness=serving 的 bot 数
 * @param totalCount      bot 总数
 * @returns 新状态(不含 startedAt,调用方保留)
 *
 * 判断逻辑:
 *   - 非 restarting → 原样返回
 *   - elapsed >= LK_RESTART_TIMEOUT_SECS 且未全恢复 → timeout(升红)
 *   - elapsed >= LK_RESTART_FLOOR_SECS 且全部 serving 且 total > 0 → serving(收敛)
 *   - 否则保持 restarting
 */
export function computeRestartTransition(
  restart: RestartState,
  now: number,
  recoveredCount: number,
  totalCount: number,
): RestartTransitionResult {
  if (restart.status !== "restarting") {
    return { status: restart.status, elapsed: restart.elapsed };
  }
  const elapsed = Math.round((now - (restart.startedAt ?? now)) / 1000);
  // 超时:elapsed >= 40 且未全恢复
  if (elapsed >= LK_RESTART_TIMEOUT_SECS && recoveredCount < totalCount) {
    return { status: "timeout", elapsed };
  }
  // 收敛:elapsed >= floor(4) 且全部已 serving
  if (elapsed >= LK_RESTART_FLOOR_SECS && recoveredCount >= totalCount && totalCount > 0) {
    return { status: "serving", elapsed };
  }
  return { status: "restarting", elapsed };
}

/**
 * 纯函数:重启中显示覆盖 —— 某 bot 的「展示用」liveness(不改真实 liveness)。
 *
 * @param realLive      真实 liveness(state.liveness[id] 或 effLive)
 * @param restartStatus 当前重启机器状态
 * @returns 展示用 liveness key
 *
 * 显示覆盖规则(照 restartBoard.jsx):
 *   - serving → 原样
 *   - restarting:真实已 serving → 显 serving(驱动 N/total 进度);否则 → transitioning(sky)
 *   - timeout:未 serving → offline(红);已 serving → serving
 */
export function restartDisplayLive(realLive: string, restartStatus: RestartStatus): string {
  if (restartStatus === "serving") return realLive;
  if (restartStatus === "restarting") {
    return realLive === "serving" ? "serving" : "transitioning";
  }
  if (restartStatus === "timeout") {
    return realLive === "serving" ? "serving" : "offline";
  }
  return realLive;
}

/**
 * 纯函数:派生分步 stepIndex(0=服务重启中 / 1=助手重连中 / 2=已恢复)。
 */
export function restartStepIndex(
  restartStatus: RestartStatus,
  elapsed: number,
  recoveredCount: number,
  _totalCount: number,
): 0 | 1 | 2 {
  if (restartStatus === "serving") return 2;
  if (elapsed < 3 && recoveredCount === 0) return 0;
  return 1;
}
