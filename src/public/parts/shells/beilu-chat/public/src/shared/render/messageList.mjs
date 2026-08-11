/**
 * [messageList] — 单条消息渲染核心。不管消息队列调度（那是 virtualQueue 的事），不管流式逐字渲染（那是 StreamRenderer 的事）。
 *
 * 链路：virtualQueue.renderItem() → renderMessage() → DOM 元素
 *       websocket.mjs message_replaced → virtualQueue.replaceItem → renderMessage()
 * 影响：写 DOM（innerHTML 注入 .message-content）、挂 touch 监听器（swipe）、发出向请求——
 *       删除/编辑/切时间线经 endpoints.mjs（deleteMessage/editMessage/
 *       modifyTimeLine），隐藏/取消隐藏/回档/render-entries 经 sendAction（不直接调 apiFetch）
 * 相交：← virtualQueue.mjs（renderItem 回调）  ← websocket.mjs（message_replaced 触发 replaceItem）
 *       → displayRegex.mjs（applyDisplayRules / applyBuiltinProcessors / detectContentType）
 *       → iframeRenderer.mjs（renderAsIframe: full-html/mixed 分支）
 *       → StreamRenderer.mjs（流式期间由 virtualQueue 管理，本模块不直接调用）
 *       → endpoints.mjs（deleteMessage / editMessage / modifyTimeLine）
 *       → sendAction.mjs（hideMessages / getRenderEntries / getRollbackPreview / 回档 / branch，
 *         target 统一为 shells:chat）
 *
 * 渲染管线（renderMessage 内部）：
 *   消息对象 → resolveMessageSource（取最完整字段源）→ 思维链剥离 → StatusPlaceHolder 提取
 *   → applyBuiltinProcessors → applyDisplayRules（正则替换/美化）→ detectContentType
 *   → 三分支：markdown / full-html(iframe) / mixed → 模板渲染 → DOM 注入
 *
 * 范围：每条消息的渲染 + 交互（编辑/删除/隐藏/回档/拖拽/swipe）。
 *   不管 WS 事件分发、不管消息队列顺序、不管流式增量拼接。
 */
import {
  confirmI18n,
  geti18n,
  main_locale,
} from "../../../../../../scripts/i18n.mjs";
import {
  renderMarkdownAsStandAloneHtmlString,
  renderMarkdownAsString,
} from "../../../../../../scripts/markdown.mjs";
import { onElementRemoved } from "../../../../../../scripts/onElementRemoved.mjs";
import {
  renderTemplate,
  renderTemplateAsHtmlString,
  renderTemplateNoScriptActivation,
} from "../../../../../../scripts/template.mjs";
import { showToast, showToastI18n } from "../../../../../../scripts/toast.mjs";
import { stopGeneration } from "../chat-core/chat.mjs";
import { createDiag } from "../state/diagLogger.mjs";
import {
  activateScriptsInElement,
  applyBuiltinProcessors,
  applyDisplayRules,
  applyThinkingVisibilityBadge,
  detectContentType,
  extractThinkingContent,
  getThinkingFoldLabel,
  isScriptActivationAllowed,
  getRenderDepth,
  getRenderMode,
  restorePlaceholders,
} from "./displayRegex.mjs";
import { deleteMessage, editMessage, modifyTimeLine } from "../transport/endpoints.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // 出向统一门面：render/entries + messages/hide + chat 原子回档 + branch
import { normalizeStructuredApiResult } from "../transport/api-client.mjs";
import {
  handleFilesSelect,
  renderAttachmentPreview,
} from "../chat-core/fileHandling.mjs" // 6c尾·根级散件归位;
import { getfile } from "../transport/files.mjs" // 6c尾·根级散件归位;
import { createShareLink } from "../transport/share.mjs" // 6c尾·根级散件归位;
import { handleTaskOverlayExtension } from "../../panels/task/taskOverlay.mjs";
import { handleCrossModeNotification } from "../widgets/crossModeNotification.mjs";
import { handleRecalledMemory } from "./recalledMemory.mjs";
import {
  DEFAULT_AVATAR,
  resolveAvatar,
  SWIPE_THRESHOLD,
  TRANSITION_DURATION,
  arrayBufferToBase64,
  escapeHtml,
} from "../state/utils.mjs";
const diag = createDiag("messageList");

// ★ Phase 1.2 + Phase 2：MVU 变量桥接 + 混合内容分段渲染
import { addDragAndDropSupport } from "../widgets/dragAndDrop.mjs";
import { renderDiffHtml } from "../../panels/code/diffRenderer.mjs";
import { toolSets } from "../state/toolSets.mjs"; // 0715 硬编码收口(D1)：文件编辑工具清单单源（权威=后端 commandGate.mjs，getApprovalRules 下发覆盖），原独立字面量副本已删
import { renderAsIframe } from "./iframeRenderer.mjs";
import { getPluginEnabled } from "../../stCompat/pluginManager.mjs";
import {
  applyAuthoritativeEdit,
  addDeletionListener,
  beginAuthoritativeEdit,
  consumePendingAuthoritativeEdit,
  endAuthoritativeEdit,
  getChatLogIndexByQueueIndex,
  getMessageElementByQueueIndex,
  getQueue,
  getQueueIndex,
  notifyDeletionListeners,
  rerenderMessageForChat,
  replaceMessageInQueue,
} from "./virtualQueue.mjs";
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { isValidChatId } from "../state/sharedState.mjs";
import { beiluConfirm } from "../widgets/beiluDialog.mjs";

// 用于存储滑动事件监听器的 Map
const swipeListenersMap = new WeakMap();
const deletionQueue = [];

function readMemoryArchiveCoverage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.status !== "not_covered"
    || value.coveredByLedger !== false
    || value.affectedOperations !== null
    || value.restoredOperations !== 0
    || typeof value.reason !== "string"
    || !value.reason.trim()) return null;
  return value;
}

const ROLLBACK_LAYER_LABELS = Object.freeze({
  table: "记忆表格",
  ide_files: "IDE 文件",
  context_summary: "上下文摘要",
  chat: "对话",
});

function rollbackText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function rollbackFlag(value) {
  return value === true ? "是" : value === false ? "否" : "未声明";
}

function describeRollbackNode(label, value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${label}[未返回]`;
  const details = [];
  if (typeof value.status === "string" && value.status) details.push(`status=${value.status}`);
  for (const field of fields) {
    if (typeof value[field] === "boolean") details.push(`${field}=${rollbackFlag(value[field])}`);
    else if (value[field] != null && Number.isFinite(Number(value[field]))) details.push(`${field}=${Number(value[field])}`);
  }
  const reason = value.error || value.warning || value.reason || value.safetyRollbackError;
  if (reason) details.push(`原因=${rollbackText(reason)}`);
  return `${label}[${details.length ? details.join(", ") : "已返回，无状态字段"}]`;
}

function describeFailedRollbackFile(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return rollbackText(value) || "(未知文件)";
  const file = value.relativePath || value.path || value.file || value.name || "(未知文件)";
  const reason = value.error || value.reason || value.message;
  return reason ? `${file} (${rollbackText(reason)})` : String(file);
}

/** 409 抛错与 2xx result 共用的回档结果摘要，不把部分写入伪装成成功。 */
function formatRollbackOutcome(value) {
  const result = normalizeStructuredApiResult(value);
  const completed = Array.isArray(result.completed) && result.completed.length
    ? result.completed.map(layer => ROLLBACK_LAYER_LABELS[layer] || String(layer)).join("、")
    : "无/未声明";
  const failedFileEntries = Array.isArray(result.failedFiles)
    ? result.failedFiles
    : Array.isArray(result.memory?.failedFiles)
      ? result.memory.failedFiles
      : Array.isArray(result.memory?.fileRollback?.failedFiles)
        ? result.memory.fileRollback.failedFiles
        : [];
  const failedFiles = failedFileEntries.length
    ? failedFileEntries.map(describeFailedRollbackFile).join("、")
    : "无/未声明";
  const memory = describeRollbackNode("记忆", result.memory, [
    "success", "applied", "partial", "tableRestored", "contextSummaryInvalidated", "pending", "indeterminate",
  ]);
  const memoryFiles = describeRollbackNode("记忆文件层", result.memory?.fileRollback, [
    "success", "applied", "partial", "attempted", "reverted", "checkpointsReverted", "totalRestored", "totalDeleted", "pending", "indeterminate",
  ]);
  const chat = describeRollbackNode("对话", result.chat, [
    "success", "applied", "partial", "committed", "chatCommitted", "deletedCount", "newLength",
  ]);
  const safetyRollbackError = result.safetyRollbackError || result.memory?.safetyRollbackError;
  const safety = safetyRollbackError
    ? rollbackText(safetyRollbackError)
    : "无/未声明";
  return {
    result,
    reason: rollbackText(result.error || result.warning || result.fileError || result.reason || result.message)
      || "后端未提供详细原因",
    detail: `applied=${rollbackFlag(result.applied)}，partial=${rollbackFlag(result.partial)}，confirmed=${rollbackFlag(result.confirmed)}` +
      `；已完成层=${completed}；failedFiles=${failedFiles}；safetyRollbackError=${safety}；${memory}；${memoryFiles}；${chat}`,
  };
}

function reportRollbackFailure(value, { fallbackHttpStatus, messageId, node = "rollback.failure" } = {}) {
  const outcome = formatRollbackOutcome(value);
  const httpStatus = Number.isInteger(outcome.result.httpStatus)
    ? outcome.result.httpStatus
    : Number.isInteger(fallbackHttpStatus) ? fallbackHttpStatus : null;
  const title = httpStatus ? `回档失败（HTTP ${httpStatus}）` : "回档未确认成功";
  console.error(`[messageList] ${title}:`, outcome.result);
  wbDetect("messageList", node, false, outcome.reason, {
    id: messageId,
    httpStatus,
    applied: outcome.result.applied,
    partial: outcome.result.partial,
    confirmed: outcome.result.confirmed,
    completed: outcome.result.completed,
  });
  showToast(
    "error",
    `${title}：${outcome.reason}；${outcome.detail}。请立即刷新对话，并人工核对对话消息、记忆表格、上下文摘要与 IDE 文件。`,
  );
  return outcome.result;
}

// 全局 Shift 键状态（单例，避免每条消息注册独立 keydown/keyup）
let _globalShiftPressed = false;
const _shiftCallbacks = new Set();
document.addEventListener("keydown", (e) => { if (e.key === "Shift" && !_globalShiftPressed) { _globalShiftPressed = true; _shiftCallbacks.forEach(fn => fn(true)); } });
document.addEventListener("keyup", (e) => { if (e.key === "Shift" && _globalShiftPressed) { _globalShiftPressed = false; _shiftCallbacks.forEach(fn => fn(false)); } });

// ★ K4 [RENDER:*] 渲染相线消费端：拉取当前角色 render 阶段世界书条目内容
//   后端 producer：shell:chat GET :chatid/render/entries → worldbook GetRenderEntries
//   设计：含 [RENDER:*] 的世界书条目「生成期隐藏、渲染期显示」——不进 LLM 提示词，
//   仅在消息渲染时显示。
//   ★ D5 修复：端点改走 shell 后端（带 chatId），后端 loadChat→可见 chat_log 单源喂给
//     GetRenderEntries，使 activationMode=regex 的 [RENDER:*] 条目可随对话关键词激活。
//   缓存键含 chatId + chatLog 指纹（队列长度 + 末条 id），否则 regex 激活结果会冻结在首次
//   渲染、不随对话推进更新（框架md §6 最重要回归点）。同一轮渲染多条消息共享同一指纹→一次请求。
const _renderEntriesCache = new Map(); // cacheKey(chatId|charKey|fingerprint) -> Promise<string[]>
function _renderChatLogFingerprint() {
  // 末条 id + 可见队列长度作指纹：新消息追加/swipe/regen 都会改变其一 → 缓存自然失效
  try {
    const queue = getQueue();
    const len = queue.length;
    const last = len > 0 ? queue[len - 1] : null;
    return len + ":" + (last?.id || "");
  } catch {
    return "0:";
  }
}
async function fetchRenderEntries(charId, charName, chatId) {
  const charKey = charId || charName || "";
  if (!charKey) return [];
  // chatId 缺失 → 无法取 chat_log，且新端点需要 chatid；禁止从当前可见窗口猜 owner。
  if (!chatId) return [];
  const fp = _renderChatLogFingerprint();
  const prefix = chatId + "|" + charKey + "|";
  const cacheKey = prefix + fp;
  if (_renderEntriesCache.has(cacheKey)) return _renderEntriesCache.get(cacheKey);
  // 同 chat+char 的旧指纹键失效（对话推进后只保留最新一份，避免 Map 无界增长）
  for (const k of _renderEntriesCache.keys()) {
    if (k.startsWith(prefix) && k !== cacheKey) _renderEntriesCache.delete(k);
  }
  const p = (async () => {
    try {
      // T6b批7：GET /render/entries?charId&charName → sendAction shells:chat#getRenderEntries（chatId 进 URL，char* 进 query）。
      //   !ok 门面抛错走 catch → []（等价原 !resp.ok return []）。
      const data = await sendAction({ verb: "getRenderEntries", target: "shells:chat", source: "web", scope: { chatId }, payload: { charId, charName } });
      return Array.isArray(data.entries)
        ? data.entries.map((e) => e.content).filter((c) => c && c.trim())
        : [];
    } catch (err) {
      diag.warn("fetchRenderEntries 失败", { charKey, err: err?.message });
      return [];
    }
  })();
  _renderEntriesCache.set(cacheKey, p);
  return p;
}
/** 清除 render 条目缓存（世界书改动后调用，使下次渲染重新拉取） */
export function clearRenderEntriesCache() {
  _renderEntriesCache.clear();
}
// 世界书条目编辑保存后广播此事件 → 失效 render 缓存，下次渲染拉取最新 [RENDER:*]
window.addEventListener("beilu-worldbook-changed", clearRenderEntriesCache);

/**
 * 为每个消息对象存储其专属的 markdown 渲染缓存
 * @type {WeakMap<object, object>}
 */
const messageRenderCacheMap = new WeakMap();

/**
 * 获取或创建消息的渲染缓存对象
 * @param {object} message - 消息对象
 * @returns {object} 缓存对象
 */
function getMessageCache(message) {
  let cache = messageRenderCacheMap.get(message);
  if (!cache) messageRenderCacheMap.set(message, (cache = {}));
  return cache;
}

/**
 * 从当前消息对象和队列中的同 id 消息里，挑出原始字段更完整的那一份。
 * 这样刷新后即使局部渲染对象缺了 content_for_edit/content_for_show，
 * 仍然优先使用聊天队列里那份完整原文。
 * @param {object} message - 当前消息对象
 * @returns {object|null}
 */
function resolveMessageSource(message) {
  if (!message || typeof message !== "object") return null;

  const queueMessage = getQueue().find((item) => item?.id === message.id);
  if (!queueMessage || queueMessage === message) return message;

  const messageScore =
    Number(typeof message.content_for_edit === "string") +
    Number(typeof message.content_for_show === "string") +
    Number(typeof message.content === "string");
  const queueScore =
    Number(typeof queueMessage.content_for_edit === "string") +
    Number(typeof queueMessage.content_for_show === "string") +
    Number(typeof queueMessage.content === "string");

  // replaceItem 期间队列尚未更新，传入的 message 是后端完整消息
  return queueScore > messageScore ? queueMessage : message;
}

/**
 * 获取显示链使用的原始消息文本。
 * @param {object} message - 当前消息对象
 * @returns {string}
 */
function resolveRawMessageContent(message) {
  const source = resolveMessageSource(message);
  // [0717 裸露事故] "剥空"≠"缺失"：纯工具指令消息（整条只有 <ppt_op>/协议标签）被后端
  // _stripAllTags 剥成空串是设计产物（执行状态由回合末 system 工具卡呈现，成功时附件挂气泡）——
  // 旧 || 短路把空串当缺失回退 raw content，导致整块 spec JSON 裸露气泡。
  // 判据：content_for_show 是字符串但剥空，且原文含标签形态（"<"）→ 空显示权威成立；
  // 原文无标签的真空串（历史数据异常）仍走回退，保持兼容。
  if (
    typeof source?.content_for_show === "string" &&
    !source.content_for_show.trim() &&
    typeof source?.content === "string" &&
    source.content.includes("<")
  ) {
    return "";
  }
  return (
    source?.content_for_show ||
    source?.content_for_edit ||
    source?.content ||
    ""
  );
}


/**
 * PJ-5：从未剥离的原始内容解析 <ideToolCall>，生成内置工具调用折叠卡。
 * content_for_show 已被后端 _stripAllTags 剥除 <ideToolCall>，故必须读 message.content。
 * 三种格式：自闭合 <ideToolCall ... /> / 带正文 <ideToolCall ...>...</ideToolCall> / 参数以子标签承载。
 * 写类工具复用 renderDiffHtml 嵌入红删绿增（不另写 diff 引擎）。格式异常则该块不成卡、不报错。
 * @param {string} rawWithTags - 含标签的原始消息内容
 * @returns {string} 折叠卡 HTML（单块、无换行），无工具调用返回 ""
 */
function buildIdeToolCallCards(rawWithTags) {
  if (
    !rawWithTags ||
    typeof rawWithTags !== "string" ||
    rawWithTags.indexOf("<ideToolCall") === -1
  ) {
    return "";
  }
  const blockRe = /<ideToolCall\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ideToolCall>)/gi;
  let m;
  let cards = "";
  while ((m = blockRe.exec(rawWithTags)) !== null) {
    try {
      const attrStr = m[1] || "";
      const body = m[2] || "";
      const attrs = {};
      const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) attrs[am[1]] = am[2];
      const tool = attrs.tool || "ideToolCall";
      const childOf = (tag) => {
        const mm = body.match(new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">", "i"));
        return mm ? mm[1] : "";
      };
      const oldStr = attrs.old_string || childOf("old_string");
      const newStr = attrs.new_string || childOf("new_string");
      const content =
        attrs.content ||
        childOf("content") ||
        childOf("new_content") ||
        (body && !/<\w+>/.test(body) ? body.trim() : "");
      const keyParam =
        attrs.path || attrs.file_path || attrs.command || attrs.query || attrs.pattern || "";
      const summaryParam = keyParam
        ? ` <span class="ide-tool-arg">${escapeHtml(keyParam.length > 80 ? keyParam.slice(0, 80) + "…" : keyParam)}</span>`
        : "";
      let paramsHtml = "";
      for (const k of Object.keys(attrs)) {
        if (k === "tool") continue;
        const v = String(attrs[k]);
        paramsHtml += `<div class="ide-tool-param"><span class="ide-tool-pk">${escapeHtml(k)}</span>=${escapeHtml(v.length > 200 ? v.slice(0, 200) + "…" : v)}</div>`;
      }
      let diffHtml = "";
      if (toolSets.fileEditTools.includes(tool)) {
        // ★ 定点跳转（阶段3）：聊天流卡是 AI 标签自报（无 result 的 contextAnchor），取新内容首非空行作锚——
        //   该行编辑后存在于文件，可据此在 IDE 定位跳转。path 来自标签 keyParam。
        const _firstLine = (s) => (s || "").split("\n").map((l) => l.trim()).find((l) => l) || "";
        if (oldStr || newStr) {
          diffHtml = renderDiffHtml(oldStr, newStr, { fileName: keyParam, tool, revealPath: keyParam, anchorText: _firstLine(newStr) });
        } else if (content) {
          const preview = content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content;
          diffHtml = renderDiffHtml("", preview, { fileName: keyParam, tool, revealPath: keyParam, anchorText: _firstLine(content) });
        }
      }
      cards += `<details class="ide-tool-card"><summary><span class="ide-tool-icon"><i data-ic="wrench"></i></span> <span class="ide-tool-name">${escapeHtml(tool)}</span>${summaryParam}</summary><div class="ide-tool-body">${paramsHtml}${diffHtml}</div></details>`;
    } catch (_e) {
      // 单块解析异常：跳过该块，不影响其它卡与正文（降级不崩）
    }
  }
  return cards;
}

/**
 * [0717 折叠卡补] <ppt_op> 调用折叠卡——与 ideToolCall 卡同范式（凛倾"输出指令会不会折叠"：
 * 剥离后气泡里零痕迹，用户看不到调用发生；卡=可展开看 action/deck/spec 摘要）。
 * 正则与后端 parsePptOps/_stripAllTags 同语义（(?!<ppt_op\b) 前瞻防散文提及吞噬）。
 * @param {string} rawWithTags - 含标签的原始消息内容（message.content）
 * @returns {string} 折叠卡 HTML，无调用返回 ""
 */
function buildPptOpCards(rawWithTags) {
  if (!rawWithTags || typeof rawWithTags !== "string" || rawWithTags.indexOf("<ppt_op") === -1) {
    return "";
  }
  const blockRe = /<ppt_op\b([^>]*?)(?:\/\s*>|>((?:(?!<ppt_op\b)[\s\S])*?)<\/ppt_op>)/gi;
  let m;
  let cards = "";
  while ((m = blockRe.exec(rawWithTags)) !== null) {
    try {
      const attrs = {};
      const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(m[1] || "")) !== null) attrs[am[1]] = am[2];
      const body = (m[2] || "").trim();
      // 散文提及跳过（与后端 parsePptOps 同判据：无属性且 body 非 JSON 开头）
      if (!Object.keys(attrs).length && !/^[\[{`]/.test(body)) continue;
      const action = attrs.action || "generate";
      const subject = attrs.name || attrs.query || attrs.url || attrs.file || "";
      const summaryParam = subject
        ? ` <span class="ide-tool-arg">${escapeHtml(subject.length > 60 ? subject.slice(0, 60) + "…" : subject)}</span>`
        : "";
      let paramsHtml = "";
      for (const k of Object.keys(attrs)) {
        if (k === "action") continue;
        const v = String(attrs[k]);
        paramsHtml += `<div class="ide-tool-param"><span class="ide-tool-pk">${escapeHtml(k)}</span>=${escapeHtml(v.length > 120 ? v.slice(0, 120) + "…" : v)}</div>`;
      }
      if (body) {
        const preview = body.length > 1500 ? body.slice(0, 1500) + "\n…(截断)" : body;
        paramsHtml += `<pre class="ide-tool-param" style="white-space:pre-wrap;max-height:260px;overflow:auto">${escapeHtml(preview)}</pre>`;
      }
      cards += `<details class="ide-tool-card"><summary><span class="ide-tool-icon"><i data-ic="wrench"></i></span> <span class="ide-tool-name">ppt_op·${escapeHtml(action)}</span>${summaryParam}</summary><div class="ide-tool-body">${paramsHtml}</div></details>`;
    } catch (_e) {
      // 单块解析异常：跳过该块，不影响其它卡与正文（降级不崩）
    }
  }
  return cards;
}

