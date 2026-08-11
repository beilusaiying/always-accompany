/**
 * [chat.js] — YonBan 左侧栏 webview 入口文件。不管具体业务逻辑（那是各功能模块通过 YB 命名空间注册的 handler 的事）。
 *
 * 链路：Extension(YonBanProvider.postMessage) → window "message" 事件 → 本文件 switch 路由 → YB.onXxx handler
 *       用户 DOM 事件 → 本文件事件绑定 → vscode.postMessage → Extension → beilu 后端
 * 影响：注册全局 onerror/unhandledrejection 错误捕获(toast 显示)；monkey-patch vscode.postMessage(白盒出站追踪)；
 *       绑定所有 DOM 事件监听器；启动初始化序列
 * 相交：← Extension(onDidReceiveMessage)  → YB.*(chat-core 提供基础 + 各模块注册 handler)
 *
 * 加载顺序（HTML script 标签决定）：
 *   chat-core.js(YB 命名空间) → chat-connection.js → chat-messages.js → chat-modes.js
 *   → chat-settings.js → chat-prompt-viewer.js → chat-diagnostics.js → 本文件(入口)
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — 全局错误捕获（onerror + unhandledrejection → toast，因 webview 无 F12 DevTools）
 *   — 白盒线路：monkey-patch vscode.postMessage 出站追踪
 *   — 消息路由 switch（~60 种 postMessage type → 对应 YB.onXxx handler 分发）
 *   — 事件绑定（聊天视图）：设置/汉堡菜单/发送/停止/弹出层/选择器
 *   — 事件绑定（设置视图）：连接/断开/登录/刷新/诊断
 *   — 初始化序列：restoreFromLocalState → showView → getState/getWsStatus/getSubModes/getClones
 *   — showDisplaySettingsPopup（思维链标签配置浮窗，IIFE 外的全局函数）
 *
 * ★ BUG 记录：（无）
 */
// =====================================================
// chat.js — 入口文件 (V2 两视图重构)
// 消息路由 + 事件绑定 + 初始化
// 依赖：chat-core.js -> chat-connection.js -> chat-messages.js
//       -> chat-modes.js -> chat-settings.js
//       -> chat-prompt-viewer.js -> chat-diagnostics.js
// =====================================================

