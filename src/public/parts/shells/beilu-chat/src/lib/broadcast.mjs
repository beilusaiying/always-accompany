/**
 * beilu-chat 广播层 — 管「WS 连接注册/生命周期」「per-chatid 事件广播」「流式生成任务(StreamManager)」。
 * 不管生成调度（那是 generation.mjs 的事）、不管消息构建（那是 messageBuilder 的事）。
 *
 * 链路：generation.mjs / chatOps.mjs 调 broadcastChatEvent → 按 chatid 取 chatUiSockets 逐 WS 推送
 *       StreamManager.create → createBufferedSyncPreviewUpdater(stream.mjs) → generateDiff → 广播 stream_update
 * 影响：WS 推送所有事件到前端 / 背压检查超 1MB 丢弃非关键消息 / webhook 终态推送(fire-and-forget) /
 *       ws.on("close") 延迟 5s 中止在飞流+卸载 chatMetadata
 * 相交：← generation.executeGeneration·triggerCharReply·chatOps.addChatLogEntry（广播调用方）
 *       → stream.mjs(createBufferedSyncPreviewUpdater·generateDiff)·groupRegistry(组隔离)·whitebox(wbTrace/wbDetect)
 */

import { createBufferedSyncPreviewUpdater, generateDiff } from "../stream.mjs";
// ★ 白盒（K13 迁移后）：whitebox 已迁至核心层 server/whitebox.mjs，broadcast 单向向下依赖它（无环）。
// ★ 反向（whitebox→广播）改为 setBroadcaster 注入，由 chat.mjs 启动时装配 broadcastChatEvent。
// ★ 契约不变：broadcastChatEvent 函数体内严禁调用任何 wb*（否则 wb→broadcaster→wb 无限递归）。
import { wbTrace, wbDetect } from "../../../../../../server/whitebox.mjs";
// v4 簇②：跨 chat 广播按 groupId 过滤。groupRegistry 仅依赖 auth/json_loader，与 broadcast 无环。
import { getGroupIdByChatId, getGroupChatIds } from "./groupRegistry.mjs";
// 跨 isolate 收口（isolateBridge）：worker isolate 内本模块的 chatUiSockets 恒空（isolate 隔离单例），
// 四个广播出口在 worker 中统一改走桥上行、由主进程的真实注册表代发；主 isolate 加载时自注册回放处理器。
// isolate 判定内化在本系统内部——调用方（replyHandler/beilu-files 等插件链）零改动。桥零依赖，无环。
import { isWorkerIsolate, publishFromWorker, registerBridgeHandler } from "../../../../../../yonban/core/transport/isolateBridge.mjs";
import { createDiag } from "../../../../../../server/diagLogger.mjs";

// 诊断 stream 模块常驻埋点（0716 死标记接线）：流生命周期/背压丢弃/WS发送失败按需可见。
// 纯 console 输出，不经 broadcastChatEvent（与 :16 的 wb* 禁令不同源，无递归风险）。
const diag = createDiag("stream");

// WS 和流统计
export const broadcastStats = {
  wsConnections: 0, wsDisconnects: 0, wsSendErrors: 0,
  backpressureSkips: 0, activeStreams: 0, streamAborts: 0,
};

// W66: 停止生成时的回调（由 generation.mjs 注册，避免循环依赖）
let _onStopGeneration = null;
export function setOnStopGeneration(fn) { _onStopGeneration = fn; }

// EXT-WH: Webhook 事件分发器（由 server/web_server/api_v1_router.mjs 注入，避免壳层→服务层耦合）。
//   注入时机：v1 路由 _getBeiluChat() 懒加载本模块后立即装配。
//   触发口径：AI 回复完成的「最收口」终态 = broadcastChatEvent 的 message_replaced(is_generating=false, 非 user)
//             —— 与 api_v1_router /chat/send mockWs 的终态识别同口径（单一权威终态点）。
//   契约：dispatcher(username, chatid, event) fire-and-forget，内部自己 try/catch + 重试 + 落 diag，
//         绝不阻塞广播主链、绝不抛错回本函数。
let _webhookDispatcher = null;
export function setWebhookDispatcher(fn) { _webhookDispatcher = fn; }

