/**
 * chatOps — 聊天操作层：所有修改对话状态（消息/角色/插件/人设/世界）的写操作 + 只读查询。
 * 不管 AI 生成（那是 generation.mjs 的事）、不管存储路径解析（那是 chatStorage.mjs 的事）、
 * 不管消息构建（那是 messageBuilder.mjs 的事）。
 *
 * 链路：endpoints.mjs → 本模块（写操作）→ chatStorage.saveChat / broadcast.broadcastChatEvent
 *       generation.mjs → 本模块（addChatLogEntry 注入工具结果 system 条）
 *       requestBuilder.mjs → 本模块（getVisibleChatLog 构建 AI 可见上下文 + addChatLogEntry 供插件
 *         request.AddChatLogEntry 回调写入）
 *
 * 影响：每个写操作都遵循 RT-4 契约（先 await saveChat 落盘，再 broadcastChatEvent 推送前端）；
 *       chatLog 就地 push/splice（内存态变更）；广播 WS 事件（message_added/deleted/edited/hidden 等）
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
  saveChat,
  newChat,
  renameChat,
  setModeActiveChat,
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

async function _ensureBotChatImpl(username, charName, platform, { fresh = false, chatid = "", peek = false } = {}) {
  const key = `${platform}|${charName}`;
  const bindings = loadShellData(username, "chat", "bot_chat_bindings");
  const names = loadShellData(username, "chat", "chat_names");
  // 切换到指定已有对话（切换器）：校验存在+属主后写指针，即改即生效
  if (chatid) {
    if (chatMetadatas.get(chatid)?.username !== username)
      throw new Error(`对话 ${chatid} 不存在或不属于当前用户`);
    bindings[key] = chatid;
    saveShellData(username, "chat", "bot_chat_bindings");
    return { chatid, name: names[chatid] || "", created: false };
  }
  if (!fresh) {
    const bound = bindings[key];
    // 指针有效性：对话仍存在且属主匹配（被删除的脏指针视同无，落新建重绑）
    if (bound && chatMetadatas.get(bound)?.username === username) {
      return { chatid: bound, name: names[bound] || `${BOT_CHAT_SYMBOL}[${platform}] ${charName}`, created: false };
    }
    // peek：只查不建（面板回显当前绑定用）
    if (peek) return { chatid: "", name: "", created: false };
  }
  const name = `${BOT_CHAT_SYMBOL}[${platform}] ${charName}`;
  const newId = await newChat(username);
  await renameChat(newId, username, name);
  try {
    await addchar(newId, charName);
  } catch (e) {
    // 角色挂载失败不阻塞（对话已建；角色卡可能瞬时不可加载），留痕供排查
    diag.warn(`ensureBotChat: 角色"${charName}"挂载失败: ${e?.message || e}`);
  }
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
export async function appendBotChatEntry(chatid, msg) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  const new_timeSlice = chatMetadata.LastTimeSlice.copy();
  let entry;
  if (msg.role === "char") {
    entry = await BuildChatLogEntryFromCharReply(
      { name: msg.name, content: msg.content, content_for_show: msg.content_for_show, files: msg.files || [], extension: msg.extension || {} },
      new_timeSlice,
      null,
      msg.charName || msg.name,
      chatMetadata.username,
    );
  } else {
    entry = await BuildChatLogEntryFromUserMessage(
      { name: msg.name, content: msg.content, files: msg.files || [], extension: msg.extension || {} },
      new_timeSlice,
      new_timeSlice.player,
      new_timeSlice.player_id,
      chatMetadata.username,
    );
  }
  // [0726 上下文换源] N42 档位字段透传：`_sourceType`/`_permissionLevel` 由各壳挂在条目上，
  //   消费方 resolveRequestBotPermission(chat_log) 取**尾条**判本轮触发者档位（file_op/delegate/
  //   ideToolCall/modeSwitch 据此裁决）。原先 chat_log 来自壳内存，字段天然在；换成从对话文件读之后，
  //   若此处不透传，尾条就没有这两个字段 → resolveRequestBotPermission 返回 null → 档位门整体失效
  //   （静默降级成"非 bot 来源"，等于所有平台用户拿满权限）。
  //   可行性：entry.toData() 是全量 `{ ...this }` 展开、fromJSON 是 `Object.assign(new, {...json})`，
  //   非白名单，故自定义字段能完整过盘往返。
  if (msg._sourceType) entry._sourceType = msg._sourceType;
  if (Number.isFinite(msg._permissionLevel)) entry._permissionLevel = msg._permissionLevel;
  chatMetadata.LastTimeSlice = entry.timeSlice;
  return addChatLogEntry(chatid, entry);
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
export async function addChatLogEntry(chatid, entry) {
  wbTrace(chatid, "chatOps", "addChatLogEntry:enter", { role: entry?.role, contentLen: entry?.content?.length || 0 });
  const chatMetadata = await loadChat(chatid);

  chatMetadata.chatLog.push(entry);

  // 始终保存
  // ★ RT-4 修：先 await 落盘再 broadcast，避免前端收到 message_added 后 refetch 读到未落盘的旧 chatLog
  wbTrace(chatid, "chatOps", "addChatLogEntry:saveChat_awaited", { chatLogLen: chatMetadata.chatLog.length });
  await saveChat(chatid);
  broadcastChatEvent(chatid, {
    type: "message_added",
    payload: await entry.toData(chatMetadata.username),
  });

  return entry;
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
export async function addUserReply(chatid, object) {
  wbTrace(chatid, "chatOps", "addUserReply:enter", { contentLen: (object?.content || "").length, files: object?.files?.length || 0 });
  const _cmid = typeof object?.client_msg_id === "string" && object.client_msg_id ? object.client_msg_id : null;
  if (_cmid) {
    delete object.client_msg_id;
    const _dupEntry = getRecentUserReply(chatid, _cmid);
    if (_dupEntry) {
      wbTrace(chatid, "chatOps", "addUserReply:idempotent_hit", { client_msg_id: _cmid });
      console.log(`[chatOps] addUserReply 幂等命中（重放不重写）: ${chatid.substring(0, 8)}… id=${_cmid}`);
      return _dupEntry;
    }
  }
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");

  const timeSlice = chatMetadata.LastTimeSlice;
  const new_timeSlice = timeSlice.copy();
  const user = timeSlice.player;

  const entry = await BuildChatLogEntryFromUserMessage(
    object, new_timeSlice, user, new_timeSlice.player_id, chatMetadata.username,
  );
  chatMetadata.timeLines = [entry];
  chatMetadata.timeLineIndex = 0;
  chatMetadata.LastTimeSlice = entry.timeSlice;
  const _added = await addChatLogEntry(chatid, entry);
  if (_cmid) _registerClientMsgId(chatid, _cmid, _added);
  return _added;
}

const _lastActiveEntry = findLastActive;

// ============================================================
// 删除消息
// ============================================================

export async function deleteMessage(chatid, index) {
  wbTrace(chatid, "chatOps", "deleteMessage:enter", { index });
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  // 参数校验：非法值（null/NaN/负数）硬抛；越界或已删除则幂等返回——
  // 回档物理截断后前端可能持有旧索引，越界不应报错（消息已不在）。
  if (index == null || !Number.isFinite(index) || index < 0) throw new Error("Invalid index");
  if (!chatMetadata.chatLog[index] || isDeleted(chatMetadata.chatLog[index])) return;

  const entry = chatMetadata.chatLog[index];
  if (entry) StreamManager.abortByMessageId(entry.id);

  chatLogSnapshot(chatid, chatMetadata.chatLog, "deleteMessage");

  markDeleted(entry, "user");

  const last = _lastActiveEntry(chatMetadata.chatLog);
  chatMetadata.timeLines = last ? [last] : [];
  chatMetadata.timeLineIndex = 0;
  chatMetadata.LastTimeSlice = last ? last.timeSlice : new timeSlice_t();

  await saveChat(chatid);
  broadcastChatEvent(chatid, { type: "message_deleted", payload: { index } });
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
 * @returns {Promise<{ deleted: number }>}
 */
