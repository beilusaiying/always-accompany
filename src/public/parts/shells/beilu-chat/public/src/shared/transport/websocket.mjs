/**
 * [websocket.mjs] — WebSocket 连接管理 + 服务端事件分发中枢。不管消息渲染（那是 virtualQueue/messageList 的事），
 *   不管 API 请求（那是 endpoints.mjs 的事），不管输入框（那是 messageInput.mjs 的事）。
 *
 * 职责：
 *   1. initializeWebSocket() / reconnectWebSocket()：建立/重连 WS（SSE）连接，监听服务端推事件
 *   2. sendWebsocketMessage()：向后端 POST /api/parts/shells:chat/:chatid/message 发消息指令（发送/停止）
 *   3. handleBroadcastEvent()：服务端广播事件路由——将 message_* / stream_* / timeline_info 等分发到各处理函数
 *   4. EventBus 桥接：_emitEventBus / emitBeiluEvent / emitEmotionChanged——把后端事件转发给 iframe 脚本
 *   5. MVU 变量同步：_syncMvuVariablesToStore——把 message_replaced 带来的变量写入前端 variableStore
 *   6. 唤醒轮询：_scheduleWakeup——连接静默时定时心跳保活
 *
 * 链路：onServerEvent(SSE) → handleBroadcastEvent → 分发到：
 *         message_added/replaced/deleted/hidden → virtualQueue.mjs
 *         stream_update → virtualQueue.mjs → stream.mjs applySlice → StreamRenderer.mjs
 *         timeline_info → virtualQueue.mjs handleTimelineInfo
 *         typing_status → typingIndicator.mjs handleTypingStatus
 *         char_list / plugin_list / mode_change → chat.mjs 状态更新 / sidebar
 *       chat.mjs → initializeWebSocket / reconnectWebSocket / sendWebsocketMessage
 * 影响：建立长连接（SSE/WS）；写 window.__beiluEmotionState；dispatch beilu:emotion-changed CustomEvent；
 *       dispatch beilu:char-changed / character-switched 事件；更新 script-iframe SillyTavern.chat 数组
 * 相交：← chat.mjs（初始化/重连/发消息）
 *       → virtualQueue.mjs（消息队列事件）→ typingIndicator.mjs（输入状态）
 *       → variableStore.mjs（MVU变量同步）→ whitebox.mjs（链路追踪）
 *       → server_events.mjs（SSE底层连接）
 *
 * 点击后发生什么：
 *   用户点"发送" → messageInput → sendWebsocketMessage(POST message) → 后端推 stream_update SSE
 *   → handleBroadcastEvent → virtualQueue handleStreamUpdate → StreamRenderer 逐字渲染
 *   用户点"停止" → stopGeneration (chat.mjs) → sendWebsocketMessage({type:'stop'})
 *   页面加载 → chat.mjs initializeChat → initializeWebSocket → SSE 连接建立，开始收事件
 */
import { onServerEvent } from "../../../../../../scripts/server_events.mjs";
import { notifyDesktop } from "../../../../../../scripts/desktopNotify.mjs";

import { createDiag } from "../state/diagLogger.mjs";
import { currentChatId } from "./endpoints.mjs";
import { wbIngestBackend, wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { MODE_TO_TAB } from "../state/modeTabMap.mjs";
import { sendAction } from "./sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），runtime-params/new/bindChatMode 收口（WS 通道 sendWebsocketMessage 不动）
import { emitEventBusDetached } from "../state/eventBusCore.mjs"; // [0807 转接二期#6] emit 单源叶子（await+可变引用语义收口）

const diag = createDiag("websocket");
let _wakeupTimerId = null;

function _getToolJobsMap() {
  if (window._beiluToolJobs instanceof Map) return window._beiluToolJobs;
  const rows = Array.isArray(window._beiluToolJobs) ? window._beiluToolJobs : [];
  const map = new Map();
  for (const job of rows) {
    const id = job?.jobId || job?.requestId;
    if (id) map.set(id, job);
  }
  window._beiluToolJobs = map;
  return map;
}

function _formatToolJobDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
}

const _toolJobEventSignatures = new Set();
const _terminalToolJobStates = new Set([
  "succeeded",
  "failed",
  "connection_lost",
  "orphan_result",
]);

function _pruneToolJobsMap(jobs) {
  const limit = Number(window._beiluToolJobHistoryLimit);
  if (!Number.isFinite(limit) || limit < 1 || jobs.size <= limit) return;
  const terminal = [...jobs.entries()]
    .filter(([, value]) => _terminalToolJobStates.has(value?.state || value?.status))
    .sort(([, a], [, b]) => String(a?.updatedAt || a?.createdAt || "")
      .localeCompare(String(b?.updatedAt || b?.createdAt || "")));
  for (const [id] of terminal) {
    if (jobs.size <= limit) break;
    jobs.delete(id);
  }
}

function _handleToolJobUpdate(payload) {
  const job = payload?.job;
  const id = job?.jobId || job?.requestId;
  if (!id) return;
  const jobs = _getToolJobsMap();
  const existing = jobs.get(id);
  const incomingVersion = Number(job?.version);
  const existingVersion = Number(existing?.version);
  if (
    Number.isFinite(incomingVersion) &&
    Number.isFinite(existingVersion) &&
    incomingVersion < existingVersion
  ) return;
  if (
    (!Number.isFinite(incomingVersion) || !Number.isFinite(existingVersion)) &&
    existing?.updatedAt &&
    job?.updatedAt &&
    String(job.updatedAt) < String(existing.updatedAt)
  ) return;
  // 用户广播可能经本页多个 chat WS 到达；同一状态版本只消费一次，避免重复弹窗。
  const signature = [
    id,
    job.version ?? "",
    job.updatedAt || "",
    job.state || job.status || "",
    job.duration ?? "",
    job.error?.message || job.error || "",
    payload?.notify === true ? "1" : "0",
  ].join("|");
  if (_toolJobEventSignatures.has(signature)) return;
  _toolJobEventSignatures.add(signature);
  if (_toolJobEventSignatures.size > 500) {
    _toolJobEventSignatures.delete(_toolJobEventSignatures.values().next().value);
  }
  const merged = { ...(jobs.get(id) || {}), ...job };
  jobs.set(id, merged);
  _pruneToolJobsMap(jobs);
  window._beiluToolJobsRevision = Number(window._beiluToolJobsRevision || 0) + 1;

  const detail = { job: merged, notify: payload?.notify === true };
  window.dispatchEvent(new CustomEvent("beilu:tool-job-update", { detail }));
  window.dispatchEvent(new CustomEvent("beilu:smart-task-update", { detail }));

  if (payload?.notify === true) {
    // 后端 phase 是本次通知的真实生命周期节点；长任务仍处于 running，
    // 若只显示 state 会丢掉“已越过长运行阈值”这一关键反馈。
    const status = payload?.phase || merged.state || merged.status || "unknown";
    const duration = _formatToolJobDuration(merged.duration);
    const error = typeof merged.error === "string"
      ? merged.error
      : merged.error?.message || "";
    const parts = [merged.backendKind, duration, error].filter(Boolean);
    const message = parts.join(" · ");
    const isError = status === "failed" || status === "connection_lost" || status === "orphan_result";
    showCrossModeNotification({
      fromMode: "code",
      type: isError ? "error" : "info",
      title: `${merged.tool || id} · ${status}`,
      message,
      targetTab: "files",
    });
  }
}

_getToolJobsMap();

// ============================================================
// EventBus 事件桥接 — 对标 JS-Slash-Runner event.ts
// ============================================================

/**
 * 通过父页面 EventBus 发送事件
 *
 * 对标 JS-Slash-Runner 的 iframe_events / tavern_events：
 * - iframe_events.GENERATION_STARTED = 'js_generation_started'
 * - iframe_events.GENERATION_ENDED = 'js_generation_ended'
 * - tavern_events.GENERATION_STARTED = 'generation_started'
 * - tavern_events.MESSAGE_RECEIVED = 'message_received'
 * - tavern_events.MESSAGE_SENT = 'message_sent'
 * - tavern_events.GENERATION_ENDED = 'generation_ended'
 *
 * @param {string} eventName - 事件名（与 eventConstants.mjs 中定义一致）
 * @param  {...any} args - 事件参数
 */
function _emitEventBus(eventName, ...args) {
  // [0807 转接二期#6] 原地同步循环删除，转发 eventBusCore 单源（ST await 语义：串行 await 每个
  //   监听器——原实现不 await，async 监听器（卡内脚本常见）被丢时序=可变管道语义断裂的病根之一）。
  //   本文件 17 个调用点全是通知类事件（message_*/generation_*/emotion 等，producer 不回读），
  //   走 Detached 出口：不阻塞 SSE 分发链，监听器之间时序仍串行保持。
  emitEventBusDetached(eventName, ...args);
}

/**
 * 情感系统 producer（前端契约 by 点1，设计 §4.5）
 *
 * 后端情感检测落地后，在检测到 [情感] 标签处调本函数一次即可：
 *   ① 写父页面 window.__beiluEmotionState —— iframe 内 getCurrentEmotion() 的唯一来源
 *   ② 走 _emitEventBus('emotion_changed', {emotion, message_id}) 广播给所有 iframe
 * 未调用前：__beiluEmotionState 为 undefined，getCurrentEmotion() 一律返回 null（不造假）。
 *
 * @param {string} emotion - 情感标签文本，如 "开心"
 * @param {number} [messageId=-1] - 关联消息楼层索引
 */
function emitEmotionChanged(emotion, messageId = -1) {
  if (typeof emotion !== "string" || !emotion) return;
  window.__beiluEmotionState = {
    emotion,
    message_id: typeof messageId === "number" ? messageId : -1,
    timestamp: Date.now(),
  };
  _emitEventBus("emotion_changed", { emotion, message_id: messageId });
  // 父页面消费者（live2dRenderer 等）走 window 事件——与 iframe EventBus 是两个执行上下文。
  // 收口在 producer 内：任意调用方（WS / displayRegex / StreamRenderer / 后端检测）都同时驱动两端。
  window.dispatchEvent(new CustomEvent("beilu:emotion-changed", { detail: { emotion, messageId } }));
}
// 暴露为 window 全局，供后端检测代码 / displayRegex / StreamRenderer 任意处调用
if (typeof window !== "undefined") window.emitEmotionChanged = emitEmotionChanged;

/**
 * 通用 EventBus producer（N49）：供 chat/mode/character 等**跨模块**收口在父页面广播 beilu 专属事件，
 * 给 iframe 美化脚本的 eventOn 消费（_emitEventBus 是本模块私有，跨文件收口经此 window 出口）。
 * emit 到无 listener 的事件是安全 no-op（不影响主流程，故各收口可无条件调）。
 * @param {string} eventName - 见 eventConstants tavern_events（chat_id_changed / mode_changed / character_changed / variable_updated）
 * @param {object} [payload]
 */
function emitBeiluEvent(eventName, payload) {
  if (typeof eventName !== "string" || !eventName) return;
  _emitEventBus(eventName, payload);
}
if (typeof window !== "undefined") window.emitBeiluEvent = emitBeiluEvent;

/**
 * 更新脚本 iframe 中的 SillyTavern.chat 数组
 *
 * 当 message_replaced 到来时，需要同步更新脚本 iframe 的 chat 数组，
 * 确保 getAllVariables() 能读到最新的变量数据。
 *
 * @param {number} index - 消息在 chatLog 中的索引
 * @param {object} entry - 更新后的消息条目
 */
// [0807 §七#3] timeline_info 到来时需要重同步尾消息的 swipe 维度，但 timeline_info 广播不带 entry
//   （modifyTimeLine 先发 message_replaced(带 entry) 再发 timeline_info），故缓存最近一次 replace。
let _lastReplacedForTimeline = null;