// v4 簇②：注入式拿到 chatid→{username} 索引（复用 registerChatUiSocket 已收的 getChatMetadatas，
// 避免静态 import chatStorage 触发循环初始化）。用于把 sourceChatId 解析到 username 再查组。
let _getChatMetadatas = null;

// ============================================================
// StreamManager — 流式生成任务管理
// ============================================================

/**
 * StreamManager — 流式生成任务管理。per-chatid/messageId 跟踪在飞流，提供 create/abort/abortAll。
 *
 * 链路：triggerCharReply → StreamManager.create → 返回 {update,done,abort,signal}
 *       → executeGeneration 经 request.generation_options.replyPreviewUpdater 调 stream.update
 *       → createBufferedSyncPreviewUpdater(33ms 节流) → generateDiff → 广播 stream_update
 *       → stream.done()/abort() 清理 activeStreams + 更新 broadcastStats
 * 影响：activeStreams Map 变更 / broadcastStats 计数 / 实时 emotion_changed·motion_triggered 广播
 */
const activeStreams = new Map();
export const StreamManager = {
  create(chatId, messageId) {
    const streamId = crypto.randomUUID();
    const controller = new AbortController();

    const context = {
      chatId,
      messageId,
      lastMessage: { content: "", files: [] },
      lastEmotion: "", // ★ Live2D 关联：上次广播的情感，变化才发（防 30fps 重发）
      lastMotion: "",  // ★ Live2D 关联：上次广播的动作组名，变化才发（同 emotion 去重范式）
      controller,
    };

    activeStreams.set(streamId, context);
    broadcastStats.activeStreams++;
    wbTrace(chatId, "broadcast", "StreamManager.create", { streamId, messageId });
    diag.debug("stream create:", streamId.slice(0, 8), "chat:", chatId, "msg:", messageId, "在飞:", broadcastStats.activeStreams);

    const syncUpdate = createBufferedSyncPreviewUpdater((newMessage) => {
      if (context.controller.signal.aborted) return;
      const slices = generateDiff(context.lastMessage, newMessage);
      if (slices.length > 0) {
        context.lastMessage = structuredClone(newMessage);
        broadcastChatEvent(chatId, {
          type: "stream_update",
          payload: { messageId, slices },
        });
      }
      // ★ Live2D 关联（实时 emotion producer）：从 raw content 检测 <emotion> 标签，变化即广播。
      //   必须用 newMessage.content（raw，含标签）——generateDiff/前端走 content_for_show 已剥 <emotion>。
      //   情感值→Live2D 表情/语音映射是角色卡 config；此处只做框架级标签提取（beilu 只做管道不做内容识别）。
      const _rawC = newMessage?.content || "";
      const _emoM = _rawC.match(/<emotion>\s*([^<]+?)\s*<\/emotion>/gi);
      if (_emoM && _emoM.length) {
        const _emo = _emoM[_emoM.length - 1].replace(/<\/?emotion>/gi, "").trim();
        if (_emo && _emo !== context.lastEmotion) {
          context.lastEmotion = _emo;
          broadcastChatEvent(chatId, {
            type: "emotion_changed",
            payload: { messageId, emotion: _emo },
          });
        }
      }
      // ★ Live2D 关联（实时 motion producer）：从 raw content 检测 <motion> 标签，变化即广播。
      //   沿用 emotion 去重范式：取最后一个匹配，与 lastMotion 比较，变化才发。
      //   支持 <motion>group</motion> 和 <motion name="group"/> 两种写法。
      const _motM = _rawC.match(/<motion(?:\s+name="([^"]+)")?\s*\/?>([^<]*?)(?:<\/motion>)?/gi);
      if (_motM && _motM.length) {
        const _lastTag = _motM[_motM.length - 1];
        const _motDetail = _lastTag.match(/<motion(?:\s+name="([^"]+)")?\s*\/?>([^<]*?)(?:<\/motion>)?/i);
        const _mot = (_motDetail && (_motDetail[1] || _motDetail[2] || "").trim()) || "";
        if (_mot && _mot !== context.lastMotion) {
          context.lastMotion = _mot;
          broadcastChatEvent(chatId, {
            type: "motion_triggered",
            payload: { messageId, motion: _mot },
          });
        }
      }
    });

    return {
      id: streamId,
      signal: controller.signal,
      get lastContent() { return context.lastMessage?.content || ""; },
      get lastFiles() { return context.lastMessage?.files || []; },

      update(newMessage) {
        if (context.controller.signal.aborted) return;
        syncUpdate(newMessage);
      },

      done() {
        // 计数与 set 成员单源绑定：仅当真删掉在飞流才减（Set.delete 返回 true）。
        // 防 abort()+done()(finalizeEntry) 对同一流二次递减致 activeStreams 下溢为负。
        if (activeStreams.delete(streamId)) broadcastStats.activeStreams--;
      },

      abort(reason = "User Aborted") {
        if (context.controller.signal.aborted) return;
        const error = new Error(reason);
        error.name = "AbortError";
        context.controller.abort(error);
        // 计数与 set 成员单源绑定：仅当真删掉在飞流才减（Set.delete 返回 true）。
        // 防 abort()+done()(finalizeEntry) 对同一流二次递减致 activeStreams 下溢为负。
        if (activeStreams.delete(streamId)) broadcastStats.activeStreams--;
        broadcastStats.streamAborts++;
        diag.debug("stream abort:", streamId.slice(0, 8), "reason:", reason, "累计中止:", broadcastStats.streamAborts);
        wbTrace(chatId, "broadcast", "StreamManager.abort", { streamId, messageId, reason });
      },
    };
  },

  abortByMessageId(messageId) {
    for (const [id, ctx] of activeStreams)
      if (ctx.messageId === messageId) {
        if (ctx.controller.signal.aborted) continue;
        const error = new Error("User Aborted");
        error.name = "AbortError";
        ctx.controller.abort(error);
        if (activeStreams.delete(id)) broadcastStats.activeStreams--;
        return true; // T009 B6：返回是否精确命中，调用方据此决定要不要 abortAll 兜底
      }
    return false;
  },

  abortAll(chatId) {
    const toDelete = [];
    for (const [id, ctx] of activeStreams)
      if (ctx.chatId === chatId) {
        if (ctx.controller.signal.aborted) continue;
        const error = new Error("User Aborted");
        error.name = "AbortError";
        ctx.controller.abort(error);
        toDelete.push(id);
      }
    for (const id of toDelete) if (activeStreams.delete(id)) broadcastStats.activeStreams--;
    return toDelete.length; // 81：返回实际中止的在飞流数（0=该窗口当时没在生成，调用方据此判断是否需写后激活）
  },
};

