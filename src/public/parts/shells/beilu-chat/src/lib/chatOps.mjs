/**
 * chatOps — 聊天操作层：所有修改对话状态（消息/角色/插件/人设/世界）的写操作 + 只读查询。
 * 不管 AI 生成（那是 generation.mjs 的事）、不管存储路径解析（那是 chatStorage.mjs 的事）、
 * 不管消息构建（那是 messageBuilder.mjs 的事）。
 *
 * 链路：endpoints.mjs → 本模块（写操作）→ chatStorage.mutateChat / broadcast.broadcastChatEvent
 *       generation.mjs → 本模块（addChatLogEntry 注入工具结果 system 条）
 *       requestBuilder.mjs → 本模块（getVisibleChatLog 构建 AI 可见上下文 + addChatLogEntry 供插件
 *         request.AddChatLogEntry 回调写入）
 *
 * 影响：已迁移写操作遵循候选修改 → 主 JSON 原子提交 → Map 发布 → 广播；
 *       未迁移 legacy 写者仍经 saveChat 兼容入口串行（见交付边界）。
 *
 * 相交：← endpoints.mjs（HTTP 路由入口） / generation.mjs（自动续轮注入工具结果）
 *       → chatStorage.saveChat（落盘） / broadcast.broadcastChatEvent（WS 推送）
 *       → messageBuilder（BuildChatLogEntryFromUserMessage/CharReply）
 *
 * RT-4 全局契约：所有改变 chatLog 后需要通知前端的操作，都先 await saveChat 再 broadcastChatEvent。
 *   原因：前端收到 WS 事件后可能 refetch /log 端点，若落盘未完成则读到旧 chatLog → 幽灵消息。
 */

import { createDiag } from "../../../../../../server/diagLogger.mjs";
import { renameSyncWithRetry } from "../../../../../../scripts/nicerWriteFile.mjs";
import { getPartList, loadPart } from "../../../../../../server/parts_loader.mjs";
import { skip_report } from "../../../../../../server/server.mjs";

import { broadcastChatEvent, broadcastCrossChatEvent, StreamManager } from "./broadcast.mjs";
import {
  chatMetadatas,
  getChatStorageDir,
  loadChat,
  mutateChat,
  saveChat,
  withChatTransactionOwner,
  newChat,
  renameChat,
  setModeActiveChat,
  deleteChat, // [0804] ensureModeChatsForChar 单线绑卡失败时回滚刚建的空对话（不留孤儿）
  BOT_CHAT_SYMBOL,
} from "./chatStorage.mjs";
import { loadShellData, saveShellData } from "../../../../../../server/setting_loader.mjs"; // bot 对话指针 bot_chat_bindings
import { chatLogSnapshot } from "../../../../../../yonban/core/functions/rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体
import { isDeleted, isActiveEntry, findLastActive, findLastActiveIndex, markDeleted } from "../../../../../../yonban/core/functions/hide/chatEntryUtils.mjs"; // T8·回切：改指 yonban 新位实现体
import {
  BuildChatLogEntryFromCharReply,
  BuildChatLogEntryFromUserMessage,
} from "./messageBuilder.mjs";
import { timeSlice_t } from "./models.mjs";
import { getChatRequest } from "./requestBuilder.mjs";
import { wbTrace, wbSpan, wbDetect } from "../../../../../../server/whitebox.mjs";

const diag = createDiag("chat");
const _preMutationSnapshot = Symbol("preMutationSnapshot");

function _captureChatLogSnapshot(chatLog) {
  return JSON.parse(JSON.stringify(chatLog));
}

function _writeCommittedSnapshot(chatid, value, reason) {
  const snapshot = value?.[_preMutationSnapshot];
  if (!snapshot) return;
  if (!chatLogSnapshot(chatid, snapshot, reason)) {
    throw new Error(`Committed chat snapshot failed: ${reason}`);
  }
}

function _runCommittedDeletionSideEffects(chatid, value, reason) {
  const failures = [];
  const messageIds = Array.isArray(value?.messageIds)
    ? value.messageIds
    : (typeof value?.messageId === "string" ? [value.messageId] : []);
  for (const messageId of messageIds) {
    try {
      StreamManager.abortByMessageId(messageId);
    } catch (error) {
      failures.push(`abort stream ${messageId}: ${error?.message || error}`);
    }
  }
  try {
    _writeCommittedSnapshot(chatid, value, reason);
  } catch (error) {
    failures.push(`snapshot: ${error?.message || error}`);
  }
  if (failures.length > 0) {
    throw new Error(`Committed deletion side effects failed: ${failures.join("; ")}`);
  }
}

function _withDerivedFailure(transaction, stage, error) {
  return {
    ...transaction,
    status: "committed_derived_failed",
    derived: {
      status: "failed",
      failures: [
        ...(transaction?.derived?.failures || []),
        { stage, error: error?.message || String(error) },
      ],
    },
  };
}

function _decorateCommittedEntry(entry, transaction) {
  if (!entry || typeof entry !== "object") return entry;
  try {
    Object.defineProperties(entry, {
      chatCommitted: { configurable: true, value: transaction.chatCommitted },
      status: { configurable: true, value: transaction.status },
      revision: { configurable: true, value: transaction.revision },
      integrity: { configurable: true, value: transaction.integrity },
      derived: { configurable: true, value: transaction.derived },
    });
  } catch (error) {
    console.warn("[chatOps] 已提交 entry 无法附加事务诊断字段:", error?.message || error);
  }
  return entry;
}

function _mergeCommitResult(value, transaction) {
  return {
    ...(value || {}),
    chatCommitted: transaction.chatCommitted,
    status: transaction.status,
    revision: transaction.revision,
    integrity: transaction.integrity,
    derived: transaction.derived,
  };
}

/**
 * 跨存储历史改写复用 chatStorage 的唯一 per-chat owner。operation 只能通过注入的
 * deleteMessagesRange capability 提交候选，禁止 public→public 重取同一锁。
 */
export async function withChatHistoryMutation(chatid, operation, { expectedUsername } = {}) {
  if (typeof operation !== "function") {
    throw _messageAnchorError("operation must be a function", "E_INVALID_CHAT_MUTATION");
  }
  return withChatTransactionOwner(chatid, async ({ candidate, commitCandidate }) => {
    let committedResult = null;
    const result = await operation({
      deleteMessagesRange: async (startIndex, endIndex, options) => {
        committedResult = await _deleteMessagesRangeOnCandidate(
          chatid, candidate, startIndex, endIndex, options, commitCandidate,
        );
        return committedResult;
      },
    });
    if (!committedResult?.chatCommitted || !result || typeof result !== "object") return result;
    return {
      ...result,
      chatCommitted: committedResult.chatCommitted,
      chatStatus: committedResult.status,
      chatRevision: committedResult.revision,
      chatIntegrity: committedResult.integrity,
      chatDerived: committedResult.derived,
    };
  }, { expectedUsername });
}

function _messageAnchorError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function _resolveMessageAnchorInLog(chatLog, anchorMessageId, indexHint) {
  const hinted = indexHint !== undefined && chatLog[indexHint]?.id === anchorMessageId
    ? indexHint
    : -1;
  const index = hinted >= 0
    ? hinted
    : chatLog.findIndex((entry) => entry?.id === anchorMessageId);
  return index < 0
    ? { found: false, index: -1, messageId: anchorMessageId, reason: "anchor_not_found" }
    : { found: true, index, messageId: anchorMessageId };
}

/**
 * 以持久化消息 ID 解析当前权威 chatLog 下标。indexHint 只用于快速命中/兼容校验，
 * 永远不能在 ID 不匹配时替代 ID 选中另一条消息。
 *
 * @param {string} chatid
 * @param {string} anchorMessageId
 * @param {number} [indexHint]
 * @returns {Promise<{found:true,index:number,messageId:string}|{found:false,index:-1,messageId:string,reason:"anchor_not_found"}>}
 */
export async function resolveMessageAnchor(chatid, anchorMessageId, indexHint) {
  if (typeof anchorMessageId !== "string" || !anchorMessageId.trim()) {
    throw _messageAnchorError("anchorMessageId must be a non-empty string", "E_INVALID_MESSAGE_ANCHOR");
  }
  if (indexHint !== undefined && (!Number.isInteger(indexHint) || indexHint < 0)) {
    throw _messageAnchorError("indexHint must be a non-negative integer", "E_INVALID_MESSAGE_INDEX");
  }
  const messageId = anchorMessageId.trim();
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw _messageAnchorError("Chat not found", "E_CHAT_NOT_FOUND", 404);
  return _resolveMessageAnchorInLog(chatMetadata.chatLog, messageId, indexHint);
}

// ============================================================
// bot 对话文件（凛倾 07-09「对话文件的专门符号+一个平台一个」）
// ============================================================
// 专门符号进【对话名】（chat_names shellData）而非 chatid——chatid 必须匹配前后端单源守卫
// /^[a-z0-9]{7,15}$/（sharedState.mjs:105 / storage.mjs:1866 _SM_CHATID_RE），符号进 id 会被
// per-chatId 隔离 map 全部拦掉。前端按此符号屏蔽（bot 模式外不出现）。
// 0715 收口：定义下沉 chatStorage.mjs（更低层，本文件已依赖它，反向 import 成环故下沉），此处 re-export
// 保旧调用点（botContentShared.mjs 经 chatOpsMod 取）。前端镜像=shared/state/utils.mjs BOT_CHAT_SYMBOL
// （跨 runtime 无法共享 import，改必同步后端 chatStorage + 前端 utils 两处）。
export { BOT_CHAT_SYMBOL } from "./chatStorage.mjs";

