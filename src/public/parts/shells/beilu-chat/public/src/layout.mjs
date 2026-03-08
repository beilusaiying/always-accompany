/**
 * beilu-chat 布局交互模块
 *
 * 负责：
 * - 顶部选项卡切换（聊天/Bot/文件/记忆/助手）
 * - 聊天模式：三栏折叠/展开
 * - 文件/记忆模式：IDE 布局（活动栏切换、侧边栏拖拽调宽、菜单栏）
 * - 聊天容器在模式间移动
 * - 布局状态持久化（localStorage）
 */

const STORAGE_KEY = "beilu-chat-layout";

// ============================================================
// DOM 引用
// ============================================================

// 顶部
const topTabs = document.getElementById("top-tabs");

// 三栏（聊天模式）
const leftPanel = document.getElementById("left-panel");
const rightPanel = document.getElementById("right-panel");
const leftToggle = document.getElementById("left-panel-toggle");
const rightToggle = document.getElementById("right-panel-toggle");

// 左栏内容区域（仅聊天模式使用左栏）
const leftContentChat = document.getElementById("left-content-chat");

// 聊天容器 & 停靠区
const chatContainer = document.getElementById("chat-container");
const chatDock = document.getElementById("chat-dock");
const chatDockBody = document.getElementById("chat-dock-body");
const chatDockToggle = document.getElementById("chat-dock-toggle");
const centerTabChat = document.getElementById("center-tab-chat");

// IDE 文件模式
const ideActivityBar = document.getElementById("ide-activity-bar");
const ideSidebar = document.getElementById("ide-sidebar");
const ideSidebarResize = document.getElementById("ide-sidebar-resize");
const ideMenubar = document.getElementById("ide-menubar");

// IDE 记忆模式
const memActivityBar = document.getElementById("mem-activity-bar");
const memSidebar = document.getElementById("mem-sidebar");

// ============================================================
// 状态
// ============================================================

let layoutState = {
  leftCollapsed: false,
  rightCollapsed: false,
  activeTab: "chat",
  chatDockCollapsed: false,
  rightCollapsedByUser: false,
  // 三栏面板宽度
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  // IDE 状态
  ideSidebarWidth: 240,
  ideActivePanel: "explorer",
  memSidebarWidth: 240,
  memActivePanel: "memory-tree",
};

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      layoutState = { ...layoutState, ...parsed };
    }
  } catch {
    /* ignore */
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layoutState));
  } catch {
    /* ignore */
  }
}

// ============================================================
// 三栏折叠（聊天模式）
// ============================================================

function applyLeftPanel() {
  if (!leftPanel) return;
  leftPanel.classList.toggle("collapsed", layoutState.leftCollapsed);
  // 拖拽手柄显隐
  const lHandle = document.getElementById("left-panel-resize");
  if (lHandle) lHandle.classList.toggle("hidden", layoutState.leftCollapsed);
}

function applyRightPanel() {
  if (!rightPanel) return;
  rightPanel.classList.toggle("collapsed", layoutState.rightCollapsed);
  // 拖拽手柄显隐
  const rHandle = document.getElementById("right-panel-resize");
  if (rHandle) rHandle.classList.toggle("hidden", layoutState.rightCollapsed);
}

function toggleLeftPanel() {
  layoutState.leftCollapsed = !layoutState.leftCollapsed;
  applyLeftPanel();
  saveState();
}

function toggleRightPanel() {
  layoutState.rightCollapsed = !layoutState.rightCollapsed;
  if (layoutState.activeTab === "chat") {
    layoutState.rightCollapsedByUser = layoutState.rightCollapsed;
  }
  applyRightPanel();
  saveState();
}

// ============================================================
// 左栏内容区域切换
// ============================================================

function switchLeftContent(tabName) {
  // IDE 模式下左栏被隐藏，只有聊天/Bot/助手模式使用左栏
  if (leftContentChat) {
    // 聊天、Bot、助手模式显示预设面板，其他模式隐藏
    const showChat =
      tabName === "chat" || tabName === "bot" || tabName === "helper";
    leftContentChat.classList.toggle("hidden", !showChat);
  }
}

// ============================================================
// 聊天容器移动
// ============================================================

function moveChatContainer(tabName) {
  if (!chatContainer) return;

  const isIdeMode = tabName === "files" || tabName === "memory";

  if (isIdeMode) {
    // 文件模式 → 移到 IDE 侧边栏的 AI 对话面板
    // 记忆模式 → 不移动聊天容器（mem-ai-chat 面板已改为记忆AI专用对话）
    if (tabName === "files") {
      const aiPanel = document.getElementById("ide-panel-ai-chat");
      if (aiPanel && chatContainer.parentElement !== aiPanel) {
        aiPanel.appendChild(chatContainer);
      }
    }
    chatContainer.classList.add("compact-chat");
    chatContainer.classList.remove("chat-dock-collapsed");
    // 隐藏停靠区（不再使用旧停靠方式）
    if (chatDock) chatDock.classList.add("hidden");
  } else {
    // 聊天/助手模式 → 移回中栏
    if (centerTabChat && chatContainer.parentElement !== centerTabChat) {
      centerTabChat.appendChild(chatContainer);
    }
    if (chatDock) chatDock.classList.add("hidden");
    chatContainer.classList.remove("compact-chat", "chat-dock-collapsed");
  }
}

// ============================================================
// 顶部选项卡切换
// ============================================================

// 模式映射：顶部选项卡 → beilu-files activeMode
const TAB_TO_MODE = {
  chat: "chat",
  bot: "chat",
  helper: "chat",
  files: "file",
  memory: "memory",
};

/**
 * 通知后端当前模式，并处理文件模式退出时的清理
 * @param {string} tabName - 当前选项卡名
 */
