/**
 * taskItemPanel.mjs — FT1「任务条目面板」（IDE/work 任务台，跨对话超集视图）
 *
 * 功能链：
 *   mountTaskItemPanel(mountId?) → _render → 并行拉取：
 *     ① POST beilu-memory setdata {_action:"getChatList"} → 按当前角色卡过滤对话列表
 *     ② POST {_action:"getCheckpointList"} → 获取 IDE 会话级回档时间线（全局，无 per-chatId 过滤）
 *   → 渲染当前对话（展开，含任务清单 + 回档时间线）+ 「其他对话」折叠组
 *   任务清单行：点勾选 → POST {_action:"checkTask", chatid}
 *     → 状态循环（pending→in_progress→completed）→ await 后端成功后重渲
 *       （[2026-07-11 C6 注释校准] 原"本地乐观更新"失实：实现是 await 后提交，无失败脏状态）
 *   回档时间线：点某检查点 → loadCheckpointDiff(idePanel) → 弹 diff 预览卡
 *     → 点「确认回档」→ revertCheckpoint(idePanel) → 后端执行回档 → 刷新面板
 *   beilu:task-update 推送 → 局部刷新对应 chatId 的 _taskCache → 重渲该条目
 *   mountId 可重指（ide control #ide-task-panel / work 任务台容器互斥显示，单例重指）
 *
 * why（防双源 §2.4）：
 *   与 #task-card 同读 taskStore（唯一权威），同写同一套 action，同监听 beilu:task-update；
 *   本面板是 taskCard 的「跨对话超集 + 回档维度」投影，不持本地 task 副本，不抄第二份数据。
 *   回档 diff 预览卡复用 idePanel._showRevertPreview（revertCheckpoint 内部调），不另写。
 *
 * 关联链：
 *   → panels/code/idePanel.mjs revertCheckpoint / loadCheckpointDiff（回档操作复用）
 *   → shared/transport/api-client.mjs apiFetch（所有 taskStore/checkpoint REST 调用）
 *   → shared/state/storage.mjs KEYS.BEILU_LAST_CHAR（当前角色卡名，过滤用）
 *   ← workPanel.mjs mountTaskItemPanel（工作 Tab 任务台挂载）
 *   ← layout.mjs（IDE 控制区 #ide-task-panel 挂载）
 *   ← beilu:task-update（局部刷新，与 taskCard 同消费同一事件）
 *
 * 影响范围：
 *   #ide-task-panel 或 work 任务台容器 DOM；_taskCache / _checkpointsCache 内存缓存；
 *   _expanded Set（哪些 chatId 条目展开）；后端 tasks.json（checkTask 写回）。
 *
 * 使用效果：
 *   任务面板展示当前角色卡所有对话的任务，当前对话默认展开；
 *   点勾打勾，点检查点预览 diff，确认后一键回档到该历史状态。
 */

import { showToast } from "../../../../../../scripts/toast.mjs";
import { escapeHtml, whenVisible } from "../../shared/state/utils.mjs";
import { revertCheckpoint, loadCheckpointDiff } from "../code/idePanel.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory setdata + 对话列表收口
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { getUsername as _getUsername } from "../../shared/state/sharedState.mjs"; // [合并批 0714] username 读点单源（别名保调用点）

// 挂载容器可重指（ide control 内 #ide-task-panel / work 任务台容器互斥显示，单例重指）
let _mountId = "ide-task-panel";
let _panelEl = null;
let _initialized = false;
// 展开态记忆：哪些 chatId 条目当前展开（折叠/展开切换时保持）
const _expanded = new Set();
// 各 chatId 的 tasks 缓存（展开后填，beilu:task-update 推送时局部刷新用）
const _taskCache = new Map();
// 全局 checkpoint 列表缓存（IDE 会话级，挂当前活动 chatId 条目）
let _checkpointsCache = [];

const _STATUS_META = {
  completed: { icon: "✓", cls: "text-success line-through opacity-60", iconCls: "text-success" },
  in_progress: { icon: "▶", cls: "text-warning", iconCls: "text-warning" },
  pending: { icon: "○", cls: "text-base-content/70", iconCls: "text-base-content/40" },
};

// [合并批 0714] _getUsername 手抄副本删除 → sharedState.getUsername 单源