// ============================================================
// 全局 WebSocket / typing 状态
// ============================================================

export const chatUiSockets = new Map();
const typingStatus = new Map();

export function updateTypingStatus(chatid, charname, delta) {
  if (!typingStatus.has(chatid)) typingStatus.set(chatid, new Map());
  const chatMap = typingStatus.get(chatid);
  const current = chatMap.get(charname) || 0;
  const next = current + delta;
  if (next <= 0) chatMap.delete(charname);
  else chatMap.set(charname, next);

  const typingList = Array.from(chatMap.keys());
  broadcastChatEvent(chatid, {
    type: "typing_status",
    payload: { typingList },
  });
}

export function getTypingList(chatid) {
  const chatMap = typingStatus.get(chatid);
  return chatMap ? Array.from(chatMap.keys()) : [];
}

/**
 * 某对话当前打开的 WS 连接数（readyState OPEN 才算）。
 * 【why】"哪个窗口在用"的权威事实源就是 chatUiSockets 注册表——对话列表的「在用」角标
 *   从这里取数，而不是前端各窗口自猜。消费链：chatStorage.getChatList 注入 inUseCount
 *   → GET /getchatlist → 前端列表角标。
 */
export function getChatOpenConnCount(chatid) {
  const sockets = chatUiSockets.get(chatid);
  if (!sockets) return 0;
  let n = 0;
  for (const ws of sockets) if (ws.readyState === ws.OPEN) n++;
  return n;
}

