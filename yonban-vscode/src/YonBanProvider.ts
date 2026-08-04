/**
 * YonBanProvider — 左主侧栏 webview 消息中枢（case label 路由 + WS 事件转发；数量以 handleMessage switch 与 resolveWebviewView 订阅为准，注释不写死会漂移的计数）。
 * 不管 IDE 工具执行（那是 ToolExecutor 的事）、不管后端生成/预设组装（那是后端的事）。
 *
 * 链路：webview(chat.js/chat-*.js) ←postMessage→ 本模块 ←HTTP/WS→ beilu 后端
 * 影响：写 globalState（userState / modeByChat 持久化）、推 postMessage 到 webview
 * 相交：← extension.ts 注册
 *       → ChatService（WS + HTTP 与后端通信的唯一出口）
 *       → AuthService.fetchOk（预设/文件权限/运行参数的 HTTP 直调）
 *       → ConnectionService（连接状态 + serverUrl）
 *       → IdeWsServer（IDE WS 桥接状态查询）
 *
 * 三层通信架构（webview CSP 沙箱不允许直接 XHR/WS）：
 *   webview JS → postMessage → 本模块 handleMessage → ChatService/AuthService → 后端
 *   后端 → WS 广播 → ChatService 事件 → 本模块 resolveWebviewView 回调 → postMessage → webview JS
 *
 * handleMessage case 分类索引（分类速查用；精确清单以 switch 代码为准）：
 * ┌─────────────────┬─────────────────────────────────────────────────────────────────────────┐
 * │ 连接/认证 (5)   │ connect, disconnect, login, logout, getState                           │
 * │ 持久化 (1)      │ saveUserState                                                          │
 * │ WS 状态 (1)     │ getWsStatus                                                            │
 * │ 角色 (3)        │ getCharList, getCharDetails, getCharAvatarUrl                          │
 * │ 聊天列表 (4)    │ getChatList, selectChat/switchChat(合并), newChat, deleteChat           │
 * │ 消息操作 (6)    │ sendMessage, triggerReply, stopGeneration, editMessage,                │
 * │                 │ deleteMessage, hideMessage                                              │
 * │ 回档 (2)        │ previewRollback, rollbackToMessage                                     │
 * │ 模式/诊断 (4)   │ getActiveMode, setActiveMode, getYonbanDiag, getConnectionDiag         │
 * │ Token/压缩 (3)  │ getTokenSnapshot, compactContext(含7子action), hideContextNoise         │
 * │ 流程组 (5)      │ listFlowGroups, startFlowGroup, deleteFlowGroup, saveFlowGroup,        │
 * │                 │ updateFlowGroup                                                         │
 * │ 组管理 (2)      │ listGroups, groupAction                                                │
 * │ 检查点 (3)      │ listCheckpoints, getCheckpointFileDiff, revertCheckpoint               │
 * │ 权限/审批 (9)   │ getPermissionLevel, getApprovalRules, removeApprovalRule,              │
 * │                 │ getIdeApprovals, approveIdeOp, rejectIdeOp, approveAllIdeOps,          │
 * │                 │ rejectAllIdeOps, addApprovalSkipRule                                    │
 * │ 任务 (5)        │ getTasks, planTasks, checkTask, updateTask, deleteTask                 │
 * │ 缓存 (1)        │ getReadCache                                                           │
 * │ 模型/API源 (5)  │ getApiSourceConfig, switchModel, getModelList, getApiSourceList,       │
 * │                 │ switchApiSource                                                         │
 * │ 记忆/预设 (7)   │ getMemoryConfig, toggleMemoryPreset, toggleInjectionPrompt,            │
 * │                 │ getMemoryAIOutput, getDiagSnapshot, getPresetConfig, switchPreset       │
 * │ 预设生命周期 (4)│ createPreset, duplicatePreset, renamePreset, deletePreset (合并1case)   │
 * │ 子模式 (3)      │ getSubModes, saveSubModes, setActiveSubMode                            │
 * │ 分身 (2)        │ getClones, saveClones                                                  │
 * │ 提示词 (1)      │ buildPrompt                                                            │
 * │ 文件配置 (2)    │ getFilesConfig, setFilesConfig                                         │
 * │ 运行参数 (2)    │ getRuntimeParams, setRuntimeParams                                     │
 * │ 正则/思维链 (3) │ getRegexRules, getThinkingTags, updateReasoningConfig                  │
 * │ 增量补拉 (1)    │ requestMissedMessages                                                  │
 * │ IDE 定位 (1)    │ revealFile                                                              │
 * │ 记忆文件夹 (1)  │ openMemoryFolder                                                       │
 * │ 其他 (1)        │ default（未知命令 → operationError toast）                              │
 * └─────────────────┴─────────────────────────────────────────────────────────────────────────┘
 *
 * 已知 bug（仅标注不修）：（无）
 */
import * as vscode from "vscode";
import { AuthService } from "./services/AuthService";
import { ChatService, isExactIdeRouteSnapshot } from "./services/ChatService";
import type { IdeRouteSnapshot } from "./services/ChatService";
import { ConnectionService } from "./services/ConnectionService";
import type { ConsoleCapture } from "./services/ConsoleCapture";
import { IdeWsServer } from "./services/IdeWsServer";
import type { WebviewMessage } from "./types";
import { DEFAULT_MODE, PROVIDER_TIMEOUT_MS, TOKEN_POLL_MS, MEMORY_POLL_MS, APPROVAL_POLL_MS, GROUP_POLL_MS, ERROR_CENTER_MAX } from "./constants"; // T003 默认模式单源 + 超时/轮询收口
import { t } from "./i18n";

const FILE_REFERENCE_LIST_PLACEHOLDER = "{fileReferences}";

function renderFileReferencePrompt(template: string, refList: string): string {
  return template.split(FILE_REFERENCE_LIST_PLACEHOLDER).join(refList);
}

// 点击按钮的成功「提醒」：handleMessage 未抛错=动作已执行 → 对这些 mutating 动作回一条 notify→前端 showToast。
// 只列「改变了状态」的用户点击动作；纯 get*/只读 + 高频自动(saveUserState) 不提醒，避免刷屏。
// 报错提醒走另一路（operationError→showToast ❌，已有）。两路合起来 = 点哪个按钮都有提醒。
// 07-09 死键清理：logout/setActiveMode/openMemoryFolder 三键随同名死 handler case 删除（webview 零发送方）
const ACTION_NOTIFY: Record<string, string> = {
  connect: "正在连接后端…",
  sendMessage: "已发送", triggerReply: "已触发回复", stopGeneration: "已停止生成",
  newChat: "已新建对话", deleteChat: "已删除对话", editMessage: "已编辑消息",
  deleteMessage: "已删除消息", hideMessage: "已切换隐藏",
  switchModel: "已切换模型", switchApiSource: "已切换 API 源",
  switchPreset: "已切换预设", createPreset: "已创建预设", duplicatePreset: "已复制预设",
  renamePreset: "已重命名预设", deletePreset: "已删除预设", toggleMemoryPreset: "已切换记忆预设",
  toggleInjectionPrompt: "已切换注入提示词", saveSubModes: "已保存子模式", setActiveSubMode: "已激活子模式",
  saveClones: "已保存分身", setFilesConfig: "已保存文件设置", setRuntimeParams: "已保存运行参数",
  approveIdeOp: "已批准操作", rejectIdeOp: "已拒绝操作", approveAllIdeOps: "已全部批准", rejectAllIdeOps: "已全部拒绝",
  revealFile: "已定位文件",
};

/**
 * 侧边栏 Webview Provider。
 * V2 重构：两视图布局（聊天 + 设置）
 * - 聊天视图：纯对话 + 底部模式/API选择器
 * - 设置视图：Tab式面板（连接/记忆/子模式/关于）
 */
/** 本窗口私有的会话态（存 workspaceState）：这个 VSCode 窗口当前在哪张卡、哪个对话、哪个视图。 */
interface UserSessionState {
  selectedChar: string | null;
  currentChatId: string | null;
  hasBoundChar: boolean;
  currentView?: string;
}

/** 跨窗口共享的用户偏好（存 globalState）：与"在哪个对话"无关，两个窗口保持一致才合理。 */
interface UserPrefState {
  autoContinue?: boolean;
  autoContinueDelay?: number;
  modeSwitchCleanup?: boolean;
}