/**
 * 获取编辑框使用的原始消息文本。
 * 优先 content_for_edit，缺失时退回 content_for_show/content。
 * 之后由 DOM 挂载后直接写入 textarea.value，避免模板/HTML 解析吞掉 XML 标签。
 * @param {object} message - 当前消息对象
 * @returns {string}
 */
function resolveEditMessageContent(message) {
  const source = resolveMessageSource(message);
  return (
    source?.content_for_edit ||
    source?.content_for_show ||
    source?.content ||
    ""
  );
}

// ============================================================
// ★ 宏替换：{{char}} / {{user}} → 实际角色名/用户名
// ============================================================

/**
 * 替换消息文本中的 SillyTavern 风格宏
 * {{char}} → 角色显示名, {{user}} → 用户显示名
 * @param {string} text - 待替换的文本
 * @param {object} message - 当前消息对象
 * @returns {string} 替换后的文本
 *
 * T10 渲染双管线对齐：export 供 StreamRenderer.renderFrame 复用（禁复制第二份=病6自繁殖）。
 *   流式帧每帧对全量 content 重跑，宏幂等（无 `{{` 快速跳过），成本极低，收益高（否则流式期 {{char}} 裸露→流结束跳变）。
 */
export function replaceMacros(text, message) {
  if (!text || typeof text !== "string") return text;
  if (!text.includes("{{")) return text; // 快速跳过

  // 从消息队列中获取角色名和用户名
  const queue = getQueue();
  let charName = "";
  let userName = "";

  for (const m of queue) {
    if (m.role === "char" && m.name && !charName) charName = m.name;
    if (m.role === "user" && m.name && !userName) userName = m.name;
    if (charName && userName) break;
  }

  // 兜底：从当前消息的 timeSlice 获取
  if (!charName) charName = message?.timeSlice?.charname || "";
  if (!userName) userName = message?.timeSlice?.player_id || "";

  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName);
}

// ============================================================
// ★ Phase 1.2：MVU 变量查找与桥接
// ============================================================

/**
 * 从消息队列中向后查找最近的 mvu_variables
 * 用于：当前消息没有 mvu_variables 时，使用最近的累积状态
 * @param {Array} queue - 消息队列
 * @returns {object|null} 最近的 mvu_variables 或 null
 */
function findLatestMvuVariables(queue) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const vars = queue[i]?.extension?.mvu_variables;
    if (vars && typeof vars === "object" && Object.keys(vars).length > 0) {
      return vars;
    }
  }
  return null;
}

/**
 * 深度合并两个对象（用于 MVU 变量累积合并）
 *
 * 合并语义：
 * - 对象：递归合并，保留未覆盖的字段
 * - 数组：用新值整体覆盖旧值
 * - 原始类型：用新值覆盖旧值
 *
 * @param {object} target - 目标对象
 * @param {object} source - 源对象（覆盖 target 中的同名字段）
 * @returns {object} 合并后的新对象
 */
function deepMergeVars(target, source) {
  if (!source || typeof source !== "object") return target;
  if (!target || typeof target !== "object") return structuredClone(source);

  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (
      srcVal &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      // 两边都是普通对象：递归合并
      result[key] = deepMergeVars(tgtVal, srcVal);
    } else {
      // 数组、原始类型或类型不匹配：用新值覆盖
      result[key] =
        srcVal && typeof srcVal === "object" ? structuredClone(srcVal) : srcVal;
    }
  }
  return result;
}

/**
 * 获取用于渲染的 MVU 变量数据
 *
 * 状态栏语义：显示当前聊天的**最新完整变量状态**。
 * 所有楼层的状态栏都应该展示同一份最新累积变量，
 * 而不是每个楼层只展示截止到自己为止的历史快照。
 *
 * 搜索策略：
 * 1. 从整个队列（所有楼层）深度合并所有 mvu_variables
 * 2. 如果队列中没有变量，从 __beiluVarStore.messages 读取（刷新后兜底）
 *
 * @param {object} message - 当前消息对象（目前未使用，保留参数签名以备后续需要楼层快照）
 * @returns {object} MVU 变量对象（完整累积状态，可能为空对象）
 */
/** @type {{queueLen: number, lastMsgId: string|null, result: object}|null} MVU变量缓存 */
let _mvuCache = null;

