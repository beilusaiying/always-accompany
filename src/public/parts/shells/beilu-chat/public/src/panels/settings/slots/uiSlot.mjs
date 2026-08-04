// uiSlot.mjs — 设置面板·界面设置 slot + 主题/字体域（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
// 主题导入/导出/恢复（importThemeFile/exportCurrentTheme/restoreStoredThemeState）与 initUiSlot 共享
// _DAISY_THEMES/_ENHANCED_THEMES/IMPORTED_THEME_*/TYPOGRAPHY_* 全套模块态，必须同模块（拆分设计·共享面登记）。
import { escapeHtml } from "../../../shared/state/utils.mjs";
import { DEFAULTS } from "../../../config/defaults.mjs";
import { setMsgLoadLimit } from "../../feature/featureControls.mjs";
import { storage, KEYS } from "../../../shared/state/storage.mjs";
import { showToast } from "../../../../../../../scripts/toast.mjs";
// recordImportHistory 改调用点动态 import（下方 importThemeFile 内）：importExport 静态 import 本模块
// 所属门面 settingsSlots（主题函数单源），此处再静态回边 = check_import_cycles 基线外新环
// （原 settingsSlots 单文件时代即是遗留 5 成员环成员）。动态 import 防静态环=项目既有范式
// （tempConversation._resolveModeChatId / websocket._ensureModeChatId 同款先例）。
import { resolveGlobalThemePreference } from "../../../../../../../scripts/theme.mjs";

// ============================================================
// 界面设置 slot
// ============================================================

const _DAISY_THEMES = [
  // group: "dark" | "light" | "vivid" — 用于分组显示
  { id: "default", label: "跟随全局", dark: true, group: "dark" },
  { id: "dark", label: "深色", dark: true, group: "dark" },
  { id: "night", label: "夜空", dark: true, group: "dark" },
  { id: "dim", label: "暗淡", dark: true, group: "dark" },
  { id: "dracula", label: "德古拉", dark: true, group: "dark" },
  { id: "abyss", label: "深渊", dark: true, group: "dark" },
  { id: "synthwave", label: "合成波", dark: true, group: "dark" },
  { id: "sunset", label: "日落", dark: true, group: "dark" },
  { id: "coffee", label: "咖啡", dark: true, group: "dark" },
  { id: "forest", label: "森林", dark: true, group: "dark" },
  { id: "luxury", label: "奢华", dark: true, group: "dark" },
  { id: "business", label: "商务", dark: true, group: "dark" },
  { id: "black", label: "纯黑", dark: true, group: "dark" },
  { id: "halloween", label: "万圣节", dark: true, group: "dark" },
  { id: "nord", label: "北欧", dark: false, group: "light" },
  { id: "light", label: "浅色", dark: false, group: "light" },
  { id: "cupcake", label: "杯糕", dark: false, group: "light" },
  { id: "emerald", label: "翡翠", dark: false, group: "light" },
  { id: "corporate", label: "企业", dark: false, group: "light" },
  { id: "retro", label: "复古", dark: false, group: "light" },
  { id: "winter", label: "冬日", dark: false, group: "light" },
  { id: "autumn", label: "秋韵", dark: false, group: "light" },
  { id: "lofi", label: "低保真", dark: false, group: "light" },
  { id: "silk", label: "丝绸", dark: false, group: "light" },
  { id: "caramellatte", label: "焦糖", dark: false, group: "light" },
  { id: "valentine", label: "情人节", dark: false, group: "vivid" },
  { id: "garden", label: "花园", dark: false, group: "vivid" },
  { id: "pastel", label: "粉蜡", dark: false, group: "vivid" },
  { id: "bumblebee", label: "蜜蜂", dark: false, group: "vivid" },
  { id: "cyberpunk", label: "赛博朋克", dark: false, group: "vivid" },
  { id: "acid", label: "迷幻", dark: false, group: "vivid" },
  { id: "lemonade", label: "柠檬水", dark: false, group: "vivid" },
  { id: "wireframe", label: "线框", dark: false, group: "vivid" },
  { id: "cmyk", label: "印刷色", dark: false, group: "vivid" },
  { id: "fantasy", label: "幻想", dark: false, group: "vivid" },
  { id: "aqua", label: "水蓝", dark: true, group: "vivid" },
];

const _ENHANCED_THEMES = [
  { id: "cyberpunk", label: "夜城终端", base: "cyberpunk", desc: "深色实体终端" },
  { id: "night", label: "星轨档案", base: "night", desc: "海军蓝档案层级" },
  { id: "valentine", label: "绯樱书简", base: "valentine", desc: "乳白阅读纸面" },
  { id: "bumblebee", label: "工业指挥板", base: "bumblebee", desc: "炭黑模块命令板" },
  { id: "synthwave", label: "霓虹地平线", base: "synthwave", desc: "紫黑实体终端" },
  { id: "acid", label: "生物信号", base: "acid", desc: "石墨实验标注" },
  { id: "lemonade", label: "柑橘手账", base: "lemonade", desc: "乳白纸面与深绿" },
  { id: "aqua", label: "深海终端", base: "aqua", desc: "深海资料板" },
  { id: "madoka", label: "五色契约", base: "valentine", desc: "乳白五色灵魂宝石 UI", swatches: ["pink", "violet", "gold", "red", "blue"] },
];

function _buildEnhancedGrid(currentEnhanced) {
  let html = "";
  for (const t of _ENHANCED_THEMES) {
    const active = t.id === currentEnhanced;
    const cls = active ? "theme-btn active" : "theme-btn";
    if (t.swatches) {
      html += `<button data-enhanced-pick="${escapeHtml(t.id)}" data-enhanced-base="${escapeHtml(t.base)}" data-enhanced-label="${escapeHtml(t.label)}" class="${cls}" title="${escapeHtml(t.desc)}" data-theme="${escapeHtml(t.base)}">
      <span class="theme-name">${escapeHtml(t.label)}</span>
      <span class="theme-dots">
        ${t.swatches.map(swatch => `<i data-swatch="${escapeHtml(swatch)}"></i>`).join("\n        ")}
      </span>
    </button>`;
      continue;
    }
    html += `<button data-enhanced-pick="${escapeHtml(t.id)}" data-enhanced-base="${escapeHtml(t.base)}" data-enhanced-label="${escapeHtml(t.label)}" class="${cls}" title="${escapeHtml(t.desc)}" data-theme="${escapeHtml(t.base)}">
      <span class="theme-name">${escapeHtml(t.label)}</span>
      <span class="theme-dots">
        <i style="background:oklch(var(--p))"></i>
        <i style="background:oklch(var(--s))"></i>
        <i style="background:oklch(var(--a))"></i>
      </span>
    </button>`;
  }
  return html;
}

/** 根据 scheme id 查找中文 label，找不到返回 id 本身 */
function _themeLabel(schemeId) {
  if (!schemeId || schemeId === "default") return "跟随全局";
  const found = _DAISY_THEMES.find(t => t.id === schemeId);
  return found ? found.label : schemeId;
}

