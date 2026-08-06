/**
 * [conversationManager.mjs] — 侧边栏对话列表管理器。只管对话列表的获取/渲染/切换/重命名/删除，
 *   不管消息渲染（那是 messageList 的事），不管 WS 通信（那是 websocket.mjs 的事）。
 *
 * 职责：
 *   1. fetchChatList()：GET /getchatlist，拉取当前用户所有对话
 *   2. renderChatList()：把对话列表渲染进侧边栏 #conversation-list，高亮当前对话，按模式/角色过滤
 *   3. createNewChat()：POST /new，新建对话，写 localStorage，触发列表刷新
 *   4. switchToChat(chatId)：切换到指定对话——更新 hash + 调 switchCharacterScope
 *   5. 右键上下文菜单：重命名（renameChat）/ 删除（deleteChat）/ 收藏置顶（starring/pinning）
 *   6. 对话名称解析：用户自定义标签 > 第一条用户消息 > chatId 截取
 *   7. 模式标签（E1）：每条对话显示所属模式 icon（聊天/编程/工作）
 *   8. 跨客户端同步：监听 beilu:conv-meta-changed / chat-list-changed，防抖 300ms 重渲染
 *   9. _showAllModes 开关：默认只显示当前模式对话，用户可切换显示全部
 *
 * 链路：sidebar.mjs setupSidebar → setupConversationManager() → 注册列表渲染 + 按钮事件
 *       WS chat-list-changed 事件 → renderChatList()（300ms 防抖）
 *       用户点对话项 → switchToChat(chatId) → chat.mjs switchCharacterScope → 重初始化聊天
 *       用户右键 → 上下文菜单 → 重命名/删除/收藏
 * 影响：写 localStorage（CONV_META_KEY：对话元数据，含 label/starred/pinned/mode）；
 *       dispatch beilu:conv-meta-changed CustomEvent；操作 window.location.hash；
 *       调 apiFetch（列表/新建/删除/重命名）
 * 相交：← sidebar.mjs（初始化入口）← websocket.mjs（chat-list-changed 事件驱动刷新）
 *       → chat.mjs（switchCharacterScope: 切对话触发运行时切换）
 *       → api-client.mjs（apiFetch / renameChat）
 *       → featureControls.mjs（getCurrentMode / MODE_CHATID_KEYS: 模式-chatId 映射）
 *       → storage.mjs（KEYS.BEILU_CONVERSATION_META）
 *
 * 点击后发生什么：
 *   侧边栏对话项点击 → switchToChat(chatId) → hash 变 → switchCharacterScope → 重连 WS + 重载数据
 *   「新建对话」按钮点击 → createNewChat() → POST /new → 切换到新对话 → renderChatList 刷新
 *   右键对话项 → 弹上下文菜单 → 选「重命名」→ 弹输入框 → renameChat() → 刷新列表
 *   右键对话项 → 选「删除」→ beiluConfirm 确认 → deleteChat() → 切回其它对话 → 刷新列表
 *   右键对话项 → 选「收藏」→ 写 convMeta.starred → 保存 → 刷新（置顶显示）
 */

import { charList, switchCharacterScope } from "./chat.mjs";
import { showToast } from "../../../../../../scripts/toast.mjs";
import { getCurrentMode, MODE_CHATID_KEYS, getModeChatIdKey } from "../../panels/feature/featureControls.mjs";
import { escapeHtml, positionContextMenu, formatRelativeTime, bindClickOutsideClose, mountInlineEdit, BOT_CHAT_SYMBOL } from "../state/utils.mjs"; // [合并批 0714] 相对时间/点外关闭/内联改名编排收口 utils 单源;0715 bot 符号单源
import { wbTrace } from "../widgets/whitebox.mjs";
import { apiFetch, renameChat, setChatFlags, setChatMode, setModeActiveChat } from "../transport/api-client.mjs"; // renameChat=对话改名单源(查重C-P0-A)；setChatMode=模式徽标服务端持久单源(对齐N39)；setModeActiveChat=在用指针服务端持久；apiFetch 仅留给 exportConversation 的 blob 下载（T6b批7：blob 有据不收，其余出向已切 sendAction）
import { sendAction } from "../transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），shells:chat getchatlist/new/groups/delete/log-length/branch/search/char 收口
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { beiluConfirm } from "../widgets/beiluDialog.mjs";

const CONV_META_KEY = KEYS.BEILU_CONVERSATION_META;

// 跨客户端 chat-list-changed 重渲染防抖句柄（300ms 合并高频）
let _chatListChangedTimer = null;

/** [P1-2 0805] 列表重渲染防抖单源：hashchange / beilu:mode-switched / beilu:conv-meta-changed /
 *  beilu:chat-list-changed 四个高频事件源共用一个 300ms 防抖句柄，合并连发事件为一次重渲染
 *  （用户发消息 → hash 变化 + chat-list-changed 常同帧到达，原来各自直调 = 一次交互多次全量渲染）。 */
function _debouncedRenderConvList() {
  if (_chatListChangedTimer) clearTimeout(_chatListChangedTimer);
  _chatListChangedTimer = setTimeout(() => {
    _chatListChangedTimer = null;
    renderConversationList();
  }, 300);
}

/** 模式过滤开关：false = 只显示当前模式的对话，true = 显示全部。
 *  持久化（反方审查 0712）：误标对话的找回入口就是「全部」开关，不持久=刷新即丢、找回动线断。 */
let _showAllModes = storage.get(KEYS.BEILU_CONV_SHOW_ALL_MODES) === "true";

/** E1: 模式显示配置（smart 随 0706 独立模式值同步——原漏键=smart 对话无徽标+过滤/空态文案显英文 raw）
 *  export：smart 最近对话列表复用同一套模式图标（单源，勿在各面板手抄映射）。
 *  [D2 迁移 0713] 本体迁 modeTabMap.mjs（模式概念权威表，纯常量层），此处 re-export 保消费者路径。 */
import { MODE_BADGE } from "../state/modeTabMap.mjs";
export { MODE_BADGE };

/**
 * 「XX窗口在用」标签 HTML 单源（含无标记时空串）。四列表共用，勿各自拼字符串。
 * 0713 补丁删除（凛倾「为什么只有一个源的东西要去看多个内容」）：唯一权威=服务端 usedByModes
 *   （getChatList 注入，mode_active_chats 反查）。原「服务端 ∪ 本地 getModeInUseMap」合并让
 *   本地 stale 指针永远能叠进权威结果=每条对话多挂徽标；且列表数据本身就来自服务端
 *   getChatList——列表能渲染=服务端已应答=字段必在，「本地兜底」零真实场景，纯防御多源。
 *   getModeInUseMap 收集器已随之整体删除（参照：补丁形式识别_多源合并与反向回灌.md P1/P6）。
 * 一条对话可被多个模式窗口同时占用 → 逐模式各出一个标签。
 * @param {string[]} [usedByModes] 服务端 chat.usedByModes
 * @returns {string}
 */
export function buildInUseLabel(usedByModes) {
  const modes = new Set(Array.isArray(usedByModes) ? usedByModes : []);
  let html = "";
  for (const mode of modes) {
    const label = MODE_BADGE[mode]?.label || mode;
    // 文案短版「聊天·在用」（反方审查 0712：完整「聊天窗口在用」多标签时挤爆行宽违反不拥挤原则）；
    // 完整语义进 title（hover 可读全文）。
    html += `<span class="conv-using-badge" title="${label}窗口当前正在使用此对话文件">${label}·在用</span>`;
  }
  return html;
}

/**
 * 模式线在用指针写点单源：本地 localStorage（getModeChatIdKey，立即生效）+ 服务端
 * mode_active_chats（跨窗口权威，fire-and-forget）。
 * 【why】原各切换/新建路径只 storage.set 本地——单浏览器视角，「XX窗口在用」跨窗口残缺。
 * 主收口调用点=chat.mjs switchCharacterScope MO-ISO（一切切换殊途同归处）+ classifyNewChat + MO-INIT。
 * @param {string} mode
 * @param {string} charName
 * @param {string} chatid
 */
