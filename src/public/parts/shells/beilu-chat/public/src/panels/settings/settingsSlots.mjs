/**
 * settingsSlots.mjs — 设置面板各 slot 内容注入与交互绑定
 *
 * 功能链：
 *   initSettingsSlots() → 按序填充各 slot DOM：
 *   language slot → 语言切换（storage + 后端 /api/setusersetting + 页面刷新）
 *   ui slot → 主题/字体/宽度/渲染器等 UI 参数（localStorage）
 *   account slot → 用户列表（GET /api/users/list）+ 登录/切换
 *   remote slot → 网络信息（GET .../network-info）+ 远程访问设置
 *   pluginList slot → 已加载插件清单（getPartList，与 sidebar.mjs 同源）
 *   api slot → API 源配置（serviceSourceManage）+ 模型选择
 *   pluginConfig slot → 各插件配置项（beilu-memory / beilu-files 等）
 *   monitor slot → 白盒追踪开关 + getWhiteboxRing 查看
 *   fakeSend slot → fake-send 参数调试
 *
 * why：
 *   设置面板内容复杂、来源多样（后端 API + localStorage + 插件 config）；
 *   slot 模式让 HTML 结构稳定，各 slot 独立初始化，互不干扰、可按需懒加载；
 *   pluginList 与 sidebar.mjs 共用同一 getPartList 来源，保证显示一致性（A7）。
 *
 * 关联链：
 *   ← layout.mjs / index.mjs（initSettingsSlots 调用）
 *   → shared/transport/api-client.mjs（apiFetch：多个后端 API）
 *   → shared/state/storage.mjs（KEYS：localStorage 集中管理）
 *   → scripts/parts.mjs（getPartList：插件清单）
 *   → whitebox.mjs（getWhiteboxRing/setWhiteboxEnabled：追踪控制）
 *   → beiluDialog.mjs（beiluConfirm/beiluPrompt：危险操作确认）
 *
 * 影响范围：
 *   DOM：各 #settings-*-slot 节点内容（打开设置面板时注入）；
 *   localStorage：语言/UI 参数持久化；
 *   后端：账户切换/插件配置变更触发 API 调用。
 *
 * 使用效果：
 *   打开设置面板即可修改语言、主题、API 源、插件配置等全局参数；
 *   修改即时生效（部分需刷新页面，如语言切换）。
 */

import { escapeHtml, copyWithFeedback, whenVisible } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 复制✅反馈收口单源
import { DEFAULTS } from "../../config/defaults.mjs"; // P2：消息加载数缺省单源
import { setMsgLoadLimit } from "../feature/featureControls.mjs"; // T5：消息加载数唯一写点直连（含0-1000归一化+同步全部入口）；setThinkingFoldEnabled 已删（0720 硬化：思维链人类侧恒可见）
import { saveReasoningTags } from "../../shared/state/reasoningTags.mjs"; // 0714 思维链设定收口：标签保存链唯一写点（后端 functions:hide#setReasoningTags + 本地折叠镜像 + 重渲染）
import { getWhiteboxRing, setWhiteboxEnabled } from "../../shared/widgets/whitebox.mjs";
import diagControl from "../../shared/state/diagLogger.mjs"; // diag-export：前端 console 缓冲/快照读取口（getLogBuffer/getSnapshotBuffer）
import { apiFetch } from "../../shared/transport/api-client.mjs"; // R1: raw fetch → apiFetch（timeout+401；raw 保留 ok/body/credentials；外部 modelsUrl SKIP）
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b 批2
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { getPartList, getLoadedPartList, getAllCachedPartDetails } from "../../../../../../scripts/parts.mjs"; // A7: 插件清单/详情/加载态后端单源（GET /api/getlist|getallcacheddetails|getloadedlist /plugins），与 sidebar.mjs 同源
import { showToast } from "../../../../../../scripts/toast.mjs";
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { recordImportHistory } from "./importExport.mjs"; // T033：主题导入成功上报集中历史
import { loadChannels, modelsRequestFor } from "./apiChannels.mjs"; // 0711 渠道下拉恢复：渠道表单源（后端 PROVIDER_META）
import { getAvailableLangs, getCurrentLang, switchLang } from "../../shared/i18n.mjs"; // 覆盖式 i18n：语言 slot 的选项单源与唯一写点
import { initTranslations } from "../../../../../../scripts/i18n.mjs"; // fount 遗留链重翻入口（data-i18n 域,切语言时显式重拉,替代已删的整页 reload）

// ============================================================
// 语言设置 slot —— 覆盖式 i18n 消费方（0716 修复：旧实现写 beiluHomeLang（beilu-home 域键，
// 本壳零读方=死写）且选项硬编码 4 项、id(en-UK/ja-JP) 与覆盖式(en/ja) 不一致 → 切换无效。
// 现：选项 = shared/i18n.mjs getAvailableLangs()（locales/list.json 单源+中文本体），
// 写点 = switchLang()（beiluLang 唯一 owner，无刷新即时生效+派发 beilu-lang-change）。
// ============================================================

// fount 遗留 data-i18n（58处）读 userPreferredLanguages，其 locale id 为 en-UK/ja-JP 形制——继续同步写但做 id 映射
const FOUNT_LANG_MAP = { en: "en-UK", ja: "ja-JP" };

async function initLanguageSlot() {
  const slot = document.getElementById("settings-language-slot");
  if (!slot) return;

  const langs = await getAvailableLangs();
  const current = getCurrentLang();

  slot.innerHTML = `
    <div class="space-y-3 mt-2">
      <div class="flex items-center gap-3">
        <span class="text-sm font-medium">界面语言</span>
        <select id="settings-lang-select" class="select select-sm select-bordered w-40">
          ${langs.map(o =>
            `<option value="${o.id}" ${o.id === current ? "selected" : ""}>${o.name}</option>`
          ).join("")}
        </select>
      </div>
      <p class="text-xs text-base-content/50">切换后立即生效</p>
    </div>
  `;

  slot.querySelector("#settings-lang-select")?.addEventListener("change", async (e) => {
    const lang = e.target.value;
    await switchLang(lang); // 唯一写点：beiluLang + 覆盖/恢复 DOM + 派发 beilu-lang-change（wiki 同步刷新）
    localStorage.setItem("beiluLangChosen", "1");
    // fount 遗留链（data-i18n 58处 + chat.beiluChat.* 113键）：写 userPreferredLanguages 后必须重跑
    // initTranslations 才会重翻——旧实现靠整页 reload 达成，reload 已删，此处显式重拉（断链补接 0716）
    try { storage.set(KEYS.USERPREFERREDLANGUAGES, JSON.stringify([FOUNT_LANG_MAP[lang] || lang])); } catch {}
    initTranslations().catch(() => { /* fount 域翻不动不阻塞覆盖式主链 */ });
    sendAction({ verb: "setSetting", target: "server:user", source: "web", payload: { key: "language", value: lang } }).catch(() => {});
  });

  // 其他入口（首次登录选择层等）切语言时同步本下拉选中态
  window.addEventListener("beilu-lang-change", (e) => {
    const sel = slot.querySelector("#settings-lang-select");
    const lang = e.detail?.lang;
    if (sel && lang && [...sel.options].some(o => o.value === lang)) sel.value = lang;
  });
}

// ============================================================
// 界面设置 slot
// ============================================================

const _DAISY_THEMES = [
  // group: "dark" | "light" | "vivid" — 用于分组显示
  { id: "default", label: "默认", dark: true, group: "dark" },
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
  { id: "cyberpunk", label: "赛博朋克 Pro", base: "cyberpunk", desc: "CP2077风" },
  { id: "night", label: "夜空 Pro", base: "night", desc: "P3R水下蓝" },
  { id: "valentine", label: "情人节 Pro", base: "valentine", desc: "柔粉圆点" },
  { id: "bumblebee", label: "蜜蜂 Pro", base: "bumblebee", desc: "暖蜜斜线" },
  { id: "synthwave", label: "合成波 Pro", base: "synthwave", desc: "霓虹网格" },
  { id: "acid", label: "迷幻 Pro", base: "acid", desc: "荧光网点" },
  { id: "lemonade", label: "柠檬水 Pro", base: "lemonade", desc: "清新波纹" },
  { id: "aqua", label: "水蓝 Pro", base: "aqua", desc: "深海金琥珀" },
];