/**
 * bot 对话文件 ensure/新建（凛倾 07-09「一个平台一个」+「可以新建对话」）。
 *
 * 绑定模型=【指针】而非名字反查：shellData `bot_chat_bindings`（`<platform>|<charName>` → chatid）
 * 是「当前活跃 bot 对话」的单一权威。为什么不用名字查：用户可改名、可新建多个同名对话
 * ——名字派生查找会漂移；指针切换才承载「新建对话」语义（新建=建新文件+切指针，
 * 旧对话保留存档，仍带符号被普通列表屏蔽）。
 *
 * @param {string} username
 * @param {string} charName - 绑定角色卡名。
 * @param {string} platform - 平台名（discord/telegram/...，=extension.platform 单源值）。
 * 生效模型对齐（凛倾 07-09「绑定死=设计浪费」，同 07-08 预设生效模型）：指针=运行时真值，
 * 人（面板切换/新建）随时改它即改即生效；角色卡也不绑死——指针键含 charName，切绑定角色
 * =自然换键，新角色首条消息 lazy ensure 新线。
 *
 * @param {{fresh?: boolean, chatid?: string, peek?: boolean}} [opts]
 *   fresh=true 强制新建并切指针（面板「新建对话」）；
 *   chatid=切指针到指定已有对话（面板切换器，校验存在+属主）；
 *   peek=true 只读查询当前指针（无绑定不创建，返回 chatid:""）；
 *   缺省=有有效指针直接返回，无则新建（bot 壳每条消息取用，轻 IO 不缓存→切线即时生效）。
 * @returns {Promise<{chatid: string, name: string, created: boolean}>}
 */
/**
 * ensureBotChat 同键在飞串行化表（key = `${username}|${platform}|${charName}`）。
 *
 * 【why】本函数是「读绑定 → 无则 newChat → 写绑定」的读-改-写，中间有多个 await（newChat/
 *   renameChat/addchar 都是异步落盘）。原实现无任何互斥：两条平台消息几乎同时到达且当前无绑定时，
 *   两次调用都会读到「无绑定」→ 各自 newChat → 后写的 saveShellData 覆盖前写 → **前一条线成为孤儿**
 *   （文件已建、指针丢失，且那条线上已落的消息再也读不回来）。
 *   0726 上下文换源后本函数从「仅 discord 每轮调」变成「9 壳每条消息都调」，撞上概率被显著放大，
 *   且首次启动（无绑定 + 多平台并发收消息）正是最危险的窗口。
 * 【why 串行而非「只锁创建分支」】判定「有没有绑定」本身就在临界区内——只锁创建仍会两个调用
 *   先后都判成「无绑定」。故整函数按 key 串行；不同 key（不同用户/平台/角色）互不阻塞。
 * 【fresh 语义不变】fresh=true 本就意在每次新建一条，串行化只是让它们依次执行，不合并。
 */
const _ensureBotChatQueue = new Map();

/**
 * 取（无则建）某平台 bot 的对话线 —— 同键串行化包装，实现体见 _ensureBotChatImpl。
 * 参数与返回值同实现体。
 */
export async function ensureBotChat(username, charName, platform, opts = {}) {
  const qKey = `${username}|${platform}|${charName}`;
  const prev = _ensureBotChatQueue.get(qKey) ?? Promise.resolve();
  // prev 失败不应连坐后续调用（catch 吞掉前一次的错，只用它做时序栅栏）
  const run = prev.catch(() => {}).then(() => _ensureBotChatImpl(username, charName, platform, opts));
  _ensureBotChatQueue.set(qKey, run);
  try {
    return await run;
  } finally {
    // 只有自己仍是队尾时才清理，否则会误删后来者的栅栏
    if (_ensureBotChatQueue.get(qKey) === run) _ensureBotChatQueue.delete(qKey);
  }
}

/**
 * 保证 bot 绑定返回的对话真实挂载了它声明的角色。
 *
 * bot_chat_bindings 的值不是“只要文件存在就有效”的弱指针；后续 addUserReply 会复制该对话的
 * LastTimeSlice，而 triggerCharReply 在未显式传角色时也只从这里解析。允许空 chars 的对话进入
 * 绑定表，会把空角色状态持续传播成 no_character。这里因此承担 bot 线的角色不变量：缺失时先
 * 通过 addchar 正常挂载，挂载后再读回验证；不能证明成立就抛错，禁止继续写入/复用坏指针。
 */
async function _ensureBotChatCharacter(chatid, username, charName) {
  let metadata = await loadChat(chatid);
  if (!metadata) throw new Error(`Bot 对话不存在: ${chatid}`);
  if (metadata.username !== username) throw new Error(`Bot 对话不属于当前用户: ${chatid}`);
  if (!metadata.LastTimeSlice?.chars?.[charName]) {
    await addchar(chatid, charName);
    metadata = await loadChat(chatid);
  }
  if (!metadata?.LastTimeSlice?.chars?.[charName]) {
    const error = new Error(`Bot 对话角色挂载失败: ${chatid}/${charName}`);
    error.code = "E_BOT_CHAT_CHARACTER_MISSING";
    throw error;
  }
}

async function _ensureBotChatImpl(username, charName, platform, { fresh = false, chatid = "", peek = false } = {}) {
  const key = `${platform}|${charName}`;
  const bindings = loadShellData(username, "chat", "bot_chat_bindings");
  const names = loadShellData(username, "chat", "chat_names");
  // 切换到指定已有对话（切换器）：校验存在+属主后写指针，即改即生效
  if (chatid) {
    if (chatMetadatas.get(chatid)?.username !== username)
      throw new Error(`对话 ${chatid} 不存在或不属于当前用户`);
    await _ensureBotChatCharacter(chatid, username, charName);
    bindings[key] = chatid;
    saveShellData(username, "chat", "bot_chat_bindings");
    return { chatid, name: names[chatid] || "", created: false };
  }
  if (!fresh) {
    const bound = bindings[key];
    // 指针有效性：对话仍存在且属主匹配（被删除的脏指针视同无，落新建重绑）
    if (bound && chatMetadatas.get(bound)?.username === username) {
      // peek 是纯读预览；真正消费 bot 线时必须修复/验证角色不变量。这样历史空壳绑定会在
      // 下一次启动或收消息时原地自愈，而不是继续把空 LastTimeSlice 传给主生成器。
      if (!peek) await _ensureBotChatCharacter(bound, username, charName);
      return { chatid: bound, name: names[bound] || `${BOT_CHAT_SYMBOL}[${platform}] ${charName}`, created: false };
    }
    // peek：只查不建（面板回显当前绑定用）
    if (peek) return { chatid: "", name: "", created: false };
  }
  const name = `${BOT_CHAT_SYMBOL}[${platform}] ${charName}`;
  const newId = await newChat(username);
  await renameChat(newId, username, name);
  // 角色挂载是 bot 对话成立的前置契约，不是可忽略装饰。先挂载并读回验证，成功后才写绑定；
  // 失败时保留原绑定不被坏指针覆盖，并把真实错误交给启动/消息入口显示。
  await _ensureBotChatCharacter(newId, username, charName);
  bindings[key] = newId;
  saveShellData(username, "chat", "bot_chat_bindings");
  return { chatid: newId, name, created: true };
}

/**
 * bot 平台消息写入对话文件（凛倾 07-09「目的是上下文」的实体：对话文件=上下文载体，
 * 切换对话=切换上下文，不落消息则文件是空壳目的不成立）。
 *
 * 身份表示与壳内存日志同规则（discord main :259-264）：owner 消息=role "user"、
 * 外部用户/AI=role "char"，显示名经 result.name 覆盖（messageBuilder 原生支持，
 * BuildChatLogEntryFromUserMessage:188 / FromCharReply:147）。timeSlice 沿对话自身
 * LastTimeSlice 推进（addUserReply 同款），不发明新序列化字段。
 *
 * @param {string} chatid
 * @param {{role: "user"|"char", name: string, content: string, content_for_show?: string,
 *   charName?: string, files?: Array, extension?: object}} msg
 *   charName：role="char" 且是绑定角色的 AI 回复时传真实角色名（头像取该角色卡）；
 *   外部用户消息传其显示名即可（无角色卡头像=优雅降级）。
 * @returns {Promise<object>} 追加的 entry。
 */
export async function appendBotChatEntry(chatid, msg, { expectedUsername } = {}) {
  const transaction = await mutateChat(chatid, (candidate, entry) => {
    // [0726 上下文换源] N42 档位字段透传：`_sourceType`/`_permissionLevel` 由各壳挂在条目上，
    //   消费方 resolveRequestBotPermission(chat_log) 取**尾条**判本轮触发者档位（file_op/delegate/
    //   ideToolCall/modeSwitch 据此裁决）。原先 chat_log 来自壳内存，字段天然在；换成从对话文件读之后，
    //   若此处不透传，尾条就没有这两个字段 → resolveRequestBotPermission 返回 null → 档位门整体失效
    //   （静默降级成"非 bot 来源"，等于所有平台用户拿满权限）。
    //   可行性：entry.toData() 是全量 `{ ...this }` 展开、fromJSON 是 `Object.assign(new, {...json})`，
    //   非白名单，故自定义字段能完整过盘往返。
    if (msg._sourceType) entry._sourceType = msg._sourceType;
    if (Number.isFinite(msg._permissionLevel)) entry._permissionLevel = msg._permissionLevel;
    // [P0-B 2026-08-03] sender 身份/策略快照透传（buildBotSourceMeta 产出，pickBotSourceMeta 转发）：
    //   _senderId/_isOwner=审计与 host_control 裁决依据；_hostControl=触发时刻策略快照（owner-only，
    //   默认 false）；_policyRev=权限策略修订对账。缺失（旧壳/旧条目）时消费端按非 owner/无宿主能力
    //   fail-closed 解析——不在此补默认值，缺字段本身就是"不可证明"的诚实信号。
    if (msg._senderId !== undefined) entry._senderId = String(msg._senderId);
    if (msg._isOwner !== undefined) entry._isOwner = msg._isOwner === true;
    if (msg._hostControl !== undefined) entry._hostControl = msg._hostControl === true;
    if (Number.isFinite(msg._policyRev)) entry._policyRev = msg._policyRev;
    candidate.LastTimeSlice = entry.timeSlice;
    candidate.chatLog.push(entry);
    return entry;
  }, {
    expectedUsername,
    prepare: async (authoritative) => {
      const newTimeSlice = authoritative.LastTimeSlice.copy();
      return msg.role === "char"
        ? BuildChatLogEntryFromCharReply(
          { name: msg.name, content: msg.content, content_for_show: msg.content_for_show, files: msg.files || [], extension: msg.extension || {} },
          newTimeSlice, null, msg.charName || msg.name, authoritative.username,
        )
        : BuildChatLogEntryFromUserMessage(
          { name: msg.name, content: msg.content, files: msg.files || [], extension: msg.extension || {} },
          newTimeSlice, newTimeSlice.player, newTimeSlice.player_id, authoritative.username,
        );
    },
  });
  let finalTransaction = transaction;
  try {
    broadcastChatEvent(chatid, {
      type: "message_added",
      payload: await transaction.value.toData(expectedUsername ?? chatMetadatas.get(chatid)?.username),
    });
  } catch (error) {
    finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
  }
  return _decorateCommittedEntry(transaction.value, finalTransaction);
}