function _updateScriptIframeChat(index, entry) {
  // S1 每脚本独立 iframe（scriptRunner.mjs:1062 同名 className），可同时存在多个，
  // 必须遍历全部同步，否则只有首个脚本 iframe 拿到最新 chat，其余永久 stale。
  const iframes = document.querySelectorAll(".beilu-script-iframe");
  if (!iframes.length) return;

  // beilu role → 酒馆 role
  const stRole = entry.role === "user" ? "user" : "assistant";
  const msgText = entry.content_for_show || entry.content || "";

  for (const iframe of iframes) {
    if (!iframe?.contentWindow?.SillyTavern) continue;

    try {
      const stChat = iframe.contentWindow.SillyTavern.chat;
      if (!stChat) continue;

      // 每个 iframe 独立沙盒，构建独立消息对象避免跨 iframe 共享可变引用。
      // [0807 §七#3] 形状收口 stChatShape.mjs（与 scriptRunner 初始内联同源）；
      //   时间线只挂最后一条活跃消息：尾部 char 消息带真实 swipe_id/多维数组，其余单 swipe。
      const isTail = stRole !== "user" && index >= stChat.length - 1;
      const stMsg = buildStChatMessage(entry, index, msgText, isTail ? getTimelineInfo() : null, "User", "Character");

      // 更新或追加
      if (index < stChat.length) {
        stChat[index] = stMsg;
      } else {
        // 可能有间隔，用空对象填充
        while (stChat.length < index) {
          stChat.push({ variables: [{}], swipe_id: 0 });
        }
        stChat.push(stMsg);
      }
    } catch (e) {
      // iframe 可能已销毁或跨域
      console.debug('[ws] _updateScriptIframeChat:', e.message);
    }
  }
}

// ============================================================
// MVU 变量 → __beiluVarStore 同步
// ============================================================

/**
 * 楼层号映射：chatLog 存储索引 → 逻辑楼层号（从 0 开始）
 * 主人要求楼层按 AI 回复的顺序来算（0、1、2），
 * 而不是用 chatLog 中的绝对存储索引（如 34）。
 */
const _floorMap = new Map(); // chatLogIndex → logicalFloorNumber
let _nextFloor = 0;

/**
 * 重置楼层映射（新对话/切换聊天时调用）
 *
 * 清空 _floorMap 和 _nextFloor，确保新对话的楼层号从 0 开始。
 */
export function resetFloorMap() {
  _floorMap.clear();
  _nextFloor = 0;
  // [0807 §七#3] 时间线重同步缓存随对话切换清空——否则新对话首个 timeline_info 会把旧对话的
  //   entry 写进新 iframe 的 chat 数组（跨对话残留）。本函数是切换对话的既有收口点（虚拟队列 init 必调）。
  _lastReplacedForTimeline = null;
  diag.debug("楼层映射已重置");
}

/**
 * 获取指定 chatLog 索引对应的逻辑楼层号
 * @param {number} chatLogIndex - chatLog 中的绝对存储索引
 * @returns {number} 逻辑楼层号（从 0 开始递增）
 */
function _getLogicalFloor(chatLogIndex) {
  if (_floorMap.has(chatLogIndex)) return _floorMap.get(chatLogIndex);
  const floor = _nextFloor++;
  _floorMap.set(chatLogIndex, floor);
  return floor;
}

/**
 * 将消息中的 mvu_variables 同步到 __beiluVarStore
 *
 * 调用时机：message_added / message_replaced / message_edited
 *
 * 同步目标：
 * 1. __beiluVarStore.chat — 最新的完整变量状态（变量管理器"聊天"tab 读取）
 * 2. __beiluVarStore.messages[floorNumber] — 该楼层的变量快照（变量管理器"消息楼层"tab 读取）
 *    其中 floorNumber 是从 0 开始的逻辑楼层号，而不是 chatLog 存储索引
 *
 * @param {number|undefined} index - 消息在 chatLog 中的索引
 * @param {object} entry - 消息条目
 */
export function _syncMvuVariablesToStore(index, entry) {
  if (!entry?.extension?.mvu_variables) return;

  const mvuVars = entry.extension.mvu_variables;
  if (typeof mvuVars !== "object" || Object.keys(mvuVars).length === 0) return;

  const store = window.__beiluVarStore;
  if (!store) {
    diag.warn("MVU同步: __beiluVarStore不存在");
    return;
  }
  diag.debug(`MVU同步: index=${index}, keys=${Object.keys(mvuVars).join(",")}`);

  // ★ 修复：不再将 MVU 变量写入 chat 作用域！
  // 参考 JS-Slash-Runner：chat 作用域只存放脚本设置的默认变量，
  // message 变量存在 messages[floorNumber] 中，
  // getAllVariables() 合并时 global → character → chat(默认) → messages(MVU) 依次覆盖。
  // 之前的做法把 MVU 变量 replaceVariables 到 chat 作用域，导致默认变量被污染/覆盖。

  // 同步到 messages[floorNumber] 作用域（楼层快照）
  // ★ 使用逻辑楼层号（0、1、2...）而非 chatLog 存储索引（如 34）
  if (index !== undefined && index !== null) {
    try {
      store.messages = store.messages || {};
      const floorNumber = _getLogicalFloor(index);
      store.messages[String(floorNumber)] = { ...mvuVars };
    } catch (e) {
      console.warn("[websocket] MVU→messages 变量同步失败:", e);
    }
  }

  // 2. 发 postMessage 通知变量管理器刷新
  // 通知 scope 改为 message，与实际存储位置一致
  try {
    window.postMessage(
      {
        type: "beilu-var-replace",
        option: { scope: "message" },
        variables: mvuVars,
        _source: "mvu-sync",
      },
      "*",
    );
  } catch (e) {
    // ignore
  }

  diag.log(
    `[MVU→VarStore] 已同步 index=${index}, keys=${Object.keys(mvuVars).join(",")}`,
  );

  // N49 VARIABLE_UPDATED producer：MVU 写入收口广播给 iframe 美化脚本（本模块内直接走 _emitEventBus）。
  _emitEventBus("variable_updated", { index, variables: mvuVars });
}

import { buildStChatMessage } from "../../stCompat/runtime/stChatShape.mjs"; // [0807 §七#3] ST 消息形状单源（叶子，与 scriptRunner 同源）
import { getTimelineInfo } from "../state/timelineState.mjs"; // [0807 §七#3] swipe 状态单源（叶子）
import {
  addPartToSelect,
  handleCharAdded,
  handleCharRemoved,
  handlePersonaSet,
  handlePluginAdded,
  handlePluginRemoved,
  handleWorldSet,
  removePartFromSelect,
} from "../layout/sidebar.mjs";
import { handleTypingStatus } from "../render/typingIndicator.mjs";
// FT6 D4：跨 chatId 广播过来的跨模式通知(report 完成/needHelp)在源窗口弹出
import { showCrossModeNotification } from "../widgets/crossModeNotification.mjs";
// AI 建 Skill组通知弹窗（凛倾 2026-07-15）：确认「保持/更改」+ 组级源/模型更改流程（与组详情面板共用）
import { beiluConfirm } from "../widgets/beiluDialog.mjs";
import { promptFlowGroupModelChange } from "../widgets/flowGroupModelDialog.mjs";
import {
  applyAuthoritativeEdit,
  handleMessageAdded,
  handleMessageDeleted,
  handleMessageReplaced,
  handleMessagesRangeDeleted,
  handleMessagesHidden,
  handleStreamUpdate,
  handleTimelineInfo,
} from "../render/virtualQueue.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { DEFAULTS } from "../../config/defaults.mjs"; // 0719 病征⑤修：WS dispatch 缺省超时与 HTTP 侧同源（同一请求两条腿一个默认）

