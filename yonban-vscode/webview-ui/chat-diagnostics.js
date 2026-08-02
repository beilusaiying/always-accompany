/**
 * [chat-diagnostics] — 连接诊断结果渲染（纯展示，无数据获取逻辑）。
 * 不管诊断数据采集（那是 Extension ConnectionService 的事）。
 *
 * 链路：用户点"运行诊断" → chat.js 发 getConnectionDiag → Extension 采集 4 项检测
 *       → postMessage("connectionDiag") → chat.js 路由 → onConnectionDiag → DOM 渲染
 * 影响：写 dom.diagResults.innerHTML（4 项检测结果：HTTP/认证/IDE WS/聊天 WS）
 * 相交：← chat.js(消息路由)  → chat-core.js(dom.diagResults / escapeHtml)
 */
// =====================================================
// chat-diagnostics.js — 连接诊断器
// 检测 HTTP/认证/WS/聊天WS 各项连接状态
// =====================================================

(function () {
  "use strict";
  try {
  const { dom, escapeHtml } = window.YB;

  // ═══════════════════════════════════════════════════════
  // 诊断结果渲染
  // ═══════════════════════════════════════════════════════

  function onConnectionDiag(payload) {
    const el = dom.diagResults;
    if (!el) return;

    const checks = [
      {
        label: "HTTP 后端",
        ok: payload.http?.status === "connected",
        detail: payload.http?.serverUrl || "-",
      },
      {
        label: "用户认证",
        ok: payload.auth?.authenticated,
        detail: payload.auth?.username || "未登录",
      },
      {
        label: "IDE WS 服务器",
        ok: payload.wsServer?.running,
        detail:
          "端口 " +
          (payload.wsServer?.port || "-") +
          " · " +
          (payload.wsServer?.clients || 0) +
          " 个客户端",
      },
      {
        label: "聊天 WS",
        ok: payload.chatWs?.connected,
        detail: payload.chatWs?.chatId
          ? "聊天 " + payload.chatWs.chatId.slice(0, 8) + "…"
          : "未连接到聊天",
      },
    ];

    el.innerHTML = checks
      .map((c) => {
        const icon = c.ok ? "✓" : "✗";
        const color = c.ok ? "var(--vscode-testing-iconPassed)" : "var(--vscode-errorForeground)";
        return (
          '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;">' +
          "<span>" +
          icon +
          "</span>" +
          '<span style="flex:1;">' +
          escapeHtml(c.label) +
          "</span>" +
          '<span style="color:' +
          color +
          ';font-size:10px;">' +
          escapeHtml(c.detail) +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  // ── 导出到 YB ─────────────────────────────────────
  YB.onConnectionDiag = onConnectionDiag;
  } catch(e) { try { window.YB.showToast("\uD83D\uDEA8 chat-diagnostics 加载失败: " + e.message, 8000); } catch(_) {} console.error("[chat-diagnostics] 加载失败:", e); }
})();
