/**
 * src/web/public/app.js
 *
 * Larkway 管理面 — 原生 ES module SPA，无框架、无构建步骤。
 *
 * Token 解析:server 注入 window.__LARKWAY_TOKEN__ > ?token= 回退。
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
  // ── 公司中心库专用(centralData.jsx CC_ICON + LK_ICON 复刻)──
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
  const injected = window.__LARKWAY_TOKEN__;
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
              我明白删除后它会停止服务，且不会自动同步到公司中心库。
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

// ---------------------------------------------------------------------------
// uploadConfirmDialog — 正式上传(晋升 push)二次确认弹窗
//   复刻 centralPromote.jsx LkUploadConfirm:红 upload 徽章 + 标题 + 三条「会发生
//   什么」+ ack 勾选 gate + 红「确认上传」。不可逆外发,样式走 destructive 红。
// ---------------------------------------------------------------------------

/**
 * 弹出「正式上传到公司中心库」二次确认弹窗,返回 Promise<boolean>。
 * 勾选「我明白这是不可逆外发」前确认按钮 disabled。点确认 → true;取消/Esc/点背景 → false。
 *
 * @param {{name:string}} bot   要上传的助手(显示名)
 * @param {{name?:string,branch?:string}|null} repo 中心库信息(展示推到哪)
 * @returns {Promise<boolean>}
 */
