/**
 * [index.mjs] — beilu-chat 前端总装配入口。不管聊天状态管理（那是 chat.mjs 的事），
 *   不管 API 请求封装（那是 api-client.mjs 的事），不管跨模块共享状态（那是 sharedState.mjs 的事）。
 *
 * 职责：
 *   1. 页面启动初始化 init()：主题 → ST兼容层 → 脚本加载 → i18n → 共享状态 →
 *      initializeChat(chat.mjs) → 预设读回 → 三栏布局 → API配置 → 扩展菜单 → 各懒面板注册
 *   2. 切卡免刷后重绑「信息·可见」面板（世界书/表格/记忆浏览器）
 *   3. Tab 懒加载门控（helper/files/bot/subtabs 首次激活才 dynamic import）
 *   4. IDE 写操作审批 dock（轮询+WS推送+attention弹窗）
 *
 * 链路：浏览器 DOMContentLoaded → init() → initializeChat()(chat.mjs) → initializeVirtualQueue() → WS 连接
 *       → 各 Tab 懒加载 → character-switched 事件 → 面板重绑
 * 影响：dispatch character-switched / beilu:tab-activated / beilu:char-changed / beilu:switchMode 等自定义事件；
 *       写 localStorage（通过 storage.mjs）；启动 setInterval 轮询（审批 dock / Eye / Browser）
 * 相交：← 浏览器加载  → chat.mjs(initializeChat/switchCharacterScope) → endpoints.mjs(CRUD)
 *       → sharedState.mjs(setModel/initSharedState) → api-client.mjs(apiFetch)
 *       → virtualQueue.mjs(消息渲染) → websocket.mjs(WS连接) → sidebar.mjs(侧栏)
 */
import { initTranslations } from "../../scripts/i18n.mjs";
import { initI18n } from "./src/shared/i18n.mjs"; // 壳覆盖式 i18n（中文=本体零行为，外语=差量字典覆盖）
import { getPartDetails, getPartList } from "../../scripts/parts.mjs";
import { usingTemplates } from "../../scripts/template.mjs";
import { applyTheme } from "../../scripts/theme.mjs";
import { setCharId, getCharId, setModel, initSharedState, getUsername } from "./src/shared/state/sharedState.mjs"; // [合并批 0714] getUsername=username 读点单源

