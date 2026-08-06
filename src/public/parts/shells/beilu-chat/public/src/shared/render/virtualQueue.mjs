/**
 * [virtualQueue] — 虚拟渲染队列 + WS 消息事件调度中枢。不管单条消息怎么渲染（那是 messageList 的事），
 *   不管流式逐字 DOM 更新（那是 StreamRenderer 的事），不管 WS 连接（那是 websocket.mjs 的事）。
 *
 * 链路：websocket.mjs handleBroadcastEvent → 本模块 handle* 系列 → virtualList 增删替换 → messageList.renderMessage
 *       流式链路：handleStreamUpdate → applySlice(stream.mjs) → streamRenderer.updateTarget → DOM 逐字渲染
 * 影响：操作 virtualList（appendItem/replaceItem；deleteItem 用于批量回档 handleMessagesRangeDeleted
 *       从队列真正删除；单条 message_deleted 仍走 DOM display:none 隐藏，见 handleMessageDeleted）、操作 streamRenderer
 *       （register/stop/updateTarget）、清空 MVU 变量（clearMessages）、广播 EventBus stream_token_received 事件
 * 相交：← websocket.mjs（所有 message_* / stream_* / timeline_info 事件分发到此）
 *       → virtualList.mjs（底层虚拟滚动列表，管数据分页 + DOM 回收）
 *       → messageList.mjs（renderMessage 作为 renderItem 回调）
 *       → stream.mjs（applySlice: append/rewrite_tail/set_files 三型切片）
 *       → StreamRenderer.mjs（register/stop/updateTarget: 流式逐字 DOM 渲染）
 *
 * 消息生命周期事件处理：
 *   message_added    → handleMessageAdded: 标 pendingRender，500ms 超时兜底骨架屏
 *   stream_update    → handleStreamUpdate: 首帧 appendItem+register，每帧 applySlice+updateTarget
 *   message_replaced → handleMessageReplaced: 先 stop StreamRenderer 再 replaceItem
 *   message_deleted  → handleMessageDeleted: 隐藏 DOM + 通知删除监听器
 *   messages_hidden  → handleMessagesHidden: 灰显切换
 *   timeline_info    → handleTimelineInfo: 更新 swipe 计数器(❮ N/M ❯)
 */
import { createVirtualList } from "../../../../../../scripts/virtualList.mjs";
import { getChatLog, getChatLogLength } from "../transport/endpoints.mjs";
import { modifyTimeLine } from "../transport/endpoints.mjs";
import { applySlice } from "./stream.mjs";

import { createDiag } from "../state/diagLogger.mjs";
import { DEFAULTS } from "../../config/defaults.mjs"; // P2：消息加载数缺省单源
import { _syncMvuVariablesToStore, resetFloorMap } from "../transport/websocket.mjs";
import { disableSwipe, enableSwipe, renderMessage } from "./messageList.mjs";
import { clearMessages } from "../../stCompat/variableStore.mjs";
import { StreamRenderer } from "./StreamRenderer.mjs"; // [0727 多窗口] 每窗口 new 一个，不再是单例
import { handleTypingStatus } from "./typingIndicator.mjs";
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中

// ══ 每个窗口一份渲染上下文（凛倾 0727：「每个窗口都是并行的」「每个窗口一份完整的」）══
// 【why】原来这些是模块级单例：N 个窗口共用一个 virtualList / 一套流式态 → 那不叫并行。
//   后果实测：开新窗口或切回窗口补拉时，initializeVirtualQueue 会清全局流式态，
//   **把别的窗口正在生成的消息打断且永远卡住**；后台窗口也没有自己的列表可渲染。
// 【做法】按窗口 id（=chatid）各存一份，函数按 id 取；不传 id 时取当前显示窗口。
//   窗口 id 与消息 id 两边本来就有，直接按 id 走，不需要"找"、不需要全局重绑。
const _wins = new Map();
let _activeWinId = "";
/** 取某个窗口的渲染上下文（懒建）。id 省略＝当前显示窗口。 */
/**
 * 窗口键单源：**所有**取渲染上下文的地方都经此解析，产地与消费方因此天然同键。
 * 【why 必须单源】原来产地（initializeVirtualQueue → _W()）在无窗口时落到无名默认键 "__main__"，
 *   而消费方（WS 事件 → _W(cid)）按对话 id 取 —— 建一个键、取另一个键，事件全部打进空上下文，
 *   handleMessageReplaced 首行 `if (!_w.virtualList) return` 静默退出：切开场白后端已换好、
 *   界面纹丝不动（0727 凛倾实测）。在读侧加"认领"分支只是兼容错键，键仍是两个 → 病还在。
 * 解析序：显式 id（消息自带，最权威）> 当前显示窗口 > 当前对话 id > 无名兜底（无对话时才可能走到）。
 */
function _winKey(id) {
  if (id) return id;
  if (_activeWinId) return _activeWinId;
  try {
    const c = window._beiluCurWinChatId?.() || window._beiluGetChatId?.() || "";
    if (c) return c;
  } catch { /* 桥未载 */ }
  return "__main__";
}
function _W(id) {
  const k = _winKey(id);
  let w = _wins.get(k);
  if (!w) {
    w = {
      container: (typeof window !== "undefined" && window._beiluGetWinEl?.(k)) || document.getElementById("chat-messages"),
      virtualList: null,
      streamingMessages: new Map(),
      // 逐字渲染器也每窗口一份：它自带 streamingMessages + RAF loop，共用一份的话
      //   任一窗口重建队列时的 stopLoop()+clear() 会掐断所有窗口的生成（StreamRenderer.mjs 类头 why）
      streamRenderer: new StreamRenderer(),
      renderTotalCount: 0,
      chatLogOffsetShift: 0,
      optimisticElements: [],
    };
    _wins.set(k, w);
    wbTrace("window", "ctx:create", { win: k });
  }
  // 失效模式断言：容器已从文档里摘掉却还拿它渲染 —— LRU 回收/关窗口时漏了配对删链就是这样，
  //   症状是"消息看起来发出去了但界面没有"，而 DOM 操作本身不报错。
  else if (w.container && !w.container.isConnected) {
    wbDetect("window", "ctx:orphanContainer", false,
      "该窗口的容器已不在文档里，却仍在往它渲染（回收路径漏了 dropWindowCtx？）", { win: k });
  }
  return w;
}
/** lineManager 切窗口时告知当前显示的是哪个窗口 */
export function setActiveWindow(chatid) {
  _activeWinId = chatid || "";
  const w = _W(chatid);
  const el = (typeof window !== "undefined" && window._beiluGetWinEl?.(_activeWinId)) || document.getElementById("chat-messages");
  if (el) w.container = el;
}
export function getActiveWindow() { return _activeWinId; }
/**
 * 把一个窗口的渲染上下文改挂到新的窗口 id 上（**搬 key，不销毁**）。
 * 用处：a（主窗口）的 chatid 会被原生切换改掉（切模式各记各的对话 / 切对话 / 切卡），
 *   而容器还是同一个 DOM —— 上下文该跟着改名，不该重建。
 * 【why 不是 drop 旧的再建新的】lineManager 的 rekey 与 chat.mjs 的重载都挂在 hashchange 上，
 *   顺序不保证：若重载先跑（已在旧 key 上建好 virtualList）、rekey 再 drop，刚建好的列表被销毁
 *   → 界面空白。搬 key 则两种顺序都对，不需要约定谁先谁后。
 */