(function () {
  "use strict";

  // ★ 全局错误捕获（YonBan没有F12，错误通过toast即时提示 + 错误中心留档——toast 2 秒即逝，
  //   chat-errors.js 的错误中心让错误可回看/可复制）
  window.onerror = function(msg, src, line, col, err) {
    var detail = (src ? src.split("/").pop() : "?") + ":" + line + " " + (msg || "");
    try {
      if (window.YB && window.YB.showToast) {
        window.YB.showToast("\uD83D\uDEA8 JS\u9519\u8BEF: " + detail, 5000);
      }
      if (window.YB && window.YB.reportError) {
        window.YB.reportError("JS错误 " + detail, err && err.stack ? String(err.stack).substring(0, 300) : null, "全局");
      }
    } catch(_) {}
    return false;
  };
  window.addEventListener("unhandledrejection", function(e) {
    try {
      if (window.YB && window.YB.showToast) {
        var msg2 = e.reason ? String(e.reason).substring(0, 80) : "Promise rejected";
        window.YB.showToast("\uD83D\uDEA8 Promise: " + msg2, 5000);
      }
      if (window.YB && window.YB.reportError) {
        window.YB.reportError("Promise 未处理拒绝", e.reason ? String(e.reason).substring(0, 300) : null, "全局");
      }
    } catch(_) {}
  });

  var YB = window.YB;
  var dom = YB.dom;
  var state = YB.state;
  var vscode = YB.vscode;
  var showView = YB.showView;
  var togglePopup = YB.togglePopup;
  var closePopup = YB.closePopup;

  // 白盒线路：出站单点追踪。VSCode webview API 的 postMessage 是只读属性，
  // 不能直接赋值覆盖，改为在 YB 命名空间上挂 wrappedPost 供调试用。
  if (vscode && !vscode.__wbPatched) {
    try {
      var _wbOrigPost = vscode.postMessage.bind(vscode);
      Object.defineProperty(vscode, "postMessage", {
        value: function (m) {
          try { YB.wbTrace("yb", "post", { type: m && m.type }); } catch (_) {}
          return _wbOrigPost(m);
        },
        writable: true, configurable: true
      });
      vscode.__wbPatched = true;
    } catch (_) {
      // postMessage 不可覆盖时静默跳过，不影响功能
    }
  }

  // ═══════════════════════════════════════════════════════
  // 消息路由（统一分发后端消息）
  // ═══════════════════════════════════════════════════════

  var _lastConnStatus = null; // 连接状态提醒去重：只在状态变化时弹一次

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    // 白盒线路：入站单点追踪。记录每次"扩展回包的 type"，与出站 [yb:post] 对照即可
    // 在运行时看出"点了发出去但没回包(死线/无反馈)"——出站有 post、入站无对应 recv。
    try { YB.wbTrace("yb", "recv", { type: msg.type }); } catch (_) {}

    // ★ 回包 error 字段统一留档（框架级单点：宿主 15+ 种回包带 error 字段，各 onXxx handler
    //   展示与否不一——此处不改各 handler 既有展示，只保证「凡 error 必进错误中心」不再有静默断链。
    //   report 档不 toast，防轮询类失败刷屏；hostError 自身在 chat-errors 入环，跳过防双记）
    try {
      if (msg.payload && typeof msg.payload === "object" && msg.payload.error &&
          msg.type !== "hostError" && YB.reportError) {
        YB.reportError("[" + msg.type + "] " + String(msg.payload.error).substring(0, 300), null, "回包");
      }
    } catch (_) {}

    try { switch (msg.type) {
      case "connectionState":
        YB.onConnectionState(msg.payload);
        // 各种代码也提醒：连接状态变化弹一次（去重，不刷屏）
        if (msg.payload && msg.payload.status && msg.payload.status !== _lastConnStatus) {
          _lastConnStatus = msg.payload.status;
          if (msg.payload.status === "connected") YB.showToast("已连接后端", 1500);
          else if (msg.payload.status === "disconnected") YB.showToast("已断开后端", 1500);
          else if (msg.payload.status === "error") YB.showToast("✗ 连接错误: " + (msg.payload.error || "后端无响应"), 2500);
        }
        break;
      case "loginResult":
        YB.onLoginResult(msg.payload);
        break;
      case "wsStatus":
        YB.onWsStatus(msg.payload);
        break;
      case "charList":
        YB.onCharList(msg.payload);
        break;
      case "charDetails":
        YB.onCharDetails(msg.payload);
        break;
      case "chatList":
        YB.onChatList(msg.payload);
        break;
      // ★ 右副侧栏「卡片/窗口」板块切对话 → 左 Provider 已后端切好 + 推 chatInitialData，
      //   这里仅同步左对话 UI 态（标题/视图/轮询），不回发 switchChat（防回环，设计第3问）。
      case "chatSwitched":
        if (YB.applySwitchedChat && msg.payload) {
          YB.applySwitchedChat(msg.payload.chatId, msg.payload.chatMeta);
        }
        break;
case "chatInitialData":
        YB.onChatInitialData(msg.payload);
        // 初始化后拉取filesConfig（权限列表）；联网搜索开关状态走真源 beilu-memory（0714 同源修）
        vscode.postMessage({ type: "getFilesConfig" });
        vscode.postMessage({ type: "getWebSearch" });
        // F3/Y2: 拉取当前会话任务清单（任务卡初始渲染；后续变更走 taskUpdate 推送）
        vscode.postMessage({ type: "getTasks" });
        // B3/Y6: 拉取权限档位（顶栏徽章外显）
        vscode.postMessage({ type: "getPermissionLevel" });
        // S5: 拉取 display regex 规则
        vscode.postMessage({ type: "getRegexRules" });
        // 拉取思维链标签配置（从本体 beilu-memory 配置同步，替代 hardcoded thinking|think|thought）
        vscode.postMessage({ type: "getThinkingTags" });
        // 多开显示：切对话后刷新顶栏路由徽章（当前对话绑定去向可能变了）
        vscode.postMessage({ type: "getIdeBindingStatus" });
        break;
      case "chatListChanged":
        // 通道B：他端建/删/改会话 → 重拉会话列表刷新（host 取回后重渲染）。
        // 注：角色卡/会话 config 变更不走这里——host 侧 _resyncChat 全量刷（chatResync），更完整。
        vscode.postMessage({ type: "getChatList" });
        break;
      case "messageAdded":
        YB.onMessageAdded(msg.payload);
        break;
      case "messageReplaced":
        YB.onMessageReplaced(msg.payload);
        break;
      case "messageDeleted":
        YB.onMessageDeleted(msg.payload);
        break;
      case "messageEdited":
        YB.onMessageEdited(msg.payload);
        break;
      case "editMessageResult":
        if (YB.onEditMessageResult) YB.onEditMessageResult(msg.payload);
        if (msg.payload && msg.payload.success !== true) {
          YB.showToast("✗ 编辑消息失败: " + (msg.payload.error || msg.payload.reason || "后端未提交编辑"), 3000);
          console.error("[YonBan] editMessageResult:", msg.payload);
        }
        break;
      case "streamStart":
        YB.onStreamStart(msg.payload);
        break;
      case "streamUpdate":
        YB.onStreamUpdate(msg.payload);
        break;
      case "typingStatus":
        YB.onTypingStatus(msg.payload);
        break;
      case "chatConnected":
        // 多开显示：聊天 WS 连上（此时 Provider 已上报绑定）→ 拉连接池快照刷新顶栏路由徽章
        vscode.postMessage({ type: "getIdeBindingStatus" });
        break;
      case "chatDisconnected":
        break;
      // 多开显示（2026-07-26）：顶栏徽章——本窗口桥接端口/工作区/本体是否连到本窗口/当前对话路由去向
      case "ideBindingStatus":
        if (YB.onIdeBindingStatus) YB.onIdeBindingStatus(msg.payload);
        break;
      case "chatResync":
        YB.onChatResync(msg.payload);
        break;
      // H2: 重连 → 计算本地服务端绝对消息数并回发，请求增量补拉断线期漏掉的消息
      case "chatReconnected":
        if (YB.onChatReconnected) YB.onChatReconnected(msg.payload);
        break;
      // H2: 后端返回的断线期漏掉的消息 → 逐条追加
      case "missedMessages":
        if (YB.onMissedMessages) YB.onMissedMessages(msg.payload);
        break;
      case "newChatCreated":
        YB.onNewChatCreated(msg.payload);
        break;
      case "chatDeleted":
        YB.onChatDeleted(msg.payload);
        break;
      case "presetConfig":
        YB.onPresetConfig(msg.payload);
        break;
      case "tokenSnapshot":
        YB.onTokenSnapshot(msg.payload);
        break;
      case "compactResult":
        YB.onCompactResult(msg.payload);
        break;
      case "tokenUsage":
        if (YB.onTokenUsage) YB.onTokenUsage(msg.payload);
        break;
      case "cloneStatus":
        if (YB.onCloneStatus) YB.onCloneStatus(msg.payload);
        // 各种代码也提醒：分身只在「开始/完成/异常」弹（跳过 working/retrying 高频中间态防刷屏）
        if (msg.payload) {
          var _cs = msg.payload.status, _tid = msg.payload.taskId || "";
          if (_cs === "started") YB.showToast("分身#" + _tid + " 开始", 1500);
          else if (_cs === "completed") YB.showToast("✓ 分身#" + _tid + " 完成", 1500);
          else if (_cs === "error" || _cs === "stopped") YB.showToast("⚠ 分身#" + _tid + " " + _cs + ": " + (msg.payload.detail || ""), 2500);
        }
        break;
      case "editRecord":
        if (YB.onEditRecord) YB.onEditRecord(msg.payload);
        // 各种代码也提醒：AI 写入文件时弹一条
        if (msg.payload && msg.payload.path) YB.showToast((msg.payload.tool || "写入") + ": " + msg.payload.path, 2000);
        break;
      // auxiliaryConfig: 辅助AI功能已下线，路由保留防后端残留消息报错
      case "auxiliaryConfig": break;
      case "flowGroupList":
        if (YB.onFlowGroupList) YB.onFlowGroupList(msg.payload);
        break;
      case "flowGroupStarted":
        if (YB.onFlowGroupStarted) YB.onFlowGroupStarted(msg.payload);
        break;
      case "flowGroupChanged":
        if (YB.onFlowGroupChanged) YB.onFlowGroupChanged(msg.payload);
        break;
      case "checkpointList":
        if (YB.onCheckpointList) YB.onCheckpointList(msg.payload);
        break;
      case "checkpointDiff":
        if (YB.onCheckpointDiff) YB.onCheckpointDiff(msg.payload);
        break;
      case "checkpointReverted":
        if (YB.onCheckpointReverted) YB.onCheckpointReverted(msg.payload);
        break;
      case "toolResultsReady":
        YB.onToolResultsReady(msg.payload);
        YB.showToast("工具结果已就绪", 1500);
        break;
      case "pendingApprovals":
        if (YB.onPendingApprovals) YB.onPendingApprovals(msg.payload);
        break;
      case "memoryConfig":
        YB.onMemoryConfig(msg.payload);
        break;
      case "memoryAIOutput":
        YB.onMemoryAIOutput(msg.payload);
        break;
      case "diagSnapshot":
        YB.onDiagSnapshot(msg.payload);
        break;
      case "subModesConfig":
        YB.onSubModesConfig(msg.payload);
        break;
      case "modelList":
        YB.onModelList(msg.payload);
        break;
      case "clonesConfig":
        YB.onClonesConfig(msg.payload);
        break;
      case "promptData":
        YB.onPromptData(msg.payload);
        break;
      case "connectionDiag":
        YB.onConnectionDiag(msg.payload);
        break;
      case "rollbackPreview":
        if (YB.onRollbackPreview) YB.onRollbackPreview(msg.payload);
        break;
      case "rollbackResult":
        YB.onRollbackResult(msg.payload);
        break;
      case "apiSourceList":
        YB.onApiSourceList(msg.payload);
        break;
      case "apiSourceSwitched":
        YB.onApiSourceSwitched(msg.payload);
        break;
      case "restoreUserState":
        YB.onRestoreUserState(msg.payload);
        break;
      case "userList":
        if (YB.onUserList) YB.onUserList(msg.payload);
        break;
      case "operationError":
        if (msg.payload && msg.payload.error) {
          YB.showToast("✗ " + (msg.payload.action || "操作") + "失败: " + msg.payload.error, 3000);
          console.error("[YonBan] operationError:", msg.payload);
          // U06（T049）：发送失败 → 复位"等待发送确认"标记，输入框文本原样保留可重发（对齐本体失败保文本）。
          if (msg.payload.action === "sendMessage") {
            if (YB.abortSendAck) YB.abortSendAck();
            if (YB.setSendIdle) YB.setSendIdle(); // [0719 发送状态机] 失败=完成事件之一
          }
        }
        break;
      case "operationWarning":
        if (msg.payload && msg.payload.warning) {
          YB.showToast("⚠ " + (msg.payload.action || "操作") + ": " + msg.payload.warning, 5000);
          console.warn("[YonBan] operationWarning:", msg.payload);
        }
        break;
      case "sendMessageDone":
        // [0719 发送状态机] extension 直连成功信号（WS 断连时 message_added 收不到的兜底腿）
        if (YB.setSendIdle) YB.setSendIdle();
        break;
      case "notify":
        // 点击按钮的成功提醒（与 operationError 的失败提醒对称）
        if (msg.payload && msg.payload.message) YB.showToast("✓ " + msg.payload.message, 2000);
        break;
      case "runtimeParams":
        if (YB.onRuntimeParams) YB.onRuntimeParams(msg.payload);
        break;
      case "tokenReminderConfig":
        if (YB.onTokenReminderConfig) YB.onTokenReminderConfig(msg.payload);
        break;
      case "regexRules":
        if (YB.onRegexRules) YB.onRegexRules(msg.payload);
        break;
      case "thinkingTagsConfig":
        if (YB.onThinkingTagsConfig) YB.onThinkingTagsConfig(msg.payload);
        break;
      case "filesConfig":
        if (YB.onFilesConfig) YB.onFilesConfig(msg.payload);
        break;
      // 联网搜索开关状态回包（0714 同源修：真源 beilu-memory config.web_search）
      case "webSearchState":
        (function () {
          var ws = document.getElementById("hmWebSearch");
          var st = msg.payload && msg.payload.web_search;
          if (ws && st && st.enabled !== undefined) ws.checked = !!st.enabled;
        })();
        break;
      // AI 提问 dock（0714 Kilo 式改道：聊天流内答题，替代 VSCode 顶部模态 InputBox）
      case "aiQuestion":
        if (YB.showAiQuestionDock) YB.showAiQuestionDock(msg.payload);
        break;
      case "aiQuestionClosed":
        if (YB.removeAiQuestionDock) YB.removeAiQuestionDock(msg.payload && msg.payload.id);
        break;
      // T10: 子模式切换 WS 实时推送（替代 4s 轮询）
      case "subModeSwitched":
        if (YB.onSubModeSwitched) YB.onSubModeSwitched(msg.payload);
        break;
      // 同步断链修复（2026-07-10）：另一端保存了子模式配置 → 重拉全量（回包走既有
      //   subModesConfig 链 → onSubModesConfig 刷新 state/面板/枚举 schema，幂等）
      case "subModesConfigChanged":
        vscode.postMessage({ type: "getSubModes" });
        break;
      // 跨客户端「当前对话」同步：本用户另一端(本体)生成开始 → 跟随切到该 chat 看流。
      // 默认跟随，localStorage 'yb-peer-follow'==='false' 可关。
      case "peerActiveChat": {
        var _pac = msg.payload || {};
        // 跟随前检查：用户正在输入/编辑/填写表单时不自动切换（防内容丢失）
        var _hasUnsavedInput = dom.msgInput && dom.msgInput.value.trim().length > 0;
        var _hasOverlay = document.querySelector(".yb-overlay, .yb-modal, .submode-edit-overlay");
        var _userBusy = state.isGenerating || _hasUnsavedInput || !!_hasOverlay;
        // ★ 多实例隔离（0726 实测串台路径）：默认**完全不跟随**，只有显式 'true' 才跟。
        //   why 删掉原来的「未设置=本窗尚无对话时吸附一次」：restoreUserState 是异步的，
        //   窗口刚起来时 state.currentChatId 必然为空——此刻另一个 YonBan 实例一开始生成，
        //   本窗就判定「我还没对话，吸附一下」切到**别的实例的对话**，两个 VSCode 从此渲染同一份内容。
        //   持久态按窗口隔离（workspaceState）也拦不住这条运行时路径。
        //   多实例语义：每个实例管自己的对话，别的实例在生成什么与本窗无关。
        var _followPref = (function () { try { return localStorage.getItem("yb-peer-follow"); } catch (e) { return null; } })();
        var _shouldFollow = _followPref === "true";
        if (
          _pac.chatid &&
          _pac.chatid !== state.currentChatId &&
          !_userBusy &&
          _shouldFollow &&
          YB.switchToChat
        ) {
          YB.switchToChat(_pac.chatid, null);
        }
        break;
      }
      // F3/Y2: 任务打勾卡（taskUpdate=后端推送；taskList=本端操作回包，同一渲染入口）
      case "taskUpdate":
      case "taskList":
        if (YB.onTaskUpdate) YB.onTaskUpdate(msg.payload);
        break;
      // 跨模式事件：work/code 独立 chatId 的任务/审批/report 变更。
      //   对齐本体（总是刷任务面板=beilu:smart-task-update，仅 cross_mode_notification 才弹窗）：
      //   非 notification 的 subtype(tasks/pending_approvals) 不再静默丢——总刷一次任务卡。
      case "crossModeTaskUpdate": {
        var _cm = msg.payload || {};
        vscode.postMessage({ type: "getTasks" });
        if (_cm.notification && (_cm.notification.message || _cm.notification.title)) {
          YB.showToast(_cm.notification.message || _cm.notification.title, 4000);
        }
        break;
      }
      // #5 通知型：自动继续熔断 / bot 错误 → toast
      case "serverNotice": {
        var _sn = msg.payload || {};
        if (_sn.kind === "bot_error") {
          var _be = _sn.payload || {};
          YB.showToast("⚠ Bot " + (_be.platform || "") + " 错误：" + (_be.message || ""), 5000);
        } else if (_sn.kind === "auto_continue_fuse") {
          YB.showToast("⏸ 自动继续已停止", 4000);
        }
        break;
      }
      // F6/Y5: 审批跳过规则面板（列/删回包同一入口）
      case "approvalRulesList":
        if (YB.onApprovalRulesList) YB.onApprovalRulesList(msg.payload);
        break;
      // B3/Y6: 权限档位徽章
      case "permissionLevel":
        if (YB.onPermissionLevel) YB.onPermissionLevel(msg.payload);
        break;
      case "activeMode":
      case "modeChanged":
        if (YB.onModeChanged) YB.onModeChanged(msg.payload);
        // 各种代码也提醒：模式切换（含后端发起的）弹一次
        if (msg.payload && msg.payload.mode) YB.showToast("已切换到 " + msg.payload.mode + " 模式", 1500);
        break;
      case "ideApprovals":
        YB.onIdeApprovals(msg.payload);
        break;
      case "ideApprovalResult":
        YB.onIdeApprovalResult(msg.payload);
        break;
      case "groupList":
        if (YB.onGroupList) YB.onGroupList(msg.payload);
        break;
      case "groupUpdated":
        if (YB.onGroupUpdated) YB.onGroupUpdated(msg.payload);
        break;
      // P0.3: 本体组运行态推送（group_runtime_update）→ 重拉组注册表刷新运行态条（推送即刷新，轮询降级兜底）
      case "groupRuntimeUpdate":
        if (YB.onGroupRuntimeUpdate) YB.onGroupRuntimeUpdate(msg.payload);
        break;
      case "groupApiResult":
        if (YB.onGroupApiResult) YB.onGroupApiResult(msg.payload);
        break;
      // 反馈系统：宿主 warn/error（ConsoleCapture 第二消费者）实时推送 + 积压补拉
      case "hostError":
        if (YB.onHostError) YB.onHostError(msg.payload);
        break;
      case "hostErrorBacklog":
        if (YB.onHostErrorBacklog) YB.onHostErrorBacklog(msg.payload);
        break;
      case "visibilityChanged":
        if (msg.payload && msg.payload.visible === false) {
          if (YB.stopTokenPoll) YB.stopTokenPoll();
          if (YB.stopMemoryPoll) YB.stopMemoryPoll();
          if (YB.stopApprovalPoll) YB.stopApprovalPoll();
          if (YB.stopGroupPoll) YB.stopGroupPoll(); // 多开资源优化：隐藏时组轮询也停（4开时防 4 份后台空转）
        } else if (msg.payload && msg.payload.visible === true) {
          if (YB.startTokenPoll) YB.startTokenPoll();
          if (YB.startMemoryPoll) YB.startMemoryPoll();
          if (YB.startApprovalPoll) YB.startApprovalPoll();
          if (YB.startGroupPoll) YB.startGroupPoll();
        }
        break;
    } } catch (_msgErr) {
      try { YB.showToast("\uD83D\uDEA8 消息处理错误[" + msg.type + "]: " + _msgErr.message, 4000); } catch(_) {}
      console.error("[YonBan] 消息路由错误:", msg.type, _msgErr); // console.error 已被 chat-errors 拦截入错误中心
    }
  });

  // ═══════════════════════════════════════════════════════
  // 事件绑定 — 聊天视图
  // ═══════════════════════════════════════════════════════

  // ⚙ 设置按钮：从聊天视图切到设置视图
  if (dom.btnSettings) {
    dom.btnSettings.addEventListener("click", function () {
      showView("settings");
    });
  }

  // 💭 显示设置按钮：思维链标签配置浮窗
  if (dom.btnDisplaySettings) {
    dom.btnDisplaySettings.addEventListener("click", function () {
      showDisplaySettingsPopup();
    });
  }

  // ☰ 汉堡菜单
  if (dom.btnHamburger) {
    dom.btnHamburger.addEventListener("click", function () {
      togglePopup("hamburger");
    });
  }

  // 汉堡菜单项点击
  document.querySelectorAll(".hamburger-item[data-action]").forEach(function (item) {
    item.addEventListener("click", function () {
      var action = item.dataset.action;
      closePopup();
      switch (action) {
        case "promptViewer":
          YB.togglePromptViewer();
          break;
        case "tokenSettings":
          YB.showFloatingPopup("tokenSettingsPopup");
          YB.loadTokenSettings();
          break;
        case "ideApprovals":
          YB.showFloatingPopup("ideApprovalsPopup");
          vscode.postMessage({ type: "getIdeApprovals" });
          break;
        case "approvalRules":
          if (YB.showApprovalRulesPanel) YB.showApprovalRulesPanel();
          break;
        case "editHistory":
          if (YB.showEditHistory) {
            try {
              YB.showEditHistory();
            } catch(e) {
              YB.showToast("\u274C \u6539\u52A8\u5386\u53F2\u9519\u8BEF: " + e.message, 3000);
            }
          } else {
            YB.showToast("\u274C \u6539\u52A8\u5386\u53F2\u6A21\u5757\u672A\u52A0\u8F7D", 3000);
          }
          break;
        // switchCodeMode/switchWorkMode removed (P3-2)
        case "groupManager":
          if (YB.showGroupManager) YB.showGroupManager();
          else YB.showToast("组管理模块未加载", 2000);
          break;
        case "newChat":
          vscode.postMessage({ type: "newChat", payload: { charName: state.selectedChar } });
          YB.showToast("新建聊天中…", 1500);
          break;
        case "regenerate":
          if (state.currentChatId) {
            vscode.postMessage({ type: "triggerReply", payload: {} });
            YB.showToast("重新生成中…", 1500);
          }
          break;
        case "manageChatList":
          (function(){
            var p=document.getElementById("chatManagerPopup");
            var bd=document.getElementById("chatManagerBackdrop");
            if(!p){
              p=document.createElement("div");p.id="chatManagerPopup";
              p.style.cssText="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;background:var(--vscode-editor-background,#1e1e2e);border:1px solid var(--vscode-panel-border,#333);border-radius:10px;padding:16px;width:320px;max-height:70vh;box-shadow:0 8px 32px rgba(0,0,0,.5);flex-direction:column;gap:8px;";
              var hdr=document.createElement("div");hdr.style.cssText="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
              var ttl=document.createElement("span");ttl.style.fontWeight="bold";ttl.textContent="\u7BA1\u7406\u5BF9\u8BDD";
              var cb=document.createElement("button");cb.id="chatMgrClose";cb.style.cssText="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;";cb.textContent="\u00D7";
              cb.addEventListener("click",function(){p.style.display="none";if(bd)bd.style.display="none";});
              hdr.appendChild(ttl);hdr.appendChild(cb);
              var nb=document.createElement("button");nb.style.cssText="width:100%;padding:7px;border:none;border-radius:6px;background:#0e639c;color:#fff;cursor:pointer;font-size:12px;margin-bottom:8px;";nb.textContent="+\u65B0\u5EFA\u5BF9\u8BDD";
              nb.addEventListener("click",function(){vscode.postMessage({type:"newChat",payload:{charName:state.selectedChar}});p.style.display="none";if(bd)bd.style.display="none";});
              var lst=document.createElement("div");lst.id="chatMgrList";lst.style.cssText="overflow-y:auto;max-height:50vh;display:flex;flex-direction:column;gap:3px;";
              p.appendChild(hdr);p.appendChild(nb);p.appendChild(lst);
              bd=document.createElement("div");bd.id="chatManagerBackdrop";bd.style.cssText="display:none;position:fixed;inset:0;z-index:9998;";
              bd.addEventListener("click",function(){p.style.display="none";bd.style.display="none";});
              document.body.appendChild(bd);document.body.appendChild(p);
            }
            var le=document.getElementById("chatMgrList");
            if(le){
              le.innerHTML="";
              var chats=state.allChats||[];
              if(state.selectedChar){chats=chats.filter(function(c){var ns=Array.isArray(c.chars)?c.chars:(c.chars?[c.chars]:[]);return ns.some(function(n){return n&&n===state.selectedChar;});});}
              if(!chats.length){le.innerHTML="<div style='text-align:center;opacity:.5;font-size:12px;padding:12px;'>\u6682\u65E0\u5BF9\u8BDD</div>";}
              chats.forEach(function(ch){
                var it=document.createElement("div");var act=ch.chatid===state.currentChatId;
                it.style.cssText="display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:12px;"+(act?"background:var(--vscode-list-activeSelectionBackground,#094771);":"");
                var nm=ch.customName||(ch.firstUserMessage&&ch.firstUserMessage.slice(0,30))||ch.chatid.slice(0,12);
                var ns=document.createElement("span");ns.style.cssText="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";ns.textContent=(act?"\u25B6 ":"")+nm;
                ns.addEventListener("click",function(){vscode.postMessage({type:"selectChat",payload:{chatId:ch.chatid}});p.style.display="none";if(bd)bd.style.display="none";});
                var db=document.createElement("button");db.style.cssText="background:none;border:none;color:inherit;cursor:pointer;opacity:.5;font-size:11px;";db.textContent="\uD83D\uDDD1";
                db.addEventListener("click",function(e){e.stopPropagation();if(!db._c){db._c=true;db.textContent="\u786E\u8BA4";db.style.opacity="1";setTimeout(function(){if(db){db._c=false;db.textContent="\uD83D\uDDD1";db.style.opacity=".5";}},3000);}else{vscode.postMessage({type:"deleteChat",payload:{chatId:ch.chatid}});p.style.display="none";if(bd)bd.style.display="none";}});
                it.appendChild(ns);it.appendChild(db);le.appendChild(it);
              });
            }
            p.style.display="flex";if(bd)bd.style.display="block";
            closePopup("hamburgerPopup");
          })();
          break;
        case "webSearch":
          // toggle handled by checkbox, don't close
          break;
      }
    });
  });

  // 联网搜索开关
  if (dom.hmWebSearch) {
    dom.hmWebSearch.addEventListener("change", function (e) {
      e.stopPropagation();
      // 0714 同源修：写真源 beilu-memory config.web_search.enabled（原 setFilesConfig 走
      // beilu-files 白名单无此字段=写入即丢，刷新回落关闭）
      vscode.postMessage({
        type: "setWebSearch",
        payload: { enabled: dom.hmWebSearch.checked },
      });
      YB.showToast(dom.hmWebSearch.checked ? "联网搜索已开启" : "联网搜索已关闭", 1500);
    });
    // 防止点击checkbox时触发父级item的click
    dom.hmWebSearch.closest(".hamburger-item").addEventListener("click", function (e) {
      if (e.target !== dom.hmWebSearch) {
        dom.hmWebSearch.checked = !dom.hmWebSearch.checked;
        dom.hmWebSearch.dispatchEvent(new Event("change"));
      }
      e.stopPropagation();
    });
  }

  // 跨端跟随开关（机制硬编码收口 2026-07-13：peerActiveChat 消费的 'yb-peer-follow' 原是零写入点的幽灵键）
  // 多开语义（2026-07-26）：默认改为不勾选（未设置=仅未选对话时初始吸附）；勾选=显式 'true' 全跟随。
  var hmPeerFollow = document.getElementById("hmPeerFollow");
  if (hmPeerFollow) {
    try { hmPeerFollow.checked = localStorage.getItem("yb-peer-follow") === "true"; } catch (_) { hmPeerFollow.checked = false; }
    hmPeerFollow.addEventListener("change", function (e) {
      e.stopPropagation();
      try { localStorage.setItem("yb-peer-follow", hmPeerFollow.checked ? "true" : "false"); } catch (_) {}
      YB.showToast(hmPeerFollow.checked ? "跨端跟随已开启（他端开始生成时自动切到该对话）" : "跨端跟随已关闭（多窗口各管各的对话）", 2000);
    });
    hmPeerFollow.closest(".hamburger-item").addEventListener("click", function (e) {
      if (e.target !== hmPeerFollow) {
        hmPeerFollow.checked = !hmPeerFollow.checked;
        hmPeerFollow.dispatchEvent(new Event("change"));
      }
      e.stopPropagation();
    });
  }

  // ★ data-close 通用事件委托（悬浮窗×按钮）
  document.querySelectorAll("[data-close]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetId = btn.dataset.close;
      var target = document.getElementById(targetId);
      if (target) {
        target.classList.add("hidden");
      } else {
        YB.showToast("\u274C \u5173\u95ED\u5931\u8D25: \u627E\u4E0D\u5230 " + targetId, 2000);
      }
    });
  });

  // Token设置弹窗
  if (dom.tokenSettingsClose) {
    dom.tokenSettingsClose.addEventListener("click", function () {
      YB.closeAllFloatingPopups();
    });
  }
  if (dom.fpSaveBtn) {
    dom.fpSaveBtn.addEventListener("click", function () {
      YB.saveTokenSettings();
    });
  }

  // IDE审批弹窗
  if (dom.ideApprovalsClose) {
    dom.ideApprovalsClose.addEventListener("click", function () {
      YB.closeAllFloatingPopups();
    });
  }
  if (dom.iaApproveAll) {
    dom.iaApproveAll.addEventListener("click", function () {
      vscode.postMessage({ type: "approveAllIdeOps" });
      YB.showToast("已全部批准", 1500);
      YB.closeAllFloatingPopups();
    });
  }
  if (dom.iaRejectAll) {
    dom.iaRejectAll.addEventListener("click", function () {
      vscode.postMessage({ type: "rejectAllIdeOps" });
      YB.showToast("已全部拒绝", 1500);
      YB.closeAllFloatingPopups();
    });
  }
  // 提示词查看器(保留构建/复制按钮事件)
  if (dom.pvBuildBtn) {
    dom.pvBuildBtn.addEventListener("click", function () {
      dom.pvBuildBtn.disabled = true;
      dom.pvBuildBtn.textContent = "构建中…";
      vscode.postMessage({ type: "buildPrompt" });
      setTimeout(function () {
        if (dom.pvBuildBtn.disabled) {
          dom.pvBuildBtn.disabled = false;
          dom.pvBuildBtn.textContent = "⚠ 超时";
          YB.showToast("构建请求超时，请重试", 2000);
          setTimeout(function() { dom.pvBuildBtn.textContent = "构建请求"; }, 2000);
        }
      }, 10000);
    });
  }
  if (dom.pvCopyBtn) {
    dom.pvCopyBtn.addEventListener("click", function () {
      if (state.lastPromptData) {
        var text = JSON.stringify(state.lastPromptData, null, 2);
        navigator.clipboard
          .writeText(text)
          .then(function () {
            dom.pvCopyBtn.textContent = "✓";
            setTimeout(function () {
              dom.pvCopyBtn.textContent = "复制";
            }, 1500);
          })
          .catch(function () { dom.pvCopyBtn.textContent = "✗"; YB.showToast("复制失败", 1500); setTimeout(function() { dom.pvCopyBtn.textContent = "复制"; }, 1500); });
      }
    });
  }

  // Token 压缩 — 弹出两种模式选择面板
  if (dom.btnCompact) {
    dom.btnCompact.addEventListener("click", function () {
      YB.showCompressPanel();
    });
  }

  // 发送 — [0719 发送状态机] 按钮态事件驱动：原 3s 定时器无条件复位与真实完成脱钩
  //   （慢请求时按钮先回「发送」用户误判失败再点=双发温床）。复位只由真实完成事件触发：
  //   sendMessageDone（extension 直连成功信号）/ message_added(role=user)（WS 成功回推）/
  //   operationError（失败，toast 已由既有通道弹出）。
  YB.setSendIdle = function () {
    state.sendInFlight = false;
    if (dom.btnSend) { dom.btnSend.disabled = false; dom.btnSend.textContent = "发送"; }
    YB.updateInputState && YB.updateInputState();
  };
  if (dom.btnSend) {
    dom.btnSend.addEventListener("click", function () {
      if (dom.btnSend.disabled) return;
      // [0719 中途输入] 生成中点发送 → 本地待发送队列（显示在输入区上方，×可撤销，
      //   本轮输出完自动注入下一轮）——不占发送状态机，按钮即时可再排下一条
      if (state.isGenerating && YB.queuePendingSend) {
        YB.queuePendingSend();
        return;
      }
      state.sendInFlight = true;
      dom.btnSend.disabled = true;
      dom.btnSend.textContent = "…";
      YB.sendMessage();
    });
  }
  if (dom.msgInput) {
    dom.msgInput.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        // [0719 中途输入] 生成中允许发送（后端排队保序）；in-flight 锁由按钮 disabled 承担
        if (dom.btnSend) { dom.btnSend.click(); return; }
        YB.sendMessage();
      }
    });
    dom.msgInput.addEventListener("input", function () {
      YB.autoResizeInput();
    });
  }

  // 停止生成
  if (dom.btnStop) {
    dom.btnStop.addEventListener("click", function () {
      // 无论 generatingMessageId 是否存在都发送停止请求
      // T009 B6：无 id 发 null（后端 abortAll 全停）——原魔法串 "__force_stop__" 会流到后端 abortByMessageId 空转+泄漏进日志
      vscode.postMessage({
        type: "stopGeneration",
        payload: { messageId: state.generatingMessageId || null },
      });
      // 本地立即标记为非生成状态
      state.isGenerating = false;
      state.generatingMessageId = null;
      updateInputState();
    });
  }

  // 底部模式选择器
  if (dom.btnModeSelector) {
    dom.btnModeSelector.addEventListener("click", function () {
      togglePopup("mode");
    });
  }

  // 底部 API 源选择器 — 点击弹出 API 源列表，选中写回当前子模式 apiSource
  if (dom.btnApiSelector) {
    dom.btnApiSelector.addEventListener("click", function () {
      // 拉取最新 API 源列表（onApiSourceList → renderApiSourcePopupList）
      if (typeof YB.fetchApiSourceList === "function") YB.fetchApiSourceList();
      togglePopup("apiSource");
    });
  }

  // 底部模型选择器 — 点击弹出模型列表（apiPopup / #apiList）
  if (dom.btnModelSelector) {
    dom.btnModelSelector.addEventListener("click", function () {
      togglePopup("api");
    });
  }

  // 弹出层遮罩
  if (dom.popupBackdrop) {
    dom.popupBackdrop.addEventListener("click", function () {
      closePopup();
    });
  }

  // ═══════════════════════════════════════════════════════
  // 事件绑定 — 设置视图
  // ═══════════════════════════════════════════════════════

  // 完成按钮：回到聊天视图
  if (dom.btnSettingsDone) {
    dom.btnSettingsDone.addEventListener("click", function () {
      showView("chat");
    });
  }

  // 连接/断开
  if (dom.connectBtn) {
    dom.connectBtn.addEventListener("click", function () {
      dom.connectBtn.disabled = true; dom.connectBtn.textContent = "连接中…";
      vscode.postMessage({ type: "connect" });
      setTimeout(function() { dom.connectBtn.disabled = false; dom.connectBtn.textContent = "连接"; }, 10000);
    });
  }
  if (dom.disconnectBtn) {
    dom.disconnectBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "disconnect" });
      YB.showToast("已断开连接", 1500);
    });
  }

  // 登录（用户选择下拉）
  if (dom.loginBtn) {
    dom.loginBtn.addEventListener("click", function () {
      var sel = document.getElementById("userSelector");
      var username = sel ? sel.value : "";
      if (!username) { YB.showToast("请选择用户", 1500); return; }
      if (dom.loginError) dom.loginError.classList.add("hidden");
      // 持久化选择（经 patchState 单点写，散写收口 2026-07-13）
      YB.patchState({ _lastLoginUser: username });
      vscode.postMessage({
        type: "login",
        payload: { username: username, password: "" },
      });
    });
  }

  // 角色列表刷新
  if (dom.btnRefreshChars) {
    dom.btnRefreshChars.addEventListener("click", function () {
      vscode.postMessage({ type: "getCharList" });
      vscode.postMessage({ type: "getChatList" });
    });
  }

  // 聊天列表操作
  if (dom.btnNewChat) {
    dom.btnNewChat.addEventListener("click", function () {
      vscode.postMessage({
        type: "newChat",
        payload: { charName: state.selectedChar },
      });
    });
  }
  if (dom.btnRefreshChats) {
    dom.btnRefreshChats.addEventListener("click", function () {
      vscode.postMessage({ type: "getChatList" });
    });
  }

  // 子模式刷新
  if (dom.btnRefreshPresets) {
    dom.btnRefreshPresets.addEventListener("click", function () {
      vscode.postMessage({ type: "getPresetConfig" });
      vscode.postMessage({ type: "getSubModes" });
    });
  }

  // 分身刷新
  var btnRefreshClones = document.getElementById("btnRefreshClones");
  if (btnRefreshClones) {
    btnRefreshClones.addEventListener("click", function () {
      YB.fetchClones();
    });
  }

  // 记忆预设刷新
  if (dom.btnRefreshMemory) {
    dom.btnRefreshMemory.addEventListener("click", function () {
      vscode.postMessage({ type: "getMemoryConfig" });
    });
  }

  // 连接诊断
  if (dom.btnRunDiag) {
    dom.btnRunDiag.addEventListener("click", function () {
      vscode.postMessage({ type: "getConnectionDiag" });
    });
  }

  // ═══════════════════════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════════════════════

  // ★ 优先从 vscode.getState() 恢复（同步，不等 extension 消息）
  var hasLocalRestore = YB.restoreFromLocalState();

  // 根据恢复结果决定初始视图
  if (hasLocalRestore && state.currentView === "chat") {
    // 有本地缓存且之前在聊天页 → 先显示聊天（等连接后自动 switchToChat 加载消息）
    showView("chat");
  } else {
    showView(state.currentView || "settings");
  }

  YB.updateInputState();
  YB.renderSubModeBar();
  vscode.postMessage({ type: "getState" });
  vscode.postMessage({ type: "getWsStatus" });
  vscode.postMessage({ type: "getSubModes" });
  vscode.postMessage({ type: "getClones" });
  // ★ F1修复：移除启动时的 getApiSourceList，改为在连接成功后获取
})();

