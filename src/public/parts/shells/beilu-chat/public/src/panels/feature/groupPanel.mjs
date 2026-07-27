/**
 * groupPanel.mjs — 多组并行 v4 组管理面板（前端）
 *
 * 功能链：
 *   initGroupPanel(container) → GET /api/parts/shells:chat/groups → 渲染组列表
 *   → 并行引擎开关（grp-engine-toggle）→ POST /groups/engine { enabled }
 *   → 建组（grp-name + grp-root）→ POST /groups → 刷新列表
 *   → 删组 → beiluConfirm 确认 → DELETE /groups/:gid → 刷新列表
 *   → 绑定角色到组（把当前对话 chatid 绑到组内某 role）→ POST /groups/:gid/role
 *   → 解绑角色 → DELETE /groups/:gid/role/:role
 *   → 启动并行执行 → POST /groups/:gid/execute
 *   → 定时刷新（_refreshTimer）→ 保持组状态实时
 *
 * why：
 *   多组并行让不同角色在独立对话线上并行处理任务；
 *   此面板是「多组」从 UI 可达的唯一入口（建/删/绑/执行）；
 *   自包含（initGroupPanel 传容器，不依赖模板 HTML），挂载零耦合；
 *   chatid 取守卫单源 window._beiluGetChatId()（sharedState.mjs:108，_CHATID_RE 校验非法 hash 返 ""），避免 import 耦合。
 *
 * 关联链：
 *   ← layout.mjs / IDE 面板（initGroupPanel 调用）
 *   → /api/parts/shells:chat/groups（组 CRUD + engine + execute）
 *   → shared/transport/api-client.mjs（apiFetch：统一封装，自动 JSON body+headers）
 *   → groupRuntimePanel.mjs（右栏运行态面板，独立轮询同一 API）
 *
 * 影响范围：
 *   后端组数据（创建/删除/绑定）影响并行执行路由；
 *   并行引擎开关影响全局并行调度能力；
 *   DOM：initGroupPanel 传入的 container 内完整重渲染。
 *
 * 使用效果：
 *   IDE 面板可视化管理并行组；一键启动 → 各角色在各自对话线并行执行任务；
 *   角色绑定到组后，并行执行时自动路由消息到对应对话。
 */
import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作）

let _refreshTimer = null;

// T6b：apiFetch → sendAction（verb 语义化；scope.chatId 或 payload 承载参数；错误由门面统一 _report+抛错）。
const apiList = async () => (await sendAction({ verb: "getGroups", target: "shells:chat", source: "web" })).groups || {};
const apiCreate = async (body) =>
  (await sendAction({ verb: "createGroup", target: "shells:chat", source: "web", payload: body })).groupId;
const apiRemove = (gid) =>
  sendAction({ verb: "removeGroup", target: "shells:chat", source: "web", payload: { gid } });
const apiBind = (gid, role, chatid) =>
  sendAction({ verb: "bindGroupRole", target: "shells:chat", source: "web", payload: { gid, role, chatid } });
const apiUnbind = (gid, role) =>
  sendAction({ verb: "unbindGroupRole", target: "shells:chat", source: "web", payload: { gid, role } });
const apiExecute = (gid) =>
  sendAction({ verb: "executeGroup", target: "shells:chat", source: "web", payload: { gid } });
const apiGetEngine = async () => (await sendAction({ verb: "getGroupsEngine", target: "shells:chat", source: "web" })).enabled;
const apiSetEngine = async (enabled) =>
  (await sendAction({ verb: "setGroupsEngine", target: "shells:chat", source: "web", payload: { enabled } })).enabled;

function currentChatId() {
  // 补修（同族收口 C-9）：切守卫单源 getChatId（sharedState.mjs:108，内含 _CHATID_RE 校验）——非法 hash
  //   （分段气泡/IDE 内部锚点）返 ""，不再裸读 substring 当 chatid 送后端 bindGroupRole 分区键。
  //   空值由调用处 :126 if(!cid) throw 空值守卫拦截（保留）。对齐 cardsPanel.mjs:62 _cur() 范式（window 全局桥单源）。
  return window._beiluGetChatId?.() || "";
}

let _root = null;
let _engineEnabled = false;

