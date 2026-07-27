/**
 * memswitch.mjs — 记忆侧边栏查看模式切换按钮 cluster
 *
 * 功能链：initMemModeSwitchBtn() 初始化「查看模式」按钮（chat/code/work 三模式循环）
 *   → 按钮显示当前查看的记忆模式 → 用户点击=唯一写 window._beiluMemViewMode 的入口（不切换会话模式）
 *   → 派发 beilu:mem-view-changed 事件 → 记忆表格重载对应模式的记忆数据
 *   → 监听 beilu:mode-switched 事件：清空显式查看选择+重载（查看桶回到后端按本窗 chatid 解析的真值，
 *     不复制事件里的 newMode——它可能来自 char 级共享基线=别窗值，复制=多窗口写串毒种）
 *   → 同时绑定记忆内容/检索诊断/运维三组子 Tab 的切换按钮
 * why：记忆查看模式与当前会话模式解耦（可独立切换看别的模式的记忆）；查看态权威在后端
 *   per-chatid 解析（getData 回传 activeMode→beilu:mem-view-calibrated），前端不自持跨窗可漂移副本
 * 关联链：被 layout.mjs import（initMemModeSwitchBtn 在 initLayout 时调用）；
 *   import featureControls.mjs（getCurrentMode）、memtool.mjs（_showMemContentSub/_showDiagretrSub/_showOpsSub）
 * 影响范围：改动影响记忆 Tab 顶部的模式按钮显示、记忆表格内容的模式过滤、子 Tab 切换逻辑
 * 使用效果：用户在记忆 Tab 点击「聊天模式」按钮可切换查看「编程模式」的记忆，不影响当前正在进行的会话
 */
import { getCurrentMode } from "../feature/featureControls.mjs";
import { MODE_BADGE } from "../../shared/state/modeTabMap.mjs"; // D2 收口：模式文案单源
import { _showMemContentSub, _showDiagretrSub, _showOpsSub } from "./memtool.mjs";
import { whenVisible } from "../../shared/state/utils.mjs"; // 0718 可见性门控
const memModeSwitchBtn = document.getElementById("mem-mode-switch-btn"); // 镜像 layout.mjs:112 原模块级捕获(随迁)

// ============================================================
// 记忆侧边栏模式切换按钮
// ============================================================

/** 三模式循环顺序 */
const MODE_CYCLE = ["chat", "code", "work"];

/** 模式显示配置。[D2 收口 0713·凛倾「哪里来的设计?」] label 从 MODE_BADGE 权威派生（原手抄
 *  "聊天模式"=第三套模式文案副本，0709"场景化不收口"注释查证无拍板依据）。
 *  原 nextLabel 字段零消费（:41 已由 MODE_CYCLE 推导）=死字段，纯删。 */
const MODE_DISPLAY = Object.fromEntries(MODE_CYCLE.map((m) => [m, {
  icon: MODE_BADGE[m]?.icon || "",
  label: `${MODE_BADGE[m]?.label || m}模式`,
}]));

/**
 * 更新模式切换按钮的显示状态
 * @param {string} mode - "chat" | "code" | "work"
 */
