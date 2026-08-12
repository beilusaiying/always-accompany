/**
 * layout.mjs — beilu-chat 主布局编排入口
 *
 * 功能链：页面加载 → initLayout() 统一初始化所有子 cluster → 顶部 Tab 切换（chat/bot/ide/memory/companion/smart）
 *   → 各模式按需挂载对应活动栏/侧栏/主区 → 布局状态通过 core.mjs 持久化到 localStorage
 * why：将所有布局级交互汇聚到单一入口，子 cluster 按功能域拆分后在此装配，避免循环依赖同时保留统一初始化时序
 * 关联链：被 index.html 的 <script type="module"> 直接引入作为应用入口；
 *   import 了 core/bot/ide/collapse/companion/memswitch/memtool/panels/smart/editor/charsel/settings/security 共 14 个 layout cluster
 * 影响范围：改动影响整个 beilu-chat UI 的初始化时序、Tab 切换逻辑、聊天容器挂载位置、模式切换后的布局恢复
 * 使用效果：用户打开页面看到三栏布局，点击顶部 Tab 在聊天/Bot 管理/文件/记忆/助手/SMART 六个模式间切换，
 *   各模式布局记忆在刷新后自动恢复
 */

import {
  getCurrentMode,
  initFeatureControls,
  switchModeTo,
  getModeChatIdKey,
} from "../../panels/feature/featureControls.mjs";
import { escapeHtml, DEFAULT_AVATAR, resolveAvatar } from "../state/utils.mjs";
import { DEFAULTS } from "../../config/defaults.mjs"; // T6：cleanup 模式缺省单源，收口 `|| "auto"` 副本

const _escHtml = escapeHtml;

import { addCharacter, currentChatId, removeCharacter } from "../transport/endpoints.mjs";
import { switchCharacterScope, chatBelongsToChar } from "../chat-core/chat.mjs";
import { initTempConversationListener } from "../widgets/tempConversation.mjs";
import { TAB_TO_MODE, MODE_TO_TAB, TAB_LABEL } from "../state/modeTabMap.mjs";

import {
  initIdeControlPanel,
  initIdeOpMonitor,
  initMenubar,
} from "../../panels/code/idePanel.mjs";
import { initPipelinePanel } from "../../panels/work/pipelinePanel.mjs";
import { initTaskItemPanel, mountTaskItemPanel } from "../../panels/task/taskItemPanel.mjs";
import { initTaskCard } from "../../panels/task/taskCard.mjs";
import { initCloneProgressCard } from "../../panels/task/cloneProgressCard.mjs";
import { initPermissionPanel } from "../../panels/feature/permissionPanel.mjs";
import { getCharId, isValidChatId } from "../state/sharedState.mjs";

import {
  closeMobilePanel,
  initMobileAdaptation,
  registerApplyPanelFns,
} from "./mobileAdaptation.mjs";

import { initBackendMonitor } from "../widgets/backendMonitor.mjs";
import { initConversationManager, fetchChatList } from "../chat-core/conversationManager.mjs";
import { initCardsPanel } from "../../panels/bot/cardsPanel.mjs";
import { initIdeConnPanel } from "../../panels/code/ideConnPanel.mjs";
import { initGroupPanel } from "../../panels/feature/groupPanel.mjs";
import { initGroupRuntimePanel } from "../../panels/feature/groupRuntimePanel.mjs";
import { initMcpPanel } from "../../panels/feature/mcpPanel.mjs";
import { renderBotSidePanel, stopBotLogPanel } from "../../panels/bot/botSidePanels.mjs";
import { initTaskTimeline } from "../../panels/task/taskTimeline.mjs";
import { initSubModePanel } from "../../panels/work/subModePanel.mjs";
import { initWorkPanel } from "../../panels/work/workPanel.mjs";
import { initSettingsSlots } from "../../panels/settings/settingsSlots.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作；memory 通配注入 _action；shells:chat/serviceSource 专用路由）
import { _initSecurityCenter } from "../../panels/settings/security.mjs"; // R3: 安全中心 cluster 抽出
import { initMemToolbar, _toggleMemMainArea, _showMemContentSub, _showDiagretrSub, _showOpsSub } from "../../panels/memory/memtool.mjs"; // R3: 记忆工具栏 cluster 抽出
import { initCompanionActivityBar } from "../../panels/companion/companion.mjs"; // R3: 桌宠/伴随 cluster 抽出
import { layoutState, loadState, saveState, initSidebarResize, applyLeftPanel, applyRightPanel, initPanelResize } from "./core.mjs"; // R3: 最小 core(状态层) 抽出
import { _loadPersonaEditor, _loadPresetPanel, _loadInjPanel, _openCharEditDialog } from "../../panels/settings/panels.mjs"; // R3: 面板加载器 cluster 抽出
import { initBotActivityBar } from "../../panels/bot/bot.mjs"; // R3: Bot 活动栏 cluster 抽出
import { initIdeActivityBar, restoreIdePanel } from "../../panels/code/ide.mjs"; // R3: IDE/记忆 活动栏 cluster 抽出
import { initCollapsePersistence } from "./collapse.mjs"; // R3: 折叠组持久化 cluster 抽出
import { initMemModeSwitchBtn } from "../../panels/memory/memswitch.mjs"; // R3: 记忆模式切换按钮 cluster 抽出
import { _setupSmartPolling, _refreshSmartTaskCounters, _setupSmartRightPanel, _populateSmartLeftPanel, updateSmartGreeting, _bindSmartGreetingObserver, _initSmartGreetingCategories, _initSmartCollapseMemory } from "../../panels/smart/smart.mjs"; // R3-c: SMART 全智能簇抽出
import { _bindEditorWindowSizing, _saveEditorPos, _bindResetWorkWelcome, _bindAirpMsgCtxInputs } from "./editor.mjs"; // R3-e: 编辑器弹窗 cluster 抽出
import { _initCharSelectorDropdown } from "../../panels/shared/charsel.mjs"; // R3-g: 角色卡选择 cluster 抽出
import { _initOutputFilterPanel, _toggleSettingsModal, _initSettingsModals } from "../../panels/settings/settings.mjs"; // R3-h: 设置弹窗 cluster 抽出
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { beiluConfirm } from "../widgets/beiluDialog.mjs";
import { createDiag } from "../state/diagLogger.mjs";

const diag = createDiag("layout");
// T006死码批: navigateToLayer 已删——全库唯三调用点都在 editor-entry 死绑定块内（块已同批删）。

// ============================================================
// DOM 引用
// ============================================================

// 顶部
const topTabs = document.getElementById("top-tabs");

// 三栏（聊天模式）
const leftPanel = document.getElementById("left-panel");
const rightPanel = document.getElementById("right-panel");
const leftToggle = document.getElementById("left-panel-toggle");
const rightToggle = document.getElementById("right-panel-toggle");

// 左栏内容区域（仅聊天模式使用左栏）
const leftContentChat = document.getElementById("left-content-chat");

// 聊天容器 & 停靠区
const chatContainer = document.getElementById("chat-container");
// 界面10: chatDock/chatDockToggle 死常量已删（W59 DOM 移除后全链 no-op）
const centerTabChat = document.getElementById("center-tab-chat");

// IDE 文件模式
const ideActivityBar = document.getElementById("ide-activity-bar");
const ideSidebar = document.getElementById("ide-sidebar");
const ideSidebarResize = document.getElementById("ide-sidebar-resize");
const ideMenubar = document.getElementById("ide-menubar");

// IDE 记忆模式
const memActivityBar = document.getElementById("mem-activity-bar");
const memSidebar = document.getElementById("mem-sidebar");

// ============================================================
// 状态
// ============================================================


// ============================================================
// 三栏折叠（聊天模式）
// ============================================================

// 左右栏开合按 tab 记忆（凛倾 07-11「侧栏没有记录上次操作」）：
// chat(AIRP)/smart 共用同一对 left/right panel DOM，其余 tab 整栏隐藏不参与开合记忆。
// smart 首次进入默认折叠（原 W59 Claude 风格）——仅默认值，用户操作后以 panelMemory 为准，不再每次强制。
const PANEL_MEMORY_TABS = new Set(["chat", "smart"]);
const PANEL_MEMORY_DEFAULTS = { smart: { left: true, right: true } };

function _snapshotPanelMemory() {
  if (!PANEL_MEMORY_TABS.has(layoutState.activeTab)) return;
  layoutState.panelMemory[layoutState.activeTab] = {
    left: layoutState.leftCollapsed,
    right: layoutState.rightCollapsed,
  };
}

function toggleLeftPanel() {
  layoutState.leftCollapsed = !layoutState.leftCollapsed;
  diag.debug("toggleLeftPanel → collapsed:", layoutState.leftCollapsed, "(tab:", layoutState.activeTab + ")");
  _snapshotPanelMemory();
  applyLeftPanel();
  saveState();
}

