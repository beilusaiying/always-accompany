/**
 * taskCard.mjs — 聊天流顶部常驻轻量任务卡（F3 §1.4 / G2）
 *
 * 功能链：
 *   initTaskCard → 监听 beilu:task-update 事件 → _renderTasks(tasks, rev)
 *     → 渲染清单行（pending○ / in_progress▶ / completed✓ 状态图标 + 文本）
 *     + 进度栏（完成/总数 百分比）+ 「剩余 N 项」折叠数
 *   点勾选 icon → POST beilu-memory setdata {_action:"checkTask", id, chatid, username}
 *     → 状态循环（pending→in_progress→completed→pending）→ await 后端成功后重渲
 *       （[2026-07-11 C6 注释校准] 原"本地乐观更新"失实：实现是 await 后提交，无失败脏状态）
 *   点「编辑」→ beiluPrompt 输入新内容 → POST {_action:"updateTask", id, content}
 *   点「删除」→ POST {_action:"deleteTask", id}
 *   点「折叠/展开」→ _collapsed toggle → localStorage 持久化（刷新后保持状态）
 *   hashchange 事件 → 切对话 → _curRev=-1 → refreshTaskCard（拉取新 chatId 的任务清单）
 *   WS task_update 推送优先，轮询只兜底（避免 WS 故障时任务卡卡死）
 *
 * why（§1.4 进度语义归任务卡）：
 *   pipelinePanel 9 步条只表示"当前子模式角色在流水线哪一步"（角色位置），
 *   任务完成进度（完成几项/共几项）全部归本组件负责，避免两处展示进度语义冲突。
 *   per-chatId 隔离：多窗口各自只渲染自己 chatId 的任务，不串窗口（不变式2）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（getTasks/checkTask/updateTask/deleteTask REST 调用）
 *   → shared/state/storage.mjs KEYS.BEILU_TASKCARD_COLLAPSED（折叠态持久化）
 *   → shared/widgets/beiluDialog.mjs beiluPrompt（编辑任务文本输入框）
 *   ← websocket.mjs（派发 beilu:task-update 事件，本模块消费）
 *   ← messageList.mjs（AI 回复后可能触发任务更新推送）
 *
 * 影响范围：
 *   #task-card 容器 DOM（聊天流顶部固定位置）；
 *   后端 work_ctx/tasks.json（checkTask/updateTask/deleteTask 写回）；
 *   localStorage BEILU_TASKCARD_COLLAPSED。
 *
 * 使用效果：
 *   AI 制定任务后任务卡自动出现/更新（WS 推送）；
 *   用户点勾 → 状态切换，进度条实时更新；折叠隐藏清单只显示摘要行。
 */

import { showToast } from "../../../../../../scripts/toast.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory setdata taskStore 收口
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { getUsername as _getUsername } from "../../shared/state/sharedState.mjs"; // [合并批 0714] username 读点单源（别名保调用点）

let _cardEl = null;
let _initialized = false;
let _curRev = -1;
// 任务面板折叠态（持久化，跨渲染/刷新保留）
let _collapsed = false;
try { _collapsed = storage.get(KEYS.BEILU_TASKCARD_COLLAPSED) === "1"; } catch (_) { /* ignore */ }

// [合并批 0714] _getUsername 手抄副本删除 → sharedState.getUsername 单源

// 当前窗口 chatId（per-chatId 隔离，权威来自 sharedState.getChatId 守卫）。
// [T047] 走守卫单一权威 getChatId()（sharedState.mjs:108，_CHATID_RE 校验）——
// 非法 hash 返 ""，不再裸读当 chatid POST beilu-memory。
// [2026-07-13] 原 `|| _beiluCurrentChatId` 次级兜底删除：全根 grep 零写点=幽灵值。
function _getChatId() {
  return window._beiluGetChatId?.() || "";
}

async function _sd(action, body) {
  // T6b批7：原 raw fetch（POST setdata + 自 .json()）→ sendAction 门面。verb=真动作，
  // payload 平铺（username/chatid/…）由 beilu-memory#* 通配路由重组 {_action:verb,...payload}，行为等价。
  const chatid = _getChatId();
  return sendAction({
    verb: action,
    target: "plugins:beilu-memory",
    source: "web",
    payload: { username: _getUsername(), chatid, ...body },
  });
}

