/**
 * src/web/public/app.js
 *
 * Larkway 管理面 — 原生 ES module SPA，无框架、无构建步骤。
 *
 * Token 解析:server 注入 window.__LK_BOOT_TOKEN__ > ?token= 回退。
 * 所有 /api/* 请求自动带 X-Larkway-Token header。
 * secret 绝不显示真值(gitlab_token_env 变量名是内部细节,UI 不暴露)。
 *
 * 面向非技术用户:字段全用大白话标签 + helper text,基础/高级渐进披露。
 * API 契约不变(fetch 路径 / 字段名 / token 处理与 api.ts 一致)。
 */

// ---------------------------------------------------------------------------
// 内联 SVG 图标(无 emoji 当图标)
// ---------------------------------------------------------------------------

const ICONS = {
  check: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  x: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  trash: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>`,
  info: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>`,
  warn: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  qr: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/><path d="M7 7h0M17 7h0M7 17h0"/></svg>`,
  edit: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  chat: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z"/></svg>`,
  inbox: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16l2 11v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3Z"/><path d="M4 15h5a3 3 0 0 0 6 0h5"/></svg>`,
  shield: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/></svg>`,
  lock: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  gear: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
  chevron: `<svg class="icon chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  save: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>`,
  upload: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`,
  refresh: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>`,
  zap: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-6Z"/></svg>`,
  code: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>`,
  scan: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/></svg>`,
  box: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
  plus: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  repo: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h11l3 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 4v3h3M7 13h8M7 16h5"/></svg>`,
  branch: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v9M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 6c0 5-6 4-6 9"/></svg>`,
  folder: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  link2: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>`,
  users: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/></svg>`,
  pull: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 11l4 4 4-4M4 21h16"/></svg>`,
  arrowRight: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
};

const EVENT_FILTERS = [
  ["all", "全部", "all"],
  ["received", "已收到", "received"],
  ["running", "处理中", "running"],
  ["completed", "已完成", "completed"],
  ["filtered", "被过滤", "filtered"],
  ["failed", "异常", "failed"],
];

const EVENT_STATUS = {
  received: { label: "已收到", text: "已收到，等待交给 Agent" },
  running: { label: "处理中", text: "Agent 正在处理" },
  completed: { label: "已完成", text: "已回复" },
  filtered: { label: "被过滤", text: "已忽略" },
  failed: { label: "异常", text: "处理失败" },
};

/**
 * 动画心电图(ECG)/心跳线 —— serving/degraded 走流动折线,offline 走平线。
 * 复刻 shared.jsx LkHeart:offline=平线(opacity .5),否则=ECG(strokeDash 流动)。
 * @param {"serving"|"degraded"|"offline"|"unknown"} liveKey
 * @param {number} w
 * @param {number} h
 * @param {number} sw
 */
function heartSVG(liveKey, w = 72, h = 22, sw = 1.8) {
  const c = LIVE_COLOR[liveKey] ?? LIVE_COLOR.unknown;
  const mid = h / 2;
  const flat = `M0 ${mid} H${w}`;
  const ecg =
    `M0 ${mid} H${(w * 0.28).toFixed(2)} l3 ${(-mid * 0.5).toFixed(2)} l4 ${(mid * 1.3).toFixed(2)} ` +
    `l5 ${(-mid * 1.5).toFixed(2)} l4 ${(mid * 0.7).toFixed(2)} H${w}`;
  const isFlow = liveKey === "serving" || liveKey === "degraded";
  const d = liveKey === "offline" ? flat : ecg;
  const cls = isFlow ? "lk-ecgline" : "lk-ecgflat";
  const dur = liveKey === "serving" ? "1.5s" : "2.6s";
  // inline style so the per-bot duration + dash flow stay self-contained
  const styleAttr = isFlow
    ? `style="stroke-dasharray:0.1 8, 40 200;animation:lk-ecg ${dur} linear infinite"`
    : `style="opacity:.5"`;
  return (
    `<svg class="lk-heart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<path class="${cls}" d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" ${styleAttr} /></svg>`
  );
}

// ---------------------------------------------------------------------------
// Token 解析(server 注入 > ?token= 回退;只存内存,不落 localStorage)
// ---------------------------------------------------------------------------

const PLACEHOLDER = "__LARKWAY_TOKEN__";

function resolveToken() {
  const injected = window.__LK_BOOT_TOKEN__;
  if (typeof injected === "string" && injected && injected !== PLACEHOLDER) {
    return injected;
  }
  return new URLSearchParams(location.search).get("token") || "";
}

const TOKEN = resolveToken();

// ---------------------------------------------------------------------------
// api() — fetch 封装(自动带 token header + JSON 序列化)
// ---------------------------------------------------------------------------

/**
 * 调一个 /api/* 路由。
 * @param {string} method  GET / POST / PUT ...
 * @param {string} path    以 / 开头,如 "/api/bots"
 * @param {unknown} [body] POST/PUT 的 JSON body
 * @returns {Promise<{status:number, ok:boolean, json:any}>}
 */
export async function api(method, path, body) {
  const headers = { "X-Larkway-Token": TOKEN };
  /** @type {RequestInit} */
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    return { status: 0, ok: false, json: { error: String(e) } };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应;保持 null */
  }
  return { status: res.status, ok: res.ok, json };
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------

let _toastTimer = null;

/**
 * Handle for the short-burst poll timer started after restart/start actions.
 * Stored at module scope so a new action can always cancel any prior burst.
 * @type {ReturnType<typeof setInterval>|null}
 */
let _restartPollHandle = null;

/**
 * 显示一条短暂提示。
 * @param {string} msg
 * @param {"info"|"error"|"warn"|"ok"} [kind]
 */
export function toast(msg, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  const ic =
    kind === "ok" ? ICONS.check : kind === "error" ? ICONS.x : kind === "warn" ? ICONS.warn : ICONS.info;
  el.innerHTML = `${ic}<span></span>`;
  el.querySelector("span:last-child").textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4500);
}

// ---------------------------------------------------------------------------
// confirmDialog — 可复用的自定义确认弹窗(替代原生 confirm())
// ---------------------------------------------------------------------------

/**
 * 弹出一个自定义确认弹窗，返回 Promise<boolean>。
 * 复用 .modal-backdrop / .modal / .modal-header / .modal-body / .modal-footer / .modal-btns 的 CSS。
 *
 * @param {object} opts
 * @param {string} opts.title         弹窗标题
 * @param {string} opts.body          弹窗正文（纯文本，会 esc 处理）
 * @param {string} [opts.confirmText] 确认按钮文案（默认「确认」）
 * @param {boolean} [opts.confirmDanger] true → 确认按钮加 .btn-danger 样式
 * @returns {Promise<boolean>}        用户点确认 → true；取消 / Esc / 点背景 → false
 */
function confirmDialog({ title, body, confirmText = "确认", confirmDanger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");

    const dangerClass = confirmDanger ? " btn-danger" : " btn-primary";
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-header">${esc(title)}</div>
        <div class="modal-body" style="white-space:pre-wrap">${esc(body)}</div>
        <div class="modal-footer">
          <div class="modal-btns">
            <button class="btn" id="cd-cancel" type="button">取消</button>
            <button class="btn${dangerClass}" id="cd-confirm" type="button">${esc(confirmText)}</button>
          </div>
        </div>
      </div>
    `;

    function close(result) {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === "Escape") close(false);
    }

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
    backdrop.querySelector("#cd-cancel").addEventListener("click", () => close(false));
    backdrop.querySelector("#cd-confirm").addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey);

    document.body.appendChild(backdrop);
    backdrop.querySelector("#cd-confirm").focus();
  });
}

// ---------------------------------------------------------------------------
// deleteAssistantDialog — 删除助手确认弹窗(设计稿 shared.jsx LkDeleteFlow)
// ---------------------------------------------------------------------------

/**
 * 弹出删除助手确认弹窗。包含:红色 trash 徽章、说明文案、ack 勾选框 gate、footer。
 * 勾选前删除按钮 disabled;点「删除助手」且已勾选 → resolve(true);其余 → resolve(false)。
 * 关闭后自动从 DOM 移除(防泄漏)。
 *
 * @param {{id:string,name:string}} bot
 * @returns {Promise<boolean>}
 */
function deleteAssistantDialog(bot) {
  return new Promise((resolve) => {
    let resolved = false;
    function done(result) {
      if (resolved) return;
      resolved = true;
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === "Escape") done(false);
    }

    const trashIcon15 = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px;flex-shrink:0"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>`;
    const trashIcon19 = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:19px;height:19px"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>`;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");

    backdrop.innerHTML = `
      <div class="modal" style="max-width:440px">
        <div class="modal-body" style="padding:24px 24px 0">
          <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px">
            <div style="flex-shrink:0;width:40px;height:40px;border-radius:11px;background:#fef2f2;border:1px solid #fecaca;color:#dc2626;display:flex;align-items:center;justify-content:center">
              ${trashIcon19}
            </div>
            <div>
              <div style="font-size:18px;font-weight:700;color:var(--text);line-height:1.3;margin-bottom:4px">删除「${esc(bot.name)}」？</div>
              <div style="font-size:14px;color:var(--muted);line-height:1.5">
                会从这台电脑的名册里移除它的配置。<b>重启服务后它就不再回复。</b>飞书那边的机器人应用还在 —— 之后重新扫码可以再配回来。
              </div>
            </div>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:flex-start;gap:10px;margin-bottom:20px">
            <input type="checkbox" id="del-ack-chk" style="margin-top:3px;accent-color:#dc2626;flex-shrink:0" />
            <label for="del-ack-chk" style="font-size:13.5px;color:var(--text);cursor:pointer;line-height:1.5">
              我明白删除后它会停止服务。
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding:12px 24px 20px">
          <div class="modal-btns">
            <button class="btn" id="del-cancel" type="button">取消</button>
            <button class="btn btn-del-confirm" id="del-confirm" type="button" disabled>
              ${trashIcon15} 删除助手
            </button>
          </div>
        </div>
      </div>
    `;

    const ackChk = backdrop.querySelector("#del-ack-chk");
    const confirmBtn = backdrop.querySelector("#del-confirm");

    // 启用/禁用的视觉(粉底/红底·白字·opacity)全交给 .btn-del-confirm 的 :disabled CSS,
    // 这里只切 disabled —— 复刻设计稿 LkDeleteFlow(文字图标永远白色)。
    ackChk.addEventListener("change", () => {
      confirmBtn.disabled = !ackChk.checked;
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(false);
    });
    backdrop.querySelector("#del-cancel").addEventListener("click", () => done(false));
    confirmBtn.addEventListener("click", () => {
      if (!ackChk.checked) return;
      done(true);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(backdrop);
    backdrop.querySelector("#del-cancel").focus();
  });
}


/**
 * 删除助手流程:弹确认 → DELETE /api/bot/:id → 更新 state → toast。
 * @param {string} id
 */
async function doDeleteBot(id) {
  const bot = state.bots.find((b) => b.id === id);
  if (!bot) return;
  const name = bot.name || id;

  const ok = await deleteAssistantDialog(bot);
  if (!ok) return;

  const res = await api("DELETE", `/api/bot/${encodeURIComponent(id)}`);
  if (!res.ok) {
    toast(res.json?.error ?? `删除失败（${res.status}）`, "error");
    return;
  }

  // Find neighbour before mutating state.
  const idx = state.bots.findIndex((b) => b.id === id);
  state.bots = state.bots.filter((b) => b.id !== id);

  if (state.selected === id) {
    // Select the item at the same index (now shifted), or the one before, or null.
    const next = state.bots[idx] ?? state.bots[idx - 1] ?? null;
    state.selected = next ? next.id : null;
  }

  renderBotList();
  renderBotDetail(state.selected);
  toast(`已删除「${name}」`, "ok");

  // Restart-aware hint: if bridge is running, this bot is still loaded until restart.
  if (state.bridge?.running) {
    toast("重启服务后彻底生效（bridge 正在运行）", "info");
  }
}

// ---------------------------------------------------------------------------
// 全局 UI 状态
// ---------------------------------------------------------------------------

const state = {
  /** @type {"local"} */
  mode: "local",
  /** @type {Array<{id:string,name:string,description:string,avatar:string|null}>} */
  bots: [],
  /** @type {string|null} */
  selected: null,
  /** Bridge 进程状态(来自 GET /api/bridge;null = 未知)。 */
  bridge: /** @type {{running:boolean,pid:number|null,platform:string,mode:string}|null} */ (null),
  /** Runtime requirement diagnostics from GET /api/runtime/requirements. */
  requirements: /** @type {{requirements:Array<any>,missingRequired:Array<any>,missingOptional:Array<any>}|null} */ (null),
  /**
   * 每个 bot 的实时在线状态(来自 GET /api/status 的 bots[]),按 id 索引。
   * "serving"=🟢正常服务中 / "degraded"=🟡连接异常 / "offline"=🔴未运行掉线 / null=状态未知。
   * @type {Record<string, "serving"|"degraded"|"offline">}
   */
  liveness: {},
  /** /api/status 是否成功拉取过(失败时 UI 降级显示「状态未知」灰点)。 */
  livenessKnown: false,
  /**
   * 每个 bot 的头像 URL(来自 /api/bots 或 /api/status 的 avatar 字段),按 id 索引。
   * null = 无头像(回退首字母占位)。public image/png,直接 <img src> 加载。
   * @type {Record<string, string|null>}
   */
  avatars: {},
  /** 每个 bot 距上次心跳的毫秒数(/api/status 的 lastSeenMs),按 id 索引;null/缺失=不显示心跳时间。 */
  lastSeenMs: {},
  /**
   * BL-17: 每个 bot 当前 bridge 进程实际运行的底座(/api/status 的 runningBackend),按 id 索引。
   * null = status.json 缺失或旧 bridge 未写入(不做不一致比对,避免假阳性)。
   * @type {Record<string, string|null>}
   */
  runningBackends: {},
  /** 最近事件面板筛选状态,按 bot id 索引。 */
  eventFilters: {},
  /** 最近事件面板是否展开全部,按 bot id 索引。 */
  eventShowAll: {},
  /** 当前详情表单是否有未保存改动(基础+高级 yaml 表单)。 */
  formDirty: false,
  /** 当前详情 memory 是否有未保存改动。 */
  memoryDirty: false,

  /**
   * 待重启提示:来自 GET /api/status 的 pendingRestart 字段。
   * newCount = 有 yaml 无 status.json(新增 bot,待重启上线);
   * ghostCount = 有 status.json 无 yaml(已删 bot,待重启下线)。
   * @type {{newCount:number, ghostCount:number, ghosts:Array<{id:string,name?:string}>}}
   */
  pendingRestart: { newCount: 0, ghostCount: 0, ghosts: [] },
  /**
   * 重启过渡态机器(BL-18)。
   * status: 'serving' = idle / 'restarting' = 重启中(sky) / 'timeout' = 超时未恢复(红)。
   * startedAt = 触发时的 Date.now() 毫秒;null 表示 idle。
   * elapsed = 上次 ticker/poll 更新的已用秒数(整数)。
   * @type {{status:'serving'|'restarting'|'timeout', startedAt:number|null, elapsed:number}}
   */
  restart: { status: "serving", startedAt: null, elapsed: 0 },
};

/** 状态可视化用的固定文案/语义,集中一处(DRY)。 */
const LIVENESS = {
  serving: { dotClass: "is-serving", label: "正常服务中", aria: "正常服务中" },
  degraded: {
    dotClass: "is-degraded",
    label: "连接异常（bridge 在跑但没连上飞书）",
    aria: "连接异常",
  },
  offline: {
    dotClass: "is-offline",
    label: "掉线（bridge 未运行，去本机跑 larkway start）",
    aria: "掉线，未运行",
  },
  unknown: { dotClass: "is-unknown", label: "状态未知", aria: "状态未知" },
  // ── 第 5 态:transitioning(重启中,sky) ──────────────────────────────────
  transitioning: { dotClass: "is-transitioning", label: "重启中", aria: "重启中，预期内" },
};

/**
 * 状态语义色(LK_COLORS,shared.jsx)—— 只给状态用(圆点/状态条/心跳线/hero 光环),
 * 与 indigo 品牌色严格分离。c=主色 / soft=浅底 / edge=描边 / text=深字。
 */
const LIVE_COLOR = {
  serving: "#16a34a",
  degraded: "#d97706",
  offline: "#dc2626",
  unknown: "#94a3b8",
  // ── 第 5 态:transitioning(重启中,sky 天蓝) ─────────────────────────────
  // sky #0284c7 落在「天蓝 ~230」区,避开活性绿/橙/红与交互 indigo,天然读作「进行中/冷静」
  transitioning: "#0284c7",
};
const LIVE_SOFT = {
  serving: "#f0fdf4",
  degraded: "#fffbeb",
  offline: "#fef2f2",
  unknown: "#f8fafc",
  transitioning: "#f0f9ff",
};
const LIVE_EDGE = {
  serving: "#bbf7d0",
  degraded: "#fde68a",
  offline: "#fecaca",
  unknown: "#e2e8f0",
  transitioning: "#bae6fd",
};
const LIVE_TEXT = {
  serving: "#15803d",
  degraded: "#b45309",
  offline: "#b91c1c",
  unknown: "#64748b",
  transitioning: "#0369a1",
};
/** hero 状态条 / 侧栏的「正常服务中」短中标签。 */
const LIVE_LABEL = {
  serving: "正常服务中",
  degraded: "连接异常",
  offline: "已掉线",
  unknown: "状态未知",
  transitioning: "重启中",
};
/** hero 状态条的长版文案(复刻 shared.jsx LK_LABEL_LONG)。 */
const LIVE_LABEL_LONG = {
  serving: "正常服务中",
  degraded: "连接异常 · bridge 在跑但没连上飞书",
  offline: "已掉线 · 去本机跑 larkway start",
  unknown: "状态未知",
  transitioning: "重启中 · 预期内,正在恢复",
};

// ---------------------------------------------------------------------------
// 重启过渡态(BL-18)常量 + 纯函数逻辑(照 restartKit.jsx)
// 纯函数不依赖 state,方便单测。
// ---------------------------------------------------------------------------

/** 超时阈值(秒)。超过此时长未全恢复 → status='timeout'(升红)。 */
export const LK_RESTART_TIMEOUT_SECS = 40;
/** 防假收敛 floor(秒)。至少等这么久才能判定收敛,给 bridge 真正停+起来的时间。 */
export const LK_RESTART_FLOOR_SECS = 4;

/** 文案规范(照 restartKit.jsx LK_RS)。 */
const LK_RS = {
  label: "重启中",
  typical: "通常十几秒就好",
  /** @param {number} s 已用秒 */
  elapsed: (s) => `重启中 ${s}s…`,
  steps: [
    { key: "bridge",    label: "服务重启中", hint: "本机 bridge 进程正在重启" },
    { key: "reconnect", label: "助手重连中", hint: "各助手正逐个连回飞书" },
    { key: "done",      label: "已恢复",     hint: "全部连回,回到正常服务中" },
  ],
  calmTitle: "你点了重启 —— 正在恢复中",
  calmSay: "这是预期内的过渡:服务停一下、助手再逐个连回来。好了会自动转回「正常服务中」,不用管它,也不用重复点。",
  timeoutTitle: "重启异常,可能出问题了",
  /** @param {number} s 已用秒 @param {number|null} left 未恢复数 */
  timeoutSay: (s, left) =>
    `重启已超过 ${s} 秒还没恢复${left ? `,还有 ${left} 个助手没连回` : ""}。这可能不只是一次普通重启 —— 看一眼日志最快定位。`,
};

/**
 * 纯函数:计算重启机器的下一状态(供单测 + 状态更新共用)。
 * @param {{ status: string, startedAt: number|null, elapsed: number }} restart 当前状态
 * @param {number} now              Date.now() 毫秒
 * @param {number} recoveredCount   当前真实 liveness=serving 的 bot 数
 * @param {number} totalCount       bot 总数
 * @returns {{ status: string, elapsed: number }}  新状态(不含 startedAt,调用方保留)
 */
export function computeRestartTransition(restart, now, recoveredCount, totalCount) {
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
 * 纯函数:重启中显示覆盖 —— 某 bot 的「展示用」liveness(不改真实 state.liveness)。
 * @param {string} realLive   真实 liveness(state.liveness[id] 或 effLive)
 * @param {'serving'|'restarting'|'timeout'} restartStatus
 * @returns {string}  展示用 liveness key
 */
export function restartDisplayLive(realLive, restartStatus) {
  if (restartStatus === "serving") return realLive;
  if (restartStatus === "restarting") {
    // 真实已 serving → 显 serving(驱动 N/total 进度);否则显 transitioning(sky 呼吸点)
    return realLive === "serving" ? "serving" : "transitioning";
  }
  if (restartStatus === "timeout") {
    // 超时:未 serving → 红 offline;已 serving → serving
    return realLive === "serving" ? "serving" : "offline";
  }
  return realLive;
}

/**
 * 纯函数:派生分步 stepIndex(0=服务重启中 / 1=助手重连中 / 2=已恢复)。
 * @param {'serving'|'restarting'|'timeout'} restartStatus
 * @param {number} elapsed  已用秒
 * @param {number} recoveredCount
 * @param {number} totalCount
 * @returns {0|1|2}
 */
export function restartStepIndex(restartStatus, elapsed, recoveredCount, totalCount) {
  if (restartStatus === "serving") return 2;
  if (elapsed < 3 && recoveredCount === 0) return 0;
  return 1;
}

// 1s ticker handle(更新 elapsed 显示)
let _restartTickerHandle = null;

/** 启动 1s ticker;不重复启动。 */
function startRestartTicker() {
  if (_restartTickerHandle !== null) return;
  _restartTickerHandle = setInterval(() => {
    if (state.restart.status !== "restarting") {
      stopRestartTicker();
      return;
    }
    const now = Date.now();
    const elapsed = Math.round((now - (state.restart.startedAt ?? now)) / 1000);
    state.restart.elapsed = elapsed;
    // 只更新顶栏(计时显示)而不触发全量 re-render;全量收敛由 pollStatus 驱动
    renderServiceIndicator();
  }, 1000);
}

/** 停止 ticker。 */
function stopRestartTicker() {
  if (_restartTickerHandle !== null) {
    clearInterval(_restartTickerHandle);
    _restartTickerHandle = null;
  }
}

/** indigo 品牌 + 交互色 token(BR,directionAtelier.jsx)。 */
const BR = {
  c: "#4f46e5",
  soft: "#eef2ff",
  edge: "#c7d2fe",
  text: "#4338ca",
};

// ---------------------------------------------------------------------------
// Backend 身份层系统 —— 复刻 backendKit.jsx
// 铁律:身份层=中性 slate ·静(不碰 indigo / 不碰绿橙红)
// ---------------------------------------------------------------------------

/**
 * 底座静态元数据注册表(可扩展:加第三个 = 加一条)。
 * 仅 claude + codex 是真实底座;gemini 等假想项不进 UI。
 */
const LK_BACKENDS_META = {
  claude: { id: "claude", name: "Claude Code", short: "Claude", vendor: "Anthropic 订阅", mono: "CC" },
  codex:  { id: "codex",  name: "Codex",       short: "Codex",  vendor: "OpenAI 订阅",  mono: "CX" },
};

/** 显示顺序(镜像 backendKit.jsx LK_BACKEND_ORDER,去掉 hypothetical gemini)。 */
const LK_BACKEND_ORDER = ["codex", "claude"];
const LK_BACKEND_DEFAULT = "codex";

/**
 * 从 id 或 bot 对象解析底座元数据。未知 id 回退通用槽。
 * @param {string|{backend?:string}|null|undefined} idOrBot
 */
function lkBackend(idOrBot) {
  const id = typeof idOrBot === "string" ? idOrBot
           : (idOrBot && idOrBot.backend) || LK_BACKEND_DEFAULT;
  return LK_BACKENDS_META[id] || {
    id, name: id, short: id, vendor: "第三方底座",
    mono: String(id || "?").slice(0, 2).toUpperCase(),
  };
}

/**
 * 渲染 LkBackendMono 字标小方 tile 的 HTML。
 * @param {string} backendId
 * @param {"sm"|"md"|"lg"|"xl"} [size]
 */
function lkBackendMonoHTML(backendId, size = "md") {
  const b = lkBackend(backendId);
  return (
    `<span class="lk-bk-mono lk-bk-mono--${size}" aria-hidden="true">${esc(b.mono)}</span>`
  );
}

/**
 * 渲染 LkBackendChip 方角身份 chip 的 HTML。
 * props: backend · size 'sm'|'md' · mono(显示字标 tile) · vendor(显示一句话定位)
 * @param {string} backendId
 * @param {{size?:"sm"|"md", mono?:boolean, vendor?:boolean}} [opts]
 */
function lkBackendChipHTML(backendId, opts = {}) {
  const { size = "md", mono = false, vendor = false } = opts;
  const b = lkBackend(backendId);
  const monoHTML = mono ? lkBackendMonoHTML(backendId, size === "sm" ? "sm" : "md") : "";
  const hasMono = mono ? " has-mono" : "";
  return (
    `<span class="lk-bk-chip lk-bk-chip--${size}${hasMono}" title="底座:${esc(b.name)}">` +
    monoHTML +
    `<span class="lk-bk-chip-inner">` +
    `<span class="lk-bk-chip-name">${esc(b.short)}</span>` +
    (vendor ? `<span class="lk-bk-chip-vendor">· ${esc(b.vendor)}</span>` : "") +
    `</span></span>`
  );
}

/**
 * 全局 backend ready 状态(从 GET /api/backends 拉取)。
 * 启动时加载一次,select 组件用它驱动「就绪/未就绪」显示。
 * @type {Record<string, boolean>}
 */
let _backendReady = {};

/** 拉一次 /api/backends 并更新 _backendReady,供 select 渲染前调用。 */
async function loadBackends() {
  try {
    const res = await api("GET", "/api/backends");
    if (res.ok && Array.isArray(res.json?.backends)) {
      for (const b of res.json.backends) {
        if (typeof b.id === "string") _backendReady[b.id] = !!b.ready;
      }
    }
  } catch { /* 失败静默;ready 默认 true */ }
}

/**
 * 渲染 LkBackendSelect 单选列表(可扩展,N 个底座)的 HTML。
 * 选中项用 indigo 交互色;未就绪提示用中性 slate(绝不染状态色)。
 *
 * @param {string} value        当前选中的 backend id
 * @param {string} [containerId] 容器 id(用于 change 事件冒泡)
 */
function lkBackendSelectHTML(value, containerId = "") {
  const items = LK_BACKEND_ORDER.map((id) => {
    const b = lkBackend(id);
    const sel = id === value;
    const isReady = _backendReady[id] !== false; // 默认就绪
    const isDefault = id === LK_BACKEND_DEFAULT;
    const selClass = sel ? " is-sel" : "";
    return (
      `<button type="button" role="radio" aria-checked="${sel}" data-bk-id="${esc(id)}"` +
      ` class="lk-bk-select-btn${selClass}"` +
      (containerId ? ` data-bk-container="${esc(containerId)}"` : "") + `>` +
      // 单选圈(选中=indigo)
      `<span class="lk-bk-radio">${sel ? `<span class="lk-bk-radio-dot"></span>` : ""}</span>` +
      // 字标 tile(中性)
      lkBackendMonoHTML(id, "xl") +
      `<div style="min-width:0;flex:1">` +
      `<div class="lk-bk-item-name">${esc(b.name)}` +
      (isDefault ? `<span class="lk-bk-default-badge">默认</span>` : "") +
      `</div>` +
      `<div class="lk-bk-item-vendor">${esc(b.vendor)}</div>` +
      // 边界提示:未就绪(中性 slate,绝不染状态色)
      (!isReady
        ? `<div class="lk-bk-not-ready-hint">${ICONS.info}` +
          `本机还没就绪 —— 先在终端 <code>${esc(id)} login</code></div>`
        : "") +
      `</div>` +
      // 就绪/未就绪 badge(中性)
      (isReady
        ? `<span class="lk-bk-ready-badge">${ICONS.check} 本机就绪</span>`
        : `<span class="lk-bk-unready-badge">未就绪</span>`) +
      `</button>`
    );
  }).join("");

  return (
    `<div class="lk-bk-select">` +
    `<div class="lk-bk-select-group" role="radiogroup" aria-label="选择底座">` +
    items +
    `</div>` +
    // 「会增长的列表」的可视暗示
    `<div class="lk-bk-more-hint">` +
    ICONS.plus +
    `更多底座会随 Larkway 升级自动出现在这里 —— 由代码侧的运行器注册表提供。` +
    `</div>` +
    `</div>`
  );
}

/**
 * 为一个 .lk-bk-select 容器接线:点 button → 切选中态 + 调回调。
 * @param {Element} container  包含 .lk-bk-select 的 DOM 元素
 * @param {function(string):void} onChange  选中新 id 时调用
 */
function wireLkBackendSelect(container, onChange) {
  container.querySelectorAll(".lk-bk-select-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.bkId;
      if (!id) return;
      // 更新 is-sel + aria-checked + 单选圈
      container.querySelectorAll(".lk-bk-select-btn").forEach((b) => {
        const sel = b.dataset.bkId === id;
        b.classList.toggle("is-sel", sel);
        b.setAttribute("aria-checked", String(sel));
        const dot = b.querySelector(".lk-bk-radio-dot");
        if (sel && !dot) {
          const radio = b.querySelector(".lk-bk-radio");
          if (radio) radio.innerHTML = `<span class="lk-bk-radio-dot"></span>`;
        } else if (!sel && dot) {
          const radio = b.querySelector(".lk-bk-radio");
          if (radio) radio.innerHTML = "";
        }
      });
      onChange(id);
    });
  });
}