export async function initGroupPanel(container) {
  _root = container || document.getElementById("group-panel-root");
  if (!_root) return;

  try { _engineEnabled = await apiGetEngine(); } catch { _engineEnabled = false; }

  _root.innerHTML = `
    <div class="group-panel" style="padding:10px;font-size:0.8rem;">
      <div style="font-weight:600;color:var(--beilu-amber);margin-bottom:6px;"><i data-ic="folders"></i> 并行组管理</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:4px 6px;border:1px solid var(--beilu-amber-15);border-radius:5px;background:var(--beilu-amber-4);">
        <span style="font-size:0.72rem;flex:1;"><i data-ic="zap"></i> 并行引擎</span>
        <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;">
          <input type="checkbox" id="grp-engine-toggle" ${_engineEnabled ? "checked" : ""} style="opacity:0;width:0;height:0;">
          <span id="grp-engine-slider" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${_engineEnabled ? "var(--beilu-success)" : "var(--beilu-muted-bg, #4b5563)"};border-radius:10px;transition:0.3s;">
            <span style="position:absolute;left:${_engineEnabled ? "18px" : "2px"};top:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:0.3s;"></span>
          </span>
        </label>
        <span id="grp-engine-label" style="font-size:0.65rem;opacity:0.6;min-width:24px;">${_engineEnabled ? "ON" : "OFF"}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <input id="grp-name" class="conn-input" placeholder="项目名" title="并行组名称(如项目代号)" style="flex:1;min-width:80px;">
        <input id="grp-root" class="conn-input" placeholder="工作区根(可选)" title="组内对话共享的工作目录(IDE 模式用;留空=各对话独立)" style="flex:1;min-width:80px;">
        <button id="grp-create" class="conn-btn conn-btn-primary"><i data-ic="plus"></i> 建组</button>
      </div>
      <div id="grp-msg" style="font-size:0.7rem;color:var(--beilu-error);min-height:14px;"></div>
      <div id="grp-list"></div>
    </div>`;

  _root.querySelector("#grp-engine-toggle").addEventListener("change", async (e) => {
    const slider = _root.querySelector("#grp-engine-slider");
    const label = _root.querySelector("#grp-engine-label");
    const dot = slider?.querySelector("span");
    try {
      _engineEnabled = await apiSetEngine(e.target.checked);
    } catch (err) {
      _engineEnabled = false;
      e.target.checked = false;
    }
    if (slider) slider.style.background = _engineEnabled ? "var(--beilu-success)" : "var(--beilu-muted-bg, #4b5563)";
    if (dot) dot.style.left = _engineEnabled ? "18px" : "2px";
    if (label) label.textContent = _engineEnabled ? "ON" : "OFF";
  });

  _root.querySelector("#grp-create").addEventListener("click", async () => {
    const name = _root.querySelector("#grp-name").value.trim();
    const root = _root.querySelector("#grp-root").value.trim();
    await _guard(async () => {
      await apiCreate({ projectName: name, workspaceRoot: root });
      _root.querySelector("#grp-name").value = "";
      _root.querySelector("#grp-root").value = "";
      await refresh();
    });
  });

  _root.querySelector("#grp-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act, gid, role } = btn.dataset;
    await _guard(async () => {
      if (act === "remove") await apiRemove(gid);
      else if (act === "unbind") await apiUnbind(gid, role);
      else if (act === "bind") {
        const cid = currentChatId();
        if (!cid) throw new Error("当前无打开的对话（hash 为空）");
        const roleInput = _root.querySelector(`#grp-role-${cssEsc(gid)}`);
        const charName = window._beiluGetCharName?.() || "";
        const r = (roleInput?.value || "").trim() || charName || "member";
        await apiBind(gid, r, cid);
      } else if (act === "execute") {
        const result = await apiExecute(gid);
        const ok = (result.triggered || []).filter((t) => t.ok).length;
        const fail = (result.triggered || []).filter((t) => !t.ok).length;
        const msg = _root?.querySelector("#grp-msg");
        if (msg) {
          msg.style.color = fail ? "var(--beilu-error)" : "var(--beilu-success)";
          msg.textContent = `▶ 已触发 ${ok} 个对话${fail ? `，${fail} 个失败` : ""}`;
          setTimeout(() => { msg.textContent = ""; msg.style.color = "var(--beilu-error)"; }, 3000);
        }
      }
      await refresh();
    });
  });

  await refresh();

  clearInterval(_refreshTimer);
  _refreshTimer = setInterval(async () => {
    if (_root && _root.offsetWidth > 0) {
      try { await refresh(); } catch { /* 静默 */ }
    }
  }, 4000);
}