const _STATUS_META = {
  completed: { icon: "✓", cls: "text-success line-through opacity-60", iconCls: "text-success" },
  in_progress: { icon: "▶", cls: "text-warning", iconCls: "text-warning" },
  pending: { icon: "○", cls: "text-base-content/70", iconCls: "text-base-content/40" },
};

export function initTaskCard() {
  if (_initialized) return;
  _initialized = true;
  _cardEl = document.getElementById("task-card");
  if (!_cardEl) return;

  // 推送优先：后端 task_update → beilu:task-update（websocket.mjs 派发）
  window.addEventListener("beilu:task-update", (e) => {
    const d = e.detail || {};
    // 只渲染当前窗口的任务（per-chatId 隔离展示，不变式2）
    if (d.chatid && d.chatid !== _getChatId()) return;
    _renderTasks(d.tasks || [], d.rev);
  });

  // 切窗口 / 切聊天时重新拉取该 chatId 的清单
  // [0720 F2 真变守卫(设计_前端管线归位 F2 点名靶)] cid 真变才强制失效重拉:
  //   空态回退等路径会 #a→""→#a 连发 hashchange,同 cid 重入时 rev 未变、getTasks 纯重复。
  //   守卫范式=preset.mjs:892/mcpPanel:154 同款 cid 缓存键。
  let _tcLastCid = _getChatId();
  window.addEventListener("hashchange", () => {
    const _cid = _getChatId();
    if (_cid === _tcLastCid) return;
    _tcLastCid = _cid;
    _curRev = -1;
    refreshTaskCard();
  });

  refreshTaskCard();
}

/** 主动拉取当前 chatId 的任务清单（初始化 + 轮询兜底 + 切窗口）。 */
export async function refreshTaskCard() {
  if (!_cardEl) _cardEl = document.getElementById("task-card");
  if (!_cardEl) return;
  if (!_getChatId()) { _hide(); return; }
  try {
    const data = await _sd("getTasks", {});
    if (data && data.success && Array.isArray(data.tasks)) {
      _renderTasks(data.tasks, data.rev);
    } else {
      _hide();
    }
  } catch (_) {
    // 网络错误：保留上次渲染，不清空
  }
}

function _hide() {
  if (_cardEl) _cardEl.classList.add("hidden");
}

function _renderTasks(tasks, rev) {
  if (!_cardEl) return;
  if (typeof rev === "number") _curRev = rev;
  if (!tasks || tasks.length === 0) { _hide(); return; }

  const remaining = tasks.filter((t) => t.status !== "completed").length;
  const total = tasks.length;

  const rows = tasks.map((t) => {
    const meta = _STATUS_META[t.status] || _STATUS_META.pending;
    const done = t.status === "completed";
    const nextStatus = done ? "pending" : "completed";
    return (
      `<div class="task-row flex items-center gap-1.5 text-xs py-0.5 group" data-id="${escapeHtml(t.id)}">` +
        `<button class="task-toggle w-4 text-center ${meta.iconCls} hover:scale-110" ` +
          `data-id="${escapeHtml(t.id)}" data-next="${nextStatus}" title="点击切换完成状态">${meta.icon}</button>` +
        `<span class="task-content flex-1 ${meta.cls} truncate" data-id="${escapeHtml(t.id)}" ` +
          `data-content="${escapeHtml(t.content)}" title="${escapeHtml(t.content)}（双击编辑）">${escapeHtml(t.content)}</span>` +
        `<button class="task-del opacity-0 group-hover:opacity-100 text-error/60 hover:text-error text-[10px]" ` +
          `data-id="${escapeHtml(t.id)}" title="删除此项">✕</button>` +
      `</div>`
    );
  }).join("");

  _cardEl.classList.remove("hidden");
  _cardEl.className = "mx-[10px] mt-2 lg:mx-4 lg:mt-3 bg-base-200/70 border border-base-content/10 rounded-lg p-2 space-y-1";
  _cardEl.innerHTML =
    `<div id="task-card-header" class="flex items-center justify-between mb-1 cursor-pointer select-none" title="点击折叠/展开任务清单">` +
      `<span class="text-xs font-medium text-base-content/70">` +
        `<span id="task-card-caret" class="inline-block w-3 text-center text-base-content/40">${_collapsed ? "▸" : "▾"}</span> <i data-ic="clipboard"></i> 任务清单</span>` +
      `<span class="text-[10px] ${remaining === 0 ? "text-success" : "text-base-content/50"}">` +
        `${remaining === 0 ? "全部完成" : `剩余 ${remaining} 项`} / 共 ${total}</span>` +
    `</div>` +
    `<div id="task-card-body" class="${_collapsed ? "hidden" : ""}">` +
      `<div class="task-rows space-y-0.5">${rows}</div>` +
      `<div class="flex justify-end pt-0.5">` +
        `<button id="task-add" class="btn btn-ghost btn-xs h-5 min-h-0 text-[10px] text-base-content/50"><i data-ic="plus"></i> 添加</button>` +
      `</div>` +
    `</div>`;

  _wireEvents();
}