import {
  initApiConfig,
  loadApiConfig,
} from "./src/panels/settings/apiConfig.mjs"; // 6c尾·根级散件归位
import { restoreStoredThemeState } from "./src/panels/settings/settingsSlots.mjs";
import {
  charList,
  initializeChat,
  personaName,
  setPersonaName,
  switchCharacterScope,
  worldName,
} from "./src/shared/chat-core/chat.mjs";
import { bindDataTableToChar } from "./src/panels/memory/dataTable.mjs";
// D6 skillInjectBar 整删（凛倾 2026-07-06 授权）：chip 条把 skill 原文写单次注入 = 0617 两次否决形态，
//   自称"v2 0618授权"全归档查无原话（0705 前端轮 D6 留决→0706 拍板删）。备份=删除批_凛倾授权_20260706_1258\skillInjectBar.mjs
//   [0723 后续] skillPicker 也已随说明书库整域删除（凛倾「说明书库可以删除,和inj重复」），上传按钮回归直传。
import {
  addUserReply,
  currentChatId,
  deleteMessage,
  getInitialData,
  modifyTimeLine,
  setPersona,
  triggerCharacterReply,
} from "./src/shared/transport/endpoints.mjs";
import { initExpandEditor } from "./src/shared/widgets/expandEditor.mjs" // 6c尾·根级散件归位;
import { initLayout } from "./src/shared/layout/layout.mjs";
import {
  bindMemoryBrowserToChar,
  initMemoryBrowser,
} from "./src/panels/memory/memoryBrowser.mjs";
import { initMemoryPresetChat } from "./src/panels/memory/memoryPresetChat.mjs";
import { initPromptViewer, openPromptViewer } from "./src/panels/feature/promptViewer.mjs" // 0716 解封回补：凛倾定案提示词查看器为核心功能，恢复≡菜单入口+初始化
import { initBackgroundSettings } from "./src/panels/editors/backgroundSettings.mjs";
import { initWorldBinding } from "./src/panels/editors/worldbookEditor.mjs"; // 死浮窗删除0706：initWbEditor 死 import 收口（浮窗整块已删，见该文件尾注）
import { initSTCompat } from "./src/stCompat/index.mjs";
import { apiFetch } from "./src/shared/transport/api-client.mjs";
import { storage, KEYS } from "./src/shared/state/storage.mjs";
import { loadGlobalScripts, loadPresetScripts } from "./src/stCompat/scriptRunner.mjs"; // loadCharacterScripts 死 import 删（真调用方=charscript.mjs，本文件零调用，2026-07-13 追链核实）
import { updateContext as updateVarContext } from "./src/stCompat/variableStore.mjs";
import {
  getChatLogIndexByQueueIndex,
  getQueue,
} from "./src/shared/render/virtualQueue.mjs";
import { initExtendMenuW28 } from "./src/shared/layout/extendMenuW28.mjs";
import { initReadinessBanner } from "./src/shared/widgets/readinessBanner.mjs"; // [D5 §2.4] 首屏 readiness 消费(遮罩+后台扩展卡,失败开放防锁死)
import { wbTrace, wbDetect } from "./src/shared/widgets/whitebox.mjs";
import { installDiagProbes } from "./src/shared/state/diagProbes.mjs"; // 0716 死标签接线：dom/perf 常驻探针
import { ensureLive2dVendorRuntime } from "./src/shared/companion/live2dRuntimeLoader.mjs";
import {
  configureCompanionRendererLoader,
  refreshCompanionRendererSettings,
  setCompanionRendererState,
} from "./src/panels/companion/companion.mjs";
import { escapeHtml, showToast, getCurrentCharId, waitForCharIdReady } from "./src/panels/airp/utils.mjs"; // P2续: 共享工具基座抽出；D1 收口:fallbackToast 死降级已删(toast 实现单源 scripts/toast.mjs)
import { handleNewChat, handleManageChats, handleBatchDelete, handleRegenerate } from "./src/panels/airp/chatmgmt.mjs"; // P2续: 会话管理 cluster 抽出
// 2A injprompt: 右栏列表面板 HTML 从未存在(纠察坐实), phantom 闭包已删。INJ 编辑走编辑界面 Tab4（layout.mjs beilu:openEditorTab "inj-edit"）。
// T006死码批: injectionEditor.mjs 浮窗已整文件删除（openInjEditor/closeInjEditor 零调用+inj-editor-* DOM 零存在）。
import { initCharacterScriptSystem, _loadScriptsForPreset } from "./src/panels/airp/charscript.mjs"; // P2续: 角色卡脚本系统 cluster 抽出
import { startEyeActivePoll } from "./src/panels/companion/eye.mjs"; // P2续: 桌面截图主动轮询（T006: initEyeStatusUI 死段已删）
import { initPersonaSelector } from "./src/panels/airp/persona.mjs"; // P2续: 用户人设选择 cluster 抽出
import { initCharInfoPanel } from "./src/panels/airp/charinfo.mjs"; // P2续: 角色快捷信息面板 cluster 抽出
// 2C懒载: index-memoryai 从 static import 移出 → boot 完成后 deferred dynamic import（省首屏 parse 327行）
// toggles→memoryai 死边已断(toggles.mjs initExtendMenu 死码删除) → memoryai 仅此处一个消费入口 → 真懒
import { initFeatureToggles } from "./src/panels/airp/toggles.mjs"; // P2续: 功能开关簇 抽出
// 注入坞（0726 重构）：工具栏按钮 → INJ 条目浮窗（搜索/排序/改位置，每条可⚡这轮或📌常驻）。
//   取代原「单次注入面板」单条 textarea（只能存一份=无法选择注入哪条，凛倾判「完全就是 bug」）。
//   单次注入改传条目 id 引用走 INJ 正线，不再传原文副本（副本形态=0617/0706 两次否决的 skillInjectBar）。
import { initInjectDock } from "./src/shared/chat-core/injectDock.mjs";
// P2续 懒加载: index-subtabs 改 dynamic import（见 init 的 beilu:tab-activated 监听），不再 static 急加载
import { getPresetData, fetchModels, applyPresetData, loadPresetData } from "./src/panels/airp/preset.mjs"; // P2续: 预设+模型参数 最大簇 抽出