export function markModeActiveChat(mode, charName, chatid) {
  // R1 0713：服务端写不再依赖前端 charName（服务端按对话 primaryCharName 权威定键）。
  //   原「charName 空整体跳过+服务端拒收」双闸全静默 → 指针冻结在旧值（「在用」徽标硬编码案根因）：
  //   显示链（charList[0]）有角色而本参数源（BEILU_LAST_CHAR 仅 charsel 选卡时写）常空。
  //   本地缓存键仍按「模式×角色」分线需要 charName：空则只跳本地写（缺失由 _syncModePointerCache
  //   从服务端 usedByModes×primaryCharName 投影回填自愈），服务端权威写无条件发。
  //   charName 空产 `mode:` 无主键的旧病（getModeChatIdKey 兜旧全局键）随本地写跳过一并挡住。
  if (charName) {
    const modeKey = getModeChatIdKey(mode, charName);
    if (modeKey && storage.get(modeKey) !== chatid) {
      storage.set(modeKey, chatid);
      // 自动刷新闭环：本地指针变化即广播（与 _syncModePointerCache 同事件），横幅等消费者重查。
      window.dispatchEvent(new CustomEvent("beilu:mode-pointer-changed"));
    }
  } else {
    console.warn(`[conversationManager] markModeActiveChat：charName 空，本地缓存键跳过（服务端照常写，mode=${mode}, chatid=${chatid?.substring?.(0, 8)}）`);
  }
  setModeActiveChat(chatid, mode).then((r) => {
    // R4 0713：失败上诊断面（toast），不再只 console.warn——静默失败正是徽标冻结数日无人知的原因。
    if (!r.ok) {
      console.warn("[conversationManager] 在用指针服务端持久失败:", r.message);
      showToast?.("error", `「在用」指针保存失败: ${r.message}`);
    }
  });
  // [窗口在用即绑生成模式·凛倾定案] 生成权威 active_modes_map(chatid→mode)= 当前使用此文件的窗口模式。
  //   与在用指针(mode_active_chats)同刻写：窗口一用某文件，就把它的生成模式绑成本窗口模式（覆盖，非只填）。
  //   why：① 生成脱离 UI（后台唤醒/调度器/worker/bot 壳）只拿 chatId，模式必须缓存在对话上；
  //        ② 用哪个模式由「当前使用它的窗口」决定，非文件出生窗口——AIRP 打开 code 窗口建的文件即应以 chat
  //           生成，故随使用覆盖。原缺此写=建对话/切对话后 active_modes_map 空 → getActiveMode 回退 char 级
  //           chat（smart/work 窗口对话生效 chat 的实证 bug）。char 由后端按 chatid 元数据归位（不落 _global）。
  sendAction({ verb: "bindChatMode", target: "plugins:beilu-memory", source: "web", payload: { mode, chat_id: chatid } })
    .catch((e) => console.warn("[conversationManager] active_modes_map 绑定失败(不阻塞):", e?.message));
}

/**
 * 「另一窗口在用」角标 HTML 单源。[D4 收口 0713] 原四列表各自内联同一判定+HTML
 * （tooltip 文案已分叉两套「另一浏览器窗口/另一窗口」），与 buildInUseLabel 同族收口。
 * 判定：后端 inUseCount=该对话全部 WS 连接数（chatUiSockets 权威），减本窗口自持连接
 * （_wsPool 切窗口不断旧连接，不减会把自己开过的全误报为"别的窗口在用"）。
 * @param {string} chatid
 * @param {number} inUseCount - getchatlist 注入的连接数
 * @returns {string}
 */
export function buildOtherWindowBadge(chatid, inUseCount) {
  const _selfHolds = window._beiluHasOpenChatWs?.(chatid) ? 1 : 0;
  return (inUseCount || 0) > _selfHolds
    ? '<span class="conv-inuse-badge" title="另一浏览器窗口正在使用此对话">●</span>'
    : "";
}

/**
 * 模式徽章 HTML 单源（凛倾 0712「用户知道这个图标代表什么吗」：裸图标不自解释，
 * 徽章=图标+模式文字；无分类不再降级显示 💬 之类的不明裸图标，返回空串）。
 * 四列表共用，勿各自手拼 badge HTML。
 * @param {string|null|undefined} mode
 * @returns {string}
 */
export function buildModeBadge(mode) {
  const cfg = mode ? MODE_BADGE[mode] : null;
  if (!cfg) return "";
  return `<span class="conv-mode-badge" title="此对话属于${cfg.label}窗口">${cfg.icon}${cfg.label}</span>`;
}

/**
 * 获取对话元数据（模式、标签、收藏等）
 * @returns {Object} { [chatid]: { label, lastActive, starred, pinned, mode } }
 */
// export（T5 收口接线）：chat.mjs MO-INIT 懒建对话打 mode 标记原直写 CONV_META_KEY 绕本收口，
//   现改走 loadConvMeta/saveConvMeta（含 _selfMetaWrite 守卫 + conv-meta-changed 广播），单源写点。
/**
 * 对话列表排序比较器单源：置顶 > 收藏 > 最近活跃（0715 散点合并）。
 * 【why】原本模块/workPanel/subModePanel 各持一份同构手抄比较器（三份质量不齐：subModePanel
 *   版漏判 starred=收藏排序在弹窗列表静默失效）。收单源后排序语义只此一份。
 * starred/pinned 读服务端注入值（chat_flags 权威）；时间用 convMeta.lastActive（本地活跃防抖值）
 *   兜底 lastMessageTime——与原三份实现同语义。
 * @param {object} a - getChatList 摘要条目
 * @param {object} b - getChatList 摘要条目
 * @param {object} [meta] - loadConvMeta() 结果（lastActive 来源；省略=纯按 lastMessageTime）
 * @returns {number}
 */
export function compareConvOrder(a, b, meta) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
  const am = meta?.[a.chatid || a.id] || {};
  const bm = meta?.[b.chatid || b.id] || {};
  const at = am.lastActive || new Date(a.lastMessageTime || 0).getTime();
  const bt = bm.lastActive || new Date(b.lastMessageTime || 0).getTime();
  return bt - at;
}

export function loadConvMeta() {
  try {
    return JSON.parse(storage.get(CONV_META_KEY) || "{}");
  } catch {
    return {};
  }
}

// 防递归标记：saveConvMeta 广播 conv-meta-changed 后，本模块的监听器用此跳过自触发重渲染
let _selfMetaWrite = false;

export function saveConvMeta(meta) {
  try {
    _selfMetaWrite = true;
    storage.set(CONV_META_KEY, JSON.stringify(meta));
    // 根病3 修复：广播 meta 变化，让 workPanel / layout-smart / index-chatmgmt 同步
    window.dispatchEvent(new CustomEvent("beilu:conv-meta-changed"));
  } catch {
    /* ignore */
  } finally {
    _selfMetaWrite = false;
  }
}

/**
 * 获取当前chatid。
 * [2026-07-13 T047 同族漏网收口] 原裸读 hash 无 _CHATID_RE 校验——比较类消费方（列表高亮/meta 命中）
 * 行为等价（垃圾 hash 匹配不上真 id），但 smart 删除按钮把它当 cid 送后端 deleteConversation=
 * 与 gitPanel C1 同类旁路。委托守卫单源（window 桥，防 import 环范式同 panels）。
 */
export function getCurrentChatId() {
  return window._beiluGetChatId?.() || "";
}

/**
 * 从后端获取对话列表
 * API: GET /api/parts/shells:chat/getchatlist
 */
export async function fetchChatList() {
  try {
    // T6b批7：GET /getchatlist → sendAction shells:chat#getChatList。!ok 门面抛错走 catch → []（等价原 !res.ok return []）。
    const list = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" }); // 返回数组
    _syncModePointerCache(list);
    return list;
  } catch (err) {
    console.warn("[conversationManager] fetch chat list failed:", err);
    window._reportError?.(`[conversationManager] ${err.message}`, err.stack);
    return [];
  }
}

