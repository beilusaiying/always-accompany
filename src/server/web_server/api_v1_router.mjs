import express from "npm:express";
import { authenticate, getUserByReq, requireApiKeyScope, apiKeyHasScope } from "../../yonban/core/functions/security/auth.mjs";
import { asyncHandler } from "../monitor.mjs";
import { safeFetch } from "../../yonban/core/functions/security/safe_fetch.mjs";
import { wbTrace, wbDetect } from "../whitebox.mjs";
import { confineSegment } from "../../yonban/core/functions/security/path_confine.mjs";
import { stripInvisibleUnicode } from "../../yonban/core/functions/security/untrusted_content.mjs"; // SEC-PI 单源：Unicode 剥除与 10 bot 平台共用同一份
import { isActiveEntry } from "../../yonban/core/functions/hide/chatEntryUtils.mjs"; // T8·回切：改指 yonban 新位实现体
import { config, save_config } from "../server.mjs";
import { is_local_ip } from "../../scripts/ratelimit.mjs";
import { readJsonSafe } from "../../scripts/safeJsonIO.mjs"; // T019：变量文件损坏→备份.corrupt.bak抛错，不再body直接覆盖清空
import { nicerWriteFileSync } from "../../scripts/nicerWriteFile.mjs"; // [0716 断电安全] 原子写单源
import {
  prepareEditMessageRequest,
  prepareEditOperationIdentity,
} from "../../public/parts/shells/beilu-chat/src/lib/editMessageRequest.mjs";
import * as v1 from "./v1_adapter.mjs";

const router = express.Router();

// chatId / 变量文件名 sanitize:E-7 收口到 path_confine.confineSegment 单一权威(本函数即该权威的抽取来源,见 path_confine.mjs:6)。
//   confineSegment = 原口径(删 / \ .)+ NFKC 归一 + 控制字符删除——更严,对有效 chatid 输出不变,只多挡控制字符/同形注入。半收口补齐(权威早建仅原始点未迁)。

// SEC-IDOR: v1 是独立 express Router，不经 beilu-chat 壳 endpoints.mjs 的中央 router.param 属主闸
//   (endpoints.mjs:97-102 `meta.username !== username` → 403)。此处镜像同一属主校验：
//   chatMetadatas[chatid].username 是权威属主(与 getChatList/deleteChat 同源)；loadChat 内部扫盘自愈，
//   覆盖磁盘有但本 isolate 内存未加载的 chat。无此闸则任意有效 key 可按 chatId 读/操作他人会话。
async function _isChatOwner(chatModule, chatId, username) {
  if (!username) return false;
  const metas = chatModule.getChatMetadatas();
  let meta = metas.get(chatId);
  if (!meta) { try { await chatModule.loadChat(chatId); } catch { /* ignore */ } meta = metas.get(chatId); }
  return !!meta && meta.username === username;
}

function _parseNonNegativeInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// 认证中间件:支持 Header `Authorization: Bearer xxx` 和 URL `?token=xxx`(WS 场景)
// 把 token 同时塞进 3 条 auth 路径,让 try_auth_request (auth.mjs 中 grep `export async function try_auth_request`) 自选命中
//   1. x-api-key header    → verifyApiKey (API Key 表查询)
//   2. cookies.apiAccessToken → JWT api 类型验证
//   3. cookies.accessToken → JWT 标准验证(内部登录共用)
function apiKeyAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  const queryToken = req.query?.token;
  let token = null;
  if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
  else if (queryToken) token = queryToken;
  if (token) {
    if (!req.headers["x-api-key"]) req.headers["x-api-key"] = token;
    req.cookies = req.cookies || {};
    if (!req.cookies.apiAccessToken) req.cookies.apiAccessToken = token;
    if (!req.cookies.accessToken) req.cookies.accessToken = token;
  }
  return authenticate(req, res, next);
}

router.use(apiKeyAuth);

// SEC-RL: v1 API 可配速率限制（默认关闭——个人大型调查可能 40 并发，零摩擦）。
//   开启后按 API Key JTI（per-key）或 IP（无 key 兜底）限流。
//   config.v1RateLimit = { enabled, perKeyPerMin, genPerKeyPerMin }
//   env BEILU_V1_RATE_LIMIT=on 强制开启。
const _rlCounts = new Map();
function _v1RateLimiter(req, res, next) {
  const envForce = String(globalThis.Deno?.env?.get?.("BEILU_V1_RATE_LIMIT") || process.env.BEILU_V1_RATE_LIMIT || "").toLowerCase() === "on";
  const cfg = config.v1RateLimit || {};
  if (!cfg.enabled && !envForce) return next();
  if (is_local_ip(req.ip)) return next();
  const key = req.user?._apiKeyJti || req.ip || "anon";
  const now = Date.now();
  for (const [k, e] of _rlCounts) if (e.expiry < now) _rlCounts.delete(k);
  const limit = cfg.perKeyPerMin || v1.V1_CONST.RATE_LIMIT_DEFAULT_PER_MIN;
  if (!_rlCounts.has(key)) _rlCounts.set(key, { count: 0, expiry: now + v1.V1_CONST.RATE_LIMIT_WINDOW_MS });
  const entry = _rlCounts.get(key);
  entry.count++;
  if (entry.count > limit) {
    wbDetect(null, "api", "v1_rate_limit:exceeded", false, "v1 速率限制触发", { key, count: entry.count, limit });
    return res.status(429).json({ error: "rate limit exceeded" });
  }
  return next();
}
router.use(_v1RateLimiter);

function requireConfirm(description) {
  return (req, res, next) => {
    if (req.headers["x-beilu-confirm"] === "true") return next();
    return res.status(428).json({
      error: "dangerous operation requires confirmation",
      description,
      hint: "Add header 'X-Beilu-Confirm: true' to confirm this operation",
    });
  };
}

