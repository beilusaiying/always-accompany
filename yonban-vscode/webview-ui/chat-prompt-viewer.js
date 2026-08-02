/**
 * [chat-prompt-viewer] — 提示词构建请求查看器。映射 beilu-chat promptViewer 到 YonBan 侧边栏。
 * 不管提示词构建逻辑（那是 beilu 后端 getChatRequest 的事）。
 *
 * 链路：用户点"构建请求" → chat.js 发 buildPrompt → Extension → 后端构建 → postMessage("promptData")
 *       → chat.js 路由 → onPromptData → 渲染统计栏 + 消息列表（可折叠的 role/content/source/section）
 * 影响：操作 DOM(#promptViewerPanel / #pvStats / #pvMessageList)；写 state(promptViewerOpen / lastPromptData)
 * 相交：← chat.js(消息路由 + pvBuildBtn/pvCopyBtn 事件绑定)  → chat-core.js(dom/state/escapeHtml)
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — togglePromptViewer（面板显隐切换）
 *   — onPromptData（数据回调 + 错误处理）
 *   — renderPromptStats（统计栏：条数/预设/聊天/注入/token/模型）
 *   — renderPromptMessages（消息列表渲染：折叠式 accordion + role 颜色 + source/section 列 + token 估算）
 */
// =====================================================
// chat-prompt-viewer.js — 提示词查看器 (V2 两视图重构)
// 映射 beilu-chat 的 promptViewer 功能到 YonBan 侧边栏
// =====================================================