// W55/W56: AI模式/子模式切换时自动切换预设 + Tab跟随 + 子模式面板刷新
async function _handleModeSwitchPreset(entry) {
  const ext = entry?.extension;
  if (!ext) return;

  // 1.（已拆除）大模式绑定预设的前端回声切换
  // [预设切换互斥 2026-07-13 S5] 原消费 ext._modeSwitchPreset 再 POST switchPreset 回后端——
  //   后端→前端→后端回声：前端时点 mode/cid 与切换目标可错位（写错键），且无"无记录才初始化"
  //   守卫=每次 AI 切模式盖掉用户已选预设。现由后端产生点直写（replyHandler modeSwitch 块，
  //   同 setDataActions switchMode 守卫+switchPresetViaAPI 收口），前端只经 preset_changed 广播刷 UI。

  // 1b. 子模式切换 → 重置 runtimeParams 采样参数到哨兵值（防旧子模式 temperature 等残留覆盖新预设基线）
  //   与 subModePanel._setActiveSubMode 的重置逻辑同源——AI驱动和手动切换走统一清理路径。
  //   子模式自身的参数由 getPromptHandler per-round extension.sub_mode_* 下发（Layer 3），不依赖 runtimeParams。
  if (ext._subModeSwitch) {
    try {
      // T6b批7：runtime-params POST → sendAction beilu-preset#setRuntimeParams（body=payload）。fire-and-forget，!ok 门面抛错走 catch。
      await sendAction({
        verb: "setRuntimeParams",
        target: "plugins:beilu-preset",
        source: "web",
        payload: {
          temperature: -1, top_p: -1, top_k: -1, min_p: -1,
          frequency_penalty: null, presence_penalty: null,
          openai_max_tokens: 0, openai_max_context: 0,
        },
      });
      console.log("[websocket] 子模式切换 → runtimeParams 采样参数已重置");
    } catch (_resetErr) {
      console.warn("[websocket] runtimeParams 重置失败:", _resetErr.message);
    }
  }

  // 1b-orig. 子模式带 API 覆盖（[0804] 后端已删角色全局 AIsource 写；此值=per-request 覆盖源，下轮生成局部生效）
  if (ext._subModeSwitchApiSource) {
    console.log("[websocket] 子模式 API 覆盖（per-request）:", ext._subModeSwitchApiSource);
  }

  // 1c. 子模式绑定model_params → 通知前端同步（#180: 原死extension，前端无消费导致参数面板不刷新）
  if (ext._subModeSwitchModelParams) {
    window.dispatchEvent(new CustomEvent("beilu:runtime-params-changed", { detail: ext._subModeSwitchModelParams }));
  }

  // 2a. [P0-A 2026-08-03] Smart 提案待确认 → 只投影确认卡，零副作用。
  //   建线/绑定/指针/task_start 全部延后到认证 confirm 端点（服务端单源 ensureModeChatsForChar），
  //   前端此处禁止任何创建动作（旧 _ensureModeChatId 预建线=确认前副作用，已随散写函数一并删除）。
  const pendingConf = ext._pendingConfirmation;
  if (pendingConf?.confirmationId) {
    window.dispatchEvent(new CustomEvent("beilu:smart-pending-confirmation", { detail: { confirmation: pendingConf } }));
    console.log("[websocket] Smart 提案待确认:", pendingConf.confirmationId, pendingConf.sourceMode, "→", pendingConf.targetMode);
  }
  if (ext._pendingConfirmationError) {
    // 提案登记失败（服务端 fail-closed，本轮副作用已全拒）——真实错误可见，不伪装成功
    console.warn("[websocket] Smart 提案登记失败:", ext._pendingConfirmationError);
    try { window.showToast?.("error", "Smart 提案登记失败: " + ext._pendingConfirmationError, 5000); } catch {}
  }

  // 2. Tab跟随模式切换（_modeSwitch是对象 { from, to }）
  //   [P0-A] 投递语义（smart/chat→code/work）已在后端提案硬门收口、不再产生 _modeSwitch，
  //   此处只剩真实状态转移（work/code→chat/smart、code↔work）的 Tab 跟随。
  const modeSwitch = ext._modeSwitch;
  if (modeSwitch?.to) {
    // 映射权威源 ./modeTabMap.mjs（T-3）。裸表无回退：未知 mode→undefined，由下方 else 分支 warn+toast。
    const targetTab = MODE_TO_TAB[modeSwitch.to];
    if (targetTab) {
      console.log("[websocket] AI模式切换 → Tab跟随:", modeSwitch.from, "→", modeSwitch.to, "→ Tab:", targetTab);
      window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: targetTab } }));
    } else {
      console.warn("[websocket] AI请求切换到未知模式:", modeSwitch.to);
      try { window.showToast?.("warning", "AI请求切换到未知模式: " + modeSwitch.to, 3000); } catch {}
    }
  }

  // 3. 子模式面板UI刷新（后端已更新active_sub_mode，通知前端同步）
  const subModeSwitch = ext._subModeSwitch;
  if (subModeSwitch?.to) {
    console.log("[websocket] AI子模式切换:", subModeSwitch.from, "→", subModeSwitch.to);
    window.dispatchEvent(new CustomEvent("beilu:subModeSwitched", { detail: subModeSwitch }));
  }

  // 4. AI主动停止自动继续（<stopContinue/>标签）— 纯运行态信号，停止语义全在后端
  //   （generation.mjs stopContinue 分支：本轮不续 + loop 双停阈值计数），前端无功能消费者。
  // 【红线·0731 凛倾拍板】「操作后自动继续」（系统配置域开关）与 <stopContinue/>（AI 任务域：
  //   "本轮任务做完了"）是两个开关，禁止合流——AI 停止只是任务上的，不是系统上禁止自动继续，
  //   翻了配置开关用户下一次派任务就没有自动继续。禁止任何运行态代码碰 #ide-auto-continue。
  //   [0731 根修] 原在此把 #ide-auto-continue 翻 false（注释称"仅临时不持久化"）——但该开关是
  //   持久配置 yonban_config.auto_continue.enabled 的 UI（idePanel init 后端回填 + 用户 change 写回），
  //   被当运行状态灯翻假后：①AI 每发一次停止符开关就显示"关"，用户刚打开立刻又见关闭；
  //   ②面板任一其它项 change 触发 _syncAutoContinueToBackend 全量覆写，把假 false 持久化进后端
  //   = 用户配置随机丢失。运行态信号禁碰配置 UI，只留日志。
  if (ext._stopContinue) {
    console.log("[websocket] AI已结束本轮自动继续（配置开关不变，停止语义由后端处理）");
  }

  // 5. AI定时唤醒（<scheduleWakeup/>标签）— 先停，N秒后自动恢复继续
  if (ext._scheduleWakeup) {
    const { delay, reason } = ext._scheduleWakeup;
    console.log(`[websocket] AI请求定时唤醒: ${delay}秒后 (${reason})`);
    // _stopContinue已在replyHandler中设置，此处广播事件让UI同步显示倒计时状态
    // consumer=backendMonitor.mjs「⏰ 定时唤醒」行（setWakeup→1s ticker 倒计时）；本事件仅驱动 UI，下方 setTimeout 是真实唤醒计时，二者独立
    window.dispatchEvent(new CustomEvent("beilu:scheduleWakeup", { detail: { delay, reason } }));
    if (_wakeupTimerId) clearTimeout(_wakeupTimerId);
    const _snapChatId = currentChatId;
    // FT-B4: 角色名走三级链（与 conversationManager/taskItemPanel 同口径），不再读旧抽屉隐藏 #char-select
    const _getCharName = () =>
      window._beiluGetCharName?.() || storage.get(KEYS.BEILU_LAST_CHAR) || "";
    const _snapCharId = _getCharName();
    _wakeupTimerId = setTimeout(() => {
      _wakeupTimerId = null;
      if (currentChatId !== _snapChatId) { console.log("[websocket] scheduleWakeup: 对话已切换，跳过"); return; }
      console.log(`[websocket] 定时唤醒触发: ${reason}`);
      // 【红线】禁碰 #ide-auto-continue（同上方 stopContinue 红线：运行态禁改配置域开关）。
      // [0731 根修] 原在此把 #ide-auto-continue 翻 true——与上方 stopContinue 翻 false 同型劫持
      //   （反向：用户显式关闭配置时被翻"开"，再经面板全量覆写持久化）。唤醒动作本身由下方
      //   triggerCharacterReply 完成，不依赖该开关，配置 UI 只归 idePanel 两触点（init 回填/用户 change）。
      const charId = _snapCharId || _getCharName();
      if (!charId) { console.warn("[websocket] scheduleWakeup: charId 为空，跳过触发"); return; }
      import("./endpoints.mjs").then(m => m.triggerCharacterReply(charId)).catch(e => console.warn("[websocket] scheduleWakeup触发失败:", e.message));
    }, delay * 1000);
  }

}

// [P0-A 2026-08-03 删除] _ensureModeChatId / _bindModeChatId 前端散写建线（new+bindCharToChat+
//   markModeActiveChat+classifyNewChat+bindChatMode 复制循环）已整体删除——Fable 审查阻断2/非阻断1：
//   模式线创建唯一权威=服务端 chatOps.ensureModeChatsForChar（确认通过后由 smart-confirmations/confirm
//   端点调用），前端不再持有第二套创建/绑定逻辑。原唯一调用方=上方 _modeSwitch smart 分支（同批删除）。

// W66: 通用自动继续 @deprecated — 原前端函数 _maybeAutoContinue 已停用、全库零调用点，
// 自动继续现统一由后端 generation.mjs 触发；为消除死代码已删除该函数（2026-06-01 点3优化）。

let ws = null; // 当前活跃连接（指向 _wsPool 中的某个）
const _wsPool = new Map(); // chatid → WebSocket（并行窗口连接池）
// [债#7 修 0726] 池容量上限：原池只增不减（切对话不关旧连接、closeParallelWs 零调用点），
//   单 tab 访问过 N 个对话就常驻 N 条 WS，后端每条都占 chatUiSockets 一席、还会让「另一窗口在用」
//   角标把自己开过的连接误报成别人。规则：超上限时按最久未活跃逐出，绝不动当前活跃 chatid 的连接。
const WS_POOL_MAX = 6;
const _wsLastUsed = new Map(); // chatid → 最近活跃时刻（建立/收消息时更新）
function _evictWsPoolIfNeeded(keepCid) {
  if (_wsPool.size <= WS_POOL_MAX) return;
  // ★ 已拉起的线绝不逐出：线 = 用户明确开着的并行链路，后端正按 chatid 各自生成，
  //   逐掉它的 WS = 生成还在跑但前端收不到 stream_update/message_added（切回去才发现断了一截）。
  //   上限只约束「顺手点开过的对话」这类顺带连接；线数本身超上限时上限让位（下方候选耗尽即停止逐出）。
  const _lineCids = (() => { try { return new Set(window._beiluGetLineChatIds?.() || []); } catch { return new Set(); } })();
  const cands = [];
  for (const [cid, sock] of _wsPool) {
    if (cid === keepCid || cid === currentChatId) continue; // 当前活跃永不逐出
    if (_lineCids.has(cid)) continue;                        // 已拉起的线永不逐出
    cands.push([cid, _wsLastUsed.get(cid) || 0, sock]);
  }
  cands.sort((a, b) => a[1] - b[1]); // 最久未活跃在前
  while (_wsPool.size > WS_POOL_MAX && cands.length) {
    const [cid, , sock] = cands.shift();
    _rejectDispatchPendingForSocket(cid, sock, "WS 连接已被连接池逐出");
    try { if (sock) { sock.onclose = null; sock.close(1000, "pool-evict"); } } catch { /* ignore */ }
    _wsPool.delete(cid);
    _wsLastUsed.delete(cid);
    const t = _wsReconnectTimers.get(cid);
    if (t) { clearTimeout(t); _wsReconnectTimers.delete(cid); }
    console.log(`[websocket] 连接池超 ${WS_POOL_MAX}，逐出最久未用连接: ${cid}`);
  }
}

// WS dispatch：前端发 dispatch 请求 → 后端回 dispatch_response，按 id 关联 Promise
const _dispatchPending = new Map(); // Map<id, { resolve, reject, timer, chatId, socket }>
let _dispatchSeq = 0;

function _rejectDispatchPendingForChat(chatId, reason = "WS 连接断开") {
  for (const [id, pending] of _dispatchPending) {
    if (pending.chatId !== chatId) continue;
    clearTimeout(pending.timer);
    _dispatchPending.delete(id);
    pending.reject(new Error(reason));
  }
}

function _rejectDispatchPendingForSocket(chatId, socket, reason = "WS 连接断开") {
  for (const [id, pending] of _dispatchPending) {
    if (pending.chatId !== chatId || pending.socket !== socket) continue;
    clearTimeout(pending.timer);
    _dispatchPending.delete(id);
    pending.reject(new Error(reason));
  }
}

// 「另一窗口在用」角标的自持判定桥：后端 getchatlist.inUseCount 数的是全部窗口的连接，
// 列表渲染方（conversationManager，同步渲染无法动态 import）需减掉本窗口自己持有的连接
// 才能判「别的窗口在用」。window 桥避免 conversationManager↔websocket 静态循环依赖。
window._beiluHasOpenChatWs = (chatid) => {
  const w = _wsPool.get(chatid);
  return !!w && w.readyState === WebSocket.OPEN;
};
const _wsReconnectTimers = new Map(); // chatid → reconnect timer id
const _wsFailCounts = new Map(); // chatid → fail count
let _chatIdWaitTimerId = null;
let _chatIdWaitTries = 0;
let _reconnectTimerId = null; // M-11: onclose 3s 自动重连 timer，存 id 以便新连接建立前取消，防双 WS
let _wsFailCount = 0;
let _accountDeleted = false;
const _CHATID_WAIT_MAX = 60; // 60 × 500ms = 30s 上限，避免无聊天时无限轮询

/**
 * T050·U03：WS 连接状态可见化统一出口。
 *
 * why：原 onclose(:562) 只 console.log 走退避重连，界面无任何提示——用户看到"消息发出去了
 * 却永远没有回复"，完全不知道是连接断了（对比 onopen:534 连上时会弹 toast，断连全静默，不对称）。
 * 参照 YonBan chat-connection.js onConnectionState 的 connDot status→颜色/文案映射范式，在
 * 顶栏 #conn-dot（index.html 顶部栏左区）以指示灯 + title 呈现连接态，走这个统一函数出口
 * （不在 onclose 断处贴一句 console/toast，避免断连提示散落）。
 *
 * 显示策略：只反映"当前活跃 chat"（currentChatId）的连接态——多 chat 连接池下指示灯代表用户
 * 当前正在看的这个对话的连接。connected 隐藏指示灯（无干扰），重连中黄、彻底断开红。
 *
 * @param {"connected"|"connecting"|"disconnected"} status
 */
function _updateConnIndicator(status) {
  try {
    const dot = document.getElementById("conn-dot");
    if (!dot) return;
    if (status === "connected") {
      dot.style.display = "none";
      dot.title = "";
      return;
    }
    dot.style.display = "inline-block";
    if (status === "disconnected") {
      // 超过重试上限彻底断开：红，明确告知回复可能收不到
      dot.style.background = "var(--fallback-er,oklch(var(--er)))";
      dot.title = "连接已断开，AI 回复可能收不到，请检查网络或刷新";
    } else {
      // connecting：网络中断正在退避重连，黄
      dot.style.background = "var(--fallback-wa,oklch(var(--wa)))";
      dot.title = "连接中断，正在重连…（此期间 AI 回复可能收不到）";
    }
  } catch {}
}

/**
 * Sends a message through the WebSocket.
 * @param {object} message - The message object to send.
 */
export function sendWebsocketMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else console.error("WebSocket is not connected.");
}