export async function deleteMessagesRange(chatid, startIndex, endIndex) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");

  // 入参为原始数组下标范围（GetChatLog 不再过滤 _hidden，前端/扫描序=原始序）。
  // endIndex 省略=删到末尾，夹在其间的隐藏消息一并删除（符合「删除此点之后全部」语义）。
  const len = chatMetadata.chatLog.length;
  const start = Math.max(0, startIndex);
  const end = endIndex != null ? Math.min(len, endIndex) : len;
  if (start >= end) return { deleted: 0 };

  for (let i = start; i < end; i++) {
    const entry = chatMetadata.chatLog[i];
    if (entry) StreamManager.abortByMessageId(entry.id);
  }

  chatLogSnapshot(chatid, chatMetadata.chatLog, "deleteRange");

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

  await saveChat(chatid);
  broadcastChatEvent(chatid, {
    type: "messages_range_deleted",
    payload: { startIndex: start, count },
  });

  return { deleted: count };
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
 * 约束：T3 支持 opts.ids 按 entry.id 重定位下标，防 TOCTOU（并发增删导致下标漂移而隐藏错对象）
 *       T4 _hiddenMeta 记 who/when/why（by: 'ai'|'auto'|'user'），_hidden 保持布尔不动热路径
 *
 * @param {string} chatid
 * @param {number[]} indices - 原始数组下标
 * @param {boolean} [hide=true]
 * @param {{ ids?: string[], meta?: { by: string, reason?: string } }} [opts]
 * @returns {Promise<{ hidden: number }>} 实际变更数量
 */
