/**
 * taskTimeline.mjs — 编程模式 IDE 操作时间线面板
 *
 * 功能链：
 *   initTaskTimeline(containerId) → 渲染面板骨架（标题栏 + 图例 + 列表区）
 *     → 首次 refreshTimeline(containerId)
 *   refreshTimeline → 并行拉取两个后端真源（N40 重写，废弃旧 DOM 抓取方案）：
 *     ① POST beilu-files setdata {_action:"getOperationHistory"} → file_op 历史
 *     ② POST beilu-memory setdata {_action:"getIdeOperationHistory"} → IDE 工具历史
 *     → 合并 + 按时间排序 → 渲染时间线条目行（彩色圆点 + 类型标签 + 摘要）
 *   点「🔄 刷新」按钮 → 重新拉取并渲染
 *   点时间线条目 → 按时间最近邻（±15min 窗）匹配 #chat-messages 内 .chat-message[data-timestamp]
 *     → scrollIntoView + 高亮（消息侧锚点=messageList.mjs 审查#7 专为本面板埋的 data-timestamp）；
 *     窗口外/消息不在 DOM（切对话/清屏）→ 条目红闪反馈不跳转
 *   TYPE_COLORS 颜色映射：user-request=蓝/code-edit=绿/search=黄/table-edit=紫/archive=灰/compress=橙/error=红
 *
 * why（废弃旧 DOM 抓取方案）：
 *   旧实现从 #chat-messages DOM 抓取消息（切对话/清屏即丢，只见当前窗口可见消息），
 *   N40 改为读后端真源（file_op 历史 + IDE 工具历史），跨对话持久、跨窗口一致。
 *
 * why（tsMs 时间戳归一，断链#36 修复）：
 *   两源 timestamp 格式不一——beilu-files=Date.now() 毫秒数、beilu-memory=ISO 串。
 *   旧 localeCompare 混排必错（"2026-…">"1751…"，IDE 恒压 FILES），FILES 时间列 substring 出乱码；
 *   且 N40 后条目不再携带消息引用，点击定位链断。三症同根：入列时统一转 tsMs（epoch ms），
 *   排序/显示/定位全走 tsMs，定位靠消息侧 data-timestamp 时间最近邻还原关联。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（beilu-files / beilu-memory 双源拉取）
 *   ← layout.mjs / idePanel.mjs（IDE 侧边栏时间线面板初始化时调用 initTaskTimeline）
 *
 * 影响范围：
 *   containerId 对应的 DOM 容器（`${containerId}-list` 列表区）；
 *   无持久化状态，每次刷新重拉后端数据。
 *
 * 使用效果：
 *   IDE 面板侧边栏展示当前会话的操作历史时间线（文件编辑/搜索/归档等分色显示）；
 *   点「刷新」更新到最新操作；点条目可定位到聊天流中对应消息。
 */

import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-files/beilu-memory 操作历史双源收口
import { escapeHtml } from "../../shared/state/utils.mjs"; // T7：HTML 转义收口到唯一权威实现（5 字符含单引号）

const TYPE_COLORS = {
  "user-request": "var(--beilu-accent, #4fc3f7)",
  "code-edit": "var(--beilu-success, #66bb6a)",
  search: "var(--beilu-search, #ffd54f)",
  "table-edit": "var(--beilu-purple, #ce93d8)",
  archive: "var(--beilu-muted, #90a4ae)",
  compress: "var(--beilu-warning, #ff9800)",
  error: "var(--beilu-error, #ef5350)",
  text: "var(--beilu-text-dim, #e0e0e0)",
};

const TYPE_LABELS = {
  "user-request": "指令",
  "code-edit": "编辑",
  search: "搜索",
  "table-edit": "表格",
  archive: "归档",
  compress: "压缩",
  error: "错误",
  text: "文本",
};

/**
 * 初始化任务时间线面板
 * @param {string} containerId - 面板容器 DOM id
 */
