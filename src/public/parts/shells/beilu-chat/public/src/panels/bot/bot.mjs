/**
 * bot.mjs — Bot 模式活动栏与平台切换 cluster
 *
 * 功能链：切换到 Bot Tab → initBotActivityBar() 绑定 BCSLO 功能按钮（Bot列表/Cards/设置/日志/运维）
 *   → 动态渲染各平台 Tab（Discord/Telegram/Slack/飞书等 BOT_PLATFORM_META 驱动）
 *   → 平台切换时 _switchBotPlatform() 更新 localStorage + 刷新 sidebar 内容
 *   → 30s 轮询 getrunningbotlist 接口维护「运行中」绿色角标
 * why：Bot 管理页需要独立的平台选择器和多功能活动栏，从 layout.mjs 抽出避免单文件过大，
 *   平台元数据集中在此管理方便扩展新平台
 * 关联链：被 layout.mjs import（initBotActivityBar 在 initLayout 时调用）；
 *   import botSidePanels.mjs（渲染各功能侧面板）、core.mjs（侧栏拖宽）、api-client.mjs（运行状态轮询）
 * 影响范围：改动影响 Bot Tab 下的平台切换、侧栏面板渲染、Bot 运行状态角标显示
 * 使用效果：用户点击 Bot Tab 后看到平台列表和 BCSLO 功能栏，切换平台时侧栏内容随之更新，
 *   有 Bot 运行中时「B」按钮出现绿色小圆点
 */
import { renderBotSidePanel, stopBotLogPanel } from "./botSidePanels.mjs";
import { getCurrentCharId } from "../airp/utils.mjs"; // 0716 收口：charId 单源（读共享 charList[0]）。原 DOM textContent 读显示名=P4c 判过的病形状（显示名≠part 名，占位文案会被当 charId）
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（动态壳名/server list 走专用路由）
import { initSidebarResize, layoutState, saveState } from "../../shared/layout/core.mjs"; // botActivePanel 面板记忆（凛倾07-11「侧栏没有记录上次操作」）
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { createVisibilityPoller } from "../../shared/state/windowRuntime.mjs"; // [0808 机制] 前台/后台刷新分级单源

// ============================================================
// Bot模式活动栏
// ============================================================

// 各平台的占位文案 + 参考链接
const BOT_PLATFORM_META = {
  // icon 现为 '<i data-ic="...">'：双消费点（L123 tab innerHTML / L144 header）均已改 innerHTML，
  // botSidePanels _curPlatformLabel 改从 PLATFORM_SCHEMA 单源取图标（不再读本元素 textContent）
  discord: { icon: '<i data-ic="discord"></i>', name: "Discord", ref: null },
  telegram: { icon: '<i data-ic="telegram"></i>', name: "Telegram", ref: "https://github.com/beilusaiying/always-accompany/tree/master/src/public/parts/shells/telegrambot" },
  slack: { icon: '<i data-ic="slack"></i>', name: "Slack", ref: "https://github.com/RockChinQ/LangBot/blob/master/pkg/platform/sources/slack.py" },
  line: { icon: '<i data-ic="line"></i>', name: "LINE", ref: "https://github.com/RockChinQ/LangBot/blob/master/pkg/platform/sources/line.py" },
  x: { icon: '<i data-ic="x-twitter"></i>', name: "X (Twitter)", ref: "https://www.npmjs.com/package/twitter-api-v2" },
  lark: { icon: '<i data-ic="lark"></i>', name: "飞书", ref: "https://github.com/RockChinQ/LangBot/blob/master/pkg/platform/sources/lark.py" },
  dingtalk: { icon: '<i data-ic="dingtalk"></i>', name: "钉钉", ref: "https://github.com/RockChinQ/LangBot/blob/master/pkg/platform/sources/dingtalk.py" },
  wecom: { icon: '<i data-ic="wecom"></i>', name: "企业微信", ref: "https://github.com/RockChinQ/LangBot/blob/master/pkg/platform/sources/wecom.py" },
  wechat: { icon: '<i data-ic="wechat"></i>', name: "微信", ref: "https://github.com/RockChinQ/LangBot/blob/master/pkg/platform/sources/wechatpad.py" },
};

let _currentBotPlatform = "discord";