/**
 * hex 色 + alpha → rgba(r,g,b,a) 字符串。
 * 设计稿 lkHexA(hex, alpha) 的等价实现。
 * @param {string} hex  "#rrggbb" 格式
 * @param {number} alpha 0–1
 */
function lkHexA(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// BL-17: 运行态 vs 配置态底座不一致 badge
// ---------------------------------------------------------------------------

/**
 * 判断一个 bot 的「运行中底座」与「已存配置底座」是否不一致。
 *
 * 规则:
 *   - runningBackend = null → 未知(旧 bridge / 无 status.json) → 不报不一致,返回 false
 *   - runningBackend === configuredBackend → 一致 → false
 *   - 不同 → true
 *
 * 这是纯函数:接受两个 string|null,不读全局 state,方便单测。
 *
 * @param {string|null} runningBackend  当前 bridge 进程实际运行的底座(来自 status.json)
 * @param {string}      configuredBackend  yaml 磁盘里保存的底座(来自 /api/bots)
 * @returns {boolean}
 */
function isBackendMismatch(runningBackend, configuredBackend) {
  if (runningBackend === null) return false; // unknown → no badge
  return runningBackend !== configuredBackend;
}

/**
 * 生成「运行中 X · 已存 Y,重启服务生效」持久 badge 的 HTML。
 * 位置:名册行(sm)和详情区(md)复用此函数,由 size 控制尺寸。
 *
 * 视觉语言:复用现有 lk-attention-pill(「需处理」视觉语义 = service-attention amber)。
 * NOT 底座身份色(中性 slate 系) — 这是服务状态,不是 backend 身份。
 *
 * @param {string} runningBackend  当前实际运行底座 id
 * @param {string} configuredBackend  磁盘配置底座 id
 * @param {"sm"|"md"} [size]
 * @returns {string} HTML string
 */
function backendMismatchBadgeHTML(runningBackend, configuredBackend, size = "sm") {
  const runningShort = lkBackend(runningBackend).short;
  const configuredShort = lkBackend(configuredBackend).short;
  const isSm = size === "sm";
  const fontSize = isSm ? "10.5px" : "12px";
  const padding = isSm ? "1px 7px" : "3px 10px";
  // 复用 degraded amber(service-attention,与 lk-attention-pill 一致)
  const color = LIVE_TEXT.degraded;       // "#b45309"
  const bg    = LIVE_SOFT.degraded;       // "#fffbeb"
  const edge  = LIVE_EDGE.degraded;       // "#fde68a"
  return (
    `<span class="lk-backend-mismatch-badge" ` +
    `title="bridge 正在跑 ${runningShort},已存配置是 ${configuredShort};重启服务后生效" ` +
    `style="display:inline-flex;align-items:center;gap:4px;padding:${padding};border-radius:999px;` +
    `font-size:${fontSize};font-weight:700;letter-spacing:.02em;` +
    `color:${color};background:${bg};border:1px solid ${edge}">` +
    ICONS.warn +
    `运行中 ${esc(runningShort)} · 已存 ${esc(configuredShort)},重启生效` +
    `</span>`
  );
}

/** 取某个 bot 的 liveness key(serving/degraded/offline/unknown)。 */
function botLiveness(id) {
  if (!state.livenessKnown) return "unknown";
  return state.liveness[id] ?? "offline";
}

/**
 * 有效 liveness(效 live):bridge 未运行时全部 bot 视为 offline,否则用实际状态。
 * 复刻 statusAction.jsx 的 effLive 计算逻辑。
 */
function effLive(id) {
  const bridgeRunning = state.bridge?.running ?? false;
  return bridgeRunning ? botLiveness(id) : "offline";
}

function missingRequiredForBot(id) {
  const missing = state.requirements?.missingRequired;
  if (!Array.isArray(missing)) return [];
  return missing.filter((req) => Array.isArray(req.botIds) && req.botIds.includes(id));
}

function missingRequiredAll() {
  return Array.isArray(state.requirements?.missingRequired) ? state.requirements.missingRequired : [];
}

function requirementShortLabel(req) {
  if (!req) return "运行依赖";
  if (req.command === "lark-cli") return "飞书 CLI";
  if (req.kind === "secret") return req.label === "Git access token env" ? "Git 访问令牌" : req.label;
  return req.label || req.command || "运行依赖";
}

function requirementInstallText(req) {
  if (!req) return "";
  if (req.command === "lark-cli") return "安装并配置 lark-cli 后重启服务。";
  if (req.kind === "secret") return req.installHint || "在看板里粘贴 Git access token，或补齐 bot yaml 的 git_token_env。";
  return req.installHint || "安装缺失的 CLI 后重启服务。";
}

function primaryMissingForBot(id) {
  return missingRequiredForBot(id)[0] ?? null;
}

/**
 * pendingNew:bridge 在跑且存在从未上报过 status 的 bot(unknown liveness)的数量。
 * 对应 LkServiceIndicator pendingNew prop。
 */
function pendingNewCount() {
  if (!state.bridge?.running) return 0;
  if (!state.livenessKnown) return 0;
  let count = 0;
  for (const bot of state.bots) {
    // 从没写过 status.json(lastSeenMs 缺失)= bridge 启动时还没这个 bot → 重启才加载它。
    // 用 lastSeenMs 而非 liveness:classifyStatus(无文件)返回 "offline" 不是 null,
    // 但 getStatus 对无 status.json 的 bot 回 lastSeenMs:null —— 这才是「从没上报过」的真信号。
    if (state.lastSeenMs[bot.id] == null) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 状态可操作化:LK_FIXIT 数据 + 渲染函数(Design Block B)
// ---------------------------------------------------------------------------

/**
 * LK_FIXIT — 每个非健康状态对应的「怎么办」配置。
 * 复刻 statusAction.jsx LK_FIXIT。
 * action: 'restart' | 'start' | 'logs' | 'rescan'
 */
const LK_FIXIT = {
  serving: null,
  degraded: {
    icon: "warn",
    heading: "现在啥情况 —— 还能修",
    say: "服务在跑，但这个助手没连上飞书，暂时收不到 @。多数情况重启服务能恢复。",
    primary: { label: "重启服务", busyLabel: "正在重启服务…", action: "restart" },
    secondary: { label: "查看日志", action: "logs" },
    more: [
      {
        d: "它对应的飞书应用可能没开「事件订阅 / 长连接」",
        hint: "重新扫码配一次最快能修。",
        cta: { label: "重新扫码配对", action: "rescan" },
      },
      {
        d: "看一眼日志里最近有没有报错",
        hint: "把红色那几行截给工程师，定位最快。",
        cta: { label: "查看日志", action: "logs" },
      },
    ],
  },
  offline: {
    icon: "warn",
    heading: "现在啥情况 —— 服务停了",
    say: "本机服务没在跑，所有助手都不会回复。",
    primary: { label: "启动服务", busyLabel: "正在启动服务…", action: "start" },
    secondary: { label: "查看日志", action: "logs" },
    more: null,
  },
  unknown: {
    icon: "info",
    heading: "现在啥情况 —— 还没上过线",
    say: "它还没上线过 —— 启动服务后它会自动连上飞书。",
    primary: { label: "启动服务", busyLabel: "正在启动服务…", action: "start" },
    secondary: null,
    more: null,
  },
};

/**
 * 渲染「怎么办」面板的 HTML string。
 * @param {"degraded"|"offline"|"unknown"} liveKey
 * @param {string|null} busyAction  当前 busy 的 action key（null = not busy）
 * @param {boolean} moreOpen        degraded 的二级排查是否展开
 */
function buildStatusActionPanel(liveKey, busyAction = null, moreOpen = false) {
  const fx = LK_FIXIT[liveKey];
  if (!fx) return "";

  const sc = {
    c: LIVE_COLOR[liveKey] ?? LIVE_COLOR.unknown,
    soft: LIVE_SOFT[liveKey] ?? LIVE_SOFT.unknown,
    edge: LIVE_EDGE[liveKey] ?? LIVE_EDGE.unknown,
    text: LIVE_TEXT[liveKey] ?? LIVE_TEXT.unknown,
  };

  // Icon SVG (inline, sized 17, current-color)
  const iconPath = fx.icon === "warn"
    ? "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"
    : "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16v-4M12 8h.01";
  const iconSvg =
    `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;display:block">` +
    iconPath.split("M").filter(Boolean).map((seg) => `<path d="M${seg}"/>`).join("") +
    `</svg>`;

  // Fix button helper (inline styles, indigo interactive color)
  const fixBtnPrimary = (isBusy) => {
    const label = isBusy ? fx.primary.busyLabel : fx.primary.label;
    const actionIcon = fx.primary.action === "restart" ? ICONS.refresh : ICONS.zap;
    const spinner = `<span class="btn-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:lk-spin .7s linear infinite;flex-shrink:0"></span>`;
    return (
      `<button type="button" class="lk-fix-btn lk-fix-btn-primary" ` +
      `data-fix-action="${fx.primary.action}" ${isBusy ? "disabled" : ""} ` +
      `style="display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:9px;` +
      `font-size:13.5px;font-weight:600;font-family:inherit;cursor:${isBusy ? "wait" : "pointer"};` +
      `white-space:nowrap;border:1px solid ${BR.c};background:${BR.c};color:#fff;transition:background .14s,border-color .14s">` +
      (isBusy ? spinner : actionIcon) +
      `${esc(label)}</button>`
    );
  };

  const fixBtnSecondary = (sec) => {
    return (
      `<button type="button" class="lk-fix-btn lk-fix-btn-secondary" ` +
      `data-fix-action="${sec.action}" ` +
      `style="display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:9px;` +
      `font-size:13.5px;font-weight:600;font-family:inherit;cursor:pointer;` +
      `white-space:nowrap;border:1px solid ${BR.edge};background:#fff;color:${BR.text};transition:background .14s,border-color .14s">` +
      ICONS.code +
      `${esc(sec.label)}</button>`
    );
  };

  const primaryBusy = busyAction === fx.primary.action;
  const heading = fx.heading;
  const say = fx.say;

  // Build "more" section for degraded
  let moreSection = "";
  if (liveKey === "degraded" && Array.isArray(fx.more)) {
    const chevSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;display:block;transform:${moreOpen ? "rotate(90deg)" : "none"};transition:transform .2s"><path d="m9 6 6 6-6 6"/></svg>`;
    const moreItems = moreOpen
      ? `<ol style="margin:12px 0 2px;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px">` +
        fx.more.map((m, i) => {
          const ctaBtn = m.cta
            ? `<button type="button" class="lk-fix-btn lk-fix-btn-ghost" data-fix-action="${m.cta.action}" ` +
              `style="display:inline-flex;align-items:center;gap:5px;margin-top:7px;padding:5px 11px;border-radius:8px;` +
              `border:1px solid ${BR.edge};background:#fff;color:${BR.text};font-size:12.5px;font-weight:600;` +
              `cursor:pointer;font-family:inherit">` +
              (m.cta.action === "rescan" ? ICONS.scan : ICONS.code) +
              esc(m.cta.label) + `</button>`
            : "";
          return (
            `<li style="display:flex;gap:11px;align-items:flex-start">` +
            `<span style="flex-shrink:0;width:20px;height:20px;margin-top:1px;border-radius:999px;` +
            `background:#fff;border:1px solid ${sc.edge};color:${sc.text};font-size:11px;font-weight:700;` +
            `display:flex;align-items:center;justify-content:center">${i + 1}</span>` +
            `<div style="min-width:0">` +
            `<div style="font-size:13.5px;color:#334155;line-height:1.5">${esc(m.d)}</div>` +
            `<div style="font-size:12.5px;color:#64748b;line-height:1.5;margin-top:1px">${esc(m.hint)}</div>` +
            ctaBtn +
            `</div></li>`
          );
        }).join("") +
        `</ol>`
      : "";

    moreSection =
      `<div style="margin-top:14px;padding-top:13px;border-top:1px dashed ${sc.edge}">` +
      `<button type="button" class="lk-fix-more-toggle" ` +
      `style="display:inline-flex;align-items:center;gap:7px;padding:4px 6px;margin:-4px -6px;` +
      `border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;color:#64748b">` +
      chevSvg + `还是不行?` +
      `</button>` +
      moreItems +
      `</div>`;
  }

  return (
    `<div class="lk-status-action" data-live="${liveKey}" ` +
    `style="margin-top:18px;border-radius:13px;overflow:hidden;background:#fff;` +
    `border:1px solid ${sc.edge};box-shadow:0 1px 2px rgba(15,23,42,.04)">` +
    `<div style="display:flex;align-items:stretch">` +
    // Left accent bar (status color)
    `<span style="width:4px;flex-shrink:0;background:${sc.c}"></span>` +
    `<div style="flex:1;padding:15px 18px;background:${sc.soft}">` +
    `<div style="display:flex;gap:11px">` +
    // Icon badge
    `<span style="flex-shrink:0;width:30px;height:30px;border-radius:9px;background:#fff;` +
    `border:1px solid ${sc.edge};color:${sc.c};display:flex;align-items:center;justify-content:center">` +
    iconSvg + `</span>` +
    `<div style="min-width:0;flex:1">` +
    `<div style="font-size:12.5px;font-weight:700;letter-spacing:.04em;color:${sc.text};margin-bottom:4px">` +
    esc(heading) + `</div>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#334155">${esc(say)}</p>` +
    `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:13px;align-items:center">` +
    fixBtnPrimary(primaryBusy) +
    (fx.secondary ? fixBtnSecondary(fx.secondary) : "") +
    `</div>` +
    `</div></div>` +
    moreSection +
    `</div></div></div>`
  );
}

// ---------------------------------------------------------------------------
// 辅助工具
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 头像(沉浸感):真头像 <img> + 首字母彩色回退
// ---------------------------------------------------------------------------

/** 回退占位的稳定色板(由 id/name 哈希取一个,保证同 bot 永远同色)。 */
const AVATAR_COLORS = [
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

/** 对字符串做稳定哈希(djb2 变体),用于挑回退底色。 */
function hashString(s) {
  let h = 5381;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h);
}

/** 取名字首字(中文取首字符,空则 "?")。 */
function avatarInitial(name, id) {
  const s = String(name || id || "").trim();
  if (!s) return "?";
  return Array.from(s)[0].toUpperCase();
}

/**
 * 构建一个头像 HTML 片段:有 avatar → <img>(onerror 回退首字母);无 → 直接首字母彩底。
 * 状态圆点作为右下角小角标叠加(不覆盖头像本身)。
 * - list:38px 圆形(名册行)
 * - hero:76px 圆角方形(radius 20)+ 健康时脉冲光环(ring)
 * @param {string} id
 * @param {string} name
 * @param {string|null} avatar
 * @param {"list"|"hero"} size
 * @param {string} liveKey  serving/degraded/offline/unknown — 角标圆点
 */
function avatarHTML(id, name, avatar, size, liveKey) {
  const initial = esc(avatarInitial(name, id));
  const color = AVATAR_COLORS[hashString(id || name) % AVATAR_COLORS.length];
  const live = LIVENESS[liveKey] ?? LIVENESS.unknown;
  const fallback =
    `<span class="avatar-fallback" style="background:${color}" aria-hidden="true">${initial}</span>`;
  const img = avatar
    ? `<img class="avatar-img" src="${esc(avatar)}" alt="" loading="lazy" ` +
      `onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />` +
      `<span class="avatar-fallback" style="background:${color};display:none" aria-hidden="true">${initial}</span>`
    : fallback;
  // hero 健康时:status 色脉冲光环(serving 才动);异常/掉线无动效环
  const ring =
    size === "hero" && liveKey === "serving"
      ? `<span class="avatar-ring" style="border-color:${LIVE_COLOR.serving}" aria-hidden="true"></span>`
      : "";
  return (
    `<span class="avatar avatar-${size}">` +
    ring +
    img +
    `<span class="avatar-dot live-dot ${live.dotClass}" role="img" aria-label="${esc(live.aria)}"></span>` +
    `</span>`
  );
}

/**
 * 「当前生效」chip(减认知):陈述当前事实,跟 helper text(解释)区分。
 * - f-chats:count=0 → 绿「任何群都能 @」;>0 → 灰「仅 N 个群」
 * - f-repos:count=0 → 灰「纯答疑,不碰代码」;>0 → 灰「可改 N 个仓库」
 * @param {"f-chats"|"f-repos"} field
 * @param {number} count
 */
function renderChip(field, count) {
  let cls = "chip-neutral";
  let label = "";
  if (field === "f-chats") {
    if (count === 0) {
      cls = "chip-open";
      label = "任何群都能 @";
    } else {
      label = `仅 ${count} 个群`;
    }
  } else {
    if (count === 0) {
      label = "纯答疑，不碰代码";
    } else {
      label = `可改 ${count} 个仓库`;
    }
  }
  return `<span class="field-chip ${cls}" data-chip-for="${field}">当前：${esc(label)}</span>`;
}

/** 把 lastSeenMs 换算成「N 秒前 / N 分钟前」中文。 */
function formatHeartbeat(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒前心跳`;
  const min = Math.round(sec / 60);
  return `${min} 分钟前心跳`;
}

function formatEventTime(iso) {
  const ts = Date.parse(iso || "");
  if (!Number.isFinite(ts)) return "未知时间";
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatEventAbsolute(iso) {
  const ts = Date.parse(iso || "");
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function eventTriggerLabel(t) {
  if (t === "mention") return "群里 @";
  if (t === "thread_reply") return "话题回复";
  if (t === "card_action") return "卡片按钮";
  if (t === "gap_fill") return "补拉";
  return "飞书事件";
}

function looksLikeLarkId(value, prefix) {
  const s = String(value || "");
  return prefix ? s.startsWith(prefix) : /^[a-z]{2}_[a-z0-9]{12,}$/i.test(s);
}

function displayEventChat(e) {
  if (e.chatName) return e.chatName;
  if (looksLikeLarkId(e.chatId, "oc_")) return "未命名群聊";
  if (e.chatId) return e.chatId;
  return "当前会话";
}

function displayEventSender(e) {
  if (e.senderName) return e.senderName;
  if (looksLikeLarkId(e.senderId, "ou_")) return "";
  if (e.senderId) return e.senderId;
  return "";
}

function eventStatusMeta(status) {
  return EVENT_STATUS[status] ?? { label: "未知", text: "状态未知" };
}

function eventStatusClass(status) {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "filtered") return "filtered";
  return "received";
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min} 分 ${rest} 秒` : `${min} 分钟`;
}

// ---------------------------------------------------------------------------
// 渲染:顶部上下文切换
// ---------------------------------------------------------------------------

function renderContextSwitch() {
  // Static local-only mode — show hostname badge, nothing to toggle.
  const hostEl = document.getElementById("ctx-host");
  if (hostEl) hostEl.textContent = location.hostname ? " · " + location.hostname : "";
}



// ---------------------------------------------------------------------------
// 渲染:主机状态 pill
// ---------------------------------------------------------------------------

/**
 * 渲染顶栏右上的状态 pill —— 反映整机 overall 在线状态(绿=服务正常/红=未运行)。
 * 同时把 bots[] 的每个 state 存进 state.liveness 供左侧圆点 + 详情横幅用。
 * @param {*} status GET /api/status 的 json;传 null/失败 → 降级「状态未知」灰点。
 */
function renderStatus(status) {
  // 拉取失败 / 无响应 → 降级:灰点 + 「状态未知」,不崩。
  if (!status) {
    state.livenessKnown = false;
    state.liveness = {};
    renderBotList(); // 让左侧圆点同步成灰
    renderDetailBanner(); // 详情横幅也降级成灰
    refreshDetailHero(); // hero 头部状态 pill 也降级成灰
    renderServiceIndicator(); // 顶栏服务指示器(此时 livenessKnown=false,pendingNew 记 0)
    return;
  }

  // 存每个 bot 的实时状态 + 心跳时间 + 头像 + 运行态底座(status.json 也带 avatar/backend)
  const map = {};
  const seenMap = {};
  const runningBkMap = {};
  let servingCount = 0;
  for (const b of Array.isArray(status.bots) ? status.bots : []) {
    if (b && typeof b.id === "string") {
      map[b.id] = b.state;
      seenMap[b.id] = typeof b.lastSeenMs === "number" ? b.lastSeenMs : null;
      // status 的 avatar 与 /api/bots 同源;有值就并入(不覆盖已有为 null)
      if (b.avatar) state.avatars[b.id] = b.avatar;
      // BL-17: runningBackend — null means unknown (old bridge / no status.json)
      runningBkMap[b.id] = typeof b.runningBackend === "string" ? b.runningBackend : null;
    }
  }
  state.liveness = map;
  state.lastSeenMs = seenMap;
  state.runningBackends = runningBkMap;
  state.livenessKnown = true;

  // 存 pendingRestart(新增/已删 bot 待重启生效),驱动顶栏 amber 提示。
  if (status.pendingRestart && typeof status.pendingRestart === "object") {
    state.pendingRestart = {
      newCount: typeof status.pendingRestart.newCount === "number" ? status.pendingRestart.newCount : 0,
      ghostCount: typeof status.pendingRestart.ghostCount === "number" ? status.pendingRestart.ghostCount : 0,
      ghosts: Array.isArray(status.pendingRestart.ghosts) ? status.pendingRestart.ghosts : [],
    };
  } else {
    state.pendingRestart = { newCount: 0, ghostCount: 0, ghosts: [] };
  }

  // ── BL-18:每次 poll 落地时推进重启状态机 ──────────────────────────────────
  if (state.restart.status === "restarting") {
    const totalCount = state.bots.length;
    const recoveredCount = state.bots.filter((b) => state.liveness[b.id] === "serving").length;
    const now = Date.now();
    const next = computeRestartTransition(state.restart, now, recoveredCount, totalCount);
    const prevStatus = state.restart.status;
    state.restart.elapsed = next.elapsed;
    if (next.status !== prevStatus) {
      state.restart.status = next.status;
      stopRestartTicker();
      if (next.status === "serving") {
        toast("服务已恢复 · 全部助手已连回", "ok");
      } else if (next.status === "timeout") {
        toast("重启超时 —— 已升级为「重启异常」,看一眼日志", "error");
      }
    }
  }

  // 详情横幅 + 左侧圆点 + 顶栏服务指示器都依赖 liveness,刷新它们。
  // 顶栏 indicator 必须在 liveness 落地后再渲染一次 —— 否则 pendingNew 用的是空数据,
  // 会把「有新助手」误显成「正常服务中」。
  renderBotList();
  renderDetailBanner();
  refreshDetailHero(); // hero 头部状态 pill + 心跳也跟 poll 刷新(否则恢复在线后卡旧态)
  renderServiceIndicator();
}

/**
 * 渲染选中 bot 详情区顶部的状态横幅(绿/黄/红/灰)。
 * 横幅 DOM 由 buildDetailHTML 占位,这里只填内容 + 切色;无选中或无横幅则跳过。
 */
function renderDetailBanner() {
  const banner = document.getElementById("detail-status-banner");
  if (!banner) return;
  if (!state.selected) {
    banner.hidden = true;
    return;
  }
  // ⑤ 状态横幅也以 effLive 为准:bridge 停时不显绿
  const key = effLive(state.selected);
  const live = LIVENESS[key];
  banner.dataset.state = key;
  // serving/degraded 末尾追加心跳时间(offline/unknown 不显示)
  let heartbeat = "";
  if (key === "serving" || key === "degraded") {
    const hb = formatHeartbeat(state.lastSeenMs[state.selected]);
    if (hb) heartbeat = `<span class="banner-heartbeat"> · ${esc(hb)}</span>`;
  }
  banner.innerHTML =
    `<span class="live-dot ${live.dotClass}" aria-hidden="true"></span>` +
    `<span>${esc(live.label)}${heartbeat}</span>`;
  banner.hidden = false;
}

/**
 * Poll 时刷新「详情区 hero 头部」的状态 pill + 心跳 + 光环色。
 *
 * renderDetailBanner() 只更新下方的状态横幅(#detail-status-banner),hero 头部那
 * 一行(名字下方的「● 连接异常/正常服务中 · N 秒前心跳」+ 头像光环)是 renderBotDetail
 * 选中时一次性渲染的,poll 不碰它 → bot 恢复在线后 hero pill 卡在旧的「连接异常」+ 旧心跳。
 * 这里在每次 /api/status 落地后,用 acRefreshHero 按 state.liveness/lastSeenMs 重建 hero body
 * (它读 AC 面板的实时表单值,所以不会丢用户正在编辑的输入)。
 */
function refreshDetailHero() {
  const id = state.selected;
  if (!id) return;
  const panel = document.getElementById("detail");
  if (!panel || !panel.querySelector("#detail-hero-body")) return;
  if (!panel.querySelector("#ac-panel")) return; // 编辑式面板未挂载(加载中/占位)
  const bot = state.bots.find((b) => b.id === id);
  if (!bot) return;
  acRefreshHero(panel, id, bot);
}

// ---------------------------------------------------------------------------
// 渲染:左侧 bot 列表
// ---------------------------------------------------------------------------

/** 列表加载中:显示 spinner row。 */
function renderBotListLoading() {
  const list = document.getElementById("bot-list");
  const empty = document.getElementById("bot-list-empty");
  if (!list) return;
  for (const li of Array.from(list.querySelectorAll("li[data-bot-id]"))) li.remove();
  if (empty) {
    empty.style.display = "";
    empty.innerHTML = `<span class="list-loading"><span class="spinner"></span> 正在加载助手…</span>`;
  }
}

/** 更新名册顶部计数文案「这台电脑上的 N 个助手」。 */
function renderRosterCount() {
  const el = document.getElementById("roster-count-text");
  if (!el) return;
  const n = state.bots.length;
  el.textContent = n === 0 ? "这台电脑上还没有助手" : `这台电脑上的 ${n} 个助手`;
}

/**
 * BL-18:名册头部重启状态行(照 restartBoard.jsx 名册头 isR/isTimeout 分支)。
 * restarting → sky「重启中 · 已连回 N/total」
 * timeout    → 红「重启异常 · 仍有 N 个没连回」
 * serving    → 隐藏
 */
function renderRosterRestartStatus() {
  const el = document.getElementById("roster-restart-status");
  if (!el) return;
  const rs = state.restart;
  if (rs.status === "restarting") {
    const total = state.bots.length;
    const recovered = state.bots.filter((b) => state.liveness[b.id] === "serving").length;
    el.hidden = false;
    el.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:6px;` +
      `font-size:12px;color:${LIVE_TEXT.transitioning};font-weight:600;">` +
      `<span class="live-dot is-transitioning" style="width:6px;height:6px;flex-shrink:0"></span>` +
      `重启中 · 已连回 ${recovered}/${total}` +
      `</span>`;
  } else if (rs.status === "timeout") {
    const total = state.bots.length;
    const recovered = state.bots.filter((b) => state.liveness[b.id] === "serving").length;
    el.hidden = false;
    el.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:6px;` +
      `font-size:12px;color:${LIVE_TEXT.offline};font-weight:600;">` +
      `<span class="live-dot is-offline" style="width:6px;height:6px;flex-shrink:0"></span>` +
      `重启异常 · 仍有 ${total - recovered} 个没连回` +
      `</span>`;
  } else {
    el.hidden = true;
    el.innerHTML = "";
  }
}

function renderBotList() {
  const list = document.getElementById("bot-list");
  const empty = document.getElementById("bot-list-empty");
  if (!list) return;

  renderRosterCount();
  renderRosterRestartStatus();

  if (state.bots.length === 0) {
    // 清空旧条目,只保留 empty placeholder
    for (const li of Array.from(list.children)) {
      if (li.id !== "bot-list-empty") li.remove();
    }
    if (empty) {
      empty.style.display = "";
      // 幽灵占位行(复刻设计稿 PvEmptyScreen 侧栏):虚线头像 + 骨架条,
      // 递减透明度,暗示「加完的助手会出现在这里」。
      empty.innerHTML =
        `<div class="roster-ghosts">` +
        [0, 1, 2]
          .map(
            (i) =>
              `<div class="roster-ghost" style="opacity:${(0.5 - i * 0.13).toFixed(2)}">` +
              `<span class="roster-ghost-num">${String(i + 1).padStart(2, "0")}</span>` +
              `<span class="roster-ghost-av"></span>` +
              `<span class="roster-ghost-lines"><span class="rg-l1"></span><span class="rg-l2"></span></span>` +
              `</div>`,
          )
          .join("") +
        `</div>`;
    }
    // 触发右侧空态(零助手时替换 detail-placeholder)
    renderEmptyOrPlaceholder();
    return;
  }

  // 有助手:若右侧还在显示空态,撤掉它
  renderEmptyOrPlaceholder();

  if (empty) empty.style.display = "none";

  // diff: 移除已不存在的条目
  const currentIds = new Set(state.bots.map((b) => b.id));
  for (const li of Array.from(list.querySelectorAll("li[data-bot-id]"))) {
    if (!currentIds.has(li.dataset.botId)) li.remove();
  }

  // 添加/更新条目(顺序也要对得上编号 01/02 → 按 state.bots 顺序 re-append)
  state.bots.forEach((bot, i) => {
    let li = list.querySelector(`li[data-bot-id="${CSS.escape(bot.id)}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.botId = bot.id;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.addEventListener("click", () => selectBot(bot.id));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectBot(bot.id);
        }
      });
    }
    // 保证 DOM 顺序与 state.bots 一致(编号才对得上)
    list.appendChild(li);
    const selected = bot.id === state.selected;
    li.classList.toggle("is-selected", selected);
    const num = String(i + 1).padStart(2, "0");

    // ── BL-18:显示覆盖 —— restarting/timeout 时用 restartDisplayLive 替代真实 liveKey ─
    const realLiveKey = botLiveness(bot.id);
    const dispLiveKey = restartDisplayLive(realLiveKey, state.restart.status);
    const liveKey = dispLiveKey;
    const live = LIVENESS[liveKey] ?? LIVENESS.unknown;
    const avatar = state.avatars[bot.id] ?? bot.avatar ?? null;
    const delBtn = `<button class="lk-del" type="button" aria-label="删除 ${esc(bot.name)}" title="删除助手">${ICONS.trash}</button>`;
    // 名册头部:重启中显示进度「已连回 N/total」
    // (已在名册标题区渲染,不再重复到行级)
    // LkAttentionPill / LkRestartPill:
    //   - restarting:「预期内」sky pill(替代「需处理」,不告警)
    //   - timeout:offline bot 仍显「需处理」红 pill
    //   - serving:正常逻辑
    const isTransitioning = liveKey === "transitioning";
    const eff = isTransitioning ? "transitioning" : effLive(bot.id);
    let attentionPill = "";
    if (isTransitioning) {
      // LkRestartPill —— sky「预期内」(照 restartKit.jsx)
      attentionPill =
        `<span style="display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;` +
        `font-size:10.5px;font-weight:700;letter-spacing:.02em;` +
        `color:${LIVE_TEXT.transitioning};background:${LIVE_SOFT.transitioning};` +
        `border:1px solid ${LIVE_EDGE.transitioning};white-space:nowrap;flex-shrink:0">` +
        `<span class="live-dot is-transitioning" style="width:6px;height:6px;flex-shrink:0"></span>` +
        `预期内` +
        `</span>`;
    } else if (eff !== "serving") {
      attentionPill =
        `<span class="lk-attention-pill" ` +
        `style="display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;` +
        `font-size:10.5px;font-weight:700;letter-spacing:.02em;` +
        `color:${LIVE_TEXT[eff] ?? LIVE_TEXT.unknown};` +
        `background:${LIVE_SOFT[eff] ?? LIVE_SOFT.unknown};` +
        `border:1px solid ${LIVE_EDGE[eff] ?? LIVE_EDGE.unknown}">` +
        ICONS.warn + `需处理` +
        `</span>`;
    }
    // BL-17:底座不一致 badge(名册行,sm)
    const configuredBk = bot.backend || LK_BACKEND_DEFAULT;
    const runningBk = state.runningBackends[bot.id] ?? null;
    const bkMismatchSm = isBackendMismatch(runningBk, configuredBk)
      ? backendMismatchBadgeHTML(runningBk, configuredBk, "sm")
      : "";
    // 触点①:名册行第二行最右侧加 backend chip (sm,无 mono,margin-left:auto)
    // 有不一致 badge 时替换 chip,让 badge 本身就在右侧(margin-left:auto)。
    const backendChipSm = lkBackendChipHTML(configuredBk, { size: "sm" });
    const rightSlot = bkMismatchSm
      ? `<span style="margin-left:auto;flex-shrink:0">${bkMismatchSm}</span>`
      : `<span style="margin-left:auto;flex-shrink:0">${backendChipSm}</span>`;
    li.innerHTML =
      `<span class="roster-num">${num}</span>` +
      avatarHTML(bot.id, bot.name, avatar, "list", liveKey) +
      `<span class="roster-meta">` +
      `<span class="bot-name">${esc(bot.name)}</span>` +
      `<span class="roster-state">` +
      `<span class="live-dot ${live.dotClass}" aria-hidden="true"></span>` +
      `<span class="roster-state-label" style="color:${LIVE_TEXT[liveKey] ?? LIVE_TEXT.unknown}">${esc(LIVE_LABEL[liveKey] ?? liveKey)}</span>` +
      attentionPill +
      rightSlot +
      `</span>` +
      `</span>` +
      delBtn;
    // Wire del button after innerHTML (DOM replaced)
    const delEl = li.querySelector(".lk-del");
    if (delEl) {
      delEl.addEventListener("click", (e) => {
        e.stopPropagation();
        doDeleteBot(bot.id);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 渲染:首次空状态(LkEmptyState 像素级复刻,设计稿 emptyState.jsx)
// ---------------------------------------------------------------------------

/**
 * 生成 LkRelayHero SVG(本机名册 → arc relay → 飞书群气泡)。
 * 含 <animateMotion> 光点沿 arc 流动动画。
 * @param {number} w SVG 宽度(px)
 */
function buildRelayHeroSVG(w = 332) {
  const h = Math.round(w * 188 / 340);
  const c = BR.c; // indigo
  const soft = BR.soft;
  const edge = BR.edge;
  const faint = "#cbd5e1";
  const line = "#e6e8ee";
  const ink = "#334155"; // unused but reserved

  // 名册槽:第 0 个 indigo,其余幽灵虚线
  const slots = [
    { y: 78, on: true },
    { y: 104, on: false },
    { y: 130, on: false },
  ];

  const slotsSVG = slots.map((s, i) => {
    if (s.on) {
      return `<g>
        <circle cx="44" cy="${s.y}" r="11" fill="${soft}" stroke="${c}" stroke-width="1.6"/>
        <path d="M44 95.5 v9 M39.5 100 h9" transform="translate(0 ${s.y - 100})" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="62" y="${s.y - 7}" width="56" height="6.5" rx="3.25" fill="${lkHexA(c, 0.35)}"/>
        <rect x="62" y="${s.y + 2}" width="34" height="5" rx="2.5" fill="${lkHexA(c, 0.18)}"/>
      </g>`;
    } else {
      return `<g>
        <circle cx="44" cy="${s.y}" r="11" fill="none" stroke="${faint}" stroke-width="1.4" stroke-dasharray="3 3"/>
        <rect x="62" y="${s.y - 6}" width="50" height="6" rx="3" fill="#eef0f4"/>
        <rect x="62" y="${s.y + 3}" width="30" height="5" rx="2.5" fill="#f1f3f7"/>
      </g>`;
    }
  }).join("\n");

  return `<svg viewBox="0 0 340 188" width="${w}" height="${h}" style="display:block;max-width:100%" aria-hidden="true">
    <!-- 柔和 indigo 底氛围 -->
    <ellipse cx="176" cy="98" rx="150" ry="86" fill="${lkHexA(c, 0.05)}"/>
    <ellipse cx="244" cy="74" rx="64" ry="58" fill="${lkHexA(c, 0.05)}"/>

    <!-- 左:本机面板(空名册) -->
    <g>
      <rect x="22" y="40" width="116" height="118" rx="15" fill="#fff" stroke="${line}" stroke-width="1.5"/>
      <circle cx="38" cy="57" r="3" fill="${faint}"/>
      <rect x="48" y="54" width="48" height="6" rx="3" fill="#eef0f4"/>
      <line x1="22" y1="68" x2="138" y2="68" stroke="${line}" stroke-width="1.2"/>
      ${slotsSVG}
      <text x="80" y="178" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8" style="letter-spacing:.04em">本机 · 助手名册</text>
    </g>

    <!-- arc relay 轨迹(indigo 母题) -->
    <path id="lk-relay-arc" d="M138 64 C 176 30, 198 30, 226 52" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="226" cy="52" r="3" fill="${c}"/>
    <!-- 沿轨迹传递的小光点(animateMotion) -->
    <circle r="3.6" fill="${c}">
      <animateMotion dur="2.8s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear" path="M138 64 C 176 30, 198 30, 226 52"/>
      <animate attributeName="opacity" dur="2.8s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.14;0.82;1"/>
    </circle>

    <!-- 右:飞书群(助手已加入并被 @) -->
    <g>
      <rect x="206" y="44" width="112" height="96" rx="16" fill="#fff" stroke="${line}" stroke-width="1.5"/>
      <!-- 群名头:成员头像 + 群名条 -->
      <circle cx="224" cy="62" r="7" fill="#dfe3ea"/>
      <circle cx="236" cy="62" r="7" fill="#e7d9c9"/>
      <rect x="248" y="58" width="44" height="7" rx="3.5" fill="#eef0f4"/>
      <line x1="206" y1="78" x2="318" y2="78" stroke="${line}" stroke-width="1.2"/>
      <!-- 助手发言气泡(indigo,带 @) -->
      <g>
        <circle cx="226" cy="104" r="11" fill="${c}"/>
        <path d="M222 104 a4 4 0 1 1 8 0 v1.6 a2 2 0 0 0 2 2" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="226" cy="104" r="6.4" fill="none" stroke="#fff" stroke-width="1.5"/>
        <rect x="244" y="98" width="60" height="7" rx="3.5" fill="${lkHexA(c, 0.32)}"/>
        <rect x="244" y="109" width="40" height="6" rx="3" fill="#eef0f4"/>
      </g>
    </g>
  </svg>`;
}

/**
 * 构建三步迷你流程图(LkStepFlow)的 HTML。
 */
function buildStepFlowHTML() {
  const c = BR.c;
  const soft = BR.soft;
  const edge = BR.edge;
  const faint = "#94a3b8";
  const text = "#1e293b";

  const steps = [
    {
      d: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
      t: "扫码配对",
      s: "飞书后台扫一下",
    },
    {
      d: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
      t: "给它起个名",
      s: "预填好，改两笔",
    },
    {
      d: "M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z",
      t: "群里 @ 它",
      s: "它就开始干活",
    },
  ];

  const arrowSVG = `<svg style="flex-shrink:0;color:${faint}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

  const stepItems = steps.map((st, i) => {
    const iconSVG = `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${st.d.split("M").filter(Boolean).map((seg) => `<path d="M${seg}"/>`).join("")}</svg>`;
    const badge = `<span style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;background:${c};color:#fff;font-size:10.5px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;font-family:ui-monospace,monospace">${i + 1}</span>`;
    const icon = `<span style="position:relative;width:44px;height:44px;border-radius:13px;background:${soft};border:1px solid ${edge};display:inline-flex;align-items:center;justify-content:center;color:${c};flex-shrink:0">${iconSVG}${badge}</span>`;
    const label = `<div><div style="font-size:13.5px;font-weight:700;color:${text}">${esc(st.t)}</div><div style="font-size:12px;color:${faint};margin-top:2px">${esc(st.s)}</div></div>`;
    const stepEl = `<div style="display:flex;flex-direction:column;align-items:center;gap:9px;width:116px;text-align:center">${icon}${label}</div>`;

    return i < steps.length - 1
      ? stepEl + `<span style="display:flex;align-items:center;height:44px;flex-shrink:0">${arrowSVG}</span>`
      : stepEl;
  }).join("\n");

  return `<div style="display:flex;align-items:flex-start;justify-content:center;gap:4px">${stepItems}</div>`;
}

/**
 * 构建 LkEmptyState 的完整 HTML。
 * @param {boolean} serviceRunning  false 时在 CTA 下加温和提示
 */
function buildEmptyStateHTML(serviceRunning) {
  const c = BR.c;
  const soft = BR.soft;
  const edge = BR.edge;
  const brText = BR.text;
  const text = "#1e293b";
  const muted = "#64748b";
  const faint = "#94a3b8";
  const border = "#e2e8f0";
  const surface = "#fff";

  const heroSVG = buildRelayHeroSVG(332);

  // radial gradient background
  const bgStyle = `radial-gradient(120% 90% at 50% 0%, ${lkHexA(c, 0.05)} 0%, ${surface} 56%)`;

  let mainContent;
  {
    // 本机:欢迎 + CTA
    const ctaBtn = `<button id="es-add-btn" type="button"
      class="es-cta-btn"
      style="display:inline-flex;align-items:center;gap:9px;padding:14px 28px;font-size:16px;font-weight:700;font-family:inherit;color:#fff;cursor:pointer;background:${c};border:none;border-radius:13px;box-shadow:0 4px 14px ${lkHexA(c, 0.26)};transition:background .15s,box-shadow .18s,transform .18s">
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      添加新助手
    </button>`;

    const serviceHint = !serviceRunning
      ? `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:${muted}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="${faint}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
          加好后，启动服务它就上线
        </span>`
      : "";

    const ctaBlock = `<div style="margin-top:26px;display:flex;flex-direction:column;align-items:center;gap:10px">
      ${ctaBtn}
      ${serviceHint}
    </div>`;

    const stepSection = `<div style="margin-top:38px;padding-top:30px;border-top:1px solid ${border};width:100%">
      ${buildStepFlowHTML()}
    </div>`;

    mainContent = `
      <h1 style="margin:20px 0 0;font-size:30px;font-weight:800;letter-spacing:-.03em;line-height:1.12;color:${text};text-wrap:balance">让飞书群里多一个会干活的助手</h1>
      <p style="margin:12px 0 0;font-size:16px;color:${muted};line-height:1.62;max-width:470px;text-wrap:pretty">
        在群里 <b style="color:#334155">@ 它</b>，它就在你本机用 Claude 帮你改代码、起预览、答疑 —— <b style="color:${brText}">配一次，全组能用</b>。
      </p>
      ${ctaBlock}
      ${stepSection}
    `;
  }

  // 底部安心语(两变体共有)
  const shieldNote = `<div style="margin-top:26px;display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:${faint}">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/></svg>
    全程不碰终端；密钥只存在你本机，别人看不到
  </div>`;

  return `<div class="es-root" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:40px 32px;background:${bgStyle};overflow-y:auto">
    <div style="width:100%;max-width:560px;display:flex;flex-direction:column;align-items:center;text-align:center">
      ${heroSVG}
      ${mainContent}
      ${shieldNote}
    </div>
  </div>`;
}


// ---------------------------------------------------------------------------
// 详情区「空态」(名册有助手但未选中)—— 复刻 Claude Design empty-detail 稿。
// ---------------------------------------------------------------------------

/** 空态用的 icon path(复合 path 按 'M' 拆段,见 edIcon)。 */
const ED_ICON = {
  plus: "M12 5v14M5 12h14",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  arrowL: "M19 12H5M11 18l-6-6 6-6",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  upload: "M12 15V3M8 7l4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  lock: "M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4",
  shield: "M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z",
};

/** 复合 path 按 'M' 拆成多段 → inline SVG(与设计稿 EdIcon 一致)。 */
function edIcon(d, size = 18, sw = 2) {
  const segs = String(d).split("M").filter(Boolean).map((s) => `<path d="M${s}"/>`).join("");
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${segs}</svg>`;
}

/** hero 插画:名册一行被选中 → 详情在右侧展开。ro=只读(slate+虚线+锁,无动效)。 */
function edHeroSVG(ro, w) {
  const br = "#4f46e5", line = "#e6e8ee", faint = "#cbd5e1";
  const accent = ro ? "#94a3b8" : br;
  const accSoft = ro ? "#f1f5f9" : "#eef2ff";
  const wash = ro ? "rgba(148,163,184,.10)" : "rgba(79,70,229,.06)";
  const h = Math.round((w * 184) / 360);
  const selBar = ro ? "#94a3b8" : "rgba(79,70,229,.42)";
  const selSub = ro ? "#cbd5e1" : "rgba(79,70,229,.20)";
  const nameFill = ro ? "#cbd5e1" : "rgba(79,70,229,.42)";

  const rowsSVG = [
    { cy: 88, sel: false },
    { cy: 116, sel: true },
    { cy: 144, sel: false },
  ].map((r) =>
    (r.sel ? `<rect x="14" y="${r.cy - 14}" width="138" height="28" rx="9" fill="${accSoft}" stroke="${accent}" stroke-width="1.4"/>` : "") +
    (r.sel
      ? `<circle cx="42" cy="${r.cy}" r="10" fill="${accent}"/>`
      : `<circle cx="42" cy="${r.cy}" r="10" fill="none" stroke="${faint}" stroke-width="1.4" stroke-dasharray="3 3"/>`) +
    `<rect x="60" y="${r.cy - 6}" width="${r.sel ? 56 : 50}" height="6" rx="3" fill="${r.sel ? selBar : "#eef0f4"}"/>` +
    `<rect x="60" y="${r.cy + 3}" width="${r.sel ? 36 : 30}" height="5" rx="2.5" fill="${r.sel ? selSub : "#f1f3f7"}"/>`
  ).join("");

  const motionPath = "M152 116 C 178 116, 184 70, 210 70";
  const connector =
    `<path d="${motionPath}" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="${ro ? "4 4" : "none"}" opacity="${ro ? 0.7 : 1}"/>` +
    (ro ? "" : `<circle r="3.4" fill="${br}"><animateMotion dur="2.6s" repeatCount="indefinite" path="${motionPath}"/><animate attributeName="opacity" dur="2.6s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.15;0.8;1"/></circle>`);

  const fieldsSVG = [94, 128].map((y, i) =>
    `<rect x="224" y="${y}" width="${i === 0 ? 44 : 56}" height="5" rx="2.5" fill="#cbd5e1"/>` +
    (ro
      ? `<rect x="224" y="${y + 10}" width="${i === 0 ? 96 : 78}" height="6" rx="3" fill="#eef0f4"/>`
      : `<rect x="224" y="${y + 9}" width="100" height="15" rx="5" fill="#f8fafc" stroke="${line}" stroke-width="1.1"/>`)
  ).join("");

  const lockBadge = ro
    ? `<g><circle cx="326" cy="48" r="12" fill="#f1f5f9" stroke="#e2e8f0" stroke-width="1.2"/><g transform="translate(320.5 42.5) scale(0.5)" fill="none" stroke="#64748b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4"/></g></g>`
    : "";
  const cursor = ro ? "" : `<g transform="translate(120 122)"><path d="M0 0 L4 15 L7 9 L13 12 Z" fill="#1e293b" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></g>`;

  return `<svg viewBox="0 0 360 184" width="${w}" height="${h}" style="display:block" aria-hidden="true">` +
    `<ellipse cx="180" cy="96" rx="156" ry="84" fill="${wash}"/><ellipse cx="250" cy="72" rx="62" ry="56" fill="${wash}"/>` +
    `<g><rect x="20" y="34" width="124" height="132" rx="15" fill="#fff" stroke="${line}" stroke-width="1.5"/>` +
    `<circle cx="38" cy="52" r="3" fill="${faint}"/><rect x="48" y="49" width="54" height="6" rx="3" fill="#eef0f4"/>` +
    `<line x1="20" y1="64" x2="144" y2="64" stroke="${line}" stroke-width="1.2"/>${rowsSVG}` +
    `<text x="82" y="180" text-anchor="middle" font-size="10.5" font-weight="700" fill="#94a3b8" style="letter-spacing:.04em">助手名册</text></g>` +
    connector +
    `<g><rect x="206" y="30" width="138" height="140" rx="16" fill="#fff" stroke="${line}" stroke-width="1.5"/>` +
    `<circle cx="230" cy="56" r="12" fill="${accent}"/><rect x="250" y="48" width="66" height="7" rx="3.5" fill="${nameFill}"/>` +
    `<rect x="250" y="60" width="44" height="5" rx="2.5" fill="#eef0f4"/><line x1="206" y1="80" x2="344" y2="80" stroke="${line}" stroke-width="1.2"/>` +
    `${fieldsSVG}${lockBadge}</g>${cursor}</svg>`;
}

/** 三步 rail。 */
function edRail(steps) {
  return `<div class="lk-ed__rail">` +
    steps.map((st, i) =>
      `<div class="lk-ed__step"><span class="lk-ed__chip">${edIcon(st.d, 21, 1.9)}<span class="lk-ed__chip-no">${i + 1}</span></span>` +
      `<div><div class="lk-ed__step-t">${esc(st.t)}</div><div class="lk-ed__step-s">${esc(st.s)}</div></div></div>` +
      (i < steps.length - 1 ? `<span class="lk-ed__arrow">${edIcon(ED_ICON.arrowR, 18, 1.8)}</span>` : "")
    ).join("") +
    `</div>`;
}

/** 详情区空态 HTML(本机 · 可改)。 */
function buildEmptyDetailHTML() {
  return `<div class="lk-ed" style="container-type:inline-size;container-name:lk-ed">` +
    `<div class="lk-ed__inner">${edHeroSVG(false, 348)}` +
    `<span class="lk-ed__eyebrow">${edIcon(ED_ICON.edit, 14, 2)} 本机 · 可改</span>` +
    `<h2 class="lk-ed__title">从左边选一个助手，开始配置</h2>` +
    `<p class="lk-ed__body">在这里可以改它的名字、介绍、能用它的群、能改的代码仓库，还有它的职责说明。改好点<b class="br">「保存」</b>就写入本机生效，同事在群里 @ 它就能用。</p>` +
    `<div class="lk-ed__actions">` +
    `<button type="button" id="ed-add-bot" class="lk-ed__btn lk-ed__btn--primary">${edIcon(ED_ICON.plus, 18, 2.2)} 添加新助手</button>` +
    `<button type="button" id="ed-pick" class="lk-ed__btn lk-ed__btn--ghost">${edIcon(ED_ICON.arrowL, 16, 2)} 从名册里挑一个</button></div>` +
    edRail([
      { d: ED_ICON.sliders, t: "配置", s: "改名字、群、仓库、职责" },
      { d: ED_ICON.edit, t: "保存", s: "写入本机即生效" },
      { d: ED_ICON.users, t: "群里 @", s: "同事直接用" },
    ]) +
    `<span class="lk-ed__foot">${edIcon(ED_ICON.shield, 14, 1.7)} 全程不碰终端；密钥只存在你本机，别人看不到</span></div></div>`;
}

/** 渲染 #detail-placeholder 的空态内容 + 接线按钮(按当前 mode 选变体)。 */
function renderDetailPlaceholder() {
  const placeholder = document.getElementById("detail-placeholder");
  if (!placeholder) return;
  placeholder.innerHTML = buildEmptyDetailHTML();
  placeholder.querySelector("#ed-add-bot")?.addEventListener("click", () => openOnboardModal());
  placeholder.querySelector("#ed-pick")?.addEventListener("click", () => {
    if (state.bots[0]) selectBot(state.bots[0].id);
  });
}

/**
 * 在 detail 区渲染空态或恢复 placeholder。
 * 当 state.bots.length === 0 且无选中 bot 时显示空态全屏欢迎页；
 * 有助手但无选中时恢复 placeholder。
 * 在 loadBots 结束后、renderBotDetail(null) 后调用。
 */
function renderEmptyOrPlaceholder() {
  const detail = document.getElementById("detail");
  const placeholder = document.getElementById("detail-placeholder");
  if (!detail) return;

  // 清理已有 empty-state 节点
  const existingEs = detail.querySelector(".es-panel");
  const panel = detail.querySelector(".detail-panel");

  if (state.bots.length === 0 && !state.selected) {
    // 零助手 → 空态全屏
    if (placeholder) placeholder.style.display = "none";
    if (panel) panel.style.display = "none";

    if (!existingEs) {
      const esEl = document.createElement("div");
      esEl.className = "es-panel";
      esEl.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column;height:100%";
      detail.appendChild(esEl);
    }
    const es = detail.querySelector(".es-panel");
    if (es) {
      const serviceRunning = state.bridge?.running ?? false;
      es.innerHTML = buildEmptyStateHTML(serviceRunning);
      wireEmptyStateEvents(es);
    }
  } else {
    // 有助手:移除空态,恢复 placeholder(若无选中)
    if (existingEs) existingEs.remove();
    if (panel) panel.style.display = "";
    if (!state.selected && placeholder) {
      renderDetailPlaceholder();
      placeholder.style.display = "";
    }
  }
}

/** 接线空态内的事件。*/
function wireEmptyStateEvents(container) {
  // CTA → openOnboardModal
  const addBtn = container.querySelector("#es-add-btn");
  addBtn?.addEventListener("click", () => openOnboardModal());

  // CTA hover 效果
  addBtn?.addEventListener("mouseenter", () => {
    addBtn.style.background = "#4338ca";
    addBtn.style.boxShadow = `0 10px 26px ${lkHexA(BR.c, 0.36)}`;
    addBtn.style.transform = "translateY(-1px)";
  });
  addBtn?.addEventListener("mouseleave", () => {
    addBtn.style.background = BR.c;
    addBtn.style.boxShadow = `0 4px 14px ${lkHexA(BR.c, 0.26)}`;
    addBtn.style.transform = "none";
  });
}

// ---------------------------------------------------------------------------
// 渲染:右侧 bot 详情(yaml 表单 + memory 编辑 + promote 按钮)
// ---------------------------------------------------------------------------

/**
 * 渲染选中 bot 的详情区。
 * @param {string} id
 */
async function renderBotDetail(id) {
  const detail = document.getElementById("detail");
  const placeholder = document.getElementById("detail-placeholder");
  if (!detail) return;

  if (!id) {
    // 清除上一次的详情内容(detail-panel + es-panel)
    for (const el of Array.from(detail.children)) {
      if (el.id !== "detail-placeholder") el.remove();
    }
    // 零助手 → 空态;有助手但无选中 → placeholder
    renderEmptyOrPlaceholder();
    return;
  }

  if (placeholder) placeholder.style.display = "none";

  // 明确的 loading:spinner + 文案(加载完会被真实内容替换,绝不留卡住的骨架)
  let panel = detail.querySelector(".detail-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "detail-panel";
    detail.appendChild(panel);
  }
  panel.innerHTML = `<div class="loading-block"><span class="spinner spinner-lg"></span><span>正在打开助手…</span></div>`;

  // 并行拉配置 + memory
  const [botRes, memRes] = await Promise.all([
    api("GET", `/api/bot/${encodeURIComponent(id)}`),
    api("GET", `/api/memory/${encodeURIComponent(id)}`),
  ]);

  // 用户在请求飞行途中切换了选择 → 丢弃过期渲染
  if (state.selected !== id) return;

  if (!botRes.ok) {
    panel.innerHTML = `<div class="error-block">${ICONS.x}<div>打开助手失败：${esc(botRes.json?.error ?? botRes.status)}</div></div>`;
    return;
  }

  const bot = botRes.json?.bot ?? {};
  const memContent = memRes.ok ? (memRes.json?.content ?? "") : "";

  // 新详情 → 重置脏状态(刚加载即「无改动」)
  state.formDirty = false;
  state.memoryDirty = false;

  panel.innerHTML = buildDetailHTML(id, bot, memContent);
  // 切 bot 丝滑:详情区淡入(reduced-motion 下 transition 被禁,无白闪)
  panel.classList.remove("panel-enter");
  void panel.offsetWidth; // 强制 reflow 重新触发动画
  panel.classList.add("panel-enter");
  // AC 面板头像渲染(#ac-avatar-wrap 由 buildAgentConfigHTML 留空)
  const avatar = state.avatars[id] ?? bot.avatar ?? null;
  const liveKey = botLiveness(id);
  acRenderAvatar(panel, id, bot.name || id, avatar, liveKey);
  wireDetailEvents(panel, id, bot);
  renderDetailBanner();
  loadRecentEvents(id, panel);
}


/**
 * 构建 hero band 内层(名字 / 介绍 / meta strip）—— 依赖 P.form 的实时值,
 * 输入时由 refreshHero() 重渲染,与编辑式 hero 的「所见即所改」一致。
 * @param {string} id
 * @param {object} bot   原始 yaml(提供 app_id / bot_open_id 等只读 meta)
 * @param {{name:string,description:string,chatCount:number,repoCount:number}} f 当前表单值
 * @param {boolean} readonly
 */
function buildHeroInner(id, bot, f) {
  const idx = state.bots.findIndex((b) => b.id === id);
  const num = String((idx < 0 ? 0 : idx) + 1).padStart(2, "0");
  // ⑤ hero 内状态条:BL-18 重启窗口内用 restartDisplayLive 覆盖;否则 effLive
  const realLive = effLive(id);
  const rs = state.restart;
  const isR = rs.status === "restarting";
  const isTimeout = rs.status === "timeout";
  const dispLiveKey = (isR || isTimeout) ? restartDisplayLive(realLive, rs.status) : realLive;
  const liveKey = dispLiveKey;

  const editBadge = `<span class="hero-badge">${ICONS.check} 可改</span>`;
  const eyebrowLabel = "本机助手 · 第";

  // 状态条(1.5px edge pill):重启中 → sky「重启中 · 预期内,正在恢复」;否则正常
  const statusPillText = isR
    ? LIVE_LABEL_LONG.transitioning
    : (isTimeout && liveKey === "offline" ? "重启异常 · 超时未恢复" : (LIVE_LABEL_LONG[liveKey] ?? liveKey));
  const statusPillLiveKey = isR ? "transitioning" : liveKey;
  const statusPill =
    `<span class="hero-status" style="color:${LIVE_TEXT[statusPillLiveKey] ?? LIVE_TEXT.unknown};border-color:${LIVE_EDGE[statusPillLiveKey] ?? LIVE_EDGE.unknown}">` +
    `<span class="live-dot ${LIVENESS[statusPillLiveKey]?.dotClass ?? "is-unknown"}" aria-hidden="true"></span> ` +
    `${esc(statusPillText)}</span>`;

  // 心跳:重启中 → 显「重连中」(平线流动 sky);timeout+未恢复 → 「无心跳」(平线);正常 → ECG
  let heartbeat = "";
  if (isR) {
    // LkReconnectHeart:平基线 + sky 流动虚线(照 restartKit.jsx + restartBoard.jsx)
    heartbeat =
      `<span class="hero-heart">` +
      `<svg width="72" height="22" viewBox="0 0 72 22" style="display:block;overflow:visible">` +
      `<path d="M0 11 H72" fill="none" stroke="${LIVE_COLOR.transitioning}" stroke-width="1.8" stroke-linecap="round" style="opacity:.22"/>` +
      `<path d="M0 11 H72" fill="none" stroke="${LIVE_COLOR.transitioning}" stroke-width="1.8" stroke-linecap="round" ` +
      `class="lk-reconnect lk-ecgline" style="stroke-dasharray:0.1 7, 26 200;animation:lk-ecg 1.0s linear infinite"/>` +
      `</svg>` +
      `<span class="hero-heart-text">重连中</span>` +
      `</span>`;
  } else if (isTimeout && liveKey === "offline") {
    heartbeat =
      `<span class="hero-heart">` +
      heartSVG("offline") +
      `<span class="hero-heart-text">无心跳</span>` +
      `</span>`;
  } else {
    const hb = formatHeartbeat(state.lastSeenMs[id]);
    if ((liveKey === "serving" || liveKey === "degraded") && hb) {
      heartbeat = `<span class="hero-heart">${heartSVG(liveKey)}<span class="hero-heart-text">${esc(hb)}</span></span>`;
    }
  }

  // meta strip 五列(原 4 列扩 → 含「底座」)。谁能用它走 indigo 强调(留空=任何群),其余中性。
  const chatVal = f.chatCount === 0 ? "任何群都能 @" : `仅 ${f.chatCount} 个群`;
  const repoVal = f.repoCount === 0 ? "纯答疑" : `${f.repoCount} 个仓库`;
  const chatTone = f.chatCount === 0 ? ` style="color:${BR.text}"` : "";

  // 触点③:meta strip「底座」列(sm + mono 字标)
  const backendMetaCell =
    `<div class="meta-cell"><span class="meta-label">底座</span>` +
    `<span style="display:inline-flex">${lkBackendChipHTML(bot.backend || LK_BACKEND_DEFAULT, { size: "sm", mono: true })}</span>` +
    `</div>`;

  const heroDelBtn = `<button class="btn btn-hero-del" id="btn-hero-del" type="button" title="删除助手">` +
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;flex-shrink:0"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>` +
    ` 删除</button>`;

  // 触点②:hero kicker 行,紧跟眉批加 backend chip(mono + vendor)
  const backendKickerChip = lkBackendChipHTML(bot.backend || LK_BACKEND_DEFAULT, { mono: true, vendor: true });

  // ── BL-18:hero 状态面板(重启中=冷静 sky 面板 / 超时=红色告警) ────────────────
  // 重启窗口内隐藏「修复/重启」类动作(别诱导重复点),下方配置区保持可读。
  let restartPanel = "";
  if (isR) {
    const total = state.bots.length;
    const recovered = state.bots.filter((b) => state.liveness[b.id] === "serving").length;
    const elapsed = rs.elapsed;
    const stepIndex = restartStepIndex(rs.status, elapsed, recovered, total);
    restartPanel = buildRestartHeroPanel(stepIndex, elapsed, recovered, total);
  } else if (isTimeout) {
    const total = state.bots.length;
    const recovered = state.bots.filter((b) => state.liveness[b.id] === "serving").length;
    const elapsed = Math.max(rs.elapsed, LK_RESTART_TIMEOUT_SECS);
    restartPanel = buildRestartTimeoutPanel(elapsed, total - recovered);
  }

  return (
    `<div class="hero-top">` +
    `<div class="hero-eyebrow-row">` +
    `<span class="hero-eyebrow">${eyebrowLabel} ${num} 个</span>` +
    backendKickerChip +
    editBadge +
    heroDelBtn +
    `</div>` +
    `<h1 class="hero-title">${esc(f.name || id)}</h1>` +
    `<p class="hero-desc">${esc(f.description || "（还没填介绍）")}</p>` +
    `<div class="hero-statusrow">${statusPill}${heartbeat}</div>` +
    restartPanel +
    `</div>` +
    `<div class="hero-meta hero-meta-5">` +
    `<div class="meta-cell"><span class="meta-label">谁能用它</span><span class="meta-value"${chatTone}>${esc(chatVal)}</span></div>` +
    `<div class="meta-cell"><span class="meta-label">能改仓库</span><span class="meta-value">${esc(repoVal)}</span></div>` +
    backendMetaCell +
    `<div class="meta-cell"><span class="meta-label">应用 ID</span><span class="meta-value meta-mono">${esc(bot.app_id || "—")}</span></div>` +
    `<div class="meta-cell"><span class="meta-label">机器人 ID</span><span class="meta-value meta-mono">${esc(bot.bot_open_id || "—")}</span></div>` +
    `</div>`
  );
}

/**
 * BL-18:生成「重启中」hero 冷静面板 HTML(照 LkRestartHeroPanel + LkRestartProgress)。
 * stepIndex: 0=服务重启中 / 1=助手重连中 / 2=已恢复
 */
function buildRestartHeroPanel(stepIndex, elapsed, recovered, total) {
  const c = LIVE_COLOR.transitioning;
  const soft = LIVE_SOFT.transitioning;
  const edge = LIVE_EDGE.transitioning;
  const text = LIVE_TEXT.transitioning;

  // 三步分步轨
  const steps = LK_RS.steps;
  const stepsHtml = steps.map((st, i) => {
    const done = i < stepIndex;
    const active = i === stepIndex;
    const dotC = done ? LIVE_COLOR.serving : active ? c : "#cbd5e1";
    const labelColor = done ? LIVE_TEXT.serving : active ? text : "#94a3b8";
    const dotHtml = done
      ? `<span style="width:16px;height:16px;border-radius:50%;background:${LIVE_COLOR.serving};display:inline-flex;align-items:center;justify-content:center">` +
        `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>` +
        `</span>`
      : `<span class="${active ? "lk-trans-dot" : ""}" ` +
        `style="width:16px;height:16px;border-radius:50%;background:${dotC};` +
        `animation:${active ? "lk-breathe 2.6s ease-in-out infinite" : "none"}"></span>`;
    const connectorHtml = i < steps.length - 1
      ? `<span style="flex:1;height:2px;border-radius:2px;margin-top:-20px;background:${i < stepIndex ? LIVE_EDGE.serving : "#e2e8f0"}"></span>`
      : "";
    return (
      `<div style="display:flex;flex-direction:column;align-items:center;gap:7px;min-width:96px">` +
      `<span style="position:relative;display:inline-flex;width:16px;height:16px">${dotHtml}</span>` +
      `<div style="text-align:center;font-size:12.5px;font-weight:700;color:${labelColor};white-space:nowrap">${esc(st.label)}</div>` +
      `</div>` +
      connectorHtml
    );
  }).join("");

  // 已用时 pill + 典型时长 + 已连回 N/total
  const elapsedRow =
    `<div style="display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap">` +
    `<span style="display:inline-flex;align-items:center;gap:8px;padding:6px 13px;border-radius:999px;` +
    `background:${soft};border:1px solid ${edge};color:${text};` +
    `font-size:13.5px;font-weight:700;font-variant-numeric:tabular-nums">` +
    `<span class="live-dot is-transitioning" style="width:8px;height:8px;flex-shrink:0"></span>` +
    `${esc(LK_RS.elapsed(elapsed))}` +
    `</span>` +
    `<span style="font-size:12.5px;color:#94a3b8">${esc(LK_RS.typical)}</span>` +
    (typeof recovered === "number" && typeof total === "number"
      ? `<span style="margin-left:auto;font-size:12.5px;font-weight:600;color:${text};font-variant-numeric:tabular-nums">已连回 ${recovered}/${total}</span>`
      : "") +
    `</div>`;

  return (
    `<div style="margin-top:18px;border-radius:13px;overflow:hidden;background:#fff;` +
    `border:1px solid ${edge};box-shadow:0 1px 2px rgba(15,23,42,.04)">` +
    `<div style="display:flex;align-items:stretch">` +
    `<span style="width:4px;flex-shrink:0;background:${c}"></span>` +
    `<div style="flex:1;padding:16px 20px;background:${soft}">` +
    `<div style="display:flex;gap:11px">` +
    `<span style="flex-shrink:0;width:30px;height:30px;border-radius:9px;background:#fff;` +
    `border:1px solid ${edge};color:${c};display:flex;align-items:center;justify-content:center">` +
    ICONS.refresh +
    `</span>` +
    `<div style="min-width:0;flex:1">` +
    `<div style="font-size:12.5px;font-weight:700;letter-spacing:.04em;color:${text};margin-bottom:4px">现在啥情况 —— 预期内的重启,正在恢复</div>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#334155">${esc(LK_RS.calmSay)}</p>` +
    `</div>` +
    `</div>` +
    `<div style="margin-top:16px;padding-top:15px;border-top:1px dashed ${edge}">` +
    `<div style="display:flex;align-items:center;gap:0">${stepsHtml}</div>` +
    elapsedRow +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

/**
 * BL-18:生成「重启超时」hero 红色告警面板 HTML(照 LkRestartTimeoutPanel)。
 * elapsed: 已用秒(至少 LK_RESTART_TIMEOUT_SECS)
 * left: 未连回数
 */
function buildRestartTimeoutPanel(elapsed, left) {
  const sc = { c: LIVE_COLOR.offline, soft: LIVE_SOFT.offline, edge: LIVE_EDGE.offline, text: LIVE_TEXT.offline };
  return (
    `<div style="margin-top:18px;border-radius:13px;overflow:hidden;background:#fff;` +
    `border:1px solid ${sc.edge};box-shadow:0 1px 2px rgba(15,23,42,.04)">` +
    `<div style="display:flex;align-items:stretch">` +
    `<span style="width:4px;flex-shrink:0;background:${sc.c}"></span>` +
    `<div style="flex:1;padding:15px 18px;background:${sc.soft}">` +
    `<div style="display:flex;gap:11px">` +
    `<span style="flex-shrink:0;width:30px;height:30px;border-radius:9px;background:#fff;` +
    `border:1px solid ${sc.edge};color:${sc.c};display:flex;align-items:center;justify-content:center">` +
    ICONS.warn +
    `</span>` +
    `<div style="min-width:0;flex:1">` +
    `<div style="font-size:12.5px;font-weight:700;letter-spacing:.04em;color:${sc.text};margin-bottom:4px">${esc(LK_RS.timeoutTitle)}</div>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#334155">${esc(LK_RS.timeoutSay(elapsed, left))}</p>` +
    `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:13px;align-items:center">` +
    // 查看日志(primary indigo)
    `<button type="button" data-restart-action="logs" ` +
    `style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;` +
    `border:none;background:${BR.c};color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">` +
    ICONS.code + `查看日志` +
    `</button>` +
    // 再试一次(ghost)
    `<button type="button" data-restart-action="restart" ` +
    `style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;` +
    `border:1px solid ${sc.edge};background:#fff;color:${sc.text};font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">` +
    ICONS.refresh + `再试一次重启` +
    `</button>` +
    // 重新扫码(ghost)
    `<button type="button" data-restart-action="rescan" ` +
    `style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;` +
    `border:1px solid ${sc.edge};background:#fff;color:${sc.text};font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">` +
    ICONS.scan + `重新扫码配对` +
    `</button>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// 三层 Agent 配置面板(AcLayer × 3)— vanilla 重建 agentConfig.jsx LkAgentConfig
// 设计权威源:agentConfig.jsx;配色铁律 indigo=交互/红=不可逆;secret 永不显真值。
// ---------------------------------------------------------------------------

/**
 * 把 bot 数据结构里的 repos(旧格式 "slug:branch" 字符串数组 或 {slug,branch,url?} 对象数组)
 * 统一转成 [{slug,branch,url}] 对象数组。
 */
function normalizeRepos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    if (typeof r === "string") {
      const [slug, branch = "main"] = r.split(":").map((s) => s.trim());
      return { slug, branch, url: "" };
    }
    return { slug: r.slug ?? "", branch: r.branch ?? "main", url: r.url ?? "" };
  });
}

function inferRepoSlugFromUrl(url) {
  const text = String(url ?? "").trim();
  if (!text) return "";
  const stripGit = (s) => s.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");

  const scp = /^[A-Za-z0-9_.-]+@[^:\s]+:(.+)$/.exec(text);
  if (scp) return stripGit(scp[1] ?? "");

  try {
    const parsed = new URL(text);
    return stripGit(parsed.pathname);
  } catch {
    return "";
  }
}

/**
 * 生成一个仓库行的 HTML。UI 只暴露 Git 地址;slug/branch 都是内部细节。
 * @param {number} idx
 * @param {{slug:string,branch:string,url:string}} repo
 */
function acRepoRowHTML(idx, repo) {
  const xIcon = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const displayUrl = repo.url || "";
  return (
    `<div class="ac-repo-row" data-repo-idx="${idx}">` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-repo-url-${idx}">代码仓库 Git 地址 <span class="ac-required">必填</span></label>` +
    `<input id="ac-repo-url-${idx}" class="ac-input ac-mono" type="text" placeholder="git@github.com:org/repo.git" spellcheck="false" data-repo="url" data-repo-idx="${idx}" value="${esc(displayUrl)}" />` +
    `</div>` +
    `<button type="button" class="ac-repo-del" title="移除这个仓库" data-repo-idx="${idx}" aria-label="移除仓库 ${esc(repo.slug || repo.url || idx + 1)}">` +
    xIcon +
    `</button>` +
    `</div>`
  );
}

/**
 * 生成收起态摘要药丸 HTML。
 * @param {"brand"|"muted"} tone
 * @param {string} iconD  SVG path d 属性
 * @param {string} text
 */
function acPillHTML(tone, iconD, text) {
  const svg = iconD
    ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">${iconD.split("M").filter(Boolean).map((s) => `<path d="M${s}"/>`).join("")}</svg>`
    : "";
  return `<span class="ac-pill${tone === "brand" ? " ac-pill-brand" : ""}">${svg}${esc(text)}</span>`;
}

/**
 * 生成完整的三层 Agent 配置面板 HTML。
 * @param {object}  bot         已解析的 bot YAML 对象(name/description/app_id/bot_open_id/gitlab_token_env/repos/chats/turn_taking_limit)
 * @param {string}  memContent  memory 文本内容(从 GET /api/memory/:id 拿到)
 * @param {"edit"|"create"} mode
 * @param {object}  [prefill]   create 模式时的预填数据 { appId, openId }
 */
function buildAgentConfigHTML(bot, memContent, mode, prefill) {
  const isCreate = mode === "create";
  const repos = normalizeRepos(bot.repos);
  // ① 用 git_token_env(兼容旧 gitlab_token_env)非空来判断「已配置」——新保存契约:值存后端,前端只知道「有/无」
  const gitlabConfigured = !!(bot.git_token_env || bot.gitlab_token_env);
  const codeAccess = !!(gitlabConfigured || repos.length > 0);
  const chatsVal = Array.isArray(bot.chats) ? bot.chats.join("\n") : (bot.chats || "");
  const turnLimit = bot.turn_taking_limit ?? 10;

  const appId = isCreate ? (prefill?.appId ?? "") : (bot.app_id ?? "");
  const openId = isCreate ? (prefill?.openId ?? "") : (bot.bot_open_id ?? "");

  // 层二 summary 药丸(收起态)
  const permSummaryHTML = codeAccess
    ? acPillHTML("brand", "m16 18 6-6-6-6M8 6l-6 6 6 6", "可访问代码仓库") +
      acPillHTML("muted", "M21 8 12 3 3 8v8l9 5 9-5ZM3 8l9 5 9-5M12 13v8", repos.length ? `预热 ${repos.length} 个仓库` : "agent 自己 clone")
    : acPillHTML("muted", "M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4", "纯对话 · 不碰任何代码仓库");

  // 层三 summary 药丸
  const chatCount = chatsVal.split("\n").map((s) => s.trim()).filter(Boolean).length;
  const advSummaryHTML =
    acPillHTML("muted", "M13 2 3 14h7l-1 8 10-12h-7l1-6Z", `最多连做 ${turnLimit} 步`) +
    acPillHTML("muted", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8", chatCount === 0 ? "任何群都能 @" : `仅 ${chatCount} 个群`);

  // 飞书机器人绑定行(只读)
  const bindingBadge = isCreate
    ? `<span class="ac-binding-badge ac-binding-badge-new"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>扫码刚绑定</span>`
    : `<span class="ac-binding-badge-ro">只读</span>`;

  return (
    `<div class="ac-panel" id="ac-panel">` +
    `<input type="hidden" name="id" value="${esc(bot.id ?? "")}" />` +

    // ─── 层一:定义 ───
    `<section class="ac-layer">` +
    `<div class="ac-layer-head">` +
    `<span class="ac-index">一</span>` +
    `<div class="ac-layer-meta">` +
    `<h3 class="ac-layer-title">Agent 的定义</h3>` +
    `<p class="ac-layer-role">它是谁、干嘛的、怎么干活 —— 任何 bot 都要。纯对话 / 自带知识答疑的 bot，只配这一层就够。</p>` +
    `</div>` +
    `</div>` +
    `<div class="ac-layer-body">` +
    // 头像 + 名字 + 绑定行
    `<div class="ac-identity-row">` +
    `<div class="ac-avatar-wrap" id="ac-avatar-wrap"></div>` +
    `<div class="ac-identity-fields">` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-name">名字</label>` +
    `<p class="ac-hint">这个助手在群里显示的名字。</p>` +
    `<input id="ac-name" name="name" class="ac-input ac-name-input" type="text" value="${esc(bot.name ?? "")}" placeholder="比如：demo-frontend-agent" autocomplete="off" />` +
    `</div>` +
    `<div class="ac-binding-row">` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;color:var(--faint)"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>` +
    `<span class="ac-binding-label">已绑定飞书机器人</span>` +
    `<code class="ac-binding-code">${esc(appId || "—")}</code>` +
    `<span class="ac-binding-dot">·</span>` +
    `<code class="ac-binding-code ac-binding-muted">${esc(openId || "—")}</code>` +
    bindingBadge +
    `</div>` +
    `</div>` +
    `</div>` +
    // 一句话职能
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-desc">一句话职能</label>` +
    `<p class="ac-hint">它能帮人做什么 —— 同事看到这句就知道能 @ 它干嘛。</p>` +
    `<textarea id="ac-desc" name="description" class="ac-input" rows="2" placeholder="比如：回答 Larkway 的配置和功能问题。">${esc(bot.description ?? "")}</textarea>` +
    `</div>` +
    // memory
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-memory">工作方式 / 流程（memory）</label>` +
    `<p class="ac-hint">用大白话写它的使命、知识、怎么干活、边界 —— 它会照这个来工作。这是它的 memory 文件，可在这里直接编辑。</p>` +
    `<textarea id="ac-memory" class="ac-input ac-mono ac-memory-editor" rows="8">${esc(memContent ?? "")}</textarea>` +
    `<div class="ac-memory-hint"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>存为独立 memory 文件，随「保存」一起写入。</div>` +
    `</div>` +
    `</div>` + // ac-layer-body
    `</section>` +

    // ─── 层二:权限 ───
    `<section class="ac-layer ac-layer-collapsible" id="ac-perm-layer" data-open="${codeAccess ? "1" : "0"}">` +
    `<div class="ac-layer-head ac-layer-head-toggle" id="ac-perm-toggle" role="button" tabindex="0" aria-expanded="${codeAccess}">` +
    `<span class="ac-index">二</span>` +
    `<div class="ac-layer-meta">` +
    `<div class="ac-layer-title-row">` +
    `<h3 class="ac-layer-title">Agent 的权限</h3>` +
    `<span class="ac-optional-badge">可选</span>` +
    (codeAccess ? `<span class="ac-open-badge"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>已开</span>` : "") +
    `</div>` +
    `<p class="ac-layer-role">它能不能、以及大概会碰哪些代码仓库。不需要碰代码就别开 —— 光有「定义」就够。</p>` +
    `<div class="ac-perm-summary" id="ac-perm-summary">${codeAccess ? "" : permSummaryHTML}</div>` +
    `</div>` +
    `<svg class="ac-chevron" id="ac-perm-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:${codeAccess ? "rotate(180deg)" : "none"}"><path d="m6 9 6 6 6-6"/></svg>` +
    `</div>` +
    `<div class="ac-layer-body ac-perm-body" id="ac-perm-body" ${codeAccess ? "" : 'style="display:none"'}>` +
    // 核心开关
    `<div class="ac-access-toggle-row${codeAccess ? " is-on" : ""}" id="ac-access-row">` +
    `<div class="ac-access-info">` +
    `<div class="ac-access-title">给它访问代码仓库的权限</div>` +
    `<p class="ac-access-desc">打开后给 agent 一组仓库 clone 地址。Git 访问令牌是可选的身份材料：不填就用这台机器现有的 SSH key、credential helper 或环境变量；能不能读 / push 由 GitHub/GitLab 那边决定。</p>` +
    `</div>` +
    `<button type="button" class="ac-toggle${codeAccess ? " is-on" : ""}" id="ac-code-access-btn" role="switch" aria-checked="${codeAccess}" title="开 / 关代码访问权限">` +
    `<span class="ac-toggle-thumb"></span>` +
    `</button>` +
    `</div>` +
    // 关闭态提示
    `<div class="ac-no-access-hint" id="ac-no-access-hint" ${codeAccess ? 'style="display:none"' : ""}>` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;color:var(--faint)"><path d="M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4"/></svg>` +
    `当前这个 agent 不访问任何代码仓库。需要它读 / 改代码时，再打开上面的开关。` +
    `</div>` +
    // 开启态:仓库 + 高级 Token
    `<div class="ac-access-fields" id="ac-access-fields" ${codeAccess ? "" : 'style="display:none"'}>` +
    // 仓库列表
    `<div class="ac-repos-section">` +
    `<div class="ac-repos-header">` +
    `<span class="ac-repos-title">代码仓库</span>` +
    `</div>` +
    `<p class="ac-hint">打开代码访问后，只需要填仓库的 Git 地址；其余交给 Larkway 自动处理。</p>` +
    `<div class="ac-repos-empty" id="ac-repos-empty" ${repos.length ? 'style="display:none"' : ""}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/></svg>还没有仓库。需要访问代码时，请添加仓库 Git 地址。</div>` +
    `<div class="ac-repos-list" id="ac-repos-list" ${repos.length ? "" : 'style="display:none"'}>${repos.map((r, i) => acRepoRowHTML(i, r)).join("")}</div>` +
    `<button type="button" class="ac-add-repo-btn" id="ac-add-repo-btn">` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>` +
    ` 添加仓库` +
    `</button>` +
    `</div>` + // ac-repos-section
    `<details class="ac-token-advanced">` +
    `<summary>高级设置 <span>使用特定 Git 身份</span></summary>` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-gitlab-token">Git Access Token <span class="ac-optional">可选</span></label>` +
    `<p class="ac-hint">可选。填了会作为 agent 的 Git 认证材料；不填就用本机已有 Git 身份。只存本机 <code>~/.larkway/.env</code>（权限 0600），不回显、不外发。</p>` +
    (gitlabConfigured
      ? `<div class="ac-token-configured" id="ac-token-configured">` +
        `<span class="ac-token-mask">${ICONS.lock} 已配置 <span style="letter-spacing:.12em">••••••</span></span>` +
        `<button type="button" class="btn btn-sm ac-token-reset-btn" id="ac-token-reset-btn">重新设置</button>` +
        `</div>` +
        `<div class="ac-secret-wrap" id="ac-token-input-wrap" style="display:none">` +
        `<svg class="ac-secret-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4"/></svg>` +
        `<input id="ac-gitlab-token" name="gitlab_token_value" class="ac-input ac-secret-input" type="password" autocomplete="new-password" placeholder="粘贴新 token（只存本机，不回显）" value="" />` +
        `</div>`
      : `<div class="ac-secret-wrap" id="ac-token-input-wrap">` +
        `<svg class="ac-secret-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4"/></svg>` +
        `<input id="ac-gitlab-token" name="gitlab_token_value" class="ac-input ac-secret-input" type="password" autocomplete="new-password" placeholder="粘贴 Git access token（只存本机，不回显）" value="" />` +
        `</div>`
    ) +
    `</div>` +
    `</details>` +
    `</div>` + // ac-access-fields
    `</div>` + // ac-perm-body
    `</section>` +

    // ─── 层三:约束 ───
    `<section class="ac-layer ac-layer-collapsible" id="ac-adv-layer" data-open="0">` +
    `<div class="ac-layer-head ac-layer-head-toggle" id="ac-adv-toggle" role="button" tabindex="0" aria-expanded="false">` +
    `<span class="ac-index">三</span>` +
    `<div class="ac-layer-meta">` +
    `<div class="ac-layer-title-row">` +
    `<h3 class="ac-layer-title">行为约束</h3>` +
    `<span class="ac-optional-badge">可选</span>` +
    `</div>` +
    `<p class="ac-layer-role">兜底护栏 —— 一般用默认就好。</p>` +
    `<div class="ac-adv-summary" id="ac-adv-summary">${advSummaryHTML}</div>` +
    `</div>` +
    `<svg class="ac-chevron" id="ac-adv-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>` +
    `</div>` +
    `<div class="ac-layer-body" id="ac-adv-body" style="display:none">` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-turn-limit">最多连做几步就停下问人</label>` +
    `<p class="ac-hint">防止它一口气干太多步；默认 10。</p>` +
    `<input id="ac-turn-limit" name="turn_taking_limit" class="ac-input" type="number" min="1" value="${esc(turnLimit)}" style="width:130px" />` +
    `</div>` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-chats">谁能 @ 它（哪些群）</label>` +
    `<p class="ac-hint">留空 = 任何群 @ 它都会回复（最省事，推荐）。只想限定 → 填群号 oc_…，一行一个。</p>` +
    `<textarea id="ac-chats" name="chats" class="ac-input" rows="2" placeholder="留空即可；或一行一个 oc_…">${esc(chatsVal)}</textarea>` +
    `</div>` +
    `</div>` + // ac-adv-body
    `</section>` +

    // ─── 底部操作 ───
    (isCreate
      ? `<div class="ac-create-footer">` +
        `<span class="ac-create-hint" id="ac-create-hint">${codeAccess ? "有代码访问权 · " : "纯对话 · "}加完去本机跑 <code>larkway start</code> 让它上线。</span>` +
        `<button type="button" class="btn btn-primary ac-create-btn" id="ac-create-btn">` +
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>` +
        ` 添加到名册` +
        `</button>` +
        `</div>`
      : `<div class="ac-save-bar form-actions form-actions-sticky" id="form-actions-bar">` +
        `<button type="submit" class="btn btn-primary" id="btn-save" disabled>` +
        `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>` +
        ` 保存` +
        `</button>` +
        `<span class="dirty-hint" id="form-dirty-hint">无改动</span>` +
        `</div>`) +

    `</div>` // ac-panel
  );
}

/**
 * 渲染 ac-avatar-wrap 里的头像(复用已有 avatarHTML / ob2AvatarHTML)。
 * @param {HTMLElement} panel
 * @param {string}      id
 * @param {string}      name
 * @param {string|null} avatarUrl
 * @param {string}      liveKey
 */
function acRenderAvatar(panel, id, name, avatarUrl, liveKey) {
  const wrap = panel.querySelector("#ac-avatar-wrap");
  if (!wrap) return;
  wrap.innerHTML = avatarHTML(id, name, avatarUrl, "ac", liveKey);
}

/**
 * 绑定三层面板的所有事件:层折叠 / 代码访问开关 / 添加仓库 / 删除仓库 /
 * 层三 summary 实时更新。
 * @param {HTMLElement}         panel    ac-panel 的父容器(detail-panel)
 * @param {string}              id       bot id
 * @param {{gitlab_token_env?:string}} bot   原始 bot 数据(有些字段需要只读回显)
 */
function wireAgentConfigEvents(panel, id, bot) {
  const ac = panel.querySelector("#ac-panel");
  if (!ac) return;

  // ── 层折叠:层二 ──
  const permToggle = ac.querySelector("#ac-perm-toggle");
  const permBody   = ac.querySelector("#ac-perm-body");
  const permChevron = ac.querySelector("#ac-perm-chevron");
  const permSummary = ac.querySelector("#ac-perm-summary");
  const permLayer   = ac.querySelector("#ac-perm-layer");

  function getPermOpen() { return permLayer?.dataset.open === "1"; }
  function setPermOpen(open) {
    if (!permLayer || !permBody || !permChevron) return;
    permLayer.dataset.open = open ? "1" : "0";
    permToggle?.setAttribute("aria-expanded", String(open));
    permBody.style.display = open ? "" : "none";
    permChevron.style.transform = open ? "rotate(180deg)" : "none";
    if (permSummary) { acUpdatePermSummary(ac); permSummary.style.display = open ? "none" : ""; }
  }

  if (permToggle) {
    permToggle.addEventListener("click", () => setPermOpen(!getPermOpen()));
    permToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPermOpen(!getPermOpen()); }
    });
  }

  // ── 层折叠:层三 ──
  const advToggle  = ac.querySelector("#ac-adv-toggle");
  const advBody    = ac.querySelector("#ac-adv-body");
  const advChevron = ac.querySelector("#ac-adv-chevron");
  const advSummary = ac.querySelector("#ac-adv-summary");
  const advLayer   = ac.querySelector("#ac-adv-layer");

  function getAdvOpen() { return advLayer?.dataset.open === "1"; }
  function setAdvOpen(open) {
    if (!advLayer || !advBody || !advChevron) return;
    advLayer.dataset.open = open ? "1" : "0";
    advToggle?.setAttribute("aria-expanded", String(open));
    advBody.style.display = open ? "" : "none";
    advChevron.style.transform = open ? "rotate(180deg)" : "none";
    if (advSummary) advSummary.style.display = open ? "none" : "";
  }

  if (advToggle) {
    advToggle.addEventListener("click", () => setAdvOpen(!getAdvOpen()));
    advToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setAdvOpen(!getAdvOpen()); }
    });
  }

  // ── 代码访问开关 ──
  const codeAccessBtn = ac.querySelector("#ac-code-access-btn");
  const accessRow     = ac.querySelector("#ac-access-row");
  const noAccessHint  = ac.querySelector("#ac-no-access-hint");
  const accessFields  = ac.querySelector("#ac-access-fields");
  const gitlabInput   = ac.querySelector("#ac-gitlab-token");
  const permOpenBadge = ac.querySelector(".ac-open-badge");
  const permLayerTitleRow = ac.querySelector(".ac-layer-title-row");

  // ① 「重新设置」按钮:隐藏「已配置」态,露出密码框
  const tokenResetBtn = ac.querySelector("#ac-token-reset-btn");
  if (tokenResetBtn) {
    tokenResetBtn.addEventListener("click", () => {
      const configured = ac.querySelector("#ac-token-configured");
      const inputWrap = ac.querySelector("#ac-token-input-wrap");
      if (configured) configured.style.display = "none";
      if (inputWrap) inputWrap.style.display = "";
      ac.querySelector("#ac-gitlab-token")?.focus();
      // 标记「已重置」—— readAgentConfigValues 用来判断要不要发 token 字段
      ac.dataset.tokenReset = "1";
    });
  }

  function getCodeAccess() { return codeAccessBtn?.getAttribute("aria-checked") === "true"; }
  function setCodeAccess(on) {
    if (!codeAccessBtn) return;
    codeAccessBtn.setAttribute("aria-checked", String(on));
    codeAccessBtn.classList.toggle("is-on", on);
    if (accessRow) accessRow.classList.toggle("is-on", on);
    if (noAccessHint) noAccessHint.style.display = on ? "none" : "";
    if (accessFields) accessFields.style.display = on ? "" : "none";
    // 关 → 清令牌 + 仓库
    if (!on) {
      if (gitlabInput) gitlabInput.value = "";
      // 隐藏密码框,重置 tokenReset 标记(关闭等于「清除」)
      const configured = ac.querySelector("#ac-token-configured");
      const inputWrap = ac.querySelector("#ac-token-input-wrap");
      if (configured) configured.style.display = "none";
      if (inputWrap) { inputWrap.style.display = ""; } // 关闭态直接露空框,保存时会带 ""
      delete ac.dataset.tokenReset;
      acClearRepos(ac);
    }
    // open 徽标
    if (permLayerTitleRow) {
      let badge = permLayerTitleRow.querySelector(".ac-open-badge");
      if (on && !badge) {
        badge = document.createElement("span");
        badge.className = "ac-open-badge";
        badge.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>已开`;
        permLayerTitleRow.appendChild(badge);
      } else if (!on && badge) {
        badge.remove();
      }
    }
    // 收起态 summary 更新
    acUpdatePermSummary(ac);
    // 层三 summary 更新
    acUpdateAdvSummary(ac);
    // create 态底部 hint 同步
    const createHint = ac.querySelector("#ac-create-hint");
    if (createHint) createHint.innerHTML = `${on ? "有代码访问权 · " : "纯对话 · "}加完去本机跑 <code>larkway start</code> 让它上线。`;
    // 触发脏检测
    ac.dispatchEvent(new Event("ac-change", { bubbles: true }));
  }

  if (codeAccessBtn) {
    codeAccessBtn.addEventListener("click", () => setCodeAccess(!getCodeAccess()));
  }

  // ── 添加仓库 ──
  const addRepoBtn = ac.querySelector("#ac-add-repo-btn");
  if (addRepoBtn) {
    addRepoBtn.addEventListener("click", () => acAddRepo(ac));
  }

  // ── 删除仓库(事件委托) ──
  ac.addEventListener("click", (e) => {
    const delBtn = e.target.closest(".ac-repo-del");
    if (!delBtn) return;
    const idx = parseInt(delBtn.dataset.repoIdx ?? "-1", 10);
    if (idx < 0) return;
    acRemoveRepo(ac, idx);
  });

  // ── 层三实时 summary 更新 ──
  const turnLimitInput = ac.querySelector("#ac-turn-limit");
  const chatsTextarea  = ac.querySelector("#ac-chats");
  if (turnLimitInput) turnLimitInput.addEventListener("input", () => acUpdateAdvSummary(ac));
  if (chatsTextarea) chatsTextarea.addEventListener("input", () => acUpdateAdvSummary(ac));

  // ── 仓库字段变化 → 收起态 summary ──
  ac.addEventListener("input", (e) => {
    if (e.target.dataset.repo) acUpdatePermSummary(ac);
  });

  // ── create 态:「添加到名册」按钮 ──
  const createBtn = ac.querySelector("#ac-create-btn");
  if (createBtn) {
    createBtn.addEventListener("click", () => {
      // 交由外层 submitOnboardName 处理(通过 panel 上挂的 _acSubmit 回调)
      if (typeof panel._acSubmit === "function") panel._acSubmit();
    });
  }
}

/** 读取 ac-panel 内的所有字段,返回序列化后的 bot config 对象。 */
function readAgentConfigValues(panel) {
  const ac = panel.querySelector("#ac-panel");
  if (!ac) return {};

  const v = (sel) => ac.querySelector(sel)?.value?.trim() ?? "";
  const name = v("#ac-name");
  const description = v("#ac-desc");
  const memContent = v("#ac-memory");
  const turnLimit = parseInt(v("#ac-turn-limit"), 10) || 10;
  const chatsRaw = v("#ac-chats");
  const chats = chatsRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  const codeAccessBtn = ac.querySelector("#ac-code-access-btn");
  const codeAccess = codeAccessBtn?.getAttribute("aria-checked") === "true";

  // ① 新保存契约:
  //   - 代码访问关 → gitlab_token_value: ""（清除）
  //   - 已配置 + 没重设 → 不带 gitlab_token_value（保留后端现有值）
  //   - 用户输了新值（包括重设后输了值）→ gitlab_token_value: <新值>
  //   - 已配置 + 点了重设但没输值 → 不带（视为「没改」，不清）
  let _gitlabTokenValue;  // undefined = 不带字段(保留现有);string = 带字段
  if (!codeAccess) {
    _gitlabTokenValue = "";  // 关闭 = 清除
  } else {
    const tokenInput = ac.querySelector("#ac-gitlab-token");
    const typedValue = tokenInput?.value ?? "";
    const wasReset = ac.dataset.tokenReset === "1";
    // 「已配置」态:DOM 中有 #ac-token-configured 且 display 不是 none(未被「重新设置」覆盖)
    const configuredEl = ac.querySelector("#ac-token-configured");
    const isConfigured = !!(configuredEl && configuredEl.style.display !== "none");
    if (typedValue) {
      _gitlabTokenValue = typedValue;  // 输了新值 → 发送
    } else if (!isConfigured && !wasReset) {
      _gitlabTokenValue = "";  // 从未配置且没重设过,没输 → 带空(等同未配置)
    }
    // else: 已配置(显示态)/重设但没输 → _gitlabTokenValue 保持 undefined(不带字段,保留现有)
  }

  // 读所有仓库行
  const repos = [];
  if (codeAccess) {
    const repoRows = ac.querySelectorAll(".ac-repo-row");
    for (const row of repoRows) {
      const url = (row.querySelector("[data-repo='url']")?.value ?? "").trim();
      const inferredSlug = inferRepoSlugFromUrl(url);
      if (inferredSlug || url) {
        const r = { slug: inferredSlug, branch: "main" };
        if (url) r.url = url;
        repos.push(r);
      }
    }
  }

  // hidden id
  const botId = ac.querySelector("[name='id']")?.value ?? "";

  const config = {
    name,
    description,
    chats,
    repos,
    turn_taking_limit: turnLimit,
    _memContent: memContent, // 带出,由调用方分别 PUT /api/memory
  };
  if (botId) config.id = botId;
  // ① 新保存契约:_gitlabTokenValue === undefined 表示「不带字段」(保留现有)
  if (_gitlabTokenValue !== undefined) config.gitlab_token_value = _gitlabTokenValue;

  return config;
}

// ── 仓库行 CRUD ──────────────────────────────────────────────────────────────

function acGetRepos(ac) {
  const rows = ac.querySelectorAll(".ac-repo-row");
  return Array.from(rows).map((row) => {
    const url = (row.querySelector("[data-repo='url']")?.value ?? "").trim();
    return {
      slug: inferRepoSlugFromUrl(url),
      branch: "main",
      url,
      _idx: parseInt(row.dataset.repoIdx ?? "-1", 10),
    };
  });
}

function validateCodeAccessConfig(panel) {
  const ac = panel?.querySelector?.("#ac-panel") ?? panel;
  if (!ac) return true;
  const codeAccessBtn = ac.querySelector("#ac-code-access-btn");
  const codeAccess = codeAccessBtn?.getAttribute("aria-checked") === "true";
  if (!codeAccess) return true;

  const repos = acGetRepos(ac);
  if (repos.length === 0) {
    toast("已打开代码访问，请至少添加一个仓库。", "warn");
    ac.querySelector("#ac-add-repo-btn")?.focus();
    return false;
  }

  for (const repo of repos) {
    const row = ac.querySelector(`.ac-repo-row[data-repo-idx="${repo._idx}"]`);
    const urlInput = row?.querySelector("[data-repo='url']");
    if (!repo.url) {
      toast("请填写代码仓库 Git 地址。Git Access Token 是选填。", "warn");
      urlInput?.focus();
      return false;
    }
    if (!repo.slug) {
      toast("无法从 Git 地址识别仓库，请检查地址格式。", "warn");
      urlInput?.focus();
      return false;
    }
  }
  return true;
}

function acRebuildRepoRows(ac) {
  const list = ac.querySelector("#ac-repos-list");
  const empty = ac.querySelector("#ac-repos-empty");
  if (!list) return;
  const repos = acGetRepos(ac);
  // 重新按新下标渲染
  const tmp = document.createElement("div");
  tmp.innerHTML = repos.map((r, i) => acRepoRowHTML(i, r)).join("");
  list.innerHTML = tmp.innerHTML;
  if (empty) empty.style.display = repos.length === 0 ? "" : "none";
  list.style.display = repos.length === 0 ? "none" : "";
  acUpdatePermSummary(ac);
}

function acAddRepo(ac) {
  const repos = acGetRepos(ac);
  const newIdx = repos.length;
  const list = ac.querySelector("#ac-repos-list");
  const empty = ac.querySelector("#ac-repos-empty");
  if (!list) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = acRepoRowHTML(newIdx, { slug: "", branch: "main", url: "" });
  list.appendChild(tmp.firstElementChild);
  list.style.display = "";
  if (empty) empty.style.display = "none";
  list.querySelector(`#ac-repo-url-${newIdx}`)?.focus();
  acUpdatePermSummary(ac);
  ac.dispatchEvent(new Event("ac-change", { bubbles: true }));
}

function acRemoveRepo(ac, idx) {
  const rows = ac.querySelectorAll(".ac-repo-row");
  for (const row of rows) {
    if (parseInt(row.dataset.repoIdx ?? "-1", 10) === idx) {
      row.remove();
      break;
    }
  }
  // 重建下标
  acRebuildRepoRows(ac);
  ac.dispatchEvent(new Event("ac-change", { bubbles: true }));
}

function acClearRepos(ac) {
  const list = ac.querySelector("#ac-repos-list");
  const empty = ac.querySelector("#ac-repos-empty");
  if (list) { list.innerHTML = ""; list.style.display = "none"; }
  if (empty) empty.style.display = "";
  acUpdatePermSummary(ac);
}

// ── summary 药丸实时更新 ─────────────────────────────────────────────────────

function acUpdatePermSummary(ac) {
  const summaryEl = ac.querySelector("#ac-perm-summary");
  if (!summaryEl) return;
  const isOpen = ac.querySelector("#ac-perm-layer")?.dataset.open === "1";
  if (isOpen) return; // 展开态不显示 summary
  const codeAccess = ac.querySelector("#ac-code-access-btn")?.getAttribute("aria-checked") === "true";
  const repoCount = ac.querySelectorAll(".ac-repo-row").length;
  const html = codeAccess
    ? acPillHTML("brand", "m16 18 6-6-6-6M8 6l-6 6 6 6", "可访问代码仓库") +
      acPillHTML("muted", "M21 8 12 3 3 8v8l9 5 9-5ZM3 8l9 5 9-5M12 13v8", repoCount ? `预热 ${repoCount} 个仓库` : "agent 自己 clone")
    : acPillHTML("muted", "M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8 11V7a4 4 0 0 1 8 0v4", "纯对话 · 不碰任何代码仓库");
  summaryEl.innerHTML = html;
}

function acUpdateAdvSummary(ac) {
  const summaryEl = ac.querySelector("#ac-adv-summary");
  if (!summaryEl) return;
  const isOpen = ac.querySelector("#ac-adv-layer")?.dataset.open === "1";
  if (isOpen) return;
  const turnLimit = parseInt(ac.querySelector("#ac-turn-limit")?.value ?? "10", 10) || 10;
  const chatsRaw = ac.querySelector("#ac-chats")?.value ?? "";
  const chatCount = chatsRaw.split("\n").map((s) => s.trim()).filter(Boolean).length;
  summaryEl.innerHTML =
    acPillHTML("muted", "M13 2 3 14h7l-1 8 10-12h-7l1-6Z", `最多连做 ${turnLimit} 步`) +
    acPillHTML("muted", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8", chatCount === 0 ? "任何群都能 @" : `仅 ${chatCount} 个群`);
}

// ── edit 态专用:脏检测快照(含 memory) ───────────────────────────────────────

function acFormSnapshot(panel) {
  // 把「底座」纳入快照,切底座才会被算作表单改动(点亮保存按钮)。
  return JSON.stringify(readAgentConfigValues(panel)) + "|bk:" + (panel._pendingBackend || "");
}

function buildRecentEventsPanelHTML(id) {
  const filter = state.eventFilters[id] || "all";
  const filters = EVENT_FILTERS.map(([key, label]) =>
    `<button type="button" class="event-filter${filter === key ? " is-active" : ""}" data-event-filter="${esc(key)}">${esc(label)} <b>—</b></button>`
  ).join("");
  return `
<section class="event-panel" id="recent-events-panel" data-bot-id="${esc(id)}">
  <div class="event-panel-head">
    <div>
      <h4 class="event-title">${ICONS.inbox} 最近事件</h4>
      <p class="event-desc">最近 20 条飞书事件。用来判断 @ 有没有进来、是否被过滤、是否已交给 Agent。</p>
    </div>
    <div class="event-head-actions">
      <span class="event-last">${ICONS.info} 最后事件 加载中…</span>
      <button type="button" class="btn btn-sm event-refresh" id="btn-events-refresh">${ICONS.refresh} 刷新</button>
    </div>
  </div>
  <div class="event-filters" role="tablist" aria-label="最近事件筛选">${filters}</div>
  <div class="event-list" id="event-list">
    <div class="event-loading"><span class="spinner"></span><span>正在读取最近事件…</span></div>
  </div>
</section>`;
}

async function loadRecentEvents(id, panel, opts = {}) {
  const target = panel?.querySelector?.("#recent-events-panel");
  if (!target) return;
  if (!opts.silent) {
    const list = target.querySelector("#event-list");
    if (list) list.innerHTML = `<div class="event-loading"><span class="spinner"></span><span>正在刷新…</span></div>`;
  }
  const res = await api("GET", `/api/bot/${encodeURIComponent(id)}/events`);
  if (state.selected !== id) return;
  if (!res.ok) {
    renderRecentEventsPanel(target, {
      events: [],
      summary: null,
      diagnostics: { noEventsHint: res.json?.error ?? "最近事件读取失败。" },
    });
    return;
  }
  renderRecentEventsPanel(target, res.json || {});
}

function renderRecentEventsPanel(target, data) {
  const events = Array.isArray(data.events) ? data.events : [];
  const summary = data.summary || {};
  const botId = target.dataset.botId || state.selected || "";
  const filter = state.eventFilters[botId] || "all";
  const showAll = !!state.eventShowAll[botId];
  const list = target.querySelector("#event-list");
  const lastEl = target.querySelector(".event-last");

  if (lastEl) {
    lastEl.innerHTML = `${ICONS.info} 最后事件 ${summary.lastEventAt ? esc(formatEventTime(summary.lastEventAt)) : "暂无事件"}`;
  }

  for (const btn of target.querySelectorAll("[data-event-filter]")) {
    const key = btn.dataset.eventFilter || "all";
    btn.classList.toggle("is-active", key === filter);
    const count = eventFilterCount(events, key);
    btn.classList.toggle("has-count", count > 0);
    btn.innerHTML = `${esc(EVENT_FILTERS.find(([k]) => k === key)?.[1] ?? key)} <b>${count}</b>`;
  }

  const filtered = filterEvents(events, filter);
  if (!list) return;
  if (events.length === 0) {
    const hint = data.diagnostics?.noEventsHint ||
      "还没收到过这个 bot 的飞书事件。刚 @ 了但这里没有，通常说明本机 bridge 没收到事件。";
    list.innerHTML =
      `<div class="event-empty">${ICONS.info}<div><b>暂无事件</b><span>${esc(hint)}</span></div></div>`;
    return;
  }
  if (filtered.length === 0) {
    list.innerHTML =
      `<div class="event-empty">${ICONS.info}<div><b>这个筛选下没有事件</b><span>换到「全部」看最近 20 条。</span></div></div>`;
    return;
  }
  const visible = showAll ? filtered : filtered.slice(0, 4);
  const hiddenCount = Math.max(0, filtered.length - visible.length);
  list.innerHTML =
    visible.map((event, index) => eventRowHTML(event, { forceOpen: index === 0 && event.status !== "completed" })).join("") +
    (hiddenCount > 0
      ? `<button type="button" class="event-show-all" id="btn-events-show-all">查看全部 ${filtered.length} 条</button>`
      : "");
}

function eventFilterCount(events, key) {
  if (key === "all") return events.length;
  return events.filter((event) => event.status === key).length;
}

function filterEvents(events, key) {
  if (key === "all") return events;
  return events.filter((event) => event.status === key);
}

function eventFilterTone(key) {
  if (key === "running" || key === "received") return "blue";
  if (key === "completed") return "green";
  if (key === "failed") return "red";
  return "gray";
}

function eventRowHTML(e, opts = {}) {
  const meta = eventStatusMeta(e.status);
  const chat = displayEventChat(e);
  const sender = displayEventSender(e);
  const text = e.textPreview || "无文本内容";
  const previewLabel = sender ? `${sender}：` : "用户消息：";
  const statusClass = eventStatusClass(e.status);
  const pathText = Array.isArray(e.statusPath) && e.statusPath.length
    ? e.statusPath.join(" → ")
    : meta.text;
  const detail = [
    e.messageId ? `messageId: ${e.messageId}` : "",
    e.threadId ? `threadId: ${e.threadId}` : "",
    e.chatId ? `chatId: ${e.chatId}` : "",
    e.durationMs ? `耗时: ${Math.round(e.durationMs / 1000)}s` : "",
  ].filter(Boolean).join(" · ");
  const detailItems = [
    ["飞书消息 ID（排查用）", e.messageId],
    ["话题 ID（排查用）", e.threadId],
    ["群聊 ID（排查用）", e.chatId],
    ["触发类型", eventTriggerLabel(e.triggerType)],
    ["收到", formatEventAbsolute(e.receivedAt)],
    ["开始 / 结束", `${e.startedAt ? formatEventAbsolute(e.startedAt) : "—"} → ${e.finishedAt ? formatEventAbsolute(e.finishedAt) : "运行中"}`],
  ].filter(([, value]) => value);
  const pathChips = (Array.isArray(e.statusPath) && e.statusPath.length ? e.statusPath : [meta.text])
    .map((item, index, arr) =>
      `<span class="event-path-chip${index === arr.length - 1 ? " is-current" : ""}">${esc(item)}</span>`
    ).join("");
  const diagnostic = [
    `状态: ${meta.label}`,
    `路径: ${pathText}`,
    e.reason ? `原因: ${e.reason}` : "",
    detail,
  ].filter(Boolean).join("\n");
  const openAttr = opts.forceOpen ? " open" : "";
  const statusLine = eventStatusLine(e, meta);

  return `
<details class="event-row" data-status="${esc(e.status)}"${openAttr}>
  <summary>
    <span class="event-dot" aria-hidden="true"></span>
    <span class="event-main">
      <span class="event-line"><b>${esc(formatEventTime(e.receivedAt))}</b><span class="event-trigger-badge">${esc(eventTriggerLabel(e.triggerType))}</span><span class="event-source">来自「${esc(chat)}」</span></span>
      <span class="event-preview"><b>${esc(previewLabel)}</b><span>${esc(text)}</span></span>
      <span class="event-mini event-mini--${esc(statusClass)}">${esc(statusLine)}</span>
    </span>
  </summary>
  <div class="event-detail">
    <div class="event-detail-grid">
      ${detailItems.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}
    </div>
    <div class="event-path">${pathChips}</div>
    ${e.reason ? `<div class="event-reason">${esc(e.reason)}</div>` : ""}
    ${detail ? `<code>${esc(detail)}</code>` : ""}
    <div class="event-actions">
      <button type="button" class="btn btn-sm event-copy" data-diagnostic="${esc(diagnostic)}">${ICONS.code} 复制诊断信息</button>
      <button type="button" class="btn btn-sm event-logs">${ICONS.code} 查看日志</button>
    </div>
  </div>
</details>`;
}

function eventStatusLine(e, meta) {
  const duration = e.durationMs ? formatDuration(e.durationMs) : "";
  if (e.status === "running") {
    const elapsed = e.startedAt ? formatDuration(Date.now() - Date.parse(e.startedAt)) : "";
    const calls = toolCallCountFromEvent(e);
    return `Agent 正在处理${elapsed ? ` · 已运行 ${elapsed}` : ""}${calls ? ` · ${calls} 次工具调用` : ""}`;
  }
  if (e.status === "completed") return `已回复${duration ? ` · 用时 ${duration}` : ""}`;
  if (e.status === "failed") return `处理失败${e.reason ? `：${e.reason}` : ""}`;
  if (e.status === "filtered") return `已忽略：${e.reason || "被过滤或重复事件"}`;
  return meta.text;
}

function toolCallCountFromEvent(e) {
  const text = [...(e.statusPath || []), e.reason || ""].join(" ");
  const m = text.match(/(\d+)\s*次工具调用/);
  return m ? m[1] : "";
}

function wireRecentEvents(panel, id) {
  panel.querySelector("#btn-events-refresh")?.addEventListener("click", () => loadRecentEvents(id, panel));
  panel.querySelector("#recent-events-panel")?.addEventListener("click", async (e) => {
    const filterBtn = e.target.closest?.("[data-event-filter]");
    if (filterBtn) {
      state.eventFilters[id] = filterBtn.dataset.eventFilter || "all";
      await loadRecentEvents(id, panel, { silent: true });
      return;
    }
    if (e.target.closest?.("#btn-events-show-all")) {
      state.eventShowAll[id] = true;
      await loadRecentEvents(id, panel, { silent: true });
      return;
    }
    const copyBtn = e.target.closest?.(".event-copy");
    if (copyBtn) {
      await navigator.clipboard?.writeText(copyBtn.dataset.diagnostic || "");
      toast("诊断信息已复制", "ok");
      return;
    }
    if (e.target.closest?.(".event-logs")) {
      await showBridgeLogs();
    }
  });
}

/**
 * 构建详情区 HTML string — 使用三层 Agent 配置面板(buildAgentConfigHTML)。
 * hero band + status action 保留;配置表单 + memory 由 AC 面板统一承载。
 * secret 只显示变量名。
 */
function buildDetailHTML(id, bot, memContent) {
  // 详情头像(hero,右下角状态角标 + 健康脉冲环);头像 URL 复用列表/status 同源
  const avatar = state.avatars[id] ?? bot.avatar ?? null;
  // ⑤ hero 颜色以后端 effLive 为准:bridge 停时即使 status 说 serving,也强制 offline
  const liveKey = effLive(id);
  const heroTintKey = liveKey === "serving" ? "brand" : liveKey;

  // hero 初始 form 值:AC 面板里用 bot 真实值渲染,hero 用同一份
  const chatLines = Array.isArray(bot.chats) ? bot.chats : [];
  const repos = normalizeRepos(bot.repos);
  const heroInner = buildHeroInner(
    id,
    bot,
    {
      name: bot.name ?? "",
      description: bot.description ?? "",
      chatCount: chatLines.length,
      repoCount: repos.length,
    },
  );

  // 状态可操作化面板
  const effLiveKey = effLive(id);
  const statusActionPanel = effLiveKey !== "serving"
    ? `<div id="detail-status-action">${buildStatusActionPanel(effLiveKey, null, false)}</div>`
    : `<div id="detail-status-action"></div>`;

  // 三层 AC 配置面板(edit 态)
  const acPanelHTML = buildAgentConfigHTML(bot, memContent, "edit");

  // 触点④(编辑表单顶部):底座选择卡
  const _configuredBk4 = bot.backend || LK_BACKEND_DEFAULT;
  const _runningBk4 = state.runningBackends[id] ?? null;
  // BL-17:底座不一致 badge(详情区,md)— 只在 bridge 在跑时显示
  const bkMismatchDetail =
    state.bridge?.running && isBackendMismatch(_runningBk4, _configuredBk4)
      ? `<div style="margin-top:10px">${backendMismatchBadgeHTML(_runningBk4, _configuredBk4, "md")}` +
        `<span style="margin-left:8px;font-size:12px;color:var(--muted)">右上角重启服务后生效</span></div>`
      : "";
  const backendCardHTML = `<div class="lk-bk-card" id="lk-bk-card">` +
    `<h4 class="lk-bk-card-title">${ICONS.box} 用哪个底座驱动它</h4>` +
    `<p class="lk-bk-card-desc">底座决定这个助手背后跑哪个 CLI agent。默认 Codex；切换后需重启服务生效。</p>` +
    lkBackendSelectHTML(_configuredBk4, `bk-edit-${id}`) +
    bkMismatchDetail +
    `</div>`;

  return `
<!-- 编辑式 hero band(健康=indigo soft 渐变,异常=status soft 渐变） -->
<div class="hero-band" id="detail-hero" data-tint="${heroTintKey}">
  <div class="hero-row">
    ${avatarHTML(id, bot.name || id, avatar, "hero", liveKey)}
    <div class="hero-body" id="detail-hero-body">${heroInner}</div>
  </div>
</div>

<!-- 配置区(maxWidth 820) -->
<div class="config-area">
  <div class="status-banner" id="detail-status-banner" role="status" aria-live="polite" hidden></div>
  ${statusActionPanel}

  ${buildRecentEventsPanelHTML(id)}

  <!-- 底座选择卡(触点④,本机 edit 模式顶部) -->
  ${backendCardHTML}

  <!-- 三层 Agent 配置面板 -->
  <div class="ac-panel-wrap" id="ac-panel-wrap">
    ${acPanelHTML}
  </div>
</div>
`;
}

/** 计算表单当前序列化快照(用于脏检测对比)。 */
function formSnapshot(form) {
  return JSON.stringify(readFormValues(form));
}

/** 刷新 chats/repos 的「当前生效」chip(随输入实时变)。 */
function refreshChips(panel) {
  for (const field of ["f-chats", "f-repos"]) {
    const ta = panel.querySelector(`#${field}`);
    const chip = panel.querySelector(`[data-chip-for="${field}"]`);
    if (!ta || !chip) continue;
    const count = ta.value.split("\n").map((s) => s.trim()).filter(Boolean).length;
    chip.outerHTML = renderChip(field, count);
  }
}

/**
 * 编辑式 hero「所见即所改」:输入名字/介绍/群/仓库时,重渲染 hero 内层
 * (名字、介绍、meta strip)。bot 提供只读 meta(app_id / bot_open_id)。
 */
function refreshHero(panel, id, bot, readonly) {
  const body = panel.querySelector("#detail-hero-body");
  if (!body) return;
  const v = (name) => panel.querySelector(`[name="${name}"]`)?.value ?? "";
  const countLines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean).length;
  const f = {
    name: v("name").trim(),
    description: v("description").trim(),
    chatCount: countLines(v("chats")),
    repoCount: countLines(v("repos")),
  };
  body.innerHTML = buildHeroInner(id, bot, f, readonly);
}

/** 更新表单脏状态 → 保存按钮可用性 + 文案。 */
function updateFormDirty(panel) {
  const btn = panel.querySelector("#btn-save");
  const hint = panel.querySelector("#form-dirty-hint");
  if (btn) btn.disabled = !state.formDirty;
  if (hint) {
    hint.textContent = state.formDirty ? "有未保存改动" : "无改动";
    hint.classList.toggle("is-dirty", state.formDirty);
  }
}

/** 更新 memory 脏状态 → 保存按钮可用性 + 文案。 */
function updateMemoryDirty(panel) {
  const btn = panel.querySelector("#btn-save-memory");
  const hint = panel.querySelector("#memory-dirty-hint");
  if (btn) btn.disabled = !state.memoryDirty;
  if (hint) {
    hint.textContent = state.memoryDirty ? "有未保存改动" : "无改动";
    hint.classList.toggle("is-dirty", state.memoryDirty);
  }
}

/**
 * BL-18:绑定 hero 区重启面板里的动作按钮(data-restart-action)。
 * timeout 面板:logs / restart / rescan。
 * 调用方在每次 hero body innerHTML 重建后调用。
 */
function wireRestartPanelButtons(panel) {
  if (!panel) return;
  panel.querySelectorAll("[data-restart-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.restartAction;
      if (action === "restart") {
        // 再试一次:重置状态机,重新走 restart
        state.restart = { status: "serving", startedAt: null, elapsed: 0 };
        doFixAction("restart");
      } else if (action === "logs") {
        showBridgeLogs();
      } else if (action === "rescan") {
        openOnboardModal();
      }
    });
  });
}

/** 为详情区内的按钮绑定事件(三层 AC 面板版)。 */
function wireDetailEvents(panel, id, bot) {
  wireRecentEvents(panel, id);
  const statusActionContainer = panel.querySelector("#detail-status-action");
  if (statusActionContainer) wireStatusActionButtons(statusActionContainer);
  // Wire restart panel buttons (timeout panel: logs/restart/rescan)
  wireRestartPanelButtons(panel);

  // ── 三层 AC 面板:交互 + 脏检测 + 保存 ──────────────────────────────────
  wireAgentConfigEvents(panel, id, bot);

  // 底座 pending 值要在捕获脏检测基线「之前」初始化,否则切底座算不进脏状态。
  panel._pendingBackend = bot.backend || LK_BACKEND_DEFAULT;

  // AC 面板脏检测基线
  panel._acBaseline = acFormSnapshot(panel);
  state.formDirty = false;
  state.memoryDirty = false;
  updateFormDirty(panel);

  // 监听 AC 面板变化事件 → 更新脏状态 + 保存按钮 + hero
  const acPanelEl = panel.querySelector("#ac-panel");
  if (acPanelEl) {
    acPanelEl.addEventListener("input", () => {
      state.formDirty = acFormSnapshot(panel) !== panel._acBaseline;
      updateFormDirty(panel);
      acRefreshHero(panel, id, bot);
    });
    acPanelEl.addEventListener("ac-change", () => {
      state.formDirty = acFormSnapshot(panel) !== panel._acBaseline;
      updateFormDirty(panel);
      acRefreshHero(panel, id, bot);
    });
  }

  // AC 面板「保存」按钮(#btn-save 在 ac-save-bar 里)
  const btnSave = panel.querySelector("#btn-save");
  if (btnSave) {
    btnSave.addEventListener("click", async () => {
      if (btnSave.disabled) return;
      await saveAcBot(panel, id);
    });
  }

  // ── 触点④:底座选择卡交互 ───────────────────────────────────────────────
  const bkCard = panel.querySelector("#lk-bk-card");
  if (bkCard) {
    // 初始值来自 bot.backend(加载时已渲染进 HTML);pending 存面板上等保存
    wireLkBackendSelect(bkCard, (newId) => {
      panel._pendingBackend = newId;
      // 切底座算作表单改动 → 点亮保存按钮(否则 toast 提示了却存不了)
      state.formDirty = acFormSnapshot(panel) !== panel._acBaseline;
      updateFormDirty(panel);
      // 即时刷新 hero kicker + meta strip(无需保存,视觉跨触点联动)
      // 用 bot proxy 把 backend 改成新值传 buildHeroInner
      const botWithNewBackend = { ...bot, backend: newId };
      const heroBody = panel.querySelector("#detail-hero-body");
      if (heroBody) {
        const chatLines = Array.isArray(bot.chats) ? bot.chats : [];
        const repos = normalizeRepos(bot.repos);
        heroBody.innerHTML = buildHeroInner(
          id,
          botWithNewBackend,
          {
            name: panel.querySelector("[name='name']")?.value ?? bot.name ?? "",
            description: panel.querySelector("[name='description']")?.value ?? bot.description ?? "",
            chatCount: chatLines.length,
            repoCount: repos.length,
          },
        );
        // re-wire hero del btn
        heroBody.querySelector("#btn-hero-del")?.addEventListener("click", () => doDeleteBot(id));
      }
      // 名册行 chip 也跟着换(直接操作 DOM)
      const rosterLi = document.querySelector(`li[data-bot-id="${CSS.escape(id)}"]`);
      if (rosterLi) {
        const rosterChipEl = rosterLi.querySelector(".roster-state > span[style*='margin-left:auto']");
        if (rosterChipEl) rosterChipEl.innerHTML = lkBackendChipHTML(newId, { size: "sm" });
      }
      toast(`底座已切换为 ${lkBackend(newId).name}（保存后生效）`, "info");
    });
  }

  // 详情 hero 删除按钮
  const btnHeroDel = panel.querySelector("#btn-hero-del");
  if (btnHeroDel) {
    btnHeroDel.addEventListener("click", () => doDeleteBot(id));
  }

}

/**
 * 更新 hero band 标题/描述(AC 面板里输入时实时同步)。
 * @param {HTMLElement} panel   detail-panel 根元素
 * @param {string}      id      bot id
 * @param {object}      bot     原始 bot 对象
 */
function acRefreshHero(panel, id, bot) {
  const body = panel.querySelector("#detail-hero-body");
  if (!body) return;
  const vals = readAgentConfigValues(panel);
  const chatCount = Array.isArray(vals.chats) ? vals.chats.length : 0;
  const repoCount = Array.isArray(vals.repos) ? vals.repos.length : 0;
  body.innerHTML = buildHeroInner(id, { ...bot, name: vals.name, description: vals.description }, {
    name: vals.name ?? "",
    description: vals.description ?? "",
    chatCount,
    repoCount,
  });
  // re-wire del button(内容重建后需重绑)
  const btnHeroDel = body.querySelector("#btn-hero-del");
  if (btnHeroDel) btnHeroDel.addEventListener("click", () => doDeleteBot(id));
  // BL-18:re-wire restart panel buttons(timeout 面板 logs/restart/rescan)
  wireRestartPanelButtons(body);
}

/** 从表单读取 bot config 对象。 */
function readFormValues(form) {
  const v = (name) => form.querySelector(`[name="${name}"]`)?.value?.trim() ?? "";
  const chatsRaw = v("chats");
  const reposRaw = v("repos");
  const peersRaw = v("peers");

  const chats = chatsRaw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const repos = reposRaw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [slug, branch = "main"] = line.split(":").map((p) => p.trim());
      return { slug, branch };
    });
  const peers = peersRaw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const config = {
    id: v("id"),
    name: v("name"),
    description: v("description"),
    app_id: v("app_id"),
    app_secret_env: v("app_secret_env"),
    bot_open_id: v("bot_open_id"),
    chats,
    repos,
    peers,
    turn_taking_limit: parseInt(v("turn_taking_limit"), 10) || 10,
  };

  const larkProfile = v("lark_cli_profile");
  if (larkProfile) config.lark_cli_profile = larkProfile;
  // gitlab_token_env is an internal detail auto-generated by the backend.
  // The UI no longer sends it — do not read or forward this field.

  return config;
}

/** 把按钮切到 loading 态;返回一个 restore 函数。 */
function btnLoading(btn, loadingText) {
  if (!btn) return () => {};
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${esc(loadingText)}`;
  return () => {
    btn.disabled = false;
    btn.innerHTML = original;
  };
}

/** 保存成功:让 indigo 主按钮闪一下(lk-saveflash)。 */
function flashSave(btn) {
  if (!btn) return;
  btn.classList.remove("saveflash");
  void btn.offsetWidth; // 强制 reflow 重新触发动画
  btn.classList.add("saveflash");
}

async function saveBot(panel, id, form) {
  const errEl = panel.querySelector("#form-err");
  if (errEl) errEl.hidden = true;

  const config = readFormValues(form);
  const restore = btnLoading(panel.querySelector("#btn-save"), "保存中…");

  const res = await api("PUT", `/api/bot/${encodeURIComponent(id)}`, config);
  restore();

  if (res.ok) {
    toast("已保存", "ok");
    flashSave(panel.querySelector("#btn-save"));
    // 回到「无改动」态:更新基线 + 清脏 + 禁用保存
    panel._formBaseline = formSnapshot(form);
    state.formDirty = false;
    updateFormDirty(panel);
    // 名称可能变了 → 刷新左侧列表
    await loadBots({ silent: true });
  } else {
    const msg = res.json?.error ?? `HTTP ${res.status}`;
    if (errEl) {
      errEl.innerHTML = `${ICONS.x}<div></div>`;
      errEl.querySelector("div").textContent = msg;
      errEl.hidden = false;
    }
    toast(`失败：${msg}`, "error");
  }
}

async function saveMemory(panel, id) {
  const editor = panel.querySelector("#memory-editor");
  const content = editor?.value ?? "";
  const restore = btnLoading(panel.querySelector("#btn-save-memory"), "保存中…");

  const res = await api("PUT", `/api/memory/${encodeURIComponent(id)}`, { content });
  restore();

  if (res.ok) {
    toast("职责说明已保存", "ok");
    flashSave(panel.querySelector("#btn-save-memory"));
    // 回到「无改动」态
    panel._memoryBaseline = content;
    state.memoryDirty = false;
    updateMemoryDirty(panel);
  } else {
    toast(`失败：${res.json?.error ?? res.status}`, "error");
  }
}

/**
 * 保存 AC 面板:PUT /api/bot/:id(bot config) + PUT /api/memory/:id(memory 内容)。
 * memory 随「保存」一起提交。序列化字段见 readAgentConfigValues。
 */
async function saveAcBot(panel, id) {
  if (!validateCodeAccessConfig(panel)) return;

  const vals = readAgentConfigValues(panel);
  const memContent = vals._memContent ?? "";

  // 提取 bot config 字段(不含 _memContent)
  const { _memContent: _drop, ...botConfig } = vals;

  // 注入 backend(来自底座选择卡;存在 panel._pendingBackend 或从 DOM 读)
  const pendingBackend = panel._pendingBackend;
  if (pendingBackend) botConfig.backend = pendingBackend;

  const btnSave = panel.querySelector("#btn-save");
  const restore = btnLoading(btnSave, "保存中…");

  // 先保存 YAML,再保存工作方式。后端会把两者合成 workspace/AGENTS.md;
  // 串行避免两个请求并发时 AGENTS.md 被旧的 description 或 memory 覆盖。
  const botRes = await api("PUT", `/api/bot/${encodeURIComponent(id)}`, botConfig);
  const memRes = botRes.ok
    ? await api("PUT", `/api/memory/${encodeURIComponent(id)}`, { content: memContent })
    : { ok: false, json: { error: null } };
  restore();

  if (botRes.ok && memRes.ok) {
    toast("已保存", "ok");
    flashSave(btnSave);
    // 更新脏检测基线
    panel._acBaseline = acFormSnapshot(panel);
    state.formDirty = false;
    state.memoryDirty = false;
    updateFormDirty(panel);
    // 名称可能变了 → 刷新左侧列表
    await loadBots({ silent: true });
  } else {
    const msg = (botRes.ok ? null : botRes.json?.error) ?? (memRes.ok ? null : memRes.json?.error) ?? "保存失败";
    toast(`失败：${msg}`, "error");
  }
}



// ---------------------------------------------------------------------------
// 行为:Bridge 服务控制(B3)
// ---------------------------------------------------------------------------

/**
 * 拉 GET /api/bridge 并刷新顶栏 bridge 状态指示。
 * 失败时降级显示「服务状态未知」,绝不抛错。
 */
async function refreshBridgeStatus() {
  const res = await api("GET", "/api/bridge");
  if (res.ok && res.json) {
    state.bridge = res.json;
  } else {
    state.bridge = null;
  }
  renderServiceIndicator();
  // 刷新详情区里的「怎么办」面板(bridge 状态影响 effLive)
  if (state.selected) rerenderStatusAction(state.selected);
}

/**
 * 渲染顶栏 bridge 服务指示器(LkServiceIndicator)。
 * 五态:
 *   - running=false → 红报警+启动按钮
 *   - restart.status='restarting' → sky「重启中 Ns… · 通常十几秒就好」(照 LkServiceRestartChip)
 *   - restart.status='timeout' → 红「重启异常」+「再试一次」(照 LkServiceRestartChip timeout)
 *   - pendingNew>0 → amber提示+重启
 *   - running+ok → 绿chip+重启服务幽灵按钮(照 LkServiceRestartChip serving)
 */
function renderServiceIndicator() {
  const container = document.getElementById("bridge-indicator");
  if (!container) return;

  const b = state.bridge;
  const running = b?.running ?? false;
  const readonly = false;

  if (!b) {
    // 未知态(/api/bridge 没拉到):中性灰 chip,不报警也不显绿。
    container.innerHTML =
      `<span class="lk-svc-indicator lk-svc-indicator--unknown">` +
      `<span class="bridge-dot is-stopped" style="margin-right:6px"></span>` +
      `服务状态未知` +
      `</span>`;
    return;
  }

  // 状态(running)与按钮(readonly)是两个独立维度:服务没跑/有新助手时**始终**显示
  // 报警状态条:服务异常时绝不把状态改成绿色。
  const svcBtn = (id, borderColor, icon, label, action) =>
    readonly
      ? ""
      : `<button type="button" class="lk-svc-action-btn" id="${id}" ` +
        `style="display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;` +
        `border:none;border-left:1px solid ${borderColor};background:${BR.c};color:#fff;` +
        `font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">` +
        icon + label +
        `</button>`;

  // ── BL-18:启动/重启过渡态 ─────────────────────
  // Must run before the `!running` branch: after clicking "启动服务", the
  // backend has accepted the start but detectBridgeStatus may still report
  // running=false for a few seconds while bridge boots and bots reconnect.
  if (!readonly) {
    const rs = state.restart;

    // restarting → sky「重启中 Ns… · 通常十几秒就好」(照 LkServiceRestartChip restarting)
    if (rs.status === "restarting") {
      container.innerHTML =
        `<span class="lk-svc-indicator" style="display:inline-flex;align-items:center;gap:9px;` +
        `height:36px;padding:0 15px;border-radius:10px;` +
        `border:1px solid ${LIVE_EDGE.transitioning};background:${LIVE_SOFT.transitioning};` +
        `color:${LIVE_TEXT.transitioning};font-size:13px;font-weight:600;white-space:nowrap">` +
        // sky spinner
        `<span style="display:inline-block;width:14px;height:14px;border:2px solid ${LIVE_EDGE.transitioning};` +
        `border-top-color:${LIVE_COLOR.transitioning};border-radius:50%;animation:spin .9s linear infinite;flex-shrink:0"></span>` +
        `<span style="font-variant-numeric:tabular-nums">${esc(LK_RS.elapsed(rs.elapsed))}</span>` +
        `<span style="font-size:11.5px;font-weight:500;color:#7dadc9">· ${esc(LK_RS.typical)}</span>` +
        `</span>`;
      return;
    }

    // timeout → 红「重启异常」+ indigo「再试一次」(照 LkServiceRestartChip timeout)
    if (rs.status === "timeout") {
      container.innerHTML =
        `<div class="lk-svc-indicator" style="display:inline-flex;align-items:center;gap:0;` +
        `border-radius:10px;border:1px solid #fecaca;background:#fef2f2;overflow:hidden">` +
        `<span style="display:inline-flex;align-items:center;gap:7px;padding:0 12px 0 13px;` +
        `height:36px;font-size:13px;font-weight:600;color:#b91c1c;white-space:nowrap">` +
        `<span class="live-dot is-offline" style="width:8px;height:8px;flex-shrink:0"></span>` +
        `重启异常` +
        `<span style="font-size:11.5px;font-weight:500;color:#dc2626;opacity:.8">· 超 ${LK_RESTART_TIMEOUT_SECS}s 没恢复</span>` +
        `</span>` +
        `<button type="button" id="btn-svc-retry" ` +
        `style="display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;` +
        `border:none;border-left:1px solid #fecaca;background:${BR.c};color:#fff;` +
        `font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">` +
        ICONS.refresh + `再试一次` +
        `</button>` +
        `</div>`;
      container.querySelector("#btn-svc-retry")?.addEventListener("click", () => {
        // 再试一次:重置状态机,重新触发 restart
        state.restart = { status: "serving", startedAt: null, elapsed: 0 };
        doFixAction("restart");
      });
      return;
    }
  }

  if (!running) {
    // running=false → 红报警条(+ indigo 启动按钮,只读时省略)
    container.innerHTML =
      `<div class="lk-svc-indicator lk-svc-indicator--offline">` +
      `<span class="lk-svc-label">` +
      `<span class="bridge-dot is-stopped" style="margin-right:6px"></span>` +
      `服务未运行` +
      `<span class="lk-svc-sublabel"> · 助手都不会回复</span>` +
      `</span>` +
      svcBtn("btn-svc-start", "#fecaca", ICONS.zap, "启动服务", "start") +
      `</div>`;
    container.querySelector("#btn-svc-start")?.addEventListener("click", () => doFixAction("start"));
    return;
  }

  // 综合 pendingRestart(后端感知新增/已删)与本地 pendingNewCount(客户端推算)
  // 后端字段更权威;本地计算作回退(后端未返回时)。
  const pr = state.pendingRestart;
  const pendingNew = pr.newCount > 0 ? pr.newCount : pendingNewCount();
  const pendingGhost = pr.ghostCount ?? 0;
  const hasPending = pendingNew > 0 || pendingGhost > 0;

  if (hasPending) {
    // running + 有变更 → amber 提示(+ indigo 重启按钮,只读时省略)
    let pendingLabel;
    if (pendingNew > 0 && pendingGhost === 0) {
      pendingLabel = `有 ${pendingNew} 个新助手·重启服务生效`;
    } else if (pendingGhost > 0 && pendingNew === 0) {
      pendingLabel = `有 ${pendingGhost} 个助手已删除，重启服务后下线`;
    } else {
      pendingLabel = `助手有变更（新增 ${pendingNew} / 删除 ${pendingGhost}）·重启服务生效`;
    }
    container.innerHTML =
      `<div class="lk-svc-indicator lk-svc-indicator--pending">` +
      `<span class="lk-svc-label" style="color:#b45309">` +
      ICONS.info + esc(pendingLabel) +
      `</span>` +
      svcBtn("btn-svc-restart", "#fde68a", ICONS.refresh, "重启服务", "restart") +
      `</div>`;
    container.querySelector("#btn-svc-restart")?.addEventListener("click", () => doFixAction("restart"));
    return;
  }

  // running + ok → 绿 chip + 幽灵「重启服务」按钮(照 LkServiceRestartChip serving)
  if (!readonly) {
    container.innerHTML =
      `<div class="lk-svc-indicator" style="display:inline-flex;align-items:center;gap:0;` +
      `border-radius:10px;border:1px solid ${LIVE_EDGE.serving};background:${LIVE_SOFT.serving};overflow:hidden">` +
      `<span style="display:inline-flex;align-items:center;gap:8px;padding:0 13px;` +
      `height:36px;color:${LIVE_TEXT.serving};font-size:13px;font-weight:600;white-space:nowrap">` +
      `<span class="live-dot is-serving" style="width:8px;height:8px;flex-shrink:0"></span>` +
      `正常服务中` +
      `</span>` +
      `<button type="button" id="btn-svc-restart" ` +
      `style="display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 13px;` +
      `border:none;border-left:1px solid ${LIVE_EDGE.serving};background:#fff;` +
      `color:${BR.text};font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit">` +
      ICONS.refresh + `重启服务` +
      `</button>` +
      `</div>`;
    container.querySelector("#btn-svc-restart")?.addEventListener("click", () => doFixAction("restart"));
    return;
  }

  // 绿 chip(serving 正常态)
  container.innerHTML =
    `<span class="lk-svc-indicator lk-svc-indicator--ok">` +
    `<span class="bridge-dot is-running" style="margin-right:6px"></span>` +
    `正常服务中` +
    `</span>`;
}

/**
 * 统一 fix-action 处理器(busy 态 + toast + 刷新状态)。
 * action: 'restart' | 'start' | 'logs' | 'rescan'
 * @param {string} action
 * @param {HTMLElement|null} [triggerEl]  发起按钮(用于 busy 态);可空。
 */
async function doFixAction(action, triggerEl = null) {
  if (action === "rescan") {
    openOnboardModal();
    return;
  }

  if (action === "logs") {
    await showBridgeLogs();
    return;
  }

  // restart or start
  if (action === "restart" && state.bridge?.running) {
    const confirmed = await confirmDialog({
      title: "重启服务？",
      body: "重启服务会中断当前正在处理的会话，确定继续？",
      confirmText: "确认重启",
      confirmDanger: true,
    });
    if (!confirmed) return;
  }

  // Set busy state on all matching fix buttons
  const busyAction = action;
  document.querySelectorAll(`[data-fix-action="${action}"]`).forEach((el) => {
    el.disabled = true;
    el.style.cursor = "wait";
  });
  // Also disable topbar svc buttons
  const svcBtn = document.getElementById("btn-svc-start") ?? document.getElementById("btn-svc-restart");
  if (svcBtn) {
    svcBtn.disabled = true;
    svcBtn.style.cursor = "wait";
    const busyLabel = action === "start" ? "正在启动…" : "正在重启…";
    svcBtn.innerHTML =
      `<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:lk-spin .7s linear infinite;flex-shrink:0"></span>` +
      busyLabel;
  }

  // Re-render the detail panel in busy state
  if (state.selected) rerenderStatusAction(state.selected, busyAction);

  const res = await api("POST", "/api/bridge/restart");

  // Clear busy state
  document.querySelectorAll(`[data-fix-action="${action}"]`).forEach((el) => {
    el.disabled = false;
    el.style.cursor = "pointer";
  });

  if (!res.ok) {
    const errMsg = res.json?.message ?? res.json?.error ?? res.status;
    toast(`操作失败：${errMsg}`, "error");
    // Refresh status even on failure
    await refreshRuntimeRequirements();
    await refreshBridgeStatus();
    await pollStatus();
    if (state.selected) rerenderStatusAction(state.selected);
    return;
  }

  // ── BL-18:POST 成功后 → 进入 restarting 过渡态(start/restart 都走同一套) ──
  // "启动服务" 和 "重启服务" 都调用同一个后端 restart endpoint。返回成功只
  // 代表 supervisor 已接受请求,不代表 bridge 已连回飞书或 bot 已写心跳。
  stopRestartTicker();
  state.restart = { status: "restarting", startedAt: Date.now(), elapsed: 0 };
  toast(
    action === "start"
      ? "正在启动服务 —— 连上后会自动转回正常,不用重复点"
      : "正在重启服务 —— 好了会自动转回正常,不用重复点",
    "info",
  );
  // 全量刷新三触点(顶栏+名册+hero)
  renderServiceIndicator();
  renderBotList();
  if (state.selected) refreshDetailHero();
  // 启动 1s ticker 刷新已用时显示
  startRestartTicker();

  // Refresh bridge + liveness
  await refreshRuntimeRequirements();
  await refreshBridgeStatus();
  await pollStatus();
  if (state.selected) rerenderStatusAction(state.selected);

  // #9 短轮询:重启/启动后 bridge 要几秒才连上 ws,启动一个 2s×20 次的短轮询
  // (BL-18:最多等 40s;convergence 检测在 renderStatus 里做)
  if (_restartPollHandle) {
    clearInterval(_restartPollHandle);
    _restartPollHandle = null;
  }
  let burstCount = 0;
  const BURST_TOTAL = 20;   // 20 次 × 2s = 40s(覆盖整个超时窗口)
  const BURST_INTERVAL = 2000;
  _restartPollHandle = setInterval(async () => {
    burstCount++;
    await refreshRuntimeRequirements();
    await refreshBridgeStatus();
    await pollStatus();
    if (state.selected) rerenderStatusAction(state.selected);
    // 提前停:restart 机器已离开 restarting 态(收敛或超时),或达到最大次数
    const isDone = state.restart.status !== "restarting";
    if (burstCount >= BURST_TOTAL || isDone) {
      clearInterval(_restartPollHandle);
      _restartPollHandle = null;
    }
  }, BURST_INTERVAL);
}

/**
 * 拉 GET /api/bridge/logs 并弹出简单日志浮层。
 */
async function showBridgeLogs() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.innerHTML = `
    <div class="modal" style="max-width:680px;width:100%">
      <div class="modal-header">最近 Bridge 日志</div>
      <div class="modal-body" id="logs-modal-body" style="padding:0">
        <div style="display:flex;align-items:center;justify-content:center;padding:32px;color:#64748b">
          <span class="spinner"></span>&nbsp; 加载中…
        </div>
      </div>
      <div class="modal-footer" style="padding:14px 20px">
        <div class="modal-btns">
          <button class="btn btn-primary" id="logs-modal-close" type="button">关闭</button>
        </div>
      </div>
    </div>
  `;

  function closeLogsModal() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  }
  function onKey(e) { if (e.key === "Escape") closeLogsModal(); }
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeLogsModal(); });
  backdrop.querySelector("#logs-modal-close")?.addEventListener("click", closeLogsModal);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);

  const res = await api("GET", "/api/bridge/logs");
  const body = document.getElementById("logs-modal-body");
  if (!body) return;

  if (!res.ok) {
    body.innerHTML = `<div style="padding:20px;color:#dc2626">${esc(res.json?.error ?? "加载日志失败")}</div>`;
    return;
  }

  const lines = res.json?.lines ?? [];
  const logPath = res.json?.path ?? "";
  if (lines.length === 0) {
    body.innerHTML = `<div style="padding:20px;color:#64748b">暂无日志${logPath ? " — " + esc(logPath) : ""}</div>`;
    return;
  }

  body.innerHTML =
    `<div style="padding:8px 0 0;font-size:11.5px;color:#64748b;padding:8px 16px 4px">${esc(logPath)}</div>` +
    `<pre style="margin:0;padding:12px 16px 16px;overflow:auto;max-height:420px;` +
    `font-family:ui-monospace,'Cascadia Code',monospace;font-size:12px;line-height:1.6;` +
    `white-space:pre-wrap;word-break:break-all;color:#1e293b;background:#f8fafc">` +
    lines.map((l) => esc(l)).join("\n") +
    `</pre>`;
  // Scroll to bottom (most recent logs)
  const pre = body.querySelector("pre");
  if (pre) pre.scrollTop = pre.scrollHeight;
}

