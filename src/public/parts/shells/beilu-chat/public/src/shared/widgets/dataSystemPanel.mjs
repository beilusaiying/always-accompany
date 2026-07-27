/**
 * dataSystemPanel.mjs — data 系统「线路/警告」前端面板（记忆板块表格视图内）
 *
 * 功能链：
 *   initDataSystemPanel(container)（memtool._loadMemToolTable 在 initDataTable 渲染完记忆表格后追加挂载）
 *   → 自渲染 DOM → sendAction getDataSystem → 后端快照 { route, routeTotal, warnings, config, activeProject }
 *   → 渲染两区块：
 *   · route（编辑事件流）→ buildPatchChains（补丁链聚合）→ 同位置多次 edit 聚合链 + 超阈值标红
 *     → 加批注 → addRouteNote
 *   · warnings（反复修改红标）→ 消警 → ackDataWarning
 *
 * why：
 *   route/warnings 是「同处反复修改→警告」机制（凛倾收口设计）的用户侧呈现——route 由后端
 *   replyHandler ideToolCall 埋点自动写，AI 收到警告回流，这里让用户可见可消警；
 *   buildPatchChains（纯函数）把 route 里同位置多次 edit 聚合为链，超阈值标红——即「补丁链可视化」，
 *   让用户直观看到哪些位置被反复修改（潜在死循环/根因未解的信号）；
 *   面板挂在记忆板块表格视图（2026-07-16 凛倾拍板从 IDE 侧栏迁入）：原「框架/问题」两块与 code
 *   记忆表格 #3/#4 概念重复且 AI 链全死，已整链删除，架构/问题知识归记忆表格单源；
 *   route/warnings 的 active_project 由后端 action 侧自行解析，前端不传 taskName（职责隔离）。
 *
 * 关联链：
 *   ← memtool.mjs _loadMemToolTable（记忆 Tab 表格视图，随 dataTable 一起挂载/重建）
 *   → beilu-memory 插件后端（getDataSystem/addRouteNote/ackDataWarning）
 *   → scripts/toast.mjs（showToast：操作结果反馈）
 *   ← websocket.mjs handleBroadcastEvent（beilu:data-system-updated 跨窗口被动刷新，T052）
 *   导出：buildPatchChains（供测试和其它模块复用）
 *
 * 影响范围：
 *   后端 route/warnings 快照读取；DOM：记忆表格视图尾部 data 线路区块渲染；
 *   route warnings 读写影响 AI 任务调度感知（后端警告阈值触发提醒）。
 *
 * 使用效果：
 *   记忆板块「表格」视图底部实时查看当前任务的线路事件和警告；
 *   补丁链标红提示哪些位置被反复修改，辅助定位根因；可加批注、可消警。
 */
import { showToast } from "../../../../../../scripts/toast.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面（char_id 走 scope，专属 verb 覆盖 dataSystem 语义）
import { getCurrentCharId } from "../../panels/airp/utils.mjs";
import { escapeHtml } from "../state/utils.mjs"; // T7：HTML 转义收口到唯一权威实现（5 字符含单引号）

const _esc = escapeHtml;

function _ts(ms) {
  if (!ms) return "";
  try { return new Date(Number(ms)).toLocaleString(); } catch { return ""; }
}

/**
 * ★ 补丁链聚合（凛倾「反复修改给警告」的用户侧呈现，纯函数便于真实测试）。
 * 把 route 事件里 action==="edit" 的按 target 串分组，统计同位置被改次数；
 * count >= threshold 标 overThreshold（与后端 warnings 同口径：warning.position == target 串）。
 * @param {Array<{seq,ts,action,target,errorAfter}>} events route 事件
 * @param {number} threshold repeat_edit_threshold
 * @returns {Array<{target,count,overThreshold,persistentError,lastTs,seqs:number[]}>} 按次数降序
 */