function getMvuVariablesForRendering(message) {
  const queue = getQueue();
  const lastMsg = queue[queue.length - 1];
  const lastMsgId = lastMsg?.id;

  // ★ 缓存命中：队列长度和最后一条消息ID都没变
  if (_mvuCache && queue.length === _mvuCache.queueLen && lastMsgId === _mvuCache.lastMsgId) {
    return _mvuCache.result;
  }

  // 从第一楼到最后一楼，依次深度合并所有 mvu_variables
  let accumulated = {};
  for (let i = 0; i < queue.length; i++) {
    const vars = queue[i]?.extension?.mvu_variables;
    if (vars && typeof vars === "object" && Object.keys(vars).length > 0) {
      accumulated = deepMergeVars(accumulated, vars);
    }
  }

  // ★ 兜底：如果队列中完全没有变量（刷新后队列可能还没加载完），
  // 从 __beiluVarStore.messages 累积合并（websocket 同步填充的）
  // 注意：不再从 __beiluVarStore.chat 读取 MVU 变量，
  // chat 作用域只存放脚本设置的默认变量，MVU 变量在 messages 作用域中
  if (Object.keys(accumulated).length === 0) {
    try {
      const store = window.__beiluVarStore;
      if (store?.messages && typeof store.messages === "object") {
        const msgKeys = Object.keys(store.messages)
          .map(Number)
          .filter((n) => !isNaN(n))
          .sort((a, b) => a - b);
        for (const key of msgKeys) {
          const vars = store.messages[key];
          if (
            vars &&
            typeof vars === "object" &&
            Object.keys(vars).length > 0
          ) {
            accumulated = deepMergeVars(accumulated, vars);
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ★ 更新MVU缓存
  _mvuCache = { queueLen: queue.length, lastMsgId: lastMsgId, result: accumulated };
  return accumulated;
}

/**
 * 获取消息用于显示链的原始文本。
 * 优先级：content_for_show → content_for_edit → content
 *
 * 这样即使某一层字段在刷新后缺失，display regex 仍能吃到最后一条真实原文。
 *
 * @param {object} message
 * @returns {string}
 */
function getRawContentForDisplay(message) {
  return (
    message?.content_for_show ||
    message?.content_for_edit ||
    message?.content ||
    ""
  );
}

/**
 * 获取消息用于编辑态的原始文本。
 * 优先级：content_for_edit → content_for_show → content
 *
 * 这样“查看编辑”总能拿到最接近落盘原文的内容，避免模板渲染阶段把 XML 看丢。
 *
 * @param {object} message
 * @returns {string}
 */
function getRawContentForEdit(message) {
  return (
    message?.content_for_edit ||
    message?.content_for_show ||
    message?.content ||
    ""
  );
}

// ============================================================
// ★ P0-2：StatusPlaceHolderImpl 提取与隔离（类似 think 标签的处理方式）
// ============================================================

/**
 * 从文本中提取 StatusPlaceHolderImpl 占位符，类似 extractThinkingContent 的隔离方式。
 * 提取后正文不再包含状态栏标签，两者独立渲染互不干扰。
 * @param {string} text - 输入文本（已剥离思维链后的正文）
 * @returns {{ cleanText: string, hasPlaceholder: boolean }}
 *   - cleanText: 剥离状态栏占位符后的正文
 *   - hasPlaceholder: 原文中是否包含状态栏占位符
 */
// T10 渲染双管线对齐：export 供 StreamRenderer.renderFrame 复用（禁复制）。
//   流式只用返回的 cleanText 剥掉 <StatusPlaceHolderImpl/> 裸标签（幂等、成本极低）；
//   状态栏 iframe 独立注入（依赖完整 mvu_variables，终态才有意义）仍留落稿 renderMessage。
export function extractStatusPlaceholder(text) {
  if (!text || typeof text !== "string")
    return { cleanText: text || "", hasPlaceholder: false };
  const pattern = /<StatusPlaceHolderImpl\s*\/?>/gi;
  if (!pattern.test(text)) return { cleanText: text, hasPlaceholder: false };
  // 重置 lastIndex（test 后正则状态变化）
  const cleanText = text.replace(/<StatusPlaceHolderImpl\s*\/?>/gi, "").trim();
  return { cleanText, hasPlaceholder: true };
}

// ============================================================
// ★ Phase 2.1：混合内容分段检测
// ============================================================

/**
 * 检测 display regex 处理后的内容是否为混合类型
 * （正文 markdown + 嵌入的 full-html 文档）
 *
 * 只在内容同时包含普通文本和完整 HTML 文档时才拆分。
 * 如果整个内容就是一个 HTML 文档（如 <game_text> 替换结果），不拆分。
 *
 * @param {string} text - display regex 处理后的文本
 * @returns {Array<{type: 'markdown'|'full-html', content: string}>|null}
 *   返回分段数组，如果无需拆分则返回 null
 */
// [0807 渲染借鉴 R1] markdown fence 围栏形态的前端代码块归一化（对齐酒馆助手代码块粒度渲染）。
//   酒馆判定=pre 文本含 'html>'|'<head'|'<body'（is_frontend.ts）→ 单独 iframe；beilu 此前该形态
//   落 markdown 分支显示为代码块文本（无 DOCTYPE 时），或被 detectContentType 全文兜底整消息进
//   iframe（带 DOCTYPE 时围栏残渣一起进）。归一化=剥掉围栏让内容以裸 HTML 段进入既有
//   splitMixedContent/detectContentType 链（沿三分支架构，不另起渲染路径）。
//   与酒馆的刻意差异：限定 lang ∈ {html, htm, xml, 无标注}——酒馆不看 lang 只看内容，会把
//   ```js 里贴的 <body> 示例代码也渲染（误伤讨论场景）；beilu 用户有代码讨论习惯，白名单收窄。
function _normalizeFrontendFences(text) {
  if (!text || typeof text !== "string" || !text.includes("```")) return text;
  return text.replace(/```(html|htm|xml)?[ \t]*\n([\s\S]*?)\n?```/gi, (match, _lang, inner) => {
    const isFrontendBlock = ["html>", "<head", "<body"].some((tag) => inner.includes(tag));
    if (!isFrontendBlock) return match;
    // 无 DOCTYPE 的前端块补文档包装——只有真 fence 前端块获得 DOCTYPE 形态，从而进入
    // splitMixedContent/detectContentType 的**既有**判定（不扩全文 pattern：全文扫 <body>
    // 会误伤 ```js 里贴的 HTML 示例字符串，本函数 lang 白名单+局部包装=双重收口）。
    let doc = inner;
    if (!/<!DOCTYPE/i.test(doc)) {
      doc = /<html[\s>]/i.test(doc)
        ? `<!DOCTYPE html>\n${doc}`
        : `<!DOCTYPE html>\n<html>\n${doc}\n</html>`;
    }
    return `\n${doc}\n`;
  });
}

function splitMixedContent(text) {
  // [0807 R1 注] 曾试扩 pattern 到 <html>/<body> 形态——全文扫会误伤 ```js 代码块里贴的 HTML
  //   示例字符串（提取测用例 4 实锤），已回滚。fence 前端块由 _normalizeFrontendFences 局部
  //   补 DOCTYPE 包装后进入本函数**既有**判定，pattern 保持原样。
  const htmlDocPattern = /(<!DOCTYPE[\s\S]*?<\/html\s*>)/gi;
  const matches = [...text.matchAll(htmlDocPattern)];

  if (matches.length === 0) return null;

  // 整个内容就是一个 HTML 文档 → 不拆分（<game_text> 场景，落 detectContentType full-html 整消息路；
  //   fence 归一化后的单块消息也走此守卫=整消息 iframe，行为正确）
  const trimmed = text.trim();
  if (
    matches.length === 1 &&
    trimmed.indexOf(matches[0][0]) === 0 &&
    matches[0][0].length >= trimmed.length - 5
  ) {
    // 允许尾部有少量空白
    return null;
  }

  const segments = [];
  let lastIndex = 0;

  for (const match of matches) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) segments.push({ type: "markdown", content: before });
    segments.push({ type: "full-html", content: match[1] });
    lastIndex = match.index + match[0].length;
  }

  const after = text.slice(lastIndex).trim();
  if (after) segments.push({ type: "markdown", content: after });

  return segments.length > 1 ? segments : null;
}

/**
 * 按顺序处理删除队列。
 * 契约：队列项在点击时冻结 chatId + messageId，索引只作后端定位提示。
 * 只有后端明确返回 applied:true（已保存并广播）才能隐藏 DOM，拒绝“HTTP 200 但实际未删除”的假成功。
 */
let _deletionProcessing = false;
async function processDeletionQueue() {
  if (_deletionProcessing) return;
  _deletionProcessing = true;
  try {
    while (deletionQueue.length > 0) {
      const request = deletionQueue.shift();
      const messageElement = request?.messageElement;
      if (!messageElement) continue;
      try {
        if (messageElement.dataset.isGenerating === "true" || messageElement.classList.contains("is-streaming")) continue;
        const result = await deleteMessage(
          request.chatId,
          request.indexHint,
          request.messageId,
        );
        if (result?.applied !== true) {
          const detail = result?.reason ? `（${result.reason}）` : "";
          showToast("warning", `消息状态已变化，未执行删除；请刷新后重试。${detail}`);
          messageElement.querySelectorAll(".delete-button").forEach(btn => { btn.disabled = false; });
          continue;
        }
        messageElement.style.display = "none";
        notifyDeletionListeners();
        if (result?.status === "committed_derived_failed") {
          console.warn("[messageList] 消息删除已提交，但派生阶段失败:", result);
          wbDetect("messageList", "delete.committedDerivedFailed", false, "committed_derived_failed", {
            messageId: request.messageId,
            derived: result?.derived,
          });
          showToast("warning", "消息已删除，但删除后的备份、摘要或同步等至少一项处理失败；恢复/同步能力可能受损，请刷新核对。");
        }
      } catch (error) {
        console.error("Error processing deletion:", error);
        wbDetect("messageList", "enqueueDeletion", false, error?.message, { stack: error?.stack });
        showToast("error", error.stack || error.message || error);
        messageElement.querySelectorAll(".delete-button").forEach(btn => { btn.disabled = false; });
      }
    }
  } finally {
    _deletionProcessing = false;
  }
}

/**
 * 将消息元素添加到删除队列。
 * @param {HTMLElement} messageElement - 要删除的消息元素。
 * @param {Readonly<{chatId:string,messageId:string,indexHint:number}>} actionIdentity - 渲染时冻结的消息身份。
 */
function enqueueDeletion(messageElement, actionIdentity) {
  const { chatId, messageId, indexHint } = actionIdentity || {};
  if (!isValidChatId(chatId) || typeof messageId !== "string" || !messageId || !Number.isInteger(indexHint) || indexHint < 0) {
    showToast("error", "消息缺少稳定对话/ID/索引身份，未执行删除。请刷新后重试。");
    return;
  }
  deletionQueue.push({
    chatId,
    indexHint,
    messageId,
    messageElement,
  });
  processDeletionQueue();
}

/**
 * 为消息生成完整的 HTML 文档，包括样式表和附件以正确呈现。
 * 如果消息内容包含 H1 标签，其文本将用作文档标题。
 * @param {object} message - 消息对象。
 * @param {object} cache - 缓存对象（与普通渲染共享）。
 * @returns {Promise<string>} 完整的 HTML 字符串。
 */
async function generateFullHtmlForMessage(message, cache) {
  return renderTemplateAsHtmlString("standalone_message", {
    main_locale,
    message,
    /**
     * 渲染 Markdown 为 HTML 字符串（带缓存复用）
     * @param {string} markdown - Markdown 文本
     * @returns {Promise<string>} HTML 字符串
     */
    renderMarkdownAsStandAloneHtmlString: (markdown) =>
      renderMarkdownAsStandAloneHtmlString(markdown, cache),
    geti18n,
    getfile,
    arrayBufferToBase64,
  });
}

// ★ 对人类不隐藏：被压缩/清理标记 _hidden 的对话消息在前端灰显标识（仍可翻看、可恢复），
//   AI 侧由 requestBuilder:97 + proxy 两层过滤不发送。样式模块加载时注入一次。
(function _injectHiddenMsgStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById("beilu-hidden-msg-style")) return;
  const _hs = document.createElement("style");
  _hs.id = "beilu-hidden-msg-style";
  _hs.textContent =
    ".beilu-hidden-msg{opacity:.5;filter:grayscale(.55);position:relative;}" +
    '.beilu-hidden-msg::after{content:"已隐藏·不发送AI";position:absolute;top:4px;right:8px;font-size:9px;color:#999;background:rgba(128,128,128,.16);padding:1px 6px;border-radius:7px;pointer-events:none;z-index:2;}' +
    // T3 折叠条：被隐藏消息默认折叠为一行灰条（「已隐藏：N 字 · 原因」+ 展开/取消隐藏），展开时灰条插在正文上方。
    ".beilu-hidden-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#888;background:rgba(128,128,128,.10);border:1px dashed rgba(128,128,128,.35);border-radius:8px;padding:4px 10px;margin:2px 0;cursor:default;grid-column:1/-1;}" +
    ".beilu-hidden-bar .bhb-icon{opacity:.7;}" +
    ".beilu-hidden-bar .bhb-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".beilu-hidden-bar button{font-size:10px;color:#888;background:rgba(128,128,128,.16);border:none;border-radius:6px;padding:1px 8px;cursor:pointer;line-height:1.6;}" +
    ".beilu-hidden-bar button:hover{color:#555;background:rgba(128,128,128,.28);}" +
    // 折叠态：灰条显示、原正文隐藏；展开态(.bhm-expanded)：灰条+灰显正文都显示。
    ".beilu-hidden-msg.bhm-collapsed > :not(.beilu-hidden-bar){display:none !important;}" +
    ".beilu-hidden-msg.bhm-collapsed::after{display:none;}" +
    // 全局关闭灰条(beilu-show-hidden=false)：整条隐藏消息彻底不显示（用户"全隐"）。
    "body.beilu-hide-hidden-msgs .beilu-hidden-msg{display:none !important;}" +
    // [0725 凛倾「大量压缩直接给一个通知」] 分组聚合：连续 ≥2 条折叠隐藏消息合并为一条聚合灰条，
    //   成员整条隐掉（折叠态唯一可见子元素就是自己的灰条）；聚合条受全隐开关同控。
    ".beilu-hidden-msg.bhm-in-group{display:none !important;}" +
    "body.beilu-hide-hidden-msgs .beilu-hidden-group-bar{display:none !important;}";
  document.head.appendChild(_hs);
})();

// T3：show-hidden 全局开关（localStorage:beilu-show-hidden，默认"显示灰条"=true；false=全隐）。
// 读取统一走此函数，body class 驱动 CSS——显示效果 100% 由 :664 CSS 规则达成，无 JS 渲染分支依赖。
// [0716 死广播清理] 原"切换后派发 beilu:show-hidden-changed 供监听刷新"已删：全库零监听（许愿注释），效果已由 class 全达成。
export function isShowHiddenEnabled() {
  if (typeof localStorage === "undefined") return true;
  return storage.get(KEYS.BEILU_SHOW_HIDDEN) !== "false";
}
function _applyShowHiddenBodyClass() {
  if (typeof document === "undefined" || !document.body) return;
  document.body.classList.toggle("beilu-hide-hidden-msgs", !isShowHiddenEnabled());
}
export function setShowHidden(on) {
  if (typeof localStorage !== "undefined") {
    storage.set(KEYS.BEILU_SHOW_HIDDEN, on ? "true" : "false");
  }
  _applyShowHiddenBodyClass();
}
if (typeof window !== "undefined") {
  window.beiluSetShowHidden = setShowHidden;
  window.beiluIsShowHiddenEnabled = isShowHiddenEnabled;
  // 模块加载即同步一次 body class（DOM 已就绪时）
  if (typeof document !== "undefined") {
    if (document.body) _applyShowHiddenBodyClass();
    else document.addEventListener("DOMContentLoaded", _applyShowHiddenBodyClass, { once: true });
  }
}

// T4：隐藏原因标签——优先读后端 _hiddenMeta.reason（T4 元数据），无 meta 时降级 T3 正则猜测（兼容旧数据）。
// _hiddenMeta 结构：{ by: 'ai'|'auto'|'user', at: timestamp, reason: string }
const _REASON_LABEL = {
  contextClean: "AI 主动清理", urgent: "紧急 token 压缩", urgent_token_compact: "紧急 token 压缩",
  smartClean: "智能压缩/旧对话", cloneClean: "分身委派", manual: "手动隐藏",
  clearTool: "工具结果清理", hideContextNoise: "噪声清理", cleanReadCache: "读取缓存清理",
  cleanIdeResults: "工具结果清理", read_file_refresh: "旧读取刷新", write_cleanup: "写操作清理",
  pure_read_external_change: "外部修改刷新", auto_write_cleanup: "自动写清理",
};
const _BY_LABEL = { ai: "AI", auto: "自动", user: "你" };
function _deriveHiddenReason(message) {
  const ext = message?.extension || {};
  // T4 路径：后端写入的结构化元数据
  const meta = ext._hiddenMeta;
  if (meta && meta.by) {
    const byLabel = _BY_LABEL[meta.by] || meta.by;
    const reasonLabel = _REASON_LABEL[meta.reason] || meta.reason || meta.by;
    return `${byLabel}·${reasonLabel}`;
  }
  // T3 降级：旧数据无 _hiddenMeta，按内容正则猜测
  if (ext._opType === "ide_tool_result" || message?.name === "IDE工具结果") return "旧读取/工具结果";
  if (ext._opType === "ide_tool_call") return "AI 操作记录";
  if (ext._isSummary) return "已摘要替代";
  const c = typeof message?.content === "string" ? message.content : "";
  if (/<(分身\d|delegate|parallelDelegate|report|approval)[\s>]/i.test(c)) return "分身委派";
  return "token 压缩/旧对话";
}

// T3：给已隐藏消息挂折叠灰条。展开切换 bhm-collapsed；「取消隐藏」走 messages/hide 端点(hide:false)恢复进 AI 上下文。
// 索引坐标系=chatLogIndex（GetChatLog 全序=原始序，与后端 hideMessages 一致），复用既有 getQueueIndex/getChatLogIndexByQueueIndex。
function _attachHiddenBar(messageElement, message, actionIdentity) {
  try {
    if (messageElement.querySelector(":scope > .beilu-hidden-bar")) return;
    const rawText = resolveRawMessageContent(message) || message.content || "";
    const charN = (typeof rawText === "string" ? rawText : String(rawText || "")).length;
    const reason = _deriveHiddenReason(message);
    const bar = document.createElement("div");
    bar.className = "beilu-hidden-bar";
    bar.innerHTML =
      '<span class="bhb-icon"><i data-ic="mute"></i></span>' +
      `<span class="bhb-meta">已隐藏：${charN} 字 · ${escapeHtml(reason)}</span>` +
      '<button type="button" class="bhb-expand"></button>' +
      '<button type="button" class="bhb-unhide">取消隐藏</button>';
    const expandBtn = bar.querySelector(".bhb-expand");
    const _syncExpandLabel = () =>
      (expandBtn.textContent = messageElement.classList.contains("bhm-collapsed") ? "展开" : "收起");
    _syncExpandLabel();
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      messageElement.classList.toggle("bhm-collapsed");
      _syncExpandLabel();
    });
    bar.querySelector(".bhb-unhide").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const { chatId, messageId, indexHint } = actionIdentity || {};
        if (!isValidChatId(chatId) || typeof messageId !== "string" || !messageId || !Number.isInteger(indexHint) || indexHint < 0) {
          showToast("error", "消息缺少稳定对话/ID/索引身份，未执行取消隐藏。请刷新后重试。");
          return;
        }
        // T6b批7：POST /messages/hide → sendAction shells:chat#hideMessages（chatId 进 URL，body {indices,hide}）。
        //   !ok 门面抛错走 catch；成功返回 body r，仍按 r.success!==false 业务校验。
        const r = await sendAction({ verb: "hideMessages", target: "shells:chat", source: "web", scope: { chatId }, payload: { indices: [indexHint], messageIds: [messageId], hide: false } });
        if (r.success !== false) {
          if (!message.extension) message.extension = {};
          message.extension._hidden = false;
          messageElement.classList.remove("beilu-hidden-msg", "bhm-collapsed");
          messageElement.setAttribute("data-hidden", "false");
          bar.remove();
          showToast("success", "已取消隐藏（重新发送给 AI）");
        } else {
          showToast("error", "取消隐藏失败: " + (r.error || "未知"));
        }
      } catch (err) {
        wbDetect("messageList", "unhideBar", false, err?.message, { id: message?.id });
        showToast("error", "取消隐藏失败: " + (err.message || err));
      }
    });
    // 灰条置于消息元素最前（折叠态下它是唯一可见子元素）。
    messageElement.insertBefore(bar, messageElement.firstChild);
    // [0725 分组聚合] 供 _regroupHiddenBars 汇总用：字数/原因落 dataset，message 引用挂 expando
    //   （批量取消隐藏成功后要回写 extension._hidden，与单条 unhide 同步语义）。
    messageElement.dataset.bhmChars = String(charN);
    messageElement.dataset.bhmReason = reason;
    messageElement._bhmMessage = message;
    messageElement._bhmActionIdentity = actionIdentity;
    _scheduleHiddenBarRegroup();
  } catch (err) {
    wbDetect("messageList", "attachHiddenBar", false, err?.message, { id: message?.id });
  }
}

// [0725 凛倾「用户进行大量压缩,直接给一个,而不是每一个都发送一个通知」] 连续隐藏消息分组聚合。
// 设计：不动单条灰条生产线（_attachHiddenBar 照挂，展开/单条取消隐藏能力保留），在其上加一层
//   rAF 去抖的 DOM 分组器——相邻（nextElementSibling 连续）的折叠隐藏消息 ≥2 条时，成员加
//   .bhm-in-group 整条隐掉，组头前插一条聚合灰条「已隐藏 N 条 · 共 M 字 · 原因」+ 展开 + 全部取消隐藏。
//   入口收口：所有灰条挂载都走 _attachHiddenBar（单条 unhide 移除灰条时同样调度）→ 增量渲染/
//   websocket 重渲/批量压缩广播全部自然覆盖，无需挂额外事件面。
//   展开=解组（成员各自灰条恢复可见、可逐条操作），并打 bhmUngrouped 标记防 rAF 下一轮立即回组；
//   整列表重渲元素重建=标记自然消失=回归聚合态。
//   全部取消隐藏=批量走既有 hideMessages 端点（indices 数组本就是复数契约），成功后逐条回写
//   extension._hidden=false + DOM 态，与单条 unhide 语义一致。
let _bhmRegroupScheduled = false;
function _scheduleHiddenBarRegroup() {
  if (_bhmRegroupScheduled || typeof requestAnimationFrame === "undefined") return;
  _bhmRegroupScheduled = true;
  requestAnimationFrame(() => {
    _bhmRegroupScheduled = false;
    try {
      _regroupHiddenBars();
    } catch (err) {
      wbDetect("messageList", "regroupHiddenBars", false, err?.message, {});
    }
  });
}
function _regroupHiddenBars() {
  if (typeof document === "undefined") return;
  // 1. 清旧聚合条 + 解除成员标记（幂等重建，避免增量维护组边界的状态机）
  document.querySelectorAll(".beilu-hidden-group-bar").forEach((b) => b.remove());
  document.querySelectorAll(".beilu-hidden-msg.bhm-in-group").forEach((el) => el.classList.remove("bhm-in-group"));
  // 2. 按 DOM 序扫连续折叠隐藏消息（展开态/手动解组标记的条目自然断组）
  const _hiddenEls = [...document.querySelectorAll(".beilu-hidden-msg.bhm-collapsed")].filter(
    (el) => !el.dataset.bhmUngrouped,
  );
  const _runs = [];
  let _cur = [];
  for (const el of _hiddenEls) {
    if (_cur.length && _cur[_cur.length - 1].nextElementSibling === el) _cur.push(el);
    else {
      if (_cur.length >= 2) _runs.push(_cur);
      _cur = [el];
    }
  }
  if (_cur.length >= 2) _runs.push(_cur);
  for (const _run of _runs) _buildHiddenGroupBar(_run);
}
function _buildHiddenGroupBar(run) {
  const totalChars = run.reduce((s, el) => s + (parseInt(el.dataset.bhmChars, 10) || 0), 0);
  const _reasons = [...new Set(run.map((el) => el.dataset.bhmReason || ""))].filter(Boolean);
  const reasonLabel =
    _reasons.length <= 1 ? (_reasons[0] || "") : _reasons.slice(0, 2).join("、") + (_reasons.length > 2 ? " 等" : "");
  const bar = document.createElement("div");
  bar.className = "beilu-hidden-bar beilu-hidden-group-bar";
  bar.innerHTML =
    '<span class="bhb-icon"><i data-ic="mute"></i></span>' +
    `<span class="bhb-meta">已隐藏 ${run.length} 条 · 共 ${totalChars} 字${reasonLabel ? " · " + escapeHtml(reasonLabel) : ""}</span>` +
    '<button type="button" class="bhb-expand">展开</button>' +
    '<button type="button" class="bhb-unhide">全部取消隐藏</button>';
  bar.querySelector(".bhb-expand").addEventListener("click", (e) => {
    e.stopPropagation();
    // 解组：成员灰条恢复逐条可见可操作；bhmUngrouped 防 rAF 下一轮立即回组（重渲元素重建即自然复位）
    run.forEach((el) => {
      el.classList.remove("bhm-in-group");
      el.dataset.bhmUngrouped = "1";
    });
    bar.remove();
  });
  bar.querySelector(".bhb-unhide").addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      let groupChatId = "";
      const indices = [];
      const messageIds = [];
      const members = [];
      for (const el of run) {
        const identity = el._bhmActionIdentity;
        const { chatId, messageId, indexHint } = identity || {};
        const valid = isValidChatId(chatId) &&
          typeof messageId === "string" && !!messageId &&
          Number.isInteger(indexHint) && indexHint >= 0;
        if (!valid || (groupChatId && groupChatId !== chatId)) {
          showToast("error", "隐藏消息组缺少同一对话的稳定身份，未执行批量取消隐藏。请刷新后重试。");
          return;
        }
        groupChatId = chatId;
        indices.push(indexHint);
        messageIds.push(messageId);
        members.push(el);
      }
      if (!groupChatId || !indices.length || indices.length !== run.length) {
        showToast("error", "隐藏消息组身份不完整，未执行批量取消隐藏。请刷新后重试。");
        return;
      }
      const r = await sendAction({ verb: "hideMessages", target: "shells:chat", source: "web", scope: { chatId: groupChatId }, payload: { indices, messageIds, hide: false } });
      if (r.success !== false) {
        members.forEach((el) => {
          const m = el._bhmMessage;
          if (m) {
            if (!m.extension) m.extension = {};
            m.extension._hidden = false;
          }
          el.classList.remove("beilu-hidden-msg", "bhm-collapsed", "bhm-in-group");
          el.setAttribute("data-hidden", "false");
          el.querySelector(":scope > .beilu-hidden-bar")?.remove();
        });
        bar.remove();
        showToast("success", `已取消隐藏 ${members.length} 条（重新发送给 AI）`);
      } else {
        showToast("error", "批量取消隐藏失败: " + (r.error || "未知"));
      }
    } catch (err) {
      wbDetect("messageList", "unhideGroupBar", false, err?.message, { count: run.length });
      showToast("error", "批量取消隐藏失败: " + (err.message || err));
    }
  });
  // 聚合条插在组头之前（成员整条被 .bhm-in-group 隐掉，本条是该组唯一可见 UI）
  run[0].parentNode?.insertBefore(bar, run[0]);
  run.forEach((el) => el.classList.add("bhm-in-group"));
}

/**
 * FT4 §1.4 防重复 iframe 护栏。
 *
 * 渲染前移除该消息元素下既有的渲染产物，避免同一消息被重复渲染（如 websocket
 * message_replaced + 二次 regex 触发）时叠加出多个 iframe / 状态栏容器
 * （「渲染前端界面-替换助手宏-渲染前端界面」两次渲染场景）。
 *
 * 只做确定性移除，不引入 Vue 生命周期（凛倾「兼容不是创新」）。
 * @param {HTMLElement} messageElement - 消息根 DOM 元素
 * @returns {number} 移除的产物数量（供白盒/调试记录）
 */
function clearExistingRenderArtifacts(messageElement) {
  if (!messageElement || typeof messageElement.querySelectorAll !== "function") {
    return 0;
  }
  let removed = 0;
  // full-html / 状态栏 / mixed 段三类既有渲染产物
  messageElement
    .querySelectorAll(
      ".beilu-beauty-iframe, .mvu-status-container, .segment-iframe-container",
    )
    .forEach((node) => {
      node.remove();
      removed++;
    });
  if (removed > 0) {
    wbTrace("messageList", "clearExistingRenderArtifacts", {
      id: messageElement.id,
      removed,
    });
  }
  return removed;
}