/**
 * 会话删除清理：清本会话残留的 typingStatus 外层键（#85 同类补漏）。
 * 内层 charname 归零会自删，但外层 chatid→Map 即使空也从不删、deleteChat 原不通知本类 → 单调泄漏。
 * "" 兜底键不删。
 */
export function forgetChatTyping(chatid) {
  if (!chatid) return;
  typingStatus.delete(chatid);
}

// ============================================================
// 广播
// ============================================================

// W07-B2修复: WS背压检查阈值（超过1MB缓冲则跳过非关键消息）
const WS_BACKPRESSURE_LIMIT = 1024 * 1024;
const WS_CLOSE_GRACE_MS = 5000; // WS 断开后给浏览器刷新重连的宽限窗口

export function broadcastAllChatUi(event, username) {
  if (isWorkerIsolate) {
    const published = publishFromWorker("broadcast", null, { fn: "allChatUi", args: [event, username] });
    if (!published)
      console.warn("[broadcast] worker 桥无在飞 emitter，allChatUi 事件丢弃:", event?.type);
    return published;
  }
  const payload = JSON.stringify(event);
  // #181: 传 username 时只推给该用户的 chatId（多用户隔离），不传则全推（Bot 全局事件等）
  const ownerScoped = typeof username === "string" && username.length > 0;
  const metas = ownerScoped && _getChatMetadatas ? (() => { try { return _getChatMetadatas(); } catch { return null; } })() : null;
  // owner 已给却没有 owner→chat 索引时必须零发送；否则“用户级”会退化成全用户广播。
  if (ownerScoped && !metas) return false;
  for (const [cid, sockets] of chatUiSockets.entries()) {
    if (ownerScoped) {
      try { if (metas.get(cid)?.username !== username) continue; } catch { /* metadata miss → 跳过 */ }
    }
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) continue;
      try { ws.send(payload); } catch { /* 静默 */ }
    }
  }
  return true;
}

/**
 * per-chatid WS 事件广播 — 向该 chatid 已连接的所有 WS 客户端推送事件。
 *
 * 链路：generation.mjs·chatOps.mjs 等 → 本函数 → 逐 socket ws.send
 *       → AI 回复终态(message_replaced + is_generating=false + 非 user) → 触发 webhook dispatcher(fire-and-forget)
 * 影响：WS 推送 / 背压超 1MB 时丢弃 stream_update·typing_status·wb_trace / webhook 出站推送
 * 约束：M-02 — 无 UI socket 时不早 return（webhook 出站对 headless/API/bot 是主用例）；
 *       函数体内严禁调用任何 wb*（否则 wb→broadcaster→wb 无限递归）
 *
 * @param {string} chatid - 目标会话 ID
 * @param {{type: string, payload: object}} event - 要广播的事件对象
 */
export function broadcastChatEvent(chatid, event) {
  // 跨 isolate 收口：worker 内注册表恒空，改走桥由主进程代发（webhook 挂点也只在主进程装配，无损失）。
  if (isWorkerIsolate) {
    if (!publishFromWorker("broadcast", chatid, { fn: "chatEvent", args: [chatid, event] }))
      console.warn("[broadcast] worker 桥无在飞 emitter，chatEvent 丢弃:", event?.type);
    return;
  }
  const sockets = chatUiSockets.get(chatid);
  // ★ M-02: 不能在无 UI socket 时早 return——下方 webhook 出站块对 headless(API/bot, 无 UI 连接)
  //   才是主用例，旧版 `if(!sockets?.size) return` 让 webhook 永不可达=headless webhook 全失效。
  //   WS 广播自身用 size 守卫；webhook 块（下方）有自己的终态门，无论有无 UI 都可达。
  const message = sockets?.size ? JSON.stringify(event) : null;
  const isNonCritical = event.type === "stream_update" || event.type === "typing_status" || event.type === "wb_trace";

  if (sockets?.size) for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    // 背压检查：stream_update/typing_status在缓冲区过大时可丢弃
    if (isNonCritical && ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
      broadcastStats.backpressureSkips++;
      diag.throttled("backpressure", 50, "背压丢弃:", event.type, "chat:", chatid, "buffered:", ws.bufferedAmount, "累计:", broadcastStats.backpressureSkips);
      continue;
    }
    try { ws.send(message); } catch (e) { broadcastStats.wsSendErrors++; diag.warn("ws.send 失败:", event.type, "chat:", chatid, e?.message, "累计:", broadcastStats.wsSendErrors); }
  }

  // EXT-WH: Webhook 出站推送挂点 —— 仅在 AI 回复完成的终态触发。
  //   终态判定与 api_v1_router /chat/send 完全一致：message_replaced + entry.is_generating===false + 非 user。
  //   解析 chat 归属 username（_getChatMetadatas 注入索引），交给 dispatcher fire-and-forget。
  if (
    _webhookDispatcher &&
    event.type === "message_replaced" &&
    event.payload?.entry &&
    event.payload.entry.is_generating === false &&
    event.payload.entry.role !== "user"
  ) {
    try {
      const username = _getChatMetadatas?.()?.get(chatid)?.username;
      if (username) {
        // 不 await：webhook 出站不阻塞广播主链（dispatcher 内部自负重试/落 diag）。
        _webhookDispatcher(username, chatid, event);
      }
    } catch (e) {
      // 解析 username 失败等绝不影响广播：吞掉但记 detect（非吞业务错误，是隔离主链）。
      wbDetect(chatid, "broadcast", "webhook:dispatch:resolve:catch", false, e?.message || String(e), null);
    }
  }
}