export function rekeyWindowCtx(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const w = _wins.get(oldId);
  if (_activeWinId === oldId) _activeWinId = newId;
  if (!w) return;
  _wins.delete(oldId);
  const prev = _wins.get(newId);
  if (prev && prev !== w) {
    // 目标 id 已经有自己的上下文（该对话另有窗口）：不能两份指向同一容器，丢弃搬过来的这份
    try { w.virtualList?.destroy?.(); } catch { /* 已销毁 */ }
    try { w.streamRenderer?.stopLoop?.(); w.streamRenderer?.streamingMessages?.clear?.(); } catch { /* 已销毁 */ }
    for (const st of w.streamingMessages.values()) if (st?._skeletonTimer) clearTimeout(st._skeletonTimer);
    wbDetect("window", "ctx:rekeyCollide", false,
      "改名的目标窗口 id 已有自己的上下文，搬过来的那份已丢弃", { oldId, newId });
    return;
  }
  _wins.set(newId, w);
  wbTrace("window", "ctx:rekey", { oldId, newId });
}
/** 关窗口时丢弃它的渲染上下文（配对删链） */
export function dropWindowCtx(chatid) {
  const w = _wins.get(chatid);
  if (!w) return;
  try { w.virtualList?.destroy?.(); } catch { /* 已销毁 */ }
  for (const st of w.streamingMessages.values()) if (st?._skeletonTimer) clearTimeout(st._skeletonTimer);
  // 配对停链：这个窗口自己的 RAF loop 必须随窗口一起停，否则关掉的窗口还在按帧
  //   跑 renderFrame 打到已移除的 DOM 上（每窗口一份 → 每窗口都要各自 teardown）
  try { w.streamRenderer?.stopLoop?.(); w.streamRenderer?.streamingMessages?.clear?.(); } catch { /* 已销毁 */ }
  _wins.delete(chatid);
  const editPrefix = `${chatid}\u0000`;
  for (const key of _authoritativeEditState.keys()) {
    if (key.startsWith(editPrefix)) _authoritativeEditState.delete(key);
  }
  wbTrace("window", "ctx:drop", { win: chatid, left: _wins.size });
}

// [0725 凛倾「ai正在输出的情况就需要给提醒」] 当前显示窗口是否有在途流式输出——预设切换收口
//   (sharedState.switchPreset:364)经 window 桥读取，生成中切预设先弹确认提醒。
//   【why 桥在这里】原本在 StreamRenderer.mjs（那时是单例，模块自己就答得出来）。
//   多窗口后"哪个窗口在生成"只有持有窗口表的本模块知道，桥必须跟着正主走（单 producer）。
if (typeof window !== "undefined") {
  window._beiluHasActiveStream = () => _W().streamRenderer.streamingMessages.size > 0;
}


const diag = createDiag("virtualQueue");

// [多窗口 0727] 原为 const：模块加载时取一次，永久指向那一个消息区。
//   多窗口下每个窗口有自己的消息区（当前显示的那个持有标准 id #chat-messages，
//   隐藏窗口的 id 带后缀），所以这个引用必须能跟着"当前显示的窗口"走，否则新窗口的
//   消息会渲染进旧窗口（22 个使用点全部受影响）。改 let + 提供重绑出口，使用点零改动。

/** 切窗口后由 lineManager 调用：把渲染容器重新指向当前显示窗口的消息区。
 *  传 el＝直接指向该容器（后台窗口渲染用：窗口↔容器的绑定在开窗口时就建好了，
 *  消息带着 chatid 来，取出容器直接渲染进去，不需要按 currentChatId 判断）。 */
export function rebindMessagesContainer(el) {
  const target = el || document.getElementById("chat-messages");
  if (target) _W().container = target;
  return !!target;
}

/** 当前渲染容器（临时切走前先取出来，渲染完指回去） */
export function getMessagesContainer() {
  return _W().container;
}

/**
 * 按**窗口 id** 直接取该窗口的消息容器（凛倾 0727：「窗口有没有 id？信息前面能不能做 id？」）。
 * 窗口 id = chatid，开窗口时就与容器绑好了（lineManager._winEls）；WS 消息自带 chatid。
 * 两边都有 id，所以定向渲染**不需要**把全局引用指过去再指回来——那是用全局状态模拟定向，
 * 两条消息几乎同时到就会交错。按 id 现取则每次调用各自独立，天然无交错。
 * 取不到（该窗口 DOM 已回收 / 未开窗口）→ 回退当前显示的容器。
 */
export function containerFor(chatid) {
  try {
    const el = chatid && window._beiluGetWinEl?.(chatid);
    if (el) return el;
  } catch { /* lineManager 未加载 */ }
  return _W().container || document.getElementById("chat-messages");
}
let currentSwipableElement = null;
let currentTimeLineInfo = { timeLineIndex: 0, timeLinesCount: 1 };
// [0727 A11 开场白桥] 时间线信息的对外读口（单 producer=本模块，window 桥防 iframeRenderer↔本模块环）：
//   iframeRenderer 把真实 swipe 数量/索引带进卡的 iframe（st.chat[0].swipes 补齐到真实条数），
//   否则 ST 原生卡"改 swipe_id→saveChat"套路在 length 恒 1 的假数据上永远判"找不到索引"。
window._beiluTimeLineInfo = () => currentTimeLineInfo;
const deletionListeners = [];

// ★ 渲染深度修复：初始渲染时的总消息数（用于 renderMessage 的深度计算回退）

// This map holds the full message object for streaming messages,
// which is necessary for applying slices correctly.

// ============================================================
// U02 乐观本地气泡（T049）——点发送瞬间本地先出"发送中"气泡
// ------------------------------------------------------------
// 断点根因：用户气泡 100% 依赖 websocket.mjs:645 message_added 回推才渲染；
//   POST 返回→WS 回推之间是空窗期，网络/后端慢时用户看不到自己的消息，疑发送失败重复点。
// 方案：sendMessage 调 addUserReply 前先 showOptimisticUserMessage 本地渲染一个用户气泡（发送中态），
//   直接挂 #chat-messages（不进 _W().virtualList 队列，避免 index-based 队列出现幽灵项——
//   与 handleMessageDeleted 只操作 DOM 不动队列同构）。
//   随后后端广播 message_added(role=user) 到达 → handleMessageAdded 认领：移除最早的占位气泡，
//   再走正常 appendItem 落定为真正气泡（幂等去重，防"占位+回推"双份）。
//   发送失败 → sendMessage catch 调 clearOptimisticUserMessage 删占位（走正常删除路径，非吞错）。
// FIFO：允许连发多条，占位队列按顺序被后续 message_added(user) 逐个认领。

/**
 * 渲染一个乐观（发送中）用户气泡到对话区底部，立即可见。不进 _W().virtualList 队列。
 * 链路：messageInput.sendMessage → 本函数（addUserReply 之前）→ DOM 直挂 #chat-messages。
 *   认领：handleMessageAdded(role=user) 移除本占位 → 正常 appendItem 落定。
 * @param {{content?: string, files?: Array}} reply 用户输入（含附件计数用于占位显示）
 * @returns {Promise<string|null>} 占位 id（供失败时 clearOptimisticUserMessage 定位）；无容器/空内容返回 null
 */
export async function showOptimisticUserMessage(reply) {
  // 乐观气泡从渲染到 await 后挂 DOM 是同一个用户动作：入口即冻结窗口。
  // 切窗口不得让气泡的操作闭包与最终 DOM 容器分属两个 chatId。
  const ownerChatId = _winKey();
  const ownerW = _W(ownerChatId);
  if (!ownerW.container) return null;
  const content = (reply?.content || "").trim();
  const fileCount = Array.isArray(reply?.files) ? reply.files.length : 0;
  if (!content && !fileCount) return null;

  const optimisticId = "optimistic-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  // 构造合法用户消息对象交 renderMessage，视觉与真实用户气泡一致（复用同一渲染入口，不另造气泡样式）。
  const optimisticMsg = {
    id: optimisticId,
    role: "user",
    content,
    content_for_show: content || (fileCount ? `[${fileCount} 个附件]` : ""),
    is_generating: false,
    time_stamp: Date.now(),
    extension: {},
    _optimistic: true, // 标记：认领/清理时识别
  };
  try {
    // itemIndex 给一个大值（占位在最底部），totalCount 用当前渲染计数回退（depth/floor 查队列找不到本 id 会安全回退）
    const el = await renderMessage(optimisticMsg, {
      itemIndex: ownerW.renderTotalCount,
      totalCount: ownerW.renderTotalCount,
      chatId: ownerChatId,
    });
    if (!el) return null;
    el.dataset.optimistic = "1";
    el.classList.add("beilu-optimistic-sending"); // 视觉"发送中"态由 CSS 决定（设计域，此处仅打标不设视觉数值）
    ownerW.container.appendChild(el);
    ownerW.optimisticElements.push({ id: optimisticId, element: el });
    // 滚到底让用户立即看到自己的气泡
    ownerW.container.scrollTop = ownerW.container.scrollHeight;
    return optimisticId;
  } catch (err) {
    diag.warn("showOptimisticUserMessage 渲染失败（降级：无乐观气泡，仍走 WS 回推）:", err?.message);
    return null;
  }
}