// 记忆 dataTable：文件树视图内嵌挂载已删（T4 2026-07-07 凛倾拍板"删文件树里的记忆表格,用表格子tab那个"）。
// dataTable 唯一挂载点=memtool.mjs _loadMemToolTable（表格子tab）；此处仅保留 bindDataTableToChar
// 切卡/切回页面重绑（dataTable 内有 !_container 守卫，子tab未打开时空转安全）。


// ============================================================
// 初始化
// ============================================================

let _companionRendererState = "idle";
let _companionRendererPromise = null;

// 静态首屏遮罩的唯一生命周期出口：init 成功才移除；顶层异常转为可见失败态并提供刷新。
// 各懒加载扩展不在此门内，避免后台预加载拖住基础聊天界面。
function settleBootOverlay(error = null) {
  const overlay = document.getElementById("app-boot-overlay");
  if (!overlay) return;
  if (!error) {
    overlay.remove();
    return;
  }
  overlay.dataset.state = "failed";
  overlay.setAttribute("aria-busy", "false");
  const spinner = document.getElementById("app-boot-spinner");
  const status = document.getElementById("app-boot-status");
  const retry = document.getElementById("app-boot-retry");
  if (spinner) spinner.hidden = true;
  if (status) status.textContent = `界面初始化失败：${error?.message || error}`;
  if (retry) {
    retry.hidden = false;
    retry.addEventListener("click", () => window.location.reload(), { once: true });
  }
}

// Companion 渲染器的唯一创建 owner。首次激活才 dynamic import，并发激活/重试/模型切换
// 全部复用同一 Promise，避免重复读字典、创建 PIXI.Application 或丢掉初始化期间的选择。
function ensureCompanionRenderer() {
  if (_companionRendererState === "ready" && _companionRendererPromise) return _companionRendererPromise;
  if (_companionRendererPromise) return _companionRendererPromise;

  _companionRendererState = "loading";
  setCompanionRendererState("loading");
  _companionRendererPromise = import("./src/shared/companion/live2dRenderer.mjs")
    .then(async ({ initLive2dRenderer }) => {
      const ok = await initLive2dRenderer({ ensureVendorRuntime: ensureLive2dVendorRuntime });
      if (!ok || !window.beiluLive2d?.ready?.()) throw new Error("虚拟形象渲染器未进入 ready 状态");
      refreshCompanionRendererSettings();
      _companionRendererState = "ready";
      setCompanionRendererState("ready");
      return window.beiluLive2d;
    })
    .catch((error) => {
      _companionRendererState = "idle";
      _companionRendererPromise = null;
      setCompanionRendererState("error", error);
      throw error;
    });
  return _companionRendererPromise;
}

configureCompanionRendererLoader(ensureCompanionRenderer);

window.addEventListener("beilu:tab-activated", (event) => {
  if (event.detail !== "companion") return;
  startEyeActivePoll();
  ensureCompanionRenderer().catch((error) => {
    console.error("[live2d] Companion 渲染器初始化失败:", error);
    window._reportError?.(`[live2d] Companion 渲染器初始化失败: ${error?.message || error}`, error?.stack);
  });
});

