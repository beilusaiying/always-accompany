/**
 * ide.mjs — IDE 模式与记忆模式活动栏交互 cluster
 *
 * 功能链：切换到 IDE/记忆 Tab → restoreIdePanel() 从 layoutState 恢复上次激活的面板
 *   → initIdeActivityBar() 绑定活动栏按钮 → 点击面板按钮时互斥显示对应 .ide-sidebar-panel
 *   → IDE 模式下 _toggleIdeMainArea() 切换主区视图（文件树/连接/MCP 等）
 *   → 记忆模式下 _toggleMemMainArea()（memtool.mjs）切换主区三层视图
 *   → 切到「子模式」面板时 _loadIdeSubmodesPanel() 异步拉取并渲染子模式列表
 * why：IDE 和记忆两个模式共用同一套活动栏交互逻辑（互斥高亮 + DOM 入参解耦），
 *   通过 panelPrefix 参数区分 ide-panel/mem-panel 两套命名空间
 * 关联链：被 layout.mjs import（initIdeActivityBar/restoreIdePanel 在 initLayout 时调用）；
 *   import core.mjs（layoutState/saveState）、memtool.mjs（_toggleMemMainArea）、featureControls.mjs（getCurrentMode）
 * 影响范围：改动影响 IDE/记忆模式下活动栏的面板切换、主区内容联动、子模式列表加载
 * 使用效果：用户在 IDE 模式点击「文件」「连接」「子模式」图标，右侧主区内容随之切换；刷新后激活的面板自动恢复
 */
import { layoutState, saveState } from "../../shared/layout/core.mjs";
import { _toggleMemMainArea } from "../memory/memtool.mjs";
// escapeHtml/sendAction/currentChatId/getCurrentMode/PRESET_INHERIT_LABEL import 已随
//   _loadIdeSubmodesPanel 死渲染器删除（2026-07-16），本文件不再有消费点。

// ============================================================
// IDE 活动栏交互
// ============================================================

function initIdeActivityBar(activityBar, sidebar, stateKey, panelPrefix) {
  if (!activityBar || !sidebar) return;

  const dataAttr = panelPrefix === "mem-panel" ? "data-mem-panel" : "data-ide-panel";
  activityBar.addEventListener("click", (e) => {
    const btn = e.target.closest(`[${dataAttr}]`);
    if (!btn) return;
    const panelName = btn.dataset.idePanel || btn.dataset.memPanel;
    if (!panelName) return;

    activityBar.querySelectorAll(".ide-activity-btn").forEach((b) => {
      b.classList.remove("ide-activity-active");
    });
    btn.classList.add("ide-activity-active");

    sidebar.querySelectorAll(".ide-sidebar-panel").forEach((p) => {
      p.classList.add("hidden");
    });
    const target = document.getElementById(`${panelPrefix}-${panelName}`);
    if (target) {
      // [0727] 单例面板可能被别的模式借走（MCP：work 侧栏复用同一份 DOM，见 workPanel._renderMcpSidebar）——
      //   显示前先搬回本侧栏。不搬=面板在 work 容器里显形，本侧栏空着（getElementById 找得到但不在这）。
      if (target.parentElement !== sidebar) sidebar.appendChild(target);
      target.classList.remove("hidden");
    }

    if (panelPrefix === "ide-panel") {
      _toggleIdeMainArea(panelName);
    }
    // 「子模式」面板内容由 subModePanel 单例管理面板承担（其 MutationObserver 监听
    //   ide-panel-submodes 显形即挂载/刷新）。原 _loadIdeSubmodesPanel 死渲染器已删（2026-07-16）：
    //   其目标 #ide-submodes-list 全库零定义，函数首行 if(!list) return 必然早退=从未产出 UI。
    if (panelPrefix === "mem-panel") {
      _toggleMemMainArea(panelName);
    }

    layoutState[stateKey] = panelName;
    saveState();
  });

  // [多线 0726 凛倾] IDE 活动栏「＋ 开新对话线」按钮的行为绑定（按钮本体=index.html 静态声明
  // #ide-line-new-btn，不再由 JS 造；本处只把点击行为接上，lineManager 幂等自守）。
  // 动态 import：lineManager 经 conversationManager/chat.mjs 拉起整条 chat-core 链，
  // 静态引会把重依赖提前到 layout 初始化路径（且有环风险）。失败=按钮在但点击无反应，故不静默：
  // 失败要么是模块链坏、要么是本文件走了缓存旧版，两者都得能看见（原 console.warn 吞在控制台深处）。
  if (activityBar.id === "ide-activity-bar") {
    import("../../shared/chat-core/lineManager.mjs")
      .then((m) => m.initLineManager?.(activityBar))
      .then(() => {
        // 绑定成功的落地标记（可观测）：initLineManager 内部会写 btn.dataset.lineBound="1"。
        //   没有这个属性 = 接线根本没跑到；有属性但点击没反应 = 问题在 openLinePicker 内部。
        //   给排查一个**一眼可判**的信号，不必靠猜。
        console.log("[ide] lineManager 已绑定（＋号可用）");
      })
      .catch((e) => {
        console.error("[ide] lineManager 绑定失败（＋号按钮点击将无反应）:", e);
        // [0727] 原来只有 console.error + 一个**零消费者**的事件（全库无监听=派了也没人听），
        //   用户侧完全静默：按钮在、点了没反应、界面无任何提示。故障必须可见——
        //   toast 走全局桥（同 websocket.mjs 的 window.showToast?.() 范式），不新增依赖。
        window.showToast?.("error", `＋号（开新对话线）初始化失败，点击不会有反应：${e?.message || e}`, 8000);
        window.dispatchEvent(new CustomEvent("beilu:module-load-failed", { detail: { module: "lineManager", error: String(e?.message || e) } }));
      });
  }
}