/**
 * 渲染单条消息元素（本模块核心导出）。
 *
 * 链路：virtualQueue.renderItem(item, itemIndex) → 本函数 → DOM 元素
 *       流程：消息对象 → 系统消息过滤 → IDE工具结果卡 → 黑名单过滤 → 思维链剥离
 *       → StatusPlaceHolder 提取 → 内置处理器 → display regex → 分段检测
 *       → 三分支渲染（markdown / full-html(iframe) / mixed）→ 模板注入 → 交互绑定
 * 影响：写 DOM（innerHTML 注入 .message-content）、挂 touch 监听器、注册 onElementRemoved 回调
 * 约束：message 对象必须包含 id/role/content 字段，否则返回错误占位 div
 *
 * @param {object} message - 消息对象（含 id, role, content, content_for_show, extension 等）
 * @param {object} [renderContext] - 渲染上下文（由 virtualList 的 renderItem 回调传入）
 * @param {number} [renderContext.itemIndex] - 消息在总数据集中的绝对索引
 * @param {number} [renderContext.totalCount] - 总消息数量
 * @param {string} [renderContext.chatId] - 显式渲染窗口 ID（有则优先）
 * @returns {Promise<HTMLElement>} - 渲染好的消息 DOM 元素。
 */
export async function renderMessage(message, renderContext) {
  // 消息 DOM 可在多窗口后台继续存活；删除/回档闭包只接受渲染队列显式传入的 owner chatId。
  // 缺失时保持空值，后续破坏性入口 fail-closed；禁止从当前可见窗口/全局对话猜身份。
  const renderedChatId = isValidChatId(renderContext?.chatId)
    ? renderContext.chatId
    : "";
  wbTrace("messageList", "renderMessage", { id: message?.id, role: message?.role, contentLen: message?.content?.length });
  // 渲染入口记录（debug级别，不在生产中输出）
  diag.debug("renderMessage entry", {
    id: message?.id,
    role: message?.role,
    name: message?.name,
    contentLen: message?.content?.length,
  });

  // ★ 全面防御：确保 message 对象完整性
  if (!message || typeof message !== "object") {
    wbDetect("messageList", "renderMessage.invalidMessage", false, "无效消息对象", { type: typeof message });
    diag.error("renderMessage received invalid message:", message);
    const div = document.createElement("div");
    div.className = "chat-message mb-3";
    div.textContent = "[渲染错误：无效消息对象]";
    return div;
  }

  // DOM 发起的破坏性操作必须绑定渲染时的稳定身份，不能在点击/确认/await 后再读取当前窗口。
  // indexHint 只作为后端定位提示；messageId 是跨并发变更仍稳定的消息身份。
  const renderedActionIdentity = Object.freeze({
    chatId: renderedChatId,
    messageId: typeof message.id === "string" ? message.id : "",
    indexHint: Number.isInteger(renderContext?.itemIndex) && renderContext.itemIndex >= 0
      ? renderContext.itemIndex
      : -1,
  });

  // _deleted 条目不渲染（rollback 产物）——必须在 ide_tool_result 特判之前，
  // 否则已删的工具结果条走特判分支直接渲染可见折叠卡，跳过隐藏逻辑。
  if (message.extension?._deleted) {
    const deletedEl = document.createElement("div");
    deletedEl.style.display = "none";
    deletedEl.className = "chat-message deleted-hidden";
    deletedEl.id = message.id || "msg-del-" + Math.random().toString(36).substring(2, 10);
    return deletedEl;
  }

  // ★ PJ-5：IDE 工具结果消息渲染为折叠结果卡（替代整条隐藏，可观测度最大）。
  //   必须在下方系统消息过滤之前特判——否则被 display:none 隐藏永远到不了这里。
  //   其它系统消息（世界书/系统注入）仍走下方过滤隐藏，逻辑不变。
  if (
    message.name === "IDE工具结果" ||
    message?.extension?._opType === "ide_tool_result"
  ) {
    const resText = resolveRawMessageContent(message) || message.content || "";
    let statusCls = "ok";
    // includes 判断的 ✅❌⚠️ 是后端工具结果文本协议，不能动；仅展示图标换 data-ic
    let statusIcon = '<i data-ic="check"></i>';
    if (resText.includes("❌")) {
      statusCls = "fail";
      statusIcon = '<i data-ic="cross"></i>';
    } else if (resText.includes("⚠️")) {
      statusCls = "warn";
      statusIcon = '<i data-ic="warning"></i>';
    }
    // B4：有结构化事件（extension.ideToolEvents）时卡头显「工具+对象+状态」，比通用"IDE 工具结果"信息密度高
    let summaryHtml = `<span class="ide-tool-result-icon">${statusIcon}</span> IDE 工具结果`;
    const _evts = message?.extension?.ideToolEvents;
    if (Array.isArray(_evts) && _evts.length > 0) {
      if (_evts.some((e) => e && e.ok === false)) statusCls = "fail";
      summaryHtml = _evts
        .map((e) => `${e?.ok === false ? '<i data-ic="cross"></i>' : '<i data-ic="check"></i>'} <b>${escapeHtml(e?.tool || "?")}</b>${e?.subject ? ` <span class="opacity-60">${escapeHtml(e.subject)}</span>` : ""}`)
        .join(" · ");
    }
    const wrap = document.createElement("div");
    wrap.className = "chat-message ide-tool-result-msg";
    wrap.id =
      message.id || "msg-ideres-" + Math.random().toString(36).substring(2, 10);
    wrap.innerHTML = `<details class="ide-tool-result-card ide-tool-result-${statusCls}"><summary>${summaryHtml}</summary><div class="ide-tool-result-body"><pre>${escapeHtml(resText)}</pre></div></details>`;
    return wrap;
  }

  // ★ P0修复：过滤系统消息（世界书条目/注入的上下文）
  // 这些消息是 world 的 AddChatLogEntry 注入的 AI 上下文，不应该在聊天界面显示
  // 典型特征：role='system'，或 name='系统' / name='IDE工具结果'
  if (message.role === "system" || message.name === "系统" || message.name === "IDE工具结果") {
    wbTrace("messageList", "renderMessage.systemFiltered", { id: message.id, role: message.role, name: message.name });
    diag.log(
      `skipping system message (role=${message.role}, name=${message.name}), not rendering`,
    );
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    hidden.className = "chat-message system-hidden";
    hidden.id =
      message.id || "msg-sys-" + Math.random().toString(36).substring(2, 10);
    return hidden;
  }

  {
    const _blLines = (key) =>
      (storage.get(key) || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    const _userBl = _blLines(KEYS.BEILU_USER_BLACKLIST);
    if (_userBl.length && message.name && _userBl.some((w) => String(message.name).includes(w))) {
      const hiddenBl = document.createElement("div");
      hiddenBl.style.display = "none";
      hiddenBl.className = "chat-message blacklist-hidden";
      hiddenBl.id = message.id || "msg-bl-" + Math.random().toString(36).substring(2, 10);
      return hiddenBl;
    }
    const _msgBl = _blLines(KEYS.BEILU_MSG_BLACKLIST);
    const _rawTxt = String(message.content || "");
    const _hitWord = _msgBl.find((w) => _rawTxt.includes(w));
    if (_hitWord) {
      const wrapBl = document.createElement("div");
      wrapBl.className = "chat-message blacklist-collapsed";
      wrapBl.id = message.id || "msg-bl-" + Math.random().toString(36).substring(2, 10);
      wrapBl.innerHTML = `<details class="ide-tool-result-card ide-tool-result-warn"><summary><i data-ic="ban"></i> 已折叠：命中黑名单关键词「${escapeHtml(_hitWord)}」</summary><div class="ide-tool-result-body"><pre>${escapeHtml(_rawTxt)}</pre></div></details>`;
      return wrapBl;
    }
  }

  // ★ 感知消息隐藏：以 [beilu-eye-screenshot] 或 [beilu-browser-page] 开头的用户消息
  // 默认前端不显示在聊天界面（视觉隐藏），但 AI 仍能看到（通过 addUserReply 发送）
  // 用户可以通过"显示感知消息"开关（localStorage: beilu-show-sense-messages）控制是否显示
  // 注：beilu-browser 插件仍在（main.mjs 实现 <browser_op> AI 工具协议，经 replyHandler/generation
  //   对话内标签协议持续服务），但"前端 sendAction 触发浏览器快照注入用户消息"这条子功能与其
  //   functions:browser facade/桥注册已删（2026-07-16）。[beilu-browser-page] 前缀无新 producer——
  //   分支保留只为历史对话里的存量消息不裸显（遗留数据消费侧，非活功能）。
  if (
    message.role === "user" &&
    typeof message.content === "string" &&
    (message.content.startsWith("[beilu-eye-screenshot]") ||
      message.content.startsWith("[beilu-browser-page]"))
  ) {
    const showSenseMessages =
      storage.get(KEYS.BEILU_SHOW_SENSE_MESSAGES) === "true";
    if (!showSenseMessages) {
      const senseType = message.content.startsWith("[beilu-eye-screenshot]")
        ? "eye"
        : "browser";
      wbTrace("messageList", "renderMessage.senseHidden", { id: message.id, senseType });
      diag.log(`hiding beilu-${senseType} sense message (id=${message.id})`);
      const hidden = document.createElement("div");
      hidden.style.display = "none";
      hidden.className = `chat-message beilu-${senseType}-hidden`;
      hidden.id =
        message.id ||
        `msg-${senseType}-` + Math.random().toString(36).substring(2, 10);
      return hidden;
    }
    // 开关开启时，继续正常渲染（不隐藏）
    const senseType = message.content.startsWith("[beilu-eye-screenshot]")
      ? "eye"
      : "browser";
    diag.log(
      `showing beilu-${senseType} sense message (id=${message.id}, toggle=on)`,
    );
  }

  if (!message.id) {
    message.id = "msg-" + Math.random().toString(36).substring(2, 15);
    wbDetect("messageList", "renderMessage.missingId", false, "消息缺少id，已生成兜底", { genId: message.id, role: message.role });
    diag.warn(
      `message missing id, generated fallback: ${message.id}`,
      "| keys:",
      Object.keys(message).join(","),
      "| role:",
      message.role,
      "| name:",
      message.name,
      "| contentLen:",
      message.content?.length,
      "| hasTimeSlice:",
      !!message.timeSlice,
      "| content_preview:",
      message.content?.substring?.(0, 100),
    );
  }

  const cache = getMessageCache(message);

  // 获取原始内容：优先使用队列里更完整的那份消息，避免刷新后局部对象缺字段
  // ★ 宏替换：在显示前将 {{char}}/{{user}} 替换为实际名称
  const rawContent = replaceMacros(resolveRawMessageContent(message), message);

  // ★ 提取思维链内容（从正文中剥离，后续渲染到独立 UI 组件）
  // [2026-08-10 凛倾] 思维链提取/折叠只作用于 AI 消息：用户自己发的消息含 <thinking>/<beilu_thinking>/
  //   自定义标签字面量（讨论、示例、转贴）不提取不折叠，原样显示——折叠语义=「AI 的思考过程」，
  //   用户消息没有这层语义（凛倾 0810：「用户的xml标签别折叠…只是隐藏ai的不行吗」）。
  const _skipThinkingExtract = message.role === "user";
  let { cleanText: thinkingCleanText, thinkingText, hasBeiluThinking, hasOtherReasoning } =
    _skipThinkingExtract
      ? { cleanText: rawContent, thinkingText: "", hasBeiluThinking: false, hasOtherReasoning: false }
      : extractThinkingContent(rawContent);
  wbTrace("messageList", "renderMessage.thinkingExtracted", { id: message?.id, rawLen: rawContent?.length, cleanLen: thinkingCleanText?.length, thinkingLen: thinkingText?.length });

  // ★ THINKING 诊断：追踪思维链提取后正文是否为空
  //   级别 debug：每消息每次渲染都触发的逐条追踪属 debug 域（warn 级会在用户开过 ?diag= 后
  //   以 WRN 刷满后台监控——0720 实抓；warn 只留真异常）
  diag.debug("★ THINKING DIAG", {
    id: message?.id,
    rawContentLen: rawContent?.length,
    rawContentPreview: rawContent?.substring(0, 300),
    thinkingCleanTextLen: thinkingCleanText?.length,
    thinkingCleanTextEmpty: !thinkingCleanText?.trim(),
    thinkingTextLen: thinkingText?.length,
    thinkingTextPreview: thinkingText?.substring(0, 200),
    msgContentLen: message?.content?.length,
    msgContentPreview: message?.content?.substring(0, 200),
    msgContentForShowLen: message?.content_for_show?.length,
    msgContentForShowExists: message?.content_for_show !== undefined,
    msgContentForEditLen: message?.content_for_edit?.length,
  });

  // ★ P0-3修复：content_for_show 可能只包含思维链（如角色卡将 <thinking> 和正文拆到不同字段）
  // 提取思维链后如果正文为空，需要根据情况选择不同的兜底路径：
  //
  // 路径A（角色卡分字段模式）：message.content 有值，从中重新提取正文
  // 路径B（Claude Extended Thinking 模式）：reasoning_content 被 proxy 包成 <think>，
  //   content 为空，所以 content_for_show 和 content 均为空。
  //   此时 thinkingCleanText 为空是"正确"的 —— AI 只返回了思维链，没有最终回答。
  //   兜底：显示提示文字 + 思维链原文，避免气泡完全空白。
  if ((!thinkingCleanText || !thinkingCleanText.trim()) && thinkingText) {
    const hasContent =
      message.content &&
      typeof message.content === "string" &&
      message.content.trim();

    if (hasContent) {
      // ★ 路径A：从 content 字段重新提取（角色卡模式）
      diag.log(
        "P0-3A: content_for_show 提取思维链后正文为空，回退到 content 字段",
        {
          id: message.id,
          showLen: rawContent?.length,
          contentLen: message.content?.length,
        },
      );
      const fallback = _skipThinkingExtract
        ? { cleanText: message.content, thinkingText: "", hasBeiluThinking: false, hasOtherReasoning: false }
        : extractThinkingContent(message.content);
      thinkingCleanText = fallback.cleanText;
      // 保留已提取的思维链，不覆盖（content_for_show 中的更完整）
      if (!thinkingText && fallback.thinkingText) {
        thinkingText = fallback.thinkingText;
      }
      // [2026-08-10 badge 诚实性] 回退路径来源标记并入（OR）：badge 需反映实际展示的思维链来源
      hasBeiluThinking = hasBeiluThinking || fallback.hasBeiluThinking;
      hasOtherReasoning = hasOtherReasoning || fallback.hasOtherReasoning;
      // ★ P0-3b：剥离 <content> 包裹标签
      if (thinkingCleanText) {
        thinkingCleanText = thinkingCleanText
          .replace(/^<content>\s*/i, "")
          .replace(/\s*<\/content>\s*$/i, "");
      }
    } else {
      // ★ 路径B：Extended Thinking 模式 —— AI 只有 reasoning_content，无最终回答
      // 为避免气泡完全空白，显示提示信息
      diag.warn(
        "P0-3B: Extended Thinking 模式 —— content 和 content_for_show 均为空，显示思维链兜底",
        {
          id: message.id,
          thinkingTextLen: thinkingText.length,
        },
      );
      thinkingCleanText = `*（AI 仅返回了思考过程，无最终回答）*`;
    }
  }

  // ★ P0-3c：无论哪条分支，都剥离 <content> 包裹标签
  // 角色卡输出格式为 <thinking>...</thinking><content>...</content>
  // content_for_show 可能包含完整输出，提取 thinking 后 cleanText 以 <content> 开头
  // <content> 不是标准 HTML，markdown 渲染器会将其丢弃或吞掉内容
  if (thinkingCleanText) {
    thinkingCleanText = thinkingCleanText
      .replace(/^\s*<content>\s*/i, "")
      .replace(/\s*<\/content>\s*$/i, "");
  }

  // ★ P0-2修复：像 think 标签一样，从正文中提取 StatusPlaceHolderImpl 并独立渲染
  // 1. 从正文中提取 StatusPlaceHolderImpl（如果存在）→ 正文不再包含状态栏标签
  // 2. 如果需要状态栏（最新消息+MVU启用），标记为需要独立渲染
  // 3. 正文的 XML 标签位置保持原样，display regex 正常处理正文
  const {
    cleanText: statusCleanText,
    hasPlaceholder: contentHasStatusPlaceholder,
  } = extractStatusPlaceholder(thinkingCleanText);
  let contentForProcessing = statusCleanText;
  // ★ PJ-5：从未剥离的原始内容解析 <ideToolCall> 生成调用折叠卡，前置到正文。
  //   content_for_show 已被后端 _stripAllTags 剥除标签，故读 message.content（原始保留）。
  //   仅 AI/char 消息；卡是单块 <details>（同 code-fold 范式），detectContentType 不会误路由进 iframe。
  if (message.role !== "user") {
    const rawWithTags = resolveMessageSource(message)?.content || message.content || "";
    // [0717 折叠卡补] ppt_op 与 ideToolCall 同批出卡（调用在气泡可见可展开, 执行状态仍由回合末工具卡呈现）
    const toolCards = buildIdeToolCallCards(rawWithTags) + buildPptOpCards(rawWithTags);
    if (toolCards) contentForProcessing = toolCards + "\n\n" + contentForProcessing;
  }
  // ★ K4 [RENDER:*] 渲染相线：char 消息追加 render 阶段世界书条目内容。
  //   这些条目设计为「生成期隐藏、渲染期显示」——已被 GetPrompt(generate) 排除出 LLM 提示词，
  //   此处在渲染期注回，经下方 display 管线（markdown/display-regex/iframe）统一渲染（单一实现）。
  if (message.role === "char") {
    try {
      const _renderCharId = message.timeSlice?.charname || "";
      const _renderCharName = message.name || message.timeSlice?.charname || "";
      const renderBlocks = await fetchRenderEntries(_renderCharId, _renderCharName, renderedChatId);
      if (renderBlocks.length) {
        contentForProcessing =
          contentForProcessing + "\n\n" + renderBlocks.join("\n\n");
      }
    } catch (err) {
      diag.warn("render 条目注入失败", { id: message?.id, err: err?.message });
    }
  }
  // 从插件管理器获取 MVU 真实启用状态，不依赖队列中的 extension 字段
  const mvuEnabled = getPluginEnabled("beilu-mvu");
  // ★ 修复：状态栏应该在每个 char 消息中都注入（不限于最后一层楼）
  // 主人要求每层楼都显示状态栏，展示该楼层的变量快照
  const isCharMessage = message.role === "char";
  // 需要状态栏：正文中已有（被提取出来了），或者满足自动注入条件（char消息+MVU启用）
  const needStatusPlaceholder =
    contentHasStatusPlaceholder || (isCharMessage && mvuEnabled);

  // 对剥离思维链后的正文应用内置处理器（代码折叠等），再应用 display regex
  const builtinProcessed = applyBuiltinProcessors(contentForProcessing);
  // 传入消息角色，用户消息不应用 display regex（防止内容消失）
  const messageRole = message.role || (message.is_user ? "user" : "");
  // P0 修复（问题3）：charName 优先使用 timeSlice.charname（beilu 文件系统 key），
  // 回退到 message.name（显示名）。scoped 正则的 boundCharName 是导入时的文件系统名，
  // 若用显示名匹配会导致 scoped 美化正则被跳过，XML 标签无法渲染。
  const charKeyForRegex = message.timeSlice?.charname || message.name || "";
  // [0807 R1] const→let：displayProcessed 在路由前经 _normalizeFrontendFences 重赋值（单点收口）
  let { text: displayProcessed, placeholders } = applyDisplayRules(
    builtinProcessed,
    { role: messageRole, charName: charKeyForRegex, messageDepth: message.messageDepth || 0 },
  );
  wbTrace("messageList", "renderMessage.displayProcessed", { id: message?.id, role: messageRole, builtinLen: builtinProcessed?.length, displayLen: displayProcessed?.length, placeholderCount: placeholders?.size, needStatus: needStatusPlaceholder });

  // bug3 诊断：记录收口前关键输入，便于定位"渲染成功但捕捉失败"
  diag.log("renderMessage display pipeline input", {
    id: message?.id,
    role: messageRole,
    rawLen: rawContent?.length || 0,
    thinkingCleanLen: thinkingCleanText?.length || 0,
    statusCleanLen: statusCleanText?.length || 0,
    builtinLen: builtinProcessed?.length || 0,
    displayLen: displayProcessed?.length || 0,
    placeholderCount: placeholders?.size || 0,
    rawPreview: rawContent?.substring(0, 200) || "",
    displayPreview: displayProcessed?.substring(0, 200) || "",
  });

  // ★ 渲染深度检查：超出深度的旧消息不做 full-html 渲染
  // ★ 修复：初始渲染时 virtualList 尚未赋值，getQueue() 返回 []，
  //   导致所有消息的 depthIndex=-1, distanceFromEnd=0，全部通过深度检查。
  //   现在使用 renderContext (由 virtualList 传入的 itemIndex + totalCount) 作为回退。
  const renderDepth = getRenderDepth();
  const queueForDepth = getQueue();
  const depthIndex = queueForDepth.findIndex((m) => m.id === message.id);
  let distanceFromEnd;
  if (depthIndex >= 0) {
    // 正常路径：在队列中找到了消息，使用队列位置计算距离末尾的偏移
    distanceFromEnd = queueForDepth.length - 1 - depthIndex;
  } else if (
    renderContext &&
    typeof renderContext.itemIndex === "number" &&
    renderContext.totalCount > 0
  ) {
    // 初始渲染回退路径：virtualList 尚未赋值，用 renderItem 传入的位置信息
    distanceFromEnd = renderContext.totalCount - 1 - renderContext.itemIndex;
  } else {
    // 兜底：无法确定位置时，保守地认为在渲染深度之外（不做 full-html 渲染）
    distanceFromEnd = Infinity;
  }
  const isWithinRenderDepth = renderDepth <= 0 || distanceFromEnd < renderDepth;

  // ★ Phase 2.2：分段检测 + 内容类型决策
  // ★ 渲染深度修复：超出深度的消息，display regex 可能已生成完整 HTML 文档，
  //   不能直接用 renderMarkdownAsString 渲染（markdown 渲染器会吞掉 HTML 标签导致空白）。
  //   超出深度时，跳过 display regex 结果，改用原始文本渲染 markdown。
  // [0807 渲染借鉴 R1] fence 围栏前端块归一化后再路由——重赋值单点收口：下游三消费
  //   （splitMixedContent / detectContentType / markdown 渲染与 full-html iframe 输入）自动一致，
  //   display regex 占位符（placeholders）不受影响（归一化只剥围栏不碰占位符）。
  displayProcessed = _normalizeFrontendFences(displayProcessed);
  const segments = splitMixedContent(displayProcessed);
  let contentType;
  let renderedContent;
  let renderBranch = "unknown";
  const currentRenderMode = getRenderMode();

  if (!isWithinRenderDepth) {
    // ★ 超出渲染深度：不走 full-html / mixed 路径，直接用原始文本（display regex 之前）渲染 markdown
    // depth 范围外的消息不创建 iframe
    contentType = "markdown";
    renderBranch = "depth-skip";
    renderedContent = await renderMarkdownAsString(contentForProcessing, cache);
  } else if (segments) {
    // ★ 混合内容（正文 markdown + 嵌入的 full-html 状态栏）：分段渲染
    contentType = "mixed";
    renderBranch = "mixed";
    diag.debug("splitMixedContent: 检测到混合内容", {
      segmentCount: segments.length,
      types: segments.map((s) => s.type),
    });

    renderedContent = "";
    for (const seg of segments) {
      if (seg.type === "markdown") {
        const md = await renderMarkdownAsString(seg.content, cache);
        const restored =
          placeholders.size > 0 ? restorePlaceholders(md, placeholders) : md;
        renderedContent += `<div class="segment-markdown">${restored}</div>`;
      } else {
        // full-html 段：base64 编码存入 data 属性，后续创建 iframe
        const b64 = btoa(unescape(encodeURIComponent(seg.content)));
        renderedContent += `<div class="segment-iframe" data-segment-html="${b64}"></div>`;
      }
    }
  } else {
    // 原有逻辑：纯 markdown 或纯 full-html
    contentType = detectContentType(displayProcessed);

    // ★ F-D5 XSS：script-fragment（含外来 <script> 的片段）默认不进主页面 activateScripts，
    //   改路由进 iframe 沙箱（与 full-html 同路径）。owner 显式开启脚本激活才走旧主页面路径。
    if (contentType === "script-fragment" && !isScriptActivationAllowed()) {
      contentType = "full-html";
      wbTrace("messageList", "renderMessage.scriptFragmentToIframe", { id: message?.id });
    }

    if (contentType === "full-html") {
      renderBranch = "full-html";
      // full-html 统一用 iframe 渲染（无论 sandbox/free 模式）
      renderedContent =
        '<div class="iframe-placeholder">正在加载美化视图...</div>';
    } else {
      renderBranch = "markdown";
      // 普通 markdown 或脚本片段 → 走原有 markdown 管线
      renderedContent = await renderMarkdownAsString(displayProcessed, cache);
      if (placeholders.size > 0) {
        renderedContent = restorePlaceholders(renderedContent, placeholders);
      }
    }
  }

  wbTrace("messageList", "renderMessage.contentType", { id: message?.id, contentType, branch: renderBranch, withinDepth: isWithinRenderDepth, renderedLen: renderedContent?.length });
  diag.log("renderMessage display pipeline output", {
    id: message?.id,
    role: messageRole,
    renderMode: currentRenderMode,
    withinRenderDepth: isWithinRenderDepth,
    segmentCount: segments?.length || 0,
    contentType,
    branch: renderBranch,
    renderedLen: renderedContent?.length || 0,
    placeholderCount: placeholders?.size || 0,
    renderedPreview: renderedContent?.substring(0, 200) || "",
  });

  // ★ 预计算 media 判断，避免在模板中对 content 做 match（模板引擎会解析 content 中的 ${} 导致卡死）
  // full-html 内容一定包含媒体（iframe），强制为 true 确保气泡获得 w-full 类
  const contentHasMedia =
    contentType === "full-html" ||
    /<(?:video|iframe)\b[^>]*>[\s\S]*?<\/(?:video|iframe)>/gi.test(
      renderedContent,
    );

  // 预处理 avatar：C7 统一契约——经 resolveAvatar 单一权威解析（宏/空串/缺失均显式 fallback）
  // 按 role 选 parts 命名空间 + name，路径解析/兜底逻辑交给 helper。
  let kind = null;
  let partName = null;
  if (message.role === "user") {
    partName = message.timeSlice?.player_id || message.timeSlice?.player;
    kind = partName ? "personas" : null;
  } else if (message.role === "char") {
    // 优先使用 timeSlice.charname（角色卡目录名/key），比 message.name（可能是显示名）更可靠
    partName = message.timeSlice?.charname || message.name;
    kind = partName ? "chars" : null;
  }
  let safeAvatar = resolveAvatar({ avatar: message.avatar, kind, name: partName });
  // char 角色：avatar 空且解析回 DEFAULT_AVATAR 时，再尝试角色卡目录默认 image.png（img onerror 兜底）
  const _rawEmpty =
    !message.avatar ||
    (typeof message.avatar === "string" && /\{\{.*\}\}/.test(message.avatar));
  if (_rawEmpty && message.role === "char" && partName && safeAvatar === DEFAULT_AVATAR) {
    safeAvatar = `/parts/chars:${encodeURIComponent(partName)}/image.png`;
  }
  // 转义双引号，防止注入到模板的 src="${avatar}" 属性时越界
  if (typeof safeAvatar === "string") {
    safeAvatar = safeAvatar.replace(/"/g, '&quot;');
  }

  // ★ 修复：楼层号按对话中的逻辑顺序（0, 1, 2...）显示
  // 虚拟队列是倒序的（最新消息在索引 0），所以需要反转：
  // 队列末尾（最旧消息）= 楼层 0，队列头部（最新消息）= 楼层 queue.length-1
  const queueForFloor = getQueue();
  const floorQueueIndex = queueForFloor.findIndex((m) => m.id === message.id);
  const floorNumber =
    floorQueueIndex >= 0
      ? `#${queueForFloor.length - 1 - floorQueueIndex}`
      : "";

  const preprocessedMessage = {
    ...message,
    avatar: safeAvatar,
    floor: floorNumber,
    time_stamp: new Date(message.time_stamp).toLocaleString(),
    content: "", // ★ 空占位：不通过模板 ${content} 传递，避免模板引擎解析 HTML 中的 ${}
    contentHasMedia, // ★ 预计算的 media 标志，供模板判断 w-full class
  };

  if (message.is_generating) {
    const messageElement = await renderTemplateNoScriptActivation(
      "message_generating_view",
      preprocessedMessage,
    );
    // ★ 任务H: 视觉差异化 — 设置 data-mode 属性
    messageElement.setAttribute(
      "data-mode",
      message.extension?._mode || "chat",
    );
    // ★ 审查#7: 补充 taskTimeline 所需的 data 属性
    messageElement.setAttribute("data-role", message.role || "unknown");
    messageElement.setAttribute(
      "data-message-type",
      message.role === "user" ? "user-request" : "text",
    );
    if (message.time_stamp) {
      messageElement.setAttribute("data-timestamp", message.time_stamp);
    }
    // Add stop button listener
    const stopButton = messageElement.querySelector(".stop-generating-button");
    if (stopButton)
      stopButton.addEventListener("click", () => {
        stopGeneration(message.id);
      });

    const skeleton = messageElement.querySelector(".skeleton-loader");
    const contentEl = messageElement.querySelector(".message-content");
    if (skeleton && contentEl) {
      if (!renderedContent || !renderedContent.trim()) {
        skeleton.classList.remove("hidden");
        contentEl.classList.add("hidden");
      } else {
        skeleton.classList.add("hidden");
        contentEl.classList.remove("hidden");
      }
    }

    // ★ 通过 DOM 注入内容，绕过模板引擎
    if (contentEl && renderedContent) {
      contentEl.innerHTML = renderedContent;
    }

    // ★ 头像 404 回退：图片加载失败时显示默认头像
    _addAvatarFallback(messageElement);

    return messageElement;
  }

  const messageElement = await renderTemplate(
    "message_view",
    preprocessedMessage,
  );
  messageElement._beiluActionIdentity = renderedActionIdentity;
  // ★ 任务H: 视觉差异化 — 设置 data-mode 属性（编程模式消息蓝色指示线）
  messageElement.setAttribute("data-mode", message.extension?._mode || "chat");
  // ★ W73: 子模式角色标签（code/work模式下在消息头部显示当前角色名）
  const _subLabel = message.extension?._subModeLabel;
  // 用户消息没有子模式标签（_subModeLabel由AI回复的replyHandler写入），显示在用户气泡上没有意义
  if (_subLabel && message.role !== "user") {
    const _nameEl = messageElement.querySelector(".message-name, .char-name");
    if (_nameEl) {
      const _tag = document.createElement("span");
      _tag.className = "text-[9px] ml-1 px-1 py-0.5 rounded bg-warning/15 text-warning/80";
      _tag.textContent = _subLabel;
      // after()把标签插在名字后面同一行，prepend()会插到名字前面破坏视觉顺序
      _nameEl.after(_tag);
    }
  }
  // ★ 审查#7: 补充 taskTimeline 所需的 data 属性
  messageElement.setAttribute("data-role", message.role || "unknown");
  messageElement.setAttribute(
    "data-message-type",
    message.role === "user" ? "user-request" : "text",
  );
  if (message.time_stamp) {
    messageElement.setAttribute("data-timestamp", message.time_stamp);
  }
  // ★ 对人类不隐藏：_hidden 对话消息 → 折叠为灰条占位「已隐藏：N 字 · 原因」+ 展开/取消隐藏（T3）。
  //   默认折叠（bhm-collapsed），点展开看原文；灰条本身受 body.beilu-hide-hidden-msgs 全局开关控制显隐。
  //   AI 侧仍由 requestBuilder:97 + proxy 两层过滤不送——本处只动展示层。
  if (message.extension?._hidden) {
    messageElement.classList.add("beilu-hidden-msg", "bhm-collapsed");
    messageElement.setAttribute("data-hidden", "true");
    _attachHiddenBar(messageElement, message, renderedActionIdentity);
  }
  const messageContentElement =
    messageElement.querySelector(".message-content");
  // ★ 通过 DOM 注入内容，绕过模板引擎的 ${} 解析器
  if (messageContentElement && renderedContent) {
    messageContentElement.innerHTML = renderedContent;
  }

  // ★ 注入思维链内容到独立组件
  // [0720 硬化] 折叠块恒渲染：凛倾硬性核心「人类必须看得到」——原 isThinkingFoldEnabled 门控
  //   （关=完全隐藏,人类看不到）违反原则,开关/门控/写点全线已删。
  const thinkingEl = messageElement.querySelector(".thinking-toggle");
  if (thinkingEl && thinkingText) {
    thinkingEl.classList.remove("hidden");
    // 折叠标题文案用户可配置（BEILU_THINKING_FOLD_LABEL 单源，设置入口=API 区块下方）。
    // 只替换文本节点、保留首个 <i>/<svg>，避免打断 data-ic 图标替换；textContent 注入无 XSS 面。
    const labelEl = thinkingEl.querySelector(".thinking-toggle-label");
    if (labelEl) {
      const iconEl = labelEl.querySelector("i,svg");
      labelEl.textContent = "";
      if (iconEl) labelEl.appendChild(iconEl);
      labelEl.appendChild(document.createTextNode(" " + getThinkingFoldLabel()));
    }
    const thinkingContentEl = thinkingEl.querySelector(
      ".thinking-toggle-content",
    );
    if (thinkingContentEl) thinkingContentEl.textContent = thinkingText;
    // [2026-08-10] badge 与真实 AI 可见性一致：beilu_thinking「对 AI 隐藏」关=AI 可见，badge 不许撒谎
    applyThinkingVisibilityBadge(thinkingEl, { hasBeiluThinking, hasOtherReasoning });

    // 绑定折叠/展开事件
    const toggleBtn = thinkingEl.querySelector(".thinking-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const contentDiv = thinkingEl.querySelector(".thinking-toggle-content");
        const iconEl = thinkingEl.querySelector(".thinking-toggle-icon");
        const isHidden = contentDiv.classList.toggle("hidden");
        if (iconEl) iconEl.textContent = isHidden ? "▶" : "▼";
      });
    }
  }
  const messageMarkdownContent = message.content_for_show || message.content;

  // --- 拖放下载功能 ---
  // ★ 延迟生成 standaloneMessage：standalone_message 模板含 ${messageHtml}，
  //   如果消息内容含 ${ 字符，模板引擎会无限循环。改为按需生成，不阻塞消息渲染。
  let standaloneMessageUrl = "";
  let standaloneGenerated = false;

  /**
   * 按需生成 standalone HTML（仅在拖拽/下载/分享时才调用）
   * @returns {Promise<string>} blob URL
   */
  async function ensureStandaloneUrl() {
    if (standaloneGenerated) return standaloneMessageUrl;
    standaloneGenerated = true;
    try {
      const html = await generateFullHtmlForMessage(message, cache);
      standaloneMessageUrl = URL.createObjectURL(
        new Blob([html], { type: "text/html" }),
      );
    } catch (err) {
      console.warn(
        "[messageList] generateFullHtmlForMessage failed:",
        err.message,
      );
      wbDetect("messageList", "ensureStandaloneUrl", false, err?.message, { id: message?.id });
    }
    return standaloneMessageUrl;
  }

  onElementRemoved(messageElement, () => {
    if (standaloneMessageUrl) URL.revokeObjectURL(standaloneMessageUrl);
  });

  messageElement.addEventListener("mousedown", (e) => {
    // If the mousedown is on an interactive part, don't make the message draggable.
    // This allows text selection, button clicks, etc.
    if (e.target.closest(".message-content, textarea"))
      messageElement.draggable = false; // Otherwise, allow dragging the whole message.
    else messageElement.draggable = true;
  });

  /**
   * 清理可拖拽状态以防止意外行为。
   * @returns {void}
   */
  const cleanupDraggable = () => {
    messageElement.draggable = false;
  };
  messageElement.addEventListener("mouseup", cleanupDraggable);
  messageElement.addEventListener("mouseleave", cleanupDraggable);
  messageElement.addEventListener("dragend", cleanupDraggable);

  messageElement.addEventListener("dragstart", async (event) => {
    try {
      const fileName = `message-${message.id}.html`;
      const url = await ensureStandaloneUrl();

      event.dataTransfer.setData("DownloadURL", `text/html:${fileName}:${url}`);
      event.dataTransfer.effectAllowed = "copy";

      event.dataTransfer.setData(
        "text/plain",
        messageContentElement.textContent.trim(),
      );
      event.dataTransfer.setData("text/markdown", message.content);
      event.dataTransfer.setData("text/html", renderedContent);
    } catch (err) {
      console.error('[messageList] dragstart failed:', err);
      wbDetect("messageList", "dragstart", false, err?.message, { id: message?.id });
      window._reportError?.(`[messageList] ${err.message}`, err.stack);
    }
  });

  // --- 删除按钮 ---
  const deleteButtons = messageElement.querySelectorAll(".delete-button");
  deleteButtons.forEach((deleteButton) => {
    deleteButton.addEventListener("click", () => {
      // Count lines in the message content
      const lineCount = messageMarkdownContent.split("\n").length;
      // Skip confirmation for messages with less than 30 lines
      const needsConfirmation = lineCount >= 30;

      if (
        !needsConfirmation ||
        confirmI18n("chat.messageList.confirmDeleteMessage")
      ) {
        deleteButtons.forEach((btn) => (btn.disabled = true));
        enqueueDeletion(messageElement, renderedActionIdentity);
      }
    });
  });

  // --- Shift key detection for button visibility (全局单例) ---
  const buttonGroup = messageElement.querySelector(".button-group");
  const normalButtons = buttonGroup.querySelector(".normal-buttons");
  const shiftButtons = buttonGroup.querySelector(".shift-buttons");

  const _updateShift = (pressed) => {
    if (normalButtons) normalButtons.style.display = pressed ? "none" : "flex";
    if (shiftButtons) shiftButtons.style.display = pressed ? "flex" : "none";
  };
  _shiftCallbacks.add(_updateShift);
  onElementRemoved(messageElement, () => { _shiftCallbacks.delete(_updateShift); });
  _updateShift(_globalShiftPressed);

  // --- Direct Download HTML button (shift mode) ---
  const downloadHtmlButtonDirect = messageElement.querySelector(
    ".download-html-button-direct",
  );
  downloadHtmlButtonDirect.addEventListener("click", async () => {
    try {
      const url = await ensureStandaloneUrl();
      const a = document.createElement("a");
      a.href = url;
      a.download = `message-${message.id}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      wbDetect("messageList", "downloadHtmlDirect", false, error?.message, { id: message?.id });
      showToast("error", error.stack || error.message || error);
    }
  });

  // 获取 dropdown 菜单元素
  const dropdownMenu = messageElement.querySelector(".dropdown");
  messageElement.addEventListener("mouseleave", () =>
    dropdownMenu.hidePopover(),
  );

  // ★ hide/unhide：模板 dropdown 里的 .toggle-hide-button（<li> 嵌套），
  //   走 messages/hide 端点，与 smartClean/contextClean 同一 _hidden 掩码。
  {
    const _toggleHideBtn = dropdownMenu.querySelector(".toggle-hide-button");
    const _hideLabel = _toggleHideBtn?.querySelector(".toggle-hide-label");
    const _hideIcon = _toggleHideBtn?.querySelector("img");
    const _syncHideLabel = () => {
      if (!_hideLabel || !_hideIcon) return;
      const hidden = !!message.extension?._hidden;
      _hideLabel.textContent = hidden ? "恢复显示（重新发送 AI）" : "隐藏（不发送 AI）";
      _hideIcon.src = hidden
        ? "/parts/shells:beilu-chat/icons/mdi__eye-off-outline.svg"
        : "/parts/shells:beilu-chat/icons/mdi__eye-outline.svg";
    };
    _syncHideLabel();
    dropdownMenu.addEventListener("toggle", _syncHideLabel);
    if (_toggleHideBtn) {
      _toggleHideBtn.addEventListener("click", async () => {
        dropdownMenu.hidePopover();
        const _next = !message.extension?._hidden;
        try {
          const { chatId, messageId, indexHint } = renderedActionIdentity;
          if (!isValidChatId(chatId) || !messageId || indexHint < 0) {
            showToast("error", "消息缺少稳定对话/ID/索引身份，未执行隐藏操作。请刷新后重试。");
            return;
          }
          // T6b批7：POST /messages/hide → sendAction shells:chat#hideMessages（chatId 进 URL，body {indices,hide}）。
          //   !ok 门面抛错走 catch；成功返回 body r，仍按 r.success!==false 业务校验。
          const r = await sendAction({ verb: "hideMessages", target: "shells:chat", source: "web", scope: { chatId }, payload: { indices: [indexHint], messageIds: [messageId], hide: _next } });
          if (r.success !== false) {
            if (!message.extension) message.extension = {};
            message.extension._hidden = _next;
            messageElement.classList.toggle("beilu-hidden-msg", _next);
            messageElement.setAttribute("data-hidden", _next ? "true" : "false");
            _syncHideLabel();
            showToast("success", _next ? "已隐藏（不发送给 AI，可恢复）" : "已恢复显示");
          } else {
            showToast("error", "操作失败: " + (r.error || "未知"));
          }
        } catch (e) {
          wbDetect("messageList", "toggleHide", false, e?.message, { id: message?.id });
          showToast("error", "操作失败: " + (e.message || e));
        }
      });
    }
  }

  // 获取 dropdown items
  dropdownMenu
    .querySelector(".copy-markdown-button")
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(messageMarkdownContent);
      } catch (error) {
        wbDetect("messageList", "copyMarkdown", false, error?.message, { id: message?.id });
        showToast("error", error.stack || error.message || error);
      }
      dropdownMenu.hidePopover();
    });
  dropdownMenu
    .querySelector(".copy-text-button")
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(messageMarkdownContent);
      } catch (error) {
        wbDetect("messageList", "copyText", false, error?.message, { id: message?.id });
        showToast("error", error.stack || error.message || error);
      }
      dropdownMenu.hidePopover();
    });
  dropdownMenu
    .querySelector(".copy-html-button")
    .addEventListener("click", async () => {
      try {
        const fullHtml = await generateFullHtmlForMessage(message);
        await navigator.clipboard.writeText(fullHtml);
      } catch (error) {
        wbDetect("messageList", "copyHtml", false, error?.message, { id: message?.id });
        showToast("error", error.stack || error.message || error);
      }
      dropdownMenu.hidePopover();
    });

  // --- Download as HTML button ---
  const downloadHtmlButton = dropdownMenu.querySelector(
    ".download-html-button",
  );
  downloadHtmlButton.addEventListener("click", async () => {
    try {
      const url = await ensureStandaloneUrl();
      const a = document.createElement("a");
      a.href = url;
      a.download = `message-${message.id}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      wbDetect("messageList", "downloadHtml", false, error?.message, { id: message?.id });
      showToast("error", error.stack || error.message || error);
    }
    dropdownMenu.hidePopover();
  });

  // --- Share buttons ---
  const shareButtons = dropdownMenu.querySelectorAll(".share-button");
  shareButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const { time } = button.dataset;
        showToastI18n("info", "chat.messageView.share.uploading");
        const blob = new Blob([await generateFullHtmlForMessage(message)], {
          type: "text/html",
        });
        const link = await createShareLink(
          blob,
          `message-${message.id}.html`,
          time,
        );

        await navigator.clipboard.writeText(link);
        showToastI18n("success", "chat.messageView.share.success", {
          provider: "litterbox.moe",
          sponsorLink: "https://store.catbox.moe/",
        });
      } catch (error) {
        wbDetect("messageList", "shareLink", false, error?.message, { id: message?.id });
        showToast("error", error.stack || error.message || error);
      }
      dropdownMenu.hidePopover();
    });
  });

  // --- 回档按钮 ---
  const rollbackButton = dropdownMenu.querySelector(".rollback-button");
  if (rollbackButton) {
    rollbackButton.addEventListener("click", async () => {
      try {
        dropdownMenu.hidePopover();
        const rollbackChatId = renderedChatId;
        const rollbackAnchorMessageId = message?.id;
        if (!rollbackChatId || typeof rollbackAnchorMessageId !== "string" || !rollbackAnchorMessageId) {
          showToast("error", "消息缺少稳定对话/ID 身份，未执行回档。请刷新后重试。");
          return;
        }
        const queueIndex = getQueueIndex(messageElement);
        if (queueIndex === -1) return;
        const chatLogIndex = getChatLogIndexByQueueIndex(queueIndex);
        if (chatLogIndex === -1) return;

        // [2026-08-01 空消息累计案·断链3] 计数口径改"用户可见"：渲染队列已按 _deleted/隐藏过滤，
        //   旧实现拿裸 chatLog.length 算（含软删尸体）——每回一次档尸体+N，弹窗"将删除之后的 N 条"
        //   越回越大且与所见完全不符（自驱动2"11 条"案）。后端回档语义不变（仍按 chatLogIndex 截断，
        //   顺带清掉不可见尸体，无害）。
        const _queue = getQueue() || [];
        const afterCount = Math.max(0, _queue.length - queueIndex - 1);
        if (afterCount <= 0) {
          showToast("info", "这已经是最新的消息，无需回档");
          return;
        }

        let rollbackPreview;
        try {
          rollbackPreview = await sendAction({
            verb: "getRollbackPreview",
            target: "shells:chat",
            source: "web",
            scope: { chatId: rollbackChatId },
            payload: {
              anchorMessageId: rollbackAnchorMessageId,
              targetIndex: chatLogIndex,
            },
          });
        } catch (previewError) {
          console.error("[messageList] 回档预览请求失败:", previewError);
          wbDetect("messageList", "rollback.preview", false, previewError?.message, { id: message?.id });
          if (previewError?.status === 409) {
            reportRollbackFailure(previewError, {
              fallbackHttpStatus: 409,
              messageId: message?.id,
              node: "rollback.previewConflict",
            });
            return;
          }
          showToast("error", "回档预览失败，未发起回档: " + (previewError?.message || "网络错误"));
          return;
        }
        if (rollbackPreview?.success !== true) {
          const previewError = rollbackPreview?.error || rollbackPreview?.warning || "后端未返回成功预览";
          showToast("error", "回档预览未通过，未发起回档: " + previewError);
          return;
        }
        if (!readMemoryArchiveCoverage(rollbackPreview.memoryArchive)) {
          showToast("warning", "回档预览缺少归档记忆覆盖声明，已停止执行；当前结果范围不确定。");
          return;
        }

        let rollbackPreviewDetail = "\n\n限制：归档记忆文件尚未纳入本次回档。";
        const restoreCount = Array.isArray(rollbackPreview.filesToRestore)
          ? rollbackPreview.filesToRestore.length
          : 0;
        const deleteCount = Array.isArray(rollbackPreview.filesToDelete)
          ? rollbackPreview.filesToDelete.length
          : 0;
        const checkpointCount = Array.isArray(rollbackPreview.checkpointIds)
          ? rollbackPreview.checkpointIds.length
          : 0;
        if (restoreCount || deleteCount || checkpointCount) {
          const effects = [];
          if (restoreCount) effects.push("还原 " + restoreCount + " 个文件");
          if (deleteCount) effects.push("删除 " + deleteCount + " 个 AI 新建文件");
          if (checkpointCount) effects.push("回退 " + checkpointCount + " 个检查点");
          rollbackPreviewDetail += "\n\n文件影响: " + effects.join("、");
          const files = [
            ...(rollbackPreview.filesToRestore || []).map(f => "  ↩ " + (f.relativePath || f.path || f)),
            ...(rollbackPreview.filesToDelete || []).map(f => "  🗑 " + (f.relativePath || f.path || f)),
          ];
          if (files.length <= 10) rollbackPreviewDetail += "\n" + files.join("\n");
          else {
            rollbackPreviewDetail += "\n" + files.slice(0, 8).join("\n") +
              "\n  … 等共 " + files.length + " 个文件";
          }
        }

        if (
          !await beiluConfirm(
            "回档到这条消息？\n将删除之后的 " +
              afterCount +
              " 条消息，此操作不可撤销。" + rollbackPreviewDetail,
          )
        )
          return;

        try {
          // 单一 rollbackToMessage 由后端编排对话/记忆/文件；执行必须带回预览快照，
          // 防止确认期间 IDE 连接或检查点集合变化后仍按旧预览执行。
          const result = await sendAction({
            verb: "rollbackToMessage",
            target: "shells:chat",
            source: "web",
            scope: { chatId: rollbackChatId },
            payload: {
              anchorMessageId: rollbackAnchorMessageId,
              targetIndex: chatLogIndex,
              anchor: rollbackPreview.anchor,
              checkpointIds: rollbackPreview.checkpointIds,
              tableSnapshotId: rollbackPreview.tableSnapshotId,
              expectedIdeConnected: rollbackPreview.expectedIdeConnected,
              expectedIdeRoute: rollbackPreview.expectedIdeRoute,
              expectedCharacterScope: rollbackPreview.expectedCharacterScope,
              characterScopeToken: rollbackPreview.characterScopeToken,
            },
          });
          const rollbackOutcome = formatRollbackOutcome(result);
          const normalizedResult = rollbackOutcome.result;
          // no-op 走独立的服务端确认契约：普通 confirmed 必须保持 false，且任一漂移/未知态
          // 都不能把“没有写入”包装成“已经在目标状态”。
          if (normalizedResult.success === true && normalizedResult.applied === false && normalizedResult.noOp === true) {
            const noOpUnsafe = normalizedResult.noOpConfirmed !== true
              || normalizedResult.partial === true
              || !(normalizedResult.pending === undefined || normalizedResult.pending === false)
              || !(normalizedResult.indeterminate === undefined || normalizedResult.indeterminate === false)
              || !!normalizedResult.drift
              || !!normalizedResult.safetyRollbackError;
            if (noOpUnsafe) {
              reportRollbackFailure({
                ...normalizedResult,
                error: normalizedResult.error || "后端未闭合确认 no-op，不能判定当前已经处于目标状态",
              }, { messageId: message?.id, node: "rollback.noOpUnconfirmed" });
              return;
            }
            if (!readMemoryArchiveCoverage(normalizedResult.memoryArchive)) {
              console.warn("[messageList] 回档 no-op 结果缺少归档记忆覆盖声明:", normalizedResult);
              wbDetect("messageList", "rollback.noOpMemoryArchiveUnknown", false, "memoryArchive coverage missing", { id: message?.id });
              showToast("warning", "当前已经处于目标状态，无需回档；但后端未声明归档记忆覆盖范围，请刷新并人工核对。");
              return;
            }
            showToast("info", "当前已经处于目标状态，无需回档；归档记忆仍未覆盖。");
            return;
          }
          // confirmed 是服务端对已写入最终状态的明确确认；HTTP 2xx/success/applied 均不能代替。
          if (normalizedResult.confirmed !== true) {
            reportRollbackFailure({
              ...normalizedResult,
              error: normalizedResult.error || "后端未返回 confirmed=true，不能确认回档最终状态",
            }, { messageId: message?.id, node: "rollback.unconfirmed" });
            return;
          }
          if (normalizedResult.partial === true || normalizedResult.safetyRollbackError) {
            reportRollbackFailure(normalizedResult, { messageId: message?.id, node: "rollback.partial" });
            return;
          }
          if (normalizedResult.success !== true || normalizedResult.applied !== true) {
            reportRollbackFailure(normalizedResult, { messageId: message?.id, node: "rollback.notApplied" });
            return;
          }
          if (!readMemoryArchiveCoverage(normalizedResult.memoryArchive)) {
            console.warn("[messageList] 回档结果缺少归档记忆覆盖声明:", normalizedResult);
            wbDetect("messageList", "rollback.memoryArchiveUnknown", false, "memoryArchive coverage missing", { id: message?.id });
            showToast("warning", "对话回档已应用，但后端未声明归档记忆覆盖范围；结果不确定，请刷新并人工核对。");
            return;
          }
          const deletedCount = Number.isInteger(normalizedResult.chat?.deletedCount)
            ? `（对话删除 ${normalizedResult.chat.deletedCount} 条）`
            : "";
          if (normalizedResult.chat?.status === "committed_derived_failed") {
            console.warn("[messageList] 回档主提交已应用，但对话派生阶段失败:", normalizedResult);
            wbDetect("messageList", "rollback.chatCommittedDerivedFailed", false, "committed_derived_failed", {
              id: message?.id,
              derived: normalizedResult.chat?.derived,
            });
            showToast("warning", "回档主提交已应用，归档记忆仍未覆盖" + deletedCount + "；但回档后的备份、摘要或同步等至少一项处理失败，恢复/同步能力可能受损，请刷新核对。");
            return;
          }
          showToast("success", "已回档对话及已支持的数据层；归档记忆文件未回档" + deletedCount);
        } catch (err) {
          // 409 保持失败语义，但 apiFetch Error.payload 中的部分应用证据必须完整展示。
          reportRollbackFailure(err, {
            fallbackHttpStatus: Number.isInteger(err?.status) ? err.status : null,
            messageId: message?.id,
            node: "rollback.execute",
          });
        }
      } catch (err) {
        console.error('[messageList] rollback action failed:', err);
        wbDetect("messageList", "rollback.action", false, err?.message, { id: message?.id });
        window._reportError?.(`[messageList] ${err.message}`, err.stack);
      }
    });
  }

  // --- 分叉按钮 ---
  const branchButton = dropdownMenu.querySelector(".branch-button");
  if (branchButton) {
    branchButton.addEventListener("click", async () => {
      try {
        dropdownMenu.hidePopover();
        const { chatId: branchChatId, messageId: branchMessageId, indexHint: chatLogIndex } = renderedActionIdentity;
        if (!isValidChatId(branchChatId) || !branchMessageId || chatLogIndex < 0) {
          showToast("error", "消息缺少稳定对话/ID/索引身份，未执行分叉。请刷新后重试。");
          return;
        }

        if (!await beiluConfirm(
          "从此分叉\n\n将从这条消息创建一个新的对话分支，包含此消息及之前的所有消息。\n原对话不受影响。"
        )) return;

        // T6b批7：POST /branch → sendAction shells:chat#branch。!ok 门面抛错走 catch（分叉失败 toast）；成功但无 chatid 仍走 !result.chatid 判定。
        const result = await sendAction({ verb: "branch", target: "shells:chat", source: "web", payload: { chatid: branchChatId, messageId: branchMessageId, messageIndex: chatLogIndex } });
        if (!result.chatid) {
          showToast("error", "分叉失败: " + (result.error || "未知错误"));
          return;
        }
        showToast("success", "已创建分支对话");
        // 切换到新分支对话
        const { switchToChat } = await import("../chat-core/conversationManager.mjs");
        await switchToChat(result.chatid);
      } catch (err) {
        console.error("[messageList] branch action failed:", err);
        wbDetect("messageList", "branch.action", false, err?.message, { id: message?.id });
        showToast("error", "分叉失败: " + (err.message || "未知错误"));
      }
    });
  }

  // --- 编辑按钮 ---
  const editButton = messageElement.querySelector(".edit-button");
  editButton.addEventListener("click", async () => {
    try {
      const queueIndex = getQueueIndex(messageElement, renderedChatId);
      if (queueIndex === -1) return;
      await editMessageStart(message, queueIndex, renderedActionIdentity); // 显示编辑界面
    } catch (err) {
      console.error('[messageList] edit action failed:', err);
      wbDetect("messageList", "editAction", false, err?.message, { id: message?.id });
      window._reportError?.(`[messageList] ${err.message}`, err.stack);
    }
  });

  // --- iframe 渲染 ---
  // ★ FT4 §1.4：进入 iframe 渲染分支前移除既有渲染产物（防重复 iframe 护栏），
  //   避免重复渲染叠加多个 iframe/状态栏容器。
  if (contentType === "full-html" || contentType === "mixed") {
    clearExistingRenderArtifacts(messageElement);
  }
  if (contentType === "full-html") {
    // ★ Phase 1.2：纯 full-html（如 <game_text> 整块替换），注入 MVU 变量
    wbTrace("messageList", "renderMessage.iframeFullHtml", { id: message?.id });
    const mvuVars = getMvuVariablesForRendering(message);
    await renderAsIframe(displayProcessed, messageElement, rawContent, {
      mvuVariables: mvuVars,
    });
  }

  // ★ Phase 2.2：mixed 类型 — 为每个 iframe 段创建独立 iframe
  if (contentType === "mixed") {
    const mvuVars = getMvuVariablesForRendering(message);
    const slots = messageElement.querySelectorAll(".segment-iframe");
    wbTrace("messageList", "renderMessage.iframeMixed", { id: message?.id, slotCount: slots.length });
    for (const slot of slots) {
      const b64 = slot.dataset.segmentHtml;
      if (!b64) continue;
      let segmentHtml;
      try {
        segmentHtml = decodeURIComponent(escape(atob(b64)));
      } catch (e) {
        diag.warn("segment-iframe base64 解码失败:", e);
        wbDetect("messageList", "segmentBase64Decode", false, e?.message, { id: message?.id });
        continue;
      }

      // 创建 iframe 容器替换占位 div
      const container = document.createElement("div");
      container.className = "segment-iframe-container";
      const wrapper = document.createElement("div");
      wrapper.id = `${message.id}-iframe-${Math.random().toString(36).slice(2, 8)}`;
      // 这里只是 iframe host，不是消息根节点。若复用 .chat-message，
      // 外层“头像 + 正文”grid 会让富前端卡片误入 50px 头像列。
      wrapper.className = "segment-iframe-host";
      const contentDiv = document.createElement("div");
      contentDiv.className = "message-content";
      contentDiv.innerHTML =
        '<div class="iframe-placeholder">正在加载状态栏...</div>';
      wrapper.appendChild(contentDiv);
      container.appendChild(wrapper);

      slot.replaceWith(container);

      // ★ FT4 入口契约（§1.1）：renderAsIframe(html, hostEl, rawContent, {mvuVariables})。
      //   rawContent 必须传该消息原始文本（供 earlyScript 构造 _stChat[0].mes/swipes，
      //   让 iframe 内 getAllVariables()/getChatMessages() 能读到 message-scope 上下文）。
      //   mixed 段每个状态栏 iframe 同属一条消息，应共享同一原文上下文，故传 rawContent 而非 ""。
      await renderAsIframe(segmentHtml, wrapper, rawContent, {
        mvuVariables: mvuVars,
      });
    }
  }

  // --- 激活 display regex 注入的脚本（非 full-html / mixed 模式） ---
  if (
    contentType !== "full-html" &&
    contentType !== "mixed" &&
    displayProcessed !== rawContent
  ) {
    // display regex 做了替换，可能注入了 <script> 标签
    const messageContentElement2 =
      messageElement.querySelector(".message-content");
    if (messageContentElement2) {
      await activateScriptsInElement(messageContentElement2);
    }
  }

  // --- 渲染附件 ---
  if (message.files?.length) {
    const attachmentsContainer = messageElement.querySelector(".attachments");
    if (attachmentsContainer) {
      if (message.files.length === 1)
        attachmentsContainer.classList.add("is-single-attachment");

      attachmentsContainer.innerHTML = "";
      const attachmentPromises = message.files.map((file, index) =>
        renderAttachmentPreview(file, index, null),
      );
      const renderedAttachments = await Promise.all(attachmentPromises);
      renderedAttachments.forEach((attachmentElement) => {
        if (attachmentElement)
          attachmentsContainer.appendChild(attachmentElement);
      });
    }
  }

  // ★ 头像 404 回退：图片加载失败时显示默认头像
  _addAvatarFallback(messageElement);

  // ★ P0-2修复：状态栏作为独立DOM容器追加，不污染正文XML标签顺序
  // ★ 渲染深度守卫：超出渲染深度的消息不渲染状态栏 iframe，避免设定深度=1却渲染多层
  if (needStatusPlaceholder && isWithinRenderDepth) {
    // ★ FT4 §1.4：状态栏走 insertBefore 新增兄弟容器，重复渲染会叠加多个
    //   .mvu-status-container。此处仅移除既有状态栏容器（不动正文 iframe，因后者由
    //   上方 §1.4 入口护栏在 full-html/mixed 分支已统一处理），防重复叠加。
    messageElement
      .querySelectorAll(".mvu-status-container")
      .forEach((node) => node.remove());
    await _renderStatusPlaceholderSeparately(
      message,
      messageElement,
      messageRole,
      charKeyForRegex,
    );
  }

  // ★ 全智能临时任务卡片 + 跨模式通知（W17+W18）+ T6 记忆运用溯源
  if (message.extension) {
    handleTaskOverlayExtension(messageElement, message.extension);
    handleCrossModeNotification(message.extension);
    handleRecalledMemory(messageElement, message.extension);
    _appendIdeToolCallCards(messageElement, message.extension);
    // O16: AI 文件投递卡片
    _appendFileDeliveryCard(messageElement, message.extension, renderedChatId);
    // O18: AI 任务计划卡片
    _appendTaskPlanCard(messageElement, message.extension);
    // O18: 分身执行结果卡片
    _appendCloneResultsCard(messageElement, message.extension);
    // 0717: 联网搜索结果卡片（对标 claude 官方搜索卡）
    _appendWebSearchCard(messageElement, message.extension);
  }

  return messageElement;
}