router.get("/status", asyncHandler((_req, res) => {
  res.json({ status: "ok", version: "1.0.0", agent: "beilu-always-accompany" });
}, "GET /v1/status"));

router.get("/chat/list", requireApiKeyScope("chat:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chatModule = await _getBeiluChat();
  const list = await chatModule.getChatList(username);
  // 保持原响应契约 { chats: [id字符串数组] }
  res.json({ chats: list.map((c) => c.chatid) });
}, "GET /v1/chat/list"));

router.get("/chat/history/:chatId", requireApiKeyScope("chat:read"), asyncHandler(async (req, res) => {
  const chatId = confineSegment(req.params.chatId);
  const { username } = await getUserByReq(req).catch(() => ({ username: null }));
  const chatModule = await _getBeiluChat();
  // SEC-IDOR: 404 不向越权方确认 chat 存在性
  if (!await _isChatOwner(chatModule, chatId, username)) return res.status(404).json({ error: "chat not found" });
  let chatMeta;
  try {
    chatMeta = await chatModule.loadChat(chatId);
  } catch (e) {
    return res.status(500).json({ error: "load chat failed: " + e.message });
  }
  if (!chatMeta) return res.status(404).json({ error: "chat not found" });
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  // chatLogEntry_t[]：role / content / content_for_show / name / time_stamp / id
  // 用权威谓词 isActiveEntry（chatEntryUtils 单源）过滤已删+已隐藏消息
  const fullLog = (chatMeta.chatLog || [])
    .map((entry, indexHint) => ({ entry, indexHint }))
    .filter(({ entry }) => isActiveEntry(entry));
  const messages = fullLog.slice(offset, offset + limit).map(({ entry, indexHint }) => ({
    id: entry.id,
    // 可见数组经删除/隐藏过滤后会重排；只返回对应权威 chatLog 的原始 index hint，
    // 任何写操作仍必须同时携带 id，不能把分页/可见序号当作消息身份。
    indexHint,
    role: entry.role,
    content: entry.content_for_show || entry.content || "",
    name: entry.name || null,
    timestamp: entry.time_stamp || null,
  }));
  res.json({ chatId, total: fullLog.length, offset, limit, messages });
}, "GET /v1/chat/history/:chatId"));

router.get("/characters", requireApiKeyScope("characters:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  res.json({ characters: await v1.getCharacterList(username) });
}, "GET /v1/characters"));