/**
 * 通过 WS 发送 dispatch 请求并等待后端 dispatch_response 关联响应。
 *
 * 协议：前端发 { type:"dispatch", id, target, verb, payload, scope }
 *       后端回 { type:"dispatch_response", id, ok, data/error }
 *
 * @param {{ target: string, verb: string, payload?: any, scope?: string }} message - dispatch 消息体
 * @param {number} [timeout] - 超时毫秒数，缺省 DEFAULTS.request.timeoutMs——
 *   同一 sendAction 请求 WS 优先/HTTP 兜底两条腿共用一个缺省（0719 病征⑤：原 30000 字面量与
 *   api-client DEFAULTS 双源，值巧同但改一处不动另一处=默认分叉；route.timeout 显式值两腿本就同传）。
 * @returns {Promise<any>|null} - WS 不可用时返回 null（非 Promise），调用方应走 HTTP 兜底；
 *   WS 可用时返回 Promise，resolve(data) 或 reject(Error)
 */
export function dispatchViaWs(message, timeout = DEFAULTS.request.timeoutMs) {
  // dispatch 必须锁定请求所属的 chat：模块级 ws 只代表“当前可见窗口”，
  // 多窗口并行时借用它会把后台窗口的操作发到另一个对话。
  const rawChatId = message?.scope?.chatId;
  const targetChatId = typeof rawChatId === "string" ? rawChatId.trim() : "";
  if (!targetChatId) return null;

  const targetWs = _wsPool.get(targetChatId);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) return null;

  // 快照请求范围，避免调用方在发送期间切窗口/改写 scope 后改变目标。
  const dispatchScope = Object.freeze({ ...message.scope, chatId: targetChatId });
  const id = `wd-${++_dispatchSeq}-${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _dispatchPending.delete(id);
      reject(new Error(`[WS dispatch] 超时 (${timeout}ms): ${message.target}#${message.verb}`));
    }, timeout);
    _dispatchPending.set(id, { resolve, reject, timer, chatId: targetChatId, socket: targetWs });
    try {
      targetWs.send(JSON.stringify({ type: "dispatch", id, target: message.target, verb: message.verb, payload: message.payload, scope: dispatchScope }));
    } catch (error) {
      clearTimeout(timer);
      _dispatchPending.delete(id);
      reject(error);
    }
  });
}

/**
 * 为指定 chatid 建立 WebSocket 连接并加入连接池。
 * 不指定 chatid 时用当前 currentChatId。
 * 已有连接且 OPEN/CONNECTING 的不重复创建。
 */
function connect(targetChatId) {
  const cid = targetChatId || currentChatId;
  if (!cid) {
    if (_chatIdWaitTimerId) return;
    if (_chatIdWaitTries >= _CHATID_WAIT_MAX) {
      console.warn("[websocket] 等待 chatId 超时(30s)，放弃连接");
      return;
    }
    _chatIdWaitTries++;
    _chatIdWaitTimerId = setTimeout(() => {
      _chatIdWaitTimerId = null;
      connect(targetChatId);
    }, 500);
    return;
  }
  _chatIdWaitTries = 0;

  // 已有活跃连接则复用
  const existing = _wsPool.get(cid);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    if (cid === currentChatId) { ws = existing; window.__beiluWs = ws; }
    return;
  }

  // 取消该 chatid 的旧重连 timer
  const oldTimer = _wsReconnectTimers.get(cid);
  if (oldTimer) { clearTimeout(oldTimer); _wsReconnectTimers.delete(cid); }
  if (_reconnectTimerId) { clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }

  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${window.location.host}/ws/parts/shells:chat/ui/${cid}`;
  const newWs = new WebSocket(wsUrl);
  _wsPool.set(cid, newWs);
  _wsLastUsed.set(cid, Date.now());
  _evictWsPoolIfNeeded(cid); // 债#7：建新连接时顺带回收最久未用的，池不再只增不减

  // 当前活跃 chatid 的连接赋给全局 ws
  if (cid === currentChatId) { ws = newWs; window.__beiluWs = ws; }

  newWs.onopen = () => {
    console.log(`[websocket] WS connected (${cid.substring(0, 8)}…)`);
    const _wasReconnect = (_wsFailCounts.get(cid) || 0) > 0;
    _wsFailCounts.set(cid, 0);
    if (cid === currentChatId) {
      try { window.showToast?.("success", "已连接", 2000); } catch {}
      _updateConnIndicator("connected"); // T050·U03：连上→隐藏断线指示灯
      // [0716 断线补拉·凛倾拍板] 真重连（此前有失败计数）→断线窗口错过的 message_added/
      //   message_replaced 无法回放（WS 无重放机制），错过生成终态=消息永远卡"生成中"。
      //   通知 chat.mjs 全量重取当前对话重渲染（复用切卡免刷 getInitialData→initializeVirtualQueue 配方）。
      if (_wasReconnect) {
        try { window.dispatchEvent(new CustomEvent("beilu:wsReconnected", { detail: { chatid: cid } })); } catch { /* 补拉失败不影响连接本身 */ }
      }
    }
  };

  newWs.onmessage = (event) => {
    // 同一 chat 的新连接已经替换连接池后，旧 socket 仍可能吐出排队中的晚到消息。
    // 所有消息（不只 dispatch_response）都必须由当前池实例消费，否则会重复/倒序更新状态与 DOM。
    if (_wsPool.get(cid) !== newWs) return;
    _wsLastUsed.set(cid, Date.now()); // 债#7：有消息即算活跃，逐出永远挑真正闲置的那条
    try {
      const msg = JSON.parse(event.data);

      // WS dispatch 响应：按 id 关联回发送方的 Promise，短路返回不走 broadcast 路径
      if (msg.type === "dispatch_response") {
        const p = _dispatchPending.get(msg.id);
        if (p && p.chatId === cid && p.socket === newWs) {
          clearTimeout(p.timer);
          _dispatchPending.delete(msg.id);
          if (msg.ok) {
            p.resolve({ ok: true, data: msg.data });
          } else {
            // 保留后端“处理器未执行”的结构字段，让 sendAction 能只对插件接线竞态做安全重试；
            // 不能把 E_NODE/E_PART_* 压成纯 message，否则上层无法区分未执行与结果不确定。
            const error = new Error(msg.error?.msg || "dispatch failed");
            for (const field of ["code", "retryable", "retryAfterMs", "partpath"]) {
              if (Object.prototype.hasOwnProperty.call(msg.error ?? {}, field)) error[field] = msg.error[field];
            }
            p.reject(error);
          }
        } else if (p) {
          console.error(`[websocket] dispatch_response 连接归属不匹配: expected=${p.chatId}, actual=${cid}, sameSocket=${p.socket === newWs}, id=${msg.id}`);
        }
        return; // 不走 broadcast 路径
      }

      // 工具 Job 是用户级后台状态，不属于某个可见消息 DOM。无论事件来自当前线还是后台线，
      // 都只消费一次并更新全局 store；否则后台线无窗口时会漏事件，有窗口时又可能重复通知。
      if (msg.type === "tool_job_update") {
        handleBroadcastEvent(msg, cid).catch((err) => {
          console.error("[websocket] tool_job_update 处理失败:", err);
        });
        return;
      }

      // [并行链路可见 0726] 线活动状态：**对所有线统一派发**（活跃/非活跃都发），纯状态不碰 DOM。
      //   why 不放在非活跃分支里：用户在线A 生成中途切到线B，线A 后续来的是 stream_update
      //   （不是 stream_start），若只在非活跃分支判 start 就永远补不上——线A 明明在跑图标却不亮。
      //   消费方 lineManager 只关心挂在活动栏上的线，其余自行忽略。
      if (msg.type === "stream_start" || msg.type === "stream_update"
        || msg.type === "message_replaced" || msg.type === "typing_status") {
        let _gen = null;
        if (msg.type === "stream_start" || msg.type === "stream_update") _gen = true;
        else if (msg.type === "message_replaced") _gen = !!msg?.payload?.entry?.is_generating;
        else if (msg.type === "typing_status") _gen = Array.isArray(msg?.payload?.typingList) && msg.payload.typingList.length > 0;
        if (_gen !== null) {
          window.dispatchEvent(new CustomEvent("beilu:line-activity", { detail: { chatid: cid, generating: _gen } }));
        }
      }

      // 陪伴纯正文流属于承载 chat，但消费面可能不是当前主聊天窗口。对所有已连接线统一桥接，
      // 由 companionChat 按 detail.chatid 精确过滤；不进入主消息 DOM 的 handleBroadcastEvent。
      if (msg.type === "companion_stream") {
        window.dispatchEvent(new CustomEvent("beilu:companion-stream", { detail: { chatid: cid, ...(msg.payload || {}) } }));
        return;
      }

      // 只有当前活跃 chatid 的事件更新 DOM；其他窗口的事件静默（后端已保存）
      if (cid === currentChatId) {
        handleBroadcastEvent(msg, cid).catch(err => {
          console.error("[websocket] handleBroadcastEvent 异步错误:", err);
          wbDetect("websocket", "handleBroadcastEvent.async", false, err?.message, { type: msg?.type });
        });
      } else {
        // 非活跃窗口：只处理全局事件（group_runtime_update等），跳过 DOM 渲染事件
        if (msg.type === "group_runtime_update" || msg.type === "clone_status") {
          handleBroadcastEvent(msg).catch(() => {});
        }
        // [多窗口 0727] 后台窗口**走同一条渲染链路，渲染进它自己的上下文**。
        //   窗口↔容器的绑定在开窗口那一刻就建好了（lineManager._winEls），消息自带 chatid，
        //   取出来就是它该进的容器——不需要按 currentChatId 判断、不需要找。
        //   virtualQueue 已按窗口 id 各存一份（virtualList / 流式态 / 容器 / 计数），
        //   消息自带 chatid → 传下去 → handle* 用 _W(winId) 取它那一份。
        //   不是"把全局引用指过去再指回来"（那会交错），是参数一路传，各窗口互不相干。
        //   窗口 DOM 被 LRU 回收时没有上下文可渲染 → 退回标记，切过去时补拉。
        const _hasWin = (() => { try { return !!window._beiluGetWinEl?.(cid); } catch { return false; } })();
        if (_hasWin) {
          handleBroadcastEvent(msg, cid).catch(err => {
            console.warn("[websocket] 后台窗口渲染失败:", err?.message);
          });
        } else if (msg.type === "message_added" || msg.type === "message_replaced"
          || msg.type === "stream_start" || msg.type === "messages_range_deleted") {
          try { window._beiluMarkWinDirty?.(cid); } catch { /* lineManager 未加载 */ }
        }
        // T030-C1：非活跃（后台）窗口的对话生成完成时，用户在当前活跃窗口无任何感知
        //   （门控上方只放行 group_runtime_update/clone_status，后台窗口自身的 message_replaced
        //   完成终态被静默丢弃）——补一条轻量"后台完成"通知走已有 crossModeNotification 通道
        //   （右上角弹窗 + 桌面通知 + 顶栏🔔历史，不渲染后台 DOM，不违背切窗零刷）。
        //   与后端 broadcastCrossChatEvent 推送的 cross_mode_notification（work/code report/needHelp，
        //   走 cross_mode_task_update 子类）不重复：那条是"其他窗口"收到源窗口的跨模式通知，
        //   本条是"后台窗口自身"WS 收到自己完成终态；两类事件类型不同、接收窗口场景不同。
        else _notifyBackgroundComplete(cid, msg);
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  };

  newWs.onclose = () => {
    const isCurrentPoolSocket = _wsPool.get(cid) === newWs;
    if (isCurrentPoolSocket) _wsPool.delete(cid);
    if (ws === newWs) ws = null;

    // pending 既按会话也按连接实例归属：A 断开不影响 B；同一 A 的旧 socket
    // 延迟 close 也不能拒绝已经通过新 socket 发出的请求。
    _rejectDispatchPendingForSocket(cid, newWs);
    if (!isCurrentPoolSocket) return;

    if (_accountDeleted) return;
    const fails = (_wsFailCounts.get(cid) || 0) + 1;
    _wsFailCounts.set(cid, fails);
    const MAX_RETRIES = 10;
    if (fails > MAX_RETRIES) {
      console.warn(`[websocket] 连续 ${MAX_RETRIES} 次连接失败，停止重连 (chatId=${cid.substring(0, 8)}…)`);
      // T050·U03：彻底放弃重连→红点，告知回复可能收不到（走统一可见出口，不止 console）
      if (cid === currentChatId) _updateConnIndicator("disconnected");
      return;
    }
    const delay = Math.min(3000 * Math.pow(1.5, fails - 1), 30000);
    console.log(`[websocket] WS disconnected (${cid.substring(0, 8)}…). Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    // T050·U03：断线并进入退避重连期→黄点，让用户看见"正在重连"这段可见性缺口
    if (cid === currentChatId) _updateConnIndicator("connecting");
    const timerId = setTimeout(() => {
      _wsReconnectTimers.delete(cid);
      connect(cid);
    }, delay);
    _wsReconnectTimers.set(cid, timerId);
  };

  newWs.onerror = (err) => {
    console.error(`[websocket] WS error (${cid.substring(0, 8)}…):`, err);
  };
}

