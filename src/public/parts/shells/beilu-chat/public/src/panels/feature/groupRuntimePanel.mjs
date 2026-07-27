/**
 * groupRuntimePanel.mjs — 多组并行 v4 右栏「并行组运行态」实时面板（设计 §4.1）
 *
 * 功能链：
 *   initGroupRuntimePanel() → 渲染 #group-runtime-root
 *   → 定时轮询（_timer）→ GET /api/parts/shells:chat/groups → 各组 status(idle/running/stopped) + 角色
 *   → _renderActiveDetail(sm, fg)：顶部「当前运行」明细块
 *     · active_sub_mode（子模式 label）← getSubModes
 *     · 流程组步骤进度 N/M + auto-continue 状态 ← getFlowGroupStatus
 *   → 组列表：status 指示器（running=绿/idle=灰/stopped=红）+ 角色 + 当前对话所属组高亮
 *   → 点击对话链接 → switchToChat（跳转到对应对话）
 *
 * why：
 *   多组并行时，用户需要在右栏实时看到「另一组在不在跑」；
 *   status 由后端 dispatchReplyToGroup 置 running/idle（真运行态来源），前端只轮询展示；
 *   「当前运行」明细（2026-06-07 升级）补充子模式 + 流程步骤进度，让运行态更细粒度可感知；
 *   注：明细目前为「当前上下文/活跃组」级（config 非 per-group），
 *     真正跨组细粒度运行态待 worker runner 落地后补充。
 *
 * 关联链：
 *   ← layout.mjs / 右栏初始化（initGroupRuntimePanel 调用）
 *   → /api/parts/shells:chat/groups（组状态轮询）
 *   → beilu-memory 插件后端（getSubModes / getFlowGroupStatus via _memAction）
 *   → shared/chat-core/conversationManager.mjs（switchToChat：点击跳转）
 *   → shared/transport/api-client.mjs（apiFetch）
 *
 * 影响范围：
 *   DOM：#group-runtime-root 定时重渲染（轮询驱动）；
 *   无写操作，只读组状态和子模式状态；
 *   轮询间隔由 _timer 控制，unmount 时需清除（防泄漏）。
 *
 * 使用效果：
 *   右栏实时显示各并行组运行/空闲/已停状态；当前对话所属组高亮；
 *   顶部明细区显示当前子模式和流程步骤进度，辅助监控自驱动任务进展。
 */
import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面
import { getFlowGroupStatusShared, invalidateFlowGroupStatus } from "../../shared/transport/flowGroupStatus.mjs"; // T023 Q5: 三面板共享单飞；T029: 变更后失效
import { switchToChat } from "../../shared/chat-core/conversationManager.mjs";

let _root = null;
let _timer = null;

async function _memAction(action, extra) {
  try {
    // T6b：raw+手 r.ok 语义并入门面（!ok → 门面统一抛错→catch → null，与原 r.ok?json:null 语义一致）
    return await sendAction({
      verb: action,
      target: "plugins:beilu-memory",
      source: "web",
      payload: { ...(extra || {}) },
    });
  } catch { return null; }
}

