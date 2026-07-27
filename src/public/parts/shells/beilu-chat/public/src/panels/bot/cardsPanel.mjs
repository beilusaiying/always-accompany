/**
 * cardsPanel.mjs — 多窗口两层管理（窗口/模式分类层 × 角色卡实例层）
 *
 * 设计锚点（凛倾 2026-07-05 拍板，T030 期D 修正版）：
 *   「多窗口交互,2层,按照窗口,也就是单个角色卡按照窗口进行分类.如果是单个,比如work或者code,
 *     那么就是多角色卡.用户自己添加角色卡=增加一个永久的链路.」
 *   → 2 层 = 外层「窗口(模式)分类」× 内层「角色卡实例」。
 *   → chat：一卡一窗（每张角色卡=一个窗口，逐张列）。
 *   → work/code：一窗内多角色卡（链路卡 + 子模式角色链，读既有 getSubModes 呈现，不新造数据）。
 *   → 「添加角色卡=增加一个永久的链路」：链路维度=角色卡(charName)，生命周期=永久
 *      （加卡建链、删卡才断；点×=收起视图态不删链路）。永久性落在后端 per-user 持久层
 *      yonban_config.permanent_char_links（verb getCharLinks/addCharLink/removeCharLink，
 *      setDataActions.mjs 跟随 parallel_sub_modes 范式），非前端临时 localStorage Set。
 *
 * why 从「临时 chatid 标签栏」升维为「角色卡永久链路两层」：
 *   旧版 _openWindows 存 chatid（对话文件）临时 Set（localStorage，点×即删、会话级），
 *   ≠ 凛倾「添加角色卡=永久链路」（角色卡粒度、增卡即固化、不因关标签消失）。
 *   本次收口该差集：永久链路后端化（charName 维度），前端只保留「收起」视图态。
 *
 * 两层渲染（复用现有 .cardp-card/.cardp-head/.cardp-name/.cardp-convs/.cardp-conv 折叠样式，不自创视觉）：
 *   窗口(模式)分类头
 *     └ 角色卡卡片（永久链路）── 点卡头折叠/展开（视图态）
 *          └ 对话列表（chatid，卡之下子级，保留原对话切换）
 *          └ 当前对话任务清单
 *     └ work/code：子模式角色链（一窗内多角色卡）
 *   卡头「×」=收起（视图态，可留前端）；卡头「⊗移除链路」=显式断链（写后端，二次确认）。
 *
 * 迁移（一次性升维，不丢用户已开窗口）：
 *   init 读旧 beilu-parallel-windows(chatid Set) → 经 fetchChatList 映射到 charName
 *   → 逐个 addCharLink 建永久链路 → 迁移后清旧键。
 *
 * 关联链：
 *   → shared/chat-core/conversationManager.mjs fetchChatList / switchToChat / doCreateNewChat
 *   → shared/transport/sendAction.mjs（verb=getCharLinks/addCharLink/removeCharLink → beilu-memory setDataActions）
 *   → panels/feature/featureControls.mjs getCurrentMode（区分 chat/code/work 分类层）
 *   ← layout.mjs initCardsPanel
 *   ← group_runtime_update WS 事件
 */
import { fetchChatList, switchToChat, doCreateNewChat } from "../../shared/chat-core/conversationManager.mjs";
import { MODE_BADGE } from "../../shared/state/modeTabMap.mjs"; // D2 收口：模式文案单源（窗口名派生）
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs"; // 0714 扫尾：window.confirm 漏迁（全壳已统一 beiluDialog）
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作 → memory 通配路由，username 由后端登录态注入）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { getCurrentMode } from "../feature/featureControls.mjs"; // T030-D：外层窗口分类=当前模式（chat/code/work）
import { escapeHtml, whenVisible } from "../../shared/state/utils.mjs"; // T7：HTML 转义收口到唯一权威实现（5 字符含单引号；原本地版缺单引号）
import { getUsername as _getUsername } from "../../shared/state/sharedState.mjs"; // [合并批 0714] username 读点单源（别名保调用点）