export function initTaskTimeline(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:4px 8px;">
      <span style="font-size:0.78rem; font-weight:600; color:var(--beilu-amber,#d4a017);"><i data-ic="clipboard"></i> 任务时间线</span>
      <button class="timeline-refresh-btn" title="刷新" style="background:none; border:none; cursor:pointer; font-size:0.85rem; padding:2px 4px; color:inherit;"><i data-ic="refresh"></i></button>
    </div>
    <div class="timeline-legend" style="display:flex; flex-wrap:wrap; gap:4px; padding:2px 8px 6px; font-size:0.6rem; opacity:0.6;"></div>
    <div id="${containerId}-list" style="flex:1; overflow-y:auto; padding:0 4px;"></div>
  `;

  // 渲染图例
  const legendEl = container.querySelector(".timeline-legend");
  if (legendEl) {
    legendEl.innerHTML = Object.entries(TYPE_COLORS)
      .filter(([k]) => k !== "text")
      .map(
        ([k, c]) =>
          `<span style="display:inline-flex; align-items:center; gap:2px;"><span style="width:6px; height:6px; border-radius:50%; background:${c}; display:inline-block;"></span>${TYPE_LABELS[k] || k}</span>`,
      )
      .join("");
  }

  container
    .querySelector(".timeline-refresh-btn")
    ?.addEventListener("click", () => refreshTimeline(containerId));

  // 初次加载
  refreshTimeline(containerId);
}

const _escTl = escapeHtml; // T7：alias 到唯一权威实现（原本地 5 字符 replace 链已删）

/** 时间戳归一：ms 数字 / 数字串 / ISO 串 / Date 串 → epoch ms（解析失败=0 沉底） */
function _tsMs(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  const t = Number.isFinite(n) ? n : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 点条目 → 定位聊天流对应消息。
 * 后端历史记录无消息引用（N40 数据源迁移丢失关联），用时间最近邻还原：
 * 在 #chat-messages 的 .chat-message[data-timestamp]（审查#7 生产侧锚点）里找 |Δt| 最小者，
 * ±15min 窗内 → scrollIntoView+琥珀高亮；窗外/无消息 → 条目红闪（可见反馈，不静默）。
 */
function _locateMessageByTs(tsMs, itemEl) {
  const WINDOW_MS = 15 * 60 * 1000;
  let best = null;
  let bestDt = Infinity;
  if (tsMs) {
    const scope = document.getElementById("chat-messages") || document;
    for (const el of scope.querySelectorAll(".chat-message[data-timestamp]")) {
      const mt = _tsMs(el.getAttribute("data-timestamp"));
      if (!mt) continue;
      const dt = Math.abs(mt - tsMs);
      if (dt < bestDt) { bestDt = dt; best = el; }
    }
  }
  if (best && bestDt <= WINDOW_MS) {
    best.scrollIntoView({ behavior: "smooth", block: "center" });
    const prevOutline = best.style.outline;
    const prevOffset = best.style.outlineOffset;
    best.style.outline = "2px solid var(--beilu-amber, #d4a017)";
    best.style.outlineOffset = "2px";
    setTimeout(() => {
      best.style.outline = prevOutline;
      best.style.outlineOffset = prevOffset;
    }, 1600);
  } else if (itemEl) {
    itemEl.style.background = "color-mix(in srgb, var(--beilu-error, #ef5350) 25%, transparent)";
    // 恢复按当下 hover 态定，不回写点击瞬间快照——点击时必处 hover（快照=amber），
    // 移开后 timeout 回写快照会把 hover 色卡死
    setTimeout(() => {
      itemEl.style.background = itemEl.matches(":hover") ? "var(--beilu-amber-8)" : "";
    }, 700);
  }
}

/**
 * 刷新时间线列表
 * N40（IDE模式_界面设计.md :163 设计数据源）：改读后端真源——
 *   beilu-files getOperationHistory（file_op 历史）+ beilu-memory getIdeOperationHistory（IDE 工具历史），
 *   合并按时间排序。旧实现从 DOM #chat-messages 抓取（切对话/清屏即丢、只见当前窗口可见消息）已废。
 */
async function refreshTimeline(containerId) {
  const listEl = document.getElementById(`${containerId}-list`);
  if (!listEl) return;
  listEl.innerHTML =
    '<div style="text-align:center; padding:16px; font-size:0.75rem; opacity:0.4;">加载中...</div>';

  const items = [];
  let stats = { total: 0, success: 0, failed: 0 };

  // 源1: beilu-files 操作历史
  try {
    // T6b批7：原 raw fetch（POST setdata + 自 .json()）→ sendAction。verb=真动作，beilu-files#* 通配组装 {_action:verb}。
    const data = await sendAction({ verb: "getOperationHistory", target: "plugins:beilu-files", source: "web" });
    for (const op of data?.history || []) {
      items.push({
        src: "FILES",
        label: op.operation || op.detail || "(file_op)",
        detail: op.detail || "",
        success: op.success !== false,
        tsMs: _tsMs(op.timestamp),
      });
    }
    if (data?.stats) {
      stats.total += data.stats.total || 0;
      stats.success += data.stats.success || 0;
      stats.failed += data.stats.failed || 0;
    }
  } catch { /* 单源失败不阻塞另一源 */ }

  // 源2: IDE 工具操作历史
  try {
    // T6b批7：原 raw fetch（POST setdata + 自 .json()）→ sendAction。verb=真动作，beilu-memory#* 通配组装 {_action:verb}。
    const data = await sendAction({ verb: "getIdeOperationHistory", target: "plugins:beilu-memory", source: "web" });
    for (const op of data?.history || []) {
      items.push({
        src: "IDE",
        label: op.operation || op.tool || op.type || "(ide)",
        detail: op.detail || op.error || (op.args ? JSON.stringify(op.args).substring(0, 80) : ""),
        success: op.success !== false,
        tsMs: _tsMs(op.timestamp),
      });
    }
    if (data?.stats) {
      stats.total += data.stats.total || 0;
      stats.success += data.stats.success || 0;
      stats.failed += data.stats.failed || 0;
    }
  } catch { /* 同上 */ }

  // 图例位改为统计行
  const container = document.getElementById(containerId);
  const legendEl = container?.querySelector(".timeline-legend");
  if (legendEl) {
    legendEl.innerHTML = `总计 ${stats.total} · <i data-ic="check"></i> ${stats.success} · <i data-ic="cross"></i> ${stats.failed}`;
  }

  if (items.length === 0) {
    listEl.innerHTML =
      '<div style="text-align:center; padding:16px; font-size:0.75rem; opacity:0.4;">暂无操作记录</div>';
    return;
  }

  // 按时间倒序（最新在上）；timestamp 缺失/不可解析（tsMs=0）沉底。
  // 数值比较替代 localeCompare：两源格式不一（ms数字 vs ISO串）时字符串排序必错。
  items.sort((a, b) => b.tsMs - a.tsMs);

  listEl.innerHTML = items
    .map((item) => {
      const color = item.success
        ? TYPE_COLORS["code-edit"]
        : TYPE_COLORS.error;
      const icon = item.success ? '<i data-ic="check"></i>' : '<i data-ic="cross"></i>';
      const srcTag =
        item.src === "IDE"
          ? '<span style="font-size:0.55rem; background:color-mix(in srgb, var(--beilu-accent) 20%, transparent); color:var(--beilu-accent); padding:0 3px; border-radius:2px; margin-left:4px;">IDE</span>'
          : '<span style="font-size:0.55rem; background:rgba(245,158,11,0.2); color:var(--beilu-warning); padding:0 3px; border-radius:2px; margin-left:4px;">FILES</span>';
      // MM-DD HH:mm（本地时区；旧实现对 ISO 串 substring 取段，FILES 的 ms 数字会切出乱码）
      let timeStr = "";
      if (item.tsMs) {
        const d = new Date(item.tsMs);
        const p2 = (x) => String(x).padStart(2, "0");
        timeStr = `<span style="font-size:0.55rem; opacity:0.4; flex-shrink:0;">${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}</span>`;
      }
      const titleTxt = (item.detail ? item.detail + "\n" : "") + "点击定位到对应消息";
      return `
      <div class="timeline-item" data-ts="${item.tsMs}" title="${_escTl(titleTxt)}" style="display:flex; align-items:flex-start; gap:6px; padding:4px 6px; border-left:3px solid ${color}; margin-bottom:2px; border-radius:0 3px 3px 0; font-size:0.72rem; transition:background 0.15s; cursor:pointer;">
        <span style="flex-shrink:0;">${icon}</span>
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:0.7;">${_escTl(item.label)}</span>
        ${srcTag}${timeStr}
      </div>
    `;
    })
    .join("");

  listEl.querySelectorAll(".timeline-item").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      el.style.background = "var(--beilu-amber-8)";
    });
    el.addEventListener("mouseleave", () => {
      el.style.background = "";
    });
    // 断链#36 修复：接上头注释承诺的「点条目定位消息」（消费侧从未接线，生产侧锚点见 messageList 审查#7）
    el.addEventListener("click", () => _locateMessageByTs(Number(el.dataset.ts) || 0, el));
  });
}
