/**
 * [chat-connection] — 连接状态 + 角色/聊天列表数据处理 + 持久化恢复。
 * 不管 UI 渲染（角色/聊天条状列表渲染委托给 chat-settings.js）。不管消息/流式/模式（那是 chat-messages / chat-modes 的事）。
 *
 * 链路：Extension connectionState/charList/chatList/... → chat.js 路由 → 本模块 handler
 *       → 数据写入 state → 委托 chat-settings.js 渲染
 * 影响：写 state(connectionStatus/charNames/charMeta/allChats/chatListData/currentChatId)；
 *       操作 DOM(连接指示灯/服务器信息/按钮显隐)；调 YB.saveUserState 持久化
 * 相交：← chat.js(消息路由)  → chat-settings.js(renderCharStripList/renderChatStripList 渲染委托)
 *        → chat-messages.js(switchToChat 切对话)  → chat-modes.js(startTokenPoll/startMemoryPoll)
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — 连接状态 onConnectionState（connected 时自动拉角色/聊天/子模式/API 源/预设）
 *   — 登录结果 onLoginResult
 *   — WS 状态 onWsStatus（IDE WS 服务器状态显示）
 *   — 角色列表 onCharList / onCharDetails / updateCharChatCounts
 *   — 聊天列表 onChatList / onNewChatCreated / onChatDeleted
 *   — 持久化恢复 onRestoreUserState（_pendingRestore 机制：连接前收到恢复数据则挂起等连接后触发）
 *   — 导出到 YB 命名空间
 */
// =====================================================
// chat-connection.js — 连接层 (V2 两视图重构)
// 连接状态、登录、WS状态
// 角色/聊天列表渲染委托给 chat-settings.js
// =====================================================

