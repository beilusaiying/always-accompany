/**
 * [chat.mjs] — 前端聊天初始化 + 运行时切卡。不管消息渲染（那是 virtualQueue.mjs 的事），
 *   不管 WS 通信（那是 websocket.mjs 的事），不管预设/模型参数管理（那是 index-preset.mjs 的事）。
 *
 * 职责：
 *   1. initializeChat()：首次页面加载的聊天初始化流程（CSS → WS → 角色解析 → 数据获取 → 插件注册 → display规则 → 队列 → 侧栏 → 消息输入）
 *   2. switchCharacterScope()：切卡免刷运行时切换（不 reload，复用首次装配的 primitives）
 *   3. stopGeneration()：通过 WS 发送停止生成指令
 *   4. IDE 写操作审批 dock（轮询渲染+按钮绑定+WS推送监听）
 *   5. 角色/插件/世界/人设列表的导出状态（sidebar 消费）
 *
 * 链路：index.mjs init() → initializeChat() → resolveChatIdForChar()（角色隔离解析）→ getInitialData()
 *       → autoRegisterBeiluPlugins() → loadDisplayRules() → initializeVirtualQueue() → updateSidebar()
 *       切卡：conversationManager/sidebar → switchCharacterScope() → reconnectWebSocket() → getInitialData()
 *       → loadDisplayRules() → initializeVirtualQueue() → dispatch character-switched
 * 影响：写 localStorage（beilu-last-char / 模式隔离 chatid key）；设置 window.location.hash；
 *       dispatch character-switched / beilu:char-changed 事件；创建新聊天（POST /new + /char）；
 *       启动 setInterval（审批 dock 轮询）
 * 相交：← index.mjs(init调用) / sidebar·conversationManager(切卡调用)
 *       → endpoints.mjs(getInitialData/addPlugin/addCharacter/setCurrentChatId)
 *       → api-client.mjs(apiFetch) → websocket.mjs(initializeWebSocket/reconnectWebSocket/sendWebsocketMessage)
 *       → virtualQueue.mjs(initializeVirtualQueue) → sidebar.mjs(updateSidebar/setupSidebar)
 *       → displayRegex.mjs(loadDisplayRules) → storage.mjs(storage/KEYS)
 */
import { showToastI18n, showToast } from "../../../../../../scripts/toast.mjs";
import { getAllDefaultPartsByType, getPartList } from "../../../../../../scripts/parts.mjs";
import { ensureNotifyPermission } from "../../../../../../scripts/desktopNotify.mjs";

import { loadDisplayRules, loadAirpCaps } from "../render/displayRegex.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），shells:chat 生命周期 + chars 缓存 + beilu-memory IDE 审批收口
import { isValidChatId } from "../state/sharedState.mjs";
import {
  addCharacter,
  addPlugin,
  announceActiveChat,
  currentChatId,
  getInitialData,
  setPersona,
  setWorld,
  setCurrentChatId,
} from "../transport/endpoints.mjs";
import { escapeHtml, BOT_CHAT_SYMBOL } from "../state/utils.mjs"; // 0715 收口:bot 符号前端单源(原 "🤖" 字面量散写)
import { setupCss } from "../layout/css.mjs";
import { initializeMessageInput } from "./messageInput.mjs";
import { setupSidebar, updateSidebar } from "../layout/sidebar.mjs";
import { initializeVirtualQueue } from "../render/virtualQueue.mjs";
import { initializeWebSocket, reconnectWebSocket, sendWebsocketMessage } from "../transport/websocket.mjs";
import { showCrossModeNotification } from "../widgets/crossModeNotification.mjs";
import { wbTrace } from "../widgets/whitebox.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { onEventBus } from "../state/eventBusCore.mjs"; // [0807 转接二期#6] 总线订阅单源

// P0 防循环：回退计数键（sessionStorage，非 localStorage，故不进 KEYS 表）。
//   提升到模块级：initializeChat() 内 catch 分支写计数、函数末尾清计数两处需共用同一常量，
//   原局部定义在 catch 的 if 块内，函数末尾清计数处作用域不可见，会导致键名两处手写易漂移。
const FALLBACK_KEY = "beilu_chat_fallback_count";

// [0716 断线补拉·凛倾拍板] WS 真重连后全量重取当前对话消息重渲染——断线窗口错过的
//   message_added/message_replaced 永久丢（WS 无回放），生成终态错过=卡"生成中"只能手动刷新。
//   复用切卡免刷同套配方（getInitialData→initializeVirtualQueue）；chatid 校验防错窗渲染；
//   in-flight 守卫防连续重连风暴叠加重拉。
let _wsResyncInFlight = false;
// [0719 F5 双键归一·病征④] init 进行中标志原是双份状态：模块局部 _initializingChat + window
//   镜像 _beiluChatInitializing（跨模块桥，featureControls:961 消费）成对同写——单改一处即漂移。
//   归一为 window 单键（桥防环合法，双份状态才是病）；模块内读点同读单键。
window.addEventListener("beilu:wsReconnected", async (e) => {
  const _cid = e?.detail?.chatid;
  if (!_cid || _cid !== currentChatId || _wsResyncInFlight || window._beiluChatInitializing) return;
  _wsResyncInFlight = true;
  try {
    const _data = await getInitialData();
    if (_cid === currentChatId && _data) {
      await initializeVirtualQueue(_data);
      console.log("[chat] ★ WS 重连补拉完成（断线窗口消息已重同步）");
    }
  } catch (err) {
    console.warn("[chat] WS 重连补拉失败（非致命，可手动刷新）:", err?.message || err);
  } finally {
    _wsResyncInFlight = false;
  }
});

// beilu 专用插件列表 — 创建/加载聊天时自动注册
const BEILU_AUTO_PLUGINS = [
  "beilu-preset",
  "beilu-toggle",
  "beilu-logger",
  "beilu-files",
  "beilu-regex",
  "beilu-worldbook",
];

// These are shared state used by the sidebar.
// They will be updated by events from the websocket.

/**
 * 聊天角色列表。
 * @type {Array<string>}
 */
export let charList = [];
/**
 * @type {Array<string>}
 */
export let pluginList = [];
/**
 * 当前世界名称。
 * @type {string|null}
 */
export let worldName = null;
/**
 * 当前角色名称。
 * @type {string|null}
 */
export let personaName = null;

/**
 * 设置聊天角色列表。
 * @param {Array<string>} list - 角色列表。
 */
export function setCharList(list) {
  charList = list;
}

/**
 * 设置插件列表。
 * @param {Array<string>} list - 插件列表。
 */
export function setPluginList(list) {
  pluginList = list;
}
/**
 * 设置当前世界名称。
 * @param {string} name - 世界名称。
 */
export function setWorldName(name) {
  worldName = name;
}
/**
 * 设置当前角色名称。
 * @param {string} name - 角色名称。
 */
export function setPersonaName(name) {
  personaName = name;
}

/**
 * 自动注册 beilu 专用插件。
 * 检查当前聊天的 pluginlist，若缺少必要插件则自动添加。
 * @param {Array<string>} currentPlugins - 当前已注册的插件列表
 */
async function autoRegisterBeiluPlugins(currentPlugins) {
  let registered = 0;
  for (const pluginName of BEILU_AUTO_PLUGINS) {
    if (!currentPlugins.includes(pluginName)) {
      try {
        await addPlugin(pluginName);
        registered++;
        console.log(`[beilu-chat] 自动注册插件: ${pluginName}`);
      } catch (err) {
        console.warn(
          `[beilu-chat] 自动注册插件 ${pluginName} 失败:`,
          err.message,
        );
      }
    }
  }
  return registered;
}