async function init() {
  console.log(
    "[beilu-chat][DIAG] ===== init() 开始 =====",
    "hash:",
    window.location.hash,
    "href:",
    window.location.href,
  );
  try {
    await applyTheme();
  } catch (e) {
    console.error("[beilu-chat] 主题初始化失败（继续加载 UI）:", e);
  }
  try {
    restoreStoredThemeState();
  } catch (e) {
    console.error("[beilu-chat] Beilu 主题状态恢复失败（继续加载 UI）:", e);
  }

  // 初始化 ST 兼容层（EventBus + Globals + CDN 预加载）
  try {
    initSTCompat();
  } catch (e) {
    console.warn("[beilu-chat] initSTCompat 失败（非致命）:", e.message);
  }

  // S2: 加载全局脚本(scope='global',切角色不卸载,页面生命周期常驻)
  //   数据:data/users/{username}/global_scripts.json (用户手编 JSON)
  //   文件格式:{ scripts: [{id, name, enabled, type:"script", content, button, data}] }
  try {
    loadGlobalScripts().catch((e) =>
      console.warn("[beilu-chat] loadGlobalScripts 失败（非致命）:", e.message)
    );
  } catch (e) {
    console.warn("[beilu-chat] loadGlobalScripts 启动失败:", e.message);
  }

  // S2: 启动时加载一次预设脚本(scope='preset'),之后由 beilu:preset-changed 重载
  try {
    _loadScriptsForPreset();
  } catch (e) {
    console.warn("[beilu-chat] loadPresetScripts 启动失败:", e.message);
  }

  try {
    await initTranslations("chat");
  } catch (e) {
    console.warn("[beilu-chat] initTranslations 失败（非致命）:", e.message);
  }

  // 壳覆盖式 i18n：上次为外语时恢复覆盖层；中文时零行为（在 fount initTranslations 之后，覆盖层后到先赢）
  // 壳覆盖式 i18n：上次为外语时恢复覆盖层；中文零行为。语言切换入口=设置→语言（settingsSlots.mjs），
  // 新用户首次自动打开一次（settings.mjs _initFirstRunGuide，注册标志 beiluNewUser 驱动）
  try {
    await initI18n();
  } catch (e) {
    console.warn("[beilu-chat] 覆盖式 initI18n 失败（非致命）:", e.message);
  }

  try {
    usingTemplates("/parts/shells:beilu-chat/src/shared/render/templates");
  } catch (e) {
    console.warn("[beilu-chat] usingTemplates 失败（非致命）:", e.message);
  }

  // 暴露 toast 给各 UI 模块（layout/workPanel/tempConversation 经 window._beiluToast 调用）
  window._beiluToast = showToast;
  // websocket/featureControls 用 window.showToast(type, message, duration) 顺序，适配到 showToast(message, type)
  window.showToast = (type, message) => showToast(message, type);

  // 共享状态初始化（从 DOM 读取初始值，之后 DOM 只用于显示）
  initSharedState();

  console.log("[beilu-chat][DIAG] init: 即将调用 initializeChat...");
  try {
    await initializeChat();
  } catch (e) {
    console.error(
      "[beilu-chat][DIAG] initializeChat 失败:",
      e.message,
      e.stack,
    );
  }
  console.log("[beilu-chat][DIAG] init: initializeChat 完成");

  // 等待现有聊天初始化返回后先读回当前预设；其余布局、设置与扩展装配不得抢占这条顺序链。
  await loadPresetDataWithRetry();

  // 初始化三栏布局（折叠/选项卡交互）
  try {
    initLayout();
  } catch (e) {
    // [0727] 原文案是「非致命」+ console.warn —— 判断错了：initLayout 是一长串顺序接线，
    //   它中断意味着**后面所有 UI 接线都没绑**（＋号死按钮、面板点了没反应都是这条），
    //   而 warn 在控制台里毫不起眼，等于故障静默。子步骤已在 layout.mjs 内逐个隔离（_step），
    //   能走到这里的是隔离网都兜不住的整体失败，必须显式上报到错误系统。
    console.error("[beilu-chat] initLayout 整体失败（后续 UI 接线可能全部未绑定）:", e);
    window._reportError?.(`[beilu-chat] initLayout 整体失败: ${e?.message || e}`, e?.stack);
  }

  // dom/perf 诊断常驻探针（输出由诊断面板模块开关门控，默认零输出）
  try {
    installDiagProbes();
  } catch (e) {
    console.warn("[beilu-chat] installDiagProbes 失败（非致命）:", e.message);
  }

  // 字体比例控制已在 initLayout() → initFeatureControls() 中初始化，不再重复调用

  // 初始化 API 配置模块
  try {
    initApiConfig();
  } catch (e) {
    console.warn("[beilu-chat] initApiConfig 失败（非致命）:", e.message);
  }

  // W28: 初始化扩展菜单+模型选择器
  try {
    initExtendMenuW28();
  } catch (e) {
    console.warn("[beilu-chat] initExtendMenuW28 失败（非致命）:", e.message);
  }

  // W53: 注册extendMenuW28派发的自定义事件监听器
  // 新版≡菜单通过事件通信，这里桥接到已有的handler函数
  window.addEventListener("beilu:openPromptViewer", () => openPromptViewer());
  window.addEventListener("beilu:newChat", () => handleNewChat());
  window.addEventListener("beilu:manageChats", () => handleManageChats());
  window.addEventListener("beilu:regenerate", () => handleRegenerate());
  window.addEventListener("beilu:batchDelete", () => handleBatchDelete());


  // 模型获取按钮 + 下拉联动（P2续: DOM const 随 index-preset 簇迁出，此处 init wiring 改 getElementById 重查）
  const _apiFetchModelsBtn = document.getElementById("api-fetch-models");
  _apiFetchModelsBtn?.addEventListener("click", () => {
    const silent = _apiFetchModelsBtn.dataset.silent === "1";
    delete _apiFetchModelsBtn.dataset.silent;
    fetchModels({ silent });
  });
  const _apiModelSelect = document.getElementById("api-model-select");
  _apiModelSelect?.addEventListener("change", () => {
    if (_apiModelSelect.value) {
      setModel(_apiModelSelect.value);
    }
  });
  // [0717 凛倾「拉条是每次都需要访问,不是访问一次就缓存,每次点击都需要访问」]：
  //   点击展开模型下拉即静默实时拉当前源列表；fetchModels 内列表未变跳过重建（不收起展开中的下拉）
  _apiModelSelect?.addEventListener("mousedown", () => {
    fetchModels({ silent: true });
  });

  // 注入坞 — 工具栏按钮弹出 INJ 条目浮窗（按钮委托 + 点外/Esc 关闭 + 条目变更事件订阅）
  initInjectDock();

  // skill 临时注入·快速选择条(输入框下方 chip → 临时注入该卡说明书原文,复用单次注入线)
  // initSkillInjectBar() 调用已随 D6 整删（见顶部 import 区注释）

  // 加载 API 服务源配置（右栏下拉框）
  loadApiConfig();

  // 刷新按钮
  document
    .getElementById("preset-refresh-btn")
    ?.addEventListener("click", () => {
      loadPresetData();
      showToast("预设数据已刷新", "info");
    });

  // W55: 预设切换后刷新预设 UI。
  // 线路独立：本窗口 switchPreset 的即时 UI 更新由 preset.mjs:842 (beilu:presetSwitched) 同步处理（selector.value = name），
  // 全量刷新（列表/描述/模型参数/header using_preset）统一由 WS 广播的 beilu:preset-changed 触发 loadPresetData 一次性完成。
  // 原 beilu:presetSwitched 也触发 loadPresetData = 同窗口双触发（4 次 HTTP/切换），去掉消除冗余。
  window.addEventListener("beilu:preset-changed", () => { loadPresetData(); });

  // 初始化角色快捷信息面板（左栏）
  console.log("[beilu-chat][DIAG] init: 即将调用 initCharInfoPanel...");
  try {
    await initCharInfoPanel();
  } catch (e) {
    console.error(
      "[beilu-chat][DIAG] initCharInfoPanel 失败:",
      e.message,
      e.stack,
    );
  }
  console.log("[beilu-chat][DIAG] init: initCharInfoPanel 完成");

  // 初始化世界书绑定（左栏）
  try {
    await initWorldBinding({
      showToast,
      escapeHtml,
      getCurrentCharId,
      getPartList,
      worldName,
    });
  } catch (e) {
    console.warn("[beilu-chat] initWorldBinding 失败（非致命）:", e.message);
  }

  // 世界书浮窗编辑器已彻底删除（0706 凛倾授权：worldbookEditor.mjs 死浮窗 ~700 行整块删+本文件死 import 收口）；
  // initWorldBinding 仍保留（管左栏世界书绑定下拉）。世界书编辑统一走编辑界面 Tab2 内联。

  // 初始化用户人设选择（左栏）
  try {
    await initPersonaSelector();
  } catch (e) {
    console.warn("[beilu-chat] initPersonaSelector 失败（非致命）:", e.message);
  }

  // 初始化记忆文件浏览器（侧边栏文件树 + 文件查看器）
  try {
    const memoryTreeEl = document.getElementById("memory-tree");
    const memoryFileViewer = document.getElementById("memory-file-viewer");
    if (memoryTreeEl) {
      const charId = getCurrentCharId();
      const _mbUsername = getUsername(); // [合并批 0714] 内联读法删除 → sharedState.getUsername 单源
      await initMemoryBrowser(memoryTreeEl, memoryFileViewer, {
        charId: charId || "",
        username: _mbUsername,
      });

      // 如果角色卡还没加载好，用共享 polling 延迟绑定文件浏览器
      if (!charId) {
        waitForCharIdReady(id => {
          bindMemoryBrowserToChar(id);
          console.log("[beilu-chat] memoryBrowser 延迟绑定角色卡:", id);
        });
      }
    }
  } catch (e) {
    console.warn("[beilu-chat] initMemoryBrowser 失败（非致命）:", e.message);
  }
  // P2续 懒加载(1A): helper tab 四面板(regex/variable/script/plugin 编辑器)从 boot 急 init 移出。
  // 它们是 helper tab 专属面板，首屏(默认 chat tab)用不到 → 首次激活 helper 才 dynamic import + init。
  // 闭包 loaded 幂等守卫 + 容器守卫 + reload 恢复补查（复用 subtabs 同款范式）。
  const _lazyHelperPanels = (() => {
    let loaded = false;
    return async (tab) => {
      if (loaded || tab !== "helper") return;
      loaded = true;
      try {
        // 正则编辑器已移到编辑界面tab，由layout-settings.mjs _loadRegexInEditor懒加载
        // 旧的helper面板容器(regex-editor-container)已隐藏，不再初始化
        const varContainer = document.getElementById("variable-manager-container");
        if (varContainer) {
          const m = await import("./src/stCompat/variableManager.mjs");
          m.initVariableManager(varContainer);
        }
        const scriptContainer = document.getElementById("script-manager-container");
        if (scriptContainer) {
          const m = await import("./src/stCompat/scriptManager.mjs");
          m.initScriptManager(scriptContainer);
        }
        const pluginContainer = document.getElementById("plugin-manager-container");
        if (pluginContainer) {
          const m = await import("./src/stCompat/pluginManager.mjs");
          m.initPluginManager(pluginContainer);
        }
      } catch (e) {
        console.warn("[beilu-chat] 懒加载 helper 面板失败（非致命）:", e.message);
      }
    };
  })();
  window.addEventListener("beilu:tab-activated", (e) => _lazyHelperPanels(e.detail));
  // initLayout 的 switchTab 可能早于本监听触发过 → 补查当前 tab，接住 reload 恢复到 helper
  _lazyHelperPanels(document.body.dataset.activeTab);

  // P2续 懒加载: 助手/Bot 子选项卡 = helper/bot tab 专属，首次激活该 tab 才 dynamic import（含 reload 恢复）
  const _lazySubtabs = (() => {
    let loaded = false;
    return async (tab) => {
      if (loaded || (tab !== "helper" && tab !== "bot")) return;
      loaded = true;
      try {
        const m = await import("./src/panels/airp/subtabs.mjs");
        m.initHelperSubTabs();
        m.initBotSubTabs();
      } catch (err) {
        console.warn("[beilu-chat] 懒加载 subtabs 失败（非致命）:", err.message);
      }
    };
  })();
  window.addEventListener("beilu:tab-activated", (e) => _lazySubtabs(e.detail));
  // initLayout 的 switchTab 可能早于本监听触发过 → 补查当前 tab，接住 reload 恢复到 helper/bot
  _lazySubtabs(document.body.dataset.activeTab);

  // 2A injprompt: 右栏 injection-prompt-list HTML 从未添加(纠察坐实),闭包是 phantom code 已删。
  // T006死码批: injectionEditor.mjs 已删（旧注释称"inj-editor-window HTML:4484,LIVE"与实盘矛盾——index.html 零命中该 id）。
  // INJ 编辑正路=编辑界面 Tab4（beilu:openEditorTab detail:"inj-edit"）。index-injprompt.mjs 模块保留备用。

  // P2续 懒加载(1B): files(IDE) tab 两面板(文件浏览器/Git)从 boot 急 init 移出。
  // IDE 面板首屏(默认 chat tab)用不到 → 首次激活 files tab 才 dynamic import + init（含容器守卫 + reload 补查）。
  const _lazyFilesTab = (() => {
    let loaded = false;
    return async (tab) => {
      if (loaded || tab !== "files") return;
      loaded = true;
      try {
        const fileTree = document.getElementById("ide-panel-explorer");
        const fileEditor = document.getElementById("file-editor-area");
        if (fileTree && fileEditor) {
          const m = await import("./src/panels/code/fileExplorer.mjs");
          await m.initFileExplorer(fileTree, fileEditor);
        }
        const gitPanel = document.getElementById("ide-panel-git");
        if (gitPanel) {
          const m = await import("./src/panels/code/gitPanel.mjs");
          await m.initGitPanel(gitPanel);
        }
      } catch (e) {
        console.warn("[beilu-chat] 懒加载 files 面板失败（非致命）:", e.message);
      }
    };
  })();
  window.addEventListener("beilu:tab-activated", (e) => _lazyFilesTab(e.detail));
  _lazyFilesTab(document.body.dataset.activeTab);

  // 前端侧全量预取：boot 空闲后把上述 tab 懒载模块的网络+parse 成本提前吃掉（与后端 fullLoadAllParts 对偶）。
  // 只 import 暖 ESM 模块缓存，不 init——init 仍由 tab 激活触发（容器可见性/幂等守卫语义不变），
  // 首次切 tab 时 import 命中缓存即时返回，不再"打开一个等一会"。
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 3000)))(() => {
    for (const p of [
      "./src/stCompat/variableManager.mjs",
      "./src/stCompat/scriptManager.mjs",
      "./src/stCompat/pluginManager.mjs",
      "./src/panels/airp/subtabs.mjs",
      "./src/panels/code/fileExplorer.mjs",
      "./src/panels/code/gitPanel.mjs",
    ]) import(p).catch(() => {});
  });

  // 页面可见性变化时自动刷新数据（从 beilu-home 切回时同步）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      console.log("[beilu-chat] 页面重新可见，刷新预设数据");
      loadPresetData();
      // 不再重复loadApiConfig（避免反复触发fetchModels CORS请求）
      // 刷新 dataTable 和文件浏览器角色卡绑定
      const charId = getCurrentCharId();
      if (charId) {
        bindDataTableToChar(charId);
        bindMemoryBrowserToChar(charId);
      }
    }
  });

  // 切卡免刷：switchCharacterScope 切换对话后，重绑「信息·可见」世界书 +「信息·懒」表格/记忆。
  // 在 init() 注册一次（页面生命周期常驻，无泄漏）；复用 visibilitychange 同款角色卡重绑路径。
  window.addEventListener("character-switched", async (e) => {
    console.debug(
      "[切卡免刷] index 收到 character-switched:",
      e.detail?.chatid?.substring?.(0, 8),
    );
    // 信息·可见：世界书重绑（复用 init 的 initWorldBinding 配置）
    try {
      await initWorldBinding({
        showToast,
        escapeHtml,
        getCurrentCharId,
        getPartList,
        worldName,
      });
    } catch (err) {
      console.warn("[切卡免刷] 世界书重绑失败（非致命）:", err.message);
    }
    // 信息·懒：表格 + 记忆浏览器重绑（复用 visibilitychange 角色卡重绑）
    const charId = getCurrentCharId();
    if (charId) {
      try {
        bindDataTableToChar(charId);
      } catch (err) {
        console.warn("[切卡免刷] dataTable 重绑失败（非致命）:", err.message);
      }
      try {
        bindMemoryBrowserToChar(charId);
      } catch (err) {
        console.warn("[切卡免刷] memoryBrowser 重绑失败（非致命）:", err.message);
      }
    }
    // 新chatId可能映射不同的per-chat预设，刷新预设显示名
    try {
      await loadPresetData();
    } catch (err) {
      console.warn("[切卡免刷] 预设显示名刷新失败（非致命）:", err.message);
    }
  });

  // 初始化放大编辑器（所有 textarea 的通用放大窗口）
  try {
    initExpandEditor();
  } catch (e) {
    console.warn("[beilu-chat] initExpandEditor 失败（非致命）:", e.message);
  }

  try {
    initPromptViewer();
  } catch (e) {
    console.warn("[beilu-chat] initPromptViewer 失败（非致命）:", e.message);
  }

  // W46: 旧≡菜单已被W28新菜单(initExtendMenuW28 L1726)替代，禁用旧版避免双重绑定
  // initExtendMenu();

  // 初始化功能开关面板
  initFeatureToggles();

  // 初始化聊天背景设置（C3: 背景图+透明度+模糊）
  try {
    initBackgroundSettings({ showToast });
  } catch (e) {
    console.warn(
      "[beilu-chat] initBackgroundSettings 失败（非致命）:",
      e.message,
    );
  }

  // 2C懒载: memoryai 记忆AI面板非首屏必需(面板默认hidden) — boot完成后deferred dynamic import
  // 省首屏 parse 327行。toggles→memoryai 死边已断 → 首屏不再静态拉入 memoryai。
  // window._beiluSyncInj2State 在模块eval时设置,layout.mjs用?.()保护,懒载前no-op降级安全。
  import("./src/panels/airp/memoryai.mjs").then(m => {
    m.loadInj2Status();
    try { m.initMemoryOutputPanel(); } catch (e) { console.warn("[beilu-chat] initMemoryOutputPanel 失败:", e.message); }
    m.initMemoryAIPanelCollapse();
  }).catch(e => console.warn("[beilu-chat] 懒加载 memoryai 失败（非致命）:", e.message));

  // 初始化记忆AI预设交互模块（侧边栏预设面板 + AI对话面板）
  try {
    await initMemoryPresetChat();
  } catch (e) {
    console.warn(
      "[beilu-chat] initMemoryPresetChat 失败（非致命）:",
      e.message,
    );
  }

  // 初始化角色卡脚本系统（tavern_helper 脚本 iframe）
  try {
    await initCharacterScriptSystem();
  } catch (e) {
    console.warn(
      "[beilu-chat] initCharacterScriptSystem 失败（非致命）:",
      e.message,
    );
  }

  // 桌面截图轮询：不在 init 无条件启动。
  // 原无条件 startEyeActivePoll → 未启用时每 2s 白发 HTTP → 网络抖动时堆积占满浏览器连接槽 → 级联超时。
  // 改为：companion tab 激活时再启动（eye.mjs startEyeActivePoll 有 if(_eyePollTimer)return 防重入）。
  // 无桌宠客户端的用户 = 零轮询零浪费。

  // 浏览器感知轮询已删（2026-07-16）：beilu-browser 插件整体移除

  // W66: 文件操作结果自动继续已移至后端 generation.mjs 统一控制
  // 前端不再轮询，避免与后端重复触发
  console.log("[beilu-chat] 文件操作结果自动继续由后端控制（前端轮询已禁用）");

  // [D5 §2.4] 首屏 readiness 消费：launcher 现在 shellReady 就开浏览器，本模块把后端阶段真值
  // 渲染给用户（chatInteractive 未成立=输入软遮罩「正在准备基础聊天…」；后台预加载/失败扩展
  // =右下可折叠卡+重试）。失败开放：readiness 不可达/旧后端 → 立即解除，绝不因观测面锁死输入。
  try {
    initReadinessBanner();
  } catch (e) {
    console.warn("[beilu-chat] initReadinessBanner 失败（非致命）:", e.message);
  }

  console.log(
    "[beilu-chat] Shell 已加载 — Phase 4 三栏布局 + 聊天 + 预设 + API 配置 + dataTable 记忆编辑器 + 正则编辑器 + 文件浏览器 + 提示词查看器 + 记忆AI输出面板 + 记忆AI预设交互",
  );
}