// EXT-D: chat/send 同步 + 流式 SSE
//   同步模式(默认): 等 generation_ended 事件,返回最终 AI 回复
//   流式模式 (?stream=true): 以 SSE (text/event-stream) 转发 stream_update / generation_ended
//   注:不返回 emotion 字段 — API 层是纯框架,不做内容识别(若要情感,用户自己在 content 正则提取)
router.post("/chat/send", requireApiKeyScope("chat:send"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req).catch(() => ({ username: null }));
  if (!username) return res.status(401).json({ error: "unauthenticated" });

  let { chatId, message, charName } = req.body || {};
  if (!chatId || !message) return res.status(400).json({ error: "missing chatId or message" });
  chatId = confineSegment(chatId);

  const stream = req.query?.stream === "true" || req.body?.stream === true;
  const timeout = Math.min(parseInt(req.query.timeout) || v1.V1_CONST.CHAT_SEND_DEFAULT_TIMEOUT, v1.V1_CONST.CHAT_SEND_MAX_TIMEOUT);
  wbTrace(chatId, "api", "chat/send:enter", { stream, charName: charName || null, msgLen: String(message).length });

  let chatModule;
  try { chatModule = await _getBeiluChat(); }
  catch (e) { return res.status(500).json({ error: "chat module load failed: " + e.message }); }

  // SEC-IDOR: 校验 chatId 归属当前认证用户，防向他人会话注入消息/盗用其 AI 源
  if (!await _isChatOwner(chatModule, chatId, username)) return res.status(404).json({ error: "chat not found" });

  // 构造 mock WS: ws 接口契约 { readyState, OPEN, send, on('message'), on('close') }
  const handlers = { message: [], close: [] };
  const mockWs = {
    readyState: 1, OPEN: 1,
    send: (raw) => {
      let msg; try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
      if (stream) {
        if (!res.writableEnded) {
          try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {}
        }
      }
      if (msg.type === "generation_ended" || msg.type === "generation_end" || msg.type === "generation_complete") {
        _finish(msg);
      }
      // RT-3: 后端生成管线从不广播 generation_*；主回复路径终态 = finalizeEntry 的
      // message_replaced(is_generating=false)（见 generation.mjs finalizeEntry）。
      // 不识别这条则非流式 /v1/chat/send 永远命中超时返 504（回复其实已生成保存）。
      if (msg.type === "message_replaced" && msg.payload?.entry && msg.payload.entry.is_generating === false) {
        _finish(msg);
      }
    },
    on: (evt, cb) => { (handlers[evt] ||= []).push(cb); },
    close: () => { (handlers.close || []).forEach((cb) => { try { cb(); } catch {} }); },
  };

  let finished = false;
  let finishResolve;
  const finishPromise = new Promise((r) => { finishResolve = r; });
  function _finish(msg) {
    if (finished) return;
    finished = true;
    try { mockWs.readyState = 3; } catch {}
    finishResolve(msg);
  }

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    req.on("close", () => _finish({ type: "client_closed" }));
  }

  try {
    chatModule.registerChatUiSocket(chatId, mockWs, username);
    await chatModule.addUserReply(chatId, { content: String(message), files: [] }, { expectedUsername: username });
    chatModule.triggerCharReply(chatId, charName, { sourceChannel: "api" }).catch((err) => {
      wbDetect(chatId, "api", "chat/send:trigger", false, err.message);
      if (stream) {
        try { res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`); } catch {}
      }
      _finish({ type: "error", message: err.message });
    });
  } catch (e) {
    _finish({ type: "error", message: e.message });
    try { mockWs.close(); } catch {}
    if (!stream) return res.status(500).json({ error: e.message });
  }

  const timer = setTimeout(() => _finish({ type: "timeout" }), timeout);
  const result = await finishPromise;
  clearTimeout(timer);
  wbTrace(chatId, "api", "chat/send:finish", { type: result?.type || "ok", stream });
  try { mockWs.close(); } catch {}

  if (stream) {
    if (!res.writableEnded) {
      try { res.write(`data: ${JSON.stringify({ type: "done", ...result })}\n\n`); } catch {}
      res.end();
    }
    return;
  }

  if (result?.type === "timeout") return res.status(504).json({ error: "timeout" });
  if (result?.type === "error") return res.status(500).json({ error: result.message });
  // 从 chat 读最后一条 AI 消息返回(纯 content/role/timestamp,不识别 emotion)
  try {
    const chatMeta = await chatModule.loadChat(chatId);
    const arr = chatMeta?.chatLog || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role !== "user") {
        return res.json({
          success: true,
          reply: {
            content: arr[i].content_for_show || arr[i].content || "",
            role: arr[i].role,
            charName: arr[i].name || null,
            timestamp: arr[i].time_stamp || null,
          },
        });
      }
    }
  } catch (e) { return res.status(500).json({ error: "read reply failed: " + e.message }); }
  return res.json({ success: true, reply: null });
}, "POST /v1/chat/send"));

router.get("/variables/:chatId", requireApiKeyScope("variables:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { __projectRoot } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const _varChatId = confineSegment(req.params.chatId);
  const varFile = path.join(__projectRoot, "data", "users", username, "vars", _varChatId + "_variables.json");
  if (!fs.existsSync(varFile)) return res.json({ variables: {} });
  res.json({ variables: JSON.parse(await fs.promises.readFile(varFile, "utf-8")) });
}, "GET /v1/variables/:chatId"));

// EXT-E: 写变量(纯透传,不做内容判断)
router.post("/variables/:chatId", requireApiKeyScope("variables:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { __projectRoot } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const _safeChatId = confineSegment(req.params.chatId);
  const varDir = path.join(__projectRoot, "data", "users", username, "vars");
  if (!fs.existsSync(varDir)) await fs.promises.mkdir(varDir, { recursive: true });
  const varFile = path.join(varDir, _safeChatId + "_variables.json");
  const body = req.body || {};
  const merge = req.query?.merge !== "false";
  let next = body;
  // T019：损坏时旧行为=catch吞→body直接整文件覆盖（用户变量清空）。现损坏→readJsonSafe
  // 备份.corrupt.bak后抛错→asyncHandler返回错误响应，原文件不动；不存在→{}与body合并（首装路径）。
  if (merge) next = { ...(await readJsonSafe(varFile, {})), ...body };
  // [0716 断电安全] 原子写收口：原直写断电=变量文件半写损坏
  nicerWriteFileSync(varFile, JSON.stringify(next, null, 2), "utf-8");
  res.json({ success: true, variables: next });
}, "POST /v1/variables/:chatId"));

// EXT-E: 新建聊天
router.post("/chat/new", requireApiKeyScope("chat:send"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chatModule = await _getBeiluChat();
  const chatId = await chatModule.newChat(username);
  res.status(201).json({ success: true, chatId });
}, "POST /v1/chat/new"));

// EXT-E: 角色详情(读角色目录下标准元信息文件,不解释内容)
router.get("/characters/:name", requireApiKeyScope("characters:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const detail = await v1.getCharacterDetail(username, req.params.name);
  if (!detail) return res.status(404).json({ error: "character not found" });
  res.json(detail);
}, "GET /v1/characters/:name"));

// ============================================================
// EXT-I: 记忆 API — 纯透传 beilu-memory setDataActions
//   框架只做管道,具体 action 语义由 beilu-memory 决定
//   用户发 {_action:"xxx", ...} 透传到插件
// ============================================================
async function _loadSetDataActions() {
  // [P0-C 2026-08-03] 悬空路径修复：plugins/beilu-memory/lib/setDataActions.mjs 在 T3e 迁移后
  //   已不存在（实体在 yonban），原动态 import 必抛=全部 /v1/memory/* 端点 500 死链。
  //   改直指 yonban 实现体（与 memory/index.mjs facade 同一 handleSetData，单源）。
  return await import("../../yonban/core/functions/memory/handler/setDataActions.mjs");
}

router.post("/memory/action", requireApiKeyScope("memory:write"), asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body._action) return res.status(400).json({ error: "missing _action" });
  const mod = await _loadSetDataActions();
  if (typeof mod.handleSetData !== "function") return res.status(501).json({ error: "handleSetData not exported" });
  const { username } = await getUserByReq(req);
  const charId = body.char_id || body.charId || req.query?.char_id || "_global";
  const result = await mod.handleSetData(body, { username, char_id: charId });
  res.json({ success: true, result });
}, "POST /v1/memory/action"));

router.get("/memory/action", requireApiKeyScope("memory:read"), asyncHandler(async (req, res) => {
  const { _action, ...rest } = req.query || {};
  if (!_action) return res.status(400).json({ error: "missing _action query" });
  const mod = await _loadSetDataActions();
  if (typeof mod.handleSetData !== "function") return res.status(501).json({ error: "handleSetData not exported" });
  const { username } = await getUserByReq(req);
  const charId = rest.char_id || rest.charId || "_global";
  const result = await mod.handleSetData({ _action, ...rest }, { username, char_id: charId });
  res.json({ success: true, result });
}, "GET /v1/memory/action"));

// ============================================================
// EXT-M: 记忆结构化端点 — 对 memory/action 透传的上层封装
//   每个端点 = 固定的 _action + 明确的入参/出参契约
// ============================================================

router.get("/memory/tables/:charId", requireApiKeyScope("memory:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = confineSegment(req.params.charId) || "_global";
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "getTables" }, { username, char_id: charId });
  res.json({ success: true, charId, tables: result });
}, "GET /v1/memory/tables/:charId"));

router.post("/memory/tables/:charId", requireApiKeyScope("memory:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = confineSegment(req.params.charId) || "_global";
  const { action, ...tableData } = req.body || {};
  if (!action || !["addTable", "updateTable", "removeTable"].includes(action))
    return res.status(400).json({ error: "action must be addTable/updateTable/removeTable" });
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: action, ...tableData }, { username, char_id: charId });
  res.json({ success: true, result });
}, "POST /v1/memory/tables/:charId"));

router.get("/memory/snapshots", requireApiKeyScope("memory:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "listSnapshots" }, { username, char_id: charId });
  res.json({ success: true, snapshots: result });
}, "GET /v1/memory/snapshots"));

router.post("/memory/snapshot", requireApiKeyScope("memory:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const { action, char_id, snapshotId } = req.body || {};
  const charId = char_id || "_global";
  if (!action || !["createSnapshot", "restoreSnapshot"].includes(action))
    return res.status(400).json({ error: "action must be createSnapshot/restoreSnapshot" });
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: action, snapshotId }, { username, char_id: charId });
  res.json({ success: true, result });
}, "POST /v1/memory/snapshot"));

router.post("/memory/archive", requireApiKeyScope("memory:write"), requireConfirm(v1.DANGEROUS_OPS["memory/archive"]), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const { action, char_id } = req.body || {};
  const charId = char_id || "_global";
  if (!action || !["archiveHotToWarm", "archiveWarmToCold", "endDay", "archiveCompletedTasks"].includes(action))
    return res.status(400).json({ error: "action must be archiveHotToWarm/archiveWarmToCold/endDay/archiveCompletedTasks" });
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: action }, { username, char_id: charId });
  res.json({ success: true, result });
}, "POST /v1/memory/archive"));

router.get("/memory/files", requireApiKeyScope("memory:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const subPath = req.query?.path || "";
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "listMemoryFiles", subPath }, { username, char_id: charId });
  res.json({ success: true, files: result });
}, "GET /v1/memory/files"));

router.get("/memory/file", requireApiKeyScope("memory:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const filePath = req.query?.path;
  if (!filePath) return res.status(400).json({ error: "missing path query" });
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "readMemoryFile", filePath }, { username, char_id: charId });
  res.json({ success: true, content: result });
}, "GET /v1/memory/file"));

// ============================================================
// EXT-CH: 对话高级操作端点（委托 beilu-chat 模块）
// ============================================================

router.post("/chat/branch", requireApiKeyScope("chat:send"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const { chatId, messageId, messageIndex, wholeChat } = req.body || {};
  const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
  const wantsWholeChat = wholeChat === true;
  if (!chatId) return res.status(400).json({ success: false, code: "E_BRANCH_CHAT_REQUIRED", error: "missing chatId" });
  if ((normalizedMessageId && wantsWholeChat) || (!normalizedMessageId && !wantsWholeChat)) {
    return res.status(400).json({
      success: false,
      code: normalizedMessageId ? "E_BRANCH_SELECTOR_AMBIGUOUS" : "E_BRANCH_SELECTOR_REQUIRED",
      error: normalizedMessageId
        ? "messageId and wholeChat=true are mutually exclusive"
        : "a non-empty messageId or explicit wholeChat=true is required",
    });
  }
  if (messageIndex != null && _parseNonNegativeInteger(messageIndex) == null) {
    return res.status(400).json({ success: false, code: "E_BRANCH_INDEX_HINT_INVALID", error: "messageIndex must be a non-negative safe integer" });
  }
  const safeChatId = confineSegment(chatId);
  const chatModule = await _getBeiluChat();
  if (!await _isChatOwner(chatModule, safeChatId, username)) return res.status(404).json({ error: "chat not found" });
  try {
    const newChatId = await chatModule.branchChat(safeChatId, {
      ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
      ...(messageIndex != null ? { indexHint: _parseNonNegativeInteger(messageIndex) } : {}),
      wholeChat: wantsWholeChat,
    }, username);
    res.status(201).json({ success: true, newChatId });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (status >= 500) throw error;
    return res.status(status).json({ success: false, code: error.code, error: error.message });
  }
}, "POST /v1/chat/branch"));

router.put("/chat/message/:chatId/:index", requireApiKeyScope("chat:send"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chatId = confineSegment(req.params.chatId);
  const index = _parseNonNegativeInteger(req.params.index);
  if (index == null) {
    return res.status(400).json({
      success: false,
      applied: false,
      chatCommitted: false,
      status: "invalid_request",
      revision: null,
      derived: null,
      code: "E_EDIT_INDEX_HINT_INVALID",
      error: "invalid index hint",
    });
  }
  const { content, messageId: rawMessageId, editOperationId } = req.body || {};
  const messageId = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
  if (!messageId) {
    return res.status(400).json({
      success: false,
      applied: false,
      chatCommitted: false,
      status: "invalid_request",
      revision: null,
      derived: null,
      code: "E_EDIT_MESSAGE_ID_REQUIRED",
      error: "missing messageId",
    });
  }
  if (content === undefined) {
    return res.status(400).json({
      success: false,
      applied: false,
      chatCommitted: false,
      status: "invalid_request",
      revision: null,
      derived: null,
      messageId,
      indexHint: index,
      code: "E_EDIT_CONTENT_REQUIRED",
      error: "missing content",
    });
  }
  const chatModule = await _getBeiluChat();
  if (!await _isChatOwner(chatModule, chatId, username)) {
    return res.status(404).json({
      success: false,
      applied: false,
      chatCommitted: false,
      status: "not_found",
      revision: null,
      derived: null,
      messageId,
      indexHint: index,
      error: "chat not found",
    });
  }
  // [2026-08-01 批⑦疑#1] editMessage 第三参被 messageBuilder 按对象消费（result.content）。
  //   v1 API 层 content 可能是纯字符串——包装成 {content} 对象，对齐内部 endpoints.mjs:203
  //   addUserReply 的 {content} 包装范式。
  const _editPayload = typeof content === 'string' ? { content } : content;
  try {
    const preparedEdit = await prepareEditMessageRequest(username, _editPayload, editOperationId);
    const result = await chatModule.editMessage(
      chatId,
      messageId,
      index,
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
    return res.status(responseStatus).json({
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
  } catch (error) {
    const status = Number.isInteger(error?.statusCode)
      ? error.statusCode
      : /not found/i.test(error?.message || "") ? 404 : 500;
    if (status >= 500) throw error;
    return res.status(status).json({
      success: false,
      applied: false,
      chatCommitted: error?.chatCommitted === true,
      status: error?.status || "precommit_failed",
      revision: null,
      derived: null,
      messageId,
      indexHint: index,
      code: error?.code,
      error: error?.message || String(error),
    });
  }
}, "PUT /v1/chat/message/:chatId/:index"));

router.post("/chat/message/:chatId/:index/edit-operation/:operationId/reconcile", requireApiKeyScope("chat:send"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chatId = confineSegment(req.params.chatId);
  const index = _parseNonNegativeInteger(req.params.index);
  const reconcileBody = req.body && typeof req.body === "object" ? req.body : {};
  const messageId = typeof reconcileBody.messageId === "string" ? reconcileBody.messageId.trim() : "";
  if (index == null || !messageId) {
    return res.status(400).json({
      success: false,
      code: index == null ? "E_EDIT_INDEX_HINT_INVALID" : "E_EDIT_MESSAGE_ID_REQUIRED",
      error: index == null ? "invalid index hint" : "missing messageId",
    });
  }
  const chatModule = await _getBeiluChat();
  if (!await _isChatOwner(chatModule, chatId, username)) {
    return res.status(404).json({ error: "chat not found" });
  }
  try {
    const identity = prepareEditOperationIdentity(reconcileBody.content, req.params.operationId);
    const receipt = await chatModule.getEditOperationReceipt(
      chatId,
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
        indexHint: index,
        editOperationId: req.params.operationId,
        error: "edit operation not found",
      });
    }
    return res.status(200).json({ success: true, ...receipt });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (status >= 500) throw error;
    return res.status(status).json({
      success: false,
      applied: false,
      chatCommitted: false,
      status: "reconciliation_failed",
      code: error?.code,
      error: error?.message || String(error),
    });
  }
}, "POST /v1/chat/message/:chatId/:index/edit-operation/:operationId/reconcile"));

router.delete("/chat/message/:chatId/:index", requireApiKeyScope("chat:send"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chatId = confineSegment(req.params.chatId);
  const index = _parseNonNegativeInteger(req.params.index);
  if (index == null) return res.status(400).json({ success: false, error: "invalid index" });
  const rawMessageId = req.query?.messageId ?? req.body?.messageId;
  if (typeof rawMessageId !== "string" || !rawMessageId.trim()) {
    return res.status(400).json({ success: false, error: "messageId is required" });
  }
  const messageId = rawMessageId.trim();
  const chatModule = await _getBeiluChat();
  if (!await _isChatOwner(chatModule, chatId, username)) return res.status(404).json({ error: "chat not found" });
  const result = await chatModule.deleteMessage(chatId, index, { messageId, expectedUsername: username });
  res.json({ success: result.applied, ...result });
}, "DELETE /v1/chat/message/:chatId/:index"));

router.delete("/chat/:chatId", requireApiKeyScope("chat:send"), requireConfirm(v1.DANGEROUS_OPS["chat/delete"]), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chatId = confineSegment(req.params.chatId);
  const chatModule = await _getBeiluChat();
  if (!await _isChatOwner(chatModule, chatId, username)) return res.status(404).json({ error: "chat not found" });
  const [result] = await chatModule.deleteChat([chatId], username);
  if (result?.success !== true) {
    const status = Number.isInteger(result?.statusCode) ? result.statusCode : 409;
    return res.status(status).json({ success: false, ...result });
  }
  res.json({ success: true, ...result });
}, "DELETE /v1/chat/:chatId"));

// ============================================================
// EXT-W: 世界书结构化端点（委托 beilu-worldbook 插件）
// ============================================================

router.get("/worldbooks", requireApiKeyScope("worldbook:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  res.json({ success: true, worldbooks: await v1.getWorldbooks(username) });
}, "GET /v1/worldbooks"));

router.get("/worldbooks/:name/entries", requireApiKeyScope("worldbook:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const entries = await v1.getWorldbookEntries(username, req.params.name);
  if (entries === null) return res.status(404).json({ error: "worldbook not found" });
  res.json({ success: true, name: req.params.name, entries });
}, "GET /v1/worldbooks/:name/entries"));

router.post("/worldbooks/:name/entries", requireApiKeyScope("worldbook:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const { action, ...entryData } = req.body || {};
  if (!action) return res.status(400).json({ error: "missing action" });
  const result = await v1.worldbookAction(username, req.params.name, action, entryData);
  res.json({ success: true, result });
}, "POST /v1/worldbooks/:name/entries"));

// ============================================================
// EXT-C: 角色卡 CRUD 结构化端点
// ============================================================

router.post("/characters", requireApiKeyScope("characters:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  try {
    const name = await v1.createCharacter(username, req.body || {});
    res.status(201).json({ success: true, name });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
}, "POST /v1/characters"));

router.put("/characters/:name", requireApiKeyScope("characters:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const result = await v1.updateCharacter(username, req.params.name, req.body || {});
  if (!result) return res.status(404).json({ error: "character not found" });
  res.json({ success: true, chardata: result });
}, "PUT /v1/characters/:name"));

router.delete("/characters/:name", requireApiKeyScope("characters:write"), asyncHandler(async (_req, res) => {
  res.status(501).json({ error: "DELETE characters via v1 API is not yet available. Use the web UI (requires 8-step cleanup)." });
}, "DELETE /v1/characters/:name"));

router.get("/characters/:name/export", requireApiKeyScope("characters:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const chardata = await v1.exportCharacter(username, req.params.name);
  if (!chardata) return res.status(404).json({ error: "character not found" });
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(confineSegment(req.params.name))}.json"`);
  res.json(chardata);
}, "GET /v1/characters/:name/export"));

// ============================================================
// EXT-P: 预设 + 注入提示词结构化端点
// ============================================================

router.get("/presets", requireApiKeyScope("presets:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "getMemoryPresets" }, { username, char_id: charId });
  res.json({ success: true, presets: result });
}, "GET /v1/presets"));