/**
 * T030-C1：后台（非活跃）窗口对话生成完成 → 轻量跨窗口通知。
 *
 * why：活跃窗口机制（_wsPool + onmessage 门控:587）下，后台窗口的 message_replaced 完成终态
 *   被静默丢弃（防污染活跃窗口 DOM，是切窗零刷的根保障，不可改成后台也渲染 DOM）。代价=后台
 *   窗口的长对话跑完，用户在活跃窗口完全无感。此函数只走"独立通知通道"（不碰后台 DOM），补齐感知。
 *
 * 完成终态判定：与后端 broadcast.mjs:270 webhook 出站终态、api_v1_router /chat/send mockWs 终态
 *   同一权威口径 = message_replaced + entry.is_generating===false + role!==user（单一终态点，不自造）。
 *
 * 通道复用：走既有 showCrossModeNotification（crossModeNotification.mjs）——右上角弹窗 + 失焦升级
 *   OS 桌面通知 + 顶栏🔔历史中心（近 20 条/24h），无需新造机制。窗口归属信息从 convMeta
 *   （KEYS.BEILU_CONVERSATION_META，{[chatid]:{label,mode}}）解析，label 作卡名、mode 作跳转 targetTab。
 *
 * @param {string} cid - 后台窗口的 chatid（connect 闭包捕获，即事件源对话）
 * @param {object} msg - WS 事件对象
 */
function _notifyBackgroundComplete(cid, msg) {
  try {
    if (msg?.type !== "message_replaced") return;
    const entry = msg?.payload?.entry;
    // 终态门：仍在生成 / 用户消息 → 不是"完成"，不通知（与后端终态口径一致）
    if (!entry || entry.is_generating || entry.role === "user") return;

    // 从对话元数据解析该后台窗口的标签/模式（label=对话名，mode=所属模式→跳转 Tab）
    let label = "", mode = "";
    try {
      const meta = JSON.parse(storage.get(KEYS.BEILU_CONVERSATION_META) || "{}");
      const m = meta[cid] || {};
      label = m.label || "";
      mode = m.mode || "";
    } catch { /* meta 解析失败 → 用空兜底，仍发通知 */ }

    const _name = label || "后台对话";
    showCrossModeNotification({
      fromMode: mode || "chat",
      type: "info",
      title: "后台对话已完成",
      message: `「${_name}」的 AI 回复已完成`,
      targetTab: mode || "chat", // crossModeNotification 内部 modeToTab 规范化，非法值回退 chat
    });
  } catch (e) {
    console.warn("[websocket] 后台完成通知失败:", e?.message);
  }
}

/**
 * 处理广播事件。
 * @param {object} event - 事件。
 * @returns {Promise<void>}
 */
