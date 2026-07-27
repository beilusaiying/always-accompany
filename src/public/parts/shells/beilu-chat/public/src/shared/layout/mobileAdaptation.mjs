/**
 * mobileAdaptation.mjs — 移动端适配 + 浏览器感知状态轮询
 *
 * 功能链：
 *   initMobileAdaptation(refs) → 创建 .mobile-overlay 遮罩 → 监听 matchMedia(max-width:768px)
 *   → 小屏时 body.beilu-mobile → 左/右侧栏 toggle 按钮绑定 → 展开面板时显示遮罩
 *   → 点击遮罩 closeMobilePanel → 收起面板 + 隐藏遮罩
 *   updateBrowserSenseStatus() → 轮询后端浏览器感知 API → 刷新状态指示器 DOM
 *
 * why：
 *   移动端屏幕宽度不足以同时显示左右侧栏，需 overlay 模式分别展开；
 *   遮罩层点击关闭模式与 PC 侧栏行为一致（不遮罩、不影响聊天区布局）；
 *   浏览器感知（browser sense）状态需轮询后端，由此模块统一维护轮询入口。
 *
 * 关联链：
 *   ← layout.mjs（initMobileAdaptation 调用，传入 leftPanel/rightPanel/toggle 引用）
 *   → shared/transport/api-client.mjs（apiFetch：浏览器感知状态 API）
 *   → shared/state/storage.mjs（storage/KEYS：桌面端折叠组状态 BEILU_CHAT_COLLAPSE_STATES 读取恢复）
 *
 * 影响范围：
 *   DOM：body.beilu-mobile 类切换（触发全局移动端样式）；
 *   body 下注入 .mobile-overlay 遮罩节点；
 *   左/右侧栏的显示/隐藏由外部传入的 toggleLeftPanel/toggleRightPanel 控制。
 *
 * 使用效果：
 *   ≤768px 屏幕宽度时自动切换移动布局；
 *   点顶栏汉堡按钮展开左/右侧栏，点遮罩或内容区收起。
 */

import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中（折叠组状态恢复）

// ============================================================
// 手机适配
// ============================================================

/** @type {HTMLElement|null} */
let mobileOverlay = null;

// 面板引用（由 initMobileAdaptation 注入）
let _leftPanel = null;
let _rightPanel = null;
let _leftToggle = null;
let _rightToggle = null;
let _toggleLeftPanel = null;
let _toggleRightPanel = null;
let _mobileListenerAC = null;

/**
 * 初始化手机适配逻辑
 * @param {{
 *   leftPanel: HTMLElement,
 *   rightPanel: HTMLElement,
 *   leftToggle: HTMLElement,
 *   rightToggle: HTMLElement,
 *   toggleLeftPanel: Function,
 *   toggleRightPanel: Function,
 * }} refs - 来自 layout.mjs 的 DOM 引用和函数
 */
export function initMobileAdaptation(refs) {
  _leftPanel = refs.leftPanel;
  _rightPanel = refs.rightPanel;
  _leftToggle = refs.leftToggle;
  _rightToggle = refs.rightToggle;
  _toggleLeftPanel = refs.toggleLeftPanel;
  _toggleRightPanel = refs.toggleRightPanel;

  // 创建遮罩层
  mobileOverlay = document.createElement("div");
  mobileOverlay.className = "mobile-overlay";
  mobileOverlay.addEventListener("click", closeMobilePanel);
  document.body.appendChild(mobileOverlay);

  const mql = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mql);
  mql.addEventListener("change", handleMobileChange);
}

