/**
 * idePanel.mjs — IDE 主控制面板
 *
 * 功能链：
 *   菜单栏点击 → handleMenuAction → 调后端 REST/WS 执行 IDE 动作（新建文件/搜索/跳转等）
 *   initIdeOpMonitor → pollIdeOpLog 轮询 → 拉取 IDE 工具操作日志 → renderToolResultDiff 生成红删绿增视图
 *   initIdeControls → 清理模式/手动清理/自动继续按钮绑事件 → POST beilu-files/beilu-memory setdata
 *
 * why：
 *   IDE 面板是 VSCode/Cursor 扩展与 beilu-chat 前端的交互枢纽；
 *   轮询 ideOpLog 让用户在聊天侧即时看到 AI 文件操作的 diff 可视化，无需切 IDE 窗口。
 *
 * 关联链：
 *   → diffRenderer.mjs（renderToolResultDiff：把 ide 工具 result 渲染为 diff HTML）
 *   → ideConnPanel.mjs（连接状态入口）
 *   → fileExplorer.mjs（文件浏览/编辑容器）
 *   → shared/transport/api-client.mjs apiFetch（所有后端通信统一出口）
 *   ← index.mjs（在 IDE 模式初始化时调用 initMenubar / initIdeControls / initIdeOpMonitor）
 *
 * 影响范围：
 *   菜单栏 DOM（.ide-menu-item / .ide-menu-dropdown / .ide-menu-action）、
 *   #ide-op-log 容器（diff 卡片追加）、清理模式 / 手动清理 / 自动继续按钮状态。
 *
 * 使用效果：
 *   点击菜单标签 → 展开下拉菜单，再点菜单项 → 触发对应 IDE 动作；
 *   操作日志轮询开启后，AI 对文件的每次写操作自动在面板插入彩色 diff 卡片；
 *   revertCheckpoint / loadCheckpointDiff 供 taskItemPanel 调用，实现回档彩色预览。
 */
import { renderToolResultDiff } from "./diffRenderer.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs";

/** [0727 多窗口窗口化·A5 审计] 本面板"当前线"的唯一读点：可见窗口优先（lineManager 单源桥）、
 *  hash 兜底。本文件 6 处 per-线操作（回档/diff/清理/定时续写）原直读 hash——副窗口显示时
 *  hash 仍是主窗口 a 的指针，回档这类破坏性动作会打到别的线（585 行注释早写明了要打本线，
 *  取值却取错了源）。无窗口体系时桥不存在，行为与原来逐字相同。 */
function _lineChatId() {
  try { const _w = window._beiluCurWinChatId?.(); if (_w) return _w; } catch { /* 桥未载 */ }
  return window._beiluGetChatId?.() || "";
}
import { showToast } from "../../../../../../scripts/toast.mjs";
import { wbDetect } from "../../shared/widgets/whitebox.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作 → files/memory 通配 + shells:chat#hideMessages）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { setCleanupMode } from "../feature/featureControls.mjs"; // T5：清理模式唯一写点直连（featureControls 已由核心链先加载，无循环依赖），删 else 直写双写点

// ============================================================
// 菜单栏
// ============================================================

/**
 * 初始化 IDE 菜单栏交互
 * @param {HTMLElement} ideMenubar
 */
export function initMenubar(ideMenubar) {
  if (!ideMenubar) return;

  let openMenu = null;

  ideMenubar.querySelectorAll(".ide-menu-item").forEach((item) => {
    const label = item.querySelector(".ide-menu-label");
    const dropdown = item.querySelector(".ide-menu-dropdown");
    if (!label || !dropdown) return;

    label.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openMenu === dropdown) {
        dropdown.classList.add("hidden");
        openMenu = null;
      } else {
        ideMenubar
          .querySelectorAll(".ide-menu-dropdown")
          .forEach((d) => d.classList.add("hidden"));
        dropdown.classList.remove("hidden");
        openMenu = dropdown;
      }
    });

    label.addEventListener("mouseenter", () => {
      if (openMenu && openMenu !== dropdown) {
        openMenu.classList.add("hidden");
        dropdown.classList.remove("hidden");
        openMenu = dropdown;
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (openMenu && !ideMenubar.contains(e.target)) {
      openMenu.classList.add("hidden");
      openMenu = null;
    }
  });

  ideMenubar.querySelectorAll(".ide-menu-action").forEach((action) => {
    action.addEventListener("click", () => {
      const act = action.dataset.action;
      if (openMenu) {
        openMenu.classList.add("hidden");
        openMenu = null;
      }
      handleMenuAction(act);
    });
  });
}

/**
 * 处理菜单动作
 * @param {string} action
 */
async function handleMenuAction(action) {
  const textarea = document.getElementById("file-editor-textarea");

  switch (action) {
    case "cleanup-context": {
      // 确诊-C：走守卫单源 getChatId()（sharedState.mjs:108，内含 _CHATID_RE 校验）——
      //   非法 hash（分段气泡/IDE 内部锚点）返 ""，不再裸读 substring 当 chatid 送后端写脏分区键。
      //   对齐 subModePanel.mjs:100-104 _getCurrentChatId 范式（window 全局单源，无需新增 import）。
      const chatid = _lineChatId();
      if (!chatid) {
        console.warn("[idePanel] 无法清理: 无 chatid");
        break;
      }
      try {
        // N6：getCleanupInfo 按 chatid 分区（payload.chatid）→ files 通配路由。!ok 由 apiFetch 抛错走 catch。
        const info = await sendAction({ verb: "getCleanupInfo", target: "plugins:beilu-files", source: "web", payload: { chatid } });
        if (info?.startIndex >= 0) {
          // hideMessages：scope.chatId 进 URL，body {startIndex}。
          const delResult = await sendAction({ verb: "hideMessages", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { startIndex: info.startIndex } });
          console.log(
            `[idePanel] 手动清理: 隐藏(不发送)了 ${delResult?.hidden} 条消息`,
          );
          window.dispatchEvent(new CustomEvent("chat:reload"));
        } else {
          console.log("[idePanel] 手动清理: 无需清理（未记录起始位置）");
        }
      } catch (err) {
        console.warn("[idePanel] 手动清理失败:", err.message);
      }
      break;
    }
    case "new-file":
      document.getElementById("file-tree-new-file")?.click();
      break;
    case "open-folder":
      document.getElementById("file-tree-open-folder")?.click();
      break;
    case "save":
      document.getElementById("file-save-btn")?.click();
      break;
    case "undo":
      if (textarea) document.execCommand("undo");
      break;
    case "redo":
      if (textarea) document.execCommand("redo");
      break;
    case "cut":
      document.execCommand("cut");
      break;
    case "copy":
      document.execCommand("copy");
      break;
    case "paste":
      if (textarea) {
        textarea.focus();
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text && textarea) {
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              textarea.value =
                textarea.value.substring(0, start) +
                text +
                textarea.value.substring(end);
              textarea.selectionStart = textarea.selectionEnd =
                start + text.length;
              textarea.dispatchEvent(new Event("input"));
            }
          })
          .catch((err) => {
            console.error('[idePanel]', err);
            window._reportError?.(`[idePanel] ${err.message}`, err.stack);
          });
      }
      break;
    case "find":
      openFindReplaceBar(false);
      break;
    case "replace":
      openFindReplaceBar(true);
      break;
    default:
      break;
  }
}