router.get("/presets/:id", requireApiKeyScope("presets:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const presetId = req.params.id;
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "getMemoryPresetDetail", presetId }, { username, char_id: charId });
  res.json({ success: true, preset: result });
}, "GET /v1/presets/:id"));

router.put("/presets/:id", requireApiKeyScope("presets:write"), requireConfirm(v1.DANGEROUS_OPS["presets/write"]), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const presetId = req.params.id;
  const body = req.body || {};
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: "updateMemoryPreset", presetId, ...body }, { username, char_id: charId });
  res.json({ success: true, result });
}, "PUT /v1/presets/:id"));

router.get("/injections", requireApiKeyScope("presets:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const mod = await _loadSetDataActions();
  const presets = await mod.handleSetData({ _action: "getMemoryPresets" }, { username, char_id: charId });
  const injections = [];
  if (Array.isArray(presets)) {
    for (const p of presets) {
      try {
        const detail = await mod.handleSetData({ _action: "getMemoryPresetDetail", presetId: p.id || p.name }, { username, char_id: charId });
        if (detail?.injections) injections.push(...detail.injections.map(inj => ({ ...inj, presetId: p.id || p.name })));
      } catch {}
    }
  }
  res.json({ success: true, injections });
}, "GET /v1/injections"));

router.post("/injections", requireApiKeyScope("presets:write"), requireConfirm(v1.DANGEROUS_OPS["injections/write"]), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const charId = req.query?.char_id || "_global";
  const { action, ...data } = req.body || {};
  if (!action || !["addInjectionPrompt", "updateInjectionPrompt", "deleteInjectionPrompt"].includes(action))
    return res.status(400).json({ error: "action must be addInjectionPrompt/updateInjectionPrompt/deleteInjectionPrompt" });
  const mod = await _loadSetDataActions();
  const result = await mod.handleSetData({ _action: action, ...data }, { username, char_id: charId });
  res.json({ success: true, result });
}, "POST /v1/injections"));