export class YonBanProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;
  private _connectionService: ConnectionService;
  private _authService: AuthService;
  private _wsServer: IdeWsServer;
  private _chatService: ChatService;
  private _globalState: vscode.Memento;
  /** 本窗口（工作区）私有存储：会话态归这里，绝不进 globalState——见 saveUserState 的多窗隔离注释。 */
  private _workspaceState: vscode.Memento;
  // ★ B17: per-chat activeMode 隔离 + 持久化。原 _yonbanMode 单字段会被任意 chat 的切换污染全局。
  //   现按 chatId 存 Map，并持久化到 _globalState("yonban.modeByChat")；无 chatId 时回退 _defaultMode 单值行为。
  private _yonbanModeByChat: Map<string, string> = new Map();
  private _defaultMode: string = DEFAULT_MODE; // T003 单源
  private _extensionVersion: string;

  /** B17: 取某 chat 的 mode；缺省回退 _defaultMode。chatId 为空时返回 _defaultMode（兼容单值行为）。 */
  private _modeFor(chatId: string | null | undefined): string {
    if (!chatId) return this._defaultMode;
    return this._yonbanModeByChat.get(chatId) ?? this._defaultMode;
  }

  /** B17: 写某 chat 的 mode 并持久化。chatId 为空时只更新 _defaultMode（兼容单值行为）。 */
  private _setModeFor(chatId: string | null | undefined, mode: string): void {
    this._defaultMode = mode; // 最近一次选择也作为新 chat 的缺省
    if (chatId) {
      this._yonbanModeByChat.set(chatId, mode);
      this._persistModeByChat();
    }
  }

  /** 多开绑定的唯一入口：完整身份 + 后端 success 才算绑定成功。 */
  private async _bindCurrentChat(chatId: string): Promise<Record<string, unknown>> {
    const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const port = this._wsServer.port;
    const instanceId = this._wsServer.instanceId;
    if (!normalizedChatId || !Number.isInteger(port) || port <= 0 || typeof instanceId !== "string" || !instanceId.trim()) {
      throw new Error("IDE 实例绑定身份无效（chatId/port/instanceId 必须完整）");
    }
    return this._chatService.bindIdeInstance(normalizedChatId, port, instanceId.trim());
  }

  /** 绑定失败必须用户可见；不写成功缓存，后续切换/发送/重连仍可重试。 */
  private _reportIdeBindFailure(chatId: string, phase: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[YonBan] ${phase} IDE 实例绑定失败 (chat=${chatId}):`, detail);
    this.postMessage({
      type: "operationError",
      payload: { action: "bindIdeInstance", error: `${phase}：${detail}` },
    });
  }

  /** B17: 持久化整张 Map 到 globalState（与 yonban.userState 同套 Memento 持久化模式）。 */
  private _persistModeByChat(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this._yonbanModeByChat) obj[k] = v;
      this._globalState.update("yonban.modeByChat", obj);
    } catch (err: unknown) {
      console.error("[YonBan] 持久化 modeByChat 失败:", err);
    }
  }

  constructor(
    extensionUri: vscode.Uri,
    connectionService: ConnectionService,
    authService: AuthService,
    wsServer: IdeWsServer,
    chatService: ChatService,
    globalState: vscode.Memento,
    workspaceState: vscode.Memento,
    extensionVersion: string = "",
  ) {
    this._extensionUri = extensionUri;
    this._connectionService = connectionService;
    this._authService = authService;
    this._wsServer = wsServer;
    this._chatService = chatService;
    this._globalState = globalState;
    this._workspaceState = workspaceState;
    this._extensionVersion = extensionVersion;
    // ★ B17: 启动恢复 per-chat mode 持久化表
    try {
      const saved = this._globalState.get<Record<string, string>>("yonban.modeByChat");
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) {
          if (typeof v === "string") this._yonbanModeByChat.set(k, v);
        }
      }
    } catch (err: unknown) {
      console.error("[YonBan] 恢复 modeByChat 失败:", err);
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "webview-ui"),
      ],
    };

    // ★ B7: 切换面板时同步状态
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postMessage({
          type: "connectionState",
          payload: this._connectionService.state,
        });
        this.postMessage({ type: "visibilityChanged", payload: { visible: true } });
        this._resyncChat();
        this.handleMessage({ type: "getIdeApprovals" } as WebviewMessage);
        this.handleMessage({ type: "getSubModes" } as WebviewMessage);
        this.handleMessage({ type: "getPresetConfig" } as WebviewMessage);
        this.handleMessage({ type: "getRuntimeParams" } as WebviewMessage);
      } else {
        this.postMessage({ type: "visibilityChanged", payload: { visible: false } });
      }
    });

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // 监听 Webview 发来的消息
    // ★ 报错兜底：handleMessage 是 async，原回调既不 await 也不 catch → 无自身 try/catch 的处理分支
    //   （connect/disconnect/logout/saveUserState/setActiveMode/toggle* 等）抛错时变成「未处理的 Promise
    //   rejection」=静默失败，UI 永远不知道。此处统一兜底：任何未捕获错误 → 回 webview operationError（前端
    //   已有该类型的错误展示），并打日志。保证「每个可触碰动作有问题就会报错」。
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        try {
          const outcome = await this.handleMessage(message);
          // 成功提醒：mutating 动作执行完（未抛错）→ 回 notify，前端 showToast「已X」。
          const _note = ACTION_NOTIFY[message?.type as string];
          if (_note && outcome?.actionNotifyHandled !== true) {
            this.postMessage({ type: "notify", payload: { message: _note } });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[YonBan] handleMessage 未捕获错误 (action=${message?.type}):`, msg);
          this.postMessage({
            type: "operationError",
            payload: { action: message?.type ?? "unknown", error: msg },
          });
        }
      },
      undefined,
    );

    // 监听连接状态变化，推送给 Webview + 协调 ChatService
    this._connectionService.onStateChange((state) => {
      this.postMessage({ type: "connectionState", payload: state });
      // 断链3修：HTTP 连接恢复时，检查 ChatService WS 是否需要重连
      if (state.status === "connected" && this._chatService.currentChatId && !this._chatService.isChatConnected) {
        console.log("[YonBan] HTTP 恢复，WS 未连接，触发 WS 重连:", this._chatService.currentChatId);
        this._chatService.connectChat(this._chatService.currentChatId);
      }
    });

    // 初始状态推送
    this.postMessage({
      type: "connectionState",
      payload: this._connectionService.state,
    });

    // ── 聊天事件转发给 Webview ─────────────
    this._chatService.onMessageAdded((entry) => {
      this.postMessage({ type: "messageAdded", payload: entry });
    });
    this._chatService.onMessageReplaced((data) => {
      _flushStreamUpdates(); // [0719 IPC 合帧] 终帧替换前清缓冲保序（定义在下方，事件异步触发时已初始化）
      this.postMessage({ type: "messageReplaced", payload: data });
    });
    // [0719 IPC 合帧·诊断_YonBan流式显示链 跳B] streamUpdate 原每 chunk 一次跨进程 postMessage
    //   （一轮生成几百次 structured clone + IPC=延迟放大器）。slices 是增量操作流（append/
    //   rewrite_tail/set_files，webview 按序 for 应用）→ 合帧必须无损：按 messageId 缓冲串接，
    //   80ms 合并成单条（webview 消费语义零变化）。messageReplaced/Deleted 转发前强制先 flush
    //   保序——否则终帧替换后晚到的旧 slices 会在 webview 重建已删除的流式条目（幽灵复活）。
    //   注意：flush 只传 {messageId, slices}——webview onStreamUpdate 只读这两字段（chat-messages.js:726-727），
    //   payload 未来加新字段时需同步扩这里。
    const _suBuf = new Map<string, unknown[]>();
    let _suTimer: ReturnType<typeof setTimeout> | null = null;
    const _SU_FLUSH_MS = 80;
    const _flushStreamUpdates = () => {
      if (_suTimer) { clearTimeout(_suTimer); _suTimer = null; }
      for (const [mid, slices] of _suBuf) {
        this.postMessage({ type: "streamUpdate", payload: { messageId: mid, slices } });
      }
      _suBuf.clear();
    };
    this._chatService.onMessageDeleted((data) => {
      _flushStreamUpdates();
      this.postMessage({ type: "messageDeleted", payload: data });
    });
    this._chatService.onMessageEdited((data) => {
      this.postMessage({ type: "messageEdited", payload: data });
    });
    this._chatService.onStreamStart((data) => {
      this.postMessage({ type: "streamStart", payload: data });
    });
    this._chatService.onStreamUpdate((data: { messageId: string; slices?: unknown[] }) => {
      const arr = _suBuf.get(data.messageId) || [];
      _suBuf.set(data.messageId, arr.concat(data.slices || []));
      if (!_suTimer) _suTimer = setTimeout(_flushStreamUpdates, _SU_FLUSH_MS);
    });
    this._chatService.onTypingStatus((data) => {
      this.postMessage({ type: "typingStatus", payload: data });
    });
    // W65: 工具结果就绪→通知webview自动继续
    this._chatService.onToolResultsReady((data) => {
      this.postMessage({ type: "toolResultsReady", payload: data });
    });
    // ★ Cache token统计→通知webview更新token bar
    this._chatService.onTokenUsage((data) => {
      this.postMessage({ type: "tokenUsage", payload: data });
    });
    // ★ 分身操作外显→通知webview显示进度
    this._chatService.onCloneStatus((data) => {
      this.postMessage({ type: "cloneStatus", payload: data });
    });
    // W66: 有新审批→通知webview弹出审批UI
    this._chatService.onPendingApprovals((data) => {
      this.postMessage({ type: "pendingApprovals", payload: data });
    });
    // W72: 状态同步事件→转发给webview自动刷新
    this._chatService.onModeChanged((data) => {
      this.postMessage({ type: "modeChanged", payload: data });
    });
    this._chatService.onPresetChanged((data) => {
      this.postMessage({ type: "presetConfig", payload: { active_preset: data.preset } });
    });
    this._chatService.onRuntimeParamsChanged((data) => {
      this.postMessage({ type: "runtimeParams", payload: data.params });
    });
    // T10: 子模式切换 WS 推送 → webview（实时通道，替代 4s 全量轮询）
    this._chatService.onSubModeSwitched((data) => {
      this.postMessage({ type: "subModeSwitched", payload: data });
    });
    // 同步断链修复（2026-07-10）：配置内容变更 → 通知 webview 重拉 getSubModes
    this._chatService.onSubModesConfigChanged(() => {
      this.postMessage({ type: "subModesConfigChanged", payload: {} });
    });
    // 跨客户端「当前对话」同步：本用户另一端(本体)生成开始 → 通知 webview 跟随切到该 chat
    this._chatService.onPeerActiveChat((data) => {
      this.postMessage({ type: "peerActiveChat", payload: data });
    });
    // F3/Y2: 任务清单变更推送 → webview 任务卡
    this._chatService.onTaskUpdate((data) => {
      this.postMessage({ type: "taskUpdate", payload: data });
    });
    // P0.3: 组运行态推送（本体 group_runtime_update）→ webview 组运行态条即时刷新（替代 15s 轮询主路径）
    this._chatService.onGroupRuntimeUpdate((data) => {
      this.postMessage({ type: "groupRuntimeUpdate", payload: data });
    });
    // 通道B（/ws/notify）：跨客户端会话列表/角色卡变更 → webview 刷新（重新 getChatList）
    this._chatService.onChatListChanged((data) => {
      this.postMessage({ type: "chatListChanged", payload: data });
    });
    // 角色卡数据被他端编辑 → 推 chatInitialData 刷新（onChatInitialData 真应用 charlist；
    // 修正：原走 _resyncChat→chatResync 只补消息、不应用 config，是半吊子，已改 chatInitialData）。
    this._chatService.onCharDataChanged(() => {
      this._refreshChatInitialData();
    });
    // 通道A 跨 chatId：work/code 在独立 chatId 的 report 完成/needHelp/审批 → webview 提示
    this._chatService.onCrossModeTaskUpdate((data) => {
      this.postMessage({ type: "crossModeTaskUpdate", payload: data });
    });
    // #2/#3 当前会话配置变更（他端改角色/插件/人设/世界书/装新部件）→ 推 chatInitialData 刷新。
    //   修正：onChatInitialData 才真应用 config（charlist）；onChatResync 只补消息，故改走 chatInitialData。
    //   注：YonBan webview 目前仅 state.charlist 从 initialData 应用；plugins/persona/world 的显示刷新归前端手动专做域。
    this._chatService.onChatConfigChanged(() => {
      this._refreshChatInitialData();
    });
    // #4 消息结构变更（他端删一段/隐藏/时间线）→ 全量 resync 反映
    this._chatService.onMessageStructChanged(() => {
      this._resyncChat();
    });
    // #5 通知型（自动继续熔断 / bot 错误）→ webview toast
    this._chatService.onServerNotice((data) => {
      this.postMessage({ type: "serverNotice", payload: data });
    });
    this._chatService.onChatConnected(({ chatId, isReconnect }) => {
      // EventEmitter 不等待异步监听器：WS 连接事实照常上报；IDE 绑定单独等待并显式报告失败。
      // 这里不设置“已绑定”状态，失败后仍由下一次重连、切换或发送重试。
      void this._bindCurrentChat(chatId).catch((err: unknown) => {
        this._reportIdeBindFailure(chatId, isReconnect ? "聊天重连后绑定" : "聊天连接后绑定", err);
      });
      this.postMessage({ type: "chatConnected", payload: { chatId, isReconnect } });
      if (isReconnect) {
        // H2: 重连 → 通知 webview 触发增量补拉（webview 持有本地消息数，回发 requestMissedMessages）
        this.postMessage({ type: "chatReconnected", payload: { chatId } });
      } else {
        // 首连：全量窗口同步可能遗漏的消息
        this._resyncChat();
      }
    });
    this._chatService.onChatDisconnected(() => {
      this.postMessage({ type: "chatDisconnected" });
    });
  }

  // 反馈系统（2026-07-13）：extension.ts 注入 ConsoleCapture 引用——webview 初始化时经
  // getHostErrors 补拉宿主积压的 warn/error（postMessage 在 webview 未就绪时静默丢，实时
  // hostError 推送覆盖不到激活早期，此处是积压读路）。
  public consoleCapture?: ConsoleCapture;

  /**
   * webview ↔ 后端的 80+ case 消息路由中枢。
   *
   * 链路：webview postMessage → 本函数 switch → ChatService/AuthService → 后端
   * 影响：写 globalState（setActiveMode / saveUserState）、推 postMessage 给 webview
   * 约束：调用者不需要 catch——resolveWebviewView 的 onDidReceiveMessage 已统一兜底
   *       operationError toast（见上方 try/catch 包裹）。
   */
  public async handleMessage(message: WebviewMessage): Promise<{ actionNotifyHandled: true } | void> {
    switch (message.type) {
      case "connect":
        await this._connectionService.connect();
        break;

      case "disconnect":
        this._connectionService.disconnect();
        break;

      case "login": {
        const { username, password } = message.payload as {
          username: string;
          password: string;
        };
        // loginAs 而非 login+connect()：connect() 在 status=connected 时幂等跳过（ConnectionService:75），
        // 状态不会刷新 → authenticated/username 不广播 → webview 永远停在登录表单、角色/聊天列表不加载。
        const ok = await this._connectionService.loginAs(username, password);
        if (ok) {
          this.postMessage({ type: "loginResult", payload: { success: true } });
        } else {
          this.postMessage({
            type: "loginResult",
            payload: { success: false, error: "登录失败，请检查用户名和密码" },
          });
        }
        break;
      }

      // 死 handler 清理（2026-07-09 收口审计）：logout/getCharDetails/getCharAvatarUrl/openMemoryFolder/
      //   getActiveMode/setActiveMode/getYonbanDiag/getApiSourceConfig/getDiagSnapshot 九个 case 删除——
      //   webview-ui 全文零发送方（grep 复核），webview message handler 仅 webview 可触达=确证死代码。
      //   服务层方法（ChatService.setActiveMode 等）另有 provider 直调方，不受影响。

      case "getUserList": {
        try {
          const serverUrl = this._connectionService.state.serverUrl;
          const resp = await fetch(`${serverUrl}/api/users/list`, {
            method: "GET",
            headers: this._authService.getHeaders(),
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          });
          if (resp.ok) {
            // 本体契约（endpoints.mjs:428）：{ success, users: [...] }——取 .users，整个 body 不是数组
            const data = (await resp.json()) as { users?: unknown[] };
            this.postMessage({ type: "userList", payload: { users: Array.isArray(data.users) ? data.users : [] } });
          } else {
            this.postMessage({ type: "userList", payload: { users: [], error: "获取用户列表失败" } });
          }
        } catch (err: unknown) {
          this.postMessage({ type: "userList", payload: { users: [], error: String(err) } });
        }
        break;
      }

      case "getState":
        this.postMessage({
          type: "connectionState",
          payload: this._connectionService.state,
        });
        // 同时推送持久化的用户选择状态（会话态取本窗口的，偏好取全局的——见 saveUserState 注释）
        {
          const _sess = this._workspaceState.get<UserSessionState>("yonban.userState.session");
          const _pref = this._globalState.get<UserPrefState>("yonban.userState.pref");
          // 迁移：旧版整体存 globalState.yonban.userState，其中会话态是跨窗共享的（本次修复对象）。
          //   仅当本窗口尚无会话态时读一次旧键取偏好部分，会话态一律不从旧键恢复（否则又把别的窗口的对话拽过来）。
          const _legacy = (!_sess && !_pref)
            ? this._globalState.get<UserSessionState & UserPrefState>("yonban.userState")
            : null;
          const saved = {
            ...(_legacy ? { autoContinue: _legacy.autoContinue, autoContinueDelay: _legacy.autoContinueDelay, modeSwitchCleanup: _legacy.modeSwitchCleanup } : {}),
            ...(_pref || {}),
            ...(_sess || {}),
          };
          if (Object.keys(saved).length) {
            this.postMessage({
              type: "restoreUserState",
              payload: saved,
            });
          }
        }
        break;

      case "saveUserState": {
        const userState = message.payload as UserSessionState & UserPrefState;
        // ★ [多窗隔离根因修 0726] 会话态必须存 workspaceState（per-工作区=per-窗口），不能存 globalState。
        //   【实测事故】globalState 在 VSCode 里跨**所有窗口**共享：窗口A 选了角色卡X的对话、窗口B 选了
        //   角色卡Y的对话，两边 saveUserState 写同一个键互相覆盖；任一窗口 webview 重建/恢复可见时
        //   restoreUserState 读到的是另一个窗口最后写的 selectedChar+currentChatId → 两个 VSCode
        //   收敛到同一个对话、渲染同一份内容（凛倾 0726「两个不同的角色卡…你给我做相同的对话文件」）。
        //   这不是竞态也不是广播串台，是 per-窗口状态放进了跨窗口存储。
        //   分流依据=状态的归属层：selectedChar/currentChatId/hasBoundChar/currentView 属于**这个窗口**，
        //   autoContinue/延迟/modeSwitchCleanup 是**用户偏好**（跨窗一致才合理，留 globalState）。
        this._workspaceState.update("yonban.userState.session", {
          selectedChar: userState.selectedChar,
          currentChatId: userState.currentChatId,
          hasBoundChar: userState.hasBoundChar,
          currentView: userState.currentView,
        });
        this._globalState.update("yonban.userState.pref", {
          autoContinue: userState.autoContinue,
          autoContinueDelay: userState.autoContinueDelay,
          modeSwitchCleanup: userState.modeSwitchCleanup,
        });
        break;
      }

      case "getWsStatus":
        this.postMessage({
          type: "wsStatus",
          payload: {
            running: this._wsServer.isRunning,
            port: this._wsServer.port,
            clients: this._wsServer.clientCount,
          },
        });
        break;

      // 多开显示（2026-07-26）：后端连接池快照 + 本窗口身份 → webview 顶栏徽章
      //（本窗口端口 / 本体是否连到本窗口 / 当前对话是否路由到本窗口 / 本窗口工作区）
      case "getIdeBindingStatus": {
        const _myPort = this._wsServer.port;
        const _myWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
        try {
          const data = await this._chatService.getIdeInstances();
          this.postMessage({
            type: "ideBindingStatus",
            payload: {
              ...data,
              myPort: _myPort,
              myWorkspace: _myWs,
              currentChatId: this._chatService.currentChatId,
            },
          });
        } catch (err: unknown) {
          // 后端未升级（无 getIdeInstances action）/未连接 → 降级：只报本窗口身份，徽章显示为「未知路由」
          this.postMessage({
            type: "ideBindingStatus",
            payload: { error: err instanceof Error ? err.message : String(err), myPort: _myPort, myWorkspace: _myWs, currentChatId: this._chatService.currentChatId },
          });
        }
        break;
      }

      // ── 角色相关消息处理 ────────────────
      case "getCharList": {
        try {
          const charNames = await this._chatService.getCharacterList();
          this.postMessage({ type: "charList", payload: charNames });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "charList", payload: { error: msg } });
        }
        break;
      }

      // ── 聊天相关消息处理 ─────────────────
      case "getChatList": {
        try {
          const list = await this._chatService.getChatList();
          this.postMessage({ type: "chatList", payload: list });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "chatList",
            payload: { error: msg },
          });
        }
        break;
      }

      case "selectChat":
      case "switchChat": {
        const { chatId } = message.payload as { chatId: string };
        // [多窗时序 0726] 切换代号闸：onDidReceiveMessage 不串行，快速 A→B 切换时 A 的 getInitialData
        //   await 间隙里 B 可能整段跑完——若 A 恢复后照常 post，UI 终态=A 而 WS/currentChatId 终态=B（发错对话）。
        //   闸法：每次切换取递增代号，await 回来发现代号已过期 → 本次结果整段作废（不 post 不恢复 mode）。
        const _epoch = ++this._switchEpoch;
        try {
          // 先确认本窗口 IDE 身份绑定；失败时不改变 ChatService 当前 chat/WS 状态。
          try {
            await this._bindCurrentChat(chatId);
          } catch (err: unknown) {
            if (_epoch !== this._switchEpoch) break;
            this._reportIdeBindFailure(chatId, "切换对话", err);
            this.postMessage({
              type: "chatInitialData",
              payload: { error: err instanceof Error ? err.message : String(err), chatId },
            });
            break;
          }
          this._chatService.connectChat(chatId);
          const data = await this._chatService.getInitialData(chatId);
          if (_epoch !== this._switchEpoch) break; // 期间又切了别的对话，晚到的旧数据不得盖新终态
          // 推 chatSwitched 让左 webview 调 applySwitchedChat（只更新 UI 不回发 switchChat = 防回环）。
          //   chatMeta 留空：applySwitchedChat 从 state.allChats 自查（避免 ChatService 再加一层缓存）。
          // ★ 顺序约束：chatSwitched 必须先于 chatInitialData——applySwitchedChat 会重置消息区为
          //   "加载中"占位，若在 chatInitialData 之后到达会把刚渲染的消息擦掉且无人再拉数据（永久卡死）。
          //   先切 UI 态、后到的 chatInitialData 负责真正渲染。
          this.postMessage({ type: "chatSwitched", payload: { chatId } });
          this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } }); // 带归属 id，消费端校验（指令带id·执行端识别同款范式）
          // ★ B17: 切 chat 时恢复该 chat 的 activeMode 并通知 webview（复用 activeMode 通道）。
          //   后端同步该 mode，避免下一次 send/trigger 前残留上一个 chat 的 mode。
          const _restoredMode = this._modeFor(chatId);
          try {
            await this._chatService.setActiveMode(_restoredMode);
          } catch (e: unknown) {
            console.error("[YonBan] 切 chat 恢复 mode 失败:", e);
          }
          if (_epoch !== this._switchEpoch) break; // setActiveMode await 间隙同样可被插队
          this.postMessage({ type: "activeMode", payload: { mode: _restoredMode } });
        } catch (err: unknown) {
          if (_epoch !== this._switchEpoch) break; // 过期切换的报错也作废（新切换已接管 UI）
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "chatInitialData",
            payload: { error: msg, chatId },
          });
        }
        break;
      }

      case "sendMessage": {
        const { reply, autoReply, files, fileReferences, chatId: _wvChatId } = message.payload as {
          reply: string;
          autoReply?: boolean;
          chatId?: string;
          files?: unknown[];
          fileReferences?: string[];
        };
        // chatService.currentChatId 优先；webview 传的 chatId 做 fallback（两个状态可能因 WS 断连不同步）
        let chatId = this._chatService.currentChatId;
        let shouldRestoreChatConnection = false;
        if (!chatId && _wvChatId) {
          // ChatService 丢失了 chatId（WS 断连后未恢复），先冻结 webview 身份，绑定成功后再恢复 WS。
          console.warn(`[YonBan] sendMessage: chatService.currentChatId 为空，用 webview 侧 chatId=${_wvChatId} 恢复`);
          chatId = _wvChatId;
          shouldRestoreChatConnection = true;
        }
        if (!chatId) {
          throw new Error("无法发送：未选择对话（请先选择角色和对话）");
        }
        // 每次发送前确认当前窗口身份仍绑定；后端重启/绑定漂移时不把 IDE 工具静默路由到其他实例。
        await this._bindCurrentChat(chatId);
        if (shouldRestoreChatConnection) this._chatService.connectChat(chatId);
        // 绑定及后续失败统一抛给顶层 operationError，不在此静默降级。
        const _mode = this._modeFor(chatId);
        console.log(`[P0-9] sendMessage: chat=${chatId} mode=${_mode}`);
        await this._chatService.setActiveMode(_mode);
        // ★ @文件引用：按配置的数量上限格式化路径，再由用户模板决定是否及如何附加提示。
        // 配置默认值由 package.json schema 供给；≤0=不限制，空模板=不附加提示。
        let enrichedReply = reply;
        if (fileReferences && fileReferences.length > 0) {
          const _config = vscode.workspace.getConfiguration("yonban");
          const _refLimit = _config.get<number>("maxFileReferences");
          const _refs = (typeof _refLimit === "number" && _refLimit > 0) ? fileReferences.slice(0, _refLimit) : fileReferences;
          const refList = _refs.map((r) => `@${r}`).join(", ");
          const _template = _config.get<string>("fileReferencePromptTemplate");
          if (typeof _template === "string" && _template.length > 0) {
            enrichedReply = reply + renderFileReferencePrompt(_template, refList);
          }
        }
        await this._chatService.sendMessage(chatId, enrichedReply, autoReply, files || []);
        // [0719 发送状态机·第三层] 显式成功信号：webview 发送按钮态改为事件驱动（删 3s 定时器），
        //   完成事件集 = sendMessageDone(此处) ∪ message_added(role=user, WS) ∪ operationError(顶层兜底)。
        //   WS 断连时 message_added 收不到，此直连信号保证按钮不卡死。
        this.postMessage({ type: "sendMessageDone" });
        break;
      }

      case "triggerReply": {
        const { charname } = (message.payload as { charname?: string }) ?? {};
        const chatId = this._chatService.currentChatId;
        if (!chatId) break;
        await this._bindCurrentChat(chatId);
        // 绑定及触发失败统一抛给顶层 operationError，不在此静默降级。
        const _mode = this._modeFor(chatId);
        console.log(`[P0-9] triggerReply: chat=${chatId} mode=${_mode}`);
        await this._chatService.setActiveMode(_mode);
        await this._chatService.triggerReply(chatId, charname);
        break;
      }

      case "stopGeneration": {
        const { messageId } = message.payload as { messageId: string };
        this._chatService.stopGeneration(messageId);
        break;
      }

      case "newChat": {
        // 失败经抛 → 顶层兜底 operationError toast（不在此自吞，否则新建失败用户无感）
        const { charName } = (message.payload as { charName?: string }) ?? {};
        const chatId = await this._chatService.createNewChat();
        if (charName) {
          await this._chatService.addCharacter(chatId, charName);
        }
        const list = await this._chatService.getChatList();
        this.postMessage({ type: "chatList", payload: list });
        this.postMessage({
          type: "newChatCreated",
          payload: { chatId, charName },
        });
        break;
      }

      case "deleteChat": {
        // 失败经抛 → 顶层兜底 operationError toast（不在此自吞）
        const { chatId: delChatId } = message.payload as { chatId: string };
        await this._chatService.deleteChat(delChatId);
        const list = await this._chatService.getChatList();
        this.postMessage({ type: "chatList", payload: list });
        this.postMessage({
          type: "chatDeleted",
          payload: { chatId: delChatId },
        });
        break;
      }

      case "editMessage": {
        const { chatId, messageId, indexHint, content, editOperationId } = message.payload as {
          chatId: string;
          messageId: string;
          indexHint: number;
          content: string;
          editOperationId: string;
        };
        if (!chatId || !messageId || !Number.isSafeInteger(indexHint) || indexHint < 0
          || typeof content !== "string" || !editOperationId) {
          this.postMessage({
            type: "editMessageResult",
            payload: {
              chatId, messageId, indexHint, editOperationId, success: false, applied: false,
              error: "编辑消息身份无效，请刷新对话后重试",
            },
          });
          return { actionNotifyHandled: true };
        }
        try {
          const result = await this._chatService.editMessage(
            chatId,
            indexHint,
            messageId,
            content,
            editOperationId,
          );
          if (result.applied !== true || result.chatCommitted !== true) {
            this.postMessage({
              type: "editMessageResult",
              payload: {
                ...result, chatId, messageId, indexHint, editOperationId, success: false,
                error: result.error || result.reason || "后端未提交编辑",
              },
            });
            return { actionNotifyHandled: true };
          }

          this.postMessage({
            type: "editMessageResult",
            payload: { ...result, chatId, messageId, indexHint, editOperationId, success: true },
          });
          this.postMessage({ type: "notify", payload: { message: ACTION_NOTIFY.editMessage } });

          const authoritativeEntryMissing = !result.entry || result.entry.id !== messageId;
          if (result.status === "committed_derived_failed" || authoritativeEntryMissing) {
            let warning = result.warning
              || (authoritativeEntryMissing
                ? "消息已提交，但响应缺少匹配的权威条目；正在刷新原对话。"
                : "消息已提交，但同步或广播至少一项失败；正在刷新原对话。");
            if (this._chatService.currentChatId === chatId) {
              try {
                const data = await this._chatService.getInitialData(chatId);
                this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } });
              } catch (refreshError: unknown) {
                warning += ` 刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`;
              }
            }
            this.postMessage({
              type: "operationWarning",
              payload: { action: "editMessage", warning, chatId, messageId },
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[YonBan] 编辑消息失败:", msg);
          this.postMessage({
            type: "editMessageResult",
            payload: { chatId, messageId, indexHint, editOperationId, success: false, applied: false, error: msg },
          });
        }
        return { actionNotifyHandled: true };
      }

      case "deleteMessage": {
        const { chatId, messageId, indexHint } = message.payload as {
          chatId: string;
          messageId: string;
          indexHint: number;
        };
        if (!chatId || !messageId || !Number.isInteger(indexHint) || indexHint < 0) {
          throw new Error("删除消息身份无效，请刷新对话后重试");
        }
        const result = await this._chatService.deleteMessage(chatId, indexHint, messageId);
        if (result.status === "committed_derived_failed") {
          const successNote = ACTION_NOTIFY.deleteMessage;
          if (successNote) this.postMessage({ type: "notify", payload: { message: successNote } });
          this.postMessage({
            type: "operationWarning",
            payload: {
              action: "deleteMessage",
              warning: "消息已删除，但删除后的备份、摘要或同步等至少一项处理失败；恢复/同步能力可能受损，请刷新核对。",
              derived: result.derived,
            },
          });
          try {
            const data = await this._chatService.getInitialData(chatId);
            this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } });
          } catch (refreshError: unknown) {
            const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
            console.error("[YonBan] 消息已删除，但删除后刷新核对失败:", detail);
            this.postMessage({
              type: "operationError",
              payload: { action: "删除后刷新", error: `消息已删除，但无法刷新核对当前对话: ${detail}` },
            });
          }
          return { actionNotifyHandled: true };
        }
        break;
      }

      case "hideMessage": {
        const { chatId, messageId, indexHint, hide } = message.payload as {
          chatId: string;
          messageId: string;
          indexHint: number;
          hide: boolean;
        };
        if (!chatId || !messageId || !Number.isInteger(indexHint) || indexHint < 0 || typeof hide !== "boolean") {
          throw new Error("隐藏消息身份无效，请刷新对话后重试");
        }
        const result = await this._chatService.hideMessage(chatId, indexHint, messageId, hide);
        if (result.success !== true || result.applied !== true || result.partial === true) {
          const reason = typeof result.error === "string"
            ? result.error
            : typeof result.code === "string" ? result.code : "后端未完整应用隐藏操作";
          throw new Error(reason);
        }
        try {
          const data = await this._chatService.getInitialData(chatId);
          this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } });
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "operationError",
            payload: { action: "hideMessageRefresh", error: `隐藏已应用，但权威消息刷新失败：${detail}` },
          });
        }
        break;
      }

      // ── 回档功能 ─────────────────────────────────
      // ★ P3 回档预览：只读查询文件层 Δ，供前端在确认前展示预览卡片。
      // 预览失败时回传固定身份与错误；前端不允许缺少预览令牌的执行请求。
      case "previewRollback": {
        const { chatId, anchorMessageId, targetIndex, afterCount } = message.payload as {
          chatId: string;
          anchorMessageId: string;
          targetIndex: number;
          afterCount: number;
        };
        const identity = { chatId, anchorMessageId, targetIndex, afterCount };
        if (!chatId || !anchorMessageId || !Number.isInteger(targetIndex) || targetIndex < 0 || !Number.isInteger(afterCount) || afterCount < 0) {
          this.postMessage({
            type: "rollbackPreview",
            payload: { ...identity, success: false, previewError: "回档预览身份无效，请刷新对话后重试" },
          });
          break;
        }
        try {
          await this._bindCurrentChat(chatId);
          const diff = await this._chatService.getRollbackPreview(chatId, {
            anchorMessageId,
            targetIndex,
            afterCount,
          });
          if (diff.success === true && (
            !isExactIdeRouteSnapshot(diff.expectedIdeRoute)
            || typeof diff.expectedIdeConnected !== "boolean"
            || diff.expectedIdeConnected !== diff.expectedIdeRoute.connected
          )) {
            this.postMessage({
              type: "rollbackPreview",
              payload: {
                ...identity,
                success: false,
                previewError: "后端回档预览缺少有效的 expectedIdeRoute 精确路由令牌",
              },
            });
            break;
          }
          this.postMessage({
            type: "rollbackPreview",
            payload: { ...diff, ...identity },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[YonBan] 回档预览失败:", msg);
          this.postMessage({
            type: "rollbackPreview",
            payload: { ...identity, success: false, previewError: msg },
          });
        }
        break;
      }

      case "rollbackToMessage": {
        const rollbackPayload = message.payload as {
          chatId: string;
          anchorMessageId: string;
          targetIndex: number;
          afterCount: number;
          expectedIdeConnected: boolean;
          expectedIdeRoute: IdeRouteSnapshot;
          checkpointIds: string[];
          tableSnapshotId: unknown;
        };
        const {
          chatId,
          anchorMessageId,
          targetIndex,
          afterCount,
          expectedIdeConnected,
          expectedIdeRoute,
          checkpointIds,
          tableSnapshotId,
        } = rollbackPayload;
        const identity = { chatId, anchorMessageId, targetIndex, afterCount };
        const hasTableSnapshotId = Object.prototype.hasOwnProperty.call(rollbackPayload, "tableSnapshotId");
        const hasExpectedIdeRoute = Object.prototype.hasOwnProperty.call(rollbackPayload, "expectedIdeRoute");
        if (
          !chatId ||
          !anchorMessageId ||
          !Number.isInteger(targetIndex) ||
          targetIndex < 0 ||
          !Number.isInteger(afterCount) ||
          afterCount < 0 ||
          typeof expectedIdeConnected !== "boolean" ||
          !hasExpectedIdeRoute ||
          !isExactIdeRouteSnapshot(expectedIdeRoute) ||
          expectedIdeConnected !== expectedIdeRoute.connected ||
          !Array.isArray(checkpointIds) ||
          checkpointIds.some((id) => typeof id !== "string" || id.length === 0) ||
          new Set(checkpointIds).size !== checkpointIds.length ||
          (tableSnapshotId !== null && (typeof tableSnapshotId !== "string" || tableSnapshotId.length === 0)) ||
          !hasTableSnapshotId
        ) {
          this.postMessage({
            type: "rollbackResult",
            payload: { ...identity, success: false, applied: false, error: "回档确认令牌无效，请重新预览" },
          });
          break;
        }
        try {
          await this._bindCurrentChat(chatId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this._reportIdeBindFailure(chatId, "执行回档前", err);
          this.postMessage({
            type: "rollbackResult",
            payload: { ...identity, success: false, applied: false, error: msg },
          });
          break;
        }
        let result: Record<string, unknown>;
        try {
          result = await this._chatService.rollbackToMessage(chatId, {
            anchorMessageId,
            targetIndex,
            afterCount,
            expectedIdeConnected,
            expectedIdeRoute,
            checkpointIds: [...checkpointIds],
            tableSnapshotId,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[YonBan] 回档响应未确认，执行状态未知:", msg);
          let reconcileError: string | null = null;
          try {
            const data = await this._chatService.getInitialData(chatId);
            this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } });
          } catch (reloadErr: unknown) {
            reconcileError = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
          }
          this.postMessage({
            type: "rollbackResult",
            payload: {
              ...identity,
              success: false,
              indeterminate: true,
              error: `回档响应未确认，执行状态未知：${msg}`,
              reconcileRequested: true,
              ...(reconcileError ? { reconcileError } : {}),
            },
          });
          break;
        }
        this.postMessage({
          type: "rollbackResult",
          payload: { ...result, ...identity },
        });
        // 只按后端显式终态判断是否可能已改变消息；不以 deleted 等计数字段推断成功。
        if (
          (result.success === true && result.applied === true && result.partial !== true) ||
          result.partial === true
        ) {
          try {
            const data = await this._chatService.getInitialData(chatId);
            this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } });
          } catch (reloadErr: unknown) {
            const detail = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
            this.postMessage({
              type: "operationError",
              payload: { action: "rollbackRefresh", error: `回档结果已返回，但权威消息刷新失败：${detail}` },
            });
          }
        }
        break;
      }

      // ── 预设/模式管理 ─────────────────────
      // getPresetConfig / switchPreset 的 case 分支统一在本 switch 下方通过 HTTP API 实现
      // （定位用 grep 'case "getPresetConfig"' / 'case "switchPreset"'，勿依赖行号）

      // ── Token 快照 + 压缩 ────────────
      case "getTokenSnapshot": {
        try {
          const snapshot = await this._chatService.getTokenSnapshot();
          this.postMessage({ type: "tokenSnapshot", payload: snapshot });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "tokenSnapshot",
            payload: { available: false, error: msg },
          });
        }
        break;
      }

      case "compactContext": {
        const cpPayload = message.payload as Record<string, unknown>;
        const cpAction = (cpPayload?.action as string) || "clearInjections";
        try {
          if (cpAction === "clearInjections") {
            const chatId = (cpPayload.chatId as string) || this._chatService.currentChatId || "";
            const result = await this._chatService.clearInjections({
              clearP1: cpPayload.clearP1 as boolean,
              clearWeb: cpPayload.clearWeb as boolean,
              clearTool: cpPayload.clearTool as boolean,
              chatId,
            });
            this.postMessage({ type: "compactResult", payload: { ...result, action: "clearInjections" } });
          } else if (cpAction === "fullCompact") {
            // 三步链对齐本体 executeFullCompact：①AI摘要 ②屏蔽旧对话(跳过keep_indices) ③注入摘要消息。
            // 原仅调 compactContext(只写摘要文件)，旧对话没屏蔽、摘要没注入=全量清理实际没压缩。
            const chatId = (cpPayload.chatId as string) || this._chatService.currentChatId || "";
            const keepLastN = cpPayload.keepLastN as number;
            const cp = await this._chatService.compactContext(
              cpPayload.chatHistory as string,
              cpPayload.messageCount as number,
              keepLastN,
            );
            if (cp && cp.success !== false && chatId) {
              const keepIndices = (cp.keep_indices as number[]) || [];
              const sc = await this._chatService.smartCleanChat(chatId, keepLastN, keepIndices);
              if (cp.summary) {
                await this._chatService.injectSummaryMessage(chatId, cp.summary as string, {
                  hiddenCount: (sc?.hidden as number) || 0,
                  originalChars: cp.originalChars as number,
                  summaryChars: cp.summaryChars as number,
                });
              }
            }
            this.postMessage({ type: "compactResult", payload: { ...cp, action: "fullCompact" } });
          } else if (cpAction === "cleanXmlTags") {
            const chatId = (cpPayload.chatId as string) || this._chatService.currentChatId || "";
            const result = await this._chatService.cleanXmlTags(chatId);
            this.postMessage({ type: "compactResult", payload: { ...result, action: "cleanXmlTags" } });
          } else if (cpAction === "cleanReadCache") {
            const chatId = (cpPayload.chatId as string) || this._chatService.currentChatId || "";
            const result = await this._chatService.cleanReadCache(
              cpPayload.paths as string[],
              chatId,
              cpPayload.chatLogIndices as number[],
            );
            this.postMessage({ type: "compactResult", payload: { ...result, action: "cleanReadCache" } });
          } else if (cpAction === "smartCleanChat") {
            const chatId = (cpPayload.chatId as string) || this._chatService.currentChatId || "";
            const result = await this._chatService.smartCleanChat(chatId, cpPayload.keepRecent as number);
            this.postMessage({ type: "compactResult", payload: { ...result, action: "smartCleanChat" } });
          } else if (cpAction === "deleteMessages") {
            const chatId = typeof cpPayload.chatId === "string" ? cpPayload.chatId.trim() : "";
            const anchorMessageId = typeof cpPayload.anchorMessageId === "string" ? cpPayload.anchorMessageId.trim() : "";
            if (!chatId || !anchorMessageId) {
              throw new Error("范围删除缺少冻结的 chatId 或 anchorMessageId，已拒绝按索引执行");
            }
            const result = await this._chatService.deleteMessageRange(
              chatId,
              anchorMessageId,
              cpPayload.startIndex as number,
              cpPayload.endIndex as number,
            );
            const failureDetail = result.success === true && result.applied === true && result.partial !== true
              ? null
              : typeof result.error === "string" ? result.error
              : typeof result.reason === "string" ? result.reason
              : "后端未完整应用范围删除";
            this.postMessage({
              type: "compactResult",
              payload: { ...result, ...(failureDetail ? { error: failureDetail } : {}), action: "deleteMessages" },
            });
          } else if (cpAction === "hideCloneMessages") {
            const chatId = (cpPayload.chatId as string) || this._chatService.currentChatId || "";
            const result = await this._chatService.hideCloneMessages(chatId);
            this.postMessage({ type: "compactResult", payload: { ...result, action: "hideCloneMessages" } });
          } else {
            const result = await this._chatService.clearInjections();
            this.postMessage({ type: "compactResult", payload: result });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "compactResult",
            payload: { success: false, error: msg, action: cpAction },
          });
        }
        break;
      }

      // ── 三对等（壳层中转，后端 action 全在本体 beilu-memory）──
      case "hideContextNoise": {
        try {
          const p = (message.payload || {}) as { chatId?: string; keepLast?: number };
          const chatId = p.chatId || this._chatService.currentChatId || "";
          const result = await this._chatService.hideContextNoise(chatId, p.keepLast ?? 2);
          this.postMessage({ type: "compactResult", payload: { ...result, action: "hideContextNoise" } });
        } catch (err: unknown) {
          this.postMessage({ type: "compactResult", payload: { error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      case "listFlowGroups": {
        try {
          const result = await this._chatService.listFlowGroups();
          this.postMessage({ type: "flowGroupList", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "flowGroupList", payload: { success: false, error: err instanceof Error ? err.message : String(err), groups: [] } });
        }
        break;
      }

      case "startFlowGroup": {
        try {
          const p = (message.payload || {}) as { filename?: string };
          const result = await this._chatService.startFlowGroup(p.filename || "");
          this.postMessage({ type: "flowGroupStarted", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "flowGroupStarted", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      case "deleteFlowGroup": {
        try {
          const p = (message.payload || {}) as { filename?: string };
          const result = await this._chatService.deleteFlowGroup(p.filename || "");
          this.postMessage({ type: "flowGroupChanged", payload: { ...result, op: "delete" } });
        } catch (err: unknown) {
          this.postMessage({ type: "flowGroupChanged", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      case "saveFlowGroup": {
        try {
          const p = (message.payload || {}) as { name?: string; steps?: Array<Record<string, unknown>>; auto_advance?: boolean; modeGroup?: string };
          const result = await this._chatService.saveFlowGroup(p.name || "", p.steps || [], p.auto_advance !== false);
          this.postMessage({ type: "flowGroupChanged", payload: { ...result, op: "save" } });
        } catch (err: unknown) {
          this.postMessage({ type: "flowGroupChanged", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      case "updateFlowGroup": {
        try {
          const p = (message.payload || {}) as { filename?: string; update?: Record<string, unknown> };
          const result = await this._chatService.updateFlowGroup(p.filename || "", p.update || {});
          this.postMessage({ type: "flowGroupChanged", payload: { ...result, op: "update" } });
        } catch (err: unknown) {
          this.postMessage({ type: "flowGroupChanged", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      // v4 §4: 组管理 API 转发（webview CSP 不允许直接 XHR）
      case "listGroups": {
        try {
          const result = await this._chatService.listGroups();
          const cbId = (message.payload as Record<string, unknown>)?._callbackId;
          this.postMessage({ type: "groupApiResult", payload: { ...result, _callbackId: cbId } });
        } catch (err: unknown) {
          const cbId = (message.payload as Record<string, unknown>)?._callbackId;
          this.postMessage({ type: "groupApiResult", payload: { error: err instanceof Error ? err.message : String(err), _callbackId: cbId } });
        }
        break;
      }
      case "groupAction": {
        try {
          const p = (message.payload || {}) as { action?: string; body?: Record<string, unknown>; _callbackId?: string };
          const result = await this._chatService.groupAction(p.action || "", p.body || {});
          this.postMessage({ type: "groupApiResult", payload: { ...result, _callbackId: p._callbackId } });
        } catch (err: unknown) {
          const p = (message.payload || {}) as { _callbackId?: string };
          this.postMessage({ type: "groupApiResult", payload: { error: err instanceof Error ? err.message : String(err), _callbackId: p._callbackId } });
        }
        break;
      }

      case "listCheckpoints": {
        try {
          const result = await this._chatService.listCheckpoints();
          this.postMessage({ type: "checkpointList", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "checkpointList", payload: { success: false, error: err instanceof Error ? err.message : String(err), checkpoints: [] } });
        }
        break;
      }

      case "getCheckpointFileDiff": {
        try {
          const p = (message.payload || {}) as { id?: string };
          const result = await this._chatService.getCheckpointFileDiff(p.id || "");
          this.postMessage({ type: "checkpointDiff", payload: { id: p.id, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "checkpointDiff", payload: { success: false, error: err instanceof Error ? err.message : String(err), files: [] } });
        }
        break;
      }

      case "revertCheckpoint": {
        try {
          const p = (message.payload || {}) as { id?: string };
          const result = await this._chatService.revertCheckpoint(p.id || "");
          this.postMessage({ type: "checkpointReverted", payload: { id: p.id, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "checkpointReverted", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      // ── B3/Y6 权限档位外显 ──
      case "getPermissionLevel": {
        try {
          const result = await this._chatService.getPermissionLevel();
          this.postMessage({ type: "permissionLevel", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "permissionLevel", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      // ── F6/Y5 审批跳过规则管理（列/删，后端 ide_approval_rules.json 单一权威）──
      case "getApprovalRules": {
        try {
          const result = await this._chatService.getApprovalRules();
          this.postMessage({ type: "approvalRulesList", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "approvalRulesList", payload: { success: false, error: err instanceof Error ? err.message : String(err), rules: [] } });
        }
        break;
      }

      case "removeApprovalRule": {
        try {
          const p = (message.payload || {}) as { tool?: string; pathPrefix?: string };
          const result = await this._chatService.removeApprovalRule(p.tool || "", p.pathPrefix || "");
          this.postMessage({ type: "approvalRulesList", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "approvalRulesList", payload: { success: false, error: err instanceof Error ? err.message : String(err), rules: [] } });
        }
        break;
      }

      // ── F3/Y2 任务打勾（壳层中转，后端 taskStore 单一权威；chatid 取当前连接会话）──
      case "getTasks": {
        try {
          const chatId = this._chatService.currentChatId || "";
          const result = await this._chatService.getTasks(chatId);
          this.postMessage({ type: "taskList", payload: { chatid: chatId, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "taskList", payload: { success: false, error: err instanceof Error ? err.message : String(err), tasks: [] } });
        }
        break;
      }

      case "planTasks": {
        try {
          const p = (message.payload || {}) as { tasks?: Array<Record<string, unknown>> };
          const chatId = this._chatService.currentChatId || "";
          const result = await this._chatService.planTasks(chatId, p.tasks || []);
          this.postMessage({ type: "taskList", payload: { chatid: chatId, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "taskList", payload: { success: false, error: err instanceof Error ? err.message : String(err), tasks: [] } });
        }
        break;
      }

      case "checkTask": {
        try {
          const p = (message.payload || {}) as { id?: string; status?: string };
          const chatId = this._chatService.currentChatId || "";
          const result = await this._chatService.checkTask(chatId, p.id || "", p.status);
          this.postMessage({ type: "taskList", payload: { chatid: chatId, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "taskList", payload: { success: false, error: err instanceof Error ? err.message : String(err), tasks: [] } });
        }
        break;
      }

      case "updateTask": {
        try {
          const p = (message.payload || {}) as { id?: string; content?: string; priority?: string };
          const chatId = this._chatService.currentChatId || "";
          const result = await this._chatService.updateTask(chatId, p.id || "", { content: p.content, priority: p.priority });
          this.postMessage({ type: "taskList", payload: { chatid: chatId, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "taskList", payload: { success: false, error: err instanceof Error ? err.message : String(err), tasks: [] } });
        }
        break;
      }

      case "deleteTask": {
        try {
          const p = (message.payload || {}) as { id?: string };
          const chatId = this._chatService.currentChatId || "";
          const result = await this._chatService.deleteTask(chatId, p.id || "");
          this.postMessage({ type: "taskList", payload: { chatid: chatId, ...result } });
        } catch (err: unknown) {
          this.postMessage({ type: "taskList", payload: { success: false, error: err instanceof Error ? err.message : String(err), tasks: [] } });
        }
        break;
      }

      case "getReadCache": {
        try {
          const cache = await this._chatService.getReadCache();
          this.postMessage({ type: "readCacheData", payload: cache });
        } catch (err: unknown) {
          this.postMessage({ type: "readCacheData", payload: [] });
        }
        break;
      }

      // ── 模型相关 ──────────────────────
      case "switchModel": {
        const { modelName: mdlName } = message.payload as { modelName: string };
        try {
          await this._chatService.switchModel(mdlName);
        } catch (err: unknown) {
          console.error("[YonBan] 切换模型失败:", err);
        }
        break;
      }

      case "getModelList": {
        try {
          const mlPl = message.payload as Record<string, string> | undefined;
          const apiUrl = mlPl?.url || "";
          const apiKey = mlPl?.key || "";

          if (apiUrl || apiKey) {
            const result = await this._chatService.getModelList({ url: apiUrl, key: apiKey });
            this.postMessage({ type: "modelList", payload: result });
          } else if (mlPl?.sourceName) {
            // ★ 修复模型列表加载失败（D3）：直接把 sourceName 交给后端 getModels，由后端读源配置
            //   （嵌套 config）。此前 YonBan 走「getApiSourceConfig → 前端解析 url/key」迂回，且读顶层
            //   字段（实际嵌套在 config 下）恒 undefined → apiUrl 空 → 永远「无API源配置」→ 模型列表加载失败。
            const result = await this._chatService.getModelListBySource(mlPl.sourceName);
            this.postMessage({ type: "modelList", payload: result });
          } else {
            this.postMessage({ type: "modelList", payload: { models: [], error: "无API源配置" } });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "modelList", payload: { error: msg } });
        }
        break;
      }

      // ── 记忆预设配置 + P1/P8 状态 ─────────
      case "getMemoryConfig": {
        try {
          const config = await this._chatService.getMemoryConfig();
          this.postMessage({ type: "memoryConfig", payload: config });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "memoryConfig",
            payload: { error: msg },
          });
        }
        break;
      }

      case "toggleMemoryPreset": {
        const { presetId, enabled } = message.payload as {
          presetId: string;
          enabled: boolean;
        };
        try {
          await this._chatService.toggleMemoryPreset(presetId, enabled);
          const config = await this._chatService.getMemoryConfig();
          this.postMessage({ type: "memoryConfig", payload: config });
        } catch (err: unknown) {
          console.error("[YonBan] 切换记忆预设失败:", err);
        }
        break;
      }

      // ★ BUG#5 修复：IN系列（INJ-1/INJ-2/INJ-3）使用独立的 toggleInjectionPrompt 消息
      case "toggleInjectionPrompt": {
        const { injectionId, enabled: injEnabled } = message.payload as {
          injectionId: string;
          enabled: boolean;
        };
        try {
          await this._chatService.toggleInjectionPrompt(injectionId, injEnabled);
          const config = await this._chatService.getMemoryConfig();
          this.postMessage({ type: "memoryConfig", payload: config });
        } catch (err: unknown) {
          console.error("[YonBan] 切换注入提示词失败:", err);
        }
        break;
      }

      case "getMemoryAIOutput": {
        const { sinceId } = (message.payload as { sinceId?: number }) ?? {};
        try {
          const output = await this._chatService.getMemoryAIOutput(sinceId);
          this.postMessage({ type: "memoryAIOutput", payload: output });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "memoryAIOutput",
            payload: { error: msg },
          });
        }
        break;
      }

      // ── 子模式动态管理 ──────────────────────────
      case "getSubModes": {
        try {
          const result = await this._chatService.getSubModes();
          this.postMessage({ type: "subModesConfig", payload: result });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "subModesConfig", payload: { error: msg } });
        }
        break;
      }

      case "saveSubModes": {
        const { subModes: smList } = message.payload as { subModes: unknown[] };
        try {
          const result = await this._chatService.saveSubModes(smList);
          this.postMessage({ type: "subModesConfig", payload: result });
        } catch (err: unknown) {
          console.error("[YonBan] 保存子模式失败:", err);
          throw err; // 对齐 saveClones T021 范式：rethrow 交顶层兜底（:210 operationError→前端 toast）——原局部吞错后顶层照发「已保存」notify=纯假成功
        }
        break;
      }

      case "setActiveSubMode": {
        const { id: smId, chatId: smChatId } = message.payload as { id: string; chatId?: string };
        try {
          const result = await this._chatService.setActiveSubMode(smId, smChatId);
          this.postMessage({ type: "subModesConfig", payload: result });
        } catch (err: unknown) {
          console.error("[YonBan] 设置活跃子模式失败:", err);
          throw err; // 对齐 saveClones T021 范式：rethrow 交顶层兜底（operationError→前端 toast），禁局部吞错假成功
        }
        break;
      }

      // ── 分身AI管理 (W65) ──────────────────
      case "getClones": {
        try {
          const result = await this._chatService.getClones();
          this.postMessage({ type: "clonesConfig", payload: result });
        } catch (err: unknown) {
          this.postMessage({ type: "clonesConfig", payload: { clones: [], error: String(err) } });
        }
        break;
      }
      case "saveClones": {
        try {
          const pl = message.payload as { clones: unknown[] };
          await this._chatService.saveClones(pl.clones);
        } catch (err: unknown) {
          console.warn("[YonBan] saveClones failed:", err);
          throw err; // T021：rethrow 交顶层兜底（:210 operationError→前端 toast）——原局部吞错把统一报错机制短路，用户保存分身配置丢失无感
        }
        break;
      }
      case "stopCloneTask": {
        // [0724 分身可停·002] 分身进度面板 ⏹ → 后端 SetData stopCloneTask（cloneAbort 触发该任务
        //   AbortController）。终态 stopped 由后端 clone_status 广播回流面板，本 case 不预写状态。
        try {
          const pl = (message.payload || {}) as { taskId?: string };
          const chatId = this._chatService.currentChatId || "";
          const r = await this._chatService.stopCloneTask(chatId, pl.taskId);
          const aborted = (r as { aborted?: number })?.aborted ?? 0;
          if (!aborted) this.postMessage({ type: "operationError", payload: { action: "stopCloneTask", error: `分身#${pl.taskId ?? "(全部)"} 未匹配到在跑任务（可能已结束）` } });
        } catch (err: unknown) {
          console.warn("[YonBan] stopCloneTask failed:", err);
          throw err; // T021：rethrow 交顶层兜底（operationError→前端 toast）
        }
        break;
      }


      // ── 提示词查看器 ──────────────────────
      case "buildPrompt": {
        const chatId = this._chatService.currentChatId;
        if (!chatId) {
          this.postMessage({
            type: "promptData",
            payload: { error: "没有活跃的聊天" },
          });
          break;
        }
        try {
          // 0715 查看器纯读化（凛倾0714「切换预设选择查看提示词之后会强制变成上一个预设」根因）：
          //   原先此处 setActiveMode(_modeFor(chatId)) 把写操作混进纯读流程——switchMode 返回
          //   bound_preset 后 setActiveMode 内无条件联动 switch_preset（ChatService D2 补发），
          //   用户在子模式里刚选的预设被模式绑定默认预设覆盖=「强制改回」。
          //   fake-send 后端按 per-chat 绑定链自行解析模式（同 getTokenSnapshot 用法，从不预推模式），
          //   查看=纯读，删除该写调用。
          const data = await this._chatService.fakeSend(chatId);
          this.postMessage({ type: "promptData", payload: data });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "promptData",
            payload: { error: msg },
          });
        }
        break;
      }

      // ── API 源列表 ─────────────────────────────
      case "getApiSourceList": {
        try {
          const list = await this._chatService.getApiSourceList();
          this.postMessage({ type: "apiSourceList", payload: { list } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({
            type: "apiSourceList",
            payload: { list: [], error: msg },
          });
        }
        break;
      }

      case "switchApiSource": {
        const { sourceName, charNames } = message.payload as {
          sourceName: string;
          charNames: string[];
        };
        try {
          await this._chatService.switchApiSource(sourceName, charNames);
          this.postMessage({
            type: "apiSourceSwitched",
            payload: { sourceName, success: true },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[YonBan] 切换 API 源失败:", msg);
          this.postMessage({
            type: "apiSourceSwitched",
            payload: { sourceName, success: false, error: msg },
          });
        }
        break;
      }

      // ── 反馈系统：宿主错误积压补拉（实时走 hostError 推送，这里只管 webview 建立前的积压）──
      case "getHostErrors": {
        const backlog = (this.consoleCapture?.getBuffer() ?? [])
          .filter((e) => e.level === "error" || e.level === "warn")
          .slice(-ERROR_CENTER_MAX);
        this.postMessage({ type: "hostErrorBacklog", payload: { entries: backlog } });
        break;
      }

      // ── 连接诊断器 ────────────────────────
      case "getConnectionDiag": {
        const diagPayload = {
          http: {
            status: this._connectionService.state.status,
            serverUrl: this._connectionService.state.serverUrl,
          },
          auth: {
            authenticated: this._authService.isAuthenticated,
            username: this._connectionService.state.username || null,
          },
          wsServer: {
            running: this._wsServer.isRunning,
            port: this._wsServer.port,
            clients: this._wsServer.clientCount,
          },
          chatWs: {
            connected: this._chatService.isChatConnected,
            chatId: this._chatService.currentChatId,
          },
        };
        this.postMessage({ type: "connectionDiag", payload: diagPayload });
        break;
      }

      // ── 运行时参数（提示词后处理/预填充） ──────
      case "getRuntimeParams": {
        // 错误经 fetchOk 抛 → 顶层 onDidReceiveMessage 兜底 operationError toast（单一 chokepoint，不在此自吞）
        const serverUrl = this._connectionService.state.serverUrl;
        const resp = await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/runtime-params`, { timeoutMs: PROVIDER_TIMEOUT_MS, action: "获取运行参数" });
        this.postMessage({ type: "runtimeParams", payload: await resp.json() });
        break;
      }

      case "setRuntimeParams": {
        const serverUrl = this._connectionService.state.serverUrl;
        await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/runtime-params`, {
          method: "POST", body: message.payload || {}, jsonBody: true, timeoutMs: PROVIDER_TIMEOUT_MS, action: "保存运行参数",
        });
        break;
      }

      // ── display regex 规则 ─────────────────────────
      case "getRegexRules": {
        try {
          const regexData = await this._chatService.getRegexConfig();
          this.postMessage({ type: "regexRules", payload: regexData });
        } catch (e: unknown) {
          this.postMessage({ type: "regexRules", payload: { rules: [], enabled: false } });
        }
        break;
      }

      // ── 思维链标签配置（从 beilu-memory 配置同步） ──
      case "getThinkingTags": {
        try {
          const tags = await this._chatService.getThinkingTags();
          this.postMessage({ type: "thinkingTagsConfig", payload: { tags } });
        } catch (e: unknown) {
          // 失败时不推送——webview 侧保持默认值 ["thinking", "think"]
        }
        break;
      }

      // 注：webview 发送形态是顶层字段 { type, builtin, tags }（chat.js reasoning 设置浮窗保存处），
      // 非 payload 嵌套——从 message 顶层解构是正确的（T027 校准：旧 BUG 注释误判，代码本就匹配）。
      // 失败经抛 → 顶层兜底 operationError toast（不在此自吞）。
      //   原自带 try/catch 把错误包成 "updateReasoningConfigResult" 推送——webview 全库零接收方
      //   （2026-07-15 消息契约 diff 确诊）：保存失败=用户零反馈、以为已保存。删自造孤儿 type，对齐统一错误通道。
      case "updateReasoningConfig": {
        const { builtin, tags } = message as unknown as { builtin: { think?: boolean; thinking?: boolean }; tags: Array<{ open: string; close: string }> };
        await this._chatService.updateReasoningConfig(builtin || {}, tags || []);
        const updatedTags = await this._chatService.getThinkingTags();
        this.postMessage({ type: "thinkingTagsConfig", payload: { tags: updatedTags } });
        break;
      }

      // ── 预设管理 ────────────────────────────────
      case "getPresetConfig": {
        const serverUrl = this._connectionService.state.serverUrl;
        const resp = await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/getdata`, { timeoutMs: PROVIDER_TIMEOUT_MS, action: "获取预设配置" });
        this.postMessage({ type: "presetConfig", payload: await resp.json() });
        break;
      }

      case "switchPreset": {
        const serverUrl = this._connectionService.state.serverUrl;
        const pl = message.payload as Record<string, string> | undefined;
        await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/setdata`, {
          method: "POST", jsonBody: true, timeoutMs: PROVIDER_TIMEOUT_MS, action: "切换预设",
          body: { switch_preset: { name: pl?.name || pl?.presetName, chatid: pl?.chatid || pl?.chatId || undefined, mode: pl?.mode || undefined } },
        });
        // 切换成功后刷新配置（best-effort：已切换，刷新失败不回退/不报错）
        const resp2 = await this._authService.fetchWithAuth(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/getdata`, { timeoutMs: PROVIDER_TIMEOUT_MS });
        if (resp2.ok) this.postMessage({ type: "presetConfig", payload: await resp2.json() });
        break;
      }

      // ── 预设生命周期管理 ────────────────
      case "createPreset":
      case "duplicatePreset":
      case "renamePreset":
      case "deletePreset": {
        const serverUrl = this._connectionService.state.serverUrl;
        const pl = message.payload as Record<string, string> | undefined;
        let body: Record<string, unknown> = {};
        if (message.type === "createPreset") body = { create_preset: { name: pl?.name } };
        else if (message.type === "duplicatePreset") body = { duplicate_preset: { name: pl?.name } };
        else if (message.type === "renamePreset") body = { rename_preset: { old_name: pl?.oldName, new_name: pl?.newName } };
        else if (message.type === "deletePreset") body = { delete_preset: { name: pl?.name } };
        await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/setdata`, {
          method: "POST", body, jsonBody: true, timeoutMs: PROVIDER_TIMEOUT_MS, action: message.type,
        });
        // 刷新预设列表（best-effort）
        const resp2 = await this._authService.fetchWithAuth(serverUrl, `${serverUrl}/api/parts/plugins:beilu-preset/config/getdata`, { timeoutMs: PROVIDER_TIMEOUT_MS });
        if (resp2.ok) this.postMessage({ type: "presetConfig", payload: await resp2.json() });
        break;
      }

      // ── AI 控制面板（文件权限） ────────────────
      case "getFilesConfig": {
        const serverUrl = this._connectionService.state.serverUrl;
        const resp = await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-files/config/getdata`, { timeoutMs: PROVIDER_TIMEOUT_MS, action: "获取文件权限" });
        this.postMessage({ type: "filesConfig", payload: await resp.json() });
        break;
      }

      case "setFilesConfig": {
        const serverUrl = this._connectionService.state.serverUrl;
        await this._authService.fetchOk(serverUrl, `${serverUrl}/api/parts/plugins:beilu-files/config/setdata`, {
          method: "POST", body: message.payload || {}, jsonBody: true, timeoutMs: PROVIDER_TIMEOUT_MS, action: "保存文件权限",
        });
        break;
      }

      // ── 联网搜索开关（0714 读写同源修：真源 = beilu-memory per-char config.web_search，
      //    与本体前端联网设置同一读写口；原走 beilu-files 白名单无此字段 = 写入即丢 + 刷新回落）──
      case "getWebSearch": {
        try {
          // 专用读动作（带 chatid → 后端解析当前 chat 角色，per-char 读写同源；getMemoryConfig 无
          // char 上下文会落 _global 与写侧分叉）
          const data = await this._chatService.getWebSearchConfig();
          this.postMessage({ type: "webSearchState", payload: { web_search: (data as { web_search?: unknown })?.web_search ?? {} } });
        } catch (err: unknown) {
          this.postMessage({ type: "webSearchState", payload: { success: false, error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }
      case "setWebSearch": {
        const pl = message.payload as { enabled?: boolean } | undefined;
        await this._chatService.setWebSearchEnabled(!!pl?.enabled);
        break;
      }

      // ── AI 提问 dock 答题回传（0714 Kilo 式改道，配对 handleAiQuestion）────
      case "aiQuestionAnswer": {
        const pl = message.payload as { id?: string; answer?: string; answered?: boolean } | undefined;
        if (pl?.id) this._resolveAiQuestion(pl.id, pl.answer || "", pl.answered !== false);
        break;
      }

      // ── IDE 写操作审批 ────────────────────────
      case "getIdeApprovals": {
        try {
          const data = await this._chatService.getIdeApprovals();
          this.postMessage({ type: "ideApprovals", payload: data });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "ideApprovals", payload: { success: false, error: msg, pendingApprovals: [] } });
        }
        break;
      }

      case "approveIdeOp": {
        try {
          const pl = message.payload as Record<string, string> | undefined;
          const opId = pl?.opId ?? "";
          const result = await this._chatService.approveIdeOp(opId);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "approve", opId, ...result } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "approve", success: false, error: msg } });
        }
        break;
      }

      case "rejectIdeOp": {
        try {
          const pl = message.payload as Record<string, string> | undefined;
          const opId = pl?.opId ?? "";
          const result = await this._chatService.rejectIdeOp(opId);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "reject", opId, ...result } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "reject", success: false, error: msg } });
        }
        break;
      }

      case "approveAllIdeOps": {
        try {
          const result = await this._chatService.approveAllIdeOps();
          this.postMessage({ type: "ideApprovalResult", payload: { action: "approveAll", ...result } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "approveAll", success: false, error: msg } });
        }
        break;
      }

      case "rejectAllIdeOps": {
        try {
          const result = await this._chatService.rejectAllIdeOps();
          this.postMessage({ type: "ideApprovalResult", payload: { action: "rejectAll", ...result } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "rejectAll", success: false, error: msg } });
        }
        break;
      }

      // ★ F6「此类不再问」：派生 (tool, 路径前缀) 规则落 per-user settings，并拒掉该 op 出队。
      case "addApprovalSkipRule": {
        try {
          const pl = message.payload as Record<string, string> | undefined;
          const opId = pl?.opId ?? "";
          const result = await this._chatService.addApprovalSkipRule(opId);
          // 同时把这条 op 出队（语义：这类别再拦，当前这条也不必继续等）
          if (opId) {
            try { await this._chatService.rejectIdeOp(opId); } catch { /* 出队失败不影响规则已落盘 */ }
          }
          this.postMessage({ type: "ideApprovalResult", payload: { action: "skipRule", opId, ...result } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: "ideApprovalResult", payload: { action: "skipRule", success: false, error: msg } });
        }
        break;
      }

      // H2: webview 重连后回发，带本地已持有的服务端绝对消息数 → 增量补拉断线期漏掉的消息
      case "requestMissedMessages": {
        const rmPayload = message.payload as { chatId?: string; localServerCount?: number };
        const chatId = rmPayload.chatId || this._chatService.currentChatId;
        if (!chatId) break;
        try {
          const { serverLength, missed } = await this._chatService.getMissedMessages(
            chatId,
            rmPayload.localServerCount ?? 0,
          );
          if (missed.length > 0) {
            this.postMessage({
              type: "missedMessages",
              payload: { chatId, serverLength, missed },
            });
          }
        } catch (err) {
          console.warn("[YonBan] 补拉漏掉消息失败:", err);
        }
        break;
      }

      case "revealFile": {
        const rvPayload = message.payload as { path: string; line: number };
        try {
          const uri = vscode.Uri.file(rvPayload.path);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
          const lineIdx = Math.max(0, (rvPayload.line || 1) - 1);
          const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
            isWholeLine: true,
          });
          editor.setDecorations(decoration, [range]);
          setTimeout(() => decoration.dispose(), 3000);
        } catch (err: unknown) {
          throw err; // T021：rethrow 交顶层兜底 operationError——用户点击定位文件失败原静默，现前端可见
        }
        break;
      }
      default:
        console.warn("[YonBan] 未知 Webview 消息:", message.type);
        // Cursor 无 F12：未知命令也回 operationError → 前端 ❌toast，避免「点按钮完全无反应无报错」
        // （如 auxiliary 辅助AI 面板：后端功能已下线，webview 残留按钮发 getAuxiliaryConfig/saveAuxiliaryConfig
        //  落此 default → 此前只 console.warn 用户无感；现给 toast 告知功能已下线/版本不匹配）。
        this.postMessage({
          type: "operationError",
          payload: { action: String(message.type), error: `未知命令「${message.type}」：该功能可能已下线，或面板与扩展版本不匹配` },
        });
    }
  }

  /** [多窗时序 0726] 切换代号（并发 switchChat 竞态闸，见 switchChat case 注释）。 */
  private _switchEpoch = 0;

  /** WS重连/面板恢复时同步可能遗漏的消息（chatResync handler 只补消息，不应用 config）。 */
  private async _resyncChat(): Promise<void> {
    const chatId = this._chatService.currentChatId;
    if (!chatId) return;
    try {
      const data = await this._chatService.getInitialData(chatId);
      this.postMessage({ type: "chatResync", payload: { ...data, chatId } }); // 带归属 id（与 chatInitialData 同约）
    } catch (err) {
      console.warn("[YonBan] resync失败:", err);
    }
  }

  /** 当前会话 config（角色等）被他端改 → 推 chatInitialData（onChatInitialData 真应用 charlist+messages）。 */
  private async _refreshChatInitialData(): Promise<void> {
    const chatId = this._chatService.currentChatId;
    if (!chatId) return;
    try {
      const data = await this._chatService.getInitialData(chatId);
      // [多窗时序 0726] await 期间可能已切走：带发起时的 chatId，消费端按归属校验（陈旧推送不再渲进新对话视图）
      this.postMessage({ type: "chatInitialData", payload: { ...data, chatId } });
    } catch (err) {
      console.warn("[YonBan] config 刷新失败:", err);
    }
  }

  /** 向 Webview 发送消息（public：extension.ts 等外部串联点需用，如 editRecord 推送） */
  // ── AI 提问 Kilo 式改道（0714）────────────────────────────
  // 悬浮窗(showInputBox)技术档案留档：问题去_全链诊断_20260714_1900/recon_悬浮窗技术档案与Kilo形态.md；
  // 原路径代码保留在 IdeWsServer 默认分支（onQuestion 未注入时仍走 InputBox=天然回退）。
  private _pendingQuestions = new Map<string, (answer: string | null) => void>();

  /** AI 提问：聊天流 dock 答题 + 非模态通知提醒（不阻塞不弹模态窗）。webview 不可用 → 回退原 InputBox。 */
  public async handleAiQuestion(id: string, text: string): Promise<string | null> {
    if (!this._view) {
      // webview 未创建 → 回退 VSCode 原生输入框（与 IdeWsServer 默认路径同款，保证提问不丢）
      const answer = await vscode.window.showInputBox({
        title: t("beilu AI 提问"),
        prompt: text,
        placeHolder: t("请输入回答..."),
        ignoreFocusOut: true,
      });
      return answer ?? null;
    }
    return new Promise<string | null>((resolve) => {
      this._pendingQuestions.set(id, resolve);
      this.postMessage({ type: "aiQuestion", payload: { id, text } });
      // 非模态提醒（右下角通知，不打断编辑；「去回答」聚焦面板，「忽略」立即答复 AI 未回答）
      const btnAnswer = t("去回答");
      const btnIgnore = t("忽略");
      void vscode.window.showInformationMessage(
        t("beilu AI 提问: ${preview}", { preview: text.length > 120 ? text.slice(0, 120) + "…" : text }),
        btnAnswer, btnIgnore,
      ).then((pick) => {
        if (pick === btnAnswer) {
          void vscode.commands.executeCommand("yonban.panel.focus");
        } else if (pick === btnIgnore) {
          const r = this._pendingQuestions.get(id);
          if (r) {
            this._pendingQuestions.delete(id);
            this.postMessage({ type: "aiQuestionClosed", payload: { id } });
            r(null);
          }
        }
      });
    });
  }

  /** webview 答题回传（chat.js aiQuestion dock → 此处 resolve 挂起的 WS question）。 */
  private _resolveAiQuestion(id: string, answer: string, answered: boolean): void {
    const r = this._pendingQuestions.get(id);
    if (!r) return;
    this._pendingQuestions.delete(id);
    r(answered ? answer : null);
  }

  public postMessage(message: WebviewMessage): void {
    this._view?.webview.postMessage(message);
  }

  /** 从外部推送 WS 客户端数量变化（extension.ts 调用） */
  public postWsClientCount(count: number): void {
    this.postMessage({
      type: "wsStatus",
      payload: {
        running: this._wsServer.isRunning,
        port: this._wsServer.port,
        clients: count,
      },
    });
  }

  /**
   * 生成 Webview HTML
   * V2 重构：两视图（聊天 + 设置），参考 Kilo Code 布局
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "chat.css"),
    );

    // 模块化 JS 文件 URI
    const coreJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "chat-core.js"),
    );
    const errorsJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "chat-errors.js"),
    );
    const connectionJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "webview-ui",
        "chat-connection.js",
      ),
    );
    const messagesJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "chat-messages.js"),
    );
    const modesJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "chat-modes.js"),
    );
    const settingsJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "webview-ui",
        "chat-settings.js",
      ),
    );
    const promptViewerJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "webview-ui",
        "chat-prompt-viewer.js",
      ),
    );
    const diagnosticsJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "webview-ui",
        "chat-diagnostics.js",
      ),
    );
    const mainJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "chat.js"),
    );
    const vendorMarkdownJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "vendor-markdown.js"),
    );
    // [0719 流式渲染增量化·跳A] morphdom（与本体 StreamRenderer 同源 vendor 拷贝）：
    // 流式帧 DOM diff 更新替代整树 innerHTML 重建
    const morphdomJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "morphdom.min.js"),
    );

    // 覆盖式 i18n（beilu 多语言体系）：中文=本体不加载任何 locale；外语=静态 locale JS（CSP 禁内联，
    // 字典经 window.YB_DICT/YB_LANG 由 locales/{lang}.js 定义）+ i18n.js 覆盖层，按 VSCode 显示语言选择
    const vsLang = vscode.env.language.toLowerCase();
    const uiLang = vsLang.startsWith("zh-tw") || vsLang.startsWith("zh-hant") ? "zh-TW"
      : vsLang.startsWith("zh") ? "zh-cn"
      : vsLang.startsWith("ja") ? "ja"
      : "en";
    let i18nScripts = "";
    if (uiLang !== "zh-cn") {
      const localeJs = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "webview-ui", "locales", `${uiLang}.js`),
      );
      const i18nJs = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "webview-ui", "i18n.js"),
      );
      i18nScripts = `<script src="${localeJs}"></script>\n    <script src="${i18nJs}"></script>`;
    }

    const serverUrl =
      this._connectionService.state.serverUrl || this._connectionService.getServerUrl();

    return /*html*/ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} ${serverUrl} data:;">
    <title>YonBan</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<!-- data-default-mode：DEFAULT_MODE 单源注入（原 inline script 方案被 CSP script-src 拒=死注入，07-09 传导链追踪抓出改 data 属性——CSP 不限属性） -->
<!-- data-poll-cfg：轮询间隔单源注入（constants.ts TOKEN/MEMORY/APPROVAL/GROUP_POLL_MS，同 T003 data 属性范式；
     webview 侧 chat-core.js 解析为 YB.POLL，属性缺失=各消费点等值字面量退化） -->
<body data-default-mode="${DEFAULT_MODE}" data-poll-cfg="${JSON.stringify({ token: TOKEN_POLL_MS, memory: MEMORY_POLL_MS, approval: APPROVAL_POLL_MS, group: GROUP_POLL_MS }).replace(/"/g, "&quot;")}">

    <!-- ═══════════════════════════════════════════════════
         视图 A: 聊天视图（主界面）
         ═══════════════════════════════════════════════════ -->
    <div id="viewChat" data-view="chat">

        <!-- 顶部栏 -->
        <div class="view-header">
            <div class="view-header-left">
                <span id="chatTitle" class="view-title">YonBan</span>
                <span id="connDot" class="status-dot" style="width:6px;height:6px;margin-left:6px;display:none;" title="连接状态"></span>
                <!-- 多开路由徽章（2026-07-26）：本窗口桥接端口·工作区名；绿=对话路由到本窗口 黄=路由别处/未知 灰=本体未连本窗口 -->
                <span id="ideBindBadge" class="ide-bind-badge hidden" title="IDE 桥接路由状态"></span>
            </div>
            <div class="view-header-right">
                <span id="permBadge" class="perm-badge hidden" title="权限档位（点击查看审批跳过规则）"></span>
                <button id="errBadge" class="icon-btn err-badge hidden" title="错误中心（宿主+界面运行时错误）" aria-label="打开错误中心">⚠<span id="errBadgeCount" class="err-badge-count"></span></button>
                <button id="btnDisplaySettings" class="icon-btn" title="显示设置" aria-label="显示设置">💭</button>
                <button id="btnSettings" class="icon-btn" title="设置" aria-label="打开设置">⚙</button>
            </div>
        </div>

        <!-- 并行组运行态指示条（v4 §4 三栏适配：顶部常驻，显示各组状态） -->
        <div id="groupRuntimeBar" class="group-runtime-bar hidden">
            <div id="groupRuntimeContent" class="group-runtime-content"></div>
        </div>

        <!-- Token 进度条 -->
        <div id="tokenBar" class="token-bar hidden">
            <div class="token-bar-inner">
                <div class="token-bar-track">
                    <div id="tokenBarFill" class="token-bar-fill"></div>
                </div>
                <span id="tokenBarLabel" class="token-bar-label">—</span>
                <button id="btnCompact" class="icon-btn token-compact-btn" title="压缩上下文" aria-label="压缩上下文">🗜</button>
            </div>
        </div>

        <!-- 记忆状态指示器 -->
        <div id="memoryStatusBar" class="memory-status-bar hidden">
            <span id="memoryStatusText" class="memory-status-text"></span>
        </div>

        <!-- F3/Y2 任务打勾卡（聊天流顶部，per-chatId，与本体 taskCard 同款语义） -->
        <div id="taskCard" class="task-card hidden"></div>

        <!-- 提示词查看器面板（🔍展开） -->
        <div id="promptViewerPanel" class="prompt-viewer-panel hidden">
            <div class="preset-section">
                <div class="preset-section-header">
                    <span class="section-label">提示词预览</span>
                    <button id="pvCopyBtn" class="icon-btn" title="复制JSON">📋</button>
                </div>
                <div style="padding:0 8px 8px;">
                    <button id="pvBuildBtn" class="btn btn-primary" style="width:100%;font-size:12px;">🚀 构建请求</button>
                </div>
                <div id="pvStats" class="hidden" style="padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);"></div>
                <div id="pvMessageList" style="max-height:50vh;overflow-y:auto;padding:4px;">
                    <div style="text-align:center;color:var(--vscode-descriptionForeground);font-size:11px;padding:16px 8px;">点击 🚀 构建请求 预览完整提示词</div>
                </div>
            </div>
        </div>

        <!-- 消息列表 -->
        <div id="messageList" class="message-list"></div>

        <!-- 打字指示器 -->
        <div id="typingIndicator" class="typing-indicator">
            <span id="typingNames"></span><span class="dots"></span>
        </div>

        <!-- 输入区域 -->
        <div class="input-area">
            <textarea id="msgInput" rows="1" placeholder="输入消息… (Ctrl+Enter 发送)"></textarea>
            <div class="input-bottom-bar">
                <div class="input-selectors">
                    <button id="btnHamburger" class="selector-btn hamburger-btn" title="菜单">
                        <span>☰</span>
                    </button>
                    <button id="btnModeSelector" class="selector-btn" title="切换模式">
                        <span id="activeModeLabel">💻 Code</span>
                        <span class="selector-arrow">▲</span>
                    </button>
                    <button id="btnApiSelector" class="selector-btn" title="切换API源">
                        <span id="activeApiSourceLabel">源: 默认</span>
                        <span class="selector-arrow">▲</span>
                    </button>
                    <button id="btnModelSelector" class="selector-btn" title="切换模型">
                        <span id="activeApiLabel">模型: 默认</span>
                        <span class="selector-arrow">▲</span>
                    </button>
                </div>
                <div class="input-actions">
                    <button id="btnSend" class="btn btn-primary btn-send" aria-label="发送消息">发送</button>
                    <button id="btnStop" class="btn btn-warn btn-stop hidden" aria-label="停止生成">停止</button>
                </div>
            </div>
        </div>

        <!-- 模式选择器弹出层（从底部向上展开） -->
        <div id="modePopup" class="bottom-popup hidden">
            <div class="bottom-popup-inner">
                <div class="popup-section">
                    <div class="section-label">模式</div>
                    <div id="submodeBar" class="submode-bar"></div>
                </div>
            </div>
        </div>

        <!-- API 源选择器弹出层 -->
        <div id="apiSourcePopup" class="bottom-popup hidden">
            <div class="bottom-popup-inner">
                <div class="popup-section">
                    <div class="section-label">API 源</div>
                    <div id="apiSourceList" class="submode-bar"></div>
                </div>
            </div>
        </div>

        <!-- 模型选择器弹出层 -->
        <div id="apiPopup" class="bottom-popup hidden">
            <div class="bottom-popup-inner">
                <div class="popup-section">
                    <div class="section-label">模型</div>
                    <div id="apiList" class="submode-bar"></div>
                </div>
            </div>
        </div>

        <!-- ☰ 汉堡菜单弹出层 -->
        <div id="hamburgerPopup" class="bottom-popup hidden">
            <div class="bottom-popup-inner hamburger-menu">
                <div class="hamburger-item" data-action="webSearch">
                    <span class="hamburger-icon">🌐</span>
                    <span class="hamburger-label">联网搜索</span>
                    <label class="hamburger-switch"><input type="checkbox" id="hmWebSearch" /><span class="hm-slider"></span></label>
                </div>
                <!-- 机制硬编码收口（2026-07-13）：跨端跟随机制早留了 localStorage 'yb-peer-follow' 开关
                     （chat.js peerActiveChat 消费）但全库零写入点=幽灵开关，此处补上用户入口 -->
                <div class="hamburger-item" data-action="peerFollow">
                    <span class="hamburger-icon">🔗</span>
                    <span class="hamburger-label">跨端跟随对话</span>
                    <label class="hamburger-switch"><input type="checkbox" id="hmPeerFollow" /><span class="hm-slider"></span></label>
                </div>
                <div class="hamburger-divider"></div>
                <div class="hamburger-item" data-action="promptViewer">
                    <span class="hamburger-icon">🔍</span>
                    <span class="hamburger-label">提示词查看器</span>
                </div>
                <div class="hamburger-item" data-action="tokenSettings">
                    <span class="hamburger-icon">⚙️</span>
                    <span class="hamburger-label">Token设置</span>
                </div>
                <div class="hamburger-item" data-action="ideApprovals">
                    <span class="hamburger-icon">✅</span>
                    <span class="hamburger-label">AI操作审批</span>
                </div>
                <div class="hamburger-item" data-action="approvalRules">
                    <span class="hamburger-icon">🛡️</span>
                    <span class="hamburger-label">审批跳过规则</span>
                </div>
                <div class="hamburger-item" data-action="editHistory">
                    <span class="hamburger-icon">\u{1F4DD}</span>
                    <span class="hamburger-label">改动历史</span>
                    <span id="editHistoryCount" class="hamburger-badge hidden">0</span>
                </div>
                <!-- switchCodeMode/switchWorkMode removed (P3-2) -->
                <div class="hamburger-divider"></div>
                <div class="hamburger-item" data-action="newChat">
                    <span class="hamburger-icon">➕</span>
                    <span class="hamburger-label">新建对话</span>
                </div>
                <div class="hamburger-item" data-action="regenerate">
                    <span class="hamburger-icon">🔄</span>
                    <span class="hamburger-label">重新生成</span>
                </div>
                <div class="hamburger-item" data-action="groupManager">
                    <span class="hamburger-icon">🗂️</span>
                    <span class="hamburger-label">并行组管理</span>
                </div>
                <div class="hamburger-item" data-action="manageChatList">
                    <span class="hamburger-icon">📋</span>
                    <span class="hamburger-label">管理对话</span>
                </div>
            </div>
        </div>

        <!-- ⚠ 错误中心悬浮窗（反馈系统：宿主 hostError + webview console.error/JS 错误/回包 error 的持久面；
             对齐 beilu 主前端 backendMonitor _errors 环形+未读角标语义：打开即已读） -->
        <div id="errorCenterPopup" class="floating-popup hidden">
            <div class="floating-popup-header">
                <span>⚠ 错误中心</span>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button id="errCenterCopyBtn" class="fp-btn-sm" title="复制全部错误文本">复制</button>
                    <button id="errCenterClearBtn" class="fp-btn-sm">清空</button>
                    <button class="fp-close-btn" data-close="errorCenterPopup">×</button>
                </div>
            </div>
            <div id="errCenterList" class="err-center-list">
                <div class="err-center-empty">暂无错误</div>
            </div>
        </div>

        <!-- 📝 改动历史悬浮窗 -->
        <div id="editHistoryPopup" class="floating-popup hidden">
            <div class="floating-popup-header">
                <span>\u{1F4DD} AI改动历史</span>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button id="editHistoryClearBtn" class="fp-btn-sm">清空</button>
                    <button class="fp-close-btn" data-close="editHistoryPopup">×</button>
                </div>
            </div>
            <div id="editHistoryList" class="edit-history-list">
                <div class="edit-history-empty">暂无改动记录</div>
            </div>
        </div>
        <!-- Token设置悬浮窗 -->
        <div id="tokenSettingsPopup" class="floating-popup hidden">
            <div class="floating-popup-header">
                <span>Token 设置</span>
                <button id="tokenSettingsClose" class="icon-btn" style="font-size:12px;">✕</button>
            </div>
            <div class="floating-popup-body">
                <div class="fp-row">
                    <span class="fp-label">最大上下文</span>
                    <input type="number" id="fpMaxContext" class="fp-input" min="1024" step="1024" placeholder="200000" />
                </div>
                <div class="fp-row">
                    <span class="fp-label">最大生成Token</span>
                    <input type="number" id="fpMaxTokens" class="fp-input" min="256" step="256" placeholder="8192" />
                </div>
                <div class="fp-row">
                    <span class="fp-label">警告阈值 %</span>
                    <input type="number" id="fpWarnPct" class="fp-input" min="50" max="100" value="70" />
                </div>
                <div class="fp-row">
                    <span class="fp-label">危险阈值 %</span>
                    <input type="number" id="fpDangerPct" class="fp-input" min="50" max="100" value="90" />
                </div>
                <button id="fpSaveBtn" class="btn btn-primary" style="width:100%;margin-top:8px;font-size:12px;">保存</button>
                <div id="fpStatus" style="font-size:10px;color:var(--vscode-descriptionForeground);text-align:center;margin-top:4px;"></div>
            </div>
        </div>

        <!-- IDE审批悬浮窗 -->
        <div id="ideApprovalsPopup" class="floating-popup hidden">
            <div class="floating-popup-header">
                <span>AI操作审批</span>
                <button id="ideApprovalsClose" class="icon-btn" style="font-size:12px;">✕</button>
            </div>
            <div class="floating-popup-body">
                <div id="ideApprovalsList" style="font-size:11px;">
                    <div style="color:var(--vscode-descriptionForeground);text-align:center;padding:12px;">加载中…</div>
                </div>
                <div style="display:flex;gap:6px;margin-top:8px;">
                    <button id="iaApproveAll" class="btn btn-primary" style="flex:1;font-size:11px;">全部批准</button>
                    <button id="iaRejectAll" class="btn btn-secondary" style="flex:1;font-size:11px;">全部拒绝</button>
                </div>
            </div>
        </div>
    </div>

    <!-- ═══════════════════════════════════════════════════
         视图 B: 设置视图
         ═══════════════════════════════════════════════════ -->
    <div id="viewSettings" data-view="settings" class="hidden">

        <!-- 设置顶部栏 -->
        <div class="view-header">
            <div class="view-header-left">
                <span class="view-title">设置</span>
            </div>
            <div class="view-header-right">
                <button id="btnSettingsDone" class="btn btn-primary" style="font-size:12px;padding:3px 12px;">完成</button>
            </div>
        </div>

        <!-- 设置主体：左Tab + 右内容 -->
        <div class="settings-body">
            <!-- 左侧 Tab 栏 -->
            <div class="settings-tabs">
                <button class="settings-tab active" data-tab="connect" title="连接">🔌</button>
                <button class="settings-tab" data-tab="memory" title="记忆引擎">🧠</button>
                <button class="settings-tab" data-tab="submodes" title="子模式">⚡</button>
                <button class="settings-tab" data-tab="clones" title="分身AI">👥</button>
                <button class="settings-tab" data-tab="prompt" title="提示词设置">📝</button>
                <button class="settings-tab" data-tab="ai-control" title="AI 控制">🔐</button>
                <button class="settings-tab" data-tab="preset" title="预设 & 模型">⚙</button>
                <button class="settings-tab" data-tab="about" title="关于">ℹ️</button>
            </div>

            <!-- 右侧内容区 -->
            <div class="settings-content">

                <!-- Tab: 连接 -->
                <div id="tabConnect" class="settings-tab-panel" data-tab-panel="connect">
                    <div class="section-label">连接状态</div>
                    <div class="connect-header">
                        <div id="statusBadge" class="status-badge status-disconnected">
                            <span class="status-dot"></span>
                            <span id="statusText">未连接</span>
                        </div>
                    </div>

                    <div id="serverInfo" class="info-section hidden">
                        <div class="info-row"><span class="info-key">地址</span><span id="serverUrl" class="info-val">-</span></div>
                        <div class="info-row"><span class="info-key">版本</span><span id="serverVer" class="info-val">-</span></div>
                        <div class="info-row"><span class="info-key">用户</span><span id="serverUser" class="info-val">-</span></div>
                    </div>

                    <div id="loginForm" class="info-section hidden">
                        <div class="section-label">选择用户</div>
                        <select id="userSelector" class="input-field" style="width:100%;padding:6px 8px;margin-bottom:6px;">
                            <option value="">加载中...</option>
                        </select>
                        <button id="loginBtn" class="btn btn-primary" style="width:100%;">登录</button>
                        <div id="loginError" class="error-text hidden"></div>
                    </div>

                    <div class="connect-actions" style="margin:8px 0;">
                        <button id="connectBtn" class="btn btn-primary" style="width:100%;">连接后端</button>
                        <button id="disconnectBtn" class="btn btn-secondary hidden" style="width:100%;">断开连接</button>
                    </div>

                    <div class="info-section">
                        <div class="section-label">IDE 桥接</div>
                        <div class="info-row"><span class="info-key">状态</span><span id="wsStatusText" class="info-val">未启动</span></div>
                        <div class="info-row"><span class="info-key">端口</span><span id="wsPort" class="info-val">-</span></div>
                        <div class="info-row"><span class="info-key">前端连接</span><span id="wsClients" class="info-val">0</span></div>
                    </div>

                    <!-- 连接诊断 -->
                    <div class="info-section">
                        <div class="section-label">诊断</div>
                        <button id="btnRunDiag" class="btn btn-secondary" style="width:100%;font-size:12px;margin-bottom:6px;">🏥 运行诊断</button>
                        <div id="diagResults" style="font-size:11px;"></div>
                    </div>

                    <!-- 角色卡选择（条状列表） -->
                    <div class="info-section">
                        <div class="preset-section-header">
                            <span class="section-label">角色卡</span>
                            <button id="btnRefreshChars" class="icon-btn" title="刷新">⟳</button>
                        </div>
                        <div id="charList" class="char-strip-list"></div>
                    </div>

                    <!-- 聊天列表 -->
                    <div id="chatListSection" class="info-section hidden">
                        <div class="preset-section-header">
                            <span id="chatListTitle" class="section-label">聊天</span>
                            <div style="display:flex;gap:4px;">
                                <button id="btnNewChat" class="icon-btn" title="新建聊天">+</button>
                                <button id="btnRefreshChats" class="icon-btn" title="刷新">⟳</button>
                            </div>
                        </div>
                        <div id="chatList" class="chat-strip-list"></div>
                    </div>
                </div>

                <!-- Tab: 记忆引擎 -->
                <div id="tabMemory" class="settings-tab-panel hidden" data-tab-panel="memory">
                    <div class="preset-section-header">
                        <span class="section-label">记忆引擎 (P1-P7 / IN1-3)</span>
                        <button id="btnRefreshMemory" class="icon-btn" title="刷新">⟳</button>
                    </div>
                    <div id="memoryPresetList" class="memory-preset-list"></div>
                </div>

                <!-- Tab: 子模式 -->
                <div id="tabSubmodes" class="settings-tab-panel hidden" data-tab-panel="submodes">
                    <div class="preset-section-header">
                        <span class="section-label">子模式管理</span>
                        <button id="btnRefreshPresets" class="icon-btn" title="刷新">⟳</button>
                    </div>
                    <div id="skillGroupBar" style="margin-bottom:8px;"></div>
                    <div id="submodeList" class="submode-list"></div>
                </div>

                <!-- Tab: 分身AI -->
                <div id="tabClones" class="settings-tab-panel hidden" data-tab-panel="clones">
                    <div class="preset-section-header">
                        <span class="section-label">分身AI管理</span>
                        <button id="btnRefreshClones" class="icon-btn" title="刷新">⟳</button>
                    </div>
                    <p style="font-size:11px;opacity:0.5;margin-bottom:8px;">主AI通过 &lt;分身N&gt;指令&lt;/分身N&gt; 并行调用分身AI</p>
                    <div id="yb-clone-list" class="submode-list"></div>
                </div>

                <!-- Tab: 提示词设置 -->
                <div id="tabPrompt" class="settings-tab-panel hidden" data-tab-panel="prompt">
                    <div class="section-label">提示词后处理</div>
                    <div class="info-section">
                        <div class="info-row">
                            <span class="info-key">后处理模式</span>
                            <!-- T002：selected 与后端权威默认一致（preset/main.mjs RUNTIME_PARAMS_DEFAULTS
                                 prompt_post_processing="none"）。旧码 strict selected=第三份默认值，
                                 getRuntimeParams 未回/失败窗口期显示 strict 而主链执行 none=显示谎报。
                                 正常路径 JS 按下发值覆盖，此 selected 只管兜底窗口。 -->
                            <select id="promptPostProcessing" class="input-field" style="width:auto;font-size:12px;">
                                <option value="none" selected>关闭</option>
                                <option value="merge">合并 (Merge)</option>
                                <option value="semi">半严格 (Semi)</option>
                                <option value="strict">严格 (Strict)</option>
                            </select>
                        </div>
                        <div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;">
                            严格模式：中间 system 转 user，保证角色交替<br>
                            半严格：同上但不插入占位符<br>
                            合并：只合并连续同角色消息
                        </div>
                    </div>

                    <div class="section-label" style="margin-top:12px;">预填充</div>
                    <div class="info-section">
                        <div class="info-row">
                            <span class="info-key">尾部预填充</span>
                            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
                                <input type="checkbox" id="prefillEnabled" />
                                <span style="font-size:12px;">启用</span>
                            </label>
                        </div>
                        <!-- Claude预填充由子模式配置控制，不在这里设置 -->
                    </div>

                    <button id="savePromptSettings" class="btn-primary" style="margin-top:8px;width:100%;">保存设置</button>
                    <div id="promptSettingsStatus" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;text-align:center;"></div>
                </div>

                <!-- Tab: AI 控制面板 -->
                <div id="tabAiControl" class="settings-tab-panel hidden" data-tab-panel="ai-control">
                    <div class="info-section" style="margin-bottom:8px;">
                        <div class="info-row">
                            <span class="info-key">当前预设</span>
                            <span id="aiActivePreset" class="info-val" style="font-weight:600;color:var(--vscode-textLink-foreground);">—</span>
                        </div>
                    </div>
                    <div class="section-label">🔐 AI 文件处理能力</div>
                    <!-- 权限项目录后端单源：chat-settings.js renderAiPermList 按 getFilesConfig
                         permissions 键集 + allowExec 动态生成。旧静态 9 行 data-perm(read/write/...)
                         与后端真键(file_read/file_write/questions/...)全对不上=恒显示 HTML 假 checked
                         的谎报面板，保存还把 read/cleanup 等无消费者垃圾键写进后端配置——故删静态行，
                         未下发前显示等待态（诚实降级，不摆假开关）。 -->
                    <div class="info-section" id="aiPermList">
                        <div style="font-size:11px;color:var(--vscode-descriptionForeground);">（等待后端下发权限项…）</div>
                    </div>

                    <div class="section-label" style="margin-top:12px;">模式切换清理</div>
                    <div class="info-section">
                        <label class="perm-toggle-row">
                            <input type="checkbox" id="aiModeSwitchClean" />
                            <span>退出文件/记忆模式时清理对话消息</span>
                        </label>
                    </div>

                    <div class="section-label" style="margin-top:12px;">🔄 操作后自动继续</div>
                    <div class="info-section">
                        <label class="perm-toggle-row">
                            <input type="checkbox" id="aiAutoContinue" />
                            <span>AI 执行文件操作后自动发送结果并继续对话</span>
                        </label>
                    </div>

                    <button id="saveAiControlSettings" class="btn-primary" style="margin-top:8px;width:100%;">保存设置</button>
                    <div id="aiControlStatus" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;text-align:center;"></div>
                </div>

                <!-- Tab: 预设 & 模型 -->
                <div id="tabPreset" class="settings-tab-panel hidden" data-tab-panel="preset">
                    <div class="section-label">📦 预设管理</div>
                    <div class="info-section">
                        <div class="info-row">
                            <span class="info-key">当前预设</span>
                            <select id="presetSelector" class="input-field" style="width:auto;font-size:12px;max-width:180px;"></select>
                        </div>
                        <div class="info-row" style="gap:4px;flex-wrap:wrap;margin-top:4px;">
                            <button id="presetNew" class="small-btn" title="新建">＋ 新建</button>
                            <button id="presetDup" class="small-btn" title="复制">📋 复制</button>
                            <button id="presetRename" class="small-btn" title="重命名">✏️ 改名</button>
                            <button id="presetDel" class="small-btn" style="color:#f87171;" title="删除">🗑️ 删除</button>
                        </div>
                    </div>

                    <!-- 模型参数和生成设置由子模式编辑控制 -->
                </div>

                <!-- Tab: 关于 -->
                <div id="tabAbout" class="settings-tab-panel hidden" data-tab-panel="about">
                    <div class="section-label">关于 YonBan</div>
                    <div class="info-section">
                        <div class="info-row"><span class="info-key">版本</span><span class="info-val">${this._extensionVersion}</span></div>
                        <div class="info-row"><span class="info-key">作者</span><span class="info-val">凛倾</span></div>
                        <div class="info-row"><span class="info-key">描述</span><span class="info-val">beilu IDE 桥接插件</span></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- 弹出层遮罩 -->
    <div id="popupBackdrop" class="popup-backdrop hidden"></div>

    <!-- 模块化 JS 加载（顺序重要）；i18n 覆盖层最先：先翻静态 HTML 并挂 observer 兜住后续动态渲染 -->
    ${i18nScripts}
    <script src="${vendorMarkdownJs}"></script>
    <script src="${morphdomJs}"></script>
    <script src="${coreJs}"></script>
    <script src="${errorsJs}"></script>
    <script src="${connectionJs}"></script>
    <script src="${messagesJs}"></script>
    <script src="${modesJs}"></script>
    <script src="${settingsJs}"></script>
    <script src="${promptViewerJs}"></script>
    <script src="${diagnosticsJs}"></script>
    <script src="${mainJs}"></script>
</body>
</html>`;
  }
}