/**
 * 判断一个聊天摘要是否属于指定角色的【web 常规对话】。
 * 权威字段 primaryCharName（目录归属），兼容旧数据 chars 数组。
 *
 * bot 对话排除（凛倾 07-09「前端其他的屏蔽,只有在bot模式出现」全入口收口）：
 *   bot 对话文件（customName 带 🤖 符号，=后端 chatOps BOT_CHAT_SYMBOL 镜像）虽归属角色，
 *   但由 Bot 面板/指针体系（bot_chat_bindings）专属管理——本函数是 web 侧全部
 *   「列表显示/自动选线」消费点（charsel 切卡/chat.mjs 启动解析/smart/work/chatmgmt/layout
 *   共 8 处）的单一权威，在此排除=一处收口；否则 bot 线常年最活跃，切角色/启动会把
 *   web 直接带进 bot 对话。Bot 面板取线不走本函数（走 newBotChat peek/getChatList 自滤）。
 * @param {object} chat - getchatlist 返回的聊天摘要
 * @param {string} charName - 角色名
 * @returns {boolean}
 */
// [D7 迁移 0713] 本体迁 shared/state/utils.mjs（纯函数层）：/new 等轻入口页可 import 权威
// 而不拉起本文件重链（原各自手抄漏判 primaryCharName/bot 排除）。import+export 双句：本文件
// :215/:219 等内部调用需要本地绑定，纯 re-export 语法不创建本地绑定会 ReferenceError。
import { chatBelongsToChar } from "../state/utils.mjs";
export { chatBelongsToChar };

/**
 * 框架级单一权威：解析「当前角色应加载哪个聊天」。
 *
 * 规则（唯一，不分支打补丁）：
 *   1. 若 hashChatId 指向的聊天确属当前角色 → 采纳它（保留深链/刷新定位）。
 *   2. 否则取当前角色自己最近的聊天（getchatlist 已按时间倒序）。
 *   3. 当前角色无任何聊天 → 新建空白聊天并绑定该角色。
 *   ★ 任何情况都不跨角色回退到「最近聊天」——这是对话隔离的根本保证。
 *
 * 仅当 charName 为空（全新用户从未选过角色）时，允许回退到 hash 或最近聊天，
 * 因为此时不存在「当前角色」概念，隔离无意义。
 *
 * @param {string} charName - 当前角色（localStorage beilu-last-char）
 * @param {string} hashChatId - URL hash 当前指向的 chatId
 * @returns {Promise<string>} 应加载的 chatId（可能为空，表示无聊天可加载）
 */
async function resolveChatIdForChar(charName, hashChatId) {
  // [N11] stale last-char 单点收口：beilu-last-char 可能指向已不存在的角色（手工删目录/改名/旧版本残留），
  //   下方规则3会为它新建空白聊天并 POST /char 绑定 → 后端 loadPart Module not found → 启动期幽灵 500
  //   （测试轮 2026-06-12 登记的 [chat/addchar] parts/chars/代码 即此链）。本函数是「当前角色」的
  //   单一权威解析点，在此验存在性即收口全部下游消费（sharedState/conversationManager 等读到的都是洗后值）。
  if (charName) {
    try {
      const allChars = await getPartList("chars");
      if (Array.isArray(allChars) && !allChars.includes(charName)) {
        console.warn(`[beilu-chat] beilu-last-char「${charName}」角色已不存在，清除 stale 值`);
        // [R6 身份收口 0713] 走 commitCurrentChar 桥清两态（原 storage.remove 只清持久键，
        //   sharedState._charName 残留已删角色名=两态分叉）。
        window._beiluSetCharName?.("");
        charName = "";
      }
    } catch { /* 角色列表取不到时不阻断启动，沿用原值（后端路由侧另有存在性校验兜底） */ }
  }
  let chats = [];
  try {
    // T6b批7：GET /getchatlist → sendAction shells:chat#getChatList。!ok 门面抛错走 catch（原 res.ok 为假时 chats 保持 []，等价）。
    chats = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
  } catch (e) {
    console.warn("[beilu-chat] resolveChatIdForChar 取列表失败:", e.message);
    // 取不到列表时只能沿用 hash（无法判断归属）
    return hashChatId || "";
  }
  if (!Array.isArray(chats)) chats = [];

  // 全新用户：无当前角色 → 沿用 hash 或回退最近，不强制隔离
  // （bot 对话同样排除——无角色分支不走 chatBelongsToChar，需单独滤，否则最活跃的 bot 线被自动打开）
  if (!charName) {
    const _nonBot = chats.filter(c => !(c.customName || "").startsWith(BOT_CHAT_SYMBOL));
    if (hashChatId && _nonBot.some(c => (c.chatid || c.id) === hashChatId)) return hashChatId;
    if (_nonBot.length) return _nonBot[0]?.chatid || _nonBot[0]?.id || "";
    // [0804 根因修·新用户默认角色] 全新用户（无角色、无任何对话）原实现直接返回空态；
    //   之后虽补过“取角色列表第一张”，但目录枚举顺序不是默认角色契约。权威改为用户配置
    //   defaultParts.chars（由新用户模板登记官方默认卡），旧用户没有该字段才兼容首张卡。
    //   已登记的默认卡若未实际安装必须显式失败，禁止静默改选另一张卡掩盖发布物缺件。
    try {
      // “接口成功返回空列表”和“接口读取失败”是两个状态：前者才代表旧用户没有配置；
      // 后者可能是认证/网络波动，必须保留失败态，不能误选目录第一张并伪装初始化成功。
      const _defaults = await getAllDefaultPartsByType("chars");
      const _configuredDefault = Array.isArray(_defaults)
        ? (_defaults.find(n => typeof n === "string" && n && !n.startsWith("_")) || "")
        : "";
      const _allChars = await getPartList("chars");
      const _availableChars = Array.isArray(_allChars)
        ? _allChars.filter(n => typeof n === "string" && n && !n.startsWith("_"))
        : [];
      if (_configuredDefault && !_availableChars.includes(_configuredDefault)) {
        throw new Error(`用户默认角色“${_configuredDefault}”未安装，请检查新用户模板或发布物同步`);
      }
      const _targetChar = _configuredDefault || _availableChars[0] || "";
      if (_targetChar) {
        const resp = await sendAction({ verb: "ensureModeChats", target: "shells:chat", source: "web", payload: { charname: _targetChar } });
        const _modeChats = resp?.modeChats;
        const _requiredModes = ["chat", "smart", "code", "work"];
        const _missingModes = _requiredModes.filter(mode => typeof _modeChats?.[mode] !== "string" || !_modeChats[mode]);
        if (resp?.success !== true || _missingModes.length) {
          throw new Error(`默认角色四模式对话未完整建立${_missingModes.length ? `（缺少 ${_missingModes.join("/")}）` : ""}`);
        }
        if (typeof window._beiluSetCharName !== "function") {
          throw new Error("当前角色提交入口未就绪");
        }
        // 后端四模式事务 ACK 完整后再提交本地角色，避免“角色已切换、对话创建失败”的假成功。
        window._beiluSetCharName(_targetChar);
        const cid = _modeChats.chat;
        console.log(`[beilu-chat] 新用户自动选中默认角色「${_targetChar}」，chat=${cid}`);
        return cid;
      }
    } catch (e) {
      console.error("[beilu-chat] 新用户默认角色自动选中失败（保留空态）:", e?.message);
      showToast?.("error", `默认角色初始化失败：${e?.message || e}`, 8000);
    }
    return "";
  }

  // 规则1：hash 指向的聊天确属当前角色 → 采纳
  if (hashChatId) {
    const hc = chats.find(c => (c.chatid || c.id) === hashChatId);
    if (chatBelongsToChar(hc, charName)) return hashChatId;
  }

  // 规则2：当前角色自己最近的聊天
  const mine = chats.find(c => chatBelongsToChar(c, charName));
  if (mine) {
    // [0804 根因修] 原实现「找到任一角色对话即 return」把规则3 的四模式补齐永久短路：
    //   半成品角色（历史绑卡循环中断只剩 1 条线）reload 多少次都停在 1 条，切模式 tab 直接
    //   撞死坐标（E 现场实证）。补齐走服务端幂等公用机制：四线健全时零新建（指针+对话实存
    //   即保留现值），只有缺线才补——不改变本函数「打开最近对话」的返回语义。失败不阻断打开。
    try {
      await sendAction({ verb: "ensureModeChats", target: "shells:chat", source: "web", payload: { charname: charName } });
    } catch (e) {
      console.warn(`[beilu-chat] 角色「${charName}」四模式健全性补齐失败（不阻断打开）:`, e?.message);
    }
    return mine.chatid || mine.id;
  }

  // 规则3：当前角色无聊天 → 服务端 ensureModeChatsForChar 建四窗口对话（chat/smart/code/work）
  // [0802 四窗口对话收口] 原实现只建 1 条 → 默认角色卡首次使用时被四窗共用。改走服务端单点
  //   ensureModeChatsForChar（与 create-char/import-char 同一实现体，幂等）。
  try {
    const resp = await sendAction({ verb: "ensureModeChats", target: "shells:chat", source: "web", payload: { charname: charName } });
    const chatModeId = resp?.modeChats?.chat;
    if (chatModeId) {
      console.log(`[beilu-chat] 角色「${charName}」无聊天，已建四窗口对话，chat=${chatModeId}`);
      return chatModeId;
    }
  } catch (e) {
    // 不能回退成单条绑定对话：那会重新引入四个模式共用同一聊天的根因。
    console.warn("[beilu-chat] 建四窗口对话失败，保留空态等待用户重试:", e.message);
    showToast?.("error", `角色「${charName}」的模式对话未建全：${e?.message || e}`, 6000);
  }
  return "";
}