// ============================================================
// EXT-I: 工具 API — 纯透传 (列表 + 执行),具体工具由 beilu 内部注册决定
//   框架只暴露接口,不定义"哪些工具应该存在"
// ============================================================
router.get("/tools/list", requireApiKeyScope("tools:list"), asyncHandler(async (_req, res) => {
  const { __projectRoot } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  // 尝试从 aiRunner 导出 toolRegistry / getAvailableTools;若无则返回空
  try {
    const aiRunnerPath = path.join(__projectRoot, "src", "public", "parts", "plugins", "beilu-memory", "lib", "aiRunner.mjs");
    const mod = await import(pathToFileURL(aiRunnerPath).href);
    const list = mod.getAvailableTools?.() || mod.listTools?.() || [];
    return res.json({ tools: Array.isArray(list) ? list : [] });
  } catch {
    return res.json({ tools: [], note: "aiRunner does not export tool list" });
  }
}, "GET /v1/tools/list"));

router.post("/tools/execute", requireApiKeyScope("tools:exec"), asyncHandler(async (req, res) => {
  const { tool, args } = req.body || {};
  if (!tool) return res.status(400).json({ error: "missing tool" });
  const { __projectRoot } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  try {
    const aiRunnerPath = path.join(__projectRoot, "src", "public", "parts", "plugins", "beilu-memory", "lib", "aiRunner.mjs");
    const mod = await import(pathToFileURL(aiRunnerPath).href);
    const exec = mod.executeTool || mod.callTool || mod.runTool;
    if (typeof exec !== "function") return res.status(501).json({ error: "tool execute not available" });
    const { username } = await getUserByReq(req);
    const result = await exec({ tool, args: args || {}, username });
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}, "POST /v1/tools/execute"));

// ============================================================
// EXT-I: Webhooks — 用户可注册外部 URL 接收事件推送
//   存储在 data/users/:username/webhooks.json
//   事件触发后端内部广播时,本模块 HMAC 签名 + POST 到注册 URL
//   EXT-WH(2026-06-12)：事件触发挂点已接 —— broadcast.broadcastChatEvent 在 AI 回复终态
//     (message_replaced/is_generating=false)调用 _dispatchWebhookEvent（见本文件下方 + broadcast.mjs setWebhookDispatcher）。
// ============================================================
async function _readWebhooks(username) {
  const fs = await import("node:fs");
  const { getWebhooksPath } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const file = getWebhooksPath(username);
  if (!fs.existsSync(file)) return [];
  // T021 留痕 + T019 同族风险注记：损坏时静默返 []，若用户随后增删 webhook 会以空表为基写回=整表覆盖。
  // 本批只加留痕不改读写语义（safeJsonIO 收编属 T019 差集，登记待收）。
  try { return JSON.parse(await fs.promises.readFile(file, "utf-8")); } catch (e) { console.warn(`[api_v1] webhooks.json 解析失败（损坏？）: ${e?.message || e}`); return []; }
}
async function _writeWebhooks(username, list) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { getWebhooksPath } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const file = getWebhooksPath(username);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
  // [0716 断电安全] 原子写收口：原直写断电=webhooks 文件半写损坏
  nicerWriteFileSync(file, JSON.stringify(list, null, 2), "utf-8");
}