function toggleRightPanel() {
  layoutState.rightCollapsed = !layoutState.rightCollapsed;
  diag.debug("toggleRightPanel → collapsed:", layoutState.rightCollapsed, "(tab:", layoutState.activeTab + ")");
  _snapshotPanelMemory();
  applyRightPanel();
  saveState();
}

// ============================================================
// 左栏内容区域切换
// ============================================================

function switchLeftContent(tabName) {
  const leftSmartEl = document.getElementById("left-content-smart");
  // T2 2026-07-07 凛倾「chat左侧需要加和airp一样的(模型)参数,两个需要同步」：
  // 模型参数折叠组是同一个 DOM 节点跨栏搬家（smart↔airp 永不同屏，layout 本函数即互斥点）。
  // 禁克隆：preset.mjs/featureControls.mjs 模块加载期按 id 持有这些控件引用，重复 id 会让
  // 克隆侧成僵尸（同 :159 拍板注释警告的全局 getElementById 依赖）。搬家保元素身份，监听器/
  // 折叠记忆(collapse.mjs 全文档扫描)/i18n 全部原样生效，同步由单一 DOM 天然保证。
  const mpGroup = document.getElementById("left-model-params-group");
  if (tabName === "smart") {
    if (leftContentChat) leftContentChat.classList.add("hidden");
    if (leftSmartEl) {
      leftSmartEl.style.display = "";
      const mpSlot = document.getElementById("smart-model-params-slot");
      if (mpGroup && mpSlot && mpGroup.parentElement !== mpSlot) mpSlot.appendChild(mpGroup);
      _populateSmartLeftPanel().catch(e => console.warn("[smart] leftPanel populate failed:", e));
    }
  } else {
    if (leftSmartEl) leftSmartEl.style.display = "none";
    // 模型参数组归位 airp 左栏原位（世界书绑定组之前，锚既有 data-collapse-id 不锚行号）
    if (mpGroup && leftContentChat && mpGroup.parentElement !== leftContentChat) {
      const wbGroup = leftContentChat.querySelector('input[data-collapse-id="left-world-binding"]')?.closest(".collapse");
      if (wbGroup) leftContentChat.insertBefore(mpGroup, wbGroup);
      else leftContentChat.appendChild(mpGroup);
    }
    if (leftContentChat) {
      // 界面5 拆4（拍板#5）：AIRP 左栏只属 airp(chat)；bot/helper 各有独立主区不借此栏。
      // DOM 不删（regexEditor 等仍 getElementById 读全局状态控件），仅归属解耦。
      const showChat = tabName === "chat";
      leftContentChat.classList.toggle("hidden", !showChat);
    }
  }
  // 右栏切换:独立DOM, 控件镜像到 .right-panel-content 原控件 (设计8.2)
  const rightDefault = document.querySelector(".right-panel-content");
  const rightSmart = document.getElementById("right-content-smart");
  if (tabName === "smart") {
    if (rightDefault) rightDefault.style.display = "none";
    if (rightSmart) {
      rightSmart.style.display = "";
      _setupSmartRightPanel();
      _refreshSmartTaskCounters();
    }
    // P0-1 最小可用 + 点3优化: 进入 smart 立即拉一次; 之后 5s tick, 但 tick 内部 WS 在线则跳过 HTTP(靠推送)
    _setupSmartPolling(true);
  } else {
    _setupSmartPolling(false);
    if (rightDefault) rightDefault.style.display = "";
    if (rightSmart) rightSmart.style.display = "none";
  }
}

// 监听任务/审批更新, 自动刷新 smart 右栏 + 工作模式活动栏角标
// N47(设计 全智能8.5): 有任务进行中时自动展开右栏——只在 0→有 的上升沿展开一次，
// 任务清零不自动收起（设计：「任务全部完成后右栏可以保持，用户选择」），用户手动折叠后不反复打扰。

// ============================================================
// Smart 折叠区状态 localStorage (设计13.2)
// ============================================================

// [MO-T2] 多模式同 chatId 检测提示（per-character key 版）
// 凛倾0706：smart 升独立模式值（原 smart→chat 坍缩=实现残留），与 :418 targetMode/featureControls MODE_CHATID_KEYS 同步
// [D3 收口 0713] 原字面量副本与 modeTabMap.TAB_TO_MODE 三表并存（同键值曾分叉,C2 审计实证 files
//   一度 "file"/"code" 不一致）。改从权威表派生——键集刻意只留 4 个「参与 MO-ISO 恢复/横幅检测」
//   的模式 tab（bot/helper/memory 等辅助视图不参与恢复,不能直接用全表）,值随权威单源变。
const _MODE_TAB_TO_MODE = { "chat": TAB_TO_MODE.chat, "smart": TAB_TO_MODE.smart, "files": TAB_TO_MODE.files, "work": TAB_TO_MODE.work };
// [D2 收口 0713] tab 文案从 TAB_LABEL 权威派生（原第二份手抄副本）
const MODE_TAB_LABEL = {
  "chat": TAB_LABEL.chat, "smart": TAB_LABEL.smart, "files": TAB_LABEL.files, "work": TAB_LABEL.work,
};
function _checkMultiModeChatLock(tabName) {
  _lastLockCheckTab = tabName;
  const bar = document.getElementById("multi-mode-lock-bar");
  const charName = storage.get(KEYS.BEILU_LAST_CHAR) || "";
  const targetMode = _MODE_TAB_TO_MODE[tabName];
  const targetKey = getModeChatIdKey(targetMode, charName);
  const targetId = targetKey ? storage.get(targetKey) : null;
  if (!targetId) { bar?.classList.add("hidden"); return; }
  const conflicts = [];
  for (const [otherTab, otherMode] of Object.entries(_MODE_TAB_TO_MODE)) {
    if (otherTab === tabName) continue;
    if (otherMode === targetMode) continue;
    const otherKey = getModeChatIdKey(otherMode, charName);
    if (!otherKey) continue;
    const otherId = storage.get(otherKey);
    if (otherId === targetId) conflicts.push(MODE_TAB_LABEL[otherTab]);
  }
  if (conflicts.length === 0) {
    if (bar) bar.classList.add("hidden");
    return;
  }
  diag.debug("多模式同 chatId 冲突:", tabName, "vs", conflicts.join("/"), "chatId:", targetId?.substring(0, 8));
  let el = bar;
  if (!el) {
    el = document.createElement("div");
    el.id = "multi-mode-lock-bar";
    el.className = "multi-mode-lock-bar";
    document.body.appendChild(el);
  }
  el.classList.remove("hidden");
  el.innerHTML = `<i data-ic="lock"></i> 此对话在 <b>${conflicts.join("/")}</b> 模式中也打开了。多模式同时发送可能冲突,建议只在一个模式操作 <button class="btn btn-ghost btn-xs" id="multi-mode-lock-dismiss">✕</button>`;
  el.querySelector("#multi-mode-lock-dismiss")?.addEventListener("click", () => el.classList.add("hidden"));
}
// 自动刷新闭环（凛倾 0713「没有做自动刷新,导致时序问题」）：横幅数据源=本地模式键，
// 键会在切 tab 之后才被改动（MO-ISO 收口写、fetchChatList 读时校准、跨端 chat-list-changed
// 驱动的重拉）——只在切 tab 一瞬查一次=显示停在改动前快照。接事件总线：指针/列表变化即
// 防抖重查当前 tab，横幅跟随事实自愈，无轮询。
let _lastLockCheckTab = null;
let _lockRecheckTimer = null;
function _scheduleLockRecheck() {
  if (!_lastLockCheckTab) return;
  clearTimeout(_lockRecheckTimer);
  _lockRecheckTimer = setTimeout(() => { _checkMultiModeChatLock(_lastLockCheckTab); }, 300);
}
window.addEventListener("beilu:mode-pointer-changed", _scheduleLockRecheck);
window.addEventListener("beilu:chat-list-changed", _scheduleLockRecheck);

/**
 * [MO-ISO] 模式隔离：切 Tab 后恢复目标模式记忆的 chatId。
 * 从 per-character key 读 localStorage，若与当前 hash 不同则 switchCharacterScope。
 * 若该模式从未选过对话（localStorage 无值），不切换——保持当前对话。
 */