// ============================================================
// addChatLogEntry（大幅简化：去掉 world 劫持/成就/通知/自动回复）
// ============================================================

/**
 * 向对话追加一条消息并持久化 + 广播。
 *
 * 链路：endpoints POST message → addUserReply → 本函数
 *       generation.mjs 自动续轮 → 本函数（注入 IDE 工具结果 system 条）
 * 影响：chatLog 就地 push → saveChat 落盘 → broadcast message_added
 * 约束：RT-4 契约——先 await 落盘再广播，否则前端 refetch 读到旧 chatLog
 *
 * @param {string} chatid
 * @param {chatLogEntry_t} entry - 已构建好的消息条目（由 messageBuilder 构建）
 * @returns {Promise<chatLogEntry_t>} 同一 entry 引用
 */
export async function addChatLogEntry(chatid, entry, { expectedUsername } = {}) {
  wbTrace(chatid, "chatOps", "addChatLogEntry:enter", { role: entry?.role, contentLen: entry?.content?.length || 0 });
  const transaction = await mutateChat(chatid, (candidate) => {
    candidate.chatLog.push(entry);
    return entry;
  }, { expectedUsername });
  let finalTransaction = transaction;
  try {
    broadcastChatEvent(chatid, {
      type: "message_added",
      payload: await entry.toData(expectedUsername ?? chatMetadatas.get(chatid)?.username),
    });
  } catch (error) {
    finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
  }
  return _decorateCommittedEntry(entry, finalTransaction);
}

// ============================================================
// 用户回复
// ============================================================

// ============================================================
// [0719 幂等契约·凛倾「只发送一次但ai看到了4次」根治] 用户消息写入幂等窗（写入 owner 单点）：
//   客户端每次「逻辑发送」（一次点击）生成 client_msg_id 随 POST 带上——超时重放/401 重放/
//   连接重试携带同一 id → 本窗口内命中=不重写，重放天然无害（at-least-once 客户端的正确性契约，
//   底部功能层「写入带信息,储存按信息走」语义）。盘上实证：同 md5 消息落 4 条（取证_消息4次复制.md）。
//   窗=内存 10 分钟（重放都在秒级；跨重启的重复不在射程=诚实边界）。不带 id 的调用方行为零变化。
// ============================================================
const _recentClientMsgIds = new Map(); // `${chatid}:${client_msg_id}` → { entry, ts }
const _CMID_TTL_MS = 10 * 60 * 1000;

/** 幂等查询：该 chatid 的 client_msg_id 是否在窗内已写入（供 POST message 入口判重，命中返回既有 entry）。 */
export function getRecentUserReply(chatid, clientMsgId) {
  if (!chatid || !clientMsgId) return null;
  const hit = _recentClientMsgIds.get(`${chatid}:${clientMsgId}`);
  if (!hit) return null;
  if (Date.now() - hit.ts > _CMID_TTL_MS) {
    _recentClientMsgIds.delete(`${chatid}:${clientMsgId}`);
    return null;
  }
  return hit.entry;
}

function _registerClientMsgId(chatid, clientMsgId, entry) {
  const now = Date.now();
  // 顺路清扫过期项（无定时器，写入时代谢）
  for (const [k, v] of _recentClientMsgIds) if (now - v.ts > _CMID_TTL_MS) _recentClientMsgIds.delete(k);
  _recentClientMsgIds.set(`${chatid}:${clientMsgId}`, { entry, ts: now });
}

/**
 * 保存用户消息到对话。是 R1 主对话链路第 2 节点。
 *
 * 链路：endpoints POST /:chatid/message → 本函数 → BuildChatLogEntryFromUserMessage → addChatLogEntry
 * 影响：复制当前 LastTimeSlice → 构建 user entry → addChatLogEntry（落盘 + 广播 message_added）
 *
 * @param {string} chatid
 * @param {{ content: string, files?: Array, client_msg_id?: string }} object - 用户消息内容（endpoints 已校验并统一格式；
 *   client_msg_id=幂等键，见上方幂等窗注释，写入后登记并从 object 剥离不进 entry 构建）
 * @returns {Promise<chatLogEntry_t>}
 */
export async function addUserReply(chatid, object, { expectedUsername } = {}) {
  wbTrace(chatid, "chatOps", "addUserReply:enter", { contentLen: (object?.content || "").length, files: object?.files?.length || 0 });
  const _cmid = typeof object?.client_msg_id === "string" && object.client_msg_id ? object.client_msg_id : null;
  if (_cmid) {
    delete object.client_msg_id;
  }
  const transaction = await mutateChat(chatid, (candidate, entry) => {
    const duplicateEntry = _cmid ? getRecentUserReply(chatid, _cmid) : null;
    if (duplicateEntry) {
      wbTrace(chatid, "chatOps", "addUserReply:idempotent_hit", { client_msg_id: _cmid });
      console.log(`[chatOps] addUserReply 幂等命中（重放不重写）: ${chatid.substring(0, 8)}… id=${_cmid}`);
      return { entry: duplicateEntry, duplicate: true };
    }
    candidate.timeLines = [entry];
    candidate.timeLineIndex = 0;
    candidate.LastTimeSlice = entry.timeSlice;
    candidate.chatLog.push(entry);
    return { entry, duplicate: false };
  }, {
    expectedUsername,
    shouldCommit: (value) => !value.duplicate,
    afterCommit: (value) => {
      if (_cmid) _registerClientMsgId(chatid, _cmid, value.entry);
    },
    prepare: async (authoritative) => {
      const timeSlice = authoritative.LastTimeSlice;
      const newTimeSlice = timeSlice.copy();
      return BuildChatLogEntryFromUserMessage(
        object, newTimeSlice, timeSlice.player, newTimeSlice.player_id, authoritative.username,
      );
    },
  });
  if (transaction.value.duplicate) return transaction.value.entry;
  let finalTransaction = transaction;
  if (transaction.chatCommitted) {
    try {
      broadcastChatEvent(chatid, {
        type: "message_added",
        payload: await transaction.value.entry.toData(expectedUsername ?? chatMetadatas.get(chatid)?.username),
      });
    } catch (error) {
      finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
    }
  }
  return _decorateCommittedEntry(transaction.value.entry, finalTransaction);
}

const _lastActiveEntry = findLastActive;

// ============================================================
// 删除消息
// ============================================================

export async function deleteMessage(chatid, index, { messageId, expectedUsername } = {}) {
  wbTrace(chatid, "chatOps", "deleteMessage:enter", { index, messageId });
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid index");
  const hasStableMessageId = typeof messageId === "string" && messageId.length > 0;
  const transaction = await mutateChat(chatid, (candidate) => {
    const anchor = hasStableMessageId
      ? _resolveMessageAnchorInLog(candidate.chatLog, messageId, index)
      : null;
    const resolvedIndex = anchor ? anchor.index : index;
    const entry = candidate.chatLog[resolvedIndex];
    if (!entry) return { applied: false, index: resolvedIndex, messageId: hasStableMessageId ? messageId : null, reason: "not_found" };
    if (isDeleted(entry)) return { applied: false, index: resolvedIndex, messageId: entry.id, reason: "already_deleted" };
    const snapshot = _captureChatLogSnapshot(candidate.chatLog);
    markDeleted(entry, "user");
    const last = _lastActiveEntry(candidate.chatLog);
    candidate.timeLines = last ? [last] : [];
    candidate.timeLineIndex = 0;
    candidate.LastTimeSlice = last ? last.timeSlice : new timeSlice_t();
    const value = { applied: true, index: resolvedIndex, messageId: entry.id, reason: "deleted" };
    Object.defineProperty(value, _preMutationSnapshot, { value: snapshot });
    return value;
  }, {
    expectedUsername,
    shouldCommit: (value) => value.applied,
    afterCommit: (value) => _runCommittedDeletionSideEffects(chatid, value, "deleteMessage"),
  });
  let finalTransaction = transaction;
  if (transaction.chatCommitted) {
    try {
      broadcastChatEvent(chatid, {
        type: "message_deleted",
        payload: { index: transaction.value.index, messageId: transaction.value.messageId },
      });
    } catch (error) {
      finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
    }
  }
  return _mergeCommitResult(transaction.value, finalTransaction);
}

// ============================================================
// 批量删除消息范围
// ============================================================

/**
 * 批量标记删除消息范围（含隐藏消息一并删除，符合「删除此点之后全部」语义）。
 *
 * 链路：endpoints POST /:chatid/messages/delete-range → 本函数
 * 影响：markDeleted 所有范围内消息 → saveChat → broadcast messages_range_deleted
 *       中止范围内正在生成的流（StreamManager.abortByMessageId）
 *
 * @param {string} chatid
 * @param {number} startIndex - 原始数组起始下标（含）
 * @param {number} [endIndex] - 原始数组结束下标（不含），省略=删到末尾
 * @param {{anchorMessageId?: string}} [options] - 回档锚点；给出后 startIndex 只作兼容提示，实际从该 ID 后开始删。
 * @returns {Promise<{ applied: boolean, deleted: number, startIndex: number, endIndex: number, messageIds: string[], reason?: string }>}
 */
export async function deleteMessagesRange(chatid, startIndex, endIndex, { anchorMessageId, expectedUsername } = {}) {
  const transaction = await mutateChat(
    chatid,
    (candidate) => _applyDeleteMessagesRange(chatid, candidate, startIndex, endIndex, { anchorMessageId }),
    {
      expectedUsername,
      shouldCommit: (value) => value.applied,
      afterCommit: (value) => _runCommittedDeletionSideEffects(chatid, value, "deleteRange"),
    },
  );
  return _finishDeleteRange(chatid, transaction);
}