function showDisplaySettingsPopup() {
  if (document.getElementById("yb-display-settings")) return;
  var vscode = window.YB.vscode;
  var tags = window.YB._thinkingTags || ["thinking", "think"];

  var overlay = document.createElement("div");
  overlay.id = "yb-display-settings";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)";
  overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });

  var panel = document.createElement("div");
  panel.style.cssText = "background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:16px;max-width:320px;width:90%;max-height:80vh;overflow-y:auto";
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h3 style="margin:0;font-size:14px">💭 思维链标签配置</h3>' +
      '<button id="yb-ds-close" style="background:none;border:none;cursor:pointer;font-size:16px;opacity:0.6">✕</button>' +
    '</div>' +
    '<div style="font-size:11px;opacity:0.6;margin-bottom:8px">控制哪些标签的内容从 AI 上下文中剥离 + 前端折叠显示</div>' +
    '<div style="margin-bottom:8px">' +
      '<div style="font-size:11px;font-weight:600;margin-bottom:4px">内置标签</div>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="yb-ds-think" ' + (tags.indexOf("think") >= 0 ? 'checked' : '') + ' /> &lt;think&gt;</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="yb-ds-thinking" ' + (tags.indexOf("thinking") >= 0 ? 'checked' : '') + ' /> &lt;thinking&gt;</label>' +
    '</div>' +
    '<div style="margin-bottom:8px">' +
      '<div style="font-size:11px;font-weight:600;margin-bottom:4px">自定义标签</div>' +
      '<div id="yb-ds-custom"></div>' +
      '<button id="yb-ds-add" style="font-size:11px;background:none;border:1px dashed var(--vscode-panel-border);border-radius:4px;padding:2px 8px;cursor:pointer;margin-top:4px">+ 添加</button>' +
    '</div>' +
    // 机制硬编码收口（2026-07-13）：iframe sandbox 三档原只有渲染侧读 'beilu-iframe-sandbox'
    // （chat-messages.js getDisplayHtml full-html 分支），YonBan 无任何写入口=档位永远 strict 死值。
    // UI/键名/默认对齐本体 settings.mjs F-T4（change 即存，默认 strict 不降级安全默认）。
    '<div style="margin-bottom:8px">' +
      '<div style="font-size:11px;font-weight:600;margin-bottom:4px">HTML 消息沙箱（iframe 渲染档位）</div>' +
      '<select id="yb-ds-sandbox" style="width:100%;font-size:11px;padding:3px 4px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;color:var(--vscode-input-foreground)">' +
        '<option value="strict">strict — 默认（脚本可跑，无 same-origin，防 XSS）</option>' +
        '<option value="standard">standard — 含 same-origin（owner 显式选择）</option>' +
        '<option value="sandbox">sandbox — 最严格（仅脚本）</option>' +
      '</select>' +
    '</div>' +
    '<button id="yb-ds-save" style="font-size:12px;padding:4px 12px;border:none;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer">保存</button>';

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  panel.querySelector("#yb-ds-close").addEventListener("click", function() { overlay.remove(); });

  // iframe sandbox 档位：读写同一键（渲染侧 chat-messages.js:full-html 分支消费），change 即存对齐本体
  var sandboxSel = panel.querySelector("#yb-ds-sandbox");
  if (sandboxSel) {
    try { sandboxSel.value = localStorage.getItem("beilu-iframe-sandbox") || "strict"; } catch (_) {}
    sandboxSel.addEventListener("change", function () {
      try { localStorage.setItem("beilu-iframe-sandbox", sandboxSel.value); } catch (_) {}
      window.YB.showToast("沙箱档位已存: " + sandboxSel.value + "（对之后渲染的 HTML 消息生效）", 2500);
    });
  }

  var customTags = tags.filter(function(t) { return t !== "think" && t !== "thinking"; });
  var customContainer = panel.querySelector("#yb-ds-custom");
  customTags.forEach(function(t, i) {
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:4px";
    row.innerHTML = '<input type="text" value="' + t + '" style="flex:1;font-size:11px;padding:2px 4px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;color:var(--vscode-input-foreground)" /><button style="background:none;border:none;cursor:pointer;opacity:0.6">✖</button>';
    row.querySelector("button").addEventListener("click", function() { row.remove(); });
    customContainer.appendChild(row);
  });

  panel.querySelector("#yb-ds-add").addEventListener("click", function() {
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:4px";
    row.innerHTML = '<input type="text" placeholder="标签名" style="flex:1;font-size:11px;padding:2px 4px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;color:var(--vscode-input-foreground)" /><button style="background:none;border:none;cursor:pointer;opacity:0.6">✖</button>';
    row.querySelector("button").addEventListener("click", function() { row.remove(); });
    customContainer.appendChild(row);
  });

  panel.querySelector("#yb-ds-save").addEventListener("click", function() {
    var btn = panel.querySelector("#yb-ds-save");
    var builtin = {
      think: !!panel.querySelector("#yb-ds-think").checked,
      thinking: !!panel.querySelector("#yb-ds-thinking").checked
    };
    var customInputs = customContainer.querySelectorAll("input");
    var customPairs = [];
    customInputs.forEach(function(inp) {
      var name = inp.value.trim().replace(/[<>/\s]/g, "");
      if (name && /^[\w-]+$/.test(name)) customPairs.push({ open: "<" + name + ">", close: "</" + name + ">" });
    });
    btn.textContent = "⏳";
    vscode.postMessage({ type: "updateReasoningConfig", builtin: builtin, tags: customPairs });
    setTimeout(function() { overlay.remove(); }, 1000);
  });
}
