/**
 * endpoints — beilu-chat 壳的全部 HTTP/WS 路由入口。3 条链路交叉（R1 生成 / R6 回档 / R12 前端）。
 * 不管 AI 生成逻辑（那是 generation.mjs 的事）、不管消息 CRUD 实现（那是 chatOps 的事）、
 * 不管存储路径解析（那是 chatStorage 的事）。本模块只做：HTTP 参数校验 → 委派业务函数 → 序列化响应。
 * 【0802 校验】POST /api/eye/inject（Eye 截图注入，R9 链路）不在本文件——该路由实际注册在
 *   server/web_server/endpoints.mjs，本文件全文 grep 零引用，原头注释误标为本文件链路，已删除该claim。
 *
 * 链路：前端 HTTP/WS → 本模块 → chatOps / chatStorage / generation（triggerCharReply）
 * 影响：全局状态写（__beiluLastUserMessage/AutoSendCount）、磁盘文件操作（角色/人设 CRUD）
 * 相交：← 前端（browser + YonBan webview）
 *       → chat.mjs facade（re-export 的 chatOps/chatStorage/generation 函数）
 *       → parts_loader（loadPart/notifyPartInstall/parts_set）
 *       → ideClient（IDE 桥接 WS token / 手动工具调用）
 *
 * 安全：SEC 破口1 修复 — router.param("chatid") 中央归属校验（chatMetadatas.username vs 请求用户）；
 *       body 中 chatid 的端点（manual-tool-call / group bind / branch）单独 inline 校验。
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                        路由索引（按功能域分类）                           │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                       │
 * │ ■ IDE 桥接                                                            │
 * │   GET  ide/wstoken              — 浏览器代读 IDE WS token              │
 * │   POST ide/connect              — 强制后端 ideClient 立即连接           │
 * │   GET  ide/tool-list            — IDE 公开工具清单（单源 ideClient.availableTools）│
 * │   POST ide/manual-tool-call     — 人工面板工具调用（走后端统一执行闸）    │
 * │                                                                       │
 * │ ■ 多组并行管理（v4）                                                   │
 * │   GET    groups                 — 列出本用户全部组                      │
 * │   POST   groups                 — 新建组                               │
 * │   PUT    groups/:groupId        — 更新组字段                            │
 * │   DELETE groups/:groupId        — 删组（含终止 worker）                  │
 * │   POST   groups/:groupId/role   — 绑定组内角色到 chatid                 │
 * │   DELETE groups/:groupId/role/:role — 解绑组内角色                      │
 * │   GET    groups/engine          — 并行引擎开关状态                      │
 * │   POST   groups/engine          — 切换并行引擎开关                      │
 * │   POST   groups/:groupId/execute — 启动组内全部角色对话                  │
 * │                                                                       │
 * │ ■ 生成并发控制                                                         │
 * │   GET    ai-concurrency         — 读 AI 并发上限（0=不限）              │
 * │   POST   ai-concurrency         — 设 AI 并发上限（写 yonban_config.ai_max_concurrent）│
 * │                                                                       │
 * │ ■ 角色卡管理（从 beilu-home 迁入）                                      │
 * │   POST   create-char            — 创建空白角色卡                        │
 * │   PUT    update-char/:charName  — 更新角色卡字段                        │
 * │   DELETE delete-char/:charName  — 删除角色卡（8步清理）                  │
 * │   POST   import-char            — 导入角色卡 JSON/PNG（含正则+世界书迁移）│
 * │   GET    char/:charName/export  — 导出角色卡 PNG/JSON                   │
 * │   GET    char-data/:charName    — 获取 chardata.json                    │
 * │   GET    char-aisource/:charName — 获取角色绑定 AI 源 + 可用源列表       │
 * │                                                                       │
 * │ ■ 人设管理（从 beilu-home 迁入）                                        │
 * │   POST   persona/create         — 创建人设                             │
 * │   DELETE persona/:name          — 删除人设                             │
 * │   PUT    persona/:name/update   — 更新人设描述+头像                     │
 * │                                                                       │
 * │ ■ 对话生命周期                                                         │
 * │   POST   new                    — 新建空对话                            │
 * │   POST   ensure-mode-chats     — 确保角色卡四窗口对话（幂等，缺失线新建）│
 * │   POST   newbotchat             — bot 对话文件 ensure/新建（一平台一线，幂等）│
 * │   DELETE delete                 — 批量删除对话                          │
 * │   POST   :chatid/rename         — 对话改名（N39）                       │
 * │   POST   :chatid/mode           — 对话模式徽标（服务端持久，对齐N39）     │
 * │   POST   :chatid/using          — 模式窗口在用指针（mode:char→chatid）   │
 * │   POST   :chatid/flags          — 收藏/置顶标记（chat_flags，对齐N39）    │
 * │   POST   branch                 — 对话分叉                             │
 * │   GET    getchatlist            — 获取聊天列表                          │
 * │   POST   search                 — 全文搜索聊天内容                      │
 * │   POST   switch-active          — 跨客户端同步当前活跃对话（YonBan切换通知本体跟随）│
 * │                                                                       │
 * │ ■ 对话消息操作（:chatid 经 router.param 归属校验）                       │
 * │   WS     /ws/.../ui/:chatid     — 聊天 UI WebSocket                    │
 * │   GET    :chatid/initial-data   — 打开对话初始化数据                     │
 * │   GET    :chatid/log            — 获取 chatLog（分页）                   │
 * │   GET    :chatid/log/length     — chatLog 长度（?visible=1 仅未隐藏）    │
 * │   POST   :chatid/message        — 用户发消息（R1 入口）                  │
 * │   PUT    :chatid/message/:index — 编辑消息                              │
 * │   DELETE :chatid/message/:index — 删除单条消息                          │
 * │   POST   :chatid/trigger-reply  — 仅触发 AI 回复（不保存用户消息）        │
 * │   POST   :chatid/messages/delete-range — 批量删除消息范围               │
 * │   POST   :chatid/messages/hide  — 隐藏/取消隐藏消息范围                 │
 * │   PUT    :chatid/timeline       — 切换时间线（greeting swipe）           │
 * │   GET    :chatid/render/entries — D5 regex 激活修复：render 查询         │
 * │   GET    :chatid/airp/view      — AIRP 渲染期视图（符号画/状态块，不进 chatLog）│
 * │                                                                       │
 * │ ■ 对话元数据查询                                                       │
 * │   GET    :chatid/chars          — 对话内角色列表                        │
 * │   GET    :chatid/plugins        — 对话内插件列表                        │
 * │   GET    :chatid/persona        — 当前人设名                            │
 * │   GET    :chatid/world          — 当前世界设定名                        │
 * │   POST   :chatid/char           — 添加角色到对话                        │
 * │   DELETE :chatid/char/:charname — 从对话移除角色                        │
 * │   POST   :chatid/plugin         — 添加插件到对话                        │
 * │   DELETE :chatid/plugin/:pluginname — 从对话移除插件                    │
 * │   PUT    :chatid/world          — 设置世界设定                          │
 * │   PUT    :chatid/persona        — 设置人设                              │
 * │   GET    :chatid/fake-send      — 伪发送（token 预览用）                │
 * │                                                                       │
 * │ ■ 文件/资源                                                            │
 * │   POST   addfile                — 上传文件（hash 存储）                 │
 * │   GET    getfile                — 按 hash 获取文件                      │
 * │   GET    file-delivery/:chatid  — fileDelivery 下载（AI 投递文件）       │
 * │   GET    /virtual_files/.../:chatid — 导出对话 JSON 下载                │
 * │                                                                       │
 * │ ■ 背景图                                                               │
 * │   POST   background             — 上传背景图                           │
 * │   GET    background             — 获取背景图                            │
 * │   DELETE background             — 删除背景图                            │
 * │                                                                       │
 * │ ■ 系统/网络                                                            │
 * │   GET    network-info           — 局域网 IP + 端口                      │
 * │                                                                       │
 * │ ■ 诊断系统（原 beilu-home/diag）                                       │
 * │   GET    diag/status            — 诊断模块状态                          │
 * │   POST   diag/enable            — 启用诊断模块                          │
 * │   POST   diag/disable           — 禁用诊断模块                          │
 * │   POST   diag/level             — 设置诊断级别                          │
 * │   GET    diag/snapshots         — 获取诊断快照                          │
 * │   POST   diag/clear-snapshots   — 清空诊断快照                          │
 * │   GET    diag/logs              — 获取诊断日志                          │
 * │   POST   diag/clear-logs        — 清空诊断日志                          │
 * │                                                                       │
 * │ ■ Browser 插件代理（浏览器自动化 CDP 连接管理）                          │
 * │   GET    plugins/beilu-browser/status — 查询 CDP 连接状态               │
 * │   POST   plugins/beilu-browser/launch — 启动带远程调试端口的 Chrome      │
 * │                                                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs";
import { readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // T019：损坏不静默重建，备份.corrupt.bak后抛错中止
import { sanitizeFilename } from "../../../../../scripts/sanitizeName.mjs"; // 0716 轮子收口：文件名安全清洗共享原语

import {
  authenticate,
  getUserByReq,
  getUserDictionary,
  requireOwner,
} from "../../../../../yonban/core/functions/security/auth.mjs";
import { diagControl } from "../../../../../server/diagLogger.mjs";
import { isPartLoaded, loadPart, notifyPartInstall, parts_set, uninstallPartBase } from "../../../../../server/parts_loader.mjs";
import { loadData, saveData } from "../../../../../server/setting_loader.mjs";
import { sendEventToUser } from "../../../../../server/web_server/event_dispatcher.mjs";
import { confinePath, confineSegment } from "../../../../../yonban/core/functions/security/path_confine.mjs";
import { processImageFiles } from "../../../../../yonban/core/functions/image/imageProcessing.mjs"; // T8·回切：改指 yonban 新位实现体
import { getYonbanConfigPath, loadJsonFileIfExists, patchYonbanConfig, getUserDataDir, addPermanentCharLink, removePermanentCharLink } from "../../../../../yonban/core/functions/memory/storage_mod/storage.mjs"; // T048：group_worker per-user 持久化开关；[T074]getUserDataDir 供 worldbook per-user 路径；charLink：create/import-char 建链、delete-char 断链（凛倾0705「添加角色卡=增加一个永久的链路」）；[T4]patchYonbanConfig 收口 group_worker_enabled 写点（原直接 saveJsonFile 整文件 read-modify-write 与后端子模式写点互覆）

import {
  addchar,
  addplugin,
  addUserReply,
  buildFakeSendRequest,
  deleteChat,
  deleteMessage,
  deleteMessagesRange,
  editMessage,
  getEditOperationReceipt,
  exportChat,
  getCharListOfChat,
  getChatList,
  GetChatLog,
  GetChatLogLength,
  GetVisibleChatLogLength,
  getVisibleChatLog,
  hideMessages,
  getInitialData,
  getPluginListOfChat,
  GetUserPersonaName,
  GetWorldName,
  modifyTimeLine,
  newChat,
  registerChatUiSocket,
  removechar,
  removeplugin,
  renameChat,
  setChatFlags,
  setChatMode,
  setModeActiveChat,
  setPersona,
  setWorld,
  cancelAutoContinue,
  triggerCharReply,
} from "./chat.mjs";
import { addfile, getfile } from "./files.mjs";
import {
  prepareEditMessageRequest,
  prepareEditOperationIdentity,
} from "./lib/editMessageRequest.mjs";
// B16: WS token 解析单一权威 —— 与 ideClient（后端→IDE 客户端）共用同一实现，
// 防双实现路径漂移（前端代读端点与后端客户端读到不同 token/端口）。
import { resolveIdeWsToken, ideClient } from "../../../../../yonban/core/transport/ideClient.mjs"; // T066：ideClient 迁 transport，改指 yonban 新位实现体
// D-4 路B：手动工具调用经后端 ideClient（统一执行闸）+ 结果作 _hidden 的 IDE工具结果 条目接入对话。
import { addChatLogEntry, ensureBotChat, ensureModeChatsForChar, getRecentUserReply } from "./lib/chatOps.mjs"; // getRecentUserReply=0719 幂等窗查询（POST message 重放判定）；ensureModeChatsForChar=0731 四窗口对话收口
// [P0-A 2026-08-03] Smart 提案确认协调器：提案由 replyHandler 硬门产生（pending 非 running），
// 确认/取消/状态三端点只信 session owner + 单次 claim；目标线复用 ensureModeChatsForChar 单源。
import {
  claimConfirmation,
  completeClaim,
  failClaim,
  cancelConfirmation,
  listConfirmations,
  projectConfirmation,
} from "./lib/confirmationStore.mjs";
// 目标线模式绑定（active_modes_map[chatId]，投递线 INJ/预设解析依赖）——直调 yonban 权威写点
import { setActiveMode } from "../../../../../yonban/core/functions/memory/storage_mod/storage.mjs";
// task_start 文本走可编辑注入文本链（铁律：代码不持进 messages 的提示词）
import { fillInjectText } from "../../../../../yonban/core/functions/injectTexts/main.mjs";

const REQUIRED_MODE_CHAT_MODES = ["chat", "smart", "code", "work"];
function getMissingModeChatModes(modeChats) {
  return REQUIRED_MODE_CHAT_MODES.filter((mode) => !modeChats?.[mode]);
}
import { branchChat, loadChat, getChatMetadatas } from "./lib/chatStorage.mjs";
import { broadcastUserActiveChat } from "./lib/broadcast.mjs";
import { chatLogEntry_t } from "./lib/models.mjs";
import { safeTrash, safeUnlink } from "../../../../../yonban/core/functions/rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体
import {
  executeRollback as executeCoordinatedRollback,
  getRollbackPreview as getCoordinatedRollbackPreview,
} from "../../../../../yonban/core/functions/rollback/rollbackCoordinator.mjs";
import { isDeleted } from "../../../../../yonban/core/functions/hide/chatEntryUtils.mjs"; // T8·回切：改指 yonban 新位实现体
// 多组并行 v4：组管理 API 的单一权威源（chatid→groupId 映射 + 广播按组 scope 的依据）
import {
  getGroupRegistry,
  createGroup,
  removeGroup,
  updateGroup,
  setGroupRole,
  clearGroupRole,
} from "./lib/groupRegistry.mjs";
// 删组时同步终止该组常驻 worker（removeGroup 只删注册表；worker 生命周期在 manager）。
import { terminateGroupWorker } from "./lib/groupWorkerManager.mjs";
import { wbT, wbD } from "../../../../../server/wbStub.mjs";

// 人设模板目录（从 beilu-home 迁入，persona create 时复制 main.mjs）
const PERSONA_TEMPLATE_DIR = path.join(
  import.meta.dirname,
  "persona-template",
);

// 角色卡模板目录（仍位于 beilu-home 下，import-char 创建角色卡时复制 main.mjs）
// 注意：此模块级声明被 setEndpoints() 内部同名 const 遮蔽（:482），实际使用的是内部声明。
// 两处路径相同（均指向 beilu-home/beilu-char-template），行为不影响，但存在重复声明。
const CHAR_TEMPLATE_DIR = path.join(
  import.meta.dirname,
  "../../beilu-home/beilu-char-template",
);

/**
 * 为聊天功能设置API端点。
 *
 * @param {import('npm:websocket-express').Router} router - Express路由实例，用于附加端点。
 */
// G1: 解析 YonBan IDE 桥接 WS token 由 ideClient.mjs 的 resolveIdeWsToken 单一权威提供（B16）。
// 浏览器侧 ideConnPanel 无文件系统访问，故由本后端（与 YonBan 同 OS 用户）代读后下发；
// 后端→IDE 客户端 ideClient 走同一函数，二者读到的 token/端口必然一致。

// /log 端点日志去重：前端轮询/切换频繁调用 → 原 DIAG P0 每次打整批 entry 刷屏。
// 按 chatid 记上次响应签名（条数+ids），相同则不打，变化或有问题才打。
const _lastLogDiag = new Map();