// B4 inline工具卡（调用侧）：AI 回复里的 <ideToolCall> 对 AI/正文都剥，用户从 extension.ideToolCalls
// 看到"这轮调了什么工具+对象"（G8 对 AI 删对用户折叠）。结果在下一条 ide_tool_result 折叠卡里。
function _appendIdeToolCallCards(messageElement, extension) {
  const calls = extension?.ideToolCalls;
  if (extension?._opType !== "ide_tool_call" || !Array.isArray(calls) || calls.length === 0) return;
  if (messageElement.querySelector(".ide-tool-call-strip")) return;
  const strip = document.createElement("div");
  strip.className = "ide-tool-call-strip";
  strip.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;font-size:0.68rem;opacity:0.85;";
  for (const c of calls) {
    const chip = document.createElement("span");
    chip.style.cssText = "display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:9px;border:1px solid oklch(var(--bc, 0.8 0 0) / 0.2);background:oklch(var(--b2, 0.18 0 0) / 0.6);";
    chip.textContent = `🛠 ${c?.tool || "?"}${c?.subject ? " " + c.subject : ""}`;
    chip.title = `IDE 工具调用：${c?.tool || "?"}${c?.subject ? "\n" + c.subject : ""}\n结果见下方「工具结果」折叠卡`;
    strip.appendChild(chip);
  }
  messageElement.appendChild(strip);
}