async function _restoreModeChatId(tabName, announceActive = true) {
  const charName = storage.get(KEYS.BEILU_LAST_CHAR) || "";
  const targetMode = _MODE_TAB_TO_MODE[tabName];
  const targetKey = getModeChatIdKey(targetMode, charName);
  if (!targetKey) return;
  let savedChatId = storage.get(targetKey);
  // [hash恢复真源上移·多窗口] localStorage(getModeChatIdKey)是 per-浏览器缓存,新窗口/清缓存/init
  //   竞态下为空 → 原直接 return 不恢复 hash,而生成/面板读 active_modes_map[hash]=别模式对话的模式,
  //   顶部意图(code)与生效(work)脱钩。真源=服务端 mode_active_chats(getChatList 注入 usedByModes,
  //   conversationManager:239「本地键=纯缓存,服务端=唯一真源」)。缺失时拉一次列表,
  //   _syncModePointerCache 反填本地键后重读,把 hash 落到该模式窗口的权威在用对话。
  if (!savedChatId) {
    try { await fetchChatList(); savedChatId = storage.get(targetKey); } catch { /* 拉取失败=保持原「无值不恢复」行为,不阻断切 tab */ }
  }
  if (!savedChatId) return;
  if (!isValidChatId(savedChatId)) {
    console.warn(`[layout][MO-ISO] 清除无效 chatId: ${savedChatId.substring(0, 20)}`);
    storage.remove(targetKey);
    return;
  }
  const currentHash = (window.location.hash || "").substring(1);
  if (savedChatId === currentHash) return;
  console.log(`[layout][MO-ISO] 恢复 ${tabName}/${charName} 的 chatId: ${savedChatId.substring(0, 8)}…`);
  // [多窗口审计 2026-07-11 A1] 显式传 targetMode：恢复链明确知道目标模式，switchCharacterScope 内
  //   [MO-ISO] 写点不再猜前端内存 getCurrentMode（tab 联动飞行期 stale 会把目标模式的 cid 写进旧模式键）
  switchCharacterScope(savedChatId, charName, { mode: targetMode, announceActive });
}


// ============================================================
// 聊天容器移动
// ============================================================

function moveChatContainer(tabName) {
  if (!chatContainer) return;
  const _prevParent = chatContainer.parentElement?.id || "(none)";

  const isIdeMode = tabName === "files" || tabName === "memory";

  if (isIdeMode) {
    if (tabName === "files") {
      const aiPanel = document.getElementById("ide-panel-ai-chat");
      if (aiPanel && chatContainer.parentElement !== aiPanel) {
        aiPanel.appendChild(chatContainer);
      }
      // 界面4: 任务条目组件若被 work 任务台重指过，切回 ide 时归位
      mountTaskItemPanel("ide-task-panel");
    }
    chatContainer.classList.add("compact-chat");
    chatContainer.classList.remove("chat-dock-collapsed");
  } else if (tabName === "smart") {
    // W28: Smart模式 — chat-container移入center-tab-smart
    const smartTab = document.getElementById("center-tab-smart");
    if (smartTab && chatContainer.parentElement !== smartTab) {
      smartTab.appendChild(chatContainer);
    }
    chatContainer.classList.remove("compact-chat", "chat-dock-collapsed");
    // W28: 有聊天消息时隐藏greeting面板 + 重新绑定Observer
    updateSmartGreeting();
    _bindSmartGreetingObserver();
  } else if (tabName === "work") {
    // W28: Work模式 — chat-container移入work-chat-area
    const workChat = document.getElementById("work-chat-area");
    if (workChat && chatContainer.parentElement !== workChat) {
      workChat.appendChild(chatContainer);
    }
    chatContainer.classList.remove("compact-chat", "chat-dock-collapsed");
  } else {
    if (centerTabChat && chatContainer.parentElement !== centerTabChat) {
      centerTabChat.appendChild(chatContainer);
    }
    chatContainer.classList.remove("compact-chat", "chat-dock-collapsed");
  }
  const _newParent = chatContainer.parentElement?.id || "(none)";
  if (_newParent !== _prevParent) diag.debug("moveChatContainer:", _prevParent, "→", _newParent, "(tab:", tabName + ")");
}

// ============================================================
// 顶部选项卡切换
// ============================================================

// TAB_TO_MODE 已抽到 ./modeTabMap.mjs（单一权威源，T-3），此处 import 引入，引用不变。

// [N8] 模式后端通道并轨：原 notifyActiveMode 直发 A 通道（beilu-files setMode）已删除。
//   A 通道现由 B 通道单入口（featureControls.switchModeTo → setDataActions switchMode）服务端内部扇出，
//   前端不再并发发两请求（消灭"双发无序/任一失败不回滚"竞态，凛倾「后端是一条线路, 注意异步」）。
//   退文件/记忆模式的对话清理（confirm/隐藏消息）仍是前端职责：beilu-files setMode 返回的 _cleanup
//   随 B 响应回传（setDataActions 写入 result._filesCleanup），featureControls 经下方 window 桥调用本处理器。
//   保留为独立函数 + window 桥，避免 featureControls ↔ layout 循环 import（同 _beiluGetChatId 等既有桥范式）。
async function _handleFilesModeCleanup(cleanup) {
  if (!cleanup) return;
  const cleanupMode = storage.get(KEYS.BEILU_CLEANUP_MODE) || DEFAULTS.cleanup.mode; // T6：前端运行参数单源，删字面量 "auto" 副本
  const { chatid: cleanupChatid, startIndex } = cleanup;
  if (!(cleanupChatid && startIndex >= 0)) return;

  let shouldClean = false;
  if (cleanupMode === "auto") {
    shouldClean = true;
  } else if (cleanupMode === "ask") {
    try {
      // 原 raw GET log/length + lenRes.ok 手检 → 门面 getLogLength（scope.chatId=cleanupChatid）；!ok 由门面抛错走 catch（原 catch 降级 confirm 等价）
      const total = await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: cleanupChatid } }) || 0;
      const count = total - startIndex;
      if (count > 0) {
        shouldClean = await beiluConfirm(
          `是否清理文件/记忆模式期间的 ${count} 条对话消息？`,
        );
      }
    } catch {
      shouldClean = await beiluConfirm("是否清理文件/记忆模式期间的对话消息？");
    }
  }

  if (shouldClean) {
    try {
      // 原 raw POST messages/hide + delRes.ok 手检 → 门面 hideMessages（scope.chatId=cleanupChatid，payload {startIndex}）；!ok 由门面抛错走 catch
      const delResult = await sendAction({ verb: "hideMessages", target: "shells:chat", source: "web", scope: { chatId: cleanupChatid }, payload: { startIndex } });
      console.log(
        `[layout] 文件模式清理: 隐藏(不发送)了 ${delResult?.hidden} 条消息`,
      );
    } catch (err) {
      console.warn("[layout] 文件模式清理失败:", err.message);
    }
  } else if (cleanupMode !== "auto") {
    console.log(
      `[layout] 文件模式清理: 用户选择保留消息 (模式: ${cleanupMode})`,
    );
  }
}
// window 桥：featureControls 收到 B 响应里的 _filesCleanup 后调用本处理器（无循环 import）
window._beiluHandleFilesModeCleanup = _handleFilesModeCleanup;

// ★ W33 BUG-3: INJ-2 状态更新提取为函数，确保在模式切换后调用
// 单调写令牌：tab 快速切换会并发多次 setdata，仅最后一次回写 UI，消乱序
let _inj2WriteToken = 0;
// ★ T04：INJ-2 状态值相同时跳过 POST（幂等优化）。
// why: 每次 switchTab 都无条件发 POST updateInjectionPrompt，实际只在 files tab 为 true 其他为 false，
//   同模式组内切 tab（如 code→files→memory）会重复发相同 enabled=true。
// 关联: index.mjs handleToggleInj2 手动开关会更新 _lastInj2Enabled（通过 _beiluSyncInj2State 桥）。
let _lastInj2Enabled = undefined;
// 桥：手动开关（injprompt.mjs handleToggleInj2）改了 INJ-2 后同步此缓存，
// 否则下次 switchTab 的 dirty check 会跳过实际已变的状态。
window._beiluSyncInj2LastEnabled = (v) => { _lastInj2Enabled = v; };
function _updateInj2State(enabled) {
  if (_lastInj2Enabled === enabled) return;
  _lastInj2Enabled = enabled;
  const myToken = ++_inj2WriteToken;
  // charName 必须与手动切换(index.mjs handleToggleInj2)同口径：否则后端按 char_id||_global
  // 落到不同作用域，状态分裂（dataset.charId 由 index.mjs 在切角色时写入）
  const charId = getCharId();
  // 原 raw POST setdata {_action:updateInjectionPrompt,...} → memory 通配路由 verb=真动作组装 _action。
  // 行为等价：原 !ok 只 console.warn 不 return，仍乐观更新 UI；门面 !ok 抛错走 catch——把 UI 回写抽成 _applyInj2Ui 在成功/失败两路都调用，保持乐观更新语义。
  const _applyInj2Ui = () => {
    if (myToken !== _inj2WriteToken) return; // 已有更新的写覆盖，丢弃过期回写
    const statusEl = document.getElementById("inj2-status");
    if (statusEl) statusEl.textContent = enabled ? "ON" : "OFF";
    // 同步 index.mjs 的 _inj2Enabled 缓存，避免手动开关从陈旧值翻转
    window._beiluSyncInj2State?.(enabled);
  };
  sendAction({ verb: "updateInjectionPrompt", target: "plugins:beilu-memory", source: "web", payload: { injectionId: "INJ-2", enabled, charName: charId || "_global" } })
    .then(() => _applyInj2Ui())
    .catch((err) => { console.warn("[layout] updateInj2State:", err?.message); window._reportError?.(`[layout] INJ-2 注入状态同步失败: ${err?.message}`, err?.stack); _applyInj2Ui(); }); // T021 留痕：补 errors 上报
}


