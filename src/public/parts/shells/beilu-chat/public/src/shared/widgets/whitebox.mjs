/**
 * whitebox.mjs — 前端白盒线路追踪 + 异常检测
 *
 * 功能链：
 *   前端执行点 wbTrace(line, node, data) → 写环形缓冲 _ring（500 条）+ console.log "[wb:line:node]"
 *   → backendMonitor.mjs console 拦截 → 自动出现在「运行时日志」面板
 *   wbDetect(line, node, ok, msg) → ok=false 时写 _ring + console.warn
 *   websocket.mjs 收 wb_trace WS 事件 → wbIngestBackend(payload) → 同步进 _ring + console
 *
 * why：
 *   前后端链路追踪统一走 console.log "[wb:...]" 格式，被 backendMonitor 拦截后统一展示，无需新面板；
 *   环形缓冲限 500 条，防止内存无限增长；
 *   wbDetect 用于关键节点断言（如消息解析、WS 连接），异常立即可见于监控面板。
 *
 * 关联链：
 *   ← websocket.mjs（wbIngestBackend：接收后端广播 wb_trace）
 *   ← tokenProgressBar.mjs、iframeRenderer.mjs 等（wbDetect 断言检测）
 *   → backendMonitor.mjs（console 拦截后展示 wb 日志）
 *   无后端请求，无 DOM 操作。
 *
 * 影响范围：
 *   console.log/warn 输出（被 backendMonitor 拦截），不影响业务逻辑；
 *   setWhiteboxEnabled(false) 可全局关闭追踪，减少 console 噪声。
 *
 * 使用效果：
 *   线路追踪日志实时出现在 backendMonitor「运行时日志」面板；
 *   wbDetect 断言失败时面板出现警告标记，便于定位链路断点。
 */

const _ring = [];
const RING_MAX = 500;
let _seq = 0;
let _enabled = true;

export function setWhiteboxEnabled(on) { _enabled = !!on; }
export function isWhiteboxEnabled() { return _enabled; }
export function getWhiteboxRing() { return _ring.slice(); }

function push(entry) {
  _ring.push(entry);
  if (_ring.length > RING_MAX) _ring.shift();
}

/** 前端执行点追踪 */
export function wbTrace(line, node, data) {
  if (!_enabled) return;
  const e = { seq: ++_seq, ts: Date.now(), side: "fe", line, node, data: data || null };
  push(e);
  try { console.log(`[wb:${line}:${node}]`, data != null ? JSON.stringify(data) : ""); } catch { /* noop */ }
}

/** 前端检测：ok=false 时记录并 warn。返回 ok */
export function wbDetect(line, node, ok, msg, data) {
  if (_enabled && !ok) {
    const e = { seq: ++_seq, ts: Date.now(), side: "fe", line, node, detect: true, msg: msg || "detect failed", data: data || null };
    push(e);
    try { console.warn(`[wb:${line}:${node}] ⚠ ${msg || ""}`, data != null ? JSON.stringify(data) : ""); } catch { /* noop */ }
  }
  return ok;
}

/** 接收后端广播的 wb_trace 事件 → 走 console 进入 backendMonitor 统一展示 */
export function wbIngestBackend(payload) {
  if (!_enabled || !payload) return;
  push({ ...payload, side: payload.side || "be" });
  try {
    const body = payload.data != null ? JSON.stringify(payload.data) : (payload.msg || "");
    if (payload.detect) console.warn(`[wb:${payload.line}:${payload.node}] ⚠`, body);
    else console.log(`[wb:${payload.line}:${payload.node}]`, body);
  } catch { /* noop */ }
}
