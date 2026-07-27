/**
 * editor.mjs — 编辑器弹窗窗口化 cluster
 *
 * 功能链：打开编辑弹窗（AIRP/编辑器 Tab）→ _bindEditorWindowSizing() 恢复上次窗口尺寸/位置
 *   → 用户拖拽 tab-bar 移动弹窗位置 → mouseup 时 _saveEditorPos() 写入 localStorage
 *   → 用户点击小/中/全屏档位快捷按钮切换尺寸模式并清除自由定位记忆
 *   → _bindAirpMsgCtxInputs() 绑定消息上下文输入框（字数/条数）
 * 关联链：被 layout.mjs import（_bindEditorWindowSizing 等在 initLayout 时调用）；
 *   _saveEditorPos 被 settings.mjs 复用；自身只 import storage.mjs
 */
import { storage, KEYS } from "../state/storage.mjs";

// AIRP-T15 + EX-T2: 编辑弹窗窗口化 — 3档快捷 + 自由拖拽 + 右下角 resize
function _bindEditorWindowSizing() {
  const win = document.getElementById("editor-modal-window");
  if (!win) return;
  const KEY = KEYS.BEILU_EDITOR_WINDOW_SIZE;
  const POS_KEY = KEYS.BEILU_EDITOR_WINDOW_POS;
  const resetFloat = () => {
    win.classList.remove("editor-floating");
    win.style.left = ""; win.style.top = "";
    win.style.width = ""; win.style.height = "";
  };
  const apply = (size, fromUser = true) => {
    resetFloat();
    win.classList.remove("editor-size-small", "editor-size-full");
    if (size === "small") win.classList.add("editor-size-small");
    else if (size === "full") win.classList.add("editor-size-full");
    storage.set(KEY, size);
    // 仅用户显式点档位时清自由定位；初始化恢复不清（否则冷启动必抹用户摆好的位置=记忆失效 bug）
    if (fromUser) storage.remove(POS_KEY);
  };
  apply(storage.get(KEY) || "normal", false);
  // 恢复自由定位 (localStorage 有就覆盖档位)
  try {
    const savedPos = JSON.parse(storage.get(POS_KEY) || "null");
    if (savedPos && savedPos.left != null) {
      win.classList.add("editor-floating");
      win.classList.remove("editor-size-small", "editor-size-full");
      win.style.left = savedPos.left + "px";
      win.style.top = savedPos.top + "px";
      if (savedPos.width) win.style.width = savedPos.width + "px";
      if (savedPos.height) win.style.height = savedPos.height + "px";
    }
  } catch {}

  document.getElementById("editor-size-small")?.addEventListener("click", () => apply("small"));
  document.getElementById("editor-size-normal")?.addEventListener("click", () => apply("normal"));
  document.getElementById("editor-size-full")?.addEventListener("click", () => apply("full"));
  document.getElementById("editor-size-close")?.addEventListener("click", () => {
    document.getElementById("center-tab-editor")?.classList.add("hidden");
  });

  // EX-T2: 拖拽 (tab-bar 作为拖拽头)
  const tabBar = win.querySelector(".editor-tab-bar");
  if (tabBar) {
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    tabBar.addEventListener("mousedown", (e) => {
      // 点到按钮/控制区不触发拖拽
      if (e.target.closest(".editor-tab, button, input, select")) return;
      if (win.classList.contains("editor-size-full")) return;
      dragging = true;
      win.classList.add("editor-dragging");
      const r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      // 切到自由定位模式
      win.classList.add("editor-floating");
      win.classList.remove("editor-size-small");
      win.style.left = sl + "px"; win.style.top = st + "px";
      win.style.width = r.width + "px"; win.style.height = r.height + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const newLeft = Math.max(-win.offsetWidth + 100, Math.min(window.innerWidth - 100, sl + e.clientX - sx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, st + e.clientY - sy));
      win.style.left = newLeft + "px";
      win.style.top = newTop + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      win.classList.remove("editor-dragging");
      _saveEditorPos(win, POS_KEY);
    });
  }

  // EX-T2: 右下角 resize handle
  const handle = document.getElementById("editor-resize-handle");
  if (handle) {
    let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
    handle.addEventListener("mousedown", (e) => {
      if (win.classList.contains("editor-size-full")) return;
      resizing = true;
      const r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      // 切到自由模式,锁定当前位置
      if (!win.classList.contains("editor-floating")) {
        win.classList.add("editor-floating");
        win.classList.remove("editor-size-small");
        win.style.left = r.left + "px"; win.style.top = r.top + "px";
      }
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      // 界面9: 加视口上限，防拖到比屏幕大后 resize 手柄出界回不来
      win.style.width = Math.min(window.innerWidth, Math.max(400, sw + (e.clientX - sx))) + "px";
      win.style.height = Math.min(window.innerHeight, Math.max(300, sh + (e.clientY - sy))) + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      _saveEditorPos(win, POS_KEY);
    });
  }
}

function _saveEditorPos(win, key) {
  try {
    const r = win.getBoundingClientRect();
    storage.set(key, JSON.stringify({
      left: Math.round(r.left), top: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    }));
  } catch {}
}

// 界面9: 设置弹窗「重新显示工作模式欢迎引导」
function _bindResetWorkWelcome() {
  document.getElementById("ui-reset-work-welcome")?.addEventListener("click", (e) => {
    try { storage.remove(KEYS.BEILU_WORK_WELCOME_SEEN); } catch { /* ignore */ }
    e.currentTarget.innerHTML = '<i data-ic="check"></i> 已重置';
  });
}

// AIRP-T10: 右栏"消息与上下文"可见 input 镜像到 hidden menu-* (保留 featureControls 兼容)
function _bindAirpMsgCtxInputs() {
  const pairs = [
    ["right-menu-msg-load-limit", "menu-msg-load-limit"],
    ["right-menu-context-msg-limit", "menu-context-msg-limit"],
  ];
  pairs.forEach(([visId, origId]) => {
    const vis = document.getElementById(visId);
    const orig = document.getElementById(origId);
    if (!vis || !orig) return;
    // 初始同步(从已持久化的 menu input 读)
    if (orig.value) vis.value = orig.value;
    // vis → orig
    vis.addEventListener("input", () => {
      orig.value = vis.value;
      orig.dispatchEvent(new Event("change", { bubbles: true }));
      orig.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // orig → vis
    orig.addEventListener("change", () => { vis.value = orig.value; });
  });
}


export { _bindEditorWindowSizing, _saveEditorPos, _bindResetWorkWelcome, _bindAirpMsgCtxInputs };