function handleMobileChange(e) {
  const isMobile = e.matches !== undefined ? e.matches : e;
  document.body.classList.toggle("beilu-mobile", isMobile);

  if (isMobile) {
    if (_leftPanel) _leftPanel.classList.add("collapsed");
    if (_rightPanel) _rightPanel.classList.add("collapsed");

    document
      .querySelectorAll(
        '.left-panel .collapse input[type="checkbox"], .right-panel .collapse input[type="checkbox"]',
      )
      .forEach((cb) => {
        cb.checked = false;
      });

    document
      .querySelectorAll(".mobile-panel-close-bar")
      .forEach((el) => el.classList.remove("hidden"));

    const topBar = document.getElementById("top-bar");
    if (topBar) {
      const h = topBar.offsetHeight;
      document.documentElement.style.setProperty("--top-bar-h", h + "px");
    }

    _mobileListenerAC?.abort();
    _mobileListenerAC = new AbortController();
    const sig = { signal: _mobileListenerAC.signal };
    _leftToggle?.removeEventListener("click", _toggleLeftPanel);
    _rightToggle?.removeEventListener("click", _toggleRightPanel);
    _leftToggle?.addEventListener("click", toggleLeftMobile, sig);
    _rightToggle?.addEventListener("click", toggleRightMobile, sig);
  } else {
    closeMobilePanel();
    _mobileListenerAC?.abort();
    _mobileListenerAC = null;

    document.documentElement.style.removeProperty("--top-bar-h");

    document
      .querySelectorAll(".mobile-panel-close-bar")
      .forEach((el) => el.classList.add("hidden"));

    if (_toggleLeftPanel)
      _leftToggle?.addEventListener("click", _toggleLeftPanel);
    if (_toggleRightPanel)
      _rightToggle?.addEventListener("click", _toggleRightPanel);

    // 调用 layout 提供的恢复函数（applyPanels 统一管 display + collapsed class）
    refs_applyPanels();

    // 恢复桌面端折叠组状态（从 localStorage 读取）
    try {
      const saved = storage.get(KEYS.BEILU_CHAT_COLLAPSE_STATES);
      if (saved) {
        const states = JSON.parse(saved);
        // 键=data-collapse-id（collapse.mjs saveCollapseState 的存储键）；原 cb.id 恒空=恢复链断
        document.querySelectorAll('.left-panel .collapse input[type="checkbox"], .right-panel .collapse input[type="checkbox"]').forEach((cb) => {
          const cid = cb.dataset.collapseId;
          if (cid && states[cid] !== undefined) cb.checked = states[cid];
        });
      }
    } catch { /* 恢复失败不影响布局 */ }
  }
}

/** 恢复桌面面板状态（由外部注入 applyLeftPanel/applyRightPanel） */
let _applyLeft = null;
let _applyRight = null;

/** 供 layout.mjs 注册面板恢复函数 */
export function registerApplyPanelFns(applyLeft, applyRight) {
  _applyLeft = applyLeft;
  _applyRight = applyRight;
}

function refs_applyPanels() {
  if (_applyLeft) _applyLeft();
  if (_applyRight) _applyRight();
}

function toggleLeftMobile() {
  const isOpen = _leftPanel?.classList.contains("mobile-open");
  closeMobilePanel();
  if (!isOpen && _leftPanel) {
    _leftPanel.classList.remove("collapsed");
    _leftPanel.classList.add("mobile-open");
    mobileOverlay?.classList.add("active");
  }
}

function toggleRightMobile() {
  const isOpen = _rightPanel?.classList.contains("mobile-open");
  closeMobilePanel();
  if (!isOpen && _rightPanel) {
    _rightPanel.classList.remove("collapsed");
    _rightPanel.classList.add("mobile-open");
    mobileOverlay?.classList.add("active");
  }
}

export function closeMobilePanel() {
  _leftPanel?.classList.remove("mobile-open");
  _rightPanel?.classList.remove("mobile-open");
  if (document.body.classList.contains("beilu-mobile")) {
    _leftPanel?.classList.add("collapsed");
    _rightPanel?.classList.add("collapsed");
  }
  mobileOverlay?.classList.remove("active");
}

// 浏览器感知状态轮询已删（2026-07-16）：beilu-browser 插件整体移除
//   （其 DOM 消费点 browser-snapshot-count/browser-status-dot/browser-latest-title 早已不在 index.html）