/**
 * Re-render only the LkStatusAction panel inside the current detail panel.
 * Called after bridge state changes or fix actions complete.
 * @param {string} id
 * @param {string|null} [busyAction]
 */
function rerenderStatusAction(id, busyAction = null) {
  const panel = document.querySelector(".detail-panel");
  if (!panel) return;
  const container = panel.querySelector("#detail-status-action");
  if (!container) return;
  const liveKey = effLive(id);
  // BL-18:重启窗口内(restarting/timeout)隐藏「修复/重启」类动作面板
  // (设计稿:「别诱导重复点」;timeout 的排查按钮在 hero buildRestartTimeoutPanel 里)
  const rs = state.restart;
  const hideFixPanel = rs.status === "restarting" || rs.status === "timeout";
  container.outerHTML =
    (liveKey !== "serving" && !hideFixPanel)
      ? `<div id="detail-status-action">${buildStatusActionPanel(liveKey, busyAction, false)}</div>`
      : `<div id="detail-status-action"></div>`;
  // Re-wire action buttons after innerHTML swap
  const newContainer = panel.querySelector("#detail-status-action");
  if (newContainer) wireStatusActionButtons(newContainer);
}

/**
 * Wire click handlers for all .lk-fix-btn elements and .lk-fix-more-toggle in a container.
 */