async function notifyActiveMode(tabName) {
  const mode = TAB_TO_MODE[tabName] || "chat";

  // 获取当前 chatid（从 URL hash 读取）
  const chatid = window.location.hash?.substring(1) || "";

  // 获取当前消息数量（仅在进入文件模式时需要）
  let currentMessageCount = -1;
  if (mode === "file" || mode === "memory") {
    try {
      const lenRes = await fetch(`/api/parts/shells:chat/${chatid}/log/length`);
      if (lenRes.ok) currentMessageCount = await lenRes.json();
    } catch {
      /* ignore */
    }
  }

  try {
    const res = await fetch("/api/parts/plugins:beilu-files/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _action: "setMode",
        mode,
        chatid,
        currentMessageCount,
      }),
    });

    if (res.ok) {
      const result = await res.json();

      // 处理文件模式退出时的清理（删除文件操作期间的消息）
      if (result?._cleanup) {
        const cleanupMode =
          localStorage.getItem("beilu-cleanup-mode") || "auto";
        const { chatid: cleanupChatid, startIndex } = result._cleanup;

        if (cleanupChatid && startIndex >= 0) {
          let shouldClean = false;

          if (cleanupMode === "auto") {
            shouldClean = true;
          } else if (cleanupMode === "ask") {
            // 先获取要清理的消息数
            try {
              const lenRes = await fetch(
                `/api/parts/shells:chat/${cleanupChatid}/log/length`,
              );
              const total = lenRes.ok ? await lenRes.json() : 0;
              const count = total - startIndex;
              if (count > 0) {
                shouldClean = confirm(
                  `是否清理文件/记忆模式期间的 ${count} 条对话消息？`,
                );
              }
            } catch {
              shouldClean = confirm("是否清理文件/记忆模式期间的对话消息？");
            }
          }
          // cleanupMode === 'off' → shouldClean stays false

          if (shouldClean) {
            try {
              const delRes = await fetch(
                `/api/parts/shells:chat/${cleanupChatid}/messages/delete-range`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ startIndex }),
                },
              );
              if (delRes.ok) {
                const delResult = await delRes.json();
                console.log(
                  `[layout] 文件模式清理: 删除了 ${delResult.deleted} 条消息`,
                );
              }
            } catch (err) {
              console.warn("[layout] 文件模式清理失败:", err.message);
            }
          } else if (cleanupMode !== "auto") {
            console.log(
              `[layout] 文件模式清理: 用户选择保留消息 (模式: ${cleanupMode})`,
            );
          }
        }
      }
    }
  } catch (err) {
    console.warn("[layout] 通知 activeMode 失败:", err.message);
  }
}

function switchTab(tabName) {
  layoutState.activeTab = tabName;
  const isIdeMode = tabName === "files" || tabName === "memory";

  // 通知后端当前模式（影响 GetPrompt 是否注入文件操作能力）
  notifyActiveMode(tabName);

  // 自动切换 INJ-2 文件层提示词
  const inj2Enabled = tabName === "files";
  fetch("/api/parts/plugins:beilu-memory/config/setdata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      _action: "updateInjectionPrompt",
      injectionId: "INJ-2",
      enabled: inj2Enabled,
    }),
  })
    .then(() => {
      const statusEl = document.getElementById("inj2-status");
      if (statusEl) statusEl.textContent = inj2Enabled ? "ON" : "OFF";
    })
    .catch(() => {});

  // 更新顶部选项卡按钮
  topTabs?.querySelectorAll("[data-top-tab]").forEach((btn) => {
    btn.classList.toggle("top-tab-active", btn.dataset.topTab === tabName);
  });

  // 显示/隐藏选项卡内容
  document.querySelectorAll(".center-tab-content").forEach((panel) => {
    const isTarget = panel.id === `center-tab-${tabName}`;
    if (isTarget) {
      panel.classList.remove("hidden");
      // 不设置 style.display，让 Tailwind 的 flex-1 正常生效
      // 清除可能残留的 inline style
      panel.style.display = "";
    } else {
      panel.classList.add("hidden");
    }
  });

  // 切换左栏内容（聊天模式使用）
  switchLeftContent(tabName);

  // 移动聊天容器
  moveChatContainer(tabName);

  // IDE 模式：隐藏三栏的左右栏，全屏给 IDE
  if (isIdeMode) {
    if (leftPanel) {
      leftPanel.classList.add("collapsed");
      leftPanel.style.display = "none";
    }
    if (rightPanel) {
      rightPanel.classList.add("collapsed");
      rightPanel.style.display = "none";
    }
  } else {
    // 聊天/助手模式：恢复三栏
    if (leftPanel) {
      leftPanel.style.display = "";
      // 移动端不恢复展开状态，保持折叠
      if (!document.body.classList.contains("beilu-mobile")) {
        applyLeftPanel();
      }
    }
    if (rightPanel) {
      rightPanel.style.display = "";
      if (!document.body.classList.contains("beilu-mobile")) {
        if (tabName === "chat") {
          layoutState.rightCollapsed = layoutState.rightCollapsedByUser;
        }
        applyRightPanel();
      }
    }
  }

  saveState();
}

// ============================================================
// IDE 活动栏交互
// ============================================================

function initIdeActivityBar(activityBar, sidebar, stateKey, panelPrefix) {
  if (!activityBar || !sidebar) return;

  activityBar
    .querySelectorAll("[data-ide-panel], [data-mem-panel]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const panelName = btn.dataset.idePanel || btn.dataset.memPanel;
        if (!panelName) return;

        // 更新活动按钮状态
        activityBar.querySelectorAll(".ide-activity-btn").forEach((b) => {
          b.classList.remove("ide-activity-active");
        });
        btn.classList.add("ide-activity-active");

        // 切换侧边栏面板
        sidebar.querySelectorAll(".ide-sidebar-panel").forEach((p) => {
          p.classList.add("hidden");
        });
        const target = document.getElementById(`${panelPrefix}-${panelName}`);
        if (target) target.classList.remove("hidden");

        // 保存状态
        layoutState[stateKey] = panelName;
        saveState();
      });
    });
}

function restoreIdePanel(activityBar, sidebar, stateKey, panelPrefix) {
  if (!activityBar || !sidebar) return;
  const activePanel = layoutState[stateKey];

  // 设置活动按钮
  activityBar.querySelectorAll(".ide-activity-btn").forEach((btn) => {
    const panelName = btn.dataset.idePanel || btn.dataset.memPanel;
    btn.classList.toggle("ide-activity-active", panelName === activePanel);
  });

  // 显示对应面板
  sidebar.querySelectorAll(".ide-sidebar-panel").forEach((p) => {
    p.classList.add("hidden");
  });
  const target = document.getElementById(`${panelPrefix}-${activePanel}`);
  if (target) target.classList.remove("hidden");
}

// ============================================================
// 三栏面板拖拽调宽（左栏 / 右栏）
// ============================================================