/**
 * 移除指定乐观占位气泡（发送失败时由 sendMessage catch 调用）。
 * @param {string} id showOptimisticUserMessage 返回的占位 id
 */
export function clearOptimisticUserMessage(id) {
  if (!id) return false;
  const idx = _W().optimisticElements.findIndex((o) => o.id === id);
  if (idx < 0) return false;
  const [o] = _W().optimisticElements.splice(idx, 1);
  if (o.element?.parentNode) o.element.remove();
  return true;
}

/**
 * 认领并移除最早的乐观占位气泡（message_added(role=user) 到达时调用）。
 * 移除后由调用方走正常 appendItem 渲染真实气泡，实现占位→落定的幂等替换。
 * @returns {boolean} 是否消费了一个占位（true=本次 message_added 是对某乐观气泡的回推）
 */
function _claimOptimisticUserMessage() {
  const o = _W().optimisticElements.shift();
  if (!o) return false;
  if (o.element?.parentNode) o.element.remove();
  return true;
}

/**
 * T049b：切卡/重建 teardown 时清空所有乐观占位（同 P2-2 deletionListeners 泄漏型）。
 * why：_W().optimisticElements 是模块级数组，原 initializeVirtualQueue/cleanupVirtualQueueObserver 不清 →
 *   切卡时若有 in-flight 占位（用户刚发送、message_added(user) 回推未到就切卡），旧对话的占位气泡
 *   DOM 直挂 #chat-messages（:97 不进 _W().virtualList 队列），切卡 clearVirtualQueueDOM/重建不认领它 →
 *   ① Map 项残留跨对话泄漏；② 孤儿 DOM 元素滞留（虽 initializeVirtualQueue destroy 旧 list 会清 DOM，
 *   但占位不在 list 内不被 destroy 管，且数组引用泄漏会让下条 message_added(user) 误认领旧对话占位）。
 *   fire+clear：移除孤儿 DOM + 清空数组，与 :291 notifyDeletionListeners 同处收口。
 */
function _teardownOptimisticElements() {
  while (_W().optimisticElements.length) {
    const o = _W().optimisticElements.pop();
    if (o?.element?.parentNode) o.element.remove();
  }
}

/**
 * 添加一个在从 UI 中删除消息后将被调用的监听器。
 * @param {Function} callback - 要调用的函数。
 */
export function addDeletionListener(callback) {
  deletionListeners.push(callback);
}

/**
 * 通知所有已注册的删除监听器。
 * export：messageList.mjs processDeletionQueue 删除成功后调用（拆模块时漏导出=删消息即 ReferenceError 被 catch 吞成错误 toast）。
 */
export function notifyDeletionListeners() {
  while (deletionListeners.length) deletionListeners.pop()();
}

/**
 * 更新最后一个 'char' 消息的左右箭头和滑动功能。
 *
 * ★ 修复：不完全依赖 _W().virtualList.getQueue()（可能因时序问题返回空），
 *   当 queue 为空时回退到从 DOM 中直接查找最后一个 char 消息元素。
 */
function updateLastCharMessageArrows() {
  // 移除旧导航栏
  _W().container
    .querySelectorAll(".swipe-nav")
    .forEach((nav) => nav.remove());
  if (currentSwipableElement) {
    disableSwipe(currentSwipableElement);
    currentSwipableElement = null;
  }

  // 策略1：从 _W().virtualList queue 获取最后一条 char 消息
  const queue = _W().virtualList ? _W().virtualList.getQueue() : [];
  let lastMessageElement = null;

  if (queue.length > 0) {
    const lastMessage = queue[queue.length - 1];
    if (
      lastMessage &&
      lastMessage.role === "char" &&
      !lastMessage.is_generating
    ) {
      lastMessageElement = document.getElementById(lastMessage.id);
    }
  }

  // 策略2（fallback）：queue 为空时，从 DOM 中查找最后一个可见 chat-message 元素
  // 这解决了 _W().virtualList.state.queue 因时序问题为空、但 DOM 中已渲染消息的情况
  if (!lastMessageElement) {
    const allMessages = _W().container.querySelectorAll(
      ".chat-message:not(.system-hidden)",
    );
    if (allMessages.length > 0) {
      const lastEl = allMessages[allMessages.length - 1];
      // 在 DOM fallback 模式下，无法精确判断角色类型（模板未设置 data-role）
      // 但开场白场景中最后一条消息必然是 char，且 timeLinesCount > 1 时总需要箭头
      // 因此只要找到可见消息元素就尝试显示箭头
      lastMessageElement = lastEl;
      diag.log(
        "updateLastCharMessageArrows: 使用 DOM fallback，找到最后消息元素",
        lastEl.id,
      );
    }
  }

  if (!lastMessageElement) return;

  currentSwipableElement = lastMessageElement;
  // ★ 修复：在 iframe 渲染模式下，.message-content 可能有 iframe-content class
  // 无论是否是 iframe 模式，都尝试查找 .message-content 作为箭头的插入锚点
  const messageContent = lastMessageElement.querySelector(".message-content");

  if (messageContent) {
    enableSwipe(lastMessageElement);

    // 酒馆式悬浮导航：按钮仍挂在气泡内，但由 CSS 绝对定位，不参与消息高度计算。
    const navBar = document.createElement("div");
    navBar.classList.add("swipe-nav");
    navBar.setAttribute("aria-label", "切换回复");

    const leftArrow = document.createElement("button");
    leftArrow.type = "button";
    leftArrow.classList.add("arrow", "left");
    leftArrow.textContent = "❮";
    leftArrow.title = "上一条回复";
    leftArrow.setAttribute("aria-label", "上一条回复");

    const counter = document.createElement("span");
    counter.classList.add("swipe-counter");
    counter.textContent = `${currentTimeLineInfo.timeLineIndex + 1}/${currentTimeLineInfo.timeLinesCount}`;
    counter.style.opacity =
      currentTimeLineInfo.timeLinesCount > 1 ? "1" : "0.3";

    const rightArrow = document.createElement("button");
    rightArrow.type = "button";
    rightArrow.classList.add("arrow", "right");
    rightArrow.textContent = "❯";
    rightArrow.title = "下一条回复";
    rightArrow.setAttribute("aria-label", "下一条回复");

    navBar.append(leftArrow, counter, rightArrow);
    messageContent.after(navBar);

    /**
     * 移除导航栏
     */
    const removeArrows = () => {
      navBar.remove();
    };
    leftArrow.addEventListener("click", async () => {
      try {
        removeArrows();
        await modifyTimeLine(-1);
      } catch (err) {
        wbDetect("virtualQueue", "timelineNav", false, err?.message, { dir: -1 });
        console.error('[virtualQueue] timeline navigate failed:', err);
        window._reportError?.(`[virtualQueue] ${err.message}`, err.stack);
      }
    });
    rightArrow.addEventListener("click", async () => {
      try {
        removeArrows();
        await modifyTimeLine(1);
      } catch (err) {
        wbDetect("virtualQueue", "timelineNav", false, err?.message, { dir: 1 });
        console.error('[virtualQueue] timeline navigate failed:', err);
        window._reportError?.(`[virtualQueue] ${err.message}`, err.stack);
      }
    });
  }
}

