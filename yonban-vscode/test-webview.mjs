/**
 * test-webview.mjs — YonBan webview 独立测试
 * Mock acquireVsCodeApi + 加载 webview JS → Playwright 驱动点击验证
 *
 * 用法: cd YonBan && node test-webview.mjs [--headed]
 */

// [0731 收进本体] 本项目已迁入 beilu-always-accompany/yonban-vscode/，playwright 从本体根 node_modules 取
import { chromium } from "../node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes("--headed");
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(__dirname, "test-output", `yonban-test_${ts}`);
fs.mkdirSync(outDir, { recursive: true });

// 简易静态文件服务（serve webview-ui/ 和 CSS）
// T004：本端口仅本测试脚本自用的静态服务器（借用 DEFAULT_SANDBOX_WS_PORT 同值，非连接契约；mjs 无法 import src/constants.ts）
const PORT = 18931;
const server = http.createServer((req, res) => {
  let fp = path.join(__dirname, decodeURIComponent(req.url));
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end("404"); return; }
  const ext = path.extname(fp);
  const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" });
  res.end(fs.readFileSync(fp));
});

await new Promise(r => server.listen(PORT, r));
console.log(`静态服务: http://localhost:${PORT}`);

// 构建 standalone HTML（从 YonBanProvider.getHtmlContent 提取关键结构）
const cssContent = fs.readFileSync(path.join(__dirname, "webview-ui", "chat.css"), "utf-8");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${cssContent}</style>
  <style>
    body { background: #1e1e1e; color: #ccc; font-family: system-ui; margin: 0; }
    :root {
      --vscode-editor-background: #1e1e1e;
      --vscode-panel-border: #444;
      --vscode-input-background: #2d2d2d;
      --vscode-input-border: #555;
      --vscode-input-foreground: #ccc;
      --vscode-button-background: #0e639c;
      --vscode-button-foreground: #fff;
      --vscode-descriptionForeground: #888;
    }
  </style>
</head>
<body>
  <div id="viewChat" data-view="chat">
    <div class="view-header">
      <div class="view-header-left">
        <span id="chatTitle" class="view-title">YonBan Test</span>
        <span id="connDot" class="status-dot" style="width:6px;height:6px;margin-left:6px;display:none;"></span>
      </div>
      <div class="view-header-right">
        <span id="permBadge" class="perm-badge hidden"></span>
        <button id="btnDisplaySettings" class="icon-btn" title="显示设置">💭</button>
        <button id="btnSettings" class="icon-btn" title="设置">⚙</button>
      </div>
    </div>
    <div id="tokenBar" class="token-bar hidden"><div class="token-bar-inner"><div class="token-bar-track"><div id="tokenBarFill" class="token-bar-fill"></div></div><span id="tokenBarLabel" class="token-bar-label">—</span><button id="btnCompact" class="icon-btn token-compact-btn">🗜</button></div></div>
    <div id="memoryStatusBar" class="memory-status-bar hidden"><span id="memoryStatusText"></span></div>
    <div id="subModeBarContainer" class="sub-mode-bar hidden"><div id="subModeBar"></div></div>
    <div id="chatMessages" class="chat-messages"></div>
    <div class="input-area">
      <div class="input-wrapper">
        <textarea id="chatInput" placeholder="Enter message..." rows="1"></textarea>
      </div>
      <div class="input-actions">
        <button id="btnSend" class="btn btn-primary">发送</button>
      </div>
    </div>
  </div>
  <div id="viewSettings" data-view="settings" class="hidden">
    <div class="view-header"><div class="view-header-left"><span class="view-title">设置</span></div><div class="view-header-right"><button id="btnSettingsDone" class="btn btn-primary">完成</button></div></div>
    <div class="settings-body"><div class="settings-tabs"></div><div class="settings-content" id="settingsContent"></div></div>
  </div>

  <script>
    // Mock vscode API
    const _messages = [];
    window.acquireVsCodeApi = function() {
      return {
        postMessage: function(msg) {
          _messages.push(msg);
          console.log("[mock:postMessage]", JSON.stringify(msg));
          // 模拟后端响应
          if (msg.type === "getState") {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "initialState", payload: { connected: true, serverUrl: "http://localhost:1314" } } })), 100);
          }
          if (msg.type === "getThinkingTags") {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "thinkingTagsConfig", payload: { tags: ["thinking", "think"] } } })), 100);
          }
          if (msg.type === "updateReasoningConfig") {
            setTimeout(() => {
              window.dispatchEvent(new MessageEvent("message", { data: { type: "updateReasoningConfigResult", payload: { success: true } } }));
              window.dispatchEvent(new MessageEvent("message", { data: { type: "thinkingTagsConfig", payload: { tags: ["thinking", "think"] } } }));
            }, 200);
          }
          if (msg.type === "hideMessage") {
            setTimeout(() => {
              window.dispatchEvent(new MessageEvent("message", { data: { type: "actionNotify", payload: { action: "hideMessage", text: "已切换隐藏" } } }));
            }, 100);
          }
        },
        getState: function() { return {}; },
        setState: function() {},
      };
    };
    window._mockMessages = _messages;
  </script>
  <script src="http://localhost:${PORT}/webview-ui/chat-core.js"></script>
  <script src="http://localhost:${PORT}/webview-ui/chat-messages.js"></script>
  <script src="http://localhost:${PORT}/webview-ui/chat-modes.js"></script>
  <script src="http://localhost:${PORT}/webview-ui/chat-settings.js"></script>
  <script src="http://localhost:${PORT}/webview-ui/chat.js"></script>
