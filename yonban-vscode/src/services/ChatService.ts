/**
 * ChatService.ts — 聊天服务（WS + REST 双通道核心）— 封装与 beilu 后端的全部 REST API 调用 + 双 WS 通道消息分发。
 * 不管 webview 渲染（那是 YonBanProvider / webview-ui 的事）、不管 IDE 工具执行（那是 IdeWsServer + ToolExecutor 的事）。
 *
 * ═══ 架构概览 ═══
 *
 * 双 WS 通道：
 *   通道A（per-chat）：ws://{host}/ws/parts/shells:chat/ui/{chatid} — 聊天消息流，切对话时断重连
 *   通道B（per-user）：ws://{host}/ws/notify — 跨客户端事件（会话列表/角色卡变更），常驻不随切对话断开
 *
 * REST API 两大前缀：
 *   shells:chat — 聊天 CRUD / 消息操作 / 生成控制（_callApi 封装）
 *   plugins:beilu-memory / beilu-preset / beilu-regex — 记忆/预设/正则配置（_callPluginApi 封装）
 *
 * 链路：YonBanProvider.handleMessage(case "sendMessage") → ChatService.sendMessage() → _callApi → _fetchWithAuth → AuthService.fetchWithAuth
 *       后端 broadcastChatUi({type:"stream_update"}) → 通道A WS → _handleWsMessage → _onStreamUpdate.fire → YonBanProvider 转 webview
 * 影响：通过一组 EventEmitter（数量以本类字段为准）广播 WS 事件给 YonBanProvider；
 *       管理 _chatWs / _notifyWs 两个 WS 连接的生命周期（含心跳、断线重连、增量补拉）
 * 相交：← YonBanProvider（76+ case handleMessage 中大部分调用本服务方法）
 *       → AuthService.fetchWithAuth（统一 401-refresh-retry）
 *       → ConnectionService.state.serverUrl（取后端地址）
 *       → 本体 broadcast.mjs（WS 对端，推送 30 种聊天事件）
 *       → 本体 sendEventToUser（通道B 对端，推送跨客户端事件）
 *
 * ═══ 通道A WS 消息类型索引（_handleWsMessage；种数以 switch 代码为准，注释不写死会漂移的计数）═══
 *
 * 【消息生命周期】（4 种）
 *   message_added      — 新消息入 chatLog（用户发/AI 首帧/系统注入）
 *   message_replaced   — 生成完成后用最终版替换流式占位
 *   message_deleted     — 单条删除
 *   message_edited      — 消息内容编辑
 *
 * 【流式生成】（2 种）
 *   stream_start       — AI 开始生成（创建占位消息）
 *   stream_update      — 流式增量（slices: append / rewrite_tail / set_files）
 *
 * 【状态指示器】（2 种）
 *   typing_status      — 打字状态（typingList 角色名数组）
 *   token_usage        — 本次生成的 token 统计（input/output/cache_read/cache_creation）
 *
 * 【工具 & 审批】（2 种）
 *   tool_results_ready — IDE 工具执行完毕，结果已入 pendingResults 队列
 *   pending_approvals  — 有新的写操作待审批（W66）
 *
 * 【分身】（1 种）
 *   clone_status       — 分身 AI 执行进度（taskId / round / status / detail）
 *
 * 【模式 & 预设 & 运行参数】（4 种）
 *   mode_changed       — 模式切换（chat/code/work + bound_preset）
 *   preset_changed     — 预设切换（per-chat 或全局）
 *   runtime_params_changed — 运行参数变更
 *   subModeSwitched    — 子模式切换（T10，字段在 event 顶层 subModeSwitch 而非 payload）
 *
 * 【跨客户端同步】（2 种）
 *   peer_active_chat   — 本用户另一端开始生成 → 跟随到该 chat
 *   cross_mode_task_update — 跨 chatId 模式事件（work/code report 完成/needHelp）
 *
 * 【任务 & 组】（2 种）
 *   task_update        — 任务清单变更（AI taskPlan/taskCheck 或用户手勾）
 *   group_runtime_update — 并行组运行态变更（P0.3，payload 仅 {username}，消费方需重拉组注册表）
 *
 * 【会话配置变更（他端操作）】（6 种，统一为 onChatConfigChanged）
 *   char_added / char_removed / plugin_added / plugin_removed / persona_set / world_set
 *
 * 【消息结构变更（他端操作）】（3 种，统一为 onMessageStructChanged）
 *   messages_range_deleted / messages_hidden / timeline_info
 *
 * 【通知型（错误/熔断）】（3 种，统一为 onServerNotice）
 *   auto_continue_fuse / bot_error / group_worker_degraded
 *
 * 【心跳】（1 种）
 *   pong               — 应用层心跳回应（H3），更新 _lastPongAt 供僵连接检测
 *
 * ═══ 通道B WS 消息类型（ensureNotifyWs，共 3 种）═══
 *   chat-list-changed  — 跨客户端会话列表变更 → onChatListChanged
 *   char-data-changed  — 跨客户端角色卡变更 → onCharDataChanged
 *   part-installed     — 新装角色/人设 → onChatConfigChanged
 *
 * ═══ 心跳 & 重连（H2/H3）═══
 *   H3 应用层心跳：每 30s 发 {type:"ping"}，超 75s 无 pong 判僵连接 → 主动 close → onclose 触发重连
 *   H2 增量补拉：重连后按本地 last index 只拉缺失区间，避免全量 resync
 *   通道B 断线：5s 后自动重连（除非已 dispose）
 */
import { randomUUID } from "node:crypto"; // 0719 幂等契约：逻辑发送级 client_msg_id
import * as vscode from "vscode";
import WebSocket from "ws";
import type {
  CharacterDetails,
  ChatInitialData,
  ChatLogEntry,
  ChatSummary,
  PresetConfigData,
  StreamSlice,
} from "../types";
import type { AuthService } from "./AuthService";
import type { ConnectionService } from "./ConnectionService";
import { API_TIMEOUT_MS, PLUGIN_API_TIMEOUT_MS, BULK_OP_TIMEOUT_MS, WS_RECONNECT_DELAY_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, NOTIFY_RECONNECT_DELAY_MS, DEFAULT_MODE } from "../constants"; // T003 默认模式单源

export class ChatService {
  // ── 依赖 ──────────────────────────────────────────
  private _connectionService: ConnectionService;
  private _authService: AuthService;

  // ── WS 连接 ────────────────────────────────────────
  private _chatWs: WebSocket | null = null;
  private _currentChatId: string | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_DELAY = WS_RECONNECT_DELAY_MS;

  // ── H3: WS 聊天流应用层心跳（检测半开 TCP 僵连接，收不到 pong 主动重连）──
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _lastPongAt = 0;
  // H2: 区分首连 vs 重连——首连由 onChatConnected 触发完整 initial-data；
  //   重连按本地 last index 增量补拉断线期漏掉的消息（避免断线消息永久丢）。
  private _everConnected = false;
  private static readonly HEARTBEAT_INTERVAL = HEARTBEAT_INTERVAL_MS;
  // 连续 2 个心跳周期无 pong 判僵连接 → 主动 close 触发重连
  private static readonly HEARTBEAT_TIMEOUT = HEARTBEAT_TIMEOUT_MS;

  // ── 消息事件（EventEmitter 集合，与头注释 WS 消息类型索引对应）───
  private _onMessageAdded = new vscode.EventEmitter<ChatLogEntry>();
  private _onMessageReplaced = new vscode.EventEmitter<{
    index: number;
    entry: ChatLogEntry;
  }>();
  private _onMessageDeleted = new vscode.EventEmitter<{ index: number }>();
  private _onMessageEdited = new vscode.EventEmitter<{
    index: number;
    entry: ChatLogEntry;
  }>();

  // ── 流式事件 ───────────────────────────────────────
  private _onStreamStart = new vscode.EventEmitter<{ messageId: string }>();
  private _onStreamUpdate = new vscode.EventEmitter<{
    messageId: string;
    slices: StreamSlice[];
  }>();