// ============================================================
// 编辑器查找/替换浮条（原生 textarea，纯文本匹配）
// ============================================================

/**
 * 打开查找/替换浮条（挂在 #file-editor-area，无 textarea 时静默返回）
 * @param {boolean} showReplace 是否展开替换行
 */
function openFindReplaceBar(showReplace) {
  const host = document.getElementById("file-editor-area");
  const textarea = document.getElementById("file-editor-textarea");
  if (!host || !textarea) return; // 二进制/未打开文件无编辑器

  let bar = document.getElementById("ide-find-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "ide-find-bar";
    bar.className = "ide-find-bar";
    bar.innerHTML = `
      <div class="ide-find-row">
        <input id="ide-find-input" class="ide-find-input" type="text" placeholder="查找" />
        <span id="ide-find-count" class="ide-find-count">0/0</span>
        <button id="ide-find-prev" class="ide-find-btn" title="上一个 (Shift+Enter)">▲</button>
        <button id="ide-find-next" class="ide-find-btn" title="下一个 (Enter)">▼</button>
        <button id="ide-find-close" class="ide-find-btn" title="关闭 (Esc)">✕</button>
      </div>
      <div class="ide-find-row ide-replace-row">
        <input id="ide-replace-input" class="ide-find-input" type="text" placeholder="替换为" />
        <button id="ide-replace-one" class="ide-find-btn ide-find-btn-text" title="替换当前">替换</button>
        <button id="ide-replace-all" class="ide-find-btn ide-find-btn-text" title="全部替换">全部</button>
      </div>`;
    host.appendChild(bar);
    _bindFindBarEvents(bar, textarea);
  }
  bar.querySelector(".ide-replace-row").style.display = showReplace ? "flex" : "none";
  bar.classList.remove("hidden");

  const findInput = bar.querySelector("#ide-find-input");
  const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
  if (sel && sel.length < 200 && !sel.includes("\n")) findInput.value = sel;
  findInput.focus();
  findInput.select();
  _findRefresh(bar, textarea);
}

/** 当前匹配游标（跨调用保留） */
let _findMatches = [];
let _findIdx = -1;

function _findRefresh(bar, textarea) {
  const term = bar.querySelector("#ide-find-input").value;
  const countEl = bar.querySelector("#ide-find-count");
  _findMatches = [];
  _findIdx = -1;
  if (term) {
    const hay = textarea.value.toLowerCase();
    const needle = term.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      _findMatches.push(i);
      i = hay.indexOf(needle, i + needle.length);
    }
  }
  countEl.textContent = `${_findMatches.length ? 1 : 0}/${_findMatches.length}`;
  if (_findMatches.length) _findGoto(0, bar, textarea, term.length);
}

function _findGoto(idx, bar, textarea, termLen) {
  if (!_findMatches.length) return;
  _findIdx = (idx + _findMatches.length) % _findMatches.length;
  const pos = _findMatches[_findIdx];
  textarea.focus();
  textarea.setSelectionRange(pos, pos + termLen);
  // 滚动到可见：用临时 blur/focus 触发原生滚动
  const line = textarea.value.substring(0, pos).split("\n").length;
  textarea.scrollTop = Math.max(0, (line - 3) * 18);
  bar.querySelector("#ide-find-count").textContent = `${_findIdx + 1}/${_findMatches.length}`;
}

function _bindFindBarEvents(bar, textarea) {
  const findInput = bar.querySelector("#ide-find-input");
  const replaceInput = bar.querySelector("#ide-replace-input");
  const close = () => { bar.classList.add("hidden"); textarea.focus(); };

  findInput.addEventListener("input", () => _findRefresh(bar, textarea));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      _findGoto(_findIdx + (e.shiftKey ? -1 : 1), bar, textarea, findInput.value.length);
    } else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  bar.querySelector("#ide-find-next").addEventListener("click", () => _findGoto(_findIdx + 1, bar, textarea, findInput.value.length));
  bar.querySelector("#ide-find-prev").addEventListener("click", () => _findGoto(_findIdx - 1, bar, textarea, findInput.value.length));
  bar.querySelector("#ide-find-close").addEventListener("click", close);

  bar.querySelector("#ide-replace-one").addEventListener("click", () => {
    const term = findInput.value;
    if (!term || _findIdx < 0) return;
    const pos = _findMatches[_findIdx];
    const cur = textarea.value.substring(pos, pos + term.length);
    if (cur.toLowerCase() !== term.toLowerCase()) { _findRefresh(bar, textarea); return; }
    textarea.value = textarea.value.substring(0, pos) + replaceInput.value + textarea.value.substring(pos + term.length);
    textarea.dispatchEvent(new Event("input"));
    _findRefresh(bar, textarea);
  });
  bar.querySelector("#ide-replace-all").addEventListener("click", () => {
    const term = findInput.value;
    if (!term) return;
    // 大小写不敏感全替换：按匹配位置从后往前替，避免位移
    const positions = _findMatches.slice().reverse();
    let v = textarea.value;
    for (const pos of positions) {
      v = v.substring(0, pos) + replaceInput.value + v.substring(pos + term.length);
    }
    textarea.value = v;
    textarea.dispatchEvent(new Event("input"));
    _findRefresh(bar, textarea);
  });
}