function _buildThemeGrid(currentScheme) {
  const groups = [
    { key: "dark", label: "暗色" },
    { key: "light", label: "亮色" },
    { key: "vivid", label: "鲜艳色" },
  ];
  let html = "";
  for (const g of groups) {
    const items = _DAISY_THEMES.filter(t => t.group === g.key);
    if (!items.length) continue;
    html += `<div class="theme-group-label">${escapeHtml(g.label)}</div>`;
    for (const t of items) {
      const active = (t.id === "default" && !currentScheme) || t.id === currentScheme;
      const cls = active ? "theme-btn active" : "theme-btn";
      html += `<button data-theme-pick="${escapeHtml(t.id)}" data-theme-label="${escapeHtml(t.label)}" class="${cls}" title="${escapeHtml(t.label)}" data-theme="${escapeHtml(t.id)}">
        <span class="theme-name">${escapeHtml(t.label)}</span>
        <span class="theme-dots">
          <i style="background:oklch(var(--p))"></i>
          <i style="background:oklch(var(--s))"></i>
          <i style="background:oklch(var(--a))"></i>
        </span>
      </button>`;
    }
  }
  return html;
}

const IMPORTED_THEME_BASE = "dark";

// JSON 字段→导入目标→导出语义源的唯一登记表。旧折叠字段在前，新角色字段在后覆盖，保持旧文件兼容且支持无损回环。
const IMPORTED_THEME_COLOR_MAP = Object.freeze([
  // 旧 beilu_theme 字段：继续写旧别名，但 exportVar 始终读取新语义 token。
  Object.freeze({ key: "amber", cssVars: Object.freeze(["--beilu-amber", "--beilu-user-accent", "--beilu-action-accent"]), exportVar: "--beilu-action-accent" }),
  Object.freeze({ key: "amber_text", cssVars: Object.freeze(["--beilu-amber-text", "--beilu-fg-on-accent"]), exportVar: "--beilu-fg-on-accent" }),
  Object.freeze({ key: "accent", cssVars: Object.freeze(["--beilu-accent", "--beilu-theme-accent-aux"]), exportVar: "--beilu-theme-accent-aux" }),
  Object.freeze({ key: "accent_text", cssVars: Object.freeze(["--beilu-accent-text", "--beilu-fg-on-accent-aux"]), exportVar: "--beilu-fg-on-accent-aux" }),
  Object.freeze({ key: "error", cssVars: Object.freeze(["--beilu-error", "--beilu-state-error"]), exportVar: "--beilu-state-error" }),
  Object.freeze({ key: "success", cssVars: Object.freeze(["--beilu-success", "--beilu-state-success"]), exportVar: "--beilu-state-success" }),
  Object.freeze({ key: "warning", cssVars: Object.freeze(["--beilu-warning", "--beilu-state-warning"]), exportVar: "--beilu-state-warning" }),
  Object.freeze({ key: "bg_dark", cssVars: Object.freeze(["--beilu-bg-dark", "--beilu-surface-workspace"]), exportVar: "--beilu-surface-workspace", opaque: true }),
  Object.freeze({ key: "bg_card", cssVars: Object.freeze(["--beilu-bg-card", "--beilu-surface-panel", "--beilu-surface-raised"]), exportVar: "--beilu-surface-panel", opaque: true }),
  Object.freeze({ key: "modal_bg", cssVars: Object.freeze(["--beilu-modal-bg", "--beilu-surface-modal", "--beilu-surface-floating"]), exportVar: "--beilu-surface-modal", opaque: true }),
  Object.freeze({ key: "text_dim", cssVars: Object.freeze(["--beilu-text-dim", "--beilu-fg-secondary", "--beilu-fg-muted"]), exportVar: "--beilu-fg-secondary" }),
  Object.freeze({ key: "border_subtle", cssVars: Object.freeze(["--beilu-border-subtle", "--beilu-border-default"]), exportVar: "--beilu-border-subtle" }),
  Object.freeze({ key: "bg_hover", cssVars: Object.freeze(["--beilu-bg-hover", "--beilu-hover"]), exportVar: "--beilu-hover" }),
  Object.freeze({ key: "user_msg_bg", cssVars: Object.freeze(["--beilu-user-msg-bg", "--beilu-surface-message-user"]), exportVar: "--beilu-surface-message-user", opaque: true }),
  Object.freeze({ key: "bot_msg_bg", cssVars: Object.freeze(["--beilu-bot-msg-bg", "--beilu-surface-message-bot"]), exportVar: "--beilu-surface-message-bot", opaque: true }),
  // 可选角色字段：顺序必须位于旧折叠字段之后，以便新格式精确覆盖 raised/floating/muted/default 等角色。
  Object.freeze({ key: "bg_raised", cssVars: Object.freeze(["--beilu-surface-raised"]), exportVar: "--beilu-surface-raised", opaque: true }),
  Object.freeze({ key: "floating_bg", cssVars: Object.freeze(["--beilu-surface-floating"]), exportVar: "--beilu-surface-floating", opaque: true }),
  Object.freeze({ key: "input_bg", cssVars: Object.freeze(["--beilu-surface-input"]), exportVar: "--beilu-surface-input", opaque: true }),
  Object.freeze({ key: "code_bg", cssVars: Object.freeze(["--beilu-surface-code"]), exportVar: "--beilu-surface-code", opaque: true }),
  Object.freeze({ key: "inverse_bg", cssVars: Object.freeze(["--beilu-surface-inverse"]), exportVar: "--beilu-surface-inverse", opaque: true }),
  Object.freeze({ key: "backdrop", cssVars: Object.freeze(["--beilu-backdrop"]), exportVar: "--beilu-backdrop" }),
  Object.freeze({ key: "text_primary", cssVars: Object.freeze(["--beilu-fg-primary"]), exportVar: "--beilu-fg-primary" }),
  Object.freeze({ key: "text_muted", cssVars: Object.freeze(["--beilu-fg-muted"]), exportVar: "--beilu-fg-muted" }),
  Object.freeze({ key: "text_disabled", cssVars: Object.freeze(["--beilu-fg-disabled"]), exportVar: "--beilu-fg-disabled" }),
  Object.freeze({ key: "text_inverse", cssVars: Object.freeze(["--beilu-fg-inverse"]), exportVar: "--beilu-fg-inverse" }),
  Object.freeze({ key: "text_accent", cssVars: Object.freeze(["--beilu-fg-accent"]), exportVar: "--beilu-fg-accent" }),
  Object.freeze({ key: "theme_accent", cssVars: Object.freeze(["--beilu-theme-accent"]), exportVar: "--beilu-theme-accent" }),
  Object.freeze({ key: "info", cssVars: Object.freeze(["--beilu-state-info"]), exportVar: "--beilu-state-info" }),
  Object.freeze({ key: "info_text", cssVars: Object.freeze(["--beilu-fg-on-info"]), exportVar: "--beilu-fg-on-info" }),
  Object.freeze({ key: "success_text", cssVars: Object.freeze(["--beilu-fg-on-success"]), exportVar: "--beilu-fg-on-success" }),
  Object.freeze({ key: "warning_text", cssVars: Object.freeze(["--beilu-fg-on-warning"]), exportVar: "--beilu-fg-on-warning" }),
  Object.freeze({ key: "error_text", cssVars: Object.freeze(["--beilu-fg-on-error"]), exportVar: "--beilu-fg-on-error" }),
  Object.freeze({ key: "border_default", cssVars: Object.freeze(["--beilu-border-default"]), exportVar: "--beilu-border-default" }),
  Object.freeze({ key: "border_strong", cssVars: Object.freeze(["--beilu-border-strong"]), exportVar: "--beilu-border-strong" }),
  Object.freeze({ key: "border_focus", cssVars: Object.freeze(["--beilu-border-focus"]), exportVar: "--beilu-border-focus" }),
  Object.freeze({ key: "focus", cssVars: Object.freeze(["--beilu-focus"]), exportVar: "--beilu-focus" }),
  Object.freeze({ key: "selection", cssVars: Object.freeze(["--beilu-selection"]), exportVar: "--beilu-selection" }),
  Object.freeze({ key: "selection_inactive", cssVars: Object.freeze(["--beilu-selection-inactive"]), exportVar: "--beilu-selection-inactive" }),
  Object.freeze({ key: "bg_active", cssVars: Object.freeze(["--beilu-active"]), exportVar: "--beilu-active" }),
  Object.freeze({ key: "drop_target", cssVars: Object.freeze(["--beilu-drop-target"]), exportVar: "--beilu-drop-target" }),
]);

