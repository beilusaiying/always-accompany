/**
 * @file subtabs.mjs — 助手 / Bot 子选项卡切换 cluster
 *
 * 【功能链】
 *   initHelperSubTabs（纯 DOM：绑定 .helper-sub-tab 点击事件
 *       → 切换 helper-sub-tab-active 高亮 → 切换 .helper-panel 显隐）
 *   → initBotSubTabs（初始化 Discord Bot 面板：
 *       调用 initDiscordBotPanel，注入 showToast / getCurrentCharId / getPartList 依赖）
 *
 * 【why】
 *   助手面板包含多个子 tab（正则管理器、变量管理器等），需要统一的 tab 切换逻辑；
 *   Bot 面板目前简化为仅 Discord，initBotSubTabs 作为唯一入口封装依赖注入，
 *   避免 discordBotPanel.mjs 直接依赖 utils.mjs / parts.mjs（保持 bot 模块可测试性）。
 *
 * 【关联链】
 *   上游：index.mjs（调用 initHelperSubTabs + initBotSubTabs）
 *   同层依赖：utils.mjs（showToast / getCurrentCharId）
 *   核心依赖：scripts/parts.mjs（getPartList 获取 bot 列表）、
 *             panels/bot/discordBotPanel.mjs（Discord Bot 面板逻辑）
 *
 * 【影响范围】
 *   助手面板子 tab 切换 UI（helper-sub-tab / helper-panel DOM）；
 *   Discord Bot 面板初始化（包含 Bot 配置表单和操作按钮）。
 *
 * 【使用效果】
 *   import { initHelperSubTabs, initBotSubTabs } from "./subtabs.mjs"
 *   初始化后助手面板 tab 切换立即可用；Discord Bot 面板完成配置注入并渲染。
 */
import { showToast, getCurrentCharId } from "./utils.mjs";
import { getPartList } from "../../../../../../scripts/parts.mjs";
import { initDiscordBotPanel } from "../bot/discordBotPanel.mjs";

// ============================================================
// 助手子选项卡切换（正则 / 变量管理器）
// ============================================================

function initHelperSubTabs() {
  const tabs = document.querySelectorAll(".helper-sub-tab");
  if (tabs.length === 0) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.dataset.helperTab;
      if (!targetTab) return;

      // 更新 tab 高亮
      tabs.forEach((t) =>
        t.classList.toggle(
          "helper-sub-tab-active",
          t.dataset.helperTab === targetTab,
        ),
      );

      // 切换面板
      document.querySelectorAll(".helper-panel").forEach((panel) => {
        panel.style.display =
          panel.id === `helper-panel-${targetTab}` ? "" : "none";
      });
    });
  });
}
// ============================================================
// Bot 面板初始化（仅 Discord）
// ============================================================

function initBotSubTabs() {
  // 初始化 Discord Bot 面板（Bot tab 已简化为仅 Discord）
  try {
    initDiscordBotPanel({ showToast, getCurrentCharId, getPartList });
  } catch (e) {
    console.warn("[beilu-chat] initDiscordBotPanel 失败（非致命）:", e.message);
  }
}

export { initHelperSubTabs, initBotSubTabs };