async function handleBroadcastEvent(event, winId) {
  const { type, payload = {} } = event;
  wbTrace("websocket", "handleBroadcastEvent", { type });
  if (type === "account_deleted") {
    _accountDeleted = true;
    // P0-2（一致性审计②）：批量清理走门面 clearAll（前缀语义归 storage.mjs 单点持有），行为不变
    storage.clearAll();
    // 20260706 删号传导链修：直达 /login/ 不绕 '/'（账户已删=确定无会话，同 base.mjs account_deleted 语义）
    window.location.href = "/login/";
    return;
  }
  if (type === "subModeSwitched" && event.subModeSwitch?.to) {
    console.log("[websocket] 后端广播子模式切换:", event.subModeSwitch.from, "→", event.subModeSwitch.to);
    window.dispatchEvent(new CustomEvent("beilu:subModeSwitched", { detail: event.subModeSwitch }));
    return;
  }
  // 同步断链修复（2026-07-10）：子模式配置内容变更广播（saveSubModes 落盘后 memory/main.mjs 发），
  //   本体/YonBan 任一侧编辑→双端即时可见；消费端（subModePanel）重拉 getSubModes 读落盘真值
  if (type === "subModesConfigChanged") {
    console.log("[websocket] 后端广播子模式配置变更 → 重拉");
    window.dispatchEvent(new CustomEvent("beilu:subModesConfigChanged"));
    return;
  }
  // [0717 跨窗口同步] 联网配置变更（updateConfig web_search 落盘后 memory main/index 中继）——
  //   本层只桥接 WS→CustomEvent；消费端 featureControls 重拉后端权威值回填四个只读显示点
  //   （applyWebSearchDisplays 单源），与 subModesConfigChanged「信号不带全量,消费端重拉」同范式
  if (type === "webSearchConfigChanged") {
    window.dispatchEvent(new CustomEvent("beilu:webSearchConfigChanged", { detail: { charName: event.charName } }));
    return;
  }
  // F3：本窗口任务清单变更（AI taskPlan/taskCheck 或用户手动改）→ 任务卡即时刷新（不变式4 推送优先）
  if (type === "task_update") {
    wbTrace("websocket", "task_update", { chatid: payload?.chatid, count: payload?.tasks?.length, remaining: payload?.remaining });
    window.dispatchEvent(new CustomEvent("beilu:task-update", { detail: payload }));
    return;
  }
  // T052：data 系统写变更（route/warning；framework/issues 已 2026-07-16 去重删除）→ data 面板跨窗口即时刷新（补半链 consumer 侧）。
  //   producer=setDataActions._broadcastDataSystemUpdate（addRouteNote/ackDataWarning 写成功后 push，走 broadcastCrossChatEvent 按 username fan-out）。
  //   事件形状对齐（T023 形状病防线）：{type:"data_system_updated", payload:{charId, scope, kind}} 扁平，
  //   消费方 dataSystemPanel 读 detail.charId / detail.scope 决定是否按 charId 过滤（char 校验同卡）。
  //   与 task_update 同口径：本层只桥接 WS→CustomEvent，charId 过滤留给面板（职责隔离，面板才知道 getCurrentCharId）。
  if (type === "data_system_updated") {
    wbTrace("websocket", "data_system_updated", { charId: payload?.charId, scope: payload?.scope, kind: payload?.kind });
    window.dispatchEvent(new CustomEvent("beilu:data-system-updated", { detail: payload }));
    return;
  }
  // F4：组注册表变更（建组/状态/角色绑定）→ 组运行态面板即时刷新（不变式4 推送优先）
  if (type === "group_runtime_update") {
    wbTrace("websocket", "group_runtime_update", {});
    window.dispatchEvent(new CustomEvent("beilu:group-runtime-update", { detail: payload }));
    return;
  }
  // [BE-T7] 跨 chatId 任务事件 (从其他模式广播过来)
  if (type === "cross_mode_task_update") {
    wbTrace("websocket", "cross_mode_task_update", { sourceChatId: event.sourceChatId, subtype: event.subtype });
    console.log("[websocket] 收到跨模式任务事件:", event.sourceChatId, event.subtype);
    // F1-2(2026-06-17): 把别窗口(work/code chatId)的任务清单落地 window._beiluCrossModeTasks，
    //   供 layout 计数/悬浮小窗消费——补「事件到了、payload.tasks 没落进任何 store」的核心断点(G1)。
    //   payload={chatid,tasks,rev,remaining}(replyHandler:692)；task={id,content,status}(taskStore:12)。
    if (event.subtype === "tasks" && event.payload) {
      window._beiluCrossModeTasks = window._beiluCrossModeTasks || {};
      const _src = event.payload.chatid || event.sourceChatId;
      const _arr = Array.isArray(event.payload.tasks) ? event.payload.tasks : [];
      if (_arr.length === 0 || _arr.every((t) => t && t.status === "completed")) {
        delete window._beiluCrossModeTasks[_src]; // 无未完成任务 → 清理，不留陈旧
      } else {
        window._beiluCrossModeTasks[_src] = { chatid: _src, tasks: _arr, remaining: event.payload.remaining, at: Date.now() };
      }
    }
    window.dispatchEvent(new CustomEvent("beilu:smart-task-update", { detail: event }));
    // FT6 D4：work/code 独立 chatId 产出的 report 完成/needHelp 通知 → 在源窗口右上角弹出
    if (event.subtype === "cross_mode_notification" && event.notification) {
      try { showCrossModeNotification(event.notification); } catch (e) { console.warn("[websocket] 跨模式通知弹出失败:", e?.message); }
    }
    return;
  }
  switch (type) {
    case "browser_op_notice": {
      // [0727 凛倾] AI 打算操作浏览器 → 通知一声（producer：beilu-browser ReplyHandler 执行前广播）
      const _brOps = (payload?.ops || []).join(", ");
      try { window._beiluToast?.(`AI 正在操作浏览器: ${_brOps}`, "info"); } catch { /* toast 不可用不阻断 */ }
      notifyDesktop("always accompany — AI 浏览器操作", `即将执行: ${_brOps}`, { tag: "beilu-browser-op" });
      // 尊重提示音总开关：关了就只弹通知不响铃
      if (storage.get(KEYS.BEILU_DONE_SOUND) !== "false") _playDoneBeep();
      break;
    }
    case "message_added":
      wbTrace("websocket", "message_added", { id: payload?.id, role: payload?.role, generating: payload?.is_generating });
      diag.debug(`message_added: id=${payload?.id}, role=${payload?.role}, generating=${payload?.is_generating}`);
      await handleMessageAdded(payload, winId);
      // ★ MVU 变量同步到 __beiluVarStore
      _syncMvuVariablesToStore(undefined, payload);
      // ★ EventBus 桥接: 用户发送消息 → MESSAGE_SENT
      // 对标 JS-Slash-Runner tavern_events.MESSAGE_SENT
      if (payload?.role === "user") {
        _emitEventBus("message_sent");
      }
      break;
    case "message_replaced":
      wbTrace("websocket", "message_replaced", { idx: payload.index, generating: payload.entry?.is_generating, len: payload.entry?.content?.length });
      diag.debug(`message_replaced: idx=${payload.index}, generating=${payload.entry?.is_generating}, len=${payload.entry?.content?.length}`);
      await handleMessageReplaced(payload.index, payload.entry, winId);
      // ★ MVU 变量同步到 __beiluVarStore
      _syncMvuVariablesToStore(payload.index, payload.entry);
      // ★ EventBus 桥接: 更新脚本 iframe 中的 SillyTavern.chat（含 MVU 变量）
      _updateScriptIframeChat(payload.index, payload.entry);
      // [0807 §七#3] 缓存给随后到来的 timeline_info 重同步 swipe 维度用（见 _lastReplacedForTimeline 注释）
      _lastReplacedForTimeline = { index: payload.index, entry: payload.entry };
      // ★ EventBus 桥接: AI 生成完成 → MESSAGE_RECEIVED + GENERATION_ENDED
      // 对标 JS-Slash-Runner tavern_events + iframe_events
      if (!payload.entry?.is_generating && payload.entry?.role !== "user") {
        wbTrace("websocket", "ai_reply_complete", { idx: payload.index, extKeys: payload.entry?.extension ? Object.keys(payload.entry.extension) : [] });
        console.log("[websocket] ★ AI回复完成, 进入后处理链路. extension keys:", payload.entry?.extension ? Object.keys(payload.entry.extension) : "无");
        _emitEventBus("message_received", payload.index);
        _emitEventBus("generation_ended", payload.index);
        _emitEventBus("js_generation_ended", payload.index);
        // W55: AI模式/子模式切换 → 自动切换预设
        await _handleModeSwitchPreset(payload.entry);
        // W66: 自动继续由后端 generation.mjs 统一处理，前端不再触发
        // W71: IDE/工作模式任务完成提示音
        _maybePlayDoneSound(payload.entry);
        _maybeNotifyBrowser(payload.entry);
        // O16: AI 文件投递 → toast 通知 + 自动下载
        _maybeHandleFileDelivery(payload.entry);
        // O18: AI 任务计划 → toast 通知
        _maybeShowTaskPlan(payload.entry);
        // G1: AI回复完成 → Live2D口型触发
        window.dispatchEvent(new CustomEvent("beilu:ai-reply-done", { detail: { contentLength: payload.entry?.content?.length || 0 } }));
        // 不 await：弹窗等用户交互，不阻塞本 case 后续处理（beiluDialog 队列自串行）
        _maybeHandleFlowGroupCreated(payload.entry);
        if (payload.entry?.extension?._taskCheck) {
          const tc = payload.entry.extension._taskCheck;
          window._beiluToast?.(`任务核查: 剩余${tc.remaining}项`, "info", 2000);
        }
        if (payload.entry?.extension?._parallelDelegateResults?.length) {
          const pdr = payload.entry.extension._parallelDelegateResults;
          const ok = pdr.filter(r => r.status === "completed").length;
          window._beiluToast?.(`并行委派完成: ${ok}/${pdr.length}项成功`, "info", 3000);
        }
      }
      break;
    case "message_deleted":
      wbTrace("websocket", "message_deleted", { index: payload.index, messageId: payload.messageId });
      await handleMessageDeleted(payload.index, payload.messageId, winId);
      // ★ EventBus 桥接: 消息删除 → MESSAGE_DELETED（对标 tavern_events.message_deleted）
      _emitEventBus("message_deleted", payload.index);
      break;
    case "messages_range_deleted":
      wbTrace("websocket", "messages_range_deleted", { startIndex: payload.startIndex, count: payload.count, messageIdCount: payload.messageIds?.length });
      await handleMessagesRangeDeleted(payload.startIndex, payload.count, payload.messageIds, winId);
      break;
    case "messages_hidden":
      // _hidden 掩码变化（smartClean/contextClean/手动恢复）→ 当前视图即时灰显/恢复，他端同步
      wbTrace("websocket", "messages_hidden", { count: payload.indices?.length, hide: payload.hide });
      handleMessagesHidden(payload.indices, payload.hide, winId);
      break;
    case "message_edited":
      wbTrace("websocket", "message_edited", { index: payload.index });
      // 编辑广播不走通用 message_replaced 的 index/追加策略：它必须在事件所属
      // winId 中按 messageId 定位，并受 _editVersion 单调门约束。编辑器开启时只挂起，
      // 不用 WS 回显打断 textarea。
      {
        const editApply = await applyAuthoritativeEdit(winId, payload.entry, {
          deferWhileEditing: true,
          source: "websocket",
          editOperationId: payload.editOperationId,
          payloadFingerprint: payload.payloadFingerprint,
        });
        if (editApply.applied !== true && editApply.deferred !== true) {
          if (editApply.stale !== true) {
            wbDetect("websocket", "message_edited.authoritativeApply", false,
              editApply.reason || "edit_not_applied", {
                winId,
                messageId: payload.entry?.id,
                editVersion: payload.entry?._editVersion,
              });
          }
          break;
        }
      }
      // ★ MVU 变量同步到 __beiluVarStore
      _syncMvuVariablesToStore(payload.index, payload.entry);
      // ★ EventBus 桥接: 消息编辑 → MESSAGE_EDITED + MESSAGE_UPDATED（设计 §4.5）
      _emitEventBus("message_edited", payload.index);
      _emitEventBus("message_updated", payload.index);
      break;
    case "timeline_info": {
      wbTrace("websocket", "timeline_info", { timeLineIndex: payload?.timeLineIndex, timeLinesCount: payload?.timeLinesCount });
      const _prevTlIdx = getTimelineInfo().timeLineIndex;
      handleTimelineInfo(payload, winId); // 内部 setTimelineInfo → 叶子单源更新
      // [0807 §七#3] 时序：message_replaced 先到（当时单源还是旧下标），timeline_info 后到——
      //   此刻单源已是新值，用缓存的 entry 重同步 iframe 尾消息的 swipe_id/variables 下标。
      if (_lastReplacedForTimeline) {
        _updateScriptIframeChat(_lastReplacedForTimeline.index, _lastReplacedForTimeline.entry);
      }
      // [0807 §七#8] MESSAGE_SWIPED producer：下标真变了才广播（对标酒馆卡切 swipe 重算变量的核心信号；
      //   payload=消息下标数字，酒馆助手 wrapper 对 message 类事件 parseInt，无下标时不发防 NaN 被吞）
      if ((payload?.timeLineIndex ?? 0) !== _prevTlIdx && _lastReplacedForTimeline) {
        _emitEventBus("message_swiped", _lastReplacedForTimeline.index);
      }
      break;
    }
    case "persona_set":
      wbTrace("websocket", "persona_set", { personaname: payload.personaname });
      await handlePersonaSet(payload.personaname);
      break;
    case "world_set":
      wbTrace("websocket", "world_set", { worldname: payload.worldname });
      await handleWorldSet(payload.worldname);
      break;
    case "char_added":
      wbTrace("websocket", "char_added", { charname: payload.charname });
      await handleCharAdded(payload.charname);
      break;
    case "char_removed":
      wbTrace("websocket", "char_removed", { charname: payload.charname });
      await handleCharRemoved(payload.charname);
      break;
    // T070 死枝删除（凛倾 2026-07-06 授权）：char_frequency_set case 整链删（全库零发送点，事件永不到达）
    case "plugin_added":
      wbTrace("websocket", "plugin_added", { pluginname: payload.pluginname });
      await handlePluginAdded(payload.pluginname);
      break;
    case "plugin_removed":
      wbTrace("websocket", "plugin_removed", { pluginname: payload.pluginname });
      await handlePluginRemoved(payload.pluginname);
      break;
    case "typing_status":
      wbTrace("websocket", "typing_status", { count: payload?.typingList?.length });
      await handleTypingStatus(payload.typingList);
      break;
    case "stream_start":
      wbTrace("websocket", "stream_start", { messageId: payload.messageId });
      diag.debug(`stream_start: messageId=${payload.messageId}`);
      // ★ EventBus 桥接: 生成开始 → GENERATION_STARTED
      // 对标 JS-Slash-Runner iframe_events + tavern_events
      _emitEventBus("js_generation_started");
      _emitEventBus("generation_started");
      break;
    case "stream_update":
      wbTrace("websocket", "stream_update", { messageId: payload?.messageId, sliceCount: payload?.slices?.length });
      await handleStreamUpdate(payload, winId);
      break;
    case "peer_active_chat":
      // 跨客户端「当前对话」同步：本用户另一客户端(YonBan)切对话/开始生成 → 本体跟随切到该 chat。
      // 0714 前后端默认分叉修：producer 侧(broadcast.mjs broadcastUserActiveChat 头注)设计语义=「默认跟随，
      // 可关」，本消费端却实现成默认关(需显式 true)——YonBan↔本体对话"完全不同步"病根之一。
      // 改为默认跟随（显式 beilu-peer-follow=false 才关）；环路安全：对端已在同 chat 时
      // chatid===currentChatId 短路，不会互相反弹。
      // [多线 0727] 跟随的判据从「有事件就跟」收紧成两条，缺一不跟：
      //   ① reason !== "generation"：生成开始不是用户切对话。后台线随时在生成，跟过去 =
      //      把用户从他正在看的线上拽走，与「一个窗口工作、另一个窗口可以继续」正面冲突。
      //      （reason 缺失=旧后端，按旧语义当 attach 处理，不静默改变既有行为。）
      //   ② 该对话的 WS 不是本页自己持有的：本体每条线在 _wsPool 里各有一条 WS，后台线建连
      //      同样会触发广播——那是"我自己开的线"，不该让本页跟着跳过去。
      //      _beiluHasOpenChatWs 是既有判据（对话列表「另一窗口在用」角标同源），不新造机制。
      //   保住 0714 的修：YonBan 打开某对话时本页没有它的 WS → 仍然跟随。
      const _peerReason = payload?.reason || "attach";
      const _peerSelfHeld = (() => { try { return !!window._beiluHasOpenChatWs?.(payload?.chatid); } catch { return false; } })();
      wbTrace("websocket", "peer_active_chat", { chatid: payload?.chatid, current: currentChatId, reason: _peerReason, selfHeld: _peerSelfHeld });
      if (
        payload?.chatid &&
        payload.chatid !== currentChatId &&
        _peerReason !== "generation" &&
        !_peerSelfHeld &&
        storage.get(KEYS.BEILU_PEER_FOLLOW) !== "false"
      ) {
        import("../chat-core/chat.mjs")
          .then((m) => { try { m.switchCharacterScope?.(payload.chatid, undefined, { announceActive: false }); } catch (e) { console.warn("[websocket] peer_active_chat 跟随失败:", e?.message); } })
          .catch(() => {});
      }
      // 「另一窗口在用」角标刷新：不管跟不跟随，对端活动变化=列表 inUseCount 已过时，
      // 桥成 chat-list-changed 让各列表（conversationManager 防抖 300ms）重拉 getchatlist 刷角标。
      window.dispatchEvent(new CustomEvent("beilu:chat-list-changed", { detail: { chatid: payload?.chatid, peerActive: true } }));
      break;
    case "emotion_changed":
      // ★ Live2D 关联：后端流式检测到 <emotion> → 接通空 producer。
      //   写 __beiluEmotionState + 广播 emotion_changed 给所有 iframe（getCurrentEmotion()/eventOn 消费，未来 Live2D 表情驱动）。
      wbTrace("websocket", "emotion_changed", { emotion: payload?.emotion, messageId: payload?.messageId });
      // emitEmotionChanged 内部收口扇出 iframe(EventBus)+父页(window 事件)，此处只需调用一次。
      if (payload?.emotion) emitEmotionChanged(payload.emotion, payload.messageId);
      break;
    case "motion_triggered":
      // ★ Live2D 关联：后端检测到 <motion> → 转发给 live2dRenderer(window事件) + iframe脚本(EventBus)。
      wbTrace("websocket", "motion_triggered", { motion: payload?.motion, messageId: payload?.messageId });
      if (payload?.motion) {
        _emitEventBus("motion_triggered", payload);
        window.dispatchEvent(new CustomEvent("beilu:motion-triggered", { detail: payload }));
      }
      break;
    case "tool_results_ready":
      // W65: 工具执行完毕，立即通知前端触发自动继续（不等轮询）
      // traceId：与本体 opLog / YonBan ideOpLog 同一关联 ID，单次操作三层日志可拼
      wbTrace("websocket", "tool_results_ready", { traceId: payload.traceId, count: payload.count, source: payload.source });
      console.log(`[websocket] 工具结果就绪: ${payload.count}条 (${payload.source})${payload.traceId ? ` [trace ${payload.traceId}]` : ""}`);
      window.dispatchEvent(new CustomEvent("beilu:toolResultsReady", { detail: payload }));
      break;
    case "tool_job_update":
      wbTrace("websocket", "tool_job_update", {
        jobId: payload?.job?.jobId,
        tool: payload?.job?.tool,
        state: payload?.job?.state || payload?.job?.status,
        notify: payload?.notify === true,
      });
      _handleToolJobUpdate(payload);
      break;
    case "token_usage":
      // ★ AI生成完成后的cache token统计 → 转发给token bar
      wbTrace("websocket", "token_usage", { keys: payload ? Object.keys(payload) : [] });
      window.dispatchEvent(new CustomEvent("beilu:tokenUsage", { detail: payload }));
      break;
    case "clone_status":
      wbTrace("websocket", "clone_status", { taskId: payload.taskId, status: payload.status });
      // ★ 分身操作外显 → 转发给UI
      // producer=replyHandler `_broadcastCloneStatus`；consumer=backendMonitor.mjs「🤖 分身状态」区块（监听 beilu:cloneStatus）
      console.log(`[websocket] 分身#${payload.taskId} ${payload.status}: ${payload.detail}`);
      window.dispatchEvent(new CustomEvent("beilu:cloneStatus", { detail: payload }));
      break;
    case "bot_error":
      // BR2: Bot 壳启动/运行时错误（producer=各 bot 壳 runBot/bot.catch → botErrorBroadcast →
      // broadcast.mjs broadcastAllChatUi）。consumer=botSidePanels [O] 监控红点计数（监听 beilu:bot-error）。
      wbTrace("websocket", "bot_error", { platform: payload?.platform, botname: payload?.botname, phase: payload?.phase });
      console.error(`[bot ${payload?.platform || ""}] ${payload?.botname || ""} ${payload?.phase || ""}错误: ${payload?.message || ""}`);
      window.dispatchEvent(new CustomEvent("beilu:bot-error", { detail: payload }));
      break;
    // (companion_message case 已删,凛倾 2026-07-16 P 系列删除:唯一 producer=gameCompanion aiRunner 临时轮
    //  onComplete 广播,随临时轮一并移除;陪伴回复现走主链落盘+companionChat.mjs getLog 轮询。
    //  beilu:companion-message 事件本身未死:desktop-eye/live2d-pet.html:216 仍本地派发驱动口型,live2dRenderer 监听保留。)
    case "orb_message":
      // 陪伴模式: <orbMessage>横幅 → 悬浮球显示 / 网页 toast
      wbTrace("websocket", "orb_message", { keys: payload ? Object.keys(payload) : [] });
      window.dispatchEvent(new CustomEvent("beilu:orb-message", { detail: payload }));
      break;
    case "capture_control_applied":
      // AI 自主(captureControl)动作反馈: producer=replyHandler captureControl 块(gate 后实际生效项)
      // consumer=companion.mjs(设置区提示 dwellMs 停留 + 感知控件回填)。payload={applied,dwellMs,at}
      wbTrace("websocket", "capture_control_applied", { keys: payload ? Object.keys(payload) : [] });
      window.dispatchEvent(new CustomEvent("beilu:capture-control-applied", { detail: payload }));
      break;
    case "mcp_connect_requests_changed":
      // 只桥接数据变化信号；MCP 面板按当前 chatId 过滤并重拉服务端请求记录。
      wbTrace("websocket", "mcp_connect_requests_changed", {
        requestId: payload?.requestId,
        chatId: payload?.chatId,
        status: payload?.status,
      });
      window.dispatchEvent(new CustomEvent("beilu:mcp-connect-requests-changed", { detail: payload }));
      break;
    case "pending_approvals":
      wbTrace("websocket", "pending_approvals", { keys: payload ? Object.keys(payload) : [] });
      window.dispatchEvent(new CustomEvent("beilu:pendingApprovals", { detail: payload }));
      break;
    // [停止 yonban 停止多窗口 0726] producer=ideClient._notifyBoundLinesGone（本线所绑执行端断开）。
    // 本线的工具调用从此刻起会被降级拒绝（不跨窗执行），必须让用户当场看见，否则表现为「AI 突然啥也干不了」。
    // [模式切换 0727] producer=ideClient._syncConnections（分类器结果变化时全量播报）。
    //   本层只桥接 WS→CustomEvent，不做业务判断：谁该关窗口由持有窗口的模块（lineManager）决定。
    case "ide_mode_changed":
      wbTrace("websocket", "ide_mode_changed", { from: payload?.from, to: payload?.to, dim: payload?.windowDimension });
      window.dispatchEvent(new CustomEvent("beilu:ide-mode-changed", { detail: payload }));
      break;
    case "ide_instance_gone": {
      wbTrace("websocket", "ide_instance_gone", { port: payload?.port, instanceId: payload?.instanceId, chatid: payload?.chatid });
      const _ws = payload?.workspace ? `（${payload.workspace}）` : "";
      const _kind = payload?.kind === "cli" ? "本体 CLI" : "VSCode 窗口";
      // [T5 0727 收口] 登记在窗口体系里的线，提示权**全归 lineManager**：它才知道这条线接下来
      //   是自动关窗（yonban 实例没了窗口随之关）还是保留待手动处理（cli/home）——本层措辞
      //   "工具调用将暂停…改绑后恢复"对要被关掉的窗口是误导（0727 双 toast 打架病）。
      //   本层只兜底两种 lineManager 覆盖不到的情况：payload.chatid 缺失（旧后端）、
      //   该 chatid 不在线登记里（窗口体系外的对话被绑过执行端）。
      {
        const _lineIds = (() => { try { return window._beiluGetLineChatIds?.() || []; } catch { return []; } })();
        // 当前对话 ∧ 未被线登记（lineManager 未载时 _lineIds 恒空=行为回到"只当前线提示"）：
        //   措辞「本对话线」只对当前对话成立，后台 chatid 的 gone 在体系外没有可靠名字，不冒认。
        if (!payload?.chatid || (payload.chatid === currentChatId && !_lineIds.includes(payload.chatid))) {
          try { window.showToast?.("error", `本对话线绑定的${_kind}${_ws}已停止，工具调用将暂停；重新打开该窗口或在 ＋ 里改绑后恢复。`, 6000); } catch { /* toast 不可用不阻断事件派发 */ }
        }
      }
      window.dispatchEvent(new CustomEvent("beilu:ide-instance-gone", { detail: payload }));
      break;
    }
    case "mode_changed":
      wbTrace("websocket", "mode_changed", { keys: payload ? Object.keys(payload) : [] });
      // T023 Q4：mode-switched 派发权收口 featureControls（真变化守卫+detail 同构 {oldMode,newMode,...}）。
      // 原无条件转发使本 tab 自己切换的 WS 回显再刷一轮（三源竞发根源）；且 detail 形状（{mode,...}）
      // 与 UI 生产者（{newMode,...}）不同构=双形状病，收口后一并消除。featureControls 未加载时兜底旧行为。
      if (window._beiluApplyModeFromWs) window._beiluApplyModeFromWs(payload);
      else window.dispatchEvent(new CustomEvent("beilu:mode-switched", { detail: payload }));
      break;
    case "preset_changed":
      wbTrace("websocket", "preset_changed", { keys: payload ? Object.keys(payload) : [] });
      // 07-09 使用链走查：广播=权威预设已变，失效 getCachedPresetData 5s 缓存——原只改 DOM 不失效，
      //   AI/P1 切换后短窗内打开预设面板/smart 读到旧 map/旧 resolved（手动切换路径 SS:258 有失效，广播路径漏）。
      //   window 桥同 _beiluHandleFilesModeCleanup 先例（transport→state 不加 import 边）。
      window._beiluInvalidatePresetCache?.();
      // [多窗口审计 2026-07-11 A4] 窗口坐标过滤：payload.cid 存在且≠本窗口当前会话（TOCTOU：事件到达
      //   与处理之间 hash 可能已变）→ 只失效缓存不动本窗口 DOM/状态；scope:"global"/无 cid（老数据）
      //   保持原行为（全局切换回退链全窗口受影响）。
      if (payload?.cid && payload.cid !== (window._beiluGetChatId?.() || "")) break;
      window.dispatchEvent(new CustomEvent("beilu:preset-changed", { detail: payload }));
      break;
    // [0716 凛倾定案] bindings_changed case 已删——「绑定」概念整体删除（producer/consumer 同批全删）。
    case "preset_list_changed":
      // [0716 刷新机制] producer: beilu-preset SetData delete/create/duplicate/rename 单点广播
      //   （preset/main.mjs _presetListChanged）。语义=预设名单变了≠当前预设已切（后者走 preset_changed）。
      //   消费者：preset.mjs 下拉重填 + 弹窗开着时重渲。payload={preset_list}。
      wbTrace("websocket", "preset_list_changed", { n: payload?.preset_list?.length });
      window._beiluInvalidatePresetCache?.();
      window.dispatchEvent(new CustomEvent("beilu:presetListChanged", { detail: payload }));
      break;
    case "injection_prompts_changed":
      // [0716 W4 刷新机制] producer: setDataActions INJ CRUD 五写点（_broadcastInjPromptsChanged）。
      //   消费者：panels.mjs INJ 面板 _injPanelRefresh（可见时重拉，订阅骨架同日已建）。
      wbTrace("websocket", "injection_prompts_changed", {});
      window.dispatchEvent(new CustomEvent("beilu:injectionPromptsChanged", { detail: payload }));
      break;
    case "regex_rules_changed":
      // [0716 W2 刷新机制] producer: beilu-regex saveConfigToDisk 单点（全部 CRUD 收口于写盘）。
      //   消费者：regexEditor（显示层缓存必刷 + 编辑器可见时重载列表）。
      wbTrace("websocket", "regex_rules_changed", {});
      window.dispatchEvent(new CustomEvent("beilu:regexRulesChanged", { detail: payload }));
      break;
    case "worldbook_changed":
      // [0716 W1 刷新机制] producer: beilu-worldbook saveConfigToDisk 单点（全部写路收口于写盘）。
      //   消费者：panels.mjs 世界书面板（可见时整体重载）。
      wbTrace("websocket", "worldbook_changed", {});
      window.dispatchEvent(new CustomEvent("beilu:worldbookChanged", { detail: payload }));
      break;
    case "aisource_changed":
      // [0716 W3 刷新机制] producer: serviceSourceManage 增删改/设默认三写点。先失效前端源/模型缓存，
      //   再派发【既有】内部事件 resource:api-changed——复用 settingsSlots/apiConfig/layout 全部既有消费者
      //   （本窗自己保存=面板派发+本回显双触发，消费者重拉幂等无害；跨窗口由此首次打通）。
      wbTrace("websocket", "aisource_changed", { name: payload?.name });
      window._beiluInvalidateApiSources?.();
      window._beiluInvalidateModelCache?.(payload?.name || undefined);
      window.dispatchEvent(new CustomEvent("resource:api-changed", { detail: payload }));
      break;
    case "runtime_params_changed":
      // producer: beilu-preset/main.mjs:672 (runtime-params保存后广播，payload={params:{...}}嵌套) + replyHandler _subModeSwitchModelParams
      wbTrace("websocket", "runtime_params_changed", { keys: payload ? Object.keys(payload) : [] });
      // T023 Q3：解包 payload.params 统一扁平形状——回灌监听器（featureControls:444）读扁平字段
      // （p.stream 等），原直发嵌套 payload 使后端广播这条回灌链从未命中过（形状病实锤）
      window.dispatchEvent(new CustomEvent("beilu:runtime-params-changed", { detail: payload?.params || payload }));
      break;
    case "wb_trace":
      // 白盒线路追踪：后端执行点事件 → 进 backendMonitor 统一展示
      wbIngestBackend(payload);
      break;
    case "auto_continue_fuse": {
      // 自动继续熔断通知（generation.mjs 熔断分支 broadcastChatEvent 广播）。此前前端无 case → 落 default 被丢弃，
      // 自动继续触发熔断时用户在 UI 完全无感。补 case 弹警告 toast 告知原因。
      wbTrace("websocket", "auto_continue_fuse", { reason: payload?.reason, count: payload?.count });
      const _fr = payload?.reason;
      const _fmsg = _fr === "ide_disconnected" ? "IDE 已断开，自动继续已停止"
        : "连续解析失败，自动继续已停止";
      window._beiluToast?.(_fmsg, "warning");
      break;
    }
    case "group_worker_degraded": {
      // #5：组 worker 路由失败已回退本地生成（generation.mjs:_getReplyMaybeGrouped 降级分支广播）。
      // 生成不中断，但多组并行降级为本地——之前用户在 UI 完全无感（仅 dev 日志）。补 case 弹警告 toast 告知。
      // 对齐 auto_continue_fuse 范式；文案沿用现有约定中文（真实前端尚无 i18n 系统，i18n 见前端展示预览）。
      wbTrace("websocket", "group_worker_degraded", { reason: payload?.reason });
      window._beiluToast?.("多组并行暂不可用，已切换本地生成（不影响本次回复）", "warning");
      break;
    }
    case "reply_truncated": {
      // 输出截断通知（generation.mjs finish_reason 非 stop/end_turn 时广播）。此前前端无 case → 落 default 被丢弃，
      // 用户看到不完整回复时无任何提示。补 case 弹警告 toast 告知截断事实（对齐 auto_continue_fuse 范式）。
      wbTrace("websocket", "reply_truncated", { finish_reason: payload?.finish_reason });
      window._beiluToast?.(`AI回复被截断（${payload?.finish_reason || "未知原因"}），内容可能不完整`, "warning");
      break;
    }
    default:
      wbDetect("websocket", "default", false, "未知WS类型", { type });
      break;
  }
}