const IMPORTED_THEME_INLINE_VARS = Object.freeze([
  ...new Set(IMPORTED_THEME_COLOR_MAP.flatMap((entry) => entry.cssVars)),
  "--beilu-amber-rgb",
]);

const IMPORTED_THEME_CONTRAST_SURFACES = Object.freeze([
  Object.freeze({ role: "workspace", cssVar: "--beilu-surface-workspace" }),
  Object.freeze({ role: "panel", cssVar: "--beilu-surface-panel" }),
  Object.freeze({ role: "raised", cssVar: "--beilu-surface-raised" }),
  Object.freeze({ role: "input", cssVar: "--beilu-surface-input" }),
  Object.freeze({ role: "code", cssVar: "--beilu-surface-code" }),
  Object.freeze({ role: "floating", cssVar: "--beilu-surface-floating" }),
  Object.freeze({ role: "modal", cssVar: "--beilu-surface-modal" }),
  Object.freeze({ role: "message-user", cssVar: "--beilu-surface-message-user" }),
  Object.freeze({ role: "message-bot", cssVar: "--beilu-surface-message-bot" }),
]);

const IMPORTED_THEME_CONTRAST_TEXT = Object.freeze([
  Object.freeze({ role: "text-primary", cssVar: "--beilu-fg-primary", minimum: 4.5, guidance: "colors.text_primary" }),
  Object.freeze({ role: "text-secondary", cssVar: "--beilu-fg-secondary", minimum: 4.5, guidance: "colors.text_dim" }),
  Object.freeze({ role: "text-muted", cssVar: "--beilu-fg-muted", minimum: 4.5, guidance: "colors.text_muted" }),
  Object.freeze({ role: "text-disabled", cssVar: "--beilu-fg-disabled", minimum: 3, guidance: "colors.text_disabled" }),
]);

const IMPORTED_THEME_CONTRAST_STATE_PAIRS = Object.freeze([
  Object.freeze({ foregroundRole: "on-accent", foregroundVar: "--beilu-fg-on-accent", backgroundRole: "accent", backgroundVar: "--beilu-action-accent", guidance: "colors.amber_text" }),
  Object.freeze({ foregroundRole: "on-accent-aux", foregroundVar: "--beilu-fg-on-accent-aux", backgroundRole: "accent-aux", backgroundVar: "--beilu-theme-accent-aux", guidance: "colors.accent_text" }),
  Object.freeze({ foregroundRole: "on-info", foregroundVar: "--beilu-fg-on-info", backgroundRole: "info", backgroundVar: "--beilu-state-info", guidance: "colors.info_text" }),
  Object.freeze({ foregroundRole: "on-success", foregroundVar: "--beilu-fg-on-success", backgroundRole: "success", backgroundVar: "--beilu-state-success", guidance: "colors.success_text" }),
  Object.freeze({ foregroundRole: "on-warning", foregroundVar: "--beilu-fg-on-warning", backgroundRole: "warning", backgroundVar: "--beilu-state-warning", guidance: "colors.warning_text" }),
  Object.freeze({ foregroundRole: "on-error", foregroundVar: "--beilu-fg-on-error", backgroundRole: "error", backgroundVar: "--beilu-state-error", guidance: "colors.error_text" }),
]);

function _readImportedColor(raw, key) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw !== "string") throw new TypeError(`colors.${key} 必须是 CSS 颜色字符串`);
  const value = raw.trim();
  if (!value || (globalThis.CSS?.supports && !CSS.supports("color", value))) {
    throw new TypeError(`colors.${key} 不是有效 CSS 颜色: ${JSON.stringify(raw)}`);
  }
  return value;
}

function _opaqueImportedColor(value, key) {
  const relativeColor = `rgb(from ${value} r g b / 1)`;
  if (!globalThis.CSS?.supports || CSS.supports("color", relativeColor)) return relativeColor;

  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) return `#${hex.length <= 4 ? hex.slice(0, 3) : hex.slice(0, 6)}`;
  const rgb = value.match(/^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,/\s)]+)(?:\s*[,/]\s*[^)]+)?\s*\)$/i);
  if (rgb) return `rgb(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()})`;
  throw new TypeError(`colors.${key} 无法转换为不透明颜色: ${JSON.stringify(value)}`);
}

function _amberRgbChannels(value) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? hex.slice(0, 3).split("").map((c) => c + c).join("") : hex.slice(0, 6);
    return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16)).join(", ");
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
  return rgb ? `${Math.round(Number(rgb[1]))}, ${Math.round(Number(rgb[2]))}, ${Math.round(Number(rgb[3]))}` : "";
}

function _clearImportedThemeOverrides() {
  const root = document.documentElement;
  for (const cssVar of IMPORTED_THEME_INLINE_VARS) root.style.removeProperty(cssVar);
}

function _prepareImportedThemeColors(colors) {
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) {
    throw new TypeError("theme.colors 必须是颜色对象");
  }

  // 全字段先完成类型、CSS 语法与不透明 surface 转换校验；此阶段不触碰 DOM。
  const assignments = [];
  for (const entry of IMPORTED_THEME_COLOR_MAP) {
    const value = _readImportedColor(colors[entry.key], entry.key);
    if (!value) continue;
    const appliedValue = entry.opaque ? _opaqueImportedColor(value, entry.key) : value;
    for (const cssVar of entry.cssVars) assignments.push([cssVar, appliedValue]);
  }

  const amber = _readImportedColor(colors.amber, "amber");
  return Object.freeze({
    assignments: Object.freeze(assignments.map((assignment) => Object.freeze(assignment))),
    amberValue: amber,
    amberRgbChannels: amber ? _amberRgbChannels(amber) : "",
  });
}

function _applyPreparedImportedThemeColors(prepared) {
  _clearImportedThemeOverrides();
  const root = document.documentElement;
  for (const [cssVar, value] of prepared.assignments) root.style.setProperty(cssVar, value);
  if (prepared.amberRgbChannels) root.style.setProperty("--beilu-amber-rgb", prepared.amberRgbChannels);
  else if (prepared.amberValue) console.warn(`[beilu-settings] 无法从 ${JSON.stringify(prepared.amberValue)} 派生旧 --beilu-amber-rgb；新语义色仍已生效`);
}