// 路由不能用 parseInt："1abc" 会被静默解释为 1，"" 还会被 Number 解释为 0。
// 消息索引是持久化写操作的兼容提示，必须是明确的非负整数。
function parseNonNegativeInteger(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function setEndpoints(router) {
  // SEC（红方 round2 隔离审计·破口1）：chatid 是全局命名空间，:chatid 端点原只 authenticate 不校验属主
  //   → A 持/猜 B 的 chatid 可读/改/删 B 对话、触发 B 的 AI（用 B 的 serviceSource/API 凭证、烧 B 额度）。
  //   chatMetadatas[chatid].username 是权威属主（与 getChatList/deleteChat 同源）。中央 router.param 对
  //   所有 :chatid 路由统一校验所有权。WsAbleRouter 的 .ws 经 router.get 注册 → param 同样覆盖 WS 路由；
  //   但 WS 的 res 是 mock 无 .status()，故拒绝走 req.ws.fail()。新建 chat 经 newChat 先注册属主再返
  //   chatid → guard 不误伤新建。body 带 chatid 的端点（manual-tool-call / group bind）router.param 不
  //   触发，单独 inline 校验。
  const _denyChat = (req, res, code, msg) => {
    if (req.ws) { try { req.ws.fail(); } catch { /* socket 可能已毁 */ } return; }
    res.status(code).json({ error: msg });
  };
  const _assertChatOwner = async (req, res, chatid) => {
    const { username } = await getUserByReq(req);
    const metas = getChatMetadatas();
    let meta = metas.get(chatid);
    if (!meta) { try { await loadChat(chatid); } catch { /* ignore */ } meta = metas.get(chatid); } // loadChat 内部扫盘自愈
    if (!meta) { _denyChat(req, res, 404, "会话不存在"); return false; }
    if (meta.username !== username) { _denyChat(req, res, 403, "无权访问该会话"); return false; }
    return true;
  };
  router.param("chatid", async (req, res, next, chatid) => {
    if (await _assertChatOwner(req, res, chatid)) next();
  });

  // 07-09 时序洞修（storage.mjs:1798 自曝）：模式定义注册链原挂首次生成（prompt_struct→shadowBuild→getModeDef），
  //   「先切自定义模式后首次生成」时 isValidModeId 拒（modes/*.json 的自定义模式还没注册进 _validModeIds）。
  //   此处启动即预热——fire-and-forget 动态 import（同 prompt_struct 范式，不把 yonban pipelines 静态耦合进壳
  //   加载时序），失败仅告警（首次生成 getModeDef 会重试，行为回到修复前）。
  // 07-20 预热死件修：validateModeDef 查 dispatch registry，而 registry 只靠 all.mjs import 副作用填
  //   （yonban_bridge 首请求惰性 / shadowBuild 首次生成）——启动时必空，预热必抛「点了未注册功能」，
  //   registerModeIds/registerInjectionScopes 全没跑到，时序洞实际没关。收口=先装 registry 自举单点
  //   all.mjs（与桥同一 import，同进程幂等，只是提前），再 loadModeDefs；scheduler.mjs 的重试版预热同步受益。
  import("../../../../../yonban/core/functions/all.mjs")
    .then(() => import("../../../../../yonban/pipelines/_runtime/runner.mjs"))
    .then((m) => m.loadModeDefs())
    .catch((e) => console.warn("[chat/endpoints] 模式定义预热失败(首次生成时重试):", e?.message));

  // G1: 已登录浏览器取 IDE WS token（YonBan 服务端写到工作区无关的全局路径，本后端代读）
  router.get(
    "/api/parts/shells\\:chat/ide/wstoken",
    authenticate,
    async (req, res) => {
      try {
        const { token, port } = resolveIdeWsToken();
        res.status(200).json({ token, port });
      } catch (err) {
        console.error("[chat/endpoints] ide/wstoken 失败:", err.message);
        res.status(500).json({ error: err.message, token: "", port: null });
      }
    },
  );

  // [0730] 对话切换广播：任何客户端（YonBan/外部面板）切换对话时调此端点，
  // 后端广播 peer_active_chat → 本体前端跟随切换（websocket.mjs:1169 消费）。
  // 解决 YonBan 切对话时本体不同步：YonBan 前端不经过 WS 重建，手动触发广播。
  router.post(
    "/api/parts/shells\\:chat/switch-active",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const chatid = req.body?.chatid;
        if (!chatid) return res.status(400).json({ error: "缺少 chatid" });
        if (!(await _assertChatOwner(req, res, chatid))) return;
        broadcastUserActiveChat(chatid, "attach");
        res.status(200).json({ ok: true, chatid });
      } catch (err) {
        console.error("[chat/switch-active] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 连接识别修复（2026-06-15）：前端 ideConnPanel 连上浏览器那条 WS 后调本端点，
  // 强制后端 ideClient（getPromptHandler 选 INJ 看的就是它）立即连一次，绕开指数退避窗口。
  // 根因：前端连接(浏览器↔YonBan) 与 后端连接(Deno↔YonBan) 解耦，前端"已连接"≠后端 isConnected。
  router.post(
    "/api/parts/shells\\:chat/ide/connect",
    authenticate,
    async (_req, res) => {
      try {
        try { ideClient._clearReconnectTimer?.(); } catch { /* ignore */ }
        if (!ideClient.isConnected) ideClient.connect({ autoReconnect: true });
        // 给握手一点时间再回报状态（不阻塞太久）
        await new Promise((r) => setTimeout(r, 400));
        res.status(200).json({ connected: ideClient.isConnected });
      } catch (err) {
        console.error("[chat/endpoints] ide/connect 失败:", err.message);
        res.status(500).json({ error: err.message, connected: false });
      }
    },
  );


  // 2026-07-09 收口审计（D4）：IDE 公开工具清单下发——单源=ideClient.availableTools（IDE_TOOLS 结构化
  //   定义，与 YonBan ToolExecutor 对齐）。原前端 ideConnPanel._TOOLCALL_TOOLS 硬编码 20 个落后实际
  //   工具集（git_*/edit_xlsx 等无法手动测），前端改拉本端点，静态清单降级为离线兜底。
  router.get(
    "/api/parts/shells\\:chat/ide/tool-list",
    authenticate,
    async (_req, res) => {
      try {
        const tools = (ideClient.availableTools || []).map((t) => t.name);
        res.status(200).json({ tools });
      } catch (err) {
        console.error("[chat/endpoints] ide/tool-list 失败:", err.message);
        res.status(500).json({ error: err.message, tools: [] });
      }
    },
  );

  // D-4 框架修复（路B）：人工面板的工具调用改走后端 ideClient.callTool（与 AI 同一统一执行闸
  // gateToolExecution，source=frontend），不再走浏览器平行 WS 直发 YonBan（那条绕过本体全部门控）。
  // 结果作 _hidden 的 "IDE工具结果" 条目接入对话——前端渲染为折叠结果卡(messageList:782 _opType 特判先于隐藏)、
  // 但 requestBuilder:106 按 _hidden 滤出 AI 上下文 = 用户能看、AI 看不到（与 thinking 同款语义）。
  router.post(
    "/api/parts/shells\\:chat/ide/manual-tool-call",
    authenticate,
    async (req, res) => {
      try {
        const { chatid, tool, params = {} } = req.body || {};
        if (!chatid || !tool) {
          res.status(400).json({ error: "缺少 chatid 或 tool" });
          return;
        }
        // SEC 破口1：chatid 来自 body，router.param 不触发 → inline 校验属主，防 A 借工具调用操作 B 的会话。
        if (!(await _assertChatOwner(req, res, chatid))) return;
        const { username } = await getUserByReq(req);
        const traceId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const result = await ideClient.callTool(tool, params, undefined, traceId, {
          source: "frontend",
          chatid,
          ownerUsername: username,
        });

        const ok = !!result?.success;
        const body = ok
          ? (typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "(无返回)", null, 2))
          : (result?.error || "未知错误");
        const content = `${ok ? "✅" : "❌"} [手动 IDE 工具] ${tool}\n${body}`;

        const chatMetadata = await loadChat(chatid);
        if (chatMetadata) {
          const entry = new chatLogEntry_t();
          entry.role = "system";
          entry.name = "IDE工具结果";
          entry.content = content;
          entry.extension = {
            _opType: "ide_tool_result",
            _hidden: true, // ★ 仅用户折叠可见，不喂 AI
            ideToolEvents: [{ tool, ok, subject: typeof params?.path === "string" ? params.path : "" }],
          };
          entry.timeSlice = chatMetadata.LastTimeSlice.copy();
          entry.time_stamp = new Date();
          entry.is_generating = false;
          await addChatLogEntry(chatid, entry);
        }
        res.status(200).json({ ok, result });
      } catch (err) {
        console.error("[chat/endpoints] ide/manual-tool-call 失败:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ============================================================
  // 多组并行 v4 · 组管理 API（三栏 UI / 命令的入口；激活已建的 groupRegistry +
  // broadcastCrossChatEvent 按组 scope + dispatchActivation 跨窗口唤醒——此前无入口创建组而全为死码）
  // ============================================================

  // 列出本用户全部组（左栏 组→角色 列表 / 右栏运行态用）
  router.get(
    "/api/parts/shells\\:chat/groups",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        res.json({ groups: getGroupRegistry(username) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 新建组 {projectName?, workspaceRoot?} → { groupId }
  router.post(
    "/api/parts/shells\\:chat/groups",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { projectName = "", workspaceRoot = "" } = req.body || {};
        const groupId = createGroup(username, { projectName, workspaceRoot });
        res.json({ groupId });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 更新组字段 {projectName?, workspaceRoot?, status?}
  router.put(
    "/api/parts/shells\\:chat/groups/:groupId",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const ok = updateGroup(username, req.params.groupId, req.body || {});
        if (!ok) return res.status(404).json({ error: "组不存在" });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 删组
  router.delete(
    "/api/parts/shells\\:chat/groups/:groupId",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const ok = removeGroup(username, req.params.groupId);
        if (!ok) return res.status(404).json({ error: "组不存在" });
        // 终止该组常驻 worker（无 worker 时 no-op）；gated 下默认无 worker，安全。
        try { terminateGroupWorker(req.params.groupId); } catch (_) { /* 终止失败不影响删组 */ }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 绑定组内某角色到某 chatid {role, chatid}（建立 chatid→groupId 映射）
  router.post(
    "/api/parts/shells\\:chat/groups/:groupId/role",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { role, chatid } = req.body || {};
        if (!role || !chatid) return res.status(400).json({ error: "缺少 role 或 chatid" });
        // SEC 破口1（同根间接向）：禁止把他人 chatid 绑进自己组（否则组操作会 loadChat 他人会话）。
        if (!(await _assertChatOwner(req, res, chatid))) return;
        const ok = setGroupRole(username, req.params.groupId, role, chatid);
        if (!ok) return res.status(404).json({ error: "组不存在" });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 解绑组内某角色
  router.delete(
    "/api/parts/shells\\:chat/groups/:groupId/role/:role",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const ok = clearGroupRole(username, req.params.groupId, req.params.role);
        if (!ok) return res.status(404).json({ error: "角色未绑定" });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 并行引擎开关（T048：per-user 持久化配置，前端 toggle 用；原 process.env 进程全局态=多用户串台+重启易失）
  router.get(
    "/api/parts/shells\\:chat/groups/engine",
    authenticate,
    async (req, res) => {
      // T048：读该 user 的 yonban_config.group_worker_enabled（严格 ===true，缺失/怪值→OFF 安全默认）
      const { username } = await getUserByReq(req);
      const cfg = loadJsonFileIfExists(getYonbanConfigPath(username), {});
      res.json({ enabled: cfg.group_worker_enabled === true });
    },
  );
  router.post(
    "/api/parts/shells\\:chat/groups/engine",
    requireOwner,
    async (req, res) => {
      // T048：requireOwner 内已 try_auth_request 设 req.user；写该 owner user 自己的持久化开关（不再写进程全局 env）
      const { username } = await getUserByReq(req);
      const { enabled } = req.body || {};
      // T4 收口：走 patchYonbanConfig 串行锁（原 load→改 group_worker_enabled→saveJsonFile 整文件
      //   read-modify-write 无锁，与后端子模式/分身写点并发时互覆字段）。行为等价：仍只写此单字段。
      const cfg = await patchYonbanConfig(username, { group_worker_enabled: !!enabled }, {});
      res.json({ enabled: cfg.group_worker_enabled === true });
    },
  );

  // [0727 并发闸] AI 并发上限（0=不限）：用户可设「同时最多几路 AI 在跑」（凛倾：3窗×5分身=18路需可调）。
  //   存 yonban_config.ai_max_concurrent（后端单源，patchYonbanConfig 串行锁写）；
  //   消费点 = proxy/lib/aiConcurrencyGate.mjs（httpFetch 出站必经点每次现读 → 改动即时生效，不需重启）。
  router.get(
    "/api/parts/shells\\:chat/ai-concurrency",
    authenticate,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const cfg = loadJsonFileIfExists(getYonbanConfigPath(username), {});
      const n = Number(cfg.ai_max_concurrent);
      res.json({ limit: Number.isInteger(n) && n > 0 ? n : 0 });
    },
  );
  router.post(
    "/api/parts/shells\\:chat/ai-concurrency",
    requireOwner,
    async (req, res) => {
      const { username } = await getUserByReq(req);
      const n = Number(req.body?.limit);
      if (!Number.isInteger(n) || n < 0 || n > 99) {
        return res.status(400).json({ error: "limit 需为 0-99 整数（0=不限）", code: "INVALID_LIMIT" });
      }
      const cfg = await patchYonbanConfig(username, { ai_max_concurrent: n }, {});
      res.json({ limit: Number(cfg.ai_max_concurrent) || 0 });
    },
  );

  // 启动组内所有已绑角色的对话（触发 triggerCharReply）
  router.post(
    "/api/parts/shells\\:chat/groups/:groupId/execute",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const groups = getGroupRegistry(username);
        const group = groups[req.params.groupId];
        if (!group) return res.status(404).json({ error: "组不存在" });
        const roles = group.roles || {};
        const chatids = [...new Set(Object.values(roles))].filter(Boolean);
        if (!chatids.length) return res.status(400).json({ error: "组内无已绑角色" });
        const results = [];
        for (const cid of chatids) {
          try {
            await triggerCharReply(cid);
            results.push({ chatid: cid, ok: true });
          } catch (err) {
            results.push({ chatid: cid, ok: false, error: err.message });
          }
        }
        res.json({ triggered: results });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ============================================================
  // 从 beilu-home 壳迁入的路由（beilu-home UI 已废弃，后端路由收敛到此）
  // ============================================================

  // ---- 角色卡模板目录（create-char 复制 main.mjs 用） ----
  const CHAR_TEMPLATE_DIR = path.join(import.meta.dirname, "../../beilu-home/beilu-char-template");

  // POST /api/parts/shells:chat/create-char — 创建空白角色卡（原 beilu-home/create-char）
  router.post(
    "/api/parts/shells\\:chat/create-char",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { name } = req.body || {};

        if (!name || typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ message: "角色名称不能为空" });
        }

        const charName = name.trim();
        // 安全检查：禁止路径穿越字符
        if (/[\/\\:*?"<>|]/.test(charName)) {
          return res.status(400).json({ message: "角色名称包含非法字符" });
        }

        const userDir = getUserDictionary(username);
        const charDir = path.join(userDir, "chars", charName);

        if (fs.existsSync(charDir)) {
          return res
            .status(409)
            .json({ message: `角色 "${charName}" 已存在` });
        }

        // 创建目录
        fs.mkdirSync(charDir, { recursive: true });

        // 复制 beilu 角色卡模板 main.mjs（保持与导入角色卡结构一致）
        const templateMain = path.join(CHAR_TEMPLATE_DIR, "main.mjs");
        if (fs.existsSync(templateMain)) {
          fs.copyFileSync(templateMain, path.join(charDir, "main.mjs"));
        } else {
          console.warn(
            "[beilu-chat] 角色卡模板 main.mjs 不存在，空白角色卡可能缺少 main.mjs",
          );
        }

        // 写入 beilu-part.json
        nicerWriteFileSync(
          path.join(charDir, "beilu-part.json"),
          JSON.stringify({ type: "chars", dirname: charName }, null, "\t"),
          "utf-8",
        );

        // 写入 info.json（最小的多语言信息）
        const infoData = {
          "zh-CN": {
            name: charName,
            avatar: "",
            description: "",
            version: "0.1.0",
            author: username,
            tags: [],
          },
          "en-UK": {
            name: charName,
            avatar: "",
            description: "",
            version: "0.1.0",
            author: username,
            tags: [],
          },
        };
        nicerWriteFileSync(
          path.join(charDir, "info.json"),
          JSON.stringify(infoData, null, "\t"),
          "utf-8",
        );

        // 写入 chardata.json（空白角色卡初始数据）
        const chardata = {
          name: charName,
          description: "",
          personality: "",
          scenario: "",
          first_mes: "",
          mes_example: "",
          system_prompt: "",
          post_history_instructions: "",
          creator_notes: "",
          creator: username,
          character_version: "0.1.0",
          tags: [],
          alternate_greetings: [],
          extensions: {},
        };
        nicerWriteFileSync(
          path.join(charDir, "chardata.json"),
          JSON.stringify(chardata, null, "\t"),
          "utf-8",
        );

        // 为新角色自动分配默认 AIsource
        try {
          const parts_config = loadData(username, "parts_config");
          let defaultAIsource = "";
          // 策略1: 复用已有角色卡的 AIsource
          for (const [key, val] of Object.entries(parts_config)) {
            if (key.startsWith("chars/") && val?.AIsource) {
              defaultAIsource = val.AIsource;
              break;
            }
          }
          // 策略2: 找 generator === "proxy" 的第一个 AI 源
          if (!defaultAIsource) {
            for (const [key, val] of Object.entries(parts_config)) {
              if (
                key.startsWith("serviceSources/AI/") &&
                val?.generator === "proxy"
              ) {
                defaultAIsource = key.replace("serviceSources/AI/", "");
                break;
              }
            }
          }
          if (defaultAIsource) {
            parts_config[`chars/${charName}`] = {
              AIsource: defaultAIsource,
              plugins: [],
            };
            saveData(username, "parts_config");
            console.log(
              `[beilu-chat] 新角色自动配置 AIsource: "${defaultAIsource}" → chars/${charName}`,
            );
          }
        } catch (e) {
          console.warn(
            "[beilu-chat] 新角色自动配置 AIsource 失败:",
            e.message,
          );
        }

        // 通知 beilu 刷新 parts 缓存
        try {
          notifyPartInstall(username, `chars/${charName}`);
        } catch (e) {
          console.warn("[beilu-chat] notifyPartInstall 失败:", e.message);
        }

        console.log(
          `[beilu-chat] 角色卡已创建: "${charName}" (user: ${username})`,
        );
        // 添加角色卡=建永久链路（凛倾0705拍板；单源 storage.addPermanentCharLink，与 addCharLink verb 同落盘）
        try { await addPermanentCharLink(username, charName); } catch (e) { console.warn("[beilu-chat] 建永久链路失败(非致命):", e.message); } // T4：now async，await 保留错误被此 try/catch 捕获
        try { sendEventToUser(username, "char-data-changed", { charName, created: true }); } catch (e) { console.warn("[同步广播] char-data-changed(created) 推送失败(不阻塞创建):", e?.message); }
        // 角色卡创建完成不等于四个模式的作业线已经成立。不能把缺线当作成功返回，
        // 否则前端会带着一个共享/缺失对话继续运行，直到用户切窗才暴露问题。
        const modeChats = await ensureModeChatsForChar(username, charName);
        const missingModes = getMissingModeChatModes(modeChats);
        if (missingModes.length) {
          return res.status(409).json({
            success: false,
            partial: true,
            code: "E_MODE_CHAT_INCOMPLETE",
            name: charName,
            modeChats,
            missingModes,
            error: `角色卡已创建，但模式对话未建全: ${missingModes.join(", ")}`,
          });
        }
        res.status(201).json({ success: true, name: charName, modeChats });
      } catch (error) {
        console.error("[beilu-chat] Error creating char:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // PUT /api/parts/shells:chat/update-char/:charName — 更新角色卡（原 beilu-home/update-char）
  router.put(
    "/api/parts/shells\\:chat/update-char/:charName",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const charName = confineSegment(req.params.charName);

        if (!charName) {
          return res.status(400).json({ message: "缺少角色名称" });
        }

        const userDir = getUserDictionary(username);
        const charDir = path.join(userDir, "chars", charName);

        if (!fs.existsSync(charDir)) {
          return res
            .status(404)
            .json({ message: `角色 "${charName}" 不存在` });
        }

        const chardataPath = path.join(charDir, "chardata.json");
        let chardata = {};
        if (fs.existsSync(chardataPath)) {
          chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
        }

        // 更新文本字段
        const updates = req.body || {};
        const allowedFields = [
          "name",
          "first_mes",
          "description",
          "personality",
          "scenario",
          "mes_example",
          "system_prompt",
          "post_history_instructions",
          "creator_notes",
        ];
        let changed = false;
        for (const field of allowedFields) {
          if (updates[field] !== undefined) {
            chardata[field] = updates[field];
            changed = true;
          }
        }

        // extensions 深度合并更新（支持修改 tavern_helper.scripts 等嵌套字段）
        if (updates.extensions && typeof updates.extensions === "object") {
          if (
            !chardata.extensions ||
            typeof chardata.extensions !== "object"
          ) {
            chardata.extensions = {};
          }
          // 递归浅合并第一层 key（如 tavern_helper）
          const _UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])
          for (const [extKey, extVal] of Object.entries(updates.extensions)) {
            if (_UNSAFE_KEYS.has(extKey)) continue
            if (
              extVal &&
              typeof extVal === "object" &&
              !Array.isArray(extVal)
            ) {
              if (
                !chardata.extensions[extKey] ||
                typeof chardata.extensions[extKey] !== "object"
              ) {
                chardata.extensions[extKey] = {};
              }
              Object.assign(chardata.extensions[extKey], extVal);
            } else {
              chardata.extensions[extKey] = extVal;
            }
          }
          changed = true;
        }
        // alternate_greetings 数组（兼容 FormData 字符串传输）
        let altGreetings = updates.alternate_greetings;
        if (typeof altGreetings === "string") {
          try {
            altGreetings = JSON.parse(altGreetings);
          } catch (_) {
            altGreetings = null;
          }
        }
        if (Array.isArray(altGreetings)) {
          chardata.alternate_greetings = altGreetings;
          changed = true;
        }

        if (changed) {
          nicerWriteFileSync(
            chardataPath,
            JSON.stringify(chardata, null, "\t"),
            "utf-8",
          );
        }

        // 如果 name 字段变更，同步更新 info.json
        if (updates.name !== undefined) {
          const infoPath = path.join(charDir, "info.json");
          if (fs.existsSync(infoPath)) {
            const infoData = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
            for (const lang of Object.keys(infoData)) {
              if (typeof infoData[lang] === "object") {
                infoData[lang].name = updates.name;
              }
            }
            nicerWriteFileSync(
              infoPath,
              JSON.stringify(infoData, null, "\t"),
              "utf-8",
            );
          }
        }

        // 处理头像上传
        const avatarFile = req.files?.avatar;
        if (avatarFile) {
          // ★ F-D5 XSS：头像与 import-char 落盘同为 public/image.png，是同型上传 XSS 面。
          //   magic bytes 断言拒 SVG(内联脚本)/伪装 polyglot；再 data_reader.remove 重序列化 PNG
          //   丢弃 IEND 后尾随字节，剥除 polyglot 尾部 HTML。非法→400 拒绝，不写盘。
          const { assertSafeCharImage } = await import(
            "../../../ImportHandlers/SillyTavern/main.mjs"
          );
          try {
            await assertSafeCharImage(avatarFile.data);
          } catch (imgErr) {
            return res.status(400).json({ message: imgErr.message });
          }
          const dataReader = await import(
            "../../../ImportHandlers/SillyTavern/data_reader.mjs"
          );
          const publicDir = path.join(charDir, "public");
          fs.mkdirSync(publicDir, { recursive: true });
          fs.writeFileSync(
            path.join(publicDir, "image.png"),
            dataReader.remove(avatarFile.data),
          );
        }

        // 清除 parts_details_cache 以刷新
        try {
          const cache = loadData(username, "parts_details_cache");
          delete cache[`chars/${charName}`];
          saveData(username, "parts_details_cache");
        } catch (_) {
          /* 静默 */
        }

        console.log(
          `[beilu-chat] 角色卡已更新: "${charName}" (user: ${username})`,
        );
        // [2026-08-01 改卡不重载修] 盘已更新，刷新已加载角色的模块级 chardata 内存态：
        //   两种角色模板的 SetData({chardata}) 均支持就地刷新内存（SillyTavern :110-112 原有，
        //   beilu-char-template 本次补齐）。未加载的角色（首次使用时从盘读，无陈旧态）跳过。
        //   失败不阻断保存——模板可能无 SetData 或角色已卸载。
        const _charPartpath = `chars/${charName}`;
        if (changed && isPartLoaded(username, _charPartpath)) {
          try {
            const _charPart = await loadPart(username, _charPartpath);
            await _charPart.interfaces?.config?.SetData?.({ chardata });
          } catch (e) { console.warn(`[beilu-chat] 改卡后刷新内存态失败(盘已保存): ${e?.message}`); }
        }
        // 跨客户端：通知该用户所有端，正在看此卡的角色信息面板/选卡器重载
        try { sendEventToUser(username, "char-data-changed", { charName }); } catch (e) { console.warn("[同步广播] char-data-changed 推送失败(不阻塞保存):", e?.message); }
        res.status(200).json({ success: true, name: charName, chardata });
      } catch (error) {
        console.error("[beilu-chat] Error updating char:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // [D1 §4 删除契约·单源分类+指纹] preview 端点与 delete-char 执行侧共用本函数——
  //   [0804 反方补修] 原两处各写一份分类+djb2 逻辑（注释自认"改一处须同步另一处"）：漂移则指纹
  //   恒不符（删除永远被拒）或恒相符（预览失去保护），两个方向都危险，故抽单源。
  //   分类：managedModeChats（四模式指针受管理线）/extraOwnedChats（同角色额外自有）/diskExtraChats
  //   （chars/<char>/chats 磁盘存在但内存索引缺，执行时经 deleteChat 做 owner 验证）/legacyCandidates
  //   （旧路径 shells/chat/chats 按 timeSlice.chars 弱归属，仅候选默认不删）。
  //   previewRevision=分类结果指纹（djb2，无 crypto 依赖）。
  function _computeDeleteCharPreview(username, charName) {
    const userDir = getUserDictionary(username);
    const charDir = path.join(userDir, "chars", charName);
    const chatShell = parts_set[username]?.["shells/beilu-chat"];
    let cls = { managedModeChats: [], extraOwnedChats: [], managedChatIds: [] };
    if (chatShell?.interfaces?.chat?.classifyCharChatsForDeletion) {
      cls = chatShell.interfaces.chat.classifyCharChatsForDeletion(username, charName);
    }
    const knownIds = new Set([...(cls.managedChatIds || []), ...(cls.extraOwnedChats || [])]);
    const diskExtraChats = [];
    const chatsDir = path.join(charDir, "chats");
    if (fs.existsSync(chatsDir)) {
      for (const f of fs.readdirSync(chatsDir).filter((x) => x.endsWith(".json"))) {
        const id = f.replace(/\.json$/, "");
        if (!knownIds.has(id)) diskExtraChats.push(id);
      }
    }
    const legacyCandidates = [];
    const oldChatsDir = path.join(userDir, "shells", "chat", "chats");
    if (fs.existsSync(oldChatsDir)) {
      for (const f of fs.readdirSync(oldChatsDir).filter((x) => x.endsWith(".json"))) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(oldChatsDir, f), "utf-8"));
          const chars = raw.chatLog?.[raw.chatLog.length - 1]?.timeSlice?.chars || [];
          if (Array.isArray(chars) && chars.includes(charName)) legacyCandidates.push(f.replace(/\.json$/, ""));
        } catch { /* 解析失败跳过 */ }
      }
    }
    const _basis = JSON.stringify({
      m: (cls.managedChatIds || []).slice().sort(),
      e: (cls.extraOwnedChats || []).slice().sort(),
      d: diskExtraChats.slice().sort(),
      l: legacyCandidates.slice().sort(),
    });
    let _h = 5381;
    for (let i = 0; i < _basis.length; i++) _h = ((_h << 5) + _h + _basis.charCodeAt(i)) >>> 0;
    return { cls, diskExtraChats, legacyCandidates, previewRevision: _h.toString(16) };
  }

  // GET /api/parts/shells:chat/delete-char/:charName/cleanup-preview — [D1 §4 删除契约] 无副作用删除预览。
  //   分类/指纹单源=_computeDeleteCharPreview；执行时重算比对不符 → E_DELETE_PREVIEW_STALE 拒绝
  //   （防预览后状态漂移误删）。删除执行契约见 delete-char handler。
  router.get(
    "/api/parts/shells\\:chat/delete-char/:charName/cleanup-preview",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const charName = confineSegment(req.params.charName);
        if (!charName) return res.status(400).json({ message: "缺少角色名称" });
        const charDir = path.join(getUserDictionary(username), "chars", charName);
        if (!fs.existsSync(charDir)) return res.status(404).json({ message: `角色 "${charName}" 不存在` });

        const { cls, diskExtraChats, legacyCandidates, previewRevision } = _computeDeleteCharPreview(username, charName);
        res.json({
          success: true,
          preview: { charName, managedModeChats: cls.managedModeChats || [], extraOwnedChats: cls.extraOwnedChats || [], diskExtraChats, legacyCandidates, previewRevision },
        });
      } catch (err) {
        console.error("[beilu-chat] cleanup-preview error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // DELETE /api/parts/shells:chat/delete-char/:charName — 删除角色卡（原 beilu-home/delete-char）
  // 8步清理（顺序不可改）：
  //   1. 正则规则 — 始终自动删除 boundCharName 匹配的规则（磁盘+内存双清）
  //   2. 世界书 — 按 options.deleteWorldbook 选择删除绑定世界书
  //   3. 聊天记录 — 按 options.deleteChats 选择，三路删除（beilu-chat 接口 → 磁盘 fallback → 旧路径兼容）
  //   4. 记忆数据 — 按 options.deleteMemory 选择，删前备份到临时目录
  //   5. uninstallPartBase（清 5 层缓存），失败有手动删除目录兜底
  //   6. 恢复记忆（用户选择保留时从临时目录恢复到 memory/{charName}/）
  //   7. 通知 beilu-memory 清理内存缓存
  //   8. 保险 rmDir 确保角色卡目录彻底删除
  router.delete(
    "/api/parts/shells\\:chat/delete-char/:charName",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const charName = confineSegment(req.params.charName);
        const options = req.body || {};

        if (!charName) {
          return res.status(400).json({ message: "缺少角色名称" });
        }

        const userDir = getUserDictionary(username);
        const charDir = path.join(userDir, "chars", charName);

        if (!fs.existsSync(charDir)) {
          return res
            .status(404)
            .json({ message: `角色 "${charName}" 不存在` });
        }

        // [0804 反方补修·校验前移] previewRevision 比对必须发生在【任何破坏性步骤之前】——
        //   原实现放在步骤3（正则/世界书已删之后），预览过期时前两步已破坏=D1 §4"revision 不符
        //   则零破坏"语义被打穿。此处零副作用早退；分类快照冻结供步骤3 复用（用户确认的正是这份
        //   集合，删除按已验证快照执行，不在步骤间重算——重算=校验与执行两个集合可再漂移）。
        const _delPreview = options.deleteChats ? _computeDeleteCharPreview(username, charName) : null;
        if (options.previewRevision && _delPreview && _delPreview.previewRevision !== options.previewRevision) {
          return res.status(409).json({ success: false, code: "E_DELETE_PREVIEW_STALE", message: "删除预览已过期，请重新预览确认", currentRevision: _delPreview.previewRevision });
        }

        const partpath = `chars/${charName}`;
        const cleanupResults = {
          regex: false,
          worldbook: false,
          chats: 0,
          memory: false,
        };

        const failedPaths = [];
        const rmDirWithRetry = async (dirPath, label) => {
          if (!fs.existsSync(dirPath)) return true;
          const r = await safeTrash(dirPath, `delete-char_${label}`);
          if (!r.success) {
            failedPaths.push({ path: dirPath, label, error: r.error || "safeTrash failed" });
            return false;
          }
          return true;
        };

        // [T077] 原 pluginsDir（全局 plugins 目录）已无消费者：regex 清理改 getUserDataDir(username)/regex/、
        //   worldbook 清理 T074 已改 getUserDataDir(username)/worldbooks/。全局单文件路径退役（per-user 隔离后不再直操全局盘）。

        // 1. 正则规则 — 始终自动删除（直接操作磁盘文件）
        // [T077 per-user] 磁盘路径改 per-user：data/users/<user>/regex/config_data.json（原全局单文件=串台）。
        //   与 worldbook per-user 清理同型；SetData 加 {username} 使 in-memory 走该 user 的 store。
        try {
          const regexConfigPath = path.join(
            getUserDataDir(username),
            "regex",
            "config_data.json",
          );
          if (fs.existsSync(regexConfigPath)) {
            const regexData = JSON.parse(
              fs.readFileSync(regexConfigPath, "utf-8"),
            );
            if (Array.isArray(regexData.rules)) {
              const before = regexData.rules.length;
              regexData.rules = regexData.rules.filter(
                (r) => r.boundCharName !== charName,
              );
              const removed = before - regexData.rules.length;
              if (removed > 0) {
                nicerWriteFileSync(
                  regexConfigPath,
                  JSON.stringify(regexData, null, 2),
                  "utf-8",
                );
                console.log(
                  `[beilu-chat] 已清理角色 "${charName}" 绑定的 ${removed} 条正则规则`,
                );
              }
              cleanupResults.regex = true;
            }
          }
          // 如果插件已加载到 parts_set，同步内存状态（SetData 传 {username} → 该 user 的 store）
          try {
            const regexPlugin = parts_set[username]?.["plugins/beilu-regex"];
            if (regexPlugin?.interfaces?.config?.SetData) {
              await regexPlugin.interfaces.config.SetData({
                _action: "removeByChar",
                charName,
              }, { username });
            }
          } catch (_) {
            /* 插件未加载时忽略 */
          }
        } catch (e) {
          console.warn("[beilu-chat] 清理绑定正则失败:", e.message);
        }

        // 2. 世界书 — 根据用户选择（直接操作磁盘文件）
        if (options.deleteWorldbook) {
          try {
            // [T074 per-user] 世界书已 per-user 隔离：清理该用户目录下的 config_data.json，
            //   不再操作全局 plugins/beilu-worldbook/config_data.json（那会误删/漏删）。
            const wbConfigPath = path.join(
              getUserDataDir(username),
              "worldbooks",
              "config_data.json",
            );
            if (fs.existsSync(wbConfigPath)) {
              const wbData = JSON.parse(
                fs.readFileSync(wbConfigPath, "utf-8"),
              );
              if (wbData.worldbooks && typeof wbData.worldbooks === "object") {
                const toRemove = Object.keys(wbData.worldbooks).filter(
                  (name) => wbData.worldbooks[name]?.boundCharName === charName,
                );
                if (toRemove.length > 0) {
                  for (const name of toRemove) delete wbData.worldbooks[name];
                  // active_worldbook 若被删则重指
                  if (toRemove.includes(wbData.active_worldbook)) {
                    const remaining = Object.keys(wbData.worldbooks);
                    wbData.active_worldbook = remaining.length > 0 ? remaining[0] : "";
                  }
                  nicerWriteFileSync(
                    wbConfigPath,
                    JSON.stringify(wbData, null, 2),
                    "utf-8",
                  );
                  console.log(
                    `[beilu-chat] 已清理角色 "${charName}" 绑定的 ${toRemove.length} 个世界书`,
                  );
                }
                cleanupResults.worldbook = true;
              }
            }
            // 如果插件已加载到 parts_set，同步内存状态
            try {
              const worldbookPlugin =
                parts_set[username]?.["plugins/beilu-worldbook"];
              if (worldbookPlugin?.interfaces?.config?.SetData) {
                // [T074] 传 { username } → SetData 落该用户 store（否则改 _default，内存态与磁盘清理不一致）。
                await worldbookPlugin.interfaces.config.SetData({
                  removeByChar: { charName },
                }, { username });
              }
            } catch (_) {
              /* 插件未加载时忽略 */
            }
          } catch (e) {
            console.warn("[beilu-chat] 清理绑定世界书失败:", e.message);
          }
        }

        // 3. 聊天记录 — 根据用户选择
        if (options.deleteChats) {
          try {
            const chatShell = parts_set[username]?.["shells/beilu-chat"];
            // [D1 §4 删除契约 / 0804 反方补修] 分类+revision 校验已在 handler 开头（任何破坏性步骤前）
            //   经单源 _computeDeleteCharPreview 完成；此处只消费冻结快照 _delPreview.cls——
            //   删除集合=用户在 preview 确认的那份，不重算（重算=校验与执行集合可再漂移）。
            const _cls = _delPreview?.cls || { managedModeChats: [], extraOwnedChats: [], managedChatIds: [] };
            // 删角色卡默认 all-owned-chats（删该角色全部 owned；向后兼容=原 getChatIdsByCharName 全部=managed+extra）；
            //   显式 managed-mode-chats 只删四条受管理线。legacy 由 includeLegacyCandidates 单控（方式3 默认不删）。
            const _policy = options.deletePolicy || "all-owned-chats";
            let chatIdsToDelete = [];

            // 方式1：[D1 §4] 按 deletePolicy 选删除集合走 deleteChat（owner 校验/事务/per-chat 清理），
            //   非原「无差别删 getChatIdsByCharName 全部」——managed-mode-chats 只删四条受管理线，all-owned 含额外自有。
            if (chatShell?.interfaces?.chat?.deleteChat) {
              chatIdsToDelete = _policy === "all-owned-chats"
                ? [...new Set([...(_cls.managedChatIds || []), ...(_cls.extraOwnedChats || [])])]
                : [...(_cls.managedChatIds || [])];
              if (chatIdsToDelete.length > 0) {
                const results = await chatShell.interfaces.chat.deleteChat(
                  chatIdsToDelete,
                  username,
                );
                const successCount = results.filter((r) => r.success).length;
                cleanupResults.chats = successCount;
                console.log(
                  `[beilu-chat] 通过 beilu-chat 接口删除 ${successCount}/${chatIdsToDelete.length} 个聊天`,
                );
              }
            }

            // 方式2（fallback）：直接删除 chars/{charName}/chats/ 目录下的文件
            const chatsDir = path.join(charDir, "chats");
            if (fs.existsSync(chatsDir)) {
              const chatFiles = fs
                .readdirSync(chatsDir)
                .filter((f) => f.endsWith(".json"));
              for (const file of chatFiles) {
                const chatid = file.replace(".json", "");
                // [D1 §4] 只 safeUnlink 真孤儿（完全无内存索引）：内存索引存在（可能 primaryCharName
                //   已漂移到别角色）的不在此删，交方式1 deleteChat（owner/事务/清理）或保留，防绕 owner 误删别角色会话。
                const _isIndexed = chatShell?.interfaces?.chat?.isIndexedChat?.(chatid) ?? false;
                if (!chatIdsToDelete.includes(chatid) && !_isIndexed) {
                  try {
                    await safeUnlink(path.join(chatsDir, file), "delete-char_孤儿聊天文件(无内存索引)");
                    cleanupResults.chats++;
                  } catch (e) {
                    console.warn(`[beilu-chat] 删除孤儿聊天文件 ${file} 失败:`, e.message);
                  }
                }
              }
            }

            // 方式3（兼容旧路径 legacyCandidates）：shells/chat/chats/ 按 timeSlice.chars 弱归属。
            // [D1 §4 删除契约] 默认**不删**——末条 timeSlice.chars 是弱归属证据，可能误删他人/别角色聊天
            //   （凛倾契约：不以 timeSlice.chars 自动当足够归属证据）。仅在调用方显式
            //   options.includeLegacyCandidates 时才清（cleanup-preview 已把这些列为 legacyCandidates 供用户确认）。
            if (options.includeLegacyCandidates) {
              const oldChatsDir = path.join(userDir, "shells", "chat", "chats");
              if (fs.existsSync(oldChatsDir)) {
                const oldChatFiles = fs
                  .readdirSync(oldChatsDir)
                  .filter((f) => f.endsWith(".json"));
                for (const file of oldChatFiles) {
                  try {
                    const raw = JSON.parse(
                      fs.readFileSync(path.join(oldChatsDir, file), "utf-8"),
                    );
                    const lastEntry = raw.chatLog?.[raw.chatLog.length - 1];
                    const chars = lastEntry?.timeSlice?.chars || [];
                    if (Array.isArray(chars) && chars.includes(charName)) {
                      await safeUnlink(path.join(oldChatsDir, file), "delete-char_旧路径聊天");
                      cleanupResults.chats++;
                    }
                  } catch (_) {
                    /* 解析失败跳过 */
                  }
                }
              }
            }

            // 清理 summaries cache 中该角色的聊天
            try {
              const cachePath = path.join(
                userDir,
                "shells",
                "chat",
                "chat_summaries_cache.json",
              );
              if (fs.existsSync(cachePath)) {
                const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                let cacheChanged = false;
                for (const [chatid, summary] of Object.entries(cache)) {
                  if (summary?.chars?.includes?.(charName)) {
                    delete cache[chatid];
                    cacheChanged = true;
                  }
                }
                if (cacheChanged) {
                  nicerWriteFileSync(
                    cachePath,
                    JSON.stringify(cache, null, 2),
                    "utf-8",
                  );
                }
              }
            } catch (_) {
              /* 缓存清理失败不影响主流程 */
            }
          } catch (e) {
            console.warn("[beilu-chat] 清理聊天记录失败:", e.message);
          }
        }

        // 4. 记忆数据 — 根据用户选择（在 uninstallPartBase 之前主动处理）
        if (options.deleteMemory) {
          const memoryDir = path.join(charDir, "memory");
          const okMem = await rmDirWithRetry(memoryDir, "记忆目录");
          const oldMemoryDir = path.join(userDir, "memory", charName);
          const okOldMem = await rmDirWithRetry(oldMemoryDir, "旧记忆目录");
          cleanupResults.memory = okMem && okOldMem;
        } else {
          // 用户选择保留记忆 → 备份 memory 目录到临时位置
          const memoryDir = path.join(charDir, "memory");
          const tempMemoryDir = path.join(
            userDir,
            "_temp_memory_backup_" + charName,
          );
          if (fs.existsSync(memoryDir)) {
            try {
              fs.cpSync(memoryDir, tempMemoryDir, { recursive: true });
            } catch (e) {
              console.warn("[beilu-chat] 备份记忆数据失败:", e.message);
            }
          }
          options._restoreMemoryFrom = tempMemoryDir;
        }

        // 5. 使用 beilu 的 uninstallPartBase 进行完整卸载（清 5 层缓存）
        try {
          await uninstallPartBase(username, partpath, undefined, undefined, {
            pathGetter: () => charDir,
          });
        } catch (uninstallErr) {
          console.warn(
            `[beilu-chat] uninstallPartBase 失败(${uninstallErr.message})，手动删除目录...`,
          );
          await rmDirWithRetry(charDir, "角色卡目录(uninstall回退)");
        }

        // 6. 如果需要恢复记忆数据（用户选择保留时）
        if (
          options._restoreMemoryFrom &&
          fs.existsSync(options._restoreMemoryFrom)
        ) {
          try {
            const restoredDir = path.join(userDir, "memory", charName);
            fs.cpSync(options._restoreMemoryFrom, restoredDir, {
              recursive: true,
            });
            fs.rmSync(options._restoreMemoryFrom, {
              recursive: true,
              force: true,
            });
            console.log(`[beilu-chat] 记忆数据已保留到: ${restoredDir}`);
          } catch (e) {
            console.warn("[beilu-chat] 恢复记忆数据失败:", e.message);
          }
        }

        // 7. 通知 beilu-memory 清理内存缓存
        try {
          const memPlugin = parts_set[username]?.["plugins/beilu-memory"];
          if (memPlugin?.interfaces?.config?.SetData) {
            await memPlugin.interfaces.config.SetData({
              _action: "clearCache",
              charName,
              username,
            });
          }
        } catch (_) {
          /* 插件未加载时忽略 */
        }

        // 8. 保险：确保角色卡目录被彻底删除
        const charDirOk = await rmDirWithRetry(charDir, "角色卡目录(保险清理)");
        if (charDirOk) {
          for (let i = failedPaths.length - 1; i >= 0; i--) {
            if (failedPaths[i].path === charDir) failedPaths.splice(i, 1);
          }
          console.log(
            `[beilu-chat] 保险清理：角色卡目录已删除: ${charDir}`,
          );
        }

        // 最终回报
        if (failedPaths.length > 0) {
          console.error(
            `[beilu-chat] 角色卡删除未彻底: "${charName}" (user: ${username})，残留:`,
            failedPaths,
          );
          return res.status(500).json({
            success: false,
            name: charName,
            cleanup: cleanupResults,
            failedPaths,
            error: `删除未彻底：${failedPaths.length} 个目录残留（可能被进程占用，请稍后重试）`,
          });
        }

        console.log(
          `[beilu-chat] 角色卡已删除（含缓存清理）: "${charName}" (user: ${username})`,
          cleanupResults,
        );
        // 删卡=断永久链路（加卡建链、删卡才断；卡目录已删=链无条件断，防幽灵卡名留在窗口分类）
        try { await removePermanentCharLink(username, charName); } catch (e) { console.warn("[beilu-chat] 断永久链路失败(非致命):", e.message); } // T4：now async，await 保留错误被此 try/catch 捕获
        try { sendEventToUser(username, "char-data-changed", { charName, deleted: true }); } catch (e) { console.warn("[同步广播] char-data-changed(deleted) 推送失败(不阻塞删除):", e?.message); }
        res
          .status(200)
          .json({ success: true, name: charName, cleanup: cleanupResults });
      } catch (error) {
        console.error("[beilu-chat] Error deleting char:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // 局域网 IP + 端口（原 beilu-home/network-info）
  router.get(
    "/api/parts/shells\\:chat/network-info",
    authenticate,
    async (_req, res) => {
      try {
        const interfaces = os.networkInterfaces();
        const ips = [];
        for (const name of Object.keys(interfaces)) {
          for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
              ips.push({ name, address: iface.address });
            }
          }
        }
        const port = process.env.BEILU_PORT || 1314;
        res.json({ ips, port });
      } catch (err) {
        console.error("[chat/endpoints] network-info error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 诊断系统 API（原 beilu-home/diag/*，前端控制面板远程控制后端诊断日志）
  router.get("/api/parts/shells\\:chat/diag/status", authenticate, (_req, res) => {
    try {
      res.json(diagControl.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/api/parts/shells\\:chat/diag/enable", authenticate, (req, res) => {
    try {
      const { modules } = req.body || {};
      if (!modules) return res.status(400).json({ error: "缺少 modules 参数" });
      diagControl.enable(modules);
      res.json({ success: true, ...diagControl.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/api/parts/shells\\:chat/diag/disable", authenticate, (req, res) => {
    try {
      const { modules } = req.body || {};
      if (!modules) return res.status(400).json({ error: "缺少 modules 参数" });
      diagControl.disable(modules);
      res.json({ success: true, ...diagControl.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/api/parts/shells\\:chat/diag/level", authenticate, (req, res) => {
    try {
      const { level } = req.body || {};
      if (!level) return res.status(400).json({ error: "缺少 level 参数" });
      diagControl.setLevel(level);
      res.json({ success: true, ...diagControl.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.get("/api/parts/shells\\:chat/diag/snapshots", authenticate, (req, res) => {
    try {
      const count = parseInt(req.query.count) || 50;
      const module = req.query.module || null;
      res.json({ snapshots: diagControl.getSnapshots(count, module) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/api/parts/shells\\:chat/diag/clear-snapshots", authenticate, (_req, res) => {
    try {
      diagControl.clearSnapshots();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.get("/api/parts/shells\\:chat/diag/logs", authenticate, (req, res) => {
    try {
      const count = parseInt(req.query.count) || 500;
      res.json({ logs: diagControl.getLogs(count) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/api/parts/shells\\:chat/diag/clear-logs", authenticate, (_req, res) => {
    try {
      diagControl.clearLogs();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.ws(
    "/ws/parts/shells\\:chat/ui/:chatid",
    authenticate,
    async (ws, req) => {
      const { chatid } = req.params;
      let _wsUser = "";
      try { _wsUser = (await getUserByReq(req)).username || ""; } catch { /* 匿名→_default 桶 */ }
      registerChatUiSocket(chatid, ws, _wsUser);
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/initial-data",
    authenticate,
    async (req, res) => {
      const { chatid } = req.params;
      try {
        const data = await getInitialData(chatid);
        res.status(200).json(data);
      } catch (err) {
        // Chat not found → 404（不是 500），前端可据此清除无效 chatid
        if (err.message === "Chat not found") {
          return res.status(404).json({ error: "Chat not found", chatid });
        }
        console.error(
          `[chat/endpoints] ★ initial-data 失败: chatid=${chatid}`,
          err.message,
        );
        res.status(500).json({
          error: err.message,
          _diag: "initial-data endpoint caught error",
        });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/chars",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        res.status(200).json(await getCharListOfChat(chatid));
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/plugins",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        res.status(200).json(await getPluginListOfChat(chatid));
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/log",
    authenticate,
    async (req, res) => {
      const {
        params: { chatid },
        query: { start, end },
      } = req;
      const { username } = await getUserByReq(req);
      // start/end 缺省或非数字时传 undefined=全量（parseInt(undefined)=NaN 会让 slice(NaN,NaN) 恒返 []）
      const _start = parseInt(start, 10);
      const _end = parseInt(end, 10);
      const log = await GetChatLog(
        chatid,
        Number.isFinite(_start) ? _start : undefined,
        Number.isFinite(_end) ? _end : undefined,
      );
      // 只在有问题的 entry（缺 toData / 缺 id）时记录，正常 entry 不刷屏
      for (let i = 0; i < log.length; i++) {
        const e = log[i];
        if (typeof e?.toData !== "function" || !e?.id) {
          console.warn(
            `[chat/endpoints] /log chatid=${chatid} entry[${i}] 异常: constructor=${e?.constructor?.name} hasToData=${typeof e?.toData === "function"} id=${e?.id} role=${e?.role}`,
          );
        }
      }
      const serialized = await Promise.all(
        log.map(async (entry, i) => {
          let result;
          try {
            if (typeof entry?.toData === "function") {
              result = await entry.toData(username);
            }
          } catch (err) {
            console.warn(
              "[chat/endpoints] toData failed for log entry:",
              err.message,
            );
          }
          if (!result) {
            console.warn(
              `[chat/endpoints] log entry[${i}] missing toData, using fallback. id=${entry?.id}`,
            );
            try {
              if (typeof entry?.toJSON === "function") result = entry.toJSON();
            } catch (err2) {
              console.warn(
                "[chat/endpoints] toJSON also failed:",
                err2.message,
              );
            }
          }
          if (!result) {
            // 最终 fallback：确保至少有 id、content、role
            result = {
              id: entry?.id || crypto.randomUUID(),
              content: entry?.content || "",
              role: entry?.role || "char",
              name: entry?.name || "Unknown",
              time_stamp: entry?.time_stamp || new Date(),
              files: [],
              timeSlice: { chars: [], plugins: [] },
            };
          }
          // ★ DIAG P0: 检查序列化后是否有 id
          if (!result.id) {
            console.error(
              `[chat/endpoints DIAG] ★ 序列化后 entry[${i}] 缺少 id! keys:`,
              Object.keys(result).join(","),
            );
          }
          return result;
        }),
      );
      // 去重：同一 chatid 响应（条数+ids）与上次相同则不打，避免轮询刷屏；变化才打一次
      const _diagKey = `${serialized.length}:${serialized.map((e) => e.id).join(",")}`;
      if (_lastLogDiag.get(chatid) !== _diagKey) {
        _lastLogDiag.set(chatid, _diagKey);
        console.log(`[chat/endpoints] /log chatid=${chatid} 响应 ${serialized.length} 条`);
      }
      res.status(200).json(serialized);
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/log/length",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        // ?visible=1 → 仅未隐藏数(手动压缩 slider 用)；默认全序(兼容 virtualQueue 等)
        const _len = req.query?.visible === "1" ? await GetVisibleChatLogLength(chatid) : await GetChatLogLength(chatid);
        res.status(200).json(_len);
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ★ D5 [RENDER:*] regex 激活修复（框架级，方案B）：render 查询挪到 shell 后端，
  //   因为只有 shell 层能 loadChat→取可见 chat_log（单源），worldbook 插件不可反向依赖 shell。
  //   旧无状态端点（beilu-worldbook GET render/entries）缺 chat_log → regex 门控恒 false 永不激活。
  //   本路由 loadChat→getVisibleChatLog（与 GetPrompt 路径同一可见 chat_log 单源）+ 解析 username/UserCharname，
  //   转调 worldbook.interfaces.chat.GetRenderEntries（已支持 chat_log，只是从无人喂数据）。
  //   :chatid 经 router.param 已做归属校验（_assertChatOwner），无需重复鉴权。
  //   ?charId=part目录名(timeSlice.charname)  ?charName=角色显示名
  router.get(
    "/api/parts/shells\\:chat/:chatid/render/entries",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        const { username } = await getUserByReq(req);
        const charId = req.query.charId || "";
        const charName = req.query.charName || "";
        // 可见 chat_log 单源：与 requestBuilder(GetPrompt 路径)共用 getVisibleChatLog（同口径过滤 _hidden）
        const chat_log = await getVisibleChatLog(chatid);
        // UserCharname：persona 显示名（player_id），与 requestBuilder:50 的回退链一致；
        //   补齐后 render regex 条目里的 {{user}} 宏不再被 charName 顶替（框架md §6 风险4 预期修正）。
        const UserCharname = (await GetUserPersonaName(chatid)) || username;
        // 加载 worldbook 插件（loadPart 内部有缓存，与 requestBuilder:69 同款加载方式）。
        // 加载失败/未暴露接口 → 返回空集（非错误：该用户可能未启用世界书，不应 500 刷前端告警）。
        let worldbook = null;
        try { worldbook = await loadPart(username, "plugins/beilu-worldbook"); } catch { worldbook = null; }
        const fn = worldbook?.interfaces?.chat?.GetRenderEntries;
        if (typeof fn !== "function") {
          return res.status(200).json({ entries: [] });
        }
        const result = fn({
          char_id: charId,
          Charname: charName,
          username,
          UserCharname,
          chat_log,
          chatid,
        });
        res.status(200).json(result);
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/endpoints] render/entries 失败:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ★ AIRP 渲染期视图（框架 v6 §三 P0 章3）：符号画/状态块只在渲染期产出，
  //   不写 chatLog、不进 messages（002原话「符号画不要出现在 ai 的上下文」）。
  //   与上方 render/entries 同构：只有 shell 层能 loadChat→取可见 chat_log（单源），
  //   airp 插件不可反向依赖 shell。转调 airp.interfaces.chat.GetRenderView。
  //   :chatid 经 router.param 已做归属校验（_assertChatOwner），无需重复鉴权。
  //   ?charId=part目录名(timeSlice.charname)
  router.get(
    "/api/parts/shells\\:chat/:chatid/airp/view",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        const { username } = await getUserByReq(req);
        const charId = req.query.charId || "";
        // 可见 chat_log 单源：与 GetPrompt 路径共用 getVisibleChatLog（同口径过滤 _hidden）
        const chat_log = await getVisibleChatLog(chatid);
        // 加载 airp 插件（loadPart 内部有缓存，与 render/entries :1510 同款加载方式）。
        // 加载失败/未暴露接口 → 返回空结果（非错误：该用户可能未装/未启用 airp，不应 500 刷前端告警）。
        let airp = null;
        try { airp = await loadPart(username, "plugins/beilu-airp"); } catch { airp = null; }
        const fn = airp?.interfaces?.chat?.GetRenderView;
        if (typeof fn !== "function") {
          return res.status(200).json({ caps: null, blocks: [] });
        }
        // 同步函数（与 GetRenderEntries :1515 同范式，不 await）
        const result = fn({ username, chat_log, chatid, char_id: charId });
        res.status(200).json(result);
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/endpoints] airp/view 失败:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/persona",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        // 无人设时 player_id 为 undefined，res.json(undefined) 会发空体导致客户端 JSON.parse 失败；?? null 保证合法 JSON
        res.status(200).json((await GetUserPersonaName(chatid)) ?? null);
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/:chatid/world",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        // 同 persona：无世界设定时 world_id 为 undefined，?? null 避免发空体
        res.status(200).json((await GetWorldName(chatid)) ?? null);
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.put(
    "/api/parts/shells\\:chat/:chatid/timeline",
    authenticate,
    async (req, res) => {
      try {
        const {
          params: { chatid },
          body: { delta, absoluteIndex },
        } = req;
        wbT(chatid, "chat", "PUT_timeline:enter", { delta, absoluteIndex: absoluteIndex ?? null });
        const entry = await modifyTimeLine(chatid, delta, absoluteIndex);
        res.status(200).json({
          success: true,
          entry: await entry.toData((await getUserByReq(req)).username),
        });
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        // 客户端错误（如对空 chat 切时间线）带 statusCode → 映射 4xx，而非一律 500
        const _code = err.statusCode || 500;
        wbD(req?.params?.chatid, "chat", "PUT_timeline:catch", false, err?.message || String(err), { statusCode: _code, name: err?.name });
        if (_code >= 500) console.error("[chat/timeline] Error:", err.message);
        res.status(_code).json({ error: err.message });
      }
    },
  );

  router.delete(
    "/api/parts/shells\\:chat/:chatid/message/:index",
    authenticate,
    async (req, res) => {
      try {
        const { chatid, index } = req.params;
        const { username } = await getUserByReq(req);
        const parsedIndex = parseNonNegativeInteger(index);
        if (parsedIndex == null) {
          return res.status(400).json({ error: "Invalid index" });
        }
        const messageId = typeof req.query?.messageId === "string"
          ? req.query.messageId.trim()
          : "";
        if (!messageId) {
          return res.status(400).json({ success: false, error: "messageId is required" });
        }
        const result = await deleteMessage(chatid, parsedIndex, { messageId, expectedUsername: username });
        res.status(200).json({ success: result.applied, ...result });
      } catch (err) {
        // "Invalid index" / "Chat not found" = 客户端参数错 → 400；其余 → 500
        const _code = Number.isInteger(err?.statusCode)
          ? err.statusCode
          : err.message === "Invalid index" || err.message === "Chat not found" ? 400 : 500;
        if (_code >= 500) console.error("[chat/deleteMessage] Error:", err);
        res.status(_code).json({ error: err.message });
      }
    },
  );

  router.put(
    "/api/parts/shells\\:chat/:chatid/message/:index",
    authenticate,
    async (req, res) => {
      try {
      const {
        params: { chatid, index },
      } = req;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const rawContent = body.content;
      const { username } = await getUserByReq(req);
      const parsedIndex = parseNonNegativeInteger(index);
      if (parsedIndex == null) {
        return res.status(400).json({
          success: false, applied: false, chatCommitted: false, status: "invalid_request",
          revision: null, derived: null, code: "E_EDIT_INDEX_HINT_INVALID", error: "Invalid index",
        });
      }
      const messageId = typeof (body.messageId ?? req.query?.messageId) === "string"
        ? (body.messageId ?? req.query.messageId).trim()
        : "";
      if (!messageId) {
        return res.status(400).json({
          success: false,
          applied: false,
          chatCommitted: false,
          status: "invalid_request",
          revision: null,
          derived: null,
          code: "E_EDIT_MESSAGE_ID_REQUIRED",
          error: "messageId is required",
        });
      }
      if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
        return res.status(400).json({
          success: false,
          applied: false,
          chatCommitted: false,
          status: "invalid_request",
          revision: null,
          derived: null,
          messageId,
          indexHint: parsedIndex,
          code: "E_EDIT_CONTENT_INVALID",
          error: "content must be an object",
        });
      }
      const preparedEdit = await prepareEditMessageRequest(
        username,
        rawContent,
        body.editOperationId,
      );
      const result = await editMessage(
        chatid,
        messageId,
        parsedIndex,
        preparedEdit.content,
        {
          expectedUsername: username,
          editOperationId: preparedEdit.editOperationId,
          payloadFingerprint: preparedEdit.payloadFingerprint,
        },
      );
      const responseStatus = result.applied
        ? 200
        : result.reason === "message_id_not_found" ? 404 : 409;
      res.status(responseStatus).json({
        success: result.applied === true && result.chatCommitted === true,
        applied: result.applied === true,
        entry: result.entry,
        reason: result.reason,
        messageId: result.messageId,
        index: result.index,
        indexHint: result.indexHint,
        chatCommitted: result.chatCommitted,
        status: result.status,
        revision: result.revision,
        derived: result.derived,
        warning: result.warning,
        editOperationId: result.editOperationId,
        payloadFingerprint: result.payloadFingerprint,
        deduped: result.deduped === true,
      });
      } catch (err) {
        const failedIndexHint = parseNonNegativeInteger(req.params?.index);
        const failedBody = req.body && typeof req.body === "object" ? req.body : {};
        const failedMessageId = typeof (failedBody.messageId ?? req.query?.messageId) === "string"
          ? (failedBody.messageId ?? req.query.messageId).trim()
          : "";
        const statusCode = Number.isInteger(err?.statusCode)
          ? err.statusCode
          : /not found/i.test(err.message) ? 404 : 500;
        if (statusCode >= 500) console.error("[chat/editMessage] Error:", err);
        if (/not found/i.test(err.message)) {
          return res.status(404).json({
            success: false,
            applied: false,
            chatCommitted: false,
            status: "not_found",
            revision: null,
            derived: null,
            messageId: failedMessageId,
            indexHint: failedIndexHint,
            error: "Chat not found",
          });
        }
        res.status(statusCode).json({
          success: false,
          applied: false,
          chatCommitted: err?.chatCommitted === true,
          status: err?.status || "precommit_failed",
          revision: null,
          derived: null,
          messageId: failedMessageId,
          indexHint: failedIndexHint,
          error: err.message,
          code: err.code,
        });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/:chatid/message/:index/edit-operation/:operationId/reconcile",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const indexHint = parseNonNegativeInteger(req.params?.index);
        const reconcileBody = req.body && typeof req.body === "object" ? req.body : {};
        const messageId = typeof reconcileBody.messageId === "string" ? reconcileBody.messageId.trim() : "";
        if (indexHint == null || !messageId) {
          return res.status(400).json({
            success: false,
            code: indexHint == null ? "E_EDIT_INDEX_HINT_INVALID" : "E_EDIT_MESSAGE_ID_REQUIRED",
            error: indexHint == null ? "Invalid index" : "messageId is required",
          });
        }
        const identity = prepareEditOperationIdentity(
          reconcileBody.content,
          req.params.operationId,
        );
        const receipt = await getEditOperationReceipt(
          req.params.chatid,
          messageId,
          identity.editOperationId,
          identity.payloadFingerprint,
          { expectedUsername: username },
        );
        if (!receipt) {
          return res.status(404).json({
            success: false,
            applied: false,
            chatCommitted: false,
            status: "not_found",
            code: "E_EDIT_OPERATION_NOT_FOUND",
            messageId,
            indexHint,
            editOperationId: req.params.operationId,
            error: "edit operation not found",
          });
        }
        return res.status(200).json({ success: true, ...receipt });
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        if (statusCode >= 500) console.error("[chat/getEditOperationReceipt] Error:", error);
        return res.status(statusCode).json({
          success: false,
          applied: false,
          chatCommitted: false,
          status: "reconciliation_failed",
          code: error?.code,
          error: error?.message || String(error),
        });
      }
    },
  );

  // R1 主对话生成链路入口：用户发消息。
  // 步骤：
  //   1. N16 入参校验 → reply 非 string/object 拒绝 400
  //   2. W55 兼容包装 → 统一 mime_type → base64→Buffer → processImageFiles 压缩
  //   3. W66 cancelAutoContinue → 取消上一轮自动继续
  //   4. addUserReply → 落盘 + 广播 message_added(user)
  //   5. triggerCharReply（异步不 await）→ 走 generation.mjs 生成链
  //   6. 响应 200 {entry}（仅 user entry，AI 回复走 WS stream）
  // 不变量：步骤 4 必须在步骤 5 之前——用户消息必须先落盘，AI 生成才能看到它
  router.post(
    "/api/parts/shells\\:chat/:chatid/message",
    authenticate,
    async (req, res) => {
      try {
      const {
        params: { chatid },
        // single_inject_ids（0726 注入坞）：本轮临时启用的 INJ 条目 id 数组，与 single_inject
        //   （纯文本）并存不互斥——前者引用条目走 INJ 正线，后者是不落条目的临时一句话。
        // window_mode（20260726）：发送时用户所在窗口的模式（前端 TAB_TO_MODE[activeTab]）。
        //   模式是窗口的运行时事实，随请求上送后 resolveGenerationMode 第一优先级直接命中，
        //   不必再回退去磁盘 active_modes_map 反查（那张表多窗口并发写会互相覆盖）。
        body: { reply, autoReply, single_inject, single_inject_ids, window_mode, client_msg_id },
      } = req;
      // [0719 幂等契约] 同一逻辑发送的重放（客户端超时/401 重试携带同一 client_msg_id）→
      //   命中窗内既有 entry：返 200 现有结果、不重写、不重触发生成（否则 dup 会经 userInitiated
      //   队列再排一轮 AI 回复）。不带 id 的老客户端行为零变化。
      if (client_msg_id) {
        const _dupEntry = getRecentUserReply(chatid, client_msg_id);
        if (_dupEntry) {
          wbT(chatid, "chat", "POST_message:idempotent_hit", { client_msg_id });
          const _dupUser = (await getUserByReq(req)).username;
          return res.status(200).json({ success: true, entry: await _dupEntry.toData(_dupUser), deduped: true });
        }
      }
      // N16: 系统边界校验（测试轮 2026-06-12 实测：缺 reply 时下方 replyObj.files 赋值抛
      //   TypeError → 500 "Cannot set properties of undefined"。外部入参错应 400 结构化非 500）
      wbT(chatid, "chat", "POST_message:enter", { replyType: typeof reply, autoReply: autoReply !== false, singleInject: !!single_inject });
      globalThis.__beiluLastUserMessage = globalThis.__beiluLastUserMessage || {};
      globalThis.__beiluLastUserMessage[chatid] = Date.now();
      if (globalThis.__beiluAutoSendCount) globalThis.__beiluAutoSendCount[chatid] = 0;
      if (reply === undefined || reply === null || Array.isArray(reply) || (typeof reply !== "string" && typeof reply !== "object")) {
        // B-2g：数组 typeof "object" 且非 null 会漏过守卫 → 下游 replyObj=数组、messageBuilder content=undefined 脏 entry。reply 只应 string | {content,files?}，数组归同源 400。
        wbD(chatid, "chat", "POST_message:invalid_reply", false, "Missing or invalid 'reply' field", { replyType: typeof reply });
        return res.status(400).json({ error: "Missing or invalid 'reply' field", code: "INVALID_REPLY", expected: "string | { content, files? }" });
      }
      // W55修复: reply可能是字符串（AI直接返回文本时），需要包装成对象
      const replyObj = typeof reply === "string" ? { content: reply, files: [] } : reply;
      const _rawFiles = replyObj?.files || [];
      // ★ 统一字段名：YonBan发的是 type，beilu-eye/本体用 mime_type，后端统一用 mime_type
      replyObj.files = _rawFiles
        .filter((file) => file && file.buffer)
        .map((file) => ({
          ...file,
          mime_type: file.mime_type || file.type || "application/octet-stream",
          buffer: Buffer.from(file.buffer, "base64"),
        }));
      if (replyObj.files.length > 0) console.log(`[endpoints/message] 过滤后files: ${replyObj.files.length}个`);
      // 图片格式校验 + 压缩
      if (replyObj.files?.length) {
        replyObj.files = await processImageFiles(replyObj.files);
      }
      // W66: 用户发新消息 → 取消上一轮自动继续
      cancelAutoContinue(chatid);

      if (client_msg_id) replyObj.client_msg_id = String(client_msg_id); // 幂等键随写入登记（chatOps 剥离不进 entry）
      const username = (await getUserByReq(req)).username;
      const entry = await addUserReply(chatid, replyObj, { expectedUsername: username });

      // autoReply: 保存用户消息后自动触发AI回复（避免前端分两次请求导致双重触发）
      if (autoReply !== false) {
        // 异步触发，不阻塞响应；单次注入仅对本轮生效（一次性）
        // userInitiated: 生成中到达则排队、本轮结束补发（中途输入支持，保序）
        const _onceIds = Array.isArray(single_inject_ids) ? single_inject_ids.filter((s) => typeof s === "string" && s) : [];
        const _winMode = typeof window_mode === "string" && window_mode ? window_mode : undefined; // 空/非法=不带，走磁盘兜底（零回归）
        wbT(chatid, "chat", "POST_message:autoReply_trigger", { singleInject: !!single_inject, onceInjectIds: _onceIds.length, windowMode: _winMode || null });
        triggerCharReply(chatid, undefined, { singleInject: single_inject, onceInjectIds: _onceIds, userInitiated: true, windowMode: _winMode }).catch((err) => {
          wbD(chatid, "chat", "POST_message:autoReply_trigger:catch", false, err?.message || String(err), { name: err?.name });
          console.warn(
            "[chat/POST message] autoReply triggerCharReply 失败:",
            err.message,
          );
        });
      }

      res
        .status(200)
        .json({ success: true, entry: await entry.toData(username) });
      } catch (err) {
        wbD(req?.params?.chatid, "chat", "POST_message:catch", false, err?.message || String(err), { name: err?.name });
        console.error("[chat/POST message] Error:", err);
        if (/not found/i.test(err.message))
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/:chatid/trigger-reply",
    authenticate,
    async (req, res) => {
      try {
        const {
          params: { chatid },
          body: { charname },
        } = req;
        wbT(chatid, "chat", "POST_triggerReply:enter", { charname: charname || null });
        // [0718 时序洞修] 手动触发生成=用户接管：取消 pending 自动继续 timer（与 POST message :1707
        //   同语义）。原实现不取消——手动轮结束后旧 timer 再 fire=多跑一轮，与工具续轮交错成复轮。
        cancelAutoContinue(chatid);
        await triggerCharReply(chatid, charname);
        res.status(200).json({ success: true });
      } catch (err) {
        wbD(req?.params?.chatid, "chat", "POST_triggerReply:catch", false, err?.message || String(err), { name: err?.name });
        console.error("[chat/POST trigger-reply] Error:", err);
        if (/not found/i.test(err.message))
          return res.status(404).json({ error: "Chat not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.put(
    "/api/parts/shells\\:chat/:chatid/world",
    authenticate,
    async (req, res) => {
      try {
        const {
          params: { chatid },
          body: { worldname },
        } = req;
        await setWorld(chatid, worldname);
        res.status(200).json({ success: true });
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/setWorld] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.put(
    "/api/parts/shells\\:chat/:chatid/persona",
    authenticate,
    async (req, res) => {
      try {
        const {
          params: { chatid },
          body: { personaname },
        } = req;
        await setPersona(chatid, personaname);
        res.status(200).json({ success: true });
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/setPersona] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/:chatid/char",
    authenticate,
    async (req, res) => {
      const reqStartAt = Date.now();
      // [0804 根因修] 本 handler 原缺认证身份声明：2162 的 ensureModeChatsForChar(username,...)
      //   裸引用未定义 username → ReferenceError → 500——绑卡（addchar）已成功却被伪装成失败，
      //   四模式补齐整条不执行（新角色只剩 1 条对话的服务端断点）。与全文件其余 handler 同范式取认证身份。
      const { username } = await getUserByReq(req);
      const {
        params: { chatid },
        body: { charname },
      } = req;
      const reqDiagId = `${chatid}:${charname}:${reqStartAt.toString(36)}`;
      const logReq = process.env.BEILU_DEBUG
        ? (msg) =>
            console.log(
              `[endpoints DIAG][${reqDiagId}][+${Date.now() - reqStartAt}ms] ${msg}`,
            )
        : () => {};

      try {
        if (!charname || typeof charname !== "string" || !charname.trim()) {
          logReq("★ 参数无效: charname 为空");
          return res.status(400).json({ error: "Invalid charname" });
        }
        logReq(`▶ POST /char 收到请求 chatid=${chatid} charname=${charname}`);
        // [0804 根因修] 绑卡前先验 chat 属主：addchar 内部用 chat 元数据的 username，而下方
        //   ensureModeChatsForChar 用认证 username——两者不同人时会把四模式线建到错误用户名下。
        //   fail-closed：目标 chat 不存在或不属于认证用户 → 404（不泄露他人 chat 存在性）。
        const _bindMeta = await loadChat(chatid).catch(() => null);
        if (!_bindMeta || getChatMetadatas().get(chatid)?.username !== username) {
          return res.status(404).json({ error: "Chat not found" });
        }
        const tAddchar = Date.now();
        await addchar(chatid, charname);
        logReq(
          `◀ POST /char addchar 完成, addcharCost=${Date.now() - tAddchar}ms, 准备返回 200`,
        );
        // 绑定成功后仍需确认四模式作业线完整；不能把部分成功伪装成绑定完成。
        const modeChats = await ensureModeChatsForChar(username, charname);
        const missingModes = getMissingModeChatModes(modeChats);
        if (missingModes.length) {
          return res.status(409).json({
            success: false,
            partial: true,
            code: "E_MODE_CHAT_INCOMPLETE",
            modeChats,
            missingModes,
            error: `角色已绑定当前对话，但模式对话未建全: ${missingModes.join(", ")}`,
            _diag: { reqDiagId, totalMs: Date.now() - reqStartAt },
          });
        }
        res.status(200).json({
          success: true,
          modeChats,
          _diag: { reqDiagId, totalMs: Date.now() - reqStartAt },
        });
      } catch (err) {
        logReq(`★ POST /char 异常: ${err.message}`);
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        // 角色不存在（脏/陈旧 charname）→ 结构化 404，前端可识别，不再当 500 幽灵错误
        if (err.code === "CHAR_NOT_FOUND")
          return res.status(404).json({
            error: "Char not found",
            code: "CHAR_NOT_FOUND",
            charname: err.charname,
            _diag: { reqDiagId, totalMs: Date.now() - reqStartAt },
          });
        console.error("[chat/addchar] Error:", err.message);
        res.status(500).json({
          error: err.message,
          _diag: { reqDiagId, totalMs: Date.now() - reqStartAt },
        });
      }
    },
  );

  router.delete(
    "/api/parts/shells\\:chat/:chatid/char/:charname",
    authenticate,
    async (req, res) => {
      try {
        const { chatid, charname } = req.params;
        await removechar(chatid, charname);
        res.status(200).json({ success: true });
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/removechar] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/:chatid/plugin",
    authenticate,
    async (req, res) => {
      try {
        const {
          params: { chatid },
          body: { pluginname },
        } = req;
        await addplugin(chatid, pluginname);
        res.status(200).json({ success: true });
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/addplugin] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.delete(
    "/api/parts/shells\\:chat/:chatid/plugin/:pluginname",
    authenticate,
    async (req, res) => {
      try {
        const { chatid, pluginname } = req.params;
        await removeplugin(chatid, pluginname);
        res.status(200).json({ success: true });
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/removeplugin] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/new",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const mode = req.body?.mode || null;
        res.status(200).json({ chatid: await newChat(username, mode) });
      } catch (err) {
        console.error("[chat/new] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // [0802 四窗口对话收口] 确保角色卡在四个模式窗口（chat/smart/code/work）各有一条专属对话。
  // 幂等（已有线返现值、缺失线新建）。前端 resolveChatIdForChar 规则3 / initializeChat 兜底 调用，
  // 解决默认角色卡「新的开始」首次使用时只建 1 条对话被四窗共用的根因。
  // 单源=chatOps.ensureModeChatsForChar（与 create-char/import-char 同一实现体）。
  router.post(
    "/api/parts/shells\\:chat/ensure-mode-chats",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { charname } = req.body || {};
        if (!charname || typeof charname !== "string" || !charname.trim())
          return res.status(400).json({ error: "缺少 charname" });
        const modeChats = await ensureModeChatsForChar(username, charname.trim());
        const missingModes = getMissingModeChatModes(modeChats);
        if (missingModes.length) {
          return res.status(409).json({
            success: false,
            code: "E_MODE_CHAT_INCOMPLETE",
            modeChats,
            missingModes,
            error: `模式对话未建全: ${missingModes.join(", ")}`,
          });
        }
        res.status(200).json({ success: true, modeChats });
      } catch (err) {
        // [0804] 角色不存在（换用户残留/已删角色名）→ 结构化 404：ensure 现已先验角色零建线，
        //   前端据此提示清 stale 角色而不是收到 500 幽灵错误（与 POST /char 的映射同范式）。
        if (err.code === "CHAR_NOT_FOUND")
          return res.status(404).json({ error: "Char not found", code: "CHAR_NOT_FOUND", charname: err.charname });
        console.error("[chat/ensure-mode-chats] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // [P0-A 2026-08-03] Smart 提案确认协调入口（confirm / cancel / status）
  // 功能链：replyHandler 提案硬门产生 pending 记录 → 前端确认卡 → 本三端点。
  // 契约：只信 session owner（getUserByReq）+ 记录内 sourceChatId；payload 不能覆盖 owner；
  //   confirm=单次 claim（并发只有一个执行者），confirmed 重放幂等返回既有结果；
  //   目标线只从服务端单源 ensureModeChatsForChar 导出（不信任何 payload chatid）；
  //   返回 status:"accepted" 只表达 task_start 已落盘被接受，不冒充 AI ready/succeeded。
  // ═══════════════════════════════════════════════════════════════
  router.post(
    "/api/parts/shells\\:chat/smart-confirmations/confirm",
    authenticate,
    async (req, res) => {
      let _claimedRec = null;
      let _confUser = "";
      try {
        _confUser = (await getUserByReq(req)).username;
        const { confirmationId, revision, sourceChatId, note } = req.body || {};
        if (!confirmationId || typeof confirmationId !== "string")
          return res.status(400).json({ success: false, code: "E_CONFIRM_BAD_REQUEST", error: "缺少 confirmationId" });
        const _claim = claimConfirmation(_confUser, {
          confirmationId,
          revision,
          sourceChatId: typeof sourceChatId === "string" ? sourceChatId : "",
        });
        if (!_claim.ok) {
          // confirmed 重放 → 幂等返回既有执行结果（重放对账），不重复执行
          if (_claim.code === "E_CONFIRM_ALREADY_EXECUTED") {
            return res.status(200).json({ success: true, status: "accepted", deduped: true, confirmation: projectConfirmation(_claim.record) });
          }
          const _httpCode = _claim.code === "E_CONFIRM_NOT_FOUND" ? 404 : _claim.code === "E_CONFIRM_OWNER_MISMATCH" ? 403 : 409;
          return res.status(_httpCode).json({ success: false, code: _claim.code, error: _claim.error, confirmation: projectConfirmation(_claim.record) });
        }
        _claimedRec = _claim.record;
        // 1. 目标 mode chat：服务端单源补齐（缺失线新建，幂等；不复制前端创建逻辑）
        const _modeChats = await ensureModeChatsForChar(_confUser, _claimedRec.sourceCharName);
        const _targetChatId = _modeChats?.[_claimedRec.targetMode];
        if (!_targetChatId) throw new Error(`目标 ${_claimedRec.targetMode} 模式对话补齐失败（ensureModeChatsForChar 未返回该线）`);
        // 2. 目标线模式绑定（active_modes_map[chatId]）——失败向上传导，不静默
        const _bindRes = setActiveMode(_confUser, _claimedRec.sourceCharName, _claimedRec.targetMode, _targetChatId);
        if (!_bindRes?.success) throw new Error(`目标线模式绑定失败: ${_bindRes?.error || "未知错误"}`);
        // 3. task_start 落盘（文本=injectTexts 可编辑模板；client_msg_id 幂等键防 claim 后半程崩溃重试双写）
        const _noteStr = typeof note === "string" ? note.trim().slice(0, 2000) : "";
        const _startContent = fillInjectText("smart.task_start", {
          mode: _claimedRec.targetMode,
          title: _claimedRec.taskTitle || "",
          note: _noteStr,
          confirmation_id: _claimedRec.confirmationId,
        });
        const _startMsgKey = `smartconf_${_claimedRec.confirmationId}`;
        let _entry = getRecentUserReply(_targetChatId, _startMsgKey);
        if (!_entry) {
          _entry = await addUserReply(
            _targetChatId,
            { content: _startContent, files: [], client_msg_id: _startMsgKey },
            { expectedUsername: _confUser },
          );
        }
        completeClaim(_confUser, _claimedRec.confirmationId, { targetChatId: _targetChatId, taskStartMessageId: _entry?.id || "" });
        const _executedId = _claimedRec.confirmationId;
        _claimedRec = null; // 已收尾，catch 不再回退
        // 4. 目标线生成异步触发：返回值只表达 task_start 已接受/已持久化，不把异步 AI 完成写成成功
        triggerCharReply(_targetChatId, undefined, { userInitiated: true }).catch((err) => {
          console.warn("[chat/smart-confirm] 目标线生成触发失败（task_start 已落盘，用户可在目标窗口手动触发）:", err?.message);
        });
        return res.status(200).json({
          success: true,
          status: "accepted",
          confirmationId: _executedId,
          targetChatId: _targetChatId,
          taskStartMessageId: _entry?.id || "",
        });
      } catch (err) {
        // claim 后执行失败：回退 pending + 记 lastError（用户可见可重试），绝不显示成功
        if (_claimedRec && _confUser) {
          try { failClaim(_confUser, _claimedRec.confirmationId, err); } catch { /* 回退失败仅日志 */ }
        }
        console.error("[chat/smart-confirm] Error:", err?.message);
        return res.status(500).json({ success: false, code: "E_CONFIRM_EXEC_FAILED", error: err?.message || String(err) });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/smart-confirmations/cancel",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { confirmationId, sourceChatId } = req.body || {};
        if (!confirmationId || typeof confirmationId !== "string")
          return res.status(400).json({ success: false, code: "E_CONFIRM_BAD_REQUEST", error: "缺少 confirmationId" });
        const _r = cancelConfirmation(username, {
          confirmationId,
          sourceChatId: typeof sourceChatId === "string" ? sourceChatId : "",
        });
        if (!_r.ok) {
          const _httpCode = _r.code === "E_CONFIRM_NOT_FOUND" ? 404 : _r.code === "E_CONFIRM_OWNER_MISMATCH" ? 403 : 409;
          return res.status(_httpCode).json({ success: false, code: _r.code, error: _r.error, confirmation: projectConfirmation(_r.record) });
        }
        return res.status(200).json({ success: true, confirmation: projectConfirmation(_r.record) });
      } catch (err) {
        console.error("[chat/smart-cancel] Error:", err?.message);
        return res.status(500).json({ success: false, error: err?.message || String(err) });
      }
    },
  );

  // 状态查询（刷新/重连重新投影确认卡；只返回本 owner 的记录）
  router.get(
    "/api/parts/shells\\:chat/:chatid/smart-confirmations",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const _list = listConfirmations(username, req.params.chatid);
        return res.status(200).json({ success: true, confirmations: _list });
      } catch (err) {
        console.error("[chat/smart-confirmations] Error:", err?.message);
        return res.status(500).json({ success: false, error: err?.message || String(err) });
      }
    },
  );

  // bot 对话文件（凛倾 07-09「当前角色卡新建对话+绑定，一个平台一个」）：
  // 幂等 ensure（已存在返回既有 chatid）。命名带 BOT_CHAT_SYMBOL，前端列表按符号屏蔽。
  router.post(
    "/api/parts/shells\\:chat/newbotchat",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { charname, platform, fresh, chatid, peek } = req.body || {};
        if (!charname || !platform)
          return res.status(400).json({ error: "缺少 charname 或 platform" });
        // fresh=新建并切指针 / chatid=切到指定已有对话 / peek=只查当前绑定不创建 / 缺省=有则返回无则建
        res.status(200).json(await ensureBotChat(username, String(charname), String(platform), { fresh: !!fresh, chatid: chatid ? String(chatid) : "", peek: !!peek }));
      } catch (err) {
        console.error("[chat/newbotchat] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/getchatlist",
    authenticate,
    async (req, res) => {
      try {
        res
          .status(200)
          .json(await getChatList((await getUserByReq(req)).username));
      } catch (err) {
        console.error("[chat/getchatlist] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/search",
    authenticate,
    async (req, res) => {
      try {
        const username = (await getUserByReq(req)).username;
        const { query, charName, limit: rawLimit } = req.body || {};
        if (!query || typeof query !== "string" || query.trim().length < 2) {
          return res.status(400).json({ error: "query 至少 2 字符" });
        }
        const q = query.trim().toLowerCase();
        const maxResults = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const chatList = await getChatList(username);
        const results = [];
        for (const chat of chatList) {
          if (results.length >= maxResults) break;
          if (charName && chat.primaryCharName !== charName) continue;
          try {
            await loadChat(chat.chatid);
            const log = await GetChatLog(chat.chatid);
            if (!Array.isArray(log)) continue;
            for (let i = 0; i < log.length && results.length < maxResults; i++) {
              if (isDeleted(log[i])) continue;
              const content = log[i]?.content;
              if (!content || typeof content !== "string") continue;
              const idx = content.toLowerCase().indexOf(q);
              if (idx === -1) continue;
              const start = Math.max(0, idx - 40);
              const end = Math.min(content.length, idx + q.length + 40);
              results.push({
                chatId: chat.chatid,
                chatTitle: chat.customName || chat.primaryCharName || chat.chatid,
                messageIndex: i,
                role: log[i].role || (log[i].is_user ? "user" : "assistant"),
                // T032 补差：回带 time_stamp，前端切对话后按 messageList data-timestamp 锚点
                // 定位并滚动到命中消息（复用 taskTimeline 时间最近邻定位法，非按 index 定位——
                // 因 log 含 _hidden/_deleted 条目而 DOM 渲染形态不同，index↔DOM 不等价）。
                timeStamp: log[i]?.time_stamp || null,
                snippet: (start > 0 ? "…" : "") + content.slice(start, end).replace(/\n/g, " ") + (end < content.length ? "…" : ""),
              });
            }
          } catch (_loadErr) { /* 加载失败跳过该对话 */ }
        }
        res.status(200).json({ success: true, results, total: results.length });
      } catch (err) {
        console.error("[chat/search] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.delete(
    "/api/parts/shells\\:chat/delete",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const chatids = req.body?.chatids;
        if (!Array.isArray(chatids) || chatids.length === 0
          || chatids.some((chatid) => typeof chatid !== "string" || !chatid)) {
          return res.status(400).json({ error: "chatids 必须是非空会话 ID 数组" });
        }
        if (new Set(chatids).size !== chatids.length) {
          return res.status(400).json({ error: "chatids 不得包含重复会话 ID" });
        }
        // 先验证整批，再执行第一项删除，避免遇到越权/不存在 ID 时留下半批提交。
        for (const chatid of chatids) {
          if (!(await _assertChatOwner(req, res, chatid))) return;
        }
        const result = await deleteChat(chatids, username);
        const failed = result.find((item) => item?.success !== true);
        const status = failed
          ? (Number.isInteger(failed.statusCode) ? failed.statusCode : 409)
          : 200;
        res.status(status).json(result);
      } catch (err) {
        console.error("[chat/delete] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // N39: 对话改名（服务端持久化，设计 IDE模式_界面设计.md :262）
  router.post(
    "/api/parts/shells\\:chat/:chatid/rename",
    authenticate,
    async (req, res) => {
      try {
        const result = await renameChat(
          req.params.chatid,
          (await getUserByReq(req)).username,
          req.body?.name,
        );
        res.status(result.success ? 200 : 404).json(result);
      } catch (err) {
        console.error("[chat/rename] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 对话模式徽标（服务端持久化，对齐 N39 rename 范式；存储/校验在 chatStorage.setChatMode）
  router.post(
    "/api/parts/shells\\:chat/:chatid/mode",
    authenticate,
    async (req, res) => {
      try {
        const result = await setChatMode(
          req.params.chatid,
          (await getUserByReq(req)).username,
          req.body?.mode,
        );
        res.status(result.success ? 200 : 404).json(result);
      } catch (err) {
        console.error("[chat/mode] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 收藏/置顶标记（服务端持久化，对齐 rename/mode 范式；存储/卫生在 chatStorage.setChatFlags——
  //   0715 LS-4：原只存前端 localStorage convMeta，多窗口整对象覆盖丢标记，权威上移）
  router.post(
    "/api/parts/shells\\:chat/:chatid/flags",
    authenticate,
    async (req, res) => {
      try {
        const result = await setChatFlags(
          req.params.chatid,
          (await getUserByReq(req)).username,
          { starred: req.body?.starred, pinned: req.body?.pinned },
        );
        res.status(result.success ? 200 : 404).json(result);
      } catch (err) {
        console.error("[chat/flags] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 模式窗口在用指针（服务端持久化：`${mode}:${charName}`→chatid；存储/校验在 chatStorage.setModeActiveChat）
  // 「XX窗口在用」标签的权威写点；getChatList 注入 usedByModes 是读点。
  // R1 0713：键的 char 段由服务端反查对话 primaryCharName，body 不再收 charName
  //   （前端 charName 源常空 → 双闸静默拒写=徽标冻结案根因；char≡primaryCharName 本是该键语义）。
  router.post(
    "/api/parts/shells\\:chat/:chatid/using",
    authenticate,
    async (req, res) => {
      try {
        const result = await setModeActiveChat(
          req.params.chatid,
          (await getUserByReq(req)).username,
          req.body?.mode,
        );
        res.status(result.success ? 200 : 404).json(result);
      } catch (err) {
        console.error("[chat/using] Error:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // 对话分叉：从源对话指定消息处创建分支副本
  router.post(
    "/api/parts/shells\\:chat/branch",
    authenticate,
    async (req, res) => {
      try {
        const { chatid, messageId, messageIndex, wholeChat } = req.body || {};
        const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
        const wantsWholeChat = wholeChat === true;
        if (!chatid) {
          return res.status(400).json({ success: false, code: "E_BRANCH_CHAT_REQUIRED", error: "缺少 chatid" });
        }
        if ((normalizedMessageId && wantsWholeChat) || (!normalizedMessageId && !wantsWholeChat)) {
          return res.status(400).json({
            success: false,
            code: normalizedMessageId ? "E_BRANCH_SELECTOR_AMBIGUOUS" : "E_BRANCH_SELECTOR_REQUIRED",
            error: normalizedMessageId
              ? "messageId 与 wholeChat=true 只能选择一种分叉意图"
              : "必须提供非空 messageId 或显式 wholeChat=true",
          });
        }
        if (messageIndex != null && (!Number.isSafeInteger(messageIndex) || messageIndex < 0)) {
          return res.status(400).json({ success: false, code: "E_BRANCH_INDEX_HINT_INVALID", error: "messageIndex 必须是非负安全整数" });
        }
        // SEC：chatid 来自 body，router.param 不触发 → inline 校验属主
        if (!(await _assertChatOwner(req, res, chatid))) return;
        const newChatid = await branchChat(chatid, {
          ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
          ...(messageIndex != null ? { indexHint: messageIndex } : {}),
          wholeChat: wantsWholeChat,
        }, (await getUserByReq(req)).username);
        res.json({ chatid: newChatid });
      } catch (e) {
        const status = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
        if (status >= 500) console.error("[branch] Error:", e.message);
        res.status(status).json({ success: false, code: e?.code || "E_BRANCH_UNEXPECTED", error: e.message });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/addfile",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const data = req.files;
        for (const file of Object.values(data))
          await addfile(username, file.data);
        res.status(200).json({ message: "files added" });
      } catch (err) {
        console.error("[chat/POST addfile] Error:", err);
        if (/not found/i.test(err.message))
          return res.status(404).json({ error: "Not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/api/parts/shells\\:chat/getfile",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { hash } = req.query;
        const data = await getfile(username, hash);
        res.status(200).send(data);
      } catch (err) {
        console.error("[chat/GET getfile] Error:", err);
        if (/not found/i.test(err.message))
          return res.status(404).json({ error: "File not found" });
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ---- 批量删除消息范围 API（文件模式隔离用） ----
  router.post(
    "/api/parts/shells\\:chat/:chatid/messages/delete-range",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        const { username } = await getUserByReq(req);
        const { startIndex, endIndex, anchorMessageId } = req.body || {};
        if (startIndex == null)
          return res.status(400).json({ error: "Missing startIndex" });
        if (typeof anchorMessageId !== "string" || !anchorMessageId.trim()) {
          return res.status(400).json({ success: false, error: "anchorMessageId is required" });
        }
        const parsedStartIndex = parseNonNegativeInteger(startIndex);
        const parsedEndIndex = endIndex != null
          ? parseNonNegativeInteger(endIndex)
          : undefined;
        if (parsedStartIndex == null || (endIndex != null && parsedEndIndex == null)) {
          return res.status(400).json({ error: "Invalid message range" });
        }
        const result = await deleteMessagesRange(
          chatid,
          parsedStartIndex,
          parsedEndIndex,
          { anchorMessageId: anchorMessageId.trim(), expectedUsername: username },
        );
        res.status(200).json({ success: result.applied, ...result });
      } catch (err) {
        const _code = Number.isInteger(err?.statusCode)
          ? err.statusCode
          : err.message === "Invalid startIndex" || err.message === "Invalid endIndex" || err.message === "Chat not found" ? 400 : 500;
        if (_code >= 500) console.error("[chat/deleteMessagesRange] Error:", err);
        res.status(_code).json({ error: err.message });
      }
    },
  );

  // ---- 统一跨存储回档：稳定消息锚 → 生成静默 → 记忆/IDE → chat 截断 ----
  router.post(
    "/api/parts/shells\\:chat/:chatid/rollback/preview",
    authenticate,
    async (req, res) => {
      try {
        const targetIndex = parseNonNegativeInteger(req.body?.targetIndex);
        const anchorMessageId = req.body?.anchorMessageId;
        if (typeof anchorMessageId !== "string" || !anchorMessageId.trim() || targetIndex == null) {
          return res.status(400).json({
            success: false,
            applied: false,
            partial: false,
            code: "E_INVALID_ROLLBACK_REQUEST",
            error: "anchorMessageId and non-negative targetIndex are required",
          });
        }
        const { username } = await getUserByReq(req);
        const result = await getCoordinatedRollbackPreview({
          chatId: req.params.chatid,
          username,
          anchorMessageId,
          targetIndex,
        });
        const status = result.success
          ? 200
          : result.code === "E_ROLLBACK_ANCHOR_NOT_FOUND" ? 404 : 409;
        return res.status(status).json(result);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        if (status >= 500) console.error("[chat/rollback/preview] Unexpected error:", error);
        return res.status(status).json({
          success: false,
          applied: false,
          partial: false,
          code: error?.code || "E_ROLLBACK_PREVIEW_UNEXPECTED",
          error: error?.message || String(error),
        });
      }
    },
  );

  router.post(
    "/api/parts/shells\\:chat/:chatid/rollback",
    authenticate,
    async (req, res) => {
      try {
        const targetIndex = parseNonNegativeInteger(req.body?.targetIndex);
        const anchorMessageId = req.body?.anchorMessageId;
        if (typeof anchorMessageId !== "string" || !anchorMessageId.trim() || targetIndex == null) {
          return res.status(400).json({
            success: false,
            applied: false,
            partial: false,
            code: "E_INVALID_ROLLBACK_REQUEST",
            error: "anchorMessageId and non-negative targetIndex are required",
          });
        }
        const { username } = await getUserByReq(req);
        const result = await executeCoordinatedRollback({
          chatId: req.params.chatid,
          username,
          anchorMessageId,
          targetIndex,
          expectedIdeConnected: req.body?.expectedIdeConnected,
          expectedIdeRoute: req.body?.expectedIdeRoute,
          checkpointIds: req.body?.checkpointIds,
          tableSnapshotId: req.body?.tableSnapshotId,
          expectedCharacterScope: req.body?.expectedCharacterScope,
          characterScopeToken: req.body?.characterScopeToken,
        });
        const status = result.partial !== true
          && (result.confirmed === true || result.noOpConfirmed === true)
          ? 200
          : result.code === "E_ROLLBACK_ANCHOR_NOT_FOUND" ? 404 : 409;
        return res.status(status).json(result);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        if (status >= 500) console.error("[chat/rollback] Unexpected error:", error);
        return res.status(status).json({
          success: false,
          applied: false,
          partial: false,
          code: error?.code || "E_ROLLBACK_UNEXPECTED",
          error: error?.message || String(error),
        });
      }
    },
  );

  // ---- 隐藏消息范围 API（删除=不发送掩码 _hidden，非物理删除，可逆） ----
  // 文件/记忆模式隔离、上下文清理统一走这里：消息留盘可逆，仅 requestBuilder:97 过滤不送 AI
  router.post(
    "/api/parts/shells\\:chat/:chatid/messages/hide",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        const { username } = await getUserByReq(req);
        const { startIndex, endIndex, indices, messageIds, hide, meta: _reqMeta } = req.body || {};
        const hasMessageIds = Object.prototype.hasOwnProperty.call(req.body || {}, "messageIds");
        let normalizedMessageIds;
        if (hasMessageIds) {
          if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.some((id) => typeof id !== "string" || !id.trim())) {
            return res.status(400).json({ success: false, code: "E_HIDE_MESSAGE_IDS_INVALID", error: "messageIds 必须是非空字符串 ID 数组" });
          }
          normalizedMessageIds = messageIds.map((id) => id.trim());
          if (new Set(normalizedMessageIds).size !== normalizedMessageIds.length) {
            return res.status(400).json({ success: false, code: "E_HIDE_MESSAGE_IDS_DUPLICATED", error: "messageIds 不得包含重复 ID" });
          }
        }
        let idxList;
        if (Array.isArray(indices)) {
          idxList = indices.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
        } else if (startIndex != null) {
          const total = await GetChatLogLength(chatid);
          const start = Math.max(0, parseInt(startIndex, 10));
          const end = endIndex != null ? Math.min(total, parseInt(endIndex, 10)) : total;
          idxList = [];
          for (let i = start; i < end; i++) idxList.push(i);
        } else if (!hasMessageIds) {
          return res.status(400).json({ error: "Missing startIndex or indices" });
        } else {
          idxList = [];
        }
        // T4: 调用方可通过 body.meta 传入真实来源(auto/ai)；缺省→手动端点 by=user
        const _meta = _reqMeta && _reqMeta.by ? { by: _reqMeta.by, reason: _reqMeta.reason || _reqMeta.by } : { by: "user", reason: "manual" };
        const result = await hideMessages(chatid, idxList, hide !== false, {
          ...(hasMessageIds ? { ids: normalizedMessageIds } : {}),
          messageMeta: _meta,
          expectedUsername: username,
        });
        const status = result.success !== false
          ? 200
          : result.partial ? 409 : result.code === "E_HIDE_MESSAGE_IDS_NOT_FOUND" ? 404 : 400;
        res.status(status).json(result);
      } catch (err) {
        console.error("[chat/hideMessages] Error:", err);
        res.status(Number.isInteger(err?.statusCode) ? err.statusCode : 500).json({ error: err.message });
      }
    },
  );

  // ---- 伪发送 API ----
  router.get(
    "/api/parts/shells\\:chat/:chatid/fake-send",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        const charname = req.query.charname || undefined;
        const result = await buildFakeSendRequest(chatid, charname);
        res.status(200).json(result);
      } catch (err) {
        if (err.message === "Chat not found")
          return res.status(404).json({ error: "Chat not found" });
        console.error("[chat/fake-send] Error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // T8 清理（07-03）：_t5shadow 影子比对端点已删（T5 步骤4 对照面，切流量后全量回归多轮 PASS=历史使命完成；
  //   Legacy 旧线同批删，正线=buildPromptStruct→ViaModes 影子孪生转正）。原件备份 yonban迁移_T8_Legacy与探针清理_*。

  // ============================================================
  // 背景图 API（C3: 自定义聊天背景）
  // 存储位置: {userDir}/shells/chat/chat_background.{ext}
  // ============================================================

  // POST /api/parts/shells:chat/background — 上传背景图
  router.post(
    "/api/parts/shells\\:chat/background",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const uploadedFile = req.files?.file;
        if (!uploadedFile) {
          return res.status(400).json({ error: "未上传文件" });
        }

        const fileName = uploadedFile.name || "";
        const ext = fileName.toLowerCase().split(".").pop();
        const allowedExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
        if (!allowedExts.includes(ext)) {
          return res.status(400).json({ error: `不支持的图片格式: .${ext}` });
        }

        const userDir = getUserDictionary(username);
        const bgDir = path.join(userDir, "shells", "chat");
        fs.mkdirSync(bgDir, { recursive: true });

        for (const oldExt of allowedExts) {
          const oldPath = path.join(bgDir, `chat_background.${oldExt}`);
          if (fs.existsSync(oldPath)) {
            await safeUnlink(oldPath, "背景图替换");
          }
        }

        // 保存新背景图
        const bgPath = path.join(bgDir, `chat_background.${ext}`);
        fs.writeFileSync(bgPath, uploadedFile.data);

        console.log(
          `[beilu-chat] 背景图已上传: chat_background.${ext} (user: ${username})`,
        );
        res.json({ success: true, filename: `chat_background.${ext}` });
      } catch (err) {
        console.error("[beilu-chat] 背景图上传失败:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // GET /api/parts/shells:chat/background — 获取背景图
  router.get(
    "/api/parts/shells\\:chat/background",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const userDir = getUserDictionary(username);
        const bgDir = path.join(userDir, "shells", "chat");

        const allowedExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
        for (const ext of allowedExts) {
          const bgPath = path.join(bgDir, `chat_background.${ext}`);
          if (fs.existsSync(bgPath)) {
            const mimeMap = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
              bmp: "image/bmp",
              svg: "image/svg+xml",
            };
            res.setHeader(
              "Content-Type",
              mimeMap[ext] || "application/octet-stream",
            );
            res.setHeader("Cache-Control", "no-cache");
            return res.send(fs.readFileSync(bgPath));
          }
        }
        // 无背景图 → 204
        res.status(204).end();
      } catch (err) {
        console.error("[beilu-chat] 获取背景图失败:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // DELETE /api/parts/shells:chat/background — 删除背景图
  router.delete(
    "/api/parts/shells\\:chat/background",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const userDir = getUserDictionary(username);
        const bgDir = path.join(userDir, "shells", "chat");

        const allowedExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
        let deleted = false;
        for (const ext of allowedExts) {
          const bgPath = path.join(bgDir, `chat_background.${ext}`);
          if (fs.existsSync(bgPath)) {
            await safeUnlink(bgPath, "删除背景图");
            deleted = true;
          }
        }
        res.json({ success: true, deleted });
      } catch (err) {
        console.error("[beilu-chat] 删除背景图失败:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // O16: fileDelivery 下载端点 — AI 通过 <fileDelivery> 标签投递的文件，前端经此端点触发浏览器下载。
  // 安全：authenticate + chatid 属主校验（router.param 覆盖）+ confinePath 围栏（防穿越到用户数据目录外）。
  router.get(
    "/api/parts/shells\\:chat/file-delivery/:chatid",
    authenticate,
    async (req, res) => {
      try {
        const { chatid } = req.params;
        const filePath = req.query.path;
        if (!filePath || typeof filePath !== "string") {
          return res.status(400).json({ error: "缺少 path 参数" });
        }
        // chatid 属主校验由 router.param("chatid") 统一覆盖（SEC 破口1 修复），此处只需通过即可。
        const { username } = await getUserByReq(req);
        const userDir = getUserDictionary(username);

        // 安全围栏：confinePath 将 filePath resolve 到 userDir 内，逃出则抛 Error。
        let safePath;
        try {
          safePath = confinePath(userDir, filePath);
        } catch (_confineErr) {
          console.warn(`[chat/endpoints] file-delivery 路径越界: user=${username}, path=${filePath}`);
          return res.status(403).json({ error: "路径越界，拒绝访问" });
        }

        if (!fs.existsSync(safePath)) {
          return res.status(404).json({ error: "文件不存在" });
        }
        const stat = fs.statSync(safePath);
        if (!stat.isFile()) {
          return res.status(400).json({ error: "路径不是文件" });
        }

        const fileName = path.basename(safePath);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(req.query.name || fileName)}`,
        );
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", stat.size);
        const stream = fs.createReadStream(safePath);
        stream.pipe(res);
      } catch (err) {
        console.error("[chat/endpoints] file-delivery 失败:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.get(
    "/virtual_files/parts/shells\\:chat/:chatid",
    authenticate,
    async (req, res) => {
      const { chatid } = req.params;
      const exportResult = await exportChat([chatid]);
      if (!exportResult[0]?.success)
        return res.status(500).json({
          message: exportResult[0]?.message || "Failed to export chat",
        });

      const chatData = exportResult[0].data;
      const filename = `chat-${chatid}.json`;
      const fileContents = JSON.stringify(chatData, null, "\t");

      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(fileContents);
    },
  );

  // ============================================================
  // 角色卡导入/导出 API（从 beilu-home 迁入）
  // import-char: 8 步（解析→创建→模板→chardata→beilu-part→头像→AIsource→通知→正则迁移→世界书迁移）
  // export: PNG(tEXt chunk) 或 JSON 下载
  // ============================================================

  // POST /api/parts/shells:chat/import-char — 导入角色卡（JSON / PNG）
  // 步骤：
  //   1. 解析文件（JSON 直读 / PNG 经 SillyTavern data_reader 提取 tEXt chunk）
  //   2. 创建角色卡目录（重名自动加数字后缀）
  //   3. 复制 beilu-char-template/main.mjs（角色卡模板）
  //   4. 写入 chardata.json（完整保留原始 ST 数据不篡改）+ beilu-part.json
  //   5. 保存头像图片（PNG 导入时提取）
  //   6. 自动配置 AIsource（复用已有角色卡的 → 找 proxy 源 → 无则跳过）
  //   7. 迁移内嵌正则 extensions.regex_scripts → beilu-regex config_data.json（幂等先清后导）
  //   8. 迁移内嵌世界书 character_book → beilu-worldbook config_data.json（绑定书 enabled=false
  //      靠 boundMatch 私有注入本角色；enabled=true 会经 globalEnabled 泄漏进所有角色）
  //   notifyPartInstall + sendEventToUser 刷新前端
  router.post(
    "/api/parts/shells\\:chat/import-char",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);

        // express-fileupload 解析后的文件
        const uploadedFile = req.files?.file;
        if (!uploadedFile) {
          return res.status(400).json({ message: "未上传文件" });
        }

        const fileName = uploadedFile.name || "";
        const fileBuffer = uploadedFile.data;
        const ext = fileName.toLowerCase().split(".").pop();

        let charDataRaw = null;
        let imageBuffer = null;

        // --- 根据文件类型解析 ---
        if (ext === "json") {
          const text = fileBuffer.toString("utf-8");
          charDataRaw = JSON.parse(text);
        } else if (ext === "png") {
          try {
            // ★ F-D5 XSS：解析前先按 magic bytes 断言真实 MIME（复用 ST 权威 assertSafeCharImage，
            //   与 ImportAsData(main.mjs:71) 同范式）。import-char 是独立于 ImportAsData 的第二条
            //   角色卡导入入口，F-D5 防护原只覆盖 ST 入口，此处漏接 → 伪装成 .png 的 SVG/HTML polyglot
            //   可绕过。断言拒非 PNG / SVG(可内联 <script>) / 伪装 polyglot，非法抛错→下方 catch 返 400。
            const { assertSafeCharImage } = await import(
              "../../../ImportHandlers/SillyTavern/main.mjs"
            );
            await assertSafeCharImage(fileBuffer);
            const dataReader = await import(
              "../../../ImportHandlers/SillyTavern/data_reader.mjs"
            );
            const charaJson = dataReader.read(fileBuffer);
            charDataRaw = JSON.parse(charaJson);
            // ★ F-D5 XSS：头像写盘前经 data_reader.remove 重序列化 PNG（png-chunks-extract→encode），
            //   丢弃 IEND 之后的尾随字节 —— 消除"合法 PNG 头 + 尾部藏 HTML/JS"的 polyglot 落盘。
            //   不能用原始 fileBuffer 裸写（那样尾部 HTML 会随头像落盘）。
            imageBuffer = dataReader.remove(fileBuffer);
          } catch (pngErr) {
            return res
              .status(400)
              .json({ message: "PNG 中未找到角色卡数据: " + pngErr.message });
          }
        } else {
          return res.status(400).json({
            message: `不支持的文件格式: .${ext}（支持 .json / .png）`,
          });
        }

        if (!charDataRaw || typeof charDataRaw !== "object") {
          return res.status(400).json({ message: "角色卡数据解析失败" });
        }

        // 解析 ST chara_card_v2/v3 格式
        const data = charDataRaw.data || charDataRaw;
        const charName = (data.name || "unknown").trim();

        if (!charName) {
          return res.status(400).json({ message: "角色名称为空" });
        }

        // 安全检查：替换非法字符
        const safeName = sanitizeFilename(charName);
        const userDir = getUserDictionary(username);
        let charDir = path.join(userDir, "chars", safeName);

        // 处理重名：加数字后缀
        let finalName = safeName;
        let counter = 1;
        while (fs.existsSync(charDir)) {
          finalName = `${safeName}_${counter}`;
          charDir = path.join(userDir, "chars", finalName);
          counter++;
        }

        // 创建角色卡目录
        fs.mkdirSync(charDir, { recursive: true });

        // Step 1: 复制 beilu 角色卡模板 main.mjs
        const templateMain = path.join(CHAR_TEMPLATE_DIR, "main.mjs");
        if (fs.existsSync(templateMain)) {
          fs.copyFileSync(templateMain, path.join(charDir, "main.mjs"));
        } else {
          fs.rmSync(charDir, { recursive: true, force: true });
          console.warn(
            "[beilu-chat] 角色卡模板 main.mjs 不存在:",
            templateMain,
          );
          return res.status(500).json({ message: "角色卡模板缺失" });
        }

        // Step 2: 写入 chardata.json（完整保留原始 ST 数据，不篡改）
        nicerWriteFileSync(
          path.join(charDir, "chardata.json"),
          JSON.stringify(data, null, "\t"),
          "utf-8",
        );

        // Step 3: 写入 beilu-part.json
        nicerWriteFileSync(
          path.join(charDir, "beilu-part.json"),
          JSON.stringify({ type: "chars", dirname: finalName }, null, "\t"),
          "utf-8",
        );

        // Step 4: 保存头像图片
        if (imageBuffer) {
          const publicDir = path.join(charDir, "public");
          fs.mkdirSync(publicDir, { recursive: true });
          fs.writeFileSync(path.join(publicDir, "image.png"), imageBuffer);
        }

        // Step 5: 为新角色写入默认 AIsource 配置
        try {
          const parts_config = loadData(username, "parts_config");

          // 策略1: 复用已有角色卡的 AIsource
          let defaultAIsource = "";
          for (const [key, val] of Object.entries(parts_config)) {
            if (key.startsWith("chars/") && val?.AIsource) {
              defaultAIsource = val.AIsource;
              break;
            }
          }

          // 策略2: 找 generator === "proxy" 的第一个 AI 源
          if (!defaultAIsource) {
            for (const [key, val] of Object.entries(parts_config)) {
              if (
                key.startsWith("serviceSources/AI/") &&
                val?.generator === "proxy"
              ) {
                defaultAIsource = key.replace("serviceSources/AI/", "");
                break;
              }
            }
          }

          if (defaultAIsource) {
            parts_config[`chars/${finalName}`] = {
              AIsource: defaultAIsource,
              plugins: [],
            };
            saveData(username, "parts_config");
            console.log(
              `[beilu-chat] 自动配置 AIsource: "${defaultAIsource}" → chars/${finalName}`,
            );
          } else {
            console.warn(
              "[beilu-chat] 未找到可用的 AIsource，新角色卡需要手动配置",
            );
          }
        } catch (e) {
          console.warn("[beilu-chat] 自动配置 AIsource 失败:", e.message);
        }

        // Step 6: 通知 beilu 刷新 parts 缓存 + 跨客户端角色卡列表变更
        try {
          notifyPartInstall(username, `chars/${finalName}`);
        } catch (e) {
          console.warn("[beilu-chat] notifyPartInstall 失败:", e.message);
        }
        try { sendEventToUser(username, "char-data-changed", { charName: finalName }); } catch { /* 不阻塞导入 */ }

        // Step 7: 迁移角色卡内嵌正则（extensions.regex_scripts）进 beilu-regex 运行时存储
        //   应用层（displayRegex/applyRegexRules）只读 beilu-regex 的 config_data.json.rules，
        //   从不读 chardata.regex_scripts。后端 import-char 统一迁移，所有导入入口生效。
        //   口径：boundCharName = finalName（文件系统目录名）。幂等：先清后导。
        try {
          const stRegexScripts = data?.extensions?.regex_scripts;
          if (Array.isArray(stRegexScripts) && stRegexScripts.length > 0) {
            const regexPlugin =
              parts_set[username]?.["plugins/beilu-regex"];
            if (regexPlugin?.interfaces?.config?.SetData) {
              // 插件已加载：走插件 action（in-memory + saveConfigToDisk）
              // [T077 per-user] 两 SetData 加 {username} → 写该 user 的 store/盘（原无 user → 写共享单例=串台）。
              await regexPlugin.interfaces.config.SetData({
                _action: "removeByChar",
                charName: finalName,
              }, { username });
              const imp = await regexPlugin.interfaces.config.SetData({
                _action: "importST",
                scripts: stRegexScripts,
                scope: "scoped",
                boundCharName: finalName,
              }, { username });
              console.log(
                `[beilu-chat] 角色 "${finalName}" 迁移 ${imp?._result?.count ?? stRegexScripts.length} 条正则进 beilu-regex（in-memory）`,
              );
            } else {
              // 插件未加载：直接落盘（磁盘 fallback）
              // [T077 per-user] fallback 路径改 per-user：data/users/<user>/regex/config_data.json（原全局单文件=串台）。
              const { importFromSTFormat } = await import(
                "../../../plugins/beilu-regex/main.mjs"
              );
              const regexConfigPath = path.join(
                getUserDataDir(username),
                "regex",
                "config_data.json",
              );
              // [T077 per-user] 新用户首次导入时 regex/ 目录不存在，nicerWriteFileSync 不建目录 → 先 mkdir（与 T074 worldbook fallback 同款）。
              fs.mkdirSync(path.dirname(regexConfigPath), { recursive: true });
              // T019：损坏→备份.corrupt.bak后抛错，本段迁移中止（外层catch报错），不空库顶上写回。
              const regexData = readJsonSafeSync(regexConfigPath, { rules: [], enabled: true });
              if (!Array.isArray(regexData.rules)) regexData.rules = [];
              // 幂等：先清掉该 finalName 已有 scoped 规则
              regexData.rules = regexData.rules.filter(
                (r) => r.boundCharName !== finalName,
              );
              const converted = importFromSTFormat(
                stRegexScripts,
                "scoped",
                finalName,
                "",
              );
              regexData.rules.push(...converted);
              nicerWriteFileSync(
                regexConfigPath,
                JSON.stringify(regexData, null, 2),
                "utf-8",
              );
              console.log(
                `[beilu-chat] 角色 "${finalName}" 迁移 ${converted.length} 条正则进 beilu-regex（磁盘 fallback）`,
              );
            }
          }
        } catch (e) {
          console.warn(
            `[beilu-chat] 迁移角色 "${finalName}" 正则进 beilu-regex 失败:`,
            e.message,
          );
        }

        // Step 8: 迁移角色卡内嵌世界书（character_book）进 beilu-worldbook 运行时存储
        //   应用层 GetPrompt 只读 beilu-worldbook 的 config_data.json.worldbooks，
        //   从不读 chardata.character_book。后端 import-char 统一迁移。
        //   口径：boundCharName = finalName（文件系统目录名）。幂等：先清后导。
        //   **关键**：绑定书 enabled=false（靠 boundMatch 私有注入；enabled=true 会经 globalEnabled 泄漏）
        try {
          const charBook =
            data?.character_book || data?.extensions?.character_book;
          if (
            charBook?.entries &&
            (Array.isArray(charBook.entries)
              ? charBook.entries.length > 0
              : Object.keys(charBook.entries).length > 0)
          ) {
            const bookName = `${finalName} 世界书`;
            const worldbookPlugin =
              parts_set[username]?.["plugins/beilu-worldbook"];
            const entryCount = Array.isArray(charBook.entries)
              ? charBook.entries.length
              : Object.keys(charBook.entries).length;
            if (worldbookPlugin?.interfaces?.config?.SetData) {
              // 插件已加载：走插件 action（in-memory + saveConfigToDisk）
              // [T074] 传 { username } → SetData 落该用户 store（否则改 _default，导入的世界书用户看不到）。
              await worldbookPlugin.interfaces.config.SetData({
                removeByChar: { charName: finalName },
              }, { username });
              await worldbookPlugin.interfaces.config.SetData({
                import_worldbook: {
                  json: charBook,
                  name: bookName,
                  boundCharName: finalName,
                },
              }, { username });
              console.log(
                `[beilu-chat] 角色 "${finalName}" 迁移 ${entryCount} 条内嵌世界书进 beilu-worldbook（in-memory）`,
              );
            } else {
              // 插件未加载：直接落盘（磁盘 fallback）
              const { convertSTEntries } = await import(
                "../../../plugins/beilu-worldbook/main.mjs"
              );
              // [T074 per-user] 落该用户目录，与 configFileFor(username) 同口径（旧写全局→用户读不到）。
              const worldbookConfigPath = path.join(
                getUserDataDir(username),
                "worldbooks",
                "config_data.json",
              );
              fs.mkdirSync(path.dirname(worldbookConfigPath), { recursive: true });
              // T019：损坏→备份.corrupt.bak后抛错中止，不空库顶上写回清空其他世界书。
              const worldbookData = readJsonSafeSync(worldbookConfigPath, {
                active_worldbook: "",
                worldbooks: {},
              });
              if (
                !worldbookData.worldbooks ||
                typeof worldbookData.worldbooks !== "object"
              ) {
                worldbookData.worldbooks = {};
              }
              // 幂等：先清掉该 finalName 已绑定的世界书
              for (const [wbName, wb] of Object.entries(
                worldbookData.worldbooks,
              )) {
                if (wb?.boundCharName === finalName) {
                  delete worldbookData.worldbooks[wbName];
                }
              }
              const convertedEntries = convertSTEntries(charBook.entries);
              worldbookData.worldbooks[bookName] = {
                entries: convertedEntries,
                // 绑定书 enabled=false：靠 boundMatch 私有注入到本角色；
                // enabled=true 会经 globalEnabled 泄漏进所有角色。
                enabled: false,
                boundCharName: finalName,
              };
              worldbookData.active_worldbook = bookName;
              nicerWriteFileSync(
                worldbookConfigPath,
                JSON.stringify(worldbookData, null, 2),
                "utf-8",
              );
              console.log(
                `[beilu-chat] 角色 "${finalName}" 迁移 ${Object.keys(convertedEntries).length} 条内嵌世界书进 beilu-worldbook（磁盘 fallback）`,
              );
            }
          }
        } catch (e) {
          console.warn(
            `[beilu-chat] 迁移角色 "${finalName}" 内嵌世界书进 beilu-worldbook 失败:`,
            e.message,
          );
        }

        console.log(
          `[beilu-chat] 角色卡已导入: "${finalName}" (原名: "${charName}", user: ${username})`,
        );
        // 添加角色卡=建永久链路（凛倾0705拍板；导入用 finalName=重名加后缀后的最终落盘名）
        try { await addPermanentCharLink(username, finalName); } catch (e) { console.warn("[beilu-chat] 建永久链路失败(非致命):", e.message); } // T4：now async，await 保留错误被此 try/catch 捕获
        // 导入角色同样以四模式对话完整为成功条件；不能让导入接口掩盖缺失作业线。
        const modeChats = await ensureModeChatsForChar(username, finalName);
        const missingModes = getMissingModeChatModes(modeChats);
        if (missingModes.length) {
          return res.status(409).json({
            success: false,
            partial: true,
            code: "E_MODE_CHAT_INCOMPLETE",
            name: finalName,
            original_name: charName,
            modeChats,
            missingModes,
            error: `角色卡已导入，但模式对话未建全: ${missingModes.join(", ")}`,
          });
        }
        res.status(201).json({
          success: true,
          name: finalName,
          original_name: charName,
          chardata: data,
          modeChats,
        });
      } catch (error) {
        console.error("[beilu-chat] Error importing char:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // GET /api/parts/shells:chat/char/:charName/export — 导出角色卡 PNG 或 JSON
  router.get(
    "/api/parts/shells\\:chat/char/:charName/export",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const charName = confineSegment(req.params.charName);
        const format = req.query.format || "png";
        const userDir = getUserDictionary(username);
        const charDir = path.join(userDir, "chars", charName);
        const chardataPath = path.join(charDir, "chardata.json");
        if (!fs.existsSync(chardataPath)) {
          return res.status(404).json({ message: `角色 "${charName}" 数据不存在` });
        }
        const chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
        if (format === "json") {
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(charName)}.json"`);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          return res.status(200).send(JSON.stringify(chardata, null, 2));
        }
        const avatarPath = path.join(charDir, "public", "image.png");
        if (!fs.existsSync(avatarPath)) {
          // 无头像 PNG 时自动降级 JSON 导出（E1 框架级修：无图角色也可导出）
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(charName)}.json"`);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          return res.status(200).send(JSON.stringify(chardata, null, 2));
        }
        const { write: writePng } = await import(
          "../../../ImportHandlers/SillyTavern/data_reader.mjs"
        );
        const imageBuffer = fs.readFileSync(avatarPath);
        const exportData = JSON.stringify(chardata);
        const resultPng = writePng(imageBuffer, exportData);
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(charName)}.png"`);
        res.setHeader("Content-Type", "image/png");
        res.status(200).send(resultPng);
      } catch (error) {
        console.error("[beilu-chat] char export error:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // ============================================================
  // 人设 CRUD API（从 beilu-home 迁入，头像统一为 image.png）
  // ============================================================

  // POST /api/parts/shells:chat/persona/create — 创建用户人设
  router.post(
    "/api/parts/shells\\:chat/persona/create",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const { name, description } = req.body || {};

        if (!name || typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ message: "人设名称不能为空" });
        }

        const personaName = name.trim();
        if (/[\/\\:*?"<>|]/.test(personaName)) {
          return res.status(400).json({ message: "人设名称包含非法字符" });
        }

        const userDir = getUserDictionary(username);
        const personaDir = path.join(userDir, "personas", personaName);

        if (fs.existsSync(personaDir)) {
          return res
            .status(409)
            .json({ message: `人设 "${personaName}" 已存在` });
        }

        // 创建目录
        fs.mkdirSync(personaDir, { recursive: true });

        // 复制模板 main.mjs
        const templateMain = path.join(PERSONA_TEMPLATE_DIR, "main.mjs");
        if (fs.existsSync(templateMain)) {
          fs.copyFileSync(templateMain, path.join(personaDir, "main.mjs"));
        } else {
          fs.rmSync(personaDir, { recursive: true, force: true });
          return res.status(500).json({ message: "人设模板缺失" });
        }

        // 写入 beilu-part.json
        nicerWriteFileSync(
          path.join(personaDir, "beilu-part.json"),
          JSON.stringify(
            { type: "personas", dirname: personaName },
            null,
            "\t",
          ),
          "utf-8",
        );

        // 处理头像上传（统一文件名 image.png）
        let avatarFileName = "";
        const avatarFile = req.files?.avatar;
        if (avatarFile) {
          // ★ F-D5 XSS：人设头像同为 public/image.png，同型上传 XSS 面（同 import-char/角色卡头像）。
          //   magic bytes 断言拒 SVG/polyglot；data_reader.remove 重序列化剥 IEND 后尾随 HTML。
          const { assertSafeCharImage } = await import(
            "../../../ImportHandlers/SillyTavern/main.mjs"
          );
          try {
            await assertSafeCharImage(avatarFile.data);
          } catch (imgErr) {
            return res.status(400).json({ message: imgErr.message });
          }
          const dataReader = await import(
            "../../../ImportHandlers/SillyTavern/data_reader.mjs"
          );
          const publicDir = path.join(personaDir, "public");
          fs.mkdirSync(publicDir, { recursive: true });
          avatarFileName = "image.png";
          fs.writeFileSync(
            path.join(publicDir, avatarFileName),
            dataReader.remove(avatarFile.data),
          );
        }

        // 写入 info.json
        const infoData = {
          "zh-CN": {
            name: personaName,
            avatar: avatarFileName,
            description: description || "",
            version: "0.1.0",
            author: username,
          },
          "en-UK": {
            name: personaName,
            avatar: avatarFileName,
            description: description || "",
            version: "0.1.0",
            author: username,
          },
        };
        nicerWriteFileSync(
          path.join(personaDir, "info.json"),
          JSON.stringify(infoData, null, "\t"),
          "utf-8",
        );

        // 通知 beilu 刷新
        try {
          notifyPartInstall(username, `personas/${personaName}`);
        } catch (e) {
          console.warn(
            "[beilu-chat] notifyPartInstall(persona) 失败:",
            e.message,
          );
        }

        // 写入 parts_details_cache，确保前端 getAllCachedPartDetails 能立即获取头像等信息
        try {
          const cache = loadData(username, "parts_details_cache");
          cache[`personas/${personaName}`] = {
            info: infoData,
            supportedInterfaces: [],
          };
          saveData(username, "parts_details_cache");
        } catch (_) {
          /* 静默 */
        }

        console.log(
          `[beilu-chat] 人设已创建: "${personaName}" (user: ${username})`,
        );
        res.status(201).json({ success: true, name: personaName });
      } catch (error) {
        console.error("[beilu-chat] Error creating persona:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // DELETE /api/parts/shells:chat/persona/:name — 删除用户人设
  router.delete(
    "/api/parts/shells\\:chat/persona/:name",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const personaName = confineSegment(decodeURIComponent(req.params.name).trim());
        if (!personaName) return res.status(400).json({ message: "人设名称不能为空" });

        const userDir = getUserDictionary(username);
        const personaDir = path.join(userDir, "personas", personaName);

        if (!fs.existsSync(personaDir)) {
          return res.status(404).json({ message: `人设 "${personaName}" 不存在` });
        }

        await safeTrash(personaDir, "删除人设");

        try {
          const cache = loadData(username, "parts_details_cache");
          delete cache[`personas/${personaName}`];
          saveData(username, "parts_details_cache");
        } catch (_) {}

        console.log(`[beilu-chat] 人设已删除: "${personaName}" (user: ${username})`);
        res.status(200).json({ success: true });
      } catch (error) {
        console.error("[beilu-chat] Error deleting persona:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // PUT /api/parts/shells:chat/persona/:name/update — 更新用户人设（描述 + 可选头像上传）
  router.put(
    "/api/parts/shells\\:chat/persona/:name/update",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const personaName = confineSegment(req.params.name);
        const { description } = req.body || {};

        if (!personaName) {
          return res.status(400).json({ message: "缺少人设名称" });
        }

        const userDir = getUserDictionary(username);
        const personaDir = path.join(userDir, "personas", personaName);

        if (!fs.existsSync(personaDir)) {
          return res
            .status(404)
            .json({ message: `人设 "${personaName}" 不存在` });
        }

        // 处理头像上传（统一文件名 image.png）
        const avatarFile = req.files?.avatar;
        let avatarFileName = undefined; // undefined = 不更新 avatar 字段
        if (avatarFile) {
          // ★ F-D5 XSS：人设头像同为 public/image.png，同型上传 XSS 面（同 import-char/角色卡头像）。
          //   magic bytes 断言拒 SVG/polyglot；data_reader.remove 重序列化剥 IEND 后尾随 HTML。
          const { assertSafeCharImage } = await import(
            "../../../ImportHandlers/SillyTavern/main.mjs"
          );
          try {
            await assertSafeCharImage(avatarFile.data);
          } catch (imgErr) {
            return res.status(400).json({ message: imgErr.message });
          }
          const dataReader = await import(
            "../../../ImportHandlers/SillyTavern/data_reader.mjs"
          );
          const publicDir = path.join(personaDir, "public");
          fs.mkdirSync(publicDir, { recursive: true });
          avatarFileName = "image.png";
          fs.writeFileSync(
            path.join(publicDir, avatarFileName),
            dataReader.remove(avatarFile.data),
          );
        }

        // 读取并更新 info.json
        const infoPath = path.join(personaDir, "info.json");
        let infoData = {};
        if (fs.existsSync(infoPath)) {
          infoData = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        }

        // 更新所有语言的 description 和 avatar
        for (const lang of Object.keys(infoData)) {
          if (typeof infoData[lang] === "object") {
            if (description !== undefined)
              infoData[lang].description = description;
            if (avatarFileName !== undefined)
              infoData[lang].avatar = avatarFileName;
          }
        }
        // 如果 info.json 为空或没有语言键，创建默认结构
        if (Object.keys(infoData).length === 0) {
          infoData = {
            "zh-CN": {
              name: personaName,
              description: description || "",
              avatar: avatarFileName || "",
            },
            "en-UK": {
              name: personaName,
              description: description || "",
              avatar: avatarFileName || "",
            },
          };
        }

        nicerWriteFileSync(
          infoPath,
          JSON.stringify(infoData, null, "\t"),
          "utf-8",
        );

        // 更新 parts_details_cache（写入最新的 info，而非仅删除缓存）
        try {
          const cache = loadData(username, "parts_details_cache");
          cache[`personas/${personaName}`] = {
            info: infoData,
            supportedInterfaces: [],
          };
          saveData(username, "parts_details_cache");
        } catch (_) {
          /* 静默 */
        }

        console.log(
          `[beilu-chat] 人设已更新: "${personaName}" (user: ${username})`,
        );
        res.status(200).json({ success: true, name: personaName });
      } catch (error) {
        console.error("[beilu-chat] Error updating persona:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // ============================================================
  // GET /api/parts/shells:chat/char-data/:charName
  // 获取角色卡完整数据（从 beilu-home 迁移）
  // ============================================================
  router.get(
    "/api/parts/shells\\:chat/char-data/:charName",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const charName = confineSegment(req.params.charName);
        const userDir = getUserDictionary(username);
        const chardataPath = path.join(
          userDir,
          "chars",
          charName,
          "chardata.json",
        );

        if (!fs.existsSync(chardataPath)) {
          return res
            .status(404)
            .json({ message: `角色 "${charName}" 数据不存在` });
        }

        const chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
        res.status(200).json(chardata);
      } catch (error) {
        console.error("[beilu-chat] Error reading char data:", error);
        res.status(500).json({ message: error.message });
      }
    },
  );

  // ============================================================
  // GET /api/parts/shells:chat/char-aisource/:charName
  // 获取角色卡当前绑定的 AI 源 + 可用源列表（从 beilu-home 迁移）
  // ============================================================
  router.get(
    "/api/parts/shells\\:chat/char-aisource/:charName",
    authenticate,
    async (req, res) => {
      try {
        const { username } = await getUserByReq(req);
        const charName = confineSegment(req.params.charName);
        const parts_config = loadData(username, "parts_config");

        // 当前角色绑定的 AIsource
        const charConfig = parts_config[`chars/${charName}`];
        const currentSource = charConfig?.AIsource || "";

        // 可用的 AI 源列表
        const available = [];
        for (const key of Object.keys(parts_config)) {
          if (key.startsWith("serviceSources/AI/")) {
            available.push(key.replace("serviceSources/AI/", ""));
          }
        }

        res.json({ AIsource: currentSource, available });
      } catch (error) {
        console.error("[beilu-chat] char-aisource GET error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // 教程系统CRUD已迁移到 plugins/beilu-tutorial(凛倾 2026-07-14)

  // STT 插件已迁移到 plugins/beilu-stt (独立 part 注册)

  // ■ Browser 插件代理（浏览器自动化 CDP 连接管理）

  router.get("/api/parts/shells\\:chat/plugins/beilu-browser/status", authenticate, async (_req, res) => {
    const port = _req.query?.port || 9222;
    try {
      const http = await import("http");
      const data = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, (r) => {
          let body = "";
          r.on("data", (c) => { body += c; });
          r.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { reject(new Error("parse error")); }
          });
        }).on("error", reject);
      });
      res.json({ connected: true, browser: data.Browser || "Chrome", userAgent: data["User-Agent"] || "" });
    } catch {
      res.json({ connected: false });
    }
  });

  router.post("/api/parts/shells\\:chat/plugins/beilu-browser/launch", authenticate, async (req, res) => {
    try {
      const { exec } = await import("child_process");
      const fs = await import("fs");
      const path = await import("path");
      const body = req.body || {};
      const port = body.port || 9222;
      // 默认 CWD 锚相对路径（禁机器盘符硬编码），resolve 绝对化避免 Chrome 按自身 CWD 解析歧义
      const userDataDir = path.resolve(body.userDataDir || "data/browser-profile");
      let chromePath = body.chromePath || "";

      if (!chromePath) {
        const candidates = process.platform === "win32" ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
        ] : process.platform === "darwin" ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          `${process.env.HOME || ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        ] : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/snap/bin/chromium",
        ];
        chromePath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "";
      }

      if (!chromePath) {
        return res.json({ ok: false, error: "未找到 Chrome，请在设置中指定路径或安装 Chrome: https://www.google.com/chrome/" });
      }

      const child = exec(`"${chromePath}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}"`);
      child.unref?.();
      res.json({ ok: true, pid: child.pid });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });
}