// [BE-T7] 跨 chatId 广播 — 向所有已连接 chatId 的客户端推送(替代前端10s轮询)
// 用于全智能在 chat-xxx 监听 work-yyy 的任务事件
//
// v4 簇②（多组并行）：若源 chat 属于某并行组，则只广播到同组的 chatid（多组隔离，
// 防 A 组任务事件串到 B 组窗口）；源 chat 不属任何组时退回 legacy 全广播——这样
// pre-group 的单上下文跨模式监听（C-1/BE-T7：全智能在 chat 监听 work 任务）不被破坏。
// 注：此处只治「广播 fan-out」一条串话向；BUG-H（诊断告警无 chatid 串话）根因在
//     ideClient 的 diagnostics_changed push 漏 chatid，归 ⑧，不在本函数。
/**
 * 跨 chatId 广播 — 向源 chatId 以外的客户端推送事件（替代前端 10s 轮询）。
 *
 * 链路：beilu-memory 任务事件 → 本函数 → 按组/用户隔离 fan-out → 同组/同用户其他 chatid 的 WS 客户端
 * 影响：WS 推送跨 chat 事件 / v4 多组隔离（属组则只投同组，否则退回同用户全广播）
 * 约束：源 chatId 已通过 broadcastChatEvent 通知过，此处跳过源以避免重复；
 *       #181 多用户隔离 — 无组时退回同用户广播（不跨用户）
 *
 * @param {string|null} sourceChatId - 事件源会话 ID（会被跳过不重复推送）
 * @param {{type?: string, payload?: object}} event - 要广播的事件（缺 type 时默认 cross_mode_task_update）
 * @param {string|null} usernameOverride - source 为空时由认证调用方显式提供的用户 owner
 * @returns {boolean} 是否已解析出安全的用户范围并接受广播
 */