/**
 * 首次页面加载的聊天初始化主流程。每个步骤独立 try/catch，避免单个失败拖垮整个初始化。
 *
 * 链路：index.mjs init() → 本函数 → resolveChatIdForChar()（角色隔离解析）
 *       → getInitialData()×2（首次取数据 + 插件注册后刷新）→ autoRegisterBeiluPlugins()
 *       → loadDisplayRules() → initializeVirtualQueue() → updateSidebar() → initializeMessageInput()
 * 影响：设置 window.location.hash（当前 chatId）；写 localStorage（beilu-last-char / 模式隔离 key）；
 *       初始化 WS 连接；可能创建新聊天（POST /new + /char）；加载 display 正则规则
 * 约束：非幂等（会重复加 chat:reload listener + setupCss），切卡时应走 switchCharacterScope() 而非重调本函数
 *
 * @returns {Promise<void>}
 */
export async function initializeChat() {
  wbTrace("chat", "initializeChat:enter", {});
  console.log("[beilu-chat][DIAG] ========== initializeChat 开始 ==========");
  window._beiluChatInitializing = true; // [0719 F5] 单键（原双写 _initializingChat 已归一）
  try { // finally 保证 init 标志复位，防异常卡死 WS resync
  try {
    setupCss();
  } catch (e) {
    console.warn("[beilu-chat] setupCss 失败（非致命）:", e.message);
  }

  try {
    initializeWebSocket();
  } catch (e) {
    console.warn("[beilu-chat] initializeWebSocket 失败:", e.message);
  }

  window.addEventListener("chat:reload", () => { window.location.reload(); });

  let refreshedData = null;

  const { currentChatId, setCurrentChatId: _setCid } = await import("../transport/endpoints.mjs");
  const _initChar = storage.get(KEYS.BEILU_LAST_CHAR) || "";

  // [MO-ISO] 模式隔离初始化：优先从当前模式的 per-character localStorage key 恢复 chatId。
  let _modeChatIdHint = currentChatId;
  try {
    const { getCurrentMode, getModeChatIdKey } = await import("../../panels/feature/featureControls.mjs");
    const mode = getCurrentMode();
    const modeKey = getModeChatIdKey(mode, _initChar);
    let savedId = modeKey ? storage.get(modeKey) : null;
    // 旧数据迁移：per-char key 为空但旧全局 key 有值 → 迁移
    if (!savedId && _initChar) {
      const { MODE_CHATID_KEYS } = await import("../../panels/feature/featureControls.mjs");
      const oldKey = MODE_CHATID_KEYS[mode];
      const oldId = oldKey ? storage.get(oldKey) : null;
      // T5 收口：原 storage.set(modeKey, oldId) 直写本地绕 markModeActiveChat，服务端双写缺失。
      //   改走收口，迁移即本地+服务端在用指针双写（跨窗口徽标一致）。
      if (oldId) {
        savedId = oldId;
        const { markModeActiveChat } = await import("./conversationManager.mjs");
        markModeActiveChat(mode, _initChar, oldId);
      }
    }
    if (savedId && isValidChatId(savedId)) {
      _modeChatIdHint = savedId;
      console.log(`[beilu-chat][MO-ISO] 初始化：从 ${mode}/${_initChar} 恢复 chatId ${savedId.substring(0, 8)}…`);
    } else if (savedId && !isValidChatId(savedId)) {
      console.warn(`[beilu-chat][MO-ISO] 清除无效 chatId: ${savedId.substring(0, 20)}`);
      if (modeKey) storage.remove(modeKey);
    }
  } catch { /* 非致命 */ }

  // 框架级单一权威：当前角色决定加载哪个聊天。hash 仅当其聊天确属当前角色时才被采纳；
  // 否则解析到该角色自己的聊天（最近的，无则新建空白），任何情况都不跨角色回退。
  let _validatedChatId = await resolveChatIdForChar(_initChar, _modeChatIdHint);
  if (_validatedChatId && _validatedChatId !== currentChatId) {
    window.location.hash = "#" + _validatedChatId;
    _setCid(_validatedChatId);
    // [时序修 0726] WS 必须跟着改写走：本函数 :296 已用**改写前**的 hash chatid 连过 WS，
    //   而 setCurrentChatId 只是赋值、全库无 hashchange→WS 的监听 → 这里不重连的话，
    //   HTTP 走新 chatid、WS 停在旧通道，本窗收不到 stream_update/message_added（界面不动）。
    //   出口与切卡免刷同源（switchCharacterScope:775 同款理由：initializeWebSocket 有 if(ws)return 守卫）。
    try {
      reconnectWebSocket();
    } catch (e) {
      console.warn("[beilu-chat] chatId 改写后 WS 重连失败（实时消息可能不更新）:", e.message);
    }
  } else if (_validatedChatId) {
    _setCid(_validatedChatId);
  }
  console.log("[beilu-chat][DIAG] currentChatId:", _validatedChatId);
  if (_validatedChatId) {
    try {
      console.log(
        "[beilu-chat] 第1次 getInitialData 开始... chatId:",
        _validatedChatId,
      );
      const initialData = await getInitialData();
      console.log("[beilu-chat] 第1次 getInitialData 成功:", {
        charlist: initialData?.charlist?.length,
        pluginlist: initialData?.pluginlist?.length,
        logLength: initialData?.logLength,
        initialLog: initialData?.initialLog?.length,
        worldname: initialData?.worldname,
        personaname: initialData?.personaname,
      });

      // ⭐ beilu 特有: 自动注册 beilu 插件
      const _regCount = await autoRegisterBeiluPlugins(initialData.pluginlist || []);

      if (_regCount > 0) {
        console.log(`[beilu-chat] 注册了 ${_regCount} 个新插件, 重新获取数据...`);
        refreshedData = await getInitialData();
        console.log("[beilu-chat] 第2次 getInitialData 成功:", {
          charlist: refreshedData?.charlist?.length,
          pluginlist: refreshedData?.pluginlist?.length,
          logLength: refreshedData?.logLength,
          initialLog: refreshedData?.initialLog?.length,
        });
      } else {
        refreshedData = initialData;
      }
    } catch (e) {
      // Chat not found（404）→ 尝试回退到最近可用聊天（带防循环保护）
      if (e.response?.status === 404 || e.error === "Chat not found") {
        console.warn(
          "[beilu-chat] 聊天不存在（可能已被删除），尝试回退到最近可用聊天",
        );

        // P0 防循环：用 sessionStorage 计数，同一会话内最多回退 3 次
        // FALLBACK_KEY 已提升到模块级（函数末尾清计数处需共用），此处仅本地上限
        const FALLBACK_MAX = 3;
        const fallbackCount = parseInt(
          sessionStorage.getItem(FALLBACK_KEY) || "0",
          10,
        );

        if (fallbackCount >= FALLBACK_MAX) {
          console.error(
            `[beilu-chat] 回退次数已达上限(${FALLBACK_MAX})，停止回退，进入空态`,
          );
          sessionStorage.removeItem(FALLBACK_KEY);
          window.location.hash = "";
        } else {
          try {
            // 单一权威：当前角色重新解析（其聊天没了就取该角色另一个/新建），不跨角色回退
            const fallbackChatId = await resolveChatIdForChar(_initChar, "");
            if (fallbackChatId && fallbackChatId !== _validatedChatId) {
              console.log(
                `[beilu-chat] 角色「${_initChar}」聊天失效，解析到: ${fallbackChatId}（第${fallbackCount + 1}次）`,
              );
              sessionStorage.setItem(FALLBACK_KEY, String(fallbackCount + 1));
              window.location.hash = "#" + fallbackChatId;
              window.location.reload();
              return; // 页面将重载，不继续初始化
            }
          } catch (fallbackErr) {
            console.warn("[beilu-chat] 回退解析失败:", fallbackErr.message);
          }
          // 回退也失败，清空 hash 进入空态
          sessionStorage.removeItem(FALLBACK_KEY);
          window.location.hash = "";
        }
      } else {
        console.error(
          "[beilu-chat] ★ getInitialData / autoRegister 失败:",
          e.message,
        );
      }
    }
  } else {
    // resolveChatIdForChar 已穷尽（含新建）后仍无 chatId = 系统里一个聊天都没有。
    // [0802 四窗口对话收口] 有当前角色时走 ensureModeChats 建四窗口对话（与规则3 同源）；
    //   无角色时单建空白对话（无角色可绑=无意义建四线）。
    console.log("[beilu-chat] 无任何聊天，创建新空白聊天...");
    try {
      let chatid = null;
      if (_initChar) {
        // 有角色 → 四窗口对话
        try {
          const resp = await sendAction({ verb: "ensureModeChats", target: "shells:chat", source: "web", payload: { charname: _initChar } });
          chatid = resp?.modeChats?.chat || null;
          if (chatid) console.log(`[beilu-chat] 已为角色「${_initChar}」建四窗口对话，chat=${chatid}`);
        } catch (e) {
          // 不能以单建+绑卡兜底，否则当前角色又会得到可被四模式复用的共享对话。
          console.warn("[beilu-chat] 建四窗口对话失败，保留空态等待用户重试:", e.message);
          showToast?.("error", `角色「${_initChar}」的模式对话未建全：${e?.message || e}`, 6000);
        }
      }
      // 无角色时可以单建空白对话；有角色但四线未建全时不得回退成共享线。
      if (!chatid && !_initChar) {
        const newData = await sendAction({ verb: "new", target: "shells:chat", source: "web" });
        chatid = newData.chatid || newData.id;
      }
      if (chatid) {
        window.location.hash = chatid;
        setCurrentChatId(chatid);
        refreshedData = await getInitialData();
        await autoRegisterBeiluPlugins(refreshedData?.pluginlist || []);
        refreshedData = await getInitialData();
      }
    } catch (autoErr) {
      console.warn("[beilu-chat] 创建新聊天失败:", autoErr.message);
    }
  }

  // ⭐ beilu 特有: 预加载 display regex 规则（在插件注册之后，确保 beilu-regex 可用）
  // ⚠️ 必须 await：确保渲染消息前规则已加载完成，否则 full-html 检测会因规则缺失导致空白
  try {
    await loadDisplayRules();
  } catch (err) {
    console.warn("[beilu-chat] display regex 加载失败:", err);
  }
  // ⭐ AIRP 能力谱预加载（同 loadDisplayRules 时机，但非阻塞）：applyBuiltinProcessors 同步读 cachedAirpCaps 渲染 airp DSL。
  //   不 await——缓存 null 时 applyBuiltinProcessors 优雅降级(airp DSL 原样留存下帧渲染)，故不阻塞初始化。谱来源=后端 plugins:beilu-airp 单源。
  loadAirpCaps().catch((err) => console.warn("[beilu-chat] airp 能力谱加载失败(非致命):", err?.message));

  // P0：初始化成功时清除回退计数
  sessionStorage.removeItem(FALLBACK_KEY);

  console.log(
    "[beilu-chat][DIAG] initializeChat: refreshedData 存在?",
    !!refreshedData,
    refreshedData
      ? {
          charlist: refreshedData.charlist,
          pluginlist: refreshedData.pluginlist?.length,
        }
      : "null",
  );
  if (refreshedData) {
    // W55修复: charlist为空时自动绑定角色
    if (!refreshedData.charlist || refreshedData.charlist.length === 0) {
      console.log("[beilu-chat] charlist为空，尝试自动绑定角色...");
      try {
        // T6b批7：GET /getallcacheddetails/chars → sendAction server:chars#listAllCached。!ok 门面抛错走 catch。
        const allChars = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
        {
          // /api/getallcacheddetails/chars 返回 { cachedDetails:{name:..}, uncachedNames:[] }
          // 直接 Object.keys(allChars) 会取到包装键 cachedDetails/uncachedNames，
          // 误把 "cachedDetails" 当角色名 addCharacter → loadPart(chars/cachedDetails) 404→500
          const charNames = [
            ...Object.keys(allChars?.cachedDetails || {}),
            ...(allChars?.uncachedNames || []),
          ];
          if (charNames.length > 0) {
            const lastChar = storage.get(KEYS.BEILU_LAST_CHAR);
            const targetChar = (lastChar && charNames.includes(lastChar)) ? lastChar : charNames[0];
            console.log("[beilu-chat] 自动绑定角色:", targetChar);
            await addCharacter(targetChar);
            refreshedData = await getInitialData();
            console.log("[beilu-chat] 角色绑定后charlist:", refreshedData?.charlist);
          }
        }
      } catch (bindErr) {
        console.warn("[beilu-chat] 自动绑定角色失败:", bindErr.message);
      }
    }

    try {
      await initializeVirtualQueue(refreshedData);
    } catch (e) {
      console.warn(
        "[beilu-chat] initializeVirtualQueue 失败（非致命）:",
        e.message,
      );
    }

    try {
      updateSidebar({
        charlist: refreshedData.charlist,
        pluginlist: refreshedData.pluginlist,
        worldname: refreshedData.worldname,
        personaname: refreshedData.personaname,
        // frequency_data 转发已删（T070 链收口0706：后端零产出恒 undefined，sidebar 读点同批删）
      });
    } catch (e) {
      console.warn("[beilu-chat] updateSidebar 失败（非致命）:", e.message);
    }
  }

  ensureNotifyPermission();

  try {
    setupSidebar();
  } catch (e) {
    console.warn("[beilu-chat] setupSidebar 失败（非致命）:", e.message);
  }

  // ⚠️ 关键：发送按钮绑定 — 必须执行
  try {
    initializeMessageInput();
  } catch (e) {
    console.error(
      "[beilu-chat] initializeMessageInput 失败（严重）:",
      e.message,
    );
  }
  // ── IDE 写操作审批 dock ───────────────────────────────────
  try {
    initializeIdeApprovalDock();
  } catch (e) {
    console.warn("[beilu-chat] initializeIdeApprovalDock 失败（非致命）:", e.message);
  }

  } finally {
    window._beiluChatInitializing = false; // [0719 F5] 单键复位
    try { window.dispatchEvent(new CustomEvent("beilu:chatInitDone")); } catch { /* 通知失败不阻断 */ }
  }
  console.log("[beilu-chat][DIAG] ========== initializeChat 完成 ==========");

  // Add global drag-and-drop support for x-beilu-part
  document.body.addEventListener("dragover", (event) => {
    event.preventDefault(); // Allow drop
  });

  document.body.addEventListener("drop", async (event) => {
    event.preventDefault();
    const partData = event?.dataTransfer?.getData?.("x-beilu-part");
    if (!partData) return;
    const [partType, partName] = partData.split("/");
    if (!partType || !partName)
      return showToastI18n("error", "chat.dragAndDrop.invalidPartData");

    try {
      switch (partType) {
        case "chars":
          await addCharacter(partName);
          showToastI18n("success", "chat.dragAndDrop.charAdded", { partName });
          break;
        case "personas":
          await setPersona(partName);
          showToastI18n("success", "chat.dragAndDrop.personaSet", { partName });
          break;
        case "worlds":
          await setWorld(partName);
          showToastI18n("success", "chat.dragAndDrop.worldSet", { partName });
          break;
        case "plugins":
          await addPlugin(partName);
          showToastI18n("success", "chat.dragAndDrop.pluginAdded", {
            partName,
          });
          break;
        default:
          showToastI18n("warning", "chat.dragAndDrop.unsupportedPartType", {
            partType,
          });
          return;
      }
    } catch (error) {
      console.error(
        `Error handling dropped part (${partType}/${partName}):`,
        error,
      );
      showToastI18n("error", "chat.dragAndDrop.errorAddingPart", {
        partName,
        error: error.message,
      });
    }
  });
}

