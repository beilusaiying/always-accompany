/**
 * tempConversation.mjs — 全智能提案确认卡（P0-A 2026-08-03 重构）
 *
 * 功能链：
 *   Smart/Chat AI 输出 <modeSwitch>work|code</modeSwitch>
 *   → 后端 replyHandler 提案硬门（本轮可变操作全拒、pending 记录持久化，非 running）
 *   → extension._pendingConfirmation → websocket dispatch beilu:smart-pending-confirmation
 *   → 本模块确认卡（提案展示 + 本地补充说明输入）
 *   → 用户点「确认开始」→ sendAction shells:chat#smartConfirm（认证端点单次 claim）
 *     → 服务端 ensureModeChatsForChar 单源补齐目标线 + 绑定 + task_start 落盘 → accepted
 *     → 前端才切 Tab + 显示「任务已提交」（区分于 IDE ready / 任务完成）
 *   → 用户点「取消」→ sendAction shells:chat#smartCancel（pending→cancelled）
 *   刷新/重连（beilu:wsReconnected）→ shells:chat#smartConfirmations status 重新投影。
 *
 * why（对旧版的根因级替换，Fable 审查阻断1/2/3）：
 *   - 旧「确认师」= 把 <temp_confirm> 发进目标 Code/Work 普通生成链的全权 AI，服务端零硬门
 *     ——该通道整体删除（不是拦一个标签）。本批不建独立 confirmation-only AI：补充说明只在
 *     本地收集，随确认一起提交进 task_start，不伪装"确认师已回复"。
 *   - 旧 _resolveModeChatId 前端散写建线（new+绑卡+指针）→ 删除，目标线唯一来源=服务端确认端点。
 *   - 旧 onConfirm fire-and-forget + 无条件"任务已启动" → 确认按钮 await 服务端业务结果：
 *     失败保留卡片、恢复按钮、显示真实错误，不切 Tab 不报成功。
 *
 * 契约：
 *   - 按 confirmationId+revision 去重（同一提案广播重放/重连重投影不弹重复卡）。
 *   - 成功文案=「任务已提交（目标窗口已接受）」，不写 ready/succeeded。
 *   - ✕ = 本地暂时收起（不取消，pending 由服务端 TTL 管理，可经重投影找回）；
 *     「取消」= 服务端 cancel。两个动作语义分开，不混。
 *
 * 关联链：
 *   ← transport/websocket.mjs（beilu:smart-pending-confirmation 事件生产者）
 *   ← shared/layout/layout.mjs（initTempConversationListener 装载点）
 *   → transport/sendAction.mjs（smartConfirm / smartCancel / smartConfirmations）
 *   → shared/state/modeTabMap.mjs（确认成功后的 Tab 跳转映射）
 *   buildChatContextRef 保留原实现（消费方=panels/smart/smart.mjs 跨模式引用预览）。
 */

import { escapeHtml as _escapeHtml } from "../state/utils.mjs";
import { MODE_TO_TAB } from "../state/modeTabMap.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中

let _cardController = null;
// 去重：已展示/已终态处理过的 confirmationId:revision（重连重投影、广播重放不弹重复卡）
const _seenConfirmations = new Map(); // `${id}:${rev}` → "shown" | "done"
// [0808 治理·有生无灭修] 原 "done" 条目永久保留（长会话单调增长，治理清单 循环08 二节点名）。
//   Map 按插入序滚动裁剪：超上限摘最老（同 checkpoint MAX=50 滚动范式）；重插同键先删后插保新鲜度。
const _SEEN_CONFIRMATIONS_MAX = 200;
function _rememberConfirmation(key, val) {
  if (_seenConfirmations.has(key)) _seenConfirmations.delete(key);
  _seenConfirmations.set(key, val);
  while (_seenConfirmations.size > _SEEN_CONFIRMATIONS_MAX) {
    const _oldest = _seenConfirmations.keys().next().value;
    _seenConfirmations.delete(_oldest);
  }
}

/**
 * FT-A1: 跨模式上下文引用构造器（全智能MD §四.3）
 * 读当前对话最近 N 条（beilu-xmode-refcount），按 beilu-xmode-format 包装：
 * xml=<chat_context>块 / dash=---分隔。不压缩原文。预览按钮消费（panels/smart/smart.mjs）。
 */