function _buildEnhancedGrid(currentEnhanced) {
  let html = "";
  for (const t of _ENHANCED_THEMES) {
    const active = t.id === currentEnhanced;
    const cls = active ? "theme-btn active" : "theme-btn";
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
  if (!schemeId || schemeId === "default") return "默认";
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

/** 清除 :root inline style 上的 --beilu-amber* 变量，让 CSS per-theme 规则生效 */
function _clearInlineAmber() {
  const root = document.documentElement;
  root.style.removeProperty("--beilu-amber");
  root.style.removeProperty("--beilu-amber-text");
  root.style.removeProperty("--beilu-amber-rgb");
  // 也清除其他 beilu 色变量的 inline 覆盖
  const otherVars = [
    "--beilu-accent", "--beilu-accent-text",
    "--beilu-error", "--beilu-error-text",
    "--beilu-success", "--beilu-warning",
    "--beilu-bg-dark", "--beilu-bg-card",
    "--beilu-text-dim", "--beilu-border-subtle", "--beilu-bg-hover",
    "--beilu-user-msg-bg", "--beilu-bot-msg-bg",
  ];
  for (const v of otherVars) {
    root.style.removeProperty(v);
  }
}

/** amber hex → 设置 --beilu-amber-rgb，CSS自动派生21档alpha */
function _deriveAmberAlphas(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  document.documentElement.style.setProperty("--beilu-amber-rgb", `${r}, ${g}, ${b}`);
}

function initUiSlot() {
  const slot = document.getElementById("settings-ui-slot");
  if (!slot) return;

  const currentTheme = storage.get(KEYS.THEME) || "dark";
  const currentFontSize = storage.get(KEYS.BEILU_FONT_SIZE) || "14";
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

      <!-- 字体大小 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">字体大小</span>
          <p class="text-xs text-base-content/40">聊天消息的文字大小</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="range" id="settings-font-size" class="range range-xs w-24"
            min="12" max="20" step="1" value="${currentFontSize}" />
          <span id="settings-font-size-label" class="text-xs font-mono w-8">${currentFontSize}px</span>
        </div>
      </div>

      <!-- 系统字体 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">系统字体</span>
          <p class="text-xs text-base-content/40">界面使用的字体</p>
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

      <!-- 弹窗背景色 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">弹窗背景色</span>
          <p class="text-xs text-base-content/40">设置/编辑弹窗的背景颜色</p>
        </div>
        <input type="color" id="settings-modal-bg" class="w-10 h-8 rounded cursor-pointer border-none"
          value="${storage.get(KEYS.BEILU_MODAL_BG) || '#1d1b2e'}" />
      </div>

      <!-- 弹窗透明度 -->
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium">弹窗透明度</span>
          <p class="text-xs text-base-content/40">1=完全不透明，0.5=半透明</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="range" id="settings-modal-opacity" class="range range-xs w-24"
            min="0.5" max="1" step="0.05" value="${storage.get(KEYS.BEILU_MODAL_OPACITY) || '1'}" />
          <span id="settings-modal-opacity-label" class="text-xs font-mono w-8">${storage.get(KEYS.BEILU_MODAL_OPACITY) || '1'}</span>
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
      _clearInlineAmber();
      document.documentElement.dataset.theme = theme;
    }
  });

  // 配色方案选择器
  const themeGrid = slot.querySelector("#settings-theme-grid");
  const themeBadge = slot.querySelector("#settings-theme-badge");
  // Hover预览：mouseenter临时切换html[data-theme]，mouseleave还原
  let _savedTheme = document.documentElement.dataset.theme || "";
  themeGrid?.addEventListener("mouseenter", (e) => {
    const btn = e.target.closest("[data-theme-pick]");
    if (!btn) return;
    _savedTheme = document.documentElement.dataset.theme || "";
    const preview = btn.dataset.themePick;
    if (preview && preview !== "default") {
      document.documentElement.dataset.theme = preview;
    }
  }, true);
  themeGrid?.addEventListener("mouseleave", (e) => {
    const btn = e.target.closest("[data-theme-pick]");
    if (!btn) return;
    // 还原到持久化的主题
    const saved = storage.get(KEYS.BEILU_COLOR_SCHEME) || storage.get(KEYS.THEME) || "dark";
    document.documentElement.dataset.theme = saved;
  }, true);
  // Click持久化
  themeGrid?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-pick]");
    if (!btn) return;
    const scheme = btn.dataset.themePick;
    themeGrid.querySelectorAll("[data-theme-pick]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _clearInlineAmber();
    if (scheme === "default") {
      storage.remove(KEYS.BEILU_COLOR_SCHEME);
      storage.remove(KEYS.BEILU_IMPORTED_THEME);
      document.documentElement.dataset.theme = storage.get(KEYS.THEME) || "dark";
      themeBadge.textContent = "默认";
    } else {
      storage.set(KEYS.BEILU_COLOR_SCHEME, scheme);
      storage.remove(KEYS.BEILU_IMPORTED_THEME);
      storage.remove(KEYS.BEILU_ENHANCED_THEME);
      delete document.documentElement.dataset.beiluEnhanced;
      document.documentElement.dataset.theme = scheme;
      themeBadge.textContent = btn.dataset.themeLabel || scheme;
    }
  });

  // UI优化主题选择器
  const enhancedGrid = slot.querySelector("#settings-theme-enhanced");
  enhancedGrid?.addEventListener("mouseenter", (e) => {
    const btn = e.target.closest("[data-enhanced-pick]");
    if (!btn) return;
    _savedTheme = document.documentElement.dataset.theme || "";
    document.documentElement.dataset.theme = btn.dataset.enhancedBase;
    document.documentElement.dataset.beiluEnhanced = btn.dataset.enhancedPick;
  }, true);
  enhancedGrid?.addEventListener("mouseleave", (e) => {
    const btn = e.target.closest("[data-enhanced-pick]");
    if (!btn) return;
    const savedEnhanced = storage.get(KEYS.BEILU_ENHANCED_THEME);
    if (savedEnhanced) {
      const et = _ENHANCED_THEMES.find(t => t.id === savedEnhanced);
      document.documentElement.dataset.theme = et ? et.base : _savedTheme;
      document.documentElement.dataset.beiluEnhanced = savedEnhanced;
    } else {
      const saved = storage.get(KEYS.BEILU_COLOR_SCHEME) || storage.get(KEYS.THEME) || "dark";
      document.documentElement.dataset.theme = saved;
      delete document.documentElement.dataset.beiluEnhanced;
    }
  }, true);
  enhancedGrid?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-enhanced-pick]");
    if (!btn) return;
    const eid = btn.dataset.enhancedPick;
    const ebase = btn.dataset.enhancedBase;
    // 清除原色active
    themeGrid?.querySelectorAll("[data-theme-pick]").forEach(b => b.classList.remove("active"));
    enhancedGrid.querySelectorAll("[data-enhanced-pick]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _clearInlineAmber();
    storage.set(KEYS.BEILU_COLOR_SCHEME, ebase);
    storage.set(KEYS.BEILU_ENHANCED_THEME, eid);
    storage.remove(KEYS.BEILU_IMPORTED_THEME);
    document.documentElement.dataset.theme = ebase;
    document.documentElement.dataset.beiluEnhanced = eid;
    themeBadge.textContent = btn.dataset.enhancedLabel || eid;
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

  // 恢复已导入的 beilu 主题
  const savedColorScheme = storage.get(KEYS.BEILU_COLOR_SCHEME) || "";
  if (savedColorScheme.startsWith("imported:")) {
    const savedBeiluTheme = storage.get(KEYS.BEILU_IMPORTED_THEME);
    if (savedBeiluTheme) {
      try {
        const theme = JSON.parse(savedBeiluTheme);
        if (theme.beilu_theme && theme.colors) {
          const c = theme.colors;
          const root = document.documentElement;
          if (c.amber) {
            root.style.setProperty("--beilu-amber", c.amber);
            _deriveAmberAlphas(c.amber);
          }
          if (c.amber_text) root.style.setProperty("--beilu-amber-text", c.amber_text);
          const BEILU_COLOR_MAP = {
            amber: "--beilu-amber",
            amber_text: "--beilu-amber-text",
            accent: "--beilu-accent",
            accent_text: "--beilu-accent-text",
            error: "--beilu-error",
            success: "--beilu-success",
            warning: "--beilu-warning",
            bg_dark: "--beilu-bg-dark",
            bg_card: "--beilu-bg-card",
            modal_bg: "--beilu-modal-bg",
            text_dim: "--beilu-text-dim",
            border_subtle: "--beilu-border-subtle",
            bg_hover: "--beilu-bg-hover",
            user_msg_bg: "--beilu-user-msg-bg",
            bot_msg_bg: "--beilu-bot-msg-bg",
          };
          for (const [key, cssVar] of Object.entries(BEILU_COLOR_MAP)) {
            if (c[key]) root.style.setProperty(cssVar, c[key]);
          }
        }
      } catch { /* corrupted JSON */ }
    }
  }

  // 字体大小 — B4修复：同时设置两个CSS变量 + 加载时恢复
  const fontRange = slot.querySelector("#settings-font-size");
  const fontLabel = slot.querySelector("#settings-font-size-label");
  const applyFontSize = (size) => {
    document.documentElement.style.setProperty("--chat-font-size", size + "px");
    document.documentElement.style.setProperty("--beilu-font-size", size + "px");
  };
  // 加载时立即恢复
  applyFontSize(currentFontSize);
  fontRange?.addEventListener("input", () => {
    const size = fontRange.value;
    fontLabel.textContent = size + "px";
    storage.set(KEYS.BEILU_FONT_SIZE, size);
    applyFontSize(size);
  });

  // 系统字体
  const fontFamilySelect = slot.querySelector("#settings-font-family");
  const fontFamilyCustom = slot.querySelector("#settings-font-family-custom");
  const applyFontFamily = (val) => {
    if (val) {
      document.documentElement.style.setProperty("--beilu-font-family", val);
    } else {
      document.documentElement.style.removeProperty("--beilu-font-family");
    }
  };
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
    applyFontFamily(currentFontFamily);
    fontFamilySelect.addEventListener("change", () => {
      const v = fontFamilySelect.value;
      if (v === "__custom__") {
        fontFamilyCustom?.classList.remove("hidden");
        fontFamilyCustom?.focus();
        return;
      }
      fontFamilyCustom?.classList.add("hidden");
      storage.set(KEYS.BEILU_FONT_FAMILY, v);
      applyFontFamily(v);
    });
    fontFamilyCustom?.addEventListener("change", () => {
      const v = fontFamilyCustom.value.trim();
      storage.set(KEYS.BEILU_FONT_FAMILY, v);
      applyFontFamily(v);
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

  // 弹窗背景色
  const modalBgPicker = slot.querySelector("#settings-modal-bg");
  modalBgPicker?.addEventListener("input", () => {
    document.documentElement.style.setProperty("--beilu-modal-bg", modalBgPicker.value);
    storage.set(KEYS.BEILU_MODAL_BG, modalBgPicker.value);
  });

  // 弹窗透明度
  const modalOpacity = slot.querySelector("#settings-modal-opacity");
  const modalOpacityLabel = slot.querySelector("#settings-modal-opacity-label");
  modalOpacity?.addEventListener("input", () => {
    const v = modalOpacity.value;
    document.documentElement.style.setProperty("--beilu-modal-opacity", v);
    storage.set(KEYS.BEILU_MODAL_OPACITY, v);
    if (modalOpacityLabel) modalOpacityLabel.textContent = v;
  });

  // 加载时恢复弹窗设置
  const savedModalBg = storage.get(KEYS.BEILU_MODAL_BG);
  if (savedModalBg) document.documentElement.style.setProperty("--beilu-modal-bg", savedModalBg);
  const savedModalOpacity = storage.get(KEYS.BEILU_MODAL_OPACITY);
  if (savedModalOpacity) document.documentElement.style.setProperty("--beilu-modal-opacity", savedModalOpacity);

  // B27修复: 权限select已移除，权限管理在IDE控制面板的toggle开关
}

// ============================================================
// 用户账号 slot
// ============================================================

async function initAccountSlot() {
  const slot = document.getElementById("settings-account-slot");
  if (!slot) return;

  slot.innerHTML = '<div class="text-sm text-base-content/50 mt-2">加载中...</div>';

  try {
    const resp = await apiFetch("/api/users/list", { raw: true });
    const data = await resp.json();
    const users = data.users || [];

    let currentUser = "未知";
    let currentIsOwner = false;
    try {
      const whoRes = await apiFetch("/api/whoami", { headers: { Accept: "application/json" }, raw: true });
      if (whoRes.ok) {
        const who = await whoRes.json();
        currentUser = who.username || who.name || "未知";
        currentIsOwner = !!who.isOwner;
      }
    } catch {}

    slot.innerHTML = `
      <div class="space-y-4 mt-2">
        <!-- 当前用户 -->
        <div class="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
          <div class="avatar placeholder">
            <div class="bg-primary text-primary-content rounded-full w-10">
              <span class="text-lg"><i data-ic="person"></i></span>
            </div>
          </div>
          <div class="flex-1">
            <div class="font-bold text-sm">${escapeHtml(currentUser)} ${currentIsOwner ? '<span class="badge badge-xs badge-info">管理员</span>' : ''}</div>
            <div class="text-xs text-base-content/50">当前登录账号</div>
          </div>
          <button class="btn btn-xs btn-outline" id="settings-switch-user">切换</button>
        </div>

        <!-- 用户列表 -->
        <div>
          <h4 class="text-sm font-medium mb-2">已注册账号 (${users.length})</h4>
          <div class="space-y-1" id="settings-user-list">
            ${users.map(u => {
              const name = u.username || u.name || u;
              const isCurrent = name === currentUser;
              const _en = escapeHtml(name);
              return `<div class="flex items-center justify-between p-2 rounded hover:bg-base-200 text-sm" ${isCurrent ? 'style="background:var(--beilu-amber-10)"' : ''}>
                <span><i data-ic="person"></i> ${_en} ${isCurrent ? '<span class="badge badge-xs badge-warning">当前</span>' : ''}</span>
                <div class="flex gap-1">
                  ${currentIsOwner && !isCurrent ? `<button class="btn btn-xs btn-ghost user-reset-pwd-btn" data-user="${_en}" title="重置密码"><i data-ic="key"></i></button>` : ''}
                  ${currentIsOwner && !isCurrent ? `<button class="btn btn-xs btn-ghost user-rename-btn" data-user="${_en}" title="重命名"><i data-ic="edit"></i></button>` : ''}
                  ${currentIsOwner && !isCurrent ? `<button class="btn btn-xs btn-ghost btn-error user-delete-btn" data-user="${_en}" title="删除此用户"><i data-ic="trash"></i></button>` : ''}
                  <button class="btn btn-xs btn-ghost user-login-btn" data-user="${_en}" ${isCurrent ? 'disabled' : ''}>登录</button>
                </div>
              </div>`;
            }).join("") || '<div class="text-xs text-base-content/40">暂无用户</div>'}
          </div>
        </div>

        <!-- 修改密码 -->
        <details class="collapse collapse-arrow bg-base-200 rounded-lg" id="acc-change-pw">
          <summary class="collapse-title text-sm font-medium min-h-0 py-2 px-3"><i data-ic="key"></i> 修改密码</summary>
          <div class="collapse-content px-3 pb-3 space-y-2">
            <input type="password" placeholder="当前密码（无密码留空）" class="input input-xs input-bordered w-full" id="acc-cur-pwd" autocomplete="current-password">
            <input type="password" placeholder="新密码" class="input input-xs input-bordered w-full" id="acc-new-pwd" autocomplete="new-password">
            <input type="password" placeholder="确认新密码" class="input input-xs input-bordered w-full" id="acc-confirm-pwd" autocomplete="new-password">
            <button class="btn btn-xs btn-primary w-full" id="acc-change-pwd-btn">修改密码</button>
          </div>
        </details>

        <!-- 安全问题（密码找回） -->
        <details class="collapse collapse-arrow bg-base-200 rounded-lg" id="acc-security-q">
          <summary class="collapse-title text-sm font-medium min-h-0 py-2 px-3"><i data-ic="shield"></i> 安全问题（找回密码用）</summary>
          <div class="collapse-content px-3 pb-3 space-y-2">
            <p class="text-xs text-base-content/50">设置 3 个安全问题，忘记密码时可通过回答问题重置。</p>
            <div id="acc-sq-fields"></div>
            <input type="password" placeholder="当前密码确认（无密码留空）" class="input input-xs input-bordered w-full" id="acc-sq-pwd" autocomplete="current-password">
            <button class="btn btn-xs btn-primary w-full" id="acc-sq-save-btn">保存安全问题</button>
          </div>
        </details>

        <!-- 删除当前账号 -->
        <details class="collapse collapse-arrow bg-error/10 rounded-lg border border-error/30" id="acc-delete-self">
          <summary class="collapse-title text-sm font-medium min-h-0 py-2 px-3 text-error"><i data-ic="warning"></i> 删除当前账号</summary>
          <div class="collapse-content px-3 pb-3 space-y-2">
            <p class="text-xs text-error/80">此操作将删除账号「${escapeHtml(currentUser)}」的所有数据。用户文件将移入回收站。</p>
            <input type="password" placeholder="输入密码确认（无密码留空）" class="input input-xs input-bordered w-full" id="acc-del-pwd" autocomplete="current-password">
            <label class="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" class="checkbox checkbox-xs checkbox-error" id="acc-del-purge">
              <span>完全清除（不留任何配置痕迹，API密钥等记录一并永久删除）</span>
            </label>
            <button class="btn btn-xs btn-error w-full" id="acc-delete-self-btn">确认删除账号</button>
          </div>
        </details>
      </div>
    `;

    // 切换用户 → 先真登出再跳登录页（六域纠察断链修，凛倾0706「登录」域）：
    //   原实现只跳转，access(1d)/refresh(30d) token 全留=用户以为退出实际会话未撤（安全面）。
    //   后端 POST /api/logout（server/web_server/endpoints.mjs 路由→auth.logout 撤token+清cookie）完整可用，
    //   此前全前端零调用点=纯接线断链。登出失败也照跳（跳转是主语义，撤销尽力而为，失败console可见）。
    slot.querySelector("#settings-switch-user")?.addEventListener("click", async () => {
      try { await apiFetch("/api/logout", { method: "POST", raw: true }); } catch (e) { console.warn("[settings] 登出请求失败(仍跳转):", e?.message || e); }
      // 20260706 删号传导链修同批：登出=确定无会话，直达 /login/ 不绕 '/'（同 account_deleted 语义）
      window.location.href = "/login/";
    });

    // 用户列表登录按钮
    slot.querySelectorAll(".user-login-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const username = btn.dataset.user;
        const pwd = await beiluPrompt(`输入 ${username} 的密码（无密码直接确认）:`, "");
        if (pwd === null) return;
        try {
          const deviceid = storage.get(KEYS.BEILU_DEVICE_ID) || crypto.randomUUID();
          storage.set(KEYS.BEILU_DEVICE_ID, deviceid);
          const res = await apiFetch("/api/login", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password: pwd, deviceid }),
          });
          if (res.ok) {
            window.location.reload();
          } else {
            const err = await res.json().catch(() => ({}));
            showToast("error", "登录失败: " + (err.message || err.error || res.status));
          }
        } catch (e) {
          showToast("error", "登录失败: " + e.message);
        }
      });
    });

    // 管理员：重置他人密码
    slot.querySelectorAll(".user-reset-pwd-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.user;
        const newPwd = await beiluPrompt(`为用户「${target}」设置新密码:`, "");
        if (newPwd === null || !newPwd.trim()) return;
        try {
          const res = await apiFetch("/api/users/admin-reset-password", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUsername: target, newPassword: newPwd }),
          });
          const result = await res.json().catch(() => ({}));
          if (res.ok && result.success) showToast("success", `已重置「${target}」的密码`);
          else showToast("error", result.message || "重置失败");
        } catch (e) { showToast("error", "重置失败: " + e.message); }
      });
    });

    // 管理员：重命名用户
    slot.querySelectorAll(".user-rename-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.user;
        const newName = await beiluPrompt(`将「${target}」重命名为:`, target);
        if (newName === null || !newName.trim() || newName.trim() === target) return;
        const pwd = await beiluPrompt("输入你（管理员）的密码确认:", "");
        if (pwd === null) return;
        try {
          const res = await apiFetch("/api/users/rename", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newUsername: newName.trim(), password: pwd, targetUsername: target }),
          });
          const result = await res.json().catch(() => ({}));
          if (res.ok && result.success) { showToast("success", `已重命名为「${newName.trim()}」`); initAccountSlot(); }
          else showToast("error", result.message || "重命名失败");
        } catch (e) { showToast("error", "重命名失败: " + e.message); }
      });
    });

    // 用户列表删除按钮（删别人，需要 owner 权限，后端校验）
    slot.querySelectorAll(".user-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.user;
        if (!await beiluConfirm(`确定删除用户「${target}」？\n该用户的文件将移入回收站。`)) return;
        const pwd = await beiluPrompt("输入你（当前登录者）的密码确认:", "");
        if (pwd === null) return;
        // 文案对齐行为(20260706)：API密钥两种选择下都失效(auth.mjs deleteUserAccount 无条件清全局 apiKeys 表)，可恢复的只有用户文件(回收站)
        const purge = await beiluConfirm("是否完全清除该用户的配置痕迹？\n\n选「确定」= 完全清除不留痕\n选「取消」= 用户文件移入回收站（可恢复）\n\n注意：无论选哪个，该用户的 API 密钥与登录会话都会立即失效。");
        try {
          const res = await apiFetch("/api/users/delete-account", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pwd, targetUsername: target, purgeConfig: purge }),
          });
          const result = await res.json().catch(() => ({}));
          if (res.ok && result.success) {
            showToast("success", `用户「${target}」已删除`);
            initAccountSlot();
          } else {
            showToast("error", result.message || "删除失败");
          }
        } catch (e) {
          showToast("error", "删除失败: " + e.message);
        }
      });
    });

    // 修改密码
    slot.querySelector("#acc-change-pwd-btn")?.addEventListener("click", async () => {
      const curPwd = slot.querySelector("#acc-cur-pwd")?.value || "";
      const newPwd = slot.querySelector("#acc-new-pwd")?.value || "";
      const confirmPwd = slot.querySelector("#acc-confirm-pwd")?.value || "";
      if (!newPwd) return showToast("error", "请输入新密码");
      if (newPwd !== confirmPwd) return showToast("error", "两次输入的新密码不一致");
      try {
        const res = await apiFetch("/api/users/change-password", {
          method: "POST", raw: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast("success", "密码修改成功");
          slot.querySelector("#acc-cur-pwd").value = "";
          slot.querySelector("#acc-new-pwd").value = "";
          slot.querySelector("#acc-confirm-pwd").value = "";
          slot.querySelector("#acc-change-pw").removeAttribute("open");
        } else {
          showToast("error", result.message || "密码修改失败");
        }
      } catch (e) {
        showToast("error", "密码修改失败: " + e.message);
      }
    });

    // 安全问题 UI 初始化
    const PRESET_QUESTIONS = [
      "你的第一只宠物叫什么？",
      "你小时候最好的朋友叫什么？",
      "你的出生城市？",
      "你母亲的名字？",
      "你最喜欢的老师叫什么？",
      "你的第一所学校叫什么？",
      "你最喜欢的电影？",
      "你童年的昵称？",
    ];
    const sqFields = slot.querySelector("#acc-sq-fields");
    if (sqFields) {
      let existingQs = [];
      try {
        const r = await apiFetch(`/api/users/security-questions/get/${encodeURIComponent(currentUser)}`, { raw: true });
        const d = await r.json();
        if (d.success && d.questions?.length) existingQs = d.questions;
      } catch {}
      sqFields.innerHTML = [0, 1, 2].map(i => {
        const eq = existingQs[i];
        const opts = PRESET_QUESTIONS.map(q => `<option value="${escapeHtml(q)}" ${eq?.question === q ? 'selected' : ''}>${escapeHtml(q)}</option>`).join('');
        return `<div class="space-y-1 mb-2">
          <label class="text-xs font-medium text-base-content/60">问题 ${i + 1}</label>
          <select class="select select-xs select-bordered w-full acc-sq-question" data-idx="${i}">
            <option value="">选择预置问题或自定义…</option>
            ${opts}
            <option value="__custom__" ${eq && !PRESET_QUESTIONS.includes(eq.question) ? 'selected' : ''}>自定义问题</option>
          </select>
          <input type="text" class="input input-xs input-bordered w-full acc-sq-custom-q" data-idx="${i}" placeholder="输入自定义问题" style="display:${eq && !PRESET_QUESTIONS.includes(eq.question) ? 'block' : 'none'}" value="${eq && !PRESET_QUESTIONS.includes(eq.question) ? escapeHtml(eq.question) : ''}">
          <input type="text" class="input input-xs input-bordered w-full acc-sq-answer" data-idx="${i}" placeholder="输入答案（不区分大小写）" autocomplete="off">
        </div>`;
      }).join('');
      sqFields.querySelectorAll(".acc-sq-question").forEach(sel => {
        sel.addEventListener("change", () => {
          const custom = sel.closest("div").querySelector(".acc-sq-custom-q");
          custom.style.display = sel.value === "__custom__" ? "block" : "none";
        });
      });
    }

    slot.querySelector("#acc-sq-save-btn")?.addEventListener("click", async () => {
      const questions = [0, 1, 2].map(i => {
        const sel = sqFields.querySelector(`.acc-sq-question[data-idx="${i}"]`);
        const customInput = sqFields.querySelector(`.acc-sq-custom-q[data-idx="${i}"]`);
        const ansInput = sqFields.querySelector(`.acc-sq-answer[data-idx="${i}"]`);
        const question = sel.value === "__custom__" ? customInput.value.trim() : sel.value;
        return { questionId: `q${i}`, question, answer: ansInput?.value || "" };
      });
      if (questions.some(q => !q.question || !q.answer)) return showToast("error", "请填写所有问题和答案");
      const pwd = slot.querySelector("#acc-sq-pwd")?.value || "";
      try {
        const res = await apiFetch("/api/users/security-questions/set", {
          method: "POST", raw: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, questions }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast("success", "安全问题已保存");
          slot.querySelector("#acc-security-q")?.removeAttribute("open");
          sqFields.querySelectorAll(".acc-sq-answer").forEach(el => { el.value = ""; });
          slot.querySelector("#acc-sq-pwd").value = "";
        } else {
          showToast("error", result.message || "保存失败");
        }
      } catch (e) {
        showToast("error", "保存失败: " + e.message);
      }
    });

    // 删除当前账号
    slot.querySelector("#acc-delete-self-btn")?.addEventListener("click", async () => {
      const pwd = slot.querySelector("#acc-del-pwd")?.value || "";
      const purge = slot.querySelector("#acc-del-purge")?.checked || false;
      // 文案对齐行为(20260706)：API密钥无论是否勾选"完全清除"都会失效，可从回收站恢复的只有用户文件
      if (!await beiluConfirm(`确定要永久删除账号「${currentUser}」？\n\n用户文件将移入回收站（可恢复）。\n${purge ? "配置痕迹将被完全清除，不留任何可恢复数据。" : "重新注册同名账号后，可从回收站还原用户文件。"}\nAPI 密钥与登录会话将立即失效。`)) return;
      try {
        const res = await apiFetch("/api/users/delete-account", {
          method: "POST", raw: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, purgeConfig: purge }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast("success", "账号已删除，正在跳转...");
          // 20260706 删号传导链修：直达 /login/ 不绕 '/'（响应已 clearCookie=确定无会话，同 account_deleted 事件语义）
          setTimeout(() => { window.location.href = "/login/"; }, 1500);
        } else {
          showToast("error", result.message || "删除失败");
        }
      } catch (e) {
        showToast("error", "删除失败: " + e.message);
      }
    });
  } catch {
    slot.innerHTML = '<div class="text-sm text-error mt-2">加载用户列表失败</div>';
  }
}