// O16: AI 文件投递卡片 — extension._fileDelivery 存在时，在消息底部追加可下载文件卡片。
// 样式复用 ide-tool-result-card 的视觉范式（紫色边框折叠卡），下载链接指向后端 file-delivery 端点。
function _appendFileDeliveryCard(messageElement, extension, renderedChatId) {
  const fd = extension?._fileDelivery;
  if (!fd?.path) return;
  // 防重复：同一 messageElement 不重复追加
  if (messageElement.querySelector(".file-delivery-card")) return;

  const name = fd.name || fd.path.split(/[/\\]/).pop() || "文件";
  const desc = fd.description || "";
  if (!isValidChatId(renderedChatId)) return;
  const downloadUrl = `/api/parts/shells:chat/file-delivery/${encodeURIComponent(renderedChatId)}?path=${encodeURIComponent(fd.path)}&name=${encodeURIComponent(name)}`;

  const card = document.createElement("div");
  card.className = "file-delivery-card";
  card.innerHTML =
    `<div class="file-delivery-inner">` +
    `<span class="file-delivery-icon"><i data-ic="paperclip"></i></span>` +
    `<div class="file-delivery-info">` +
    `<a class="file-delivery-name" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(name)}" title="点击下载">${escapeHtml(name)}</a>` +
    (desc ? `<span class="file-delivery-desc">${escapeHtml(desc)}</span>` : "") +
    `</div>` +
    `</div>`;
  messageElement.appendChild(card);
}

