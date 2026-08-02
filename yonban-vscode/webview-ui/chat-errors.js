/**
 * [chat-errors] — 错误中心（webview 反馈系统的持久面）。不管瞬时提示（那是 chat-core showToast 的事）。
 *
 * why：toast 是 2 秒即逝的单例，错误闪过就没了；宿主 services 层的 console.error 用户彻底看不见
 *      （webview 无 F12）。本模块给错误一个「留得住、看得到、可复制」的出口——对齐 beilu 主前端
 *      backendMonitor.mjs 的 _errors 环形缓冲 + 未读角标 +「在看=已读」语义（参照优先于发明）。
 *
 * 链路（三路 producer → 一个 consumer 面板）：
 *   ① 宿主：ConsoleCapture 拦截 extension host 全部 console → extension.ts setOnEntry 过滤 warn/error
 *      → postMessage("hostError") 实时推 / getHostErrors→hostErrorBacklog 积压补拉 → 本模块入环
 *   ② webview console：本模块拦截 console.error/warn（原样透传原始输出）→ 入环
 *   ③ 显式上报：YB.reportError（chat.js 全局 onerror/unhandledrejection/回包 error 字段/路由 catch 调用）
 * 影响：monkey-patch webview console.error/warn；写 #errBadge/#errBadgeCount/#errCenterList DOM
 * 相交：← chat-core.js(YB 命名空间/showFloatingPopup/escapeHtml)  ← chat.js(路由 hostError/hostErrorBacklog + 全局错误接入)
 *       ← extension.ts/YonBanProvider.ts(宿主错误通道)  → 无下游（叶节点）
 *
 * 分级语义（对齐 beilu sendAction.mjs notify 三档中的 toast/report 两档）：
 *   YB.reportError = 只进错误中心（后台轮询/读路失败，防 toast 刷屏）
 *   YB.notifyError = toast + 错误中心（用户触发的写路失败，既要即时可见又要留档）
 */