// ============================================================
// 远程访问 slot
// ============================================================

async function initRemoteSlot() {
  const slot = document.getElementById("settings-remote-slot");
  if (!slot) return;

  slot.innerHTML = '<div class="text-sm text-base-content/50 mt-2">获取网络信息...</div>';

  try {
    const resp = await apiFetch("/api/parts/shells:chat/network-info", { raw: true });
    const data = await resp.json();
    const port = data.port || location.port || 1314;
    const ips = data.ips || [];

    const addresses = ips.map(ip => `http://${ip.address}:${port}`);

    slot.innerHTML = `
      <div class="space-y-4 mt-2">
        <div class="p-3 bg-base-200 rounded-lg">
          <h4 class="text-sm font-medium mb-2">局域网访问地址</h4>
          <div class="space-y-2">
            ${addresses.length > 0 ? addresses.map(addr => `
              <div class="flex items-center justify-between gap-2 p-2 bg-base-100 rounded">
                <code class="text-xs font-mono flex-1 truncate">${addr}</code>
                <button class="btn btn-xs btn-ghost remote-copy-btn" data-url="${addr}" title="复制">📋</button>
              </div>
            `).join("") : '<p class="text-xs text-base-content/40">未检测到局域网地址</p>'}
          </div>
          <p class="text-xs text-base-content/40 mt-2">在同一局域网的设备上打开以上地址即可访问</p>
        </div>

        <div class="p-3 bg-base-200 rounded-lg">
          <h4 class="text-sm font-medium mb-2">手机扫码连接</h4>
          <p class="text-xs text-base-content/40">使用手机浏览器扫描二维码，即可在手机上使用 always accompany</p>
          <div id="settings-qrcode" class="flex justify-center mt-2">
            ${addresses.length > 0
              ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(addresses[0])}"
                   alt="QR Code" class="rounded-lg" width="160" height="160" />`
              : '<p class="text-xs text-base-content/40">无可用地址</p>'}
          </div>
        </div>
      </div>
    `;

    // 复制按钮
    slot.querySelectorAll(".remote-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => copyWithFeedback(btn.dataset.url, btn, "✅"));
    });
  } catch {
    slot.innerHTML = '<div class="text-sm text-error mt-2">获取网络信息失败</div>';
  }
}

// ============================================================
// 导出：统一初始化
// ============================================================

// ============================================================
// 插件列表 slot (W46新增: 替代iframe)
// ============================================================

// A7: 插件 icon / 中文 desc 仅为纯 UI 文案（只存前端，不入后端单源），保留为元数据映射。
// 渲染源真相 = 后端 getPartList('plugins')（已安装插件目录全集），后端新增插件自动出现；
// 映射里没有的插件用兜底 icon/desc 渲染。不再写死插件数量，三方数字不一致(代码15/注释16/历史17)问题随动态化消除。
const PLUGIN_META = {
  "beilu-memory": { icon: '<i data-ic="brain"></i>', desc: "记忆系统核心" },
  "beilu-preset": { icon: '<i data-ic="clipboard"></i>', desc: "预设引擎" },
  "beilu-worldbook": { icon: '<i data-ic="book"></i>', desc: "世界书注入" },
  "beilu-mvu": { icon: '<i data-ic="chart"></i>', desc: "MVU变量系统" },
  "beilu-files": { icon: '<i data-ic="folder"></i>', desc: "文件操作沙箱" },
  "beilu-web": { icon: '<i data-ic="earth"></i>', desc: "联网搜索/浏览" },
  "beilu-plugin-host": { icon: '<i data-ic="plug"></i>', desc: "用户外部插件" },
  "beilu-eye": { icon: '<i data-ic="camera"></i>', desc: "桌面截图" },
  "beilu-toggle": { icon: '<i data-ic="shuffle"></i>', desc: "AI条目控制" },
  "beilu-sysinfo": { icon: '<i data-ic="info"></i>', desc: "系统信息注入" },
  "beilu-vectordb": { icon: '<i data-ic="search"></i>', desc: "向量搜索" },
  "beilu-ejs": { icon: '<i data-ic="edit"></i>', desc: "EJS模板渲染" },
  "beilu-regex": { icon: '<i data-ic="scissors"></i>', desc: "正则替换引擎" },
  "beilu-logger": { icon: '<i data-ic="edit"></i>', desc: "日志记录" },
};

async function initPluginListSlot() {
  const slot = document.getElementById("settings-plugin-list");
  if (!slot) return;

  try {
    // 渲染源真相：后端已安装插件全集（GET /api/getlist/plugins，server/web_server/endpoints.mjs:563 → getPartList(username,'plugins')）
    // 后端单源 → 后端新增插件无需改前端即显示，根除写死清单漂移。失败时回退 PLUGIN_META 键集（已知插件，仍非硬编码数量）。
    let pluginNames = [];
    try {
      const _all = await getPartList("plugins");
      if (Array.isArray(_all)) pluginNames = _all;
    } catch {}
    if (!pluginNames.length) pluginNames = Object.keys(PLUGIN_META);

    // 获取当前chat已注册的插件（仅用于标"本对话启用"，非渲染源）
    // 补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，内含 _CHATID_RE 校验）——非法 hash
    //   （分段气泡/IDE 内部锚点）返 ""，走下方 if(hash) false 分支不拼进 URL path segment，避免坏请求/404。
    //   对齐 cardsPanel.mjs:62 _cur()/featureControls.mjs:60 范式（window 全局桥单源，无需新增 import）。
    const hash = window._beiluGetChatId?.() || "";

    // 三路并行：描述后端单源(getallcacheddetails，info.json 本地化文案——新插件不再缺描述)
    //   + 真实加载态(getloadedlist = parts_set 实况；启动全量预加载 fullLoadAllParts 后正常应全部已加载)
    //   + 当前对话注册表。原"活跃/待机"语义=对话注册，与用户理解的"插件加载好没有"错位，拆成两个独立标记。
    const [detailsRes, loadedRes, registeredRes] = await Promise.allSettled([
      getAllCachedPartDetails("plugins"),
      getLoadedPartList("plugins"),
      // T2批23：静默降级读 → getChatPluginsQuiet（notify:"report"）。非 2xx sendAction throw 进 catch侧，registeredPlugins 保持 []。
      hash ? sendAction({ verb: "getChatPluginsQuiet", target: "shells:chat", source: "web", scope: { chatId: hash } }) : Promise.resolve([]),
    ]);
    const detailsMap = detailsRes.status === "fulfilled" ? (detailsRes.value?.cachedDetails || {}) : {};
    const loadedSet = new Set(loadedRes.status === "fulfilled" && Array.isArray(loadedRes.value)
      ? loadedRes.value.map(p => p.split("/").pop()) : []);
    const registeredPlugins = registeredRes.status === "fulfilled" && Array.isArray(registeredRes.value) ? registeredRes.value : [];
    const registeredNames = registeredPlugins.map(p => typeof p === "string" ? p : p.name || "");

    slot.innerHTML = pluginNames.map(name => {
      const meta = PLUGIN_META[name] || { icon: '<i data-ic="puzzle"></i>', desc: "" };
      const info = detailsMap[name]?.info || {};
      const desc = info.description || meta.desc;
      const loaded = loadedSet.has(name);
      const inChat = registeredNames.some(n => n.includes(name));
      return `<div class="flex items-center gap-2 p-2 bg-base-200/50 rounded text-xs">
        <span>${meta.icon}</span>
        <span class="font-mono shrink-0">${escapeHtml(name)}</span>
        <span class="flex-1 text-base-content/50 truncate" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>
        ${inChat ? '<span class="text-info text-[10px] shrink-0">本对话启用</span>' : ''}
        <span class="${loaded ? 'text-success' : 'text-base-content/50'} text-[10px] shrink-0">${loaded ? '● 已加载' : '○ 未加载'}</span>
      </div>`;
    }).join("");
  } catch (err) {
    slot.innerHTML = `<p class="text-xs text-error">加载失败: ${err.message}</p>`;
  }
}

// ============================================================
// AI服务源管理 slot (W63新增: 完整CRUD + Fetch Models)
// ============================================================

const API_BASE = '/api/parts/shells:serviceSourceManage';
const SERVICE_TYPE = 'AI';

// SETTINGS_API_TYPES 硬编码两项表已删（0711 渠道下拉恢复）：类型=渠道，表由 apiChannels.loadChannels()
// 从后端 PROVIDER_META 单源构建（禁前端另写枚举/URL/文案，apiAdapters.mjs:29 裁决）

async function initApiSlot() {
  const slot = document.getElementById("settings-api-slot");
  if (!slot) return;

  // 渠道表先于 DOM 构建（后端 PROVIDER_META 单源；失败内部降级基础两项，面板不空转）
  const CH = await loadChannels();

  slot.innerHTML = `
    <div class="space-y-3 mt-2">
      <!-- 选择 -->
      <div class="flex items-center gap-2">
        <select id="sa-api-select" class="select select-sm select-bordered flex-1"></select>
        <button id="sa-api-new" class="btn btn-sm btn-outline btn-success" title="新建">＋</button>
        <button id="sa-api-delete" class="btn btn-sm btn-outline btn-error" title="删除" disabled><i data-ic="trash"></i></button>
      </div>
      <!-- 名称+类型（类型=渠道，选中即声明 convert_config.provider） -->
      <div class="flex items-center gap-2">
        <input id="sa-api-name" class="input input-sm input-bordered flex-1" placeholder="配置名称" />
        <select id="sa-api-type" class="select select-sm select-bordered w-44">
          ${CH.channels.map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`).join('')}
        </select>
      </div>
      <!-- 渠道坑提示（后端 PROVIDER_META.hint；只提示不改参数，0708 裁决） -->
      <div id="sa-api-hint" class="hidden text-[11px] text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1"></div>
      <!-- URL（可改可清空；「恢复默认」回填后端默认端点） -->
      <div>
        <label class="text-xs opacity-60" id="sa-api-url-label">API URL</label>
        <div class="flex items-center gap-2">
          <input id="sa-api-url" class="input input-sm input-bordered flex-1" />
          <button id="sa-api-url-reset" class="btn btn-sm btn-outline" title="恢复该渠道的默认地址">恢复默认</button>
        </div>
      </div>
      <!-- API Key -->
      <div>
        <label class="text-xs opacity-60">API Key</label>
        <input id="sa-api-key" type="password" class="input input-sm input-bordered w-full" placeholder="sk-..." />
      </div>
      <!-- Model -->
      <div>
        <label class="text-xs opacity-60">模型</label>
        <div class="flex items-center gap-2">
          <input id="sa-api-model" class="input input-sm input-bordered flex-1" placeholder="模型名称" />
          <button id="sa-api-fetch" class="btn btn-sm btn-outline btn-info">获取模型</button>
        </div>
        <select id="sa-api-model-list" class="select select-sm select-bordered w-full mt-1 hidden"></select>
      </div>
      <!-- 思维链模式（2026-08-01 凛倾收口：thinking 控制唯一入口=本面板 per-源；三态+默认，
           按 convert_config.provider 在后端 applyThinkingMode 映射成各家参数，见 providerPatch.mjs） -->
      <div class="form-control">
        <label class="label py-0.5">
          <span class="label-text text-xs"><i data-ic="brain"></i> 思维链（Thinking / CoT）</span>
        </label>
        <select id="sa-api-thinking-mode" class="select select-sm select-bordered w-full">
          <option value="">渠道默认（不发参数）</option>
          <option value="off">关闭思维链 · 最快直接输出</option>
          <option value="standard">标准思维链 · 平衡速度和质量</option>
          <option value="max">最大思维链 · 最深推理</option>
        </select>
        <span class="text-[9px] text-base-content/50 pl-1">按渠道自动映射参数（DeepSeek/Kimi: thinking.type；Claude: thinking+effort；OpenAI系: reasoning_effort）。部分模型不可关（Gemini 2.5 Pro、kimi-k2.7-code、Claude Fable），强关会由 API 报错提示。</span>
      </div>
      <!-- 操作 -->
      <div class="flex gap-2">
        <button id="sa-api-save" class="btn btn-sm btn-primary flex-1"><i data-ic="save"></i> 保存</button>
      </div>
      <div id="sa-api-status" class="text-xs text-center hidden"></div>
      <!-- [0727 并发闸] 用户级 AI 并发上限（全局总闸，非 per-源参数，故放保存按钮之外、改动即存） -->
      <div class="divider text-xs opacity-40 mt-4">并发控制</div>
      <div class="form-control">
        <label class="label py-0.5">
          <span class="label-text text-xs"><i data-ic="zap"></i> AI 并发上限（0=不限）</span>
          <span id="sa-ai-concurrency-status" class="label-text-alt font-mono text-xs opacity-60"></span>
        </label>
        <input type="number" id="sa-ai-concurrency" min="0" max="99" step="1" placeholder="0" class="input input-sm input-bordered w-full font-mono" />
        <span class="text-[9px] text-base-content/50 pl-1 mt-1">同时最多几路 AI 在跑（含所有窗口+分身+记忆AI）。本体优先于分身；本体忙时分身自动排队逐个执行。改动即存即生效。</span>
      </div>
    </div>
  `;

  let currentName = null;
  let apiSources = [];
  const $ = id => slot.querySelector('#' + id);
  // 根病2 单向同步修(步骤0):自抑制本面板自身派发(复刻 apiConfig.mjs:88-93),避免步骤1监听器在本面板保存/删除/新建后重复刷新自己。
  let _suppressApiReload = false;
  const _emitApiChanged = () => {
    _suppressApiReload = true;
    try { window.dispatchEvent(new CustomEvent('resource:api-changed')); }
    finally { _suppressApiReload = false; }
  };

  const showStatus = (msg, type = 'info') => {
    const el = $('sa-api-status');
    el.textContent = msg;
    el.className = `text-xs text-center mt-1 ${type === 'success' ? 'text-success' : type === 'error' ? 'text-error' : 'text-warning'}`;
    el.classList.remove('hidden');
    if (type === 'success') setTimeout(() => el.classList.add('hidden'), 2000);
  };

  // [0727 并发闸] AI 并发上限接线：后端 yonban_config.ai_max_concurrent 单源（GET 回显 / change 即存），
  //   值域校验在后端 endpoints（0-99 整数），前端只 clamp 展示——操作界面三原则：选项限值来自后端。
  {
    const concInput = $('sa-ai-concurrency');
    const concStatus = $('sa-ai-concurrency-status');
    if (concInput) {
      sendAction({ verb: 'getAiConcurrency', target: 'shells:chat', source: 'web' })
        .then((r) => { concInput.value = String(r?.limit ?? 0); })
        .catch(() => { /* 读失败保持占位（0=不限），不阻断面板初始化 */ });
      concInput.addEventListener('change', async () => {
        const n = Math.max(0, Math.min(99, parseInt(concInput.value, 10) || 0));
        concInput.value = String(n);
        try {
          const r = await sendAction({ verb: 'setAiConcurrency', target: 'shells:chat', source: 'web', payload: { limit: n } });
          if (concStatus) {
            concStatus.textContent = (r?.limit ?? n) > 0 ? `已生效: ${r.limit}` : '不限';
            setTimeout(() => { if (concStatus) concStatus.textContent = ''; }, 3000);
          }
        } catch (err) {
          if (concStatus) concStatus.textContent = '保存失败';
          window._reportError?.(`[settingsSlots] setAiConcurrency: ${err.message}`, err.stack);
        }
      });
    }
  }

  // 未知生成器（claude-api/grok/polling…）的临时渠道项：只在加载到该源时注入下拉，
  // 保存不动 generator/provider（修 0711 前旧病：未知生成器被强转 proxy=错绑）
  let _tempEntry = null;
  // 「用户没改过 URL」判据：值为空或仍等于上个渠道的默认值 → 切渠道时才自动换成新默认
  let _lastDefaultUrl = '';

  const curEntry = () => {
    const v = $('sa-api-type').value;
    if (_tempEntry && _tempEntry.value === v) return _tempEntry;
    return CH.byValue.get(v) || CH.byValue.get('proxy') || CH.channels[0];
  };

  const removeTempOption = () => {
    _tempEntry = null;
    $('sa-api-type').querySelector('option[data-temp]')?.remove();
  };

  const ensureTempOption = (entry) => {
    removeTempOption();
    _tempEntry = entry;
    const opt = document.createElement('option');
    opt.value = entry.value;
    opt.textContent = entry.label;
    opt.dataset.temp = '1';
    $('sa-api-type').appendChild(opt);
  };

  const syncChannelUI = () => {
    const e = curEntry();
    $('sa-api-url-label').textContent = e.urlLabel;
    $('sa-api-url').placeholder = e.defaultUrl || '';
    const hintEl = $('sa-api-hint');
    hintEl.textContent = e.hint || '';
    hintEl.classList.toggle('hidden', !e.hint);
    $('sa-api-url-reset').classList.toggle('hidden', !e.defaultUrl);
  };

  const clearForm = () => {
    currentName = null;
    removeTempOption();
    $('sa-api-name').value = '';
    $('sa-api-type').value = 'proxy';
    $('sa-api-url').value = '';
    $('sa-api-key').value = '';
    $('sa-api-model').value = '';
    $('sa-api-delete').disabled = true;
    $('sa-api-model-list').classList.add('hidden');
    _lastDefaultUrl = curEntry().defaultUrl || '';
    syncChannelUI();
  };

  const loadList = async () => {
    try {
      // T2批1收口：raw GET → sendAction 门面（shells:serviceSourceManage#getAISources REST 精确路由，回包=数组裸体等价）
      apiSources = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
      const sel = $('sa-api-select');
      sel.innerHTML = apiSources.length === 0
        ? '<option value="">（无配置）</option>'
        : apiSources.map(n => `<option value="${escapeHtml(n)}" ${n === currentName ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
      if (apiSources.length > 0 && !currentName) loadSource(apiSources[0]);
    } catch (e) { showStatus('加载列表失败: ' + e.message, 'error'); }
  };

  const loadSource = async (name) => {
    if (!name) return;
    currentName = name;
    $('sa-api-select').value = name;
    try {
      // T2批1收口：raw GET 单源 → sendAction 门面（getAISource REST，回包 {generator,config} 裸体等价）
      const data = await sendAction({ verb: "getAISource", target: "shells:serviceSourceManage", source: "web", payload: { name } });
      const gen = data.generator || 'proxy';
      const cfg = data.config || {};
      $('sa-api-name').value = cfg.name || name;
      const chValue = CH.valueFor(gen, cfg);
      let entry;
      if (chValue) {
        removeTempOption();
        $('sa-api-type').value = chValue;
        entry = curEntry();
      } else {
        // 未知生成器：按配置实有键探测地址字段，保存时保留原 generator
        const urlField = ['url', 'base_url', 'host'].find((k) => k in cfg) || 'url';
        ensureTempOption({
          value: `__gen:${gen}`, label: `${gen}（其他生成器）`, generator: gen, provider: '',
          urlField, urlLabel: `API 地址（字段：${urlField}）`, defaultUrl: '',
          hint: '此生成器的专项参数请在服务源管理页配置；这里保存只更新名称/地址/密钥/模型',
        });
        $('sa-api-type').value = `__gen:${gen}`;
        entry = _tempEntry;
      }
      $('sa-api-url').value = cfg[entry.urlField] || '';
      _lastDefaultUrl = entry.defaultUrl || '';
      $('sa-api-key').value = cfg.apikey || '';
      $('sa-api-model').value = cfg.model || '';
      $('sa-api-delete').disabled = false;
      $('sa-api-model-list').classList.add('hidden');
      // 思维链模式回显（per-源）：新键 thinking_mode 优先；旧 boolean extended_thinking 迁移显示
      //   （true=standard，false/缺失=渠道默认），与后端 httpFetch 迁移语义一致
      const _thinkModeEl = $('sa-api-thinking-mode');
      if (_thinkModeEl) {
        _thinkModeEl.value = (cfg.thinking_mode !== undefined && cfg.thinking_mode !== null && cfg.thinking_mode !== '')
          ? cfg.thinking_mode
          : (cfg.extended_thinking ? 'standard' : '');
      }
      syncChannelUI();
    } catch (e) { showStatus('加载失败: ' + e.message, 'error'); }
  };

  // Events
  $('sa-api-select').addEventListener('change', () => loadSource($('sa-api-select').value));
  $('sa-api-type').addEventListener('change', () => {
    // 用户没改过 URL（空或=上个渠道默认）才自动换新默认；改过的值不动（凛倾：可删可改）
    const entry = curEntry();
    const u = $('sa-api-url');
    if (!u.value || u.value === _lastDefaultUrl) u.value = entry.defaultUrl || '';
    _lastDefaultUrl = entry.defaultUrl || '';
    syncChannelUI();
  });
  $('sa-api-url-reset').addEventListener('click', () => {
    const entry = curEntry();
    $('sa-api-url').value = entry.defaultUrl || '';
    _lastDefaultUrl = entry.defaultUrl || '';
  });

  // （旧 Extended Thinking 开关/预算联动已删——2026-08-01 三态下拉无需联动）

  $('sa-api-save').addEventListener('click', async () => {
    if (!currentName) { showStatus('请先选择或新建配置', 'error'); return; }
    const entry = curEntry();
    let baseCfg = {};
    // T2批23：静默兜底预读 → getAISourceQuiet（notify:"report"，失败进报错系统不弹 toast，baseCfg={} 继续）。
    try { baseCfg = (await sendAction({ verb: "getAISourceQuiet", target: "shells:serviceSourceManage", source: "web", payload: { name: currentName } })).config || {}; } catch {}
    // 0714 trim：name/key/model/url 全字段去首尾空白（脏 URL 曾致后端 getModels 解析炸=模型下拉静默空）
    baseCfg.name = $('sa-api-name').value.trim() || currentName;
    baseCfg.apikey = $('sa-api-key').value.trim();
    baseCfg.model = $('sa-api-model').value.trim();
    // 思维链模式 per-源（2026-08-01 凛倾收口：thinking 控制唯一入口=本面板）：写 config 顶层
    //   thinking_mode（""=渠道默认/off/standard/max），消费方=httpFetch→applyThinkingMode 按
    //   convert_config.provider 显式映射各家参数。旧键 extended_thinking/thinking_budget 同步删除
    //   （存量迁移读侧兜底：无 thinking_mode 时 extended_thinking===true 视同 standard）。
    baseCfg.thinking_mode = $('sa-api-thinking-mode')?.value || '';
    delete baseCfg.extended_thinking;
    delete baseCfg.thinking_budget;
    if (_tempEntry && entry === _tempEntry) {
      // 未知生成器：只写探测到的地址字段，不清理其他键、不写 provider（保留原生成器语义）
      baseCfg[entry.urlField] = $('sa-api-url').value.trim();
    } else {
      CH.applyToConfig(entry, baseCfg, $('sa-api-url').value);
    }
    const gen = entry.generator;
    try {
      // T2批1收口：raw POST 保存 → sendAction 门面（saveAISource 注册体 buildBody 取 payload.data，故 {generator,config} 须包进 data）。
      //   sendAction 非 2xx 自动 throw，原 if(!res.ok)throw 由门面接管删除。
      await sendAction({ verb: "saveAISource", target: "shells:serviceSourceManage", source: "web",
        payload: { name: currentName, data: { generator: gen, config: baseCfg } } });
      showStatus('✅ 已保存', 'success');
      // 0714 根修（凛倾「保存后转跳为空白」案）：原 `currentName = baseCfg.name` 改名漂移删除——
      //   后端按 URL :name 存文件从不改名（serviceSourceManage endpoints.mjs POST :39），config.name
      //   只是显示名（生成器 buildInfo v.name 消费），两者本就允许不同。漂移后 loadSource(不存在名)
      //   → select.value 落空=下拉空白，且后续保存/加载全按幽灵名 404。文件键恒=currentName 不动。
      await loadList();
      loadSource(currentName);
      _emitApiChanged();
    } catch (e) { showStatus('保存失败: ' + e.message, 'error'); }
  });

  $('sa-api-delete').addEventListener('click', async () => {
    if (!currentName || !await beiluConfirm(`确定删除「${currentName}」?`)) return;
    try {
      // T2批1收口：raw DELETE → sendAction 门面（deleteAISource REST，不带 mode=无 query 等价；现状不消费返回值）
      await sendAction({ verb: "deleteAISource", target: "shells:serviceSourceManage", source: "web", payload: { name: currentName } });
      showStatus('已删除', 'success');
      currentName = null;
      await loadList();
      if (apiSources.length > 0) loadSource(apiSources[0]); else clearForm();
      _emitApiChanged();
    } catch (e) { showStatus('删除失败: ' + e.message, 'error'); }
  });

  $('sa-api-new').addEventListener('click', async () => {
    const name = await beiluPrompt('输入新API配置名称：');
    if (!name?.trim()) return;
    const safeName = name.trim();
    if (apiSources.includes(safeName)) { showStatus('名称已存在', 'error'); return; }
    let tmpl = {};
    // T2批23：静默兜底预读 → getGeneratorTemplateQuiet（notify:"report"，失败 tmpl={} 继续不弹 toast）。
    try { tmpl = await sendAction({ verb: "getGeneratorTemplateQuiet", target: "shells:serviceSourceManage", source: "web", payload: { generator: 'proxy' } }); } catch {}
    try {
      // T2批1收口：raw POST 新建 → sendAction 门面（saveAISource 同 A4，buildBody 取 payload.data，故 {generator,config} 须包进 data）。
      await sendAction({ verb: "saveAISource", target: "shells:serviceSourceManage", source: "web",
        payload: { name: safeName, data: { generator: 'proxy', config: tmpl } } });
      currentName = safeName;
      await loadList();
      loadSource(safeName);
      showStatus('✅ 已创建', 'success');
      _emitApiChanged();
    } catch (e) { showStatus('创建失败: ' + e.message, 'error'); }
  });

  // [0717 抽函数] 原按钮内联体抽出共用：按钮点击（可见反馈）+ 模型下拉 mousedown（静默实时拉，
  //   凛倾「拉条是每次都需要访问,不是访问一次就缓存,每次点击都需要访问」）两口同链。
  //   silent 时：不动状态条/按钮文案；列表未变跳过重建（重建会把刚展开的原生下拉强制收起）。
  let _saFetchSeq = 0; // 乱序守卫：连点/连开期间旧慢响应不覆盖新列表（同 preset.mjs _fetchModelsSeq 范式）
  async function _saFetchModels({ silent = false } = {}) {
    const seq = ++_saFetchSeq;
    const url = $('sa-api-url').value;
    const key = $('sa-api-key').value;
    if (!url) { if (!silent) showStatus('请先填写URL', 'error'); return; }
    // 按渠道分发列表端点：ollama=/api/tags（{models:[{name}]}），其余 OpenAI 惯例 /models
    const req = modelsRequestFor(curEntry(), url);
    const modelsUrl = req.url;
    if (!silent) { $('sa-api-fetch').disabled = true; $('sa-api-fetch').textContent = '获取中...'; }
    try {
      let models = [];
      // Try proxy fetch via beilu-memory (参数格式与 index.mjs chat 侧栏对齐)
      // T6b尾：原 raw POST setdata {_action:"getModels",...} + proxyRes.ok 手检 → sendAction 门面（memory#* 通配桥组装 _action=verb+平铺 payload）。
      //   等价换算：verb="getModels"，payload 逐字段照搬原 body 非 _action 部分 {apiConfig,url:modelsUrl,apikey}（语义=按未保存配置试拉，非 sourceName 路径，故不照抄他处 {sourceName}）；门面返回体=原 proxyRes.json() 解析结果（桥 unwrap 还原裸数据）。
      //   控制流等价（要点）：原 proxyRes.ok=false 是布尔态、models 保持 [] 继续走下方 direct fetch fallback；门面失败改为抛错，故此处包 try/catch 把门面抛错降级为「proxy 无果」(models 仍 [])，让控制流照原样落到 fallback——非吞错：direct 也失败时 models=[] → 显示「未找到模型」，与原三态一致。
      try {
        const d = await sendAction({ verb: "getModels", target: "plugins:beilu-memory", source: "web", payload: { apiConfig: { url: $('sa-api-url').value, key }, url: modelsUrl, apikey: key } });
        models = req.normalize(d);
      } catch { /* proxy 失败=降级走下方 direct fetch fallback（保持原 !ok 分支的控制流），错误在 fallback 也失败时经末尾「未找到模型」可见 */ }
      if (models.length === 0) {
        // Direct fetch fallback
        try {
          // R1-SKIP: modelsUrl=用户填的外部 API 端点(自管 Authorization Bearer)；apiFetch 401→/login 对外站有害。
          const directRes = await fetch(modelsUrl, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
          if (directRes.ok) {
            const d = await directRes.json();
            models = req.normalize(d);
          }
        } catch {}
      }
      if (seq !== _saFetchSeq) return; // 已被更新的调用超越，丢弃旧响应
      const listEl = $('sa-api-model-list');
      if (models.length > 0) {
        const oldVals = Array.from(listEl.options).map(o => o.value);
        const sameList = !listEl.classList.contains('hidden') &&
          oldVals.length === models.length && oldVals.every((v, i) => v === models[i]);
        if (!sameList) {
          const current = $('sa-api-model').value;
          listEl.innerHTML = models.map(m => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
          listEl.classList.remove('hidden');
        }
        if (!silent) showStatus(`找到 ${models.length} 个模型`, 'success');
      } else if (!silent) {
        listEl.classList.add('hidden');
        showStatus('未找到模型，请检查URL和Key', 'error');
      }
    } catch (e) { if (!silent) showStatus('获取模型失败: ' + e.message, 'error'); }
    if (!silent) { $('sa-api-fetch').disabled = false; $('sa-api-fetch').textContent = '获取模型'; }
  }

  $('sa-api-fetch').addEventListener('click', () => _saFetchModels({ silent: false }));

  $('sa-api-model-list').addEventListener('change', () => {
    $('sa-api-model').value = $('sa-api-model-list').value;
  });
  // [0717] 下拉点击展开=静默实时拉（列表未变不重建，不打断展开中的下拉）
  $('sa-api-model-list').addEventListener('mousedown', () => _saFetchModels({ silent: true }));

  syncChannelUI();
  await loadList();

  // 根病2 单向同步修(步骤1,补 C4 消费边):外部(apiConfig 右栏/独立页/onboarding)改 API 源 → 重拉后端权威刷新本设置弹窗 #sa-api-*。
  //   修前 settingsSlots 只 dispatch 不 listen=单向盲点。复用闭包内 loadList/loadSource,不新造数据源。initApiSlot 单次调(layout.mjs:795),无重复监听。
  window.addEventListener('resource:api-changed', whenVisible('#center-tab-settings', () => {
    if (_suppressApiReload) return; // 跳过本面板自身派发(步骤0自抑制)
    loadList().then(() => { if (currentName) loadSource(currentName); });
  }));

  // 思维链设定唯一入口（凛倾 2026-07-14 收口；0720 硬化：内置 think/thinking 恒剥离恒显示——
  //   折叠开关与内置标签勾选均已删，剩折叠标题+自定义标签对两项可配）。
  // 元素在 index.html api 区块静态存在（slot 外，不被 innerHTML 重建）。写点全走既有单源，本处只做 UI 装配：
  //   - 折叠标题：KEYS.BEILU_THINKING_FOLD_LABEL，消费方 messageList；空值/恢复默认 = 删 key 回落代码默认值
  //   - 自定义标签对：reasoningTags.saveReasoningTags（后端 functions:hide#setReasoningTags 权威 + 本地折叠镜像 + 重渲染）
  const { THINKING_FOLD_LABEL_DEFAULT } = await import('../../shared/render/displayRegex.mjs');
  const tfInput = document.getElementById('sa-thinkfold-label');
  const tfReset = document.getElementById('sa-thinkfold-reset');
  const _tfRefresh = () => import('../../shared/render/virtualQueue.mjs')
    .then((m) => m.reloadBeautify?.(30))
    .catch((err) => console.warn('[settingsSlots] 思维链折叠标题 reloadBeautify 失败:', err));
  if (tfInput && !tfInput._wired) {
    tfInput._wired = true;
    tfInput.placeholder = THINKING_FOLD_LABEL_DEFAULT;
    tfInput.value = storage.get(KEYS.BEILU_THINKING_FOLD_LABEL) || '';
    tfInput.addEventListener('change', () => {
      const v = tfInput.value.trim();
      if (v) storage.set(KEYS.BEILU_THINKING_FOLD_LABEL, v);
      else storage.remove(KEYS.BEILU_THINKING_FOLD_LABEL);
      _tfRefresh();
    });
    tfReset?.addEventListener('click', () => {
      tfInput.value = '';
      storage.remove(KEYS.BEILU_THINKING_FOLD_LABEL);
      _tfRefresh();
    });
  }

  // 折叠开关已删（0720 硬化）：凛倾硬性核心「人类必须看得到」——折叠块恒渲染,无隐藏开关。

  // 标签编辑（自定义标签对；内置 think/thinking 恒剥离恒显示不可关）：权威源=后端 beilu-memory config
  //   （reasoning_tags；reasoning_builtin 已废,0720 硬化），打开设置时拉一次填充；保存走 saveReasoningTags 唯一写点。
  const tfSave = document.getElementById('sa-think-save');
  if (tfSave && !tfSave._wired) {
    tfSave._wired = true;
    // [0720 硬化] 内置 think/thinking 勾选框已删（恒剥离恒显示,凛倾硬性核心）,只装配自定义标签对
    const tfTagsBox = document.getElementById('sa-think-custom-tags');
    const _mkTagRow = (open = '', close = '') => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1';
      const mk = (ph, val) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'input input-xs input-bordered flex-1';
        inp.placeholder = ph; inp.value = val;
        return inp;
      };
      const oInp = mk('<tag>', open); oInp.dataset.rf = 'o';
      const cInp = mk('</tag>', close); cInp.dataset.rf = 'c';
      const del = document.createElement('button');
      del.className = 'btn btn-xs btn-ghost'; del.textContent = '✖';
      del.addEventListener('click', () => row.remove());
      row.append(oInp, cInp, del);
      return row;
    };
    let _hadPrevTags = false;
    try {
      const data = await sendAction({ verb: 'getData', target: 'plugins:beilu-memory', source: 'web' });
      const cfg = data?.config || {};
      _hadPrevTags = Array.isArray(cfg.reasoning_tags) && cfg.reasoning_tags.length > 0;
      if (tfTagsBox) for (const t of (cfg.reasoning_tags || [])) tfTagsBox.appendChild(_mkTagRow(t.open || '', t.close || ''));
    } catch (err) {
      console.warn('[settingsSlots] 思维链标签配置加载失败:', err);
      window._reportError?.(`[settingsSlots] 思维链标签配置加载失败: ${err?.message}`, err?.stack);
    }
    document.getElementById('sa-think-add-tag')?.addEventListener('click', () => tfTagsBox?.appendChild(_mkTagRow()));
    tfSave.addEventListener('click', async () => {
      const rTags = [];
      tfTagsBox?.querySelectorAll(':scope > div').forEach((row) => {
        const o = row.querySelector('[data-rf="o"]')?.value?.trim() || '';
        const c = row.querySelector('[data-rf="c"]')?.value?.trim() || '';
        if (o && c) rTags.push({ open: o, close: c });
      });
      const _origHtml = tfSave.innerHTML;
      try {
        tfSave.innerHTML = '<i data-ic="hourglass"></i> 保存中';
        await saveReasoningTags(rTags, { hadPrevTags: _hadPrevTags });
        _hadPrevTags = rTags.length > 0; // 保存成功后基线更新：本轮清空已落盘，下次再清空仍要落盘
        tfSave.innerHTML = '<i data-ic="check"></i> 已保存';
      } catch (err) {
        console.warn('[settingsSlots] 思维链标签保存失败:', err);
        window._reportError?.(`[settingsSlots] 思维链标签保存失败: ${err?.message}`, err?.stack);
        tfSave.innerHTML = '<i data-ic="cross"></i> 失败';
      }
      setTimeout(() => { tfSave.innerHTML = _origHtml; }, 1500);
    });
  }
}

// beilu-files 路径白黑名单已迁入权限域（凛倾0710）：code 权限面板(permissionPanel.mjs) + work 工具箱·工具权限(workPanel.mjs)，共享单源 panels/shared/filesPathConfig.mjs（安全中心副本 0710 已删）

// ============================================================
// 后台监控增强 (W63新增: beilu-logger + 前端诊断)
// ============================================================

async function initMonitorSlot() {
  const logOutput = document.getElementById("settings-monitor-log");
  const errOutput = document.getElementById("settings-monitor-errors");
  const statusOutput = document.getElementById("settings-monitor-status");
  const clearBtn = document.getElementById("settings-monitor-clear-log");
  if (!logOutput) return;
  // 幂等：initSettingsSlots 只调一次，但防御性挡重入（避免重复注册监听/MutationObserver）
  if (logOutput.dataset.monInit === "1") return;
  logOutput.dataset.monInit = "1";

  let autoRefreshTimer = null;
  let currentLevel = 'all';
  let currentErrSource = 'all'; // 错误追踪块来源过滤：all/frontend/server
  // 异步竞态防护：每次 fetchLogs 自增 token，旧响应回来时若 token 已过期则丢弃，
  // 防止「慢的旧请求」覆盖「快的新请求」结果（凛倾点名注意异步）。
  let _fetchSeq = 0;

  // Replace log area with enhanced UI
  const logParent = logOutput.parentElement;
  // Add controls before the log output
  const controls = document.createElement('div');
  controls.className = 'flex items-center gap-1 mb-1 flex-wrap';
  controls.innerHTML = `
    <button class="btn btn-xs mon-filter active" data-level="all" style="background:oklch(var(--b2))">全部</button>
    <button class="btn btn-xs btn-ghost mon-filter" data-level="error"><i data-ic="cross"></i> 错误</button>
    <button class="btn btn-xs btn-ghost mon-filter" data-level="warn"><i data-ic="warning"></i> 警告</button>
    <label class="flex items-center gap-1 ml-auto cursor-pointer">
      <input type="checkbox" id="mon-auto-refresh" class="checkbox checkbox-xs" />
      <span class="text-[10px]">自动刷新</span>
    </label>
    <button id="mon-copy-log" class="btn btn-xs btn-ghost" title="复制日志">📋</button>
  `;
  logParent.insertBefore(controls, logOutput);

  // ── 错误追踪块控制条（来源过滤 / console.error 桥接开关 / 导出）──
  // errOutput 容器结构：div.bg-base-300/50 > [<p>⚠️ 错误追踪</p>, #settings-monitor-errors]
  // 控制条插在标题 <p> 之后、错误列表 errOutput 之前。
  if (errOutput) {
    const errParent = errOutput.parentElement;
    const errControls = document.createElement('div');
    errControls.className = 'flex items-center gap-1 mb-1 flex-wrap';
    const bridgeOn = (() => { try { return storage.get(KEYS.BEILU_CONSOLE_ERROR_BRIDGE) === '1'; } catch { return false; } })();
    errControls.innerHTML = `
      <button class="btn btn-xs err-src active" data-src="all" style="background:oklch(var(--b2))">全部</button>
      <button class="btn btn-xs btn-ghost err-src" data-src="frontend">前端</button>
      <button class="btn btn-xs btn-ghost err-src" data-src="server">后端</button>
      <label class="flex items-center gap-1 ml-auto cursor-pointer" title="开启后 console.error 也会镜像上报到错误缓冲（默认关，避免噪音）">
        <input type="checkbox" id="err-console-bridge" class="checkbox checkbox-xs" ${bridgeOn ? 'checked' : ''} />
        <span class="text-[10px]">桥接 console.error</span>
      </label>
      <button id="err-export" class="btn btn-xs btn-ghost" title="导出错误报告 (JSON)"><i data-ic="upload"></i></button>
    `;
    errParent.insertBefore(errControls, errOutput);

    // 来源过滤
    errControls.querySelectorAll('.err-src').forEach(btn => {
      btn.addEventListener('click', () => {
        errControls.querySelectorAll('.err-src').forEach(b => { b.classList.add('btn-ghost'); b.style.background = ''; });
        btn.classList.remove('btn-ghost');
        btn.style.background = 'oklch(var(--b2))';
        currentErrSource = btn.dataset.src;
        fetchLogs();
      });
    });

    // console.error 桥接开关（持久化 + 调用 base.mjs 安装的 window._setConsoleErrorBridge）
    errControls.querySelector('#err-console-bridge')?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      try { storage.set(KEYS.BEILU_CONSOLE_ERROR_BRIDGE, on ? '1' : '0'); } catch {}
      if (typeof window._setConsoleErrorBridge === 'function') window._setConsoleErrorBridge(on);
    });

    // 导出错误报告：独立 fetch，不共享自动刷新的 _fetchSeq（凛倾点名注意并发）。
    // 纯本地 Blob 下载，零联网。拉全量（limit=1000，后端上限）+ 当前诊断元信息。
    errControls.querySelector('#err-export')?.addEventListener('click', async () => {
      const btn = errControls.querySelector('#err-export');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        // T2批23：读路走 sendAction（getErrors，notify:"report"）。sendAction 非 2xx 自动 throw，
        //   故用 try 给 errors 失败占位（导出仍产出，与原 res.ok?...:{error,entries:[]} 降级同义）。
        // 导出去重：dedupe=1 → 后端同指纹（message+stack首行）折叠为一条，附 count/firstSeen/lastSeen；
        //   rawTotal 保留折叠前原始条数。面板列表路径（fetchLogs）不带 dedupe，行为不变。
        let data;
        try { data = await sendAction({ verb: "getErrors", target: "server:monitor", source: "web", payload: { limit: 1000, dedupe: true } }); }
        catch (e) { data = { error: e?.message || String(e), entries: [] }; }
        let health = null;
        try { health = await sendAction({ verb: "getHealth", target: "server:monitor", source: "web" }); } catch {}
        const report = {
          _type: 'beilu-error-report', _version: 2,
          meta: {
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            url: location.href,
            viewport: `${innerWidth}x${innerHeight}`,
            deduped: true,
            consoleErrorBridge: (() => { try { return storage.get(KEYS.BEILU_CONSOLE_ERROR_BRIDGE) === '1'; } catch { return false; } })(),
          },
          health,
          total: data.total ?? (data.entries ? data.entries.length : 0),
          rawTotal: data.rawTotal ?? null,
          entries: data.entries || [],
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `beilu-errors-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        btn.textContent = '✅'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
      } catch (err) {
        btn.textContent = '❌'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
      }
    });
  }

  // W63: 前端诊断模块开关
  const DIAG_MODULES = ['template','displayRegex','messageList','streamRenderer','virtualQueue','websocket','iframeRenderer','stCompat','sidebar','fileExplorer','layout','config','api','dom','perf'];
  const diagSection = document.createElement('div');
  diagSection.className = 'bg-base-300/50 rounded-lg p-2 space-y-1 mt-2';
  diagSection.innerHTML = `
    <div class="flex items-center justify-between mb-1">
      <p class="text-xs font-medium" style="color:var(--beilu-amber)"><i data-ic="wrench"></i> 前端诊断模块</p>
      <div class="flex gap-1">
        <button id="diag-enable-all" class="btn btn-xs btn-ghost">全开</button>
        <button id="diag-disable-all" class="btn btn-xs btn-ghost">全关</button>
        <button id="diag-export" class="btn btn-xs btn-ghost" title="导出全量诊断报告（运行时日志+错误追踪+系统状态+白盒线路追踪）"><i data-ic="upload"></i></button>
      </div>
    </div>
    <div class="flex flex-wrap gap-1" id="diag-module-btns">
      ${DIAG_MODULES.map(m => {
        const active = (storage.get(KEYS.BEILU_DIAG_MODULES) || '').includes(m);
        return `<button class="btn btn-xs ${active ? 'btn-warning' : 'btn-ghost'} diag-mod" data-mod="${m}">${m}</button>`;
      }).join('')}
    </div>
    <div class="flex items-center gap-2 mt-1">
      <span class="text-[10px] opacity-60">日志级别</span>
      <select id="diag-level-sel" class="select select-xs select-bordered w-24">
        <option value="info" ${(storage.get(KEYS.BEILU_DIAG_LEVEL)||'info')==='info'?'selected':''}>info</option>
        <option value="debug" ${storage.get(KEYS.BEILU_DIAG_LEVEL)==='debug'?'selected':''}>debug</option>
        <option value="warn" ${storage.get(KEYS.BEILU_DIAG_LEVEL)==='warn'?'selected':''}>warn</option>
        <option value="error" ${storage.get(KEYS.BEILU_DIAG_LEVEL)==='error'?'selected':''}>error</option>
      </select>
      <label class="flex items-center gap-1 ml-auto cursor-pointer" title="白盒线路追踪总开关（前后端，默认开）。与上面的诊断模块是两套：诊断模块控 console 日志，白盒控 wbTrace 线路环。">
        <input type="checkbox" id="diag-whitebox-toggle" class="checkbox checkbox-xs" ${(()=>{try{return storage.get(KEYS.BEILU_WHITEBOX_ENABLED)!=='0';}catch{return true;}})()?'checked':''} />
        <span class="text-[10px]">白盒线路追踪</span>
      </label>
    </div>
  `;
  logParent.parentElement.appendChild(diagSection);

  // Module toggle
  diagSection.querySelectorAll('.diag-mod').forEach(btn => {
    btn.addEventListener('click', () => {
      const mod = btn.dataset.mod;
      let mods = (storage.get(KEYS.BEILU_DIAG_MODULES) || '').split(',').filter(Boolean);
      if (mods.includes(mod)) { mods = mods.filter(m => m !== mod); btn.classList.replace('btn-warning','btn-ghost'); }
      else { mods.push(mod); btn.classList.replace('btn-ghost','btn-warning'); }
      storage.set(KEYS.BEILU_DIAG_MODULES, mods.join(','));
    });
  });
  // Enable/disable all
  diagSection.querySelector('#diag-enable-all')?.addEventListener('click', () => {
    storage.set(KEYS.BEILU_DIAG_MODULES, '*');
    diagSection.querySelectorAll('.diag-mod').forEach(b => { b.classList.remove('btn-ghost'); b.classList.add('btn-warning'); });
  });
  diagSection.querySelector('#diag-disable-all')?.addEventListener('click', () => {
    storage.remove(KEYS.BEILU_DIAG_MODULES);
    diagSection.querySelectorAll('.diag-mod').forEach(b => { b.classList.remove('btn-warning'); b.classList.add('btn-ghost'); });
  });
  // Level
  diagSection.querySelector('#diag-level-sel')?.addEventListener('change', (e) => {
    storage.set(KEYS.BEILU_DIAG_LEVEL, e.target.value);
  });
  // 白盒线路追踪总开关（断点②修复）：前端 setWhiteboxEnabled + 后端 POST toggle，持久化。
  // 启动时按持久化恢复（默认开；仅显式存 '0' 才关）。
  const wbToggle = diagSection.querySelector('#diag-whitebox-toggle');
  const applyWhitebox = (on, persist) => {
    try { setWhiteboxEnabled(on); } catch {}
    if (persist) { try { storage.set(KEYS.BEILU_WHITEBOX_ENABLED, on ? '1' : '0'); } catch {} }
    // T2批23：交互写按钮 → toggleWhitebox（缺省 toast，失败让用户可见没生效）。.catch 吞 rethrow（本地态已由
    //   setWhiteboxEnabled/持久化落地，后端同步失败不回滚前端）；toast 由 sendAction _report 缺省档负责弹出。
    sendAction({ verb: "toggleWhitebox", target: "server:monitor", source: "web", payload: { enabled: on } }).catch(() => {});
  };
  wbToggle?.addEventListener('change', (e) => applyWhitebox(!!e.target.checked, true));
  // 启动恢复：仅当持久化为 '0' 时主动关（避免每次进设置面板都向后端发无谓请求，默认开不发）
  try { if (storage.get(KEYS.BEILU_WHITEBOX_ENABLED) === '0') applyWhitebox(false, false); } catch {}
  // 全量诊断导出：单按钮汇总本面板全部可观测 —— 运行时日志 + 错误追踪 + 系统状态(health)
  // + 前端诊断配置 + 白盒线路追踪环(getWhiteboxRing，此前无任何导出口，含前端执行点 + 后端广播 wb_trace)
  // + 前端 console 缓冲/状态快照(diagControl.getLogBuffer/getSnapshotBuffer，此前仅控制台 beiluDiag.pack() 可达，面板导出漏接)。
  // 纯本地 Blob 下载，四个 fetch 并发独立(不共享 fetchLogs 的 _fetchSeq)，任一失败降级不阻断其余。
  // 导出去重（三处重复源，各在权威侧折叠）：
  //   ① errors → 后端 dedupe=1 同指纹折叠（monitor.mjs，附 count/firstSeen/lastSeen）
  //   ② loggerLogs ↔ errors 跨源重复（beilu-logger 与 monitor 双拦 console.error/warn）→
  //      errors 为权威（含 module/stack/source 结构化），loggerLogs 剔除与 errors console 域同 level+message 的条目
  //   ③ 白盒双环：前端环含后端广播(side:"be")，后端 RING 为权威全量 → 后端环拉取成功时前端环只导 side:"fe"，
  //      拉取失败时保留整环兜底；前端 console 缓冲中 "[wb:" 行已结构化在环里，导出时剔除
  const _foldLogs = (entries, msgOf, tsOf) => {
    // 同 level+message 折叠为一条（保留首见实体 + count/firstSeen/lastSeen），导出专用，不动缓冲本体
    const map = new Map();
    for (const e of entries) {
      const key = `${e.level}|${msgOf(e)}`;
      const cur = map.get(key);
      const ts = tsOf(e);
      if (cur) { cur.count++; cur.lastSeen = ts; }
      else map.set(key, { ...e, count: 1, firstSeen: ts, lastSeen: ts });
    }
    return Array.from(map.values());
  };
  diagSection.querySelector('#diag-export')?.addEventListener('click', async () => {
    const btn = diagSection.querySelector('#diag-export');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳';
    try {
      // T2批23：四路读全走 sendAction（notify:"report"，失败进后端报错系统不弹 toast）。
      //   Promise.allSettled 结构保留——sendAction 非 2xx reject，pick(r) 取 null 降级（与原 r.ok?json:null 同义）。
      const [logsR, errsR, healthR, wbBeR] = await Promise.allSettled([
        sendAction({ verb: "getLogs", target: "plugins:beilu-logger", source: "web", payload: { level: "all", limit: 500 } }),
        sendAction({ verb: "getErrors", target: "server:monitor", source: "web", payload: { limit: 1000, dedupe: true } }),
        sendAction({ verb: "getHealth", target: "server:monitor", source: "web" }),
        sendAction({ verb: "getWhitebox", target: "server:monitor", source: "web" }),
      ]);
      const pick = (r) => (r.status === 'fulfilled' ? r.value : null);
      let wbRing = [];
      try { wbRing = getWhiteboxRing(); } catch {}
      const wbBe = pick(wbBeR);
      const errData = pick(errsR);
      // ③ 白盒去重：后端权威环在手 → 前端环只留本端执行点（side:"fe"）
      const wbFeRing = (wbBe && Array.isArray(wbBe.ring)) ? wbRing.filter(e => e.side === 'fe') : wbRing;
      // ② 跨源去重：errors console 域（后端 installConsoleHook 产物）的 level+message 集合
      const errConsoleKeys = new Set((errData?.entries || []).filter(e => e.module === 'console').map(e => `${e.level}|${e.message}`));
      const loggerData = pick(logsR);
      const loggerLogsDeduped = loggerData ? {
        ...loggerData,
        logs: _foldLogs((loggerData.logs || []).filter(l => !errConsoleKeys.has(`${l.level}|${l.message}`)), l => l.message, l => l.time),
      } : null;
      // 前端 console 缓冲：剔除 "[wb:" 行（已结构化在 whiteboxRing）后同信息折叠；快照原样（结构化数据无重复语义）
      let feConsoleLogs = [];
      let feSnapshots = [];
      try {
        feConsoleLogs = _foldLogs(
          diagControl.getLogBuffer(500).filter(e => !String(e.msg || '').startsWith('[wb:')),
          e => e.msg, e => new Date(e.t).toISOString());
        feSnapshots = diagControl.getSnapshotBuffer(200);
      } catch {}
      const report = {
        _type: 'beilu-diag-report', _version: 4,
        meta: {
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
          url: location.href,
          viewport: `${innerWidth}x${innerHeight}`,
          deduped: true,
          consoleErrorBridge: (() => { try { return storage.get(KEYS.BEILU_CONSOLE_ERROR_BRIDGE) === '1'; } catch { return false; } })(),
        },
        frontend: {
          diagModules: storage.get(KEYS.BEILU_DIAG_MODULES),
          diagLevel: storage.get(KEYS.BEILU_DIAG_LEVEL),
          theme: storage.get(KEYS.THEME),
          consoleLogs: feConsoleLogs,     // ← 前端 console 拦截缓冲（diagLogger，去 wb 行 + 同信息折叠）
          snapshots: feSnapshots,         // ← 前端状态快照（diag.snapshot 产物）
          whiteboxRing: wbFeRing,         // ← 白盒线路追踪环（后端环拉取成功时仅 side:"fe"，失败时整环兜底）
          whiteboxRingCount: wbFeRing.length,
        },
        backend: {
          loggerLogs: loggerLogsDeduped,  // ← 已剔除与 errors console 域重复 + 同信息折叠
          errors: errData ? { total: errData.total ?? (errData.entries?.length || 0), rawTotal: errData.rawTotal ?? null, entries: errData.entries || [] } : null,
          health: pick(healthR),
          whiteboxRing: wbBe ? wbBe.ring : null,        // ← 后端 RING 权威全量（含回合外 chatid=null 线路）
          whiteboxRingCount: wbBe ? wbBe.total : null,
        },
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `beilu-diag-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      btn.textContent = '✅'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    } catch (err) {
      btn.textContent = '❌'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
  });

  // 单源复用既有检测代码（不另造采集器）：
  //   · 运行时日志 ← beilu-logger 插件环形缓冲（plugins:beilu-logger/logs，main.mjs 拦截后端 console.error/warn）
  //   · 错误追踪   ← server/monitor.mjs 权威错误缓冲（/api/v1/monitor/errors）。该缓冲已聚合：
  //                 后端 console（installConsoleHook, monitor.mjs:72）+ 前端运行时错误（base.mjs:8 _reportError
  //                 → /api/v1/monitor/errors/report，source:"frontend"）+ 路由异常（asyncHandler）。
  //                 含 module/source/stack 结构化信息，故此处渲染真实条目，不再只显示计数。
  //   · 系统状态   ← /api/v1/monitor/health 真实 uptime/memory/最近5分钟错误数（取代写死的「● 运行中」）。
  // 三个 fetch 并发；用 _fetchSeq token 丢弃过期响应。authenticate 经同源 cookie 通过
  // （与 backendMonitor.mjs:283 同源调用 /api/v1/monitor/plugins 一致）。
  const fetchLogs = async () => {
    const seq = ++_fetchSeq;
    const stale = () => seq !== _fetchSeq; // 有更新请求发出后，本次结果作废
    // ── 运行时日志（beilu-logger）──
    try {
      // T2批23：走 getLogs（notify:"report"，轮询读路失败不弹 toast 进报错系统）。sendAction 直返 body（非 2xx 自动 throw 进本 catch）。
      const data = await sendAction({ verb: "getLogs", target: "plugins:beilu-logger", source: "web", payload: { level: currentLevel, limit: 200 } });
      if (stale()) return;
      const logs = data.logs || [];
      if (logs.length === 0) {
        logOutput.innerHTML = '<p class="text-base-content/50 text-center py-2">暂无日志</p>';
      } else {
        logOutput.innerHTML = logs.map(l => {
          const icon = l.level === 'error' ? '<i data-ic="cross"></i>' : l.level === 'warn' ? '<i data-ic="warning"></i>' : '<i data-ic="edit"></i>';
          const time = l.time ? new Date(l.time).toLocaleTimeString('zh-CN') : '';
          const color = l.level === 'error' ? 'text-error' : l.level === 'warn' ? 'text-warning' : '';
          return `<div class="${color}">${icon} <span class="opacity-40">${time}</span> ${escapeHtml(l.message || '')}</div>`;
        }).join('');
        logOutput.scrollTop = logOutput.scrollHeight;
      }
    } catch (e) {
      if (!stale()) logOutput.innerHTML = `<p class="text-error text-center py-2">日志加载失败: ${e.message}</p>`;
    }

    // ── 错误追踪（server/monitor.mjs 权威缓冲，含前端上报错误）──
    if (errOutput) {
      try {
        // 来源过滤经后端 source 参数（monitor.mjs /errors 支持 source）。limit=200 给详情列表更全的历史。
        // T2批23：走 getErrors（notify:"report"），source 缺省不带（'all' 不设 query）。
        const _src = (currentErrSource && currentErrSource !== 'all') ? currentErrSource : undefined;
        const data = await sendAction({ verb: "getErrors", target: "server:monitor", source: "web", payload: { limit: 200, ...(_src ? { source: _src } : {}) } });
        if (stale()) return;
        const entries = data.entries || []; // 已 reverse（最新在前），每条附 count/firstSeen（monitor.mjs 查询边界聚合）
        if (entries.length === 0) {
          // 空态引导文案（凛倾：优化用户前端体验）
          errOutput.innerHTML = '<p class="text-base-content/50 text-center py-2 leading-relaxed">无错误记录。<br/>前端未捕获异常会自动上报；console.error 桥接可在上方开启。</p>';
        } else {
          const errN = entries.filter(e => e.level === 'error').length;
          const warnN = entries.filter(e => e.level === 'warn').length;
          const head = `<div class="text-xs opacity-60 mb-1"><i data-ic="cross"></i> ${errN} · <i data-ic="warning"></i> ${warnN} · 共 ${data.total ?? entries.length} 条 · 点击展开详情</div>`;
          const rows = entries.map(en => renderErrorRow(en)).join('');
          errOutput.innerHTML = head + rows;
        }
      } catch (e) {
        if (!stale()) errOutput.innerHTML = `<p class="text-warning text-center py-2">错误数据不可用: ${escapeHtml(e.message)}</p>`;
      }
    }

    // ── 系统状态（/api/v1/monitor/health 真实数据）──
    if (statusOutput) {
      try {
        // T2批23：走 getHealth（notify:"report"）。sendAction 直返 body（非 2xx 自动 throw 进本 catch 降级）。
        const h = await sendAction({ verb: "getHealth", target: "server:monitor", source: "web" });
        if (stale()) return;
        const ok = h.status === 'ok';
        const statusColor = ok ? 'text-success' : 'text-warning';
        const statusText = ok ? '● 运行中' : '▲ ' + (h.status || '降级');
        const uptimeStr = Number.isFinite(h.uptime) ? fmtUptime(h.uptime) : 'N/A';
        const mem = h.memory || {};
        const last5 = h.errors ? (h.errors.last5min || 0) : 0;
        statusOutput.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">服务状态</span>
            <span class="${statusColor} text-[10px]">${statusText}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">运行时间</span>
            <span class="text-[10px]">${uptimeStr}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">内存 (heap/rss)</span>
            <span class="text-[10px]">${mem.heapUsedMB || '?'} / ${mem.rssMB || '?'} MB</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">近5分钟错误</span>
            <span class="text-[10px] ${last5 > 0 ? 'text-error' : ''}">${last5}</span>
          </div>
        `;
      } catch (e) {
        // health 拉取失败（未登录/端点异常）：状态块降级显示，不影响日志/错误块
        if (!stale()) statusOutput.innerHTML = `<div class="text-warning text-[10px]">状态不可用: ${escapeHtml(e.message)}</div>`;
      }
    }
  };

  // Level filter
  controls.querySelectorAll('.mon-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      controls.querySelectorAll('.mon-filter').forEach(b => { b.classList.add('btn-ghost'); b.style.background = ''; });
      btn.classList.remove('btn-ghost');
      btn.style.background = 'oklch(var(--b2))';
      currentLevel = btn.dataset.level;
      fetchLogs();
    });
  });

  // Auto refresh —— 异步生命周期收口（凛倾点名注意异步）
  //   · 单一 timer，startAuto/stopAuto 配对，绝不并行多个 interval；
  //   · timer 仅在「勾选 且 section 可见」时存在；
  //   · MutationObserver 监听 monitor section 的 .hidden（切走 section / 关设置弹窗都会加 .hidden），
  //     隐藏即 stopAuto（立即停，不等下个 tick），重新可见且仍勾选则 startAuto。
  const autoCb = controls.querySelector('#mon-auto-refresh');
  // monitor section 容器（index.html: div.settings-section[data-section="monitor"]）
  const monSection = logOutput.closest('.settings-section') || document.querySelector('.settings-section[data-section="monitor"]');
  const isVisible = () => !!(logOutput.offsetParent); // 隐藏(.hidden/display:none)时为 null
  const refreshAll = () => { fetchLogs(); fetchPluginStatus(); };
  const startAuto = () => {
    if (autoRefreshTimer) return;            // 防重入：已存在不再起第二个
    autoRefreshTimer = setInterval(refreshAll, 5000);
  };
  const stopAuto = () => {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  };
  autoCb?.addEventListener('change', (e) => {
    if (e.target.checked && isVisible()) startAuto();
    else stopAuto();
  });
  if (monSection) {
    const monObs = new MutationObserver(() => {
      const visible = isVisible();
      if (visible) {
        fetchLogs(); fetchPluginStatus();     // 重新进入面板：立即刷新一次拿最新
        if (autoCb?.checked) startAuto();     // 仍勾选则恢复自动刷新
      } else {
        stopAuto();                           // 隐藏/关弹窗：立即停 timer（异步泄漏收口）
      }
    });
    monObs.observe(monSection, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  // Copy
  controls.querySelector('#mon-copy-log')?.addEventListener('click', () => {
    copyWithFeedback(logOutput.innerText, controls.querySelector('#mon-copy-log'), '✅');
  });

  // Clear
  clearBtn?.addEventListener('click', async () => {
    if (!await beiluConfirm('清空所有日志？')) return;
    try {
      // T2批23：交互写按钮 → clearLogs（缺省 toast，失败让用户可见）。
      await sendAction({ verb: "clearLogs", target: "plugins:beilu-logger", source: "web" });
      fetchLogs();
    } catch {}
  });

  // ── 插件加载状态（拉线自 /api/v1/monitor/plugins，此前仅 IDE 面板有） ──
  const pluginsOutput = document.getElementById("settings-monitor-plugins");
  const pluginRefreshBtn = document.getElementById("settings-monitor-refresh-plugins");
  const PLUGIN_ERROR_STATUSES = new Set(["load-error", "shallow-load-error", "unload-error", "init-error"]);

  const fetchPluginStatus = async () => {
    if (!pluginsOutput) return;
    try {
      // P1-2（一致性审计②双通道）：apiFetch 直连 → 既有 verb server:monitor#getPlugins（sendAction.mjs:460）；
      //   !ok 由门面抛错落下方 catch（原 !ok 分支的状态码文案并入 e.message，诊断面不丢）
      const data = await sendAction({ verb: "getPlugins", target: "server:monitor", source: "web" });
      const plugins = data?.plugins || {};
      const entries = Object.entries(plugins);
      if (entries.length === 0) {
        pluginsOutput.innerHTML = '<p class="text-base-content/50 text-center py-1">无已注册插件</p>';
        return;
      }
      // 按状态排序：错误在上
      entries.sort(([, a], [, b]) => {
        const ae = PLUGIN_ERROR_STATUSES.has(a.status) ? 0 : 1;
        const be = PLUGIN_ERROR_STATUSES.has(b.status) ? 0 : 1;
        return ae - be;
      });
      pluginsOutput.innerHTML = entries.map(([name, info]) => {
        const isErr = PLUGIN_ERROR_STATUSES.has(info.status);
        const color = isErr ? "text-error" : info.status === "loaded" ? "text-success" : "";
        const icon = isErr ? '<i data-ic="cross"></i>' : info.status === "loaded" ? '<i data-ic="check"></i>' : info.status === "inited" ? '<i data-ic="hourglass"></i>' : "◻️";
        const detail = info.detail
          ? (typeof info.detail === "string" ? info.detail : JSON.stringify(info.detail))
          : "";
        const time = info.lastUpdate ? new Date(info.lastUpdate).toLocaleTimeString("zh-CN") : "";
        return `<div class="${color} flex items-start gap-1"><span>${icon}</span><span class="flex-1 break-all">${escapeHtml(name)} <span class="opacity-50">[${escapeHtml(info.status)}]</span>${detail ? " " + escapeHtml(detail.slice(0, 120)) : ""}</span><span class="opacity-40 shrink-0">${time}</span></div>`;
      }).join("");
    } catch (e) {
      pluginsOutput.innerHTML = `<p class="text-warning text-center py-1">拉取失败: ${escapeHtml(e.message)}</p>`;
    }
  };

  pluginRefreshBtn?.addEventListener("click", fetchPluginStatus);

  // ── 前端监控设置 ──
  const pollToggle = document.getElementById("mon-poll-toggle");
  const POLL_KEY = KEYS.BEILU_MONITOR_POLL_ENABLED; // T041b: 收编 KEYS 单源（原字面 "beilu-monitor-poll-enabled"，与 backendMonitor 同 key）
  // 恢复持久化状态
  try { if (storage.get(POLL_KEY) === "0") { if (pollToggle) pollToggle.checked = false; } } catch {}

  pollToggle?.addEventListener("change", (e) => {
    try { storage.set(POLL_KEY, e.target.checked ? "1" : "0"); } catch {}
    // 通知 backendMonitor 停/启轮询
    window.dispatchEvent(new CustomEvent("beilu:monitor-poll-toggle", { detail: { enabled: e.target.checked } }));
  });

  // Initial load
  fetchLogs();
  fetchPluginStatus();
}

// 渲染单条错误为可展开详情行（<details>）。
// entry 字段来自 monitor.mjs makeErrorEntry + 查询边界聚合：
//   level/module/route/userId/message/stack/context{url,line,col,userAgent}/source/timestamp/count/firstSeen
function renderErrorRow(en) {
  const icon = en.level === 'error' ? '<i data-ic="cross"></i>' : en.level === 'warn' ? '<i data-ic="warning"></i>' : '<i data-ic="info"></i>';
  const color = en.level === 'error' ? 'text-error' : en.level === 'warn' ? 'text-warning' : '';
  const time = en.timestamp ? new Date(en.timestamp).toLocaleTimeString('zh-CN') : '';
  // source: frontend/server；module: console/route/frontend...（monitor.mjs makeErrorEntry）
  const tag = en.source === 'frontend' ? '前端' : (en.module || 'server');
  const count = (en.count && en.count > 1) ? `<span class="badge badge-xs badge-warning ml-1" title="同错累计出现次数">×${en.count}</span>` : '';
  const ctx = en.context || {};
  // 详情字段（仅渲染存在的，避免一堆「null」噪音）
  const detailRows = [];
  if (en.source) detailRows.push(['来源', en.source]);
  if (en.module) detailRows.push(['模块', en.module]);
  if (en.route) detailRows.push(['路由', en.route]);
  if (en.userId) detailRows.push(['用户', en.userId]);
  if (en.timestamp) detailRows.push(['时间', new Date(en.timestamp).toLocaleString('zh-CN')]);
  if (en.firstSeen && en.firstSeen !== en.timestamp) detailRows.push(['首次', new Date(en.firstSeen).toLocaleString('zh-CN')]);
  if (en.count && en.count > 1) detailRows.push(['累计', `${en.count} 次`]);
  if (ctx.url) detailRows.push(['URL', ctx.url]);
  if (ctx.line != null) detailRows.push(['行:列', `${ctx.line}:${ctx.col ?? '?'}`]);
  if (ctx.userAgent) detailRows.push(['UA', ctx.userAgent]);
  const meta = detailRows.map(([k, v]) =>
    `<div class="flex gap-2"><span class="opacity-40 shrink-0 w-12">${k}</span><span class="break-all">${escapeHtml(String(v))}</span></div>`
  ).join('');
  const stackBlock = en.stack
    ? `<div class="mt-1"><span class="opacity-40">stack</span><pre class="whitespace-pre-wrap break-all mt-0.5 opacity-80 text-[9px] leading-snug">${escapeHtml(en.stack)}</pre></div>`
    : '';
  return `<details class="${color} border-b border-base-content/5">
    <summary class="py-0.5 cursor-pointer list-none flex items-center gap-1">
      <span>${icon}</span><span class="opacity-40">${time}</span><span class="opacity-50">[${escapeHtml(tag)}]</span>
      <span class="truncate flex-1">${escapeHtml(en.message || '')}</span>${count}
    </summary>
    <div class="pl-4 pb-1 pt-0.5 space-y-0.5 text-[9px] text-base-content/70">${meta}${stackBlock}</div>
  </details>`;
}

function timeSince(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}小时${mins % 60}分`;
  return `${Math.floor(hrs / 24)}天${hrs % 24}小时`;
}

// health.uptime 为秒（monitor.mjs /api/v1/monitor/health：Math.floor((now-startTime)/1000)）
function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分${sec % 60}秒`;
}