export function broadcastCrossChatEvent(sourceChatId, event, usernameOverride = null) {
  if (isWorkerIsolate) {
    const published = publishFromWorker("broadcast", sourceChatId, { fn: "crossChatEvent", args: [sourceChatId, event, usernameOverride] });
    if (!published)
      console.warn("[broadcast] worker 桥无在飞 emitter，crossChatEvent 丢弃:", event?.type);
    return published;
  }
  const payload = JSON.stringify({
    ...event,
    type: event.type || "cross_mode_task_update",
    sourceChatId,
  });

  // 解析源 chat 的组 scope + username：拿到组则只投同组，否则退回同用户全广播（#181: 多用户隔离）。
  // source 为空时只接受认证调用方传入的 usernameOverride；两者都没有时 fail-closed。
  let allowed = null;
  let _srcUsername = null;
  let _metas = null;
  try {
    _metas = _getChatMetadatas?.();
    _srcUsername = (sourceChatId ? _metas?.get(sourceChatId)?.username : null) || usernameOverride;
  } catch (_ownerErr) {
    console.warn("[broadcast] broadcastCrossChatEvent: owner 查询失败, 已拒绝广播:", _ownerErr?.message || _ownerErr);
    return false;
  }
  if (!_metas || !_srcUsername) return false;
  if (sourceChatId) {
    try {
      const groupId = sourceChatId ? getGroupIdByChatId(_srcUsername, sourceChatId) : null;
      if (groupId) allowed = new Set(getGroupChatIds(_srcUsername, groupId));
    } catch (_groupErr) {
      // 组索引不可用时仍可依靠已解析的 username 安全退回同用户广播，不跨 owner。
      console.warn("[broadcast] broadcastCrossChatEvent: 组隔离查询失败, 退回同用户广播:", _groupErr?.message || _groupErr);
    }
  }

  for (const [cid, sockets] of chatUiSockets.entries()) {
    if (cid === sourceChatId) continue; // 源 chatId 已经通过 broadcastChatEvent 通知过
    if (allowed && !allowed.has(cid)) continue; // 组隔离：非同组 chatid 跳过
    // 无论是否有组都再校验用户 owner；metadata miss 保守跳过。
    try { if (_metas.get(cid)?.username !== _srcUsername) continue; } catch { continue; }
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) continue;
      try { ws.send(payload); } catch { /* 静默 */ }
    }
  }
  return true;
}

/**
 * 跨客户端「当前对话」同步（本体↔YonBan）：生成开始时按 user 维度通知该用户的其它客户端
 * 「当前活动对话=chatid」。另一端据 peer_active_chat 自行决定是否跟随（默认跟随，可关）。
 * ★ 与 per-chatId 消息广播(broadcastChatEvent)正交：不改任何消息事件的作用域，只多发一条
 *   user 级软提示，故不回退多窗口隔离（同类多窗口可各自关闭跟随）。username 由 chat 元数据解析。
 */
export function broadcastUserActiveChat(chatid, reason = "attach") {
  if (isWorkerIsolate) {
    if (!publishFromWorker("broadcast", chatid, { fn: "userActiveChat", args: [chatid, reason] }))
      console.warn("[broadcast] worker 桥无在飞 emitter，userActiveChat 丢弃");
    return;
  }
  if (!chatid || !_getChatMetadatas) return;
  let metas, username;
  try { metas = _getChatMetadatas(); username = metas?.get(chatid)?.username; } catch { return; }
  if (!username) return;
  // reason 随事件下发（0727 多线）：消费端据此区分「用户打开了某对话」(attach，该跟随) 与
  //   「某对话开始生成」(generation，**不该**跟随)。原先两者共用一条无差别消息，导致后台线
  //   一开始生成就把用户当前看的界面抢走——与「一个窗口工作，另一个窗口可以继续」正面冲突。
  const payload = JSON.stringify({ type: "peer_active_chat", payload: { chatid, reason } });
  for (const [cid, sockets] of chatUiSockets.entries()) {
    let cu = null;
    try { cu = metas?.get(cid)?.username; } catch { cu = null; }
    if (cu !== username) continue;
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      try { ws.send(payload); } catch { /* 忽略单 socket 发送失败 */ }
    }
  }
}

// ============================================================
// WebSocket 注册（修复：关闭时保存而非删除）
// 注：saveChat 从 chatStorage 延迟引入，避免循环依赖在模块初始化阶段展开
// ============================================================

/**
 * 注册 WS 连接 — 绑定 chatid↔socket 映射，处理客户端消息(ping/stop_generation)，管理连接生命周期。
 *
 * 链路：endpoints.mjs WS upgrade → 本函数 → chatUiSockets.add
 *       → ws.on("message"): ping→pong / stop_generation→StreamManager.abortAll（[0724] 不再 cancelAutoContinue——停止只停在飞流）
 *       → ws.on("close"): 延迟 5s 确认无重连后 abortAll+saveChat+卸载 chatMetadata
 * 影响：chatUiSockets 新增映射 / broadcastUserActiveChat 同步当前对话 / ws.on("close") 触发 saveChat+内存卸载
 * 约束：getChatMetadatas/saveChat 延迟注入避免循环依赖；RC-1 修 — close 后还须取消自动继续定时器
 *
 * @param {string} chatid - 会话 ID
 * @param {WebSocket} ws - WebSocket 连接实例
 * @param {{getChatMetadatas: () => Map, saveChat: (chatid: string) => Promise<void>}} deps - 注入的依赖
 */