// ============================================================

// ★ T04 滚动位置保存/恢复
// why: 切 tab 后 chat-messages 的 scrollTop 丢失，回来后对话滚到顶部。
// 关联: chat-messages DOM 通过 moveChatContainer(:254) appendChild 移动不重建（内容保持），
//   但滚动位置不随 DOM 移动保留。per-tab 存 scrollTop，返回时 rAF 恢复。
// 影响范围: 仅前端 DOM 操作，不触发后端请求。
const _tabScrollPositions = {};
// [系统病型审计 0713·A-NEW-1] tab 切换并发代号（_switchGen 同款范式）：switchTab 同步返回但
// 拖着 switchModeTo(...).then(_restoreModeChatId) 异步尾巴——连点 tab 时旧链慢返回会用旧
// tabName 恢复错误模式线的对话、或失败回滚把新 tab 拽回。代号闸：旧链的延续一律放弃。
let _tabSwitchGen = 0;
function switchTab(tabName, { isInit = false } = {}) {
  if (!(tabName in TAB_TO_MODE)) {
    const mapped = MODE_TO_TAB[tabName];
    if (mapped) { tabName = mapped; } else { console.warn("[layout] switchTab: 非法 tabName:", tabName); tabName = "chat"; }
  }
  const prevTab = layoutState.activeTab;
  diag.debug("switchTab:", prevTab, "→", tabName, isInit ? "(init)" : "");
  // 离开前保存滚动位置
  const _chatMsgs = document.getElementById("chat-messages");
  if (_chatMsgs && prevTab) {
    _tabScrollPositions[prevTab] = _chatMsgs.scrollTop;
  }
  // 离开前快照当前 tab 的左右栏开合（activeTab 此刻仍=prevTab；非 panel tab 内部自跳过）
  _snapshotPanelMemory();
  layoutState.activeTab = tabName;
  // W28: 设置body级属性，供CSS模式显隐控制
  document.body.dataset.activeTab = tabName;
  // [0808 windowRuntime 机制·单点 producer] 窗口展示变化事件：后台前端降频/前台正常的唯一
  //   切窗信号源（windowRuntime.createVisibilityPoller 消费；整页前后台由 visibilitychange 补维度）。
  window.dispatchEvent(new CustomEvent("beilu:window-shown", { detail: { tab: tabName, prevTab } }));
  const isIdeMode = tabName === "files" || tabName === "memory";
  // [MO-T2] 检测多模式同 chatId 互斥锁 (切到新模式时,如果该模式与其他模式共用 chatId,提示用户)
  if (!isInit) _checkMultiModeChatLock(tabName);

  // ★ E1: 先保存 layoutState。[多窗口审计 2026-07-11 C6 注释校准] 原注释称"switchModeTo 可能触发
  //   reload"——已证伪（_doSwitchMode 全链零 reload 调用，E1 历史残留）；保存仍有意义（防中途异常丢状态）。
  // reload 后 initLayout → switchTab(layoutState.activeTab) 会恢复到正确的 tab
  saveState();

  // Tab 联动模式切换：files/memory tab → code 模式，其他 tab → chat 模式
  // ★ H1 修复: 初始化恢复时不触发 switchModeTo，避免 reload 循环
  // 初始化时模式状态已从 localStorage 同步读取（featureControls.mjs），
  // 后端状态由 syncModeFromBackend() 异步同步，不需要再发 switchMode 请求
  // W41: memory/settings/editor不切后端模式
  // [N8] 后端单入口：原此处并发发 B(switchModeTo) + A(notifyActiveMode) 两请求已并轨为一。
  //   只发一次 switchModeTo(B 通道)，携带原始 tab；后端 switchMode 持久化后服务端内部扇出至
  //   beilu-files(A 通道)。tab 透传让后端区分 files→file / memory→memory（B 通道两者都坍缩成 code）。
  //   原 `getCurrentMode()!==targetMode` 守卫已去：files↔memory 切换时 B 模式同为 code 不变，
  //   但 A 通道需 file↔memory 切换，故必须无条件发（switchModeTo 走 skipConfirm，B 端幂等强制同步）。
  if (!isInit && TAB_TO_MODE[tabName] !== null && tabName !== "settings" && tabName !== "editor") {
    // N15: companion 分支已死（TAB_TO_MODE.companion=null 在守卫处即跳过），随值域洞一并清除
    // 凛倾0706「4个模式就是现在前端的4个模式」：smart 不再坍缩成 chat——smart 升独立后端模式值
    //   （合法集/modes/smart.json/绑定键/chatid 键全链同步，见 storage.mjs _validModeIds 注释）。
    const targetMode = tabName === "work" ? "work" : isIdeMode ? "code" : tabName === "smart" ? "smart" : "chat";
    const _myTabGen = ++_tabSwitchGen; // [A-NEW-1] 本次切换领号，异步尾巴每步核号
    switchModeTo(targetMode, { tab: tabName })
      .then((res) => {
        // [A-NEW-1] 已有更新的 tab 切换 → 本链全部放弃（恢复/回滚/INJ2 都不做，新链接管）
        if (_myTabGen !== _tabSwitchGen) return;
        // [多窗口审计 2026-07-11 A3] 原 .catch 回滚是死路径：_doSwitchModeInner 吞异常恒 resolve、
        //   后端 success:false 也不抛 → 真实失败从不走 .catch，前端 tab 已切后端没切=三态不一致。
        //   现按三态返回判别：false=确定失败→回滚；undefined=无操作→不动；true=成功。
        //   [0716 模式轴时序修] 并发不再丢弃（featureControls _doSwitchMode 串行队列，意图必达后端），
        //   undefined 仅剩「同模式无需切/用户取消」两类真无操作——原「下次切换自愈」（实为要用户再点一次）已根治。
        if (res === false) {
          diag.warn("Tab 联动模式切换失败，回退:", tabName, "→", prevTab);
          console.warn("[layout] Tab 联动模式切换失败，回退到", prevTab);
          switchTab(prevTab, { isInit: true });
          window._beiluToast?.("模式切换失败，已回退", "warning");
          return;
        }
        // ★ W33 BUG-3: INJ-2 enable 在模式切换完成后再执行，避免竞态
        _updateInj2State(tabName === "files");
        // [MO-ISO] 模式隔离恢复：切到目标模式后，从 localStorage 恢复该模式上次的 chatId。
        //   如果目标模式有记忆的 chatId 且与当前 hash 不同，切到该对话。
        _restoreModeChatId(tabName);
      })
      .catch((err) => {
        if (_myTabGen !== _tabSwitchGen) return; // [A-NEW-1] 同上
        // [A3] 兜底保留（_doSwitchModeInner 已全捕获，理论不可达；防新代码抛错仍有回滚）
        console.warn("[layout] Tab 联动模式切换失败，回退到", prevTab, ":", err?.message);
        switchTab(prevTab, { isInit: true });
        window._beiluToast?.("模式切换失败，已回退", "warning");
      });
    // N49 MODE_CHANGED producer：模式切换收口广播给 iframe 美化脚本（mode_changed）。
    window.emitBeiluEvent?.("mode_changed", { mode: targetMode });
    // [2026-07-11 C6 注释校准] 原"switchModeTo 触发 reload"说法已证伪（全链零 reload，E1 残留）
    // 但 layoutState.activeTab 已经在上面保存了
  } else {
    _updateInj2State(tabName === "files");
    if (isInit && TAB_TO_MODE[tabName] !== null && tabName !== "settings" && tabName !== "editor") {
      _restoreModeChatId(tabName, false);
    }
  }

  // 更新顶部选项卡按钮
  topTabs?.querySelectorAll("[data-top-tab]").forEach((btn) => {
    btn.classList.toggle("top-tab-active", btn.dataset.topTab === tabName);
  });

  // 显示/隐藏选项卡内容
  document.querySelectorAll(".center-tab-content").forEach((panel) => {
    const isTarget = panel.id === `center-tab-${tabName}`;
    if (isTarget) {
      panel.classList.remove("hidden");
      panel.style.display = "";
    } else {
      panel.classList.add("hidden");
    }
  });

  switchLeftContent(tabName);
  moveChatContainer(tabName);

  // ★ T04 恢复滚动位置（moveChatContainer 之后，DOM 已移入目标容器）
  if (_chatMsgs && _tabScrollPositions[tabName] !== undefined) {
    requestAnimationFrame(() => { _chatMsgs.scrollTop = _tabScrollPositions[tabName]; });
  }

  // P2续 懒加载: 广播 tab 激活，供 index.mjs 按 tab 首次激活 dynamic import 面板专属模块（含 reload 恢复路径）
  if (tabName === "extensions") {
    import("../../panels/extensions/extensionsPanel.mjs")
      .then((m) => m.initExtensionsPanel())
      .catch((e) => console.warn("[layout] extensions:", e.message));
  }
  window.dispatchEvent(new CustomEvent("beilu:tab-activated", { detail: tabName }));

  // B39: settings/editor不再是Tab，不需要在这里处理
  // 界面5 拆4：helper 主区=#center-tab-helper 全宽工具面板，左右栏对其无意义，与 bot 同列
  const hideSidebars = isIdeMode || tabName === "work" || tabName === "bot" || tabName === "helper" || tabName === "companion" || tabName === "extensions";
  if (hideSidebars) {
    if (leftPanel) {
      leftPanel.classList.add("collapsed");
      leftPanel.style.display = "none";
    }
    if (rightPanel) {
      rightPanel.classList.add("collapsed");
      rightPanel.style.display = "none";
    }
  } else {
    // 开合按 tab 记忆恢复（panelMemory）——原 smart 每次强制折叠(W59)与 chat 右栏 rightCollapsedByUser
    // 专例已并入统一记忆表：smart 折叠只作首次默认（PANEL_MEMORY_DEFAULTS），之后记用户上次操作。
    // 移动端跳过 apply 与原行为一致（beilu-mobile 下开合由 mobileAdaptation overlay 模式管理）。
    const mem = layoutState.panelMemory[tabName] || PANEL_MEMORY_DEFAULTS[tabName];
    if (mem) {
      layoutState.leftCollapsed = !!mem.left;
      layoutState.rightCollapsed = !!mem.right;
    }
    const isMobile = document.body.classList.contains("beilu-mobile");
    if (leftPanel) {
      leftPanel.style.display = "";
      if (!isMobile) applyLeftPanel();
    }
    if (rightPanel) {
      rightPanel.style.display = "";
      if (!isMobile) applyRightPanel();
    }
  }

  // 工作面板初始化
  if (tabName === "work") {
    initWorkPanel();
  }

  _updateModeBtn(tabName);
  saveState();
}

