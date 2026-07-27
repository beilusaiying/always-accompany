/**
 * tempConversation.mjs — 全智能模式临时对话区（设计文档 3.3）
 *
 * 功能链：
 *   全智能 AI 输出 <modeSwitch>work|code</modeSwitch> → 外部调用 showTempConversation()
 *   → 在聊天区与输入框之间插入临时对话容器
 *   → 用户与确认师交流（可含跨模式上下文引用 buildChatContextRef）
 *   → 用户点「确认开始」→ _bindChatMode(chatId, mode) 绑定模式 → 切换到对应 Tab
 *   → 用户点「取消」/ 超时 → hideTempConversation() → DOM 移除
 *
 * why：
 *   全智能模式检测到需要切换到 work/code 时，不应立即跳转，而应先让用户确认任务细节；
 *   _bindChatMode（N38）把对话线绑到对应模式，是切换后 AI 获得正确 INJ/预设的唯一来源（取消全局翻转后）；
 *   buildChatContextRef 让确认师可以引用最近 N 条聊天内容，避免上下文断层。
 *
 * 关联链：
 *   ← websocket.mjs / messageParser（解析 <modeSwitch> 标签后调用）
 *   → shared/state/modeTabMap.mjs（MODE_TO_TAB：模式到 Tab 的映射）
 *   → beilu-memory 插件后端（bindChatMode action / 对话日志读取）
 *   → shared/transport/api-client.mjs（apiFetch）
 *   → shared/state/storage.mjs（KEYS.BEILU_XMODE_REFCOUNT / BEILU_XMODE_FORMAT：跨模式引用配置）
 *
 * 影响范围：
 *   DOM：在 .chat-messages 与 .chat-input 之间动态插入/移除临时对话容器；
 *   后端：_bindChatMode 写 active_modes_map[chatId]（幂等，失败不阻塞）；
 *   生命周期：用户确认/取消/超时后自动移除，不留残余状态。
 *
 * 使用效果：
 *   全智能 AI 触发模式切换意图时，弹出临时对话区由用户确认；
 *   确认后自动绑定模式并跳转对应 Tab，AI 在新 Tab 获得正确上下文。
 */

import { escapeHtml as _escapeHtml } from "../state/utils.mjs";
import { getCharId } from "../state/sharedState.mjs";
import { MODE_TO_TAB } from "../state/modeTabMap.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中

let _tempController = null;
let _pollAbort = null;

/**
 * N38: 把模式专属对话线绑定到对应模式（后端 active_modes_map[chatId]）。
 * 旧链路靠 modeSwitch 的 char 级全局翻转让投递线"碰巧"拿到 work 模式；
 * N38 取消全局翻转后，绑定是投递线获得正确 INJ/预设的唯一来源。幂等，失败不阻塞
 * （后端回退 char 级默认解析）。
 */
async function _bindChatMode(chatid, mode) {
  try {
    // T6b：走 beilu-memory 通配 setdata 路由（verb=bindChatMode，rest 平铺）
    await sendAction({
      verb: "bindChatMode", target: "plugins:beilu-memory", source: "web",
      payload: { mode, chat_id: chatid, charName: getCharId() },
    });
  } catch { /* 绑定失败不阻塞确认流程 */ }
}

