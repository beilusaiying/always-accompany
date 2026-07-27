/**
 * gitPanel.mjs — IDE 活动栏 [G] Git 源代码管理面板（前端）
 *
 * 功能链：
 *   点「刷新状态」按钮 → _callGitTool("git_status") → REST 桥
 *     POST /api/parts/shells:chat/ide/manual-tool-call {chatid, tool, params}
 *     → 后端 ideClient.callTool（过 gateToolExecution + 审批门, source=frontend）→ WS 发往 YonBan 扩展
 *     → 返回 {ok, result:{success, result}} → _parseStatus 容错解析 → 渲染暂存/未暂存/未追踪文件列表
 *   点文件行「+」→ git_add；点「提交」→ beiluPrompt 输入信息 → git_commit；
 *   点「Branch」→ git_branch/checkout；点「Log」→ git_log → 渲染提交历史。
 *
 * why：
 *   后端 9 个 git 工具已在 YonBan 扩展侧实现，前端面板是唯一展示/操作入口；
 *   统一走 manual-tool-call REST 桥而非浏览器直发 WS，保证经过本体门控和审批（D-4 弃用直发）。
 *   每次 callTool 会在当前对话写一条 _hidden IDE工具结果条目（按钮触发不轮询，避免条目膨胀）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（REST 桥唯一出口）
 *   → shared/transport/endpoints.mjs currentChatId（chatid 来源，多窗口隔离）
 *   → shared/state/storage.mjs（暂存区展开态等 UI 状态持久化）
 *   ← layout.mjs / idePanel.mjs（IDE 活动栏 [G] 按钮点击时 initGitPanel）
 *
 * 影响范围：
 *   #git-panel 容器 DOM（状态列表/提交历史/分支列表渲染）；
 *   每次操作写一条 _hidden 消息到当前对话（chatid 隔离）。
 *
 * 使用效果：
 *   未连 IDE 时所有按钮返回"请连接 YonBan"降级提示；连接后，刷新状态显示工作区文件变更，
 *   可直接在面板完成 add/commit/branch/log 操作，结果实时渲染，无需切 IDE 窗口。
 *   _parseStatus 对常见字段名做容错兼容（schema 真源在 YonBan 侧，首连后可微调该函数）。
 */

import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=ideManualToolCall；桥回包 {ok,result} 解析保留）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs"; // T7：HTML 转义收口到唯一权威实现（5 字符含单引号）

let _panelEl = null;
let _logOpen = false;
let _stylesInjected = false;

/** 取当前 chatid（与 fileExplorer/idePanel 同源口径）。
 *  回退走守卫单源 _beiluGetChatId（sharedState._CHATID_RE 校验）——原裸读 location.hash 无校验，
 *  非法 hash 会被当 chatid 送后端写脏分区键（2026-07-13 补丁扫描 C1，读侧旁路收口）。 */
function _getChatId() {
  return currentChatId || (window._beiluGetChatId?.() || "");
}

/**
 * 经 REST 桥调一个 git 工具。返回 { success, data, error }。
 * 失败（IDE 未连接/工具报错/网络）统一归一化，调用方据 success 渲染或降级。
 */
async function _callGitTool(tool, params = {}) {
  const chatid = _getChatId();
  if (!chatid) return { success: false, error: "无当前对话（chatid 缺失）" };
  try {
    // 门面 ideManualToolCall：body {chatid,tool,params}；桥回包 {ok,result}，!ok 时 apiFetch 抛错走 catch。
    const j = await sendAction({ verb: "ideManualToolCall", target: "shells:chat", source: "web", payload: { chatid, tool, params } });
    if (!j || !j.ok) return { success: false, error: j?.result?.error || j?.error || "工具调用失败" };
    const r = j.result || {};
    if (r.success === false) return { success: false, error: r.error || "工具执行失败（IDE 未连接？）" };
    return { success: true, data: r.result };
  } catch (e) {
    try { window._reportError?.("[gitPanel] " + tool + " 失败", e?.stack); } catch { /* ignore */ }
    return { success: false, error: e?.message || String(e) };
  }
}