// 当前窗口 chatId（per-chatId 隔离，与 taskCard 同款解析）。
// [T047] 走守卫单一权威 getChatId()（sharedState.mjs:108，_CHATID_RE 校验）——
// 非法 hash 返 ""，不再裸读当 chatid POST beilu-memory 写脏 taskStore 分区键。
// [2026-07-13] 原 `|| window._beiluCurrentChatId` 次级兜底删除：全根 grep 零写点=从未被赋值的幽灵值。
function _getCurrentChatId() {
  return window._beiluGetChatId?.() || "";
}

// 当前角色卡名（与 conversationManager.getCurrentCharName 同序：sharedState → localStorage → 从列表推断）
function _getCurrentCharName(allChats) {
  const shared = window._beiluGetCharName?.();
  if (shared) return shared;
  const saved = storage.get(KEYS.BEILU_LAST_CHAR);
  if (saved) return saved;
  const curId = _getCurrentChatId();
  const cur = curId && allChats.find((c) => _entryChatId(c) === curId);
  return cur?.primaryCharName || cur?.chars?.[0] || "";
}

// 角色卡过滤（与 conversationManager 同款：primaryCharName 精确 OR 旧数据 chars 包含）
function _charMatches(c, charName) {
  if (!charName) return true;
  if (c.primaryCharName) return c.primaryCharName === charName;
  return Array.isArray(c.chars) && c.chars.includes(charName);
}

/** setdata 调用（带 username + 指定 chatid，复用 taskStore per-chatId 隔离）。 */
async function _sd(action, body, chatid) {
  // T6b批7：原 raw fetch（POST setdata + 自 .json()）→ sendAction 门面。verb=真动作，
  // payload 平铺由 beilu-memory#* 通配路由重组 {_action:verb,...payload}，行为等价。
  return sendAction({
    verb: action,
    target: "plugins:beilu-memory",
    source: "web",
    payload: { username: _getUsername(), chatid, ...body },
  });
}

/** 把面板重指到另一容器并立即渲染（ide↔work 模式互斥，监听器只在 init 绑一次） */
export function mountTaskItemPanel(containerId) {
  if (!containerId || _mountId === containerId) {
    if (containerId) _render();
    return;
  }
  const el = document.getElementById(containerId);
  if (!el) return;
  // 清空旧容器：避免隐藏模式里残留同 id 子元素（task-item-summary 等）被全局查询误命中
  const old = document.getElementById(_mountId);
  if (old) old.innerHTML = "";
  _mountId = containerId;
  _panelEl = el;
  if (!_initialized) { initTaskItemPanel(); return; }
  _render();
}

export function initTaskItemPanel() {
  if (_initialized) return;
  _initialized = true;
  if (!_panelEl) _panelEl = document.getElementById(_mountId);
  if (!_panelEl) return;

  // 防双源：与 #task-card 同听 task_update 推送，任一处改动两处同步刷新（§2.4）
  window.addEventListener("beilu:task-update", (e) => {
    const d = e.detail || {};
    if (d.chatid && Array.isArray(d.tasks)) {
      _taskCache.set(d.chatid, { tasks: d.tasks, rev: d.rev });
      // 当前对话任务区常显必刷；其他对话条目仅展开态局部刷新，避免整面板抖动
      if (d.chatid === _getCurrentChatId() || _expanded.has(d.chatid)) _renderTaskSection(d.chatid);
      _refreshEntryCount(d.chatid, d.tasks);
    }
  });

  window.addEventListener("beilu:smart-task-update", () => {
    if (_panelEl) _renderCrossModeTasks();
  });

  window.addEventListener("character-switched", whenVisible("#ide-task-panel", () => {
    _expanded.clear();
    _taskCache.clear();
    _checkpointsCache = [];
    if (_panelEl) _render();
  }));

  // 切窗口 / 切聊天 → 当前活动条目变化，重渲染（高亮当前 + 回档区归位）
  window.addEventListener("hashchange", () => _render());
  // 回档执行后检查点已销毁（idePanel._executeRevert 广播）→ 重拉时间线
  window.addEventListener("beilu:checkpoint-update", () => _render());

  _render();
}