export async function hideMessages(chatid, indices, hide = true, opts = {}) {
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  const log = chatMetadata.chatLog;

  // 入参索引基于原始数组下标（GetChatLog 不再过滤 _hidden，前端/扫描序、AI 翻译后序=原始序）。
  // hide/unhide 统一按原始下标处理。
  // T3 定位优先 id：opts.ids 给定则在刚 reload 的 log 里按稳定 entry.id(crypto.randomUUID) 重定位下标，
  // 防 TOCTOU——调用方算下标↔本函数 await loadChat reload 之间并发增删消息致下标漂移而隐藏错对象。缺省回退入参下标。
  let _indices = indices;
  if (Array.isArray(opts.ids) && opts.ids.length) {
    _indices = opts.ids.map((id) => log.findIndex((e) => e?.id === id)).filter((i) => i >= 0);
  }

  // T4 隐藏元数据：旁路字段 _hiddenMeta 记 who/when/why；_hidden 保持布尔不动 prompt 过滤热路径。
  // by: 'ai'(contextClean) | 'auto'(压缩/工具/read_file 刷新) | 'user'(手动端点)，缺省 auto。
  const _meta = hide
    ? { by: opts.meta?.by || "auto", at: Date.now(), reason: opts.meta?.reason || opts.meta?.by || "auto" }
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

  if (changed > 0) {
    await saveChat(chatid); // RT-4 对齐：先 await 落盘再广播
    broadcastChatEvent(chatid, {
      type: "messages_hidden",
      payload: { indices: [..._indices], hide, ...(_meta ? { meta: { by: _meta.by, reason: _meta.reason } } : {}) },
    });
  }

  return { hidden: changed };
}

// ============================================================
// 编辑消息
// ============================================================

export async function editMessage(chatid, index, new_content) {
  wbTrace(chatid, "chatOps", "editMessage:enter", { index });
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  // index 为原始数组下标（GetChatLog 不再过滤 _hidden）
  if (index == null || index < 0 || !chatMetadata.chatLog[index]) return { error: "index out of range", index };
  if (isDeleted(chatMetadata.chatLog[index])) return { error: "message already deleted", index };
  const rawIndex = index;

  const _oldEntry = chatMetadata.chatLog[rawIndex];
  if (_oldEntry) StreamManager.abortByMessageId(_oldEntry.id);

  const timeSlice =
    chatMetadata.chatLog[rawIndex].timeSlice ||
    chatMetadata.LastTimeSlice ||
    new timeSlice_t();
  let entry;
  if (timeSlice.charname) {
    const char = timeSlice.chars?.[timeSlice.charname];
    entry = await BuildChatLogEntryFromCharReply(
      new_content,
      timeSlice,
      char,
      timeSlice.charname,
      chatMetadata.username,
    );
  } else {
    entry = await BuildChatLogEntryFromUserMessage(
      new_content,
      timeSlice,
      timeSlice.player,
      timeSlice.player_id,
      chatMetadata.username,
    );
  }

  // T009 P4：编辑版本号 +1（继承旧 entry 版本）——前端据版本比对丢过期/回声广播，替代 5s 时序锁
  entry._editVersion = (_oldEntry?._editVersion || 0) + 1;

  chatMetadata.chatLog[rawIndex] = entry;
  if (rawIndex == chatMetadata.chatLog.length - 1)
    chatMetadata.timeLines[chatMetadata.timeLineIndex] = entry;

  await saveChat(chatid); // RT-4 对齐：先 await 落盘再广播
  broadcastChatEvent(chatid, {
    type: "message_edited",
    payload: { index, entry: await entry.toData(chatMetadata.username) },
  });

  return entry;
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
 *   对已有角色重复调用不会新建对话。
 * 【每条缺失线】newChat(mode)（建对话+chat_modes 徽标）→ addchar（绑卡+文件迁移+开场白，
 *   与前端 bindCharToChat 路由同一实现）→ setModeActiveChat（「XX窗口在用」指针+跨端广播）。
 * 【失败面】单模式线绑卡失败只跳过该线不中断其余；调用方应 try/catch 使其对建卡主链非致命。
 *
 * @param {string} username
 * @param {string} charName - 角色目录名（与 primaryCharName 同域）
 * @returns {Promise<Record<string,string>>} mode → chatid 四键全量表（已有线返现值，新建线返新值）
 */
export async function ensureModeChatsForChar(username, charName) {
  const WINDOW_MODES = ["chat", "smart", "code", "work"]; // 窗口模式徽标域（chatStorage._VALID_CHAT_MODES 同域，禁与生成模式域混淆）
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
      console.warn(`[chatOps] ensureModeChatsForChar: ${mode} 线绑卡失败，跳过该线:`, e?.message);
      continue;
    }
    const r = await setModeActiveChat(chatid, username, mode);
    if (!r?.success) console.warn(`[chatOps] ensureModeChatsForChar: ${mode} 在用指针写入失败:`, r?.message);
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