// ============================================================
// ============================================================
// [2026-08-01 W6] toggle 手动控制面
// ============================================================

async function initToggleSlot() {
  const anchor = document.getElementById("settings-plugin-config");
  if (!anchor || !anchor.parentElement) return;
  if (document.getElementById("settings-toggle-slot")) return;

  const slot = document.createElement("div");
  slot.id = "settings-toggle-slot";
  slot.className = "mt-4";
  anchor.parentElement.appendChild(slot);

  slot.innerHTML = `
    <div class="collapse collapse-arrow bg-base-200/30 rounded-lg">
      <input type="checkbox" />
      <div class="collapse-title text-sm font-medium min-h-0 py-2 px-3"><i data-ic="shuffle"></i> AI 条目控制</div>
      <div class="collapse-content px-3 pb-3 text-xs space-y-2">
        <p class="opacity-50">AI 通过 &lt;toggle&gt; 标签动态启/禁预设条目。此面板可手动翻转或查看 AI 历史操作。</p>
        <div id="toggle-entry-list" class="space-y-1"></div>
        <div class="flex gap-2 mt-2">
          <button id="toggle-refresh" class="btn btn-xs btn-outline btn-info">刷新</button>
          <button id="toggle-clear-all" class="btn btn-xs btn-outline btn-warning">清除所有覆盖</button>
        </div>
        <div id="toggle-history" class="mt-2"></div>
      </div>
    </div>
  `;

  async function loadToggle() {
    const listEl = slot.querySelector("#toggle-entry-list");
    const histEl = slot.querySelector("#toggle-history");
    if (!listEl) return;
    try {
      // 获取当前覆盖状态
      const tgData = await sendAction({ verb: "getData", target: "plugins:beilu-toggle", source: "web" });
      const overrides = tgData?.overrides || {};
      const history = tgData?.history || [];

      // 从 preset 获取可控条目列表（toggleable_entries）
      let entries = [];
      try {
        const presetData = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
        entries = presetData?.toggleable_entries || [];
      } catch {}

      if (entries.length === 0) {
        listEl.innerHTML = '<p class="opacity-40">当前预设无可控条目</p>';
      } else {
        listEl.innerHTML = entries.map(e => {
          const overridden = overrides[e.identifier] !== undefined;
          const currentEnabled = overridden ? overrides[e.identifier] : e.enabled;
          return `<div class="flex items-center gap-2 px-2 py-1 rounded ${overridden ? 'bg-warning/10' : 'bg-base-200/40'}">
            <input type="checkbox" class="toggle toggle-xs toggle-success toggle-entry-cb" data-identifier="${e.identifier}" ${currentEnabled ? 'checked' : ''} />
            <span class="flex-1 truncate">${e.name || e.identifier}</span>
            ${overridden ? '<span class="badge badge-xs badge-warning">已覆盖</span>' : ''}
          </div>`;
        }).join("");

        listEl.querySelectorAll(".toggle-entry-cb").forEach(cb => {
          cb.addEventListener("change", async () => {
            try {
              await sendAction({ verb: "setData", target: "plugins:beilu-toggle", source: "web",
                payload: { manual_toggle: { identifier: cb.dataset.identifier, enabled: cb.checked } } });
              loadToggle();
            } catch (err) { console.error("[toggle] 手动翻转失败:", err); }
          });
        });
      }

      // 历史
      if (history.length > 0) {
        histEl.innerHTML = '<p class="text-[10px] opacity-40 mb-1">最近操作</p>' +
          history.slice(-5).reverse().map(h => {
            const t = h.time ? new Date(h.time).toLocaleTimeString() : '?';
            return `<div class="text-[10px] opacity-50">${t} · ${h.source === 'ai' ? 'AI' : '手动'} · ${h.identifier} → ${h.enabled ? '启用' : '禁用'}</div>`;
          }).join("");
      } else {
        histEl.innerHTML = '';
      }
    } catch (err) { listEl.innerHTML = `<p class="text-error text-xs">${err.message}</p>`; }
  }

  slot.querySelector("#toggle-refresh")?.addEventListener("click", loadToggle);
  slot.querySelector("#toggle-clear-all")?.addEventListener("click", async () => {
    try {
      await sendAction({ verb: "setData", target: "plugins:beilu-toggle", source: "web", payload: { clear_overrides: true } });
      loadToggle();
    } catch (err) { console.error("[toggle] 清除覆盖失败:", err); }
  });

  loadToggle();
}

