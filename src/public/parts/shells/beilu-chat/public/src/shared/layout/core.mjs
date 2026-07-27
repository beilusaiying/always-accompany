/**
 * core.mjs — layout 共享状态与基础行为基座
 *
 * 功能链：应用启动 → loadState() 从 localStorage 读取上次布局快照 → 挂载到 layoutState（唯一权威 UI 布局态）
 *   → 各 cluster 读取 layoutState 恢复面板宽度/折叠状态 → 用户操作后 saveState() 写回 localStorage
 *   → initSidebarResize() 为任意侧栏绑定拖拽调宽（mousedown/mousemove/mouseup 三事件链）
 * why：R3 拆分后各 cluster 都需要读写同一份布局状态，core 作为无 feature 依赖的最小基座打破循环，
 *   ESM live-binding 保证 layoutState 对象属性变更对所有 importer 实时可见
 * 关联链：被 layout.mjs / smart.mjs / ide.mjs / memswitch.mjs / charsel.mjs 等所有需要布局状态的 cluster import；
 *   自身只 import storage.mjs，无其他 layout 内依赖
 * 影响范围：改动 layoutState 字段影响所有依赖该字段的面板宽度/折叠记忆；改动 saveState/loadState 影响布局持久化
 * 使用效果：用户调整侧栏宽度或折叠面板后刷新页面，布局自动还原到上次状态
 */
import { storage, KEYS } from "../state/storage.mjs";

// 键走 KEYS 单源（原裸字符串与 storage-keys.mjs BEILU_CHAT_LAYOUT 双处定义同一键，漂移隐患）
const STORAGE_KEY = KEYS.BEILU_CHAT_LAYOUT;

let layoutState = {
  leftCollapsed: false,
  rightCollapsed: false,
  activeTab: "chat",
  // 左右栏开合按 tab 记忆 { [tab]: { left: bool, right: bool } }——chat/smart 共用同一对 panel DOM，
  // 原全局单值会被 smart 每次进入的强制折叠污染（凛倾 07-11「侧栏没有记录上次操作」根因）
  panelMemory: {},
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  ideSidebarWidth: 240,
  ideActivePanel: "explorer",
  memSidebarWidth: 240,
  memActivePanel: "memory-tree",
  workActivePanel: "chat", // work 模式活动栏子面板（chat=侧栏隐藏全宽对话），与 ideActivePanel 同框架
  botActivePanel: "list", // bot 模式 BCSLO 活动栏面板，与 ideActivePanel 同框架
  companionSidebarWidth: 240,
  chatInputHeight: 0, // 输入框用户定高（0=未设不应用）；布局尺寸统一归本收口，与侧栏宽度同仓
};

function loadState() {
  try {
    const saved = storage.get(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      layoutState = { ...layoutState, ...parsed };
      // 迁移：旧快照无 panelMemory 时，用旧字段种子 chat 条目（rightCollapsedByUser=旧 chat 右栏专例）
      if (parsed.panelMemory === undefined) {
        layoutState.panelMemory = {
          chat: { left: !!parsed.leftCollapsed, right: !!parsed.rightCollapsedByUser },
        };
      }
      if (!layoutState.panelMemory || typeof layoutState.panelMemory !== "object") {
        layoutState.panelMemory = {};
      }
      delete layoutState.rightCollapsedByUser;
    }
  } catch {
    /* ignore */
  }
}

function saveState() {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(layoutState));
  } catch {
    /* ignore */
  }
}

const _sidebarResizeACs = new Map();

// opts(2026-07-09 T7 陪伴三栏可调扩展,向后兼容):invert=手柄在栏左缘(右侧栏)时拖动方向取反;min=最小宽(默认160,窄导航栏可降)。
function initSidebarResize(sidebar, resizeHandle, stateKey, opts) {
  if (!sidebar || !resizeHandle) return;
  const _invert = !!(opts && opts.invert);
  const _minW = (opts && opts.min > 0) ? opts.min : 160;

  const prev = _sidebarResizeACs.get(stateKey);
  if (prev) prev.abort();
  const ac = new AbortController();
  _sidebarResizeACs.set(stateKey, ac);
  const sig = { signal: ac.signal };

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
  }, sig);

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const delta = _invert ? (startX - e.clientX) : (e.clientX - startX);
    const newWidth = Math.max(
      _minW,
      Math.min(startWidth + delta, window.innerWidth * 0.5),
    );
    sidebar.style.width = newWidth + "px";
  }, sig);

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    resizeHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    layoutState[stateKey] = sidebar.offsetWidth;
    saveState();
  }, sig);

  const savedWidth = layoutState[stateKey];
  if (savedWidth && savedWidth > 0) {
    sidebar.style.width = savedWidth + "px";
  }
}

// 三栏折叠应用（R3-b 并入 core：SMART/shell/orch 共用；getElementById re-query 解耦原 layout.mjs:91/92 模块级 ref）
function applyLeftPanel() {
  const leftPanel = document.getElementById("left-panel");
  if (!leftPanel) return;
  leftPanel.classList.toggle("collapsed", layoutState.leftCollapsed);
  leftPanel.style.display = "";
  const lHandle = document.getElementById("left-panel-resize");
  if (lHandle) lHandle.classList.toggle("hidden", layoutState.leftCollapsed);
}

function applyRightPanel() {
  const rightPanel = document.getElementById("right-panel");
  if (!rightPanel) return;
  rightPanel.classList.toggle("collapsed", layoutState.rightCollapsed);
  rightPanel.style.display = "";
  const rHandle = document.getElementById("right-panel-resize");
  if (rHandle) rHandle.classList.toggle("hidden", layoutState.rightCollapsed);
}

// 三栏面板拖拽调宽（R3 并入 core：resize 基建,与 initSidebarResize 同源；leftPanel/rightPanel re-query 解耦）
function initPanelResize() {
  const leftPanel = document.getElementById("left-panel");
  const rightPanel = document.getElementById("right-panel");
  const leftHandle = document.getElementById("left-panel-resize");
  const rightHandle = document.getElementById("right-panel-resize");

  function setPanelWidth(panel, width) {
    // 0713：content 宽度改由 CSS 派生（.left/right-panel-content width:100%），不再 JS 双写——
    //   原 querySelector 只命中第一个 content div（左栏有 chat/smart 两份 .left-panel-content），
    //   smart 模式拖宽面板内容不跟随；残留的旧 inline width 会压过 CSS，一并清掉。
    panel.style.width = width + "px";
    panel.querySelectorAll(".left-panel-content, .right-panel-content").forEach((c) => {
      c.style.width = "";
      c.style.minWidth = "";
    });
  }

  if (
    leftPanel &&
    layoutState.leftPanelWidth &&
    layoutState.leftPanelWidth !== 280
  ) {
    setPanelWidth(leftPanel, layoutState.leftPanelWidth);
  }
  if (
    rightPanel &&
    layoutState.rightPanelWidth &&
    layoutState.rightPanelWidth !== 320
  ) {
    setPanelWidth(rightPanel, layoutState.rightPanelWidth);
  }

  if (leftPanel && leftHandle) {
    let dragging = false,
      startX = 0,
      startW = 0;

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
      const newW = Math.max(
        180,
        Math.min(startW + delta, window.innerWidth * 0.45),
      );
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

  if (rightPanel && rightHandle) {
    let dragging = false,
      startX = 0,
      startW = 0;

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
      const delta = startX - cx;
      const newW = Math.max(
        200,
        Math.min(startW + delta, window.innerWidth * 0.45),
      );
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

export { layoutState, loadState, saveState, initSidebarResize, applyLeftPanel, applyRightPanel, initPanelResize };