function _parseBrowserRgb(serialized, role) {
  const value = String(serialized ?? "").trim().toLowerCase();
  const parseChannel = (token) => {
    const raw = token.trim();
    const number = Number.parseFloat(raw);
    if (!Number.isFinite(number)) return Number.NaN;
    return raw.endsWith("%") ? number * 2.55 : number;
  };
  const parseAlpha = (token = "1") => {
    const raw = token.trim();
    const number = Number.parseFloat(raw);
    if (!Number.isFinite(number)) return Number.NaN;
    return raw.endsWith("%") ? number / 100 : number;
  };

  let channels;
  let alpha = 1;
  const rgbMatch = value.match(/^rgba?\((.*)\)$/);
  if (rgbMatch) {
    const [channelPart, slashAlpha] = rgbMatch[1].split("/").map((part) => part.trim());
    const parts = channelPart.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    if (!slashAlpha && parts.length === 4) alpha = parseAlpha(parts.pop());
    else if (slashAlpha) alpha = parseAlpha(slashAlpha);
    channels = parts.map(parseChannel);
  } else {
    const srgbMatch = value.match(/^color\(srgb\s+([^)]*)\)$/);
    if (srgbMatch) {
      const [channelPart, slashAlpha] = srgbMatch[1].split("/").map((part) => part.trim());
      channels = channelPart.split(/\s+/).filter(Boolean).map((part) => {
        const raw = part.trim();
        const number = Number.parseFloat(raw);
        return raw.endsWith("%") ? number * 2.55 : number * 255;
      });
      if (slashAlpha) alpha = parseAlpha(slashAlpha);
    }
  }

  if (channels?.length !== 3 || channels.some((channel) => !Number.isFinite(channel)) || !Number.isFinite(alpha)) {
    throw new TypeError(`主题颜色角色 ${role} 无法解析为浏览器 RGB: ${JSON.stringify(serialized)}`);
  }
  return Object.freeze({
    r: Math.min(255, Math.max(0, channels[0])),
    g: Math.min(255, Math.max(0, channels[1])),
    b: Math.min(255, Math.max(0, channels[2])),
    a: Math.min(1, Math.max(0, alpha)),
  });
}

function _resolveImportedThemeRole(probe, role, cssVar) {
  // 强制在 sRGB 空间序列化；浏览器负责解析 named/hex/rgb/hsl/oklch/color-mix/var 等真实 CSS 色值。
  probe.style.setProperty("background-color", `color-mix(in srgb, var(${cssVar}) 100%, transparent)`, "important");
  const resolved = getComputedStyle(probe).backgroundColor;
  return _parseBrowserRgb(resolved, role);
}

function _compositeImportedThemeColor(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
  return Object.freeze({
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  });
}