router.get("/webhooks", requireApiKeyScope("webhooks:read"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const list = await _readWebhooks(username);
  res.json({ webhooks: list.map(w => ({ id: w.id, url: w.url, events: w.events, createdAt: w.createdAt })) });
}, "GET /v1/webhooks"));

router.post("/webhooks", requireApiKeyScope("webhooks:write"), asyncHandler(async (req, res) => {
  const { url, events, secret } = req.body || {};
  if (!url || !Array.isArray(events) || events.length === 0)
    return res.status(400).json({ error: "missing url or events[]" });
  const { username } = await getUserByReq(req);
  const list = await _readWebhooks(username);
  const crypto = await import("node:crypto");
  const id = "wh-" + crypto.randomBytes(8).toString("hex");
  const entry = {
    id, url, events, secret: secret || crypto.randomBytes(16).toString("hex"),
    createdAt: Date.now(),
  };
  list.push(entry);
  await _writeWebhooks(username, list);
  res.status(201).json({ success: true, id, secret: entry.secret });
}, "POST /v1/webhooks"));

router.delete("/webhooks/:id", requireApiKeyScope("webhooks:write"), asyncHandler(async (req, res) => {
  const { username } = await getUserByReq(req);
  const list = await _readWebhooks(username);
  const next = list.filter(w => w.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: "webhook not found" });
  await _writeWebhooks(username, next);
  res.json({ success: true });
}, "DELETE /v1/webhooks/:id"));