/** 拉对话列表（复用现有 getchatlist endpoint，非新后端）。 */
async function _fetchChatList() {
  try {
    // T6b批7：原 raw fetch → sendAction shells:chat#getChatList（!ok 由门面抛错走 catch → 与原 !res.ok 分支同返 []）。
    const arr = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    // T021 弹出：面板打开拉列表失败原样返空=用户看到空面板无从得知失败
    showToast("error", "对话列表加载失败: " + (e?.message || e));
    return [];
  }
}

/**
 * 拉**本条线**的 checkpoint 列表（0727 池化配套）。
 * 【why 必须带 chatid】CLI 侧 checkpoint 已按窗口/线分池（executor._checkpointFor，键=_window_id=chatid），
 *   后端 getCheckpointList 也早就支持按 chatid 路由到该线所绑的执行端；只有前端一直不传，
 *   于是拿回来的是"主连接那条线"的时间线，却挂在当前对话行上显示——多线下等于让用户对着
 *   **别的线**的快照点回档（破坏性）。带上当前线 id，显示与回档的对象才是同一条线。
 */
async function _fetchCheckpoints() {
  try {
    const data = await _sd("getCheckpointList", {}, _getCurrentChatId());
    _checkpointsCache = Array.isArray(data?.checkpoints) ? data.checkpoints : [];
  } catch (_) {
    _checkpointsCache = [];
  }
  return _checkpointsCache;
}

// 渲染序号令牌（conversationManager Drift #3 同款）：hashchange 并发触发时旧 fetch 不准覆盖新 DOM
let _renderSeq = 0;

/** 面板主渲染：主轴=当前对话任务（汇总行+清单+回档时间线），其他对话折叠组（角色卡过滤）。 */
/** 取当前活的挂载节点：侧栏面板切换会销毁重建同 ID 容器，缓存节点可能已 detached */
function _host() {
  const live = document.getElementById(_mountId);
  if (live) _panelEl = live;
  return _panelEl;
}

async function _render() {
  if (!_host()) return;
  const seq = ++_renderSeq;
  const curId = _getCurrentChatId();

  _panelEl.innerHTML =
    `<div class="flex items-center justify-between mb-1">` +
      `<p class="text-xs font-medium" style="color:var(--beilu-amber)"><i data-ic="clipboard"></i> 任务 / 回档</p>` +
      `<button id="task-item-refresh" class="btn btn-xs btn-ghost text-base-content/40" title="刷新"><i data-ic="refresh"></i></button>` +
    `</div>` +
    `<div id="task-item-summary" class="text-[11px] text-base-content/50 mb-1">加载中…</div>` +
    `<div class="task-item-tasks text-[11px]" data-id="${escapeHtml(curId)}"></div>` +
    `<div class="task-item-cps text-[11px]" data-id="${escapeHtml(curId)}"></div>` +
    `<div id="task-item-others" class="text-[11px]"></div>`;

  _host()?.querySelector("#task-item-refresh")?.addEventListener("click", () => _render());

  if (!curId) {
    const sum = _host()?.querySelector("#task-item-summary");
    if (sum) sum.textContent = "未打开对话";
    return;
  }

  const [chats] = await Promise.all([_fetchChatList(), _fetchCheckpoints()]);
  if (seq !== _renderSeq) return;

  // 主轴：当前对话任务 + 回档时间线
  await _loadEntryDetail(curId);
  if (seq !== _renderSeq) return;
  _refreshSummary((_taskCache.get(curId) || {}).tasks || []);

  // 其他对话：当前角色卡过滤 → 折叠组
  const charName = _getCurrentCharName(chats);
  const others = chats.filter((c) => _entryChatId(c) !== curId && _charMatches(c, charName));
  _renderOthersGroup(others, curId);
}

/** CC tasks 式汇总行：`N tasks（x done · y in progress · z open）`。 */
function _refreshSummary(tasks) {
  const el = _host()?.querySelector("#task-item-summary");
  if (!el) return;
  const total = tasks.length;
  if (total === 0) { el.textContent = "当前对话暂无任务"; return; }
  const done = tasks.filter((t) => t.status === "completed").length;
  const prog = tasks.filter((t) => t.status === "in_progress").length;
  el.textContent = `${total} 个任务（${done} 完成 · ${prog} 进行中 · ${total - done - prog} 待办）`;
  el.className = done === total ? "text-[11px] text-success mb-1" : "text-[11px] text-base-content/50 mb-1";
}

