/**
 * readinessBanner.mjs — 首屏启动 Readiness 消费者（D5 §2.4/§4，2026-08-04）。
 *
 * 【功能链】
 *   index.mjs init() 尾部 initReadinessBanner() → 轮询 GET /api/readiness（后端阶段机单源）
 *   → ①chatInteractive=false 时给聊天输入区上「正在准备基础聊天…」软遮罩（禁输入+文案）
 *   → ②backgroundPreload 进行中/有 degraded 时显示右下可折叠卡「正在后台准备 N 个扩展」
 *      + 失败 Part 名称 + 重试入口（POST /api/loadpart → 成功后后端 markPartPreloadRecovered 摘 degraded）
 *   → 全就绪（chatInteractive && preload done && 无 degraded）自动移除并停止轮询。
 *
 * 【why】launcher 现在 shellReady 就开浏览器（黑屏根除），代价是页面打开时该 user 的
 *   chat/memory Part 可能仍在生命周期中——不加诚实反馈就是把"黑屏"换成"点了没反应"。
 *   本模块把后端真值渲染给用户，绝不自宣布任何"已就绪"。
 *
 * 【失败开放（防新死锁）】readiness 端点不可达/旧后端 404/字段缺失 → 立即解除遮罩、隐藏卡片：
 *   遮罩只能由「后端明确说没准备好」维持；另有 90s 硬上限强制解除（宁可让用户撞到慢接口报错，
 *   也不许一个观测面把输入锁死——观测面自己成为故障点=比没有更糟）。
 *
 * 【关联链】← index.mjs（唯一 init 调用点） → /api/readiness（endpoints.mjs）→ readiness.mjs 注册表
 * 【影响范围】只读端点+自建 DOM（挂 body，不改 index.html）；#send_textarea 的 disabled/placeholder
 *   在遮罩期被本模块接管，解除时恢复原值。
 */
import { apiFetch } from "../transport/api-client.mjs";
import { escapeHtml } from "../state/utils.mjs"; // T7 收口:HTML 转义唯一权威实现,禁本地副本

const POLL_MS_ACTIVE = 2000;   // 未就绪期
const POLL_MS_SETTLED = 10000; // 只剩 degraded 观察期
const MASK_HARD_LIMIT_MS = 90_000; // 遮罩硬上限（失败开放）

let _timer = null;
let _startedAt = 0;
let _maskOn = false;
let _inputPrev = null; // {disabled, placeholder} 遮罩前原值

function _input() { return document.getElementById("send_textarea"); }

function _setMask(on, label) {
  const input = _input();
  if (!input) return;
  if (on && !_maskOn) {
    _inputPrev = { disabled: input.disabled, placeholder: input.placeholder };
    input.disabled = true;
    input.placeholder = label || "正在准备基础聊天…";
    _maskOn = true;
  } else if (on && _maskOn) {
    input.placeholder = label || input.placeholder;
  } else if (!on && _maskOn) {
    input.disabled = _inputPrev ? _inputPrev.disabled : false;
    input.placeholder = _inputPrev ? _inputPrev.placeholder : "";
    _inputPrev = null;
    _maskOn = false;
  }
}

const _esc = escapeHtml; // alias(与 companion.mjs _capEsc 同范式)

function _card() {
  let el = document.getElementById("readiness-preload-card");
  if (el) return el;
  el = document.createElement("details");
  el.id = "readiness-preload-card";
  el.className = "fixed bottom-2 left-2 z-40 bg-base-200/95 border border-base-300 rounded-lg shadow px-3 py-2 text-xs max-w-[320px]";
  el.innerHTML = '<summary id="readiness-preload-summary" class="cursor-pointer select-none opacity-80"></summary>' +
    '<div id="readiness-preload-body" class="mt-1 max-h-40 overflow-y-auto space-y-1"></div>';
  document.body.appendChild(el);
  // 重试委托（单监听）：POST /api/loadpart，结果如实 toast（loadPart 退避/熔断错误原样显示）
  el.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.("[data-retry-part]");
    if (!btn) return;
    ev.preventDefault();
    btn.disabled = true;
    try {
      await apiFetch("/api/loadpart", { method: "POST", body: { partpath: btn.dataset.retryPart } });
      window._beiluToast?.(`扩展 ${btn.dataset.retryPart} 重试加载成功`, "success");
    } catch (e) {
      window._beiluToast?.(`扩展重试失败: ${e?.message || e}`, "error");
      btn.disabled = false;
    }
  });
  return el;
}

function _renderCard(snap) {
  const bp = snap.backgroundPreload;
  const counts = bp?.counts || {};
  const degraded = bp?.degraded || [];
  const running = bp?.state === "running";
  if (!running && !degraded.length) {
    document.getElementById("readiness-preload-card")?.remove();
    return;
  }
  const el = _card();
  const summary = el.querySelector("#readiness-preload-summary");
  const body = el.querySelector("#readiness-preload-body");
  const total = counts.total || 0;
  const loaded = counts.loaded || 0;
  if (summary) {
    summary.textContent = running
      ? `正在后台准备 ${total} 个扩展（${loaded}/${total}）${degraded.length ? ` · ${degraded.length} 个失败` : ""}`
      : `${degraded.length} 个扩展加载失败（点开重试）`;
  }
  if (body) {
    body.innerHTML = degraded.length
      ? degraded.map((d) =>
        `<div class="flex items-center gap-1"><span class="truncate flex-1 text-error/80" title="${_esc(d.error)}">${_esc(d.partpath)}</span>` +
        `<button class="btn btn-ghost btn-xs" data-retry-part="${_esc(d.partpath)}">重试</button></div>`).join("")
      : '<span class="opacity-50">扩展加载中，全部完成后本卡片自动消失。</span>';
  }
}

async function _tick() {
  let snap = null;
  try { snap = await apiFetch("/api/readiness", { timeout: 5000 }); } catch { snap = null; }
  // 失败开放：端点不可达/旧后端/最小快照（无 chatInteractive 字段）→ 解除遮罩、撤卡、停表
  if (!snap || !("chatInteractive" in snap)) {
    _setMask(false);
    document.getElementById("readiness-preload-card")?.remove();
    _timer = null;
    return;
  }
  const hardLimit = Date.now() - _startedAt > MASK_HARD_LIMIT_MS;
  // 遮罩只由「后端明确 false」维持；null(探针未注入/未登录)不遮——诚实但不锁死
  _setMask(snap.chatInteractive === false && !hardLimit, "正在准备基础聊天…");
  _renderCard(snap);
  const allDone = snap.chatInteractive !== false &&
    snap.backgroundPreload?.state !== "running" &&
    !(snap.backgroundPreload?.degraded || []).length;
  if (allDone) { _timer = null; return; }
  const settled = snap.chatInteractive !== false && snap.backgroundPreload?.state !== "running";
  _timer = setTimeout(_tick, settled ? POLL_MS_SETTLED : POLL_MS_ACTIVE);
}

/** index.mjs init() 尾部调用一次；幂等。 */
export function initReadinessBanner() {
  if (_timer || _startedAt) return;
  _startedAt = Date.now();
  _tick();
}