async function _guard(fn) {
  const msg = _root?.querySelector("#grp-msg");
  if (msg) msg.textContent = "";
  try { await fn(); }
  catch (err) { if (msg) msg.textContent = "⚠️ " + (err?.message || String(err)); }
}

const cssEsc = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "");

export async function refresh() {
  if (!_root) return;
  const listEl = _root.querySelector("#grp-list");
  if (!listEl) return;
  let groups;
  try { groups = await apiList(); }
  catch (err) { listEl.innerHTML = `<div style="color:var(--beilu-error);font-size:0.7rem;">加载失败：${escapeHtml(err.message)}</div>`; return; }

  const ids = Object.keys(groups);
  if (!ids.length) {
    listEl.innerHTML = `<div style="opacity:0.5;font-size:0.72rem;">还没有并行组。建一个组，再把对话绑进去，然后启动并行执行。</div>`;
    return;
  }
  const cid = currentChatId();
  const _curCharName = window._beiluGetCharName?.() || "";
  listEl.innerHTML = ids.map((gid) => {
    const g = groups[gid];
    const roles = Object.entries(g.roles || {});
    const statusColor = g.status === "running" ? "var(--beilu-success)" : g.status === "stopped" ? "var(--beilu-error)" : "var(--beilu-muted, #9ca3af)";
    const statusText = g.status === "running" ? "运行中" : g.status === "stopped" ? "已停" : "空闲";
    const hasRoles = roles.length > 0;
    const rolesHtml = hasRoles
      ? roles.map(([role, c]) => `
          <div style="display:flex;align-items:center;gap:6px;font-size:0.7rem;padding:1px 0;">
            <span style="opacity:0.6;">${escapeHtml(role)}</span>
            <span style="font-family:monospace;opacity:0.5;flex:1;${c === cid ? "color:var(--beilu-amber);" : ""}">${escapeHtml(c)}${c === cid ? " ←当前" : ""}</span>
            <button class="conn-btn" data-act="unbind" data-gid="${escapeHtml(gid)}" data-role="${escapeHtml(role)}" title="解绑">✕</button>
          </div>`).join("")
      : `<div class="text-base-content/50" style="font-size:0.68rem;">（组内暂无角色，请先绑定对话）</div>`;
    return `
      <div class="group-card" style="border:1px solid var(--beilu-amber-20);border-radius:6px;padding:6px 8px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="width:7px;height:7px;border-radius:50%;background:${statusColor};${g.status === "running" ? "animation:pulse 1.5s infinite;" : ""}"></span>
          <span style="font-weight:600;flex:1;">${escapeHtml(g.projectName || "(未命名)")}</span>
          <span style="font-size:0.6rem;color:${statusColor};">${statusText}</span>
          <button class="conn-btn conn-btn-primary" data-act="execute" data-gid="${escapeHtml(gid)}" ${hasRoles ? "" : "disabled"} title="启动此组所有角色的并行执行" style="font-size:0.65rem;padding:1px 6px;">▶ 启动</button>
          <button class="conn-btn conn-btn-danger" data-act="remove" data-gid="${escapeHtml(gid)}" title="删组"><i data-ic="trash"></i></button>
        </div>
        ${g.workspaceRoot ? `<div style="font-size:0.62rem;opacity:0.4;font-family:monospace;">${escapeHtml(g.workspaceRoot)}</div>` : ""}
        <div style="margin:3px 0;">${rolesHtml}</div>
        <div style="display:flex;gap:4px;align-items:center;">
          <input id="grp-role-${cssEsc(gid)}" class="conn-input" placeholder="${escapeHtml(_curCharName || '角色名')}" style="flex:1;min-width:60px;font-size:0.68rem;">
          <button class="conn-btn conn-btn-primary" data-act="bind" data-gid="${escapeHtml(gid)}" ${cid ? "" : "disabled"} title="把当前对话绑到此组">↳ 绑当前对话</button>
        </div>
      </div>`;
  }).join("");
}