/**
 * 初始化虚拟队列（总装配入口，切卡/刷新/压缩后重建时调用）。
 *
 * 链路：chat.mjs initializeChat() → 本函数 → createVirtualList → fetchData(getChatLog) → renderItem(renderMessage)
 * 影响：销毁旧 _W().virtualList + 清空 _W().streamingMessages/StreamRenderer + 清空 MVU 变量 + 清空楼层映射 + fire 旧 deletionListeners
 * 约束：调用前必须已建立 WS 连接（getChatLogLength 依赖后端 HTTP），否则 total 拿不到
 *
 * @param {object} initialData - 初始数据（timeLineIndex/timeLinesCount 用于 swipe 计数器）
 * @returns {Promise<void>}
 */
export async function initializeVirtualQueue(initialData) {
  try {
    // 键定位走单源 _winKey（见其注释）。init 是重建语义：把键定死在当前对话上，
    //   并卸掉早期无名键上下文（chatid 未就位时建的那份，留着=孤儿 RAF/列表泄漏）。
    const _k = _winKey();
    if (_k !== "__main__") {
      _activeWinId = _k;
      if (_wins.has("__main__")) dropWindowCtx("__main__");
    } // 解析不到对话 id 时**不**把 _activeWinId 钉在无名键上：钉住＝后面 chatid 就位了也不再解析，键又分家
    // 从这里起所有 await 前后都使用这一份 owner；后台窗口的 virtualList
    // 之后收到 append/replace 时，不得因当前显示窗口已变而重解析 `_W()`。
    const ownerChatId = _k;
    const ownerW = _W(ownerChatId);

    // 初始化 timeline 信息（用于 swipe 计数器显示）
    if (initialData?.timeLineIndex !== undefined) {
      currentTimeLineInfo = {
        timeLineIndex: initialData.timeLineIndex,
        timeLinesCount: initialData.timeLinesCount || 1,
      };
    }

    if (ownerW.virtualList) ownerW.virtualList.destroy();

    // M-09/M-10：清空前取消所有 pending 骨架屏 timer + 停 RAF loop，防切卡后回调/帧写到新对话或已销毁 DOM
    for (const _st of ownerW.streamingMessages.values()) { if (_st._skeletonTimer) { clearTimeout(_st._skeletonTimer); _st._skeletonTimer = null; } }
    ownerW.streamingMessages.clear();
    // M-09/M-10 + [0727 多窗口]：只停**本窗口**的 RAF loop 与流式态。
    //   原来这行打的是全站单例 → 开新窗口/补拉时把别的窗口正在生成的消息一起掐断且永不恢复
    //   （凛倾「每个窗口都是并行的，哪里来的影响？」）。现在 renderer 每窗口一份，各停各的。
    ownerW.streamRenderer.stopLoop();
    ownerW.streamRenderer.streamingMessages.clear();

    // ★ 修复：重新对话时清空旧的 MVU 变量和楼层映射
    // 否则旧对话的 messages 变量会累积到新对话中
    clearMessages();
    resetFloorMap();
    // P2-2：切卡重置 deletionListeners（模块级数组，原 init 不清 → 旧对话 in-flight 删除的 pending 监听跨对话泄漏：
    //   新对话删消息时 notifyDeletionListeners 误 pop 旧 resolve / 旧 await uiUpdated 永挂）。
    //   fire+clear：resolve 掉旧 pending await（唯一 caller messageList:541 传 resolve）后清空数组。
    notifyDeletionListeners();
    // T049b：切卡/重建清空乐观占位（同 P2-2 泄漏型，防 in-flight 占位孤儿 DOM + 跨对话误认领）。
    _teardownOptimisticElements();

    let total = await getChatLogLength();

    const msgLoadLimit = parseInt(
      storage.get(KEYS.BEILU_MSG_LOAD_LIMIT) || String(DEFAULTS.messages.loadLimit), // P2：缺省单源
      10,
    );
    let effectiveTotal = total;
    let offsetShift = 0;
    if (msgLoadLimit > 0 && total > msgLoadLimit) {
      offsetShift = total - msgLoadLimit;
      effectiveTotal = msgLoadLimit;
    }
    ownerW.chatLogOffsetShift = offsetShift;

    // renderMessage 的 itemIndex / totalCount 使用持久 chatLog 的绝对坐标系。
    // virtualList 自身仍只管理末尾 effectiveTotal 条；两套坐标不能混用，否则开启
    // msgLoadLimit 后菜单会把局部 index 当成持久下标，分叉/隐藏命中错误消息。
    // 初始渲染时 ownerW.virtualList 尚未赋值，getQueue() 返回 []，
    // 导致 renderMessage 无法正确计算渲染深度。
    // 通过 renderItem 闭包传递 { itemIndex, totalCount } 作为回退。
    ownerW.renderTotalCount = total;

    ownerW.virtualList = await createVirtualList({
      container: ownerW.container,
      /**
       * 异步函数，用于获取数据块。
       * @param {number} offset - 数据块的起始偏移量。
       * @param {number} limit - 数据块的大小。
       * @returns {Promise<{items: Array<object>, total: number}>} - 包含项目数组和总数的对象。
       */
      fetchData: async (offset, limit) => {
        const actualOffset = offset + offsetShift;
        const items = await getChatLog(actualOffset, actualOffset + limit);
        // ★ DIAG P0: 检查前端收到的数据（级别 debug：每次分页拉取都触发的逐条追踪属
        //   debug 域，warn 级会在用户开过 ?diag= 后以 WRN 刷满后台监控——0720 实抓）
        diag.debug("fetchData", {
          offset,
          actualOffset,
          limit,
          itemCount: items?.length,
          effectiveTotal,
        });
        if (items?.length > 0) {
          for (let i = 0; i < Math.min(items.length, 3); i++) {
            const m = items[i];
            diag.debug("  fetchData item", {
              i,
              id: m?.id,
              role: m?.role,
              name: m?.name,
              contentLen: m?.content?.length,
              hasTimeSlice: !!m?.timeSlice,
              keys: m ? Object.keys(m).join(",") : "null",
            });
          }
          if (items.length > 3) diag.debug("  ... more items:", items.length - 3);
        }
        return { items, total: effectiveTotal };
      },
      renderItem: (item, itemIndex) =>
        renderMessage(item, {
          itemIndex: itemIndex + offsetShift,
          totalCount: ownerW.renderTotalCount,
          chatId: ownerChatId,
        }),
      initialIndex: effectiveTotal > 0 ? effectiveTotal - 1 : 0,
      onRenderComplete: updateLastCharMessageArrows,
      itemIdKey: "id", // Use the unique 'id' property as the key
    });

    // ★ 修复：页面刷新后 MVU 变量丢失
    // 初始数据通过 HTTP fetchData 加载，不经过 WebSocket 的 message_added/message_replaced 事件，
    // 导致 _syncMvuVariablesToStore 从未被调用，__beiluVarStore.chat 为空。
    // 修复：加载完成后，从队列中找到最后一条有 mvu_variables 的消息，执行一次同步。
    try {
      const queue = ownerW.virtualList.getQueue();
      if (queue.length > 0) {
        // 从后往前找第一条有 mvu_variables 的消息
        for (let i = queue.length - 1; i >= 0; i--) {
          const msg = queue[i];
          if (
            msg?.extension?.mvu_variables &&
            Object.keys(msg.extension.mvu_variables).length > 0
          ) {
            const logIndex = ownerW.virtualList.getChatLogIndexByQueueIndex(i);
            console.log(
              `[virtualQueue] 初始加载 MVU 变量同步: queueIndex=${i}, logIndex=${logIndex}, keys=${Object.keys(msg.extension.mvu_variables).join(",")}`,
            );
            _syncMvuVariablesToStore(logIndex, msg);
            break;
          }
        }
      }
    } catch (e) {
      wbDetect("virtualQueue", "mvuInitSync", false, e?.message);
      console.warn("[virtualQueue] 初始 MVU 变量同步失败（非致命）:", e.message);
    }
  } catch (err) {
    console.error('[virtualQueue] initializeVirtualQueue failed:', err);
    wbDetect("virtualQueue", "initializeVirtualQueue", false, err?.message, { stack: err?.stack });
    window._reportError?.(`[virtualQueue] ${err.message}`, err.stack);
  }
}