// T041b: beilu-parallel-windows 收编 KEYS 单源（迁移旧数据用，迁完清空）。
const _OLD_PARALLEL_WINDOWS_KEY = KEYS.BEILU_PARALLEL_WINDOWS;
// T030-D：收起(视图态)集合——纯前端，不影响后端永久链路。已经 extract_localstorage_keys.mjs --write 收编 KEYS。
const _COLLAPSED_KEY = KEYS.BEILU_COLLAPSED_CHAR_LINKS;

let _root = null;
let _initialized = false;
let _activeLines = new Set();       // 运行中的对话线（chatid），group_runtime_update 推送
let _charLinks = [];                // 角色卡永久链路（charName 数组，后端权威）
let _collapsedChars = new Set();    // 收起的角色卡（视图态，前端 localStorage）
let _allChats = [];                 // 缓存的全量对话列表
let _subModes = [];                 // 子模式角色链（work/code 一窗多卡用，getSubModes 拿）
let _pickerVisible = false;
let _pickerChar = "";               // 添加链路选中的角色卡名（当前简化为一步选卡即建链）

// 确诊-D：走守卫单源 getChatId()（sharedState.mjs:108，内含 _CHATID_RE 校验）——非法 hash
//   （分段气泡/IDE 内部锚点）返 ""，不再裸读 substring 当 chatid 送后端（getTasks/checkTask 分区键）写脏分区。
//   对齐 subModePanel.mjs:100-104 _getCurrentChatId 范式（window 全局单源，无需新增 import）。
function _cur() { return window._beiluGetChatId?.() || ""; }

const _esc = escapeHtml; // T7：alias 到唯一权威实现（原本地 replace 链缺单引号转义，已删）

// [合并批 0714] _getUsername 手抄副本删除 → sharedState.getUsername 单源（别名保调用点不变）

/** verb 直调 beilu-memory setData（username 由后端登录态注入，前端可不传）。 */
async function _mem(verb, payload) {
  return sendAction({ verb, target: "plugins:beilu-memory", source: "web", payload: { username: _getUsername(), ...payload } });
}

// ── 收起视图态（localStorage，不删永久链路）─────────────────────────────
// P2（一致性审计②）：裸 localStorage → storage 门面（容错在门面内；JSON 解析仍需本地 try）
function _loadCollapsed() {
  try {
    const raw = storage.get(_COLLAPSED_KEY);
    _collapsedChars = new Set(raw ? JSON.parse(raw) : []);
  } catch { _collapsedChars = new Set(); }
}
function _saveCollapsed() {
  storage.set(_COLLAPSED_KEY, JSON.stringify([..._collapsedChars]));
}

// ── 永久链路（后端权威）────────────────────────────────────────────────
async function _loadCharLinks() {
  try {
    const r = await _mem("getCharLinks", {});
    _charLinks = Array.isArray(r?.permanent_char_links) ? r.permanent_char_links : [];
  } catch { _charLinks = []; }
}
async function _addCharLink(charName) {
  if (!charName) return;
  try {
    const r = await _mem("addCharLink", { charName });
    if (Array.isArray(r?.permanent_char_links)) _charLinks = r.permanent_char_links;
  } catch (e) { console.warn("[cardsPanel] addCharLink failed:", e?.message); }
}
async function _removeCharLink(charName) {
  if (!charName) return;
  try {
    const r = await _mem("removeCharLink", { charName });
    if (Array.isArray(r?.permanent_char_links)) _charLinks = r.permanent_char_links;
  } catch (e) { console.warn("[cardsPanel] removeCharLink failed:", e?.message); }
}