/**
 * FT-A1: 跨模式上下文引用构造器（全智能MD §四.3）
 * 读当前对话最近 N 条（beilu-xmode-refcount），按 beilu-xmode-format 包装：
 * xml=<chat_context>块 / dash=---分隔。不压缩原文。预览按钮与确认师通道共用。
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

/** 创建临时对话区 */
export function createTempConversation(options) {
  if (_tempController) closeTempConversation("replaced");

  const area = document.getElementById("temp-conversation-area");
  if (!area) return null;

  const { targetMode = "work", taskTitle = "", onConfirm, onCancel } = options || {};
  const modeIcon = targetMode === "work" ? '<i data-ic="clipboard"></i>' : '<i data-ic="code"></i>';
  const modeLabel = targetMode === "work" ? "工作模式" : "代码模式";

  area.classList.remove("hidden");
  area.innerHTML = `
    <div class="temp-conv-panel">
      <div class="temp-conv-header">
        <span class="temp-conv-title">${modeIcon} ${modeLabel}</span>
        <div class="temp-conv-header-actions">
          <button class="btn btn-ghost btn-xs" data-tc-action="collapse" title="收起">–</button>
          <button class="btn btn-ghost btn-xs" data-tc-action="close" title="取消">✕</button>
        </div>
      </div>
      <div class="temp-conv-body">
        <div class="temp-conv-task-info">
          <div class="text-xs opacity-60">检测到任务</div>
          <div class="text-sm font-bold mt-1" id="temp-conv-task-title">${_escapeHtml(taskTitle || "(AI未提供任务描述)")}</div>
        </div>
        <div id="temp-conv-messages" class="temp-conv-messages"></div>
        <div class="temp-conv-input-row">
          <textarea id="temp-conv-input" class="textarea textarea-bordered flex-1 text-xs" rows="2" placeholder="修改需求或补充说明..."></textarea>
          <button class="btn btn-sm btn-ghost" data-tc-action="send-msg" title="发送">➤</button>
        </div>
        <div class="temp-conv-actions">
          <button class="btn btn-sm btn-primary" data-tc-action="confirm">✓ 确认开始</button>
          <button class="btn btn-sm" data-tc-action="cancel">取消</button>
        </div>
      </div>
      <div class="temp-conv-collapsed hidden" data-tc-action="expand">
        ${modeIcon} 待确认 — 点击展开
      </div>
    </div>
  `;

  const panel = area.querySelector(".temp-conv-panel");
  const body = area.querySelector(".temp-conv-body");
  const collapsed = area.querySelector(".temp-conv-collapsed");

  _tempController = {
    targetMode,
    close(reason) {
      area.classList.add("hidden");
      area.innerHTML = "";
      _tempController = null;
      _pollAbort?.abort();
      _pollAbort = null;
      if (reason === "confirmed") onConfirm?.();
      else if (reason === "cancelled") onCancel?.();
    },
    addMessage(role, content) {
      const msgList = area.querySelector("#temp-conv-messages");
      if (!msgList) return;
      const el = document.createElement("div");
      el.className = `temp-conv-msg temp-conv-msg-${role}`;
      el.innerHTML = `<span class="temp-conv-msg-role">${role === "user" ? "你" : "确认师"}:</span> <span>${_escapeHtml(content)}</span>`;
      msgList.appendChild(el);
      msgList.scrollTop = msgList.scrollHeight;
    },
  };

  area.querySelectorAll("[data-tc-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.tcAction;
      if (act === "close" || act === "cancel") {
        closeTempConversation("cancelled");
      } else if (act === "confirm") {
        closeTempConversation("confirmed");
      } else if (act === "collapse") {
        body.classList.add("hidden");
        collapsed.classList.remove("hidden");
      } else if (act === "expand") {
        body.classList.remove("hidden");
        collapsed.classList.add("hidden");
      } else if (act === "send-msg") {
        const input = area.querySelector("#temp-conv-input");
        const text = input?.value.trim();
        if (!text) return;
        input.value = "";
        _tempController?.addMessage("user", text);
        // A6: 接独立确认师通道 — POST 到目标模式(work/code)的 chatId, 不污染主聊天
        // 设计 §3.2 步骤4 + §4.2 步骤2: 独立消息通道, 走目标 chatId 的 message 端点
        const sendBtn = btn;
        sendBtn.disabled = true;
        _sendToConfirmer(targetMode, text)
          .then((replyText) => {
            _tempController?.addMessage("assistant", replyText || "(确认师无回复)");
          })
          .catch((err) => {
            console.warn("[tempConversation] 确认师通道失败,回退本地回显:", err?.message);
            _tempController?.addMessage("assistant", "收到,请点[确认开始]或[取消]");
          })
          .finally(() => { sendBtn.disabled = false; });
      }
    });
  });

  return _tempController;
}

/** 关闭临时对话 */
export function closeTempConversation(reason = "cancelled") {
  _tempController?.close(reason);
}