function _importedThemeRelativeLuminance(color) {
  const linear = [color.r, color.g, color.b].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function _importedThemeContrastRatio(foreground, background, pairRole) {
  if (background.a < 1) {
    throw new TypeError(`主题颜色角色 ${pairRole} 的背景不是不透明色，无法得到唯一对比度`);
  }
  const renderedForeground = foreground.a < 1
    ? _compositeImportedThemeColor(foreground, background)
    : foreground;
  const foregroundLuminance = _importedThemeRelativeLuminance(renderedForeground);
  const backgroundLuminance = _importedThemeRelativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function _assertImportedThemeContrast() {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed!important;left:-10000px!important;top:-10000px!important;width:1px!important;height:1px!important;visibility:hidden!important;pointer-events:none!important;contain:strict!important;";
  document.documentElement.appendChild(probe);

  try {
    const resolved = new Map();
    const readRole = (role, cssVar) => {
      const cacheKey = `${role}\u0000${cssVar}`;
      if (!resolved.has(cacheKey)) resolved.set(cacheKey, _resolveImportedThemeRole(probe, role, cssVar));
      return resolved.get(cacheKey);
    };
    const surfaces = IMPORTED_THEME_CONTRAST_SURFACES.map((surface) => Object.freeze({
      ...surface,
      color: readRole(surface.role, surface.cssVar),
    }));
    const failures = [];

    for (const text of IMPORTED_THEME_CONTRAST_TEXT) {
      const foreground = readRole(text.role, text.cssVar);
      for (const surface of surfaces) {
        const pairRole = `${text.role}/${surface.role}`;
        const ratio = _importedThemeContrastRatio(foreground, surface.color, pairRole);
        if (ratio + Number.EPSILON < text.minimum) {
          failures.push(Object.freeze({ role: pairRole, ratio, minimum: text.minimum, guidance: text.guidance }));
        }
      }
    }

    for (const pair of IMPORTED_THEME_CONTRAST_STATE_PAIRS) {
      const pairRole = `${pair.foregroundRole}/${pair.backgroundRole}`;
      const ratio = _importedThemeContrastRatio(
        readRole(pair.foregroundRole, pair.foregroundVar),
        readRole(pair.backgroundRole, pair.backgroundVar),
        pairRole,
      );
      if (ratio + Number.EPSILON < 4.5) {
        failures.push(Object.freeze({ role: pairRole, ratio, minimum: 4.5, guidance: pair.guidance }));
      }
    }

    if (failures.length) {
      const details = failures
        .map((failure) => `${failure.role} ${failure.ratio.toFixed(3)}:1（要求 ${failure.minimum.toFixed(1)}:1）`)
        .join("；");
      const guidance = [...new Set(failures.map((failure) => failure.guidance))].join("、");
      throw new TypeError(`主题对比度校验失败：${details}。请补充或调整 ${guidance}；不会自动猜测黑/白或覆盖你的颜色。`);
    }
  } finally {
    probe.remove();
  }
}

function _collectThemeExportColors(readCssVar) {
  if (typeof readCssVar !== "function") throw new TypeError("readCssVar 必须是函数");
  const colors = {};
  for (const entry of IMPORTED_THEME_COLOR_MAP) {
    if (!entry.exportVar) continue;
    const value = String(readCssVar(entry.exportVar) ?? "").trim();
    if (value) colors[entry.key] = value;
  }
  return colors;
}

function _captureThemePreviewState() {
  const root = document.documentElement;
  return Object.freeze({
    theme: root.getAttribute("data-theme"),
    enhanced: root.getAttribute("data-beilu-enhanced"),
    inlineVars: Object.freeze(IMPORTED_THEME_INLINE_VARS.map((cssVar) => Object.freeze({
      cssVar,
      value: root.style.getPropertyValue(cssVar),
      priority: root.style.getPropertyPriority(cssVar),
    }))),
  });
}

function _restoreThemePreviewState(snapshot) {
  const root = document.documentElement;
  if (snapshot.theme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", snapshot.theme);
  if (snapshot.enhanced === null) root.removeAttribute("data-beilu-enhanced");
  else root.setAttribute("data-beilu-enhanced", snapshot.enhanced);
  for (const { cssVar, value, priority } of snapshot.inlineVars) {
    if (value) root.style.setProperty(cssVar, value, priority);
    else root.style.removeProperty(cssVar);
  }
}

function _beginThemePreview({ theme, enhanced = null }) {
  const snapshot = _captureThemePreviewState();
  // imported 的 inline token 优先级高于 palette/skin；预览期间只移除 DOM 覆盖，不改任何持久化状态。
  _clearImportedThemeOverrides();
  document.documentElement.dataset.theme = theme;
  if (enhanced) document.documentElement.dataset.beiluEnhanced = enhanced;
  else document.documentElement.removeAttribute("data-beilu-enhanced");
  return snapshot;
}

function _clearEnhancedThemeState() {
  storage.remove(KEYS.BEILU_ENHANCED_THEME);
  document.documentElement.removeAttribute("data-beilu-enhanced");
}

function _activateImportedTheme(theme, { persist = false } = {}) {
  if (!theme?.beilu_theme || !theme.colors?.amber) {
    throw new TypeError("无效的 beilu 主题（需要 beilu_theme 和 colors.amber）");
  }
  const prepared = _prepareImportedThemeColors(theme.colors);
  const snapshot = _captureThemePreviewState();
  try {
    // 对比度必须按最终生效组合测量：固定 dark 基座，退出 enhanced 属性，再叠加导入 token。
    document.documentElement.dataset.theme = IMPORTED_THEME_BASE;
    document.documentElement.removeAttribute("data-beilu-enhanced");
    _applyPreparedImportedThemeColors(prepared);
    _assertImportedThemeContrast();
  } catch (error) {
    // 导入失败只回滚本函数触碰的 DOM 状态；持久化写点尚未发生，原增强主题仍完整保留。
    _restoreThemePreviewState(snapshot);
    throw error;
  }

  // 测量通过后才提交持久化副作用。
  _clearEnhancedThemeState();
  storage.set(KEYS.BEILU_COLOR_SCHEME, IMPORTED_THEME_BASE);
  if (persist) storage.set(KEYS.BEILU_IMPORTED_THEME, JSON.stringify(theme));
}

// 字号设置登记表：key/范围/缺省值/CSS 消费变量只在此处定义。
// 现有 BEILU_FONT_SIZE 字面保持不变，继续表示 content/chat，不破坏用户已存值。
const TYPOGRAPHY_SETTINGS = Object.freeze([
  Object.freeze({
    role: "content", key: KEYS.BEILU_FONT_SIZE,
    cssVar: "--beilu-font-size-content", legacyCssVar: "--beilu-font-size",
    min: 12, max: 20, defaultValue: 14,
    legacyValues: Object.freeze({ xsmall: 11, small: 12, medium: 14, mlarge: 15, large: 16 }),
    inputId: "settings-font-size", labelId: "settings-font-size-label",
  }),
  Object.freeze({
    role: "ui", key: KEYS.BEILU_UI_FONT_SIZE,
    cssVar: "--beilu-font-size-ui",
    min: 14, max: 20, defaultValue: 16,
    inputId: "settings-ui-font-size", labelId: "settings-ui-font-size-label",
  }),
  Object.freeze({
    role: "mono", key: KEYS.BEILU_MONO_FONT_SIZE,
    cssVar: "--beilu-font-size-mono",
    min: 12, max: 22, defaultValue: 14,
    inputId: "settings-mono-font-size", labelId: "settings-mono-font-size-label",
  }),
]);
const TYPOGRAPHY_SETTING_BY_KEY = new Map(TYPOGRAPHY_SETTINGS.map((spec) => [spec.key, spec]));
let _typographyStorageUnsubscribe = null;

function _normalizeFontSize(raw, spec) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text === "") return spec.defaultValue;
  const number = spec.legacyValues?.[text] ?? Number(text);
  if (!Number.isFinite(number)) {
    console.warn(`[beilu-settings] 字号设置 ${spec.key}=${JSON.stringify(raw)} 无效，恢复 ${spec.defaultValue}px`);
    return spec.defaultValue;
  }
  const rounded = Math.round(number);
  const clamped = Math.min(spec.max, Math.max(spec.min, rounded));
  if (clamped !== number) {
    console.warn(`[beilu-settings] 字号设置 ${spec.key}=${JSON.stringify(raw)} 已规范为 ${clamped}px`);
  }
  return clamped;
}

function _syncTypographyControl(spec, value) {
  const input = document.getElementById(spec.inputId);
  const label = document.getElementById(spec.labelId);
  if (input) input.value = String(value);
  if (label) label.textContent = `${value}px`;
}

function _applyTypographySetting(spec, raw, { repairStoredValue = false } = {}) {
  const value = _normalizeFontSize(raw, spec);
  const canonical = String(value);
  const root = document.documentElement;
  root.style.setProperty(spec.cssVar, `${canonical}px`);
  // 兼容期：旧 --beilu-font-size 只跟随 content；不再同步无消费的聊天字号别名。
  if (spec.legacyCssVar) root.style.setProperty(spec.legacyCssVar, `${canonical}px`);
  _syncTypographyControl(spec, value);
  if (repairStoredValue && raw !== null && raw !== undefined && String(raw).trim() !== canonical) {
    storage.set(spec.key, canonical);
  }
  return value;
}

function _readTypographySetting(spec) {
  return _applyTypographySetting(spec, storage.get(spec.key), { repairStoredValue: true });
}

function _commitTypographySetting(spec, raw) {
  const value = _applyTypographySetting(spec, raw);
  storage.set(spec.key, String(value));
  return value;
}

function _applyFontFamilyPreference(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  const root = document.documentElement;
  const properties = ["--beilu-font-ui", "--beilu-font-content", "--beilu-font-family"];
  for (const property of properties) {
    if (value) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }

  const select = document.getElementById("settings-font-family");
  const custom = document.getElementById("settings-font-family-custom");
  if (!select) return value;
  const matched = Array.from(select.options).some((option) => option.value === value);
  if (!value || matched) {
    select.value = value;
    custom?.classList.add("hidden");
  } else {
    select.value = "__custom__";
    if (custom) {
      custom.value = value;
      custom.classList.remove("hidden");
    }
  }
  return value;
}

function _initTypographyPreferences() {
  for (const spec of TYPOGRAPHY_SETTINGS) _readTypographySetting(spec);
  _applyFontFamilyPreference(storage.get(KEYS.BEILU_FONT_FAMILY));
  if (_typographyStorageUnsubscribe) return;
  const watchedKeys = [...TYPOGRAPHY_SETTINGS.map((spec) => spec.key), KEYS.BEILU_FONT_FAMILY];
  _typographyStorageUnsubscribe = storage.subscribe(watchedKeys, ({ key, value }) => {
    if (key === null) {
      for (const spec of TYPOGRAPHY_SETTINGS) _applyTypographySetting(spec, null);
      _applyFontFamilyPreference("");
      return;
    }
    if (key === KEYS.BEILU_FONT_FAMILY) {
      _applyFontFamilyPreference(value);
      return;
    }
    const spec = TYPOGRAPHY_SETTING_BY_KEY.get(key);
    if (spec) _applyTypographySetting(spec, value, { repairStoredValue: true });
  });
}

export function initUiSlot() {
  const slot = document.getElementById("settings-ui-slot");
  if (!slot) return;

  const currentTheme = resolveGlobalThemePreference(storage.get(KEYS.THEME));
  const typographyValues = Object.fromEntries(TYPOGRAPHY_SETTINGS.map((spec) => [spec.role, _readTypographySetting(spec)]));
  const currentFontFamily = storage.get(KEYS.BEILU_FONT_FAMILY) || "";

  slot.innerHTML = `
    <div class="space-y-4 mt-2">
      <!-- 统一主题面板 -->
      <div class="beilu-theme-panel">
        <div class="beilu-theme-header">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">主题</span>
            <label class="swap swap-rotate" style="transform:scale(0.85)">
              <input type="checkbox" id="settings-theme-toggle"
                ${currentTheme === "dark" ? "checked" : ""} />
              <span class="swap-on"><i data-ic="moon"></i></span>
              <span class="swap-off"><i data-ic="sun"></i></span>
            </label>
          </div>
          <span id="settings-theme-badge" class="badge badge-sm badge-outline">${_themeLabel(storage.get(KEYS.BEILU_COLOR_SCHEME))}</span>
        </div>
        <div class="beilu-theme-tabs">
          <button class="beilu-cat-tab active" data-cat="original">原色系列</button>
          <button class="beilu-cat-tab" data-cat="enhanced">UI优化</button>
          <button class="beilu-cat-tab" data-cat="imported">已导入</button>
        </div>
        <div id="settings-theme-grid" class="beilu-theme-grid" data-cat="original">
          ${_buildThemeGrid(storage.get(KEYS.BEILU_COLOR_SCHEME) || "")}
        </div>
        <div id="settings-theme-enhanced" class="beilu-theme-grid" data-cat="enhanced" style="display:none">
          ${_buildEnhancedGrid(storage.get(KEYS.BEILU_ENHANCED_THEME) || "")}
        </div>
        <div id="settings-theme-imported" class="beilu-theme-grid" data-cat="imported" style="display:none">
          <div class="beilu-theme-empty">暂无导入的主题</div>
        </div>
        <div class="beilu-theme-actions">
          <button id="settings-theme-import" class="btn btn-xs btn-outline flex-1">导入</button>
          <button id="settings-theme-export" class="btn btn-xs btn-outline flex-1">导出</button>
        </div>
      </div>

      <!-- 内容/对话字号：保留旧 key beilu-font-size -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">阅读字号</span>
          <p class="text-xs text-base-content/70">对话、长文和说明内容</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="range" id="settings-font-size" class="range range-xs w-24"
            min="12" max="20" step="1" value="${typographyValues.content}" />
          <span id="settings-font-size-label" class="text-xs font-mono w-8">${typographyValues.content}px</span>
        </div>
      </div>

      <!-- 系统 UI 字号：rem 基准 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">界面字号</span>
          <p class="text-xs text-base-content/70">菜单、设置、按钮和文件树</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="range" id="settings-ui-font-size" class="range range-xs w-24"
            min="14" max="20" step="1" value="${typographyValues.ui}" />
          <span id="settings-ui-font-size-label" class="text-xs font-mono w-8">${typographyValues.ui}px</span>
        </div>
      </div>

      <!-- 等宽字号 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">等宽字号</span>
          <p class="text-xs text-base-content/70">编辑器、代码、日志和路径</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="range" id="settings-mono-font-size" class="range range-xs w-24"
            min="12" max="22" step="1" value="${typographyValues.mono}" />
          <span id="settings-mono-font-size-label" class="text-xs font-mono w-8">${typographyValues.mono}px</span>
        </div>
      </div>

      <!-- 系统字体 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">系统字体</span>
          <p class="text-xs text-base-content/70">界面使用的字体</p>
        </div>
        <div class="flex items-center gap-2">
          <select id="settings-font-family" class="select select-xs select-bordered w-36 text-xs">
            <option value="">默认</option>
            <option value='"Microsoft YaHei", "PingFang SC", sans-serif'>微软雅黑</option>
            <option value='"SimHei", "Heiti SC", sans-serif'>黑体</option>
            <option value='"SimSun", "Songti SC", serif'>宋体</option>
            <option value='"KaiTi", "STKaiti", serif'>楷体</option>
            <option value='"FangSong", "STFangsong", serif'>仿宋</option>
            <option value='system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'>系统无衬线</option>
            <option value='"Georgia", "Times New Roman", serif'>西文衬线</option>
            <option value="__custom__">自定义…</option>
          </select>
          <input type="text" id="settings-font-family-custom" class="input input-xs input-bordered w-36 text-xs hidden"
            placeholder='字体名, 备选字体' value="" />
        </div>
      </div>

      <!-- 聊天气泡密度 (滑块) -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <div>
            <span class="text-sm font-medium">消息密度</span>
            <p class="text-xs text-base-content/40">消息之间的间距</p>
          </div>
          <span id="settings-density-label" class="badge badge-sm badge-outline">标准</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs opacity-50">紧凑</span>
          <input type="range" id="settings-density-slider" class="range range-xs flex-1"
            min="0" max="2" step="1" value="1" />
          <span class="text-xs opacity-50">宽松</span>
        </div>
      </div>

      <!-- 透明层边界：只有插图/聊天画布可透明 -->
      <div class="rounded p-3 text-xs bg-base-200">
        <div>
          <span class="font-medium">透明层说明</span>
          <p class="text-base-content/60 mt-1">弹窗、菜单与编辑器保持不透明，插图透明度在聊天背景设置调整。</p>
        </div>
      </div>

      <!-- 消息加载限制 (从右侧栏消息设置迁移) -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">消息加载数</span>
          <p class="text-xs text-base-content/40">限制DOM中加载的消息数（0=全部）</p>
        </div>
        <!-- T15-2：删静态 value="0"（与 JS 回填 DEFAULTS.messages.loadLimit=100 分叉）；初值由 :579 单源回填 -->
        <input type="number" id="msg-load-limit"
          class="input input-xs input-bordered w-20 font-mono text-xs"
          min="0" max="9999" step="50" title="0=不限制" />
      </div>

      <!-- 上下文消息数 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">上下文消息数</span>
          <p class="text-xs text-base-content/40">发送给AI的最大消息条数（0=全部）</p>
        </div>
        <input type="number" id="context-msg-limit"
          class="input input-xs input-bordered w-20 font-mono text-xs"
          min="0" max="9999" step="5" placeholder="后端默认" title="0=不限制" />
      </div>

      <!-- B27修复: 权限管理指向IDE控制面板 -->
      <div class="divider text-xs opacity-40">AI权限管理</div>
      <div class="text-xs text-base-content/60 bg-base-200 rounded p-3">
        <p class="font-medium mb-1"><i data-ic="lock"></i> AI文件处理能力</p>
        <p>AI的读取/写入/删除/命令执行权限在 <strong>IDE模式 → 控制面板</strong> 中管理。</p>
        <p class="mt-1">开启危险权限时会弹出风险提醒。</p>
      </div>
    </div>
  `;

  // 分类Tab切换
  slot.querySelectorAll(".beilu-cat-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      slot.querySelectorAll(".beilu-cat-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const cat = tab.dataset.cat;
      slot.querySelectorAll(".beilu-theme-grid").forEach(g => {
        g.style.display = g.dataset.cat === cat ? "" : "none";
      });
    });
  });

  // 主题切换 (基础 dark/light toggle)
  slot.querySelector("#settings-theme-toggle")?.addEventListener("change", (e) => {
    const theme = e.target.checked ? "dark" : "light";
    storage.set(KEYS.THEME, theme);
    const scheme = storage.get(KEYS.BEILU_COLOR_SCHEME);
    if (!scheme) {
      _clearImportedThemeOverrides();
      document.documentElement.dataset.theme = theme;
    }
  });

  // 配色方案选择器
  const themeGrid = slot.querySelector("#settings-theme-grid");
  const themeBadge = slot.querySelector("#settings-theme-badge");
  // 原始主题 hover 预览必须临时退出 Pro/imported；离开时精确恢复属性和 inline token。
  let originalPreviewState = null;
  themeGrid?.querySelectorAll("[data-theme-pick]").forEach((btn) => {
    btn.addEventListener("mouseenter", () => {
      const scheme = btn.dataset.themePick;
      const previewTheme = scheme === "default" ? resolveGlobalThemePreference(storage.get(KEYS.THEME)) : scheme;
      originalPreviewState = _beginThemePreview({ theme: previewTheme });
    });
    btn.addEventListener("mouseleave", () => {
      if (originalPreviewState) _restoreThemePreviewState(originalPreviewState);
      originalPreviewState = null;
    });
  });
  // Click持久化
  themeGrid?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-pick]");
    if (!btn) return;
    const scheme = btn.dataset.themePick;
    themeGrid.querySelectorAll("[data-theme-pick]").forEach(b => b.classList.remove("active"));
    enhancedGrid?.querySelectorAll("[data-enhanced-pick]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _clearImportedThemeOverrides();
    _clearEnhancedThemeState();
    storage.remove(KEYS.BEILU_IMPORTED_THEME);
    if (scheme === "default") {
      storage.remove(KEYS.BEILU_COLOR_SCHEME);
      document.documentElement.dataset.theme = resolveGlobalThemePreference(storage.get(KEYS.THEME));
      themeBadge.textContent = "跟随全局";
    } else {
      storage.set(KEYS.BEILU_COLOR_SCHEME, scheme);
      document.documentElement.dataset.theme = scheme;
      themeBadge.textContent = btn.dataset.themeLabel || scheme;
    }
    originalPreviewState = _captureThemePreviewState();
  });

  // UI优化主题选择器
  const enhancedGrid = slot.querySelector("#settings-theme-enhanced");
  let enhancedPreviewState = null;
  enhancedGrid?.querySelectorAll("[data-enhanced-pick]").forEach((btn) => {
    btn.addEventListener("mouseenter", () => {
      enhancedPreviewState = _beginThemePreview({
        theme: btn.dataset.enhancedBase,
        enhanced: btn.dataset.enhancedPick,
      });
    });
    btn.addEventListener("mouseleave", () => {
      if (enhancedPreviewState) _restoreThemePreviewState(enhancedPreviewState);
      enhancedPreviewState = null;
    });
  });
  enhancedGrid?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-enhanced-pick]");
    if (!btn) return;
    const eid = btn.dataset.enhancedPick;
    const ebase = btn.dataset.enhancedBase;
    // 清除原色active
    themeGrid?.querySelectorAll("[data-theme-pick]").forEach(b => b.classList.remove("active"));
    enhancedGrid.querySelectorAll("[data-enhanced-pick]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _clearImportedThemeOverrides();
    storage.set(KEYS.BEILU_COLOR_SCHEME, ebase);
    storage.set(KEYS.BEILU_ENHANCED_THEME, eid);
    storage.remove(KEYS.BEILU_IMPORTED_THEME);
    document.documentElement.dataset.theme = ebase;
    document.documentElement.dataset.beiluEnhanced = eid;
    themeBadge.textContent = btn.dataset.enhancedLabel || eid;
    enhancedPreviewState = _captureThemePreviewState();
  });

  // 美化主题导入——实现抽为模块级 importThemeFile（导入导出聚合面板直连复用，单源）
  slot.querySelector("#settings-theme-import")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      await importThemeFile(file);
    });
    input.click();
  });

  slot.querySelector("#settings-theme-export")?.addEventListener("click", () => exportCurrentTheme());

  // 主题恢复已在 initSettingsSlots 生命周期入口完成；slot 只同步可见徽标。
  const savedBeiluTheme = storage.get(KEYS.BEILU_IMPORTED_THEME);
  if (savedBeiluTheme) {
    try {
      const theme = JSON.parse(savedBeiluTheme);
      themeBadge.textContent = theme.name || "beilu-custom";
    } catch {
      themeBadge.textContent = "导入主题错误";
    }
  }

  // UI/content/mono 三条设置共用同一登记表、clamp 和 apply 入口。
  for (const spec of TYPOGRAPHY_SETTINGS) {
    _syncTypographyControl(spec, typographyValues[spec.role]);
    slot.querySelector(`#${spec.inputId}`)?.addEventListener("input", (event) => {
      _commitTypographySetting(spec, event.currentTarget.value);
    });
  }

  // 系统字体
  const fontFamilySelect = slot.querySelector("#settings-font-family");
  const fontFamilyCustom = slot.querySelector("#settings-font-family-custom");
  if (fontFamilySelect) {
    // 恢复已存值：匹配预设 option 或显示自定义输入框
    if (currentFontFamily) {
      const matched = Array.from(fontFamilySelect.options).find(o => o.value === currentFontFamily);
      if (matched) {
        fontFamilySelect.value = currentFontFamily;
      } else {
        fontFamilySelect.value = "__custom__";
        if (fontFamilyCustom) {
          fontFamilyCustom.value = currentFontFamily;
          fontFamilyCustom.classList.remove("hidden");
        }
      }
    }
    _applyFontFamilyPreference(currentFontFamily);
    fontFamilySelect.addEventListener("change", () => {
      const v = fontFamilySelect.value;
      if (v === "__custom__") {
        fontFamilyCustom?.classList.remove("hidden");
        fontFamilyCustom?.focus();
        return;
      }
      fontFamilyCustom?.classList.add("hidden");
      storage.set(KEYS.BEILU_FONT_FAMILY, v);
      _applyFontFamilyPreference(v);
    });
    fontFamilyCustom?.addEventListener("change", () => {
      const v = fontFamilyCustom.value.trim();
      storage.set(KEYS.BEILU_FONT_FAMILY, v);
      _applyFontFamilyPreference(v);
    });
  }

  // 消息密度 — 滑块版（0=compact, 1=normal, 2=cozy）
  const densitySlider = slot.querySelector("#settings-density-slider");
  const densityLabel = slot.querySelector("#settings-density-label");
  const DENSITY_MAP = ["compact", "normal", "cozy"];
  const DENSITY_LABELS = ["紧凑", "标准", "宽松"];
  const savedDensity = storage.get(KEYS.BEILU_MSG_DENSITY) || "normal";
  const savedIdx = Math.max(0, DENSITY_MAP.indexOf(savedDensity));
  document.body.dataset.msgDensity = savedDensity;
  if (densitySlider) {
    densitySlider.value = savedIdx;
    densityLabel.textContent = DENSITY_LABELS[savedIdx];
    densitySlider.addEventListener("input", () => {
      const idx = parseInt(densitySlider.value, 10);
      const val = DENSITY_MAP[idx] || "normal";
      densityLabel.textContent = DENSITY_LABELS[idx] || "标准";
      storage.set(KEYS.BEILU_MSG_DENSITY, val);
      document.body.dataset.msgDensity = val;
    });
  }

  // 消息加载数 — 同步到 featureControls 的 menu-msg-load-limit hidden input
  const msgLoadLimit = slot.querySelector("#msg-load-limit");
  if (msgLoadLimit) {
    const saved = storage.get(KEYS.BEILU_MSG_LOAD_LIMIT);
    msgLoadLimit.value = saved || String(DEFAULTS.messages.loadLimit); // P2：缺省单源
    msgLoadLimit.addEventListener("change", () => {
      // T5：唯一写点直连 featureControls.setMsgLoadLimit（0-1000 归一化+同步全部入口）。
      //   删原 else storage.set 直写——它无归一化能写出界外值=病2散写点；featureControls
      //   已由核心链静态加载，setMsgLoadLimit 恒可用，无需桥兜底。
      setMsgLoadLimit(msgLoadLimit.value);
    });
  }

  // 上下文消息数 — 同步到 featureControls 的 menu-context-msg-limit hidden input
  const ctxMsgLimit = slot.querySelector("#context-msg-limit");
  if (ctxMsgLimit) {
    const saved = storage.get(KEYS.BEILU_CONTEXT_MSG_LIMIT);
    // T6-C2: 删前端编造副本 "0"。此 slot 未拉 runtime params（纯 localStorage），
    // 无存值时留空由 placeholder="后端默认" 提示，后端 getRuntimeParams 恒回 context_msg_limit 兜底，前端不编造假值。
    ctxMsgLimit.value = saved ?? "";
    ctxMsgLimit.addEventListener("change", () => {
      // T5：删本 slot 的 storage.set 直写（无后端确认，与 featureControls:345「后端确认才落本地」分叉——
      //   后端拒绝时本地已被脏写，无法真回滚）。改为仅把值同步到 menu-context-msg-limit 并派发其 change，
      //   委托 featureControls 的确认式监听（syncRuntimeParams ok 才 storage.set，失败回读旧值）为唯一落本地写点。
      const v = String(parseInt(ctxMsgLimit.value, 10) || 0);
      const menuEl = document.getElementById("menu-context-msg-limit");
      if (menuEl) { menuEl.value = v; menuEl.dispatchEvent(new Event("change")); }
    });
  }

  // B27修复: 权限select已移除，权限管理在IDE控制面板的toggle开关
}