function initPanelResize() {
  const leftHandle = document.getElementById("left-panel-resize");
  const rightHandle = document.getElementById("right-panel-resize");

  // 通用：设置面板宽度（同步 content 内容区）
  function setPanelWidth(panel, width) {
    panel.style.width = width + "px";
    const content = panel.querySelector(".left-panel-content, .right-panel-content");
    if (content) {
      content.style.width = width + "px";
      content.style.minWidth = width + "px";
    }
  }

  // 恢复保存的宽度
  if (leftPanel && layoutState.leftPanelWidth && layoutState.leftPanelWidth !== 280) {
    setPanelWidth(leftPanel, layoutState.leftPanelWidth);
  }
  if (rightPanel && layoutState.rightPanelWidth && layoutState.rightPanelWidth !== 320) {
    setPanelWidth(rightPanel, layoutState.rightPanelWidth);
  }

  // 左面板拖拽：向右拖 = 变宽
  if (leftPanel && leftHandle) {
    let dragging = false, startX = 0, startW = 0;

    const onDown = (e) => {
      if (layoutState.leftCollapsed) return;
      dragging = true;
      startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      startW = leftPanel.offsetWidth;
      leftHandle.classList.add("dragging");
      leftPanel.style.transition = "none";
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const cx = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const delta = cx - startX;
      const newW = Math.max(180, Math.min(startW + delta, window.innerWidth * 0.45));
      setPanelWidth(leftPanel, newW);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      leftHandle.classList.remove("dragging");
      leftPanel.style.transition = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      layoutState.leftPanelWidth = leftPanel.offsetWidth;
      saveState();
    };

    leftHandle.addEventListener("mousedown", onDown);
    leftHandle.addEventListener("touchstart", onDown, { passive: false });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
  }

  // 右面板拖拽：向左拖 = 变宽（delta 为负）
  if (rightPanel && rightHandle) {
    let dragging = false, startX = 0, startW = 0;

    const onDown = (e) => {
      if (layoutState.rightCollapsed) return;
      dragging = true;
      startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      startW = rightPanel.offsetWidth;
      rightHandle.classList.add("dragging");
      rightPanel.style.transition = "none";
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const cx = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const delta = startX - cx; // 向左拖 = delta 为正 = 变宽
      const newW = Math.max(200, Math.min(startW + delta, window.innerWidth * 0.45));
      setPanelWidth(rightPanel, newW);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      rightHandle.classList.remove("dragging");
      rightPanel.style.transition = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      layoutState.rightPanelWidth = rightPanel.offsetWidth;
      saveState();
    };

    rightHandle.addEventListener("mousedown", onDown);
    rightHandle.addEventListener("touchstart", onDown, { passive: false });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
  }
}

// ============================================================
// 侧边栏拖拽调宽
// ============================================================

function initSidebarResize(sidebar, resizeHandle, stateKey) {
  if (!sidebar || !resizeHandle) return;

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  resizeHandle.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizeHandle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(
      160,
      Math.min(startWidth + delta, window.innerWidth * 0.5),
    );
    sidebar.style.width = newWidth + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    resizeHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    layoutState[stateKey] = sidebar.offsetWidth;
    saveState();
  });

  // 恢复宽度
  const savedWidth = layoutState[stateKey];
  if (savedWidth && savedWidth > 0) {
    sidebar.style.width = savedWidth + "px";
  }
}

// ============================================================
// 菜单栏交互
// ============================================================

function initMenubar() {
  if (!ideMenubar) return;

  let openMenu = null;

  ideMenubar.querySelectorAll(".ide-menu-item").forEach((item) => {
    const label = item.querySelector(".ide-menu-label");
    const dropdown = item.querySelector(".ide-menu-dropdown");
    if (!label || !dropdown) return;

    label.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openMenu === dropdown) {
        dropdown.classList.add("hidden");
        openMenu = null;
      } else {
        // 关闭其他
        ideMenubar
          .querySelectorAll(".ide-menu-dropdown")
          .forEach((d) => d.classList.add("hidden"));
        dropdown.classList.remove("hidden");
        openMenu = dropdown;
      }
    });

    // hover 切换（菜单已打开时）
    label.addEventListener("mouseenter", () => {
      if (openMenu && openMenu !== dropdown) {
        openMenu.classList.add("hidden");
        dropdown.classList.remove("hidden");
        openMenu = dropdown;
      }
    });
  });

  // 点击外部关闭
  document.addEventListener("click", (e) => {
    if (openMenu && !ideMenubar.contains(e.target)) {
      openMenu.classList.add("hidden");
      openMenu = null;
    }
  });

  // 菜单动作
  ideMenubar.querySelectorAll(".ide-menu-action").forEach((action) => {
    action.addEventListener("click", () => {
      const act = action.dataset.action;
      if (openMenu) {
        openMenu.classList.add("hidden");
        openMenu = null;
      }
      handleMenuAction(act);
    });
  });
}

async function handleMenuAction(action) {
  const textarea = document.getElementById("file-editor-textarea");

  switch (action) {
    case "cleanup-context": {
      // 手动清理文件模式上下文
      const chatid = window.location.hash?.substring(1) || "";
      if (!chatid) {
        console.warn("[layout] 无法清理: 无 chatid");
        break;
      }
      try {
        // 从 beilu-files 获取 fileModeStartIndex
        const stateRes = await fetch(
          "/api/parts/plugins:beilu-files/config/setdata",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _action: "getCleanupInfo" }),
          },
        );
        if (stateRes.ok) {
          const info = await stateRes.json();
          if (info?.startIndex >= 0) {
            const delRes = await fetch(
              `/api/parts/shells:chat/${chatid}/messages/delete-range`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startIndex: info.startIndex }),
              },
            );
            if (delRes.ok) {
              const delResult = await delRes.json();
              console.log(
                `[layout] 手动清理: 删除了 ${delResult.deleted} 条消息`,
              );
              // 刷新聊天显示
              window.dispatchEvent(new CustomEvent("chat:reload"));
            }
          } else {
            console.log("[layout] 手动清理: 无需清理（未记录起始位置）");
          }
        }
      } catch (err) {
        console.warn("[layout] 手动清理失败:", err.message);
      }
      break;
    }
    case "new-file":
      // 触发文件树的新建文件
      document.getElementById("file-tree-new-file")?.click();
      break;
    case "open-folder":
      document.getElementById("file-tree-open-folder")?.click();
      break;
    case "save":
      document.getElementById("file-save-btn")?.click();
      break;
    case "undo":
      if (textarea) document.execCommand("undo");
      break;
    case "redo":
      if (textarea) document.execCommand("redo");
      break;
    case "cut":
      document.execCommand("cut");
      break;
    case "copy":
      document.execCommand("copy");
      break;
    case "paste":
      // paste via execCommand is restricted, show hint
      if (textarea) {
        textarea.focus();
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text && textarea) {
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              textarea.value =
                textarea.value.substring(0, start) +
                text +
                textarea.value.substring(end);
              textarea.selectionStart = textarea.selectionEnd =
                start + text.length;
              textarea.dispatchEvent(new Event("input"));
            }
          })
          .catch(() => {
            // Clipboard API not available
          });
      }
      break;
    case "find":
      // TODO: 实现查找功能
      break;
    case "replace":
      // TODO: 实现替换功能
      break;
    default:
      break;
  }
}