function wireStatusActionButtons(container) {
  container.querySelectorAll(".lk-fix-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.fixAction;
      if (action) doFixAction(action, btn);
    });
  });
  const moreToggle = container.querySelector(".lk-fix-more-toggle");
  if (moreToggle) {
    moreToggle.addEventListener("click", () => {
      // Toggle "more" section by re-rendering with toggled state
      const actionPanel = moreToggle.closest(".lk-status-action");
      if (!actionPanel) return;
      const liveKey = actionPanel.dataset.live;
      const outerContainer = actionPanel.closest("#detail-status-action");
      // Determine current open state from chevron rotation
      const chev = moreToggle.querySelector("svg");
      const isOpen = chev ? chev.style.transform === "rotate(90deg)" : false;
      const newHtml = buildStatusActionPanel(liveKey, null, !isOpen);
      if (outerContainer) {
        outerContainer.innerHTML = newHtml;
        wireStatusActionButtons(outerContainer);
      }
    });
  }
}

/**
 * 执行 bridge 重启/启动(原始版,保留兼容老顶栏按钮引用)。
 * running → 先用 confirmDialog 确认；not running → 直接执行。
 * @param {HTMLElement|null} [triggerBtn]  触发按钮(用于 loading 态);null 时不显示 loading。
 * @param {string} [successMsg]  成功后的 toast 文案(默认自动选)。
 */