</body>
</html>`;

let shotN = 0;
async function shot(page, label) {
  shotN++;
  const fp = path.join(outDir, `${String(shotN).padStart(2, "0")}_${label}.png`);
  await page.screenshot({ path: fp });
  console.log(`[shot] ${fp}`);
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 400, height: 700 } });

const errors = [];
page.on("console", msg => {
  const text = msg.text();
  if (msg.type() === "error" && !text.includes("mock")) errors.push(text.slice(0, 200));
  if (text.startsWith("[mock:postMessage]")) console.log("  " + text);
});
page.on("pageerror", e => errors.push("pageerror: " + e.message.slice(0, 200)));

try {
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 切到 chat 视图
  await page.evaluate(() => {
    document.getElementById("viewChat").classList.remove("hidden");
    document.getElementById("viewSettings").classList.add("hidden");
  });
  await page.waitForTimeout(300);

  // 注入模拟消息数据
  await page.evaluate(() => {
    if (!window.YB || !window.YB.state) return;
    window.YB.state.messages = [
      { id: "test-msg-1", role: "char", name: "测试助手", content: "<thinking>这是思维链内容</thinking>你好！", content_for_show: "<thinking>这是思维链内容</thinking>你好！", time_stamp: new Date().toISOString(), extension: {}, files: [] },
      { id: "test-msg-2", role: "user", name: "You", content: "你好", time_stamp: new Date().toISOString(), extension: {}, files: [] },
    ];
    window.YB.state.logOffset = 0;
    if (window.YB.renderAllMessages) window.YB.renderAllMessages();
  });
  await page.waitForTimeout(500);
  await shot(page, "initial_with_messages");

  // === Test 1: 💭 显示设置浮窗 ===
  console.log("\n=== Test 1: 💭 显示设置浮窗 ===");
  const dsBtn = page.locator("#btnDisplaySettings");
  if (await dsBtn.isVisible()) {
    await dsBtn.click();
    await page.waitForTimeout(500);
    await shot(page, "display_settings_popup");

    const popup = page.locator("#yb-display-settings");
    console.log(`  浮窗弹出: ${await popup.isVisible()}`);

    const thinkCheck = page.locator("#yb-ds-think");
    const thinkingCheck = page.locator("#yb-ds-thinking");
    console.log(`  <think> 勾选框: ${await thinkCheck.count() > 0}`);
    console.log(`  <thinking> 勾选框: ${await thinkingCheck.count() > 0}`);

    const saveBtn = page.locator("#yb-ds-save");
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
      await page.waitForTimeout(1500);
      const msgs = await page.evaluate(() => window._mockMessages);
      const updateMsg = msgs.find(m => m.type === "updateReasoningConfig");
      console.log(`  保存 postMessage 发出: ${!!updateMsg}`);
      if (updateMsg) console.log(`  payload: ${JSON.stringify({ builtin: updateMsg.builtin, tagsCount: updateMsg.tags?.length })}`);
    }
    await shot(page, "after_save");
  } else {
    console.log("  ❌ btnDisplaySettings 不可见");
  }

  // === Test 2: 消息行 hide 按钮 ===
  console.log("\n=== Test 2: 消息行 hide 按钮 ===");
  const msgRows = page.locator(".msg-row");
  const msgCount = await msgRows.count();
  console.log(`  消息行数: ${msgCount}`);

  if (msgCount > 0) {
    const firstRow = msgRows.first();
    await firstRow.hover();
    await page.waitForTimeout(300);

    // 找 hide 按钮（🔇）
    const hideBtn = firstRow.locator("button:has-text('🔇')");
    const hideBtnCount = await hideBtn.count();
    console.log(`  🔇 hide 按钮: ${hideBtnCount > 0 ? "存在" : "不存在"}`);

    if (hideBtnCount > 0) {
      await shot(page, "before_hide");
      await hideBtn.click();
      await page.waitForTimeout(500);
      await shot(page, "after_hide");

      const opacity = await firstRow.evaluate(el => el.style.opacity);
      const filter = await firstRow.evaluate(el => el.style.filter);
      console.log(`  hide 后 opacity: ${opacity}`);
      console.log(`  hide 后 filter: ${filter}`);

      const msgs = await page.evaluate(() => window._mockMessages);
      const hideMsg = msgs.find(m => m.type === "hideMessage");
      console.log(`  hideMessage postMessage: ${!!hideMsg}`);
      if (hideMsg) console.log(`  payload: ${JSON.stringify(hideMsg.payload)}`);

      // unhide
      const unhideBtn = firstRow.locator("button:has-text('👁')");
      if (await unhideBtn.count() > 0) {
        await unhideBtn.click();
        await page.waitForTimeout(500);
        await shot(page, "after_unhide");
        const opacityAfter = await firstRow.evaluate(el => el.style.opacity);
        console.log(`  unhide 后 opacity: ${opacityAfter || "(空=恢复)"}`);
      }
    }
  }

  // === 报告 ===
  console.log("\n=== 报告 ===");
  console.log(`截图: ${outDir}`);
  if (errors.length > 0) {
    console.log(`❌ JS 错误 (${errors.length}):`);
    errors.slice(0, 10).forEach(e => console.log(`  ${e}`));
  } else {
    console.log("✅ 无 JS 错误");
  }

} finally {
  await browser.close();
  server.close();
}
