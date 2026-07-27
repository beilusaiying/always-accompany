/**
 * recalledMemory.mjs — T6「运用可溯源」记忆召回溯源卡（前端消费端）
 *
 * 功能链：
 *   后端 producer：replyHandler.mjs 在 AI 回复时
 *     → 检索记忆（beilu-memory recall）→ 把召回条目存 reply.extension._recalledMemory
 *     → consume-once 读后删（10min 新鲜窗，避免重复显示）
 *     → items = [{ file: string, score: number, summary: string }, ...]
 *   前端 consumer（本模块）：
 *     handleRecalledMemory(messageEl, extension) → 从 extension._recalledMemory 取 items
 *     → 生成可折叠 <details> 溯源卡（"本轮运用记忆 N 条"）→ 插入到 messageEl.nextSibling
 *   调用点：messageList.mjs 的 extension 分发块（与 handleTaskOverlayExtension 同款调用约定）
 *
 * why（可溯源设计）：
 *   AI 利用了哪些记忆文件影响回复，用户之前完全不可见；溯源卡让每条 AI 回复都可追溯"用了哪些记忆、
 *   来自哪个文件、置信度多少"，增强可信度感知（T6 设计目标）。
 *   <details> 折叠默认收起，不干扰正常阅读。
 *
 * 关联链：
 *   → shared/state/utils.mjs escapeHtml（文件名/摘要 XSS 安全转义）
 *   ← messageList.mjs（消息渲染后的 extension 分发点调用 handleRecalledMemory）
 *   ← replyHandler.mjs（后端写 _recalledMemory，本模块消费）
 *
 * 影响范围：
 *   仅在每条 AI 消息元素后面插入一个 <details> 节点，无全局状态，无后端写操作。
 *
 * 使用效果：
 *   AI 每次回复后，消息下方出现「🧠 本轮运用记忆 (N)」折叠条；
 *   展开后显示文件名、相关度分数（0-1）、摘要文本，帮助用户理解 AI 为何如此回答。
 */

import { escapeHtml } from "../state/utils.mjs";

function _basename(p) {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function _fmtScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

/**
 * @param {HTMLElement} messageEl - 消息DOM元素
 * @param {object} extension - reply.extension
 */
export function handleRecalledMemory(messageEl, extension) {
  if (!extension || !messageEl) return;
  const items = extension._recalledMemory;
  if (!Array.isArray(items) || items.length === 0) return;

  const rows = items
    .map((it) => {
      const file = escapeHtml(_basename(it?.file));
      const fullPath = escapeHtml(String(it?.file || ""));
      const score = _fmtScore(it?.score);
      const scoreTag = score
        ? ` <span style="opacity:0.5;">(${score})</span>`
        : "";
      const summary = escapeHtml(String(it?.summary || ""));
      return `<div style="line-height:1.5; padding:2px 0; border-bottom:1px solid rgba(148,163,184,0.1);">
        <span style="font-weight:600;" title="${fullPath}"><i data-ic="file"></i> ${file}</span>${scoreTag}
        <div style="opacity:0.7; margin-top:1px;">${summary}</div>
      </div>`;
    })
    .join("");

  const details = document.createElement("details");
  details.className = "recalled-memory-trace text-[10px] mt-1 rounded bg-base-200/40 px-2 py-1";
  details.innerHTML = `<summary style="cursor:pointer; opacity:0.7;"><i data-ic="brain"></i> 本轮运用记忆 (${items.length})</summary>
    <div style="margin-top:4px;">${rows}</div>`;

  messageEl.parentNode?.insertBefore(details, messageEl.nextSibling);
}