// ── 一次性迁移：旧 chatid Set → charName 永久链路 ────────────────────────
async function _migrateOldWindows() {
  const raw = storage.get(_OLD_PARALLEL_WINDOWS_KEY);
  if (!raw) return;
  let oldIds = [];
  try { oldIds = JSON.parse(raw); } catch { oldIds = []; }
  if (!Array.isArray(oldIds) || oldIds.length === 0) {
    storage.remove(_OLD_PARALLEL_WINDOWS_KEY);
    return;
  }
  // 旧值是 chatid，映射到 charName（经 fetchChatList），去重后逐个建永久链路。
  try { _allChats = await fetchChatList(); } catch { /* use cache */ }
  const chars = new Set();
  for (const cid of oldIds) {
    const chat = _allChats.find(c => (c.chatid || c.id) === cid);
    const cn = chat ? _chatCharName(chat) : "";
    if (cn) chars.add(cn);
  }
  for (const cn of chars) {
    if (!_charLinks.includes(cn)) await _addCharLink(cn);
  }
  // 迁移完成清旧键（升维一次，不丢用户已开窗口）。
  storage.remove(_OLD_PARALLEL_WINDOWS_KEY);
}

const _TASK_ICON = { completed: "✓", in_progress: "▶", pending: "○" };

function _renderTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return `<div class="cardp-task-empty">（本对话无任务）</div>`;
  }
  return tasks.map((t) => {
    const st = t.status || "pending";
    const icon = _TASK_ICON[st] || "○";
    return `<div class="cardp-task ${_esc(st)}" data-tid="${_esc(t.id)}" data-st="${_esc(st)}" title="${_esc(t.content || "")}">`
      + `<span class="cardp-task-ic">${icon}</span>`
      + `<span class="cardp-task-tx">${_esc(String(t.content || "").slice(0, 40))}</span></div>`;
  }).join("");
}

/** 按角色卡名聚合对话 */
function _groupByChar(chats) {
  const m = new Map();
  for (const c of chats || []) {
    const char = _chatCharName(c);
    if (!char) continue;
    if (!m.has(char)) m.set(char, []);
    m.get(char).push(c);
  }
  return m;
}

/** 获取对话可读名 */
function _convLabel(chat) {
  try {
    const meta = JSON.parse(storage.get(KEYS.BEILU_CONVERSATION_META) || "{}");
    const cm = meta[chat.chatid || chat.id] || {};
    return chat.customName || cm.label || chat.firstUserMessage || (chat.chatid || chat.id).substring(0, 8) + "…";
  } catch {
    return chat.customName || chat.firstUserMessage || (chat.chatid || chat.id).substring(0, 8) + "…";
  }
}

/** 获取对话所属角色卡名 */
function _chatCharName(chat) {
  return chat.primaryCharName || (Array.isArray(chat.chars) && chat.chars[0]) || "";
}

// ── 获取当前对话的任务清单 ──────────────────────────────────────────────
async function _fetchCurTasks() {
  const cur = _cur();
  if (!cur) return null;
  try {
    const r = await _mem("getTasks", { chatid: cur });
    return Array.isArray(r?.tasks) ? r.tasks : (Array.isArray(r?.data) ? r.data : []);
  } catch { return []; }
}

