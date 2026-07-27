/**
 * @file utils.mjs — panels/airp/ 共享工具基座
 *
 * 【功能链】
 *   escapeHtml（XSS转义，委托 shared/state/utils.mjs 权威实现）
 *   → showToast（壳：静态委托 scripts/toast.mjs 权威，仅转参数序）
 *   → getCurrentCharId（读 chat.mjs 共享 charList[0]）
 *   → waitForCharIdReady（charList 异步就绪前 setInterval 轮询，超时静默放弃）
 *
 * 【why】
 *   panels/airp/ 各 cluster 均需 toast + charId，抽出基座避免跨模块重复实现，
 *   同时统一 escapeHtml 为全5字符版（含引号），修复属性上下文 XSS 面。
 *
 * 【关联链】
 *   上游：shared/chat-core/chat.mjs（charList live-binding）、shared/state/utils.mjs（escapeHtml）
 *   下游：panels/airp/ 所有 cluster（charinfo / charscript / injprompt / memoryai /
 *         persona / poll / subtabs / eye / toggles / chatmgmt）
 *
 * 【影响范围】
 *   改动此文件影响整个 panels/airp/ 层的 toast 展示逻辑和 charId 就绪判断。
 *
 * 【使用效果】
 *   import { escapeHtml, showToast, getCurrentCharId, waitForCharIdReady } from "./utils.mjs"
 *   charList 未就绪时 waitForCharIdReady 自动延迟 callback，不阻塞调用方。
 */
import { charList } from "../../shared/chat-core/chat.mjs"; // P2续: getCurrentCharId 读共享 charList
import { escapeHtml } from "../../shared/state/utils.mjs"; // 收口: 原本地 DOM 副本只转义 & < >(不转义引号),属性上下文(如 src="${escapeHtml(...)}")存在 XSS 面→改用权威 utils.escapeHtml(全5字符,含引号)
import { showToast as _coreShowToast } from "../../../../../../scripts/toast.mjs"; // D1 收口：toast 实现单源（静态可行性=tokenProgressBar 同款先例）

// ============================================================
// 工具函数
// ============================================================

// [D1 收口 0713] toast 实现单源=scripts/toast.mjs 权威。原动态 import+fallbackToast 手绘 DOM：
//   同 origin 静态模块 import 失败≈整页已崩，降级分支运行期不可达=死代码+第二套 toast UI
//   （5 处本地实现质量不齐的病灶之一），随收口删除（删除=纯删除）。
//   本壳保留 (message, type) 参数序——本文件是 window._beiluToast 桥的本体，全前端 30+ 调用点
//   依赖此序；仓库权威序=(type, message, duration)，全量翻序属独立第二刀。
// [上线引导 0727] 首次错误 toast 后追加一次性报错指引(每会话一次)。
//   收口位=本函数(window._beiluToast 桥本体,全前端错误提示的必经点),不散改各调用方;
//   文案是纯静态中文单文本节点——壳覆盖式 i18n(shared/i18n.mjs MutationObserver)按原文
//   整串命中翻译,locales/*.json 九语言已配同键;改动此串必须同步九份字典,否则外语下不翻译。
//   延迟 1.2s 弹出:与错误本体错开,避免同屏叠加冲淡错误内容。
let _errGuideShown = false;
function showToast(message, type = "info") {
  _coreShowToast(type, message);
  if (type === "error" && !_errGuideShown) {
    _errGuideShown = true;
    setTimeout(() => _coreShowToast("info", "遇到报错?可打开 设置 → 后台监控 → 错误追踪:导出错误报告或截图,发送给作者协助修复", 8000), 1200);
  }
}

/**
 * 获取当前聊天的主角色卡名称
 * @returns {string|null}
 */
function getCurrentCharId() {
  return charList && charList.length > 0 ? charList[0] : null;
}

/**
 * charList 异步加载完成前 charId 为空——共享 polling 等待工具。
 * 加载就绪后调 callback(charId)；超时静默放弃（不调 callback）。
 * @param {(charId: string) => void} callback
 * @param {number} [timeout=30000]
 * @param {number} [interval=2000]
 */
function waitForCharIdReady(callback, timeout = 30000, interval = 2000) {
  const charId = getCurrentCharId();
  if (charId) { callback(charId); return; }
  const timer = setInterval(() => {
    const id = getCurrentCharId();
    if (id) { clearInterval(timer); callback(id); }
  }, interval);
  setTimeout(() => clearInterval(timer), timeout);
}

export { escapeHtml, showToast, getCurrentCharId, waitForCharIdReady };