// ============================================================
// 聊天停靠区折叠/展开（保留旧逻辑备用）
// ============================================================

function toggleChatDock() {
  layoutState.chatDockCollapsed = !layoutState.chatDockCollapsed;
  if (chatContainer) {
    chatContainer.classList.toggle(
      "chat-dock-collapsed",
      layoutState.chatDockCollapsed,
    );
  }
  const chevron = chatDockToggle?.querySelector(".chat-dock-chevron");
  if (chevron) {
    chevron.style.transform = layoutState.chatDockCollapsed
      ? "rotate(180deg)"
      : "";
  }
  saveState();
}

// ============================================================
// 初始化
// ============================================================

export function initLayout() {
  loadState();

  // 应用初始状态
  applyLeftPanel();
  applyRightPanel();

  // 绑定三栏 toggle 按钮
  leftToggle?.addEventListener("click", toggleLeftPanel);
  rightToggle?.addEventListener("click", toggleRightPanel);

  // 绑定顶部选项卡
  topTabs?.querySelectorAll("[data-top-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.topTab);
    });
  });

  // 初始化 IDE 活动栏
  initIdeActivityBar(ideActivityBar, ideSidebar, "ideActivePanel", "ide-panel");
  initIdeActivityBar(memActivityBar, memSidebar, "memActivePanel", "mem-panel");

  // 恢复 IDE 面板状态
  restoreIdePanel(ideActivityBar, ideSidebar, "ideActivePanel", "ide-panel");
  restoreIdePanel(memActivityBar, memSidebar, "memActivePanel", "mem-panel");

  // 初始化三栏面板拖拽
  initPanelResize();

  // 初始化侧边栏拖拽
  initSidebarResize(ideSidebar, ideSidebarResize, "ideSidebarWidth");
  // 记忆模式侧边栏
  const memResizeHandle = memSidebar?.querySelector(".ide-sidebar-resize");
  initSidebarResize(memSidebar, memResizeHandle, "memSidebarWidth");

  // 初始化菜单栏
  initMenubar();

  // 绑定聊天停靠区折叠按钮
  chatDockToggle?.addEventListener("click", toggleChatDock);

  // 初始化新功能控件绑定
  initFeatureControls();

  // 初始化手机适配
  initMobileAdaptation();

  // 应用初始选项卡
  switchTab(layoutState.activeTab);

  // API 未配置提示 banner
  checkChatApiBanner();

  // 关闭按钮
  document
    .getElementById("chat-api-warning-close")
    ?.addEventListener("click", () => {
      const banner = document.getElementById("chat-api-warning-banner");
      if (banner) banner.style.display = "none";
    });

  // 监听 API 变更事件（从右栏 API 保存/删除时触发）
  window.addEventListener("resource:api-changed", () => checkChatApiBanner());

  // 初始化折叠组状态持久化（data-collapse-id）
  initCollapsePersistence();

  console.log("[beilu-chat] 布局已初始化（顶部选项卡 + IDE 模式）");
}

// ============================================================
// 折叠组状态持久化（localStorage）
// ============================================================

const COLLAPSE_STORAGE_KEY = "beilu-chat-collapse-states";

/**
 * 初始化折叠组状态持久化
 * 所有带 data-collapse-id 的 checkbox 都会记住展开/闭合状态
 * 首次访问时默认闭合（HTML 中不带 checked）
 */
function initCollapsePersistence() {
  let savedStates = {};
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) savedStates = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  const checkboxes = document.querySelectorAll(
    'input[type="checkbox"][data-collapse-id]',
  );
  checkboxes.forEach((cb) => {
    const id = cb.dataset.collapseId;
    if (!id) return;

    // 恢复保存的状态（如果有）
    if (savedStates[id] !== undefined) {
      cb.checked = savedStates[id];
    }
    // 否则保持 HTML 默认值（不带 checked = 闭合）

    // 监听变化，保存状态
    cb.addEventListener("change", () => {
      saveCollapseState(id, cb.checked);
    });
  });
}

/**
 * 保存单个折叠组的状态
 * @param {string} id - collapse ID
 * @param {boolean} isOpen - 是否展开
 */
function saveCollapseState(id, isOpen) {
  let states = {};
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) states = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  states[id] = isOpen;
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(states));
  } catch {
    /* ignore */
  }
}

// ============================================================
// 新功能控件绑定
// ============================================================

/**
 * 初始化右栏功能控件的事件绑定和 localStorage 持久化
 */