// 请求预览面板 (W63新增: fakeSend)
// ============================================================

async function initFakeSendSlot() {
  const slot = document.getElementById("settings-fakesend-slot");
  if (!slot) return;

  slot.innerHTML = `
    <div class="space-y-3 mt-2">
      <div class="flex items-center gap-2">
        <select id="fs-chat-select" class="select select-xs select-bordered flex-1">
          <option value="">选择聊天...</option>
        </select>
        <button id="fs-refresh" class="btn btn-xs btn-ghost" title="刷新"><i data-ic="refresh"></i></button>
        <button id="fs-build" class="btn btn-xs btn-primary">生成预览</button>
      </div>
      <div id="fs-status" class="text-[10px] opacity-40"></div>
      <div id="fs-result" class="hidden">
        <!-- Stats -->
        <div id="fs-stats" class="flex gap-2 flex-wrap text-[10px] mb-2"></div>
        <!-- Sub tabs -->
        <div class="flex gap-0.5 border-b border-base-content/10 mb-2">
          <button class="btn btn-xs fs-tab active" data-tab="messages" style="background:oklch(var(--b2))">消息</button>
          <button class="btn btn-xs btn-ghost fs-tab" data-tab="params">参数</button>
          <button class="btn btn-xs btn-ghost fs-tab" data-tab="raw">原始JSON</button>
        </div>
        <div id="fs-tab-messages" class="fs-tab-content max-h-64 overflow-y-auto"></div>
        <div id="fs-tab-params" class="fs-tab-content hidden"></div>
        <div id="fs-tab-raw" class="fs-tab-content hidden">
          <div class="flex justify-end mb-1"><button id="fs-copy-raw" class="btn btn-xs btn-ghost">📋 复制</button></div>
          <pre id="fs-raw-output" class="text-[10px] font-mono bg-base-200 rounded p-2 max-h-60 overflow-auto whitespace-pre-wrap"></pre>
        </div>
      </div>
    </div>
  `;

  const $ = id => slot.querySelector('#' + id);

  // Load chat list
  const loadChats = async () => {
    try {
      // T2批23：下拉填充静默读 → getChatListQuiet（notify:"report"，失败不弹 toast 进报错系统）。
      const chats = await sendAction({ verb: "getChatListQuiet", target: "shells:chat", source: "web" });
      const sel = $('fs-chat-select');
      sel.innerHTML = '<option value="">选择聊天...</option>' +
        (Array.isArray(chats) ? chats : []).map(c => {
          const id = c.chatid || c.id || c;
          const label = c.chars ? `${c.chars.join(',')} (${id.substring(0,8)})` : id.substring(0,16);
          return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
        }).join('');
    } catch {}
  };

  // Build request preview
  const buildPreview = async () => {
    const chatId = $('fs-chat-select').value;
    if (!chatId) { $('fs-status').textContent = '请选择聊天'; return; }
    $('fs-build').disabled = true;
    $('fs-build').textContent = '生成中...';
    $('fs-status').textContent = '';
    try {
      // T2批1收口：raw GET → sendAction 门面（getFakeSend REST，回包 {messages,_meta,model} 裸体等价；if(!res.ok)throw 由门面接管删除）
      const data = await sendAction({ verb: "getFakeSend", target: "shells:chat", source: "web", scope: { chatId } });
      const msgs = data.messages || [];
      const meta = data._meta || {};

      // Stats
      $('fs-stats').innerHTML = [
        `<span class="badge badge-xs">${msgs.length} 消息</span>`,
        `<span class="badge badge-xs badge-info">${meta.system_prompt_chars || 0} 系统字符</span>`,
        `<span class="badge badge-xs badge-warning">${meta.total_chars || 0} 总字符</span>`,
        `<span class="badge badge-xs badge-success">~${meta.estimated_tokens || 0} tokens</span>`,
        `<span class="badge badge-xs">${data.model || 'N/A'}</span>`,
      ].join(' ');

      // Messages tab
      $('fs-tab-messages').innerHTML = msgs.map((m, i) => {
        const roleColor = m.role === 'system' ? 'badge-ghost' : m.role === 'user' ? 'badge-info' : 'badge-success';
        const preview = escapeHtml((m.content || '').substring(0, 80)); // T7b：原单字符 .replace(/</g) 只挡 <，&/>/引号未转仍插 innerHTML；收口壳权威版，与下行 full 同源
        const full = escapeHtml(m.content || '');
        return `<div class="mb-1 text-xs"><div class="flex items-center gap-1 cursor-pointer fs-msg-toggle" data-idx="${i}"><span class="text-[10px] opacity-50">▶</span><span class="badge badge-xs ${roleColor}">${m.role}</span><span class="opacity-60">[${(m.content||'').length}]</span><span class="truncate opacity-80">${preview}</span></div><div class="fs-msg-full hidden bg-base-200 rounded p-2 mt-1 text-[10px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">${full}</div></div>`;
      }).join('');
      // Toggle expand
      $('fs-tab-messages').querySelectorAll('.fs-msg-toggle').forEach(el => {
        el.addEventListener('click', () => {
          const full = el.nextElementSibling;
          full.classList.toggle('hidden');
          el.querySelector('span').textContent = full.classList.contains('hidden') ? '▶' : '▼';
        });
      });

      // Params tab
      const paramKeys = ['model','temperature','max_tokens','stream','top_p','top_k','presence_penalty','frequency_penalty','stop'];
      $('fs-tab-params').innerHTML = `<div class="grid grid-cols-2 gap-1 text-xs">${paramKeys.map(k => data[k] !== undefined ? `<span class="opacity-60">${k}</span><span class="font-mono">${JSON.stringify(data[k])}</span>` : '').join('')}</div>${meta.char_display_name ? `<div class="mt-2 text-xs opacity-40">角色: ${escapeHtml(meta.char_display_name)} | 用户: ${escapeHtml(meta.user_display_name||'')}</div>` : ''}`;

      // Raw JSON
      const json = JSON.stringify(data, null, 2);
      $('fs-raw-output').textContent = json.length > 50000 ? json.substring(0, 50000) + '\n... (截断)' : json;

      $('fs-result').classList.remove('hidden');
      $('fs-status').textContent = `生成于 ${new Date().toLocaleTimeString('zh-CN')}`;
    } catch (e) {
      $('fs-status').textContent = '❌ ' + e.message;
      $('fs-result').classList.add('hidden');
    }
    $('fs-build').disabled = false;
    $('fs-build').textContent = '生成预览';
  };

  // Sub tabs
  slot.querySelectorAll('.fs-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      slot.querySelectorAll('.fs-tab').forEach(b => { b.classList.add('btn-ghost'); b.style.background = ''; });
      btn.classList.remove('btn-ghost');
      btn.style.background = 'oklch(var(--b2))';
      slot.querySelectorAll('.fs-tab-content').forEach(c => c.classList.add('hidden'));
      slot.querySelector(`#fs-tab-${btn.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  $('fs-refresh').addEventListener('click', loadChats);
  $('fs-build').addEventListener('click', buildPreview);
  $('fs-copy-raw')?.addEventListener('click', () => {
    copyWithFeedback($('fs-raw-output').textContent, $('fs-copy-raw'));
  });

  await loadChats();
}

// 输出标签管控已迁入正则编辑器 (regexEditor.mjs)

// ============================================================
// beilu-sysinfo 系统信息注入配置 slot（孤儿verb期2·用户设置类）
//   why：功能链 GetData→includeTime/includeOS/includeMemory/refreshInterval + customFields 后端有字段
//        （functions/prompt/sysinfo/main.mjs:105-114 pluginData + :134-144 GetData + :174-179 字段直写 SetData），
//        前端零编辑入口=孤儿。sysinfo 默认 enabled:true 已在用，注入内容开关为用户中频控制项。
//   契约（亲读 sysinfo/main.mjs:145-180）：混合分发——布尔/数值字段无 _action 直写（本 slot 保存走此路）；
//        自定义字段增删走 _action addCustomField/removeCustomField（field:{key,value} / index）。
//        customFields 也支持整体字段直写（:178），故本 slot 直接整表回写 customFields（不逐条 _action，减少往返）。
//   敏感性：sysinfo 无凭据字段，全明文可见。落位锚 settings-plugin-config 同级追加，范式镜像 initStripTagsSlot。
async function initSysinfoConfigSlot() {
  const anchor = document.getElementById("settings-plugin-config");
  if (!anchor || !anchor.parentElement) return;
  if (document.getElementById("settings-sysinfo-slot")) return;

  // T2批1收口：SI_API 常量 + postSi raw 封装已删（getdata/setdata 均改走 sendAction 门面）。
  const slot = document.createElement("div");
  slot.id = "settings-sysinfo-slot";
  anchor.parentElement.appendChild(slot);

  let cfg = {};
  try {
    // T2批1收口：raw GET → sendAction 门面（plugins:beilu-sysinfo#getData REST 精确路由，回包=解析体裸体等价）
    cfg = await sendAction({ verb: "getData", target: "plugins:beilu-sysinfo", source: "web" }) || {};
  } catch (e) {
    slot.innerHTML = `<p class="text-xs text-error mt-2">beilu-sysinfo 配置加载失败: ${escapeHtml(e.message)}</p>`;
    return;
  }

  // customFields 本地态（回填自后端；增删改后整表 direct-write）
  let customFields = Array.isArray(cfg.customFields) ? cfg.customFields.map(f => ({ key: f.key || "", value: f.value || "" })) : [];

  slot.innerHTML = `
    <div class="space-y-3 mt-3 p-3 bg-base-200/50 rounded-lg">
      <h4 class="text-sm font-bold"><i data-ic="info"></i> beilu-sysinfo 系统信息注入</h4>
      <p class="text-xs text-base-content/40">注入给 AI 的运行环境上下文（时间/系统/内存/自定义）</p>
      <div class="space-y-2">
        <!-- [0722 差集补入口] enabled 总开关：后端可配（sysinfo SetData 接受）此前无 toggle -->
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-enabled" class="toggle toggle-xs toggle-warning" ${cfg.enabled !== false ? 'checked' : ''} />
          <span class="text-xs">启用系统信息注入（总开关）</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-time" class="toggle toggle-xs toggle-success" ${cfg.includeTime ? 'checked' : ''} />
          <span class="text-xs">注入时间信息</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-os" class="toggle toggle-xs toggle-success" ${cfg.includeOS ? 'checked' : ''} />
          <span class="text-xs">注入系统/主机信息</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="si-mem" class="toggle toggle-xs toggle-info" ${cfg.includeMemory ? 'checked' : ''} />
          <span class="text-xs">注入内存占用</span>
        </label>
      </div>
      <label class="flex items-center justify-between gap-2">
        <span class="text-xs">刷新间隔（秒，0=每次刷新）</span>
        <input type="number" id="si-refresh" min="0" step="1" class="input input-xs input-bordered w-24" value="${cfg.refreshInterval ?? ''}" />
      </label>
      <!-- 自定义字段 -->
      <div>
        <span class="text-xs font-medium">自定义字段</span>
        <div id="si-custom-list" class="space-y-1 mt-1"></div>
        <div class="flex gap-1 mt-1">
          <input id="si-new-key" class="input input-xs input-bordered flex-1" placeholder="键" />
          <input id="si-new-val" class="input input-xs input-bordered flex-1" placeholder="值" />
          <button id="si-add-field" class="btn btn-xs btn-ghost btn-success">＋</button>
        </div>
      </div>
      <button id="si-save" class="btn btn-xs btn-primary w-full"><i data-ic="save"></i> 保存配置</button>
      <div id="si-status" class="text-xs text-center hidden"></div>
    </div>
  `;

  const $ = (id) => slot.querySelector("#" + id);
  const showStatus = (msg, type = "info") => {
    const st = $("si-status");
    st.textContent = msg;
    st.className = `text-xs text-center ${type === "success" ? "text-success" : type === "error" ? "text-error" : "text-warning"}`;
    st.classList.remove("hidden");
    if (type === "success") setTimeout(() => st.classList.add("hidden"), 2000);
  };

  const renderCustom = () => {
    const el = $("si-custom-list");
    el.innerHTML = customFields.map((f, i) =>
      `<div class="flex items-center gap-1">
        <span class="badge badge-sm flex-1 justify-start gap-1 font-mono overflow-hidden"><span class="truncate">${escapeHtml(f.key)}</span>=<span class="truncate opacity-70">${escapeHtml(f.value)}</span></span>
        <button class="si-rm-field btn btn-xs btn-ghost btn-error" data-i="${i}">✕</button>
      </div>`
    ).join("");
    el.querySelectorAll(".si-rm-field").forEach(btn => {
      btn.addEventListener("click", () => {
        customFields.splice(Number(btn.dataset.i), 1);
        renderCustom();
      });
    });
  };
  renderCustom();

  $("si-add-field").addEventListener("click", () => {
    const k = $("si-new-key").value.trim();
    const v = $("si-new-val").value.trim();
    if (!k) return;
    customFields.push({ key: k, value: v });
    $("si-new-key").value = "";
    $("si-new-val").value = "";
    renderCustom();
  });

  $("si-save").addEventListener("click", async () => {
    try {
      // 字段直写（无 _action）→ 后端 sysinfo/main.mjs:174-179。customFields 整表回写（:178 支持）。
      const body = {
        enabled: $("si-enabled").checked, // [0722 差集补入口] 总开关随表提交
        includeTime: $("si-time").checked,
        includeOS: $("si-os").checked,
        includeMemory: $("si-mem").checked,
        customFields,
      };
      const ri = $("si-refresh").value.trim();
      if (ri !== "") body.refreshInterval = Number(ri);
      // T2批1收口：postSi raw POST 封装 → sendAction 门面（updateSysinfoConfig REST 字段直写含 customFields 整表，if(!res.ok)throw 由门面接管删除）
      await sendAction({ verb: "updateSysinfoConfig", target: "plugins:beilu-sysinfo", source: "web", payload: body });
      showStatus("✅ 已保存", "success");
    } catch (e) {
      showStatus("❌ " + e.message, "error");
    }
  });
}

// ============================================================
// AI 注入文本配置 slot（0710 铁律【代码禁产生进对话文本】收口专项）
//   why：browser/web/sysinfo/toggle/files/memory/bots 各 producer 注入 messages 的引导句/占位符
//        此前硬编码，收口为 functions:injectTexts 单源目录+覆盖层后，用户需要一个编辑面（本 slot）。
//   契约（后端 injectTexts/main.mjs）：getData→{entries:[{key,module,label,placeholders,default,override,effective}]}；
//        setData {overrides:{key:string|null}}，null=删覆盖恢复默认，空串=显式清空（合法，不 trim）。
//   形态：按 module 分组 <details> 折叠（操作界面三原则：不拥挤），textarea 显示生效值，
//        「默认」按钮回填出厂值；保存时 值===默认 → 发 null（收敛覆盖层，不落冗余键）。
//   落位/范式同 initSysinfoConfigSlot；走 sendAction 桥（functions:injectTexts，无旧 REST）。
// ============================================================
async function initInjectTextsSlot() {
  const anchor = document.getElementById("settings-plugin-config");
  if (!anchor || !anchor.parentElement) return;
  if (document.getElementById("settings-injecttexts-slot")) return;

  const slot = document.createElement("div");
  slot.id = "settings-injecttexts-slot";
  anchor.parentElement.appendChild(slot);

  let entries = [];
  try {
    const data = await sendAction({ verb: "getData", target: "functions:injectTexts", source: "web" });
    entries = data?.entries ?? [];
  } catch (e) {
    slot.innerHTML = `<p class="text-xs text-error mt-2">AI 注入文本配置加载失败: ${escapeHtml(e.message)}</p>`;
    return;
  }

  // 按 module 分组（保持后端目录顺序）
  const groups = new Map();
  for (const en of entries) {
    if (!groups.has(en.module)) groups.set(en.module, []);
    groups.get(en.module).push(en);
  }

  const rowsFor = (text) => Math.min(6, Math.max(2, String(text ?? "").split("\n").length));
  const groupHtml = [...groups.entries()].map(([mod, list]) => `
    <details class="collapse collapse-arrow bg-base-100/50 rounded-lg">
      <summary class="collapse-title text-xs font-medium py-2 min-h-0">${escapeHtml(mod)}<span class="opacity-40 ml-1">(${list.length})</span></summary>
      <div class="collapse-content space-y-2">
        ${list.map((en) => `
          <div>
            <div class="flex items-center justify-between">
              <span class="text-xs">${escapeHtml(en.label)}${en.override !== undefined ? ' <span class="badge badge-xs badge-warning">已改</span>' : ''}</span>
              <span class="flex items-center gap-1">
                ${en.placeholders?.length ? `<span class="text-[10px] opacity-40 font-mono">${escapeHtml(en.placeholders.map((p) => `{${p}}`).join(" "))}</span>` : ""}
                <button class="itx-reset btn btn-xs btn-ghost" data-key="${escapeHtml(en.key)}" title="回填出厂默认值">默认</button>
              </span>
            </div>
            <textarea class="itx-value textarea textarea-bordered textarea-xs w-full font-mono leading-snug" rows="${rowsFor(en.effective)}"
              data-key="${escapeHtml(en.key)}">${escapeHtml(en.effective)}</textarea>
          </div>`).join("")}
      </div>
    </details>`).join("");

  slot.innerHTML = `
    <div class="space-y-2 mt-3 p-3 bg-base-200/50 rounded-lg">
      <h4 class="text-sm font-bold"><i data-ic="edit"></i> AI 注入文本</h4>
      <p class="text-xs text-base-content/40">各功能注入进对话的引导句/占位文本，改后即时生效；「默认」回填出厂值。花括号变量运行时填充。</p>
      ${groupHtml}
      <button id="itx-save" class="btn btn-xs btn-primary w-full"><i data-ic="save"></i> 保存注入文本</button>
      <div id="itx-status" class="text-xs text-center hidden"></div>
    </div>
  `;

  const defaults = Object.fromEntries(entries.map((en) => [en.key, en.default]));
  const showStatus = (msg, type = "info") => {
    const st = slot.querySelector("#itx-status");
    st.textContent = msg;
    st.className = `text-xs text-center ${type === "success" ? "text-success" : type === "error" ? "text-error" : "text-warning"}`;
    st.classList.remove("hidden");
    if (type === "success") setTimeout(() => st.classList.add("hidden"), 2000);
  };

  slot.querySelectorAll(".itx-reset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ta = slot.querySelector(`.itx-value[data-key="${CSS.escape(btn.dataset.key)}"]`);
      if (ta) ta.value = defaults[btn.dataset.key] ?? "";
    });
  });

  slot.querySelector("#itx-save").addEventListener("click", async () => {
    try {
      // 不 trim：注入文本的空白/换行有语义（如多行引导块）；值===默认 → null 收敛覆盖层
      const overrides = {};
      slot.querySelectorAll(".itx-value").forEach((ta) => {
        const key = ta.dataset.key;
        overrides[key] = ta.value === defaults[key] ? null : ta.value;
      });
      const res = await sendAction({ verb: "setData", target: "functions:injectTexts", source: "web", payload: { overrides } });
      if (res?.rejected?.length) showStatus(`⚠️ 部分键被拒: ${res.rejected.join(", ")}`, "error");
      else showStatus("✅ 已保存", "success");
    } catch (e) {
      showStatus("❌ " + e.message, "error");
    }
  });
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
    const root = document.documentElement;
    root.style.setProperty("--beilu-amber", c.amber);
    if (c.amber_text) root.style.setProperty("--beilu-amber-text", c.amber_text);
    _deriveAmberAlphas(c.amber);
    const BEILU_COLOR_MAP = {
      amber: "--beilu-amber",
      amber_text: "--beilu-amber-text",
      accent: "--beilu-accent",
      accent_text: "--beilu-accent-text",
      error: "--beilu-error",
      success: "--beilu-success",
      warning: "--beilu-warning",
      bg_dark: "--beilu-bg-dark",
      bg_card: "--beilu-bg-card",
      modal_bg: "--beilu-modal-bg",
      text_dim: "--beilu-text-dim",
      border_subtle: "--beilu-border-subtle",
      bg_hover: "--beilu-bg-hover",
      user_msg_bg: "--beilu-user-msg-bg",
      bot_msg_bg: "--beilu-bot-msg-bg",
    };
    for (const [key, cssVar] of Object.entries(BEILU_COLOR_MAP)) {
      if (c[key]) root.style.setProperty(cssVar, c[key]);
    }
    storage.set(KEYS.BEILU_IMPORTED_THEME, JSON.stringify(theme));
    storage.set(KEYS.BEILU_COLOR_SCHEME, "imported:" + (theme.name || "beilu-custom"));
    if (themeBadge) themeBadge.textContent = theme.name || "beilu-custom";
    showToast("success", `已导入beilu主题「${theme.name || "beilu-custom"}」`);
    recordImportHistory("主题", theme.name || "beilu-custom");
  } catch (e) { showToast("error", "主题导入失败: " + e.message); }
}

/**
 * 导出当前配色为 beilu 主题 JSON（读 computed CSS 变量，纯前端无后端请求）。
 * 导出格式与 importThemeFile beilu 格式对齐（beilu_theme + colors），导入→导出→再导入可还原。
 */
export function exportCurrentTheme() {
  const gv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const EXPORT_MAP = {
    amber: "--beilu-amber",
    amber_text: "--beilu-amber-text",
    accent: "--beilu-accent",
    accent_text: "--beilu-accent-text",
    error: "--beilu-error",
    success: "--beilu-success",
    warning: "--beilu-warning",
    bg_dark: "--beilu-bg-dark",
    bg_card: "--beilu-bg-card",
    modal_bg: "--beilu-modal-bg",
    text_dim: "--beilu-text-dim",
    border_subtle: "--beilu-border-subtle",
    bg_hover: "--beilu-bg-hover",
    user_msg_bg: "--beilu-user-msg-bg",
    bot_msg_bg: "--beilu-bot-msg-bg",
  };
  const colors = {};
  for (const [key, cssVar] of Object.entries(EXPORT_MAP)) {
    const val = gv(cssVar);
    if (val) colors[key] = val;
  }
  const theme = { beilu_theme: true, name: "beilu-exported", colors };
  const blob = new Blob([JSON.stringify(theme, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "beilu-theme.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("success", "已导出当前配色");
}

export function initSettingsSlots() {
  // 恢复配色方案（优先于 dark/light toggle）
  const savedScheme = storage.get(KEYS.BEILU_COLOR_SCHEME);
  if (savedScheme) {
    document.documentElement.dataset.theme = savedScheme;
  }
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