/**
 * 模式线指针读时校准：服务端 mode_active_chats（经 usedByModes×primaryCharName 投影）→ 本地
 * per-char 键，单向覆盖。
 * 【why】凛倾 0713「显示是硬编码，不是去检测窗口使用的文件」根因层：同一事实两套存储且读点
 *   分叉——恢复链/多模式横幅读 localStorage 键，「XX窗口在用」徽标读服务端 map。写点双写但
 *   fire-and-forget 失败、历史直写（websocket._ensureModeChatId 已收口）、事故残留都让两源漂移，
 *   漂移后窗口实际打开的文件（本地键驱动）≠徽标声称在用的文件（服务端）且永不自愈。
 *   此处在列表数据唯一入口把本地键对齐服务端权威（0712 权威上移决策），漂移生命周期≤一次拉取，
 *   恢复链/横幅/徽标回到同一事实。反向（本地有服务端无）不清除：本地孤值会被 [MO-ISO] 下次
 *   使用推回服务端，自然收敛。
 * 投影安全前提：服务端键的 char ≡ 对话 primaryCharName——R1 0713 起由服务端构造性保证
 *   （setModeActiveChat 反查 meta.primaryCharName 定键，前端不再报送 char），不再依赖写点纪律。
 * R1 后本地键=纯缓存、服务端=唯一真源，本函数的单向覆盖即合法收敛方向（原「服务端写失败态
 *   下 stale 回灌压掉本地新值」的反向自愈病随服务端写不再依赖 charName 而消解）。
 */
function _syncModePointerCache(list) {
  if (!Array.isArray(list)) return;
  try {
    let _changed = 0;
    for (const c of list) {
      const _char = c?.primaryCharName;
      if (!_char || !c?.chatid || !Array.isArray(c.usedByModes)) continue;
      for (const _m of c.usedByModes) {
        const _key = getModeChatIdKey(_m, _char);
        if (_key && storage.get(_key) !== c.chatid) {
          console.log(`[conversationManager] 指针校准: ${_m}/${_char} → ${c.chatid.substring(0, 8)}…（本地键对齐服务端）`);
          storage.set(_key, c.chatid);
          _changed++;
        }
      }
    }
    // 自动刷新闭环（凛倾 0713「没有做自动刷新,导致时序问题」）：本地键被校准改动=依赖它的
    // 显示（多模式横幅/恢复预期）已过时，广播指针变化事件驱动消费者重查。只在实际改动时发
    // （幂等收敛：重查→再拉列表→校准零改动→不再发，无循环）。禁复用 chat-list-changed：
    // 那是「列表数据过时」事件且正是本函数的触发上游，复用=自触发死循环。
    if (_changed > 0) window.dispatchEvent(new CustomEvent("beilu:mode-pointer-changed"));
  } catch (e) {
    console.warn("[conversationManager] 指针读时校准失败(不阻塞列表):", e?.message);
  }
}

/**
 * 新建对话
 * API: POST /api/parts/shells:chat/new
 */
export async function createNewChat() {
  try {
    // T6b批7：POST /new → sendAction shells:chat#new。!ok 门面抛错走 catch（等价原 `if(!res.ok) throw`）。
    const data = await sendAction({ verb: "new", target: "shells:chat", source: "web" });
    return data.chatid;
  } catch (err) {
    console.error("[conversationManager] create chat failed:", err);
    window._reportError?.(`[conversationManager] ${err.message}`, err.stack);
    showToast?.("error", `新建对话失败: ${err.message}`);
    return null;
  }
}

/**
 * 切换到指定对话
 * E1: 切换时同步更新当前模式的 chatId localStorage key
 */
export async function switchToChat(chatid, charName) {
  if (!chatid) return;
  const currentId = getCurrentChatId();
  if (chatid === currentId) return; // 已经是当前对话，不重复切换
  wbTrace("conv", "switchToChat", { chatid: chatid.substring(0, 8) });

  // E1: 同步当前模式的 per-char chatId key（本地+服务端在用指针，markModeActiveChat 单源）
  //   0714 时序案：指针写必须先于 saveConvMeta——saveConvMeta 同步派发 conv-meta-changed，
  //   workPanel 等监听者立刻重拉 getChatList；写点若后置，读恒定先发=「在用」徽标停上一拍
  //   的确定性放大器（纠偏靠 chat-list-changed 广播，此处调序把首渲染的胜率也拉回来）。
  const currentMode = getCurrentMode();
  // [跨卡切换 0727] 线可以属于**另一张角色卡**（＋号拉线就是跨卡动作），故本函数接受目标卡名。
  // 【why 必须先落卡】不落卡会同时踩两个坑（0727 拉线自毁实证）：
  //   ① 在用指针本地键用 `模式:当前卡`，而服务端写点按该对话真实 primaryCharName 定键
  //      （endpoints.mjs:2148-2152 R1 0713）→ 前后端写进两个不同的键 = 读写不同源；
  //   ② 下游 switchCharacterScope 用 BEILU_LAST_CHAR 去 resolveChatIdForChar 校验，
  //      规则1「hash 指向的聊天须确属当前角色」不成立 → 规则2 静默拽回当前卡最近的对话
  //      （chat.mjs:240-248）→ 落点≠目标，界面上表现为"点了 A 却打开 B"。
  // commitCurrentChar（sharedState 单源，经 window 桥防循环 import）一次写齐运行时态+持久键。
  const _charName = charName || storage.get(KEYS.BEILU_LAST_CHAR) || "";
  if (charName && charName !== (storage.get(KEYS.BEILU_LAST_CHAR) || "")) {
    try { window._beiluSetCharName?.(charName); } catch (e) { console.warn("[conversationManager] 跨卡落卡失败:", e?.message); }
  }
  markModeActiveChat(currentMode, _charName, chatid);

  // 更新 lastActive
  const meta = loadConvMeta();
  if (!meta[chatid]) meta[chatid] = {};
  meta[chatid].lastActive = Date.now();
  saveConvMeta(meta);

  // 切卡免刷：运行时切换，不再整页 reload（setCurrentChatId + WS 重连 + 重渲染 + 重绑）
  // [多窗口审计 2026-07-11 A1] 传入口快照 currentMode：原 switchCharacterScope 内部再取 getCurrentMode
  //   与上方 :148 隔着 await——tab 联动飞行期两刻不同值=同一次切换写两个模式键
  await switchCharacterScope(chatid, charName || undefined, { mode: currentMode });

  // N49 CHAT_CHANGED producer：对话切换收口广播给 iframe 美化脚本（chat_id_changed）。
  window.emitBeiluEvent?.("chat_id_changed", { chatid });
}

/**
 * 获取当前角色卡名称
 * 优先从当前聊天的列表数据中取，备选从 charList 取
 * @param {Array} allChats - 后端返回的完整对话列表
 * @returns {string} 当前角色卡名称
 */
function getCurrentCharName(allChats) {
  // 权威源：sharedState 的 charName（角色卡选择时 set，独立于当前 chat）
  const sharedCharName = window._beiluGetCharName?.();
  if (sharedCharName) return sharedCharName;
  // localStorage（跨刷新持久）
  const saved = storage.get(KEYS.BEILU_LAST_CHAR);
  if (saved) return saved;
  // 从当前 chat 推断（仅在 sharedState 尚未设置时）
  const currentId = getCurrentChatId();
  if (currentId && allChats.length > 0) {
    const currentChat = allChats.find((c) => (c.chatid || c.id) === currentId);
    if (currentChat?.primaryCharName) {
      return currentChat.primaryCharName;
    }
    if (currentChat?.chars?.length > 0) {
      return currentChat.chars[0];
    }
  }
  // 旧 fallback
  if (charList && charList.length > 0) {
    return charList[0];
  }
  return "";
}

/** 渲染重试计数器（等待 charList 加载） */
let _renderRetryCount = 0;
const MAX_RENDER_RETRIES = 10;

/**
 * Drift 修复：渲染序号令牌。
 * renderConversationList 是 async（await fetchChatList），可被 hashchange /
 * beilu:mode-switched / 收藏/置顶/改名/删除/重试 setTimeout 并发触发。
 * 多个 fetch 竞态时，后 resolve 的旧调用会用它启动时捕获的旧 currentId/
 * currentCharName 覆盖 DOM（Drift #3：旧请求结果覆盖新会话）。
 * 每次调用自增并捕获令牌，await 之后若已被更新调用抢占则放弃写 DOM。
 */
let _renderSeq = 0;

/**
 * 渲染对话列表到 #conv-list
 * 只显示当前角色卡的对话，按角色卡过滤
 * E1: 显示模式标签
 */