// ============================================================
// IDE 操作监控
// ============================================================

let _ideOpPollingTimer = null;

/**
 * 初始化 IDE 控制面板的操作监控区域
 * 绑定清空/刷新按钮，启动轮询
 */
export function initIdeOpMonitor() {
  const clearBtn = document.getElementById("ide-clear-op-log");
  const refreshBtn = document.getElementById("ide-refresh-op-log");

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      try {
        // 两库清理并行：verb=真动作→各自通配路由。allSettled 吞每条 sendAction 抛错（清理失败不阻断 UI 清空）。
        await Promise.allSettled([
          sendAction({ verb: "clearOperationHistory", target: "plugins:beilu-files", source: "web" }),
          sendAction({ verb: "clearIdeOperationHistory", target: "plugins:beilu-memory", source: "web" }),
        ]);
        const logEl = document.getElementById("ide-op-log");
        if (logEl) {
          logEl.innerHTML =
            '<p class="text-base-content/50 text-center py-2">暂无操作记录</p>';
        }
        const statsEl = document.getElementById("ide-op-stats");
        if (statsEl) statsEl.textContent = "总计: 0 | 成功: 0 | 失败: 0";
      } catch (err) {
        console.warn("[idePanel] 清空操作日志失败:", err.message);
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => pollIdeOpLog());
  }

  // [F4 管线归位 2026-07-19] 轮询生命周期挂 tab 激活：本面板只活在 files tab，
  //   原页面加载即启动永久 5s 轮询（AIRP/work 时段全程空转发 HTTP）。
  //   producer 唯一（layout.mjs switchTab 每次切换广播 detail=tabName，init 恢复也走同一广播
  //   且在本 init 注册之后）；切入 files 启动+立即拉一次，切出停止。
  //   取代 0718 夜被删的 DOM offsetParent 散装门控（设计_前端管线归位.md F4）。
  window.addEventListener("beilu:tab-activated", (e) => {
    if (e.detail === "files") _startIdeOpPolling();
    else _stopIdeOpPolling();
  });
}

function _startIdeOpPolling() {
  if (_ideOpPollingTimer) return;
  pollIdeOpLog();
  _ideOpPollingTimer = setInterval(pollIdeOpLog, 5000);
}

function _stopIdeOpPolling() {
  if (_ideOpPollingTimer) {
    clearInterval(_ideOpPollingTimer);
    _ideOpPollingTimer = null;
  }
}

/**
 * 拉取操作历史并渲染到 IDE 操作监控面板
 * 合并两个来源：beilu-files（文件操作）+ ideClient（IDE工具调用）
 */
async function pollIdeOpLog() {
  const logEl = document.getElementById("ide-op-log");
  const statsEl = document.getElementById("ide-op-stats");
  if (!logEl && !statsEl) return;

  try {
    // 并行拉取两个来源：verb=真动作→各自通配路由。allSettled 把 sendAction 抛错归为 rejected（下方按 fulfilled 取值），
    //   保留原「某来源不可用（IDE 未连接等）则该源为 null，另一源仍渲染」的降级语义。
    const [filesRes, ideRes] = await Promise.allSettled([
      sendAction({ verb: "getOperationHistory", target: "plugins:beilu-files", source: "web" }),
      sendAction({ verb: "getIdeOperationHistory", target: "plugins:beilu-memory", source: "web" }),
    ]);

    const filesData = filesRes.status === "fulfilled" ? filesRes.value : null;
    const ideData = ideRes.status === "fulfilled" ? ideRes.value : null;

    // 合并操作历史
    const filesHistory = (filesData?.history || []).map(op => ({
      ...op, _source: "files",
      detail: op.detail || op.operation || "unknown",
    }));
    const ideHistory = (ideData?.history || []).map(op => ({
      ...op, _source: "ide",
      detail: op.tool ? `${op.tool}(${_summarizeParams(op.params)})` : "unknown",
      success: op.success !== false,
    }));
    const allHistory = [...filesHistory, ...ideHistory]
      .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""))
      .slice(-50);

    // 合并统计
    const filesStats = filesData?.stats || { total: 0, success: 0, failed: 0 };
    const ideStats = ideData?.stats || { total: 0, success: 0, failed: 0 };
    const totalStats = {
      total: filesStats.total + ideStats.total,
      success: filesStats.success + ideStats.success,
      failed: filesStats.failed + ideStats.failed,
    };

    if (statsEl) {
      statsEl.textContent = `总计: ${totalStats.total} | 成功: ${totalStats.success} | 失败: ${totalStats.failed}`;
    }

    if (logEl) {
      if (allHistory.length === 0) {
        logEl.innerHTML =
          '<p class="text-base-content/50 text-center py-2">暂无操作记录</p>';
      } else {
        const html = allHistory
          .slice()
          .reverse()
          .map((op) => {
            const icon = op.success ? '<i data-ic="check"></i>' : '<i data-ic="cross"></i>';
            const time = op.timestamp
              ? new Date(op.timestamp).toLocaleTimeString()
              : "";
            const detail = op.detail || "unknown";
            let diffHtml = "";
            if (op.tool && op.params && op.success !== false) {
              diffHtml = renderToolResultDiff({
                tool: op.tool,
                params: op.params,
                result: op.result || { success: op.success },
              }) || "";
            }
            return `<div class="flex items-start gap-1 py-0.5 border-b border-base-300/30 last:border-0">
              <span>${icon}</span>
              <span class="flex-1 break-all">${escapeHtml(detail)}</span>
              <span class="text-base-content/50 shrink-0">${time}</span>
            </div>${diffHtml}`;
          })
          .join("");
        logEl.innerHTML = html;
      }
    }
  } catch {
    /* ignore polling errors */
  }
}

/** 将工具参数缩略为简短描述 */
function _summarizeParams(params) {
  if (!params) return "";
  const p = params.path || params.directory || params.command || params.query || "";
  if (typeof p === "string" && p.length > 40) return p.substring(p.length - 40);
  return String(p).substring(0, 40);
}

// ============================================================
// 检查点 diff / 回档 —— 经 本体 beilu-memory _action → YonBan _checkpoint_* 工具
// 列表展示=任务/回档面板（taskItemPanel 回档时间线，唯一权威）；本模块只管 diff 渲染与回档执行。
// ============================================================