// ============================================================
// A6: 确认师独立消息通道 (设计 §3.2 / §4.2 / §4.3)
// ------------------------------------------------------------
// 临时对话的消息不混入主聊天: POST 到目标模式(work/code)自己的 chatId,
// 用 XML 标签隔离临时对话内容. 回复经由轮询目标 chatId 的 /log 拿回填
// (主 WS 连接的是 chat-chatid, 收不到 work-chatid 的广播 — 见设计 §15.1 P0-1,
//  跨 chatId 广播 producer ⑤-1 尚未建, 故此处用轮询而非 WS).
// ============================================================

/** 解析目标模式的 chatId (work/code), 不存在则自动新建并记入 localStorage */
async function _resolveModeChatId(mode) {
  const { getModeChatIdKey } = await import("../../panels/feature/featureControls.mjs");
  const _charName = storage.get(KEYS.BEILU_LAST_CHAR) || "";
  // [补丁扫描修复二批 2026-07-13] 同 websocket._ensureModeChatId：`|| 旧全局键` 回退是死分支+
  //   掩病（getModeChatIdKey 返 null 仅=mode 非法），删除，非法 mode 诚实抛错。
  const key = getModeChatIdKey(mode, _charName);
  if (!key) throw new Error("_resolveModeChatId: 非法 mode " + mode);
  const existing = storage.get(key);
  if (existing) {
    // N38: 复用也补绑定（幂等）——老线可能建于绑定机制之前
    await _bindChatMode(existing, mode);
    return existing;
  }
  // T6b：走 shells:chat#new（HTTP !ok → 门面抛错走外层 catch，含 target#verb 定位）
  const data = await sendAction({ verb: "new", target: "shells:chat", source: "web" });
  const cid = data?.chatid || "";
  if (!cid) throw new Error("新建" + mode + "聊天未返回 chatid");
  // [R1 配套 0713] 懒建补绑卡（websocket._ensureModeChatId 同型）：无 primaryCharName 的对话
  //   服务端 /using 反查定键失败、文件落旧路径无归属。绑卡失败不阻断（R4 toast 可见非静默）。
  if (_charName) {
    try {
      await sendAction({ verb: "bindCharToChat", target: "shells:chat", source: "web", scope: { chatId: cid }, payload: { charname: _charName } });
    } catch (e) { console.warn("[tempConversation] 懒建绑卡失败（在用指针将被服务端拒收）:", e?.message); }
  }
  // [补丁扫描修复二批 2026-07-13] 原 storage.set(key, cid) 只写本地=绕 markModeActiveChat 收口
  //   （websocket._ensureModeChatId 同型病 0713 已收口，注释称"最后一个绕收口写点"漏了此处）——
  //   本地换线服务端 mode_active_chats 不知情，恢复链/「XX窗口在用」徽标分叉。
  //   改走单源（本地+服务端双写；动态 import 与 websocket 同款防静态环）。
  const { markModeActiveChat } = await import("../chat-core/conversationManager.mjs");
  markModeActiveChat(mode, _charName, cid);
  await _bindChatMode(cid, mode);
  return cid;
}

/**
 * 向确认师发送一条临时对话消息, 返回确认师的回复文本.
 * @param {"work"|"code"} mode 目标模式
 * @param {string} text 用户在临时对话里输入的内容
 * @returns {Promise<string>}
 */
async function _sendToConfirmer(mode, text) {
  const chatid = await _resolveModeChatId(mode);

  // 取目标 chatId 当前消息数作为基线, 用于轮询时识别"新出现的 assistant 回复"
  let baseline = 0;
  try {
    // T6b：raw+手 lenRes.ok 语义并入门面（!ok → 抛错→catch → baseline 保持 0，语义等价）
    baseline = Number(await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: chatid } })) || 0;
  } catch { /* 拿不到基线就从 0 起轮询 */ }

  // §4.3 XML 隔离: 临时对话内容用 <temp_confirm> 标签包裹, 与主对话上下文隔离,
  // 不压缩原文 (保留场景信息). source 标记便于确认师区分临时确认会话.
  // FT-A1: 附带聊天上下文引用（条数/格式=右栏跨模式设置,设计「确认师能看到引用的聊天上下文」）
  let ctxRef = "";
  try { ctxRef = await buildChatContextRef(); } catch { /* 上下文拿不到不阻塞确认 */ }
  const isolated =
    '<temp_confirm source="smart" mode="' + mode + '">\n' +
    (ctxRef ? ctxRef + "\n\n" : "") + text + "\n</temp_confirm>";

  // T6b：走 shells:chat#sendMessage（HTTP !ok → 门面抛错，含"发送到确认师"定位；具体错误 msg 由门面 target#verb 表达）
  await sendAction({ verb: "sendMessage", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { reply: { content: isolated, files: [] } } });

  // 后端 message 端点异步触发 AI 回复 (经 WS 推到 work-chatid), 此处轮询 /log 拿回填
  return await _pollConfirmerReply(chatid, baseline);
}