/**
 * 切卡免刷：运行时切换到另一对话/角色卡，无需整页 location.reload()。
 *
 * 复用首次装配（initializeChat）的「信息·可见」primitives，只做角色切换真正需要的部分：
 *   setCurrentChatId（运行时切 chatId）→ reconnectWebSocket（重连新 chat 的 WS）
 *   → getInitialData×2 + autoRegisterBeiluPlugins（取新对话数据 + 补插件）
 *   → loadDisplayRules + initializeVirtualQueue（重渲染消息）+ updateSidebar（侧栏高亮/角色/世界）
 *   → dispatch "character-switched"（由 index.mjs 监听，重绑世界书 + 表格/记忆懒面板）
 *
 * 不重复 initializeChat 的「美化外壳/全局级」首次项（setupCss / setupSidebar /
 * initializeMessageInput / 各 listener），那些页面生命周期常驻，切卡不卸不重装。
 * 注：initializeChat 非幂等（会重复加 chat:reload listener + setupCss），故切卡走本函数而非重调 initializeChat。
 *
 * @param {string} chatid - 目标对话 ID
 * @returns {Promise<void>}
 */
// 切卡再入代（防嵌套/并发）：原 location.reload() 天然串行；改运行时切换后，快速连点
// 不同对话会并发跑本函数，await getInitialData 期间互相穿插 → 慢的那次 render 覆盖对的那次 = 残留旧 UI。
// 用单调代号：每次进入 ++；await 后若已非最新代号 = 被更新的切卡取代 → 旧次主动放弃 render/dispatch。
let _switchGen = 0;
// 0713 框架修：char-changed 事件的「角色真变」判据——事件语义=角色切换收尾，纯切对话不派发。
//   消费者含 featureControls:904 的模式重同步：原每次切对话都派发 → 监听者带 cid 读线级模式
//   回灌「当前模式」= 对话轴驱动窗口轴（凛倾「切换对话文件变成切换当前模式」的根）。
//   此前 :759 只守卫直调 syncModeFromBackend 是无效补丁——事件绕道（:904 监听）照样重拉。
let _lastDispatchedChar = null;
// [多窗口审计 2026-07-11 A1] opts.mode：调用方已知模式时显式传入（layout [MO-ISO] 恢复=targetMode /
//   switchToChat=入口快照），本函数 [MO-ISO] 写点不再自取 getCurrentMode()——自取值与调用方决策值
//   隔着 await（resolveChatIdForChar/动态 import），tab 联动飞行期两刻可不同 → 同一次切换写两个模式键。
export async function switchCharacterScope(chatid, charNameHint, opts = {}) {
  console.debug("[切卡免刷] switchCharacterScope →", chatid?.substring?.(0, 8));
  if (!chatid) {
    console.warn("[切卡免刷] chatid 为空，跳过");
    return;
  }
  // ══ [0727 凛倾「上面这个依旧是 a，因为 b 已经绑定了，不可以切换」「但是 a 是原生的可以切换」] ══
  //   ＋号开出来的窗口在开的那一刻就绑死了一条对话，在它上面做原生切换 = 把这个窗口的内容顶掉，
  //   用户开这个窗口的意义就没了。a（原生主窗口）不受限，照旧可切。
  // 【why 挡在这里】本函数是一切切换路径的殊途同归点（对话列表 switchToChat / layout 恢复 /
  //   peer_active_chat 跟随 / 跨模式通知跳转 全经此），挡这一处＝所有入口一次覆盖。
  //   逐个去禁用顶栏下拉/列表项那些 UI 是散点自觉，漏一个就是 b 被顶掉。
  //   "当前窗口锁没锁"由 lineManager 判定（窗口表在它手上），经 window 桥读（避免 chat.mjs ↔
  //   lineManager 静态环，同 _beiluGetWinEl 范式）；lineManager 未加载时桥不存在＝无窗口＝不拦。
  const _winLock = (() => { try { return window._beiluCurWinLocked?.(); } catch { return null; } })();
  if (_winLock && _winLock.chatid !== chatid) {
    // [0804 根因修·副窗口报废] 拒绝前先验绑定对话是否仍存在：锁的意义是保护「窗口正在显示的
    //   那条对话不被顶掉」（凛倾 0727 设计，保留）；但绑定对话已被删（外部删文件/其他端删除）时
    //   锁失去保护对象——继续拦截 = 该窗口既打不开又切不走也不能改绑，永久报废（用户实证）。
    //   死绑定 → 摘线（_beiluDropLine 自带「当前窗口先回 home 再摘」的统一提交）+ 放行本次切换。
    //   列表取不到（启动窗口期）时不放行：宁可保持锁语义，不误摘活线。
    let _boundAlive = true;
    try {
      const _chk = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
      if (Array.isArray(_chk)) _boundAlive = _chk.some(c => (c.chatid || c.id) === _winLock.chatid);
    } catch { /* 存活性未知 → 按活处理，保持原锁行为 */ }
    if (_boundAlive) {
      // 被挡住的切换必须可见：否则用户点了没反应、链路上也查不到是谁挡的（静默拒绝＝新的"点了没反应"）
      wbTrace("window", "switchBlocked", { boundTo: _winLock.chatid?.substring?.(0, 8), want: chatid?.substring?.(0, 8) });
      // [T7] 拦截进错误追踪（console.error → backendMonitor pushError 现成管线）：
      //   wbTrace 只进运行时日志，错误追踪面板对被拒操作恒显"无错误"=排查断链（0727 实证）
      console.error(`[拦截] 切换被拒：当前窗口已绑定「${_winLock.label}」(${_winLock.chatid?.substring?.(0, 8)})，目标 ${chatid?.substring?.(0, 8)} 不予切换`);
      showToast?.("warning", `这个窗口已绑定「${_winLock.label}」，不能在这里切换对话或角色卡。请先切回主窗口（活动栏 #1）。`, 5000);
      return;
    }
    wbTrace("window", "switchUnblockedDeadBinding", { boundTo: _winLock.chatid?.substring?.(0, 8), want: chatid?.substring?.(0, 8) });
    console.warn(`[窗口自愈] 绑定对话「${_winLock.label}」(${_winLock.chatid?.substring?.(0, 8)}) 已不存在，释放该窗口并继续切换到 ${chatid?.substring?.(0, 8)}`);
    showToast?.("info", `窗口绑定的对话「${_winLock.label}」已不存在，已释放该窗口并切换到目标对话。`, 5000);
    try { window._beiluDropLine?.(_winLock.chatid); } catch { /* 摘线失败不阻断切换 */ }
  }
  // [系统病型审计 0713·A-NEW-2] gen 取点前移到首个 await 之前：原在 resolve 之后 ++，
  //   慢的旧调用 resolve 回来才领号=领到"最新"号，反把先完成的新调用判旧——代号失去时序语义。
  //   入口领号 + 每段副作用写前查失效：闸从"只护渲染"升级为"护写"（hash/currentChatId/模式指针
  //   都是共享态，旧调用写入=把已切走的对话拽回，与 workPanel 直写同族的错标来源）。
  const _myGen = ++_switchGen;
  const _charName = charNameHint || storage.get(KEYS.BEILU_LAST_CHAR) || "";
  const resolved = await resolveChatIdForChar(_charName, chatid);
  if (_myGen !== _switchGen) {
    wbTrace("chat", "switchScope:stale-preWrite", { gen: _myGen, latest: _switchGen });
    console.debug("[切卡免刷] resolve 期间被更新切卡取代，放弃写入 →", chatid?.substring?.(0, 8));
    return;
  }
  if (!resolved) {
    console.warn("[切卡免刷] chatid 无法解析到有效对话，跳过:", chatid.substring(0, 20));
    return;
  }
  if (resolved !== chatid) {
    console.log(`[切卡免刷] chatid 自动修正: ${chatid.substring(0, 8)}… → ${resolved.substring(0, 8)}…`);
    chatid = resolved;
  }
  wbTrace("chat", "switchScope:enter", { chatid: chatid.substring(0, 8), gen: _myGen });

  setCurrentChatId(chatid);
  window.location.hash = "#" + chatid;

  // [MO-ISO] 模式隔离写入：每次切 chatId 时，同步写入当前模式的 per-character 在用指针。
  //   本处是一切切换路径的殊途同归点（switchToChat/navigateToChat/各面板直调全经此）——
  //   在用指针的本地+服务端双写收口在这一处（markModeActiveChat 单源），调用方不必各自写。
  //   动态 import 避免 chat.mjs ↔ featureControls/conversationManager 静态循环依赖。
  // [F1 管线打标 2026-07-19] _pipelineMode 提升到函数级：本函数尾部的 character-switched /
  //   beilu:char-changed 派发要携带本次切换所属管线（设计_前端管线归位.md F1，additive 零破坏；
  //   消费者 F2 起按 detail.pipeline 自筛，无该字段=按当前激活管线事件处理）。
  let _pipelineMode = opts.mode || null;
  try {
    const { getCurrentMode } = await import("../../panels/feature/featureControls.mjs");
    const mode = opts.mode || getCurrentMode(); // A1: 调用方快照优先，兜底才现取
    _pipelineMode = mode;
    const _isoCharName = charNameHint || storage.get(KEYS.BEILU_LAST_CHAR) || "";
    const { markModeActiveChat } = await import("./conversationManager.mjs");
    // [A-NEW-2] 动态 import 是 await——写指针前再查代号，旧调用不得写模式线指针
    if (_myGen !== _switchGen) return;
    markModeActiveChat(mode, _isoCharName, chatid);
  } catch { /* 非致命：模式 key 写入失败不阻断切卡 */ }

  // 四模式对话只能由服务端 ensureModeChatsForChar 创建和写入 mode_active_chats。
  // 旧实现以 localStorage 缺键为依据后台 new+bind，既绕过服务端幂等锁，也会在多窗口
  // 或缓存被清除时重复建线并制造孤儿对话。前端现在只消费服务端 getChatList 的映射。

  // 2. WS 重连到新 chat（initializeWebSocket 有 if(ws)return 守卫，必须显式 reconnect）
  try {
    reconnectWebSocket();
  } catch (e) {
    console.warn("[切卡免刷] WS 重连失败（非致命）:", e.message);
  }

  // 3. 取新对话数据（插件已在 initializeChat 首次装配时注册，切对话不重复注册——
  //    避免每次切卡触发后端 loadPartBase 部件重加载 + 日志污染）
  let refreshedData = null;
  try {
    refreshedData = await getInitialData();
  } catch (e) {
    // ★ [0727 切换静默失败根因修] 这里绝不是「非致命」——它是切换的**数据来源**。
    //   拿不到数据 → 下面 `if (refreshedData)` 整块跳过 → 消息区不重渲染 →
    //   用户看到的就是「点了对话，什么都没发生」，而全部证据只有这一行 console.warn。
    //   切换失败必须让用户看见（同 R4 0713 把在用指针的静默 warn 改 toast 的判例）。
    console.error("[切卡免刷] getInitialData 失败 → 本次切换未渲染:", e);
    showToast?.("error", `切换对话失败：没能取到该对话的数据（${e?.message || e}），界面仍停留在原对话`, 6000);
    window._reportError?.(`[切卡免刷] getInitialData: ${e?.message || e}`, e?.stack);
  }

  // 再入检查：取数期间若有更新的切卡发起，本次为陈旧，放弃后续 render/dispatch，
  // 避免慢的旧次覆盖新次的正确渲染（currentChatId/hash/WS 已被新次接管）。
  if (_myGen !== _switchGen) {
    wbTrace("chat", "switchScope:stale", { gen: _myGen, latest: _switchGen });
    console.debug("[切卡免刷] 被更新的切卡取代，放弃陈旧渲染 →", chatid?.substring?.(0, 8));
    return;
  }

  // 4. display 规则 + 重渲染消息（信息·可见）+ 侧栏刷新
  if (refreshedData) {
    try {
      await loadDisplayRules();
    } catch (e) {
      console.warn("[切卡免刷] loadDisplayRules 失败（非致命）:", e.message);
    }
    // AIRP 能力谱预加载（非阻塞，同上）——切卡后重渲染消息前令 cachedAirpCaps 就位。
    loadAirpCaps().catch((e) => console.warn("[切卡免刷] airp 能力谱加载失败（非致命）:", e?.message));
    try {
      await initializeVirtualQueue(refreshedData);
    } catch (e) {
      console.warn("[切卡免刷] initializeVirtualQueue 失败（非致命）:", e.message);
    }
    try {
      updateSidebar({
        charlist: refreshedData.charlist,
        pluginlist: refreshedData.pluginlist,
        worldname: refreshedData.worldname,
        personaname: refreshedData.personaname,
        // frequency_data 转发已删（T070 链收口0706：后端零产出恒 undefined，sidebar 读点同批删）
      });
    } catch (e) {
      console.warn("[切卡免刷] updateSidebar 失败（非致命）:", e.message);
    }
  }

  // 再入检查：渲染期间若被更新切卡取代，不再 dispatch（由新次的 character-switched 重绑），避免重复/错绑。
  if (_myGen !== _switchGen) {
    console.debug("[切卡免刷] 渲染后被取代，跳过 character-switched dispatch →", chatid?.substring?.(0, 8));
    return;
  }

  // 5. 通知 index.mjs 重绑「信息·可见」世界书 + 「信息·懒」表格/记忆浏览器
  window.dispatchEvent(
    // [F1 管线打标] pipeline=本次切换所属管线（additive，原消费者只读 chatid 不受影响）
    new CustomEvent("character-switched", { detail: { chatid, pipeline: _pipelineMode } }),
  );

  // 6. ★ 派发 beilu:char-changed —— 更新顶部角色名 + 选择器高亮 + bot名/token/模式同步(featureControls)。
  //    char-changed 的正牌生产者是 index.mjs loadCharInfo(:1652)，但它不在切角色路径上被调用 →
  //    选择器切换后显示名/高亮永远停在旧角色（对话却已切换）。这里在切换路径补一个生产者闭合链路。
  //    payload 与 loadCharInfo 一致带 {charId, charName}，让依赖 charId 的消费者(模式同步)也正确。
  try {
    let _cn = charNameHint || "";
    if (!_cn && refreshedData?.charlist?.length) {
      const _c0 = refreshedData.charlist[0];
      _cn = typeof _c0 === "string" ? _c0 : (_c0?.name || _c0?.charname || _c0?.charid || "");
    }
    // 0713 框架修（凛倾「切换对话文件变成切换当前模式」）：角色真变才派发 char-changed。
    //   模式重同步由 featureControls:904 的 char-changed 监听器统一负责（单一消费链），
    //   原直调 syncModeFromBackend 与监听器重复、且每次切对话都触发=模式随对话漂，一并删除。
    //   AI/后端驱动的模式变更另有专属通道（WS _beiluApplyModeFromWs），不依赖这里。
    //   首次进入（_lastDispatchedChar=null）仍派发一次，顶部角色名/模式基线初始化不回归。
    if (_cn && _cn !== _lastDispatchedChar) {
      _lastDispatchedChar = _cn;
      // [F1 管线打标] chatId/pipeline additive（原消费者只读 charId/charName 不受影响）
      window.dispatchEvent(new CustomEvent("beilu:char-changed", { detail: { charId: _cn, charName: _cn, chatId: chatid, pipeline: _pipelineMode } }));
    }
  } catch (e) {
    console.warn("[切卡免刷] 派发 beilu:char-changed 失败（非致命）:", e.message);
  }

  // 统一广播 chat_id_changed（所有调用路径受益，不再依赖各调用方各自派发）
  window.emitBeiluEvent?.("chat_id_changed", { chatid });
  // 跨端同步属于本切换的成功收尾，不属于 WS 初连/断线重连生命周期；peer 跟随显式禁止回发。
  if (opts.announceActive !== false) {
    void announceActiveChat(chatid).catch((e) => {
      console.warn("[切卡免刷] 跨端当前对话同步失败:", e?.message || e);
      window._reportError?.(`[切卡免刷] switch-active: ${e?.message || e}`, e?.stack);
    });
  }

  // ── 切卡后对齐文件树根 ──
  // 从卡_config读回该角色持久根 → 同步后端窗口根 + 前端显示
  // getCardWorkspaceRoot action在setDataActions.mjs L3889
  try {
    if (_myGen !== _switchGen) return;
    const _cardRootRes = await sendAction({
      verb: "getCardWorkspaceRoot", target: "plugins:beilu-memory", source: "web",
      payload: { charName: _charName }
    });
    const _cardRoot = _cardRootRes?.workspace_root;
    if (_cardRoot) {
      const { setFileExplorerRoot } = await import("../../panels/code/fileExplorer.mjs");
      await setFileExplorerRoot(_cardRoot);
    }
  } catch (err) {
    // 切卡本身可继续，但角色保存过的根无效/无法落盘时必须让用户知道；否则该坏根会在
    // 下次切卡、IDE 反向同步或未绑组 worker 中重复传导。
    const message = err?.message || String(err);
    console.warn("[切卡免刷] 角色工作区根未能应用:", message);
    showToast(`该角色的工作区无法恢复：${message}。请在文件面板重新选择目录。`, "warning");
  }

  console.debug("[切卡免刷] switchCharacterScope 完成 →", chatid?.substring?.(0, 8));
}