// [IDE-T1] _loadIdeSubmodesPanel 已删（2026-07-16 单例根修随批）：目标容器 #ide-submodes-list
//   与编辑按钮 #ide-submodes-edit-btn 全库零定义（index.html/所有渲染器均不产出），函数首行
//   if(!list) return 必然早退=从未产出过 UI。IDE「子模式」面板的真实内容一直是 subModePanel
//   的管理面板（observer 挂载），列表/切换/编辑均归其单例。

function restoreIdePanel(activityBar, sidebar, stateKey, panelPrefix) {
  if (!activityBar || !sidebar) return;
  const _PANEL_DEFAULTS = { "ide-panel": "explorer", "mem-panel": "chat" };
  const activePanel = layoutState[stateKey] || _PANEL_DEFAULTS[panelPrefix];

  activityBar.querySelectorAll(".ide-activity-btn").forEach((btn) => {
    const panelName = btn.dataset.idePanel || btn.dataset.memPanel;
    btn.classList.toggle("ide-activity-active", panelName === activePanel);
  });

  sidebar.querySelectorAll(".ide-sidebar-panel").forEach((p) => {
    p.classList.add("hidden");
  });
  const target = document.getElementById(`${panelPrefix}-${activePanel}`);
  if (target) {
    if (target.parentElement !== sidebar) sidebar.appendChild(target); // 同上：借出的单例先搬回
    target.classList.remove("hidden");
  }

  // ★ Bug 2 修复：恢复时也要同步主区域显示状态
  if (panelPrefix === "ide-panel") {
    _toggleIdeMainArea(activePanel);
  } else if (panelPrefix === "mem-panel") {
    // 记忆 3 层：reload 后同步主区（无保存态默认对话台），防按钮高亮与主区不一致
    _toggleMemMainArea(activePanel || "chat");
  }
}

// ============================================================
// IDE 主区域切换（文件编辑器 ↔ 后台监控）
// ============================================================

/**
 * 根据当前选中的侧边栏面板，切换 IDE 主区域显示内容。
 * connections 面板 → 显示后台监控视图
 * 其他面板 → 显示文件编辑器
 * TODO: 后续需要为 mcp 面板设计独立的右侧界面
 * @param {string} panelName - 当前选中的面板名
 */
function _toggleIdeMainArea(panelName) {
  const isMonitorPanel = panelName === "connections";
  const isSubmodesPanel = panelName === "submodes";
  const monitor = document.getElementById("ide-backend-monitor");
  const subDetail = document.getElementById("ide-submode-detail");
  const menubar = document.getElementById("ide-menubar");
  const editorArea = document.getElementById("file-editor-area");
  const statusbar = document.getElementById("ide-statusbar");
  const editorTabsBar =
    document.getElementById("ide-editor-tabs")?.parentElement;

  // 默认全隐藏三个右区视图
  if (monitor) monitor.style.display = "none";
  if (subDetail) subDetail.style.display = "none";
  if (editorArea) editorArea.style.display = "none";

  if (isMonitorPanel) {
    if (menubar) menubar.style.display = "none";
    if (editorTabsBar) editorTabsBar.style.display = "none";
    if (statusbar) statusbar.style.display = "none";
    if (monitor) monitor.style.display = "";
  } else if (isSubmodesPanel) {
    if (menubar) menubar.style.display = "none";
    if (editorTabsBar) editorTabsBar.style.display = "none";
    if (statusbar) statusbar.style.display = "none";
    if (subDetail) subDetail.style.display = "";
    _updateSubModeDetailView();
  } else {
    if (menubar) menubar.style.display = "";
    if (editorTabsBar) editorTabsBar.style.display = "";
    if (editorArea) editorArea.style.display = "";
    if (statusbar) statusbar.style.display = "";
  }
}

function _updateSubModeDetailView() {
  // 从 subModePanel 获取当前活跃子模式数据，填充右栏详情
  const event = new CustomEvent("beilu:request-submode-detail");
  window.dispatchEvent(event);
}

// 重做RT1: 壳级全局左栏(SHELL_PANEL_BY_MODE/_applyShellBarMode/initShellLeftBar)已删——
// 凛倾拍板:活动栏只存在于 ide/work 模式内部;全局模式切换=顶栏下拉唯一入口;会话/窗口顶部已有。

export { initIdeActivityBar, restoreIdePanel };