export function buildPatchChains(events, threshold) {
  const thr = Number(threshold) > 0 ? Number(threshold) : 3;
  const map = new Map();
  for (const e of events || []) {
    if (!e || e.action !== "edit") continue;
    const key = String(e.target || "(unknown)");
    let chain = map.get(key);
    if (!chain) {
      chain = { target: key, count: 0, lastTs: 0, seqs: [], _errAll: true, _errAny: false };
      map.set(key, chain);
    }
    chain.count++;
    if ((e.ts || 0) > chain.lastTs) chain.lastTs = e.ts || 0;
    if (e.seq != null) chain.seqs.push(e.seq);
    const hasErr = e.errorAfter != null && e.errorAfter !== "";
    if (hasErr) chain._errAny = true; else chain._errAll = false;
  }
  const out = [];
  for (const c of map.values()) {
    out.push({
      target: c.target,
      count: c.count,
      overThreshold: c.count >= thr,
      persistentError: c.count >= thr && c._errAll && c._errAny,
      lastTs: c.lastTs,
      seqs: c.seqs,
    });
  }
  // 次数降序 → 同次数按末次时间降序，让最该关注的链置顶
  out.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  return out;
}

// ============================================================
// 渲染
// ============================================================

function _renderChains(chains) {
  if (!chains.length) return '<p class="text-base-content/50 py-1">（暂无编辑线路）</p>';
  return chains.map((c) => {
    const red = c.overThreshold;
    const cls = red ? "text-red-600 font-medium" : "text-base-content/70";
    const flag = c.persistentError ? " ⚠错误未消" : red ? " ⚠超阈值" : "";
    return `<div class="flex items-start gap-1 py-0.5 border-b border-base-300/30 last:border-0">
      <span class="${cls} shrink-0">×${c.count}</span>
      <span class="flex-1 break-all ${red ? "text-red-600" : ""}">${_esc(c.target)}${flag}</span>
      <span class="text-base-content/50 shrink-0 text-[9px]">${_esc(_ts(c.lastTs))}</span>
    </div>`;
  }).join("");
}

function _renderWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  const active = list.filter((w) => !w.acked);
  if (!active.length) return '<p class="text-base-content/50 py-1">（无未消警告）</p>';
  return active.map((w) => {
    const pos = _esc(w.position || "");
    const err = w.persistentError ? " · 错误持续" : "";
    return `<div class="flex items-center gap-1 py-0.5 border-b border-base-300/30 last:border-0">
      <span class="flex-1 break-all text-red-600">同处已改 ×${_esc(w.count)}${err}<br><span class="text-base-content/50 text-[9px]">${pos}</span></span>
      <button class="btn btn-xs btn-ghost text-base-content/50 shrink-0" data-ack-position="${pos}" title="消警">✓消警</button>
    </div>`;
  }).join("");
}

// ============================================================
// 拉取 + 装配
// ============================================================

async function refreshDataSystem() {
  const meta = document.getElementById("memds-meta");
  try {
    const data = await sendAction({ verb: "getDataSystem", target: "plugins:beilu-memory", source: "web", scope: { charId: getCurrentCharId() } });
    const ds = data?.data_system;

    const routeEl = document.getElementById("memds-route");
    const warnEl = document.getElementById("memds-warnings");

    if (!ds) {
      if (meta) meta.textContent = "（无 data 系统数据 / 后端未返回 data_system）";
      [routeEl, warnEl].forEach((el) => {
        if (el) el.innerHTML = '<p class="text-base-content/50 py-1">—</p>';
      });
      return;
    }

    const thr = ds.config?.repeat_edit_threshold ?? 3;
    const chains = buildPatchChains(ds.route || [], thr);
    if (routeEl) routeEl.innerHTML = _renderChains(chains);
    if (warnEl) warnEl.innerHTML = _renderWarnings(ds.warnings);

    if (meta) {
      const task = ds.activeProject || "(无活动任务)";
      meta.textContent = `任务: ${task} ｜ 线路 ${ds.routeTotal ?? (ds.route || []).length} 条 ｜ 阈值 ${thr}`;
    }

    // 绑定消警按钮（每次重渲染重新绑定）
    if (warnEl) {
      warnEl.querySelectorAll("[data-ack-position]").forEach((btn) => {
        btn.addEventListener("click", () => _ackWarning(btn.dataset.ackPosition));
      });
    }
  } catch (err) {
    if (meta) meta.textContent = "加载 data 系统失败: " + err.message;
    console.warn("[dataSystemPanel] 刷新失败:", err.message);
  }
}