// 「其他对话」折叠组展开态（默认收起，对话为主角）
let _othersOpen = false;

function _renderOthersGroup(others, curId) {
  const host = _host()?.querySelector("#task-item-others");
  if (!host) return;
  if (others.length === 0) { host.innerHTML = ""; return; }
  host.innerHTML =
    `<div id="task-item-others-head" class="flex items-center gap-1 py-0.5 px-1 cursor-pointer hover:bg-base-100/50 border-t border-base-300/30 mt-1 text-base-content/50" title="同角色卡其他对话的任务">` +
      `<span class="w-3 text-center">${_othersOpen ? "▾" : "▸"}</span>` +
      `<span><i data-ic="folders"></i> 其他对话（${others.length}）</span>` +
    `</div>` +
    `<div id="task-item-others-body" class="space-y-1 ${_othersOpen ? "" : "hidden"}">` +
      others.map((c) => _renderEntryShell(c, curId)).join("") +
    `</div>`;
  _host()?.querySelector("#task-item-others-head")?.addEventListener("click", () => {
    _othersOpen = !_othersOpen;
    _renderOthersGroup(others, curId);
  });
  _wireEntryEvents();
  if (_othersOpen) {
    for (const id of _expanded) {
      if (others.some((c) => _entryChatId(c) === id)) _loadEntryDetail(id);
    }
  }
}

function _entryChatId(c) { return c.chatid || c.id || ""; }
function _entryTitle(c) {
  return c.title || c.name || c.primaryCharName || (c.chars && c.chars[0]) || _entryChatId(c) || "对话";
}
function _entryIcon(c) {
  // 模式图标降级：有 mode 字段用之，否则统一 💬
  const m = c.mode || c.activeMode || "";
  if (m === "code" || m === "files") return '<i data-ic="code"></i>';
  if (m === "work") return '<i data-ic="clipboard"></i>';
  return '<i data-ic="message"></i>';
}

/** 单条目外壳（折叠态：箭头 + 图标 + 标题 + 任务计数 + 回档标记）。 */
function _renderEntryShell(c, curId) {
  const id = _entryChatId(c);
  const isCur = id === curId;
  const open = _expanded.has(id);
  const cnt = _taskCache.get(id);
  let countHtml = `<span class="task-item-count text-base-content/40 shrink-0" data-id="${escapeHtml(id)}">…</span>`;
  if (cnt && Array.isArray(cnt.tasks)) countHtml = _countLabel(id, cnt.tasks);
  const cpMark = isCur && _checkpointsCache.length
    ? `<span class="text-base-content/40 shrink-0" title="有检查点可回档">⟲${_checkpointsCache.length}</span>`
    : "";
  return (
    `<div class="task-item-entry rounded border-b border-base-300/30 last:border-0 ${isCur ? "bg-base-100/40" : ""}" data-id="${escapeHtml(id)}">` +
      `<div class="task-item-head flex items-center gap-1 py-0.5 px-1 cursor-pointer hover:bg-base-100/50" data-id="${escapeHtml(id)}" title="点击展开/收起">` +
        `<span class="task-item-arrow w-3 text-center text-base-content/50">${open ? "▾" : "▸"}</span>` +
        `<span class="shrink-0">${_entryIcon(c)}</span>` +
        `<span class="flex-1 truncate ${isCur ? "font-medium" : ""}">${escapeHtml(_entryTitle(c))}</span>` +
        countHtml +
        cpMark +
      `</div>` +
      `<div class="task-item-body pl-4 pr-1 pb-1 space-y-1 ${open ? "" : "hidden"}" data-id="${escapeHtml(id)}">` +
        `<div class="task-item-tasks" data-id="${escapeHtml(id)}"></div>` +
        `<div class="task-item-cps" data-id="${escapeHtml(id)}"></div>` +
      `</div>` +
    `</div>`
  );
}