function _applyDeleteMessagesRange(chatid, chatMetadata, startIndex, endIndex, { anchorMessageId } = {}) {
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error("Invalid startIndex");
  }
  if (endIndex != null && (!Number.isInteger(endIndex) || endIndex < 0)) {
    throw new Error("Invalid endIndex");
  }

  // 入参为原始数组下标范围（GetChatLog 不再过滤 _hidden，前端/扫描序=原始序）。
  // endIndex 省略=删到末尾，夹在其间的隐藏消息一并删除（符合「删除此点之后全部」语义）。
  const len = chatMetadata.chatLog.length;
  const hasAnchorMessageId = typeof anchorMessageId === "string" && anchorMessageId.length > 0;
  const anchor = hasAnchorMessageId
    ? _resolveMessageAnchorInLog(chatMetadata.chatLog, anchorMessageId, Math.max(0, startIndex - 1))
    : null;
  const anchorIndex = anchor ? anchor.index : -1;
  if (hasAnchorMessageId && anchorIndex < 0) {
    return {
      applied: false,
      deleted: 0,
      startIndex: -1,
      endIndex: -1,
      messageIds: [],
      reason: "anchor_not_found",
    };
  }
  const start = hasAnchorMessageId
    ? anchorIndex + 1
    : Math.min(len, startIndex);
  const end = endIndex != null ? Math.min(len, endIndex) : len;
  if (start >= end) {
    return {
      applied: false,
      deleted: 0,
      startIndex: start,
      endIndex: end,
      messageIds: [],
      reason: "empty_range",
    };
  }

  const messageIds = chatMetadata.chatLog
    .slice(start, end)
    .map((entry) => entry?.id)
    .filter((id) => typeof id === "string" && id.length > 0);

  const snapshot = _captureChatLogSnapshot(chatMetadata.chatLog);

  const count = end - start;
  // [2026-08-01 凛倾拍板「回档=ctrl+z」] 删到末尾（回档即此形态）=物理截断：尾部截断不改变
  //   存活消息的索引，checkpoint/hide 等索引锚全部稳定；误回档由上方快照兜底（beilu-files
  //   listChatBackups/restoreChatBackup 恢复链已存在）。旧软删留尸体：渲染过滤后不可见但永久
  //   累积、回档计数失真（自驱动2"11条"案）；物理截断顺带清掉范围内历史软删尸体
  //   （="再次回档让系统清理"）。非尾部范围删除保留软删——中段物理抽除会使后续消息索引
  //   漂移、错位 checkpoint 锚，语义不同不并轨。
  if (end === len) {
    chatMetadata.chatLog.splice(start);
  } else {
    for (let i = start; i < end; i++) {
      if (chatMetadata.chatLog[i]) markDeleted(chatMetadata.chatLog[i], "rollback");
    }
  }

  const last = _lastActiveEntry(chatMetadata.chatLog);
  chatMetadata.timeLines = last ? [last] : [];
  chatMetadata.timeLineIndex = 0;
  chatMetadata.LastTimeSlice = last ? last.timeSlice : new timeSlice_t();

  const value = {
    applied: true,
    deleted: count,
    startIndex: start,
    endIndex: end,
    messageIds,
  };
  Object.defineProperty(value, _preMutationSnapshot, { value: snapshot });
  return value;
}

function _finishDeleteRange(chatid, transaction) {
  let finalTransaction = transaction;
  if (transaction.chatCommitted) {
    try {
      broadcastChatEvent(chatid, {
        type: "messages_range_deleted",
        payload: {
          startIndex: transaction.value.startIndex,
          count: transaction.value.deleted,
          messageIds: transaction.value.messageIds,
        },
      });
    } catch (error) {
      finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
    }
  }
  return _mergeCommitResult(transaction.value, finalTransaction);
}

async function _deleteMessagesRangeOnCandidate(chatid, candidate, startIndex, endIndex, options, commitCandidate) {
  const value = _applyDeleteMessagesRange(chatid, candidate, startIndex, endIndex, options);
  if (!value.applied) {
    return _mergeCommitResult(value, {
      chatCommitted: false,
      status: "not_modified",
      revision: chatMetadatas.get(chatid)?._integrity ?? null,
      integrity: chatMetadatas.get(chatid)?._integrity ?? null,
      derived: null,
    });
  }
  let transaction = await commitCandidate(value);
  try {
    _runCommittedDeletionSideEffects(chatid, value, "deleteRange");
  } catch (error) {
    transaction = _withDerivedFailure(transaction, "after_commit", error);
  }
  return _finishDeleteRange(chatid, transaction);
}

// ============================================================
// 隐藏消息（不发送掩码，对齐 SillyTavern is_system / smartClean _hidden）
// 删除语义=不发送而非物理删除：留在磁盘、可逆，仅 requestBuilder:97 过滤不送 AI
// ============================================================

/**
 * 隐藏/取消隐藏消息（_hidden 掩码）。隐藏 = 不发送 AI 而非物理删除，留在磁盘可逆。
 *
 * 链路：endpoints POST /:chatid/messages/hide → 本函数
 *       AI 上下文过滤：requestBuilder 的 isActiveEntry 按 _hidden 滤出 → AI 看不到
 *       前端渲染：GetChatLog 返回含隐藏的完整 chatLog，前端据 extension._hidden 灰显
 * 影响：修改 entry.extension._hidden + _hiddenMeta → saveChat → broadcast messages_hidden
 * 约束：整个 load → ID 定位 → 修改 → save → broadcast 位于 per-chat 写锁内。
 *       T3 支持 opts.ids 按 entry.id 重定位下标；只要显式给了 ID，就绝不回退 indices。
 *       部分 ID 消失时只处理仍存在的 ID 并返回 partial；全部消失时 fail-closed，不写盘。
 *       T4 _hiddenMeta 记 who/when/why（by: 'ai'|'auto'|'user'），_hidden 保持布尔不动热路径
 *
 * @param {string} chatid
 * @param {number[]} indices - 原始数组下标
 * @param {boolean} [hide=true]
 * @param {{ ids?: string[], messageMeta?: { by: string, reason?: string }, meta?: { by: string, reason?: string } }} [opts]
 * @returns {Promise<{success:boolean,applied:boolean,partial:boolean,hidden:number,requested:number,matched:number,indices:number[],messageIds?:string[],missingMessageIds?:string[],code?:string,error?:string}>}
 */
export async function hideMessages(chatid, indices, hide = true, opts = {}) {
  const transaction = await mutateChat(
    chatid,
    (candidate) => _hideMessagesImpl(candidate, indices, hide, opts),
    { expectedUsername: opts.expectedUsername, shouldCommit: (value) => value.applied },
  );
  let finalTransaction = transaction;
  if (transaction.chatCommitted) {
    const messageMeta = opts.messageMeta ?? opts.meta;
    try {
      broadcastChatEvent(chatid, {
        type: "messages_hidden",
        payload: {
          indices: [...transaction.value.indices],
          ...(transaction.value.messageIds ? { messageIds: [...transaction.value.messageIds] } : {}),
          hide,
          ...(hide ? { meta: { by: messageMeta?.by || "auto", reason: messageMeta?.reason || messageMeta?.by || "auto" } } : {}),
        },
      });
    } catch (error) {
      finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
    }
  }
  return _mergeCommitResult(transaction.value, finalTransaction);
}

function _hideMessagesImpl(chatMetadata, indices, hide = true, opts = {}) {
  const log = chatMetadata.chatLog;

  // 入参索引基于原始数组下标（GetChatLog 不再过滤 _hidden，前端/扫描序、AI 翻译后序=原始序）。
  // hide/unhide 统一按原始下标处理。
  // T3 定位优先 id：opts.ids 给定则在锁内刚 reload 的 log 里按稳定 entry.id 重定位。
  // 显式 ID 无论全失效还是部分失效都不回退入参下标；只有未提供 ids 的旧自动/范围调用保留 index 语义。
  let _indices = Array.isArray(indices) ? indices : [];
  let requestedMessageIds = null;
  let resolvedMessageIds = null;
  let missingMessageIds = [];
  if (Object.prototype.hasOwnProperty.call(opts, "ids")) {
    if (!Array.isArray(opts.ids) || opts.ids.length === 0 || opts.ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw _messageAnchorError("ids must be a non-empty string array", "E_HIDE_MESSAGE_IDS_INVALID");
    }
    requestedMessageIds = opts.ids.map((id) => id.trim());
    if (new Set(requestedMessageIds).size !== requestedMessageIds.length) {
      throw _messageAnchorError("ids must not contain duplicates", "E_HIDE_MESSAGE_IDS_DUPLICATED");
    }
    const resolved = requestedMessageIds.map((id) => ({ id, index: log.findIndex((entry) => entry?.id === id) }));
    missingMessageIds = resolved.filter((item) => item.index < 0).map((item) => item.id);
    const found = resolved.filter((item) => item.index >= 0);
    _indices = found.map((item) => item.index);
    resolvedMessageIds = found.map((item) => item.id);
    if (found.length === 0) {
      return {
        success: false,
        applied: false,
        partial: false,
        code: "E_HIDE_MESSAGE_IDS_NOT_FOUND",
        error: "显式指定的消息 ID 均不存在，未修改任何消息",
        hidden: 0,
        requested: requestedMessageIds.length,
        matched: 0,
        indices: [],
        messageIds: [],
        missingMessageIds,
      };
    }
  }

  // T4 隐藏元数据：旁路字段 _hiddenMeta 记 who/when/why；_hidden 保持布尔不动 prompt 过滤热路径。
  // by: 'ai'(contextClean) | 'auto'(压缩/工具/read_file 刷新) | 'user'(手动端点)，缺省 auto。
  const messageMeta = opts.messageMeta ?? opts.meta;
  const _meta = hide
    ? { by: messageMeta?.by || "auto", at: Date.now(), reason: messageMeta?.reason || messageMeta?.by || "auto" }
    : null;
  let changed = 0;
  for (const index of _indices) {
    if (index == null || index < 0 || index >= log.length) continue;
    const entry = log[index];
    if (!entry) continue;
    if (!entry.extension) entry.extension = {};
    if (Boolean(entry.extension._hidden) !== hide) {
      entry.extension._hidden = hide;
      if (hide) entry.extension._hiddenMeta = { ..._meta };
      else delete entry.extension._hiddenMeta;
      changed++;
    }
  }

  const partial = requestedMessageIds !== null && missingMessageIds.length > 0;
  return {
    success: !partial,
    applied: changed > 0,
    partial,
    ...(partial ? {
      code: "E_HIDE_MESSAGE_IDS_PARTIAL",
      error: "部分显式消息 ID 不存在；仅处理了仍存在的消息，未按 index 回退",
    } : {}),
    hidden: changed,
    requested: requestedMessageIds?.length ?? _indices.length,
    matched: _indices.length,
    indices: [..._indices],
    ...(resolvedMessageIds ? { messageIds: [...resolvedMessageIds], missingMessageIds } : {}),
  };
}