// ============================================================
// Phase 4A: 模式选择器 + 辅助菜单
// ============================================================

// [D2 收口 0713·凛倾「哪里来的设计?」] 原 07-09 注释"场景化文案不收口"查证=当时审计 AI 自我判定,
//   无拍板依据,按病型收口:label 从 TAB_LABEL 权威派生(与 index.html 顶部 tab 逐字一致;原 companion
//   "陪伴/游戏"与 html"陪伴"微分叉随之消),icon 是本选择器场景特有留本地。
//   集合边界=凛倾0706「4个模式」拍板;自定义模式兜底=:560 `|| tabName` 显示裸 id。
const _MODE_ICONS = {
  smart: '<i data-ic="star"></i>', chat: '<i data-ic="drama"></i>', files: '<i data-ic="code"></i>', work: '<i data-ic="clipboard"></i>',
  memory: '<i data-ic="brain"></i>', bot: '<i data-ic="bot"></i>', companion: '<i data-ic="gamepad"></i>', helper: '<i data-ic="wrench"></i>',
  extensions: '<i data-ic="plug"></i>',
};
const MODE_LABELS = Object.fromEntries(
  Object.entries(_MODE_ICONS).map(([t, icon]) => [t, `${icon} ${TAB_LABEL[t] || t}`]),
);
const MODE_DESCS = {
  smart: "AI自动选择最佳模式",
  chat: "角色扮演 · 创意写作 · 日常聊天",
  files: "编程 · IDE联动 · 代码审查",
  work: "自动化任务 · 委派 · 定时执行",
  memory: "记忆管理 · 热温冷三层 · 表格编辑",
  bot: "Discord/Telegram Bot · 多平台管理",
  companion: "截图陪伴 · 游戏检测 · 桌宠交互",
  helper: "ST适配 · 变量管理 · 脚本工具",
  extensions: "额外插件 · 语音转录 · 外部工具",
};

function _updateModeBtn(tabName) {
  const el = document.getElementById("mode-selector-text");
  if (el) {
    el.innerHTML = MODE_LABELS[tabName] || tabName;
    el.closest("button")?.setAttribute("data-active-mode", tabName);
  }
}

// ============================================================
// [顶部状态订阅站 20260706] 断链根修（凛倾「每个入口改了,顶部的不会变」）：
//   顶部显示位从「各发起口负责直改 DOM」反转为「顶部自己订阅事件」——发起口只管广播，
//   口再多也不会漏顶部（原模式下 subModePanel 直发口/后端驱动 preset_changed/mode-switched 整类漏更新）。
// 事件源：beilu:presetSwitched（前端收口 sharedState.switchPreset 广播，detail={name}）/
//         beilu:preset-changed（后端驱动：AI presetSwitch 标签/自动切换/跨窗口，websocket case 派发，detail={preset}）/
//         beilu:mode-switched（本地 _doSwitchMode 与 WS _beiluApplyModeFromWs 派发，detail={newMode,source}）。
// 通知纪律：仅外部驱动弹 toast（preset-changed 用「显示已同值→回显」幂等守卫；mode 用 detail.source==="ws"）——
//   本地操作口自有反馈（D2 toast），避免双弹。
// ============================================================
const _MODE_TO_TAB = { code: "files" }; // 后端 mode→前端 tab 名（其余同名：chat/work/companion/memory…）
function _updateHeaderPreset(name) {
  const el = document.getElementById("header-current-preset");
  if (!el) return;
  el.textContent = name;
  el.title = `当前预设: ${name}\n点击打开预设管理`;
}
window.addEventListener("beilu:presetSwitched", (e) => {
  const name = e?.detail?.name;
  if (name) _updateHeaderPreset(name);
});
// 凛倾0706「切换子模式=改头部那个,那个是显示当前绑定和当前状态的」：子模式切换后头部显示将生效绑定。
//   专用事件（产生点=subModePanel 手动口 + subModeSwitched 善后监听器，各一处）——不复用 presetSwitched，
//   因它另有 loadPresetData/左栏/smart selector 同步订阅者，预设此刻未真切，复用会整片误触发。
//   无绑定（继承大模式）的子模式不发此事件=头部保持大模式生效值，语义正确。
window.addEventListener("beilu:subModeBindingChanged", (e) => {
  const name = e?.detail?.name;
  if (name) _updateHeaderPreset(name);
});
window.addEventListener("beilu:preset-changed", async (e) => {
  // [0715 串扰点2] 事件=「权威预设已变」的通知，e.detail.preset 是【触发方】的值（global 切换=全局名）——
  //   本窗有 per-chat 覆盖时拿它直刷顶栏 = 显示与生成分叉。改为重解析本窗生效值
  //   （resolveCurrentPresetName 单源：桥注入 cid → 后端 active_preset_resolved 与生成链同源）。
  if (!e?.detail?.preset) return; // 无名通知（形状异常）不动顶栏
  const name = await window._beiluResolveCurrentPreset?.();
  if (!name) return; // 后端不可达：保留现值，不拿事件值凑
  const el = document.getElementById("header-current-preset");
  if (el && el.textContent === name) return; // 本窗生效值未变（如别窗 global 切换但本窗有覆盖）=静默
  _updateHeaderPreset(name);
  window._beiluToast?.(`预设已切换：${name}`, "info");
});
window.addEventListener("beilu:mode-switched", (e) => {
  const m = e?.detail?.newMode;
  if (!m) return;
  const tab = _MODE_TO_TAB[m] || m;
  _updateModeBtn(tab); // 只更新顶部显示与 data-active-mode，不强拉视图（T040b：切模式≠切视图）
  if (e?.detail?.source === "ws") {
    const label = (MODE_LABELS[tab] || m).replace(/<[^>]+>/g, "").trim();
    window._beiluToast?.(`模式已切换：${label}`, "info");
  }
});

function _updateModePanel() {
  const panel = document.getElementById("mode-selector-panel");
  if (!panel) return;
  // 0713 框架修（视图单源）：高亮/描述原读 layoutState.activeTab（tab轴——可为 settings/memory
  //   等非模式值，且 WS/后端切模式不写它）→ 与顶部徽标（mode-switched 订阅）各读各的副本，
  //   「顶部显示全智能、弹窗高亮工作」即此。改读模式单源 getCurrentMode()，经 _MODE_TO_TAB
  //   映射到选项值域（code→files），所有「当前模式」视图同源。
  const _m = getCurrentMode();
  const _modeTab = _MODE_TO_TAB[_m] || _m;
  panel.querySelectorAll(".mode-option").forEach(opt => {
    opt.classList.toggle("mode-option-active", opt.dataset.mode === _modeTab);
  });
  const desc = document.getElementById("mode-selector-desc");
  if (desc) desc.textContent = MODE_DESCS[_modeTab] || "";
}

function _closeAllPopups() {
  document.getElementById("mode-selector-panel")?.classList.add("hidden");
  // Phase4A 复原: ··· 辅助菜单
  document.getElementById("aux-menu-popup")?.classList.add("hidden");
  // 界面1挑刺修复: ESC/点外也关 ≡ 菜单弹层（extendMenuW28 管理的 popup）
  document.getElementById("extend-menu-popup")?.classList.add("hidden");
}