/** 轮询目标 chatId 的日志, 等待 baseline 之后出现的 assistant 回复 */
async function _pollConfirmerReply(chatid, baseline) {
  _pollAbort = new AbortController();
  const signal = _pollAbort.signal;
  const MAX_TRIES = 60; // 60 × 1s = 60s 上限
  for (let i = 0; i < MAX_TRIES; i++) {
    if (signal.aborted) throw new Error("已取消");
    await new Promise((r) => setTimeout(r, 1000));
    if (signal.aborted) throw new Error("已取消");
    let len = baseline;
    try {
      // T6b：门面（!ok → 抛错→catch → continue，与原 lenRes.ok=false 不 update len 等价）
      len = Number(await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: chatid } })) || baseline;
    } catch (e) { console.warn("[tempConv] 轮询取长度失败（下轮重试）:", e?.message || e); continue; /* T021 留痕 */ }
    if (len <= baseline) continue;
    // 拉取 baseline 之后的新消息, 找最后一条 assistant
    try {
      const entries = await sendAction({ verb: "getLog", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { start: baseline, end: len } });
      if (!Array.isArray(entries)) continue;
      const lastAssistant = [...entries].reverse().find(
        (e) => e && e.role !== "user" && (e.content || "").trim(),
      );
      if (lastAssistant) return _stripTempTags(lastAssistant.content || "");
    } catch { continue; }
  }
  throw new Error("等待确认师回复超时");
}

/** 去掉可能回显的隔离标签, 只给用户看纯文本 */
function _stripTempTags(s) {
  return String(s)
    .replace(/<\/?temp_confirm[^>]*>/g, "")
    .trim();
}

async function _fireWorkStart(mode, taskTitle) {
  const chatid = await _resolveModeChatId(mode);
  let ctxRef = "";
  try { ctxRef = await buildChatContextRef(); } catch { /* 上下文拿不到不阻塞启动 */ }
  const startMsg =
    '<task_start source="smart" mode="' + mode + '">\n' +
    (ctxRef ? ctxRef + "\n\n" : "") +
    (taskTitle ? "任务: " + taskTitle + "\n" : "") +
    "用户已确认开始。请开始执行任务。\n</task_start>";
  // T6b：走 shells:chat#sendMessage；原 !ok 时的 console.warn 由门面 _report console.error 覆盖
  try {
    await sendAction({ verb: "sendMessage", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { reply: { content: startMsg, files: [] } } });
  } catch (e) {
    console.warn("[tempConversation] 启动指令发送失败:", e?.message);
  }
}

/** 全局监听: replyHandler通过websocket告知需要临时对话 */
export function initTempConversationListener() {
  window.addEventListener("beilu:smart-mode-switch", (e) => {
    const { from, to, taskTitle } = e.detail || {};
    createTempConversation({
      targetMode: to,
      taskTitle,
      onConfirm: () => {
        _fireWorkStart(to, taskTitle).catch((err) => {
          console.warn("[tempConversation] work 启动指令失败:", err?.message);
        });
        const tab = MODE_TO_TAB[to];
        if (tab) window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab } }));
        window._beiluToast?.("任务已启动，AI 正在准备中...", "success");
      },
      onCancel: () => {
        window._beiluToast?.("已取消", "info");
      },
    });
  });
}