// ============================================================
// 编辑消息
// ============================================================

const EDIT_OPERATION_RECEIPT_LIMIT = 128;

function _normalizeEditOperationContract(editOperationId, payloadFingerprint, { required = false } = {}) {
  const operationId = typeof editOperationId === "string" ? editOperationId.trim() : "";
  const fingerprint = typeof payloadFingerprint === "string" ? payloadFingerprint.trim().toLowerCase() : "";
  if (!operationId && !fingerprint && !required) return null;
  if (!operationId) {
    throw _messageAnchorError("editOperationId is required", "E_EDIT_OPERATION_ID_REQUIRED");
  }
  if (operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
    throw _messageAnchorError("editOperationId format is invalid", "E_EDIT_OPERATION_ID_INVALID");
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw _messageAnchorError("edit payload fingerprint is invalid", "E_EDIT_PAYLOAD_FINGERPRINT_INVALID");
  }
  return { operationId, payloadFingerprint: fingerprint };
}

function _findEditOperationReceipt(metadata, operationId) {
  const receipts = Array.isArray(metadata?.editOperationReceipts)
    ? metadata.editOperationReceipts
    : [];
  return receipts.find((receipt) => receipt?.operationId === operationId) || null;
}

function _assertEditReceiptMatches(receipt, messageId, payloadFingerprint) {
  if (!receipt) return;
  if (receipt.messageId !== messageId || receipt.payloadFingerprint !== payloadFingerprint) {
    throw _messageAnchorError(
      "editOperationId was already committed with a different message or payload",
      "E_EDIT_OPERATION_PAYLOAD_MISMATCH",
      409,
    );
  }
}

async function _serializeEditReceiptResult(chatid, metadata, receipt, { expectedUsername } = {}) {
  if (!metadata || (expectedUsername && metadata.username !== expectedUsername)) {
    throw _messageAnchorError("Chat not found", "E_CHAT_NOT_FOUND", 404);
  }
  const anchor = _resolveMessageAnchorInLog(metadata.chatLog, receipt.messageId, receipt.index);
  const entry = anchor.found ? metadata.chatLog[anchor.index] : null;
  const entryData = entry && typeof entry.toData === "function"
    ? await entry.toData(expectedUsername ?? metadata.username)
    : null;
  const chatData = chatMetadatas.get(chatid);
  return {
    applied: true,
    deduped: true,
    reason: "edit_operation_reused",
    entry: entryData,
    messageId: receipt.messageId,
    index: anchor.found ? anchor.index : receipt.index,
    indexHint: receipt.index,
    editOperationId: receipt.operationId,
    payloadFingerprint: receipt.payloadFingerprint,
    receiptEditVersion: receipt.editVersion,
    chatCommitted: true,
    status: "committed",
    revision: chatData?._integrity ?? null,
    integrity: chatData?._integrity ?? null,
    derived: null,
  };
}

/** 只读查询一次编辑意图是否已经提交；用于响应丢失后的对账，不触发重写或广播。 */
export async function getEditOperationReceipt(
  chatid,
  messageId,
  editOperationId,
  payloadFingerprint,
  { expectedUsername } = {},
) {
  const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalizedMessageId) {
    throw _messageAnchorError("messageId must be a non-empty string", "E_EDIT_MESSAGE_ID_REQUIRED");
  }
  const operation = _normalizeEditOperationContract(
    editOperationId,
    payloadFingerprint,
    { required: true },
  );
  const metadata = await loadChat(chatid);
  if (!metadata || (expectedUsername && metadata.username !== expectedUsername)) {
    throw _messageAnchorError("Chat not found", "E_CHAT_NOT_FOUND", 404);
  }
  const receipt = _findEditOperationReceipt(metadata, operation.operationId);
  if (!receipt) return null;
  _assertEditReceiptMatches(receipt, normalizedMessageId, operation.payloadFingerprint);
  return _serializeEditReceiptResult(chatid, metadata, receipt, { expectedUsername });
}