(function () {
  "use strict";
  try {
  const { dom, state, vscode, STATUS_LABELS, showView, escapeHtml } = window.YB;

  // ═══════════════════════════════════════════════════════
  // 连接状态
  // ═══════════════════════════════════════════════════════

  // ★ 恢复链幂等判据（单源，onConnectionState 与 onRestoreUserState 两个恢复触发点共用）：
  //   该对话已在聊天视图渲染出消息 = 无需再切。恢复触发点有两个是设计（本地快照恢复走 connected
  //   分支、globalState 恢复走 restoreUserState，缺一有漏恢复场景），但双触发/面板 visibility
  //   变化重推 connectionState 会重复 switchToChat → 消息区闪回"加载中"+冗余请求（2026-07-15 病型扫描 1-A/1-B）。
  //   断连清空 messages + 切 settings 视图，故重连场景不会被此判据误挡。
  function _alreadyShowingChat(chatId) {
    return state.currentChatId === chatId && state.currentView === "chat" && state.messages.length > 0;
  }

  function onConnectionState(p) {
    state.connectionStatus = p.status;
    state.serverUrl = p.serverUrl || "";

    var connDot = document.getElementById("connDot");
    if (connDot) {
      if (p.status === "connected") { connDot.style.display = "none"; }
      else { connDot.style.display = "inline-block"; connDot.style.background = p.status === "error" ? "var(--vscode-errorForeground,#f44)" : p.status === "connecting" ? "var(--vscode-editorWarning-foreground,#f90)" : "var(--vscode-descriptionForeground,#999)"; connDot.title = p.status === "error" ? "连接错误" : p.status === "connecting" ? "连接中..." : "未连接"; }
    }
    if (dom.statusBadge) {
      dom.statusBadge.className = "status-badge status-" + p.status;
    }
    if (dom.statusText) {
      dom.statusText.textContent = STATUS_LABELS[p.status] || p.status;
    }

    if (p.status === "connected") {
      if (dom.serverInfo) dom.serverInfo.classList.remove("hidden");
      if (dom.serverUrl) dom.serverUrl.textContent = p.serverUrl || "-";
      if (dom.serverVer) {
        dom.serverVer.textContent =
          p.serverInfo?.ver || p.serverInfo?.version || "-";
      }
      if (dom.serverUser) {
        dom.serverUser.textContent = p.username || "未登录";
      }

      if (dom.connectBtn) dom.connectBtn.classList.add("hidden");
      if (dom.disconnectBtn) dom.disconnectBtn.classList.remove("hidden");

      if (p.authenticated) {
        if (dom.loginForm) dom.loginForm.classList.add("hidden");

        // 加载数据
        vscode.postMessage({ type: "getCharList" });
        vscode.postMessage({ type: "getChatList" });
        vscode.postMessage({ type: "getSubModes" });
        // ★ F1修复：连接成功后获取API源列表和预设列表
        vscode.postMessage({ type: "getApiSourceList" });
        vscode.postMessage({ type: "getPresetConfig" });

        // 如果已绑定角色且有聊天（含恢复的状态），自动进入聊天
        if (state.hasBoundChar && state.currentChatId && !_alreadyShowingChat(state.currentChatId)) {
          // 恢复聊天（无论是 pendingRestore 还是 localState 恢复的）
          _pendingRestore = false;
          YB.switchToChat(state.currentChatId, null);
        }
        // 否则保持当前视图（设置页）
      } else {
        if (dom.loginForm) dom.loginForm.classList.remove("hidden");
        vscode.postMessage({ type: "getUserList" });
      }
    } else {
      if (dom.serverInfo) dom.serverInfo.classList.add("hidden");
      if (dom.loginForm) dom.loginForm.classList.add("hidden");
      if (dom.connectBtn) dom.connectBtn.classList.remove("hidden");
      if (dom.disconnectBtn) dom.disconnectBtn.classList.add("hidden");

      // 清理状态——只清【会话运行态】，不清【用户选择】(currentChatId/selectedChar/hasBoundChar)。
      // ★ 断连是系统事件不是用户意图：此处若清 currentChatId=null，下面 showView("settings")
      //   会经 chat-core saveUserState 把 null 全量覆盖写进 vscode.setState + globalState 两个持久源，
      //   抹掉"上次对话"记忆（切目录/重启后回到初始状态的根因，2026-07-15 确诊）。
      //   保留内存值安全：发送有 canSend(connected) 双守卫、轮询已停、断连无 WS 推送；
      //   且重连后 connected 分支靠它自动 switchToChat 恢复对话。
      state.charNames = [];
      state.charMeta = {};
      state.allChats = [];
      state.chatListData = [];
      state.messages = [];
      state.isGenerating = false;
      state.streamingContent = {};
      YB.stopTokenPoll();
      YB.stopMemoryPoll();
      // 断连停轮询清单必须完整：approval poll 原漏在清单外，断连后持续空转发 getIdeApprovals（病型扫描 3-A）
      YB.stopApprovalPoll();

      // 确保在设置页
      showView("settings");

      // 清空角色/聊天列表
      if (dom.charList) {
        dom.charList.innerHTML =
          '<div class="strip-empty">连接后加载角色列表</div>';
      }
      if (dom.chatListSection) {
        dom.chatListSection.classList.add("hidden");
      }
    }

    if (p.status === "error") {
      if (dom.serverInfo) dom.serverInfo.classList.remove("hidden");
      if (dom.serverUrl) dom.serverUrl.textContent = p.serverUrl || "-";
      if (dom.serverVer) dom.serverVer.textContent = p.error || "-";
    }
  }

  function onLoginResult(p) {
    if (!p.success) {
      if (dom.loginError) {
        dom.loginError.textContent = p.error;
        dom.loginError.classList.remove("hidden");
      }
    } else {
      if (dom.loginError) dom.loginError.classList.add("hidden");
    }
  }

  function onWsStatus(p) {
    if (dom.wsStatusText) {
      dom.wsStatusText.textContent = p.running ? "运行中 ✓" : "已停止";
      dom.wsStatusText.style.color = p.running ? "var(--vscode-testing-iconPassed)" : "";
    }
    if (dom.wsPort) dom.wsPort.textContent = p.port || "-";
    if (dom.wsClients) dom.wsClients.textContent = p.clients || "0";
  }

  // ═══════════════════════════════════════════════════════
  // 多开路由徽章（2026-07-26 多窗口 YonBan）
  // 顶栏显示：本窗口桥接端口 + 工作区名；颜色=路由健康度
  //   ok(绿)=本体已连本窗口且当前对话路由到本窗口
  //   warn(黄)=本体连了但当前对话路由到别的窗口 / 池状态未知（后端未升级）
  //   off(灰)=本体没连到本窗口（工具调用会打到别的实例）
  // ═══════════════════════════════════════════════════════
  function onIdeBindingStatus(p) {
    var b = document.getElementById("ideBindBadge");
    if (!b) return;
    p = p || {};
    var myPort = p.myPort;
    if (!myPort) { b.classList.add("hidden"); return; }
    var inst = null;
    if (Array.isArray(p.instances)) {
      for (var i = 0; i < p.instances.length; i++) {
        if (p.instances[i] && p.instances[i].port === myPort) { inst = p.instances[i]; break; }
      }
    }
    var chatId = p.currentChatId || state.currentChatId;
    var boundPort = (p.bindings && chatId) ? p.bindings[chatId] : undefined;
    var connected = !!(inst && inst.connected);
    // 路由到本窗口 = 显式绑定本端口，或无绑定但本窗口是主连接
    var routedHere = connected && (boundPort === myPort || (boundPort == null && p.primaryPort === myPort));
    var wsName = p.myWorkspace ? String(p.myWorkspace).replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
    b.textContent = "⛓" + myPort + (wsName ? "·" + wsName : "");
    b.classList.remove("hidden", "ok", "warn", "off");
    b.classList.add(p.error ? "warn" : (connected ? (routedHere ? "ok" : "warn") : "off"));
    b.title = p.error
      ? ("本体连接池状态未知（后端未升级或未连接）\n本窗口桥接端口: " + myPort + (p.myWorkspace ? "\n工作区: " + p.myWorkspace : ""))
      : ("本窗口桥接端口: " + myPort
        + (p.myWorkspace ? "\n工作区: " + p.myWorkspace : "")
        + "\n本体连接本窗口: " + (connected ? "已连接 ✓" : "未连接 ✗")
        + (chatId
          ? ("\n当前对话路由: " + (boundPort != null
            ? ("端口 " + boundPort + (boundPort === myPort ? "（本窗口 ✓）" : "（其他窗口 ⚠）"))
            : (p.primaryPort === myPort ? "主连接（本窗口 ✓）" : "主连接（端口 " + p.primaryPort + " ⚠）")))
          : ""));
  }

  // ═══════════════════════════════════════════════════════
  // 角色列表（数据处理，渲染委托给 chat-settings.js）
  // ═══════════════════════════════════════════════════════

  function onCharList(payload) {
    if (payload?.error) {
      console.warn("[chat-connection] 获取角色列表失败:", payload.error);
      if (dom.charList) {
        dom.charList.innerHTML =
          '<div class="strip-empty">⚠ 加载失败: ' +
          escapeHtml(String(payload.error)) +
          "</div>";
      }
      return;
    }

    const names = Array.isArray(payload) ? payload : [];
    state.charNames = names;

    for (const name of names) {
      if (!state.charMeta[name]) {
        state.charMeta[name] = { name, chatCount: 0 };
      }
    }

    updateCharChatCounts();
    // 委托给 chat-settings.js 渲染
    if (YB.renderCharStripList) YB.renderCharStripList();
  }

  function onCharDetails(payload) {
    if (payload?.error) return;
    const { charName, details } = payload;
    if (!state.charMeta[charName]) {
      state.charMeta[charName] = { name: charName, chatCount: 0 };
    }
    if (details?.info?.avatar) {
      state.charMeta[charName].avatarUrl = details.info.avatar;
    }
  }

  function updateCharChatCounts() {
    for (const name of state.charNames) {
      if (state.charMeta[name]) state.charMeta[name].chatCount = 0;
    }
    for (const chat of state.allChats) {
      const chars = chat.chars || [];
      for (const c of chars) {
        if (state.charMeta[c]) {
          state.charMeta[c].chatCount++;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 聊天列表（数据处理，渲染委托给 chat-settings.js）
  // ═══════════════════════════════════════════════════════

  function onChatList(payload) {
    if (payload?.error) {
      console.warn("[chat-connection] 获取聊天列表失败:", payload.error);
      YB.showToast("⚠ 聊天列表加载失败", 2000);
      return;
    }

    state.allChats = Array.isArray(payload) ? payload : [];
    updateCharChatCounts();

    // 重新渲染角色列表（更新聊天数）
    if (YB.renderCharStripList) YB.renderCharStripList();

    // 如果已选中角色，更新聊天列表
    if (state.selectedChar) {
      state.chatListData = state.allChats.filter((chat) => {
        const chars = chat.chars || [];
        return chars.includes(state.selectedChar);
      });
      if (YB.renderChatStripList) YB.renderChatStripList();
    }
  }

  // ── 新建/删除聊天响应 ─────────────────────────────

  function onNewChatCreated(data) {
    const { chatId, charName } = data;
    if (chatId) {
      YB.switchToChat(chatId, {
        chatid: chatId,
        chars: charName ? [charName] : [],
      });
      // 新建后自动进聊天视图
      showView("chat");
    }
  }

  function onChatDeleted(data) {
    const { chatId } = data;
    if (state.currentChatId === chatId) {
      state.currentChatId = null;
      state.messages = [];
      YB.saveUserState(); // 清除持久化的chatId
      YB.stopTokenPoll();
      YB.stopMemoryPoll();
      if (dom.tokenBar) dom.tokenBar.classList.add("hidden");
      if (dom.memoryStatusBar) dom.memoryStatusBar.classList.add("hidden");
      // 回到设置页
      showView("settings");
    }
  }

  // ═══════════════════════════════════════════════════════
  // 持久化状态恢复
  // ═══════════════════════════════════════════════════════

  /**
   * 持久化恢复的时序问题：Extension 可能在连接建立前就推 restoreUserState。
   * 注意（2026-07-15 注释校准）：connected 后真正触发 switchToChat 的是 onConnectionState 里
   * `hasBoundChar && currentChatId` 条件（restoreUserState 已把值写进 state），_pendingRestore
   * 本身只被置位和清零、不参与触发判断——它当前仅是"曾有待恢复"的记号。
   * 不要把 _pendingRestore 移到 state 里——它是一次性信号，用完即弃，不参与持久化。
   * @type {boolean}
   */
  var _pendingRestore = false;

  function onRestoreUserState(saved) {
    if (!saved) return;
    if (saved.selectedChar) state.selectedChar = saved.selectedChar;
    if (saved.currentChatId) state.currentChatId = saved.currentChatId;
    if (saved.hasBoundChar) state.hasBoundChar = true;
    if (saved.currentView) state.currentView = saved.currentView;

    // ★ W66修复：恢复 autoContinue 等设置到持久状态（经 patchState 单点合并，散写收口 2026-07-13）
    YB.patchState(saved);
    // 同步 UI checkbox
    var ac = document.getElementById("aiAutoContinue");
    if (ac && saved.autoContinue !== undefined) ac.checked = !!saved.autoContinue;
    var msc = document.getElementById("aiModeSwitchClean");
    if (msc && saved.modeSwitchCleanup !== undefined) msc.checked = !!saved.modeSwitchCleanup;

    // 如果已经连接且有聊天ID，直接恢复（不等 connectionState）
    if (state.hasBoundChar && state.currentChatId && state.connectionStatus === "connected") {
      if (_alreadyShowingChat(state.currentChatId)) return; // connected 分支已恢复完成，防双切
      console.log("[chat-connection] 直接恢复聊天:", state.currentChatId);
      YB.switchToChat(state.currentChatId, null);
    } else if (state.hasBoundChar && state.currentChatId) {
      // 还没连接，标记待恢复，等 connectionState connected 时触发
      _pendingRestore = true;
    }
  }

  // ── 用户列表（选择用户替代手动输入登录） ─────────────
  function onUserList(payload) {
    var sel = document.getElementById("userSelector");
    if (!sel) return;
    sel.innerHTML = "";
    var users = (payload && Array.isArray(payload.users)) ? payload.users : [];
    if (users.length === 0) {
      var optEmpty = document.createElement("option");
      optEmpty.value = "";
      optEmpty.textContent = "无用户";
      sel.appendChild(optEmpty);
      return;
    }
    // 从持久化读上次选择的用户
    var saved = vscode.getState() || {};
    var lastUser = saved._lastLoginUser || "";
    for (var i = 0; i < users.length; i++) {
      var u = typeof users[i] === "string" ? users[i] : (users[i].username || users[i].name || "");
      if (!u) continue;
      var opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      if (u === lastUser) opt.selected = true;
      sel.appendChild(opt);
    }
    // 如果有上次用户且在列表中，自动登录
    if (lastUser && users.some(function(u) { return (typeof u === "string" ? u : u.username || u.name) === lastUser; })) {
      vscode.postMessage({ type: "login", payload: { username: lastUser, password: "" } });
    }
  }

  // ── 导出到 YB ─────────────────────────────────────
  YB.onConnectionState = onConnectionState;
  YB.onLoginResult = onLoginResult;
  YB.onWsStatus = onWsStatus;
  YB.onIdeBindingStatus = onIdeBindingStatus;
  YB.onCharList = onCharList;
  YB.onCharDetails = onCharDetails;
  YB.onChatList = onChatList;
  YB.onNewChatCreated = onNewChatCreated;
  YB.onChatDeleted = onChatDeleted;
  YB.updateCharChatCounts = updateCharChatCounts;
  YB.onRestoreUserState = onRestoreUserState;
  YB.onUserList = onUserList;
  } catch(e) { try { window.YB.showToast("\uD83D\uDEA8 chat-connection 加载失败: " + e.message, 8000); } catch(_) {} console.error("[chat-connection] 加载失败:", e); }
})();
