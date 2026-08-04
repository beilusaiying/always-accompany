/**
 * beilu-chat 聊天引擎 — facade 入口
 * 原 ~2017 行文件已拆分为以下子模块：
 *   lib/models.mjs         — 数据结构（timeSlice_t / chatLogEntry_t / chatMetadata_t）
 *   lib/broadcast.mjs      — StreamManager / WebSocket / broadcastChatEvent / typingStatus
 *   lib/chatStorage.mjs    — chatMetadatas / saveChat / loadChat / tryRepairChatPath / initializeChatMetadatas
 *   lib/messageBuilder.mjs — classifyApiError / sanitizeAvatar / BuildChatLogEntry 系列
 *   lib/requestBuilder.mjs — getChatRequest / buildFakeSendRequest
 *   lib/chatOps.mjs        — addChatLogEntry / addchar / removechar / addplugin / removeplugin
 *                            setPersona / setWorld / deleteMessage / deleteMessagesRange
 *                            editMessage / getInitialData / 查询接口
 *   lib/generation.mjs     — executeGeneration / triggerCharReply / modifyTimeLine
 *
 * 本文件仅负责：
 *   1. 初始化（initializeChatMetadatas）
 *   2. 注册事件处理器
 *   3. 重新导出所有公开 API，保持对外接口不变
 */

import { events } from "../../../../../server/events.mjs";
// K13：白盒迁至核心层 server/whitebox.mjs，反向广播改注入。这里启动装配 broadcaster。
import { setBroadcaster } from "../../../../../server/whitebox.mjs";
import { broadcastChatEvent } from "./lib/broadcast.mjs";

// ★ 框架级修复（2026-06-08）：原来这里手写「逐个 import + 逐个 re-export」每个 lib 符号，
//   任何 lib 加了新导出都要在本文件手动补两遍(import + export 块)，漏一个 → endpoints 导入失败
//   → 整个 chat shell 加载崩溃 → 全路由 404（GetVisibleChatLogLength 就是这么漏的）。
//   改为 `export *` 自动透传 5 个 lib 的全部命名导出：lib 新增导出自动可见，永不再漏。
//   5 个 lib 已确认无同名冲突；本地 registerChatUiSocket(包装版) 按 ES 语义 shadow broadcast 的同名。
export * from "./lib/broadcast.mjs";
export * from "./lib/chatOps.mjs";
export * from "./lib/chatStorage.mjs";
export * from "./lib/generation.mjs";
export * from "./lib/requestBuilder.mjs";

// 内部使用（非纯 re-export）的符号显式导入：events 注册 / facade 初始化 / registerChatUiSocket 包装依赖。
import { registerChatUiSocket as _registerChatUiSocket } from "./lib/broadcast.mjs";
import {
  getChatMetadatas,
  saveChat,
  initializeChatMetadatas,
  handleBeforeUserDeleted,
  handleAfterUserDeleted,
  handleUserDeletionAborted,
  handleAfterUserRenamed,
} from "./lib/chatStorage.mjs";

// ============================================================
// 初始化
// ============================================================

initializeChatMetadatas();

// K13：装配白盒 broadcaster（核心层 server/whitebox.mjs ← 壳层 broadcastChatEvent）。
// 这是 whitebox→前端面板的注入边：wb_trace 经此广播到 websocket.mjs → backendMonitor 面板。
setBroadcaster(broadcastChatEvent);

// ============================================================
// 事件处理器注册
// ============================================================

events.on("BeforeUserDeleted", handleBeforeUserDeleted);
events.on("AfterUserDeleted", handleAfterUserDeleted);
events.on("UserDeletionAborted", handleUserDeletionAborted);
events.on("AfterUserRenamed", handleAfterUserRenamed);

// ============================================================
// registerChatUiSocket — 注入 chatStorage 依赖，避免循环引用
// ============================================================

// 本地包装：注入 chatStorage 依赖避免循环引用。本地显式导出 shadow `export * from broadcast` 的同名。
export function registerChatUiSocket(chatid, ws, username) {
  _registerChatUiSocket(chatid, ws, { getChatMetadatas, saveChat }, username);
}