export async function editMessage(
  chatid,
  messageId,
  indexHint,
  new_content,
  { expectedUsername, editOperationId, payloadFingerprint } = {},
) {
  const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalizedMessageId) {
    throw _messageAnchorError("messageId must be a non-empty string", "E_EDIT_MESSAGE_ID_REQUIRED");
  }
  if (!Number.isSafeInteger(indexHint) || indexHint < 0) {
    throw _messageAnchorError("indexHint must be a non-negative safe integer", "E_EDIT_INDEX_HINT_INVALID");
  }
  if (!new_content || typeof new_content !== "object" || Array.isArray(new_content)) {
    throw _messageAnchorError("edit content must be an object", "E_EDIT_CONTENT_INVALID");
  }
  if (!Object.prototype.hasOwnProperty.call(new_content, "content")
    || typeof new_content.content !== "string") {
    throw _messageAnchorError("edit content.content must be a string", "E_EDIT_CONTENT_REQUIRED");
  }
  const operation = _normalizeEditOperationContract(editOperationId, payloadFingerprint);

  wbTrace(chatid, "chatOps", "editMessage:enter", {
    messageId: normalizedMessageId,
    indexHint,
  });
  const transaction = await mutateChat(chatid, (candidate, prepared) => {
    if (prepared?.receipt) {
      _assertEditReceiptMatches(
        prepared.receipt,
        normalizedMessageId,
        operation.payloadFingerprint,
      );
      const currentAnchor = _resolveMessageAnchorInLog(
        candidate.chatLog,
        normalizedMessageId,
        prepared.receipt.index,
      );
      return {
        applied: true,
        deduped: true,
        index: currentAnchor.found ? currentAnchor.index : prepared.receipt.index,
        indexHint,
        messageId: normalizedMessageId,
        reason: "edit_operation_reused",
        entry: currentAnchor.found ? candidate.chatLog[currentAnchor.index] : null,
        receipt: prepared.receipt,
      };
    }
    // messageId 是唯一身份；indexHint 只允许命中同一 ID 的快速路径。锁内必须重新定位，
    // 不能在 prepare 后的排队窗口继续使用旧 index，更不能在 ID 消失时回退编辑另一条消息。
    const anchor = _resolveMessageAnchorInLog(
      candidate.chatLog,
      normalizedMessageId,
      indexHint,
    );
    if (!anchor.found) {
      return {
        applied: false,
        index: -1,
        indexHint,
        messageId: normalizedMessageId,
        reason: "message_id_not_found",
        entry: null,
      };
    }
    const { index } = anchor;
    const oldEntry = candidate.chatLog[index];
    if (isDeleted(oldEntry)) {
      return {
        applied: false,
        index,
        indexHint,
        messageId: normalizedMessageId,
        reason: "message_already_deleted",
        entry: null,
      };
    }
    if (!prepared?.entry || prepared.messageId !== normalizedMessageId) {
      throw _messageAnchorError("Prepared edit entry is missing", "E_EDIT_PREPARE_MISSING", 409);
    }

    const entry = prepared.entry;
    entry.id = normalizedMessageId;
    entry._editVersion = (oldEntry._editVersion || 0) + 1;
    const carriedLastTimeSlice = candidate.LastTimeSlice === oldEntry.timeSlice;
    candidate.chatLog[index] = entry;
    let timelineReferencesUpdated = 0;
    candidate.timeLines = candidate.timeLines.map((timelineEntry) => {
      if (timelineEntry?.id !== normalizedMessageId) return timelineEntry;
      timelineReferencesUpdated += 1;
      return entry;
    });
    if (carriedLastTimeSlice) {
      candidate.LastTimeSlice = entry.timeSlice;
    }
    if (operation) {
      const receipts = Array.isArray(candidate.editOperationReceipts)
        ? candidate.editOperationReceipts
        : [];
      const existingReceipt = _findEditOperationReceipt(candidate, operation.operationId);
      _assertEditReceiptMatches(existingReceipt, normalizedMessageId, operation.payloadFingerprint);
      if (!existingReceipt) {
        receipts.push({
          operationId: operation.operationId,
          payloadFingerprint: operation.payloadFingerprint,
          messageId: normalizedMessageId,
          index,
          editVersion: entry._editVersion,
          committedAt: new Date().toISOString(),
        });
      }
      candidate.editOperationReceipts = receipts.slice(-EDIT_OPERATION_RECEIPT_LIMIT);
    }
    return {
      applied: true,
      index,
      indexHint,
      messageId: normalizedMessageId,
      reason: "edited",
      entry,
      timelineReferencesUpdated,
      lastTimeSliceUpdated: carriedLastTimeSlice,
    };
  }, {
    expectedUsername,
    shouldCommit: (value) => value.applied && value.deduped !== true,
    afterCommit: (value) => {
      if (value.applied && value.deduped !== true && value.messageId) {
        StreamManager.abortByMessageId(value.messageId);
      }
    },
    prepare: async (authoritative) => {
      if (operation) {
        const receipt = _findEditOperationReceipt(authoritative, operation.operationId);
        if (receipt) {
          _assertEditReceiptMatches(receipt, normalizedMessageId, operation.payloadFingerprint);
          return { receipt, messageId: normalizedMessageId };
        }
      }
      const anchor = _resolveMessageAnchorInLog(
        authoritative.chatLog,
        normalizedMessageId,
        indexHint,
      );
      if (!anchor.found) return { entry: null, messageId: normalizedMessageId };
      const oldEntry = authoritative.chatLog[anchor.index];
      if (!oldEntry || isDeleted(oldEntry)) {
        return { entry: null, messageId: normalizedMessageId };
      }
      const sourceTimeSlice = oldEntry.timeSlice || authoritative.LastTimeSlice || new timeSlice_t();
      if (typeof sourceTimeSlice.copy !== "function") {
        throw _messageAnchorError("Message time slice cannot be copied safely", "E_EDIT_TIMESLICE_INVALID", 409);
      }
      if (oldEntry.role !== "char" && oldEntry.role !== "user") {
        throw _messageAnchorError(`Message role cannot be edited safely: ${oldEntry.role || "unknown"}`, "E_EDIT_ROLE_UNSUPPORTED", 409);
      }
      const editingCharName = oldEntry.role === "char" ? sourceTimeSlice.charname : null;
      if (oldEntry.role === "char" && !editingCharName) {
        throw _messageAnchorError("Character message is missing its authoritative charname", "E_EDIT_CHARNAME_MISSING", 409);
      }
      const editTimeSlice = sourceTimeSlice.copy();
      // timeSlice.copy() 面向“下一条消息”会清除这三个瞬态字段；编辑是原条替换，必须恢复原时间点语义。
      editTimeSlice.charname = sourceTimeSlice.charname;
      editTimeSlice.playername = sourceTimeSlice.playername;
      editTimeSlice.greeting_type = sourceTimeSlice.greeting_type;
      const hasOwn = (key) => Object.prototype.hasOwnProperty.call(new_content, key);
      if (hasOwn("content_for_show")
        && new_content.content_for_show !== null
        && new_content.content_for_show !== new_content.content) {
        throw _messageAnchorError("content_for_show must be null or match the new content", "E_EDIT_DISPLAY_CONTENT_MISMATCH");
      }
      if (hasOwn("content_for_edit")
        && new_content.content_for_edit !== new_content.content) {
        throw _messageAnchorError("content_for_edit must match the new content", "E_EDIT_SOURCE_CONTENT_MISMATCH");
      }
      const editPayload = {
        name: oldEntry.name,
        avatar: oldEntry.avatar,
        content: new_content.content,
        // 旧 content_for_show 是旧正文的渲染产物，不能跨编辑沿用。客户端若未显式给出，
        // 置 null 让消费者按新 content 的纯文本路径展示；编辑源始终与新正文一致。
        content_for_show: hasOwn("content_for_show")
          ? new_content.content_for_show
          : null,
        content_for_edit: new_content.content,
        files: hasOwn("files") ? new_content.files : oldEntry.files,
        extension: hasOwn("extension") ? new_content.extension : oldEntry.extension,
        logContextBefore: hasOwn("logContextBefore")
          ? new_content.logContextBefore
          : oldEntry.logContextBefore,
        logContextAfter: hasOwn("logContextAfter")
          ? new_content.logContextAfter
          : oldEntry.logContextAfter,
      };
      if (!Array.isArray(editPayload.files)) {
        throw _messageAnchorError("edit files must be an array", "E_EDIT_FILES_INVALID");
      }
      if (!editPayload.extension || typeof editPayload.extension !== "object"
        || Array.isArray(editPayload.extension)) {
        throw _messageAnchorError("edit extension must be an object", "E_EDIT_EXTENSION_INVALID");
      }
      const entry = editingCharName
        ? await BuildChatLogEntryFromCharReply(
          editPayload,
          editTimeSlice,
          editTimeSlice.chars?.[editingCharName],
          editingCharName,
          authoritative.username,
        )
        : await BuildChatLogEntryFromUserMessage(
          editPayload,
          editTimeSlice,
          editTimeSlice.player,
          editTimeSlice.player_id,
          authoritative.username,
        );
      entry.time_stamp = oldEntry.time_stamp;
      return { entry, messageId: normalizedMessageId };
    },
  });

  if (transaction.value?.deduped === true && operation) {
    const metadata = await loadChat(chatid);
    return _serializeEditReceiptResult(
      chatid,
      metadata,
      transaction.value.receipt,
      { expectedUsername },
    );
  }
  if (!transaction.chatCommitted) return _mergeCommitResult(transaction.value, transaction);

  let finalTransaction = transaction;
  let entryData = null;
  try {
    entryData = await transaction.value.entry.toData(
      expectedUsername ?? chatMetadatas.get(chatid)?.username,
    );
    broadcastChatEvent(chatid, {
      type: "message_edited",
      payload: {
        index: transaction.value.index,
        entry: entryData,
        ...(operation
          ? {
            editOperationId: operation.operationId,
            payloadFingerprint: operation.payloadFingerprint,
          }
          : {}),
      },
    });
  } catch (error) {
    finalTransaction = _withDerivedFailure(transaction, "broadcast", error);
  }

  return _mergeCommitResult({
    ...transaction.value,
    entry: entryData,
    ...(operation
      ? {
        editOperationId: operation.operationId,
        payloadFingerprint: operation.payloadFingerprint,
      }
      : {}),
    ...(finalTransaction.status === "committed_derived_failed"
      ? { warning: "消息编辑已提交，但广播、流终止或派生同步至少一项失败；请刷新核对。" }
      : {}),
  }, finalTransaction);
}

// ============================================================
// 附件历史修剪(T4 防膨胀,凛倾 tasks#12)
// ============================================================

/**
 * 剥除带指定产者标记的旧条目附件,只保最近 keep 条(机械规则,不看内容——beilu 只做管道)。
 *
 * 链路:gameCompanion 陪伴截图轮 addUserReply(带 extension 标记)后调本函数 → 旧截图条 files=[]
 *       → saveChat(toData 不再写 file:hash 引用)→ files.mjs cleanFiles 每小时孤儿 GC 回收 blob
 *       (引用消失+1h mtime 宽限后删,既有契约零新删除机制)。条目文字仍在=天然占位,不注入新文本(铁律)。
 * 影响:被剥条 _editVersion+1 并广播 message_edited(editMessage 同形状)——前端在场会话即时换新,
 *       不广播=refetch 前显示旧附件的僵尸面。只动 extension[marker] 为真的条,用户手动附件零波及。
 *
 * @param {string} chatid
 * @param {{ keep: number, marker: string }} opts - keep=保留条数(≥1);marker=extension 产者标记键
 * @returns {Promise<number>} 实际剥除的条数
 */
export async function trimEntryFiles(chatid, { keep, marker } = {}) {
  const _keep = Math.floor(Number(keep));
  if (!marker || !Number.isFinite(_keep) || _keep < 1) return 0;
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) return 0;
  const idxs = [];
  for (let i = 0; i < chatMetadata.chatLog.length; i++) {
    const e = chatMetadata.chatLog[i];
    if (!e || isDeleted(e)) continue;
    if (e.extension && e.extension[marker] && Array.isArray(e.files) && e.files.length) idxs.push(i);
  }
  const toStrip = idxs.slice(0, Math.max(0, idxs.length - _keep)); // chatLog 按时间序,前段=更旧
  if (!toStrip.length) return 0;
  wbTrace(chatid, "chatOps", "trimEntryFiles:strip", { marker, keep: _keep, strip: toStrip.length });
  for (const i of toStrip) {
    const e = chatMetadata.chatLog[i];
    e.files = [];
    e._editVersion = (e._editVersion || 0) + 1;
  }
  await saveChat(chatid); // RT-4 对齐:先落盘再广播
  for (const i of toStrip) {
    broadcastChatEvent(chatid, {
      type: "message_edited",
      payload: { index: i, entry: await chatMetadata.chatLog[i].toData(chatMetadata.username) },
    });
  }
  return toStrip.length;
}

// ============================================================
// 角色管理
// ============================================================

/**
 * [0731 四窗口对话收口] 确保角色卡在四个模式窗口（chat/smart/code/work）各有一条专属对话。
 * 凛倾 0628「角色卡都需要创建4个对话」+ 0731「一次新建4个,然后放到每个窗口」。
 *
 * 【why·根因】原实现是前端 charsel 两处复制的四模式建卡循环：导入路径先查"该角色已有对话吗"
 *   才建——而角色卡初始化会自动绑进当前对话，恒"已有" → 循环恒被短路（0731 实测：一条对话被
 *   聊天/全智能/工作 三个窗口共用）；且 create-char/import-char/ST 导入等服务端入口全都拿不到
 *   前端循环。收口为服务端单点：路由收尾调用，任何入口接入即得同一行为，前端复制循环镜像删除。
 *
 * 【幂等】按 mode_active_chats 指针逐模式判缺（指针在且对话实存 → 保留现值），只补缺失线——
 *   对已有角色重复调用不会新建对话。同一 username+charName 的整个“查指针→建聊
 *   →绑卡→写指针”事务必须串行；否则两个窗口会同时看见缺失并各建一条，较早的对话变孤儿。
 * 【每条缺失线】newChat(mode)（建对话+chat_modes 徽标）→ addchar（绑卡+文件迁移+开场白，
 *   与前端 bindCharToChat 路由同一实现）→ setModeActiveChat（「XX窗口在用」指针+跨端广播）。
 * 【失败面】单模式线绑卡失败只跳过该线不中断其余；调用方应 try/catch 使其对建卡主链非致命。
 *
 * @param {string} username
 * @param {string} charName - 角色目录名（与 primaryCharName 同域）
 * @returns {Promise<Record<string,string>>} mode → chatid 四键全量表（已有线返现值，新建线返新值）
 */
const _ensureModeChatQueue = new Map();

export async function ensureModeChatsForChar(username, charName) {
  const queueKey = `${username}\u0000${charName}`;
  const previous = _ensureModeChatQueue.get(queueKey) ?? Promise.resolve();
  // 前次失败只解除时序栅栏，不能永久堵住用户随后重试。
  const run = previous.catch(() => {}).then(() => _ensureModeChatsForCharImpl(username, charName));
  _ensureModeChatQueue.set(queueKey, run);
  try {
    return await run;
  } finally {
    // 只有队尾自己完成时清理；后到调用已经挂在本 Promise 后时不能删掉它的栅栏。
    if (_ensureModeChatQueue.get(queueKey) === run) _ensureModeChatQueue.delete(queueKey);
  }
}