// ============================================================
// N44 全局快捷键（前端改版v2 Q5，凛倾 2026-04-20 确认）
// Ctrl+1~4 切模式 / Ctrl+. 辅助菜单 / Ctrl+, 设置 / Ctrl+E 编辑 / Ctrl+T Token
// 浏览器保留键说明：Chrome 等会吞掉 Ctrl+1~8（切浏览器标签）与 Ctrl+T（新标签），
// 页面 JS 无法拦截——故同键位同时接受 Alt+（Alt+1~4 / Alt+E / Alt+T）作为
// 浏览器内等效键；Electron/桌面端 Ctrl 原样可用。
// 输入框/textarea/contenteditable 聚焦时全部跳过，防打断输入。
// ============================================================
function initGlobalShortcuts() {
  const SHORTCUT_TABS = { "1": "smart", "2": "chat", "3": "files", "4": "work" };
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey) return; // AltGr / 既有 Ctrl+Alt+R 组合不抢
    const mod = (e.ctrlKey || e.altKey) && !e.shiftKey && !e.metaKey;
    if (!mod) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    const key = e.key;
    if (SHORTCUT_TABS[key]) {
      e.preventDefault();
      switchTab(SHORTCUT_TABS[key]);
      return;
    }
    if (key === ".") {
      e.preventDefault();
      document.getElementById("aux-menu-btn")?.click();
      return;
    }
    if (e.ctrlKey && key === ",") {
      e.preventDefault();
      _toggleSettingsModal("settings");
      return;
    }
    if (key === "e" || key === "E") {
      e.preventDefault();
      _toggleSettingsModal("editor");
      return;
    }
    if (key === "t" || key === "T") {
      e.preventDefault();
      document.getElementById("token-indicator-dot")?.click();
      return;
    }
  });
}

function initModeSelector() {
  const btn = document.getElementById("mode-selector-btn");
  const panel = document.getElementById("mode-selector-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = panel.classList.contains("hidden");
    _closeAllPopups();
    if (wasHidden) {
      _updateModePanel();
      panel.classList.remove("hidden");
      // 按钮正下方定位 (修复 left:50% 在宽屏下严重偏移的问题)
      const btnRect = btn.getBoundingClientRect();
      const topBar = document.getElementById("top-bar");
      const topRect = topBar?.getBoundingClientRect() || { left: 0, top: 0 };
      panel.style.left = (btnRect.left - topRect.left) + "px";
      panel.style.transform = "none";
      panel.style.top = (btnRect.bottom - topRect.top + 4) + "px";
    }
  });

  document.getElementById("mode-selector-close")?.addEventListener("click", () => _closeAllPopups());

  panel.querySelectorAll(".mode-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const mode = opt.dataset.mode;
      if (mode) {
        switchTab(mode);
        _closeAllPopups();
      }
    });
  });
}

// Phase4A 复原(2026-06-12 凛倾令): ··· 辅助菜单回归——模式下拉只留 4 主模式,扩展模式(bot/companion/memory/helper)
// 与记忆表格快捷从 ··· 进入(Phase4A_顶栏精简_设计.md §2.2b,R2=tables 暂跳 memory 模式)。
function initAuxMenu() {
  const btn = document.getElementById("aux-menu-btn");
  const popup = document.getElementById("aux-menu-popup");
  if (!btn || !popup) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = popup.classList.contains("hidden");
    _closeAllPopups();
    if (wasHidden) {
      popup.classList.remove("hidden");
      // 按钮正下方定位(同 initModeSelector 防宽屏偏移)
      const btnRect = btn.getBoundingClientRect();
      const topBar = document.getElementById("top-bar");
      const topRect = topBar?.getBoundingClientRect() || { left: 0, top: 0 };
      popup.style.left = (btnRect.left - topRect.left) + "px";
      popup.style.top = (btnRect.bottom - topRect.top + 4) + "px";
    }
  });

  popup.querySelectorAll(".aux-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      const aux = item.dataset.aux;
      _closeAllPopups();
      if (aux === "tables") {
        switchTab("memory");
        return;
      }
      // (教程开发入口已挪设置弹窗侧栏 settings.mjs data-settings-section="tutorial-dev")
      if (aux === "tutorial-play") {
        _playTutorialHelpMode().catch(e => console.warn("[layout] 帮助模式:", e.message));
        return;
      }
      if (aux) switchTab(aux);
    });
  });

  // 实验性教程不再随页面自动启动。教程开发与「帮助教程」手动入口仍保留，
  // 但 auto_trigger / desk_button 不得在用户打开聊天时遮挡真实界面。
}

/**
 * 帮助模式入口(凛倾0715MSG#9/12: 不是列表盲选，是模式开关)。
 * 点帮助图标 → 进帮助模式(板块出?) / 再点退出。每种结果都有可见反馈, 不静默。
 * 自动播放已停用；这里只保留用户主动点击的帮助模式。
 */
async function _playTutorialHelpMode() {
  const eng = await import("../tutorial/tutorialEngine.mjs");
  const state = await eng.toggleHelpMode();
  document.querySelector('[data-aux="tutorial-play"]')?.classList.toggle("active", state === "on");
  if (state === "on") window._beiluToast?.("帮助模式已开启: 点界面上的 ? 查看该处教程, 再点「帮助教程」退出", "info");
  else if (state === "off") window._beiluToast?.("已退出帮助模式", "info");
  else window._beiluToast?.("还没有教程配置帮助点 — 在 设置→教程开发 的「帮助点」里添加", "warning");
}

document.addEventListener("click", (e) => {
  const panel = document.getElementById("mode-selector-panel");
  if (panel && !panel.contains(e.target) && !document.getElementById("mode-selector-btn")?.contains(e.target)) {
    panel.classList.add("hidden");
  }
  const aux = document.getElementById("aux-menu-popup");
  if (aux && !aux.contains(e.target) && !document.getElementById("aux-menu-btn")?.contains(e.target)) {
    aux.classList.add("hidden");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") _closeAllPopups();
  // R-HR: Ctrl+Alt+R 美化热重载(刷新规则缓存+重渲染最近 N 条消息)
  //   开发美化代码时保存后立刻看到效果,免整页 Ctrl+F5
  //   用 Ctrl+Alt+R 而非 Ctrl+Shift+R,避免抢占浏览器硬刷新标准快捷键
  if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === "R" || e.key === "r")) {
    e.preventDefault();
    import("../render/virtualQueue.mjs")
      .then((m) => m.reloadBeautify?.(20))
      .catch((err) => console.warn("[reloadBeautify]", err));
  }
});


// ============================================================
// 三栏面板拖拽调宽
// ============================================================


// ============================================================
// 侧边栏拖拽调宽
// ============================================================


// 界面10: toggleChatDock 死码链已删（chat-dock DOM W59 已移除，chatDockToggle=null 绑定 no-op）







// ============================================================
// API 未配置 banner 检查
// ============================================================

let _chatApiSetupStatusRequestId = 0;

function _describeChatApiSetup(setup, bindingState = {}) {
  if (bindingState.hasExplicitBinding && !bindingState.explicitBindingUsable) {
    const role = bindingState.charName ? `当前角色「${bindingState.charName}」` : "当前角色";
    return `${role}绑定的 AI 源「${bindingState.sourceName}」不存在或配置不完整；请重新绑定或修复该源。`;
  }
  switch (setup?.status) {
    case "default_missing":
      return `已保存 ${setup?.usableSourceNames?.length || 0} 个可用 AI 源，但当前角色尚未绑定，且没有默认 API。`;
    case "invalid_default":
      return "默认 AI 服务源不完整或已失效；请到设置中修复或重新选择默认源。";
    case "source_incomplete":
      return "已检测到 AI 服务源，但渠道、地址或模型尚未完整保存。";
    case "missing":
      return "尚未配置 AI 服务源，发送消息将无法获得回复。";
    default:
      return "无法读取 AI 服务源状态；请打开设置检查配置。";
  }
}