  // ── 状态事件 ───────────────────────────────────────
  private _onTypingStatus = new vscode.EventEmitter<{
    typingList: string[];
  }>();
  private _onToolResultsReady = new vscode.EventEmitter<{ count: number; source: string }>();
  private _onTokenUsage = new vscode.EventEmitter<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>();
  private _onCloneStatus = new vscode.EventEmitter<{ taskId: number; round: number; status: string; detail: string; timestamp: string }>();
  private _onPendingApprovals = new vscode.EventEmitter<{ count: number }>();
  private _onModeChanged = new vscode.EventEmitter<{ mode: string; bound_preset?: string }>();
  private _onPresetChanged = new vscode.EventEmitter<{ preset: string }>();
  private _onRuntimeParamsChanged = new vscode.EventEmitter<{ params: Record<string, unknown> }>();
  // T10: 子模式双端同步 WS 推送（替代 4s 轮询）
  private _onSubModeSwitched = new vscode.EventEmitter<{ from?: string; to: string; label?: string; chatid?: string }>();
  // 同步断链修复（2026-07-10）：子模式配置内容变更广播（后端 saveSubModes 落盘后发），
  //   消费方（YonBanProvider）转发 webview 触发重拉 getSubModes——修"本体改配置 YonBan 到重开面板才知道"
  private _onSubModesConfigChanged = new vscode.EventEmitter<void>();
  // 跨客户端「当前对话」同步：后端 broadcastUserActiveChat 在本用户某客户端生成开始时推送，
  // 另一端据此跟随到该 chat（修「本体生成、YonBan 停在别对话故看不到」）。
  private _onPeerActiveChat = new vscode.EventEmitter<{ chatid: string }>();
  // F3/Y2: 任务打勾清单推送（后端 broadcastChatEvent task_update，与本体任务卡同款语义）
  private _onTaskUpdate = new vscode.EventEmitter<{ chatid?: string; tasks: Array<Record<string, unknown>>; rev: number; remaining?: number }>();
  // P0.3: 组运行态推送（后端 groupRegistry._notifyRuntimeUpdate → broadcastAllChatUi({type:"group_runtime_update", payload:{username}})，
  //   本体网页已消费、YonBan 此前落 default 丢弃 → 组运行态条只能靠 15s 轮询。接此事件后推送即刷新（payload 只带 username，
  //   不含 groups 列表，故消费方收到后需重新拉组注册表，与既有 onGroupUpdated 同链），轮询降级兜底。
  private _onGroupRuntimeUpdate = new vscode.EventEmitter<{ username?: string; activeLines?: string[] }>();
  // chatId + isReconnect：首连=完整 resync，重连=增量补拉（H2）
  private _onChatConnected = new vscode.EventEmitter<{ chatId: string; isReconnect: boolean }>();
  private _onChatDisconnected = new vscode.EventEmitter<void>();
  // 通道B（/ws/notify）用户级事件：跨客户端会话列表/角色卡变更同步（本体 sendEventToUser）
  private _onChatListChanged = new vscode.EventEmitter<{ chatid?: string; deleted?: string[]; renamed?: boolean }>();
  private _onCharDataChanged = new vscode.EventEmitter<{ charName?: string }>();
  // 跨 chatId 模式事件（work/code 独立 chatId 产出 report 完成/needHelp/审批 → broadcastCrossChatEvent）
  private _onCrossModeTaskUpdate = new vscode.EventEmitter<{ sourceChatId?: string; subtype?: string; notification?: unknown; payload?: unknown }>();
  // 当前会话配置变更（他端 加/删角色·插件 / 设人设 / 设世界书 → chatOps broadcastChatEvent）
  private _onChatConfigChanged = new vscode.EventEmitter<{ kind: string; payload?: unknown }>();
  // #4 消息结构变更（他端 删一段 / 隐藏消息 / 时间线变更 → chatOps broadcastChatEvent）
  private _onMessageStructChanged = new vscode.EventEmitter<{ kind: string; payload?: unknown }>();
  // #5 通知型事件（自动继续熔断 generation.mjs / bot 错误 botErrorBroadcast → 提示用户）
  private _onServerNotice = new vscode.EventEmitter<{ kind: string; payload?: unknown }>();
  private _notifyWs: WebSocket | null = null;
  private _notifyDisposed = false;

  // ── 公开事件 ───────────────────────────────────────
  readonly onMessageAdded = this._onMessageAdded.event;
  readonly onMessageReplaced = this._onMessageReplaced.event;
  readonly onMessageDeleted = this._onMessageDeleted.event;
  readonly onMessageEdited = this._onMessageEdited.event;
  readonly onStreamStart = this._onStreamStart.event;
  readonly onStreamUpdate = this._onStreamUpdate.event;
  readonly onTypingStatus = this._onTypingStatus.event;
  readonly onToolResultsReady = this._onToolResultsReady.event;
  readonly onTokenUsage = this._onTokenUsage.event;
  readonly onCloneStatus = this._onCloneStatus.event;
  readonly onPendingApprovals = this._onPendingApprovals.event;
  readonly onModeChanged = this._onModeChanged.event;
  readonly onPresetChanged = this._onPresetChanged.event;
  readonly onRuntimeParamsChanged = this._onRuntimeParamsChanged.event;
  readonly onSubModeSwitched = this._onSubModeSwitched.event;
  readonly onSubModesConfigChanged = this._onSubModesConfigChanged.event;
  readonly onPeerActiveChat = this._onPeerActiveChat.event;
  readonly onTaskUpdate = this._onTaskUpdate.event;
  readonly onGroupRuntimeUpdate = this._onGroupRuntimeUpdate.event;
  readonly onChatConnected = this._onChatConnected.event;
  readonly onChatDisconnected = this._onChatDisconnected.event;
  readonly onChatListChanged = this._onChatListChanged.event;
  readonly onCharDataChanged = this._onCharDataChanged.event;
  readonly onCrossModeTaskUpdate = this._onCrossModeTaskUpdate.event;
  readonly onChatConfigChanged = this._onChatConfigChanged.event;
  readonly onMessageStructChanged = this._onMessageStructChanged.event;
  readonly onServerNotice = this._onServerNotice.event;

  constructor(connectionService: ConnectionService, authService: AuthService) {
    this._connectionService = connectionService;
    this._authService = authService;
  }

  /** 当前连接的聊天 ID */
  get currentChatId(): string | null {
    return this._currentChatId;
  }

  /** 聊天 WS 是否已连接 */
  get isChatConnected(): boolean {
    return this._chatWs?.readyState === WebSocket.OPEN;
  }

  // =================================================================
  // REST API 封装
  // 基础路径：{serverUrl}/api/parts/shells:chat/{endpoint}
  // 统一经 _fetchWithAuth → AuthService.fetchWithAuth（401-refresh-retry）
  // =================================================================