async function _ensureModeChatsForCharImpl(username, charName) {
  const WINDOW_MODES = ["chat", "smart", "code", "work"]; // 窗口模式徽标域（chatStorage._VALID_CHAT_MODES 同域，禁与生成模式域混淆）
  // [0804 根因修] 先验角色后建线。原实现每线先 newChat 再 addchar 验角色：charName 是死值时
  //   （换用户残留 localStorage 的 p1自驱动 案）四条线全走「建空对话→绑卡失败→continue」，
  //   磁盘留下 4 个无主空对话（E 现场实证的孤儿来源）。角色不存在 → 零建线、结构化抛错，
  //   调用方（POST /char / ensure-mode-chats / create-char / import-char）自行映射 404。
  if (!(getPartList(username, "chars") || []).includes(charName)) {
    const _e = new Error("Char not found");
    _e.code = "CHAR_NOT_FOUND";
    _e.charname = charName;
    throw _e;
  }
  const modeChats = {};
  for (const mode of WINDOW_MODES) {
    const key = `${mode}:${charName}`;
    const map = loadShellData(username, "chat", "mode_active_chats");
    const existing = map[key];
    if (existing && chatMetadatas.get(existing)?.username === username) {
      modeChats[mode] = existing;
      continue;
    }
    const chatid = await newChat(username, mode);
    try {
      await addchar(chatid, charName);
    } catch (e) {
      console.warn(`[chatOps] ensureModeChatsForChar: ${mode} 线绑卡失败，回滚该线:`, e?.message);
      // [0804] 绑卡失败的空对话立即回滚：本事务刚建、未绑卡、无用户内容，删除无副作用；
      //   不回滚就是磁盘孤儿（与本函数「只补缺失线」的幂等语义矛盾——下次进来又建一条新的）。
      try {
        await deleteChat([chatid], username);
      } catch (delErr) {
        console.warn(`[chatOps] ensureModeChatsForChar: ${mode} 线孤儿回滚失败（遗留 ${chatid}）:`, delErr?.message);
      }
      continue;
    }
    const r = await setModeActiveChat(chatid, username, mode);
    // [0804 反方补修·指针写假成功] 原实现指针写失败只 warn 仍填 modeChats[mode]——调用方
    //   getMissingModeChatModes 只做四键真值检查 → 返回 success:true 但持久指针没落盘；
    //   下次 ensure 见 map 空又建新线，指针写持续失败时每次开卡净增一线（前一条沦为额外历史会话）。
    //   修法=写后从持久层读回验证（setModeActiveChat 以 meta.primaryCharName 反查定键，读回同时
    //   验证键域一致），写失败/读回不符 → 回滚本线新建对话、不填 modeChats → missingModes 如实
    //   上报 409 E_MODE_CHAT_INCOMPLETE，重试收敛而不是假绿。
    const _ptrBack = loadShellData(username, "chat", "mode_active_chats")[key];
    if (!r?.success || _ptrBack !== chatid) {
      console.warn(`[chatOps] ensureModeChatsForChar: ${mode} 在用指针写入失败（写=${r?.success ? "ok" : r?.message}，读回=${_ptrBack ?? "空"}），回滚该线`);
      try {
        await deleteChat([chatid], username);
      } catch (delErr) {
        console.warn(`[chatOps] ensureModeChatsForChar: ${mode} 线指针失败回滚失败（遗留 ${chatid}）:`, delErr?.message);
      }
      continue;
    }
    modeChats[mode] = chatid;
  }
  return modeChats;
}

/**
 * 向对话添加角色并获取首条 greeting。
 *
 * 链路：endpoints POST /:chatid/char → 本函数 → loadPart(角色) → getChatRequest → GetGreeting
 * 影响：修改 LastTimeSlice.chars → 可能迁移聊天文件到新角色目录 → 加载 greeting → addChatLogEntry
 *       广播 char_added / timeline_info（多 greeting 时）
 * 约束：角色不存在时抛 code=CHAR_NOT_FOUND（endpoints 映射为 404），防脏 charname 到达 loadPart 抛 500
 *
 * @param {string} chatid
 * @param {string} charname - 角色目录名（非显示名）
 * @returns {Promise<chatLogEntry_t|null>} greeting entry 或 null（无 greeting / 出错时）
 */
export async function addchar(chatid, charname) {
  const diagReqId = `${chatid}:${charname}:${Date.now().toString(36)}`;
  wbTrace(chatid, "chatOps", "addchar:enter", { charname });

  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");

  const { username } = chatMetadata;

  // 已存在则跳过
  if (chatMetadata.LastTimeSlice.chars[charname]) return null;

  // 角色存在性校验（复用框架 getPartList，其 PathFilter 即判定 chars/<name>/main.mjs 是否存在，
  //   与 loadPart 的加载前提同口径）。不存在则抛可识别错误，由路由层转 404 + 结构化 error，
  //   避免脏/陈旧 charname（如改名残留的 localStorage 值）直冲 loadPart 抛 "Module not found" → 500。
  let _charExists = false;
  try {
    _charExists = (getPartList(username, "chars") || []).includes(charname);
  } catch {
    _charExists = false;
  }
  if (!_charExists) {
    wbDetect(chatid, "chatOps", "addchar:charNotFound", false, "char part not found", { charname });
    const _e = new Error("Char not found");
    _e.code = "CHAR_NOT_FOUND";
    _e.charname = charname;
    throw _e;
  }

  // 修复Bug2：先加到 LastTimeSlice，再调 getChatRequest
  const char = (chatMetadata.LastTimeSlice.chars[charname] = await loadPart(
    username,
    `chars/${charname}`,
  ));
  broadcastChatEvent(chatid, { type: "char_added", payload: { charname } });

  const chatData = chatMetadatas.get(chatid);
  if (chatData) {
    const oldPrimary = chatData.primaryCharName || "";
    if (oldPrimary !== charname) {
      const oldDir = getChatStorageDir(username, oldPrimary);
      const oldPath = oldDir + "/" + chatid + ".json";
      chatData.primaryCharName = charname;
      const fs = (await import("node:fs")).default;
      if (fs.existsSync(oldPath)) {
        const newDir = getChatStorageDir(username, charname);
        fs.mkdirSync(newDir, { recursive: true });
        const newPath = newDir + "/" + chatid + ".json";
        try {
          renameSyncWithRetry(oldPath, newPath);
        } catch (e) {
          console.warn(`[chat] 聊天文件迁移失败:`, e.message);
        }
      }
    }
  }

  // 准备 greeting 时间切片
  const isFirstChar =
    Object.keys(chatMetadata.LastTimeSlice.chars).length === 1;
  const timeSlice = chatMetadata.LastTimeSlice.copy();
  timeSlice.chars[charname] = char;
  if (isFirstChar) timeSlice.greeting_type = "single";

  try {
    // 修复Bug1：getChatRequest 在 try 内
    const request = await getChatRequest(chatid, charname);

    let result = null;
    if (isFirstChar && char.interfaces?.chat?.GetGreeting) {
      const _wbG0 = wbSpan(chatid, "chatOps", "GetGreeting", { charname, index: 0 });
      result = await char.interfaces?.chat?.GetGreeting(request, 0);
      _wbG0({ contentLen: (result?.content || "").length, hasResult: !!result });
    }

    // [2026-08-01 空消息累计案·断链1] 空 greeting 拦截：角色卡 first_mes 为空时 GetGreeting 返回
    //   {content:""}（truthy）穿过旧 `if (!result)` 落成一条永久空消息（alt 循环 :727 区有空检查，
    //   index 0 主路径没有=两路径不对称）。空内容=无 greeting，同走无 greeting 分支，不落盘。
    if (!result || !String(result.content ?? "").trim()) {
      // 没有 greeting（或 greeting 为空），直接保存
      await saveChat(chatid); // RT-4 对齐：return 前 await 落盘
      return null;
    }

    const greeting_entry = await BuildChatLogEntryFromCharReply(
      result,
      timeSlice,
      char,
      charname,
      username,
    );
    chatMetadata.timeLines = [greeting_entry];
    chatMetadata.timeLineIndex = 0;
    chatMetadata.LastTimeSlice = greeting_entry.timeSlice;
    await addChatLogEntry(chatid, greeting_entry);

    // ★ P6-3 修复：预加载所有 alternate_greetings 到 timeLines
    const MAX_ALTERNATE_GREETINGS = 100;
    if (isFirstChar && char.interfaces?.chat?.GetGreeting) {
      let greetingIndex = 1;
      while (greetingIndex <= MAX_ALTERNATE_GREETINGS) {
        try {
          const _wbGi = wbSpan(chatid, "chatOps", "GetGreeting", { charname, index: greetingIndex });
          const altResult = await char.interfaces?.chat?.GetGreeting(
            request,
            greetingIndex,
          );
          _wbGi({ contentLen: (altResult?.content || "").length, hasResult: !!altResult });
          if (!altResult) {
            break;
          }
          // ★ 额外安全检查：如果返回的 content 为空字符串也视为结束
          if (
            typeof altResult === "object" &&
            !altResult.content &&
            altResult.content !== 0
          ) {
            break;
          }
          const altTimeSlice = timeSlice.copy();
          altTimeSlice.greeting_type = "single";
          altTimeSlice.charname = charname;
          const altEntry = await BuildChatLogEntryFromCharReply(
            altResult,
            altTimeSlice,
            char,
            charname,
            username,
          );
          chatMetadata.timeLines.push(altEntry);
          greetingIndex++;
        } catch (loopErr) {
          // 探针降噪（N25）："Invalid index" 是 char 模板 GetGreeting 的正常循环终止信号（如 贝露 main.mjs
          // `if (index >= greetings.length) throw`），非缺陷——只有其他异常才记 ⚠。
          if (/Invalid index/i.test(loopErr?.message || ""))
            wbTrace(chatid, "chatOps", "addchar:altGreetingLoop:end", { charname, greetings: greetingIndex });
          else
            wbDetect(chatid, "chatOps", "addchar:altGreetingLoop:catch", false, loopErr?.message || String(loopErr), { charname, greetingIndex });
          break;
        }
      }
      if (greetingIndex > MAX_ALTERNATE_GREETINGS) {
        console.warn(
          `[addchar][${diagReqId}] ★ GetGreeting 循环达到上限 ${MAX_ALTERNATE_GREETINGS}，强制终止。角色卡的 GetGreeting 实现可能有问题（永远不返回 null）。charname=${charname}`,
        );
      }
      if (chatMetadata.timeLines.length > 1) {
        broadcastChatEvent(chatid, {
          type: "timeline_info",
          payload: {
            timeLineIndex: 0,
            timeLinesCount: chatMetadata.timeLines.length,
          },
        });
        await saveChat(chatid);
      }
    }

    return greeting_entry;
  } catch (error) {
    console.error(`[addchar DIAG][${diagReqId}] ★ greeting error:`, error);
    wbDetect(chatid, "chatOps", "addchar:catch", false, error?.message || String(error), { charname, name: error?.name });
    // 修复Bug3+4：错误时也保存（角色已经加入了）
    await saveChat(chatid); // RT-4 对齐：return 前 await 落盘
    return null;
  }
}