// GW-T1: 动态加载 beilu-chat 主模块(首次调用时缓存)
let _beiluChatModule = null;
async function _getBeiluChat() {
  if (_beiluChatModule) return _beiluChatModule;
  const { __projectRoot } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const chatPath = path.join(__projectRoot, "src", "public", "parts", "shells", "beilu-chat", "src", "chat.mjs");
  _beiluChatModule = await import(pathToFileURL(chatPath).href);
  // EXT-WH: 装配 Webhook 分发器 —— 一旦 chat 模块（含 broadcast 层）就绪，立即把出站推送器注入广播层。
  //   从 v1 层注入（v1 合法依赖 chat），不让壳层反向 import 服务层；幂等（setter 覆盖同一引用）。
  try {
    if (typeof _beiluChatModule.setWebhookDispatcher === "function") {
      _beiluChatModule.setWebhookDispatcher(_dispatchWebhookEvent);
    }
  } catch (e) {
    try { console.warn("[v1/webhook] 装配分发器失败:", e?.message); } catch {}
  }
  return _beiluChatModule;
}

// ============================================================
// EXT-WH: Webhook 出站分发器（broadcast 层在 AI 回复终态时调用）
//   职责：读注册用户的 webhooks → 过滤订阅了回复完成事件的 → HMAC 签名 → POST 到外部 URL。
//   fire-and-forget：内部全程 try/catch，失败一次重试，错误进日志（不抛回广播主链）。
//   离线安全：无注册 webhook = 零外发；出站 POST 仅去用户主动配置的 URL。
//   事件映射：本终态对应设计的 message_received / generation_ended，二者任一被订阅即推送。
const _WH_TRIGGER_EVENTS = ["message_received", "generation_ended"];

async function _postWebhookOnce(url, bodyStr, signature, eventName) {
  // 8 秒超时，防外部 URL 挂起拖住（fire-and-forget 也不要泄漏挂起 socket）。
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    // SEC-T7（含 D5 redirect 防护）：safeFetch 对首跳及每个重定向 Location 都校验，拦内网/云元数据/混淆IP/302→内网
    const resp = await safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Beilu-Signature": "sha256=" + signature,
        "X-Beilu-Event": eventName,
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    return resp.ok;
  } finally {
    clearTimeout(t);
  }
}

async function _dispatchWebhookEvent(username, chatId, event) {
  try {
    const list = await _readWebhooks(username);
    if (!list.length) return; // 无注册 = 零外发
    const matched = list.filter((w) =>
      Array.isArray(w.events) && w.events.some((e) => _WH_TRIGGER_EVENTS.includes(e))
    );
    if (!matched.length) return;

    const crypto = await import("node:crypto");
    const entry = event?.payload?.entry || {};
    // 标准化出站 payload（不解释内容，纯透传 role/content/name/时间戳 + chatId）。
    const data = {
      chatId,
      content: entry.content_for_show ?? entry.content ?? "",
      role: entry.role ?? null,
      name: entry.name ?? null,
      timestamp: entry.time_stamp ?? Date.now(),
    };

    for (const w of matched) {
      // 每个 webhook 用自己订阅的命中事件名（取第一个命中的，作为 X-Beilu-Event）。
      const eventName = (w.events.find((e) => _WH_TRIGGER_EVENTS.includes(e))) || "message_received";
      const bodyStr = JSON.stringify({ event: eventName, data });
      const signature = crypto.createHmac("sha256", String(w.secret || "")).update(bodyStr).digest("hex");
      // fire-and-forget：失败一次重试（禁复杂队列）；两次都失败进 diag。
      (async () => {
        try {
          let ok = await _postWebhookOnce(w.url, bodyStr, signature, eventName);
          if (!ok) ok = await _postWebhookOnce(w.url, bodyStr, signature, eventName); // 一次重试
          if (!ok) console.warn(`[v1/webhook] 推送失败(非2xx)且重试无效: id=${w.id} url=${w.url}`);
        } catch (err) {
          try { console.warn(`[v1/webhook] 推送异常 id=${w.id}: ${err?.message || err}`); } catch {}
        }
      })();
    }
  } catch (e) {
    try { console.warn("[v1/webhook] 分发器异常:", e?.message); } catch {}
  }
}