/**
 * 初始化WebSocket。
 */
export function initializeWebSocket() {
  const existingWs = currentChatId ? _wsPool.get(currentChatId) : null;
  if (existingWs && (existingWs.readyState === WebSocket.OPEN || existingWs.readyState === WebSocket.CONNECTING)) {
    ws = existingWs;
    window.__beiluWs = ws;
    return;
  }
  connect();

  // 跨客户端部件同步（本体↔YonBan）：notifyPartInstall→sendEventToUser 发的是
  // { partpath:"chars/小明" }（parts_loader.mjs），不是 { parttype, partname }。
  // 旧代码直接解构 parttype/partname → 全 undefined → addPartToSelect 落 default 空转，
  // 导致「新建角色卡，另一端选择器永不刷新」。这里把 partpath 解析回 type/name 收口。
  onServerEvent("part-installed", (data) => {
    const { parttype, partname } = _resolvePartTypeName(data);
    wbTrace("websocket", "part-installed", { partpath: data?.partpath, parttype, partname });
    if (parttype && partname) addPartToSelect(parttype, partname);
    if (parttype === "chars") window.dispatchEvent(new CustomEvent("beilu:chars-changed", { detail: { partname, action: "installed" } }));
  });

  onServerEvent("part-uninstalled", (data) => {
    const { parttype, partname } = _resolvePartTypeName(data);
    wbTrace("websocket", "part-uninstalled", { partpath: data?.partpath, parttype, partname });
    if (parttype && partname) removePartFromSelect(parttype, partname);
    if (parttype === "chars") window.dispatchEvent(new CustomEvent("beilu:chars-changed", { detail: { partname, action: "uninstalled" } }));
  });

  // 插件加载失败即时推送（根因C修复：此前只有成功路径有事件，失败靠5s轮询）
  onServerEvent("part-load-error", (data) => {
    wbTrace("websocket", "part-load-error", { partpath: data?.partpath, status: data?.status });
    window.dispatchEvent(new CustomEvent("beilu:part-load-error", { detail: data || {} }));
  });

  // 跨客户端聊天列表同步（本体↔YonBan）：后端 newChat/updateChatSummary 经
  // sendEventToUser 按 username 推 chat-list-changed → 桥成 window 事件，
  // conversationManager 监听后重渲染列表（修「新聊天/新消息预览不同步」）。
  onServerEvent("chat-list-changed", (data) => {
    wbTrace("websocket", "chat-list-changed", { chatid: data?.chatid });
    window.dispatchEvent(new CustomEvent("beilu:chat-list-changed", { detail: data || {} }));
  });

  // 跨客户端角色卡内容同步：另一端编辑了某角色卡 → 正在看该卡的本端重载角色信息面板。
  onServerEvent("char-data-changed", (data) => {
    wbTrace("websocket", "char-data-changed", { charName: data?.charName });
    window.dispatchEvent(new CustomEvent("beilu:char-data-changed", { detail: data || {} }));
  });
}