function initFeatureControls() {
  // --- 思维链折叠标签配置 ---
  const thinkingTagsInput = document.getElementById("thinking-fold-tags");
  if (thinkingTagsInput) {
    const saved = localStorage.getItem("beilu-thinking-tags");
    if (saved) thinkingTagsInput.value = saved;
    thinkingTagsInput.addEventListener("change", () => {
      localStorage.setItem(
        "beilu-thinking-tags",
        thinkingTagsInput.value.trim(),
      );
    });
  }

  // --- 渲染器开关 ---
  const rendererToggle = document.getElementById("toggle-renderer");
  if (rendererToggle) {
    const saved = localStorage.getItem("beilu-renderer-enabled");
    if (saved !== null) rendererToggle.checked = saved !== "false";
    rendererToggle.addEventListener("change", () => {
      localStorage.setItem("beilu-renderer-enabled", rendererToggle.checked);
    });
  }

  // --- 代码折叠开关 ---
  const codeFoldToggle = document.getElementById("toggle-code-fold");
  if (codeFoldToggle) {
    const saved = localStorage.getItem("beilu-code-fold-enabled");
    if (saved !== null) codeFoldToggle.checked = saved === "true";
    codeFoldToggle.addEventListener("change", () => {
      localStorage.setItem("beilu-code-fold-enabled", codeFoldToggle.checked);
    });
  }

  // --- 代码折叠模式 ---
  const codeFoldMode = document.getElementById("code-fold-mode");
  if (codeFoldMode) {
    const saved = localStorage.getItem("beilu-code-fold-mode");
    if (saved) codeFoldMode.value = saved;
    codeFoldMode.addEventListener("change", () => {
      localStorage.setItem("beilu-code-fold-mode", codeFoldMode.value);
    });
  }

  // --- 流式渲染开关 ---
  const streamRenderToggle = document.getElementById("toggle-stream-render");
  if (streamRenderToggle) {
    const saved = localStorage.getItem("beilu-stream-render-enabled");
    if (saved !== null) streamRenderToggle.checked = saved === "true";
    streamRenderToggle.addEventListener("change", () => {
      localStorage.setItem(
        "beilu-stream-render-enabled",
        streamRenderToggle.checked,
      );
    });
  }

  // --- 渲染深度 ---
  const renderDepth = document.getElementById("render-depth");
  if (renderDepth) {
    const saved = localStorage.getItem("beilu-render-depth");
    if (saved) renderDepth.value = saved;
    renderDepth.addEventListener("change", () => {
      localStorage.setItem("beilu-render-depth", renderDepth.value);
    });
  }

  // --- 消息加载限制 ---
  const msgLoadLimit = document.getElementById("msg-load-limit");
  if (msgLoadLimit) {
    const saved = localStorage.getItem("beilu-msg-load-limit");
    if (saved) msgLoadLimit.value = saved;
    msgLoadLimit.addEventListener("change", () => {
      localStorage.setItem("beilu-msg-load-limit", msgLoadLimit.value);
    });
  }

  // --- 上下文屏蔽 ---
  const contextMsgLimit = document.getElementById("context-msg-limit");
  if (contextMsgLimit) {
    const saved = localStorage.getItem("beilu-context-msg-limit");
    if (saved) contextMsgLimit.value = saved;
    contextMsgLimit.addEventListener("change", () => {
      const val = parseInt(contextMsgLimit.value) || 0;
      localStorage.setItem("beilu-context-msg-limit", val);
      syncRuntimeParams({ context_msg_limit: val });
    });
    // 页面加载时也同步一次
    syncRuntimeParams({
      context_msg_limit: parseInt(contextMsgLimit.value) || 0,
    });
  }

  // --- 流式输出开关 ---
  const streamToggle = document.getElementById("param-stream");
  if (streamToggle) {
    const saved = localStorage.getItem("beilu-stream-enabled");
    if (saved !== null) streamToggle.checked = saved !== "false";
    streamToggle.addEventListener("change", () => {
      localStorage.setItem("beilu-stream-enabled", streamToggle.checked);
      syncRuntimeParams({ stream: streamToggle.checked });
    });
    // 页面加载时也同步一次
    syncRuntimeParams({ stream: streamToggle.checked });
  }

  // --- 通用预填充开关 ---
  const prefillToggle = document.getElementById("param-prefill-toggle");
  if (prefillToggle) {
    const saved = localStorage.getItem("beilu-prefill-enabled");
    if (saved !== null) prefillToggle.checked = saved === "true";
    prefillToggle.addEventListener("change", () => {
      localStorage.setItem("beilu-prefill-enabled", prefillToggle.checked);
      syncRuntimeParams({ prefill_enabled: prefillToggle.checked });
    });
    syncRuntimeParams({ prefill_enabled: prefillToggle.checked });
  }

  // --- Claude 预填充开关 ---
  const claudePrefillToggle = document.getElementById(
    "param-claude-prefill-toggle",
  );
  if (claudePrefillToggle) {
    const saved = localStorage.getItem("beilu-claude-prefill-enabled");
    if (saved !== null) claudePrefillToggle.checked = saved === "true";
    claudePrefillToggle.addEventListener("change", () => {
      localStorage.setItem(
        "beilu-claude-prefill-enabled",
        claudePrefillToggle.checked,
      );
      syncRuntimeParams({
        claude_prefill_enabled: claudePrefillToggle.checked,
      });
      // Claude 预填充启用时自动切换后处理为严格模式
      if (claudePrefillToggle.checked) {
        const ppSelect = document.getElementById("param-post-processing");
        if (
          ppSelect &&
          ppSelect.value !== "strict" &&
          ppSelect.value !== "semi"
        ) {
          ppSelect.value = "strict";
          localStorage.setItem("beilu-post-processing", "strict");
          syncRuntimeParams({ prompt_post_processing: "strict" });
        }
      }
    });
    syncRuntimeParams({ claude_prefill_enabled: claudePrefillToggle.checked });
  }

  // --- 提示词后处理下拉框 ---
  const postProcessingSelect = document.getElementById("param-post-processing");
  if (postProcessingSelect) {
    const saved = localStorage.getItem("beilu-post-processing");
    if (saved) postProcessingSelect.value = saved;
    postProcessingSelect.addEventListener("change", () => {
      localStorage.setItem("beilu-post-processing", postProcessingSelect.value);
      syncRuntimeParams({ prompt_post_processing: postProcessingSelect.value });
    });
    syncRuntimeParams({ prompt_post_processing: postProcessingSelect.value });
  }

  // --- 继续预填充开关 ---
  const continuePrefillToggle = document.getElementById(
    "param-continue-prefill",
  );
  if (continuePrefillToggle) {
    const saved = localStorage.getItem("beilu-continue-prefill");
    if (saved !== null) continuePrefillToggle.checked = saved === "true";
    continuePrefillToggle.addEventListener("change", () => {
      localStorage.setItem(
        "beilu-continue-prefill",
        continuePrefillToggle.checked,
      );
      syncRuntimeParams({ continue_prefill: continuePrefillToggle.checked });
    });
    syncRuntimeParams({ continue_prefill: continuePrefillToggle.checked });
  }

  // --- 模式切换清理设置 ---
  const cleanupModeSelect = document.getElementById("cleanup-mode-select");
  if (cleanupModeSelect) {
    const saved = localStorage.getItem("beilu-cleanup-mode");
    if (saved) cleanupModeSelect.value = saved;
    cleanupModeSelect.addEventListener("change", () => {
      localStorage.setItem("beilu-cleanup-mode", cleanupModeSelect.value);
    });
  }

  // --- 浏览器感知开关 ---
  const browserSenseToggle = document.getElementById("toggle-browser-sense");
  if (browserSenseToggle) {
    const saved = localStorage.getItem("beilu-browser-sense-enabled");
    if (saved !== null) browserSenseToggle.checked = saved !== "false";
    browserSenseToggle.addEventListener("change", () => {
      localStorage.setItem(
        "beilu-browser-sense-enabled",
        browserSenseToggle.checked,
      );
      // 通知 beilu-browser 插件启用/禁用
      fetch("/api/parts/plugins:beilu-browser/config/setdata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _action: "setEnabled",
          enabled: browserSenseToggle.checked,
        }),
      }).catch(() => {});
    });
  }

  // --- 浏览器感知: 复制油猴脚本 ---
  const browserCopyScript = document.getElementById("browser-copy-script");
  if (browserCopyScript) {
    browserCopyScript.addEventListener("click", async () => {
      try {
        browserCopyScript.textContent = "⏳ 获取中...";
        const res = await fetch(
          "/api/parts/plugins:beilu-browser/config/setdata",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _action: "getUserscript" }),
          },
        );
        if (res.ok) {
          const data = await res.json();
          if (data?.script) {
            // 尝试 Clipboard API
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(data.script);
            } else {
              // Fallback: 使用 textarea + execCommand
              const ta = document.createElement("textarea");
              ta.value = data.script;
              ta.style.cssText =
                "position:fixed;left:-9999px;top:-9999px;opacity:0";
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
            }
            browserCopyScript.textContent = "✅ 已复制!";
            setTimeout(() => {
              browserCopyScript.textContent = "📋 复制油猴脚本";
            }, 2000);
          } else {
            browserCopyScript.textContent = "❌ 获取失败";
            console.warn(
              "[layout] getUserscript 返回无 script:",
              data?.error || "未知错误",
            );
            setTimeout(() => {
              browserCopyScript.textContent = "📋 复制油猴脚本";
            }, 2000);
          }
        } else {
          browserCopyScript.textContent = "❌ 请求失败";
          setTimeout(() => {
            browserCopyScript.textContent = "📋 复制油猴脚本";
          }, 2000);
        }
      } catch (err) {
        console.warn("[layout] 复制油猴脚本失败:", err.message);
        browserCopyScript.textContent = "❌ 错误";
        setTimeout(() => {
          browserCopyScript.textContent = "📋 复制油猴脚本";
        }, 2000);
      }
    });
  }

  // --- 浏览器感知: 清除快照 ---
  const browserClearSnapshots = document.getElementById(
    "browser-clear-snapshots",
  );
  if (browserClearSnapshots) {
    browserClearSnapshots.addEventListener("click", async () => {
      try {
        await fetch("/api/parts/plugins:beilu-browser/config/setdata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ _action: "clearSnapshots" }),
        });
      } catch {
        /* ignore */
      }
    });
  }

  // --- 浏览器感知: 定期状态轮询 ---
  initBrowserSensePolling();

  // --- IDE 控制面板: 清理模式（同步到 localStorage，与右栏清理设置联动） ---
  const ideCleanupMode = document.getElementById("ide-cleanup-mode");
  if (ideCleanupMode) {
    const saved = localStorage.getItem("beilu-cleanup-mode");
    if (saved) ideCleanupMode.value = saved;
    ideCleanupMode.addEventListener("change", () => {
      localStorage.setItem("beilu-cleanup-mode", ideCleanupMode.value);
      // 同步右栏的 cleanup-mode-select
      const rightSelect = document.getElementById("cleanup-mode-select");
      if (rightSelect) rightSelect.value = ideCleanupMode.value;
    });
    // 右栏 → IDE 面板同步（如果右栏先变）
    const rightCleanup = document.getElementById("cleanup-mode-select");
    if (rightCleanup) {
      rightCleanup.addEventListener("change", () => {
        ideCleanupMode.value = rightCleanup.value;
      });
    }
  }

  // --- IDE 控制面板: 手动清理按钮 ---
  const ideManualCleanup = document.getElementById("ide-manual-cleanup");
  if (ideManualCleanup) {
    ideManualCleanup.addEventListener("click", async () => {
      const chatid = window.location.hash?.substring(1) || "";
      if (!chatid) {
        console.warn("[layout] 无法清理: 无 chatid");
        return;
      }
      try {
        ideManualCleanup.textContent = "⏳ 清理中...";
        ideManualCleanup.disabled = true;
        const stateRes = await fetch(
          "/api/parts/plugins:beilu-files/config/setdata",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _action: "getCleanupInfo" }),
          },
        );
        if (stateRes.ok) {
          const info = await stateRes.json();
          if (info?.startIndex >= 0) {
            const delRes = await fetch(
              `/api/parts/shells:chat/${chatid}/messages/delete-range`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startIndex: info.startIndex }),
              },
            );
            if (delRes.ok) {
              const delResult = await delRes.json();
              console.log(
                `[layout] IDE 手动清理: 删除了 ${delResult.deleted} 条消息`,
              );
              window.dispatchEvent(new CustomEvent("chat:reload"));
            }
          } else {
            console.log("[layout] IDE 手动清理: 无需清理（未记录起始位置）");
          }
        }
      } catch (err) {
        console.warn("[layout] IDE 手动清理失败:", err.message);
      } finally {
        ideManualCleanup.textContent = "🧹 手动清理当前文件对话";
        ideManualCleanup.disabled = false;
      }
    });
  }

  // --- IDE 控制面板: 自动继续开关 ---
  const ideAutoContinue = document.getElementById("ide-auto-continue");
  if (ideAutoContinue) {
    const saved = localStorage.getItem("beilu-file-auto-continue");
    if (saved !== null) ideAutoContinue.checked = saved !== "false";
    ideAutoContinue.addEventListener("change", () => {
      localStorage.setItem("beilu-file-auto-continue", ideAutoContinue.checked);
    });
  }

  // --- IDE 控制面板: 权限开关绑定 ---
  initIdePermissionToggles();

  // --- IDE 控制面板: 操作监控 ---
  initIdeOpMonitor();

  // --- 聊天宽度滑块 ---
  const chatWidth = document.getElementById("chat-width");
  const chatWidthValue = document.getElementById("chat-width-value");
  if (chatWidth) {
    const saved = localStorage.getItem("beilu-chat-width");
    if (saved) chatWidth.value = saved;
    if (chatWidthValue) chatWidthValue.textContent = chatWidth.value + "%";
    applyChatWidth(chatWidth.value);

    chatWidth.addEventListener("input", () => {
      const val = chatWidth.value;
      localStorage.setItem("beilu-chat-width", val);
      if (chatWidthValue) chatWidthValue.textContent = val + "%";
      applyChatWidth(val);
    });
  }
}