// 多组并行 v4：取 chatid→{groupId,projectName,role} 映射，给会话列表加「组」标（§4.1 左栏分组可见性）
async function fetchGroupMap() {
  try {
    // T6b批7：GET /groups → sendAction shells:chat#getGroups。!ok 门面抛错走 catch → {}（等价原 !resp.ok return {}）。
    const { groups = {} } = await sendAction({ verb: "getGroups", target: "shells:chat", source: "web" });
    const map = {};
    for (const [groupId, g] of Object.entries(groups))
      for (const [role, cid] of Object.entries(g.roles || {}))
        map[cid] = { groupId, projectName: g.projectName || "", role };
    return map;
  } catch { return {}; }
}

/**
 * 获取所有会话列表挂载点（[data-conv-list]）。
 * F-A 壳级左栏：同一份渲染逻辑同时输出到壳级会话区 + IDE 文件模式对话历史面板（多实例）。
 */
function getConvListEls() {
  return Array.from(document.querySelectorAll("[data-conv-list]"));
}

/** 给所有挂载点写同一段 HTML */
function _writeAllLists(html) {
  for (const el of getConvListEls()) el.innerHTML = html;
}

/**
 * F-A 日期分组：按 lastActive 时间把会话归到 Today / 昨天 / 更早的具体日期。
 * 返回分组键（用于 header 文案）。
 */
function _dateGroupKey(ts) {
  if (!ts) return "更早";
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  if (ts >= startOfToday) return "今天";
  if (ts >= startOfYesterday) return "昨天";
  // 更早：显示具体日期（同年省略年份）
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return y === now.getFullYear() ? `${m}月${day}日` : `${y}年${m}月${day}日`;
}