/** git_status 容错解析：兼容常见字段名，返回归一结构。schema 真源在 YonBan，首连后可微调本函数。 */
function _parseStatus(data) {
  if (!data || typeof data === "string") return null; // 字符串/空 → 交由调用方原样展示
  const arr = (v) => Array.isArray(v) ? v : [];
  const norm = (f) => (typeof f === "string" ? { path: f, st: "M" } : { path: f.path || f.file || f.name || "", st: (f.status || f.st || f.index || "M").toString().charAt(0).toUpperCase() });
  return {
    branch: data.branch || data.current || data.head || "(unknown)",
    ahead: data.ahead ?? 0,
    behind: data.behind ?? 0,
    staged: arr(data.staged || data.indexed || data.cached).map(norm),
    changes: arr(data.changes || data.unstaged || data.modified || data.working).map(norm),
    untracked: arr(data.untracked).map((f) => (typeof f === "string" ? { path: f, st: "U" } : { path: f.path || f.file || "", st: "U" })),
  };
}

const _esc = escapeHtml; // T7：alias 到唯一权威实现（原本地 5 字符 replace 链已删）
const _base = (p) => String(p || "").split("/").pop();
const _stIcon = (s) => `<span class="gp-st gp-st-${_esc(s)}">${_esc(s)}</span>`;

function _fileRow(f, area) {
  const actIcon = area === "staged" ? "－" : "＋";
  const actTitle = area === "staged" ? "取消暂存（当前工具集无 git_restore，请在 IDE 内操作）" : "git_add 暂存";
  const actFn = area === "staged" ? "unstage" : "stage";
  return `<div class="gp-file-row" data-path="${_esc(f.path)}" data-area="${area}">` +
    _stIcon(f.st) +
    `<span class="gp-fname" title="${_esc(f.path)}">${_esc(_base(f.path))}</span>` +
    `<span class="gp-fpath">${_esc(f.path)}</span>` +
    `<span class="gp-act" data-act="${actFn}" data-path="${_esc(f.path)}" title="${actTitle}">${actIcon}</span>` +
    `</div>`;
}