(function () {
  "use strict";
  try {
  var YB = window.YB;
  var dom = YB.dom;
  var state = YB.state;
  var escapeHtml = YB.escapeHtml;

  // ═══════════════════════════════════════════════════════
  // 面板切换
  // ═══════════════════════════════════════════════════════

  function togglePromptViewer() {
    state.promptViewerOpen = !state.promptViewerOpen;
    if (dom.promptViewerPanel) {
      dom.promptViewerPanel.classList.toggle("hidden", !state.promptViewerOpen);
    }
    if (dom.btnPromptViewer) {
      dom.btnPromptViewer.classList.toggle("active", state.promptViewerOpen);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 数据处理
  // ═══════════════════════════════════════════════════════

  function onPromptData(payload) {
    // 恢复按钮状态
    if (dom.pvBuildBtn) {
      dom.pvBuildBtn.disabled = false;
      dom.pvBuildBtn.textContent = "🚀 构建请求";
    }
    if (payload && payload.error) {
      if (dom.pvStats) dom.pvStats.classList.add("hidden");
      if (dom.pvMessageList) {
        dom.pvMessageList.innerHTML =
          '<div style="color:var(--vscode-errorForeground);padding:8px;font-size:12px;">❌ ' +
          escapeHtml(payload.error) +
          "</div>";
      }
      return;
    }
    state.lastPromptData = payload;
    renderPromptStats(payload);
    renderPromptMessages(payload.messages || []);
  }

  // ═══════════════════════════════════════════════════════
  // 统计栏
  // ═══════════════════════════════════════════════════════

  function renderPromptStats(result) {
    var el = dom.pvStats;
    if (!el) return;
    el.classList.remove("hidden");
    var msgs = result.messages || [];
    var meta = result._meta || {};
    var totalChars =
      meta.total_chars != null
        ? meta.total_chars
        : msgs.reduce(function (sum, m) {
            return sum + ((m.content && m.content.length) || 0);
          }, 0);
    var tokens = meta.estimated_tokens || Math.round(totalChars / 3.5);
    var model = meta.commander_mode
      ? "🎖️ 司令员"
      : result.model || meta.model || "-";

    var parts = [msgs.length + " 条"];
    if (meta.preset_entry_count != null) {
      parts.push("预设" + meta.preset_entry_count);
    }
    if (meta.chat_message_count != null) {
      parts.push("聊天" + meta.chat_message_count);
    }
    if (meta.injection_count != null) {
      parts.push("注入" + meta.injection_count);
    }

    el.textContent =
      parts.join(" · ") +
      " · " +
      totalChars.toLocaleString() +
      " 字符 · ≈" +
      tokens.toLocaleString() +
      " tok · " +
      model;
  }

  // ═══════════════════════════════════════════════════════
  // 消息列表渲染
  // ═══════════════════════════════════════════════════════

  function renderPromptMessages(messages) {
    var list = dom.pvMessageList;
    if (!list) return;
    list.innerHTML = "";

    if (!messages.length) {
      list.innerHTML =
        '<div style="text-align:center;color:var(--vscode-descriptionForeground);font-size:11px;padding:16px;">没有消息</div>';
      return;
    }

    var hasSource = messages.some(function (m) {
      return m._source;
    });
    var hasSections = messages.some(function (m) {
      return m._section;
    });
    var currentSection = null;

    var sectionLabels = {
      beforeChat: "── ▼ 头部预设 ▼ ──",
      injectionAbove: "── ▼ 注入上方 (@D≥1) ▼ ──",
      chatHistory: "── ▼ 聊天记录 ▼ ──",
      injectionBelow: "── ▼ 注入下方 (@D=0) ▼ ──",
      afterChat: "── ▼ 尾部预设 ▼ ──",
      before: "── ▼ 预设(头) ▼ ──",
      chat: "── ▼ 聊天记录 ▼ ──",
      after: "── ▼ 预设(尾) ▼ ──",
    };

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];

      // section 分隔线
      if (hasSections && msg._section && msg._section !== currentSection) {
        var divider = document.createElement("div");
        divider.style.cssText =
          "text-align:center;font-size:10px;color:var(--vscode-descriptionForeground);" +
          "padding:4px 0;border-top:1px solid var(--vscode-panel-border);margin-top:4px;";
        divider.textContent =
          sectionLabels[msg._section] ||
          "── ▼ " + msg._section + " ▼ ──";
        list.appendChild(divider);
        currentSection = msg._section;
      }

      var card = document.createElement("div");
      card.style.cssText =
        "border:1px solid var(--vscode-panel-border);border-radius:4px;margin:2px 0;font-size:11px;";

      if (msg._is_marker) {
        card.style.opacity = "0.5";
      }

      var role = msg.role || "unknown";
      var content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content || "");
      var preview = content.substring(0, 60).replace(/\n/g, " ");
      var chars = content.length;

      var roleColors = {
        system: "var(--vscode-charts-purple, #7c3aed)",
        user: "var(--vscode-charts-blue, #2563eb)",
        assistant: "var(--vscode-charts-green, #059669)",
      };
      var roleColor = roleColors[role] || "var(--vscode-descriptionForeground, #6b7280)";

      var sourceIcon = "";
      if (hasSource) {
        var s = msg._source || "";
        var sec = msg._section || "";
        if (s === "preset") {
          if (msg._is_marker) sourceIcon = "📌";
          else if (sec === "afterChat" || sec === "after")
            sourceIcon = "📋尾";
          else sourceIcon = "📋";
        } else if (s === "injection") {
          if (sec === "injectionAbove") sourceIcon = "💉↑";
          else if (sec === "injectionBelow") sourceIcon = "💉↓";
          else sourceIcon = "💉";
        } else if (s === "chat_log") {
          sourceIcon = "💬";
        }
      }

      var identTag = msg._identifier
        ? ' <span style="background:#374151;color:#d1d5db;padding:0 3px;border-radius:2px;font-size:10px;">' +
          escapeHtml(msg._identifier) +
          "</span>"
        : "";

      var nameTag = msg.name
        ? ' <span style="color:#9ca3af;font-size:10px;">' +
          escapeHtml(msg.name) +
          "</span>"
        : "";

      var hdr = document.createElement("div");
      hdr.style.cssText =
        "display:flex;align-items:center;gap:4px;padding:3px 6px;cursor:pointer;";
      hdr.innerHTML =
        '<span style="color:' +
        roleColor +
        ';font-weight:600;min-width:18px;">#' +
        (i + 1) +
        "</span>" +
        '<span style="background:' +
        roleColor +
        ';color:#fff;padding:0 4px;border-radius:3px;font-size:10px;text-transform:uppercase;">' +
        escapeHtml(role) +
        "</span>" +
        (sourceIcon
          ? '<span style="font-size:10px;">' + sourceIcon + "</span>"
          : "") +
        nameTag +
        identTag +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);">' +
        escapeHtml(preview) +
        (chars > 60 ? "…" : "") +
        "</span>" +
        '<span style="color:var(--vscode-descriptionForeground);font-size:10px;white-space:nowrap;">' +
        chars.toLocaleString() +
        "</span>" +
        '<span class="pv-chevron" style="font-size:10px;transition:transform 0.2s;">▶</span>';

      card.appendChild(hdr);

      var body = document.createElement("div");
      body.style.cssText =
        "display:none;padding:4px 6px;white-space:pre-wrap;word-break:break-all;" +
        "max-height:200px;overflow-y:auto;border-top:1px solid var(--vscode-panel-border);" +
        "font-size:11px;font-family:var(--vscode-editor-font-family);";
      body.textContent = content;
      card.appendChild(body);

      (function (capturedHdr, capturedBody) {
        capturedHdr.addEventListener("click", function () {
          var open = capturedBody.style.display !== "none";
          capturedBody.style.display = open ? "none" : "block";
          var chevron = capturedHdr.querySelector(".pv-chevron");
          if (chevron) {
            chevron.style.transform = open ? "" : "rotate(90deg)";
          }
        });
      })(hdr, body);

      list.appendChild(card);
    }
  }

  // ── 导出到 YB ─────────────────────────────────────
  YB.togglePromptViewer = togglePromptViewer;
  YB.onPromptData = onPromptData;
  } catch(e) { try { window.YB.showToast("\uD83D\uDEA8 chat-prompt-viewer 加载失败: " + e.message, 8000); } catch(_) {} console.error("[chat-prompt-viewer] 加载失败:", e); }
})();