async function renderConversationList() {
  const listEls = getConvListEls();
  if (listEls.length === 0) return;

  // Drift 修复：占用本次渲染令牌；await 后若被更新的渲染抢占则放弃，避免旧
  // fetch 结果覆盖新会话/角色的 DOM。
  const mySeq = ++_renderSeq;

  const [allChats, groupMap] = await Promise.all([fetchChatList(), fetchGroupMap()]);
  if (mySeq !== _renderSeq) return; // 已被更新的渲染抢占，丢弃本次过期结果

  const meta = loadConvMeta();
  // currentId/currentCharName 在 await 之后读取，确保对齐最新 hash/角色
  const currentId = getCurrentChatId();
  const currentCharName = getCurrentCharName(allChats);

  // ★ 修复：当 charList 未加载时（角色名为空），不显示全部对话
  // 而是显示加载提示并延迟重试
  if (!currentCharName) {
    _renderRetryCount++;
    if (_renderRetryCount <= MAX_RENDER_RETRIES) {
      _writeAllLists(
        '<div style="color:color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size:0.75rem; text-align:center; padding:1rem;"><i data-ic="hourglass"></i> 正在获取角色信息...</div>');
      setTimeout(() => renderConversationList(), 2000);
      return;
    }
    // 超过重试次数，显示错误提示
    _writeAllLists(
      '<div style="color:color-mix(in oklch, var(--color-base-content) 55%, transparent); font-size:0.75rem; text-align:center; padding:1rem;">无法获取角色信息，请刷新页面</div>');
    return;
  }
  _renderRetryCount = 0; // 成功获取角色名，重置计数器

  // 按角色卡过滤：只显示属于当前角色卡的对话
  const charFiltered = allChats.filter((chat) => {
    // bot 对话文件屏蔽（凛倾 07-09「前端其他的屏蔽,只有在bot模式出现」）：
    //   0715 收口:符号消费 utils.mjs BOT_CHAT_SYMBOL 前端单源(后端 chatOps 跨 runtime 镜像)。
    //   本列表（chat/airp/work 左栏）不在 bot tab 渲染，无条件滤除即满足「只在 bot 模式出现」。
    if ((chat.customName || "").startsWith(BOT_CHAT_SYMBOL)) return false;
    const chatCharName = chat.primaryCharName || "";
    // 匹配当前角色卡名（primaryCharName 完全匹配）
    if (chatCharName === currentCharName) return true;
    // 备选匹配：chars 数组包含当前角色卡
    if (
      chat.chars &&
      Array.isArray(chat.chars) &&
      chat.chars.includes(currentCharName)
    )
      return true;
    return false;
  });

  // 按模式过滤：只显示匹配当前模式的对话（无模式标记的旧对话在所有模式中可见）
  const currentMode = getCurrentMode();
  const filteredChats = _showAllModes
    ? charFiltered
    : charFiltered.filter((chat) => {
        const id = chat.chatid || chat.id;
        // 模式数据源：服务端 chat.mode（chat_modes 权威，跨窗口一致）> 本地 convMeta.mode（缓存/旧数据兜底）
        const chatMode = chat.mode || (meta[id] || {}).mode;
        // 无模式标记 → 旧对话，所有模式可见
        if (!chatMode) return true;
        // 模式匹配
        return chatMode === currentMode;
      });

  // 排序：置顶优先 > 收藏优先 > 最近活跃
  // 0715 LS-4：starred/pinned 唯一权威=服务端 chat.starred/pinned（chat_flags，getChatList 恒注入）。
  //   原读本地 convMeta=多窗口 read-modify-write 互覆盖丢标记；不留 ||convMeta 兜底（0713 mode 徽标
  //   同款定调：多源合并=服务端真值被本地 stale 值盖掉，参照 补丁形式识别_多源合并与反向回灌.md P2）。
  //   排序逻辑=compareConvOrder 单源（原本模块/workPanel/subModePanel 三份同构手抄副本，散点合并 0715）。
  filteredChats.sort((a, b) => compareConvOrder(a, b, meta));


  /** [P1-2 0805] 条目内容签名：覆盖会影响 buildConvItem 产出 DOM 的全部输入（名称/时间/预览/
   *  置顶/收藏/模式/组标/在用标）。增量更新时签名一致才复用旧元素（保留事件绑定），
   *  签名变化则重建——避免"只更新 className"式复用让改名/新消息预览/徽标停留在旧值。 */
  function _convItemSig(chat) {
    const id = chat.chatid || chat.id;
    const cm = meta[id] || {};
    const g = groupMap[id];
    return [
      chat.customName || cm.label || chat.firstUserMessage || "",
      cm.lastActive || chat.lastMessageTime || "",
      String(chat.lastMessageContent || "").slice(0, 60),
      chat.lastMessageSender || "",
      chat.pinned ? 1 : 0,
      chat.starred ? 1 : 0,
      chat.mode || "",
      g ? `${g.projectName || g.groupId}:${g.role}` : "",
      Array.isArray(chat.usedByModes) ? chat.usedByModes.join(",") : "",
      chat.inUseCount || 0,
    ].join("|");
  }

  /** [P1-2 0805] 增量挂载：已有同 id 元素且签名未变 → 复用（appendChild 移动即排序，事件绑定保留），
   *  只刷新高亮/置顶 class；签名变化或新条目 → buildConvItem 重建。 */
  function _appendConvItem(listEl, chat, existingMap) {
    const id = chat.chatid || chat.id;
    const el = existingMap.get(id);
    if (el && el.dataset.sig === _convItemSig(chat)) {
      el.className = `conv-item${id === currentId ? " conv-active" : ""}${chat.pinned ? " conv-pinned" : ""}`;
      listEl.appendChild(el);
    } else {
      if (el) el.remove();
      listEl.appendChild(buildConvItem(chat));
    }
  }

  /** 构建单个会话条目（每个挂载点各建一份，事件独立绑定） */
  function buildConvItem(chat) {
    const id = chat.chatid || chat.id;
    const convMeta = meta[id] || {};
    const isActive = id === currentId;
    // 标签优先级（N39）：服务端持久自定义名 > 本地 label（旧数据/离线兜底）> 首条用户消息 > ID截取
    const label =
      chat.customName || convMeta.label || chat.firstUserMessage || id.substring(0, 10) + "…";
    const lastActive = convMeta.lastActive
      ? formatRelativeTime(convMeta.lastActive)
      : chat.lastMessageTime
        ? formatRelativeTime(new Date(chat.lastMessageTime).getTime())
        : "";

    // 最近一条消息预览
    const lastPreview = chat.lastMessageContent
      ? truncate(chat.lastMessageContent, 40)
      : "";
    const lastSender = chat.lastMessageSender || "";

    // 0713 补丁删除：模式徽标唯一权威=服务端 chat.mode（chat_modes，getChatList 恒注入，空串=未分类）。
    //   原 `chat.mode || convMeta.mode || 本地指针` 三级回退=多源合并补丁——服务端说「未分类」
    //   会被本地 stale 值盖掉，各窗口各说各话（参照：补丁形式识别_多源合并与反向回灌.md P2）。
    const chatMode = chat.mode || null;
    const modeBadge = buildModeBadge(chatMode);

    // 「XX窗口在用」标签：服务端 usedByModes 单源（0713 补丁删除，∪ 本地合并已废）。
    const usingBadge = buildInUseLabel(chat.usedByModes);
    // 「另一窗口在用」角标：buildOtherWindowBadge 单源（D4 收口）
    const inUseBadge = buildOtherWindowBadge(id, chat.inUseCount);

    // 多组并行 v4：组标（此对话绑到某并行组的某角色 → 显示 🗂️，hover 看组名/角色）
    const gInfo = groupMap[id];
    const groupBadge = gInfo
      ? `<span class="conv-mode-badge" title="并行组: ${escapeHtml(gInfo.projectName || gInfo.groupId)} · 角色: ${escapeHtml(gInfo.role)}">🗂️</span>`
      : "";

    const item = document.createElement("div");
    item.className = `conv-item${isActive ? " conv-active" : ""}${chat.pinned ? " conv-pinned" : ""}`;
    item.dataset.chatid = id;
    item.dataset.sig = _convItemSig(chat); // [P1-2 0805] 增量更新复用判据，见 _appendConvItem

    // 构建 HTML：两行布局（名称行 + 预览行） + hover 显示的改名/删除按钮 [IDE-T2]
    item.innerHTML = `
      <div class="conv-item-main">
        <div class="conv-item-top">
          <span class="conv-icons">
            ${chat.pinned ? '<span class="conv-pin-icon" title="已置顶"><i data-ic="pin"></i></span>' : ""}
            ${chat.starred ? '<span class="conv-star-icon" title="已收藏"><i data-ic="star"></i></span>' : ""}
            ${modeBadge}
            ${groupBadge}
            ${inUseBadge}
          </span>
          <span class="conv-label">${escapeHtml(label)}</span>
          ${usingBadge}
          <span class="conv-time">${lastActive}</span>
          <span class="conv-hover-actions">
            <button class="conv-action-btn" data-conv-action="rename" title="改名">✏️</button>
            <button class="conv-action-btn" data-conv-action="mark" title="标记模式图标">🏷️</button>
            <button class="conv-action-btn" data-conv-action="delete" title="删除">🗑️</button>
          </span>
        </div>
        <div class="conv-item-preview">
          ${lastSender ? `<span class="conv-preview-sender">${escapeHtml(lastSender)}:</span>` : ""}
          <span class="conv-preview-text">${escapeHtml(lastPreview) || '<span class="opacity-40">(空对话)</span>'}</span>
        </div>
      </div>
    `;

    // 点击切换对话 (但点按钮时不切换)
    item.addEventListener("click", (e) => {
      if (e.target.closest("[data-conv-action]")) return;
      switchToChat(id);
    });

    // hover 按钮事件
    item.querySelector('[data-conv-action="rename"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      renameConversation(id);
    });
    item.querySelector('[data-conv-action="mark"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      showConvModeMenu(e, id);
    });
    item.querySelector('[data-conv-action="delete"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(id);
    });

    // 右键菜单（重命名/收藏/置顶/删除）——flags 传服务端注入值（chat_flags 单源），不传本地 convMeta
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showConvContextMenu(e, id, { starred: !!chat.starred, pinned: !!chat.pinned });
    });

    return item;
  }

  /** 分区 header（Starred / 日期分组） */
  function buildGroupHeader(text) {
    const h = document.createElement("div");
    h.className = "conv-group-header";
    h.textContent = text;
    return h;
  }

  // F-A 分区：Starred 置顶分区 + 日期分组（Today/昨天/具体日期）。
  // 置顶(pinned)会话仍排最前（不进 Starred 分区，保留原“📌 钉住”语义），
  // Starred 分区只收非置顶的收藏会话；其余按日期分组。
  const starredItems = [];   // 收藏（且未置顶）
  const pinnedItems = [];     // 置顶
  const dateGroups = new Map(); // 分组键 → chat[]
  for (const chat of filteredChats) {
    const id = chat.chatid || chat.id;
    const cm = meta[id] || {};
    if (chat.pinned) { pinnedItems.push(chat); continue; }
    if (chat.starred) { starredItems.push(chat); continue; }
    const ts = cm.lastActive || (chat.lastMessageTime ? new Date(chat.lastMessageTime).getTime() : 0);
    const key = _dateGroupKey(ts);
    if (!dateGroups.has(key)) dateGroups.set(key, []);
    dateGroups.get(key).push(chat);
  }

  // 渲染到每个挂载点（各建独立 DOM + 事件）
  // [P1-2 0805] keyed增量更新：按data-chatid复用已有DOM元素（签名未变才复用，见_appendConvItem），
  //   不再全量innerHTML=""重建。全量重建成本=全量DOM重建+事件重绑，高频事件（发消息/摘要落盘）下卡顿。
  for (const listEl of listEls) {
    // 收集已有conv-item元素，按data-chatid索引
    const _existing = new Map();
    for (const _el of listEl.querySelectorAll(".conv-item[data-chatid]")) {
      _existing.set(_el.dataset.chatid, _el);
    }

    // 收集本次渲染需要的所有chatid，删除不在新集合中的旧元素
    const _neededIds = new Set();
    for (const chat of pinnedItems) _neededIds.add(chat.chatid || chat.id);
    for (const chat of starredItems) _neededIds.add(chat.chatid || chat.id);
    for (const [, chats] of dateGroups) for (const chat of chats) _neededIds.add(chat.chatid || chat.id);
    for (const [id, el] of _existing) {
      if (!_neededIds.has(id)) { el.remove(); _existing.delete(id); }
    }

    // 清空listEl中非conv-item的内容（headerInfo/groupHeader/empty等，构建成本低），保留conv-item元素
    for (const _child of Array.from(listEl.children)) {
      if (!_child.classList.contains("conv-item")) _child.remove();
    }

    // 角色卡名 + 对话数量 + 模式过滤切换
    if (currentCharName) {
      const headerInfo = document.createElement("div");
      headerInfo.className = "conv-header-info";

      const modeLabel = _showAllModes
        ? "全部"
        : (MODE_BADGE[currentMode]?.label || currentMode);
      const totalForChar = charFiltered.length;
      const countText = _showAllModes
        ? `${filteredChats.length} 个对话`
        : `${filteredChats.length}/${totalForChar} 个对话`;
      headerInfo.innerHTML =
        `<span><i data-ic="paperclip"></i> ${escapeHtml(currentCharName)} · ${countText}</span>` +
        `<button class="conv-mode-filter-btn" title="${_showAllModes ? "点击：只看当前模式" : "点击：显示全部模式"}">${_showAllModes ? "全部" : modeLabel}</button>`;

      const filterBtn = headerInfo.querySelector(".conv-mode-filter-btn");
      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _showAllModes = !_showAllModes;
        storage.set(KEYS.BEILU_CONV_SHOW_ALL_MODES, String(_showAllModes));
        renderConversationList();
      });

      listEl.appendChild(headerInfo);
    }

    if (filteredChats.length === 0) {
      const emptyHint = _showAllModes
        ? "当前角色卡暂无对话"
        : `当前模式（${MODE_BADGE[currentMode]?.label || currentMode}）暂无对话`;
      listEl.insertAdjacentHTML("beforeend",
        `<div class="conv-empty">${emptyHint}<br><span style="font-size:0.7rem;">点击右上角 ＋ 新建</span></div>`);
      continue;
    }

    // 置顶分区（无 header，直接列在最前，保留原行为）
    for (const chat of pinnedItems) _appendConvItem(listEl, chat, _existing);

    // ⭐ Starred 分区置顶
    if (starredItems.length > 0) {
      listEl.appendChild(buildGroupHeader("收藏"));
      for (const chat of starredItems) _appendConvItem(listEl, chat, _existing);
    }

    // 日期分组 header（今天 / 昨天 / 具体日期），按时间从新到旧
    const orderedKeys = Array.from(dateGroups.keys());
    for (const key of orderedKeys) {
      listEl.appendChild(buildGroupHeader(key));
      for (const chat of dateGroups.get(key)) _appendConvItem(listEl, chat, _existing);
    }
  }
}