  /**
   * H1 框架级统一认证 fetch 封装（单一 401-refresh-retry choke point）。
   *
   * 所有走后端 API 的请求统一经此，避免「401 自愈逻辑只在 _callApi 有」的覆盖缺口
   * （此前 _callPluginApi + getCharacterList/getApiSourceList/switchApiSource 等裸 fetch 无重试）。
   * 行为：① 正常发请求；② 收 401 → refreshAccessToken（refreshToken 失败回退账密重登）→ 自动带新 Cookie 重试一次；
   *       ③ 重试仍非 401 即返回（成功或业务错由调用方判 resp.ok）。
   *
   * 注意：getHeaders() 每次重新读取（refresh 会更新 _cookies），故重试前必须重新 spread headers。
   * Content-Type 由调用方在 extraHeaders 决定（GET 类裸 fetch 不带；POST/PUT 带 JSON）。
   */
  private async _fetchWithAuth(
    url: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number; jsonBody?: boolean } = {},
  ): Promise<Response> {
    // 单一权威下沉到 AuthService.fetchWithAuth（401-refresh-retry 逻辑两侧共用，YonBanProvider 也走它）。
    return this._authService.fetchWithAuth(this._connectionService.state.serverUrl, url, opts);
  }

  /**
   * 内部 HTTP 调用辅助。
   * 基础路径：`{serverUrl}/api/parts/shells:chat/`
   */
  private async _callApi<T>(
    endpoint: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> {
    const serverUrl = this._connectionService.state.serverUrl;
    const url = `${serverUrl}/api/parts/shells:chat/${endpoint}`;

    // H1: 统一走 _fetchWithAuth（含 401-refresh-retry），不再各处自带重试分支
    const resp = await this._fetchWithAuth(url, {
      method,
      body,
      timeoutMs: API_TIMEOUT_MS,
      jsonBody: true,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(
        `[ChatService] API ${method} ${endpoint} → ${resp.status}: ${errBody}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  /** 获取聊天列表 */
  async getChatList(): Promise<ChatSummary[]> {
    return this._callApi<ChatSummary[]>("getchatlist");
  }

  /** 新建聊天，返回 chatid */
  async createNewChat(): Promise<string> {
    const data = await this._callApi<{ chatid: string }>("new", "POST", {});
    return data.chatid;
  }

  /** 获取聊天初始数据（最近20条消息 + 角色/插件信息） */
  async getInitialData(chatId: string): Promise<ChatInitialData> {
    return this._callApi<ChatInitialData>(`${chatId}/initial-data`);
  }

  /** 发送用户消息（支持图片附件） */
  async sendMessage(
    chatId: string,
    reply: string,
    autoReply: boolean = true,
    files: unknown[] = [],
  ): Promise<ChatLogEntry> {
    // 后端 BuildChatLogEntryFromUserMessage 读取 result.content + files
    // ★ 前端图片用 { name, type, data: "data:image/...;base64,..." }
    //   后端期望 { name, type, buffer: "<纯base64>" }
    const normalizedFiles = files.map((f: any) => {
      if (f && f.data && !f.buffer) {
        const base64 = typeof f.data === "string" && f.data.includes(",")
          ? f.data.split(",")[1]
          : f.data;
        const result = { name: f.name as string, mime_type: (f.type || f.mime_type) as string, buffer: base64 as string };
        // magic bytes 检测真实格式，修正 mime_type 和文件名后缀
        try {
          const head = Buffer.from(base64.substring(0, 24), "base64");
          let det: { mime: string; ext: string } | null = null;
          if (head[0]===0xFF && head[1]===0xD8 && head[2]===0xFF) det = { mime:"image/jpeg", ext:"jpg" };
          else if (head[0]===0x89 && head[1]===0x50 && head[2]===0x4E && head[3]===0x47) det = { mime:"image/png", ext:"png" };
          else if (head[0]===0x47 && head[1]===0x49 && head[2]===0x46 && head[3]===0x38) det = { mime:"image/gif", ext:"gif" };
          else if (head.length>=12 && head[0]===0x52 && head[1]===0x49 && head[2]===0x46 && head[3]===0x46 && head[8]===0x57 && head[9]===0x45 && head[10]===0x42 && head[11]===0x50) det = { mime:"image/webp", ext:"webp" };
          if (det) {
            result.mime_type = det.mime;
            if (result.name) {
              const dot = result.name.lastIndexOf(".");
              if (dot > 0) result.name = result.name.substring(0, dot + 1) + det.ext;
            }
          }
        } catch { /* 检测失败保持原样 */ }
        return result;
      }
      return f;
    });
    const replyObject = {
      content: reply,
      files: normalizedFiles,
    };
    // [0719 幂等契约·双发根治第二层] client_msg_id=本次逻辑发送（一次点击）的幂等键：
    //   fetchWithAuth 的 401 重放/连接重试携带同一 body=同一 id → 后端幂等窗命中不重写不重触发
    //   （盘上实证同 md5 消息落 4 条的根治收口；第一层=超时不重试非幂等，AuthService）。
    const data = await this._callApi<{ entry: ChatLogEntry }>(
      `${chatId}/message`,
      "POST",
      { reply: replyObject, autoReply, client_msg_id: randomUUID() },
    );
    return data.entry;
  }

  /** 触发 AI 回复 */
  async triggerReply(chatId: string, charname?: string): Promise<void> {
    await this._callApi(`${chatId}/trigger-reply`, "POST", { charname });
  }

  /** 编辑消息 */
  async editMessage(
    chatId: string,
    index: number,
    content: string,
  ): Promise<void> {
    // ★ A3 修复：后端 editMessage → BuildChatLogEntryFromUserMessage/CharReply
    // 期望 content 是对象 { content: string, files?: [] }，不是裸字符串。
    // 后端 endpoints.mjs 从 req.body.content 取值后直接传给 chatOps.editMessage，
    // 而 messageBuilder 通过 result.content 读取文本内容。
    await this._callApi(`${chatId}/message/${index}`, "PUT", {
      content: { content },
    });
  }

  /** 删除消息 */
  async deleteMessage(chatId: string, index: number): Promise<void> {
    await this._callApi(`${chatId}/message/${index}`, "DELETE");
  }

  /**
   * ★ A4 回档：删除指定索引之后的所有消息（保留 targetIndex 及之前的消息）
   * 后端 API：POST /api/parts/shells:chat/{chatId}/messages/delete-range
   * Body: { startIndex: number, endIndex?: number }
   */
  async rollbackToMessage(
    chatId: string,
    targetIndex: number,
  ): Promise<{ deleted: number }> {
    return this._callApi<{ deleted: number }>(
      `${chatId}/messages/delete-range`,
      "POST",
      { startIndex: targetIndex + 1 },
    );
  }

  /**
   * ★ A4 记忆回档：通知 beilu-memory 插件回退表格快照
   * POST /api/parts/plugins:beilu-memory/config/setdata
   * Body: { _action: "rollbackMemoryToMessage", chatId, targetIndex }
   */
  async rollbackMemory(
    chatId: string,
    targetIndex: number,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "rollbackMemoryToMessage", chatId, targetIndex },
    );
  }

  /**
   * ★ P3 回档预览（只读）：回档到 targetIndex 前查文件层会还原/删哪些文件。
   * 复用 beilu-memory 的 getRollbackPreview 动作（setDataActions.mjs），纯查询不改状态。
   * 注意：该后端 action 原名 getCheckpointDiff，因与 checkpoint 面板按 id 查 diff 的同名 case 撞 label
   * 已改名 getRollbackPreview（本调用方曾被漏改，会命中 id 版报"缺少 id"，已修）。
   * 返回 { success, ideConnected, checkpointsToRevert, filesToRestore[], filesToDelete[] }。
   */
  async getRollbackPreview(
    chatId: string,
    targetIndex: number,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getRollbackPreview", chatId, targetIndex },
    );
  }

  // ── 多开实例绑定（2026-07-26 多窗口 YonBan）────────────────────────────

  /**
   * 上报「chatId 由端口 wsPort 的本窗口 IDE 桥接实例服务」。
   * 后端 ideClient 连接池按此绑定把该会话的全部 IDE 工具/检查点/提问路由到本窗口，
   * 多开 VSCode 时各窗口的对话各写各的工作区（原单连接=全部打到最后注册的窗口）。
   * 调用点：Provider switchChat / sendMessage 恢复 / 聊天 WS (重)连接（幂等，重复上报无害）。
   */
  async bindIdeInstance(chatId: string, wsPort: number): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "bindIdeInstance", chatid: chatId, port: wsPort },
    );
  }

  /** 后端 IDE 连接池状态快照 { instances:[{port,kind,connected,primary,workspaceFolders}], bindings:{chatid:port}, primaryPort }。 */
  async getIdeInstances(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getIdeInstances" },
    );
  }

  // ── 以下为壳层中转：后端逻辑全在本体 beilu-memory setDataActions，YonBan 不实现任何后端 ──

  /** 80% 轻量清理：可逆 hide 三类噪声（AI读取/AI操作-YonBan命令/分身），各保留最近 keepLast。 */
  async hideCloneMessages(chatId: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "hideContextNoise", chatid: chatId, types: ["clone"] },
    );
  }

  async hideContextNoise(
    chatId: string,
    keepLast = 2,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "hideContextNoise", chatid: chatId, keepLast },
    );
  }

  /** 单条消息 hide/unhide（可逆 _hidden 掩码，走 shells:chat 端点）。 */
  async hideMessage(chatId: string, index: number, hide: boolean): Promise<{ hidden: number }> {
    return this._callApi<{ hidden: number }>(
      `${chatId}/messages/hide`,
      "POST",
      { indices: [index], hide },
    );
  }

  /** 更新思维链标签配置（内置开关 + 自定义标签对）。
   * T027 写路收口：原两次 beilu-memory#updateConfig 是旧门面（读 hide/写 memory 分裂，
   * 写后不清 hide _userTagsCache → 30s TTL 内出站剥离仍旧值）。改走桥 dispatch
   * functions:hide#setReasoningTags 写单点（本体 stripThinking.mjs:112，写后同步清缓存立即生效），
   * 与 web 端 extendMenuW28/tokenProgressBar 同一收口。语义不变：tags 整体替换 + builtin 浅合并。 */
  async updateReasoningConfig(
    builtin: { think?: boolean; thinking?: boolean },
    tags: Array<{ open: string; close: string }>,
  ): Promise<Record<string, unknown>> {
    const serverUrl = this._connectionService.state.serverUrl;
    const resp = await this._fetchWithAuth(`${serverUrl}/api/yonban/dispatch`, {
      method: "POST",
      body: {
        verb: "setReasoningTags",
        target: "functions:hide",
        payload: { reasoning_tags: tags, reasoning_builtin: builtin },
      },
      timeoutMs: PLUGIN_API_TIMEOUT_MS,
      jsonBody: true,
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`[ChatService] setReasoningTags → ${resp.status}: ${errBody}`);
    }
    const r = (await resp.json()) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; msg?: string } };
    if (r?.ok === false) throw new Error(`${r.error?.code ?? "E"}: ${r.error?.msg ?? "setReasoningTags dispatch 失败"}`);
    return { success: true, results: [r?.data ?? {}] };
  }

  /** skill 组库：列出所有流程组（首访种子大型项目/小型项目）。 */
  async listFlowGroups(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "listFlowGroups" },
    );
  }

  /** 启动 skill 组流水线（按 filename，切到第一个子模式）。 */
  async startFlowGroup(filename: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "startFlowGroup", filename },
    );
  }

  /** 删除自建 skill 组（内置组后端拒删）。 */
  async deleteFlowGroup(filename: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "deleteFlowGroup", filename },
    );
  }

  /** 新建/保存用户自建 skill 组（builtin:false）。 */
  async saveFlowGroup(
    name: string,
    steps: Array<Record<string, unknown>>,
    autoAdvance = true,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "saveFlowGroup", name, steps, auto_advance: autoAdvance },
    );
  }

  /** 更新 skill 组（重命名等）。 */
  async updateFlowGroup(filename: string, update: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "updateFlowGroup", filename, update },
    );
  }

  /** v4 §4: 列出所有并行组。 */
  async listGroups(): Promise<Record<string, unknown>> {
    return this._callApi<Record<string, unknown>>("groups");
  }

  /** v4 §4: 组管理操作（create/delete/setRole/clearRole）。 */
  async groupAction(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (action) {
      case "create":
        return this._callApi<Record<string, unknown>>("groups", "POST", body);
      case "delete":
        return this._callApi<Record<string, unknown>>(`groups/${encodeURIComponent(String(body.groupId || ""))}`, "DELETE");
      case "setRole":
        return this._callApi<Record<string, unknown>>(`groups/${encodeURIComponent(String(body.groupId || ""))}/role`, "POST", body);
      case "clearRole":
        return this._callApi<Record<string, unknown>>(`groups/${encodeURIComponent(String(body.groupId || ""))}/role/${encodeURIComponent(String(body.role || ""))}`, "DELETE");
      case "getEngine":
        return this._callApi<Record<string, unknown>>("groups/engine", "GET");
      case "setEngine":
        return this._callApi<Record<string, unknown>>("groups/engine", "POST", { enabled: body.enabled });
      case "executeGroup":
        return this._callApi<Record<string, unknown>>(`groups/${encodeURIComponent(String(body.groupId || ""))}/execute`, "POST", {});
      case "addParallelSubMode":
        return this._callPluginApi<Record<string, unknown>>("beilu-memory", "config/setdata", "POST", { _action: "addParallelSubMode", id: body.id });
      case "removeParallelSubMode":
        return this._callPluginApi<Record<string, unknown>>("beilu-memory", "config/setdata", "POST", { _action: "removeParallelSubMode", id: body.id });
      default:
        throw new Error(`未知组操作: ${action}`);
    }
  }

  /** checkpoint 列表（YonBan FileCheckpoint 快照）。多开：带当前会话 → 后端路由到本会话所绑窗口。 */
  async listCheckpoints(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getCheckpointList", ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    );
  }

  /** 某 checkpoint 的逐行 diff（按 id）。多开：带当前会话路由。 */
  async getCheckpointFileDiff(id: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getCheckpointDiff", id, ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    );
  }

  /** 回档单个 checkpoint（仅文件层，不删对话/表格）。多开：带当前会话路由。 */
  async revertCheckpoint(id: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "revertCheckpoint", id, ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    );
  }

  // ── B3/Y6 权限档位外显（壳层中转，档位落本体 permission_level.json，L0-L4=规则集模板）──

  /** 当前用户权限档位。返回 { success, level: 0-4 }。 */
  async getPermissionLevel(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getPermissionLevel" },
    );
  }

  // ── F6/Y5 审批跳过规则管理（壳层中转，规则落本体 data/users/<u>/ide_approval_rules.json）──

  /** 列出「此类不再问」规则。返回 { success, rules:[{tool,pathPrefix,createdAt}] }。 */
  async getApprovalRules(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getApprovalRules" },
    );
  }

  /** 删除一条规则（按 tool+pathPrefix 精确匹配）。返回 { success, removed, rules }。 */
  async removeApprovalRule(tool: string, pathPrefix: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "removeApprovalRule", tool, pathPrefix },
    );
  }

  // ── F3/Y2 任务打勾（壳层中转，单一权威=本体 taskStore work_ctx/tasks.json，chatid 必传 per-chatId 隔离）──

  /** 当前 chatId 的任务清单。返回 { success, tasks, rev, remaining }。 */
  async getTasks(chatId: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getTasks", chatid: chatId },
    );
  }

  /** 全量替换清单（用户重排/批量编辑/手动新增走 append 后全量提交）。 */
  async planTasks(chatId: string, tasks: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "planTasks", chatid: chatId, tasks },
    );
  }

  /** 勾选/改状态某一项（status 默认 completed）。 */
  async checkTask(chatId: string, id: string, status?: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "checkTask", chatid: chatId, id, status },
    );
  }

  /** 编辑单项内容/优先级（不改状态）。 */
  async updateTask(chatId: string, id: string, update: { content?: string; priority?: string }): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "updateTask", chatid: chatId, id, ...update },
    );
  }

  /** 删除单项。 */
  async deleteTask(chatId: string, id: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "deleteTask", chatid: chatId, id },
    );
  }

  /** 获取消息范围 */
  async getChatLog(
    chatId: string,
    start: number,
    end: number,
  ): Promise<ChatLogEntry[]> {
    return this._callApi<ChatLogEntry[]>(
      `${chatId}/log?start=${start}&end=${end}`,
    );
  }

  /** 获取消息总数。本体契约=裸数字 res.json(_len)（endpoints.mjs:1467），不是 {length} 包裹——
   *  旧读法 data.length 恒 undefined，H2 断线增量补拉因此整条失效。 */
  async getChatLogLength(chatId: string): Promise<number> {
    return this._callApi<number>(`${chatId}/log/length`);
  }

  /** 删除聊天 */
  async deleteChat(chatId: string): Promise<void> {
    // ★ A1 修复：后端路由是 DELETE /api/parts/shells:chat/delete，
    // 期望 body 为 { chatids: [chatId, ...] }，不是路径参数。
    await this._callApi("delete", "DELETE", { chatids: [chatId] });
  }

  /** 添加角色到聊天 */
  async addCharacter(chatId: string, charname: string): Promise<void> {
    await this._callApi(`${chatId}/char`, "POST", { charname });
  }

  // =================================================================
  // 角色相关 API（非 shells:chat 前缀，使用独立路径）
  // =================================================================

  /** 获取所有角色名列表 — GET /api/getlist/chars */
  async getCharacterList(): Promise<string[]> {
    const serverUrl = this._connectionService.state.serverUrl;
    const url = `${serverUrl}/api/getlist/chars`;
    // H1: 统一走 _fetchWithAuth（补 401-refresh-retry）
    const resp = await this._fetchWithAuth(url, { method: "GET", timeoutMs: API_TIMEOUT_MS });
    if (!resp.ok) {
      throw new Error(`[ChatService] GET /api/getlist/chars → ${resp.status}`);
    }
    return resp.json() as Promise<string[]>;
  }

  /** 获取指定角色详情 — GET /api/getdetails/chars/{charName} */
  async getCharacterDetails(charName: string): Promise<CharacterDetails> {
    const serverUrl = this._connectionService.state.serverUrl;
    const url = `${serverUrl}/api/getdetails/chars/${encodeURIComponent(charName)}`;
    // H1: 统一走 _fetchWithAuth（补 401-refresh-retry）
    const resp = await this._fetchWithAuth(url, { method: "GET", timeoutMs: API_TIMEOUT_MS });
    if (!resp.ok) {
      throw new Error(
        `[ChatService] GET character details for "${charName}" → ${resp.status}`,
      );
    }
    return resp.json() as Promise<CharacterDetails>;
  }

  /** 获取角色头像 URL（不做请求，仅构造路径） */
  getCharacterAvatarUrl(charName: string): string {
    const serverUrl = this._connectionService.state.serverUrl;
    return `${serverUrl}/parts/chars:${encodeURIComponent(charName)}/image.png`;
  }

  // =================================================================
  // 预设/模式管理 API（Phase 3D）
  // =================================================================

  /**
   * 通用插件 API 调用辅助（壳层中转模式的单一入口）。
   * 基础路径：{serverUrl}/api/parts/plugins:{pluginName}/{endpoint}
   * 本服务中大量方法（记忆/预设/审批/任务/分身/子模式等）都走此方法，
   * body 中的 _action 字段由本体 beilu-memory setDataActions.mjs 路由。
   */
  private async _callPluginApi<T>(
    pluginName: string,
    endpoint: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> {
    const serverUrl = this._connectionService.state.serverUrl;
    const url = `${serverUrl}/api/parts/plugins:${pluginName}/${endpoint}`;
    // H1: 统一走 _fetchWithAuth（补齐 401-refresh-retry，原裸 fetch 缺）
    const resp = await this._fetchWithAuth(url, {
      method,
      body,
      timeoutMs: PLUGIN_API_TIMEOUT_MS,
      jsonBody: true,
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(
        `[ChatService] Plugin ${pluginName}/${endpoint} → ${resp.status}: ${errBody}`,
      );
    }
    return resp.json() as Promise<T>;
  }

  /** 获取预设配置数据 */
  async getPresetConfig(): Promise<PresetConfigData> {
    return this._callPluginApi<PresetConfigData>(
      "beilu-preset",
      "config/getdata",
    );
  }

  /** 获取 display regex 规则（beilu-regex 插件） */
  async getRegexConfig(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-regex",
      "config/getdata",
    );
  }

  /**
   * 获取思维链标签列表（从 beilu-memory 配置计算）
   * 复现本体 tokenProgressBar.mjs T03 桥接逻辑：
   *   reasoning_builtin.thinking/think → 启用时加入
   *   reasoning_tags[].open → 提取标签名
   * @returns {Promise<string[]>} 标签名数组，如 ["thinking", "think"]
   */
  async getThinkingTags(): Promise<string[]> {
    const data = await this.getMemoryConfig();
    const config = (data as Record<string, unknown>)?.config as Record<string, unknown> | undefined;
    if (!config) return ["thinking", "think"];

    const builtin = config.reasoning_builtin as Record<string, boolean> | undefined;
    const reasoningTags = config.reasoning_tags as Array<{ open?: string }> | undefined;

    const builtinNames: string[] = [];
    // 缺省=启用（向后兼容，与本体 tokenProgressBar.mjs:1816-1817 一致）
    if (builtin?.thinking !== false) builtinNames.push("thinking");
    if (builtin?.think !== false) builtinNames.push("think");

    const customNames: string[] = [];
    if (Array.isArray(reasoningTags)) {
      for (const t of reasoningTags) {
        const name = (t.open || "").replace(/[<>/\s]/g, "");
        if (/^[\w-]+$/.test(name)) customNames.push(name);
      }
    }

    // 去重合并
    return [...new Set([...builtinNames, ...customNames])];
  }

  /** 切换预设（per-chatId：带当前对话 ID，只写本窗口映射不污染其他窗口） */
  async switchPreset(presetName: string): Promise<void> {
    // ★ G2 修复：后端期望 switch_preset 是对象 { name: string }，不是裸字符串
    await this._callPluginApi("beilu-preset", "config/setdata", "POST", {
      switch_preset: { name: presetName, ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    });
  }

  /**
   * 获取当前激活模式（per-character）。
   *
   * ★ D1 修复（stale 源）：原走 config/getdata 不带任何 char 字段 → 后端 getDataHandler
   *   `charName = args?.char_id || args?.charName || "_global"`（getDataHandler.mjs:33）回退 _global，
   *   读到的是全局模式而非当前角色的 per-character 模式（某角色=code、_global=chat 时 YonBan 误显 chat）。
   *   改走本体同款专用 action getMode（featureControls.mjs:606 / setDataActions.mjs:584-588），
   *   传 charName（per-character 单一权威）+ chat_id（N38 对话线绑定，未绑定回退 char 级）。
   *   getMode 返回 { success, mode }。charName 缺省时后端仍回退 _global（行为同旧，零回归）。
   */
  async getActiveMode(charName?: string): Promise<string> {
    const data = await this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      {
        _action: "getMode",
        ...(charName ? { charName } : {}),
        ...(this._currentChatId ? { chat_id: this._currentChatId } : {}),
      },
    );
    return (data.mode as string) || DEFAULT_MODE; // T003：旧缺省"chat"与初始默认(code)不一致=静默漂移
  }

  /** 切换模式（chat/code/work），并联动切换该模式绑定的预设（与本体 featureControls 一致） */
  async setActiveMode(mode: string): Promise<void> {
    // 0715 守卫归位（凛倾「使用提示词查看器之后会变成另外的预设」根因族）：
    //   预设生效模型（凛倾0708）：绑定=进入模式时刻的一次性默认初始值，仅该对话该模式无「正在使用」
    //   记录才应用（后端 switchMode hasChatModePreset 守卫，setDataActions:803）。
    //   旧 D2 补发块=孤儿补丁：它模仿的本体二段补发已被 T040b 拆除（featureControls:867 注释），
    //   且无条件 switch_preset 把后端守卫整个打穿——sendMessage/triggerReply/switchChat 每次
    //   都强切回绑定默认，覆盖用户手选预设。
    //   框架级修：带上 chatid 让后端守卫式初始化自己生效（无 chatid 时 _swCid="" 守卫分支永不走
    //   =D2 当年误判"后端只返回不应用"的根源），补发块删除，裁决单点=后端 switchMode。
    await this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "switchMode", mode, ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    );
  }

  // =================================================================
  // Token 快照 + 压缩 API（Phase 3D 纠正版）
  // =================================================================

  /**
   * 获取 Token 快照。
   * ★ 不刷新修复：原读 beilu-preset prompt-snapshot=进程级全局 lastPromptSnapshot，只在生成时被动更新、
   *   非 per-chat → 没生成=available:false(永远 —/—)，生成后也不随轮询刷新。改用本体同款「主动 per-chat」
   *   端点 fake-send：每次实算当前对话 estimated_tokens，映射成 onTokenSnapshot 期望的 {available,snapshot}。
   */
  async getTokenSnapshot(): Promise<Record<string, unknown>> {
    const chatId = this.currentChatId;
    if (!chatId) return { available: false };
    try {
      const resp = await this._callApi<Record<string, any>>(`${chatId}/fake-send`);
      const meta = (resp && resp._meta) || {};
      return {
        available: true,
        snapshot: {
          estimated_tokens: meta.estimated_tokens || 0,
          model_params: {
            max_context: meta.max_context || 0,
            max_tokens: resp?.max_tokens,
          },
        },
      };
    } catch {
      return { available: false };
    }
  }

  /** 清除注入缓存（clearInjections）：按勾分清 P1/搜索/工具结果，对齐本体 */
  async clearInjections(opts?: { clearP1?: boolean; clearWeb?: boolean; clearTool?: boolean; clearSummary?: boolean; chatId?: string }): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      {
        _action: "clearInjections",
        clearP1: opts?.clearP1,
        clearWeb: opts?.clearWeb,
        clearTool: opts?.clearTool,
        clearSummary: opts?.clearSummary,
        chatid: opts?.chatId,
      },
    );
  }

  /** 全量压缩（AI 生成摘要 + 删除旧消息） */
  async compactContext(
    chatHistory: string,
    messageCount: number,
    keepLastN: number,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "compactContext", chatHistory, messageCount, keepLastN },
    );
  }

  /** 清理消息中的 XML 操作标签 */
  async cleanXmlTags(chatId: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "cleanXmlTags", chatid: chatId },
    );
  }

  /** 获取文件读取缓存清单（从chatLog扫描） */
  async getReadCache(chatId?: string): Promise<Array<Record<string, unknown>>> {
    const data = await this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getReadCacheFromChat", chatid: chatId || this.currentChatId || "" },
    );
    return (data as any)?.entries || [];
  }

  /** 清理指定文件读取缓存 */
  async cleanReadCache(paths: string[], chatId?: string, chatLogIndices?: number[]): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "cleanReadCache", paths, chatLogIndices, chatid: chatId },
    );
  }

  /** 智能清理对话（保留文件读取+最近N条） */
  async smartCleanChat(chatId: string, keepRecent: number = 10, keepIndices?: number[]): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "smartCleanChat", chatid: chatId, keepRecent, keepIndices },
    );
  }

  /** 注入摘要系统消息（全量清理第三步，对齐本体 injectSummaryMessage） */
  async injectSummaryMessage(chatId: string, summary: string, meta?: { hiddenCount?: number; originalChars?: number; summaryChars?: number }): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "injectSummaryMessage", chatid: chatId, summary, hiddenCount: meta?.hiddenCount, originalChars: meta?.originalChars, summaryChars: meta?.summaryChars },
    );
  }

  /** 删除指定范围的聊天消息 */
  async deleteMessageRange(
    chatId: string,
    startIndex: number,
    endIndex: number,
  ): Promise<void> {
    const serverUrl = this._connectionService.state.serverUrl;
    // H1: 统一走 _fetchWithAuth（补 401-refresh-retry）
    const resp = await this._fetchWithAuth(
      `${serverUrl}/api/parts/shells:chat/${chatId}/messages/delete-range`,
      {
        method: "POST",
        body: { startIndex, endIndex },
        timeoutMs: BULK_OP_TIMEOUT_MS,
        jsonBody: true,
      },
    );
    if (!resp.ok) throw new Error(`deleteMessageRange failed: ${resp.status}`);
  }

  /** 获取指定 API 源的配置（含 model/url/apikey） */
  async getApiSourceConfig(
    sourceName: string,
  ): Promise<Record<string, unknown>> {
    const serverUrl = this._connectionService.state.serverUrl;
    const url = `${serverUrl}/api/parts/shells:serviceSourceManage/AI/${encodeURIComponent(sourceName)}`;
    // H1: 统一走 _fetchWithAuth（补 401-refresh-retry）
    const resp = await this._fetchWithAuth(url, { method: "GET", timeoutMs: PLUGIN_API_TIMEOUT_MS });
    if (!resp.ok) {
      throw new Error(`[ChatService] GET API source config → ${resp.status}`);
    }
    return resp.json() as Promise<Record<string, unknown>>;
  }

  /** 切换当前模型 */
  async switchModel(modelName: string): Promise<void> {
    await this._callPluginApi("beilu-preset", "config/setdata", "POST", {
      update_model_params: { model: modelName },
    });
  }

  /** 通过后端代理获取模型列表 */
  async getModelList(apiConfig: {
    url: string;
    key: string;
  }): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getModels", apiConfig },
    );
  }

  /** D3: 直接按源名取模型列表 —— 后端 getModels 自己读源配置（嵌套 config），
   *  比前端取 config 再解析 url/key 更稳（前端解析顶层 vs 嵌套正是模型列表加载失败的根源）。 */
  async getModelListBySource(sourceName: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getModels", sourceName },
    );
  }

  // =================================================================
  // Phase 3E: 记忆预设配置 + P1/P8 状态 API
  // =================================================================

  /**
   * 获取记忆配置数据（含 memory_presets / injection_prompts / web_search 等）
   * GET /api/parts/plugins:beilu-memory/config/getdata
   */
  async getMemoryConfig(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/getdata",
    );
  }

  /**
   * 联网搜索开关写侧（0714 读写同源修）：真源 = beilu-memory per-char _config.json 的 web_search 段
   * （updateConfig 白名单 setDataActions:2333），与本体前端联网设置悬浮窗同一写口。
   * 原 webview 走 setFilesConfig 把 {web_search} 塞 beilu-files——该插件 SetData 白名单无此字段
   * = 写入即静默丢弃，刷新读回 undefined → 开关回落关闭（双键分叉病）。读侧 = getMemoryConfig().config.web_search。
   */
  /** 联网搜索读侧（与 setWebSearchEnabled 同 char 解析=读写同源）：带 chatid → 后端解析当前 chat 角色。 */
  async getWebSearchConfig(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getWebSearchConfig", ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    );
  }

  async setWebSearchEnabled(enabled: boolean): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      // chatid：后端 updateConfig 据此解析当前 chat 的 primaryCharName 归位 per-char 配置
      // （不带 char 上下文会回退 _global=死配置，消费端读回复 char 的 _config.json 无 _global 回退）。
      { _action: "updateConfig", web_search: { enabled }, ...(this._currentChatId ? { chatid: this._currentChatId } : {}) },
    );
  }

  /**
   * 切换记忆预设启用状态（P1-P8 的 enabled 开关）
   * POST /api/parts/plugins:beilu-memory/config/setdata { _action: "updateMemoryPreset", presetId, enabled }
   */
  async toggleMemoryPreset(
    presetId: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "updateMemoryPreset", presetId, enabled },
    );
  }

  /**
   * ★ BUG#5 修复：切换注入提示词启用状态（INJ-1/INJ-2/INJ-3 的 enabled 开关）
   * 后端 updateInjectionPrompt handler 在 presetsData.injection_prompts 中查找，
   * 与 updateMemoryPreset（查 presetsData.presets）是两个不同的数据结构。
   * POST /api/parts/plugins:beilu-memory/config/setdata { _action: "updateInjectionPrompt", injectionId, enabled }
   */
  async toggleInjectionPrompt(
    injectionId: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "updateInjectionPrompt", injectionId, enabled },
    );
  }

  /**
   * 轮询记忆 AI 输出队列（P1/P8 运行状态 + 结果）
   * POST /api/parts/plugins:beilu-memory/config/setdata { _action: "getMemoryAIOutput", sinceId }
   */
  async getMemoryAIOutput(sinceId?: number): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      {
        _action: "getMemoryAIOutput",
        sinceId: sinceId ?? null,
      },
    );
  }

  /**
   * 获取诊断快照（P1 运行状态、启用预设列表、注入日志等）
   * POST /api/parts/plugins:beilu-memory/config/setdata { _action: "getDiagSnapshot" }
   */
  async getDiagSnapshot(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getDiagSnapshot" },
    );
  }

  // =================================================================
  // A5: 子模式动态管理 API
  // =================================================================

  /** 获取子模式配置 */
  async getSubModes(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      // [债#8 修 0726] 带上本窗当前对话：后端按 chatId 解析 effective_sub_modes / active_sub_modes_map
      //   （setDataActions getSubModes 分支）。不带的话本端拿到的是「无 chatId 解析」，本线尚无
      //   per-chat 记录时前端回落全局字段，而后端生成实际用的是组起点默认 → 显示≠生效。
      { _action: "getSubModes", ...(this._currentChatId ? { chatId: this._currentChatId } : {}) },
    );
  }

  /** 保存子模式列表 */
  async saveSubModes(subModes: unknown[]): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "saveSubModes", sub_modes: subModes },
    );
  }

  /** 设置当前活跃子模式 */
  async setActiveSubMode(id: string, chatId?: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "setActiveSubMode", id, chatId: chatId || "" },
    );
  }

  /** 获取分身AI配置 */
  async getClones(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getClones" },
    );
  }

  /** [0724 分身可停·002] 停止在跑分身：taskId 缺省(空串)=停该会话全部。后端 cloneAbort 触发
   *  该任务 AbortController，终态 stopped 经 clone_status 广播回流分身进度面板。 */
  async stopCloneTask(chatId: string, taskId?: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "stopCloneTask", chatid: chatId || "", taskId: taskId ?? "" },
    );
  }

  /** 保存分身AI配置 */
  async saveClones(clones: unknown[]): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "saveClones", clones },
    );
  }

  // =================================================================
  // 提示词查看器 API
  // =================================================================

  /** 构建提示词预览（fake-send，不实际发送） */
  async fakeSend(chatId: string): Promise<Record<string, unknown>> {
    return this._callApi<Record<string, unknown>>(`${chatId}/fake-send`);
  }

  // =================================================================
  // IDE 写操作审批 API
  // =================================================================

  /** 获取待审批的 IDE 写操作 */
  async getIdeApprovals(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "getIdeApprovals" },
    );
  }

  /** 批准单个 IDE 写操作 */
  async approveIdeOp(opId: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "approveIdeOp", opId },
    );
  }

  /** 拒绝单个 IDE 写操作 */
  async rejectIdeOp(opId: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "rejectIdeOp", opId },
    );
  }

  /** 批准所有待审批操作 */
  async approveAllIdeOps(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "approveAllIdeOps" },
    );
  }

  /** 拒绝所有待审批操作 */
  async rejectAllIdeOps(): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "rejectAllIdeOps" },
    );
  }

  /** ★ F6「此类不再问」：从 opId 派生 (操作类型,路径前缀) 规则并落 per-user settings */
  async addApprovalSkipRule(opId: string): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "addApprovalSkipRule", opId },
    );
  }

  /** 设置是否需要写操作审批 */
  async setIdeWriteApproval(requireApproval: boolean): Promise<Record<string, unknown>> {
    return this._callPluginApi<Record<string, unknown>>(
      "beilu-memory",
      "config/setdata",
      "POST",
      { _action: "setIdeWriteApproval", requireApproval },
    );
  }

  // =================================================================
  // ★ I4: API 源列表（读取 serviceSourceManage）
  // =================================================================

  /** 获取 AI 服务源列表 */
  async getApiSourceList(): Promise<string[]> {
    const serverUrl = this._connectionService.state.serverUrl;
    const url = `${serverUrl}/api/parts/shells:serviceSourceManage/AI`;
    // H1: 统一走 _fetchWithAuth（补 401-refresh-retry）
    const resp = await this._fetchWithAuth(url, { method: "GET", timeoutMs: PLUGIN_API_TIMEOUT_MS });
    if (!resp.ok) {
      throw new Error(`[ChatService] GET API source list → ${resp.status}`);
    }
    return resp.json() as Promise<string[]>;
  }

  /** 切换当前 API 源（绑定到聊天的所有角色） */
  async switchApiSource(
    sourceName: string,
    charNames: string[],
  ): Promise<void> {
    const serverUrl = this._connectionService.state.serverUrl;
    for (const charName of charNames) {
      // H1: 统一走 _fetchWithAuth（补 401-refresh-retry）
      const resp = await this._fetchWithAuth(
        `${serverUrl}/api/parts/shells:beilu-home/char-aisource/${encodeURIComponent(charName)}`,
        {
          method: "PUT",
          body: { AIsource: sourceName },
          timeoutMs: PLUGIN_API_TIMEOUT_MS,
          jsonBody: true,
        },
      );
      // fail-loud：原实现不判 resp.ok，绑定失败静默——用户以为切了源实际没切。
      // 抛错由 YonBanProvider onDidReceiveMessage 顶层兜底 → operationError toast。
      if (!resp.ok) {
        throw new Error(`[ChatService] 切换 AI 源失败 (${charName} → ${sourceName}): ${resp.status}`);
      }
    }
  }

  // =================================================================
  // WebSocket 聊天通道（通道A：per-chat + 通道B：per-user /ws/notify）
  // =================================================================

  /**
   * 连接到指定聊天的 WS 通道（通道A）。
   * 地址：`ws[s]://{host}/ws/parts/shells:chat/ui/{chatid}`
   *
   * 步骤：
   *   1. 同 chatId 且 OPEN/CONNECTING → 幂等跳过
   *   2. disconnectChat() 清理旧连接
   *   3. ensureNotifyWs() 幂等开通道B
   *   4. new WebSocket → onopen: 标 _everConnected + 启心跳(H3) + fire onChatConnected(首连/重连)
   *                    → onmessage: _handleWsMessage 分发
   *                    → onclose: _handleWsClose 自动重连
   */
  connectChat(chatId: string): void {
    // 已连接到同一聊天则跳过
    if (
      this._currentChatId === chatId &&
      (this._chatWs?.readyState === WebSocket.OPEN ||
       this._chatWs?.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.disconnectChat();
    this._currentChatId = chatId;

    // 通道B（用户级 /ws/notify）：与聊天 WS 独立、跨切聊天常驻，幂等开一次。
    this.ensureNotifyWs();

    const serverUrl = this._connectionService.state.serverUrl;
    const wsUrl =
      serverUrl.replace(/^http/, "ws") + `/ws/parts/shells:chat/ui/${chatId}`;

    console.log(`[ChatService] 连接聊天 WS: ${wsUrl}`);

    this._chatWs = new WebSocket(wsUrl, {
      headers: this._authService.getHeaders(),
    });

    this._chatWs.onopen = () => {
      console.log(`[ChatService] 聊天 WS 已连接: ${chatId}`);
      const isReconnect = this._everConnected;
      this._everConnected = true;
      // H3: 启动应用层心跳（每 30s 发 ping，超 75s 无 pong 判僵连接重连）
      this._lastPongAt = Date.now();
      this._startChatHeartbeat();
      // 首连：Provider 走 _resyncChat（initial-data 窗口）。
      // 重连（isReconnect=true）：Provider 走增量补拉（H2，按本地 last index 调 getChatLog 补断线期漏掉的消息）。
      this._onChatConnected.fire({ chatId, isReconnect });
    };

    this._chatWs.onmessage = (event) => {
      this._handleWsMessage(event);
    };

    this._chatWs.onclose = () => {
      this._handleWsClose();
    };

    this._chatWs.onerror = (err) => {
      console.error("[ChatService] 聊天 WS 错误:", err.message);
    };
  }

  /** 断开当前聊天 WS */
  disconnectChat(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopChatHeartbeat();
    // 主动断开（切 chat / dispose）：重置首连标记，下次 connect 视为首连（走完整 resync）
    this._everConnected = false;

    if (this._chatWs) {
      // 标记主动关闭，避免触发重连
      const ws = this._chatWs;
      this._chatWs = null;
      this._currentChatId = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      this._onChatDisconnected.fire();
    } else {
      this._currentChatId = null;
    }
  }

  /**
   * 通道B（/ws/notify）：用户级事件订阅，与聊天 WS（通道A）独立、跨切聊天常驻。
   * 本体 sendEventToUser('chat-list-changed'/'char-data-changed', …) 经此到达 → 触发 webview 刷新列表。
   * 鉴权同聊天 WS（getHeaders 注入 Cookie）。幂等：已连/连接中则跳过；断线 5s 重连（除非已 dispose）。
   */
  private ensureNotifyWs(): void {
    if (
      this._notifyWs &&
      (this._notifyWs.readyState === WebSocket.OPEN || this._notifyWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const serverUrl = this._connectionService.state.serverUrl;
    if (!serverUrl) return;
    const wsUrl = serverUrl.replace(/^http/, "ws") + "/ws/notify";
    try {
      const ws = new WebSocket(wsUrl, { headers: this._authService.getHeaders() });
      this._notifyWs = ws;
      ws.onopen = () => console.log("[ChatService] 通道B /ws/notify 已连接");
      ws.onmessage = (event) => {
        try {
          const m = JSON.parse(event.data.toString());
          if (!m || !m.type) return;
          const data = m.data || {};
          if (m.type === "chat-list-changed") this._onChatListChanged.fire(data);
          else if (m.type === "char-data-changed") this._onCharDataChanged.fire(data);
          else if (m.type === "part-installed") this._onChatConfigChanged.fire({ kind: "part_installed", payload: data }); // #3 新装角色/人设 → 刷新
          else if (m.type === "account_deleted") this._handleAccountDeleted(); // 删号系统事件（event_dispatcher.mjs:125）——与通道A同名分支双入口覆盖
          // show-toast=本体有消费(pages/base.mjs:114)无生产(残链)、default-part-setted=本体有生产(parts_loader.mjs:67,89)无消费(孤儿) → 不接。
          // locale-updated=本体链完整（生产 src/scripts/i18n.mjs:152 sendEventToAll → 消费 pages/scripts/i18n.mjs:510）——
          // YonBan 不接是设计选择（webview 无独立 locale 切换面），非 orphan（T013 校准：原"无生产者"系 YonBan 单库 grep 误判，生产者在本体库）
        } catch { /* 非 JSON / 无 type：忽略 */ }
      };
      ws.onclose = () => {
        this._notifyWs = null;
        if (!this._notifyDisposed) setTimeout(() => this.ensureNotifyWs(), NOTIFY_RECONNECT_DELAY_MS);
      };
      ws.onerror = (err) =>
        console.error("[ChatService] 通道B /ws/notify 错误:", (err as { message?: string })?.message);
    } catch (e) {
      console.error("[ChatService] 通道B 连接失败:", (e as Error)?.message);
    }
  }

  // ── H3: WS 聊天流应用层心跳 ────────────────────────────
  /**
   * 启动心跳：每 30s 发 {type:"ping"}；若超 HEARTBEAT_TIMEOUT(75s) 未收到 pong，
   * 判半开 TCP 僵连接 → 主动 close（触发 onclose → _handleWsClose 重连）。
   * 本体 broadcast.mjs registerChatUiSocket 收 ping 回 pong（H3 配套后端改动）。
   */
  private _startChatHeartbeat(): void {
    this._stopChatHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      const ws = this._chatWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // 僵连接检测：上次 pong 距今超时 → 主动断开重连（防 UI 假活、收不到推送也不重连）
      if (this._lastPongAt && Date.now() - this._lastPongAt > ChatService.HEARTBEAT_TIMEOUT) {
        console.warn("[ChatService] 聊天 WS 心跳超时（僵连接），主动重连");
        try { ws.close(); } catch { /* 已关 */ }
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "ping", payload: null }));
      } catch { /* 发送失败，等下个周期或 onclose */ }
    }, ChatService.HEARTBEAT_INTERVAL);
  }

  private _stopChatHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * 通过 WS 发送停止生成请求。
   * 对应前端 websocket.mjs 的 sendWebsocketMessage。
   */
  stopGeneration(messageId: string): void {
    if (this._chatWs?.readyState === WebSocket.OPEN) {
      this._chatWs.send(
        JSON.stringify({
          type: "stop_generation",
          payload: { messageId },
        }),
      );
    }
  }

  // =================================================================
  // WS 消息处理（通道A：per-chat 聊天 WS，32 种消息类型）
  // 完整分类索引见模块头注释
  // =================================================================

  /** 处理收到的 WS 消息（通道A 分发中枢：解析 JSON → switch(type) → fire 对应 EventEmitter） */
  private _handleWsMessage(event: WebSocket.MessageEvent): void {
    let msg: { type: string; payload: unknown };
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      console.warn("[ChatService] WS 消息解析失败:", String(event.data));
      return;
    }

    switch (msg.type) {
      case "message_added":
        this._onMessageAdded.fire(msg.payload as ChatLogEntry);
        break;

      case "message_replaced": {
        const p = msg.payload as { index: number; entry: ChatLogEntry };
        this._onMessageReplaced.fire(p);
        break;
      }

      case "message_deleted":
        this._onMessageDeleted.fire(msg.payload as { index: number });
        break;

      case "message_edited": {
        const p = msg.payload as { index: number; entry: ChatLogEntry };
        this._onMessageEdited.fire(p);
        break;
      }

      case "stream_start":
        this._onStreamStart.fire(msg.payload as { messageId: string });
        break;

      case "stream_update":
        this._onStreamUpdate.fire(
          msg.payload as { messageId: string; slices: StreamSlice[] },
        );
        break;

      case "typing_status":
        this._onTypingStatus.fire(msg.payload as { typingList: string[] });
        break;

      // W65: 工具执行完毕事件
      case "tool_results_ready":
        this._onToolResultsReady.fire(msg.payload as { count: number; source: string });
        break;

      // ★ Cache token统计
      case "token_usage":
        this._onTokenUsage.fire(msg.payload as { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number });
        break;

      // ★ 分身操作外显
      case "clone_status":
        this._onCloneStatus.fire(msg.payload as { taskId: number; round: number; status: string; detail: string; timestamp: string });
        break;

      // W66: 有新审批需要处理
      case "pending_approvals":
        this._onPendingApprovals.fire(msg.payload as { count: number });
        break;

      // W72: 状态同步事件（session2 已补 mode_changed + preset_changed producer）
      case "mode_changed":
        // producer: setDataActions.mjs:236 _broadcastModeChanged
        this._onModeChanged.fire(msg.payload as { mode: string; bound_preset?: string });
        break;
      case "preset_changed":
        // producer: beilu-preset/main.mjs:1041(per-chat) + :1089(global)
        this._onPresetChanged.fire(msg.payload as { preset: string });
        break;
      case "runtime_params_changed":
        // producer: beilu-preset/main.mjs:855 broadcastAllChatUi({type:"runtime_params_changed",...})
        this._onRuntimeParamsChanged.fire(msg.payload as { params: Record<string, unknown> });
        break;

      // T10: 后端 broadcastAllChatUi({type:"subModeSwitched"}) 推送（原先落 default 被丢弃→只能靠 4s 轮询）。
      //   ★ 字段在 event 顶层 subModeSwitch（main.mjs:96 / setDataActions.mjs:3002 {from,to,label,modeGroup,chatId}），
      //     非 msg.payload——前端 websocket.mjs:530 同样读 event.subModeSwitch?.to。此前误读 payload 永远 undefined。
      case "subModeSwitched": {
        const ev = msg as Record<string, unknown>;
        // 类型校准（2026-07-15）：本体真实字段是大写 chatId（main.mjs:96 {from,to,label,modeGroup,chatId}），
        // 原声明误写小写 chatid——当前消费端只读 label 零影响，但错误类型会引导未来消费代码读 undefined。
        this._onSubModeSwitched.fire((ev.subModeSwitch || {}) as { from?: string; to: string; label?: string; chatId?: string });
        break;
      }

      // 同步断链修复（2026-07-10）：配置内容变更信号（不带数据，消费端重拉读落盘真值）
      case "subModesConfigChanged":
        this._onSubModesConfigChanged.fire();
        break;

      // 跨客户端「当前对话」同步：本用户另一端生成开始 → 跟随到该 chat
      case "peer_active_chat":
        this._onPeerActiveChat.fire(msg.payload as { chatid: string });
        break;

      // F3/Y2: 任务清单变更推送（AI <taskPlan>/<taskCheck> 或用户手勾后后端广播）
      case "task_update":
        this._onTaskUpdate.fire(msg.payload as { chatid?: string; tasks: Array<Record<string, unknown>>; rev: number; remaining?: number });
        break;

      // P0.3: 组运行态推送（建组/状态变更/角色绑定每次落库 broadcastAllChatUi 都发）。
      //   payload 仅 {username}，消费方据此重拉组注册表刷新运行态条（轮询降级为兜底）。
      case "group_runtime_update":
        this._onGroupRuntimeUpdate.fire(msg.payload as { username?: string; activeLines?: string[] });
        break;

      // 跨 chatId 模式事件：字段在 event 顶层（sourceChatId/subtype/notification），不在 payload。
      case "cross_mode_task_update": {
        const e = msg as { type: string; sourceChatId?: string; subtype?: string; notification?: unknown; payload?: unknown };
        this._onCrossModeTaskUpdate.fire({ sourceChatId: e.sourceChatId, subtype: e.subtype, notification: e.notification, payload: e.payload });
        break;
      }

      // #2 当前会话配置变更（他端改）：统一为一个事件，webview 据此重拉刷新。
      case "char_added":
      case "char_removed":
      case "plugin_added":
      case "plugin_removed":
      case "persona_set":
      case "world_set":
        this._onChatConfigChanged.fire({ kind: msg.type, payload: msg.payload });
        break;

      // #4 消息结构变更（他端删一段/隐藏/时间线变更）→ 统一全量 resync 反映
      case "messages_range_deleted":
      case "messages_hidden":
      case "timeline_info":
        this._onMessageStructChanged.fire({ kind: msg.type, payload: msg.payload });
        break;

      // #5 通知型：自动继续熔断 / bot 错误 / 组 worker 降级 → webview toast 提示。
      //   group_worker_degraded：组 worker 路由失败回退本地生成（generation.mjs:121-124 {reason,timestamp}），
      //   此前 YonBan 落 default 丢弃，用户对降级完全无感 → 接入同型号 ServerNotice 通知。
      case "auto_continue_fuse":
      case "bot_error":
      case "group_worker_degraded":
        this._onServerNotice.fire({ kind: msg.type, payload: msg.payload });
        break;

      // H3: 应用层心跳回应。后端 registerChatUiSocket 收 ping 回 {type:"pong"}；
      //   收到 pong 即标记本次心跳活跃，供 _checkHeartbeat 判活（不再误判僵连接）。
      case "pong":
        this._lastPongAt = Date.now();
        break;

      // 系统级会话终结：本体删号在发生处主动推送（chatStorage.mjs:1134 broadcastChatEvent）。
      // 本体前端同名分支=清存储+回登录页（websocket.mjs:699）；插件等价语义=清凭据+断开。
      // 不接此事件时插件会揣着已删账号的凭据无限 401 重试（"已连接+旧用户"假活）。
      case "account_deleted":
        this._handleAccountDeleted();
        break;

      default:
        break;
    }
  }

  /**
   * 删号系统事件的插件侧终结（对齐本体前端 websocket.mjs:699 清存储+回登录页语义）：
   * 清 Cookie + 清 SecretStorage 凭据（账号已不存在，留着=下次启动无限 401 假活）+
   * 断开连接状态机（webview 回到设置页连接按钮）。通道A/通道B 双入口都路由到此。
   */
  private _handleAccountDeleted(): void {
    console.warn("[ChatService] 收到 account_deleted：账号已被删除，清理会话");
    this._authService.clearCookies();
    this._authService.clearCredentials().catch(() => { /* SecretStorage 清理尽力而为 */ });
    this.disconnectChat();
    this._connectionService.disconnect();
  }

  private _isReconnecting = false;

  /** WS 断连后自动重连 */
  private _handleWsClose(): void {
    console.log("[ChatService] 聊天 WS 断开");
    this._stopChatHeartbeat();
    this._chatWs = null;
    this._onChatDisconnected.fire();

    if (this._currentChatId && !this._isReconnecting) {
      const chatId = this._currentChatId;
      this._isReconnecting = true;
      this._reconnectTimer = setTimeout(() => {
        this._isReconnecting = false;
        if (this._currentChatId === chatId) {
          console.log(`[ChatService] 尝试重连聊天 WS: ${chatId}`);
          this.connectChat(chatId);
        }
      }, ChatService.RECONNECT_DELAY);
    }
  }

  /**
   * H2: 重连后增量补拉断线期漏掉的消息。
   * 入参 localServerCount = 客户端已持有的「服务端绝对消息数」(webview: logOffset + messages.length)。
   * 取服务端当前总长，若更长则只拉 [localServerCount, serverLength) 区间补漏；否则返回空。
   * 走 getChatLog（REST，已含 401-refresh），不全量重渲，避免断线消息永久丢 + 避免重复拉全量。
   */
  async getMissedMessages(
    chatId: string,
    localServerCount: number,
  ): Promise<{ serverLength: number; missed: ChatLogEntry[] }> {
    const serverLength = await this.getChatLogLength(chatId);
    if (!Number.isFinite(localServerCount) || localServerCount < 0) {
      return { serverLength, missed: [] };
    }
    if (serverLength <= localServerCount) {
      return { serverLength, missed: [] };
    }
    const missed = await this.getChatLog(chatId, localServerCount, serverLength);
    return { serverLength, missed };
  }

  // =================================================================
  // 资源释放（全部 EventEmitter + 2 个 WS 连接）
  // =================================================================

  dispose(): void {
    this.disconnectChat();
    this._onMessageAdded.dispose();
    this._onMessageReplaced.dispose();
    this._onMessageDeleted.dispose();
    this._onMessageEdited.dispose();
    this._onStreamStart.dispose();
    this._onStreamUpdate.dispose();
    this._onTypingStatus.dispose();
    this._onChatConnected.dispose();
    this._onChatDisconnected.dispose();
    // ⚠ 后加的 EventEmitter 曾漏 dispose 致重连重复监听——新增 Emitter 必须同步补进本清单
    //（toolResultsReady / tokenUsage / cloneStatus / pendingApprovals / modeChanged / presetChanged / runtimeParamsChanged）
    this._onToolResultsReady.dispose();
    this._onTokenUsage.dispose();
    this._onCloneStatus.dispose();
    this._onPendingApprovals.dispose();
    this._onModeChanged.dispose();
    this._onSubModeSwitched.dispose();
    this._onSubModesConfigChanged.dispose();
    this._onPeerActiveChat.dispose();
    this._onTaskUpdate.dispose();
    this._onGroupRuntimeUpdate.dispose();
    this._onPresetChanged.dispose();
    this._onRuntimeParamsChanged.dispose();
    // 通道B 收尾
    this._onChatListChanged.dispose();
    this._onCharDataChanged.dispose();
    this._onCrossModeTaskUpdate.dispose();
    this._onChatConfigChanged.dispose();
    this._onMessageStructChanged.dispose();
    this._onServerNotice.dispose();
    this._notifyDisposed = true;
    if (this._notifyWs) {
      try { this._notifyWs.onclose = null; this._notifyWs.close(); } catch { /* ignore */ }
      this._notifyWs = null;
    }
  }
}