// GW-T1: 外部输入 sanitize + 身份隔离标记
//   < > 转全角:防 beilu 内部协议标签被注入
//   长度截断:防巨大 payload 冲垮上下文
//   <external_user name="..."> 包裹:告诉 AI "这是外部不可信用户 X 说的",多人对话能分辨身份
function _sanitizeExternalInput(raw, senderName) {
  const name = String(senderName || "外部用户").replace(/[<>&"']/g, "").slice(0, v1.V1_CONST.SANITIZE_SENDER_MAX);
  let safe = String(raw || "");
  // SEC-PI: 确定性预处理——剥除不可见 Unicode 字符，防 invisible prompt injection。
  //   判据单源在 untrusted_content.stripInvisibleUnicode（api_v1 与 10 bot 平台共用一份，禁各写一份）。
  safe = stripInvisibleUnicode(safe);
  safe = safe.replace(/</g, "＜").replace(/>/g, "＞");
  if (safe.length > v1.V1_CONST.SANITIZE_MAX_LEN) safe = safe.slice(0, v1.V1_CONST.SANITIZE_MAX_LEN) + "...[截断]";
  return `<external_user name="${name}">${safe}</external_user>`;
}

export function registerV1Routes(app) {
  app.use("/api/v1", router);

  // ============================================================
  // GW-T1: 外部游戏桥接 WebSocket
  //   连接: ws://host/api/v1/game/connect?chatId=<id>&token=<api-key>
  //   认证: apiKeyAuth (支持 query.token)
  //
  //   客户端 → 服务端:
  //     {type:"send", content, sender?, charName?}  触发 AI 回复(含 sanitize)
  //     {type:"ping"}                               心跳
  //     {type:"raw_send", content, charName?}       直接转发不 sanitize(仅限受信客户端)
  //
  //   服务端 → 客户端(自动广播,复用 chatUiSockets):
  //     {type:"stream_update", payload:{messageId, slices}}  流式 token
  //     {type:"message_added", payload:{entry}}              新消息(用户/AI)
  //     {type:"message_updated", payload:{index, entry}}     消息编辑
  //     {type:"generation_ended"}                            AI 生成结束
  //     {type:"error", message}                              错误
  //     {type:"connected", chatId, username, timestamp}      连接就绪
  // ============================================================
  app.ws("/api/v1/game/connect", apiKeyAuth, async (ws, req) => {
    const _rawChatId = req.query?.chatId || req.query?.chatid;
    if (!_rawChatId) {
      try { ws.send(JSON.stringify({ type: "error", message: "missing chatId query param" })); } catch {}
      ws.close(1008, "missing chatId");
      return;
    }
    const chatId = confineSegment(_rawChatId);
    let username;
    try { ({ username } = await getUserByReq(req)); }
    catch (e) { ws.close(1008, "auth failed: " + e.message); return; }

    // SEC-B: game/connect 需要 chat:send scope(触发 AI 回复)
    if (!apiKeyHasScope(req.user, "chat:send")) {
      try { ws.send(JSON.stringify({ type: "error", message: "API Key missing scope: chat:send" })); } catch {}
      ws.close(1008, "scope denied");
      return;
    }

    let chatModule;
    try { chatModule = await _getBeiluChat(); }
    catch (e) {
      try { ws.send(JSON.stringify({ type: "error", message: "chat module load failed: " + e.message })); } catch {}
      ws.close(1011);
      return;
    }

    // SEC-IDOR: 校验 chatId 归属当前认证用户，防接入他人会话的实时流/触发其角色
    if (!await _isChatOwner(chatModule, chatId, username)) {
      try { ws.send(JSON.stringify({ type: "error", message: "chat not found" })); } catch {}
      ws.close(1008, "not owner");
      return;
    }

    try {
      chatModule.registerChatUiSocket(chatId, ws, username);
    } catch (e) {
      try { ws.send(JSON.stringify({ type: "error", message: "register failed: " + e.message })); } catch {}
      ws.close(1011);
      return;
    }

    try {
      ws.send(JSON.stringify({ type: "connected", chatId, username, timestamp: Date.now() }));
    } catch {}
    wbTrace(chatId, "api", "game/connect:open", { username });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { try { ws.send(JSON.stringify({ type: "error", message: "invalid json" })); } catch {} return; }

      if (msg.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() })); } catch {}
        return;
      }

      if (msg.type === "send" || msg.type === "raw_send") {
        // SEC-B: raw_send 跳过输入消毒，需独立 scope 隔离（默认 API Key 不含此 scope）
        if (msg.type === "raw_send" && !apiKeyHasScope(req.user, "chat:raw")) {
          try { ws.send(JSON.stringify({ type: "error", message: "API Key missing scope: chat:raw" })); } catch {}
          wbDetect(chatId, "api", "game/connect:raw_send_scope_denied", false, "chat:raw scope 不足", { username });
          return;
        }
        const content = String(msg.content ?? "");
        if (!content.trim()) {
          try { ws.send(JSON.stringify({ type: "error", message: "empty content" })); } catch {}
          return;
        }
        const wrapped = msg.type === "raw_send"
          ? content
          : _sanitizeExternalInput(content, msg.sender);
        wbTrace(chatId, "api", "game/connect:send", { type: msg.type, len: content.length });
        try {
          await chatModule.addUserReply(chatId, { content: wrapped, files: [] }, { expectedUsername: username });
          chatModule.triggerCharReply(chatId, msg.charName, { sourceChannel: "game_ws" }).catch((err) => {
            wbDetect(chatId, "api", "game/connect:trigger", false, err.message);
            try { ws.send(JSON.stringify({ type: "error", message: "AI trigger failed: " + err.message })); } catch {}
          });
        } catch (e) {
          wbDetect(chatId, "api", "game/connect:send", false, e.message);
          try { ws.send(JSON.stringify({ type: "error", message: "send failed: " + e.message })); } catch {}
        }
        return;
      }

      try { ws.send(JSON.stringify({ type: "error", message: "unknown type: " + msg.type })); } catch {}
    });

    ws.on("close", () => {
      // registerChatUiSocket 内部已绑定 close → 自动从 chatUiSockets 移除,无需额外处理
    });
  });
}