function uploadConfirmDialog(bot, repo) {
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

    const botName = esc(bot?.name || "这个助手");
    const repoName = esc(repo?.name || "公司中心库");
    const branch = esc(repo?.branch || "main");

    // 三条「会发生什么」(upload / users / lock)
    const bullets = [
      [ICONS.upload, `推送到 ${repoName}@${branch}`],
      [ICONS.users, "团队任何人都能同步、复用这一份"],
      [ICONS.lock, "只上传配置 —— 密钥、本机 .env 永远不会被推上去"],
    ];

    const uploadBadge = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:19px;height:19px"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
    const uploadIcon15 = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px;flex-shrink:0"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");

    backdrop.innerHTML = `
      <div class="modal" style="max-width:520px">
        <div class="modal-body" style="padding:24px 26px 0">
          <div style="display:flex;gap:14px;align-items:flex-start">
            <div style="flex-shrink:0;width:40px;height:40px;border-radius:11px;background:var(--destructive-weak);border:1px solid #fecaca;color:var(--destructive-strong);display:flex;align-items:center;justify-content:center">
              ${uploadBadge}
            </div>
            <div style="min-width:0">
              <div style="font-size:18px;font-weight:700;color:var(--text);line-height:1.3">正式上传「${botName}」？</div>
              <p style="margin:6px 0 0;font-size:13.5px;color:var(--muted);line-height:1.58">
                这会把它推送到团队仓库 <b style="color:var(--text);font-family:ui-monospace,monospace">${repoName}</b>，<b style="color:var(--destructive-text)">所有人同步都能拉到</b>。推上去之后<b style="color:var(--destructive-text)">没法自动撤回</b>（要撤得让工程师改仓库）。
              </p>
            </div>
          </div>
          <ul style="list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:8px">
            ${bullets
              .map(
                ([ic, tx]) =>
                  `<li style="display:flex;align-items:center;gap:9px;font-size:13px;color:#334155"><span style="color:var(--faint);flex-shrink:0;display:inline-flex">${ic}</span>${esc(tx)}</li>`,
              )
              .join("")}
          </ul>
          <label style="display:flex;align-items:flex-start;gap:9px;margin:16px 0 0;padding:12px 14px;border-radius:10px;background:var(--bg);border:1px solid var(--border);cursor:pointer">
            <input type="checkbox" id="up-ack-chk" style="margin-top:2px;width:16px;height:16px;accent-color:var(--destructive-strong);flex-shrink:0;cursor:pointer" />
            <span style="font-size:13px;color:var(--text);line-height:1.5">我明白这是不可逆的外发，全团队同步都会拉到这一份。</span>
          </label>
        </div>
        <div class="modal-footer" style="padding:18px 26px 22px">
          <div class="modal-btns">
            <button class="btn" id="up-cancel" type="button">取消</button>
            <button class="btn btn-del-confirm" id="up-confirm" type="button" disabled>
              ${uploadIcon15} 确认上传
            </button>
          </div>
        </div>
      </div>
    `;

    const ackChk = backdrop.querySelector("#up-ack-chk");
    const confirmBtn = backdrop.querySelector("#up-confirm");
    ackChk.addEventListener("change", () => {
      confirmBtn.disabled = !ackChk.checked;
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(false);
    });
    backdrop.querySelector("#up-cancel").addEventListener("click", () => done(false));
    confirmBtn.addEventListener("click", () => {
      if (!ackChk.checked) return;
      done(true);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(backdrop);
    backdrop.querySelector("#up-cancel").focus();
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
  /** @type {"local"|"central"} */
  mode: "local",
  /** @type {Array<{id:string,name:string,description:string,avatar:string|null}>} */
  bots: [],
  /** @type {string|null} */
  selected: null,
  /** 中心上下文是否可用 */
  centralAvailable: false,
  /** Bridge 进程状态(来自 GET /api/bridge;null = 未知)。 */
  bridge: /** @type {{running:boolean,pid:number|null,platform:string,mode:string}|null} */ (null),
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

  // ── 公司中心库(connect / roster / sync)──────────────────────────────
  /** 是否已连接中心库(config.json.centralConfig 已设)。来自 GET /api/central/status。 */
  centralConnected: false,
  /** 已连接时的仓库信息 { name, url, branch, path }。 */
  centralRepo: /** @type {{name:string,url:string,branch:string,path:string}|null} */ (null),
  /** 最近同步时间(ms epoch,来自 status.lastSyncMs);null = 未知。 */
  centralLastSyncMs: /** @type {number|null} */ (null),
  /** 中心库共享助手数(来自 status.sharedCount)。 */
  centralSharedCount: 0,
  /** 中心库只读名册 [{id,name,desc,by,updated,commit,chats,repos}]。来自 GET /api/central/bots。 */
  centralBots: /** @type {Array<{id:string,name:string,desc:string,by:string,updated:string,commit:string,chats:number,repos:number,avatar:string|null}>} */ ([]),
  /** 来源条同步态:'fresh'(已是最新) | 'updates'(有更新可拉) | 'syncing' | 'unknown'。 */
  centralSyncState: /** @type {"fresh"|"updates"|"syncing"|"unknown"} */ ("unknown"),
  /** 可更新项数(added+updated+removed),驱动来源条「N 项可更新」pill。 */
  centralUpdateCount: 0,
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
 * @param {boolean} [readOnly]  只读态(中心库展示)
 * @param {string} [containerId] 容器 id(用于 change 事件冒泡)
 */
function lkBackendSelectHTML(value, readOnly = false, containerId = "") {
  if (readOnly) {
    const b = lkBackend(value);
    return (
      `<div class="lk-bk-readonly">` +
      lkBackendMonoHTML(value, "lg") +
      `<div style="min-width:0;flex:1">` +
      `<div class="lk-bk-readonly-name">${esc(b.name)}</div>` +
      `<div class="lk-bk-readonly-vendor">${esc(b.vendor)}</div>` +
      `</div>` +
      `<span class="lk-bk-readonly-lock">${ICONS.lock} 只读</span>` +
      `</div>`
    );
  }

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
    esc(fx.heading) + `</div>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#334155">${esc(fx.say)}</p>` +
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
  for (const btn of document.querySelectorAll(".ctx-btn")) {
    btn.classList.toggle("is-active", btn.dataset.mode === state.mode);
  }
  // 「公司中心库」段永远可点 —— 未连接时进去看的是连接引导卡(这正是要进的页)。
  const central = document.getElementById("ctx-central");
  if (central) central.disabled = false;

  // 侧栏底部按钮:本机显「添加新助手」;中心(只读)隐藏添加,改在 renderBotList 注入
  // 「去本机添加/晋升」。旧的 #btn-sync(从公司中心库拉取)由来源条的同步入口替代,常隐藏。
  const btnAdd = document.getElementById("btn-add");
  if (btnAdd) btnAdd.style.display = state.mode === "central" ? "none" : "";
  const btnSync = document.getElementById("btn-sync");
  if (btnSync) btnSync.style.display = "none";

  // 中心库(只读)= 无「添加」按钮,改放「去本机添加/晋升」引导(CcRoster 底部)。
  const actions = document.getElementById("sidebar-actions");
  if (actions) {
    let goLocal = document.getElementById("cc-go-local-block");
    if (state.mode === "central") {
      if (!goLocal) {
        goLocal = document.createElement("button");
        goLocal.id = "cc-go-local-block";
        goLocal.type = "button";
        goLocal.className = "cc-go-local-block";
        goLocal.innerHTML = `${ICONS.plus} 去「本机」添加 / 晋升`;
        goLocal.addEventListener("click", () => switchContext("local"));
        actions.appendChild(goLocal);
      }
      goLocal.style.display = "";
    } else if (goLocal) {
      goLocal.style.display = "none";
    }
  }
}

// ---------------------------------------------------------------------------
// 渲染:公司中心库来源条(LkSyncBar 复刻)
// ---------------------------------------------------------------------------

/** 把「距上次同步的毫秒数」换算成「N 分钟前 / 刚刚 / N 小时前」。 */
function formatSyncAgo(lastSyncMs) {
  if (typeof lastSyncMs !== "number" || !isFinite(lastSyncMs)) return null;
  const diff = Date.now() - lastSyncMs;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * 渲染顶部来源条:来自 <仓库>@<分支> · 最近同步 N 分钟前 + 同步入口。
 * 仅在 central 已连接态显示;其余态隐藏。
 * 状态:'fresh'(已是最新) / 'updates'(有更新可拉) / 'syncing' / 'unknown'(检查更新)。
 */
function renderCentralSourceBar() {
  const bar = document.getElementById("central-source-bar");
  if (!bar) return;

  if (state.mode !== "central" || !state.centralConnected || !state.centralRepo) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }

  const r = state.centralRepo;
  const syncState = state.centralSyncState;
  const ago = syncState === "syncing" ? "…" : (formatSyncAgo(state.centralLastSyncMs) ?? "未知");

  // 右侧状态指示(updates pill / fresh 平静态)
  let statusBadge = "";
  if (syncState === "updates") {
    statusBadge = `<span class="csb-updates">${state.centralUpdateCount} 项可更新</span>`;
  } else if (syncState === "fresh") {
    statusBadge = `<span class="csb-fresh">${ICONS.check} 已是最新</span>`;
  }

  const hasUpdates = syncState === "updates";
  const syncing = syncState === "syncing";
  const btnLabel = syncing ? "正在同步…" : hasUpdates ? "拉取最新" : "检查更新";
  const btnIcon = syncing
    ? `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>`
    : ICONS.pull;

  bar.innerHTML =
    `<span class="csb-from">` +
    ICONS.repo +
    `<span>来自 <b class="csb-repo">${esc(r.name)}</b></span>` +
    `<span class="csb-branch">${ICONS.branch}${esc(r.branch)}</span>` +
    `<span class="csb-sep">·</span>` +
    `<span class="csb-synced">最近同步 ${esc(ago)}</span>` +
    `</span>` +
    `<span class="csb-right">` +
    statusBadge +
    `<button type="button" id="btn-central-sync" class="csb-sync-btn${hasUpdates ? " has-updates" : ""}"${syncing ? " disabled" : ""}>` +
    btnIcon + esc(btnLabel) +
    `</button>` +
    // 已连接设置块(改配置 / 断开)—— LkConnectedBlock 复刻,放在同步入口右侧
    `<button type="button" id="btn-central-edit" class="csb-sync-btn" title="改中心库配置">${ICONS.gear} 改配置</button>` +
    `<button type="button" id="btn-central-disconnect" class="csb-sync-btn csb-disconnect-btn" title="断开公司中心库">断开</button>` +
    `</span>`;
  bar.hidden = false;

  bar.querySelector("#btn-central-sync")?.addEventListener("click", () => doCentralSync());
  bar.querySelector("#btn-central-edit")?.addEventListener("click", () => openConnectFlow(true));
  bar.querySelector("#btn-central-disconnect")?.addEventListener("click", () => doCentralDisconnect());
}

// ---------------------------------------------------------------------------
// 公司中心库:连接状态 + 名册拉取
// ---------------------------------------------------------------------------

/**
 * 拉 GET /api/central/status,写入 state.central*。
 * connected = config.json.centralConfig 已设;best-effort 回填 repo/head/sharedCount/lastSyncMs。
 * 失败时降级:connected 保持已知值(不抛),让 UI 仍能渲染连接引导。
 */
async function loadCentralStatus() {
  const res = await api("GET", "/api/central/status");
  if (!res.ok || !res.json) {
    state.centralConnected = false;
    state.centralRepo = null;
    return;
  }
  const j = res.json;
  state.centralConnected = j.connected === true;
  state.centralRepo = j.repo ?? null;
  state.centralLastSyncMs = typeof j.lastSyncMs === "number" ? j.lastSyncMs : null;
  state.centralSharedCount = typeof j.sharedCount === "number" ? j.sharedCount : 0;
  // 与 /api/context 的 centralAvailable 对齐(连接=可用)
  state.centralAvailable = state.centralConnected;
}

/**
 * 拉 GET /api/central/bots → state.centralBots(只读名册,含 by/updated/commit)。
 * @returns {Promise<boolean>} 成功与否
 */
async function loadCentralBots() {
  const res = await api("GET", "/api/central/bots");
  if (!res.ok) {
    state.centralBots = [];
    return false;
  }
  state.centralBots = Array.isArray(res.json?.bots) ? res.json.bots : [];
  return true;
}

// ---------------------------------------------------------------------------
// 公司中心库:连接流弹窗(form → connecting → connected/failed)
//   复刻 centralConnect.jsx LkConnectFlow。connecting 调 POST /api/central/config。
// ---------------------------------------------------------------------------

/** 连接流弹窗的瞬态(表单值 + 连上后回填的仓库)。 */
const connectFlow = {
  /** @type {{url:string,branch:string,path:string}} */
  values: { url: "", branch: "main", path: "bots/" },
  /** @type {{name:string,url:string,branch:string,path:string}|null} */
  repo: null,
  /** @type {{kind?:string,error?:string}|null} */
  fail: null,
};

/** 打开连接流弹窗(默认 form 态;edit=true 时预填现有配置)。 */
function openConnectFlow(edit = false) {
  if (edit && state.centralRepo) {
    connectFlow.values = {
      url: state.centralRepo.url ?? "",
      branch: state.centralRepo.branch ?? "main",
      path: state.centralRepo.path ?? "bots/",
    };
  } else {
    connectFlow.values = { url: "", branch: "main", path: "bots/" };
  }
  connectFlow.repo = null;
  connectFlow.fail = null;
  renderConnectFlow("form");
  const backdrop = document.getElementById("connect-backdrop");
  if (backdrop) backdrop.hidden = false;
  document.getElementById("cc-url")?.focus();
}

function closeConnectFlow() {
  const backdrop = document.getElementById("connect-backdrop");
  if (backdrop) backdrop.hidden = true;
}

/** 连接弹窗 header(indigo link 徽章 + 标题 + 副标题 + 关闭)。 */
function connectHead(title, sub) {
  return (
    `<div style="padding:22px 26px 0">` +
    `<div style="display:flex;align-items:center;justify-content:space-between">` +
    `<h3 style="margin:0;font-size:18px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:9px">` +
    `<span style="width:30px;height:30px;border-radius:9px;background:var(--br-soft);border:1px solid var(--br-edge);color:var(--br);display:inline-flex;align-items:center;justify-content:center">${ICONS.link2}</span>` +
    esc(title) +
    `</h3>` +
    `<button type="button" id="cc-close" aria-label="关闭" style="display:inline-flex;padding:6px;border:none;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer">${ICONS.x}</button>` +
    `</div>` +
    (sub ? `<p style="margin:8px 0 0;font-size:13.5px;color:var(--muted);line-height:1.55">${esc(sub)}</p>` : "") +
    `</div>`
  );
}

/**
 * 渲染连接流弹窗的某个 phase。
 * @param {"form"|"connecting"|"connected"|"failed"} phase
 */
function renderConnectFlow(phase) {
  const modal = document.getElementById("connect-modal");
  if (!modal) return;
  const v = connectFlow.values;

  if (phase === "connecting") {
    const steps = ["找到这个仓库", "验证这台机器有没有权限", `读取 ${v.path || "bots/"} 里的助手`];
    modal.innerHTML =
      connectHead("正在连接…", "在测试这台电脑能不能访问这个仓库。不会改动仓库里任何东西。") +
      `<div style="padding:20px 26px 26px">` +
      `<div style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:18px 0 22px">` +
      `<span class="spinner spinner-lg"></span>` +
      `<code style="font-size:12.5px;color:var(--muted);font-family:ui-monospace,monospace;word-break:break-all;text-align:center;max-width:380px">${esc(v.url)}</code>` +
      `</div>` +
      `<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px">` +
      steps.map((s, i) =>
        `<li style="display:flex;align-items:center;gap:10px;font-size:13.5px;color:${i === 0 ? "var(--text)" : "var(--faint)"}">` +
        (i === 0
          ? `<span class="spinner" style="width:15px;height:15px;border-width:2px"></span>`
          : `<span style="width:15px;height:15px;border-radius:50%;border:1.6px solid var(--border);flex-shrink:0"></span>`) +
        esc(s) + `</li>`
      ).join("") +
      `</ul></div>`;
    // connecting 态不可关闭(无 close 按钮)
    return;
  }

  if (phase === "connected") {
    const r = connectFlow.repo ?? state.centralRepo ?? { name: "", branch: "main", path: "bots/" };
    const rows = [
      ["repo", "仓库", r.name, true],
      ["branch", "分支", r.branch, false],
      ["folder", "助手目录", r.path, false],
    ];
    modal.innerHTML =
      `<div style="padding:26px 26px 0;display:flex;gap:14px">` +
      `<span style="flex-shrink:0;width:40px;height:40px;border-radius:11px;background:${LIVE_SOFT.serving};border:1px solid ${LIVE_EDGE.serving};color:${LIVE_COLOR.serving};display:flex;align-items:center;justify-content:center">${ICONS.check}</span>` +
      `<div style="min-width:0">` +
      `<h3 style="margin:0;font-size:18px;font-weight:700;color:var(--text)">连上了</h3>` +
      `<p style="margin:6px 0 0;font-size:13.5px;color:var(--muted);line-height:1.55">这台电脑已经能访问公司中心库了。现在去本机详情页，<b style="color:var(--br-text)">晋升</b>按钮就能点了。</p>` +
      `</div></div>` +
      `<div style="margin:16px 26px 0;border-radius:12px;border:1px solid var(--border);overflow:hidden">` +
      rows.map(([ic, k, val, mono], i) =>
        `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;${i ? "border-top:1px solid var(--border);" : ""}background:${i % 2 ? "var(--surface)" : "var(--bg)"}">` +
        ICONS[ic] +
        `<span style="font-size:12.5px;color:var(--faint);width:64px">${esc(k)}</span>` +
        `<span style="font-size:13.5px;font-weight:600;color:var(--text);${mono ? "font-family:ui-monospace,monospace" : ""}">${esc(val ?? "")}</span>` +
        `</div>`
      ).join("") +
      `</div>` +
      `<p style="margin:14px 26px 0;font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px">${ICONS.users} 中心库里现在有 <b style="color:var(--text)">${state.centralSharedCount}</b> 个共享助手，去「公司中心库」看看。</p>` +
      `<div style="display:flex;justify-content:flex-end;gap:10px;padding:20px 26px 22px">` +
      `<button type="button" id="cc-done" class="btn btn-primary">${ICONS.check} 完成</button>` +
      `</div>`;
    modal.querySelector("#cc-done")?.addEventListener("click", () => {
      closeConnectFlow();
      // 连上后进入中心库视图并加载名册。
      // 注意:若此前已在「公司中心库」上下文(从引导卡进来),switchContext('central')
      // 会因 mode 未变而 no-op,所以这里直接强制刷新中心视图。
      void enterCentralConnected();
    });
    return;
  }

  if (phase === "failed") {
    const f = connectFlow.fail ?? {};
    const reasons = [
      ["地址可能写错了", "核对一下仓库地址有没有漏字符、对不对。"],
      ["这台机器没有访问权限", "让工程师把你这台电脑的 SSH key 加进仓库，或换 HTTPS + 令牌。"],
    ];
    const errLine = f.error
      ? `<div style="margin:14px 26px 0;font-size:12.5px;color:var(--destructive-text);line-height:1.5">${esc(f.error)}</div>`
      : "";
    modal.innerHTML =
      `<div style="padding:24px 26px 0;display:flex;gap:14px">` +
      `<span style="flex-shrink:0;width:40px;height:40px;border-radius:11px;background:${LIVE_SOFT.offline};border:1px solid ${LIVE_EDGE.offline};color:${LIVE_COLOR.offline};display:flex;align-items:center;justify-content:center">${ICONS.warn}</span>` +
      `<div style="min-width:0">` +
      `<h3 style="margin:0;font-size:18px;font-weight:700;color:var(--text)">仓库连不上</h3>` +
      `<p style="margin:6px 0 0;font-size:13.5px;color:var(--muted);line-height:1.55">没改动任何东西。多半是下面两种情况之一：</p>` +
      `</div></div>` +
      `<ul style="list-style:none;margin:14px 26px 0;padding:0;display:flex;flex-direction:column;gap:10px">` +
      reasons.map(([h, d], i) =>
        `<li style="display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border-radius:10px;background:${LIVE_SOFT.offline};border:1px solid ${LIVE_EDGE.offline}">` +
        `<span style="flex-shrink:0;width:20px;height:20px;margin-top:1px;border-radius:999px;background:var(--surface);border:1px solid ${LIVE_EDGE.offline};color:${LIVE_TEXT.offline};font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</span>` +
        `<div><div style="font-size:13.5px;font-weight:600;color:#334155">${esc(h)}</div><div style="font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:1px">${esc(d)}</div></div>` +
        `</li>`
      ).join("") +
      `</ul>` +
      errLine +
      `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:20px 26px 22px">` +
      `<button type="button" id="cc-edit" class="btn">改一下配置</button>` +
      `<button type="button" id="cc-retry" class="btn btn-primary">${ICONS.refresh} 重试</button>` +
      `</div>`;
    modal.querySelector("#cc-edit")?.addEventListener("click", () => renderConnectFlow("form"));
    modal.querySelector("#cc-retry")?.addEventListener("click", () => submitConnect());
    return;
  }

  // ── form(默认)──
  modal.innerHTML =
    connectHead(
      "连接公司中心库",
      "把一个 git 仓库连上，团队的助手就能互相同步。地址一般让工程师帮你配一次，之后就不用管了。",
    ) +
    `<div style="padding:18px 26px 0;display:flex;flex-direction:column;gap:16px">` +
    ccField("仓库地址", "团队放助手配置的 git 仓库。SSH 或 HTTPS 都行。不知道填啥？问下工程师。",
      `<input id="cc-url" class="cc-input" value="${esc(v.url)}" placeholder="git@gitlab.公司.com:team/larkway-bots.git" />`) +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">` +
    ccField("分支", "一般就是 main，别动。", `<input id="cc-branch" class="cc-input" value="${esc(v.branch)}" />`) +
    ccField("助手放在仓库哪个目录", "团队约定的目录，默认就行。", `<input id="cc-path" class="cc-input" value="${esc(v.path)}" />`) +
    `</div>` +
    `<div style="display:flex;align-items:center;gap:8px;padding:10px 13px;border-radius:10px;background:var(--bg);border:1px solid var(--border);font-size:12.5px;color:var(--muted)">${ICONS.lock} 只做一次只读连接测试，不会往仓库里写任何东西。</div>` +
    `</div>` +
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:20px 26px 22px">` +
    `<button type="button" id="cc-cancel" class="btn">取消</button>` +
    `<button type="button" id="cc-submit" class="btn btn-primary">${ICONS.link2} 连接</button>` +
    `</div>`;

  const urlEl = modal.querySelector("#cc-url");
  const submitEl = modal.querySelector("#cc-submit");
  const syncCan = () => {
    const can = (urlEl?.value ?? "").trim().length > 6;
    if (submitEl) submitEl.disabled = !can;
  };
  syncCan();
  urlEl?.addEventListener("input", syncCan);
  modal.querySelector("#cc-close")?.addEventListener("click", () => closeConnectFlow());
  modal.querySelector("#cc-cancel")?.addEventListener("click", () => closeConnectFlow());
  submitEl?.addEventListener("click", () => submitConnect());
}

/** label + 说人话 help + 输入(CcField 复刻)。 */
function ccField(label, help, inputHTML) {
  return (
    `<div style="display:flex;flex-direction:column;gap:6px">` +
    `<label style="font-size:14px;font-weight:600;color:var(--text)">${esc(label)}</label>` +
    (help ? `<p style="margin:0;font-size:12.5px;color:var(--muted);line-height:1.5">${esc(help)}</p>` : "") +
    inputHTML +
    `</div>`
  );
}

/**
 * 提交连接:读表单 → connecting 态 → POST /api/central/config →
 * ok → connected 态 + 刷新 status;否则 → failed 态(说人话,不甩堆栈)。
 */
async function submitConnect() {
  const modal = document.getElementById("connect-modal");
  // form 态时从输入读取最新值;retry 时沿用上次 values
  const urlEl = modal?.querySelector("#cc-url");
  if (urlEl) {
    connectFlow.values = {
      url: (modal.querySelector("#cc-url")?.value ?? "").trim(),
      branch: (modal.querySelector("#cc-branch")?.value ?? "").trim() || "main",
      path: (modal.querySelector("#cc-path")?.value ?? "").trim() || "bots/",
    };
  }
  const v = connectFlow.values;
  if (!v.url || v.url.length <= 6) {
    toast("请填写仓库地址。", "warn");
    return;
  }

  renderConnectFlow("connecting");
  const res = await api("POST", "/api/central/config", {
    url: v.url,
    branch: v.branch,
    path: v.path,
  });

  if (res.ok && res.json?.ok === true) {
    connectFlow.repo = res.json.repo ?? null;
    // 刷新连接状态(取 sharedCount 等)
    await loadCentralStatus();
    renderConnectFlow("connected");
  } else {
    const j = res.json ?? {};
    connectFlow.fail = { kind: j.kind, error: j.error };
    renderConnectFlow("failed");
  }
}

// ---------------------------------------------------------------------------
// 公司中心库:断开连接
// ---------------------------------------------------------------------------

async function doCentralDisconnect() {
  const ok = await confirmDialog({
    title: "断开公司中心库？",
    body:
      "断开后这台电脑不再跟团队中心库同步,「晋升」也会停用。本机已有的助手不受影响,继续在本机跑。\n\n随时可以再连回来。",
    confirmText: "断开",
    confirmDanger: true,
  });
  if (!ok) return;
  const res = await api("POST", "/api/central/disconnect");
  if (!res.ok || res.json?.ok !== true) {
    toast(`断开失败：${res.json?.error ?? res.status}`, "error");
    return;
  }
  toast("已断开公司中心库", "ok");
  state.centralConnected = false;
  state.centralRepo = null;
  state.centralAvailable = false;
  // 后端断开后会把 mode 重置为 local;前端跟随切回本机
  state.mode = "local";
  state.selected = null;
  renderContextSwitch();
  renderCentralSourceBar();
  renderBotDetail(null);
  await loadBots();
  renderServiceIndicator();
}

// ---------------------------------------------------------------------------
// 公司中心库:同步(中心 → 本地)—— preview(dry-run)+ ack gate + apply
//   复刻 centralSync.jsx LkSyncPreview。preview 走 GET /api/central/sync/preview,
//   apply 走 POST /api/central/sync/apply。移除类醒目(amber)+ ack 勾选。
// ---------------------------------------------------------------------------

async function doCentralSync() {
  state.centralSyncState = "syncing";
  renderCentralSourceBar();

  const res = await api("GET", "/api/central/sync/preview");
  if (!res.ok) {
    state.centralSyncState = "unknown";
    renderCentralSourceBar();
    toast(`同步预览失败：${res.json?.error ?? res.status}`, "error");
    return;
  }
  const preview = {
    added: Array.isArray(res.json?.added) ? res.json.added : [],
    updated: Array.isArray(res.json?.updated) ? res.json.updated : [],
    removed: Array.isArray(res.json?.removed) ? res.json.removed : [],
  };
  // 「N 项可更新」只数中心 sync 会真正应用的增量(added + updated)。removed(本机自建未晋升的
  // bot)本机自管、绝不删,不该算「可更新」—— 否则本地独有 bot 会让来源条永远显示「1 项可更新」,
  // 点进去又走删除路径(2026-06-01 误删 larkway-2 的连锁起点)。
  const total = preview.added.length + preview.updated.length;
  state.centralUpdateCount = total;
  state.centralSyncState = total > 0 ? "updates" : "fresh";
  renderCentralSourceBar();

  if (total === 0) {
    toast("已是最新，没有要同步的改动。", "ok");
    return;
  }
  showCentralSyncModal(preview);
}

/** 一行变更项(CcChangeRow):added=绿 / updated=indigo / removed=amber。 */
function ccChangeRow(kind, item) {
  const map = {
    added: { c: LIVE_COLOR.serving, soft: LIVE_SOFT.serving, edge: LIVE_EDGE.serving, text: LIVE_TEXT.serving, icon: ICONS.plus, tag: "新增" },
    updated: { c: BR.c, soft: BR.soft, edge: BR.edge, text: BR.text, icon: ICONS.refresh, tag: "更新" },
    removed: { c: LIVE_COLOR.degraded, soft: LIVE_SOFT.degraded, edge: LIVE_EDGE.degraded, text: LIVE_TEXT.degraded, icon: ICONS.trash, tag: "移除" },
  }[kind];
  const removed = kind === "removed";
  const by = item.by ? `<span style="font-size:11.5px;color:var(--faint)">· ${esc(item.by)}</span>` : "";
  const note = removed
    ? "中心库里已被移除 —— 同步后本机这份(由中心库管理)也会删掉。"
    : (item.note ?? "");
  return (
    `<div class="cc-change-row${removed ? " is-removed" : ""}">` +
    `<span class="cc-change-badge" style="border:1px solid ${map.edge};color:${map.c}">${map.icon}</span>` +
    `<div style="min-width:0;flex:1">` +
    `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">` +
    `<span style="font-size:14px;font-weight:600;color:var(--text)">${esc(item.name)}</span>` +
    `<span class="cc-change-tag" style="color:${map.text};background:${map.soft};border:1px solid ${map.edge}">${map.tag}</span>` +
    by +
    `</div>` +
    `<div style="font-size:12.5px;color:${removed ? map.text : "var(--muted)"};line-height:1.5;margin-top:2px">${esc(note)}</div>` +
    `</div></div>`
  );
}

/** 同步预览 modal(复用 #modal-backdrop)。移除>0 时 ack gate。 */
function showCentralSyncModal(preview) {
  const backdrop = document.getElementById("modal-backdrop");
  const modal = document.getElementById("modal");
  if (!backdrop || !modal) return;
  // 同步弹窗:设计稿 520px / 圆角 16px,加 class 后关闭时清掉
  modal.classList.add("modal--sync");

  const nAdd = preview.added.length, nUpd = preview.updated.length;
  // 中心 sync 只做增量:added(中心有本机没有)+ updated(两边都有、中心更新)。
  // `preview.removed` = 「本机有、中心没有」,即本机自建没晋升过的 bot —— 本机自管,中心 sync
  // 绝不删它(见下方 prune=false)。所以这里不计入改动、不展示为「移除」、不做 ack gate,
  // 避免把用户自己的本地 bot 误报成「会被移除」吓人(2026-06-01 误删 larkway-2 的教训)。
  const nRem = 0;
  const total = nAdd + nUpd;

  const sumCell = (n, label, c) =>
    `<span style="display:inline-flex;align-items:baseline;gap:5px"><b style="font-size:16px;font-weight:800;color:${n ? c : "var(--faint)"}">${n}</b><span style="font-size:12.5px;color:var(--muted)">${label}</span></span>`;
  const sep = `<span style="width:1px;height:20px;background:var(--border)"></span>`;

  const removeWarn = "";

  const list =
    preview.added.map((it) => ccChangeRow("added", it)).join("") +
    preview.updated.map((it) => ccChangeRow("updated", it)).join("");

  const ackBlock = "";

  modal.querySelector(".modal-header")?.remove();
  modal.querySelector(".modal-header-sync")?.remove();
  modal.innerHTML =
    `<div class="modal-header-sync">` +
    `<div class="modal-header-sync-row">` +
    `<h3><span class="sync-icon-badge">${ICONS.pull}</span>同步前先看一眼</h3>` +
    `<button class="sync-close-btn" id="cc-sync-close-x" type="button" aria-label="关闭">${ICONS.x}</button>` +
    `</div>` +
    `<p>把中心库最新的拉到本机。下面是会发生的改动，确认了再应用。</p>` +
    `</div>` +
    `<div class="modal-body">` +
    `<div style="display:flex;align-items:center;gap:20px;padding:12px 16px;border-radius:11px;background:var(--bg);border:1px solid var(--border)">` +
    sumCell(nAdd, "新增", LIVE_COLOR.serving) + sep + sumCell(nUpd, "更新", BR.c) + sep + sumCell(nRem, "移除", LIVE_COLOR.degraded) +
    `</div>` +
    removeWarn +
    `<div style="margin:16px 0 0;display:flex;flex-direction:column;gap:8px">${list}</div>` +
    ackBlock +
    `</div>` +
    `<div class="modal-footer">` +
    `<div class="modal-btns">` +
    `<button class="btn" id="cc-sync-cancel" type="button">先不同步</button>` +
    `<button class="btn btn-primary" id="cc-sync-apply" type="button">${ICONS.pull} 应用更新（${total}）</button>` +
    `</div></div>`;

  const applyBtn = modal.querySelector("#cc-sync-apply");
  const ackChk = modal.querySelector("#cc-sync-ack");
  if (ackChk && applyBtn) {
    applyBtn.disabled = true;
    ackChk.addEventListener("change", () => { applyBtn.disabled = !ackChk.checked; });
  }

  backdrop.hidden = false;

  const closeSync = () => { backdrop.hidden = true; modal.classList.remove("modal--sync"); };
  modal.querySelector("#cc-sync-cancel")?.addEventListener("click", closeSync);
  modal.querySelector("#cc-sync-close-x")?.addEventListener("click", closeSync);
  applyBtn?.addEventListener("click", async () => {
    if (applyBtn.disabled) return;
    // 安全:中心库 sync 永不自动删本机 bot。planSync 的 `removed` = 「本机有、中心没有」,
    // 它把「本机自建从没晋升过的 bot」(如本地新建测试 bot)和「曾被中心管理后从中心删掉的」
    // 混为一谈 —— 旧代码 `nRem>0` 就 prune=true 会把前者一并硬删(2026-06-01 误删 larkway-2)。
    // 在 provenance-aware prune 落地前,这里强制 false:本机自管是安全默认,中心 sync 只增量
    // 拉 added/updated,绝不删本机。真要清理本机多余 bot 走「拉取最新」里显式勾选 prune 的流程。
    const prune = false;
    const restore = btnLoading(applyBtn, "正在应用…");
    const res = await api("POST", "/api/central/sync/apply", { prune });
    restore();
    backdrop.hidden = true;
    modal.classList.remove("modal--sync");
    if (!res.ok || res.json?.ok !== true) {
      toast(`同步失败：${res.json?.error ?? res.status}`, "error");
      return;
    }
    const j = res.json;
    const parts = [];
    if ((j.added ?? []).length) parts.push(`新增 ${j.added.length}`);
    if ((j.updated ?? []).length) parts.push(`更新 ${j.updated.length}`);
    if ((j.removed ?? []).length) parts.push(`移除 ${j.removed.length}`);
    toast(`同步完成。${parts.join("、") || "无变化"}`, "ok");
    if ((j.warnings ?? []).length) {
      for (const w of j.warnings) console.warn("[larkway central sync]", w);
    }
    // 同步后刷新中心库状态 + 名册(本机也变了,但当前在中心视图,刷中心名册)
    state.centralSyncState = "fresh";
    state.centralUpdateCount = 0;
    await loadCentralStatus();
    renderCentralSourceBar();
    await loadBots();
  });
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
 * (它读 AC 面板的实时表单值,所以不会丢用户正在编辑的输入)。仅本机可改模式生效:
 * 中心库(只读)hero 不显在线/心跳,且没有 AC 面板可读。
 */
function refreshDetailHero() {
  const id = state.selected;
  if (!id || state.mode === "central") return;
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

/** 更新名册顶部计数文案「这台电脑上的 N 个助手」（中心库时换措辞）。 */
function renderRosterCount() {
  const el = document.getElementById("roster-count-text");
  if (!el) return;
  const n = state.bots.length;
  if (n === 0) {
    el.textContent =
      state.mode === "central" ? "中心库还没有共享助手" : "这台电脑上还没有助手";
  } else if (state.mode === "central") {
    el.textContent = `公司中心库的 ${n} 个助手`;
  } else {
    el.textContent = `这台电脑上的 ${n} 个助手`;
  }
}

/**
 * BL-18:名册头部重启状态行(照 restartBoard.jsx 名册头 isR/isTimeout 分支)。
 * restarting → sky「重启中 · 已连回 N/total」
 * timeout    → 红「重启异常 · 仍有 N 个没连回」
 * serving    → 隐藏
 */
function renderRosterRestartStatus() {
  const el = document.getElementById("roster-restart-status");
  if (!el || state.mode === "central") return;
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
  const readonly = state.mode === "central";
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

    // ── 中心库只读名册行(CcRosterItem):头像 + 名字 + 「<by> 晋升 · <updated>」──
    // 中心库存「配置」不是「进程」→ 不显在线/心跳,只显谁晋升的 + 更新时间;无删除。
    if (readonly) {
      li.classList.add("cc-roster-item");
      const meta = state.centralBots.find((b) => b.id === bot.id) ?? {};
      const by = meta.by || "";
      const updated = meta.updated || "";
      const byLine = by || updated
        ? `<span class="cc-roster-by">${ICONS.upload} ${esc(by)}${by ? " 晋升" : ""}${updated ? ` · ${esc(updated)}` : ""}</span>`
        : `<span class="cc-roster-by">${ICONS.upload} 共享助手</span>`;
      // ⑦ 中心库名册:用 bot.avatar 飞书头像,没有才回退首字母
      const ccAvatar = state.avatars[bot.id] ?? bot.avatar ?? null;
      li.innerHTML =
        `<span class="roster-num">${num}</span>` +
        avatarHTML(bot.id, bot.name, ccAvatar, "list", "unknown").replace(
          /<span class="avatar-dot[^>]*><\/span>/,
          "", // 中心库无在线状态,去掉头像角标圆点
        ) +
        `<span class="roster-meta">` +
        `<span class="bot-name">${esc(bot.name)}</span>` +
        `<span class="roster-state">${byLine}</span>` +
        `</span>`;
      return;
    }

    // ── BL-18:显示覆盖 —— restarting/timeout 时用 restartDisplayLive 替代真实 liveKey ─
    const realLiveKey = botLiveness(bot.id);
    const dispLiveKey = restartDisplayLive(realLiveKey, state.restart.status);
    const liveKey = dispLiveKey;
    const live = LIVENESS[liveKey] ?? LIVENESS.unknown;
    const avatar = state.avatars[bot.id] ?? bot.avatar ?? null;
    const delBtn = readonly
      ? ""
      : `<button class="lk-del" type="button" aria-label="删除 ${esc(bot.name)}" title="删除助手">${ICONS.trash}</button>`;
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
    if (!readonly) {
      const delEl = li.querySelector(".lk-del");
      if (delEl) {
        delEl.addEventListener("click", (e) => {
          e.stopPropagation();
          doDeleteBot(bot.id);
        });
      }
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
 * @param {'local'|'central'} variant
 * @param {boolean} serviceRunning  false 时在 CTA 下加温和提示
 */
function buildEmptyStateHTML(variant, serviceRunning) {
  const central = variant === "central";
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
  if (central) {
    // 中心库变体:只读引导
    const switchBtn = `<button class="es-central-switch-btn" type="button"
      style="margin-top:24px;display:inline-flex;align-items:center;gap:8px;padding:11px 20px;font-size:14.5px;font-weight:700;font-family:inherit;color:${brText};background:${soft};border:1px solid ${edge};border-radius:11px;cursor:pointer">
      切到「本机」去添加
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
    </button>`;

    mainContent = `
      <h1 style="margin:20px 0 0;font-size:30px;font-weight:800;letter-spacing:-.03em;line-height:1.12;color:${text}">公司中心库还没有共享助手</h1>
      <p style="margin:12px 0 0;font-size:16px;color:${muted};line-height:1.62;max-width:460px">
        中心库是<b style="color:#334155">只读</b>的展示窗。先在<b style="color:${brText}">「本机」</b>配好一个助手，再把它<b style="color:#334155">晋升到这里</b>，全组就都能看到、复用。
      </p>
      ${switchBtn}
    `;
  } else {
    // 本机变体:欢迎 + CTA
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
  const shieldNote = `<div style="margin-top:${central ? 34 : 26}px;display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:${faint}">
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

/**
 * 构建 LkConnectGuide(未连接引导卡)的 HTML —— 复刻 centralConnect.jsx。
 * 母题:本机一份 → 仓库 → 同事各自一份(共享);CTA = indigo「连接公司中心库」。
 */
function buildConnectGuideHTML() {
  const c = BR.c, soft = BR.soft, text = "#1e293b", muted = "#64748b", faint = "#94a3b8", brText = BR.text;
  const bgStyle = `radial-gradient(120% 90% at 50% 0%, ${lkHexA(c, 0.05)} 0%, #fff 56%)`;

  // 连接母题插画(中央仓库 + 三个同事机器 + 双向同步弧线/流动光点)
  const machines = [[34, 38], [34, 94], [266, 66]]
    .map(([x, y]) =>
      `<g><rect x="${x - 20}" y="${y - 14}" width="40" height="28" rx="7" fill="#fff" stroke="#cbd5e1" stroke-width="1.5"/>` +
      `<circle cx="${x - 9}" cy="${y}" r="3.5" fill="#cbd5e1"/>` +
      `<rect x="${x - 2}" y="${y - 4}" width="16" height="3.5" rx="1.75" fill="#e2e8f0"/>` +
      `<rect x="${x - 2}" y="${y + 3}" width="11" height="3" rx="1.5" fill="#eef0f4"/></g>`,
    ).join("");
  const arcs = [[54, 44, 123, 56], [54, 88, 123, 78], [246, 66, 177, 67]]
    .map((p, i) => {
      const d = `M${p[0]} ${p[1]} Q ${(p[0] + p[2]) / 2} ${(p[1] + p[3]) / 2 - 14}, ${p[2]} ${p[3]}`;
      return (
        `<g><path d="${d}" fill="none" stroke="${lkHexA(c, 0.4)}" stroke-width="1.8" stroke-dasharray="3 4" stroke-linecap="round"/>` +
        `<circle r="2.6" fill="${c}">` +
        `<animateMotion dur="2.6s" begin="${i * 0.5}s" repeatCount="indefinite" path="${d}"/>` +
        `<animate attributeName="opacity" dur="2.6s" begin="${i * 0.5}s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.15;0.8;1"/>` +
        `</circle></g>`
      );
    }).join("");
  const svg =
    `<svg viewBox="0 0 300 132" width="272" height="120" aria-hidden="true" style="display:block">` +
    `<ellipse cx="150" cy="66" rx="132" ry="58" fill="${lkHexA(c, 0.05)}"/>` +
    `<rect x="123" y="44" width="54" height="46" rx="11" fill="#fff" stroke="${c}" stroke-width="1.8"/>` +
    `<path d="M135 58h30M135 67h30M135 76h20" stroke="${lkHexA(c, 0.5)}" stroke-width="2" stroke-linecap="round"/>` +
    machines + arcs +
    `</svg>`;

  return (
    `<div class="es-root" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:40px 32px;background:${bgStyle};overflow-y:auto">` +
    `<div style="width:100%;max-width:520px;display:flex;flex-direction:column;align-items:center;text-align:center">` +
    svg +
    `<h1 style="margin:18px 0 0;font-size:27px;font-weight:800;letter-spacing:-.025em;line-height:1.14;color:${text};text-wrap:balance">连接公司中心库，和团队共享助手</h1>` +
    `<p style="margin:11px 0 0;font-size:15.5px;color:${muted};line-height:1.62;max-width:440px;text-wrap:pretty">把本机调好的助手<b style="color:${brText}">晋升</b>到团队的中心库，别的同事一拉就能用同一份；别人晋升的，你也<b style="color:#334155">一键同步</b>下来。</p>` +
    `<button id="cc-guide-connect" type="button" class="es-cta-btn" style="margin-top:24px;display:inline-flex;align-items:center;gap:9px;padding:13px 26px;font-size:15.5px;font-weight:700;font-family:inherit;color:#fff;background:${c};border:none;border-radius:12px;cursor:pointer;box-shadow:0 4px 14px ${lkHexA(c, 0.26)};transition:background .15s">${ICONS.link2} 连接公司中心库</button>` +
    `<div style="margin-top:18px;display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:${faint}">${ICONS.info} 第一次连可能要工程师帮忙给个仓库地址；连好之后日常同步、晋升你自己点就行</div>` +
    `</div></div>`
  );
}

// ---------------------------------------------------------------------------
// 详情区「空态」(名册有助手但未选中)—— 复刻 Claude Design empty-detail 稿。
// 两个变体:本机(可改,indigo)/ 公司中心库(只读,slate)。设计稿 emptyDetail.jsx。
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

/** 详情区空态 HTML(ro=公司中心库只读变体)。 */
function buildEmptyDetailHTML(ro) {
  if (ro) {
    return `<div class="lk-ed lk-ed--ro" style="container-type:inline-size;container-name:lk-ed">` +
      `<div class="lk-ed__inner">${edHeroSVG(true, 348)}` +
      `<span class="lk-ed__eyebrow">${edIcon(ED_ICON.lock, 14, 2.1)} 公司中心库 · 只读</span>` +
      `<h2 class="lk-ed__title">选一个共享助手，看它怎么配的</h2>` +
      `<p class="lk-ed__body">这里是全组共享的助手，内容<b>只读</b> —— 能看它的配置和职责，照着用。想改？先回<b class="br">「本机」</b>改好，再<b>「晋升」</b>覆盖回来。</p>` +
      `<div class="lk-ed__actions"><button type="button" id="ed-go-local" class="lk-ed__btn lk-ed__btn--soft">${edIcon(ED_ICON.arrowL, 16, 2.1)} 回「本机」去改配置</button></div>` +
      edRail([
        { d: ED_ICON.eye, t: "在这里浏览", s: "只读看配置 / 职责" },
        { d: ED_ICON.edit, t: "回本机修改", s: "改动只能在本机做" },
        { d: ED_ICON.upload, t: "晋升覆盖", s: "推上来，全组更新" },
      ]) +
      `<span class="lk-ed__foot">${edIcon(ED_ICON.lock, 14, 1.7)} 中心库只读；任何改动都要从本机晋升上来</span></div></div>`;
  }
  return `<div class="lk-ed" style="container-type:inline-size;container-name:lk-ed">` +
    `<div class="lk-ed__inner">${edHeroSVG(false, 348)}` +
    `<span class="lk-ed__eyebrow">${edIcon(ED_ICON.edit, 14, 2)} 本机 · 可改</span>` +
    `<h2 class="lk-ed__title">从左边选一个助手，开始配置</h2>` +
    `<p class="lk-ed__body">在<b>「本机」</b>里可以改它的名字、介绍、能用它的群、能改的代码仓库，还有它的职责说明。改好后用<b class="br">「晋升」</b>把配置交给公司中心库，别的电脑就能拉到同一份。</p>` +
    `<div class="lk-ed__actions">` +
    `<button type="button" id="ed-add-bot" class="lk-ed__btn lk-ed__btn--primary">${edIcon(ED_ICON.plus, 18, 2.2)} 添加新助手</button>` +
    `<button type="button" id="ed-pick" class="lk-ed__btn lk-ed__btn--ghost">${edIcon(ED_ICON.arrowL, 16, 2)} 从名册里挑一个</button></div>` +
    edRail([
      { d: ED_ICON.sliders, t: "配置", s: "改名字、群、仓库、职责" },
      { d: ED_ICON.upload, t: "晋升", s: "交给公司中心库" },
      { d: ED_ICON.users, t: "全组复用", s: "别的电脑拉同一份" },
    ]) +
    `<span class="lk-ed__foot">${edIcon(ED_ICON.shield, 14, 1.7)} 全程不碰终端；密钥只存在你本机，别人看不到</span></div></div>`;
}

/** 渲染 #detail-placeholder 的空态内容 + 接线按钮(按当前 mode 选变体)。 */
function renderDetailPlaceholder() {
  const placeholder = document.getElementById("detail-placeholder");
  if (!placeholder) return;
  const ro = state.mode === "central";
  placeholder.innerHTML = buildEmptyDetailHTML(ro);
  if (ro) {
    placeholder.querySelector("#ed-go-local")?.addEventListener("click", () => switchContext("local"));
  } else {
    placeholder.querySelector("#ed-add-bot")?.addEventListener("click", () => openOnboardModal());
    placeholder.querySelector("#ed-pick")?.addEventListener("click", () => {
      if (state.bots[0]) selectBot(state.bots[0].id);
    });
  }
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

  // 中心库未连接 → 全屏连接引导卡(LkConnectGuide),优先级高于空态。
  const centralDisconnected = state.mode === "central" && !state.centralConnected;

  if (centralDisconnected) {
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
      es.innerHTML = buildConnectGuideHTML();
      es.querySelector("#cc-guide-connect")?.addEventListener("click", () => openConnectFlow());
    }
    return;
  }

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
      const variant = state.mode === "central" ? "central" : "local";
      const serviceRunning = state.bridge?.running ?? false;
      es.innerHTML = buildEmptyStateHTML(variant, serviceRunning);
      wireEmptyStateEvents(es);
    }
  } else {
    // 有助手:移除空态,恢复 placeholder(若无选中)
    if (existingEs) existingEs.remove();
    if (panel) panel.style.display = "";
    if (!state.selected && placeholder) {
      renderDetailPlaceholder(); // 按当前 mode 渲染本机/只读空态变体
      placeholder.style.display = "";
    }
  }
}

/** 接线空态内的事件。*/
function wireEmptyStateEvents(container) {
  // 本机变体:CTA → openOnboardModal
  const addBtn = container.querySelector("#es-add-btn");
  addBtn?.addEventListener("click", () => openOnboardModal());

  // central 变体:「切到本机」→ switchContext('local')
  const switchBtn = container.querySelector(".es-central-switch-btn");
  switchBtn?.addEventListener("click", () => switchContext("local"));

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

  const readonly = state.mode === "central";

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

  // 中心库 = 只读展示窗(CcReadonlyDetail):by/updated/commit + 回本机引导 + 只读 memory。
  if (readonly) {
    panel.innerHTML = buildCentralDetailHTML(id, bot, memContent);
    panel.classList.remove("panel-enter");
    void panel.offsetWidth;
    panel.classList.add("panel-enter");
    panel.querySelector("#cc-detail-golocal")?.addEventListener("click", () => switchContext("local"));
    return;
  }

  panel.innerHTML = buildDetailHTML(id, bot, memContent, readonly);
  // 切 bot 丝滑:详情区淡入(reduced-motion 下 transition 被禁,无白闪)
  panel.classList.remove("panel-enter");
  void panel.offsetWidth; // 强制 reflow 重新触发动画
  panel.classList.add("panel-enter");
  // AC 面板头像渲染(#ac-avatar-wrap 由 buildAgentConfigHTML 留空)
  const avatar = state.avatars[id] ?? bot.avatar ?? null;
  const liveKey = botLiveness(id);
  acRenderAvatar(panel, id, bot.name || id, avatar, liveKey);
  wireDetailEvents(panel, id, bot, readonly);
  renderDetailBanner();
  loadRecentEvents(id, panel);
}

/**
 * 构建中心库只读详情(CcReadonlyDetail 复刻):
 * hero(标题 + 描述 + by/updated/commit + 谁能用它/能改仓库/谁晋升的) + 只读横幅(回本机改) + 只读职责说明。
 * 中心库不显在线/心跳;memory 即「职责说明」,只读;密钥不显示。
 */
function buildCentralDetailHTML(id, bot, memContent) {
  const meta = state.centralBots.find((b) => b.id === id) ?? {};
  const by = meta.by || "—";
  const updated = meta.updated || "—";
  const commit = meta.commit || "—";
  const name = bot.name ?? id;
  const desc = bot.description ?? "";
  const chats = Array.isArray(bot.chats) ? bot.chats.length : 0;
  const repos = Array.isArray(bot.repos) ? bot.repos.length : 0;

  // L1 权限层(只读):能改仓库 / repos 明细 / 令牌变量名(脱敏,绝不显真值)+ 约束。
  const repoList = Array.isArray(bot.repos) ? bot.repos : [];
  const codeAccess = !!(bot.gitlab_token_env || repoList.length > 0);
  const turnLimit = bot.turn_taking_limit ?? 10;
  // chats 元素可能是字符串(oc_…)或 {label/chat_id} 对象;统一成可读文案。
  const chatLabel = (c) =>
    typeof c === "string" ? c : (c?.label || c?.chat_id || c?.id || JSON.stringify(c));
  const chatsList = Array.isArray(bot.chats) ? bot.chats.map(chatLabel) : [];

  // 只读卡片外壳(与「它的职责说明」同款)。
  const roCard = (title, inner) =>
    `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;box-shadow:var(--shadow-sm);margin-bottom:16px">` +
    `<h4 style="margin:0 0 14px;font-size:16px;font-weight:700;color:var(--text)">${esc(title)}</h4>` +
    inner +
    `</div>`;
  const roKv = (label, value) =>
    `<div style="display:flex;gap:12px;align-items:baseline;padding:7px 0">` +
    `<span style="font-size:12.5px;color:var(--faint);width:104px;flex-shrink:0">${esc(label)}</span>` +
    `<span style="font-size:13.5px;color:var(--text);line-height:1.5">${esc(value)}</span></div>`;

  // 「它的权限」卡内容
  const permInner = codeAccess
    ? `<div style="display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600;color:${LIVE_TEXT.serving}">${ICONS.check} 能改代码仓库 · 通过 GitLab 令牌</div>` +
      (repoList.length
        ? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">` +
          repoList.map((r) =>
            `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg)">` +
            `<div style="font-size:13.5px;font-weight:600;color:var(--text);font-family:ui-monospace,monospace">${esc(r.slug || "—")} <span style="color:var(--faint);font-weight:400">@ ${esc(r.branch || "main")}</span></div>` +
            (r.url ? `<div style="margin-top:3px;font-size:12px;color:var(--muted);font-family:ui-monospace,monospace;word-break:break-all">${esc(r.url)}</div>` : "") +
            `</div>`
          ).join("") +
          `</div>`
        : `<p style="margin:10px 0 0;font-size:13px;color:var(--muted);line-height:1.55">未列具体仓库 —— agent 用令牌自己判断需要哪些、自己 clone。</p>`) +
      (bot.gitlab_token_env
        ? `<p style="margin:12px 0 0;font-size:12px;color:var(--faint);display:flex;align-items:center;gap:6px">${ICONS.lock} 令牌已配置，真值只存本机 <code>.env</code>（0600），这里看不到。</p>`
        : "")
    : `<div style="display:inline-flex;align-items:center;gap:7px;font-size:14px;color:var(--muted)">${ICONS.lock} 纯答疑，不碰代码。</div>`;

  // 「行为约束」卡内容
  const constraintInner =
    roKv("谁能 @ 它", chatsList.length ? chatsList.join("、") : "任何群都能 @(没限制)") +
    roKv("最多连做", `${turnLimit} 步就停下问人`);

  const metaCell = (label, value, tone) =>
    `<div style="display:flex;flex-direction:column;gap:3px">` +
    `<span style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)">${esc(label)}</span>` +
    `<span style="font-size:13.5px;font-weight:600;color:${tone || "var(--text)"}">${esc(value)}</span>` +
    `</div>`;

  const chatVal = chats === 0 ? "任何群都能 @" : `仅 ${chats} 个群`;
  const repoVal = repos === 0 ? "纯答疑" : `${repos} 个仓库`;
  const botBackend = bot.backend || LK_BACKEND_DEFAULT;

  // 底座列:用 chip(sm + mono)内联显示,套进 metaCell value 位置
  const backendCellValue =
    `<span style="display:inline-flex">${lkBackendChipHTML(botBackend, { size: "sm", mono: true })}</span>`;
  const metaCellRaw = (label, innerHTML) =>
    `<div style="display:flex;flex-direction:column;gap:3px">` +
    `<span style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)">${esc(label)}</span>` +
    innerHTML +
    `</div>`;

  return (
    // hero band
    `<div style="padding:30px 44px 24px;background:linear-gradient(180deg,var(--bg) 0%,var(--surface) 100%);border-bottom:1px solid var(--border)">` +
    `<div style="max-width:800px;display:flex;align-items:flex-start;gap:22px">` +
    avatarHTML(id, name, bot.avatar ?? null, "list", "unknown").replace(/avatar-list/, "avatar-list cc-detail-avatar").replace(/<span class="avatar-dot[^>]*><\/span>/, "") +
    `<div style="flex:1;min-width:0;padding-top:2px">` +
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">` +
    `<span style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)">公司中心库 · 共享助手</span>` +
    `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;color:var(--muted);background:var(--bg);border:1px solid var(--border)">${ICONS.lock} 只读</span>` +
    `</div>` +
    `<h1 style="margin:0 0 8px;font-size:31px;font-weight:800;letter-spacing:-.025em;line-height:1.06;color:var(--text)">${esc(name)}</h1>` +
    `<p style="margin:0 0 14px;font-size:15.5px;color:var(--muted);line-height:1.55;max-width:540px">${esc(desc || "（还没填介绍）")}</p>` +
    `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--muted)">` +
    `<span style="display:inline-flex;align-items:center;gap:6px">${ICONS.upload} ${esc(by)} 晋升</span>` +
    `<span style="color:var(--faint)">·</span><span>更新于 ${esc(updated)}</span>` +
    `<span style="color:var(--faint)">·</span><span style="font-family:ui-monospace,monospace">commit ${esc(commit)}</span>` +
    `</div></div></div>` +
    `<div style="max-width:800px;margin-top:22px;padding-top:18px;border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(4,1fr);gap:16px">` +
    metaCell("谁能用它", chatVal, chats === 0 ? BR.text : null) +
    metaCell("能改仓库", repoVal, null) +
    metaCell("谁晋升的", by, null) +
    metaCellRaw("底座", backendCellValue) +
    `</div></div>` +
    // body
    `<div style="padding:24px 44px 36px"><div style="max-width:800px">` +
    // 只读横幅 + 回本机引导
    `<div class="cc-readonly-banner">${ICONS.lock}` +
    `<div style="min-width:0;flex:1">` +
    `<div class="cc-readonly-banner-title">这是中心库里的只读副本</div>` +
    `<div class="cc-readonly-banner-sub">中心库不能直接改。想改？回「本机」改好那一份，再<b>晋升</b>覆盖上来。</div>` +
    `</div>` +
    `<button type="button" id="cc-detail-golocal" class="cc-go-local-btn">回本机改 ${ICONS.arrowRight}</button>` +
    `</div>` +
    // 只读底座展示卡
    roCard("底座", lkBackendSelectHTML(botBackend, true)) +
    // L1 权限层(只读):它能改哪些仓库 + 令牌变量名(脱敏)
    roCard("它的权限", permInner) +
    // 约束层(只读):谁能 @ + 最多连做几步
    roCard("行为约束", constraintInner) +
    // 只读职责说明(memory)
    `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;box-shadow:var(--shadow-sm)">` +
    `<h4 style="margin:0 0 14px;font-size:16px;font-weight:700;color:var(--text)">它的职责说明</h4>` +
    `<div style="width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);font-size:13.5px;line-height:1.65;color:#334155;font-family:ui-monospace,'Cascadia Code',monospace;white-space:pre-wrap">${esc(memContent || "（没有职责说明）")}</div>` +
    `<p style="margin:12px 0 0;font-size:12px;color:var(--faint);display:flex;align-items:center;gap:6px">${ICONS.lock} 只读 —— 在这里看不到、也改不了真密钥;每个人同步到本机后用自己的密钥跑。</p>` +
    `</div></div></div>`
  );
}

/**
 * 构建 hero band 内层(名字 / 介绍 / meta strip）—— 依赖 P.form 的实时值,
 * 输入时由 refreshHero() 重渲染,与编辑式 hero 的「所见即所改」一致。
 * @param {string} id
 * @param {object} bot   原始 yaml(提供 app_id / bot_open_id 等只读 meta)
 * @param {{name:string,description:string,chatCount:number,repoCount:number}} f 当前表单值
 * @param {boolean} readonly
 */
function buildHeroInner(id, bot, f, readonly) {
  const idx = state.bots.findIndex((b) => b.id === id);
  const num = String((idx < 0 ? 0 : idx) + 1).padStart(2, "0");
  // ⑤ hero 内状态条:BL-18 重启窗口内用 restartDisplayLive 覆盖;否则 effLive
  const realLive = effLive(id);
  const rs = state.restart;
  const isR = rs.status === "restarting";
  const isTimeout = rs.status === "timeout";
  const dispLiveKey = (isR || isTimeout) ? restartDisplayLive(realLive, rs.status) : realLive;
  const liveKey = dispLiveKey;

  const editBadge = readonly
    ? `<span class="hero-badge hero-badge-ro">${ICONS.lock} 只读</span>`
    : `<span class="hero-badge">${ICONS.check} 可改</span>`;
  const eyebrowLabel = readonly ? "公司中心库 · 第" : "本机助手 · 第";

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

  const heroDelBtn = readonly
    ? ""
    : `<button class="btn btn-hero-del" id="btn-hero-del" type="button" title="删除助手">` +
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
      const [slug, branch = "master"] = r.split(":").map((s) => s.trim());
      return { slug, branch, url: "" };
    }
    return { slug: r.slug ?? "", branch: r.branch ?? "master", url: r.url ?? "" };
  });
}

/**
 * 生成一个仓库行的 HTML(可读 / 可删)。
 * @param {number} idx
 * @param {{slug:string,branch:string,url:string}} repo
 */
function acRepoRowHTML(idx, repo) {
  const xIcon = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  return (
    `<div class="ac-repo-row" data-repo-idx="${idx}">` +
    `<div class="ac-repo-grid">` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-repo-slug-${idx}">组 / 项目</label>` +
    `<input id="ac-repo-slug-${idx}" class="ac-input ac-mono" type="text" placeholder="chuckwu0/larkway" spellcheck="false" data-repo="slug" data-repo-idx="${idx}" value="${esc(repo.slug)}" />` +
    `</div>` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-repo-branch-${idx}">分支</label>` +
    `<input id="ac-repo-branch-${idx}" class="ac-input ac-mono" type="text" placeholder="main" spellcheck="false" data-repo="branch" data-repo-idx="${idx}" value="${esc(repo.branch)}" />` +
    `</div>` +
    `</div>` +
    `<div class="ac-field" style="margin-top:8px">` +
    `<label class="ac-label" for="ac-repo-url-${idx}">clone 地址 <span class="ac-optional">私有库必需</span></label>` +
    `<input id="ac-repo-url-${idx}" class="ac-input ac-mono" type="text" placeholder="git@your-gitlab.example.com:group/repo.git" spellcheck="false" data-repo="url" data-repo-idx="${idx}" value="${esc(repo.url)}" />` +
    `</div>` +
    `<button type="button" class="ac-repo-del" title="移除这个仓库" data-repo-idx="${idx}" aria-label="移除仓库 ${esc(repo.slug || idx + 1)}">` +
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
  // ① 用 gitlab_token_env 非空来判断「已配置」——新保存契约:值存后端,前端只知道「有/无」
  const gitlabConfigured = !!(bot.gitlab_token_env);
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
    `<p class="ac-access-desc">通过配一个 <b>GitLab 访问令牌</b> 来表达。读和改都用这一个令牌 —— <b>没有读 / 写之分</b>，agent 看任务自己定。不开 = 纯对话 / 自带知识答疑。</p>` +
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
    // 开启态:令牌 + 仓库
    `<div class="ac-access-fields" id="ac-access-fields" ${codeAccess ? "" : 'style="display:none"'}>` +
    `<div class="ac-field">` +
    `<label class="ac-label" for="ac-gitlab-token">GitLab Access Token</label>` +
    `<p class="ac-hint">把 GitLab access token 粘这里。只存本机 <code>~/.larkway/.env</code>（权限 0600），不回显、不外发。</p>` +
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
        `<input id="ac-gitlab-token" name="gitlab_token_value" class="ac-input ac-secret-input" type="password" autocomplete="new-password" placeholder="粘贴 GitLab access token（只存本机，不回显）" value="" />` +
        `</div>`
    ) +
    `</div>` +
    // 仓库列表
    `<div class="ac-repos-section">` +
    `<div class="ac-repos-header">` +
    `<span class="ac-repos-title">预热这些仓库</span>` +
    `<span class="ac-optional-badge">可选</span>` +
    `</div>` +
    `<p class="ac-hint">列出主要会用到的仓库 → 我们提前 clone 好，agent 一上来就有，提速。<b>留空也行</b> —— agent 会用上面的令牌自己判断需要哪些、自己 clone。</p>` +
    `<div class="ac-repos-empty" id="ac-repos-empty" ${repos.length ? 'style="display:none"' : ""}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/></svg>未列仓库 —— agent 会用令牌自己理解需要哪些、自己 clone。</div>` +
    `<div class="ac-repos-list" id="ac-repos-list" ${repos.length ? "" : 'style="display:none"'}>${repos.map((r, i) => acRepoRowHTML(i, r)).join("")}</div>` +
    `<button type="button" class="ac-add-repo-btn" id="ac-add-repo-btn">` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>` +
    ` 添加仓库` +
    `</button>` +
    `</div>` + // ac-repos-section
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
      const slug   = (row.querySelector("[data-repo='slug']")?.value ?? "").trim();
      const branch = (row.querySelector("[data-repo='branch']")?.value ?? "").trim() || "master";
      const url    = (row.querySelector("[data-repo='url']")?.value ?? "").trim();
      if (slug) {
        const r = { slug, branch };
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
  return Array.from(rows).map((row) => ({
    slug:   (row.querySelector("[data-repo='slug']")?.value ?? "").trim(),
    branch: (row.querySelector("[data-repo='branch']")?.value ?? "").trim() || "master",
    url:    (row.querySelector("[data-repo='url']")?.value ?? "").trim(),
    _idx:   parseInt(row.dataset.repoIdx ?? "-1", 10),
  }));
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
  // 聚焦新行 slug 输入
  list.querySelector(`#ac-repo-slug-${newIdx}`)?.focus();
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
function buildDetailHTML(id, bot, memContent, readonly) {
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
    readonly,
  );

  // 状态可操作化面板
  const effLiveKey = effLive(id);
  const statusActionPanel = !readonly && effLiveKey !== "serving"
    ? `<div id="detail-status-action">${buildStatusActionPanel(effLiveKey, null, false)}</div>`
    : `<div id="detail-status-action"></div>`;

  const centralReadonlyNotice = readonly
    ? `<div class="notice notice-warn">${ICONS.lock}<div>中心库的配置是只读的，改本地后用「晋升」推上去。</div></div>`
    : "";

  // 三层 AC 配置面板(edit 态)
  const acPanelHTML = buildAgentConfigHTML(bot, memContent, "edit");

  // 触点④(编辑表单顶部):底座选择卡(仅本机 edit 模式)
  // backendKickerChip 已在 kicker 展示;这里用完整 select 控件让用户改
  const _configuredBk4 = bot.backend || LK_BACKEND_DEFAULT;
  const _runningBk4 = state.runningBackends[id] ?? null;
  // BL-17:底座不一致 badge(详情区,md)— 只在本机 edit 模式 + bridge 在跑时显示
  const bkMismatchDetail =
    !readonly && state.bridge?.running && isBackendMismatch(_runningBk4, _configuredBk4)
      ? `<div style="margin-top:10px">${backendMismatchBadgeHTML(_runningBk4, _configuredBk4, "md")}` +
        `<span style="margin-left:8px;font-size:12px;color:var(--muted)">右上角重启服务后生效</span></div>`
      : "";
  const backendCardHTML = !readonly ? (
    `<div class="lk-bk-card" id="lk-bk-card">` +
    `<h4 class="lk-bk-card-title">${ICONS.box} 用哪个底座驱动它</h4>` +
    `<p class="lk-bk-card-desc">底座决定这个助手背后跑哪个 CLI agent。默认 Codex；切换后需重启服务生效。</p>` +
    lkBackendSelectHTML(_configuredBk4, false, `bk-edit-${id}`) +
    bkMismatchDetail +
    `</div>`
  ) : "";

  // 晋升区(仅本机非只读时显示)
  const promoteSection = !readonly ? `
<div class="form-section promote-section" id="promote-section">
  <h4 class="section-title">${ICONS.box} 交给公司统一管理（晋升）</h4>
  <p class="section-desc">${
    state.centralAvailable
      ? `已连上 <b style="font-family:ui-monospace,monospace;color:var(--text)">${esc(state.centralRepo?.name ?? "公司中心库")}</b>。先暂存只动本机副本；正式上传会推给全团队。`
      : "把这个本地助手交给公司中心库，其它机器就能拉到同一份。"
  }</p>
  <div class="promote-actions">
    <button class="btn${state.centralAvailable ? "" : " is-disabled"}" id="btn-promote-no-push" type="button"${state.centralAvailable ? "" : " disabled"}>${ICONS.box} 先暂存到本机副本（不上传）</button>
    <button class="btn btn-upload${state.centralAvailable ? "" : " is-disabled"}" id="btn-promote-push" type="button"${state.centralAvailable ? "" : " disabled"}>${ICONS.upload} 正式上传到公司中心库</button>
  </div>
  ${
    state.centralAvailable
      ? `<p class="promote-hint">${ICONS.warn}<span><b style="color:var(--destructive-text)">正式上传</b>会推送到团队仓库，所有人都拉得到，<b style="color:var(--destructive-text)">推后无法自动撤销</b> —— 点了会再确认一次。</span></p>`
      : `<div class="promote-connect-hint">${ICONS.link2}<span>得先<b>连接公司中心库</b>，这两个按钮才能用。</span><button type="button" id="btn-promote-connect" class="btn btn-primary btn-sm">${ICONS.link2} 去连接</button></div>`
  }
</div>
` : "";

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
  ${centralReadonlyNotice}

  ${buildRecentEventsPanelHTML(id)}

  <!-- 底座选择卡(触点④,本机 edit 模式顶部) -->
  ${backendCardHTML}

  <!-- 三层 Agent 配置面板 -->
  <div class="ac-panel-wrap" id="ac-panel-wrap">
    ${acPanelHTML}
  </div>

  ${promoteSection}
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
function wireDetailEvents(panel, id, bot, readonly) {
  wireRecentEvents(panel, id);
  // Wire status-action fix buttons (always, even in readonly — fix buttons only appear in non-readonly)
  const statusActionContainer = panel.querySelector("#detail-status-action");
  if (statusActionContainer) wireStatusActionButtons(statusActionContainer);
  // Wire restart panel buttons (timeout panel: logs/restart/rescan)
  wireRestartPanelButtons(panel);

  if (readonly) return;

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
          false,
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

  // promote 不推送
  const btnPromoteNoP = panel.querySelector("#btn-promote-no-push");
  if (btnPromoteNoP) {
    btnPromoteNoP.addEventListener("click", async () => {
      if (btnPromoteNoP.disabled) return;
      await doPromote(btnPromoteNoP, id, false, panel);
    });
  }

  // promote 并推送(不可逆外发 → LkUploadConfirm 样式二次确认弹窗)
  const btnPromoteP = panel.querySelector("#btn-promote-push");
  if (btnPromoteP) {
    btnPromoteP.addEventListener("click", async () => {
      if (btnPromoteP.disabled) return;
      const confirmed = await uploadConfirmDialog(
        { name: bot.name || id },
        state.centralRepo,
      );
      if (!confirmed) return;
      await doPromote(btnPromoteP, id, true, panel);
    });
  }

  // 未连接态:「去连接」→ 打开连接流弹窗(连上后 centralAvailable 变 true,晋升按钮启用)
  const btnPromoteConnect = panel.querySelector("#btn-promote-connect");
  if (btnPromoteConnect) {
    btnPromoteConnect.addEventListener("click", () => openConnectFlow());
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
  const readonly = false;
  body.innerHTML = buildHeroInner(id, { ...bot, name: vals.name, description: vals.description }, {
    name: vals.name ?? "",
    description: vals.description ?? "",
    chatCount,
    repoCount,
  }, readonly);
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
      const [slug, branch = "master"] = line.split(":").map((p) => p.trim());
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

/** commit hash → 短 7 位(便于运营报给工程师);取不到给原值。 */
function shortHash(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : (sha ?? "?");
}

/**
 * 晋升:暂存(本地 indigo)/ 正式上传(红,不可逆外发)。
 * 成功 → toast 给 commit 短 hash;失败按 kind 走「怎么办」:
 *   - behind → 要先同步别人的改动,带「去同步」入口
 *   - noperm → 没写权限,提示找工程师开权限
 *   - 其它   → 原样人话错误
 * 增强后的 POST /api/promote/:id:成功 { ok:true, commit, pushed };
 * 失败(HTTP 200){ ok:false, kind:"behind"|"noperm"|"other", error };
 * 未连接(HTTP 409){ error }。
 * @param {HTMLElement} btn
 * @param {string} id
 * @param {boolean} push  true=正式上传 / false=仅暂存本机
 * @param {HTMLElement|null} [panel]  详情面板根元素,有则在 promote-section 内联渲染结果
 */
async function doPromote(btn, id, push, panel, _extraBody) {
  const restore = btnLoading(btn, push ? "正在上传…" : "暂存中…");
  const body = { push, ...((_extraBody) ? _extraBody : {}) };
  const res = await api("POST", `/api/promote/${encodeURIComponent(id)}`, body);
  restore();

  // ⑧ 409 有两种情况:requiresConfirm(推 main 需要二次确认) 或 未连接中心库
  if (res.status === 409) {
    if (res.json?.requiresConfirm) {
      const branch = res.json.branch ?? "main";
      const confirmed = await confirmDialog({
        title: "推送到主干分支",
        body: `你正要晋升到公司主干 \`${branch}\`！确认？此操作会覆盖团队共享内容，推后无法自动撤销。`,
        confirmText: "确认晋升",
        confirmDanger: true,
      });
      if (confirmed) {
        await doPromote(btn, id, push, panel, { confirmMain: true });
      }
      return;
    }
    toast("未连接公司中心库,无法晋升。先在顶部「公司中心库」里连接一次。", "error");
    return;
  }

  // 网络/服务器层错误(无 json.ok 字段)
  if (!res.ok && res.json?.ok === undefined) {
    toast(`失败：${res.json?.error ?? res.status}`, "error");
    return;
  }

  const j = res.json ?? {};

  // 业务失败(HTTP 200 + ok:false + kind)
  if (j.ok === false) {
    if (j.kind === "behind") {
      // 落后:内联渲染 amber 失败面板 + 「先同步再上传」按钮
      renderPromoteFailPanel(panel, "behind", null, async () => {
        if (state.mode !== "central") await switchContext("central");
        if (state.centralConnected) await doCentralSync();
      });
      return;
    }
    if (j.kind === "noperm") {
      // 无权限:内联渲染红色失败面板 + 「重试」按钮
      renderPromoteFailPanel(panel, "noperm", j.error ?? null, async () => {
        await doPromote(btn, id, push, panel);
      });
      return;
    }
    // 其它失败:内联渲染红色失败面板
    renderPromoteFailPanel(panel, "other", j.error ?? null, async () => {
      await doPromote(btn, id, push, panel);
    });
    return;
  }

  // 成功:commit 短 hash + 是否真推到了中心库
  const commit = shortHash(j.commit ?? j.sha);
  if (j.pushed) {
    const botName = state.bots.find((b) => b.id === id)?.name ?? id;
    const repoPath = state.centralRepo?.path ?? "bots/";
    renderPromoteSuccessPanel(panel, botName, commit, repoPath);
  } else {
    toast(`已暂存到本机副本(未上传)· commit ${commit}`, "ok");
  }
}

/**
 * 在 promote-section 内渲染上传成功内联面板(复刻 LkPromoteCard phase==='success')。
 * 绿色 check 徽章 + 「已上传」标题 + larkway sync 提示 + 路径/commit + 「去中心库看看」。
 * @param {HTMLElement|null} panel
 * @param {string} botName
 * @param {string} commit  短 7 位 hash
 * @param {string} repoPath  "bots/" 之类
 */
function renderPromoteSuccessPanel(panel, botName, commit, repoPath) {
  const section = panel?.querySelector(".promote-section");
  if (!section) { toast(`已上传「${esc(botName)}」到公司中心库 · commit ${commit}`, "ok"); return; }

  const gC = LIVE_COLOR.serving, gE = LIVE_EDGE.serving, gS = LIVE_SOFT.serving, gT = LIVE_TEXT.serving;
  const checkSVG = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:19px;height:19px;stroke-width:2.4"><path d="M20 6 9 17l-5-5"/></svg>`;
  const arrowSVG = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

  section.innerHTML =
    `<h4 class="section-title">${ICONS.box} 交给公司统一管理（晋升）</h4>` +
    `<div class="promote-result-panel" style="background:${gS};border:1px solid ${gE}">` +
    `<span class="prp-badge" style="border:1px solid ${gE};color:${gC}">${checkSVG}</span>` +
    `<div class="prp-body">` +
    `<div class="prp-title" style="color:${gT}">已上传「${esc(botName)}」到中心库</div>` +
    `<div class="prp-desc">同事 <code style="font-family:ui-monospace,monospace;background:#fff;padding:1px 5px;border-radius:5px;border:1px solid var(--border)">larkway sync</code> 一下就能拉到这一份了。</div>` +
    `<div class="prp-meta">` +
    `<span style="display:inline-flex;align-items:center;gap:5px">${ICONS.folder} ${esc(repoPath)}${esc(botName)}/</span>` +
    `<span>·</span>` +
    `<span style="font-family:ui-monospace,monospace">commit ${esc(commit)}</span>` +
    `</div>` +
    `<div class="prp-actions">` +
    `<button class="btn" id="prp-go-central" type="button" style="background:var(--br-soft);border:1px solid var(--br-edge);color:var(--br-text);font-size:13.5px;padding:8px 15px;border-radius:9px">去「公司中心库」看看 ${arrowSVG}</button>` +
    `</div>` +
    `</div>` +
    `</div>`;

  section.querySelector("#prp-go-central")?.addEventListener("click", () => switchContext("central"));
}

/**
 * 在 promote-section 内渲染上传失败内联面板(复刻 LkPromoteCard phase==='failed')。
 * behind=amber 「推不上去」;noperm/other=红「上传失败」。
 * @param {HTMLElement|null} panel
 * @param {"behind"|"noperm"|"other"} kind
 * @param {string|null} errorMsg
 * @param {function():Promise<void>} onAction  主 CTA 点击回调(同步 / 重试)
 */
function renderPromoteFailPanel(panel, kind, errorMsg, onAction) {
  const section = panel?.querySelector(".promote-section");
  const behind = kind === "behind";

  if (!section) {
    // 无 panel 降级 toast
    if (behind) {
      toast("推不上去 —— 中心库有别人的新改动,得先同步再上传。", "error");
    } else {
      toast(`上传失败${errorMsg ? "：" + errorMsg : ""}`, "error");
    }
    return;
  }

  // amber(behind) or red(noperm/other)
  const sc = behind
    ? { c: LIVE_COLOR.degraded, soft: LIVE_SOFT.degraded, edge: LIVE_EDGE.degraded, text: LIVE_TEXT.degraded }
    : { c: "#dc2626", soft: "#fef2f2", edge: "#fecaca", text: "#b91c1c" };

  const warnSVG = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`;
  const pullSVG = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px"><path d="M12 3v12M8 11l4 4 4-4M4 21h16"/></svg>`;
  const refreshSVG = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>`;

  const titleText = behind ? "推不上去 —— 中心库有新改动" : "上传失败";
  const descText = behind
    ? "别人在你之前也晋升了东西。你得先把那些「同步」拉下来，跟你的合到一起，再上传一次。"
    : (errorMsg
      ? esc(errorMsg)
      : "这台机器可能没有往团队仓库写的权限。让工程师给你开一下，或换一台有权限的机器再试。");
  const ctaLabel = behind ? "先同步，再上传" : "重试";
  const ctaIcon = behind ? pullSVG : refreshSVG;

  section.innerHTML =
    `<h4 class="section-title">${ICONS.box} 交给公司统一管理（晋升）</h4>` +
    `<div class="promote-result-panel" style="background:${sc.soft};border:1px solid ${sc.edge}">` +
    `<span class="prp-badge" style="border:1px solid ${sc.edge};color:${sc.c}">${warnSVG}</span>` +
    `<div class="prp-body">` +
    `<div class="prp-title" style="color:${sc.text}">${titleText}</div>` +
    `<p class="prp-desc">${descText}</p>` +
    `<div class="prp-actions">` +
    `<button class="btn" id="prp-cta" type="button" style="background:var(--br);border:none;color:#fff;font-size:13.5px;padding:8px 15px;border-radius:9px">${ctaIcon} ${ctaLabel}</button>` +
    `<button class="btn" id="prp-detail" type="button" style="border:1px solid var(--border);background:#fff;color:var(--muted);font-size:13.5px;padding:8px 15px;border-radius:9px">${ICONS.code} 查看详情</button>` +
    `</div>` +
    `</div>` +
    `</div>`;

  section.querySelector("#prp-cta")?.addEventListener("click", () => { void onAction(); });
  section.querySelector("#prp-detail")?.addEventListener("click", () => {
    const detail = errorMsg ?? (behind ? "中心库有新改动,需先同步。" : "无权限写入团队仓库。");
    toast(detail, "error");
  });
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
 * central 只读模式:操作按钮隐藏(本机操作无意义)。
 */
function renderServiceIndicator() {
  const container = document.getElementById("bridge-indicator");
  if (!container) return;

  const b = state.bridge;
  const running = b?.running ?? false;
  const readonly = state.mode === "central";

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
  // 报警状态条;只读上下文(中心库)只是省掉「本机操作」按钮,绝不把状态改成绿色。
  const svcBtn = (id, borderColor, icon, label, action) =>
    readonly
      ? ""
      : `<button type="button" class="lk-svc-action-btn" id="${id}" ` +
        `style="display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;` +
        `border:none;border-left:1px solid ${borderColor};background:${BR.c};color:#fff;` +
        `font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">` +
        icon + label +
        `</button>`;

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

  // ── BL-18:中心库只读时不显重启过渡态(本机运行概念) ─────────────────────────
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

  // 中心库只读 → 旧版绿 chip(无按钮)
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
    await refreshBridgeStatus();
    await pollStatus();
    if (state.selected) rerenderStatusAction(state.selected);
    return;
  }

  // ── BL-18:POST 成功后 → 进入 restarting 过渡态(仅 restart 动作) ─────────
  if (action === "restart") {
    // 重置任何旧的机器状态,进入 restarting
    stopRestartTicker();
    state.restart = { status: "restarting", startedAt: Date.now(), elapsed: 0 };
    toast("正在重启服务 —— 好了会自动转回正常,不用重复点", "info");
    // 全量刷新三触点(顶栏+名册+hero)
    renderServiceIndicator();
    renderBotList();
    if (state.selected) refreshDetailHero();
    // 启动 1s ticker 刷新已用时显示
    startRestartTicker();
  } else {
    toast("服务已启动", "ok");
  }

  // Refresh bridge + liveness
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
// 行为:上下文切换
// ---------------------------------------------------------------------------

async function switchContext(mode) {
  if (mode === state.mode) return;

  // ── 切到公司中心库 ──────────────────────────────────────────────────────
  if (mode === "central") {
    // 先确认连接状态 —— 未连接也允许进入(进去看的是连接引导卡)。
    await loadCentralStatus();
    if (!state.centralConnected) {
      // 未连接:不调 POST /api/context(后端会 409),只在前端切视图显引导。
      state.mode = "central";
      state.selected = null;
      state.bots = [];
      renderContextSwitch();
      renderCentralSourceBar();
      renderBotList();
      renderBotDetail(null);
      renderServiceIndicator();
      return;
    }
    // 已连接:正常切 context
    const res = await api("POST", "/api/context", { mode });
    if (!res.ok) {
      toast(`切换失败：${res.json?.error ?? res.status}`, "error");
      return;
    }
    state.mode = res.json?.mode ?? mode;
    state.selected = null;
    renderContextSwitch();
    renderCentralSourceBar();
    renderBotDetail(null);
    await loadBots();
    // 进中心库后台算一次同步预览,驱动来源条「N 项可更新 / 已是最新」
    void refreshCentralSyncState();
    renderServiceIndicator();
    return;
  }

  // ── 切回本机 ────────────────────────────────────────────────────────────
  const res = await api("POST", "/api/context", { mode });
  if (!res.ok) {
    toast(`切换失败：${res.json?.error ?? res.status}`, "error");
    return;
  }
  state.mode = res.json?.mode ?? mode;
  state.selected = null;
  renderContextSwitch();
  renderCentralSourceBar();
  // 清空详情
  renderBotDetail(null);
  await loadBots();
  // 切换上下文后刷新 bridge 指示(central 模式下按钮要隐藏)
  renderServiceIndicator();
}

/**
 * 强制进入「已连接的公司中心库」视图并刷新名册 + 来源条。
 * 用于连接成功后(此时 mode 可能已是 central,switchContext 会 no-op)。
 */
async function enterCentralConnected() {
  await loadCentralStatus();
  if (!state.centralConnected) {
    // 极端情况下连接态丢失 → 退回引导
    state.mode = "central";
    state.selected = null;
    state.bots = [];
    renderContextSwitch();
    renderCentralSourceBar();
    renderBotList();
    renderBotDetail(null);
    return;
  }
  // 确保后端上下文也切到 central(幂等;失败不阻断前端展示)
  await api("POST", "/api/context", { mode: "central" });
  state.mode = "central";
  state.selected = null;
  renderContextSwitch();
  renderCentralSourceBar();
  renderBotDetail(null);
  await loadBots();
  void refreshCentralSyncState();
  renderServiceIndicator();
}

/**
 * 后台算一次同步预览,只为驱动来源条状态(不弹 modal)。
 * 失败静默(来源条退回「检查更新」)。
 */
async function refreshCentralSyncState() {
  if (state.mode !== "central" || !state.centralConnected) return;
  const res = await api("GET", "/api/central/sync/preview");
  if (!res.ok) {
    state.centralSyncState = "unknown";
    renderCentralSourceBar();
    return;
  }
  // 只数会真正应用的增量(added + updated);removed(本机自建未晋升)本机自管不删,见上。
  const total =
    (res.json?.added?.length ?? 0) +
    (res.json?.updated?.length ?? 0);
  state.centralUpdateCount = total;
  state.centralSyncState = total > 0 ? "updates" : "fresh";
  renderCentralSourceBar();
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

  // 中心库:只读名册走 GET /api/central/bots(含 by/updated/commit),不显在线/心跳。
  if (state.mode === "central") {
    const ok = await loadCentralBots();
    if (!ok) {
      if (!opts.silent) toast("加载中心库名册失败", "error");
      state.bots = [];
    } else {
      // 归一化成名册行需要的 {id,name,description,avatar}(中心库 yaml 现在带飞书头像,用它)
      state.bots = state.centralBots.map((b) => ({
        id: b.id,
        name: b.name ?? b.id,
        description: b.desc ?? "",
        avatar: b.avatar ?? null,
        backend: b.backend || LK_BACKEND_DEFAULT,
      }));
      // 中心库头像并入 state.avatars,名册行 + 详情区都能用(与本机分支一致)
      for (const b of state.centralBots) {
        if (b && typeof b.id === "string" && b.avatar) state.avatars[b.id] = b.avatar;
      }
    }
    renderBotList();
    return;
  }

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
// 行为:从中心同步(先 dryRun,再二次确认)
// ---------------------------------------------------------------------------

async function doSync() {
  const btn = document.getElementById("btn-sync");
  const restore = btnLoading(btn, "拉取预览中…");
  const dryRes = await api("POST", "/api/sync", { dryRun: true });
  restore();
  if (!dryRes.ok) {
    toast(`同步预览失败：${dryRes.json?.error ?? dryRes.status}`, "error");
    return;
  }
  const plan = dryRes.json?.plan ?? { added: [], updated: [], removed: [], unchanged: [] };
  showSyncModal(plan);
}

function showSyncModal(plan) {
  const backdrop = document.getElementById("modal-backdrop");
  const body = document.getElementById("modal-body");
  const footer = document.getElementById("modal-footer");
  if (!backdrop || !body || !footer) return;

  const rows = [
    { label: "新增", items: plan.added, cls: "ok" },
    { label: "更新", items: plan.updated, cls: "warn" },
    { label: "本机独有（中心库没有，默认保留）", items: plan.removed, cls: "dim" },
    { label: "无变化", items: plan.unchanged, cls: "dim" },
  ];

  let html = "";
  for (const row of rows) {
    if (!Array.isArray(row.items) || row.items.length === 0) continue;
    html += `<div class="sync-group"><span class="sync-label sync-${row.cls}">${esc(row.label)}（${row.items.length}）</span>`;
    html += `<ul class="sync-list">${row.items.map((id) => `<li>${esc(id)}</li>`).join("")}</ul></div>`;
  }
  if (!html) html = `<p class="dim">没有变化，本机已与公司中心库一致。</p>`;

  body.innerHTML = html;
  footer.innerHTML = `
    <label class="prune-label">
      <input type="checkbox" id="chk-prune" />
      同时删除本机独有的助手（prune）
    </label>
    <div class="modal-btns">
      <button class="btn" id="modal-cancel" type="button">取消</button>
      <button class="btn btn-primary" id="modal-confirm" type="button">确认拉取</button>
    </div>
  `;

  backdrop.hidden = false;

  document.getElementById("modal-cancel")?.addEventListener("click", () => {
    backdrop.hidden = true;
  });

  document.getElementById("modal-confirm")?.addEventListener("click", async () => {
    const prune = document.getElementById("chk-prune")?.checked ?? false;
    const confirmBtn = document.getElementById("modal-confirm");
    const restore = btnLoading(confirmBtn, "拉取中…");
    const res = await api("POST", "/api/sync", { dryRun: false, prune });
    restore();
    backdrop.hidden = true;
    if (!res.ok) {
      toast(`同步失败：${res.json?.error ?? res.status}`, "error");
      return;
    }
    const result = res.json?.result ?? {};
    const parts = [];
    if ((result.applied ?? []).length) parts.push(`应用 ${result.applied.length}`);
    if ((result.pruned ?? []).length) parts.push(`删除 ${result.pruned.length}`);
    if ((result.skipped ?? []).length) parts.push(`跳过 ${result.skipped.length}`);
    toast(`同步完成。${parts.join("、") || "无变化"}`, "ok");
    if ((res.json?.warnings ?? []).length) {
      for (const w of res.json.warnings) console.warn("[larkway sync]", w);
    }
    await loadBots();
    // 如果当前选中 bot 已被删除,清空详情
    if (state.selected && !state.bots.find((b) => b.id === state.selected)) {
      state.selected = null;
      renderBotDetail(null);
    }
  });
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
    lkBackendSelectHTML(LK_BACKEND_DEFAULT, false, "ob2-bk") +
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
  // 上下文切换
  for (const btn of document.querySelectorAll(".ctx-btn")) {
    btn.addEventListener("click", () => switchContext(btn.dataset.mode));
  }

  // 刷新列表
  document.getElementById("btn-refresh")?.addEventListener("click", () => loadBots());

  // 从中心同步
  document.getElementById("btn-sync")?.addEventListener("click", () => doSync());

  // 添加新助手:页面内扫码开通(POST /api/onboard/start → 轮询 → 落盘)
  document.getElementById("btn-add")?.addEventListener("click", () => {
    if (state.mode === "central") {
      toast("「公司中心库」是只读的，新建助手请先切到「本机」。", "warn");
      return;
    }
    openOnboardModal();
  });

  // 同步预览 modal 背景点击关闭
  document.getElementById("modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
    }
  });

  // 连接公司中心库 modal 背景点击关闭(connecting 态正在测网络,不打断)
  document.getElementById("connect-backdrop")?.addEventListener("click", (e) => {
    if (e.target !== e.currentTarget) return;
    if (document.getElementById("connect-modal")?.querySelector(".spinner-lg")) return;
    closeConnectFlow();
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

  // Esc 关闭 modal（同步预览直接关；添加新助手走取消清理；连接弹窗 connecting 态不打断）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const ob = document.getElementById("onboard-backdrop");
    if (ob && !ob.hidden) {
      closeOnboardModal();
      return;
    }
    const cb = document.getElementById("connect-backdrop");
    if (cb && !cb.hidden) {
      if (document.getElementById("connect-modal")?.querySelector(".spinner-lg")) return;
      closeConnectFlow();
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

  // 拉初始上下文状态(mode + centralAvailable)
  const ctxRes = await api("GET", "/api/context");
  if (ctxRes.ok) {
    state.mode = ctxRes.json?.mode ?? "local";
    state.centralAvailable = ctxRes.json?.centralAvailable ?? false;
    const ver = ctxRes.json?.version;
    const verEl = document.getElementById("brand-ver");
    if (verEl && ver) verEl.textContent = "v" + ver;
  }

  // 拉中心库连接状态(driver:连接引导 vs 已连接名册 + 来源条)
  await loadCentralStatus();

  renderContextSwitch();
  renderCentralSourceBar();

  // 拉 backend 注册表(驱动底座选择就绪态;失败静默)
  void loadBackends();

  // 拉 bot 列表(先于首次状态轮询,确保左侧条目存在好让圆点落上去)
  await loadBots();

  // 若初始就处于已连接的中心库上下文,后台算同步预览驱动来源条
  if (state.mode === "central" && state.centralConnected) {
    void refreshCentralSyncState();
  }

  // 拉 bridge 服务状态并渲染顶栏指示
  await refreshBridgeStatus();

  // 首次拉状态 + 每 15s 轮询(实时在线状态可视化)
  await pollStatus();
  setInterval(pollStatus, 15000);
}

/**
 * 拉 GET /api/status 并刷新状态 UI(顶栏 pill + 左侧圆点 + 详情横幅)。
 * 失败/非 2xx → renderStatus(null) 降级成「状态未知」灰点,绝不抛错。
 */
async function pollStatus() {
  const res = await api("GET", "/api/status");
  renderStatus(res.ok ? res.json : null);
}

boot();