/**
 * 导入 beilu 主题文件。
 * 供本 section 与「导入导出」聚合面板（importExport.mjs 快速模式）共用，禁两处各持一份实现。
 * @param {File} file - 用户选择的 .json 主题文件（beilu_theme 格式）。
 */
export async function importThemeFile(file) {
  const themeBadge = document.getElementById("settings-theme-badge");
  try {
    const text = await file.text();
    const theme = JSON.parse(text);
    if (!theme.beilu_theme) { showToast("error", "无效的主题文件（需要 beilu_theme 格式）"); return; }
    const c = theme.colors || {};
    if (!c.amber) { showToast("error", "无效的beilu主题文件（缺少colors.amber）"); return; }
    _activateImportedTheme(theme, { persist: true });
    if (themeBadge) themeBadge.textContent = theme.name || "beilu-custom";
    showToast("success", `已导入beilu主题「${theme.name || "beilu-custom"}」`);
    // 动态 import 防静态环（见文件头登记）：主题已生效才记历史；历史上报失败不得把成功导入误报为失败，warn 可见
    try {
      const { recordImportHistory } = await import("../importExport.mjs");
      recordImportHistory("主题", theme.name || "beilu-custom");
    } catch (histErr) { console.warn("[uiSlot] 主题导入历史上报失败（导入本身已生效）:", histErr?.message); }
  } catch (e) { showToast("error", "主题导入失败: " + e.message); }
}