function initBotActivityBar() {
  const bar = document.getElementById("bot-activity-bar");
  if (!bar) return;

  // 界面7（拍板#8）：活动栏=BCSLO 功能切换；平台=[B]列表内动态 Tab
  bar.querySelectorAll("[data-bot-panel]").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.botPanel;
      bar.querySelectorAll("[data-bot-panel]").forEach(b => b.classList.remove("ide-activity-active"));
      btn.classList.add("ide-activity-active");
      document.querySelectorAll(".bot-side-panel").forEach(p => p.classList.add("hidden"));
      const target = document.getElementById(`bot-side-${panel}`);
      if (target) target.classList.remove("hidden");
      if (panel !== "log") stopBotLogPanel();
      renderBotSidePanel(panel);
      layoutState.botActivePanel = panel;
      saveState();
    });
  });

  // 恢复上次活跃面板（layoutState.botActivePanel）：懒到首次进入 bot tab 才恢复——
  // initLayout 期就 click 会对隐藏 tab 空拉后端数据（renderBotSidePanel 有请求链）。
  // "list"=index.html 静态默认已可见，无需动作。
  let _botPanelRestored = false;
  window.addEventListener("beilu:tab-activated", (e) => {
    if (e.detail !== "bot" || _botPanelRestored) return;
    _botPanelRestored = true;
    const saved = layoutState.botActivePanel;
    if (saved && saved !== "list") bar.querySelector(`[data-bot-panel="${saved}"]`)?.click();
  });

  // 平台 Tab 动态渲染（BOT_PLATFORM_META 驱动，Bot MD「左栏平台Tab的动态加载」）
  _renderBotPlatformTabs();

  // FT-D10(凛倾批「做」): bot [B] 运行中🟢角标——getrunningbotlist 真数据；
  //   仅 bot tab 可见时轮询（30s）。[O]错误🔴角标暂无后端事件源,等后端（不做假角标）
  {
    const listBtn = bar.querySelector('[data-bot-panel="list"]');
    if (listBtn && !listBtn.querySelector(".bot-run-badge")) {
      listBtn.style.position = "relative";
      const dot = document.createElement("span");
      dot.className = "bot-run-badge hidden";
      dot.style.cssText = "position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;background:var(--beilu-success);";
      dot.title = "有 Bot 运行中";
      listBtn.appendChild(dot);
    }
    const _botTabVisible = () => {
      const tabBot = document.getElementById("center-tab-bot");
      return !!(tabBot && !tabBot.classList.contains("hidden"));
    };
    const refreshRunBadge = async () => {
      if (!_botTabVisible()) return; // 分段级二次防线（调度层已按可见性暂停，此处兜信号间隙）
      try {
        const { platformToShell } = await import("./discordBotPanel.mjs");
        const shell = platformToShell(storage.get(KEYS.BEILU_BOT_PLATFORM) || "discord");
        // 原 raw GET + r.ok 手检；复用分身S 已注册的动态壳名路由 shells:_bot#getRunningBotList（payload._shell 携带真实壳名），!ok 由门面抛错走 catch（失败保持角标隐藏）
        const running = await sendAction({ verb: "getRunningBotList", target: "shells:_bot", source: "web", payload: { _shell: shell } }) || [];
        const dot = bar.querySelector(".bot-run-badge");
        if (dot) dot.classList.toggle("hidden", !(Array.isArray(running) && running.length > 0));
      } catch { /* 后端未启动时保持隐藏 */ }
    };
    // [0808 windowRuntime 机制] 30s 角标轮询接可见性生命周期（原裸 setInterval 无 clearInterval、
    //   隐藏时空转——治理清单 循环08 BUG 类；start 内含首拉，原手动 refreshRunBadge() 删除防双拉）
    createVisibilityPoller({ tick: refreshRunBadge, intervalMs: 30000, visible: _botTabVisible, label: "botRunBadge" }).start();
  }

  // 初始化侧边栏拖拽
  const botSidebar = document.getElementById("bot-sidebar");
  const botResizeHandle = botSidebar?.querySelector(".ide-sidebar-resize");
  initSidebarResize(botSidebar, botResizeHandle, "botSidebarWidth");

  // 监听角色卡切换 → 更新 bot-current-charname 显示
  window.addEventListener("beilu:char-changed", () => _refreshBotCurrentCharname());
  // Bot 被选中 → sidebar header 显示该 Bot 绑定的角色
  window.addEventListener("beilu:bot-selected", (e) => {
    const el = document.getElementById("bot-current-charname");
    if (!el) return;
    const charname = e?.detail?.charname;
    if (charname) el.textContent = `${charname}`;
    else el.textContent = "(未绑定)";
  });
  _refreshBotCurrentCharname();

  // 从 localStorage 恢复上次选中的平台
  try {
    const saved = storage.get(KEYS.BEILU_BOT_PLATFORM);
    if (saved && saved !== "discord" && BOT_PLATFORM_META[saved]) {
      _switchBotPlatform(saved);
      _refreshBotPlatformTabActive(saved);
    }
  } catch { /* ignore */ }
}