// 「当前运行」明细：active_sub_mode label + 流程步骤 N/M + auto-continue。
// sm 由 render() 传入（避免重复请求），内含 active_sub_modes_map(per-chatId) 供 per-group 渲染。
async function _renderActiveDetail(sm, fg) {
  const rows = [];
  if (sm?.active_sub_mode) {
    const cur = (sm.sub_modes || []).find((m) => m.id === sm.active_sub_mode);
    rows.push(`<span style="font-size:0.64rem;opacity:0.7;"><i data-ic="drama"></i> 子模式: <b style="color:var(--beilu-amber,#d4a017);">${escapeHtml(cur?.label || sm.active_sub_mode)}</b></span>`);
  }
  if (fg?.active && fg.state) {
    const cur = Number(fg.state.current_step ?? 0);
    const total = Number(fg.state.total_steps ?? (fg.steps || []).length ?? 0);
    const stepLabel = (fg.steps || [])[cur]?.label || (fg.steps || [])[cur]?.mode || "";
    const st = fg.state.status === "awaiting_approval" ? "待批准" : fg.state.status === "completed" ? "已完成" : "进行中";
    rows.push(`<span style="font-size:0.64rem;opacity:0.7;"><i data-ic="clipboard"></i> 流程: ${escapeHtml(fg.name || "")} <b>${Math.min(cur + 1, total || cur + 1)}/${total || "?"}</b>${stepLabel ? " · " + escapeHtml(stepLabel) : ""} (${st})</span>`);
    // T029 状态驱动按钮组（双入口之二，半修陷阱：只补 workPanel 一处=本面板用户仍卡死）。
    // 本面板显示链带 chatid（per-chat 槽）——按钮动作 payload 必须同 chatid（data-fg-chatid 携带），与显示同槽。
    // 补修（同族收口 C-8 附属）：切守卫单源 getChatId（sharedState.mjs:108，_CHATID_RE 校验）——非法 hash 返 ""，
    //   escapeHtml 只防 XSS 不验格式；此值随 data-fg-chatid 送后端 approve/advance/stopFlowGroup 分区键，须先守卫。
    const _fgcid = escapeHtml(window._beiluGetChatId?.() || "");
    const _btnStyle = 'font-size:0.6rem;padding:1px 6px;border-radius:4px;cursor:pointer;border:1px solid';
    if (fg.state.status === "awaiting_approval")
      rows.push(`<span style="display:flex;gap:4px;margin-top:2px;">
        <button class="grp-fg-approve" data-fg-chatid="${_fgcid}" style="${_btnStyle} var(--beilu-success);color:var(--beilu-success);background:transparent;">✓ 批准继续</button>
        <button class="grp-fg-stop" data-fg-chatid="${_fgcid}" style="${_btnStyle} var(--beilu-error);color:var(--beilu-error);background:transparent;">⏹ 停止</button></span>`);
    else if (fg.state.status === "running")
      rows.push(`<span style="display:flex;gap:4px;margin-top:2px;">
        <button class="grp-fg-advance" data-fg-chatid="${_fgcid}" style="${_btnStyle} var(--beilu-amber);color:var(--beilu-amber);background:transparent;">⏭ 推进下一步</button>
        <button class="grp-fg-stop" data-fg-chatid="${_fgcid}" style="${_btnStyle} var(--beilu-error);color:var(--beilu-error);background:transparent;">⏹ 停止</button></span>`);
  }
  if (!rows.length) return "";
  return `<div style="border:1px solid var(--beilu-amber-20);border-radius:5px;padding:4px 6px;margin-bottom:6px;display:flex;flex-direction:column;gap:2px;">
    <div style="font-size:0.6rem;opacity:0.4;margin-bottom:1px;">当前运行</div>${rows.join("")}</div>`;
}

const _statusMeta = {
  running: { c: "var(--beilu-success)", t: "运行中" },
  idle: { c: "var(--beilu-muted, #9ca3af)", t: "空闲" },
  stopped: { c: "var(--beilu-error)", t: "已停" },
};

async function _getEngineStatus() {
  try {
    // T6b：raw+手 r.ok 语义并入门面（!ok → 抛错→catch → false，与原返回 false 一致）
    const r = await sendAction({ verb: "getGroupsEngine", target: "shells:chat", source: "web" });
    return !!r?.enabled;
  } catch { /* ignore */ }
  return false;
}

let _renderPending = false;
async function render() {
  if (!_root || _renderPending) return;
  _renderPending = true;
  try { await _renderInner(); } finally { _renderPending = false; }
}