/**
 * 把 part-installed/uninstalled 事件 payload 归一为 { parttype, partname }。
 * 兼容两种形状：① 通道B sendEventToUser 发的 { partpath:"chars/小明" }（实际在用）；
 * ② 历史/进程内可能的 { parttype, partname }。partpath 取第一段为 type、其余为 name。
 */
function _resolvePartTypeName(data) {
  if (data?.parttype) return { parttype: data.parttype, partname: data.partname };
  const pp = typeof data?.partpath === "string" ? data.partpath : "";
  const i = pp.indexOf("/");
  if (i < 0) return { parttype: null, partname: null };
  return { parttype: pp.slice(0, i), partname: pp.slice(i + 1) };
}

/**
 * 切换活跃 WS 到当前 currentChatId。
 * 旧连接保留在 _wsPool（并行窗口继续运行），不关闭。
 * 只有 _wsPool 中没有目标 chatid 的连接时才新建。
 */
export function reconnectWebSocket() {
  if (_chatIdWaitTimerId) {
    clearTimeout(_chatIdWaitTimerId);
    _chatIdWaitTimerId = null;
  }
  _chatIdWaitTries = 0;
  // 切换活跃指针，不关旧连接
  connect(currentChatId);
}

/** 为后台承载对话建立/复用 WS，但不切换 currentChatId；陪伴面板据此接收同一主生成流。 */
export function ensureChatWebSocket(chatid) {
  if (typeof chatid === "string" && chatid) connect(chatid);
}

/**
 * 关闭指定 chatid 的并行 WS 连接（cardsPanel 关标签时调用）。
 * 不影响其他连接。
 */
export function closeParallelWs(chatid) {
  if (!chatid) return;
  const poolWs = _wsPool.get(chatid);
  if (poolWs) _rejectDispatchPendingForSocket(chatid, poolWs, "WS 连接已被主动关闭");
  else _rejectDispatchPendingForChat(chatid, "WS 连接已被主动关闭");
  if (poolWs) {
    poolWs.onclose = null;
    poolWs.close();
    _wsPool.delete(chatid);
  }
  const timer = _wsReconnectTimers.get(chatid);
  if (timer) { clearTimeout(timer); _wsReconnectTimers.delete(chatid); }
  _wsFailCounts.delete(chatid);
  if (ws === poolWs) ws = null;
}

// ============================================================
// W71: IDE/工作模式任务完成提示音
// ============================================================

let _audioCtx = null;

function _maybeNotifyBrowser(entry) {
  const content = entry?.content || "";
  const hasToolCalls = content.includes("<ideToolCall");
  // 源特有门：还在调工具（未到停点）不打扰。失焦/开关/权限/构造统一在 notifyDesktop（单一入口）。
  if (hasToolCalls && !entry?.extension?._stopContinue) return;
  notifyDesktop("always accompany — AI 回复完成", content.substring(0, 100), { tag: "beilu-done" });
}

function _maybePlayDoneSound(entry) {
  if (storage.get(KEYS.BEILU_DONE_SOUND) === "false") return;
  const mode = storage.get(KEYS.BEILU_ACTIVE_MODE) || "chat";
  if (mode !== "code" && mode !== "work") return;

  const ext = entry?.extension;
  const content = entry?.content || "";
  const hasToolCalls = content.includes("<ideToolCall");
  const isStop = !!ext?._stopContinue;

  // 纯文本（无工具调用）或 AI 主动停止 → 任务完成，播放提示音
  if (!hasToolCalls || isStop) {
    _playDoneBeep();
  }
}

function _playDoneBeep() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    // 音量用户可配（凛倾 0727"铃声大一点"）：面板滑条 → storage，默认 0.5（原硬编码 0.15 过小）
    const _volRaw = parseFloat(storage.get(KEYS.BEILU_DONE_SOUND_VOLUME) || "0.5");
    const _vol = Math.max(0.05, Math.min(1, Number.isFinite(_volRaw) ? _volRaw : 0.5));

    // 两声短促提示音 (C5 → E5)
    const notes = [523.25, 659.25];
    const now = ctx.currentTime;
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(_vol, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.1);
    });
  } catch (e) {
    console.warn("[websocket] 提示音播放失败:", e.message);
  }
}

// ============================================================
// O16: AI 文件投递 — toast 通知用户
// ============================================================

/**
 * AI 回复完成时检查 extension._fileDelivery，有则 toast 通知用户。
 * 实际下载链接在 messageList 的文件卡片中（_appendFileDeliveryCard），
 * 此处只负责即时 toast 提醒。
 * @param {object} entry - 消息条目
 */
function _maybeHandleFileDelivery(entry) {
  const fd = entry?.extension?._fileDelivery;
  if (!fd?.path) return;
  const name = fd.name || fd.path.split(/[/\\]/).pop() || "文件";
  console.log("[websocket] O16 fileDelivery toast:", name, fd.path);
  const toast = window._beiluToast || window.showToast;
  if (typeof toast === "function") {
    toast(`AI 发来文件: ${name}`, "success");
  }
}

/**
 * AI 创建 Skill组 → 通知弹窗（凛倾 2026-07-15「ai新建之后需要进行通知,弹出是否更改模型或者api」）。
 * 组的源/模型由后端建组时复制当时活跃子模式（AI 不决定，replyHandler createFlowGroup 快照），
 * 此处告知用户当前快照值并给更改入口：
 *   beiluConfirm「保持/更改」→ 更改走 promptFlowGroupModelChange（选源→选模型→updateFlowGroup 写回）。
 * 错过本弹窗仍可在子模式管理面板的组详情「源/模型」行更改（同一共享流程，操作闭环）。
 * @param {object} entry - 消息条目（读 extension._flowGroupCreated {name,filename,api_source,model,presetsCreated}）
 */
async function _maybeHandleFlowGroupCreated(entry) {
  const fg = entry?.extension?._flowGroupCreated;
  if (!fg?.name) return;
  try {
    const cur = fg.api_source ? `${fg.api_source}${fg.model ? " / " + fg.model : ""}` : "跟随当前全局源";
    const change = await beiluConfirm(
      `Skill组「${fg.name}」已创建${fg.presetsCreated ? `（含 ${fg.presetsCreated} 个新预设）` : ""}。\n模型/API 已复制当前子模式：${cur}\n是否更改模型或 API？`,
      { title: "AI 创建了 Skill组", confirmText: "更改", cancelText: "保持" },
    );
    // 老数据兜底：后端旧版 _flowGroupCreated 无 filename（无从写回）→ 只通知不进更改流程
    if (!change || !fg.filename) return;
    await promptFlowGroupModelChange(fg);
  } catch (e) {
    console.warn("[websocket] Skill组创建通知处理失败:", e?.message);
  }
}

/**
 * O18: AI 任务计划 → toast 通知。
 * 后端 replyHandler.mjs:680 写 reply.extension._taskPlan { count, remaining, rev }。
 * @param {object} entry - 消息条目
 */
function _maybeShowTaskPlan(entry) {
  const tp = entry?.extension?._taskPlan;
  if (!tp) return;
  console.log("[websocket] O18 taskPlan toast:", tp);
  const toast = window._beiluToast || window.showToast;
  if (typeof toast === "function") {
    toast(`任务计划已更新: ${tp.count}项, 剩余${tp.remaining}项`, "info");
  }
}