/**
 * 停止生成。
 * @param {string} id - 消息 ID。
 */
export function stopGeneration(id) {
  console.log("Stop generation for", id);
  sendWebsocketMessage({
    type: "stop_generation",
    payload: { messageId: id },
  });
  // UI change is now optimistic, backend will confirm by replacing the message or just stopping the stream.
  const element = document.getElementById(id);
  if (element) {
    const stopButton = element.querySelector(".stop-generating-button");
    if (stopButton) stopButton.remove();
  }
}

// ═══════════════════════════════════════════════════════════
// IDE 写操作审批 dock（对话区底部 dock）
// ═══════════════════════════════════════════════════════════

// T6b批7：MEMORY_API_SET URL 常量收口进 sendAction 门面（beilu-memory#* 通配路由）。

let _approvalTimer = null;
// ★ T2 S4：已弹过 attention 的审批 opId，防同一审批重复弹窗（轮询/推送多次触发）
let _notifiedApprovalIds = new Set();

async function _fetchIdeApprovals() {
  try {
    // ★ 多窗口会话隔离：带本会话 chatid，dock 只显示本会话待审 op（与 approveAll/rejectAll 收口一致）。
    // T6b批7：setdata {_action:getIdeApprovals} → sendAction beilu-memory#*（通配组装）。!ok 门面抛错走 catch → null（等价原 !resp.ok return null）。
    return await sendAction({ verb: "getIdeApprovals", target: "plugins:beilu-memory", source: "web", payload: { chatid: currentChatId } });
  } catch (e) { console.warn("[chat] IDE 审批轮询失败:", e?.message || e); return null; /* T021 留痕：轮询不弹防风暴 */ }
}