// O18: AI 任务计划卡片 — extension._taskPlan 存在时，在消息底部追加任务概要卡片。
// 后端 replyHandler.mjs:680 写 { count, remaining, rev }。
// 样式绿色调，与 fileDelivery(蓝色) / ide(紫色) 区分。
function _appendTaskPlanCard(messageElement, extension) {
  const tp = extension?._taskPlan;
  if (!tp) return;
  // 防重复
  if (messageElement.querySelector(".task-plan-card")) return;

  const card = document.createElement("div");
  card.className = "task-plan-card";
  card.style.cssText = "margin-top:6px;padding:8px 12px;border-radius:8px;border:1px solid oklch(var(--color-success) / 0.4);background:oklch(var(--color-base-300) / 0.5);font-size:0.82rem;";

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:600;color:oklch(var(--color-success));";
  header.innerHTML = `<i data-ic="clipboard"></i> 任务计划已更新`;
  card.appendChild(header);

  const info = document.createElement("div");
  info.style.cssText = "margin-top:4px;color:oklch(var(--color-success) / 0.7);font-size:0.78rem;";
  info.textContent = `共 ${tp.count} 项任务，剩余 ${tp.remaining} 项未完成`;
  card.appendChild(info);

  messageElement.appendChild(card);
}

// O18: 分身执行结果卡片 — extension._cloneResults 数组存在时，在消息底部追加分身结果摘要卡片。
// 后端 replyHandler.mjs:3066 写 [{ id, label, status, stopReason, resumable, preview }]。
// 样式橙色调，每条分身结果独立显示，preview 可折叠。
function _appendCloneResultsCard(messageElement, extension) {
  const results = extension?._cloneResults;
  if (!Array.isArray(results) || results.length === 0) return;
  // 防重复
  if (messageElement.querySelector(".clone-results-card")) return;

  const card = document.createElement("div");
  card.className = "clone-results-card";
  card.style.cssText = "margin-top:6px;padding:8px 12px;border-radius:8px;border:1px solid oklch(var(--color-warning) / 0.4);background:oklch(var(--color-base-300) / 0.5);font-size:0.82rem;";

  const okCount = results.filter(r => r.status !== "error").length;
  const errCount = results.length - okCount;

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:600;color:oklch(var(--color-warning));";
  header.innerHTML = `<i data-ic="shuffle"></i> 分身执行结果 (${results.length}项${errCount ? `, ${errCount}项失败` : ""})`;
  card.appendChild(header);

  for (const r of results) {
    const item = document.createElement("details");
    item.style.cssText = "margin-top:4px;padding:4px 0;border-top:1px solid oklch(var(--color-base-content) / 0.15);";

    const statusIcon = r.status === "error" ? '<i data-ic="cross"></i>' : r.resumable ? '<i data-ic="pause"></i>' : '<i data-ic="check"></i>';
    const statusText = r.status === "error" ? "失败" : r.resumable ? "中断" : "完成";

    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;color:oklch(var(--color-warning) / 0.7);font-size:0.78rem;list-style:none;display:flex;align-items:center;gap:4px;";
    summary.innerHTML = `<span>${statusIcon}</span> <span style="font-weight:500;">#${escapeHtml(String(r.id))}</span> <span>${escapeHtml(r.label || "")}</span> <span style="opacity:0.7;">[${statusText}]</span>`;
    item.appendChild(summary);

    if (r.preview) {
      const preview = document.createElement("div");
      preview.style.cssText = "margin-top:2px;padding:4px 8px;font-size:0.74rem;color:oklch(var(--color-base-content) / 0.7);white-space:pre-wrap;word-break:break-all;";
      preview.textContent = r.preview;
      item.appendChild(preview);
    }

    card.appendChild(item);
  }

  messageElement.appendChild(card);
}

// [0717] 联网搜索结果卡片 — extension._webSearchEvents 存在时，在消息底部追加搜索卡
// （对标 claude 官方搜索卡：查询词 + N 条结果 + 条目列表 title 左/域名右、链接可点、折叠）。
// producer：memory replyHandler 3b（<needWebSearch>）/ beilu-web ReplyHandler（<search>），
// 写 [{ query, engine?, count, error?, results:[{title,url,domain}] }]。信息蓝调，与
// fileDelivery(蓝)/taskPlan(绿)/clone(橙)/ide(紫) 卡片家族区分。
function _appendWebSearchCard(messageElement, extension) {
  const events = extension?._webSearchEvents;
  if (!Array.isArray(events) || events.length === 0) return;
  // 防重复：同一 messageElement 不重复追加
  if (messageElement.querySelector(".web-search-card")) return;

  const card = document.createElement("div");
  card.className = "web-search-card";
  card.style.cssText = "margin-top:6px;padding:8px 12px;border-radius:8px;border:1px solid oklch(var(--color-info) / 0.4);background:oklch(var(--color-base-300) / 0.5);font-size:0.82rem;";

  for (const ev of events) {
    const item = document.createElement("details");
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;display:flex;align-items:center;gap:6px;font-weight:600;color:oklch(var(--color-info));list-style:none;";
    const _status = ev.error ? "失败" : `${ev.count ?? (ev.results || []).length} 条结果`;
    summary.innerHTML = `<i data-ic="earth"></i> <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ev.query || "")}</span> <span style="flex:none;opacity:0.6;font-weight:400;font-size:0.76rem;">${escapeHtml(_status)}${ev.engine ? ` · ${escapeHtml(ev.engine)}` : ""}</span>`;
    item.appendChild(summary);

    if (ev.error) {
      const err = document.createElement("div");
      err.style.cssText = "margin-top:4px;padding:2px 8px;font-size:0.76rem;color:oklch(var(--color-error) / 0.8);white-space:pre-wrap;word-break:break-all;";
      err.textContent = ev.error;
      item.appendChild(err);
    }
    for (const r of (ev.results || [])) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:3px;padding:3px 8px;border-top:1px solid oklch(var(--color-base-content) / 0.08);";
      const a = document.createElement("a");
      a.href = r.url || "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.78rem;color:oklch(var(--color-base-content) / 0.9);text-decoration:none;";
      a.textContent = r.title || r.url || "";
      a.title = r.url || "";
      const dom = document.createElement("span");
      dom.style.cssText = "flex:none;font-size:0.72rem;color:oklch(var(--color-base-content) / 0.45);";
      dom.textContent = r.domain || "";
      row.appendChild(a);
      row.appendChild(dom);
      item.appendChild(row);
    }
    card.appendChild(item);
  }
  messageElement.appendChild(card);
}

/**
 * P0-2修复：将StatusPlaceHolderImpl作为独立DOM容器渲染到消息元素中，
 * 而不是拼接到正文字符串末尾。这样正文中的XML标签位置保持原样。
 * @param {object} message - 消息对象
 * @param {HTMLElement} messageElement - 消息DOM元素
 * @param {string} messageRole - 消息角色
 * @param {string} charKeyForRegex - 角色名（用于display regex匹配）
 */
async function _renderStatusPlaceholderSeparately(
  message,
  messageElement,
  messageRole,
  charKeyForRegex,
) {
  try {
    const statusText = "<StatusPlaceHolderImpl/>";
    const { text: statusProcessed, placeholders: statusPlaceholders } =
      applyDisplayRules(statusText, {
        role: messageRole,
        charName: charKeyForRegex,
      });

    // 如果display regex没有替换StatusPlaceHolderImpl，跳过渲染
    if (statusProcessed.trim() === statusText) {
      diag.debug(
        "P0-2: StatusPlaceHolderImpl未被display regex替换，跳过独立渲染",
      );
      return;
    }

    const statusType = detectContentType(statusProcessed);
    const statusContainer = document.createElement("div");
    statusContainer.className = "mvu-status-container";

    const messageContentEl = messageElement.querySelector(".message-content");
    if (!messageContentEl) return;

    if (statusType === "full-html") {
      const mvuVars = getMvuVariablesForRendering(message);
      const rawMessageText = message.content_for_show || message.content || "";
      const wrapper = document.createElement("div");
      // 状态栏是当前消息右列中的子卡片，不能再次套消息根布局。
      wrapper.className = "mvu-status-wrapper";
      const contentDiv = document.createElement("div");
      contentDiv.className = "message-content";
      wrapper.appendChild(contentDiv);
      statusContainer.appendChild(wrapper);
      messageContentEl.parentNode.insertBefore(
        statusContainer,
        messageContentEl.nextSibling,
      );
      await renderAsIframe(statusProcessed, wrapper, rawMessageText, {
        mvuVariables: mvuVars,
      });
    } else {
      // 状态栏是普通HTML片段
      let statusHtml = await renderMarkdownAsString(statusProcessed, {});
      if (statusPlaceholders.size > 0) {
        statusHtml = restorePlaceholders(statusHtml, statusPlaceholders);
      }
      statusContainer.innerHTML = statusHtml;
      messageContentEl.parentNode.insertBefore(
        statusContainer,
        messageContentEl.nextSibling,
      );
    }

    diag.debug("P0-2: 状态栏已作为独立DOM容器渲染");
  } catch (err) {
    wbDetect("messageList", "_renderStatusPlaceholderSeparately", false, err?.message, { id: message?.id });
    diag.warn("_renderStatusPlaceholderSeparately 失败:", err);
  }
}

/**
 * 为消息元素中的头像图片添加加载失败回退 + 点击悬浮预览
 * 当角色卡被删除或没有照片时，显示默认头像图标
 * @param {HTMLElement} el - 消息 DOM 元素
 */
function _addAvatarFallback(el) {
  // 只绑定标准消息根的直属头像；记忆列表和角色卡正文也可能复用
  // .message-avatar 类，不能让它们被误认为聊天头像。
  const avatars = el.querySelectorAll(":scope > .message-avatar");
  for (const avatar of avatars) {
    const img = avatar.querySelector("img");
    if (!img) continue;

    if (img.dataset.fallbackBound) continue;
    img.dataset.fallbackBound = "1";
    img.addEventListener("error", () => {
      if (img.src !== DEFAULT_AVATAR) {
        img.src = DEFAULT_AVATAR;
      }
    });

    const needsKeyboardPolyfill = avatar.tagName !== "BUTTON";
    if (needsKeyboardPolyfill) {
      avatar.setAttribute("role", "button");
      if (!avatar.hasAttribute("tabindex")) avatar.tabIndex = 0;
    }
    if (!avatar.getAttribute("aria-label")) {
      avatar.setAttribute("aria-label", `放大 ${img.alt || "消息"} 的头像`);
    }
    if (!avatar.getAttribute("title")) {
      avatar.title = `点击放大 ${img.alt || "消息"} 的头像`;
    }

    const openPreview = () => _showAvatarFloatingPreview(img);
    avatar.addEventListener("click", openPreview);
    if (needsKeyboardPolyfill) {
      avatar.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openPreview();
      });
    }
  }
}