/**
 * 应用字体比例到聊天消息区域
 * 通过更新 CSS 变量 --beilu-font-size 实现，确保 .message-content 等子元素也生效
 * @param {string|number} percent - 百分比值 (50-200)
 */
function applyFontScale(percent) {
  const scale = parseInt(percent) / 100;
  const basePx = 14; // 默认基准字体大小（px）
  const newSize = Math.round(basePx * scale) + "px";
  document.documentElement.style.setProperty("--beilu-font-size", newSize);
  // 同时设置容器 font-size，影响非 .message-content 的子元素（如时间戳等）
  const chatMessages = document.getElementById("chat-messages");
  if (chatMessages) chatMessages.style.fontSize = `${scale}rem`;
}

/**
 * 应用聊天宽度到整个聊天容器（包括消息和输入区域）
 * 限制 #chat-container 的最大宽度，居中显示
 * @param {string|number} percent - 百分比值 (30-100)
 */
function applyChatWidth(percent) {
  const val = parseInt(percent);
  const chatContainer = document.getElementById("chat-container");
  if (chatContainer) {
    if (val >= 100) {
      chatContainer.style.maxWidth = "";
      chatContainer.style.width = "";
      chatContainer.style.alignSelf = "";
    } else {
      chatContainer.style.maxWidth = val + "%";
      chatContainer.style.width = "100%";
      chatContainer.style.alignSelf = "center";
    }
  }
}