export function registerChatUiSocket(
  chatid,
  ws,
  { getChatMetadatas, saveChat },
  username,
) {
  // 捕获 chat 元数据索引供 broadcastCrossChatEvent 解析 username→groupId（注入式，避免循环 import）
  if (getChatMetadatas) _getChatMetadatas = getChatMetadatas;
  if (!chatUiSockets.has(chatid)) chatUiSockets.set(chatid, new Set());

  const socketSet = chatUiSockets.get(chatid);
  socketSet.add(ws);
  broadcastStats.wsConnections++;

  // G1/G2: 新WS连接注册时自动广播peer_active_chat，让所有同用户客户端跟随切对话
  // 覆盖：本体切对话(reconnectWebSocket) + YonBan切对话(connectChat) + 任何新WS连接
  // reason 显式写出（不靠默认值隐含语义）：新 WS 注册 = 某个客户端**打开/切到**了这个对话，
  //   这才是「用户切了对话」，是跟随语义成立的那一种。与 generation 那条区分开。
  broadcastUserActiveChat(chatid, "attach");

  const typingList = getTypingList(chatid);
  if (typingList.length > 0) {
    try { ws.send(JSON.stringify({ type: "typing_status", payload: { typingList } })); } catch { /* ws 可能已关 */ }
  }

  ws.on("message", async (message) => {
    try {
      const msg = JSON.parse(message);
      // H3: 应用层心跳。客户端（YonBan/网页）发 {type:"ping"} → 立即回 {type:"pong"}，
      //   使客户端能检测半开 TCP（防火墙静默丢/睡眠）僵连接并主动重连。纯往返、无副作用。
      if (msg.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong", payload: null })); } catch { /* ws 可能已关 */ }
        return;
      }
      if (msg.type === "stop_generation") {
        // T009 B6 精确停止语义：带 messageId 且命中 → 只停该流；未带 id 或未命中（流已完成/id 漂移）→ abortAll 全停。
        // 旧实现：前端无 id 时发魔法串 "__force_stop__"（abortByMessageId 必空转）+ 无条件 abortAll——兜底掩盖精确停止失效。
        const _targetId = msg.payload?.messageId || null;
        const _preciseHit = _targetId ? StreamManager.abortByMessageId(_targetId) : false;
        const _aborted = _preciseHit ? 1 : StreamManager.abortAll(chatid);
        // [0724 只许前端关·002拍板] 停止键只停在飞流，不再调 _onStopGeneration(=cancelAutoContinue)：
        //   原耦合=点一次停止整条自动继续/Loop 自动化静默死，而面板开关还显示开。停整条自动化的
        //   唯一出口=前端「自动继续」开关（二次确认）。中止轮的 loop 续轮由 generation 回合末
        //   _isAborted 分支/catch AbortError 路径接管（垫延迟下限，fire 时三闸守卫）。
        //   ws.on("close") 卸载路径仍走 _onStopGeneration（卸载后续轮=孤儿生成，见 generation 注册处注释）。
        console.log(`[broadcast] 用户停止生成: chatid=${chatid}, messageId=${_targetId || "(全部)"}, preciseHit=${_preciseHit}, aborted=${_aborted}`);
        wbTrace(chatid, "broadcast", "ws:stop_generation", { messageId: _targetId, preciseHit: _preciseHit, aborted: _aborted });
        return;
      }
      // WS dispatch 双向通信：前端发 {type:"dispatch", id, target, verb, payload, scope}
      // → 动态 import dispatcher → dispatch({verb,target,source:"ws",payload,scope}) → 回 dispatch_response。
      // 动态 import 避免循环依赖（broadcast ← 多模块 → dispatcher 共享 whitebox/registry 链）。
      if (msg.type === "dispatch") {
        const sendResponse = (resp) => {
          try { ws.send(JSON.stringify({ type: "dispatch_response", id: msg.id, ...resp })); } catch { /* ws 可能已关 */ }
        };
        try {
          const { dispatch: yonbanDispatch } = await import("../../../../../../yonban/core/dispatch/dispatcher.mjs");
          const { target, verb, payload, scope } = msg;
          const result = await yonbanDispatch({
            verb,
            target,
            source: "ws",
            payload: payload ?? {},
            scope: { ...(scope ?? {}), chatId: chatid, user: username },
          });
          sendResponse(result);
          wbTrace(chatid, "broadcast", "ws:dispatch", { id: msg.id, target, verb, ok: result?.ok });
        } catch (e) {
          const errMsg = e?.message || String(e);
          sendResponse({ ok: false, error: { code: "E_WS_DISPATCH", msg: errMsg } });
          console.error(`[broadcast] ws dispatch 异常: chatid=${chatid}, id=${msg.id}`, e);
          wbDetect(chatid, "broadcast", "ws:dispatch:catch", false, errMsg, null);
        }
        return;
      }
    } catch (e) {
      console.error("Error processing client websocket message:", e);
      wbDetect(chatid, "broadcast", "ws:message:parse:catch", false, e?.message || String(e), null);
    }
  });

  ws.on("close", () => {
    broadcastStats.wsDisconnects++;
    socketSet.delete(ws);
    wbTrace(chatid, "broadcast", "ws:close", { remaining: socketSet.size });
    if (!socketSet.size) {
      // 延迟 5 秒再中止——给浏览器刷新重连的窗口
      setTimeout(() => {
        const currentSet = chatUiSockets.get(chatid);
        if (currentSet && currentSet.size > 0) return; // 新连接已到，不中止
        chatUiSockets.delete(chatid);
        StreamManager.abortAll(chatid);
        // RC-1：确认无重连后，除中止在途 stream 外还须取消自动继续定时器，
        // 否则 5s 后 chatMetadata 置 null，已排队的 auto-continue setTimeout 仍会
        // 递归 triggerCharReply → 孤儿生成、末几轮工具结果不落盘（疑 #79 挂起根因）
        if (_onStopGeneration) _onStopGeneration(chatid);
        // 保存并卸载内存
        const chatMetadatas = getChatMetadatas();
        const chatData = chatMetadatas.get(chatid);
        if (chatData?.chatMetadata) {
          saveChat(chatid)
            .then(() => {
              // [0716 RC-2 判定与动作同时性] size 检查在 setTimeout 回调头同步做，但 saveChat 是
              // async——落盘的毫秒窗内新连接可到达（loadChat 复用同一 chatData 对象），此处无条件
              // 置 null 会卸载新窗口正在用的元数据（其间 mutator 的修改随 saveChat 读到 null 被跳过
              // =单次丢弃；下次 loadChat 从盘自愈无破坏）。卸载前二次核对无新连接，消灭整个窗口。
              if (chatUiSockets.get(chatid)?.size) return;
              chatData.chatMetadata = null;
            })
            .catch((err) => {
              console.error(`Failed to save chat ${chatid} on close:`, err);
              wbDetect(chatid, "broadcast", "ws:close:saveChat:catch", false, err?.message || String(err), null);
            });
        }
      }, WS_CLOSE_GRACE_MS);
    }
  });
}

// ============================================================
// 跨 isolate 桥回放（broadcast 域自注册，主 isolate 专属）
// ============================================================
// worker 上行的广播事件在此落到主进程真实 chatUiSockets/webhook。回放跑在主 isolate，
// isWorkerIsolate=false → 不会再次改道，无递归。
if (!isWorkerIsolate) {
  registerBridgeHandler("broadcast", (p) => {
    const a = Array.isArray(p?.args) ? p.args : [];
    if (p?.fn === "chatEvent") broadcastChatEvent(a[0], a[1]);
    else if (p?.fn === "allChatUi") broadcastAllChatUi(a[0], a[1]);
    else if (p?.fn === "crossChatEvent") broadcastCrossChatEvent(a[0], a[1], a[2]);
    else if (p?.fn === "userActiveChat") broadcastUserActiveChat(a[0], a[1]);
  });
}
