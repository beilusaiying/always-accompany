/**
 * memAiBubble.mjs — 共享「记忆 AI 输出」气泡渲染原语
 *
 * 功能链：
 *   renderMemAiBubble(output, opts) → 根据 output.type / output.status 构建气泡 HTMLElement
 *   → type==="content"：纯文本流片段（无状态头）
 *   → 其它 type：状态图标（⏳/✅/❌）+ 预设名 + 轮次/耗时 + 回复预览 + thinking/operations 折叠区
 *   → 调用方 append 到各自容器（增量 append 或列表重渲均适用）
 *
 * why（合并 v4 / 消除「三套渲染器」病症）：
 *   index.mjs renderMemoryAIOutputs（#1）与 tokenProgressBar showP1Panel（#3）同 endpoint、同队列 shape（aiRunner），
 *   气泡绘制完全重复；提取为共享原语后两者只保留各自的观察者/轮询/可见性门控逻辑。
 *   memoryPresetChat（#2）是交互式聊天台（user/ai/system + 头像），本质不同，不并入。
 *
 * 关联链：
 *   ← index.mjs（renderMemoryAIOutputs：增量 append 气泡）
 *   ← tokenProgressBar.mjs（showP1Panel / showCompressPanel：压缩面板内气泡列表）
 *   → shared/state/utils.mjs（escapeHtml：T7 收口，替原本地 escapeMemHtml——本地版缺单引号转义=XSS 面）。
 *
 * 影响范围：
 *   返回独立 HTMLElement，不操作全局 DOM；
 *   无后端请求，无 localStorage，无事件派发。
 *
 * 使用效果：
 *   记忆 AI 运行状态（running/done/error）以统一样式气泡呈现；
 *   thinking/operations 内容可折叠展开；replyMaxLen 超长自动截断。
 */

// T7：原 escapeMemHtml 缺单引号转义（XSS 面），且无外部消费者，纯删除后统一走唯一权威 escapeHtml（5 字符含单引号）。
import { escapeHtml } from "../state/utils.mjs";

// 状态灯：daisyUI 5 status 组件替代 emoji（⏳✅❌ 系统 emoji 光泽感重且跨平台不一致）。
//   running=琥珀呼吸(animate-pulse) / done=绿 / error=红叠 ping 扩散（inline grid-area 双层叠放）。
const _STATUS = {
  running: { html: `<span class="status status-warning animate-pulse" title="运行中"></span>` },
  done: { html: `<span class="status status-success" title="完成"></span>` },
  error: { html: `<span style="display:inline-grid" title="错误"><span class="status status-error animate-ping" style="grid-area:1/1"></span><span class="status status-error" style="grid-area:1/1"></span></span>` },
};
const _STATUS_FALLBACK = { html: `<span class="status" style="opacity:.4" title="未知状态"></span>` };

/**
 * 渲染一条 AI 输出气泡。
 * @param {object} output 队列条目 {presetName,reply,content,thinking,status,operations,error,totalRounds,totalTimeMs,timeMs,timestamp,type}
 * @param {object} [opts] {showThinking,showOperations,expandable,replyMaxLen}
 * @returns {HTMLDivElement}
 */
export function renderMemAiBubble(output, opts = {}) {
  const {
    showThinking = true,
    showOperations = true,
    expandable = true,
    replyMaxLen = 200,
  } = opts;
  const o = output || {};

  const el = document.createElement("div");
  el.className = "mem-ai-bubble";
  el.style.cssText =
    "border-bottom:1px solid rgba(255,255,255,0.08);padding:10px 0;font-size:12px;";

  // 纯流式 content 片段（#1 的 type==="content"）：只显示文本，无状态头
  if (o.type === "content") {
    const c = document.createElement("div");
    c.style.cssText =
      "white-space:pre-wrap;word-break:break-word;line-height:1.4;opacity:0.85;";
    c.textContent = o.content || "";
    el.appendChild(c);
    return el;
  }

  const st = _STATUS[o.status] || _STATUS_FALLBACK;

  // 头部：状态图标 + 预设名 + 轮次/耗时/时间
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:6px;";
  const roundInfo = o.totalRounds ? ` · ${o.totalRounds}轮` : "";
  const timeMsInfo = o.totalTimeMs
    ? ` · ${(o.totalTimeMs / 1000).toFixed(1)}s`
    : o.timeMs
      ? ` · ${o.timeMs}ms`
      : "";
  const timeStr = o.timestamp ? new Date(o.timestamp).toLocaleTimeString() : "";
  header.innerHTML =
    st.html +
    `<span style="font-weight:600;">${escapeHtml(o.presetName || "记忆AI")}</span>` +
    `<span style="opacity:0.5;margin-left:auto;font-size:11px;">${escapeHtml(timeStr + roundInfo + timeMsInfo)}</span>`;
  el.appendChild(header);

  // 错误
  if (o.error) {
    const e = document.createElement("div");
    e.style.cssText = "color:var(--beilu-error);font-size:11px;margin-top:4px;";
    e.textContent = `错误: ${o.error}`;
    el.appendChild(e);
  }

  // thinking（可折叠，<details>）
  if (showThinking && o.thinking) {
    const t = document.createElement("details");
    t.style.cssText = "margin-top:4px;font-size:11px;";
    const sm = document.createElement("summary");
    sm.style.cssText = "cursor:pointer;opacity:0.55;";
    sm.innerHTML = '<i data-ic="thought"></i> 思考过程';
    t.appendChild(sm);
    const tb = document.createElement("div");
    tb.style.cssText =
      "margin-top:4px;padding:4px 8px;background:color-mix(in srgb, var(--beilu-accent) 10%, transparent);border-radius:4px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;opacity:0.8;";
    tb.textContent = o.thinking;
    t.appendChild(tb);
    el.appendChild(t);
  }

  // operations（工具操作记录）
  if (showOperations && Array.isArray(o.operations) && o.operations.length > 0) {
    const ops = document.createElement("div");
    ops.style.cssText =
      "margin-top:6px;padding:6px 8px;background:rgba(255,255,255,0.05);border-radius:4px;font-size:11px;max-height:80px;overflow-y:auto;";
    ops.innerHTML = o.operations
      .map(
        (op) =>
          `<div style="opacity:0.7;">${escapeHtml(op.tool || op.type || "?")}: ${escapeHtml(op.query || op.path || op.keyword || JSON.stringify(op).substring(0, 60))}</div>`,
      )
      .join("");
    el.appendChild(ops);
  }

  // 回复正文（escapeHtml + pre-wrap + 可选展开全文）
  const reply = o.reply != null ? o.reply : o.content != null ? o.content : "";
  const hasReply = reply !== "" || o.status === "done";
  if (hasReply) {
    const isLong = expandable && reply.length > replyMaxLen;
    const body = document.createElement("div");
    body.className = "mem-ai-bubble-reply";
    body.style.cssText =
      "margin-top:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.4;max-height:200px;overflow-y:auto;";
    body.textContent = isLong
      ? reply.substring(0, replyMaxLen) + "…"
      : reply || "(无内容)";
    el.appendChild(body);
    if (isLong) {
      const btn = document.createElement("button");
      btn.style.cssText =
        "margin-top:4px;border:none;background:none;color:var(--beilu-accent);cursor:pointer;font-size:11px;padding:0;";
      btn.textContent = `展开全部 (${reply.length}字)`;
      btn.addEventListener("click", () => {
        body.textContent = reply;
        body.style.maxHeight = "400px";
        btn.remove();
      });
      el.appendChild(btn);
    }
  }

  return el;
}