/**
 * 同步运行时参数到后端 beilu-preset 插件
 * @param {Object} params - 要更新的参数 { context_msg_limit?, stream? }
 */
async function syncRuntimeParams(params) {
  try {
    await fetch("/api/parts/plugins:beilu-preset/config/runtime-params", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    console.warn("[layout] 同步 runtime-params 失败:", err.message);
  }
}

// ============================================================
// 手机适配
// ============================================================

/** @type {HTMLElement|null} */
let mobileOverlay = null;

/**
 * 初始化手机适配逻辑
 * 小屏（<=768px）时：
 * - 左右栏默认折叠
 * - 点击 toggle 以 overlay 方式展开
 * - 点击遮罩层关闭
 */
function initMobileAdaptation() {
  // 创建遮罩层
  mobileOverlay = document.createElement("div");
  mobileOverlay.className = "mobile-overlay";
  mobileOverlay.addEventListener("click", closeMobilePanel);
  document.body.appendChild(mobileOverlay);

  // 监听窗口大小变化
  const mql = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mql);
  mql.addEventListener("change", handleMobileChange);
}

function handleMobileChange(e) {
  const isMobile = e.matches !== undefined ? e.matches : e;
  document.body.classList.toggle("beilu-mobile", isMobile);

  if (isMobile) {
    // 小屏时自动折叠左右栏
    if (leftPanel) leftPanel.classList.add("collapsed");
    if (rightPanel) rightPanel.classList.add("collapsed");

    // 移动端：取消所有 collapse 的默认展开
    document
      .querySelectorAll(
        '.left-panel .collapse input[type="checkbox"], .right-panel .collapse input[type="checkbox"]',
      )
      .forEach((cb) => {
        cb.checked = false;
      });

    // 显示移动端关闭按钮
    document
      .querySelectorAll(".mobile-panel-close-bar")
      .forEach((el) => el.classList.remove("hidden"));

    // 动态计算顶部栏高度，设置 CSS 变量供 margin-top 使用
    const topBar = document.getElementById("top-bar");
    if (topBar) {
      const h = topBar.offsetHeight;
      document.documentElement.style.setProperty("--top-bar-h", h + "px");
    }

    // 替换 toggle 按钮的行为为 overlay 模式
    leftToggle?.removeEventListener("click", toggleLeftPanel);
    rightToggle?.removeEventListener("click", toggleRightPanel);
    leftToggle?.addEventListener("click", toggleLeftMobile);
    rightToggle?.addEventListener("click", toggleRightMobile);
  } else {
    // 恢复桌面模式
    closeMobilePanel();

    // 移除顶部栏高度 CSS 变量
    document.documentElement.style.removeProperty("--top-bar-h");

    // 隐藏移动端关闭按钮
    document
      .querySelectorAll(".mobile-panel-close-bar")
      .forEach((el) => el.classList.add("hidden"));

    leftToggle?.removeEventListener("click", toggleLeftMobile);
    rightToggle?.removeEventListener("click", toggleRightMobile);
    leftToggle?.addEventListener("click", toggleLeftPanel);
    rightToggle?.addEventListener("click", toggleRightPanel);
    applyLeftPanel();
    applyRightPanel();
  }
}

function toggleLeftMobile() {
  const isOpen = leftPanel?.classList.contains("mobile-open");
  closeMobilePanel();
  if (!isOpen && leftPanel) {
    leftPanel.classList.remove("collapsed");
    leftPanel.classList.add("mobile-open");
    mobileOverlay?.classList.add("active");
  }
}

function toggleRightMobile() {
  const isOpen = rightPanel?.classList.contains("mobile-open");
  closeMobilePanel();
  if (!isOpen && rightPanel) {
    rightPanel.classList.remove("collapsed");
    rightPanel.classList.add("mobile-open");
    mobileOverlay?.classList.add("active");
  }
}

function closeMobilePanel() {
  leftPanel?.classList.remove("mobile-open");
  rightPanel?.classList.remove("mobile-open");
  if (document.body.classList.contains("beilu-mobile")) {
    leftPanel?.classList.add("collapsed");
    rightPanel?.classList.add("collapsed");
  }
  mobileOverlay?.classList.remove("active");
}

// ============================================================
// API 未配置 banner 检查
// ============================================================

/**
 * 检查 AI 服务源是否已配置，控制顶部 banner 显示
 */
async function checkChatApiBanner() {
  const banner = document.getElementById("chat-api-warning-banner");
  if (!banner) return;
  try {
    const list = await fetch("/api/parts/shells:serviceSourceManage/AI").then(
      (r) => r.json(),
    );
    banner.style.display =
      Array.isArray(list) && list.length > 0 ? "none" : "flex";
  } catch {
    // 网络错误时不显示 banner（避免误报）
    banner.style.display = "none";
  }
}

// ============================================================
// 浏览器感知状态轮询
// ============================================================

let _browserPollingTimer = null;

function initBrowserSensePolling() {
  // 立即查询一次
  updateBrowserSenseStatus();
  // 每 30 秒轮询状态（降低频率，仅更新 UI 状态显示）
  if (_browserPollingTimer) clearInterval(_browserPollingTimer);
  _browserPollingTimer = setInterval(updateBrowserSenseStatus, 30000);
}