async function checkChatApiBanner({ charName: requestedCharName } = {}) {
  const banner = document.getElementById("chat-api-warning-banner");
  if (!banner) return;
  const requestId = ++_chatApiSetupStatusRequestId;
  try {
    // 状态只读；唯一完整的历史源没有默认绑定时，显式请求无歧义修复。多源/脏源不猜测。
    let setup = await sendAction({ verb: "getAISetupStatus", target: "shells:serviceSourceManage", source: "web" });
    if (setup?.repairableDefaultSourceName) {
      setup = await sendAction({ verb: "repairAISetupDefault", target: "shells:serviceSourceManage", source: "web" });
    }
    if (requestId !== _chatApiSetupStatusRequestId) return;
    // banner 判断的是「当前聊天能否取得源」，不是「是否存在全局默认」：
    // 当前角色绑定的源可用时，即使多源用户没有全局默认，本轮生成链也已完整，不能假报警。
    let currentCharConfigured = false;
    let hasExplicitBinding = false;
    let boundSourceName = "";
    let bindingReadFailed = false;
    const charName = requestedCharName || getCharId();
    if (charName && Array.isArray(setup?.usableSourceNames)) {
      try {
        const binding = await sendAction({
          verb: "getCharAISource",
          target: "shells:chat",
          source: "web",
          payload: { charName },
        });
        boundSourceName = typeof binding?.AIsource === "string" ? binding.AIsource.trim() : "";
        hasExplicitBinding = !!boundSourceName;
        currentCharConfigured = hasExplicitBinding && setup.usableSourceNames.includes(boundSourceName);
      } catch (error) {
        // 角色绑定读取失败不覆盖 setup-status 的真实结果；保留提示并给设置入口。
        bindingReadFailed = true;
        console.warn("[layout] 无法读取当前角色 AI 源绑定:", error);
      }
    }
    if (requestId !== _chatApiSetupStatusRequestId) return;
    const text = document.getElementById("chat-api-warning-text");
    if (text) text.textContent = bindingReadFailed
      ? "无法读取当前角色的 AI 源绑定；请打开设置检查配置。"
      : _describeChatApiSetup(setup, {
          charName,
          sourceName: boundSourceName,
          hasExplicitBinding,
          explicitBindingUsable: currentCharConfigured,
        });
    // 运行链优先使用角色显式绑定，只有绑定为空时才回退全局默认；提示必须复刻同一优先级。
    const configuredForCurrentChat = bindingReadFailed
      ? false
      : hasExplicitBinding
        ? currentCharConfigured
        : setup?.configured === true;
    banner.style.display = configuredForCurrentChat ? "none" : "flex";
  } catch (error) {
    if (requestId !== _chatApiSetupStatusRequestId) return;
    // 读状态失败时仍保留显式配置入口，不能静默伪装为已配置。
    console.warn("[layout] 无法读取 AI 配置状态:", error);
    const text = document.getElementById("chat-api-warning-text");
    if (text) text.textContent = "无法读取 AI 服务源状态；请打开设置检查配置。";
    banner.style.display = "flex";
  }
}

// ============================================================
// 移动端关闭按钮事件委托
// ============================================================

document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="close-mobile-panel"]')) {
    closeMobilePanel();
  }
});

// ============================================================
// 初始化入口
// ============================================================

/**
 * initLayout 的子步骤隔离器（0727 ＋号死按钮根因修）。
 * 【why】initLayout 是**一长串顺序接线**：前面任一步同步抛错，后面全部接线不再执行，
 *   而外层只有 index.mjs 的一个 catch 把它记成「非致命」——于是症状是「按钮在、点了没反应」，
 *   控制台只有一行 warn，没人知道是整条初始化断了（0712 已因同一结构炸过一次，
 *   当时只给 initSettingsSlots/initFeatureControls 补了隔离，前半段和活动栏接线一直裸着）。
 * 【范式】与既有 try{...}catch{console.error + _reportError} 一致，只是收成一处，
 *   免得每加一个子系统就手抄一遍 try/catch（抄漏一个就是下一个死按钮）。
 */
function _step(name, fn) {
  try { fn(); }
  catch (e) {
    console.error(`[layout] ${name} 失败(已隔离，后续接线继续):`, e);
    window._reportError?.(`[layout] ${name}: ${e?.message || e}`, e?.stack);
  }
}