// [0717 async-order guard, audit H4] render token (same pattern as taskItemPanel /
// conversationManager): _render is re-entrant (hashchange/mode events fire in bursts) and
// rebuilds the whole panel via innerHTML after two awaits - only the latest call may paint.
let _renderSeq = 0;
async function _render() {
  if (!_root) return;
  const _seq = ++_renderSeq;
  try { _allChats = await fetchChatList(); } catch { /* use cache */ }
  if (_seq !== _renderSeq) return; // a newer render started during the await - yield to it
  const cur = _cur();
  const mode = getCurrentMode() || "chat";
  // smart 独立窗口分类（六域纠察缺陷2/3，随 0706 smart 升独立模式值）：原三元把 smart 坍缩成 chat=
  //   bot 面板把全智能窗口显示为"闲聊窗口"。凛倾拍板 4 模式独立分类。
  const modeGroup = (mode === "work") ? "work" : (mode === "code" ? "code" : (mode === "smart" ? "smart" : "chat"));
  const convByChar = _groupByChar(_allChats);
  const curTasks = await _fetchCurTasks();
  if (_seq !== _renderSeq) return; // second await, same yield

  // ── 外层：窗口(模式)分类头 ──────────────────────────────────────────
  // [D2 收口 0713·凛倾「哪里来的设计?」] 窗口名从 MODE_BADGE 权威派生（原手抄"闲聊窗口"与全系统
  //   "聊天"文案分叉；0709"场景化不收口"注释查证=当时审计 AI 自我判定，无拍板依据）。
  const _MODE_LABEL = Object.fromEntries(Object.entries(MODE_BADGE).map(([m, c]) => [m, `${c.label}窗口`]));
  let html = `<div class="cardp-modehead" data-mode="${_esc(modeGroup)}">${_esc(_MODE_LABEL[modeGroup] || modeGroup)}</div>`;

  // ── 内层：角色卡实例。渲染源 = 永久链路 + 「当前对话所属卡」兜底可见。──
  //   当前卡兜底=保证正在用的卡始终可见（刷新/切卡不消失），不自动写后端链路
  //   （链路仍需用户显式「＋添加」建立，符合「添加角色卡=增加永久链路」的显式语义）；
  //   未建链的当前卡标记 unlinked，提供「固定为永久链路」入口。
  const _curChat = cur ? _allChats.find(c => (c.chatid || c.id) === cur) : null;
  const _curCharName = _curChat ? _chatCharName(_curChat) : "";
  const _displayChars = [..._charLinks];
  if (_curCharName && !_displayChars.includes(_curCharName)) _displayChars.push(_curCharName);

  if (_displayChars.length === 0) {
    html += `<div class="cardp-empty">暂无永久链路，点下方＋添加角色卡</div>`;
  }
  for (const charName of _displayChars) {
    const convs = convByChar.get(charName) || [];
    const collapsed = _collapsedChars.has(charName);
    const isLinked = _charLinks.includes(charName); // false=当前卡兜底显示，未建永久链路
    // 该卡是否有运行中的线（任一对话在跑）
    const running = convs.some(c => _activeLines.has(c.chatid || c.id));

    html += `<div class="cardp-card${isLinked ? "" : " unlinked"}" data-char="${_esc(charName)}">`;
    html += `<div class="cardp-head" data-toggle="${_esc(charName)}" title="${_esc(charName)}${isLinked ? "" : "（未固定链路）"}">`;
    html += `<span class="cardp-ar">${collapsed ? "▶" : "▼"}</span>`;
    if (running) html += `<span class="cardp-run">●</span>`;
    html += `<span class="cardp-name">${_esc(charName)}</span>`;
    html += `<span class="cardp-cnt">${convs.length}</span>`;
    if (isLinked) {
      // ×=收起视图态；⊗=显式移除永久链路（二次确认）
      html += `<span class="cardp-collapse" data-collapse="${_esc(charName)}" title="${collapsed ? "展开" : "收起"}">×</span>`;
      html += `<span class="cardp-unlink" data-unlink="${_esc(charName)}" title="移除链路（永久断链）">⊗</span>`;
    } else {
      // 未建链的当前卡：提供「固定为永久链路」入口（📌=建链）
      html += `<span class="cardp-pin" data-pin="${_esc(charName)}" title="固定为永久链路"><i data-ic="pin"></i></span>`;
    }
    html += `</div>`;

    if (!collapsed) {
      html += `<div class="cardp-convs">`;
      if (convs.length === 0) {
        html += `<div class="cardp-task-empty">（无对话，点＋新建）</div>`;
      }
      for (const c of convs) {
        const cid = c.chatid || c.id;
        const isCur = cid === cur;
        const cRunning = _activeLines.has(cid);
        const label = _convLabel(c);
        html += `<div class="cardp-conv${isCur ? " cur" : ""}" data-cid="${_esc(cid)}" title="${_esc(label)}${cRunning ? " · 运行中" : ""}">`;
        if (cRunning) html += `<span class="cardp-run">●</span>`;
        html += `${_esc(label)}</div>`;
      }
      // 卡内新建对话入口（卡之下子级）
      html += `<div class="cardp-conv cardp-conv-new" data-newconv="${_esc(charName)}">＋ 新建对话</div>`;
      // 当前对话在本卡内时，展示任务清单
      if (cur && curTasks && convs.some(c => (c.chatid || c.id) === cur)) {
        html += `<div class="cardp-tasks" data-cid="${_esc(cur)}">${_renderTasks(curTasks)}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // ── work/code：一窗内多角色卡 = 子模式角色链（读既有 getSubModes，不新造数据）──
  if (modeGroup !== "chat" && Array.isArray(_subModes) && _subModes.length > 0) {
    // [D4 0713] `|| "code"` 内联默认删除：sub_modes 存储不变式（getSubModes 迁移+saveSubModes 归一）保证字段必在
    const chainModes = _subModes.filter(m => m.modeGroup === modeGroup);
    if (chainModes.length > 0) {
      html += `<div class="cardp-modehead cardp-submodehead" title="${_esc(modeGroup)} 子模式角色链（一窗多角色卡）">${_esc(modeGroup)} 角色链</div>`;
      html += `<div class="cardp-convs cardp-submode-list">`;
      for (const sm of chainModes) {
        html += `<div class="cardp-conv cardp-submode" data-submode="${_esc(sm.id)}" title="${_esc(sm.desc || sm.label || sm.id)}">${_esc(sm.icon || "")} ${_esc(sm.label || sm.id)}</div>`;
      }
      html += `</div>`;
    }
  }

  // ── 添加永久链路按钮 ───────────────────────────────────────────────
  html += `<button class="cardp-add" data-act="new" title="添加角色卡（建永久链路）">＋ 添加角色卡链路</button>`;

  // ── 选择器弹窗（选角色卡即建永久链路）─────────────────────────────
  if (_pickerVisible) html += _renderPicker(convByChar);

  _root.innerHTML = html;
}

function _renderPicker(convByChar) {
  let html = '<div class="cardp-picker">';
  html += '<div class="cardp-picker-title">选择角色卡（建永久链路）</div>';
  // 列出所有有对话归属的角色卡，已建链路的标记
  const all = convByChar || _groupByChar(_allChats);
  let n = 0;
  for (const [char] of all) {
    const linked = _charLinks.includes(char);
    html += `<div class="cardp-picker-item${linked ? " linked" : ""}" data-pick-char="${_esc(char)}">${_esc(char)}${linked ? " ✓" : ""}</div>`;
    n++;
  }
  if (n === 0) html += '<div class="cardp-picker-empty">暂无角色卡</div>';
  html += '<div class="cardp-picker-item cardp-picker-cancel" data-act="cancel">取消</div>';
  html += '</div>';
  return html;
}

async function _handlePickerClick(e) {
  const charEl = e.target.closest("[data-pick-char]");
  if (charEl) {
    const char = charEl.dataset.pickChar;
    await _addCharLink(char); // 选卡=建永久链路（幂等：已存在不重复）
    // 展开该卡（清收起态），并切到该卡最近一个对话（若有）
    _collapsedChars.delete(char);
    _saveCollapsed();
    const convs = _groupByChar(_allChats).get(char) || [];
    if (convs.length > 0) await switchToChat(convs[0].chatid || convs[0].id);
    _pickerVisible = false;
    _render();
    return true;
  }
  if (e.target.closest('[data-act="cancel"]')) {
    _pickerVisible = false;
    _render();
    return true;
  }
  return false;
}

export function initCardsPanel(rootId = "ide-cards-body") {
  if (_initialized) return;
  _root = document.getElementById(rootId);
  if (!_root) return;
  _initialized = true;
  _loadCollapsed();

  const toggleBtn = document.getElementById("ide-rightbar-toggle");
  const rightbar = document.getElementById("ide-rightbar");
  if (toggleBtn && rightbar) {
    toggleBtn.addEventListener("click", () => {
      rightbar.classList.toggle("collapsed");
      const arrow = toggleBtn.querySelector("[data-ic]");
      if (arrow) arrow.setAttribute("data-ic", rightbar.classList.contains("collapsed") ? "arrow-down" : "arrow-right");
    });
  }

  _root.addEventListener("click", async (e) => {
    // 选择器弹窗事件优先
    if (_pickerVisible) {
      const handled = await _handlePickerClick(e);
      if (handled) return;
    }

    // 固定为永久链路（把当前兜底可见的卡建成永久链路）
    const pinBtn = e.target.closest("[data-pin]");
    if (pinBtn) {
      await _addCharLink(pinBtn.dataset.pin);
      _render();
      return;
    }

    // 移除永久链路（显式断链，二次确认）
    const unlinkBtn = e.target.closest("[data-unlink]");
    if (unlinkBtn) {
      const char = unlinkBtn.dataset.unlink;
      const ok = await beiluConfirm(`移除角色卡「${char}」的永久链路？\n（这会断开该卡的窗口链路，不删除角色卡本身的对话/记忆数据）`);
      if (ok) { await _removeCharLink(char); _render(); }
      return;
    }

    // 收起/展开（视图态，不删链路）
    const collapseBtn = e.target.closest("[data-collapse]");
    if (collapseBtn) {
      const char = collapseBtn.dataset.collapse;
      if (_collapsedChars.has(char)) _collapsedChars.delete(char); else _collapsedChars.add(char);
      _saveCollapsed();
      _render();
      return;
    }

    // 点卡头折叠/展开
    const toggle = e.target.closest("[data-toggle]");
    if (toggle && !e.target.closest("[data-collapse]") && !e.target.closest("[data-unlink]")) {
      const char = toggle.dataset.toggle;
      if (_collapsedChars.has(char)) _collapsedChars.delete(char); else _collapsedChars.add(char);
      _saveCollapsed();
      _render();
      return;
    }

    // 卡内新建对话
    const newConv = e.target.closest("[data-newconv]");
    if (newConv) {
      await doCreateNewChat();
      _render();
      return;
    }

    // 任务打勾
    const task = e.target.closest(".cardp-task");
    if (task) {
      const tid = task.dataset.tid;
      const next = task.dataset.st === "completed" ? "pending" : "completed";
      try { await _mem("checkTask", { id: tid, status: next, chatid: _cur() }); } catch { /* ignore */ }
      _render();
      return;
    }

    // 点对话切换（卡之下子级，保留原对话切换）
    const conv = e.target.closest(".cardp-conv[data-cid]");
    if (conv) {
      await switchToChat(conv.dataset.cid);
      _render();
      return;
    }

    // 添加永久链路
    if (e.target.closest('[data-act="new"]')) {
      _pickerVisible = true;
      try { _allChats = await fetchChatList(); } catch { /* use cache */ }
      _render();
    }
  });

  window.addEventListener("hashchange", _render);
  window.addEventListener("beilu:task-update", _render);
  // 模式切换（外层窗口分类变化）：featureControls.mjs:534 / websocket.mjs:857 派发 beilu:mode-switched。
  window.addEventListener("beilu:mode-switched", whenVisible("#center-tab-bot", () => { _loadSubModes().then(_render); }));
  window.addEventListener("beilu:group-runtime-update", (e) => {
    const al = e.detail?.activeLines;
    if (Array.isArray(al)) { _activeLines = new Set(al); _render(); }
  });

  // 首次加载：拉永久链路 + 迁移旧窗口 + 拉子模式链，再渲染。
  (async () => {
    await _loadCharLinks();
    await _migrateOldWindows();
    await _loadSubModes();
    _render();
  })();
}

// ── 子模式角色链（work/code 一窗多卡呈现，读既有单源）───────────────────
async function _loadSubModes() {
  try {
    const r = await _mem("getSubModes", {});
    _subModes = Array.isArray(r?.sub_modes) ? r.sub_modes : [];
  } catch { _subModes = []; }
}

export function refreshCardsPanel() { _render(); }
