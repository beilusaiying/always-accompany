/**
 * @file toggles.mjs — 功能开关簇 cluster
 *
 * 【功能链】
 *   initFeatureToggles（逐一初始化各功能开关，读 storage 恢复持久态）
 *       ├─ toggle-char-names（角色名显示：body.hide-char-names + BEILU_HIDE_CHAR_NAMES）
 *       ├─ toggle-regex（正则处理器：BEILU_REGEX_ENABLED）
 *       └─ toggle-sense-messages（感知消息显示：beilu-eye 截图消息可见性）
 *   ⚠ toggle-thinking-fold 初始化段已删（0714 收口）：思维链设定唯一入口=设置→AI服务源「思维链显示」（settingsSlots）
 *   → window.beiluSetShowHidden（全局函数：控制隐藏消息可见性，供外部调用）
 *   ⚠ 旧 initExtendMenu 已删（死码，caller index.mjs:518 注释禁用），相关 import 一并清除
 *   ⚠ 旧 initFilePermissionToggles 已删（0709 死码：[data-permission] 元素全库零命中；
 *     读写/执行权限入口=work 工具箱 workPanel.mjs + code 权限档位 permissionPanel.mjs）
 *
 * 【why】
 *   功能开关是跨模块的全局状态，集中在此管理防止分散。
 *
 * 【关联链】
 *   上游：index.mjs（调用 initFeatureToggles）
 *   核心依赖：shared/state/storage.mjs（storage / KEYS，各开关持久态读写）
 *   下游消费：messageList.mjs（hide-char-names / sense-messages 消费）、
 *             displayRegex.mjs（BEILU_REGEX_ENABLED 消费）
 *
 * 【影响范围】
 *   body CSS class（hide-char-names）；localStorage 中多个 BEILU_* 开关键；
 *   window.beiluSetShowHidden 全局暴露，外部脚本可调用控制隐藏消息可见性。
 *
 * 【使用效果】
 *   import { initFeatureToggles } from "./toggles.mjs"
 *   初始化后所有功能开关从 localStorage 恢复上次状态。
 */

import { storage, KEYS } from "../../shared/state/storage.mjs";
import { setRegexEnabled } from "../feature/featureControls.mjs"; // 0713 A1：正则开关唯一写点（写键+同步兄弟入口+重渲染）

// initSingleInjectPanel 已删（0726 注入坞重构）：它管的 #single-inject-panel（输入区内单条
// textarea 面板）整块删除，#single-inject-btn 的点击行为由 shared/chat-core/injectDock.mjs
// initInjectDock() 接管（同款 document 级委托 + 点外/Esc 关闭）。

// ============================================================
// 功能开关面板（右栏插件管理区域）
// ============================================================

function initFeatureToggles() {
  // 角色名显示开关
  const charNamesToggle = document.getElementById("toggle-char-names");
  if (charNamesToggle) {
    const saved = storage.get(KEYS.BEILU_HIDE_CHAR_NAMES);
    charNamesToggle.checked = saved !== "true";
    if (saved === "true") document.body.classList.add("hide-char-names");
    charNamesToggle.addEventListener("change", () => {
      if (charNamesToggle.checked) {
        document.body.classList.remove("hide-char-names");
        storage.set(KEYS.BEILU_HIDE_CHAR_NAMES, "false");
      } else {
        document.body.classList.add("hide-char-names");
        storage.set(KEYS.BEILU_HIDE_CHAR_NAMES, "true");
      }
    });
  }

  // 正则处理器开关（0713 A1：change 走 setRegexEnabled 唯一写点——原本处裸写键不重渲染=改了对已上屏消息不生效）
  const regexToggle = document.getElementById("toggle-regex");
  if (regexToggle) {
    const saved = storage.get(KEYS.BEILU_REGEX_ENABLED);
    regexToggle.checked = saved !== "false";
    regexToggle.addEventListener("change", () => {
      setRegexEnabled(regexToggle.checked);
    });
  }

  // 思维链折叠开关初始化段已删（0714 收口）：设定唯一入口 = 设置→AI服务源「思维链显示」（settingsSlots 装配）。

  // 感知消息显示开关（控制 beilu-eye 截图消息是否在聊天界面显示）
  const senseMessagesToggle = document.getElementById("toggle-sense-messages");
  if (senseMessagesToggle) {
    const saved = storage.get(KEYS.BEILU_SHOW_SENSE_MESSAGES);
    senseMessagesToggle.checked = saved === "true";
    senseMessagesToggle.addEventListener("change", () => {
      storage.set(KEYS.BEILU_SHOW_SENSE_MESSAGES,
        senseMessagesToggle.checked ? "true" : "false");
      console.log(
        `[beilu-chat] 感知消息显示: ${senseMessagesToggle.checked ? "开启" : "关闭"}`,
      );
    });
  }

  // T3 隐藏消息灰条显示开关（默认开=显示灰条占位；关=被隐藏消息全隐）。
  // localStorage:beilu-show-hidden，body class 与折叠条渲染逻辑统一在 messageList.mjs。
  const showHiddenToggle = document.getElementById("toggle-show-hidden");
  if (showHiddenToggle) {
    const _shSaved = storage.get(KEYS.BEILU_SHOW_HIDDEN);
    showHiddenToggle.checked = _shSaved !== "false"; // 默认显示
    // 初次同步 body class（messageList 已导出全局 helper）
    if (typeof window.beiluSetShowHidden === "function") {
      window.beiluSetShowHidden(showHiddenToggle.checked);
    }
    // 0713 A3：原 else 兜底裸写键（写库不改 body class=半接线）删除。
    // beiluSetShowHidden 由 messageList 模块作用域挂载（messageList.mjs:688），用户点击时必已就位。
    showHiddenToggle.addEventListener("change", () => {
      window.beiluSetShowHidden(showHiddenToggle.checked);
      console.log(
        `[beilu-chat] 隐藏消息灰条: ${showHiddenToggle.checked ? "显示" : "全隐"}`,
      );
    });
  }

}

export { initFeatureToggles };