async function doBridgeRestart(triggerBtn = null, successMsg = null) {
  if (state.bridge?.running) {
    const confirmed = await confirmDialog({
      title: "重启服务？",
      body: "重启服务会中断当前正在处理的会话，确定继续？",
      confirmText: "确认重启",
      confirmDanger: true,
    });
    if (!confirmed) return;
  }

  const restore = triggerBtn ? btnLoading(triggerBtn, "处理中…") : () => {};
  const res = await api("POST", "/api/bridge/restart");
  restore();

  if (res.ok) {
    const msg = successMsg ?? (res.json?.status?.running ? "服务已启动" : "操作完成");
    toast(msg, "ok");
  } else {
    const errMsg = res.json?.message ?? res.json?.error ?? res.status;
    toast(`操作失败：${errMsg}`, "error");
  }

  // 刷新状态(成功/失败都要更新显示)
  await refreshBridgeStatus();
}

// ---------------------------------------------------------------------------
// 行为:选中 bot
// ---------------------------------------------------------------------------

function selectBot(id) {
  if (id === state.selected) return;
  // 切走时若有未保存改动 → 轻提醒(不强拦),随后照常切换
  if (state.selected && (state.formDirty || state.memoryDirty)) {
    toast("上一个助手有未保存改动（已切走，未自动保存）", "warn");
  }
  state.selected = id;
  renderBotList();
  renderBotDetail(id);
}