function updateMemModeSwitchBtn(mode) {
  if (!memModeSwitchBtn) return;
  const display = MODE_DISPLAY[mode] || MODE_DISPLAY.chat;
  const nextIdx = (MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length;
  const nextDisplay = MODE_DISPLAY[MODE_CYCLE[nextIdx]] || MODE_DISPLAY.chat;
  memModeSwitchBtn.innerHTML = `${display.icon}<span style="font-size:10px;margin-left:4px;white-space:nowrap">${display.label}</span>`;
  memModeSwitchBtn.title = `查看: ${display.label}的记忆 · 点击查看${nextDisplay.label}（不切换当前会话）`;
}

// 按钮当前显示的模式（纯显示态）。查看态权威=后端 per-chatid activeMode（getData 回传，
//   dataTable 加载后派 beilu:mem-view-calibrated 校准）——本模块不再自持可跨窗漂移的副本。
let _shownMode = "";

function initMemModeSwitchBtn() {
  if (!memModeSwitchBtn) return;

  // [2026-07-16 多窗口写串根因修] 初始化不再用 getCurrentMode()（localStorage 跨窗口共享单值）
  //   灌种 window._beiluMemViewMode：毒种一旦写入，dataTable 的后端校准分支（仅 viewMode 空时触发）
  //   永不生效 → 别窗切模式 = 本窗记忆面板显示/编辑/归档全落别窗的桶（airp 窗口写进 code 桶实证，
  //   skh484s2khd 案）。留空 = getData 不带 viewMode → 后端按本窗 chatid（active_modes_map）解析
  //   真值 → 校准事件刷按钮。getCurrentMode() 只作首屏按钮显示回退，不写查看态。
  _shownMode = getCurrentMode();
  updateMemModeSwitchBtn(_shownMode);

  // 点击循环「查看模式」: chat → code → work → chat
  // ★只改查看哪个模式的记忆表格（派 beilu:mem-view-changed），不调 switchModeTo、
  //   不动会话 active_mode / 不恢复预设 / 不触发 mode-switched 那 7 个会话级消费者。
  //   用户显式选择 = 唯一允许写 window._beiluMemViewMode 的入口（明确要看别的桶）。
  memModeSwitchBtn.addEventListener("click", () => {
    const current = window._beiluMemViewMode || _shownMode || getCurrentMode();
    const target = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
    window._beiluMemViewMode = target;
    _shownMode = target;
    updateMemModeSwitchBtn(target);
    window.dispatchEvent(new CustomEvent("beilu:mem-view-changed", {
      detail: { viewMode: target, charName: window._beiluGetCharName?.() },
    }));
  });

  // 会话模式信号（tab / IDE 自动 / websocket / syncModeFromBackend 基线同步）到来时：
  //   ★不把 newMode 写进查看态（newMode 可能来自 char 级共享基线=别窗值，写入=毒种回流）。
  //   正解=清空显式查看选择，回到「跟随本窗会话真值」态并重载——getData 无 viewMode 由后端按
  //   本窗 chatid 解析，加载完 calibrated 事件刷按钮。任何来源的模式信号都只触发重新对齐，
  //   查看桶的值恒由后端 per-窗口解析，前端不复制。
  const MODE_SWITCH_DEBOUNCE_MS = 200;
  let _modeSwitchTimer = null;
  window.addEventListener("beilu:mode-switched", (e) => {
    const charName = e.detail?.charName;
    if (_modeSwitchTimer) clearTimeout(_modeSwitchTimer);
    _modeSwitchTimer = setTimeout(() => {
      _modeSwitchTimer = null;
      window._beiluMemViewMode = "";
      window.dispatchEvent(new CustomEvent("beilu:mem-view-changed", {
        detail: { viewMode: "", charName },
      }));
    }, MODE_SWITCH_DEBOUNCE_MS);
  });

  // [2026-07-16 查看按钮锚本窗真值] dataTable 用后端 per-窗口 activeMode 校准查看态后，仅刷按钮显示
  // （不重载表格——数据已按该模式取回，派 mem-view-changed 会循环）。见 dataTable.mjs 加载点同批注释。
  window.addEventListener("beilu:mem-view-calibrated", (e) => {
    const m = e.detail?.viewMode;
    if (m === "chat" || m === "code" || m === "work") {
      _shownMode = m;
      updateMemModeSwitchBtn(m);
    }
  });

  window.addEventListener("beilu:char-changed", (e) => {
    const charName = e.detail?.charName;
    // 保持用户显式查看选择；无显式选择时送空=跟随本窗会话真值（不再回退 getCurrentMode 共享单值）
    window.dispatchEvent(new CustomEvent("beilu:mem-view-changed", {
      detail: { viewMode: window._beiluMemViewMode || "", charName },
    }));
  });

  // 监听预设变更广播，同步顶部标题栏预设名
  // [多窗口审计 2026-07-11 A4] 字段名对齐后端载荷：producer(preset/main.mjs preset_changed)发 {preset}，
  //   原读 .presetName||.name 恒 miss（三方分歧：layout/smart 读 .preset 命中，本处从未生效）
  window.addEventListener("beilu:preset-changed", whenVisible("#center-tab-memory", async () => {
    // [0715 串扰点2] 原直取 e.detail.preset（触发方值）刷标题——global 切换会盖掉本窗 per-chat
    //   覆盖的显示。改调本窗生效值单源（sharedState resolveCurrentPresetName，桥同 layout 订阅站）。
    const name = await window._beiluResolveCurrentPreset?.();
    if (name) {
      const el = document.getElementById("preset-name");
      if (el) el.textContent = name;
    }
  }));

  // 合并 v4 #21：「记忆内容」子tab（文件树/表格）切换绑定
  document.querySelectorAll("#mem-content-subtabs .mem-csub-btn").forEach((b) => {
    b.addEventListener("click", () => _showMemContentSub(b.dataset.contentSub));
  });
  // 合并 v4 #21：「检索/诊断」子tab（诊断/检索）切换绑定
  document.querySelectorAll("#mem-diagretr-subtabs .mem-csub-btn").forEach((b) => {
    b.addEventListener("click", () => _showDiagretrSub(b.dataset.diagretrSub));
  });
  // 合并 v4 #21：「记忆运维」子tab（快照/格式/导入导出）切换绑定
  // （归档子tab已删——T5 2026-07-07 凛倾拍板删自动归档设置面板，data 归档入口在 dataTable）
  document.querySelectorAll("#mem-ops-subtabs .mem-csub-btn").forEach((b) => {
    b.addEventListener("click", () => _showOpsSub(b.dataset.opsSub));
  });
  // 导入/导出：复用底部既有 #mem-export-btn / #mem-import-btn（零新逻辑）
  document.getElementById("mem-io-export")?.addEventListener("click", () => {
    document.getElementById("mem-export-btn")?.click();
  });
  document.getElementById("mem-io-import")?.addEventListener("click", () => {
    document.getElementById("mem-import-btn")?.click();
  });
}

export { initMemModeSwitchBtn };