function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
.gp-wrap{font-size:13px;color:var(--color-base-content,#e0e0e0);}
.gp-sec-title{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.55;margin:10px 0 4px;display:flex;align-items:center;justify-content:space-between;}
.gp-file-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;font-size:12.5px;cursor:pointer;}
.gp-file-row:hover{background:var(--color-base-300,#2a2a2a);}
.gp-fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;}
.gp-fpath{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.gp-act{margin-left:auto;opacity:0;font-size:13px;padding:0 4px;}
.gp-file-row:hover .gp-act{opacity:.85;}
.gp-st{width:16px;text-align:center;font-weight:700;font-size:12px;flex-shrink:0;}
.gp-st-M{color:var(--beilu-warning);}.gp-st-A{color:var(--beilu-success);}.gp-st-D{color:var(--beilu-error);}.gp-st-U{color:color-mix(in oklch, #89dceb 60%, var(--color-base-content));}.gp-st-R{color:color-mix(in oklch, #cba6f7 60%, var(--color-base-content));}
.gp-diff{background:var(--color-base-100,#1a1a1a);border:1px solid var(--color-base-300,#2a2a2a);border-radius:6px;font-family:ui-monospace,monospace;font-size:12px;padding:8px;margin-top:8px;white-space:pre;overflow-x:auto;}
.gp-diff .gp-add{background:color-mix(in srgb, var(--beilu-success) 15%, transparent);color:var(--beilu-success);display:block;}
.gp-diff .gp-del{background:color-mix(in srgb, var(--beilu-error) 15%, transparent);color:var(--beilu-error);display:block;}
.gp-diff .gp-ctx{color:oklch(var(--bc, 0.7 0 0) / 0.65);display:block;}
.gp-diff .gp-hunk{color:color-mix(in oklch, #89b4fa 60%, var(--color-base-content));display:block;}
.gp-commit{width:100%;background:var(--color-base-100,#1a1a1a);color:var(--color-base-content,#e0e0e0);border:1px solid var(--color-base-300,#2a2a2a);border-radius:6px;padding:6px 8px;font-size:12.5px;resize:vertical;min-height:46px;box-sizing:border-box;}
.gp-mini{font-size:11px;opacity:.6;}
.gp-branchbar{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;flex-wrap:wrap;}
.gp-pill{background:var(--color-base-300,#2a2a2a);border-radius:10px;padding:1px 7px;font-size:11px;}
.gp-log-row{font-size:11.5px;padding:3px 4px;border-left:2px solid rgba(255,255,255,0.12);margin:2px 0;}
.gp-hash{color:color-mix(in oklch, #89b4fa 60%, var(--color-base-content));font-family:ui-monospace,monospace;}
.gp-note{background:var(--color-base-100,#141414);border:1px dashed oklch(var(--bc, 0.7 0 0) / 0.2);color:oklch(var(--bc, 0.7 0 0) / 0.65);font-size:11px;padding:6px 8px;border-radius:6px;margin-bottom:8px;}
`;
  const el = document.createElement("style");
  el.id = "gp-styles";
  el.textContent = css;
  document.head.appendChild(el);
}

function _shellHtml() {
  return `<div class="gp-wrap">
  <div class="flex items-center justify-between mb-1">
    <span class="font-bold text-sm"><i data-ic="branch"></i> 源代码管理 (Git)</span>
    <button class="btn btn-xs btn-ghost" data-gp="refresh" title="刷新 git_status">⟳</button>
  </div>
  <div class="gp-note" data-gp="note">点击 ⟳ 拉取 git 状态。git 命令在 IDE(YonBan) 扩展侧执行，需先在 VSCode/Cursor 连接 YonBan。</div>
  <div class="gp-branchbar">
    <span><i data-ic="branch"></i></span>
    <span class="gp-pill" data-gp="branch">—</span>
    <span class="gp-pill" data-gp="aheadbehind" title="ahead/behind 远端">↑0 ↓0</span>
    <button class="btn btn-xs btn-ghost" data-gp="newbranch" title="git_branch 新建并切换">＋分支</button>
    <button class="btn btn-xs btn-ghost" data-gp="checkout" title="git_checkout 切换分支"><i data-ic="shuffle"></i> 切换</button>
    <button class="btn btn-xs btn-ghost" data-gp="merge" title="git_merge 合并分支"><i data-ic="link"></i> 合并</button>
    <button class="btn btn-xs btn-ghost" data-gp="stash" title="git_stash push"><i data-ic="package"></i> stash</button>
  </div>
  <textarea class="gp-commit" data-gp="commitmsg" placeholder="提交信息（Ctrl+Enter 提交）"></textarea>
  <div class="flex gap-2 mt-1 mb-1">
    <button class="btn btn-xs btn-primary flex-1" data-gp="commit" title="git_commit">✓ 提交 (<span data-gp="stagedcount">0</span>)</button>
    <button class="btn btn-xs btn-ghost" data-gp="stageall" title="git_add 全部">＋全部暂存</button>
  </div>
  <div class="gp-sec-title">暂存的更改 <span class="gp-pill" data-gp="stagednum">0</span></div>
  <div data-gp="stagedlist"></div>
  <div class="gp-sec-title">更改 <span class="gp-pill" data-gp="changesnum">0</span></div>
  <div data-gp="changeslist"></div>
  <div class="gp-sec-title">未跟踪 <span class="gp-pill" data-gp="untrackednum">0</span></div>
  <div data-gp="untrackedlist"></div>
  <div data-gp="diffwrap" style="display:none;">
    <div class="gp-sec-title">差异：<span data-gp="difffile" style="opacity:.9;text-transform:none;"></span></div>
    <div class="gp-diff" data-gp="diffview"></div>
  </div>
  <div class="gp-sec-title" data-gp="logtoggle" style="cursor:pointer;">提交历史 (git_log) <span data-gp="logcaret">▸</span></div>
  <div data-gp="loglist" style="display:none;"></div>
</div>`;
}

const _q = (sel) => _panelEl.querySelector(`[data-gp="${sel}"]`);
function _setNote(msg, kind) {
  const n = _q("note");
  if (!n) return;
  n.textContent = msg;
  n.style.borderColor = kind === "error" ? "var(--beilu-error)" : kind === "ok" ? "var(--beilu-success)" : "rgba(255,255,255,0.12)";
}
function _toast(msg, kind) { try { window._beiluToast?.(msg, kind || "info"); } catch { /* ignore */ } }

function _renderStatus(st) {
  const fill = (sel, list, area) => {
    _q(sel).innerHTML = list.length ? list.map((f) => _fileRow(f, area)).join("") : `<div class="gp-mini" style="padding:2px 6px;">（空）</div>`;
  };
  fill("stagedlist", st.staged, "staged");
  fill("changeslist", st.changes, "changes");
  fill("untrackedlist", st.untracked, "untracked");
  _q("stagednum").textContent = st.staged.length;
  _q("changesnum").textContent = st.changes.length;
  _q("untrackednum").textContent = st.untracked.length;
  _q("stagedcount").textContent = st.staged.length;
  _q("branch").textContent = "🌿 " + st.branch;
  _q("aheadbehind").textContent = `↑${st.ahead} ↓${st.behind}`;
}

async function _refresh() {
  _setNote("拉取 git 状态中…");
  const r = await _callGitTool("git_status", {});
  if (!r.success) { _setNote("无法获取 git 状态：" + r.error + "（请在 VSCode/Cursor 连接 YonBan IDE）", "error"); return; }
  const st = _parseStatus(r.data);
  if (!st) { _setNote("git 状态（原始）：" + (typeof r.data === "string" ? r.data.slice(0, 400) : JSON.stringify(r.data).slice(0, 400))); return; }
  _renderStatus(st);
  _setNote(`分支 ${st.branch}：暂存 ${st.staged.length} / 更改 ${st.changes.length} / 未跟踪 ${st.untracked.length}`, "ok");
}

function _renderDiff(path, raw) {
  _q("diffwrap").style.display = "block";
  _q("difffile").textContent = path;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  _q("diffview").innerHTML = text.split("\n").map((l) => {
    const c = l.startsWith("+") ? "gp-add" : l.startsWith("-") ? "gp-del" : l.startsWith("@@") ? "gp-hunk" : "gp-ctx";
    return `<span class="${c}">${_esc(l) || " "}</span>`;
  }).join("");
}

async function _showDiff(path) {
  _setNote("拉取 diff：" + path);
  const r = await _callGitTool("git_diff", { path });
  if (!r.success) { _setNote("diff 失败：" + r.error, "error"); return; }
  _renderDiff(path, r.data);
  _setNote("diff: " + path, "ok");
}

async function _gitAction(tool, params, okMsg) {
  _setNote(tool + " …");
  const r = await _callGitTool(tool, params);
  if (!r.success) { _setNote(tool + " 失败：" + r.error, "error"); _toast(tool + " 失败", "error"); return false; }
  _setNote(okMsg || (tool + " 成功"), "ok"); _toast(okMsg || (tool + " 成功"), "success");
  await _refresh();
  return true;
}

async function _refreshLog() {
  const r = await _callGitTool("git_log", { maxCount: 20 });
  const el = _q("loglist");
  if (!r.success) { el.innerHTML = `<div class="gp-mini" style="padding:4px;">git_log 失败：${_esc(r.error)}</div>`; return; }
  const rows = Array.isArray(r.data) ? r.data : (r.data?.commits || []);
  el.innerHTML = rows.length ? rows.map((c) => {
    const hash = (c.hash || c.sha || c.commit || "").toString().slice(0, 7);
    const msg = c.subject || c.message || c.msg || "";
    const who = c.author || c.who || c.authorName || "";
    const when = c.date || c.when || "";
    return `<div class="gp-log-row"><span class="gp-hash">${_esc(hash)}</span> ${_esc(msg)}<div class="gp-mini">${_esc(who)} · ${_esc(when)}</div></div>`;
  }).join("") : `<div class="gp-mini" style="padding:4px;">（无提交或原始：${_esc(typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200))}）</div>`;
}

function _bind() {
  _panelEl.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-gp],[data-act]");
    if (!t) return;
    // 文件行 act（暂存/取消暂存）
    if (t.dataset.act) {
      e.stopPropagation();
      const p = t.dataset.path;
      if (t.dataset.act === "stage") await _gitAction("git_add", { path: p }, "已暂存 " + _base(p));
      // unstage：9 工具集无 git_restore（inv_I §①坐实）。不冒充 git_add（那会把文件再次暂存却谎报"已取消"误导用户），
      //   诚实提示走 IDE 内操作，不发任何调用。待后端补 git_restore 桥后再接线。
      else _setNote("当前 git 工具集无 git_restore，取消暂存请在 VSCode/Cursor 的 IDE 内操作", "error");
      return;
    }
    const gp = t.dataset.gp;
    if (gp === "refresh") return _refresh();
    if (gp === "stageall") return void _gitAction("git_add", {}, "已暂存全部");
    if (gp === "stash") return void _gitAction("git_stash", { action: "push" }, "已 stash");
    if (gp === "newbranch") { const n = await beiluPrompt("新分支名（git_branch create）"); if (n) await _gitAction("git_branch", { create: n.trim() }, "已建并切到 " + n.trim()); return; }
    if (gp === "checkout") { const b = await beiluPrompt("切换到分支（git_checkout）"); if (b) await _gitAction("git_checkout", { branch: b.trim() }, "已切换到 " + b.trim()); return; }
    if (gp === "merge") { const b = await beiluPrompt("合并分支到当前分支（git_merge）"); if (b) await _gitAction("git_merge", { branch: b.trim() }, "已合并 " + b.trim()); return; }
    if (gp === "commit") {
      const msg = _q("commitmsg").value.trim();
      if (!msg) { _setNote("请填写提交信息", "error"); return; }
      const ok = await _gitAction("git_commit", { message: msg }, "已提交");
      if (ok) { _q("commitmsg").value = ""; if (_logOpen) await _refreshLog(); }
      return;
    }
    if (gp === "logtoggle") {
      _logOpen = !_logOpen;
      _q("loglist").style.display = _logOpen ? "block" : "none";
      _q("logcaret").textContent = _logOpen ? "▾" : "▸";
      if (_logOpen) await _refreshLog();
      return;
    }
    // 点文件行看 diff
    const row = e.target.closest(".gp-file-row");
    if (row && row.dataset.path) return _showDiff(row.dataset.path);
  });
  _q("commitmsg").addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") _q("commit").click();
  });
}

/**
 * 初始化 git 面板。挂载点 = index.html 的 #ide-panel-git（由 index.mjs 取出后传入）。
 * @param {HTMLElement} panelEl
 */
export async function initGitPanel(panelEl) {
  if (!panelEl) return;
  _panelEl = panelEl;
  _injectStyles();
  panelEl.innerHTML = _shellHtml();
  _bind();
  // 不自动轮询（manual-tool-call 每调写 _hidden 条目）；首次切到面板时用户点 ⟳ 拉取。
}
