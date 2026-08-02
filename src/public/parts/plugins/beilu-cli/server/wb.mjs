/**
 * wb.mjs — beilu-cli 轻量白盒埋点（跨进程 console 桥版）
 *
 * CLI 是独立 node 子进程，不能 import 本体 server/whitebox.mjs（跨进程=第二实例，
 * RING/broadcaster/audit 全空转）。接法复用既有传导链，零新协议：
 *   本模块打 "[wb:cli.<node>:<event>]" 前缀行到 stdout/stderr
 *   → beilu-cli 插件 stdout/stderr pipe → 本体 console.log/console.warn（main.mjs:107-114）
 *   → server/monitor.mjs console hook 捕获 → 前端 backendMonitor「运行时日志」面板可见
 * 格式对齐本体 whitebox emit 的 "[wb:line:node]" console 约定，同一套 grep/面板过滤直接命中。
 *
 * 签名对齐本体 wbStub（wbT/wbD）。
 * [窗口id 0726 校准] tool_call 信封现携带 chatid（后端 ideClient 单点注入，executor 落
 * params._window_id）——会话/线级事件（session 池路由等）应把 key/_window_id 放进 data 参与归因；
 * 进程级事件仍无 chatid 维。本体 ideClient 侧 wbT/wbD 与此互补，不重复。
 */

export function wbT(node, event, data) {
  try {
    console.log(`[wb:cli.${node}:${event}]${data ? " " + JSON.stringify(data) : ""}`);
  } catch { /* 埋点绝不影响主逻辑 */ }
}

export function wbD(node, event, ok, msg, data) {
  try {
    const line = `[wb:cli.${node}:${event}] ${ok ? "✓" : "⚠"}${msg ? " " + msg : ""}${data ? " " + JSON.stringify(data) : ""}`;
    if (ok) console.log(line);
    else console.warn(line); // stderr → 插件桥 console.warn → monitor hook 错误缓冲
  } catch { /* ignore */ }
  return ok;
}