async function _ackWarning(position) {
  if (!position) return;
  try {
    const body = await sendAction({
      verb: "ackDataWarning", target: "plugins:beilu-memory", source: "web",
      scope: { charId: getCurrentCharId() },
      payload: { position },
    });
    if (body?.success === false) {
      showToast("error", "消警失败: " + (body?.error || "未知错误"));
      return;
    }
    showToast("info", "已消警");
    refreshDataSystem();
  } catch (err) {
    showToast("error", "消警失败: " + err.message);
  }
}

async function _addRouteNote() {
  const input = document.getElementById("memds-note-input");
  const note = input?.value?.trim();
  if (!note) { showToast("error", "请先填写批注内容"); return; }
  try {
    const body = await sendAction({
      verb: "addRouteNote", target: "plugins:beilu-memory", source: "web",
      scope: { charId: getCurrentCharId() },
      payload: { note },
    });
    if (body?.success === false) {
      showToast("error", "加批注失败: " + (body?.error || "未知错误"));
      return;
    }
    if (input) input.value = "";
    showToast("info", "批注已追加");
    refreshDataSystem();
  } catch (err) {
    showToast("error", "加批注失败: " + err.message);
  }
}

/**
 * 初始化 data 线路/警告面板：自渲染 DOM 进 container，绑定刷新/批注/消警，首次拉取。
 * container 由 memtool 表格视图提供（dataTable 重建时旧 DOM 一并被清，重挂即重初始化，无重复监听）。
 * @param {HTMLElement} container
 */
export function initDataSystemPanel(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="bg-base-300/50 rounded-lg p-2 space-y-1 mt-2 text-[10px]">
      <div class="flex items-center justify-between mb-1">
        <p class="text-xs font-medium text-amber-700"><i data-ic="chart"></i> data 线路 · 补丁链</p>
        <button id="memds-refresh" class="btn btn-xs btn-ghost text-base-content/40" title="刷新线路/警告"><i data-ic="refresh"></i></button>
      </div>
      <div id="memds-meta" class="text-[9px] text-base-content/40">加载中...</div>
      <div id="memds-route" class="max-h-40 overflow-y-auto font-mono"></div>
      <div class="flex items-center gap-1 mt-0.5">
        <input id="memds-note-input" type="text" class="input input-xs input-bordered flex-1 text-[10px]" placeholder="给线路加批注…" />
        <button id="memds-note-add" class="btn btn-xs btn-ghost text-base-content/50" title="追加批注（append，不抹历史）">＋</button>
      </div>
      <div class="mt-1">
        <span class="font-medium text-red-600"><i data-ic="warning"></i> 反复修改警告</span>
        <div id="memds-warnings" class="max-h-40 overflow-y-auto font-mono"></div>
      </div>
    </div>`;

  container.querySelector("#memds-refresh")?.addEventListener("click", () => refreshDataSystem());
  container.querySelector("#memds-note-add")?.addEventListener("click", () => _addRouteNote());

  refreshDataSystem();
}

// ============================================================
// T052：跨窗口 data 变更被动刷新（consumer 侧）。
// ------------------------------------------------------------
// 后端 addRouteNote/ackDataWarning 写成功 → _broadcastDataSystemUpdate → WS →
//   websocket.mjs handleBroadcastEvent 桥接为 CustomEvent("beilu:data-system-updated") → 此处刷新。
//
// 监听器挂模块顶层（模块只 import 一次）而非 initDataSystemPanel 内——面板随 dataTable 重建会重复
//   init，放 init 内会累积重复监听（内存泄漏 + 一次广播多次刷新）。模块级 = 全生命周期只绑一次。
//
// 过滤（防串窗，与后端 scope 语义对齐）：
//   · scope==="char"：route/warnings 是 per-char，仅当广播的 charId === 本窗口当前卡才刷（不串到别张卡）。
//     （2026-07-16 去重后后端只剩 char scope producer；未知 scope 容忍直刷，防前后端版本错位漏刷。）
//   · 面板未挂载（memds-meta 不存在）直接跳过：不发无谓网络请求（refreshDataSystem 无 DOM 守卫）。
window.addEventListener("beilu:data-system-updated", (e) => {
  const detail = e?.detail || {};
  if (!document.getElementById("memds-meta")) return;
  if (detail.scope === "char") {
    if (detail.charId && detail.charId !== getCurrentCharId()) return;
  }
  refreshDataSystem();
});