export function initLayout() {
  // 后台监控需尽早初始化以拦截 console
  // 逐步隔离（0727）：这一段原是裸调用，任一步抛错就把后面的活动栏接线（含 ＋号）全带走
  _step("initBackendMonitor", () => initBackendMonitor());

  _step("loadState", () => loadState());

  _step("applyLeftPanel", () => applyLeftPanel());
  _step("applyRightPanel", () => applyRightPanel());

  // 向 mobileAdaptation 注册面板恢复函数
  _step("registerApplyPanelFns", () => registerApplyPanelFns(applyLeftPanel, applyRightPanel));

  // 绑定三栏 toggle 按钮
  leftToggle?.addEventListener("click", toggleLeftPanel);
  rightToggle?.addEventListener("click", toggleRightPanel);

  // 绑定顶部选项卡
  topTabs?.querySelectorAll("[data-top-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.topTab;
      // B39修复: 设置和编辑改为弹窗，不切换Tab
      if (tab === "settings" || tab === "editor") {
        _toggleSettingsModal(tab);
        return;
      }
      switchTab(tab);
    });
  });

  // 初始化 IDE 活动栏（＋号开新对话线的行为绑定就挂在这条里：initIdeActivityBar → 动态 import
  //   lineManager → initLineManager 绑 click。这一步不跑到 = ＋号是个死按钮，故必须隔离，
  //   且两条活动栏各自隔离——记忆活动栏挂了不该连累 IDE 活动栏的接线。）
  _step("initIdeActivityBar(ide)", () => initIdeActivityBar(ideActivityBar, ideSidebar, "ideActivePanel", "ide-panel"));
  _step("initIdeActivityBar(mem)", () => initIdeActivityBar(memActivityBar, memSidebar, "memActivePanel", "mem-panel"));

  // 恢复 IDE 面板状态
  _step("restoreIdePanel(ide)", () => restoreIdePanel(ideActivityBar, ideSidebar, "ideActivePanel", "ide-panel"));
  _step("restoreIdePanel(mem)", () => restoreIdePanel(memActivityBar, memSidebar, "memActivePanel", "mem-panel"));

  // 初始化三栏面板拖拽
  initPanelResize();

  // 初始化侧边栏拖拽
  initSidebarResize(ideSidebar, ideSidebarResize, "ideSidebarWidth");
  const memResizeHandle = memSidebar?.querySelector(".ide-sidebar-resize");
  initSidebarResize(memSidebar, memResizeHandle, "memSidebarWidth");
  const workSidebar = document.getElementById("work-sidebar");
  const workResizeHandle = document.getElementById("work-sidebar-resize");
  initSidebarResize(workSidebar, workResizeHandle, "workSidebarWidth");

  // 初始化菜单栏（idePanel 子模块）
  initMenubar(ideMenubar);

  // 绑定记忆侧边栏模式切换按钮
  initMemModeSwitchBtn();
  initMemToolbar();
  initBotActivityBar();
  // Bot面板懒加载初始化
  import("../../panels/bot/discordBotPanel.mjs").then(m => {
    m.initDiscordBotPanel?.({
      showToast: window._beiluToast || ((...a) => console.log("[toast]", ...a)),
      getCurrentCharId: () => document.getElementById("header-char-name-text")?.textContent || "",
      getPartList: async () => { try { return await sendAction({ verb: "getLoadedList", target: "server:list", source: "web", payload: { type: "plugins" } }) || []; } catch { return []; } },
    });
  }).catch(e => console.warn("[layout] discordBotPanel加载失败:", e));
  initCompanionActivityBar();

  // 绑定聊天停靠区折叠按钮

  // 先初始化设置面板slot（创建msg-load-limit等DOM），再初始化featureControls（绑定事件）
  // 独立 try-catch 隔离（0712 打架扫描短路点#1/#3）：任一子系统同步抛错原会终止 initLayout
  // → featureControls 不跑 → 聊天宽度滑块段缺席 → CSS 固定钳制顶上（凛倾窄列现象的成因链）。
  try { initSettingsSlots(); } catch (e) { console.error("[layout] initSettingsSlots 失败(已隔离):", e); window._reportError?.(`[layout] initSettingsSlots: ${e.message}`, e.stack); }

  // 初始化功能控件（featureControls 子模块）
  try { initFeatureControls(); } catch (e) { console.error("[layout] initFeatureControls 失败(已隔离):", e); window._reportError?.(`[layout] initFeatureControls: ${e.message}`, e.stack); }

  // F3 任务清单卡（聊天流顶部，AI 制定任务 + 打勾）
  initTaskCard();
  initCloneProgressCard();

  // 初始化 IDE 控制面板（idePanel 子模块）
  // pipelinePanel=skill组启动器（角色位次显示已删）；FT1 的 taskItemPanel 挂载在 #ide-task-panel。
  initPipelinePanel();
  initTaskItemPanel();
  initPermissionPanel(); // B3 权限：第1层档位在 control 原位，第2/3层=悬浮窗（重做拍板#3）
  initIdeOpMonitor();
  initIdeControlPanel();
  // initDataSystemPanel 已迁 memtool._loadMemToolTable（记忆板块表格视图内挂载，2026-07-16 去重）

  // 初始化手机适配（mobileAdaptation 子模块）
  initMobileAdaptation({
    leftPanel,
    rightPanel,
    leftToggle,
    rightToggle,
    toggleLeftPanel,
    toggleRightPanel,
  });

  // 浏览器感知状态轮询已删（2026-07-16）：beilu-browser 插件整体移除

  // G3 悬浮动态小窗已删（与通知中心职责重复，凛倾 2026-07-07「动态窗口删除,所有通知统一到通知那里」）：
  // 后台任务动态并入顶栏 🔔 通知中心（settings.mjs 通知块 + crossModeNotification.collectBackgroundTasks）

  // Greeting 两级分类 (设计13.1)
  _initSmartGreetingCategories();
  // smart 折叠区状态 localStorage (设计13.2)
  _initSmartCollapseMemory();
  // 临时对话系统 (设计3章核心)
  initTempConversationListener();
  // AIRP-T10: 右栏消息与上下文 input 双向同步到 hidden menu-* input
  _bindAirpMsgCtxInputs();
  _bindResetWorkWelcome();
  // AIRP-T15: 编辑弹窗窗口化档位
  _bindEditorWindowSizing();

  // W28→B39: 编辑界面Tab切换和返回按钮已移到 _initSettingsModals()

  // W28: 编辑界面入口 — 从侧栏/弹窗"专业编辑→"触发 (B39修复: 改为弹窗)
  // AIRP-T2/T11/T12: 打开编辑弹窗并切到指定 Tab
  window.addEventListener("beilu:openEditorTab", (e) => {
    const tab = e.detail || "preset-edit";
    _toggleSettingsModal("editor", true);
    // 切到对应的 editor-tab。同步 click：按钮是 index.html 静态节点（:2291-2295）、监听在
    // _initSettingsModals 启动时绑定——原 setTimeout(50) 是无依据的定时赌渲染（慢即静默失败），去异步化。
    document.querySelector(`.editor-tab[data-editor-tab="${tab}"]`)?.click();
  });

  // T006死码批: editor-entry 死绑定块（原:894-971）已删——.editor-entry 在 index.html 零存在
  // （querySelectorAll 空 NodeList，forEach 从未执行）。连带删 navigateToLayer（唯三调用在块内）
  // 与 index.css .editor-entry 族样式。beilu:openEditorTab 监听端(:上方)保留：块外仍有
  // smart/settings/panels/ide/persona/injprompt/charinfo 等 8+ 活 dispatch 源。

  // W35→B39: 设置活动栏逻辑已移到 _initSettingsModals()
  // 拖拽调宽保留
  {
    const settingsSidebar = document.getElementById("settings-sidebar");
    const settingsResize = document.getElementById("settings-sidebar-resize");
    initSidebarResize(settingsSidebar, settingsResize, "settingsSidebarWidth");
  }



  // ★ 跨模式通知/任务卡片的Tab跳转事件（W17）
  window.addEventListener("beilu:switchTab", (e) => {
    const tab = e.detail?.tab || (typeof e.detail === "string" ? e.detail : null);
    if (!tab) return;
    // B39修复: 设置和编辑走弹窗
    if (tab === "settings" || tab === "editor") {
      _toggleSettingsModal(tab);
      return;
    }
    switchTab(tab);
  });

  // beilu-home 前端已删除，openEditorIframe 事件不再响应（角色编辑已收口到 beilu-chat 内）

  // Phase 4A: 模式选择器 + 辅助菜单
  initModeSelector();
  initAuxMenu();
  initGlobalShortcuts();

  // 应用初始选项卡（isInit=true 表示初始化恢复，不在此处发 switchModeTo）。
  // [0716 两轴对账修] 视图轴(此处 localStorage 恢复)与模式轴(后端 active_mode)的 init 对账
  //   收口在 featureControls.syncModeFromBackend 尾部：后端基线落定后 tab≠模式 → 以视图为意图重推。
  //   本行同步设置 dataset.activeTab（switchTab:449），sync 的 HTTP 回包必在其后 → 对账读到的 tab 已就绪。
  switchTab(layoutState.activeTab, { isInit: true });

  // API 未配置提示 banner
  checkChatApiBanner();

  document
    .getElementById("chat-api-warning-close")
    ?.addEventListener("click", () => {
      const banner = document.getElementById("chat-api-warning-banner");
      if (banner) banner.style.display = "none";
    });

  // 只复用完整的 API 设置页，不再维护一套字段/协议不完整的内联“快速配置”表单。
  document.getElementById("chat-api-open-settings")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("beilu:openApiSettings", { detail: { source: "chat-api-warning" } }));
  });

  window.addEventListener("resource:api-changed", () => checkChatApiBanner());
  // 初始 check 常早于角色解析；角色/窗口身份就绪后必须按同一链重新判定，不能停在启动时假状态。
  window.addEventListener("beilu:char-changed", (event) => {
    checkChatApiBanner({ charName: event.detail?.charId || event.detail?.charName });
  });
  window.addEventListener("beilu:window-switched", (event) => {
    checkChatApiBanner({ charName: event.detail?.char });
  });

  // 初始化 MCP 管理面板（**全局唯一实例**：work 侧栏用的是同一个 DOM，见 workPanel._renderMcpSidebar
  //   的容器间搬移——0727 凛倾「work 的直接拉线,直接复刻 code 的,也不用缓存隔离」）
  {
    const _mcpRoot = document.getElementById("ide-panel-mcp");
    if (_mcpRoot && !_mcpRoot.dataset.mcpInited) { initMcpPanel("ide-panel-mcp"); _mcpRoot.dataset.mcpInited = "1"; }
  }

  // 初始化对话管理器
  initConversationManager();

  // 多卡并行面板已移除（并行机制暂停）
  // initCardsPanel("ide-cards-body");

  // 初始化任务时间线面板（任务N）
  initTaskTimeline("ide-panel-timeline");

  // 初始化 后端管理面板（任务P）
  initIdeConnPanel();

  // [0727] 并行组右栏面板已删(多窗口运行取代);groupRuntimePanel 仍由 workPanel 内联调用。

  // W30 M4: 打开Cursor/VSCode按钮
  document.getElementById("launch-editor-btn")?.addEventListener("click", async () => {
    try {
      // 原 POST setdata {_action:launchEditor,...} → memory 通配路由 verb=真动作组装 _action；门面返回解析体
      const data = await sendAction({ verb: "launchEditor", target: "plugins:beilu-memory", source: "web", payload: { editor: "auto" } });
      if (data?.success) {
        window._beiluToast?.(`已启动 ${data.editor || "编辑器"}`, "success");
      } else {
        window._beiluToast?.(data?.error || "启动失败", "error");
      }
    } catch (e) {
      window._beiluToast?.("启动编辑器失败: " + e.message, "error");
    }
  });

  // YonBan 扩展包导出：downloads/yonban.vsix 静态直下载（同 LOCALE_BASE 的 shell 静态基座）。
  // HEAD 预检=诚实降级：包未随部署提供时给可见提示而不是 404 死链。
  document.getElementById("export-yonban-btn")?.addEventListener("click", async () => {
    const url = "/parts/shells:beilu-chat/downloads/yonban.vsix";
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) {
        window._beiluToast?.("扩展包不可用（未随部署提供）", "error");
        return;
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = "yonban.vsix";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window._beiluToast?.("已开始下载，安装：VSCode / Cursor 扩展面板 → 从 VSIX 安装", "success");
    } catch {
      window._beiluToast?.("扩展包不可用（未随部署提供）", "error");
    }
  });

  // W24: 输出管控规则面板
  _initOutputFilterPanel();

  // W41: 右栏角色卡折叠区已删除（切换角色通过顶部角色名）
  // 保留header角色名同步
  window.addEventListener("beilu:char-changed", (e) => {
    const headerNameText = document.getElementById("header-char-name-text");
    if (headerNameText && e.detail?.charName) headerNameText.textContent = e.detail.charName;
  });
  // [0727 多窗口] 切窗口=纯显示交换：顶栏卡名换成该窗口出生时绑定的卡（只写显示 DOM，
  //   不走 beilu:char-changed——那条会触发 commitCurrentChar 写全局卡身份，切窗口无身份变更）。
  //   char 空（旧登记缺字段）不动，等该窗口下次真实加载时由 loadCharInfo 补写。
  window.addEventListener("beilu:window-switched", (e) => {
    const headerNameText = document.getElementById("header-char-name-text");
    if (headerNameText && e.detail?.char) headerNameText.textContent = e.detail.char;
  });

  // W35: 角色卡选择悬浮窗
  _initCharSelectorDropdown();

  // B39修复: 设置/编辑弹窗初始化
  _initSettingsModals();

  // W41修复: 设置/编辑按钮在topTabs外面，需单独绑定
  document.getElementById("settings-btn")?.addEventListener("click", () => _toggleSettingsModal("settings"));
  // W59重做: ✏️编辑按钮直接切到编辑Tab（全屏编辑界面，不弹窗）
  // 凛倾原话: "点击编辑还是二次转跳，不需要这个，直接转跳到全部的编辑界面"
  document.getElementById("editor-btn")?.addEventListener("click", () => {
    _toggleSettingsModal("editor");
    setTimeout(() => {
      const activeTab = document.querySelector(".editor-tab.active");
      if (activeTab) activeTab.click();
    }, 50);
  });

  // 初始化折叠组状态持久化
  initCollapsePersistence();

  // 初始化子模式面板（K2/K4：底部触发栏 + 管理面板）
  initSubModePanel();

  console.log(
    "[beilu-chat] 布局已初始化（顶部选项卡 + IDE 模式 + E1 模式会话隔离）",
  );
}