/**
 * 替换队列中的消息。
 * @param {number} queueIndex - 队列中要替换的消息的索引。
 * @param {object} message - 新的消息对象。
 */
export async function replaceMessageInQueue(queueIndex, message, winId) {
  const w = _W(winId);
  if (!w.virtualList) return;
  const logIndex = w.virtualList.getChatLogIndexByQueueIndex(queueIndex);
  await w.virtualList.replaceItem(logIndex, message);
}

/**
 * 获取给定元素的队列索引。
 * @param {HTMLElement} element - 要获取索引的 DOM 元素。
 * @returns {number} 元素的队列索引，如果不是有效消息元素则返回 -1。
 */
export function getQueueIndex(element, winId) {
  const w = _W(winId);
  return w.virtualList ? w.virtualList.getQueueIndex(element) : -1;
}

/**
 * 根据队列索引获取聊天日志索引。
 * @param {number} queueIndex - 队列中的索引。
 * @returns {number} 聊天日志中的索引，如果索引无效则返回 -1。
 */
export function getChatLogIndexByQueueIndex(queueIndex) {
  if (!_W().virtualList) return -1;
  const idx = _W().virtualList.getChatLogIndexByQueueIndex(queueIndex);
  return idx >= 0 ? idx + _W().chatLogOffsetShift : -1;
}

/**
 * 根据队列索引获取消息元素。
 * @param {number} queueIndex - 队列中的索引。
 * @returns {HTMLElement|null} 对应的消息 DOM 元素，如果不存在则为 null。
 */
export function getMessageElementByQueueIndex(queueIndex, winId) {
  const w = _W(winId);
  if (!w.virtualList) return null;
  const item = w.virtualList.getQueue()[queueIndex];
  if (!item) return null;
  const element = document.getElementById(item.id);
  return element && w.container?.contains(element) ? element : null;
}

// 编辑回填的唯一权威入口。HTTP ack 与 WS message_edited 都必须按
// chatId + messageId 找到原窗口，再按 _editVersion 单调应用；不得在 await 后重读当前 _W()。
const _authoritativeEditState = new Map();
const _authoritativeEditChains = new Map();

function _authoritativeEditKey(chatId, messageId) {
  return `${chatId}\u0000${messageId}`;
}

function _validEditVersion(entry) {
  return Number.isSafeInteger(entry?._editVersion) && entry._editVersion > 0
    ? entry._editVersion
    : null;
}

function _findMessageInWindow(chatId, messageId) {
  const w = _W(chatId);
  if (!w.virtualList) return { w, queueIndex: -1, logIndex: -1, entry: null, element: null };
  const queue = w.virtualList.getQueue();
  const queueIndex = queue.findIndex((item) => item?.id === messageId);
  if (queueIndex < 0) return { w, queueIndex: -1, logIndex: -1, entry: null, element: null };
  const candidate = document.getElementById(messageId);
  return {
    w,
    queueIndex,
    logIndex: w.virtualList.getChatLogIndexByQueueIndex(queueIndex),
    entry: queue[queueIndex],
    element: candidate && w.container?.contains(candidate) ? candidate : null,
  };
}

function _queueAuthoritativeEdit(key, task) {
  const previous = _authoritativeEditChains.get(key) || Promise.resolve();
  const current = previous
    .catch((error) => {
      console.error("[virtualQueue] previous authoritative edit failed:", error);
    })
    .then(task);
  _authoritativeEditChains.set(key, current);
  return current.finally(() => {
    if (_authoritativeEditChains.get(key) === current) _authoritativeEditChains.delete(key);
  });
}

/** 标记某个窗口的某条消息已进入编辑态，WS 编辑广播在此期间只挂起最新版本。 */
export function beginAuthoritativeEdit(chatId, messageId) {
  if (!chatId || !messageId) return false;
  const key = _authoritativeEditKey(chatId, messageId);
  const found = _findMessageInWindow(chatId, messageId);
  if (!found.entry) return false;
  const state = _authoritativeEditState.get(key) || {};
  state.editing = true;
  state.pending = null;
  state.appliedVersion = Math.max(
    Number.isSafeInteger(state.appliedVersion) ? state.appliedVersion : 0,
    _validEditVersion(found.entry) || 0,
  );
  _authoritativeEditState.set(key, state);
  return true;
}

/**
 * 按窗口和稳定消息 ID 应用后端权威编辑条目。
 * @returns {Promise<{applied:boolean,deferred?:boolean,stale?:boolean,reason?:string,version?:number}>}
 */
export function applyAuthoritativeEdit(
  chatId,
  entry,
  {
    deferWhileEditing = false,
    source = "unknown",
    editOperationId = null,
    payloadFingerprint = null,
  } = {},
) {
  const messageId = typeof entry?.id === "string" ? entry.id : "";
  const version = _validEditVersion(entry);
  if (!chatId || !messageId || version == null) {
    return Promise.resolve({ applied: false, reason: "invalid_authoritative_edit" });
  }
  const key = _authoritativeEditKey(chatId, messageId);
  return _queueAuthoritativeEdit(key, async () => {
    const state = _authoritativeEditState.get(key) || {
      editing: false,
      pending: null,
      appliedVersion: 0,
    };
    const found = _findMessageInWindow(chatId, messageId);
    if (!found.entry || found.logIndex < 0) {
      return { applied: false, reason: "message_not_rendered", version };
    }

    const localVersion = _validEditVersion(found.entry) || 0;
    const pendingVersion = _validEditVersion(state.pending?.entry) || 0;
    const knownVersion = Math.max(localVersion, state.appliedVersion || 0, pendingVersion);
    if (version <= knownVersion) {
      return {
        applied: false,
        stale: true,
        reason: "stale_edit_version",
        version,
        editOperationId,
        payloadFingerprint,
      };
    }
    if (state.editing && deferWhileEditing) {
      state.pending = { entry, source, editOperationId, payloadFingerprint };
      _authoritativeEditState.set(key, state);
      return { applied: false, deferred: true, version, editOperationId, payloadFingerprint };
    }

    if (found.element) {
      await found.w.virtualList.replaceItem(found.logIndex, entry);
    } else {
      // virtualList.replaceItem 在该行没有当前 DOM 时会直接 return，连 queue 也不更新。
      // 离屏消息仍要先写队列真值，否则之后滚回来会渲染旧版。
      found.w.virtualList.getQueue()[found.queueIndex] = entry;
    }
    state.appliedVersion = version;
    state.pending = null;
    _authoritativeEditState.set(key, state);
    return { applied: true, version, editOperationId, payloadFingerprint };
  });
}

/** 退出编辑态；如果期间收到更新 WS 版本，在原 chatId 窗口继续单调应用。 */
export async function endAuthoritativeEdit(chatId, messageId, { applyPending = true } = {}) {
  const key = _authoritativeEditKey(chatId, messageId);
  const state = _authoritativeEditState.get(key);
  if (!state) return { applied: false, reason: "edit_state_missing" };
  state.editing = false;
  const pending = state.pending;
  state.pending = null;
  _authoritativeEditState.set(key, state);
  if (applyPending && pending?.entry) {
    return applyAuthoritativeEdit(chatId, pending.entry, {
      deferWhileEditing: false,
      source: pending.source || "pending_websocket",
      editOperationId: pending.editOperationId,
      payloadFingerprint: pending.payloadFingerprint,
    });
  }
  return { applied: false, reason: "no_pending_edit" };
}

/**
 * 未知 HTTP 结果时，只消费与本次 operationId 对应的权威 WS；不匹配则保持 textarea。
 */