/** 渲染并行组运行态到任意容器（供 workPanel 等外部调用） */
export async function renderGroupRuntimeInto(container) {
  if (!container) return;
  // root 走显式参数，不再换入换出模块级 _root——_renderInner 多处 await，
  // 换入期间并发 render() 会把面板内容写进外部容器（隐式共享态竞态，根因级改参数传递）
  await _renderInner(container);
}
async function _renderInner(root = _root) {
  let groups = {};
  let engineOn = false;
  try {
    // T6b：raw+手 gr.ok 语义并入门面（!ok → 抛错 → catch → 离线态；原 gr.ok=false 单独走"读取组失败" 分支已合并进 catch 统一态）
    const [gr, eng] = await Promise.all([
      sendAction({ verb: "getGroups", target: "shells:chat", source: "web" }),
      _getEngineStatus(),
    ]);
    groups = gr?.groups || {};
    engineOn = eng;
  } catch { root.innerHTML = `<div style="font-size:0.7rem;opacity:0.4;">离线</div>`; return; }

  // 补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，_CHATID_RE 校验）——非法 hash 返 ""。
  //   cid 用于 :156 roles.some(c===cid) UI 高亮对比，与下方送后端的 _currentChatId 同源须同守卫（避免高亮/送值分叉）。
  const cid = window._beiluGetChatId?.() || "";
  const ids = Object.keys(groups);

  // 无并行组时隐藏整个折叠区，避免空面板强制展示
  const section = document.getElementById("right-group-runtime-section");
  if (section) section.style.display = ids.length ? "" : "none";
  // 补修（同族收口 C-8）：切守卫单源 getChatId（sharedState.mjs:108，_CHATID_RE 校验）——非法 hash 返 ""，
  //   不再裸读 substring 当 chatid 送后端 getFlowGroupStatusShared 分区键。对齐 cardsPanel.mjs:62 _cur() 范式。
  const _currentChatId = window._beiluGetChatId?.() || "";
  // T023 Q5：getFlowGroupStatus 走共享单飞+TTL（原 _memAction 独立拉取；per-chatid 键与其余面板天然分槽）。
  // 保留 _memAction 的 null-on-error 语义（shared 抛错→catch null）。
  const [sm, fg] = await Promise.all([
    _memAction("getSubModes"),
    getFlowGroupStatusShared({ chatid: _currentChatId }).catch(() => null),
  ]);
  const detailHtml = await _renderActiveDetail(sm, fg);
  const _subModeMap = sm?.active_sub_modes_map || {};
  const _subModeDefs = sm?.sub_modes || [];
  const engineHtml = `<div style="font-size:0.62rem;margin-bottom:4px;padding:2px 4px;border-radius:3px;display:inline-block;background:${engineOn ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.15)"};"><i data-ic="zap"></i> 并行引擎 <b style="color:${engineOn ? "var(--beilu-success)" : "var(--beilu-muted, #9ca3af)"};">${engineOn ? "ON" : "OFF"}</b></div>`;
  if (!ids.length) {
    root.innerHTML = engineHtml + detailHtml + `<div style="font-size:0.68rem;opacity:0.4;">无并行组（在 IDE 接口管理面板建组）</div>`;
    return;
  }

  root.innerHTML = engineHtml + detailHtml + ids.map((gid) => {
    const g = groups[gid];
    const sm = _statusMeta[g.status] || _statusMeta.idle;
    const roles = Object.entries(g.roles || {});
    const mine = roles.some(([, c]) => c === cid);
    const rolesHtml = roles.length
      ? roles.map(([role, c]) => {
          const _smId = _subModeMap[c];
          const _smDef = _smId ? _subModeDefs.find(m => m.id === _smId) : null;
          const _smLabel = _smDef ? ` <span style="opacity:0.4;font-size:0.56rem;">[${escapeHtml(_smDef.label || _smId)}]</span>` : "";
          return `<span class="beilu-group-role-jump" data-jump-chatid="${escapeHtml(c)}" style="font-size:0.62rem;opacity:0.55;cursor:pointer;${c === cid ? "color:var(--beilu-amber,#d4a017);" : ""}" title="点击切换到此对话">${escapeHtml(role)}${_smLabel}${c === cid ? "●" : ""}</span>`;
        }).join(" · ")
      : `<span style="font-size:0.6rem;" class="opacity-40">无角色</span>`;
    return `
      <div style="border:1px solid var(--beilu-amber-15);border-radius:5px;padding:4px 6px;margin-bottom:4px;${mine ? "background:var(--beilu-amber-6);" : ""}">
        <div style="display:flex;align-items:center;gap:5px;">
          <span style="width:6px;height:6px;border-radius:50%;background:${sm.c};flex-shrink:0;"></span>
          <span style="font-size:0.72rem;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(g.projectName || gid)}</span>
          <span style="font-size:0.6rem;color:${sm.c};">${sm.t}</span>
        </div>
        <div style="margin-top:2px;">${rolesHtml}</div>
      </div>`;
  }).join("");
}

let _pushBound = false;

export function initGroupRuntimePanel() {
  _root = document.getElementById("group-runtime-root");
  if (!_root) return;
  render();
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    const tab = document.body.dataset?.activeTab;
    if (tab !== "files" && tab !== "memory") return;
    const panel = document.getElementById("right-panel");
    if (panel && panel.offsetWidth > 0) render();
  }, 4000);
  if (!_pushBound) {
    _pushBound = true;
    window.addEventListener("beilu:group-runtime-update", () => render());
    _root.addEventListener("click", async (e) => {
      // T029 流程组运行控制（本面板槽=per-chatid，与显示链同 payload）
      const fgBtn = e.target.closest(".grp-fg-approve, .grp-fg-advance, .grp-fg-stop");
      if (fgBtn) {
        const verb = fgBtn.classList.contains("grp-fg-approve") ? "approveFlowGroup"
          : fgBtn.classList.contains("grp-fg-advance") ? "advanceFlowGroup" : "stopFlowGroup";
        fgBtn.disabled = true;
        try {
          const r = await sendAction({ verb, target: "plugins:beilu-memory", source: "web", payload: { chatid: fgBtn.dataset.fgChatid || "" } });
          if (r && r.success === false) throw new Error(r.error || verb + " 返回失败");
          window._beiluToast?.(verb === "approveFlowGroup" ? "✓ 已批准，流程组继续" : verb === "advanceFlowGroup" ? "⏭ 已推进下一步" : "⏹ 流程组已停止", "success");
        } catch (err) {
          window._beiluToast?.(`流程组操作失败(${verb}): ${err?.message || err}`, "error"); // T021 弹出规范
        }
        invalidateFlowGroupStatus(); // 清共享缓存，立即重渲取新状态
        render();
        return;
      }
      const el = e.target.closest("[data-jump-chatid]");
      if (el) switchToChat(el.dataset.jumpChatid);
    });
  }
}