async function _sendApprovalAction(action, opId) {
  try {
    // T6b批7：setdata {_action:action} → sendAction beilu-memory#*（verb=真动作 action，通配组装）。!ok 门面抛错走 catch → null（等价原 resp.ok?json:null）。
    const payload = { chatid: currentChatId };
    if (opId) payload.opId = opId;
    return await sendAction({ verb: action, target: "plugins:beilu-memory", source: "web", payload });
  } catch { return null; }
}

function _renderApprovalDock(pending) {
  // 同步到全局供 smart 右栏任务监控使用 (设计8.6)
  window._beiluPendingApprovals = pending || [];
  window.dispatchEvent(new CustomEvent("beilu:smart-task-update"));

  const dock = document.getElementById("ide-approval-dock");
  const countEl = document.getElementById("ide-approval-count");
  const listEl = document.getElementById("ide-approval-list");
  if (!dock || !countEl || !listEl) return;

  if (!pending || pending.length === 0) {
    dock.classList.add("hidden");
    if (_approvalTimer) { clearInterval(_approvalTimer); _approvalTimer = null; }
    _notifiedApprovalIds = new Set(); // 队列清空 → 重置，下批新审批可再弹
    return;
  }

  dock.classList.remove("hidden");
  countEl.textContent = String(pending.length);

  // ★ T2 S4：新到达的审批弹 A1 attention 弹窗（复用 crossModeNotification）。
  // 验收#4：审批以 attention 弹窗呈现，用户不会漏看（尤其 S1 危险操作即使完全信任也强制入队）。
  const _newOps = pending.filter((op) => op?.id && !_notifiedApprovalIds.has(op.id));
  if (_newOps.length > 0) {
    const _danger = _newOps.some((op) => op?._forceApproval);
    const _first = _newOps[0];
    const _what = _first?.params?.command || _first?.params?.path || _first?.tool || "写操作";
    // [T6双键批] 兜底 "code" 刻意：本处是 IDE 审批 dock 渲染（ide-approval-dock，写操作审批只在
    //   code/work 模式出现）。_approvalMode 供 crossModeNotification 的 fromMode（通知显"来自代码模式"）
    //   与 targetTab（"去查看"跳 code tab）。审批必发生于 code/work 场景，localStorage 极端读不到值时
    //   兜底 code 比全链通用兜底 "chat" 语义正确——chat 模式无审批 dock，兜 chat 会显错标签+跳无审批的
    //   tab。故此处不统一为 "chat"，与 featureControls:586/websocket:1146/preset:618 的 chat 兜底分叉是刻意。
    const _approvalMode = storage.get(KEYS.BEILU_ACTIVE_MODE) || "code";
    showCrossModeNotification({
      fromMode: _approvalMode,
      type: "approval",
      title: "待审批",
      message: _danger
        ? `⚠ 危险操作待审批：${_what}${_newOps.length > 1 ? ` 等 ${_newOps.length} 项` : ""}`
        : `${_newOps.length} 项写操作待审批：${_what}`,
      targetTab: _approvalMode,
    });
    for (const op of _newOps) _notifiedApprovalIds.add(op.id);
  }

  const _escHtml = escapeHtml;
  // ★ F6 内联审批卡（KILO approval-box 形态）：目标对象文件显后端解析的绝对路径(absPath)、工作区外强提示不截断；
  //   N46 三选一 [允许一次][拒绝][总是允许]（per-op）+ dock 头部已有 [全部批准=全部允许][全部拒绝=全部跳过]（队列级）。
  listEl.innerHTML = pending.map((op) => {
    const _isCmd = op.tool === "run_command";
    const _target = op.absPath || op.params?.path || op.params?.command || "";
    const detail = _escHtml(_target);
    const tool = _escHtml(op.tool || "?");
    const opId = _escHtml(op.id);
    const _outside = op.outsideWorkspace
      ? `<span class="text-warning font-bold text-xs mr-1" title="目标在工作区外，请谨慎">⚠ 区外</span>`
      : "";
    const _force = op._forceApproval
      ? `<span class="text-error font-bold text-xs mr-1" title="危险/不可逆操作，强制审批"><i data-ic="zap"></i> 危险</span>`
      : "";
    // 区外路径不截断（break-all 全显）；区内/命令保持单行截断
    const _detailCls = op.outsideWorkspace ? "flex-1 font-mono opacity-70 break-all" : "flex-1 truncate font-mono opacity-60";
    return `<div class="flex flex-col gap-0.5 py-1 border-b border-base-300/40 ${op.outsideWorkspace ? "border-warning/50" : ""}" data-op-id="${opId}">
      <div class="flex items-center gap-1">
        <span class="badge badge-xs font-mono">${tool}</span>${_force}${_outside}
      </div>
      <div class="${_detailCls} ${_isCmd ? "text-warning" : ""}" title="${detail}">${detail}</div>
      <div class="flex items-center gap-1">
        <button class="btn btn-xs btn-ghost text-success ide-approve-one" data-id="${opId}">✓ 允许一次</button>
        <button class="btn btn-xs btn-ghost text-error ide-reject-one" data-id="${opId}">✕ 拒绝</button>
        <button class="btn btn-xs btn-ghost opacity-70 ide-skiprule-one" data-id="${opId}" title="本条执行，且以后这类操作（同类型+路径前缀）不再询问"><i data-ic="star"></i> 总是允许</button>
      </div>
    </div>`;
  }).join("");

  // 绑定单个按钮
  listEl.querySelectorAll(".ide-approve-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await _sendApprovalAction("approveIdeOp", btn.dataset.id);
      _pollApprovals();
    });
  });
  listEl.querySelectorAll(".ide-reject-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await _sendApprovalAction("rejectIdeOp", btn.dataset.id);
      _pollApprovals();
    });
  });
  // ★ N46「总是允许」三选一语义（OpenClaw 式）：派生规则落 settings + 本条照常执行。
  //   旧「此类不再问」=落规则+本条拒绝（rejectIdeOp），与"总是允许"直觉相反，已对齐为 approveIdeOp。
  listEl.querySelectorAll(".ide-skiprule-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await _sendApprovalAction("addApprovalSkipRule", btn.dataset.id);
      await _sendApprovalAction("approveIdeOp", btn.dataset.id);
      _pollApprovals();
    });
  });
}