// ---------------------------------------------------------------------------
// 行为:拉 bot 列表
// ---------------------------------------------------------------------------

async function loadBots(opts = {}) {
  if (!opts.silent) renderBotListLoading();

  const res = await api("GET", "/api/bots");
  if (!res.ok) {
    if (!opts.silent) toast(`加载助手列表失败：${res.json?.error ?? res.status}`, "error");
    state.bots = [];
  } else {
    state.bots = res.json?.bots ?? [];
    for (const b of state.bots) {
      if (b && typeof b.id === "string") state.avatars[b.id] = b.avatar ?? null;
    }
  }
  renderBotList();
}

// ---------------------------------------------------------------------------
// 行为:添加新助手(页面内扫码开通)
//
// ---------------------------------------------------------------------------
// Onboarding · 扫码优先(Block A — 设计稿 onboardingScan.jsx + atelierV2.jsx)
//
// 状态流:
//   openOnboardModal
//     → POST /api/onboard/start(无需先填表单)
//     → 轮询 GET /api/onboard/status?session=
//         starting/awaiting-scan/polling → 扫码态(qrSvg + 倒计时)
//         awaiting-name  → 第 2 步填资料(prefill.appId/openId/avatar/suggestedName)
//         done           → toast「已添加「name」」+ 刷新名册 + 关 modal
//         error/cancelled → 错误态
//   关闭/取消 → POST /api/onboard/cancel(no-orphan:后端处理孤儿)
//              → 若 cancel 返回 done(孤儿用默认名建成) → toast「已用默认名创建」+ 刷新
// ---------------------------------------------------------------------------