(function () {
  "use strict";
  try {
    var YB = window.YB;
    var vscode = YB.vscode;

    // 环形缓冲上限（constants.ts ERROR_CENTER_MAX 等值镜像——webview 无法 import TS 常量，
    // 与 beilu backendMonitor _errors 上限同值）
    var MAX_ERRORS = 50;
    /** @type {Array<{ts:number, time:string, source:string, level:string, text:string}>} */
    var _errors = [];
    var _unread = 0;
    var _inPush = false; // 防递归：入环/渲染过程自身出错时不再回环上报

    function _now() {
      var d = new Date();
      function p(n) { return String(n).padStart(2, "0"); }
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    function _isOpen() {
      var pop = document.getElementById("errorCenterPopup");
      return !!(pop && !pop.classList.contains("hidden"));
    }

    /** 入环 + 角标/面板刷新（唯一写点） */
    function _push(source, level, text, time) {
      if (_inPush) return;
      _inPush = true;
      try {
        _errors.push({
          ts: Date.now(),
          time: time || _now(),
          source: source || "",
          level: level === "warn" ? "warn" : "error",
          text: String(text == null ? "" : text).substring(0, 1000),
        });
        if (_errors.length > MAX_ERRORS) _errors.splice(0, _errors.length - MAX_ERRORS);
        if (_isOpen()) {
          _renderList(); // 在看=已读，不加未读
        } else {
          _unread++;
          _renderBadge();
        }
      } catch (_) { /* 反馈系统自身失败不得影响业务 */ }
      _inPush = false;
    }

    function _renderBadge() {
      var badge = document.getElementById("errBadge");
      var count = document.getElementById("errBadgeCount");
      if (!badge) return;
      if (_unread > 0) {
        badge.classList.remove("hidden");
        if (count) count.textContent = _unread > 99 ? "99+" : String(_unread);
      } else {
        // 有历史但已读：角标保留入口但不显数字；零历史彻底隐藏
        if (count) count.textContent = "";
        badge.classList.toggle("hidden", _errors.length === 0);
      }
    }

    function _renderList() {
      var list = document.getElementById("errCenterList");
      if (!list) return;
      if (_errors.length === 0) {
        list.innerHTML = '<div class="err-center-empty">暂无错误</div>';
        return;
      }
      var esc = YB.escapeHtml; // 转义单源（chat-core 必先加载）
      var html = "";
      // 新的在上
      for (var i = _errors.length - 1; i >= 0; i--) {
        var e = _errors[i];
        html += '<div class="err-item err-' + e.level + '">' +
          '<div class="err-item-head">' +
            '<span class="err-item-level">' + (e.level === "warn" ? "⚠" : "✗") + '</span>' +
            '<span class="err-item-source">' + esc(e.source) + '</span>' +
            '<span class="err-item-time">' + esc(e.time) + '</span>' +
          '</div>' +
          '<div class="err-item-text">' + esc(e.text) + '</div>' +
        '</div>';
      }
      list.innerHTML = html;
    }

    function _openCenter() {
      _unread = 0;
      _renderBadge();
      _renderList();
      YB.showFloatingPopup("errorCenterPopup");
    }

    // ── ② webview console 拦截（webview 无 F12，console.error/warn 原本进黑洞）──
    // 调原始方法再入环（与宿主 ConsoleCapture 同款不递归结构）
    var _origError = console.error.bind(console);
    var _origWarn = console.warn.bind(console);
    function _joinArgs(args) {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (typeof a === "string") { parts.push(a); continue; }
        if (a instanceof Error) { parts.push(a.message); continue; }
        try { parts.push(JSON.stringify(a)); } catch (_) { parts.push(String(a)); }
      }
      return parts.join(" ");
    }
    console.error = function () {
      _origError.apply(null, arguments);
      _push("界面", "error", _joinArgs(arguments));
    };
    console.warn = function () {
      _origWarn.apply(null, arguments);
      _push("界面", "warn", _joinArgs(arguments));
    };

    // ── ① 宿主错误通道 handler（chat.js 路由调用）──
    function onHostError(entry) {
      if (!entry) return;
      _push("宿主" + (entry.source ? " " + entry.source : ""), entry.level, entry.text, entry.time);
    }
    function onHostErrorBacklog(payload) {
      var entries = (payload && payload.entries) || [];
      for (var i = 0; i < entries.length; i++) onHostError(entries[i]);
    }

    // ── ③ 显式上报 ──
    /** report 档：只进错误中心（后台/读路失败用，防 toast 刷屏） */
    function reportError(label, detail, source) {
      _push(source || "上报", "error", detail ? label + ": " + detail : label);
    }
    /** toast 档：toast + 错误中心（用户触发的写路失败用） */
    function notifyError(label, detail) {
      reportError(label, detail);
      try { YB.showToast("✗ " + label, 3000); } catch (_) { /* toast 失败不阻断留档 */ }
    }

    // ── UI 事件绑定 ──
    var badge = document.getElementById("errBadge");
    if (badge) badge.addEventListener("click", _openCenter);
    var clearBtn = document.getElementById("errCenterClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      _errors = [];
      _unread = 0;
      _renderBadge();
      _renderList();
    });
    var copyBtn = document.getElementById("errCenterCopyBtn");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      var text = _errors.map(function (e) {
        return "[" + e.time + "][" + e.source + "][" + e.level + "] " + e.text;
      }).join("\n");
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = "✓";
        setTimeout(function () { copyBtn.textContent = "复制"; }, 1500);
      }).catch(function () {
        copyBtn.textContent = "✗";
        setTimeout(function () { copyBtn.textContent = "复制"; }, 1500);
      });
    });

    // ── 初始化：补拉宿主积压（webview 建立前的宿主 warn/error）──
    vscode.postMessage({ type: "getHostErrors" });

    // ── 导出到 YB ──
    YB.reportError = reportError;
    YB.notifyError = notifyError;
    YB.onHostError = onHostError;
    YB.onHostErrorBacklog = onHostErrorBacklog;
    YB.getErrors = function () { return _errors.slice(); };
  } catch (e) {
    try { window.YB.showToast("\uD83D\uDEA8 chat-errors 加载失败: " + e.message, 8000); } catch (_) {}
    // 本模块可能已包装 console.error 失败，直接用原生
    try { console.log("[chat-errors] 加载失败:", e); } catch (_) {}
  }
})();