async function updateBrowserSenseStatus() {
  const countEl = document.getElementById("browser-snapshot-count");
  const dotEl = document.getElementById("browser-status-dot");
  const titleEl = document.getElementById("browser-latest-title");
  if (!countEl && !dotEl && !titleEl) return;

  try {
    const res = await fetch("/api/parts/plugins:beilu-browser/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _action: "getStatus" }),
    });
    if (res.ok) {
      const data = await res.json();
      if (countEl) countEl.textContent = data.snapshotCount ?? 0;
      if (dotEl) {
        // 有快照且最近 30 秒内更新 → 绿色；有快照 → 黄色；无 → 灰色
        const age = data.latestAge ?? Infinity;
        if (data.snapshotCount > 0 && age < 30000) {
          dotEl.className = "w-2 h-2 rounded-full bg-green-500 inline-block";
        } else if (data.snapshotCount > 0) {
          dotEl.className = "w-2 h-2 rounded-full bg-yellow-500 inline-block";
        } else {
          dotEl.className =
            "w-2 h-2 rounded-full bg-base-content/20 inline-block";
        }
      }
      if (titleEl) {
        titleEl.textContent = data.latestTitle || "无快照";
      }
    }
  } catch {
    /* ignore polling errors */
  }
}

// ============================================================
// IDE 权限开关绑定
// ============================================================

/**
 * 初始化 IDE 控制面板中的权限开关
 /**
  * 初始化 IDE 控制面板中的权限开关
  * 页面加载时从后端拉取当前权限状态，监听 change 同步到后端
  * 注意：exec 权限映射到后端的 allowExec 字段（非 permissions.exec）
  */
function initIdePermissionToggles() {
  const permToggles = document.querySelectorAll("[data-ide-perm]");
  if (permToggles.length === 0) return;

  // 从后端拉取当前权限状态
  fetch("/api/parts/plugins:beilu-files/config/getdata")
    .then((r) => r.json())
    .then((data) => {
      const perms = data?.permissions || {};
      permToggles.forEach((toggle) => {
        const key = toggle.dataset.permission;
        if (!key) return;
        // exec 权限特殊映射到 allowExec 字段
        if (key === "exec") {
          toggle.checked = data?.allowExec || false;
        } else if (perms[key] !== undefined) {
          toggle.checked = perms[key];
        }
      });
    })
    .catch(() => {
      /* 拉取失败时保持 HTML 默认值 */
    });

  // 监听 change 事件，同步到后端
  permToggles.forEach((toggle) => {
    toggle.addEventListener("change", () => {
      const key = toggle.dataset.permission;
      if (!key) return;

      // exec 权限特殊处理：映射到 allowExec
      if (key === "exec") {
        fetch("/api/parts/plugins:beilu-files/config/setdata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowExec: toggle.checked }),
        }).catch((err) => {
          console.warn("[layout] 同步 allowExec 失败:", err.message);
        });
        return;
      }

      // 其他权限：更新 permissions 对象
      const permissions = { [key]: toggle.checked };
      fetch("/api/parts/plugins:beilu-files/config/setdata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions }),
      }).catch((err) => {
        console.warn(`[layout] 同步权限 ${key} 失败:`, err.message);
      });
    });
  });
}
// IDE 操作监控
// ============================================================

let _ideOpPollingTimer = null;

/**
 * 初始化 IDE 控制面板的操作监控区域
 * 绑定清空/刷新按钮，启动轮询
 */
function initIdeOpMonitor() {
  const clearBtn = document.getElementById("ide-clear-op-log");
  const refreshBtn = document.getElementById("ide-refresh-op-log");

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      try {
        await fetch("/api/parts/plugins:beilu-files/config/setdata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ _action: "clearOperationHistory" }),
        });
        // 清空 UI
        const logEl = document.getElementById("ide-op-log");
        if (logEl) {
          logEl.innerHTML =
            '<p class="text-base-content/30 text-center py-2">暂无操作记录</p>';
        }
        const statsEl = document.getElementById("ide-op-stats");
        if (statsEl) statsEl.textContent = "总计: 0 | 成功: 0 | 失败: 0";
      } catch (err) {
        console.warn("[layout] 清空操作日志失败:", err.message);
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => pollIdeOpLog());
  }

  // 立即拉取一次
  pollIdeOpLog();

  // 每 5 秒轮询
  if (_ideOpPollingTimer) clearInterval(_ideOpPollingTimer);
  _ideOpPollingTimer = setInterval(pollIdeOpLog, 5000);
}

/**
 * 拉取 beilu-files 操作历史并渲染到 IDE 操作监控面板
 */
async function pollIdeOpLog() {
  const logEl = document.getElementById("ide-op-log");
  const statsEl = document.getElementById("ide-op-stats");
  if (!logEl && !statsEl) return;

  try {
    const res = await fetch("/api/parts/plugins:beilu-files/config/setdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _action: "getOperationHistory" }),
    });
    if (!res.ok) return;
    const data = await res.json();

    // data 格式: { history: [...], stats: { total, success, failed } }
    const history = data?.history || [];
    const stats = data?.stats || { total: 0, success: 0, failed: 0 };

    // 更新统计
    if (statsEl) {
      statsEl.textContent = `总计: ${stats.total} | 成功: ${stats.success} | 失败: ${stats.failed}`;
    }

    // 渲染日志
    if (logEl) {
      if (history.length === 0) {
        logEl.innerHTML =
          '<p class="text-base-content/30 text-center py-2">暂无操作记录</p>';
      } else {
        // 最新的在上面
        const html = history
          .slice()
          .reverse()
          .map((op) => {
            const icon = op.success ? "✅" : "❌";
            const time = op.timestamp
              ? new Date(op.timestamp).toLocaleTimeString()
              : "";
            const detail = op.detail || op.operation || "unknown";
            return `<div class="flex items-start gap-1 py-0.5 border-b border-base-300/30 last:border-0">
              <span>${icon}</span>
              <span class="flex-1 break-all">${detail}</span>
              <span class="text-base-content/30 shrink-0">${time}</span>
            </div>`;
          })
          .join("");
        logEl.innerHTML = html;
      }
    }
  } catch {
    /* ignore polling errors */
  }
}

// 绑定移动端关闭按钮事件（使用事件委托）
document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="close-mobile-panel"]')) {
    closeMobilePanel();
  }
});