/** 当前 onboarding 会话(单例;modal 一次只开一个)。 */
const onboard = {
  /** @type {string|null} */
  sessionId: null,
  /** @type {ReturnType<typeof setTimeout>|null} */
  timer: null,
  /** @type {ReturnType<typeof setInterval>|null} 倒计时 ticker */
  countdownTimer: null,
  /** @type {number} 二维码剩余秒数 */
  secsLeft: 0,
  /** 高级折叠是否展开 */
  advOpen: false,
};

const ONBOARD_POLL_MS = 1500;

/** 清掉所有定时器(幂等)。 */
function stopOnboardPoll() {
  if (onboard.timer) { clearTimeout(onboard.timer); onboard.timer = null; }
  if (onboard.countdownTimer) { clearInterval(onboard.countdownTimer); onboard.countdownTimer = null; }
}

/**
 * 打开「添加新助手」modal → 直接 POST /api/onboard/start → 进扫码态。
 * 不再先显示表单。
 */
async function openOnboardModal() {
  stopOnboardPoll();
  onboard.sessionId = null;
  onboard.secsLeft = 0;
  onboard.advOpen = false;

  const backdrop = document.getElementById("onboard-backdrop");
  if (backdrop) backdrop.hidden = false;

  // 先渲「正在启动…」占位
  renderOnboardStarting();

  const res = await api("POST", "/api/onboard/start");

  if (!res.ok) {
    const msg = res.json?.error ?? `HTTP ${res.status}`;
    renderOnboardError(msg);
    return;
  }

  onboard.sessionId = res.json?.sessionId ?? null;
  if (!onboard.sessionId) {
    renderOnboardError("后端没返回会话 id，请重试。");
    return;
  }

  // 开始轮询
  pollOnboardOnce();
}

