/**
 * settingsSlots.mjs — 设置面板 slot 装配门面（2026-08-03 拆分：各 slot 实现迁 ./slots/*.mjs）
 *
 * 功能链：
 *   layout.mjs → initSettingsSlots() → 按序初始化 ./slots/ 下各 slot 模块：
 *   langSlot（语言）→ uiSlot（界面/主题/字体）→ accountSlot（账号）→ remoteSlot（远程访问）
 *   → pluginListSlot（插件列表）→ apiSlot（AI服务源+思维链显示）→ sysinfoSlot / injectTextsSlot
 *   → toggleSlot（AI条目控制）→ monitorSlot（后台监控）→ fakeSendSlot（请求预览）
 *
 * why：
 *   原单文件 3248 行为 11 个互不调用的 slot 段聚合，拆为自包含模块便于维护；
 *   本文件保留为唯一对外出口（门面）——外部 import 面零变化：
 *   initSettingsSlots（layout.mjs）、restoreStoredThemeState（index.mjs 启动恢复）、
 *   importThemeFile/exportCurrentTheme（importExport.mjs 聚合面板消费）。
 *   uiSlot 对 importExport.recordImportHistory 走调用点动态 import——无静态回边，
 *   settingsSlots 已退出 check_import_cycles 遗留环（0803 基线随之 5→4 成员收缩）。
 *
 * 影响范围：
 *   各 slot 的 DOM/localStorage/后端调用契约不变（内容逐字搬迁，见任务 MD：
 *   beilu的工作日志和项目日志/大文件拆分_settingsSlots_20260803/）。
 */

import { initLanguageSlot } from "./slots/langSlot.mjs";
import { initUiSlot, initTypographyPreferences, importThemeFile, exportCurrentTheme, restoreStoredThemeState } from "./slots/uiSlot.mjs";
import { initAccountSlot } from "./slots/accountSlot.mjs";
import { initRemoteSlot } from "./slots/remoteSlot.mjs";
import { initPluginListSlot } from "./slots/pluginListSlot.mjs";
import { initApiSlot } from "./slots/apiSlot.mjs";
import { initMonitorSlot } from "./slots/monitorSlot.mjs";
import { initToggleSlot } from "./slots/toggleSlot.mjs";
import { initFakeSendSlot } from "./slots/fakeSendSlot.mjs";
import { initSysinfoConfigSlot } from "./slots/sysinfoSlot.mjs";
import { initInjectTextsSlot } from "./slots/injectTextsSlot.mjs";

// 对外出口保持拆分前逐字一致（消费者：importExport.mjs / index.mjs）
export { importThemeFile, exportCurrentTheme, restoreStoredThemeState };

// ============================================================
// 导出：统一初始化
// ============================================================

export function initSettingsSlots() {
  // 字体偏好先于 slot DOM 装配恢复；即使设置面板缺失，根 token 也会在当前窗口生效。
  initTypographyPreferences();
  restoreStoredThemeState();
  initLanguageSlot();
  initUiSlot();
  initAccountSlot();
  initRemoteSlot();
  initPluginListSlot();
  initApiSlot();
  // beilu-files 路径配置已迁入安全中心 (security.mjs)
  // beilu-web 联网配置全量在联网设置悬浮窗（webSearchPanel.mjs，0713 批4 补齐 maxResults/fetchTimeout）；
  // 原 initWebConfigSlot 死 slot（零调用+与活跃入口同字段双默认分叉）已纯删
  initSysinfoConfigSlot();
  initInjectTextsSlot(); // AI 注入文本配置链（0710 收口专项）：落位同 sysinfo slot，锚 settings-plugin-config
  initToggleSlot(); // [2026-08-01 W6] toggle 手动控制面
  initMonitorSlot();
  initFakeSendSlot();
}