// 界面7: [B]列表内平台 Tab 横排（动态渲染，新平台只需加 BOT_PLATFORM_META 条目）
function _renderBotPlatformTabs() {
  const host = document.getElementById("bot-platform-tabs");
  if (!host) return;
  host.innerHTML = Object.entries(BOT_PLATFORM_META).map(([key, m]) =>
    `<button class="bot-func-tab py-0.5 px-1.5 border rounded ${key === _currentBotPlatform ? "bot-func-tab-active" : ""}"
      data-bot-platform="${key}" title="${m.name}">${m.icon} ${m.name}</button>`).join("");
  host.querySelectorAll("[data-bot-platform]").forEach(btn => {
    btn.addEventListener("click", () => {
      const platform = btn.dataset.botPlatform;
      _switchBotPlatform(platform);
      _refreshBotPlatformTabActive(platform);
    });
  });
}

function _refreshBotPlatformTabActive(platform) {
  document.querySelectorAll("#bot-platform-tabs [data-bot-platform]").forEach(b =>
    b.classList.toggle("bot-func-tab-active", b.dataset.botPlatform === platform));
}

function _switchBotPlatform(platform) {
  _currentBotPlatform = platform;
  const meta = BOT_PLATFORM_META[platform] || { icon: '<i data-ic="bot"></i>', name: platform, ref: null };
  // 更新头部显示
  const iconEl = document.getElementById("bot-current-platform-icon");
  const nameEl = document.getElementById("bot-current-platform-name");
  // meta.icon 现为 '<i data-ic="...">'（内部常量无用户数据）：textContent→innerHTML 渲染真图标
  if (iconEl) iconEl.innerHTML = meta.icon;
  if (nameEl) nameEl.textContent = meta.name;

  // C5：10 平台后端已同构（C6 已为 10 壳加 config/触发/权限字段），共用同一面板容器；stub 已删（界面8 死码清理）
  const discordContainer = document.getElementById("bot-platform-discord");
  if (discordContainer) discordContainer.classList.remove("hidden");

  // 切平台 → 重新初始化 Bot 面板，绑定该平台的壳端点 + 渲染该平台连接字段。
  import("./discordBotPanel.mjs").then(m => {
    m.initDiscordBotPanel?.({
      platform,
      showToast: window._beiluToast || ((...a) => console.log("[toast]", ...a)),
      getCurrentCharId, // 0716 收口：权威 charList 单源（原 DOM 读 header-char-name-text 显示名，与 charSelect.value 的 part 名域不一致）
      // getPartList(type) → /api/getlist/<type>（与 index.mjs 主 init 同源，需尊重 type 参数取 chars）
      getPartList: async (type) => { try { return await sendAction({ verb: "getList", target: "server:list", source: "web", payload: { type } }) || []; } catch { return []; } },
    });
  }).catch(e => console.warn("[layout] 切平台重载 Bot 面板失败:", e));

  _refreshBotCurrentCharname();
  try { storage.set(KEYS.BEILU_BOT_PLATFORM, platform); } catch {}

  // 界面7: 切平台后当前打开的功能面板（config/security/log/monitor）随平台重渲染，不残留旧平台数据
  const activePanel = document.querySelector("#bot-activity-bar .ide-activity-active")?.dataset?.botPanel;
  if (activePanel && activePanel !== "list") renderBotSidePanel(activePanel);
}

function _refreshBotCurrentCharname() {
  const el = document.getElementById("bot-current-charname");
  if (!el) return;
  // 从顶部 char-name-display 读当前角色
  const charEl = document.getElementById("char-name-display");
  const charName = charEl?.textContent?.trim() || charEl?.dataset?.charId || "";
  el.textContent = charName ? charName : "(未绑定)";
}

export { initBotActivityBar };