/**
 * 导出当前配色为 beilu 主题 JSON（读 computed CSS 变量，纯前端无后端请求）。
 * 导出格式与 importThemeFile beilu 格式对齐（beilu_theme + colors），导入→导出→再导入可还原。
 */
export function exportCurrentTheme() {
  const computed = getComputedStyle(document.documentElement);
  const colors = _collectThemeExportColors((cssVar) => computed.getPropertyValue(cssVar));
  const theme = { beilu_theme: true, name: "beilu-exported", colors };
  const blob = new Blob([JSON.stringify(theme, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "beilu-theme.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("success", "已导出当前配色");
}

/**
 * 恢复持久化主题状态的唯一 owner。无设置面板 DOM 依赖，可在启动 applyTheme 后、i18n 前调用。
 * @returns {{kind:string, scheme:string, enhanced:string|null, reason?:string, name?:string, error?:string}}
 */
export function restoreStoredThemeState() {
  const root = document.documentElement;
  const storedBaseTheme = storage.get(KEYS.THEME);
  const isRegisteredPalette = (scheme) => scheme !== "default" && _DAISY_THEMES.some((theme) => theme.id === scheme);
  const fallbackScheme = resolveGlobalThemePreference(storedBaseTheme);
  const savedScheme = storage.get(KEYS.BEILU_COLOR_SCHEME);
  const savedImportedTheme = storage.get(KEYS.BEILU_IMPORTED_THEME);
  const savedEnhancedTheme = storage.get(KEYS.BEILU_ENHANCED_THEME);

  if (savedImportedTheme) {
    try {
      const theme = JSON.parse(savedImportedTheme);
      _activateImportedTheme(theme);
      return Object.freeze({
        kind: "imported",
        scheme: IMPORTED_THEME_BASE,
        enhanced: null,
        name: theme.name || "beilu-custom",
      });
    } catch (error) {
      // 保留损坏的原文供用户修复/重新导入，但绝不把旧导入标记当作 palette id。
      _clearImportedThemeOverrides();
      _clearEnhancedThemeState();
      storage.set(KEYS.BEILU_COLOR_SCHEME, IMPORTED_THEME_BASE);
      root.dataset.theme = IMPORTED_THEME_BASE;
      console.error("[beilu-settings] 已保存的导入主题恢复失败:", error);
      return Object.freeze({
        kind: "invalid-imported",
        scheme: IMPORTED_THEME_BASE,
        enhanced: null,
        reason: "invalid-imported-theme",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  _clearImportedThemeOverrides();
  const enhancedDefinition = _ENHANCED_THEMES.find((theme) => theme.id === savedEnhancedTheme);
  if (enhancedDefinition && isRegisteredPalette(enhancedDefinition.base) && savedScheme === enhancedDefinition.base) {
    root.dataset.theme = enhancedDefinition.base;
    root.dataset.beiluEnhanced = enhancedDefinition.id;
    return Object.freeze({
      kind: "enhanced",
      scheme: enhancedDefinition.base,
      enhanced: enhancedDefinition.id,
    });
  }

  let reason;
  if (savedEnhancedTheme) {
    reason = enhancedDefinition ? "enhanced-scheme-mismatch" : "invalid-enhanced-theme";
    console.warn(`[beilu-settings] 增强主题 ${JSON.stringify(savedEnhancedTheme)} 与配色 ${JSON.stringify(savedScheme)} 不匹配，已退出 Pro skin`);
    _clearEnhancedThemeState();
  } else {
    root.removeAttribute("data-beilu-enhanced");
  }

  if (isRegisteredPalette(savedScheme)) {
    root.dataset.theme = savedScheme;
    return Object.freeze({ kind: "palette", scheme: savedScheme, enhanced: null, ...(reason ? { reason } : {}) });
  }

  if (savedScheme) {
    reason = "invalid-scheme";
    console.warn(`[beilu-settings] 配色 ${JSON.stringify(savedScheme)} 不是已登记 palette id，已恢复基础主题`);
    storage.remove(KEYS.BEILU_COLOR_SCHEME);
  }
  root.dataset.theme = fallbackScheme;
  return Object.freeze({ kind: "default", scheme: fallbackScheme, enhanced: null, ...(reason ? { reason } : {}) });
}

// 门面 initSettingsSlots 生命周期入口消费（原 settingsSlots._initTypographyPreferences 直调）
export { _initTypographyPreferences as initTypographyPreferences };