export async function loadCheckpointDiff(id) {
  const diffEl = document.getElementById("ide-checkpoint-diff");
  if (!diffEl) return;
  diffEl.innerHTML = '<p class="text-base-content/50 py-2">加载 diff…</p>';
  try {
    // verb=getCheckpointDiff → memory 通配路由。!ok 由 apiFetch 抛错走 catch（下方 wbDetect 兜底）。
    const data = await sendAction({ verb: "getCheckpointDiff", target: "plugins:beilu-memory", source: "web", payload: { id, chatid: _lineChatId() } }); // [池化 0727] 按线取 diff：检查点已按线分池，不带线 id 会取到别的线的快照
    if (!data?.success) {
      diffEl.innerHTML = `<p class="text-error/60 py-2">${escapeHtml(data?.error || "取 diff 失败")}</p>`;
      return;
    }
    // 来源标题：diff 凭空出现在任务面板下方时，用户要知道这是哪个检查点的
    diffEl.innerHTML =
      `<div class="flex items-center justify-between text-[10px] text-base-content/50 border-t border-base-300/30 mt-1 pt-1">` +
        `<span><i data-ic="file"></i> 检查点 ${escapeHtml(String(id).slice(0, 12))} 的文件变更</span>` +
        `<button id="ide-cp-diff-close" class="btn btn-xs btn-ghost text-base-content/40" title="关闭 diff">✕</button>` +
      `</div>` +
      renderCheckpointDiffHtml(data.files || []);
    diffEl.querySelector("#ide-cp-diff-close")?.addEventListener("click", () => { diffEl.innerHTML = ""; });
  } catch (e) {
    wbDetect("ide", "loadCheckpointDiff", false, e?.message, { id });
    diffEl.innerHTML = `<p class="text-error/60 py-2">加载失败: ${escapeHtml(e.message || "")}</p>`;
  }
}

/**
 * 回档单个检查点入口（P3 彩色 diff 预览）：先 fetch getCheckpointDiff →
 * 弹预览卡（四类Δ汇总 + 逐文件红删绿增）→ 用户确认才执行回档。取消=零副作用。
 * 取 diff 失败 → 降级回旧版纯文字 confirm（不变式6 兜底），不阻断用户操作。
 */
export async function revertCheckpoint(id) {
  if (!id) return;
  let files = null;
  try {
    // verb=getCheckpointDiff → memory 通配路由。!ok/异常 → catch → files 保持 null → 走旧版 confirm 兜底。
    const data = await sendAction({ verb: "getCheckpointDiff", target: "plugins:beilu-memory", source: "web", payload: { id, chatid: _lineChatId() } }); // [池化 0727] 按线取 diff：检查点已按线分池，不带线 id 会取到别的线的快照
    if (data?.success && Array.isArray(data.files)) files = data.files;
  } catch (_) {
    // 取 diff 失败 → 走兜底，不打断
  }
  if (files === null) {
    // 兜底：取 diff 失败时仍用旧版纯文字 confirm（不变式6）
    if (!await beiluConfirm(`回档检查点「${id}」？\n\n将把该检查点记录的文件还原到改动前（AI 新建的文件会被删除）。\n此操作不可逆，但不影响对话消息与记忆表格。`)) return;
    await _executeRevert(id);
    return;
  }
  _showRevertPreview(id, files);
}

/** 把 getCheckpointDiff 的 files[] 按实际字段分四类（无 rename 字段 → 不造重命名假类）。 */
function _classifyCheckpointFiles(files) {
  const added = [], modified = [], deleted = [];
  for (const f of files) {
    if (f.deletedNow) { deleted.push(f); continue; }
    // 原始内容为空（hunks 全为 add）= AI 新建文件；否则视为修改。
    const hunks = f.hunks || [];
    const isNew = hunks.length > 0 && hunks.every((h) => h.type === "add");
    if (isNew) added.push(f); else modified.push(f);
  }
  return { added, modified, deleted };
}

/**
 * 弹回档彩色 diff 预览卡。后端 revertCheckpoint 不支持按文件回档 → 只展示+整体确认，不造勾选假能力。
 * 弹层背景=不透明主题色（bg-base-200），对比度达标。点遮罩/取消=零副作用关闭。
 */
function _showRevertPreview(id, files) {
  const { added, modified, deleted } = _classifyCheckpointFiles(files);
  const ov = document.createElement("div");
  ov.className = "fixed inset-0 bg-black/50 flex items-center justify-center p-4";
  ov.style.zIndex = "var(--z-diag)"; // 层级表单一权威（index.css :root），禁硬编码 9999

  const summaryChip = (label, n, color) =>
    `<span class="px-1.5 py-0.5 rounded text-xs" style="background:color-mix(in srgb, ${color} 10%, transparent);color:${color};">${label} ${n}</span>`;
  const summary = `<div class="flex flex-wrap gap-1.5 items-center">` +
    summaryChip("新增", added.length, "var(--beilu-success)") +
    summaryChip("修改", modified.length, "var(--beilu-warning)") +
    summaryChip("删除", deleted.length, "var(--beilu-error)") +
    `</div>`;

  const body = files.length
    ? renderCheckpointDiffHtml(files)
    : '<p class="text-base-content/50 py-2">该检查点无文件变更</p>';

  ov.innerHTML =
    `<div class="bg-base-200 rounded-lg shadow-xl w-[min(720px,92vw)] max-h-[85vh] flex flex-col">` +
      `<div class="p-3 border-b border-base-300 space-y-2 shrink-0">` +
        `<div class="font-bold text-sm">↩ 回档预览：<span class="break-all opacity-80">${escapeHtml(id)}</span></div>` +
        summary +
        `<div class="text-[11px] text-base-content/60">将把这些文件还原到改动前（AI 新建的文件会被删除）。此操作不可逆，但不影响对话消息与记忆表格。</div>` +
      `</div>` +
      `<div class="p-3 overflow-y-auto flex-1 min-h-0">${body}</div>` +
      `<div class="p-3 border-t border-base-300 flex gap-2 justify-end shrink-0">` +
        `<button id="cp-revert-cancel" class="btn btn-xs btn-ghost">取消</button>` +
        `<button id="cp-revert-confirm" class="btn btn-xs btn-error">确认回档</button>` +
      `</div>` +
    `</div>`;

  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector("#cp-revert-cancel").addEventListener("click", close);
  ov.querySelector("#cp-revert-confirm").addEventListener("click", async () => {
    close();
    await _executeRevert(id);
  });
}

