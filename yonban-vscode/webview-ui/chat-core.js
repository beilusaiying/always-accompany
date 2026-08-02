/**
 * [chat-core] — YonBan webview 基础设施层（唯一的 IIFE 返回值挂载 window.YB）。
 * 不管业务逻辑（消息/连接/模式/设置各自注册 handler 到 YB 命名空间）。
 *
 * 链路：HTML 加载 → 本文件最先执行 → window.YB = { vscode, dom, state, ... }
 *       → 后续所有模块通过 `var YB = window.YB` 访问共享基础设施
 * 影响：acquireVsCodeApi() 只能调用一次(VSCode webview 约束)，本模块持有唯一 vscode 对象；
 *       写 vscode.setState(持久化)；操作 DOM classList(视图/Tab/弹出层切换)；写 _wbRing(白盒环形缓冲)
 * 相交：← 无上游（最先加载）  → 所有其他模块(chat-*.js / cards.js)依赖本模块导出
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — vscode = acquireVsCodeApi()（唯一实例）
 *   — DOM helpers（$ 选择器）
 *   — 两视图 DOM 容器（chat / settings）
 *   — 全部 DOM 引用集合（dom 对象，~130 个元素引用）
 *   — 应用状态集合（state 对象，~30 个状态字段 + JSDoc 类型标注）
 *   — STATUS_LABELS 常量
 *   — getSubModes/cacheSubModes（T010 子模式单源：定义在后端 storage.mjs，此处只做下发缓存回落）
 *   — showView（两视图切换 + 输入框草稿保存/恢复）
 *   — switchSettingsTab（设置页 Tab 切换）
 *   — 弹出层控制（openPopup / closePopup / togglePopup / showFloatingPopup）
 *   — showToast（通知 toast，2s 自动消失）
 *   — 工具函数（scrollToBottom / formatTimestamp / formatTime / escapeHtml）
 *   — 持久化（saveUserState → vscode.setState / restoreFromLocalState → vscode.getState）
 *   — showInputDialog（模态输入对话框，替代不可用的 window.prompt）
 *   — 白盒追踪（wbTrace / wbDetect / getWbRing — 环形缓冲 500 条运行时追踪记录）
 *   — return 共享对象
 */
// =====================================================
// chat-core.js — 核心层 (V2 两视图重构)
// 状态管理、DOM引用、视图切换、工具函数
// 通过 window.YB 全局命名空间共享
// =====================================================

// @ts-check
/* global acquireVsCodeApi */