async function _pollApprovals() {
  const data = await _fetchIdeApprovals();
  if (data) _renderApprovalDock(data.pendingApprovals || []);
}

function initializeIdeApprovalDock() {
  // 幂等守卫：防止多次调用重复注册监听器
  if (initializeIdeApprovalDock._initialized) return;
  initializeIdeApprovalDock._initialized = true;

  // 绑定全部批准/拒绝按钮
  document.getElementById("ide-approve-all")?.addEventListener("click", async () => {
    await _sendApprovalAction("approveAllIdeOps");
    _pollApprovals();
  });
  document.getElementById("ide-reject-all")?.addEventListener("click", async () => {
    await _sendApprovalAction("rejectAllIdeOps");
    _pollApprovals();
  });
  // AIRP-T16: 浮窗关闭按钮(临时隐藏,下次有新审批时 _pollApprovals 会重新 remove('hidden'))
  document.getElementById("ide-approval-close")?.addEventListener("click", () => {
    document.getElementById("ide-approval-dock")?.classList.add("hidden");
  });

  // 监听 AI 生成完成事件，触发审批检查
  // [0807 转接二期#6] 手拼 bus._listeners push → eventBusCore.onEventBus 单源（订阅形状收口）
  onEventBus("generation_ended", () => {
    _pollApprovals();
    // 启动轮询（3秒间隔，有待审批时持续）
    if (!_approvalTimer) {
      _approvalTimer = setInterval(_pollApprovals, 3000);
    }
  });

  // 初始检查一次
  _pollApprovals();

  // 监听 WS 广播的审批列表更新
  window.addEventListener("beilu:pendingApprovals", (e) => {
    const d = e.detail;
    // 后端 pending_approvals 广播只带 {count}（非完整列表）→ 直接渲染会让 _renderApprovalDock
    // 拿到对象当数组 .map 崩溃 + 污染 window._beiluPendingApprovals。仅当 detail 是真数组才直接渲染，
    // 否则（count-only / 推送漏帧）拉取权威列表，顺带保证 S4 attention 弹窗拿到 op 详情。
    if (Array.isArray(d?.pendingApprovals)) _renderApprovalDock(d.pendingApprovals);
    else if (Array.isArray(d)) _renderApprovalDock(d);
    else _pollApprovals();
  });
}