/**
 * 真正执行单检查点文件回档（仅文件层）。不可逆；成功后该检查点已销毁 → 刷新列表 + 清 diff。
 * 由预览卡「确认回档」或兜底 confirm 调用。
 */
async function _executeRevert(id) {
  try {
    // verb=revertCheckpoint → memory 通配路由。!ok 由 apiFetch 抛错走 catch（统一"回档失败"提示）。
    const data = await sendAction({ verb: "revertCheckpoint", target: "plugins:beilu-memory", source: "web", payload: { id, chatid: _lineChatId() } }); // [池化 0727] 回档必须打到本线：不带线 id = 可能把别的线的文件状态回滚掉（破坏性）
    if (!data?.success) {
      showToast("error", "回档失败：" + (data?.error || "未知错误"));
      return;
    }
    const _errs = (data.errors || []).length;
    showToast(_errs ? "warning" : "success",
      `已回档：还原 ${data.restored ?? 0} 个、删除 ${data.deleted ?? 0} 个` + (_errs ? `，${_errs} 个出错` : ""));
    // 检查点列表家=任务/回档面板，广播让其重渲染（该检查点回档后已销毁）
    window.dispatchEvent(new CustomEvent("beilu:checkpoint-update"));
    const diffEl = document.getElementById("ide-checkpoint-diff");
    if (diffEl) diffEl.innerHTML = "";
  } catch (e) {
    showToast("error", "回档失败：" + (e.message || "网络错误"));
  }
}

/** 渲染 getCheckpointDiff 的输出（files[].hunks[]）为红删绿增，复用 diff-line-* 样式。 */
function renderCheckpointDiffHtml(files) {
  if (!files.length) return '<p class="text-base-content/50 py-2">该检查点无文件变更</p>';
  return files
    .map((f) => {
      const _authorBadge = f.author === "human" ? ' <span style="color:var(--beilu-warning);">[人/外部改]</span>' : ' <span style="color:color-mix(in oklch, var(--beilu-accent, #4fc3f7) 55%, var(--color-base-content));">[AI]</span>';
      const header = `<div class="diff-header">${escapeHtml(f.file)}${_authorBadge}${f.binary ? " (二进制)" : ""}${f.deletedNow ? " (已删除)" : ""}</div>`;
      if (f.binary) return `<div class="diff-container">${header}</div>`;
      const added = (f.hunks || []).filter((h) => h.type === "add").length;
      const removed = (f.hunks || []).filter((h) => h.type === "del").length;
      const stats = `<div class="diff-stats"><span class="diff-stat-add">+${added}</span> <span class="diff-stat-remove">−${removed}</span></div>`;
      const body = (f.hunks || [])
        .map((h) => {
          const cls = h.type === "del" ? "diff-line-remove" : h.type === "add" ? "diff-line-add" : "diff-line-context";
          const prefix = h.type === "del" ? "−" : h.type === "add" ? "+" : " ";
          return `<div class="${cls}"><span class="diff-prefix">${prefix}</span><span class="diff-content">${escapeHtml(h.content)}</span></div>`;
        })
        .join("");
      return `<div class="diff-container">${header}${stats}<div class="diff-body">${body}</div></div>`;
    })
    .join("");
}

// ============================================================
// IDE 控制面板其他控件
// ============================================================

/**
 * 初始化 IDE 控制面板中不属于权限/监控的其他控件
 * - 清理模式双向同步（IDE ↔ 右栏）
 * - 手动清理按钮
 * - 自动继续开关
 */