window.YB = (function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  // ── DOM helpers ─────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);

  // ── 两视图 DOM ────────────────────────────────────────
  const views = {
    chat: $("#viewChat"),
    settings: $("#viewSettings"),
  };

  // ── 全部 DOM 引用 ───────────────────────────────────
  const dom = {
    // ── 聊天视图 ──────────────────
    chatTitle: $("#chatTitle"),
    btnSettings: $("#btnSettings"),
    btnDisplaySettings: $("#btnDisplaySettings"),

    // Token 进度条
    tokenBar: $("#tokenBar"),
    tokenBarFill: $("#tokenBarFill"),
    tokenBarLabel: $("#tokenBarLabel"),
    btnCompact: $("#btnCompact"),

    // 记忆状态指示器
    memoryStatusBar: $("#memoryStatusBar"),
    memoryStatusText: $("#memoryStatusText"),

    // F3/Y2 任务打勾卡
    taskCard: $("#taskCard"),

    // B3/Y6 权限档位徽章
    permBadge: $("#permBadge"),

    // 提示词查看器
    btnPromptViewer: $("#btnPromptViewer"),
    promptViewerPanel: $("#promptViewerPanel"),
    pvBuildBtn: $("#pvBuildBtn"),
    pvCopyBtn: $("#pvCopyBtn"),
    pvStats: $("#pvStats"),
    pvMessageList: $("#pvMessageList"),

    // 消息列表
    messageList: $("#messageList"),
    typingIndicator: $("#typingIndicator"),
    typingNames: $("#typingNames"),

    // 输入区
    msgInput: $("#msgInput"),
    btnSend: $("#btnSend"),
    btnStop: $("#btnStop"),

    // 底部模式/API源/模型选择器
    btnModeSelector: $("#btnModeSelector"),
    btnApiSelector: $("#btnApiSelector"),
    btnModelSelector: $("#btnModelSelector"),
    activeModeLabel: $("#activeModeLabel"),
    activeApiSourceLabel: $("#activeApiSourceLabel"),
    activeApiLabel: $("#activeApiLabel"),

    // 弹出层
    modePopup: $("#modePopup"),
    apiSourcePopup: $("#apiSourcePopup"),
    apiPopup: $("#apiPopup"),
    hamburgerPopup: $("#hamburgerPopup"),
    submodeBar: $("#submodeBar"),
    apiSourceList: $("#apiSourceList"),
    apiList: $("#apiList"),
    popupBackdrop: $("#popupBackdrop"),

    // ☰ 汉堡菜单
    btnHamburger: $("#btnHamburger"),
    hmWebSearch: $("#hmWebSearch"),

    // 悬浮弹窗
    tokenSettingsPopup: $("#tokenSettingsPopup"),
    tokenSettingsClose: $("#tokenSettingsClose"),
    fpMaxContext: $("#fpMaxContext"),
    fpMaxTokens: $("#fpMaxTokens"),
    fpWarnPct: $("#fpWarnPct"),
    fpDangerPct: $("#fpDangerPct"),
    fpSaveBtn: $("#fpSaveBtn"),
    fpStatus: $("#fpStatus"),
    ideApprovalsPopup: $("#ideApprovalsPopup"),
    ideApprovalsClose: $("#ideApprovalsClose"),
    ideApprovalsList: $("#ideApprovalsList"),
    iaApproveAll: $("#iaApproveAll"),
    iaRejectAll: $("#iaRejectAll"),

    // ── 设置视图 ──────────────────
    btnSettingsDone: $("#btnSettingsDone"),

    // 设置 Tab
    settingsTabs: document.querySelectorAll(".settings-tab"),
    settingsTabPanels: document.querySelectorAll(".settings-tab-panel"),

    // 连接Tab
    statusBadge: $("#statusBadge"),
    statusText: $("#statusText"),
    serverInfo: $("#serverInfo"),
    serverUrl: $("#serverUrl"),
    serverVer: $("#serverVer"),
    serverUser: $("#serverUser"),
    loginForm: $("#loginForm"),
    loginBtn: $("#loginBtn"),
    loginError: $("#loginError"),
    connectBtn: $("#connectBtn"),
    disconnectBtn: $("#disconnectBtn"),
    usernameInput: $("#username"),
    passwordInput: $("#password"),
    wsStatusText: $("#wsStatusText"),
    wsPort: $("#wsPort"),
    wsClients: $("#wsClients"),

    // 诊断
    btnRunDiag: $("#btnRunDiag"),
    diagResults: $("#diagResults"),

    // 角色卡列表
    charList: $("#charList"),
    btnRefreshChars: $("#btnRefreshChars"),

    // 聊天列表
    chatListSection: $("#chatListSection"),
    chatList: $("#chatList"),
    chatListTitle: $("#chatListTitle"),
    btnNewChat: $("#btnNewChat"),
    btnRefreshChats: $("#btnRefreshChats"),

    // 记忆Tab
    memoryPresetList: $("#memoryPresetList"),
    btnRefreshMemory: $("#btnRefreshMemory"),

    // 子模式Tab
    submodeList: $("#submodeList"),
    btnRefreshPresets: $("#btnRefreshPresets"),
  };

  // ── 应用状态 ────────────────────────────────────────
  const state = {
    /** @type {"chat"|"settings"} 当前视图 */
    currentView: "settings", // 首次启动进设置页
    /** @type {string} 当前设置Tab */
    activeSettingsTab: "connect",

    /** @type {"disconnected"|"connecting"|"connected"|"error"} */
    connectionStatus: "disconnected",
    /** @type {string} */
    serverUrl: "",

    // 角色
    /** @type {string[]} */
    charNames: [],
    /** @type {Object<string, {name:string, avatarUrl?:string, chatCount:number}>} */
    charMeta: {},

    // 绑定的角色（持久化）
    /** @type {string|null} */
    selectedChar: null,

    // 聊天
    /** @type {Array<Object>} */
    chatListData: [],
    /** @type {Array<Object>} */
    allChats: [],

    // 消息
    /** @type {string|null} */
    currentChatId: null,
    /** @type {Array<{id:string, role:string, name?:string, content:string, content_for_show?:string, time_stamp?:string, is_generating?:boolean}>} */
    messages: [],
    /** @type {boolean} */
    isGenerating: false,
    /** @type {string|null} */
    generatingMessageId: null,
    /** @type {Object<string, string>} */
    streamingContent: {},
    /** @type {number|null} */
    renderRAF: null,
    /** @type {boolean} */
    streamDirty: false,

    // 子模式
    /** @type {string} T010（T003 移交连带）：初值须是合法子模式 ID——原 "code" 是模式组名非子模式 ID（合法集=后端 DEFAULT_CODE_SUB_MODES，默认活跃=task-confirm，对齐 setDataActions getSubModes 播种值） */
    activeSubMode: "task-confirm",
    /** @type {string} */
    activePreset: "",

    // Token 进度条
    /** @type {number|null} */
    tokenUsed: null,
    /** @type {number|null} */
    tokenTotal: null,
    /** @type {ReturnType<typeof setInterval>|null} */
    tokenPollTimer: null,

    // 记忆预设
    /** @type {Array<{id:string, name:string, enabled:boolean, description?:string}>} */
    memoryPresets: [],
    /** @type {Array<{id:string, name:string, enabled:boolean, description?:string}>} */
    injectionPrompts: [],
    /** @type {ReturnType<typeof setInterval>|null} */
    memoryPollTimer: null,
    /** @type {number} */
    lastMemoryOutputId: 0,
    /** @type {string|null} */
    memoryStatusMsg: null,

    /** @type {Array<{id:string,label:string,icon:string,desc:string,presetName:string,enabled:boolean,apiSource?:string}>} */
    subModes: [],

    // 预设名列表（供子模式表单下拉用）
    /** @type {string[]} */
    presetNames: [],

    // 提示词查看器
    /** @type {boolean} */
    promptViewerOpen: false,
    /** @type {Object|null} */
    lastPromptData: null,

    // 消息索引偏移
    /** @type {number} */
    logOffset: 0,

    // 弹出层状态
    /** @type {"mode"|"api"|null} */
    activePopup: null,

    // API 源
    /** @type {string[]} */
    apiSources: [],
    /** @type {string} */
    activeApiSource: "",

    // 持久化标记：是否已绑定过角色（用于决定首次进设置页还是聊天页）
    /** @type {boolean} */
    hasBoundChar: false,
  };

  // ── 默认模式组（T003 单源升级 2026-07-09：provider 生成 html 时注入 <body data-default-mode>
  //    = constants.ts DEFAULT_MODE 真单源（初版 inline script 注入被 webview CSP script-src 拒=死注入，
  //    传导链追踪抓出后改 data 属性）。本处只留异常态兜底字面量（属性缺失=旧 html 缓存/异常）。
  //    chat-modes.js 等经 YB.DEFAULT_MODE 引用，禁再写字面量缺省） ──
  const DEFAULT_MODE = (document.body && document.body.dataset.defaultMode) || "code";

  // ── 轮询间隔单源（2026-07-13 收口：真源=src/constants.ts *_POLL_MS，provider 生成 html 时注入
  //    <body data-poll-cfg>（同 T003 data 属性范式）。此处字面量仅属性缺失/解析失败时的等值退化，
  //    改间隔改 constants.ts，禁在消费点另写数字） ──
  const POLL = (function () {
    var fallback = { token: 30000, memory: 15000, approval: 3000, group: 60000 };
    try {
      var raw = document.body && document.body.dataset.pollCfg;
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return {
        token: Number(parsed.token) > 0 ? Number(parsed.token) : fallback.token,
        memory: Number(parsed.memory) > 0 ? Number(parsed.memory) : fallback.memory,
        approval: Number(parsed.approval) > 0 ? Number(parsed.approval) : fallback.approval,
        group: Number(parsed.group) > 0 ? Number(parsed.group) : fallback.group,
      };
    } catch (e) { return fallback; }
  })();

  const STATUS_LABELS = {
    disconnected: "未连接",
    connecting: "连接中…",
    connected: "已连接",
    error: "连接错误",
  };

  // ── T010 子模式单源 ──────────────────────────────────
  // 定义唯一源=后端 storage.mjs DEFAULT_CODE_SUB_MODES/DEFAULT_WORK_SUB_MODES（getSubModes verb 下发，
  // 空配置时后端自动播种落盘，正常链路必返回非空）。原 9 个前端定义副本已删——三处副本各自演化
  // （后端11 code/本体18/YonBan9）即双源病活体，手工对齐=补丁，下次必再漂。
  // 取数失败语义：上次成功下发的 localStorage 缓存 → 无缓存返回 null（调用方渲染明确失败态，
  // 不拿旧假数据装正常）。
  const SUBMODES_CACHE_KEY = "yb-submodes-cache";

  /** @returns {Array|null} 子模式集；null=后端未下发且无本地缓存（加载失败态） */
  function getSubModes() {
    if (state.subModes && state.subModes.length > 0) return state.subModes;
    try {
      const cached = JSON.parse(localStorage.getItem(SUBMODES_CACHE_KEY) || "null");
      if (Array.isArray(cached) && cached.length > 0) return cached;
    } catch (e) { /* 缓存损坏视同无缓存 */ }
    return null;
  }

  /** 后端下发成功后调用，写"上次成功集合"缓存 */
  function cacheSubModes(modes) {
    if (!Array.isArray(modes) || modes.length === 0) return;
    try { localStorage.setItem(SUBMODES_CACHE_KEY, JSON.stringify(modes)); } catch (e) { /* 配额等失败不阻塞 */ }
  }

  // ── 视图切换（两视图） ──────────────────────────────
  /** @param {"chat"|"settings"} name */
  function showView(name) {
    // 切离聊天视图时保存输入框草稿
    if (state.currentView === "chat" && name !== "chat" && dom.msgInput) {
      state._inputDraft = dom.msgInput.value || "";
    }
    state.currentView = name;
    for (const [key, el] of Object.entries(views)) {
      if (el) el.classList.toggle("hidden", key !== name);
    }
    // 切回聊天视图时恢复草稿
    if (name === "chat" && dom.msgInput && state._inputDraft) {
      dom.msgInput.value = state._inputDraft;
    }
    // 关闭弹出层
    closePopup();
    // 持久化视图状态
    saveUserState();
  }

  // ── 设置 Tab 切换 ──────────────────────────────────
  /** @param {string} tabName */
  function switchSettingsTab(tabName) {
    state.activeSettingsTab = tabName;
    dom.settingsTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
    });
    dom.settingsTabPanels.forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.tabPanel !== tabName);
    });
  }

  // ── 弹出层控制 ────────────────────────────────────
  /** @param {"mode"|"api"|"hamburger"} type */
  function openPopup(type) {
    closePopup();
    state.activePopup = type;
    if (type === "mode" && dom.modePopup) {
      dom.modePopup.classList.remove("hidden");
    } else if (type === "apiSource" && dom.apiSourcePopup) {
      dom.apiSourcePopup.classList.remove("hidden");
    } else if (type === "api" && dom.apiPopup) {
      dom.apiPopup.classList.remove("hidden");
    } else if (type === "hamburger" && dom.hamburgerPopup) {
      dom.hamburgerPopup.classList.remove("hidden");
    }
    if (dom.popupBackdrop) dom.popupBackdrop.classList.remove("hidden");
  }

  function closePopup() {
    state.activePopup = null;
    if (dom.modePopup) dom.modePopup.classList.add("hidden");
    if (dom.apiSourcePopup) dom.apiSourcePopup.classList.add("hidden");
    if (dom.apiPopup) dom.apiPopup.classList.add("hidden");
    if (dom.hamburgerPopup) dom.hamburgerPopup.classList.add("hidden");
    if (dom.popupBackdrop) dom.popupBackdrop.classList.add("hidden");
  }

  /** 悬浮弹窗控制 */
  function showFloatingPopup(id) {
    closeAllFloatingPopups();
    var el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
  }

  function closeAllFloatingPopups() {
    if (dom.tokenSettingsPopup) dom.tokenSettingsPopup.classList.add("hidden");
    if (dom.ideApprovalsPopup) dom.ideApprovalsPopup.classList.add("hidden");
    // 后加入的悬浮窗（错误中心/改动历史）原不在关闭清单=showFloatingPopup 互斥失效双窗叠加（2026-07-13 追链抓出）
    var _ec = document.getElementById("errorCenterPopup");
    if (_ec) _ec.classList.add("hidden");
    var _eh = document.getElementById("editHistoryPopup");
    if (_eh) _eh.classList.add("hidden");
  }

  function togglePopup(type) {
    if (state.activePopup === type) {
      closePopup();
    } else {
      openPopup(type);
    }
  }

  // ── Toast 通知 ──────────────────────────────────────
  /** @type {number|null} */
  var _toastTimer = null;

  /**
   * 显示一个底部 toast 提示
   * @param {string} message 提示文本
   * @param {number} [duration=2000] 显示时长（ms）
   */
  function showToast(message, duration) {
    duration = duration || 2000;
    // 移除已有的 toast
    var existing = document.querySelector(".yb-toast");
    if (existing) existing.remove();
    if (_toastTimer) clearTimeout(_toastTimer);

    var toast = document.createElement("div");
    toast.className = "yb-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    // 触发动画
    requestAnimationFrame(function () {
      toast.classList.add("show");
    });

    _toastTimer = setTimeout(function () {
      toast.classList.remove("show");
      setTimeout(function () {
        toast.remove();
      }, 200);
      _toastTimer = null;
    }, duration);
  }

  // ── 工具函数 ────────────────────────────────────────
  function scrollToBottom(force) {
    if (!dom.messageList) return;
    // 只在用户已在底部附近时自动滚动（或 force=true 时强制）
    var el = dom.messageList;
    var nearBottom = force || (el.scrollHeight - el.scrollTop - el.clientHeight < 150);
    if (!nearBottom) return;
    requestAnimationFrame(() => {
      if (dom.messageList) {
        dom.messageList.scrollTop = dom.messageList.scrollHeight;
      }
    });
  }

  function formatTimestamp(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return (
        String(d.getHours()).padStart(2, "0") +
        ":" +
        String(d.getMinutes()).padStart(2, "0")
      );
    } catch {
      return ts;
    }
  }

  function formatTime(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return "";
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      if (isToday) {
        return (
          String(d.getHours()).padStart(2, "0") +
          ":" +
          String(d.getMinutes()).padStart(2, "0")
        );
      }
      return d.getMonth() + 1 + "/" + d.getDate();
    } catch {
      return "";
    }
  }

  // 系统性重复收口（2026-07-13）：全 webview 唯一转义实现。原 DOM 法（textContent→innerHTML）
  // 只转 & < >，不转 " '——被各消费点用在 HTML 属性上下文（title="..."）时引号可破属性；
  // 各模块因此各养了 5 份质量不齐的本地 _esc/fallback。现统一 map 法转 5 字符，本地副本全部删除改引本函数。
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ── 持久化用户选择 ──────────────────────────────────
  /**
   * 双通道持久化：
   * 1. vscode.setState() — webview 本地缓存，重建后 getState() 立即可读（最快）
   * 2. postMessage("saveUserState") — extension globalState，跨窗口持久化（兜底）
   */
  /**
   * vscode.setState 唯一写点（同键散写收口 2026-07-13）：原 5 个模块各自 getState→改→setState，
   * merge 纪律靠自觉，任何一处漏 merge 即覆盖丢字段。现全部经此 read-merge-write 单点。
   * @param {Object} partial 要合并进持久状态的字段
   * @returns {Object} 合并后的完整快照
   */
  function patchState(partial) {
    var existing = vscode.getState() || {};
    var snapshot = Object.assign({}, existing, partial || {});
    vscode.setState(snapshot);
    return snapshot;
  }

  function saveUserState() {
    // 通道1：webview 本地（同步，webview 重建后立即可读；经 patchState 合并保留 autoContinue 等字段）
    var snapshot = patchState({
      selectedChar: state.selectedChar,
      currentChatId: state.currentChatId,
      hasBoundChar: state.hasBoundChar,
      currentView: state.currentView,
    });
    // 通道2：extension globalState（异步，跨窗口持久）
    vscode.postMessage({ type: "saveUserState", payload: snapshot });
  }

  /**
   * webview 重建时立即从 vscode.getState() 恢复关键状态
   * 不需要等 extension 发 restoreUserState 消息
   */
  function restoreFromLocalState() {
    var saved = vscode.getState();
    if (!saved) return false;
    if (saved.selectedChar) state.selectedChar = saved.selectedChar;
    if (saved.currentChatId) state.currentChatId = saved.currentChatId;
    if (saved.hasBoundChar) state.hasBoundChar = saved.hasBoundChar;
    if (saved.currentView) state.currentView = saved.currentView;
    console.log("[chat-core] 从 vscode.getState 恢复:", JSON.stringify(saved));
    return !!(saved.hasBoundChar && saved.currentChatId);
  }

  // ── 自定义输入弹窗（替代 prompt()，VSCode webview 不支持 prompt） ──
  function showInputDialog(title, defaultValue, callback) {
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
    var panel = document.createElement("div");
    panel.style.cssText = "background:var(--vscode-editor-background,#1e1e2e);border:1px solid var(--vscode-panel-border,#333);border-radius:10px;padding:16px;width:280px;";
    var titleEl = document.createElement("div");
    titleEl.style.cssText = "font-weight:bold;margin-bottom:8px;";
    titleEl.textContent = title;
    var input = document.createElement("input");
    input.type = "text";
    input.style.cssText = "width:100%;padding:6px 8px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:var(--vscode-input-background);color:inherit;font-size:13px;box-sizing:border-box;";
    input.value = defaultValue || "";
    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    var okBtn = document.createElement("button");
    okBtn.style.cssText = "flex:1;padding:6px;border:none;border-radius:6px;background:#0e639c;color:#fff;cursor:pointer;";
    okBtn.textContent = "\u786E\u5B9A";
    var cancelBtn2 = document.createElement("button");
    cancelBtn2.style.cssText = "flex:1;padding:6px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;";
    cancelBtn2.textContent = "\u53D6\u6D88";
    okBtn.addEventListener("click", function() { overlay.remove(); callback(input.value); });
    cancelBtn2.addEventListener("click", function() { overlay.remove(); });
    input.addEventListener("keydown", function(e) { if (e.key === "Enter") { overlay.remove(); callback(input.value); } if (e.key === "Escape") { overlay.remove(); } });
    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn2);
    panel.appendChild(titleEl);
    panel.appendChild(input);
    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    setTimeout(function() { input.focus(); input.select(); }, 50);
  }

  // ── 白盒线路追踪（YonBan 无 whitebox，自建轻量 ring + console；对标 beilu 前端 whitebox）──
  // 用途：追踪"按钮点击 → vscode.postMessage 出站 → 扩展回包入站"这条线，运行时可在
  //   webview devtools console 看 [yb:...] 标签，或读 YB.getWbRing() 取环形缓冲。
  // wbTrace=执行点(每次记)；wbDetect=检测点(仅 ok=false 记，happy path 零开销)。
  var _wbRing = [];
  var _wbSeq = 0;
  function wbTrace(line, node, data) {
    var e = { seq: ++_wbSeq, ts: Date.now(), line: line, node: node, data: data || null };
    _wbRing.push(e);
    if (_wbRing.length > 500) _wbRing.shift();
    try { console.log("[yb:" + line + ":" + node + "]", data != null ? JSON.stringify(data) : ""); } catch (_) {}
  }
  function wbDetect(line, node, ok, msg, data) {
    if (!ok) {
      var e = { seq: ++_wbSeq, ts: Date.now(), line: line, node: node, detect: true, msg: msg || "detect failed", data: data || null };
      _wbRing.push(e);
      if (_wbRing.length > 500) _wbRing.shift();
      try { console.warn("[yb:" + line + ":" + node + "] \u26A0 " + (msg || ""), data != null ? JSON.stringify(data) : ""); } catch (_) {}
    }
    return ok;
  }
  function getWbRing() { return _wbRing.slice(); }

  // ── 返回共享对象 ────────────────────────────────────
  return {
    vscode,
    wbTrace,
    wbDetect,
    getWbRing,
    $,
    dom,
    state,
    views,
    STATUS_LABELS,
    DEFAULT_MODE,
    POLL,
    getSubModes,
    cacheSubModes,
    showView,
    switchSettingsTab,
    openPopup,
    closePopup,
    togglePopup,
    showToast,
    scrollToBottom,
    formatTimestamp,
    formatTime,
    escapeHtml,
    restoreFromLocalState,
    saveUserState,
    patchState,
    showFloatingPopup,
    closeAllFloatingPopups,
    showInputDialog,
  };
})();