// ============================================================
// C2-chat: 头像悬浮放大预览（非阻塞、可拖动、×/Esc 关闭）
// ============================================================

/** 悬浮预览 DOM 元素（全局单例，点击不同头像时替换图片） */
let _avatarPreviewEl = null;

/**
 * 打开头像悬浮预览。同一头像再次点击会关闭；切换头像时替换单例。
 * @param {HTMLImageElement} sourceImage
 */
function _showAvatarFloatingPreview(sourceImage) {
  const src = sourceImage?.currentSrc || sourceImage?.src || "";
  if (!src) return;

  if (_avatarPreviewEl?.dataset.avatarSrc === src) {
    _closeAvatarPreview();
    return;
  }
  _closeAvatarPreview();

  const preview = document.createElement("section");
  preview.className = "message-avatar-preview";
  preview.dataset.avatarSrc = src;
  preview.setAttribute("role", "dialog");
  preview.setAttribute("aria-label", `${sourceImage.alt || "消息"} 的头像预览`);

  const bar = document.createElement("div");
  bar.className = "message-avatar-preview__bar";

  const title = document.createElement("span");
  title.className = "message-avatar-preview__title";
  title.textContent = sourceImage.alt || "头像预览";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "message-avatar-preview__close";
  closeButton.textContent = "×";
  closeButton.title = "关闭头像预览";
  closeButton.setAttribute("aria-label", "关闭头像预览");
  closeButton.addEventListener("click", _closeAvatarPreview);

  const image = document.createElement("img");
  image.className = "message-avatar-preview__image";
  image.src = src;
  image.alt = sourceImage.alt || "头像预览";
  image.draggable = false;

  bar.append(title, closeButton);
  preview.append(bar, image);
  document.body.appendChild(preview);
  _avatarPreviewEl = preview;

  let dragging = false;
  let startPointerX = 0;
  let startPointerY = 0;
  let startLeft = 0;
  let startTop = 0;

  const stopDragging = () => {
    dragging = false;
    bar.classList.remove("dragging");
  };
  const onPointerMove = (event) => {
    if (!dragging) return;
    const maxLeft = Math.max(0, window.innerWidth - preview.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - preview.offsetHeight);
    const nextLeft = Math.min(
      maxLeft,
      Math.max(0, startLeft + event.clientX - startPointerX),
    );
    const nextTop = Math.min(
      maxTop,
      Math.max(0, startTop + event.clientY - startPointerY),
    );
    preview.style.left = `${nextLeft}px`;
    preview.style.top = `${nextTop}px`;
    preview.style.right = "auto";
    preview.style.bottom = "auto";
  };
  const onPointerUp = () => stopDragging();
  const onKeyDown = (event) => {
    if (event.key === "Escape") _closeAvatarPreview();
  };

  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const rect = preview.getBoundingClientRect();
    dragging = true;
    startPointerX = event.clientX;
    startPointerY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    bar.classList.add("dragging");
    event.preventDefault();
  });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);

  preview._cleanupDrag = () => {
    stopDragging();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
  };
}

/**
 * 关闭头像悬浮预览并清理全局拖动/键盘监听。
 */
function _closeAvatarPreview() {
  if (_avatarPreviewEl) {
    if (_avatarPreviewEl._cleanupDrag) _avatarPreviewEl._cleanupDrag();
    if (document.body.contains(_avatarPreviewEl)) {
      document.body.removeChild(_avatarPreviewEl);
    }
    _avatarPreviewEl = null;
  }
}

/**
 * 开始编辑指定消息。
 * @param {object} message - 原始消息。
 * @param {number} queueIndex - 在队列中的索引。
 * @param {Readonly<{chatId:string,messageId:string,indexHint:number}>} actionIdentity - 渲染时冻结的消息身份。
 */
export async function editMessageStart(message, queueIndex, actionIdentity) {
  const { chatId, messageId, indexHint } = actionIdentity || {};
  if (!isValidChatId(chatId) || typeof messageId !== "string" || !messageId
    || !Number.isInteger(indexHint) || indexHint < 0 || messageId !== message?.id) {
    throw new Error("消息缺少稳定对话/ID/索引身份，未进入编辑；请刷新后重试。");
  }
  const originalFiles = Array.isArray(message.files) ? message.files : [];
  const selectedFiles = [...originalFiles]; // 文件副本；未改时请求省略 files 以保留后端真值
  const editRawContent = resolveEditMessageContent(message);
  const editRenderedMessage = {
    ...message,
    avatar: message.avatar || DEFAULT_AVATAR,
    time_stamp: new Date(message.time_stamp).toLocaleString(),
    content_for_edit: "", // 通过 DOM 注入 textarea.value，避免模板引擎二次解析原文
  };

  const messageElement = getMessageElementByQueueIndex(queueIndex, chatId);
  if (!messageElement) return;
  if (!beginAuthoritativeEdit(chatId, messageId)) {
    throw new Error("原窗口中已找不到要编辑的消息，请刷新后重试。");
  }
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    await endAuthoritativeEdit(chatId, messageId, { applyPending: true });
    throw new Error("当前浏览器不支持安全的编辑操作标识，请升级浏览器后重试。");
  }
  // 同一编辑框生命周期始终复用同一 operationId。未知网络结果后再次点击不会变成第二次编辑；
  // 若用户改了正文，服务端会在旧操作已提交时用 payload 指纹拒绝漂移。
  const editOperationId = globalThis.crypto.randomUUID();
  let editSessionOpen = true;

  // 平滑过渡：淡出
  messageElement.style.transition = `opacity ${TRANSITION_DURATION / 1000}s ease-in-out`;
  messageElement.style.opacity = "0";
  await new Promise((resolve) => setTimeout(resolve, TRANSITION_DURATION));

  // [0723 失败恢复] 淡出之后的任何失败(模板 fetch 401/元素缺失)原先直接抛出→消息永久停在
  //   opacity:0=占位不可见的"大片空白"+内容消失(002 0723 实证,errors 日志 message_edit_view 401)。
  //   现失败时恢复原消息视图再抛,由调用方 catch 上报;恢复兜底=至少把 opacity 还原(此时若模板
  //   渲染未执行,innerHTML 仍是原内容,还原透明度即还原视图)。
  try {

  // 渲染编辑视图并替换
  const editViewHtml = await renderTemplateAsHtmlString(
    "message_edit_view",
    editRenderedMessage,
  );
  messageElement.innerHTML = editViewHtml;
  _addAvatarFallback(messageElement);

  // 获取编辑视图元素
  const fileEditInput = messageElement.querySelector(
    `#file-edit-input-${message.id}`,
  );
  const attachmentPreview = messageElement.querySelector(
    `#attachment-edit-preview-${message.id}`,
  );
  const editInput = messageElement.querySelector(`#edit-input-${message.id}`);
  if (editInput) {
    editInput.value = editRawContent;
  }
  const confirmButton = messageElement.querySelector(
    `#confirm-button-${message.id}`,
  );
  const cancelButton = messageElement.querySelector(
    `#cancel-button-${message.id}`,
  );
  const uploadButton = messageElement.querySelector(
    `#upload-edit-button-${message.id}`,
  );

  // 添加拖拽上传支持
  addDragAndDropSupport(editInput, selectedFiles, attachmentPreview);

  // keyboard shortcuts for editing
  editInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault(); // Prevent newline
      event.stopPropagation(); // Prevent bubbling
      confirmButton.click();
    } else if (event.key === "Escape") {
      event.preventDefault(); // Prevent default action
      event.stopPropagation(); // Prevent bubbling
      cancelButton.click();
    }
  });

  // --- 确认编辑 ---
  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    try {
      const editedContent = editInput.value;
      const editPatch = {
        content: editedContent,
        // 编辑正文后旧渲染产物不能沿用。空串是有效权威显示值，不用 || 改写其语义。
        content_for_show: editedContent,
        content_for_edit: editedContent,
      };
      // 附件未动：省略 files，由后端保留 oldEntry.files；删到空：显式发 []。
      // 只用对象身份判定即可：旧附件只会从副本数组删除，新附件则是新对象。
      const attachmentsChanged = selectedFiles.length !== originalFiles.length
        || selectedFiles.some((file, index) => file !== originalFiles[index]);
      if (attachmentsChanged) editPatch.files = selectedFiles;
      const result = await editMessage(
        chatId,
        indexHint,
        messageId,
        editPatch,
        editOperationId,
      );
      if (result?.applied !== true || result?.chatCommitted !== true) {
        const detail = result?.reason || result?.error || "后端未提交编辑";
        throw new Error(detail);
      }
      if (!result.entry || result.entry.id !== messageId) {
        // 主提交已发生，不能把它当失败重新开放保存（会诱发重复编辑）；也不能用本地输入冒充真值。
        const pendingResult = await endAuthoritativeEdit(chatId, messageId, { applyPending: true });
        editSessionOpen = false;
        if (pendingResult?.applied !== true) await rerenderMessageForChat(chatId, messageId);
        showToast("warning", result.warning || "消息已编辑，但后端未返回匹配的权威条目；请刷新对话核对。");
        return;
      }
      // HTTP ack 与编辑期 WS 回显共用同一个 chatId+messageId+版本门；
      // 两者乱序时先应用较新版本，旧 ack/回声不得覆盖。
      try {
        const ackApply = await applyAuthoritativeEdit(chatId, result.entry, {
          deferWhileEditing: false,
          source: "http_ack",
          editOperationId: result.editOperationId || editOperationId,
          payloadFingerprint: result.payloadFingerprint,
        });
        const pendingApply = await endAuthoritativeEdit(chatId, messageId, { applyPending: true });
        editSessionOpen = false;
        if (ackApply.applied !== true && ackApply.stale !== true
          && pendingApply?.applied !== true) {
          showToast("warning", "消息已编辑，但原窗口未能应用权威版本；请刷新该对话核对。");
        }
      } catch (applyError) {
        // 此时后端主提交已成功，渲染/队列回填失败不得重新开放保存造成二次编辑。
        try { await endAuthoritativeEdit(chatId, messageId, { applyPending: true }); } catch { /* 下方明示要求刷新 */ }
        editSessionOpen = false;
        console.error("[messageList] 编辑已提交但权威回填失败:", applyError);
        showToast("warning", "消息已编辑，但界面回填失败；请刷新原对话核对。");
        return;
      }
      if (result.status === "committed_derived_failed") {
        console.warn("[messageList] 消息编辑已提交，但派生阶段失败:", result);
        wbDetect("messageList", "edit.committedDerivedFailed", false, "committed_derived_failed", {
          messageId,
          derived: result?.derived,
        });
        showToast("warning", result.warning || "消息已编辑，但同步或广播至少一项失败；请刷新核对。");
      }
    } catch (err) {
      try {
        const wsReceipt = await consumePendingAuthoritativeEdit(
          chatId,
          messageId,
          editOperationId,
        );
        if (wsReceipt?.applied === true) {
          editSessionOpen = false;
          showToast("warning", "HTTP 回执丢失，但已通过同一编辑操作的权威同步确认提交。");
          return;
        }
      } catch (wsReceiptError) {
        console.warn("[messageList] 编辑失败后消费权威 WS 回执失败:", wsReceiptError);
      }
      console.error("[messageList] editMessage failed:", err);
      wbDetect("messageList", "confirmEdit", false, err?.message, { messageId, indexHint });
      showToast("error", err.error || err.reason || err.message || "编辑失败，请重试");
      confirmButton.disabled = false;
    }
  });

  // --- 取消编辑 ---
  cancelButton.addEventListener("click", async () => {
    try {
      const pendingResult = await endAuthoritativeEdit(chatId, messageId, { applyPending: true });
      editSessionOpen = false;
      if (pendingResult?.applied !== true) await rerenderMessageForChat(chatId, messageId);
    } catch (err) {
      console.error('[messageList] cancel edit failed:', err);
      wbDetect("messageList", "cancelEdit", false, err?.message, { queueIndex });
      window._reportError?.(`[messageList] ${err.message}`, err.stack);
    }
  });

  // --- 渲染编辑状态的附件 ---
  attachmentPreview.innerHTML = "";
  const attachmentPromises = selectedFiles.map(
    (file, i) => renderAttachmentPreview(file, i, selectedFiles), // 传入 selectedFiles 以支持删除
  );
  const renderedAttachments = await Promise.all(attachmentPromises);
  renderedAttachments.forEach((el) => {
    if (el) attachmentPreview.appendChild(el);
  });

  // --- 编辑状态上传按钮 ---
  uploadButton.addEventListener("click", () => fileEditInput.click());

  // --- 文件选择处理 ---
  fileEditInput.addEventListener(
    "change",
    (event) => handleFilesSelect(event, selectedFiles, attachmentPreview), // 更新 selectedFiles 和预览
  );

  // 平滑过渡：淡入
  messageElement.style.opacity = "1";

  // 自动聚焦并移动光标到末尾
  editInput.focus();
  editInput.setSelectionRange(editInput.value.length, editInput.value.length);

  } catch (err) {
    // 恢复原消息视图(重渲该 queueIndex);重渲自身失败则至少还原透明度(401 案:innerHTML 未被替换,原内容还在)
    try {
      if (editSessionOpen) await endAuthoritativeEdit(chatId, messageId, { applyPending: true });
      editSessionOpen = false;
      await rerenderMessageForChat(chatId, messageId);
    } catch { /* 重渲失败走透明度兜底 */ }
    messageElement.style.opacity = "1";
    showToast("error", `进入编辑失败: ${err?.message || err}`);
    throw err; // 继续抛给调用方,走既有 wbDetect/_reportError 上报链
  }
}

/**
 * 公开接口：替换指定索引的消息。
 * @param {number} index - 队列索引 (queueIndex)。
 * @param {object} message - 新消息对象。
 */
export async function replaceMessage(index, message) {
  await replaceMessageInQueue(index, message);
}

/**
 * 为消息元素启用左右滑动切换时间线的功能（移动端 touch 手势）。
 *
 * 链路：virtualQueue.updateLastCharMessageArrows() → enableSwipe(最后一条 char 消息)
 *       touch 手势 → modifyTimeLine(±1) → endpoints.mjs → 后端切换 swipe 分支
 * 影响：在 messageElement 上挂 touchstart/move/end/cancel 四个监听器（存入 swipeListenersMap）
 * 约束：只有最后一条 char 消息才启用 swipe（updateLastCharMessageArrows 保证）
 *
 * @param {HTMLElement} messageElement - 需要启用滑动的消息 DOM 元素
 */
export function enableSwipe(messageElement) {
  if (swipeListenersMap.has(messageElement)) disableSwipe(messageElement); // 防重复添加

  let touchStartX = 0,
    touchStartY = 0,
    isDragging = false,
    swipeHandled = false;

  // --- 定义命名的监听器函数 ---
  /**
   * 处理触摸开始事件。
   * @param {TouchEvent} event - 触摸事件对象。
   */
  const handleTouchStart = (event) => {
    if (event.touches.length !== 1) return;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    isDragging = true;
    swipeHandled = false;
  };
  /**
   * 处理触摸移动事件。
   * @param {TouchEvent} event - 触摸事件对象。
   */
  const handleTouchMove = (event) => {
    if (!isDragging || event.touches.length !== 1) return;
    const deltaX = event.touches[0].clientX - touchStartX;
    const deltaY = event.touches[0].clientY - touchStartY;
    if (Math.abs(deltaY) > Math.abs(deltaX)) isDragging = false; // 垂直滚动优先
  };
  /**
   * 处理触摸结束事件。
   * @param {TouchEvent} event - 触摸事件对象。
   */
  const handleTouchEnd = async (event) => {
    try {
      if (!isDragging || swipeHandled || event.changedTouches.length !== 1) {
        isDragging = false;
        return;
      }
      const deltaX = event.changedTouches[0].clientX - touchStartX;
      const deltaY = event.changedTouches[0].clientY - touchStartY;
      isDragging = false;

      if (
        Math.abs(deltaX) > SWIPE_THRESHOLD &&
        Math.abs(deltaX) > Math.abs(deltaY)
      ) {
        const targetElement = event.target;
        if (checkForHorizontalScrollbar(targetElement)) return; // 忽略带水平滚动的元素

        swipeHandled = true;
        const direction = deltaX > 0 ? -1 : 1; // 右滑-1(后退), 左滑+1(前进)
        await modifyTimeLine(direction);
      }
    } catch (err) {
      console.error('[messageList] swipe action failed:', err);
      wbDetect("messageList", "swipeAction", false, err?.message, { stack: err?.stack });
      window._reportError?.(`[messageList] ${err.message}`, err.stack);
    }
  };
  /**
   * 处理触摸取消事件。
   */
  const handleTouchCancel = () => {
    isDragging = false;
  };
  /**
   * 检查元素是否包含水平滚动条。
   * @param {HTMLElement} element - 要检查的 DOM 元素。
   * @returns {boolean} 如果元素包含水平滚动条则为 true，否则为 false。
   */
  function checkForHorizontalScrollbar(element) {
    if (!element || !element.scrollWidth || !element.clientWidth) return false;
    if (element.scrollWidth > element.clientWidth) return true;
    for (let i = 0; i < element.children.length; i++)
      if (checkForHorizontalScrollbar(element.children[i])) return true;

    return false;
  }
  // --- 监听器定义结束 ---

  const listeners = {
    touchstart: handleTouchStart,
    touchmove: handleTouchMove,
    touchend: handleTouchEnd,
    touchcancel: handleTouchCancel,
  };
  swipeListenersMap.set(messageElement, listeners); // 存储监听器引用

  // 添加事件监听
  messageElement.addEventListener("touchstart", listeners.touchstart, {
    passive: true,
  });
  messageElement.addEventListener("touchmove", listeners.touchmove, {
    passive: true,
  });
  messageElement.addEventListener("touchend", listeners.touchend, {
    passive: true,
  });
  messageElement.addEventListener("touchcancel", listeners.touchcancel, {
    passive: true,
  });
}

/**
 * 从消息元素移除左右滑动功能。
 * @param {HTMLElement} messageElement - 需要禁用滑动的消息 DOM 元素。
 */
export function disableSwipe(messageElement) {
  const listeners = swipeListenersMap.get(messageElement);
  if (!listeners) return;
  // 移除事件监听
  messageElement.removeEventListener("touchstart", listeners.touchstart);
  messageElement.removeEventListener("touchmove", listeners.touchmove);
  messageElement.removeEventListener("touchend", listeners.touchend);
  messageElement.removeEventListener("touchcancel", listeners.touchcancel);
  swipeListenersMap.delete(messageElement); // 清除引用
}