/**
 * 关闭 modal:若有在飞会话 → POST cancel(no-orphan)→ 识别 done+botId 场景。
 * done 之后调用时 sessionId 已清空,不会误发 cancel。
 */
async function closeOnboardModal() {
  stopOnboardPoll();
  const sid = onboard.sessionId;
  onboard.sessionId = null;

  if (sid) {
    // no-orphan:后端若已 awaiting-name,cancel 会用默认名建好(返回 done+botId)
    const res = await api("POST", "/api/onboard/cancel", { session: sid });
    // cancel 返回 { ok, botId?, defaultNamed? }:botId 存在 = 已扫到、no-orphan
    // 用默认名建好了 → 提示 + 刷新名册。
    if (res.ok && res.json?.botId) {
      await loadBots({ silent: true });
      toast("已用默认名创建，可在详情页改名，或用「删除助手」移除", "warn");
    }
  }

  const backdrop = document.getElementById("onboard-backdrop");
  if (backdrop) backdrop.hidden = true;
}

/** 渲染「正在启动…」过渡占位(POST /api/onboard/start 飞行期间)。 */
function renderOnboardStarting() {
  const modal = document.getElementById("onboard-modal");
  if (!modal) return;
  modal.innerHTML =
    ob2Head("添加新助手", "正在准备二维码，请稍候…") +
    `<div style="display:flex;flex-direction:column;align-items:center;padding:40px 26px;">` +
    `<span class="ob2-spinner"></span>` +
    `</div>` +
    `<div class="ob2-cancel-row">` +
    `<button class="btn" id="ob2-cancel-start" type="button">取消</button>` +
    `</div>`;
  modal.querySelector("#ob2-cancel-start")?.addEventListener("click", () => closeOnboardModal());
}

// ── 帮助函数 ─────────────────────────────────────────────────────────────────

/** 生成 ob2 弹窗头 HTML。 */
function ob2Head(title, sub) {
  const closeSvg = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  return (
    `<div class="ob2-head">` +
    `<div class="ob2-head-row">` +
    `<h3 class="ob2-title" id="onboard-modal-title">${esc(title)}</h3>` +
    `<button class="ob2-close-btn" id="ob2-close" aria-label="关闭">${closeSvg}</button>` +
    `</div>` +
    (sub ? `<p class="ob2-subtitle">${esc(sub)}</p>` : "") +
    `</div>`
  );
}

/** 格式化剩余秒数为 M:SS。 */
function ob2FmtSecs(s) {
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

/** 构建 ob2 头像 HTML(有 url → img;无 → 首字母彩底)。 */
function ob2AvatarHTML(name, avatarUrl) {
  const initial = esc(avatarInitial(name, name));
  const color = AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];
  const inner = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`+
      `<span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;background:${color}">${initial}</span>`
    : `<span style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;background:${color}">${initial}</span>`;
  return `<div class="ob2-avatar">${inner}</div>`;
}

// ── 第 1 步:扫码 ──────────────────────────────────────────────────────────────

/**
 * 渲染扫码态。
 * @param {{status:string, qrSvg?:string, url?:string, expireIn?:number}|null} view
 * @param {boolean} scanned  true = 已扫到(显示过渡 spinner)
 */
function renderOnboardScan(view, scanned = false) {
  const modal = document.getElementById("onboard-modal");
  if (!modal) return;

  // 更新倒计时秒数
  if (!scanned && typeof view?.expireIn === "number") {
    // 只在首次(secsLeft 还没起算)初始化 —— 否则每次 poll(~1.5s)都会把它重置回
    // expireIn,本地 ticker 的递减就被反复盖掉,倒计时每 1.5s 跳回去一次。
    if (onboard.secsLeft <= 0) onboard.secsLeft = view.expireIn;
    // 启动本地倒计时 ticker(每秒减一,避免纯靠轮询)
    if (!onboard.countdownTimer) {
      onboard.countdownTimer = setInterval(() => {
        onboard.secsLeft = Math.max(0, onboard.secsLeft - 1);
        const el = document.getElementById("ob2-expire-mono");
        if (el) el.textContent = ob2FmtSecs(onboard.secsLeft);
      }, 1000);
    }
  }

  // QR 卡内容
  let qrInner;
  if (scanned) {
    // 已扫到过渡
    qrInner =
      `<div class="ob2-scanned-overlay">` +
      `<span class="ob2-spinner"></span>` +
      `<span class="ob2-scanned-text">已扫到，正在创建飞书应用…</span>` +
      `</div>`;
  } else if (view?.qrSvg) {
    // 正常展示 QR + 扫描线
    qrInner =
      `<div class="ob2-qr-svg-btn" aria-label="飞书扫码二维码" role="img">${view.qrSvg}</div>` +
      `<span class="ob2-scan-line" aria-hidden="true"></span>`;
  } else {
    // 还没拿到 QR(starting 过渡)
    qrInner = `<span class="ob2-spinner" style="width:28px;height:28px"></span>`;
  }

  const urlFallback = !scanned && view?.url
    ? `<p class="onboard-url">扫不出来？<a href="${esc(view.url)}" target="_blank" rel="noopener">点这里在飞书里打开</a></p>`
    : "";

  const expireStr = ob2FmtSecs(onboard.secsLeft > 0 ? onboard.secsLeft : (view?.expireIn ?? 0));

  // 状态文案
  const waitText = (view?.status === "polling") ? "等待手机飞书扫码确认…" : "等待手机飞书扫码确认…";

  modal.innerHTML =
    ob2Head("添加新助手", "用手机飞书扫一扫，创建一个新助手。扫完资料就自动填好。") +
    `<div class="ob2-qr-section">` +
    `<div class="ob2-qr-card">${qrInner}</div>` +
    (!scanned ? (
      `<div class="ob2-status-pill">` +
      `<span class="ob2-status-dot"></span>` +
      esc(waitText) +
      `</div>` +
      (onboard.secsLeft > 0 || (view?.expireIn ?? 0) > 0
        ? `<div class="ob2-expire">二维码 <span class="ob2-expire-mono" id="ob2-expire-mono">${esc(expireStr)}</span> 内有效</div>`
        : `<div style="height:24px"></div>`) +
      urlFallback
    ) : `<div style="height:62px"></div>`) +
    `</div>` +
    `<div class="ob2-secret-note">` +
    ICONS.lock +
    `<span>密钥只存在本机 <code>~/.larkway/.env</code>（0600），管理面永不显示真值。</span>` +
    `</div>` +
    `<div class="ob2-cancel-row">` +
    `<button class="btn" id="ob2-cancel-scan" type="button"${scanned ? " disabled" : ""} style="${scanned ? "opacity:.6;cursor:not-allowed" : ""}">取消</button>` +
    `</div>`;

  modal.querySelector("#ob2-close")?.addEventListener("click", () => {
    if (!scanned) closeOnboardModal();
  });
  modal.querySelector("#ob2-cancel-scan")?.addEventListener("click", () => {
    if (!scanned) closeOnboardModal();
  });
}

// ── 第 2 步:填资料(awaiting-name) ──────────────────────────────────────────

/**
 * 渲染「给新助手起个名」第 2 步 — 使用三层 AC 面板(create 模式)。
 * @param {{appId?:string, openId?:string, avatar?:string, suggestedName?:string, botId?:string}} prefill
 * @param {string|null} sessionId
 */
function renderOnboardNameForm(prefill, sessionId) {
  stopOnboardPoll(); // 不再轮询,等用户提交
  const modal = document.getElementById("onboard-modal");
  if (!modal) return;

  const appId = prefill?.appId ?? "";
  const openId = prefill?.openId ?? "";
  const suggestedName = prefill?.suggestedName ?? "";

  // 构造一个最小 bot 对象供 buildAgentConfigHTML create 模式使用
  const draftBot = {
    id: prefill?.botId ?? "",
    name: suggestedName,
    description: "",
    app_id: appId,
    bot_open_id: openId,
    gitlab_token_env: "",
    repos: [],
    chats: [],
    turn_taking_limit: 10,
  };

  const acHTML = buildAgentConfigHTML(draftBot, "", "create", { appId, openId });

  // 触点④(扫码创建流第 2 步):底座选择块
  const backendSlotHTML =
    `<div class="lk-bk-card" id="ob2-bk-card" style="margin:0 0 18px">` +
    `<h4 class="lk-bk-card-title" style="font-size:14.5px">${ICONS.box} 用哪个底座` +
    `<span style="font-weight:400;color:var(--faint);font-size:13px;margin-left:4px">默认 Codex</span></h4>` +
    lkBackendSelectHTML(LK_BACKEND_DEFAULT, "ob2-bk") +
    `</div>`;

  modal.innerHTML =
    ob2Head("配置新助手", "扫码拿到的资料已自动填好 —— 填上职能、配好权限就能用。") +
    `<div class="ob2-ac-scroll">` +
    backendSlotHTML +
    acHTML +
    `</div>` +
    `<div class="ob2-cancel-row">` +
    `<button class="btn" id="ob2-cancel-form" type="button">取消</button>` +
    `</div>`;

  // 接线 AC 面板交互(折叠/开关/仓库)
  wireAgentConfigEvents(modal, draftBot.id, draftBot);

  // 接线底座选择(pending 存在 modal._ob2Backend 上)
  modal._ob2Backend = LK_BACKEND_DEFAULT;
  const bkCard = modal.querySelector("#ob2-bk-card");
  if (bkCard) {
    wireLkBackendSelect(bkCard, (newId) => { modal._ob2Backend = newId; });
  }

  // 渲染头像(create 时用 prefill.avatar 或首字母;状态 unknown)
  acRenderAvatar(modal, draftBot.id || "new", suggestedName || "助手", prefill?.avatar ?? null, "unknown");

  // 关闭
  modal.querySelector("#ob2-close")?.addEventListener("click", () => closeOnboardModal());
  modal.querySelector("#ob2-cancel-form")?.addEventListener("click", () => closeOnboardModal());

  // 「添加到名册」按钮(在 ac-create-btn 或 ac-panel 上的 _acSubmit 回调)
  modal._acSubmit = () => submitOnboardName(prefill, sessionId, modal);
  const createBtn = modal.querySelector("#ac-create-btn");
  if (createBtn) createBtn.addEventListener("click", () => submitOnboardName(prefill, sessionId, modal));

  // 聚焦名字输入
  setTimeout(() => modal.querySelector("#ac-name")?.focus(), 50);
}

/** 提交第 2 步:从 AC 面板读值 → POST /api/onboard/finalize → done。 */
async function submitOnboardName(prefill, sessionId, modal) {
  if (!modal) modal = document.getElementById("onboard-modal");
  const sid = sessionId ?? onboard.sessionId;
  if (!validateCodeAccessConfig(modal)) return;

  // 从 AC 面板读取表单值
  const vals = readAgentConfigValues(modal);
  const name = (vals.name ?? "").trim();
  if (!name) {
    modal?.querySelector("#ac-name")?.focus();
    toast("请先填助手名字。", "warn");
    return;
  }

  const botId = prefill?.botId ?? "";

  const createBtn = modal?.querySelector("#ac-create-btn");
  const restore = btnLoading(createBtn, "创建中…");

  // 序列化:符合后端 onboard/finalize 契约
  const payload = { session: sid, name };
  if (vals.description) payload.description = vals.description;
  // chats 取第一条(onboard finalize 接 chatId)
  const chatId = Array.isArray(vals.chats) && vals.chats.length > 0 ? vals.chats[0] : "";
  if (chatId) payload.chatId = chatId;
  if (botId) payload.botId = botId;
  // 扩展字段:gitlab + repos + turn_limit(后端支持就传,不支持忽略)
  // ① 新保存契约:发 gitlab_token_value(真值),不再发变量名
  if (vals.gitlab_token_value !== undefined && vals.gitlab_token_value !== "") payload.gitlab_token_value = vals.gitlab_token_value;
  if (vals.repos && vals.repos.length > 0) payload.repos = vals.repos;
  if (vals.turn_taking_limit) payload.turn_taking_limit = vals.turn_taking_limit;
  // 底座(来自扫码流第 2 步的 backend 选择;无条件发,后端已能处理默认值)
  payload.backend = modal?._ob2Backend || LK_BACKEND_DEFAULT;

  const res = await api("POST", "/api/onboard/finalize", payload);
  restore();

  if (!res.ok || res.json?.status === "error") {
    const msg = res.json?.error ?? `HTTP ${res.status}`;
    toast(`创建失败：${msg}`, "error");
    return;
  }

  // done — 如有 memory 内容,异步写入(不阻断)
  const memContent = vals._memContent ?? "";
  const newId = res.json?.botId ?? null;
  if (newId && memContent) {
    void api("PUT", `/api/memory/${encodeURIComponent(newId)}`, { content: memContent });
  }

  onboard.sessionId = null;
  await loadBots({ silent: true });
  const displayName = (newId && state.bots.find((b) => b.id === newId)?.name) || name || "新助手";

  const backdrop = document.getElementById("onboard-backdrop");
  if (backdrop) backdrop.hidden = true;
  toast(`已添加「${displayName}」`, "ok");

  if (newId && state.bots.find((b) => b.id === newId)) selectBot(newId);
}

/** 轮询一次 + 安排下一次(链式 setTimeout)。 */
async function pollOnboardOnce() {
  const sid = onboard.sessionId;
  if (!sid) return;

  const res = await api("GET", `/api/onboard/status?session=${encodeURIComponent(sid)}`);

  if (onboard.sessionId !== sid) return; // 用户已关闭

  if (!res.ok) {
    const msg = res.status === 404
      ? "二维码已过期或会话丢失了，请重试。"
      : res.json?.error ?? `HTTP ${res.status}`;
    renderOnboardError(msg);
    return;
  }

  const view = res.json ?? {};
  const status = view.status;

  if (status === "done") {
    onOnboardDone(view);
    return;
  }
  if (status === "error") {
    renderOnboardError(view.error ?? "创建失败，请重试。");
    return;
  }
  if (status === "cancelled") {
    closeOnboardModal();
    return;
  }
  if (status === "awaiting-name") {
    // 第 2 步:扫码完成,用 prefill 渲填资料表单
    stopOnboardPoll();
    renderOnboardNameForm(view.prefill ?? {}, sid);
    return;
  }

  // starting / awaiting-scan / polling → 渲扫码态
  // 'polling' 实际上是仍在等扫码确认(registerApp SDK),不是「已扫到」
  const scanned = false; // 后端没有独立的「已扫到但未建好」状态
  renderOnboardScan(view, scanned);
  onboard.timer = setTimeout(pollOnboardOnce, ONBOARD_POLL_MS);
}

/**
 * done:不走成功 modal,直接 toast + 关 + 刷新名册。
 * (「完成 = 直接 toast」,上线提示交给顶栏服务指示器)
 */
async function onOnboardDone(view) {
  stopOnboardPoll();
  const newId = view.botId ?? null;
  onboard.sessionId = null;

  await loadBots({ silent: true });
  const displayName = (newId && state.bots.find((b) => b.id === newId)?.name) || newId || "新助手";

  const backdrop = document.getElementById("onboard-backdrop");
  if (backdrop) backdrop.hidden = true;

  toast(`已添加「${displayName}」`, "ok");
  if (newId && state.bots.find((b) => b.id === newId)) selectBot(newId);
}

/** error 态:错误 + 「重试」。 */
function renderOnboardError(msg) {
  stopOnboardPoll();
  const sid = onboard.sessionId;
  onboard.sessionId = null;
  if (sid) void api("POST", "/api/onboard/cancel", { session: sid });

  const modal = document.getElementById("onboard-modal");
  if (!modal) return;

  modal.innerHTML =
    ob2Head("创建没成功", "") +
    `<div style="padding:20px 26px">` +
    `<div class="error-block">${ICONS.x}<div></div></div>` +
    `<p class="onboard-intro" style="margin-top:12px">可以再试一次 —— 重试会重新生成一个二维码。</p>` +
    `</div>` +
    `<div class="modal-footer"><div class="modal-btns">` +
    `<button class="btn" id="ob2-err-close" type="button">关闭</button>` +
    `<button class="btn btn-primary" id="ob2-err-retry" type="button">重试</button>` +
    `</div></div>`;

  modal.querySelector(".error-block div")?.appendChild(
    Object.assign(document.createTextNode(msg), {})
  );
  // 用 textContent 安全设置错误文案
  const errDiv = modal.querySelector(".error-block div");
  if (errDiv) errDiv.textContent = msg;

  modal.querySelector("#ob2-close")?.addEventListener("click", () => closeOnboardModal());
  modal.querySelector("#ob2-err-close")?.addEventListener("click", () => closeOnboardModal());
  modal.querySelector("#ob2-err-retry")?.addEventListener("click", () => openOnboardModal());
}

// ---------------------------------------------------------------------------
// 接线 + 启动
// ---------------------------------------------------------------------------

function wireEvents() {
  // 刷新列表
  document.getElementById("btn-refresh")?.addEventListener("click", () => loadBots());

  // 添加新助手:页面内扫码开通(POST /api/onboard/start → 轮询 → 落盘)
  document.getElementById("btn-add")?.addEventListener("click", () => {
    openOnboardModal();
  });

  // 同步预览 modal 背景点击关闭
  document.getElementById("modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
    }
  });

  // 添加新助手 modal 背景点击 → 走取消(中止后端 + 清定时器)
  document.getElementById("onboard-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      closeOnboardModal();
    }
  });

  // Bridge 重启/启动按钮
  document.getElementById("btn-bridge-restart")?.addEventListener("click", async (e) => {
    await doBridgeRestart(e.currentTarget);
  });

  // Esc 关闭 modal（同步预览直接关；添加新助手走取消清理）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const ob = document.getElementById("onboard-backdrop");
    if (ob && !ob.hidden) {
      closeOnboardModal();
      return;
    }
    const bd = document.getElementById("modal-backdrop");
    if (bd && !bd.hidden) bd.hidden = true;
  });
}

async function boot() {
  if (!TOKEN) {
    toast("缺少访问 token。请用终端打印的带 ?token= 的链接打开。", "error");
  }

  wireEvents();

  // 拉初始上下文状态(version + hostname)
  const ctxRes = await api("GET", "/api/context");
  if (ctxRes.ok) {
    state.mode = "local";
    const ver = ctxRes.json?.version;
    const verEl = document.getElementById("brand-ver");
    if (verEl && ver) verEl.textContent = "v" + ver;
    // 填充本机 hostname badge(浏览器侧地址,本机即 127.0.0.1)
    const hostEl = document.getElementById("ctx-host");
    const host = location.hostname || "";
    if (hostEl && host) hostEl.textContent = " · " + host;
  }

  renderContextSwitch();

  // 拉 backend 注册表(驱动底座选择就绪态;失败静默)
  void loadBackends();

  // 拉 bot 列表(先于首次状态轮询,确保左侧条目存在好让圆点落上去)
  await loadBots();
  await refreshRuntimeRequirements();

  // 拉 bridge 服务状态并渲染顶栏指示
  await refreshBridgeStatus();

  // 首次拉状态 + 每 15s 轮询(实时在线状态可视化)
  await pollStatus();
  setInterval(pollStatus, 15000);
  setInterval(refreshRuntimeRequirements, 30000);
}

/**
 * 拉 GET /api/status 并刷新状态 UI(顶栏 pill + 左侧圆点 + 详情横幅)。
 * 失败/非 2xx → renderStatus(null) 降级成「状态未知」灰点,绝不抛错。
 */
async function pollStatus() {
  const res = await api("GET", "/api/status");
  renderStatus(res.ok ? res.json : null);
}

async function refreshRuntimeRequirements() {
  const res = await api("GET", "/api/runtime/requirements");
  state.requirements = res.ok ? res.json : null;
  renderServiceIndicator();
  if (state.selected) rerenderStatusAction(state.selected);
}

boot();