export async function buildChatContextRef() {
  const n = Math.max(0, parseInt(storage.get(KEYS.BEILU_XMODE_REFCOUNT) || "5", 10) || 0);
  const fmt = storage.get(KEYS.BEILU_XMODE_FORMAT) || "xml";
  if (n === 0) return "";
  // 补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，内含 _CHATID_RE 校验）——
  //   非法 hash（分段气泡/IDE 内部锚点）返 ""，走下方 !chatid 分支不送后端 getLogLength/getLog 分区键。
  //   对齐 cardsPanel.mjs:62 _cur()/featureControls.mjs:60 范式（window 全局桥单源，无需新增 import）。
  const chatid = window._beiluGetChatId?.() || "";
  if (!chatid) return "";
  let entries = [];
  try {
    // T6b：raw+手 lenRes.ok / r.ok 语义并入门面（!ok → 抛错→catch → 返回 ""；同 else return "" 语义等价）
    const len = Number(await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: chatid } })) || 0;
    if (len === 0) return "";
    // 多拉一倍余量，过滤 system 后再取尾 N 条
    const start = Math.max(0, len - n * 2 - 2);
    const j = await sendAction({ verb: "getLog", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { start, end: len } });
    if (Array.isArray(j)) entries = j;
  } catch { return ""; }
  const recent = entries
    .filter((e) => e && (e.content || "").trim() && e.role !== "system")
    .slice(-n)
    .map((e) => `[${e.role === "user" ? "用户" : (e.name || "AI")}] ${String(e.content).trim()}`);
  if (!recent.length) return "";
  if (fmt === "xml") {
    return `<chat_context source="smart" count="${recent.length}">\n${recent.join("\n")}\n</chat_context>`;
  }
  return `--- 聊天上下文（最近${recent.length}条）---\n${recent.join("\n")}\n---`;
}

/** 创建提案确认卡。confirmation=服务端投影（confirmationId/revision/targetMode/taskTitle/sourceChatId/lastError） */
export function createTempConversation(confirmation) {
  const conf = confirmation || {};
  if (!conf.confirmationId) return null;
  const dedupKey = `${conf.confirmationId}:${conf.revision ?? 1}`;
  if (_seenConfirmations.get(dedupKey) === "done") return null;
  if (_cardController) {
    if (_cardController.dedupKey === dedupKey) return _cardController; // 同提案已在展示
    _cardController.close("replaced");
  }
  const area = document.getElementById("temp-conversation-area");
  if (!area) return null;
  _rememberConfirmation(dedupKey, "shown");

  const targetMode = conf.targetMode === "code" ? "code" : "work";
  const modeIcon = targetMode === "work" ? '<i data-ic="clipboard"></i>' : '<i data-ic="code"></i>';
  const modeLabel = targetMode === "work" ? "工作模式" : "代码模式";

  area.classList.remove("hidden");
  area.innerHTML = `
    <div class="temp-conv-panel">
      <div class="temp-conv-header">
        <span class="temp-conv-title">${modeIcon} ${modeLabel} · 待确认</span>
        <div class="temp-conv-header-actions">
          <button class="btn btn-ghost btn-xs" data-tc-action="collapse" title="收起">–</button>
          <button class="btn btn-ghost btn-xs" data-tc-action="dismiss" title="暂时收起（不取消，可从状态恢复）">✕</button>
        </div>
      </div>
      <div class="temp-conv-body">
        <div class="temp-conv-task-info">
          <div class="text-xs opacity-60">AI 提案任务（未开始执行）</div>
          <div class="text-sm font-bold mt-1">${_escapeHtml(conf.taskTitle || "(AI未提供任务描述)")}</div>
        </div>
        <div class="temp-conv-input-row">
          <textarea id="temp-conv-note" class="textarea textarea-bordered flex-1 text-xs" rows="2" placeholder="补充说明（随确认一起提交给执行 AI，可留空）..."></textarea>
        </div>
        <div id="temp-conv-error" class="text-xs text-error mt-1 ${conf.lastError ? "" : "hidden"}">${_escapeHtml(conf.lastError || "")}</div>
        <div class="temp-conv-actions">
          <button class="btn btn-sm btn-primary" data-tc-action="confirm">✓ 确认开始</button>
          <button class="btn btn-sm" data-tc-action="cancel">取消提案</button>
        </div>
      </div>
      <div class="temp-conv-collapsed hidden" data-tc-action="expand">
        ${modeIcon} 待确认 — 点击展开
      </div>
    </div>
  `;

  const body = area.querySelector(".temp-conv-body");
  const collapsed = area.querySelector(".temp-conv-collapsed");
  const errEl = area.querySelector("#temp-conv-error");
  const confirmBtn = area.querySelector('[data-tc-action="confirm"]');
  const cancelBtn = area.querySelector('[data-tc-action="cancel"]');

  const _showError = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg || "操作失败";
    errEl.classList.remove("hidden");
  };
  const _setBusy = (busy) => {
    if (confirmBtn) confirmBtn.disabled = busy;
    if (cancelBtn) cancelBtn.disabled = busy;
  };

  _cardController = {
    dedupKey,
    confirmationId: conf.confirmationId,
    close(reason) {
      area.classList.add("hidden");
      area.innerHTML = "";
      _cardController = null;
      if (reason === "confirmed" || reason === "cancelled" || reason === "terminal") {
        _rememberConfirmation(dedupKey, "done");
      } else {
        // dismiss/replaced：仅收起，允许状态重投影再次展示
        _seenConfirmations.delete(dedupKey);
      }
    },
  };

  area.querySelectorAll("[data-tc-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.tcAction;
      if (act === "dismiss") {
        // 本地收起 ≠ 取消：pending 仍在服务端（TTL 管理），重投影可找回
        _cardController?.close("dismissed");
      } else if (act === "collapse") {
        body.classList.add("hidden");
        collapsed.classList.remove("hidden");
      } else if (act === "expand") {
        body.classList.remove("hidden");
        collapsed.classList.add("hidden");
      } else if (act === "confirm") {
        // P0-A 前端要求4：await 服务端业务成功；失败保留卡片、恢复按钮、显示真实错误
        _setBusy(true);
        const note = area.querySelector("#temp-conv-note")?.value.trim() || "";
        try {
          const r = await sendAction({
            verb: "smartConfirm", target: "shells:chat", source: "web",
            payload: { confirmationId: conf.confirmationId, revision: conf.revision ?? 1, sourceChatId: conf.sourceChatId || "", note },
          });
          if (r?.success && r?.status === "accepted") {
            _cardController?.close("confirmed");
            const tab = MODE_TO_TAB[targetMode];
            if (tab) window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab } }));
            // 成功文案区分「已提交/已接受」与「IDE ready/任务完成」（P0-A 前端要求6）
            window._beiluToast?.("任务已提交，目标窗口已接受（执行进度以目标窗口为准）", "success");
          } else {
            // 门面未抛错但业务未接受：真实回执可见
            _showError(`提交未被接受: ${r?.error || r?.code || "未知回执"}`);
            _setBusy(false);
          }
        } catch (err) {
          _showError(`确认失败: ${err?.message || err}`);
          _setBusy(false);
        }
      } else if (act === "cancel") {
        _setBusy(true);
        try {
          const r = await sendAction({
            verb: "smartCancel", target: "shells:chat", source: "web",
            payload: { confirmationId: conf.confirmationId, sourceChatId: conf.sourceChatId || "" },
          });
          if (r?.success) {
            _cardController?.close("cancelled");
            window._beiluToast?.("提案已取消", "info");
          } else {
            _showError(`取消失败: ${r?.error || r?.code || "未知回执"}`);
            _setBusy(false);
          }
        } catch (err) {
          // 已执行/已过期等冲突：显示真实原因；卡片保留由用户决定收起
          _showError(`取消失败: ${err?.message || err}`);
          _setBusy(false);
        }
      }
    });
  });

  return _cardController;
}