export async function consumePendingAuthoritativeEdit(chatId, messageId, editOperationId) {
  const key = _authoritativeEditKey(chatId, messageId);
  const state = _authoritativeEditState.get(key);
  if (!state?.pending || !editOperationId || state.pending.editOperationId !== editOperationId) {
    return { applied: false, reason: "matching_pending_edit_missing" };
  }
  state.editing = false;
  const pending = state.pending;
  state.pending = null;
  _authoritativeEditState.set(key, state);
  return applyAuthoritativeEdit(chatId, pending.entry, {
    deferWhileEditing: false,
    source: pending.source || "pending_websocket_reconcile",
    editOperationId: pending.editOperationId,
    payloadFingerprint: pending.payloadFingerprint,
  });
}

/** 仅重渲染原窗口当前队列真值，用于取消/失败退出 textarea，不改写编辑版本。 */
export async function rerenderMessageForChat(chatId, messageId) {
  const found = _findMessageInWindow(chatId, messageId);
  if (!found.entry || found.logIndex < 0) return false;
  await found.w.virtualList.replaceItem(found.logIndex, found.entry);
  return true;
}

/**
 * 清理虚拟队列的观察者。
 */
export function cleanupVirtualQueueObserver() {
  if (_W().virtualList) {
    _W().virtualList.destroy();
    _W().virtualList = null;
  }
  if (currentSwipableElement) {
    disableSwipe(currentSwipableElement);
    currentSwipableElement = null;
  }
  for (const _st of _W().streamingMessages.values()) { if (_st._skeletonTimer) { clearTimeout(_st._skeletonTimer); _st._skeletonTimer = null; } } // M-09: 取消 pending 骨架屏 timer
  _W().streamingMessages.clear();
  _W().streamRenderer.stopLoop(); _W().streamRenderer.streamingMessages.clear(); // M-10: 停 RAF loop（本窗口那份）
  _teardownOptimisticElements(); // T049b: 彻底 teardown 时也清乐观占位孤儿 DOM
}

// --- Handlers for websocket events ---

/**
 * 处理消息添加事件。
 * @param {object} message - 要添加的消息对象。
 */
export async function handleMessageAdded(message, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  if (!_w.virtualList) return;

  // U02：用户消息回推 = 对某个乐观占位气泡的落定 → 先认领移除最早的占位，再走正常渲染（幂等去重，防双份）。
  //   仅 role=user 且存在占位时消费；AI 消息 / 无占位时不影响。
  if (message.role === "user") _claimOptimisticUserMessage();

  // 使用事件队列确保顺序处理
  await enqueueMessageEvent(message.id, "message_added", async () => {
    if (message.is_generating) {
      // 如果是正在生成的消息，先不添加到列表（避免显示空气泡）
      // 标记为 pendingRender，等待第一次 stream_update 或 message_replaced 时再渲染
      const itemState = {
        messageData: message,
        pendingRender: true,
      };
      _w.streamingMessages.set(message.id, itemState);

      // 设置 500ms 超时，如果超时还没收到 stream_update，强制渲染骨架屏。
      // M-09：存 timer id 到 itemState，切卡 teardown 时取消，防超时回调在切卡后把【旧对话】骨架屏插进新对话。
      itemState._skeletonTimer = setTimeout(async () => {
        itemState._skeletonTimer = null;
        if (itemState.pendingRender) {
          itemState.pendingRender = false;
          const shouldScroll =
            _w.container.scrollTop >=
            _w.container.scrollHeight -
              _w.container.clientHeight -
              20;
          await _w.virtualList.appendItem(message, shouldScroll);
        }
      }, 500);
    } else {
      // 普通消息直接添加
      const shouldScroll =
        _w.container.scrollTop >=
        _w.container.scrollHeight -
          _w.container.clientHeight -
          20;
      await _w.virtualList.appendItem(message, shouldScroll);
    }
  });
}

/**
 * 处理消息替换事件（WS message_replaced 的消费端，生成完成时触发）。
 *
 * 链路：websocket.mjs handleBroadcastEvent("message_replaced") → 本函数
 *       → 先 streamRenderer.stop(防纯文本覆盖已渲染的正则/iframe HTML)
 *       → _w.virtualList.replaceItem(重新调 renderMessage 渲染完整消息)
 * 影响：停止 StreamRenderer、从 _w.streamingMessages 删除、清除 typing indicator
 * 约束：必须在 replaceItem 之前 stop StreamRenderer——否则 renderFrame 会在 replaceItem
 *   完成后用纯文本覆盖正则处理后的 HTML 内容
 *
 * @param {number} index - 被替换消息的 chatLog 日志索引
 * @param {object} message - 新的完整消息对象（后端返回，含 content_for_show）
 */
export async function handleMessageReplaced(index, message, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  if (!_w.virtualList) return;
  // 诊断探针走 diag 门控（裸 console.log 曾对所有用户每条消息替换都打 80 字预览刷屏）
  diag.debug("THINKING DIAG message_replaced:", { id: message.id, has_cfs: message.content_for_show !== undefined, cfs_len: message.content_for_show?.length, content_len: message.content?.length, content_preview: message.content?.substring(0, 80) });

  // 使用事件队列确保顺序处理
  await enqueueMessageEvent(message.id, "message_replaced", async () => {
    const itemState = _w.streamingMessages.get(message.id);

    // 如果消息处于 pendingRender 状态（说明是非流式角色，或者流式角色生成极快直接完成了）
    // 此时直接作为新消息添加到列表底部
    if (itemState?.pendingRender) {
      itemState.pendingRender = false;
      // ★ 关键：先停止 StreamRenderer，防止覆盖新渲染的内容
      _w.streamRenderer.stop(message.id);
      _w.streamingMessages.delete(message.id);
      const shouldScroll =
        _w.container.scrollTop >=
        _w.container.scrollHeight -
          _w.container.clientHeight -
          20;
      await _w.virtualList.appendItem(message, shouldScroll);
      if (!message.is_generating) handleTypingStatus([]);
      updateLastCharMessageArrows();
      return;
    }

    // ★ 关键修复：在 replaceItem 之前停止 StreamRenderer
    // 否则 StreamRenderer 的 renderFrame 会在 replaceItem 完成后
    // 用纯文本覆盖正则处理后的 HTML 内容
    if (_w.streamingMessages.has(message.id)) {
      _w.streamRenderer.stop(message.id);
      _w.streamingMessages.delete(message.id);
    }

    // 也检查队列中旧消息的 streaming 状态
    const queue = _w.virtualList.getQueue();
    for (let i = 0; i < queue.length; i++) {
      const oldItem = queue[i];
      if (
        oldItem &&
        oldItem.id !== message.id &&
        _w.streamingMessages.has(oldItem.id)
      ) {
        const logIndex = _w.virtualList.getChatLogIndexByQueueIndex(i);
        if (logIndex === index) {
          _w.streamRenderer.stop(oldItem.id);
          _w.streamingMessages.delete(oldItem.id);
          break;
        }
      }
    }

    // 策略：先尝试通过 chatLog index 替换；如果失败，再尝试通过 messageId 在队列中查找并替换
    const currentQueue = _w.virtualList.getQueue();
    let foundByIndex = false;
    let foundByIdQueueIdx = -1;

    for (let i = 0; i < currentQueue.length; i++) {
      const logIdx = _w.virtualList.getChatLogIndexByQueueIndex(i);
      if (logIdx === index) {
        foundByIndex = true;
        break;
      }
      // 同时查找队列中是否有同 id 的旧消息（骨架屏）
      if (currentQueue[i]?.id === message.id) foundByIdQueueIdx = i;
    }

    if (foundByIndex) {
      await _w.virtualList.replaceItem(index, message);
    } else if (foundByIdQueueIdx >= 0) {
      const logIdx = _w.virtualList.getChatLogIndexByQueueIndex(foundByIdQueueIdx);
      await _w.virtualList.replaceItem(logIdx, message);
    } else {
      // [P1-3 0805] 防重复：index/id都找不到时，先按message.id查队列是否已有同id消息
      //   （WS重复投递/竞态可能导致同一消息走两次message_replaced），存在则replace不append。
      const _dupIdx = currentQueue.findIndex(item => item?.id === message.id);
      if (_dupIdx >= 0) {
        const _dupLogIdx = _w.virtualList.getChatLogIndexByQueueIndex(_dupIdx);
        await _w.virtualList.replaceItem(_dupLogIdx >= 0 ? _dupLogIdx : _dupIdx, message);
      } else {
        const shouldScroll =
          _w.container.scrollTop >=
          _w.container.scrollHeight -
            _w.container.clientHeight -
            20;
        await _w.virtualList.appendItem(message, shouldScroll);
      }
    }

    // 消息完成时强制清除 typing indicator
    if (!message.is_generating) {
      handleTypingStatus([]);
    } else {
      // 仍在生成中（不太可能走到这里，但作为防御）
      _w.streamingMessages.set(message.id, { messageData: message });
      // ★ Phase 1.2：传递 rawContent 和 mvuVariables，确保流式 iframe 渲染契约完整
      _w.streamRenderer.register(message.id, message.content, {
        rawContent: message.content_for_show || message.content,
        mvuVariables: message.extension?.mvu_variables || {},
      });
    }

    updateLastCharMessageArrows();
  });
}