/**
 * 带重试的预设数据加载
 * 首次加载失败时，延迟重试最多 3 次（应对插件路由未就绪的时序问题）
 */
async function loadPresetDataWithRetry() {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1500; // ms

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await getPresetData();
      // 检查返回数据是否有效（preset_list 非空 或 preset_loaded 为 true）
      if (data.preset_list?.length > 0 || data.preset_loaded) {
        console.log(`[beilu-chat] 预设数据加载成功（第${attempt}次尝试）`);
        applyPresetData(data);
        return;
      }
      // 数据有效但确实没有预设（preset_list 为空数组）
      if (Array.isArray(data.preset_list)) {
        console.log(
          `[beilu-chat] 预设数据为空（后端无预设），第${attempt}次尝试`,
        );
        applyPresetData(data);
        return;
      }
    } catch (err) {
      console.warn(`[beilu-chat] 预设加载第${attempt}次失败:`, err.message);
    }

    if (attempt < MAX_RETRIES) {
      console.log(`[beilu-chat] ${RETRY_DELAY}ms 后重试...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }
  }
  // 所有重试都失败，回退到普通加载
  console.warn("[beilu-chat] 预设加载重试耗尽，执行普通加载");
  await loadPresetData();
}









init()
  .then(() => {
    settleBootOverlay();
    document.body.dataset.beiluBootReady = "1";
    window.dispatchEvent(new CustomEvent("beilu:boot-ready"));
  })
  .catch((error) => {
    console.error("[beilu-chat] 顶层初始化中断:", error);
    window._reportError?.(`[beilu-chat] 顶层初始化中断: ${error?.message || error}`, error?.stack);
    settleBootOverlay(error);
  });