export async function removechar(chatid, charname) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  delete chatMetadata.LastTimeSlice.chars[charname];
  await saveChat(chatid); // RT-4 对齐：先 await 落盘再广播
  broadcastChatEvent(chatid, { type: "char_removed", payload: { charname } });
}

// ============================================================
// 插件管理
// ============================================================

export async function addplugin(chatid, pluginname) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");

  const { username } = chatMetadata;
  if (chatMetadata.LastTimeSlice.plugins[pluginname]) return;

  chatMetadata.LastTimeSlice.plugins[pluginname] = await loadPart(
    username,
    `plugins/${pluginname}`,
  );
  await saveChat(chatid); // RT-4 对齐：原 broadcast 在 saveChat 前（与其余 mutator 相反）→ 调顺序为先落盘再广播
  broadcastChatEvent(chatid, { type: "plugin_added", payload: { pluginname } });
}

export async function removeplugin(chatid, pluginname) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  delete chatMetadata.LastTimeSlice.plugins[pluginname];
  await saveChat(chatid); // RT-4 对齐：先 await 落盘再广播
  broadcastChatEvent(chatid, {
    type: "plugin_removed",
    payload: { pluginname },
  });
}

// ============================================================
// 人设 & 世界
// ============================================================

export async function setPersona(chatid, personaname) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  const { LastTimeSlice: timeSlice, username } = chatMetadata;
  let player, player_id;
  if (!personaname) {
    player = undefined;
    player_id = undefined;
  } else {
    player = await loadPart(username, `personas/${personaname}`);
    player_id = personaname;
  }
  timeSlice.player = player;
  timeSlice.player_id = player_id;

  await saveChat(chatid); // 始终保存；RT-4 对齐：先 await 落盘再广播
  broadcastChatEvent(chatid, { type: "persona_set", payload: { personaname } });

  // 人设全局同步：persona 设计上全模式共享，同步到同用户所有已加载 chatId
  for (const [cid, data] of chatMetadatas.entries()) {
    if (cid === chatid || data.username !== username) continue;
    if (!data.chatMetadata?.LastTimeSlice) continue;
    data.chatMetadata.LastTimeSlice.player = player;
    data.chatMetadata.LastTimeSlice.player_id = player_id;
    saveChat(cid).catch(e => { console.warn("[chatOps] 跨会话人设同步保存失败:", cid, e?.message || e); });
  }
  broadcastCrossChatEvent(chatid, { type: "persona_set", payload: { personaname } });
}

export async function setWorld(chatid, worldname) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  if (!worldname) {
    chatMetadata.LastTimeSlice.world = undefined;
    chatMetadata.LastTimeSlice.world_id = undefined;
  } else {
    const { username } = chatMetadata;
    chatMetadata.LastTimeSlice.world = await loadPart(
      username,
      `worlds/${worldname}`,
    );
    chatMetadata.LastTimeSlice.world_id = worldname;
  }

  await saveChat(chatid); // RT-4 对齐：先 await 落盘再广播
  broadcastChatEvent(chatid, {
    type: "world_set",
    payload: { worldname: worldname || null },
  });
  return null;
}

// ============================================================
// 查询接口
// ============================================================

export async function getCharListOfChat(chatid) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  return Object.keys(chatMetadata.LastTimeSlice.chars);
}

export async function getPluginListOfChat(chatid) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  return Object.keys(chatMetadata.LastTimeSlice.plugins);
}

export async function GetChatLog(chatid, start, end) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  // _hidden 仅对 AI 隐藏（AI 上下文由 requestBuilder:97 + proxy main/messageTransform 两层过滤，
  // 均不经此接口）；对人类不隐藏：返回含隐藏的完整 chatLog，前端据 extension._hidden 灰显+可恢复。
  // 取消过滤后可见序==原始数组下标，按下标的写操作不再需要可见序映射。
  return chatMetadata.chatLog.slice(start, end);
}

export async function GetChatLogLength(chatid) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  return chatMetadata.chatLog.length;
}

export async function GetVisibleChatLogLength(chatid) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  // 未隐藏(_hidden)的消息数——手动压缩 slider 用，避免把已隐藏计入"可清理"总数。
  return (await getVisibleChatLog(chatid, chatMetadata)).length;
}

/**
 * 可见 chat_log 单一权威：loadChat→过滤 _hidden 的同款表达式（原 requestBuilder:106）。
 * 抽出供 GetPrompt 路径(requestBuilder)与 render 路由共用，彻底单源——
 * 避免两处各写一份 filter(_hidden) 漂移（GetPrompt 与 render 必须看同一份可见上下文）。
 * @param {string} chatid
 * @param {object} [_chatMetadata] 已 loadChat 的 metadata（可省，缺省内部 loadChat）。
 * @returns {Array} 过滤掉 _hidden 的 chatLog 数组（新数组，可安全 push 不污染持久化）
 */
export async function getVisibleChatLog(chatid, _chatMetadata) {
  const chatMetadata = _chatMetadata || (await loadChat(chatid));
  if (!chatMetadata) throw new Error("Chat not found");
  return chatMetadata.chatLog
    .filter(isActiveEntry)
    .map(e => Object.assign(Object.create(Object.getPrototypeOf(e)), e));
}

export async function GetUserPersonaName(chatid) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  return chatMetadata.LastTimeSlice.player_id;
}

export async function GetWorldName(chatid) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  return chatMetadata.LastTimeSlice.world_id;
}

// ============================================================
// 初始数据
// ============================================================

/**
 * 前端打开对话时的初始化数据包（角色/插件/人设/世界 + 最近 20 条消息 + 时间线信息）。
 *
 * 链路：endpoints GET /:chatid/initial-data → 本函数
 * 影响：只读，无写操作
 * 约束：最近 20 条消息经 toData 序列化，失败时有三级 fallback（toData → toJSON → 手工构造）；
 *       含 DIAG 检查：缺 toData 的 entry 记录 constructor/id/keys 供排查数据腐化
 *
 * @param {string} chatid
 * @returns {Promise<{ charlist, pluginlist, worldname, personaname, logLength, initialLog, timeLineIndex, timeLinesCount }>}
 */
export async function getInitialData(chatid) {
  wbTrace(chatid, "chatOps", "getInitialData:enter", null);
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw skip_report(new Error("Chat not found"));
  const timeSlice = chatMetadata.LastTimeSlice;

  // ★ DIAG: 检查 chatLog 中每个 entry 的类型
  const last20 = chatMetadata.chatLog.slice(-20);
  for (let i = 0; i < last20.length; i++) {
    const x = last20[i];
    if (typeof x?.toData !== "function") {
      diag.warn(
        `getInitialData chatLog[${chatMetadata.chatLog.length - last20.length + i}] missing toData.`,
        "constructor:",
        x?.constructor?.name,
        "id:",
        x?.id,
        "avatar:",
        x?.avatar?.substring?.(0, 50),
        "keys:",
        x ? Object.keys(x).join(",") : "null",
      );
    }
  }

  return {
    charlist: Object.keys(timeSlice.chars),
    charLoadFailures: timeSlice.charLoadFailures || {},
    pluginlist: Object.keys(timeSlice.plugins),
    worldname: timeSlice.world_id,
    personaname: timeSlice.player_id,
    logLength: chatMetadata.chatLog.length,
    initialLog: await Promise.all(
      last20.map(async (x, i) => {
        try {
          if (typeof x?.toData === "function")
            return await x.toData(chatMetadata.username);
        } catch (err) {
          diag.error(`getInitialData toData[${i}] failed:`, err.message);
          wbDetect(chatid, "chatOps", "getInitialData:toData:catch", false, err?.message || String(err), { index: i, id: x?.id });
        }
        try {
          if (typeof x?.toJSON === "function") return x.toJSON();
        } catch (err2) {
          diag.error(`getInitialData toJSON[${i}] failed:`, err2.message);
          wbDetect(chatid, "chatOps", "getInitialData:toJSON:catch", false, err2?.message || String(err2), { index: i, id: x?.id });
        }
        // 最终 fallback：确保返回有效对象
        return {
          id: x?.id || crypto.randomUUID(),
          content: x?.content || "",
          // T009 B1-B4：与 toData 出口契约同构（原 fallback 缺两字段=根因3；_editVersion 同批补齐=核验待决1闭环）
          content_for_show: x?.content_for_show ?? null,
          content_for_edit: x?.content_for_edit ?? x?.content ?? "",
          _editVersion: x?._editVersion || 0,
          role: x?.role || "char",
          name: x?.name || "Unknown",
          avatar: x?.avatar || null,
          time_stamp: x?.time_stamp || new Date(),
          files: [],
          is_generating: false,
          timeSlice: { chars: [], plugins: [] },
        };
      }),
    ),
    timeLineIndex: chatMetadata.timeLineIndex,
    timeLinesCount: chatMetadata.timeLines.length,
  };
}