/**
 * 处理消息移除事件。
 * @param {number} index - 被移除消息的日志索引（旧广播兼容提示）。
 * @param {string} [messageId] - 被移除消息的稳定 ID；存在时必须优先于 index。
 */
export async function handleMessageDeleted(index, messageId, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  if (!_w.virtualList) return;

  const queue = _w.virtualList.getQueue();
  const _ofs = _w.chatLogOffsetShift || 0; // virtualList 内部索引是局部的，需加 offset 才是绝对 chatLog 下标
  for (let i = 0; i < queue.length; i++) {
    const rawIdx = _w.virtualList.getChatLogIndexByQueueIndex(i);
    const logIndex = rawIdx >= 0 ? rawIdx + _ofs : -1;
    const item = queue[i];
    // 新协议有 messageId 时绝不退回 index，避免另一个客户端已回档/删除后错藏相同下标的新消息。
    const matched = typeof messageId === "string" && messageId
      ? item?.id === messageId
      : logIndex === index;
    if (matched) {
      if (item && _w.streamingMessages.has(item.id)) {
        _w.streamRenderer.stop(item.id);
        _w.streamingMessages.delete(item.id);
      }
      const el = document.getElementById(item?.id);
      if (el) el.style.display = "none";
      break;
    }
  }
  notifyDeletionListeners();
}

/**
 * 处理消息隐藏/恢复事件（_hidden 掩码变化）。对当前视图内受影响消息即时切换灰显；
 * 不在视图内的，下次渲染时由 renderMessage 读 extension._hidden 正确显示。幂等（force toggle）。
 * @param {number[]} indices - 受影响的 chatLog 原始下标
 * @param {boolean} hide - true=隐藏(灰显), false=恢复显示
 */
export function handleMessagesHidden(indices, hide, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  if (!_w.virtualList || !Array.isArray(indices) || indices.length === 0) return;
  const target = new Set(indices);
  const queue = _w.virtualList.getQueue();
  const _ofs = _w.chatLogOffsetShift || 0; // virtualList 内部索引是局部的，需加 offset 才是绝对 chatLog 下标
  for (let i = 0; i < queue.length; i++) {
    const rawIdx = _w.virtualList.getChatLogIndexByQueueIndex(i);
    const logIndex = rawIdx >= 0 ? rawIdx + _ofs : -1;
    if (!target.has(logIndex)) continue;
    const el = document.getElementById(queue[i].id);
    if (!el) continue;
    el.classList.toggle("beilu-hidden-msg", !!hide);
    el.setAttribute("data-hidden", hide ? "true" : "false");
  }
}

/**
 * 处理批量消息删除事件（文件模式退出时的清理）。
 * @param {number} startIndex - 起始索引（含）
 * @param {number} count - 删除数量
 * @param {string[]} [messageIds] - 实际落盘删除的稳定 ID 列表；存在时优先于索引范围。
 */
export async function handleMessagesRangeDeleted(startIndex, count, messageIds, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  if (!_w.virtualList || count <= 0) return;

  const queue = _w.virtualList.getQueue();
  const _ofs = _w.chatLogOffsetShift || 0; // virtualList 内部索引是局部的，需加 offset 才是绝对 chatLog 下标
  const deletedMessageIds = Array.isArray(messageIds) && messageIds.length > 0
    ? new Set(messageIds)
    : null;
  // 倒序遍历：先删后面的再删前面的，避免 deleteItem 内部调整后续元素键导致索引漂移
  for (let j = queue.length - 1; j >= 0; j--) {
    const rawIdx = _w.virtualList.getChatLogIndexByQueueIndex(j);
    const logIndex = rawIdx >= 0 ? rawIdx + _ofs : -1;
    const item = queue[j];
    const matched = deletedMessageIds
      ? deletedMessageIds.has(item?.id)
      : logIndex >= startIndex && logIndex < startIndex + count;
    if (matched) {
      if (item && _w.streamingMessages.has(item.id)) {
        _w.streamRenderer.stop(item.id);
        _w.streamingMessages.delete(item.id);
      }
      // 从 queue 真正删除（替代只 DOM 隐藏），释放内存并保持队列与后端权威记录一致
      // deleteItem 接受的是 rawIdx（内部局部绝对索引），不是 logIndex（rawIdx+_ofs）
      if (rawIdx >= 0) {
        await _w.virtualList.deleteItem(rawIdx);
      } else {
        const el = document.getElementById(item?.id);
        if (el) el.style.display = "none";
      }
    }
  }

  notifyDeletionListeners();
  updateLastCharMessageArrows();
}

/**
 * 获取当前渲染的消息队列。
 * @returns {Array<object>} 当前队列数组。
 */
export function getQueue() {
  return _W().virtualList ? _W().virtualList.getQueue() : [];
}

// ============================================================
// R-HR: 美化热重载
//
// 用途:开发美化代码时,保存后想立刻看到效果,不用整页 Ctrl+F5
//   1. 刷新 display 规则缓存(refreshDisplayRules 清掉 30s TTL 立即重拉)
//   2. 最近 N 条消息走 replaceMessageInQueue 重新渲染(触发 iframe 重建)
//
// 入口(任一触发):
//   - 键盘快捷键 Ctrl+Shift+R (main init 里绑定)
//   - iframe postMessage {type:'beilu-reload-beautify', limit?}
//   - 父页面直接调 reloadBeautify()
// ============================================================
/**
 * 美化热重载：刷新 display 规则缓存 + 重渲染最近 N 条消息。
 *
 * 链路：Ctrl+Shift+R / iframe postMessage / 外部直调 → 本函数
 *       → refreshDisplayRules（清 30s TTL 缓存，重拉后端最新正则规则）
 *       → replaceMessageInQueue × N（触发 renderMessage 重渲染，含 iframe 重建）
 * 影响：修改 displayRegex 缓存、替换最近 N 条消息的 DOM
 *
 * @param {number} [limit=10] - 重渲染最近几条消息（最大值为队列长度）
 */
export async function reloadBeautify(limit = 10) {
  try {
    // 1. 刷新规则缓存
    const { refreshDisplayRules } = await import("./displayRegex.mjs");
    if (typeof refreshDisplayRules === "function") {
      await refreshDisplayRules();
    }
  } catch (e) {
    wbDetect("virtualQueue", "beautifyReloadRules", false, e?.message);
    console.warn("[reloadBeautify] refreshDisplayRules failed:", e);
  }

  // 2. 重渲染最近 N 条消息
  const queue = getQueue();
  const n = Math.max(1, Math.min(Number(limit) || 10, queue.length));
  const start = Math.max(0, queue.length - n);
  for (let i = start; i < queue.length; i++) {
    const msg = queue[i];
    if (!msg) continue;
    try {
      await replaceMessageInQueue(i, msg);
    } catch (e) {
      wbDetect("virtualQueue", "beautifyReloadRender", false, e?.message, { index: i });
      console.warn(`[reloadBeautify] re-render message #${i} failed:`, e);
    }
  }
  console.log(`[reloadBeautify] 重载完成: ${queue.length - start} 条消息`);
}