function _wireEvents() {
  if (!_cardEl) return;
  // 折叠/展开：点 header 切换 body 显隐 + caret，持久化
  const header = document.getElementById("task-card-header");
  if (header) header.addEventListener("click", () => {
    _collapsed = !_collapsed;
    try { storage.set(KEYS.BEILU_TASKCARD_COLLAPSED, _collapsed ? "1" : "0"); } catch (_) { /* ignore */ }
    const body = document.getElementById("task-card-body");
    if (body) body.classList.toggle("hidden", _collapsed);
    const caret = document.getElementById("task-card-caret");
    if (caret) caret.textContent = _collapsed ? "▸" : "▾";
  });
  _cardEl.querySelectorAll(".task-toggle").forEach((b) =>
    b.addEventListener("click", () => _toggle(b.dataset.id, b.dataset.next)),
  );
  _cardEl.querySelectorAll(".task-del").forEach((b) =>
    b.addEventListener("click", () => _delete(b.dataset.id)),
  );
  _cardEl.querySelectorAll(".task-content").forEach((s) =>
    s.addEventListener("dblclick", () => _editInline(s)),
  );
  const addBtn = document.getElementById("task-add");
  if (addBtn) addBtn.addEventListener("click", _addTask);
}

async function _toggle(id, nextStatus) {
  if (!id) return;
  try {
    const data = await _sd("checkTask", { id, status: nextStatus });
    if (data && data.success) {
      if (Array.isArray(data.tasks)) _renderTasks(data.tasks, data.rev);
    } else showToast("error", "更新失败：" + (data?.error || "未匹配"));
  } catch (e) { showToast("error", "更新失败：" + (e.message || "网络错误")); }
}

async function _delete(id) {
  if (!id) return;
  try {
    const data = await _sd("deleteTask", { id });
    if (data && data.success) {
      if (Array.isArray(data.tasks)) _renderTasks(data.tasks, data.rev);
    } else showToast("error", "删除失败：" + (data?.error || "未匹配"));
  } catch (e) { showToast("error", "删除失败：" + (e.message || "网络错误")); }
}

/** 双击就地编辑任务内容。 */
function _editInline(spanEl) {
  const id = spanEl.dataset.id;
  const old = spanEl.dataset.content || spanEl.textContent || "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = old;
  input.className = "input input-xs input-bordered flex-1 text-xs h-5 min-h-0";
  spanEl.replaceWith(input);
  input.focus();
  input.select();
  let _done = false;
  const commit = async () => {
    if (_done) return;
    _done = true;
    const val = input.value.trim();
    if (!val || val === old) { refreshTaskCard(); return; }
    try {
      const data = await _sd("updateTask", { id, content: val });
      if (data && data.success && Array.isArray(data.tasks)) _renderTasks(data.tasks, data.rev);
      else { showToast("error", "保存失败：" + (data?.error || "未匹配")); refreshTaskCard(); }
    } catch (e) { showToast("error", "保存失败：" + (e.message || "网络错误")); refreshTaskCard(); }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") { _done = true; refreshTaskCard(); }
  });
}

/** 用户手动新增一项（原子 addTask action，后端 withFileLock 追加——不再 getTasks→planTasks 覆盖写）。 */
async function _addTask() {
  const content = await beiluPrompt("新任务内容：");
  if (!content || !content.trim()) return;
  try {
    const data = await _sd("addTask", { content: content.trim() });
    if (data && data.success && Array.isArray(data.tasks)) _renderTasks(data.tasks, data.rev);
    else showToast("error", "添加失败：" + (data?.error || "未知错误"));
  } catch (e) { showToast("error", "添加失败：" + (e.message || "网络错误")); }
}