function _countLabel(id, tasks) {
  const remaining = tasks.filter((t) => t.status !== "completed").length;
  const total = tasks.length;
  if (total === 0) return `<span class="task-item-count text-base-content/30 shrink-0" data-id="${escapeHtml(id)}">无任务</span>`;
  const cls = remaining === 0 ? "text-success" : "text-base-content/40";
  const txt = remaining === 0 ? "全完成" : `剩${remaining}`;
  return `<span class="task-item-count ${cls} shrink-0" data-id="${escapeHtml(id)}">${txt}·共${total}</span>`;
}

function _refreshEntryCount(id, tasks) {
  if (id === _getCurrentChatId()) _refreshSummary(tasks);
  const el = _host()?.querySelector(`.task-item-count[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = _countLabel(id, tasks);
  el.replaceWith(tmp.firstChild);
}

function _wireEntryEvents() {
  if (!_panelEl) return;
  _panelEl.querySelectorAll(".task-item-head").forEach((h) =>
    h.addEventListener("click", () => _toggleEntry(h.dataset.id)),
  );
}

function _toggleEntry(id) {
  if (!id) return;
  const body = _host()?.querySelector(`.task-item-body[data-id="${CSS.escape(id)}"]`);
  const arrow = _host()?.querySelector(`.task-item-head[data-id="${CSS.escape(id)}"] .task-item-arrow`);
  if (!body) return;
  if (_expanded.has(id)) {
    _expanded.delete(id);
    body.classList.add("hidden");
    if (arrow) arrow.textContent = "▸";
  } else {
    _expanded.add(id);
    body.classList.remove("hidden");
    if (arrow) arrow.textContent = "▾";
    _loadEntryDetail(id);
  }
}

/** 展开后并行拉任务清单 + 渲染回档时间线（当前 chatId 才有 checkpoint）。 */
async function _loadEntryDetail(id) {
  // 任务：拉 getTasks（per-chatId）→ 缓存 → 渲染
  try {
    const data = await _sd("getTasks", {}, id);
    if (data && data.success && Array.isArray(data.tasks)) {
      _taskCache.set(id, { tasks: data.tasks, rev: data.rev });
      _refreshEntryCount(id, data.tasks);
    }
  } catch (_) { /* 保留缓存 */ }
  _renderTaskSection(id);
  _renderCheckpointSection(id);
}

/** 渲染条目内任务清单（复用 taskStore 数据 + checkTask/updateTask/deleteTask/planTasks 写回）。 */
function _renderTaskSection(id) {
  const host = _host()?.querySelector(`.task-item-tasks[data-id="${CSS.escape(id)}"]`);
  if (!host) return;
  const cached = _taskCache.get(id);
  const tasks = cached?.tasks || [];
  if (tasks.length === 0) {
    // 空态文案由汇总行/条目计数承担（不重复），任务区只留添加入口
    host.innerHTML =
      `<button class="task-item-add btn btn-ghost btn-xs h-5 min-h-0 text-[10px] text-base-content/50" data-id="${escapeHtml(id)}"><i data-ic="plus"></i> 添加任务</button>`;
    _wireTaskEvents(id, host);
    return;
  }
  const rows = tasks.map((t) => {
    const meta = _STATUS_META[t.status] || _STATUS_META.pending;
    const done = t.status === "completed";
    const nextStatus = done ? "pending" : "completed";
    return (
      `<div class="task-item-row flex items-center gap-1.5 py-0.5 group" data-id="${escapeHtml(t.id)}">` +
        `<button class="task-item-toggle w-4 text-center ${meta.iconCls} hover:scale-110" ` +
          `data-id="${escapeHtml(t.id)}" data-next="${nextStatus}" title="点击切换完成状态">${meta.icon}</button>` +
        `<span class="task-item-content flex-1 ${meta.cls} truncate" data-id="${escapeHtml(t.id)}" ` +
          `data-content="${escapeHtml(t.content)}" title="${escapeHtml(t.content)}（双击编辑）">${escapeHtml(t.content)}</span>` +
        `<button class="task-item-del opacity-0 group-hover:opacity-100 text-error/60 hover:text-error text-[10px]" ` +
          `data-id="${escapeHtml(t.id)}" title="删除此项">✕</button>` +
      `</div>`
    );
  }).join("");
  host.innerHTML =
    `<div class="space-y-0.5">${rows}</div>` +
    `<div class="flex justify-end pt-0.5">` +
      `<button class="task-item-add btn btn-ghost btn-xs h-5 min-h-0 text-[10px] text-base-content/50" data-id="${escapeHtml(id)}"><i data-ic="plus"></i> 添加</button>` +
    `</div>`;
  _wireTaskEvents(id, host);
}

function _wireTaskEvents(id, host) {
  host.querySelectorAll(".task-item-toggle").forEach((b) =>
    b.addEventListener("click", () => _toggleTask(id, b.dataset.id, b.dataset.next)),
  );
  host.querySelectorAll(".task-item-del").forEach((b) =>
    b.addEventListener("click", () => _deleteTask(id, b.dataset.id)),
  );
  host.querySelectorAll(".task-item-content").forEach((s) =>
    s.addEventListener("dblclick", () => _editTaskInline(id, s)),
  );
  host.querySelector(".task-item-add")?.addEventListener("click", () => _addTask(id));
}

async function _toggleTask(chatid, taskId, nextStatus) {
  if (!taskId) return;
  try {
    const data = await _sd("checkTask", { id: taskId, status: nextStatus }, chatid);
    if (data && data.success && Array.isArray(data.tasks)) {
      _taskCache.set(chatid, { tasks: data.tasks, rev: data.rev });
      _renderTaskSection(chatid);
      _refreshEntryCount(chatid, data.tasks);
    } else showToast("error", "更新失败：" + (data?.error || "未匹配"));
  } catch (e) { showToast("error", "更新失败：" + (e.message || "网络错误")); }
}

async function _deleteTask(chatid, taskId) {
  if (!taskId) return;
  try {
    const data = await _sd("deleteTask", { id: taskId }, chatid);
    if (data && data.success && Array.isArray(data.tasks)) {
      _taskCache.set(chatid, { tasks: data.tasks, rev: data.rev });
      _renderTaskSection(chatid);
      _refreshEntryCount(chatid, data.tasks);
    } else showToast("error", "删除失败：" + (data?.error || "未匹配"));
  } catch (e) { showToast("error", "删除失败：" + (e.message || "网络错误")); }
}

function _editTaskInline(chatid, spanEl) {
  const taskId = spanEl.dataset.id;
  const old = spanEl.dataset.content || spanEl.textContent || "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = old;
  input.className = "input input-xs input-bordered flex-1 text-xs h-5 min-h-0";
  spanEl.replaceWith(input);
  input.focus();
  input.select();
  let _committed = false;
  const commit = async () => {
    if (_committed) return;
    _committed = true;
    const val = input.value.trim();
    if (!val || val === old) { _renderTaskSection(chatid); return; }
    try {
      const data = await _sd("updateTask", { id: taskId, content: val }, chatid);
      if (data && data.success && Array.isArray(data.tasks)) {
        _taskCache.set(chatid, { tasks: data.tasks, rev: data.rev });
        _renderTaskSection(chatid);
      } else { showToast("error", "保存失败：" + (data?.error || "未匹配")); _renderTaskSection(chatid); }
    } catch (e) { showToast("error", "保存失败：" + (e.message || "网络错误")); _renderTaskSection(chatid); }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") { _committed = true; _renderTaskSection(chatid); }
  });
}

/** 添加任务：➕ 按钮原位换 inline input（非 window.prompt——可见可编辑，风格一致），走原子 addTask action。 */
function _addTask(chatid) {
  const btn = _host()?.querySelector(`.task-item-add[data-id="${CSS.escape(chatid)}"]`);
  if (!btn) return;
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "新任务内容，Enter 确认";
  input.className = "input input-xs input-bordered w-full text-xs h-5 min-h-0";
  btn.replaceWith(input);
  input.focus();
  let _committed = false;
  const commit = async () => {
    if (_committed) return;
    _committed = true;
    const val = input.value.trim();
    if (!val) { _renderTaskSection(chatid); return; }
    try {
      const data = await _sd("addTask", { content: val }, chatid);
      if (data && data.success && Array.isArray(data.tasks)) {
        _taskCache.set(chatid, { tasks: data.tasks, rev: data.rev });
        _renderTaskSection(chatid);
        _refreshEntryCount(chatid, data.tasks);
      } else { showToast("error", "添加失败：" + (data?.error || "未知错误")); _renderTaskSection(chatid); }
    } catch (e) { showToast("error", "添加失败：" + (e.message || "网络错误")); _renderTaskSection(chatid); }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") { _committed = true; _renderTaskSection(chatid); }
  });
}

/**
 * 渲染回档时间线。checkpoint 是 IDE 会话级全局（无 per-chatId），故只在「当前活动 chatId」条目下展示，
 * 其它条目优雅降级为「此对话无检查点」（设计 §2.1 风险注，不报错）。
 * [diff] → loadCheckpointDiff（复用，渲染到下方 #ide-checkpoint-diff）；
 * [⟲回档] → revertCheckpoint（复用，内部已弹 _showRevertPreview 彩色 diff 预览卡，别重写）。
 */
function _renderCheckpointSection(id) {
  const host = _host()?.querySelector(`.task-item-cps[data-id="${CSS.escape(id)}"]`);
  if (!host) return;
  const isCur = id === _getCurrentChatId();
  // checkpoint 是 IDE 会话级全局：非当前对话不渲染（写「此对话无检查点」是误导）
  if (!isCur) { host.innerHTML = ""; return; }
  if (_checkpointsCache.length === 0) {
    host.innerHTML = `<div class="text-base-content/30 py-1 border-t border-base-300/30 mt-1 pt-1">暂无检查点（AI 改动文件时自动创建）</div>`;
    return;
  }
  // reverse 让最新在上
  const cps = _checkpointsCache.slice().reverse();
  const rows = cps.map((cp) => {
    const time = cp.timestamp ? new Date(cp.timestamp).toLocaleTimeString() : "";
    return (
      `<div class="task-item-cp flex items-center gap-1 py-0.5 font-mono text-[10px] border-b border-base-300/20 last:border-0">` +
        `<span>●</span>` +
        `<span class="flex-1 truncate" title="${escapeHtml(cp.id)}">${escapeHtml(String(cp.id).slice(0, 12))}</span>` +
        `<span class="text-base-content/40 shrink-0">${cp.fileCount ?? 0}文件 ${time}</span>` +
        `<button class="task-item-cp-diff text-info/70 hover:text-info shrink-0" data-cp-id="${escapeHtml(cp.id)}" title="查看彩色 diff">diff</button>` +
        `<button class="task-item-cp-revert text-error/70 hover:text-error shrink-0" data-cp-id="${escapeHtml(cp.id)}" title="回档此检查点（弹彩色 diff 预览确认）">⟲回档</button>` +
      `</div>`
    );
  }).join("");
  host.innerHTML =
    `<div class="border-t border-base-300/30 mt-1 pt-1">` +
      `<div class="text-base-content/40 mb-0.5"><i data-ic="folders"></i> 回档时间线</div>` +
      `<div class="space-y-0.5">${rows}</div>` +
    `</div>`;
  host.querySelectorAll(".task-item-cp-diff").forEach((b) =>
    b.addEventListener("click", () => loadCheckpointDiff(b.dataset.cpId)),
  );
  host.querySelectorAll(".task-item-cp-revert").forEach((b) =>
    b.addEventListener("click", () => revertCheckpoint(b.dataset.cpId)),
  );
}

function _renderCrossModeTasks() {
  if (!_panelEl) return;
  let _cmEl = _panelEl.querySelector("#task-cross-mode-section");
  const crossTasks = window._beiluCrossModeTasks || {};
  const crossEntries = Object.values(crossTasks);
  if (!crossEntries.length) {
    if (_cmEl) _cmEl.remove();
    return;
  }
  if (!_cmEl) {
    _cmEl = document.createElement("div");
    _cmEl.id = "task-cross-mode-section";
    _cmEl.className = "mt-2 border-t border-base-300/40 pt-2";
    _panelEl.appendChild(_cmEl);
  }
  const rows = crossEntries.map(t => {
    const tasks = t.tasks || [];
    const done = tasks.filter(x => x.status === "completed").length;
    return `<div class="text-xs opacity-70 py-0.5"><i data-ic="antenna"></i> ${escapeHtml(t.chatid?.substring(0,8) || "?")}… ${done}/${tasks.length} 任务</div>`;
  }).join("");
  _cmEl.innerHTML = `<div class="text-xs font-bold opacity-50 mb-1">跨窗口任务</div>${rows}`;
}