/** 关闭确认卡（外部收敛入口，保留旧导出名） */
export function closeTempConversation(reason = "dismissed") {
  _cardController?.close(reason);
}

/**
 * 状态重投影（P0-A 前端要求5）：查当前对话的 pending 提案，恢复最新一张确认卡。
 * 触发点：init（刷新恢复）、beilu:wsReconnected（断线重连恢复）。
 */
export async function restorePendingConfirmations(chatid) {
  const cid = chatid || window._beiluGetChatId?.() || "";
  if (!cid) return;
  try {
    const r = await sendAction({ verb: "smartConfirmations", target: "shells:chat", source: "web", scope: { chatId: cid } });
    const pending = (r?.confirmations || []).filter((c) => c && c.status === "pending");
    if (pending.length > 0) createTempConversation(pending[0]);
  } catch (e) {
    console.warn("[tempConversation] 提案状态重投影失败:", e?.message || e);
  }
}

/** 全局监听: replyHandler 提案硬门经 websocket 告知有待确认提案 */
export function initTempConversationListener() {
  window.addEventListener("beilu:smart-pending-confirmation", (e) => {
    const conf = e.detail?.confirmation;
    if (conf?.confirmationId) createTempConversation(conf);
  });
  // 断线重连：按重连对话重新投影 pending 卡（刷新场景由下方 init 恢复）
  window.addEventListener("beilu:wsReconnected", (e) => {
    restorePendingConfirmations(e.detail?.chatid || "");
  });
  // 页面装载恢复（fire-and-forget；无 pending 时无操作）
  restorePendingConfirmations().catch?.(() => {});
}