export function initIdeControlPanel() {
  // --- 侧栏权限等级快速选择 ---
  const sidebarLevel = document.getElementById("sidebar-permission-level");
  if (sidebarLevel) {
    // 加载当前等级：verb=getPermissionLevel → memory 通配路由，sendAction 直接返回解析体（含 level）。
    // T011 权限档位元数据单源：option 由响应的 levels（后端 storage.mjs PERM_LEVEL_META）填充，
    // HTML 不再持有语义副本；levels 未下发（后端未重启窗口期）→ 纯数字 L0-L4 回退（非语义副本）。
    sendAction({ verb: "getPermissionLevel", target: "plugins:beilu-memory", source: "web" }).then(d => {
      if (d?.level === undefined) return;
      const metas = Array.isArray(d.levels) && d.levels.length > 0
        ? d.levels
        : [0, 1, 2, 3, 4].map(n => ({ level: n, label: `L${n}`, desc: "档位说明未下发（后端未更新或重启前）" }));
      sidebarLevel.innerHTML = "";
      for (const m of metas) {
        const opt = document.createElement("option");
        opt.value = String(m.level);
        opt.textContent = m.label;
        opt.title = m.desc || "";
        sidebarLevel.appendChild(opt);
      }
      sidebarLevel.value = String(d.level);
    }).catch((err) => {
      console.error('[idePanel] 加载权限等级失败:', err);
      window._reportError?.(`[idePanel] ${err.message}`, err.stack);
    });
    // 切换时同步到后端：verb=setPermissionLevel（fire-and-forget，失败上报）。
    sidebarLevel.addEventListener("change", () => {
      sendAction({ verb: "setPermissionLevel", target: "plugins:beilu-memory", source: "web", payload: { level: parseInt(sidebarLevel.value) } }).catch((err) => {
        console.error('[idePanel] 同步权限等级失败:', err);
        window._reportError?.(`[idePanel] ${err.message}`, err.stack);
      });
    });
  }

  // --- 清理模式（IDE ↔ 右栏双向同步）---
  const ideCleanupMode = document.getElementById("ide-cleanup-mode");
  if (ideCleanupMode) {
    const saved = storage.get(KEYS.BEILU_CLEANUP_MODE);
    if (saved) ideCleanupMode.value = saved;
    ideCleanupMode.addEventListener("change", () => {
      // T5：唯一写点直连 featureControls.setCleanupMode（写键+同步全部三入口）。
      //   删原 else storage.set 直写=病2散写点；featureControls 已由核心链静态加载恒可用。
      setCleanupMode(ideCleanupMode.value);
    });
    const rightCleanup = document.getElementById("cleanup-mode-select");
    if (rightCleanup) {
      rightCleanup.addEventListener("change", () => {
        ideCleanupMode.value = rightCleanup.value;
      });
    }
  }

  // --- 手动清理按钮 ---
  const ideManualCleanup = document.getElementById("ide-manual-cleanup");
  if (ideManualCleanup) {
    ideManualCleanup.addEventListener("click", async () => {
      // 确诊-C：走守卫单源 getChatId()（同 cleanup-context :106），非法 hash 返 "" 不写脏分区键。
      const chatid = _lineChatId();
      if (!chatid) {
        console.warn("[idePanel] 无法清理: 无 chatid");
        return;
      }
      try {
        ideManualCleanup.innerHTML = '<i data-ic="hourglass"></i> 清理中...';
        ideManualCleanup.disabled = true;
        // N6：getCleanupInfo 按 chatid 分区（payload.chatid）→ files 通配路由。!ok 由 apiFetch 抛错走 catch。
        const info = await sendAction({ verb: "getCleanupInfo", target: "plugins:beilu-files", source: "web", payload: { chatid } });
        if (info?.startIndex >= 0) {
          // hideMessages：scope.chatId 进 URL，body {startIndex}。
          const delResult = await sendAction({ verb: "hideMessages", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { startIndex: info.startIndex } });
          console.log(
            `[idePanel] IDE 手动清理: 隐藏(不发送)了 ${delResult?.hidden} 条消息`,
          );
          window.dispatchEvent(new CustomEvent("chat:reload"));
        } else {
          console.log("[idePanel] IDE 手动清理: 无需清理（未记录起始位置）");
        }
      } catch (err) {
        console.warn("[idePanel] IDE 手动清理失败:", err.message);
      } finally {
        ideManualCleanup.innerHTML = '<i data-ic="broom"></i> 手动清理当前文件对话';
        ideManualCleanup.disabled = false;
      }
    });
  }

  // --- 自动保存开关 ---
  const ideAutoSave = document.getElementById("ide-auto-save");
  if (ideAutoSave) {
    const saved = storage.get(KEYS.BEILU_IDE_AUTO_SAVE);
    if (saved !== null) ideAutoSave.checked = saved !== "false";
    ideAutoSave.addEventListener("change", () => {
      storage.set(KEYS.BEILU_IDE_AUTO_SAVE, ideAutoSave.checked ? "true" : "false");
    });
  }

  // --- 自动继续开关 + 延迟 ---
  // 半接线修复（2026-07-14）：这两项原只写 localStorage、后端零消费者（悬空 UI）。
  // 现同步写后端单源 yonban_config.auto_continue（SetData setAutoContinueConfig），
  // 消费端=后端 generation 回合末续轮 + 审批完成续轮。localStorage 保留作 UI 回显。
  const ideAutoContinue = document.getElementById("ide-auto-continue");
  const delayInput = document.getElementById("ide-autocontinue-delay");
  const loopEnabledEl = document.getElementById("ide-loop-enabled");
  const loopTextEl = document.getElementById("ide-loop-text");
  const loopStopNEl = document.getElementById("ide-loop-stop-threshold"); // [0724 双停退出] AI 连续停止几轮结束 Loop
  const maxRoundsEl = document.getElementById("ide-auto-continue-max-rounds"); // [0726 容错修] 连续续轮上限熔断（0=不限）
  const _syncAutoContinueToBackend = () => {
    const _enabled = ideAutoContinue ? !!ideAutoContinue.checked : true;
    const _delayMs = delayInput
      ? Math.max(0, Math.min(30000, Math.round((parseFloat(delayInput.value) || 0) * 1000)))
      : 0;
    const _loopEnabled = loopEnabledEl ? !!loopEnabledEl.checked : false;
    const _loopText = loopTextEl ? loopTextEl.value : "";
    const _loopStopN = loopStopNEl ? Math.max(0, Math.min(99, parseInt(loopStopNEl.value, 10) || 0)) : 2;
    // [0726 容错修] max_auto_rounds：setAutoContinueConfig 是全量覆写，必须随其它字段一起发防半写。
    //   输入框空/非法时发 undefined（JSON 序列化即丢字段）→ 默认值口径留后端单源（setDataActions
    //   setAutoContinueConfig 兜 50），不在前端硬编码第二份默认值；注意不能用 `|| 0` 兜底——0 语义是
    //   "禁用熔断"，空值兜成 0 会静默关掉熔断。
    const _maxRoundsRaw = maxRoundsEl ? parseInt(maxRoundsEl.value, 10) : NaN;
    const _maxRounds = Number.isInteger(_maxRoundsRaw) && _maxRoundsRaw >= 0 ? Math.min(999, _maxRoundsRaw) : undefined;
    sendAction({ verb: "setAutoContinueConfig", target: "plugins:beilu-memory", source: "web", payload: { enabled: _enabled, delay_ms: _delayMs, loop_enabled: _loopEnabled, loop_inject_text: _loopText, loop_stop_threshold: _loopStopN, max_auto_rounds: _maxRounds } })
      .catch((e) => console.warn("[idePanel] 自动继续设置同步后端失败:", e?.message || e));
  };
  if (ideAutoContinue) {
    const saved = storage.get(KEYS.BEILU_FILE_AUTO_CONTINUE);
    if (saved !== null) ideAutoContinue.checked = saved !== "false";
    ideAutoContinue.addEventListener("change", async () => {
      // [0724 只许前端关·二次确认] 此开关是整条自动继续/Loop 自动化的唯一关闭出口（停止键/错误轮/
      //   中止轮均已解耦不再掐链）——关闭是重操作，必须二次确认；取消则回弹开关不落盘不同步。
      if (!ideAutoContinue.checked) {
        const _ok = await beiluConfirm("关闭「自动继续」将停止所有自动续轮与 Loop 自动化（这是唯一的关闭入口，聊天界面的停止键只停当前轮）。确定关闭？");
        if (!_ok) { ideAutoContinue.checked = true; return; }
      }
      storage.set(KEYS.BEILU_FILE_AUTO_CONTINUE, ideAutoContinue.checked);
      _syncAutoContinueToBackend();
    });
  }
  if (delayInput) {
    const savedDelay = storage.get(KEYS.BEILU_AUTOCONTINUE_DELAY);
    if (savedDelay) delayInput.value = (parseInt(savedDelay) / 1000).toString();
    delayInput.addEventListener("change", () => {
      const ms = Math.max(500, Math.min(30000, parseFloat(delayInput.value) * 1000));
      storage.set(KEYS.BEILU_AUTOCONTINUE_DELAY, ms.toString());
      _syncAutoContinueToBackend();
    });
  }
  // --- Loop 自动继续 ---
  if (loopEnabledEl) {
    const savedLoop = storage.get(KEYS.BEILU_LOOP_ENABLED);
    if (savedLoop !== null) loopEnabledEl.checked = savedLoop === "true";
    loopEnabledEl.addEventListener("change", async () => {
      // [0724 只许前端关·二次确认] Loop 关闭同样只此一个出口，关闭需确认（对称 ideAutoContinue）。
      if (!loopEnabledEl.checked) {
        const _ok = await beiluConfirm("关闭「Loop 自动继续」将停止 Loop 注入续轮（这是唯一的关闭入口）。确定关闭？");
        if (!_ok) { loopEnabledEl.checked = true; return; }
      }
      storage.set(KEYS.BEILU_LOOP_ENABLED, loopEnabledEl.checked ? "true" : "false");
      _syncAutoContinueToBackend();
    });
  }
  if (loopTextEl) {
    const savedLoopText = storage.get(KEYS.BEILU_LOOP_TEXT);
    if (savedLoopText !== null) loopTextEl.value = savedLoopText;
    loopTextEl.addEventListener("change", () => {
      storage.set(KEYS.BEILU_LOOP_TEXT, loopTextEl.value);
      _syncAutoContinueToBackend();
    });
  }
  if (loopStopNEl) {
    const savedStopN = storage.get(KEYS.BEILU_LOOP_STOP_N);
    if (savedStopN !== null && savedStopN !== "") loopStopNEl.value = savedStopN;
    loopStopNEl.addEventListener("change", () => {
      const n = Math.max(0, Math.min(99, parseInt(loopStopNEl.value, 10) || 0));
      loopStopNEl.value = String(n);
      storage.set(KEYS.BEILU_LOOP_STOP_N, String(n));
      _syncAutoContinueToBackend();
    });
  }
  // [0726 容错修] 连续续轮上限（后端单源，无 localStorage 缓存——同 clone_async 范式）
  if (maxRoundsEl) {
    maxRoundsEl.addEventListener("change", () => {
      const _n = parseInt(maxRoundsEl.value, 10);
      if (Number.isInteger(_n)) maxRoundsEl.value = String(Math.max(0, Math.min(999, _n)));
      _syncAutoContinueToBackend();
    });
  }
  // [0724 只许前端关·后端单源回填] init 原是"把面板(localStorage)值推后端一次"——localStorage 缺省/
  //   换浏览器/清缓存时，面板默认值（loop 默认不勾）会静默覆写后端真配置 = "自动继续被别处关闭"
  //   事故源之一（覆写还持久化）。倒转方向：init 读后端回填面板+localStorage 缓存，写后端只发生在
  //   用户 change（关闭还带二次确认）。读失败→面板保持本地回显、绝不推送覆写。
  if (ideAutoContinue || delayInput || loopEnabledEl) {
    sendAction({ verb: "getAutoContinueConfig", target: "plugins:beilu-memory", source: "web", payload: {} })
      .then((r) => {
        const _ac = r?.auto_continue;
        if (!_ac) return;
        if (ideAutoContinue) { ideAutoContinue.checked = _ac.enabled !== false; storage.set(KEYS.BEILU_FILE_AUTO_CONTINUE, ideAutoContinue.checked); }
        if (delayInput) { delayInput.value = ((_ac.delay_ms || 0) / 1000).toString(); storage.set(KEYS.BEILU_AUTOCONTINUE_DELAY, String(_ac.delay_ms || 0)); }
        if (loopEnabledEl) { loopEnabledEl.checked = !!_ac.loop_enabled; storage.set(KEYS.BEILU_LOOP_ENABLED, _ac.loop_enabled ? "true" : "false"); }
        if (loopTextEl) { loopTextEl.value = _ac.loop_inject_text || ""; storage.set(KEYS.BEILU_LOOP_TEXT, loopTextEl.value); }
        if (loopStopNEl) { loopStopNEl.value = String(Number.isInteger(_ac.loop_stop_threshold) ? _ac.loop_stop_threshold : 2); storage.set(KEYS.BEILU_LOOP_STOP_N, loopStopNEl.value); }
        // [0726 容错修] 连续续轮上限回填：generation.getAutoContinueConfig 单源保证必返整数（缺省兜 50 在后端），
        //   前端只在拿到整数时回填，读不到保持空显示不造第二份默认值。
        if (maxRoundsEl && Number.isInteger(_ac.max_auto_rounds)) maxRoundsEl.value = String(_ac.max_auto_rounds);
      })
      .catch((e) => console.warn("[idePanel] 自动继续配置读取失败（面板保持本地回显，不覆写后端）:", e?.message || e));
  }

  // --- 分身异步执行 ---
  // [0726 分身异步·003] 面板接线：后端单源 yonban_config.clone_async（SetData setCloneAsyncConfig），
  //   消费端=replyHandler 分身执行块判分支（enabled 显式 true 才异步）+ generation.getCloneAsyncConfig
  //   唤醒延迟。init 读后端回填面板（同上方 getAutoContinueConfig 范式，禁把面板默认值推后端）；
  //   change 全量写 enabled+wake_delay_ms 防半写，钳制口径在后端（setDataActions setCloneAsyncConfig）。
  const cloneAsyncEnabledEl = document.getElementById("ide-clone-async-enabled");
  const cloneAsyncWakeDelayEl = document.getElementById("ide-clone-async-wake-delay");
  const _syncCloneAsyncToBackend = () => {
    const _enabled = cloneAsyncEnabledEl ? !!cloneAsyncEnabledEl.checked : false;
    const _wakeDelayMs = cloneAsyncWakeDelayEl
      ? Math.max(0, Math.min(30000, parseInt(cloneAsyncWakeDelayEl.value, 10) || 0))
      : 0;
    sendAction({ verb: "setCloneAsyncConfig", target: "plugins:beilu-memory", source: "web", payload: { enabled: _enabled, wake_delay_ms: _wakeDelayMs } })
      .catch((e) => console.warn("[idePanel] 分身异步设置同步后端失败:", e?.message || e));
  };
  if (cloneAsyncEnabledEl) {
    cloneAsyncEnabledEl.addEventListener("change", _syncCloneAsyncToBackend);
  }
  if (cloneAsyncWakeDelayEl) {
    cloneAsyncWakeDelayEl.addEventListener("change", () => {
      const ms = Math.max(0, Math.min(30000, parseInt(cloneAsyncWakeDelayEl.value, 10) || 0));
      cloneAsyncWakeDelayEl.value = String(ms);
      _syncCloneAsyncToBackend();
    });
  }
  if (cloneAsyncEnabledEl || cloneAsyncWakeDelayEl) {
    sendAction({ verb: "getCloneAsyncConfig", target: "plugins:beilu-memory", source: "web", payload: {} })
      .then((r) => {
        const _ca = r?.clone_async;
        if (!_ca) return;
        if (cloneAsyncEnabledEl) cloneAsyncEnabledEl.checked = _ca.enabled === true;
        if (cloneAsyncWakeDelayEl) cloneAsyncWakeDelayEl.value = String(_ca.wake_delay_ms || 0);
      })
      .catch((e) => console.warn("[idePanel] 分身异步配置读取失败（面板保持默认显示，不覆写后端）:", e?.message || e));
  }

  // --- 定时继续 ---
  const schedEnabledEl = document.getElementById("ide-scheduled-enabled");
  const schedDaysContainer = document.getElementById("ide-scheduled-days");
  const schedTimeEl = document.getElementById("ide-scheduled-time");
  const schedTextEl = document.getElementById("ide-scheduled-text");
  const schedSaveBtn = document.getElementById("ide-scheduled-save");
  if (schedEnabledEl) {
    const savedSE = storage.get(KEYS.BEILU_SCHEDULED_ENABLED);
    if (savedSE !== null) schedEnabledEl.checked = savedSE === "true";
  }
  if (schedDaysContainer) {
    const savedDays = storage.get(KEYS.BEILU_SCHEDULED_DAYS);
    if (savedDays) {
      try {
        const days = JSON.parse(savedDays);
        schedDaysContainer.querySelectorAll("input[type=checkbox]").forEach((cb) => {
          cb.checked = days.includes(cb.value);
        });
      } catch { /* ignore */ }
    }
  }
  if (schedTimeEl) {
    const savedTime = storage.get(KEYS.BEILU_SCHEDULED_TIME);
    if (savedTime) schedTimeEl.value = savedTime;
  }
  if (schedTextEl) {
    const savedST = storage.get(KEYS.BEILU_SCHEDULED_TEXT);
    if (savedST !== null) schedTextEl.value = savedST;
  }
  if (schedSaveBtn) {
    schedSaveBtn.addEventListener("click", () => {
      const _se = schedEnabledEl ? schedEnabledEl.checked : false;
      const _days = [];
      if (schedDaysContainer) schedDaysContainer.querySelectorAll("input[type=checkbox]:checked").forEach((cb) => _days.push(cb.value));
      const _time = schedTimeEl ? schedTimeEl.value : "09:00";
      const _text = schedTextEl ? schedTextEl.value : "";
      storage.set(KEYS.BEILU_SCHEDULED_ENABLED, _se ? "true" : "false");
      storage.set(KEYS.BEILU_SCHEDULED_DAYS, JSON.stringify(_days));
      storage.set(KEYS.BEILU_SCHEDULED_TIME, _time);
      storage.set(KEYS.BEILU_SCHEDULED_TEXT, _text);
      sendAction({ verb: "setScheduledContinue", target: "plugins:beilu-memory", source: "web", payload: { enabled: _se, days: _days, time: _time, content: _text, charName: storage.get(KEYS.BEILU_LAST_CHAR) || "", chatid: _lineChatId() } })
        .then(() => window._beiluToast?.("定时设置已保存", "success"))
        .catch((e) => window._beiluToast?.("定时设置保存失败: " + (e?.message || e), "error"));
    });
  }

  // --- 续轮高级设置 ---
  const limitsSaveBtn = document.getElementById("ide-limits-save");
  if (limitsSaveBtn) {
    limitsSaveBtn.addEventListener("click", () => {
      const _pptB = document.getElementById("ide-ppt-budget");
      const _delR = document.getElementById("ide-delegate-rounds");
      const _swM = document.getElementById("ide-switch-loop-max");
      const _schP = document.getElementById("ide-scheduler-pacing");
      const payload = {};
      if (_pptB) payload.ppt_budget = parseInt(_pptB.value) || 0;
      if (_delR) payload.delegate_max_rounds = parseInt(_delR.value) || 0;
      if (_swM) payload.switch_loop_max = parseInt(_swM.value) || 0;
      if (_schP) payload.scheduler_pacing = _schP.checked;
      sendAction({ verb: "setAdvancedLimits", target: "plugins:beilu-memory", source: "web", payload })
        .then(() => window._beiluToast?.("高级设置已保存", "success"))
        .catch((e) => window._beiluToast?.("高级设置保存失败: " + (e?.message || e), "error"));
    });
  }

  // W71: 任务完成提示音开关
  const doneSoundToggle = document.getElementById("ide-done-sound");
  if (doneSoundToggle) {
    const saved = storage.get(KEYS.BEILU_DONE_SOUND);
    if (saved !== null) doneSoundToggle.checked = saved !== "false";
    doneSoundToggle.addEventListener("change", () => {
      storage.set(KEYS.BEILU_DONE_SOUND, doneSoundToggle.checked ? "true" : "false");
    });
  }

  // 0727 凛倾"铃声大一点"：提示音音量滑条（消费在 websocket._playDoneBeep，默认 0.5）
  const doneSoundVolume = document.getElementById("ide-done-sound-volume");
  if (doneSoundVolume) {
    const savedVol = parseFloat(storage.get(KEYS.BEILU_DONE_SOUND_VOLUME) || "0.5");
    doneSoundVolume.value = Number.isFinite(savedVol) ? String(savedVol) : "0.5";
    doneSoundVolume.addEventListener("change", () => {
      storage.set(KEYS.BEILU_DONE_SOUND_VOLUME, doneSoundVolume.value);
    });
  }
}