// Message event queue system to handle race conditions elegantly
// Each message ID has its own queue that processes events sequentially
const messageEventQueues = new Map();

/**
 * 将消息事件加入队列并按顺序处理。
 * @param {string} messageId - 消息的唯一ID。
 * @param {string} eventType - 事件类型（用于日志）。
 * @param {Function} handler - 处理该事件的异步函数。
 * @returns {Promise<void>}
 */
async function enqueueMessageEvent(messageId, eventType, handler) {
  if (!messageEventQueues.has(messageId))
    messageEventQueues.set(messageId, {
      queue: [],
      processing: false,
    });

  const queueData = messageEventQueues.get(messageId);
  queueData.queue.push({ eventType, handler });

  // 如果当前没有在处理队列，开始处理
  if (!queueData.processing) processMessageEventQueue(messageId);
}

/**
 * 处理消息的事件队列。
 * @param {string} messageId - 消息的唯一ID。
 * @returns {Promise<void>}
 */
async function processMessageEventQueue(messageId) {
  const queueData = messageEventQueues.get(messageId);
  if (!queueData || queueData.processing) return;

  queueData.processing = true;

  while (queueData.queue.length > 0) {
    const { eventType, handler } = queueData.queue.shift();
    try {
      await handler();
    } catch (error) {
      console.error(
        `[EventQueue] Error processing ${eventType} for message ${messageId}:`,
        error,
      );
      wbDetect("virtualQueue", "processMessageEventQueue", false, error?.message, { eventType, messageId });
    }
  }

  queueData.processing = false;
  messageEventQueues.delete(messageId); // 处理完成后清理队列
}

/**
 * 处理 timeline_info 事件（更新 swipe 计数器）。
 * @param {object} info - { timeLineIndex, timeLinesCount }
 */
export function handleTimelineInfo(info, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  if (info) {
    currentTimeLineInfo = {
      timeLineIndex: info.timeLineIndex ?? 0,
      timeLinesCount: info.timeLinesCount ?? 1,
    };
    updateLastCharMessageArrows();
  }
}

/**
 * 处理流式更新（WS stream_update 的消费端，流式渲染链路核心节点）。
 *
 * 链路：websocket.mjs handleBroadcastEvent("stream_update") → 本函数
 *       → 首帧：_w.virtualList.appendItem(上屏) + streamRenderer.register(注册逐字渲染)
 *       → 每帧：applySlice(数据层拼接) + streamRenderer.updateTarget(DOM 逐字渲染)
 *       → _emitStreamTokenReceived(广播到 EventBus，iframe 脚本订阅做打字机/口型)
 * 影响：修改 _w.streamingMessages Map 中的 messageData.content、触发 DOM 更新、广播 EventBus 事件
 *
 * @param {object} payload - 更新数据
 * @param {string} payload.messageId - 消息的唯一ID
 * @param {Array<object>} payload.slices - 要应用的切片数组（append/rewrite_tail/set_files 三型）
 */
export async function handleStreamUpdate({ messageId, slices }, winId) {
  const _w = _W(winId); // [多窗口] 按消息自带的窗口 id 取该窗口渲染上下文（参数传递，无全局交错）
  wbTrace("virtualQueue", "handleStreamUpdate", { messageId, sliceCount: slices?.length });
  // 使用事件队列确保顺序处理
  await enqueueMessageEvent(messageId, "stream_update", async () => {
    const itemState = _w.streamingMessages.get(messageId);
    if (!itemState) return;

    // 如果消息处于 pendingRender 状态，说明是第一次收到流更新
    // 此时才将消息添加到列表（开始渲染）
    if (itemState.pendingRender) {
      wbTrace("virtualQueue", "handleStreamUpdate.firstFrame", { messageId });
      const shouldScroll =
        _w.container.scrollTop >=
        _w.container.scrollHeight -
          _w.container.clientHeight -
          20;
      await _w.virtualList.appendItem(itemState.messageData, shouldScroll);
      itemState.pendingRender = false;
      // ★ Phase 1.2：注册到 streamRenderer 时传递 rawContent 和 mvuVariables
      // ★ T10：额外传 message（宏 replaceMacros 需要）+ role/charName/messageDepth（applyDisplayRules 需要），
      //   让流式帧能复用落稿同一套加工（宏/折叠/正则），消除流式↔落稿视觉跳变。字段就在 msg 手边，零成本。
      const msg = itemState.messageData;
      _w.streamRenderer.register(messageId, msg.content, {
        rawContent: msg.content_for_show || msg.content,
        mvuVariables: msg.extension?.mvu_variables || {},
        message: msg,
        role: msg.role || (msg.is_user ? "user" : ""),
        charName: msg.timeSlice?.charname || msg.name || "",
        messageDepth: msg.messageDepth || 0,
      });
    } else if (!_w.streamRenderer.streamingMessages.has(messageId)) {
      // 500ms 超时已渲染骨架屏，但 streamRenderer 还未注册
      // 此处补注册，使后续 updateTarget 生效，启动逐字渲染
      const msg = itemState.messageData;
      wbTrace("virtualQueue", "handleStreamUpdate.lateRegister", { messageId });
      console.log(
        "[virtualQueue DIAG] handleStreamUpdate: late register to streamRenderer. messageId:",
        messageId,
      );
      _w.streamRenderer.register(messageId, msg.content || "", {
        rawContent: msg.content_for_show || msg.content || "",
        mvuVariables: msg.extension?.mvu_variables || {},
        // ★ T10：同上——lateRegister 分支同样补传，保证两条注册路径流式加工一致。
        message: msg,
        role: msg.role || (msg.is_user ? "user" : ""),
        charName: msg.timeSlice?.charname || msg.name || "",
        messageDepth: msg.messageDepth || 0,
      });
    }

    // Apply patches to the data model
    for (const slice of slices) applySlice(itemState.messageData, slice);
    wbTrace("virtualQueue", "handleStreamUpdate.applySlice", { messageId, sliceCount: slices?.length, contentLen: itemState.messageData.content?.length });

    // Notify the renderer of the new target content
    _w.streamRenderer.updateTarget(messageId, itemState.messageData.content);
    wbTrace("virtualQueue", "handleStreamUpdate.updateTarget", { messageId, contentLen: itemState.messageData.content?.length });

    // R1: 广播 STREAM_TOKEN_RECEIVED 到 EventBus,iframe 脚本可订阅做打字机/状态栏/嘴型同步等
    //   payload: { messageId, slices, fullContent } — iframe 内用户代码自己 throttle / 过滤
    _emitStreamTokenReceived(messageId, slices, itemState.messageData.content);
    wbTrace("virtualQueue", "handleStreamUpdate.emitToken", { messageId });
  });
}

// R1: 将 token 事件送到 __beiluEventBus,脚本 iframe 通过 eventOn(...) 订阅
//   三个别名都触发,iframe 可选一个监听(对齐酒馆 iframe_events + 自定义短名):
//     js_stream_token_received_fully         — 每帧完整文本 (fullContent 字段)
//     js_stream_token_received_incrementally — 每帧增量 slices (slices 字段)
//     stream_token_received                  — 通用短名 (含两者)
//   payload 都是 {messageId, slices, fullContent}, iframe 端自行 throttle
function _emitStreamTokenReceived(messageId, slices, fullContent) {
  const bus = typeof window !== "undefined" ? window.__beiluEventBus : null;
  if (!bus || !bus._listeners) return;
  const names = [
    "stream_token_received",
    "js_stream_token_received_fully",
    "js_stream_token_received_incrementally",
  ];
  const data = { messageId, slices, fullContent };
  for (const name of names) {
    const listeners = bus._listeners.get(name);
    if (!listeners || listeners.length === 0) continue;
    listeners.slice().forEach((cb) => {
      try { cb(data); }
      catch (e) { console.error(`[${name} listener]`, e); wbDetect("virtualQueue", "_emitStreamTokenReceived", false, e?.message, { name, messageId }); }
    });
  }
}