/**
 * 右键菜单壳构造单源（[合并批 0714] 原 showConvContextMenu / showConvModeMenu 两处
 * 同款 cssText 手拼，只差 min-width——收口一处，样式改动单点生效）。
 * @param {string} minWidth
 * @returns {HTMLDivElement}
 */
function _buildCtxMenuShell(minWidth) {
  document.querySelectorAll(".conv-ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "conv-ctx-menu";
  menu.style.cssText = `
    position:fixed;
    background:var(--color-base-200); border:1px solid var(--beilu-amber-30);
    border-radius:6px; padding:4px 0; z-index:var(--z-popup);
    box-shadow:0 4px 12px rgba(0,0,0,0.5); min-width:${minWidth};
  `;
  return menu;
}

/**
 * 右键菜单（增强版：重命名/收藏/置顶/删除）
 */
function showConvContextMenu(event, chatid, convMeta) {
  const menu = _buildCtxMenuShell("140px");

  const isStarred = convMeta?.starred;
  const isPinned = convMeta?.pinned;

  const actions = [
    { label: '<i data-ic="edit"></i> 重命名', action: () => renameConversation(chatid) },
    { label: '🏷️ 标记模式图标', action: () => showConvModeMenu(event, chatid) },
    {
      label: isPinned ? '<i data-ic="pin"></i> 取消置顶' : '<i data-ic="pin"></i> 置顶',
      action: () => togglePin(chatid, !isPinned),
    },
    {
      label: isStarred ? '<i data-ic="star"></i> 取消收藏' : '<i data-ic="star-o"></i> 收藏',
      action: () => toggleStar(chatid, !isStarred),
    },
    {
      label: '<i data-ic="download"></i> 导出',
      action: () => exportConversation(chatid),
    },
    {
      label: '<i data-ic="external-link"></i> 分叉对话',
      action: () => branchConversation(chatid),
    },
    {
      label: '<i data-ic="trash"></i> 删除',
      action: () => deleteConversation(chatid),
      danger: true,
    },
  ];

  for (const { label, action, danger } of actions) {
    const btn = document.createElement("div");
    btn.innerHTML = label;
    btn.style.cssText = `
      padding:7px 14px; font-size:0.8rem; cursor:pointer;
      color:${danger ? "var(--beilu-error)" : "color-mix(in oklch, var(--color-base-content) 85%, transparent)"};
    `;
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "var(--beilu-amber-15)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "";
    });
    btn.addEventListener("click", () => {
      menu.remove();
      action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  positionContextMenu(menu, event.clientX, event.clientY);
  bindClickOutsideClose(menu, () => menu.remove());
}

/**
 * 手动标记对话模式图标（凛倾 07-12「图标标记按钮」）：小浮层四模式+清除。
 * 写点=setConvMode 单源（服务端 chat_modes 权威 + 本地 convMeta.mode 缓存）。
 * 入口：conv-item 🏷️ 按钮 + 右键菜单「标记模式图标」。
 */
export function showConvModeMenu(event, chatid) {
  const menu = _buildCtxMenuShell("120px"); // [合并批 0714] 菜单壳收口 _buildCtxMenuShell 单源
  const options = [
    ...Object.entries(MODE_BADGE).map(([mode, cfg]) => ({ mode, label: `${cfg.icon} ${cfg.label}` })),
    { mode: "", label: "✕ 清除标记" },
  ];
  for (const { mode, label } of options) {
    const btn = document.createElement("div");
    btn.innerHTML = label;
    btn.style.cssText = "padding:7px 14px; font-size:0.8rem; cursor:pointer; color:color-mix(in oklch, var(--color-base-content) 85%, transparent);";
    btn.addEventListener("mouseenter", () => { btn.style.background = "var(--beilu-amber-15)"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = ""; });
    btn.addEventListener("click", () => {
      menu.remove();
      setConvMode(chatid, mode);
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  positionContextMenu(menu, event.clientX, event.clientY);
  bindClickOutsideClose(menu, () => menu.remove());
}

/**
 * 对话模式徽标写点单源：服务端持久（setChatMode→chat_modes，跨窗口权威）+ 本地 convMeta.mode 缓存。
 * 服务端失败只 toast 不回滚本地（对齐 rename 的离线兜底语义）；成功后服务端广播
 * chat-list-changed 会驱动其他客户端刷新，本端由 saveConvMeta 的 conv-meta-changed 即时重渲。
 */
async function setConvMode(chatid, mode) {
  const meta = loadConvMeta();
  meta[chatid] = { ...(meta[chatid] || {}) };
  if (mode) meta[chatid].mode = mode;
  else delete meta[chatid].mode;
  saveConvMeta(meta);
  renderConversationList();
  const _r = await setChatMode(chatid, mode);
  if (!_r.ok) showToast?.("warning", "模式标记未持久化到服务端: " + _r.message);
}

/**
 * [0713 病灶审计 D2] 对话改名提交核心单源：后端 renameChat 持久化（N39）+ 本地 convMeta.label 缓存/离线兜底。
 * 原本模块与 chatmgmt 弹窗各持整段同构提交逻辑，注释靠「N39 对齐 conversationManager」人工同步=漂移源。
 * UI 形态（内联输入框构造/显示名回写/双触发去重）留在各调用侧；数据提交只此一份。
 * @param {string} chatid
 * @param {string} newName 空串=恢复默认名（服务端回落首条消息）
 * @returns {Promise<{ok: boolean, message?: string}>} renameChat 的结果
 */
export async function commitChatRename(chatid, newName) {
  const _r = await renameChat(chatid, newName);
  if (!_r.ok) showToast?.("warning", "改名未持久化到服务端: " + _r.message);
  const meta = loadConvMeta();
  if (!meta[chatid]) meta[chatid] = {};
  meta[chatid].label = newName;
  saveConvMeta(meta);
  return _r;
}

/**
 * 重命名对话 — 使用内联输入框（prompt() 在 webview 中不可用）
 */
async function renameConversation(chatid) {
  // F-A 多挂载点：在任一 [data-conv-list] 中找到对应 conv-item 做内联编辑
  // （提交后 renderConversationList 会重渲染所有挂载点）。
  let item = null;
  for (const listEl of getConvListEls()) {
    item = listEl.querySelector(`[data-chatid="${chatid}"]`);
    if (item) break;
  }
  if (!item) return;

  const labelEl = item.querySelector(".conv-label");
  const meta = loadConvMeta();
  // [合并批 0714·二] UI 编排收口 mountInlineEdit 单源（4 处同构副本）；数据提交仍走 commitChatRename（D2）
  mountInlineEdit(labelEl, {
    value: meta[chatid]?.label || "",
    placeholder: "输入对话名称…",
    className: "conv-rename-input",
    onCommit: async (newName) => {
      await commitChatRename(chatid, newName);
      renderConversationList();
    },
  });
}

/**
 * 切换收藏状态（0715 LS-4：写点单源=服务端 setChatFlags→chat_flags，零本地写。
 * 原 loadConvMeta 整对象 read-modify-write：两窗口并发改不同对话，后写者覆盖先写者=标记静默丢。
 * 服务端成功后广播 chat-list-changed 驱动各端刷新；本端 renderConversationList 自带 fetch 拉回新值。）
 * @param {string} chatid
 * @param {boolean} next - 目标状态（调用方基于服务端当前值取反）
 */
async function toggleStar(chatid, next) {
  const _r = await setChatFlags(chatid, { starred: !!next });
  if (!_r.ok) showToast?.("warning", "收藏标记未持久化到服务端: " + _r.message);
  renderConversationList();
}

/**
 * 切换置顶状态（同 toggleStar：服务端 chat_flags 单源写）
 * @param {string} chatid
 * @param {boolean} next - 目标状态
 */
async function togglePin(chatid, next) {
  const _r = await setChatFlags(chatid, { pinned: !!next });
  if (!_r.ok) showToast?.("warning", "置顶标记未持久化到服务端: " + _r.message);
  renderConversationList();
}

export async function deleteConversation(chatid) {
  // 缺陷5：文案对齐后端真实行为——deleteChat 走 safeUnlink 进系统回收站（失败 fallback data/_trash_fallback/），非硬删
  if (!await beiluConfirm("确定删除此对话？（删除后进回收站，可找回）")) return;
  wbTrace("conv", "delete", { chatid: chatid.substring(0, 8) });
  try {
    // T6b批7：DELETE /delete → sendAction shells:chat#deleteChat（DELETE + body {chatids}）。!ok 门面抛错走 catch。
    await sendAction({ verb: "deleteChat", target: "shells:chat", source: "web", payload: { chatids: [chatid] } });
    // 清除元数据
    const meta = loadConvMeta();
    delete meta[chatid];
    saveConvMeta(meta);

    // 配对删链：活动栏若挂着这条对话的线图标，一并摘掉（否则留死图标，点了切到不存在的对话）。
    // 走 window 桥：lineManager 已 import 本模块，反向静态引会成环。
    try { window._beiluDropLine?.(chatid); } catch { /* 线管理未加载=没有线，忽略 */ }

    // E1: 如果删除的对话是某个模式的绑定 chatId，清除 per-char key 绑定
    const _delChar = storage.get(KEYS.BEILU_LAST_CHAR) || "";
    for (const [mode] of Object.entries(MODE_CHATID_KEYS)) {
      const perCharKey = getModeChatIdKey(mode, _delChar);
      if (perCharKey && storage.get(perCharKey) === chatid) {
        storage.remove(perCharKey);
        console.log(`[conversationManager] E1: 清除 ${mode}/${_delChar} 已删除 chatId 绑定`);
      }
    }

    // 如果删除的是当前对话，切换到列表中第一个
    if (getCurrentChatId() === chatid) {
      const remaining = await fetchChatList();
      if (remaining.length > 0) {
        switchToChat(remaining[0].chatid || remaining[0].id);
      } else {
        window.location.reload();
      }
    }
    renderConversationList();
  } catch (err) {
    console.error("[conversationManager] delete failed:", err);
    window._reportError?.(`[conversationManager] ${err.message}`, err.stack);
    showToast?.("error", `删除对话失败: ${err.message}`);
  }
}

/**
 * 导出对话 JSON（复用后端 virtual_files 端点，返回 Content-Disposition attachment）
 */
async function exportConversation(chatid) {
  wbTrace("conv", "export", { chatid: chatid.substring(0, 8) });
  try {
    // T6b批7 有据不收：virtual_files 端点返回 blob 二进制（res.blob() 下载附件），门面 apiFetch json 语义不适用——保留 raw apiFetch。
    const res = await apiFetch(`/virtual_files/parts/shells:chat/${encodeURIComponent(chatid)}`, { raw: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${chatid}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast?.("success", "对话已导出");
  } catch (err) {
    console.error("[conversationManager] export failed:", err);
    showToast?.("error", `导出对话失败: ${err.message}`);
  }
}

/**
 * 分叉对话：从对话最后一条消息创建分支副本
 * 会话列表右键入口（克隆完整对话）
 */
async function branchConversation(chatid) {
  if (!await beiluConfirm("分叉此对话？\n\n将创建一个包含所有消息的对话分支副本，原对话不受影响。")) return;
  wbTrace("conv", "branch", { chatid: chatid.substring(0, 8) });
  try {
    // 完整克隆是明确意图，不再由前端先 GET 长度再把“最后一条”换算成易漂移的 index。
    // 后端在同一次源 JSON 读取中选择末条，读长度失败也不会退化成克隆 index 0。
    // T6b批7：POST /branch → sendAction shells:chat#branch。原 !resp.ok||!result.chatid → toast+return；
    //   门面 !ok 抛错走外层 catch（toast 分叉失败），成功但无 chatid 仍走下方 !result.chatid 判定。
    const result = await sendAction({ verb: "branch", target: "shells:chat", source: "web", payload: { chatid, wholeChat: true } });
    if (!result.chatid) {
      showToast?.("error", "分叉失败: " + (result.error || "未知错误"));
      return;
    }
    showToast?.("success", "已创建分支对话");
    await switchToChat(result.chatid);
    renderConversationList();
  } catch (err) {
    console.error("[conversationManager] branch failed:", err);
    showToast?.("error", `分叉对话失败: ${err.message}`);
  }
}

// ---- 工具函数 ----

function truncate(str, maxLen) {
  if (!str) return "";
  const cleaned = str.replace(/[\n\r]+/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + "…" : cleaned;
}

// [合并批 0714] formatRelativeTime 本地实现删除 → shared/state/utils.mjs 单源（与 subModePanel._relTime 同批收口）

// [IDE-T2] 搜索过滤 — 在 conv-list 的 conv-item 上按 label 匹配显隐
let _searchDebounce = null;
function _applyConvSearchFilter(q) {
  for (const list of getConvListEls()) {
    list.querySelectorAll(".conv-item").forEach(item => {
      const label = item.querySelector(".conv-label")?.textContent || "";
      const preview = item.querySelector(".conv-preview-text")?.textContent || "";
      const match = !q || label.toLowerCase().includes(q) || preview.toLowerCase().includes(q);
      item.style.display = match ? "" : "none";
    });
  }
  if (_searchDebounce) clearTimeout(_searchDebounce);
  if (!q || q.length < 2) { _clearFulltextResults(); return; }
  _searchDebounce = setTimeout(() => _doFulltextSearch(q), 500);
}

async function _doFulltextSearch(q) {
  try {
    // T6b批7：POST /search → sendAction shells:chat#search。!ok 门面抛错走 catch（原全文搜索失败静默，等价）。
    const data = await sendAction({ verb: "search", target: "shells:chat", source: "web", payload: { query: q, limit: 30, charName: storage.get(KEYS.BEILU_LAST_CHAR) || undefined } });
    // T032 补差：无命中不再静默清空（DONE WHEN 硬要求），渲染内联"无匹配"态给出可见反馈。
    if (!data?.success || !data.results?.length) { _renderFulltextEmpty(q); return; }
    _renderFulltextResults(data.results, q);
  } catch (_err) { /* 全文搜索失败不影响 DOM 过滤 */ }
}

// 结果盒获取/创建（命中列表与"无匹配"态共用同一容器，避免 DOM 分裂）
function _getFulltextBox(list) {
  let box = list.parentElement?.querySelector(".conv-fulltext-results");
  if (!box) {
    box = document.createElement("div");
    box.className = "conv-fulltext-results";
    list.parentElement?.appendChild(box);
  }
  return box;
}

// T032 补差：无命中内联提示态（非静默清空——DONE WHEN 硬要求可见反馈）
function _renderFulltextEmpty(q) {
  for (const list of getConvListEls()) {
    const box = _getFulltextBox(list);
    box.innerHTML = `<div style="padding:6px 8px;font-size:11px;color:var(--beilu-muted);border-top:1px solid var(--beilu-border)">全文搜索：无匹配 “${escapeHtml(q)}”</div>`;
  }
}

function _renderFulltextResults(results, q) {
  for (const list of getConvListEls()) {
    const box = _getFulltextBox(list);
    const hl = (s) => escapeHtml(s).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    box.innerHTML = `<div style="padding:4px 8px;font-size:11px;color:var(--beilu-muted);border-top:1px solid var(--beilu-border)">全文搜索 (${results.length})</div>` +
      results.map(r => `<div class="conv-fulltext-hit" data-chatid="${r.chatId}" data-msgidx="${r.messageIndex}" data-ts="${r.timeStamp ? escapeHtml(String(r.timeStamp)) : ""}" style="padding:4px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--beilu-border)" title="${escapeHtml(r.chatTitle || "")}"><div style="color:var(--beilu-muted);font-size:10px">${escapeHtml(r.chatTitle || "")} #${r.messageIndex}</div><div>${hl(r.snippet || "")}</div></div>`).join("");
    box.querySelectorAll(".conv-fulltext-hit").forEach(hit => {
      hit.addEventListener("click", async () => {
        const chatid = hit.dataset.chatid;
        if (!chatid) return;
        await switchToChat(chatid);
        // T032 补差：切对话后按命中消息 time_stamp 滚动定位（复用 messageList data-timestamp 锚点 +
        // taskTimeline 时间最近邻法）。switchToChat 已切至同对话时会 early-return，此处仍生效。
        _scrollToHitByTs(hit.dataset.ts);
      });
    });
  }
}

// T032 补差：按 time_stamp 在 #chat-messages 定位并滚动+高亮命中消息（时间最近邻，与 taskTimeline 同法）。
// 用 index 定位不可靠：后端 messageIndex 是 log 数组下标，log 含 _hidden/_deleted 条目，DOM 渲染形态不同 → 位置不等价。
function _scrollToHitByTs(tsRaw) {
  if (!tsRaw) return;
  const target = Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : new Date(tsRaw).getTime();
  if (!Number.isFinite(target) || !target) return;
  // 消息渲染是切对话后异步完成，轮询等待锚点出现（最多 ~2s）
  let tries = 0;
  const tick = () => {
    const scope = document.getElementById("chat-messages") || document;
    let best = null, bestDt = Infinity;
    for (const el of scope.querySelectorAll(".chat-message[data-timestamp]")) {
      const raw = el.getAttribute("data-timestamp");
      const mt = Number.isFinite(Number(raw)) ? Number(raw) : new Date(raw).getTime();
      if (!Number.isFinite(mt) || !mt) continue;
      const dt = Math.abs(mt - target);
      if (dt < bestDt) { bestDt = dt; best = el; }
    }
    if (best) {
      best.scrollIntoView({ behavior: "smooth", block: "center" });
      const prev = best.style.outline, prevOff = best.style.outlineOffset;
      best.style.outline = "2px solid var(--beilu-amber, #d4a017)";
      best.style.outlineOffset = "2px";
      setTimeout(() => { best.style.outline = prev; best.style.outlineOffset = prevOff; }, 1600);
      return;
    }
    if (++tries < 20) setTimeout(tick, 100);
  };
  tick();
}

function _clearFulltextResults() {
  document.querySelectorAll(".conv-fulltext-results").forEach(el => el.remove());
}

async function _rollbackChat(chatid) {
  try {
    // T6b批7：DELETE /delete → sendAction shells:chat#deleteChat（best-effort 回滚）。
    await sendAction({ verb: "deleteChat", target: "shells:chat", source: "web", payload: { chatids: [chatid] } });
  } catch { /* best-effort rollback */ }
}

/**
 * 新建对话分类落位（单源）：写 convMeta.mode（列表按模式过滤/显示模式徽标的数据源）
 * + per-char 模式线记录（getModeChatIdKey）。
 * doCreateNewChat 与 charsel 建卡/导入建对话路径共用——charsel 直调 verb 建对话曾绕过
 * 此分类写点，新卡对话无 mode 标记（列表当旧对话处理、无徽标）。
 * @param {string} chatid
 * @param {string} [charName] 归属角色卡名；缺省取 BEILU_LAST_CHAR
 * @param {string} [mode] 显式模式线（[D6 收口 0713] AI驱动懒建等"目标模式≠当前模式"的建对话
 *   路径原因无法传模式而绕过本函数 → 对话永无分类徽章；缺省仍取 getCurrentMode() 兼容旧调用）
 */
export function classifyNewChat(chatid, charName, mode) {
  const currentMode = mode || getCurrentMode();
  const meta = loadConvMeta();
  meta[chatid] = { ...(meta[chatid] || {}), lastActive: Date.now(), mode: currentMode };
  saveConvMeta(meta);
  // 服务端双写（chat_modes 权威）：本地 convMeta.mode 只是本浏览器缓存，不双写则换窗口徽标全丢。
  // fire-and-forget：分类失败不阻塞建对话主链，列表靠本地缓存先渲染。
  setChatMode(chatid, currentMode).then((r) => {
    if (!r.ok) console.warn("[conversationManager] classifyNewChat 服务端持久失败:", r.message);
  });
  const _char = charName || storage.get(KEYS.BEILU_LAST_CHAR) || "";
  // 在用指针本地+服务端双写（markModeActiveChat 单源）
  markModeActiveChat(currentMode, _char, chatid);
}

/** F-A 新建对话共享逻辑（壳级 + IDE + cardsPanel 三个 ➕ 按钮共用） */
let _creating = false;
export async function doCreateNewChat() {
  if (_creating) return;
  _creating = true;
  try {
    const chatid = await createNewChat();
    if (chatid) {
      const currentChar = charList && charList.length > 0 ? charList[0] : null;
      if (!currentChar) {
        await _rollbackChat(chatid);
        showToast?.("error", "当前无角色卡，无法创建对话");
        return;
      }
      try {
        // T6b批7：POST /:chatId/char → sendAction shells:chat#bindCharToChat（chatId 进 URL，charname 进 body）。
        await sendAction({ verb: "bindCharToChat", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { charname: currentChar } });
      } catch (err) {
        await _rollbackChat(chatid);
        showToast?.("error", `创建对话失败: ${err.message}`);
        return;
      }

      classifyNewChat(chatid);

      switchToChat(chatid);
    }
  } finally {
    _creating = false;
  }
}

// ---- 初始化 ----

export function initConversationManager() {
  // [IDE-T2] 搜索按钮 — 每个面板各自切换其搜索框显隐 + 共享过滤逻辑
  // F-A：壳级 + IDE 两处的搜索/新建控件用 data-conv-* 多实例绑定
  document.querySelectorAll("[data-conv-search]").forEach((searchBtn) => {
    // 同一面板内的搜索行/输入框（就近查找）
    const panel = searchBtn.closest(".ide-sidebar-panel") || document;
    const searchRow = panel.querySelector("[data-conv-search-row]");
    const searchInput = panel.querySelector("[data-conv-search-input]");
    searchBtn.addEventListener("click", () => {
      if (!searchRow) return;
      const show = searchRow.style.display === "none";
      searchRow.style.display = show ? "" : "none";
      if (show) searchInput?.focus();
      else if (searchInput) { searchInput.value = ""; _applyConvSearchFilter(""); }
    });
    searchInput?.addEventListener("input", () =>
      _applyConvSearchFilter(searchInput.value.trim().toLowerCase()));
  });

  // 新建按钮（所有挂载点）
  document.querySelectorAll("[data-conv-new]").forEach((newBtn) => {
    newBtn.addEventListener("click", async () => {
      newBtn.disabled = true;
      try { await doCreateNewChat(); }
      finally { newBtn.disabled = false; }
    });
  });

  // 初始渲染
  renderConversationList();

  // 监听 hash 变化以更新高亮。lastActive 立即落盘（数据不防抖），重渲染走 300ms 防抖单源
  // （保留全量重建：hashchange 还承担排序更新+角色切换过滤，只改高亮曾导致发消息后列表不更新排序）。
  window.addEventListener("hashchange", () => {
    const meta = loadConvMeta();
    const id = getCurrentChatId();
    if (id && meta[id]) {
      meta[id].lastActive = Date.now();
      saveConvMeta(meta);
    }
    _debouncedRenderConvList();
  });

  // E1: 监听模式切换事件，刷新对话列表（更新模式标签显示）
  window.addEventListener("beilu:mode-switched", () => {
    _debouncedRenderConvList();
  });

  // [0713 病灶审计 C3] 角色就绪事件驱动重渲染：初始渲染时 charName 常未就绪（走"正在获取角色信息"占位），
  // 角色可用的两条路径均 dispatch beilu:char-changed（switchCharacterScope 切角色 / charinfo.loadCharInfo init），
  // 事件到达即重渲染——替代原来只靠 2s 定时轮询等待；轮询保留为"始终取不到角色"的有界终态收敛器。
  // 切角色不需要重拉整个对话列表（2 HTTP + 全量 DOM 重建）。
  // switchCharacterScope 设 location.hash → hashchange 事件自然触发高亮更新（:1163）。
  // 真正需要完整重建的场景（新建/删除对话）走各自的显式 renderConversationList 调用。

  // 跨客户端聊天列表同步（本体↔YonBan）：另一端新建聊天 / 更新最后一条预览时，
  // 后端按 username 经 sendEventToUser 推 chat-list-changed，websocket.mjs 桥成本事件。
  // 防抖 300ms：updateChatSummary 每次落盘都可能触发，合并高频避免抖动。
  window.addEventListener("beilu:chat-list-changed", () => {
    _debouncedRenderConvList();
  });

  // 根病3 修复：其他 UI（workPanel / index-chatmgmt）修改 meta 后广播此事件，
  // 本模块重渲染对话列表以同步 pin/star/label 等变化。
  // _selfMetaWrite 防递归：本模块自己的 saveConvMeta 触发的事件不重复渲染
  // （togglePin/toggleStar/commitRename 已各自 renderConversationList）。
  window.addEventListener("beilu:conv-meta-changed", () => {
    if (_selfMetaWrite) return;
    _debouncedRenderConvList();
  });
}
