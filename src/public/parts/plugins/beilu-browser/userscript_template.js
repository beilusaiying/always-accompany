// ==UserScript==
// @name         Beilu Browser Sense
// @namespace    beilu-always-accompany
// @version      0.2.0
// @description  浏览器页面感知悬浮球 — 让角色能"看到"你在看什么
// @author       凛倾
// @match        *://*/*
// @exclude      *://localhost:*/*
// @exclude      *://127.0.0.1:*/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==
(function () {
  "use strict";

  // ============================================================
  // 配置区
  // ============================================================
  const DEFAULT_CONFIG = {
    apiBase: "http://localhost:1314",
    apiKey: "", // API Key（用于认证，在 Fount 设置中获取）
    pushInterval: 30000, // 自动推送间隔（毫秒）
    maxContentLength: 20000, // 最大内容长度
    autoSend: false, // 是否自动定时推送
    sendOnSelection: true, // 选中文本时推送
  };

  let config = Object.assign({}, DEFAULT_CONFIG);
  // 从 GM 存储读取配置
  try {
    const saved = GM_getValue("beilu_browser_config", null);
    if (saved) Object.assign(config, JSON.parse(saved));
  } catch (e) {
    /* ignore */
  }

  function saveConfig() {
    try {
      GM_setValue("beilu_browser_config", JSON.stringify(config));
    } catch (e) {
      /* ignore */
    }
  }

  // ============================================================
  // 页面内容提取
  // ============================================================
  let lastPushedUrl = "";
  let lastPushedContent = "";

  function extractPageText() {
    const clone = document.body.cloneNode(true);
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "canvas",
      "nav",
      "footer",
      "header",
      ".ad",
      ".ads",
      ".advertisement",
      '[role="banner"]',
      '[role="navigation"]',
      '[role="contentinfo"]',
    ];
    removeSelectors.forEach((sel) => {
      try {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      } catch (e) {
        /* ignore */
      }
    });
    let text = clone.innerText || clone.textContent || "";
    text = text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return text.substring(0, config.maxContentLength);
  }

  // ============================================================
  // 网络发送
  // ============================================================
  let isConnected = false;
  let lastError = "";

  function pushPageSnapshot(selectedText, callback) {
    const content = extractPageText();
    const url = window.location.href;
    const title = document.title;

    // 没有变化时不重复推送（除非有选中文本或手动触发）
    if (
      !selectedText &&
      url === lastPushedUrl &&
      content === lastPushedContent
    ) {
      if (callback) callback(true, "内容无变化，已跳过");
      return;
    }
    lastPushedUrl = url;
    lastPushedContent = content;

    const payload = {
      _action: "pushPage",
      url,
      title,
      content,
      selectedText: selectedText || "",
      timestamp: Date.now(),
    };

    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-API-Key"] = config.apiKey;

    GM_xmlhttpRequest({
      method: "POST",
      url: `${config.apiBase}/api/parts/plugins:beilu-browser/config/setdata`,
      headers: headers,
      data: JSON.stringify(payload),
      timeout: 5000,
      onload: function (response) {
        if (response.status === 200) {
          isConnected = true;
          lastError = "";
          updateOrbStatus();
          if (callback) callback(true, "发送成功");
          console.log("[Beilu Browser] ✓ 页面已发送:", title.substring(0, 40));
        } else {
          isConnected = false;
          lastError = `HTTP ${response.status}`;
          updateOrbStatus();
          if (callback) callback(false, lastError);
        }
      },
      onerror: function (e) {
        isConnected = false;
        lastError = "连接失败";
        updateOrbStatus();
        if (callback) callback(false, lastError);
      },
      ontimeout: function () {
        isConnected = false;
        lastError = "连接超时";
        updateOrbStatus();
        if (callback) callback(false, lastError);
      },
    });
  }

  // 初始连接检测
  function checkConnection() {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-API-Key"] = config.apiKey;

    GM_xmlhttpRequest({
      method: "POST",
      url: `${config.apiBase}/api/parts/plugins:beilu-browser/config/setdata`,
      headers: headers,
      data: JSON.stringify({ _action: "getSnapshots" }),
      timeout: 3000,
      onload: function (r) {
        isConnected = r.status === 200;
        lastError = isConnected ? "" : `HTTP ${r.status}`;
        updateOrbStatus();
      },
      onerror: function () {
        isConnected = false;
        lastError = "连接失败";
        updateOrbStatus();
      },
      ontimeout: function () {
        isConnected = false;
        lastError = "连接超时";
        updateOrbStatus();
      },
    });
  }

  // ============================================================
  // 悬浮球样式
  // ============================================================
  GM_addStyle(`
		#beilu-browser-orb {
			position: fixed;
			z-index: 2147483647;
			width: 44px;
			height: 44px;
			border-radius: 50%;
			cursor: grab;
			user-select: none;
			-webkit-user-select: none;
			transition: box-shadow 0.3s ease, transform 0.15s ease;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 20px;
			font-family: sans-serif;
			box-shadow: 0 2px 12px rgba(0,0,0,0.25);
		}
		#beilu-browser-orb.connected {
			background: radial-gradient(circle at 35% 35%, #FFD54F, #F9A825);
			box-shadow: 0 2px 12px rgba(249,168,37,0.4);
		}
		#beilu-browser-orb.disconnected {
			background: radial-gradient(circle at 35% 35%, #EF9A9A, #E53935);
			box-shadow: 0 2px 12px rgba(229,57,53,0.4);
		}
		#beilu-browser-orb:hover {
			transform: scale(1.1);
			box-shadow: 0 4px 20px rgba(249,168,37,0.6);
		}
		#beilu-browser-orb:active {
			cursor: grabbing;
			transform: scale(0.95);
		}
		#beilu-browser-orb .orb-icon {
			pointer-events: none;
			line-height: 1;
		}

		/* 呼吸动画 */
		@keyframes beilu-breathe {
			0%, 100% { box-shadow: 0 2px 12px rgba(249,168,37,0.4); }
			50% { box-shadow: 0 2px 20px rgba(249,168,37,0.7); }
		}
		#beilu-browser-orb.connected.idle {
			animation: beilu-breathe 3s ease-in-out infinite;
		}

		/* 发送中旋转 */
		@keyframes beilu-spin {
			0% { transform: rotate(0deg); }
			100% { transform: rotate(360deg); }
		}
		#beilu-browser-orb.sending .orb-icon {
			animation: beilu-spin 1s linear infinite;
		}

		/* 消息输入弹窗 */
		#beilu-browser-msg-dialog {
			position: fixed;
			z-index: 2147483647;
			top: 0; left: 0; right: 0; bottom: 0;
			background: rgba(0,0,0,0.5);
			display: none;
			align-items: center;
			justify-content: center;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		}
		#beilu-browser-msg-dialog.show {
			display: flex;
		}
		#beilu-browser-msg-dialog .msg-box {
			background: #1a1a2e;
			border: 1px solid rgba(255,213,79,0.3);
			border-radius: 12px;
			padding: 20px;
			width: 360px;
			max-width: 90vw;
			box-shadow: 0 8px 32px rgba(0,0,0,0.5);
			color: #e0e0e0;
		}
		#beilu-browser-msg-dialog h3 {
			margin: 0 0 12px 0;
			color: #FFD54F;
			font-size: 15px;
		}
		#beilu-browser-msg-dialog .msg-page-info {
			font-size: 12px;
			color: #888;
			margin-bottom: 10px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#beilu-browser-msg-dialog textarea {
			width: 100%;
			min-height: 80px;
			padding: 8px 10px;
			border: 1px solid rgba(255,255,255,0.2);
			border-radius: 6px;
			background: rgba(255,255,255,0.05);
			color: #e0e0e0;
			font-size: 14px;
			outline: none;
			resize: vertical;
			box-sizing: border-box;
		}
		#beilu-browser-msg-dialog textarea:focus {
			border-color: rgba(255,213,79,0.5);
		}
		#beilu-browser-msg-dialog .msg-btn-row {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			margin-top: 12px;
		}
		#beilu-browser-msg-dialog button {
			padding: 6px 16px;
			border-radius: 6px;
			border: 1px solid rgba(255,255,255,0.2);
			background: rgba(255,255,255,0.05);
			color: #e0e0e0;
			cursor: pointer;
			font-size: 13px;
			transition: background 0.15s;
		}
		#beilu-browser-msg-dialog button:hover {
			background: rgba(255,213,79,0.15);
		}
		#beilu-browser-msg-dialog button.primary {
			background: rgba(249,168,37,0.3);
			border-color: rgba(249,168,37,0.5);
			color: #FFD54F;
		}
	
		/* 菜单 */
		#beilu-browser-menu {
			position: fixed;
			z-index: 2147483646;
			background: #1a1a2e;
			border: 1px solid rgba(255,213,79,0.3);
			border-radius: 12px;
			padding: 6px 0;
			min-width: 180px;
			box-shadow: 0 8px 32px rgba(0,0,0,0.5);
			display: none;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			font-size: 14px;
			color: #e0e0e0;
		}
		#beilu-browser-menu.show { display: block; }
		#beilu-browser-menu .menu-item {
			padding: 10px 16px;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 8px;
			transition: background 0.15s;
		}
		#beilu-browser-menu .menu-item:hover {
			background: rgba(255,213,79,0.15);
		}
		#beilu-browser-menu .menu-item.disabled {
			opacity: 0.4;
			cursor: default;
		}
		#beilu-browser-menu .menu-divider {
			height: 1px;
			background: rgba(255,255,255,0.1);
			margin: 4px 8px;
		}
		#beilu-browser-menu .menu-header {
			padding: 6px 16px;
			font-size: 11px;
			color: #888;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		#beilu-browser-menu .menu-status {
			padding: 6px 16px;
			font-size: 12px;
			color: #888;
		}

		/* Toast 通知 */
		#beilu-browser-toast {
			position: fixed;
			z-index: 2147483647;
			padding: 10px 20px;
			border-radius: 8px;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			font-size: 13px;
			color: #fff;
			pointer-events: none;
			opacity: 0;
			transition: opacity 0.3s ease, transform 0.3s ease;
			transform: translateY(10px);
		}
		#beilu-browser-toast.show {
			opacity: 1;
			transform: translateY(0);
		}
		#beilu-browser-toast.success { background: rgba(46,125,50,0.9); }
		#beilu-browser-toast.error { background: rgba(198,40,40,0.9); }
		#beilu-browser-toast.info { background: rgba(30,30,60,0.9); }

		/* 设置面板 */
		#beilu-browser-settings {
			position: fixed;
			z-index: 2147483646;
			background: #1a1a2e;
			border: 1px solid rgba(255,213,79,0.3);
			border-radius: 12px;
			padding: 20px;
			width: 300px;
			box-shadow: 0 8px 32px rgba(0,0,0,0.5);
			display: none;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			font-size: 14px;
			color: #e0e0e0;
		}
		#beilu-browser-settings.show { display: block; }
		#beilu-browser-settings h3 {
			margin: 0 0 16px 0;
			color: #FFD54F;
			font-size: 16px;
		}
		#beilu-browser-settings label {
			display: flex;
			align-items: center;
			gap: 8px;
			margin: 10px 0;
			cursor: pointer;
		}
		#beilu-browser-settings input[type="text"] {
			width: 100%;
			padding: 6px 10px;
			border: 1px solid rgba(255,255,255,0.2);
			border-radius: 6px;
			background: rgba(255,255,255,0.05);
			color: #e0e0e0;
			font-size: 13px;
			outline: none;
			box-sizing: border-box;
		}
		#beilu-browser-settings input[type="text"]:focus {
			border-color: rgba(255,213,79,0.5);
		}
		#beilu-browser-settings .setting-group {
			margin: 12px 0;
		}
		#beilu-browser-settings .setting-group .label {
			font-size: 12px;
			color: #888;
			margin-bottom: 4px;
		}
		#beilu-browser-settings .btn-row {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			margin-top: 16px;
		}
		#beilu-browser-settings button {
			padding: 6px 16px;
			border-radius: 6px;
			border: 1px solid rgba(255,255,255,0.2);
			background: rgba(255,255,255,0.05);
			color: #e0e0e0;
			cursor: pointer;
			font-size: 13px;
			transition: background 0.15s;
		}
		#beilu-browser-settings button:hover {
			background: rgba(255,213,79,0.15);
		}
		#beilu-browser-settings button.primary {
			background: rgba(249,168,37,0.3);
			border-color: rgba(249,168,37,0.5);
			color: #FFD54F;
		}
	`);

  // ============================================================
  // 悬浮球 DOM
  // ============================================================
  const orb = document.createElement("div");
  orb.id = "beilu-browser-orb";
  orb.className = "disconnected idle";
  orb.innerHTML = '<span class="orb-icon">👁</span>';
  orb.title = "贝露的浏览器感知";

  // 从 GM 存储恢复位置
  let orbX = 20,
    orbY = window.innerHeight - 80;
  try {
    const pos = GM_getValue("beilu_orb_pos", null);
    if (pos) {
      const p = JSON.parse(pos);
      orbX = Math.min(p.x, window.innerWidth - 50);
      orbY = Math.min(p.y, window.innerHeight - 50);
    }
  } catch (e) {
    /* ignore */
  }
  orb.style.left = orbX + "px";
  orb.style.top = orbY + "px";

  document.body.appendChild(orb);

  // ============================================================
  // 菜单 DOM
  // ============================================================
  const menu = document.createElement("div");
  menu.id = "beilu-browser-menu";
  menu.innerHTML = `
  	<div class="menu-header">贝露的浏览器感知</div>
  	<div class="menu-item" data-action="send-page">📄 发送整个页面</div>
  	<div class="menu-item" data-action="send-selection">📝 发送选中文本</div>
  	<div class="menu-item" data-action="send-with-message">💬 发送并对话</div>
  	<div class="menu-divider"></div>
  	<div class="menu-item" data-action="toggle-auto">🔄 自动推送: <span id="beilu-auto-status">关</span></div>
  	<div class="menu-item" data-action="settings">⚙️ 设置</div>
  	<div class="menu-divider"></div>
  	<div class="menu-status" id="beilu-connection-status">状态: 检测中...</div>
  `;
  document.body.appendChild(menu);

  // ============================================================
  // 消息输入弹窗 DOM
  // ============================================================
  const msgDialog = document.createElement("div");
  msgDialog.id = "beilu-browser-msg-dialog";
  msgDialog.innerHTML = `
  	<div class="msg-box">
  		<h3>💬 发送页面给角色</h3>
  		<div class="msg-page-info" id="beilu-msg-page-info"></div>
  		<textarea id="beilu-msg-input" placeholder="写一句话给角色（如：帮我看看这个网页）"></textarea>
  		<div class="msg-btn-row">
  			<button data-action="cancel">取消</button>
  			<button class="primary" data-action="send">发送</button>
  		</div>
  	</div>
  `;
  document.body.appendChild(msgDialog);

  // 消息弹窗事件
  msgDialog.addEventListener("click", (e) => {
    // 点击背景关闭
    if (e.target === msgDialog) {
      msgDialog.classList.remove("show");
      return;
    }
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "cancel") {
      msgDialog.classList.remove("show");
    } else if (action === "send") {
      const input = document.getElementById("beilu-msg-input");
      const message = input?.value?.trim() || "";
      msgDialog.classList.remove("show");
      sendPageWithMessage(message);
    }
  });

  // Enter 键发送（Shift+Enter 换行）
  msgDialog.querySelector("textarea")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const input = document.getElementById("beilu-msg-input");
      const message = input?.value?.trim() || "";
      msgDialog.classList.remove("show");
      sendPageWithMessage(message);
    }
  });

  // ============================================================
  // Toast 通知
  // ============================================================
  const toast = document.createElement("div");
  toast.id = "beilu-browser-toast";
  document.body.appendChild(toast);

  let toastTimer = null;
  function showToast(message, type = "info", duration = 2000) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = type + " show";
    // 定位在悬浮球附近
    const orbRect = orb.getBoundingClientRect();
    toast.style.left = orbRect.left + 55 + "px";
    toast.style.top = orbRect.top + "px";
    toastTimer = setTimeout(() => {
      toast.className = type;
    }, duration);
  }

  // ============================================================
  // 设置面板 DOM
  // ============================================================
  const settings = document.createElement("div");
  settings.id = "beilu-browser-settings";
  settings.innerHTML = `
  <h3>⚙️ 设置</h3>
  <div class="setting-group">
  	<div class="label">后端地址</div>
  	<input type="text" id="beilu-cfg-api" value="${config.apiBase}" />
  </div>
  <div class="setting-group">
  	<div class="label">API Key（在 Fount 设置中获取）</div>
  	<input type="text" id="beilu-cfg-apikey" value="${config.apiKey}" placeholder="留空则不认证" />
  </div>
  <div class="setting-group">
  	<label>
  		<input type="checkbox" id="beilu-cfg-auto" ${config.autoSend ? "checked" : ""} />
  		自动定时推送
  	</label>
  </div>
  <div class="setting-group">
  	<label>
  		<input type="checkbox" id="beilu-cfg-selection" ${config.sendOnSelection ? "checked" : ""} />
  		选中文本时自动发送
  	</label>
  </div>
  <div class="btn-row">
  	<button data-action="cancel">取消</button>
  	<button class="primary" data-action="save">保存</button>
  </div>
 `;
  document.body.appendChild(settings);

  // ============================================================
  // 拖拽逻辑
  // ============================================================
  let isDragging = false;
  let dragStartX, dragStartY, dragOrbX, dragOrbY;
  let hasMoved = false;

  orb.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOrbX = orb.offsetLeft;
    dragOrbY = orb.offsetTop;
    orb.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
    const newX = Math.max(0, Math.min(window.innerWidth - 48, dragOrbX + dx));
    const newY = Math.max(0, Math.min(window.innerHeight - 48, dragOrbY + dy));
    orb.style.left = newX + "px";
    orb.style.top = newY + "px";
  });

  document.addEventListener("mouseup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    orb.style.cursor = "grab";
    // 保存位置
    try {
      GM_setValue(
        "beilu_orb_pos",
        JSON.stringify({ x: orb.offsetLeft, y: orb.offsetTop }),
      );
    } catch (e) {
      /* ignore */
    }
  });

  // ============================================================
  // 点击和长按逻辑
  // ============================================================
  let longPressTimer = null;
  let isLongPress = false;

  orb.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isLongPress = false;
    longPressTimer = setTimeout(() => {
      isLongPress = true;
      showMenu(e);
    }, 500);
  });

  orb.addEventListener("mouseup", (e) => {
    clearTimeout(longPressTimer);
    if (e.button !== 0) return;
    if (hasMoved || isLongPress) return;
    // 短点击 → 弹出发送弹窗（主动发送模式）
    showMessageDialog();
  });

  orb.addEventListener("mouseleave", () => {
    clearTimeout(longPressTimer);
  });

  // 右键也弹菜单
  orb.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e);
  });

  // ============================================================
  // 菜单逻辑
  // ============================================================
  function showMenu(e) {
    const orbRect = orb.getBoundingClientRect();
    // 菜单定位在悬浮球右侧
    let menuX = orbRect.right + 8;
    let menuY = orbRect.top;

    // 如果右侧空间不足，放到左侧
    if (menuX + 200 > window.innerWidth) {
      menuX = orbRect.left - 200;
    }
    // 如果底部空间不足，上移
    if (menuY + 200 > window.innerHeight) {
      menuY = window.innerHeight - 220;
    }

    menu.style.left = Math.max(0, menuX) + "px";
    menu.style.top = Math.max(0, menuY) + "px";

    // 更新菜单状态
    document.getElementById("beilu-auto-status").textContent = config.autoSend
      ? "开"
      : "关";

    const selectionItem = menu.querySelector('[data-action="send-selection"]');
    const hasSelection = window.getSelection().toString().trim().length > 5;
    selectionItem.classList.toggle("disabled", !hasSelection);

    updateConnectionStatusText();

    menu.classList.add("show");
  }

  function hideMenu() {
    menu.classList.remove("show");
  }
  function hideSettings() {
    settings.classList.remove("show");
  }

  // 点击外部关闭菜单/设置
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== orb) hideMenu();
    if (
      !settings.contains(e.target) &&
      !menu.contains(e.target) &&
      e.target !== orb
    )
      hideSettings();
  });

  // 菜单项点击
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    const action = item.dataset.action;
    if (item.classList.contains("disabled")) return;

    hideMenu();

    switch (action) {
      case "send-page":
        sendPage();
        break;
      case "send-selection":
        sendSelection();
        break;
      case "send-with-message":
        showMessageDialog();
        break;
      case "toggle-auto":
        config.autoSend = !config.autoSend;
        saveConfig();
        setupAutoSend();
        showToast(`自动推送: ${config.autoSend ? "已开启" : "已关闭"}`, "info");
        break;
      case "settings":
        showSettingsPanel();
        break;
    }
  });

  // ============================================================
  // 设置面板逻辑
  // ============================================================
  function showSettingsPanel() {
    const orbRect = orb.getBoundingClientRect();
    settings.style.left =
      Math.max(0, Math.min(orbRect.right + 8, window.innerWidth - 320)) + "px";
    settings.style.top = Math.max(0, orbRect.top) + "px";

    document.getElementById("beilu-cfg-api").value = config.apiBase;
    document.getElementById("beilu-cfg-apikey").value = config.apiKey || "";
    document.getElementById("beilu-cfg-auto").checked = config.autoSend;
    document.getElementById("beilu-cfg-selection").checked =
      config.sendOnSelection;

    settings.classList.add("show");
  }

  settings.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "save") {
      config.apiBase =
        document.getElementById("beilu-cfg-api").value.trim() ||
        DEFAULT_CONFIG.apiBase;
      config.apiKey =
        document.getElementById("beilu-cfg-apikey").value.trim() || "";
      config.autoSend = document.getElementById("beilu-cfg-auto").checked;
      config.sendOnSelection = document.getElementById(
        "beilu-cfg-selection",
      ).checked;
      saveConfig();
      setupAutoSend();
      setupSelectionListener();
      checkConnection();
      hideSettings();
      showToast("设置已保存", "success");
    } else if (action === "cancel") {
      hideSettings();
    }
  });

  // ============================================================
  // 发送操作
  // ============================================================

  /**
   * 显示消息输入弹窗（发送并对话）
   */
  function showMessageDialog() {
    const pageInfo = document.getElementById("beilu-msg-page-info");
    if (pageInfo) {
      pageInfo.textContent = `📄 ${document.title} — ${window.location.href}`;
    }
    const input = document.getElementById("beilu-msg-input");
    if (input) {
      input.value = "";
    }
    msgDialog.classList.add("show");
    // 聚焦输入框
    setTimeout(() => input?.focus(), 100);
  }

  /**
   * 带消息发送页面（主动发送模式 — 前端自动发用户消息触发AI回复）
   * @param {string} message - 用户附带的消息
   */
  function sendPageWithMessage(message) {
    orb.classList.add("sending");
    orb.classList.remove("idle");
    showToast("正在发送页面+消息...", "info");

    const content = extractPageText();
    const url = window.location.href;
    const title = document.title;
    const selectedText = window.getSelection().toString().trim();

    const payload = {
      _action: "pushPage",
      url,
      title,
      content,
      selectedText: selectedText || "",
      message: message || "[查看网页]",
      timestamp: Date.now(),
    };

    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-API-Key"] = config.apiKey;

    GM_xmlhttpRequest({
      method: "POST",
      url: `${config.apiBase}/api/parts/plugins:beilu-browser/config/setdata`,
      headers: headers,
      data: JSON.stringify(payload),
      timeout: 5000,
      onload: function (response) {
        orb.classList.remove("sending");
        orb.classList.add("idle");
        if (response.status === 200) {
          isConnected = true;
          lastError = "";
          updateOrbStatus();
          showToast("✓ 页面+消息已发送给角色", "success");
          console.log(
            "[Beilu Browser] ✓ 页面+消息已发送:",
            title.substring(0, 40),
            "| msg:",
            (message || "").substring(0, 30),
          );
        } else {
          isConnected = false;
          lastError = `HTTP ${response.status}`;
          updateOrbStatus();
          showToast("✗ " + lastError, "error");
        }
      },
      onerror: function () {
        orb.classList.remove("sending");
        orb.classList.add("idle");
        isConnected = false;
        lastError = "连接失败";
        updateOrbStatus();
        showToast("✗ " + lastError, "error");
      },
      ontimeout: function () {
        orb.classList.remove("sending");
        orb.classList.add("idle");
        isConnected = false;
        lastError = "连接超时";
        updateOrbStatus();
        showToast("✗ " + lastError, "error");
      },
    });
  }

  function sendPage() {
    orb.classList.add("sending");
    orb.classList.remove("idle");
    showToast("正在发送页面...", "info");

    pushPageSnapshot(null, (ok, msg) => {
      orb.classList.remove("sending");
      orb.classList.add("idle");
      if (ok) {
        showToast("✓ 页面已发送给角色", "success");
      } else {
        showToast("✗ " + msg, "error");
      }
    });
  }

  function sendSelection() {
    const selection = window.getSelection().toString().trim();
    if (selection.length < 5) {
      showToast("请先选中一些文本", "info");
      return;
    }

    orb.classList.add("sending");
    orb.classList.remove("idle");
    showToast("正在发送选中文本...", "info");

    pushPageSnapshot(selection, (ok, msg) => {
      orb.classList.remove("sending");
      orb.classList.add("idle");
      if (ok) {
        showToast(`✓ 已发送 ${selection.length} 字符`, "success");
      } else {
        showToast("✗ " + msg, "error");
      }
    });
  }

  // ============================================================
  // 状态更新
  // ============================================================
  function updateOrbStatus() {
    orb.classList.toggle("connected", isConnected);
    orb.classList.toggle("disconnected", !isConnected);
    orb.title = isConnected
      ? "浏览器感知 (已连接)\n点击: 发送页面 | 长按/右键: 菜单"
      : `浏览器感知 (未连接: ${lastError})\n长按/右键: 打开设置`;
  }

  function updateConnectionStatusText() {
    const el = document.getElementById("beilu-connection-status");
    if (el) {
      el.textContent = isConnected
        ? "状态: ✓ 已连接"
        : `状态: ✗ ${lastError || "未连接"}`;
      el.style.color = isConnected ? "#66BB6A" : "#EF5350";
    }
  }

  // ============================================================
  // 自动推送
  // ============================================================
  let autoSendInterval = null;

  function setupAutoSend() {
    clearInterval(autoSendInterval);
    if (config.autoSend) {
      autoSendInterval = setInterval(
        () => pushPageSnapshot(),
        config.pushInterval,
      );
    }
  }

  // ============================================================
  // 选中文本自动发送
  // ============================================================
  let selectionListener = null;

  function setupSelectionListener() {
    if (selectionListener) {
      document.removeEventListener("mouseup", selectionListener);
      selectionListener = null;
    }
    if (config.sendOnSelection) {
      selectionListener = () => {
        const selection = window.getSelection().toString().trim();
        if (selection.length > 10) {
          pushPageSnapshot(selection);
        }
      };
      document.addEventListener("mouseup", selectionListener);
    }
  }

  // ============================================================
  // Tampermonkey 菜单命令
  // ============================================================
  GM_registerMenuCommand("📄 发送整个页面", sendPage, { accessKey: "p" });
  GM_registerMenuCommand("📝 发送选中文本", sendSelection, { accessKey: "s" });
  GM_registerMenuCommand("💬 发送并对话", showMessageDialog, {
    accessKey: "m",
  });
  GM_registerMenuCommand("⚙️ 打开设置", showSettingsPanel, { accessKey: "o" });
  GM_registerMenuCommand(
    `🔄 自动推送: ${config.autoSend ? "关闭" : "开启"}`,
    () => {
      config.autoSend = !config.autoSend;
      saveConfig();
      setupAutoSend();
      showToast(`自动推送: ${config.autoSend ? "已开启" : "已关闭"}`, "info");
    },
    { accessKey: "a" },
  );

  // ============================================================
  // 初始化
  // ============================================================
  checkConnection();
  setupAutoSend();
  setupSelectionListener();

  // 3 秒后首次推送
  setTimeout(() => pushPageSnapshot(), 3000);

  // 定期检查连接（60秒）
  setInterval(checkConnection, 60000);

  console.log(
    "[Beilu Browser Sense] 油猴脚本已加载 — 角色现在可以看到你浏览的页面了~",
  );
})();
