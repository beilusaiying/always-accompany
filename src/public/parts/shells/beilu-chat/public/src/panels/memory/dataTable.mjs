/**
 * dataTable.mjs — 记忆系统表格编辑器（增强版）
 *
 * 功能链：
 *   initDataTable(username, charId, container) → loadTablesForChar
 *     → sendAction plugins:beilu-memory#getData 桥（payload={char_id,viewMode}，username 桥 session 盖章；T2批2 迁移，原 GET config/getdata 直连退役）
 *       （注：POST setdata {_action:"getTables"} 是后端缓存失效动作非取数，setDataActions:890——20260706 传导链核后注释校准）
 *     → 渲染标签页 #0-#9（或更多）+ 当前表格网格（列头 + 数据行）
 *   单元格点击 → contenteditable 内联编辑 → 失焦 → isDirty=true
 *   列头点击 → 编辑列名 → 增删列按钮
 *   表格名双击 → 编辑表格名
 *   规则区点击 → 编辑 insert/update/delete 规则（控制 AI 何时写表）
 *   表格启用/禁用 toggle → 禁用后该表不注入 AI 提示词
 *   点「保存」→ POST {_action:"saveTables"} → name+columns+rules+enabled+rows 完整落盘
 *   行增 → appendRow；行/列删除走后端 deleteTableRows/deleteTableColumn（discard 变体+删前自动快照），
 *   前端只发意图+reload，无本地 splice 第二套移出实现。
 *   归档唯一入口=「归档」设置弹窗 openArchiveDialog（自动归档配置：max_rows/archive_batch/keep_recent，
 *   联动后端 autoCheckArchiveTriggers 阈值自动归档；归档对象只是内容行，不归档列——凛倾 2026-07-16 裁决，
 *   列级归档功能已整链删除）
 *   _gridFilter 搜索框 → 前端过滤当前表行（保持原始行索引，过滤后仍能正确增删）
 *   _selectedRows 多选 → 批量删除（checkbox 行选择）
 *
 * why（viewMode 对称读写）：
 *   window._beiluMemViewMode 区分 chat/code/work 三种记忆表模式，
 *   读写都带 viewMode 才能保证：在 chat 会话里查看 code 表时编辑也落 code 表，不串模式。
 *   空 viewMode 让后端按会话 active_mode 回退（兼容旧行为）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs（本模块直接 fetch，绕过 apiFetch；diagLogger 上报调试信息）
 *   → shared/state/diagLogger.mjs createDiag("memory")（表格操作调试日志）
 *   → shared/widgets/beiluDialog.mjs beiluPrompt（增加表格/列名输入）
 *   → shared/widgets/whitebox.mjs wbDetect（保存失败时白盒上报）
 *   ← memoryPresetChat.mjs / layout.mjs（记忆 Tab 内"表格"视图时调用 initDataTable）
 *
 * 影响范围：
 *   #dt-container（表格编辑器根容器）、后端 beilu-memory tables.json 落盘；
 *   isDirty 内存状态（未保存离开时提示）、_selectedRows / _gridFilter 会话内状态。
 *
 * 使用效果：
 *   点单元格直接编辑；点列头改名/增删列；双击表格名改名；toggle 控制是否注入 AI；
 *   点保存后数据持久化，下次 AI 回复时会读取表格数据注入提示词。
 */

import { createDiag } from "../../shared/state/diagLogger.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T2批23：7条 memory 直连 traceFetch 迁 sendAction 门面（getData 桥/setdata 通配桥；接受丢 traceFetch 计时）
import { wbDetect } from "../../shared/widgets/whitebox.mjs";
import { escapeHtml, whenVisible } from "../../shared/state/utils.mjs"; // 收口: 原本地副本漏转义 ' (属性单引号上下文不安全)→改用权威 utils.escapeHtml(全5字符)；whenVisible=0718 可见性门控
import { beiluPrompt, beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
const diag = createDiag("memory");

// ===== 状态 =====
let currentUsername = "";
let currentCharId = "";
let tables = [];
let currentTableIndex = 0;
let _gridFilter = ""; // R4 过滤词（合并 v4，前端过滤当前表，保持原始行索引）
let _selectedRows = new Set(); // R1 批量选删（合并 v4）：存原始行索引，切表时清空
let isDirty = false;
let _boundCharId = ""; // 绑定的角色卡（从 chat.mjs charList 传入）

// ===== DOM 引用 =====
let _container = null;
let _dom = {};

// ===== 危险确认（R9/R10：取消=默认焦点，删除=次级红字，替代原生 confirm）=====
// 0716 轮子收口：原自建第二套 <dialog>（#dt-danger-confirm）纯删，薄转调权威 beiluConfirm 的
//   danger 变体（beiluDialog.mjs——R9/R10 设计已收编进权威：取消默认焦点+确认红字次级+对话框队列）。
//   本地签名 {title,message,confirmText} 保留，4 个调用点零改动。
function _dangerConfirm({ title, message, confirmText = "删除" }) {
  return beiluConfirm(message, { title, confirmText, danger: true });
}

// ===== API 调用 =====

// ①解耦（合并 v4）：查看模式 = 看哪个模式的记忆表格（chat/code/work），来自全局
// window._beiluMemViewMode（mem-mode-switch-btn 设）。空 = 后端按会话 active_mode 回退（同旧行为）。
// 读写都带 viewMode 才框架级对称：在 chat 会话看 code 表，编辑也落 code 表（不串模式）。
function _currentViewMode() {
  const v = typeof window !== "undefined" ? window._beiluMemViewMode : "";
  return v === "chat" || v === "code" || v === "work" ? v : "";
}

async function fetchMemoryData(username, charId) {
  // T2批23：迁 sendAction getData 桥（registerBridgeAction "plugins:beilu-memory#getData"→functions:memory，
  //   buildBody={args:{...payload}}）。username 删除=桥 session 盖章覆盖；_t 破缓存戳删除=桥走 POST /dispatch
  //   无 URL query 缓存问题；viewMode 进 payload.args 由 getDataHandler 消费。桥 unwrap 取 res.data=旧 res.json() 裸体。
  const _vm = _currentViewMode();
  return sendAction({
    verb: "getData",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { char_id: charId, ...(_vm ? { viewMode: _vm } : {}) },
  });
}

async function saveTableToBackend(username, charId, tableIndex, tableData) {
  // T2批23：迁 sendAction 通配桥（"plugins:beilu-memory#*"→functions:memory，buildBody={data:{_action:verb,...payload},args:{}}）。
  //   _action:"updateTable" 提升为 verb；charName 保留在 payload（走后端 data.charName 优先消费，桥 args:{} 空不丢 char_id）；
  //   username 不带（桥 session 盖章）。桥 unwrap 取 res.data=旧 res.json() 裸体，conflict/rev 判定保形。
  diag.log(
    `saveTableToBackend: #${tableData.id} (index=${tableIndex}) "${tableData.name}" rows=${tableData.rows?.length} cols=${tableData.columns?.length} enabled=${tableData.enabled}`,
  );
  const _body = await sendAction({
    verb: "updateTable",
    target: "plugins:beilu-memory",
    source: "web",
    payload: {
      charName: charId,
      tableId: tableData.id, // ★ Phase 2: 用 table.id 标识（后端按 id 查找）
      tableIndex, // 兼容旧后端
      rows: tableData.rows,
      columns: tableData.columns,
      rules: tableData.rules,
      name: tableData.name,
      enabled: tableData.enabled,
      expectedRev: tableData.rev ?? 0, // N12：乐观并发版本号。未写过的表 rev 缺省→送 0（非 undefined），使两窗都 fresh 时首次并发保存也走冲突检测；AI/旧调用不带此字段=强写零回归
      ...(_currentViewMode() ? { viewMode: _currentViewMode() } : {}),
    },
  });
  // N12：HTTP 200 也可能 conflict（rev 不匹配）——拒写未持久化，须显式判，否则假成功覆盖别窗改动
  if (_body?.conflict) throw new Error(_body.error || "表格已被其它窗口修改，请刷新后重试");
  if (_body?.rev != null) tableData.rev = _body.rev; // 写成功后更新本地 rev，供后续保存对账
  return _body;
}

async function listTableSnapshots(username, charId) {
  // 修2 断链A（20260716）：收口走 _archiveAction（统一注入 charName + mode=查看桶）。
  //   原裸发 {charName} 无 mode → 后端全量返回三模式所有快照混列，恢复别桶快照=跨桶污染。
  //   现后端 listTableSnapshots 按 mode 过滤（+legacy 无 mode 条目），视图=列表同桶。
  diag.log(`listTableSnapshots: charName="${charId}"`);
  return _archiveAction({ _action: "listTableSnapshots" });
}

// ===== 表格快照（只读） =====

function formatSnapshotTime(ts) {
  if (!ts) return "-";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

// escapeHtml 已收口至权威 utils.escapeHtml(import 见文件头),原本地副本漏转义 ' 已删除

function renderSnapshots(snapshots) {
  if (!_dom.snapshotsBody) return;

  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    _dom.snapshotsBody.innerHTML =
      '<div style="text-align:center;color:var(--beilu-amber-35);padding:0.75rem;">暂无快照</div>';
    return;
  }

  let html =
    '<table class="dt-table" style="width:100%;"><thead><tr>' +
    '<th class="dt-col-header">时间</th>' +
    '<th class="dt-col-header">原因</th>' +
    '<th class="dt-col-header">表格数</th>' +
    '<th class="dt-col-header">聊天/楼层</th>' +
    '<th class="dt-col-header"></th>' +
    "</tr></thead><tbody>";

  for (const s of snapshots) {
    const loc =
      (s.chatId != null ? escapeHtml(s.chatId) : "-") +
      " / #" +
      (s.messageIndex != null ? escapeHtml(s.messageIndex) : "-");
    html +=
      "<tr>" +
      `<td class="dt-cell" title="${escapeHtml(s.timestamp)}">${escapeHtml(formatSnapshotTime(s.timestamp))}</td>` +
      `<td class="dt-cell">${escapeHtml(s.reason) || "-"}</td>` +
      `<td class="dt-cell" style="text-align:center;">${s.tableCount != null ? escapeHtml(s.tableCount) : "-"}</td>` +
      `<td class="dt-cell">${loc}</td>` +
      `<td class="dt-cell"><button class="dt-snap-restore" data-snap-id="${escapeHtml(s.id)}" style="cursor:pointer;font-size:0.75rem;padding:1px 6px;border:1px solid var(--beilu-amber-35);border-radius:3px;background:transparent;color:var(--beilu-amber-50);">↩ 恢复</button></td>` +
      "</tr>";
  }

  html += "</tbody></table>";
  _dom.snapshotsBody.innerHTML = html;

  _dom.snapshotsBody.querySelectorAll(".dt-snap-restore").forEach(btn => {
    btn.addEventListener("click", async () => {
      const snapId = btn.dataset.snapId;
      if (!await beiluConfirm(`恢复到表格快照 ${snapId}？当前表格状态会被覆盖。`)) return;
      btn.textContent = "恢复中...";
      btn.disabled = true;
      try {
        // 修2 断链A（20260716）：收口走 _archiveAction（统一注入 charName + mode=查看桶）。
        //   原裸发无 mode → 后端按会话 active_mode 写桶，与 UI 读桶(viewMode)分叉=「恢复不了」+污染别桶。
        //   现后端按 mode 路由 + 快照自带 mode 跨桶拒绝；success:false 由 _archiveAction 抛错进 catch。
        await _archiveAction({ _action: "restoreTableSnapshot", snapshotId: snapId });
        setStatus("快照已恢复");
        // 本文件无 loadTables（改名残留会抛 ReferenceError 被 catch 吞成"恢复失败"假报）——真名=loadTablesForChar
        await loadTablesForChar(currentUsername, currentCharId);
      } catch (e) {
        setStatus(`恢复失败: ${e.message}`);
      }
      btn.textContent = "↩ 恢复";
      btn.disabled = false;
    });
  });
}

async function loadSnapshots() {
  if (!currentUsername || !currentCharId) {
    setStatus("请先绑定角色卡");
    return;
  }
  if (_dom.snapshotsBody) {
    _dom.snapshotsBody.innerHTML =
      '<div style="text-align:center;color:var(--beilu-amber-50);padding:0.75rem;">加载中...</div>';
  }
  try {
    const result = await listTableSnapshots(currentUsername, currentCharId);
    if (result && result.error) throw new Error(result.error);
    const snapshots = (result && result.snapshots) || [];
    diag.log(`loadSnapshots: 获取到 ${snapshots.length} 个快照`);
    renderSnapshots(snapshots);
    setStatus(`已加载 ${snapshots.length} 个快照`);
  } catch (err) {
    diag.error("loadSnapshots: 加载失败", err.message);
    console.error("[dataTable] 加载快照失败:", err);
    if (_dom.snapshotsBody) {
      _dom.snapshotsBody.innerHTML = `<div style="text-align:center;color:rgba(239,68,68,0.8);padding:0.75rem;">加载快照失败：${escapeHtml(err.message)}</div>`;
    }
    setStatus(`加载快照失败: ${err.message}`);
  }
}

function toggleSnapshotsPanel() {
  if (!_dom.snapshotsPanel) return;
  const isHidden = _dom.snapshotsPanel.style.display === "none";
  if (isHidden) {
    _dom.snapshotsPanel.style.display = "";
    loadSnapshots();
  } else {
    _dom.snapshotsPanel.style.display = "none";
  }
}

// ===== 渲染完整编辑器 UI =====

function renderEditorUI(container) {
  container.innerHTML = `
		<div class="dt-editor" style="display:flex;flex-direction:column;height:100%;">
			<!-- 顶部工具栏：角色卡绑定显示 + 统计 -->
			<div class="dt-toolbar">
				<div class="dt-toolbar-group">
					<span style="font-size:0.75rem;color:var(--beilu-amber);font-weight:600;"><i data-ic="brain"></i> 记忆表格</span>
					<span id="dt-char-label" style="font-size:0.7rem;color:var(--beilu-amber-70);padding:0.15rem 0.5rem;border:1px solid var(--beilu-amber-20);border-radius:0.25rem;background:var(--beilu-amber-5);">未绑定角色</span>
					<button id="dt-refresh-btn" class="dt-btn dt-btn-sm" title="刷新"><i data-ic="refresh"></i></button>
					<button id="dt-snapshots-btn" class="dt-btn dt-btn-sm" title="查看表格快照（只读）">⊞ 快照</button>
				</div>
				<div class="dt-toolbar-group">
					<span id="dt-stats" style="font-size:0.65rem;color:var(--beilu-amber-50);"></span>
				</div>
			</div>

			<!-- Phase2: 压缩摘要已移至 #mem-summary-panel（index.html 记忆选项卡顶部） -->

			<!-- 表格标签页 -->
			<div id="dt-table-tabs" class="dt-toolbar" style="padding:0.25rem 0.5rem;gap:0.25rem;border-top:none;flex-wrap:nowrap;overflow-x:auto;">
			</div>

			<!-- 表格信息栏 -->
			<div id="dt-table-info" class="dt-toolbar" style="padding:0.25rem 0.75rem;border-top:none;display:none;">
				<div class="dt-toolbar-group" style="gap:0.4rem;align-items:center;">
					<span id="dt-table-id" class="dt-table-label"></span>
					<span id="dt-table-name" style="font-size:0.75rem;font-weight:500;cursor:pointer;" title="双击编辑表格名称"></span>
					<span id="dt-table-dirty" style="color:var(--beilu-warning);font-size:0.7rem;display:none;">● 未保存</span>
					<!-- 启用/禁用 toggle -->
					<label id="dt-enabled-toggle" style="display:inline-flex;align-items:center;gap:0.25rem;cursor:pointer;font-size:0.65rem;color:var(--beilu-amber-70);margin-left:0.5rem;" title="启用/禁用此表格（禁用后不注入AI）">
						<input type="checkbox" id="dt-enabled-checkbox" style="accent-color:var(--beilu-amber);cursor:pointer;">
						<span id="dt-enabled-label">已启用</span>
					</label>
				</div>
				<div class="dt-toolbar-group dt-actions">
					<span id="dt-row-count" class="dt-table-count"></span>
					<button id="dt-add-row-btn" class="dt-btn dt-btn-sm" title="添加行"><i data-ic="plus"></i><span class="dt-btn-lbl"> 添加行</span></button>
					<button id="dt-add-col-btn" class="dt-btn dt-btn-sm" title="添加新列"><i data-ic="ruler"></i><span class="dt-btn-lbl"> 添加列</span></button>
					<button id="dt-add-table-btn" class="dt-btn dt-btn-sm" title="新增表格"><i data-ic="chart"></i><span class="dt-btn-lbl"> 新增表格</span></button>
					<button id="dt-del-table-btn" class="dt-btn dt-btn-sm" title="删除当前表格" style="display:none;"><i data-ic="trash"></i><span class="dt-btn-lbl"> 删除表格</span></button>
					<button id="dt-archive-btn" class="dt-btn dt-btn-sm" title="归档设置（开启自动归档：超行数上限自动把旧行存为热层文件）"><i data-ic="package"></i><span class="dt-btn-lbl"> 归档</span></button>
					<button id="dt-save-btn" class="dt-btn dt-btn-sm dt-btn-primary dt-save" title="保存"><i data-ic="save"></i><span class="dt-btn-lbl"> 保存</span></button>
				</div>
			</div>

			<!-- 表格快照列表（只读） -->
			<div id="dt-snapshots-panel" class="dt-table-wrapper" style="display:none;margin:0.25rem 0.75rem;border:1px solid var(--beilu-amber-20);border-radius:0.35rem;background:var(--beilu-amber-3);">
				<div style="display:flex;align-items:center;justify-content:space-between;padding:0.3rem 0.5rem;border-bottom:1px solid var(--beilu-amber-15);">
					<span style="font-size:0.7rem;color:var(--beilu-amber);font-weight:600;"><i data-ic="camera"></i> 表格快照（只读）</span>
					<div class="dt-toolbar-group" style="gap:0.25rem;">
						<button id="dt-snapshots-refresh-btn" class="dt-btn dt-btn-sm" title="刷新快照列表"><i data-ic="refresh"></i></button>
						<button id="dt-snapshots-close-btn" class="dt-btn dt-btn-sm" title="收起">✕</button>
					</div>
				</div>
				<div id="dt-snapshots-body" style="max-height:14rem;overflow:auto;padding:0.25rem 0.5rem;font-size:0.65rem;color:var(--beilu-amber-70);">
					<div style="text-align:center;color:var(--beilu-amber-35);padding:0.75rem;">点击「<i data-ic="refresh"></i>」加载快照</div>
				</div>
			</div>

			<!-- 规则提示（可编辑） -->
			<div id="dt-rules" style="padding:0.25rem 0.75rem;font-size:0.6rem;color:var(--beilu-amber-50);display:none;">
				<span style="color:var(--beilu-amber-35);"><i data-ic="clipboard"></i></span>
				插入: <span id="dt-rule-insert" class="dt-rule-editable" title="点击编辑插入规则">-</span>
				 · 更新: <span id="dt-rule-update" class="dt-rule-editable" title="点击编辑更新规则">-</span>
				 · 删除: <span id="dt-rule-delete" class="dt-rule-editable" title="点击编辑删除规则">-</span>
			</div>

			<!-- 表格网格 -->
			<div id="dt-grid-container" class="dt-content-area" style="flex:1;overflow:auto;">
				<!-- 空状态 -->
				<div id="dt-empty" class="dt-empty-state">
					<div class="dt-empty-icon"><i data-ic="brain"></i></div>
					<div class="dt-empty-title">记忆表格编辑器</div>
					<div class="dt-empty-desc">绑定到当前聊天的角色卡，自动加载记忆数据</div>
				</div>
				<!-- 表格 -->
				<div id="dt-grid-wrapper" class="dt-table-wrapper" style="display:none;">
					<div style="padding:0.25rem 0.4rem;display:flex;gap:0.4rem;align-items:center;">
						<input id="dt-filter" placeholder="🔍 过滤本表条目…（合并 v4 R4）" style="flex:1;min-width:0;box-sizing:border-box;padding:0.25rem 0.5rem;font-size:0.7rem;background:rgba(255,255,255,0.06);border:1px solid var(--beilu-amber-25);border-radius:4px;color:inherit;outline:none;">
						<div id="dt-batch-bar" style="display:none;gap:0.4rem;align-items:center;white-space:nowrap;">
							<span id="dt-batch-count" style="font-size:0.65rem;color:var(--beilu-amber-70);"></span>
							<button id="dt-batch-del" class="dt-btn dt-btn-sm" style="color:var(--beilu-error);" title="删除所有选中行（不留档，删除前自动快照）"><i data-ic="trash"></i> 删除选中</button>
							<button id="dt-batch-clear" class="dt-btn dt-btn-sm" title="清空选择">取消</button>
						</div>
					</div>
					<table class="dt-table">
						<thead id="dt-grid-head"></thead>
						<tbody id="dt-grid-body"></tbody>
					</table>
				</div>
			</div>

			<!-- 状态栏 -->
			<div style="display:flex;align-items:center;justify-content:space-between;padding:0.125rem 0.5rem;background:var(--beilu-amber-dark);color:var(--beilu-amber-text);font-size:0.6rem;flex-shrink:0;">
				<span id="dt-status">就绪</span>
				<span>记忆编辑器</span>
			</div>
		</div>

		<style>
			.dt-rule-editable {
				cursor: pointer;
				border-bottom: 1px dashed var(--beilu-amber-30);
				padding: 0 0.15rem;
				transition: color 0.15s, border-color 0.15s;
			}
			.dt-rule-editable:hover {
				color: var(--beilu-amber);
				border-bottom-color: var(--beilu-amber);
			}
			.dt-col-header-editable {
				cursor: pointer;
				position: relative;
			}
			.dt-col-header-editable:hover {
				background: var(--beilu-amber-15) !important;
			}
			/* 列删除按钮：贴列头右上角，悬浮列头才显示（删除走后端 deleteTableColumn，删前自动快照） */
			.dt-col-delete-btn {
				position: absolute;
				top: -2px;
				right: -2px;
				font-size: 0.6rem;
				cursor: pointer;
				opacity: 0;
				transition: opacity 0.15s;
				background: var(--beilu-error, #ef4444);
				color: #fff;
				border: none;
				border-radius: 50%;
				width: 14px;
				height: 14px;
				line-height: 14px;
				text-align: center;
				padding: 0;
			}
			.dt-col-header-editable:hover .dt-col-delete-btn {
				opacity: 1;
			}
			.dt-tab-disabled {
				opacity: 0.45;
				text-decoration: line-through;
			}
			.dt-row-selected td {
				background: var(--beilu-amber-12);
			}
			/* 编辑栏窄宽自适应：右组换行 + 极窄按钮 emoji 降级 + 保存常驻贴右。
			   容器查询以 .dt-editor 宽（=面板/窗口宽）为基准，多窗口/窄侧栏下编辑按钮不再被裁。 */
			.dt-editor { container-type: inline-size; }
			.dt-actions { flex-wrap: wrap; row-gap: 0.25rem; justify-content: flex-end; }
			.dt-save { position: sticky; right: 0.25rem; }
			@container (max-width: 560px) {
				.dt-btn-lbl { display: none; }
				#dt-table-info .dt-btn-sm { padding: 0.2rem 0.35rem; }
			}
		</style>
	`;

  // 缓存 DOM 引用
  _dom.charLabel = container.querySelector("#dt-char-label");
  _dom.refreshBtn = container.querySelector("#dt-refresh-btn");
  _dom.snapshotsBtn = container.querySelector("#dt-snapshots-btn");
  _dom.snapshotsPanel = container.querySelector("#dt-snapshots-panel");
  _dom.snapshotsBody = container.querySelector("#dt-snapshots-body");
  _dom.snapshotsRefreshBtn = container.querySelector("#dt-snapshots-refresh-btn");
  _dom.snapshotsCloseBtn = container.querySelector("#dt-snapshots-close-btn");
  _dom.stats = container.querySelector("#dt-stats");
  _dom.tableTabs = container.querySelector("#dt-table-tabs");
  _dom.tableInfo = container.querySelector("#dt-table-info");
  _dom.tableId = container.querySelector("#dt-table-id");
  _dom.tableName = container.querySelector("#dt-table-name");
  _dom.tableDirty = container.querySelector("#dt-table-dirty");
  _dom.enabledToggle = container.querySelector("#dt-enabled-toggle");
  _dom.enabledCheckbox = container.querySelector("#dt-enabled-checkbox");
  _dom.enabledLabel = container.querySelector("#dt-enabled-label");
  _dom.rowCount = container.querySelector("#dt-row-count");
  _dom.addRowBtn = container.querySelector("#dt-add-row-btn");
  _dom.addColBtn = container.querySelector("#dt-add-col-btn");
  _dom.addTableBtn = container.querySelector("#dt-add-table-btn");
  _dom.delTableBtn = container.querySelector("#dt-del-table-btn");
  _dom.archiveBtn = container.querySelector("#dt-archive-btn");
  _dom.saveBtn = container.querySelector("#dt-save-btn");
  _dom.rules = container.querySelector("#dt-rules");
  _dom.ruleInsert = container.querySelector("#dt-rule-insert");
  _dom.ruleUpdate = container.querySelector("#dt-rule-update");
  _dom.ruleDelete = container.querySelector("#dt-rule-delete");
  _dom.gridContainer = container.querySelector("#dt-grid-container");
  _dom.empty = container.querySelector("#dt-empty");
  _dom.gridWrapper = container.querySelector("#dt-grid-wrapper");
  _dom.gridHead = container.querySelector("#dt-grid-head");
  _dom.gridBody = container.querySelector("#dt-grid-body");
  // R4 过滤框（合并 v4）：输入即前端过滤当前表，保持原始行索引
  _dom.filter = container.querySelector("#dt-filter");
  _dom.filter?.addEventListener("input", () => {
    _gridFilter = _dom.filter.value;
    const t = tables[currentTableIndex];
    if (t) renderGrid(t);
  });
  // R1 批量选删（合并 v4）：选中条统计 + 批量删 + 清空选择
  _dom.batchBar = container.querySelector("#dt-batch-bar");
  _dom.batchCount = container.querySelector("#dt-batch-count");
  container.querySelector("#dt-batch-del")?.addEventListener("click", _batchDeleteRows);
  container.querySelector("#dt-batch-clear")?.addEventListener("click", () => {
    _selectedRows.clear();
    const t = tables[currentTableIndex];
    if (t) renderGrid(t);
    _updateBatchBar();
  });
  _dom.status = container.querySelector("#dt-status");
  // Phase2: 压缩摘要已移至外部 #mem-summary-panel，不再缓存到 _dom
}

// ===== 角色卡绑定 =====

/**
 * 绑定到指定角色卡并加载数据
 * @param {string} charId - 角色卡名称
 * @param {string} [username] - 用户名（可选）
 */
async function bindToChar(charId, username) {
  try {
    diag.log(`bindToChar: charId="${charId || ""}" username="${username || ""}"`);
    if (!charId) {
      diag.log("bindToChar: 解绑（charId为空）");
      if (_dom.charLabel) {
        _dom.charLabel.textContent = "未绑定角色";
        _dom.charLabel.style.color = "var(--beilu-amber-50)";
      }
      showEmpty();
      tables = [];
      currentCharId = "";
      _boundCharId = "";
      return;
    }

    _boundCharId = charId;
    currentCharId = charId;

    const urlParams = new URLSearchParams(window.location.search);
    // ★ B24修复：移除硬编码用户名，改用通用默认值
    currentUsername = username || urlParams.get("username") || "_default";

    // 更新绑定标签
    if (_dom.charLabel) {
      _dom.charLabel.textContent = `🔗 ${charId}`;
      _dom.charLabel.style.color = "var(--beilu-amber)";
    }

    await loadTablesForChar(currentUsername, charId);
  } catch (err) {
    diag.error("bindToChar: 绑定失败", err.message);
    console.error("[dataTable] bindToChar 失败:", err);
    setStatus(`绑定失败: ${err.message}`);
  }
}

// 本面板「实际显示的记忆桶」：加载成功时钉住 = viewMode 非空取 viewMode，
//   空则取后端实际服务的 activeMode（getDataHandler 回传）。归档/删除动作一律送这个桶 →
//   视图与动作永远同桶，切 tab/别窗漂移 active_mode 也打不歪（异步时序病根）。
let _loadedMode = "";

async function loadTablesForChar(username, charId) {
  showEmpty();
  setStatus("加载中...");

  try {
    const data = await fetchMemoryData(username, charId);
    const _am = data.activeMode;
    _loadedMode = _currentViewMode() || ((_am === "code" || _am === "work" || _am === "chat") ? _am : "");
    // [2026-07-16 查看按钮锚本窗真值] 无用户显式查看选择时，用后端返回的 activeMode（getData 桥带
    // chatid 后 = per-窗口 active_modes_map 真值）校准全局查看态：memswitch 初值取 getCurrentMode()
    // = localStorage 全局单值，多窗口共享会显示别窗模式（凛倾 0716「上面不是应该显示当前模式吗」）。
    // 只同步显示（beilu:mem-view-calibrated 仅刷按钮），不派 mem-view-changed——本次 data 就是按该
    // 模式取的，重载即死循环。用户点击循环切换（mem-view-changed 消费链）不受影响。
    if (!_currentViewMode() && (_am === "code" || _am === "work" || _am === "chat") && window._beiluMemViewMode !== _am) {
      window._beiluMemViewMode = _am;
      window.dispatchEvent(new CustomEvent("beilu:mem-view-calibrated", { detail: { viewMode: _am } }));
    }
    tables = data.tables || [];
    // 兼容旧数据：补全 enabled 字段
    for (const t of tables) {
      if (t.enabled === undefined) t.enabled = true;
    }
    isDirty = false;
    updateDirtyIndicator();

    // Step 6: 渲染压缩摘要横幅
    renderSummaryBanner(data.context_summary);

    const enabledCount = tables.filter((t) => t.enabled !== false).length;
    diag.log(
      `loadTablesForChar: 加载完成, ${tables.length} 个表格, ${enabledCount} 启用`,
    );
    diag.snapshot("tables-loaded", {
      charId,
      tableCount: tables.length,
      enabledCount,
      tableIds: tables.map((t) => t.id),
    });

    renderStats();
    renderTableTabs();
    switchTable(0);

    setStatus(`已加载 ${tables.length} 个表格`);
  } catch (err) {
    diag.error("loadTablesForChar: 加载失败", err.message);
    console.error("[dataTable] 加载表格数据失败:", err);
    setStatus(`加载失败: ${err.message}`);
    showEmpty();
  }
}

// ===== 压缩摘要横幅 =====

/**
 * 渲染压缩摘要到外部面板 #mem-summary-panel
 * Phase2: 从 dataTable 内联横幅移至记忆选项卡顶部的独立面板
 * @param {object|null} summary - context_summary 数据（来自后端 GetData）
 */
function renderSummaryBanner(summary) {
  const panel = document.getElementById("mem-summary-panel");
  const contentEl = document.getElementById("mem-summary-content");
  const timeEl = document.getElementById("mem-summary-time");
  const toggleBtn = document.getElementById("mem-summary-toggle");

  if (!panel) return;

  // summary 为 null 或没有可展示内容则隐藏
  if (!summary) {
    panel.style.display = "none";
    return;
  }

  // 尝试提取摘要文本：优先 summary.content，其次 summary.text，否则 JSON 序列化
  let text = "";
  if (typeof summary === "string") {
    text = summary;
  } else if (summary.content) {
    text = summary.content;
  } else if (summary.text) {
    text = summary.text;
  } else {
    // 把整个对象展示为格式化 JSON（fallback）
    text = JSON.stringify(summary, null, 2);
  }

  if (!text.trim()) {
    panel.style.display = "none";
    return;
  }

  if (contentEl) contentEl.textContent = text;

  // 时间戳
  const ts =
    summary.timestamp || summary.created_at || summary.updated_at || "";
  if (ts && timeEl) {
    try {
      const d = new Date(ts);
      timeEl.textContent = d.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      timeEl.textContent = ts;
    }
  } else if (timeEl) {
    timeEl.textContent = "";
  }

  panel.style.display = "";

  // 绑定折叠按钮（只绑定一次，用 _bound 标记）
  if (toggleBtn && !toggleBtn._bound) {
    toggleBtn._bound = true;
    let _expanded = false;
    toggleBtn.addEventListener("click", () => {
      _expanded = !_expanded;
      if (contentEl) contentEl.style.maxHeight = _expanded ? "20rem" : "6rem";
      toggleBtn.textContent = _expanded ? "▲" : "▼";
    });
  }
}

// ===== 显示/隐藏 =====

function showEmpty() {
  if (_dom.empty) _dom.empty.style.display = "";
  if (_dom.gridWrapper) _dom.gridWrapper.style.display = "none";
  if (_dom.tableInfo) _dom.tableInfo.style.display = "none";
  if (_dom.rules) _dom.rules.style.display = "none";
  if (_dom.tableTabs) _dom.tableTabs.innerHTML = "";
}

function showGrid() {
  if (_dom.empty) _dom.empty.style.display = "none";
  if (_dom.gridWrapper) _dom.gridWrapper.style.display = "";
  if (_dom.tableInfo) _dom.tableInfo.style.display = "";
}

// ===== 统计 =====

function renderStats() {
  if (!_dom.stats) return;
  if (!tables.length) {
    _dom.stats.textContent = "";
    return;
  }
  const totalRows = tables.reduce((sum, t) => sum + (t.rows?.length || 0), 0);
  const enabledCount = tables.filter((t) => t.enabled !== false).length;
  _dom.stats.textContent = `${tables.length} 表格 · ${totalRows} 行 · ${enabledCount} 启用`;
}

// ===== 表格标签页 =====

function renderTableTabs() {
  if (!_dom.tableTabs) return;
  _dom.tableTabs.innerHTML = "";
  for (let i = 0; i < tables.length; i++) {
    const tab = document.createElement("button");
    const isDisabled = tables[i].enabled === false;
    tab.className =
      "dt-tab-btn" +
      (i === currentTableIndex ? " dt-tab-active" : "") +
      (isDisabled ? " dt-tab-disabled" : "");
    tab.dataset.index = i;
    tab.textContent = `#${tables[i].id}`;
    tab.title =
      (isDisabled ? "[已禁用] " : "") +
      (tables[i].name || `表格 #${tables[i].id}`);
    tab.addEventListener("click", () => switchTable(i));
    _dom.tableTabs.appendChild(tab);
  }
}

function switchTable(index) {
  if (index < 0 || index >= tables.length) return;
  currentTableIndex = index;
  // R4：切表清过滤（不同表的过滤词不残留）
  _gridFilter = "";
  if (_dom.filter) _dom.filter.value = "";
  // R1：切表清选择（行索引按表，不可跨表残留）
  _selectedRows.clear();
  _updateBatchBar();
  diag.debug(
    `switchTable: index=${index} id=#${tables[index]?.id} name="${tables[index]?.name}" enabled=${tables[index]?.enabled}`,
  );

  _dom.tableTabs.querySelectorAll(".dt-tab-btn").forEach((tab, i) => {
    const isDisabled = tables[i]?.enabled === false;
    tab.classList.toggle("dt-tab-active", i === index);
    tab.classList.toggle("dt-tab-disabled", isDisabled);
  });

  const table = tables[index];
  _dom.tableId.textContent = `#${table.id}`;
  _dom.tableName.textContent = table.name || "(未命名)";
  _dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`;

  // 启用/禁用 toggle
  const isEnabled = table.enabled !== false;
  _dom.enabledCheckbox.checked = isEnabled;
  _dom.enabledLabel.textContent = isEnabled ? "已启用" : "已禁用";
  _dom.enabledLabel.style.color = isEnabled
    ? "var(--beilu-amber-70)"
    : "rgba(239,68,68,0.7)";
  // required 表格锁定启用
  if (table.required) {
    _dom.enabledCheckbox.disabled = true;
    _dom.enabledToggle.title = "必需表格，不可禁用";
    _dom.enabledToggle.style.opacity = "0.5";
  } else {
    _dom.enabledCheckbox.disabled = false;
    _dom.enabledToggle.title = "启用/禁用此表格（禁用后不注入AI）";
    _dom.enabledToggle.style.opacity = "1";
  }

  if (table.rules) {
    _dom.ruleInsert.textContent = table.rules.insert || "-";
    _dom.ruleUpdate.textContent = table.rules.update || "-";
    _dom.ruleDelete.textContent = table.rules.delete || "-";
    _dom.rules.style.display = "";
  } else {
    _dom.rules.style.display = "none";
  }

  // 显示/隐藏删除表格按钮（required 表格不可删除）
  if (_dom.delTableBtn) {
    _dom.delTableBtn.style.display = table.required ? "none" : "";
  }

  showGrid();
  renderGrid(table);
}

// ===== 表格网格渲染 =====

function renderGrid(table) {
  // R1（合并 v4）：剔除已越界的选中索引（行被删/换表后）
  for (const i of [..._selectedRows]) {
    if (i >= table.rows.length) _selectedRows.delete(i);
  }

  // 列头
  _dom.gridHead.innerHTML = "";
  const headerRow = document.createElement("tr");

  // R1 全选 checkbox 列（合并 v4）：勾选/取消当前过滤可见行
  const thSel = document.createElement("th");
  thSel.className = "dt-row-num-header";
  const selAllEl = document.createElement("input");
  selAllEl.type = "checkbox";
  selAllEl.title = "全选/取消当前可见行";
  selAllEl.style.cssText = "accent-color:var(--beilu-amber);cursor:pointer;";
  selAllEl.addEventListener("change", () => {
    const vis = _visibleRowIndices(table);
    if (selAllEl.checked) vis.forEach((r) => _selectedRows.add(r));
    else vis.forEach((r) => _selectedRows.delete(r));
    renderGrid(table);
    _updateBatchBar();
  });
  thSel.appendChild(selAllEl);
  headerRow.appendChild(thSel);
  // R1：依据当前可见行的选中比例更新全选框（全选/半选/未选）
  function updateSelAllState() {
    const vis = _visibleRowIndices(table);
    const sel = vis.filter((r) => _selectedRows.has(r)).length;
    selAllEl.checked = vis.length > 0 && sel === vis.length;
    selAllEl.indeterminate = sel > 0 && sel < vis.length;
  }

  const thIdx = document.createElement("th");
  thIdx.className = "dt-row-num-header";
  thIdx.textContent = "#";
  headerRow.appendChild(thIdx);

  for (let c = 0; c < table.columns.length; c++) {
    const th = document.createElement("th");
    th.className = "dt-col-header dt-col-header-editable";
    th.style.position = "relative";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = table.columns[c];
    nameSpan.title = `点击编辑列名「${table.columns[c]}」`;
    th.appendChild(nameSpan);

    // 列头删除钮：× 删除列，走后端 deleteTableColumn（删前自动快照可回档）。至少保留1列。
    if (table.columns.length > 1) {
      const delBtn = document.createElement("button");
      delBtn.className = "dt-col-delete-btn";
      delBtn.textContent = "×";
      delBtn.title = `删除列「${table.columns[c]}」（不留档，删除前后端自动建快照）`;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteColumn(c);
      });
      th.appendChild(delBtn);
    }

    // 点击编辑列名
    nameSpan.addEventListener("click", () =>
      startColumnNameEdit(th, nameSpan, c),
    );

    headerRow.appendChild(th);
  }

  const thOps = document.createElement("th");
  thOps.className = "dt-action-header";
  thOps.textContent = "操作";
  headerRow.appendChild(thOps);

  _dom.gridHead.appendChild(headerRow);

  // 数据行
  _dom.gridBody.innerHTML = "";
  let _shown = 0;
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r];
    // R4 过滤（合并 v4）：不匹配则跳过渲染，保持原始 r 索引（删行/编辑用 r 不错位）
    if (_gridFilter && !row.join(" ").toLowerCase().includes(_gridFilter.toLowerCase())) continue;
    _shown++;
    const tr = document.createElement("tr");

    // R1 选择 checkbox（合并 v4）
    const tdSel = document.createElement("td");
    tdSel.className = "dt-row-num";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = _selectedRows.has(r);
    cb.style.cssText = "accent-color:var(--beilu-amber);cursor:pointer;";
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) _selectedRows.add(r);
      else _selectedRows.delete(r);
      tr.classList.toggle("dt-row-selected", cb.checked);
      _updateBatchBar();
      updateSelAllState();
    });
    tdSel.appendChild(cb);
    tr.appendChild(tdSel);
    if (cb.checked) tr.classList.add("dt-row-selected");

    // 行号
    const tdIdx = document.createElement("td");
    tdIdx.className = "dt-row-num";
    tdIdx.textContent = r;
    tr.appendChild(tdIdx);

    // 数据单元格
    for (let c = 0; c < table.columns.length; c++) {
      const td = document.createElement("td");
      td.className = "dt-cell";
      const val = c < row.length ? row[c] || "" : "";
      td.textContent = val;
      td.title = val || "(空，点击编辑)";
      td.dataset.row = r;
      td.dataset.col = c;
      td.addEventListener("click", () => startCellEdit(td, r, c));
      tr.appendChild(td);
    }

    // 操作：× 删除此行（走后端 deleteTableRows，删前自动快照可回档；批量删除经批量条）
    const tdOps = document.createElement("td");
    tdOps.className = "dt-action-cell";
    const delRowBtn = document.createElement("button");
    delRowBtn.className = "dt-row-delete-btn";
    delRowBtn.innerHTML = '<i data-ic="trash"></i>';
    delRowBtn.title = "删除此行（不留档，删除前后端自动建快照）";
    delRowBtn.style.cssText = "cursor:pointer;background:transparent;border:none;color:var(--beilu-error,#ef4444);padding:0 0.2rem;";
    delRowBtn.addEventListener("click", () => deleteRow(r));
    tdOps.appendChild(delRowBtn);
    tr.appendChild(tdOps);

    _dom.gridBody.appendChild(tr);
  }

  // 空表格 / 无匹配提示（R4 合并 v4：区分"表空"和"过滤无匹配"）
  if (_shown === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "dt-cell";
    td.style.textAlign = "center";
    // 空表提示是要读的文字，用 on-base 可读档 amber-fg（amber-35 是 35% 透明琥珀=淡底/边框用，当文字任何主题都极淡）
    td.style.color = "var(--beilu-amber-fg, var(--beilu-amber))";
    td.colSpan = table.columns.length + 3; // R1：含选择列后 选择+#+数据列+操作
    td.textContent = _gridFilter
      ? `没有匹配「${_gridFilter}」的条目`
      : "暂无数据，点击「➕ 添加行」开始";
    tr.appendChild(td);
    _dom.gridBody.appendChild(tr);
  }

  // R1（合并 v4）：渲染完同步全选框态 + 批量工具条
  updateSelAllState();
  _updateBatchBar();
}

// ===== 列名编辑 =====

function startColumnNameEdit(th, nameSpan, colIdx) {
  if (th.classList.contains("dt-cell-editing")) return;

  const table = tables[currentTableIndex];
  const currentValue = table.columns[colIdx] || "";

  th.classList.add("dt-cell-editing");
  const input = document.createElement("input");
  input.type = "text";
  input.style.cssText =
    "width:100%;padding:0.2rem 0.3rem;font-size:0.75rem;border:1.5px solid var(--beilu-amber);border-radius:0.2rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;font-weight:600;";
  input.value = currentValue;
  nameSpan.textContent = "";
  nameSpan.appendChild(input);
  input.focus();
  input.select();

  const finishEdit = () => {
    const newValue = input.value.trim() || currentValue; // 不允许空列名
    th.classList.remove("dt-cell-editing");
    nameSpan.textContent = newValue;
    nameSpan.title = `点击编辑列名「${newValue}」`;

    if (newValue !== currentValue) {
      diag.log(
        `columnNameEdit: #${table.id} col[${colIdx}] "${currentValue}" → "${newValue}"`,
      );
      table.columns[colIdx] = newValue;
      markDirty();
    }
  };

  input.addEventListener("blur", finishEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.value = currentValue;
      input.blur();
    }
  });
}

// ===== 列操作 =====

async function addColumn() {
  const table = tables[currentTableIndex];
  if (!table) return;

  const name = await beiluPrompt("请输入新列名:");
  if (!name?.trim()) return;

  table.columns.push(name.trim());
  // 所有已有行补充空单元格
  for (const row of table.rows) {
    row.push("");
  }

  diag.log(
    `addColumn: #${table.id} 新列="${name.trim()}" 总列数=${table.columns.length}`,
  );
  markDirty();
  renderGrid(table);
  _dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`;
  setStatus(`已添加列「${name.trim()}」`);
}

// 删除列：薄调用点走后端 deleteTableColumn（discard 语义+删前自动快照），
//   原前端本地 splice 无保护实现不回归。
async function deleteColumn(colIdx) {
  const table = tables[currentTableIndex];
  if (!table || table.columns.length <= 1) return;
  const colName = table.columns[colIdx];
  if (isDirty) {
    if (!await beiluConfirm(`当前表有未保存改动。删除以后端已保存的数据为准，未保存改动可能丢失。建议先保存。\n\n仍要继续吗？`)) return;
  }
  if (!await _dangerConfirm({
    title: `删除列「${colName}」`,
    message: `该列在所有 ${table.rows.length} 行中的数据将被删除（不留归档；删除前后端自动建快照，可在「快照」里回档）。`,
    confirmText: "删除该列",
  })) return;
  setStatus(`删除列「${colName}」中…`);
  try {
    await _archiveAction({ _action: "deleteTableColumn", tableId: table.id, colIndex: colIdx });
    setStatus(`已删除列「${colName}」（删除前快照可回档）`);
    if (currentCharId) await loadTablesForChar(currentUsername, currentCharId);
  } catch (e) {
    setStatus(`删除列失败: ${e.message}`);
    window._beiluToast?.(`删除列失败: ${e.message}`, "error");
  }
}

// ===== 表格名称编辑 =====

function startTableNameEdit() {
  const table = tables[currentTableIndex];
  if (!table) return;

  const nameEl = _dom.tableName;
  if (nameEl.classList.contains("dt-cell-editing")) return;

  const currentValue = table.name || "";

  nameEl.classList.add("dt-cell-editing");
  const input = document.createElement("input");
  input.type = "text";
  input.style.cssText =
    "width:200px;padding:0.15rem 0.3rem;font-size:0.75rem;border:1.5px solid var(--beilu-amber);border-radius:0.2rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;font-weight:500;";
  input.value = currentValue;
  nameEl.textContent = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();

  const finishEdit = () => {
    const newValue = input.value.trim() || currentValue; // 不允许空名称
    nameEl.classList.remove("dt-cell-editing");
    nameEl.textContent = newValue;

    if (newValue !== currentValue) {
      diag.log(`tableNameEdit: #${table.id} "${currentValue}" → "${newValue}"`);
      table.name = newValue;
      markDirty();
      // 更新标签页 title
      renderTableTabs();
    }
  };

  input.addEventListener("blur", finishEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.value = currentValue;
      input.blur();
    }
  });
}

// ===== 规则编辑 =====

function startRuleEdit(ruleSpan, ruleKey) {
  const table = tables[currentTableIndex];
  if (!table?.rules) return;
  if (ruleSpan.classList.contains("dt-cell-editing")) return;

  const currentValue = table.rules[ruleKey] || "";

  ruleSpan.classList.add("dt-cell-editing");
  const input = document.createElement("input");
  input.type = "text";
  input.style.cssText =
    "width:250px;padding:0.1rem 0.25rem;font-size:0.6rem;border:1px solid var(--beilu-amber);border-radius:0.15rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;";
  input.value = currentValue;
  ruleSpan.textContent = "";
  ruleSpan.appendChild(input);
  input.focus();
  input.select();

  const finishEdit = () => {
    const newValue = input.value.trim();
    ruleSpan.classList.remove("dt-cell-editing");
    ruleSpan.textContent = newValue || "-";

    if (newValue !== currentValue) {
      diag.log(
        `ruleEdit: #${table.id} ${ruleKey} "${currentValue}" → "${newValue}"`,
      );
      table.rules[ruleKey] = newValue;
      markDirty();
    }
  };

  input.addEventListener("blur", finishEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.value = currentValue;
      input.blur();
    }
  });
}

// ===== 启用/禁用 toggle =====

function toggleTableEnabled() {
  const table = tables[currentTableIndex];
  if (!table || table.required) return;

  const oldEnabled = table.enabled;
  table.enabled = _dom.enabledCheckbox.checked;
  diag.log(
    `toggleEnabled: #${table.id} "${table.name}" ${oldEnabled} → ${table.enabled}`,
  );
  _dom.enabledLabel.textContent = table.enabled ? "已启用" : "已禁用";
  _dom.enabledLabel.style.color = table.enabled
    ? "var(--beilu-amber-70)"
    : "rgba(239,68,68,0.7)";

  markDirty();
  renderTableTabs(); // 更新标签页样式
  renderStats();
  setStatus(`表格 #${table.id} 已${table.enabled ? "启用" : "禁用"}`);
}

// ===== 单元格内联编辑 =====

function startCellEdit(td, rowIdx, colIdx) {
  if (td.classList.contains("dt-cell-editing")) return;

  const table = tables[currentTableIndex];
  const currentValue = table.rows[rowIdx]?.[colIdx] || "";

  td.classList.add("dt-cell-editing");
  const input = document.createElement("input");
  input.type = "text";
  input.style.cssText =
    "width:100%;padding:0.2rem 0.3rem;font-size:0.8rem;border:1.5px solid var(--beilu-amber);border-radius:0.2rem;background:rgba(0,0,0,0.15);color:inherit;outline:none;box-sizing:border-box;";
  input.value = currentValue;
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  const finishEdit = () => {
    const newValue = input.value;
    td.classList.remove("dt-cell-editing");
    td.textContent = newValue;
    td.title = newValue || "(空，点击编辑)";

    if (newValue !== currentValue) {
      diag.debug(
        `cellEdit: #${table.id} [${rowIdx},${colIdx}] "${currentValue}" → "${newValue}"`,
      );
      while (table.rows[rowIdx].length <= colIdx) {
        table.rows[rowIdx].push("");
      }
      table.rows[rowIdx][colIdx] = newValue;
      markDirty();
    }
  };

  input.addEventListener("blur", finishEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.value = currentValue;
      input.blur();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      input.blur();
      const nextCol = colIdx + 1;
      if (nextCol < table.columns.length) {
        const nextTd = _dom.gridBody.querySelector(
          `td[data-row="${rowIdx}"][data-col="${nextCol}"]`,
        );
        if (nextTd) startCellEdit(nextTd, rowIdx, nextCol);
      }
    }
  });
}

// ===== 行操作 =====

function addRow() {
  const table = tables[currentTableIndex];
  if (!table) return;

  const newRow = new Array(table.columns.length).fill("");
  table.rows.push(newRow);
  diag.debug(
    `addRow: #${table.id} 新行索引=${table.rows.length - 1} 总行数=${table.rows.length}`,
  );
  markDirty();
  renderGrid(table);
  _dom.rowCount.textContent = `${table.rows.length} 行 · ${table.columns.length} 列`;
  renderStats();

  _dom.gridContainer.scrollTop = _dom.gridContainer.scrollHeight;
  setStatus(`已添加第 ${table.rows.length - 1} 行`);
}

// 删除单行：复用后端 deleteTableRows verb（discard+删前自动快照），「后端改→前端 reload」范式
//   （后端瘦身+落盘，不走本地 markDirty，避免本地未保存态与后端结果打架）。
async function deleteRow(rowIdx) {
  const table = tables[currentTableIndex];
  if (!table || rowIdx < 0 || rowIdx >= table.rows.length) return;
  if (isDirty) {
    if (!await beiluConfirm(`当前表有未保存改动。删除以后端已保存的数据为准，未保存改动可能丢失。建议先保存。\n\n仍要继续吗？`)) return;
  }
  if (!await _dangerConfirm({
    title: `删除第 ${rowIdx} 行`,
    message: `内容：${JSON.stringify(table.rows[rowIdx]).slice(0, 120)}\n该行将被删除（不留归档；删除前后端自动建快照，可在「快照」里回档）。`,
    confirmText: "删除该行",
  })) return;
  setStatus(`删除第 ${rowIdx} 行中…`);
  try {
    const r = await _archiveAction({ _action: "deleteTableRows", tableId: table.id, rowIndices: [rowIdx] });
    setStatus(`已删除 ${r.deleted} 行（删除前快照可回档）`);
    if (currentCharId) await loadTablesForChar(currentUsername, currentCharId);
  } catch (e) {
    setStatus(`删除行失败: ${e.message}`);
    window._beiluToast?.(`删除行失败: ${e.message}`, "error");
  }
}

// ===== R1 批量选删（合并 v4）=====
// 当前过滤可见的原始行索引（与 renderGrid 的过滤判定一致）
function _visibleRowIndices(table) {
  const out = [];
  if (!table) return out;
  const f = _gridFilter ? _gridFilter.toLowerCase() : "";
  for (let r = 0; r < table.rows.length; r++) {
    if (f && !table.rows[r].join(" ").toLowerCase().includes(f)) continue;
    out.push(r);
  }
  return out;
}

function _updateBatchBar() {
  if (!_dom.batchBar) return;
  const n = _selectedRows.size;
  _dom.batchBar.style.display = n > 0 ? "flex" : "none";
  if (_dom.batchCount) _dom.batchCount.textContent = `已选 ${n} 行`;
}

// 批量删除走后端 deleteTableRows verb（discard+删前自动快照可回档），不是前端第二套本地
//   splice 实现；前端只发意图+reload（与 deleteRow/deleteColumn 同范式）。
function _selectedIdxs(table) {
  return [..._selectedRows].filter((i) => i >= 0 && i < table.rows.length).sort((a, b) => a - b);
}

async function _batchMoveOutGuard(table) {
  if (isDirty) {
    return beiluConfirm("当前表有未保存改动。该操作以后端已保存的数据为准，未保存改动可能丢失。建议先保存。\n\n仍要继续吗？");
  }
  return true;
}

async function _batchDeleteRows() {
  const table = tables[currentTableIndex];
  if (!table) return;
  const idxs = _selectedIdxs(table);
  if (idxs.length === 0) { _selectedRows.clear(); _updateBatchBar(); return; }
  if (!await _batchMoveOutGuard(table)) return;
  if (!await _dangerConfirm({
    title: `删除选中的 ${idxs.length} 行`,
    message: `将从表「#${table.id} ${table.name}」删除 ${idxs.length} 行（不留归档；删除前后端会自动建快照，可在「快照」里回档）。`,
    confirmText: `删除 ${idxs.length} 行`,
  })) return;
  diag.log(`batchDeleteRows: #${table.id} 删除 ${idxs.length} 行 indices=[${idxs.join(",")}]`);
  setStatus(`删除 ${idxs.length} 行中…`);
  try {
    const r = await _archiveAction({ _action: "deleteTableRows", tableId: table.id, rowIndices: idxs });
    _selectedRows.clear();
    setStatus(`已删除 ${r.deleted} 行（删除前快照可回档）`);
    if (currentCharId) await loadTablesForChar(currentUsername, currentCharId);
  } catch (e) {
    setStatus(`删除失败: ${e.message}`);
    window._beiluToast?.(`删除失败: ${e.message}`, "error");
  }
}

// ===== 表格管理（新增/删除） =====

async function addNewTable() {
  if (!currentUsername || !currentCharId) {
    setStatus("请先绑定角色卡");
    return;
  }

  const name = await beiluPrompt("请输入新表格名称:");
  if (!name?.trim()) return;

  const colsStr = await beiluPrompt("请输入列名（逗号分隔）:", "列1,列2,列3");
  if (!colsStr?.trim()) return;
  const columns = colsStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (columns.length === 0) return;

  setStatus("正在创建表格...");
  diag.log(`addNewTable: name="${name.trim()}" columns=[${columns.join(",")}]`);

  try {
    // T2批23：迁 sendAction 通配桥。_action:"addTable"→verb；charName 保留，username 删除（桥盖章）。
    //   原 if(!res.ok)throw 由 sendAction 非 2xx 自动 throw 承接；无回包消费故不接返回值。
    await sendAction({
      verb: "addTable",
      target: "plugins:beilu-memory",
      source: "web",
      payload: {
        charName: currentCharId,
        name: name.trim(),
        columns,
        ...(_currentViewMode() ? { viewMode: _currentViewMode() } : {}),
      },
    });

    diag.log("addNewTable: 创建成功, 重新加载数据");
    // 重新加载
    await loadTablesForChar(currentUsername, currentCharId);
    // 切换到新表格
    switchTable(tables.length - 1);
    setStatus(`表格「${name.trim()}」已创建`);
  } catch (err) {
    diag.error("addNewTable: 创建失败", err.message);
    console.error("[dataTable] 创建表格失败:", err);
    setStatus(`创建失败: ${err.message}`);
  }
}
async function deleteCurrentTable() {
  if (!currentUsername || !currentCharId) return;

  const table = tables[currentTableIndex];
  if (!table) return;
  if (table.required) {
    setStatus("必需表格不可删除");
    return;
  }

  if (!await _dangerConfirm({
    title: `删除表格「#${table.id} ${table.name}」`,
    message: `整张表（${table.rows.length} 行 · ${table.columns.length} 列）将被删除，且不可撤销。`,
    confirmText: "删除整表",
  })) return;

  diag.log(
    `deleteCurrentTable: #${table.id} "${table.name}" index=${currentTableIndex}`,
  );
  setStatus("正在删除表格...");

  try {
    // T2批23：迁 sendAction 通配桥。_action:"removeTable"→verb；charName 保留，username 删除（桥盖章）。
    //   桥 unwrap 取 res.data=旧 res.json() 裸体，result.error 判定保形。
    const result = await sendAction({
      verb: "removeTable",
      target: "plugins:beilu-memory",
      source: "web",
      payload: {
        charName: currentCharId,
        tableId: table.id, // ★ Phase 2: 用 table.id 标识
        tableIndex: currentTableIndex, // 兼容旧后端
        ...(_currentViewMode() ? { viewMode: _currentViewMode() } : {}),
      },
    });
    if (result && result.error) throw new Error(result.error);

    diag.log("deleteCurrentTable: 删除成功, 重新加载数据");
    // 重新加载
    await loadTablesForChar(currentUsername, currentCharId);
    setStatus(`表格已删除`);
  } catch (err) {
    diag.error("deleteCurrentTable: 删除失败", err.message);
    console.error("[dataTable] 删除表格失败:", err);
    setStatus(`删除失败: ${err.message}`);
  }
}

// ===== 保存 =====

async function saveCurrentTable() {
  if (!currentUsername || !currentCharId) {
    setStatus("未绑定角色卡");
    return;
  }

  const table = tables[currentTableIndex];
  if (!table) return;

  diag.log(
    `saveCurrentTable: #${table.id} "${table.name}" rows=${table.rows.length} cols=${table.columns.length} enabled=${table.enabled}`,
  );
  diag.snapshot("pre-save", {
    tableId: table.id,
    name: table.name,
    rowCount: table.rows.length,
    colCount: table.columns.length,
    enabled: table.enabled,
    rules: table.rules,
  });

  _dom.saveBtn.disabled = true;
  _dom.saveBtn.textContent = "保存中...";
  setStatus("正在保存...");

  try {
    const result = await saveTableToBackend(
      currentUsername,
      currentCharId,
      currentTableIndex,
      table,
    );
    // ★ 检查后端返回的错误（后端可能返回 { error: "..." }）
    if (result && result.error) {
      throw new Error(result.error);
    }
    isDirty = false;
    updateDirtyIndicator();
    if (result && result.rev != null) table.rev = result.rev;
    diag.log(`saveCurrentTable: #${table.id} 保存成功 (rev=${table.rev})`);
    setStatus(`表格 #${table.id} 保存成功`);
    renderGrid(table);
  } catch (err) {
    wbDetect("mem", "saveTable", false, err?.message, { tableId: table?.id });
    diag.error(`saveCurrentTable: #${table.id} 保存失败`, err.message);
    console.error("[dataTable] 保存失败:", err);
    setStatus(`保存失败: ${err.message}`);
  } finally {
    _dom.saveBtn.disabled = false;
    _dom.saveBtn.innerHTML = '<i data-ic="save"></i> 保存';
  }
}

// ===== 表格自动归档设置（T031：认领后端孤儿 verb，前端补入口）=====
//
// 传导链（后端已全有，本处补前端接线）：
//   dt-archive-btn → openArchiveDialog(当前表 tables[currentTableIndex])
//     → getTableArchiveConfig 拉现有 per-table 参数填表单
//     → updateTableArchiveConfig 白名单 merge 落 _config.json 的 <mode>_archive.table_archive[tableId]
//     → archiveTableRows 立即归档（不传 rowIndices=按 max_rows/keep_recent 自动瘦身；表单值随请求传，
//        缺省时后端 verb 回读已存 table_archive 配置再回落引擎默认 TABLE_ARCHIVE_DEFAULTS）
//     → listTableArchives 回显已归档文件（每行带「↩ 恢复」钮）
//     → restoreTableArchiveRows（把该归档文件的行插回 tableId live 表头还原时序，后端建全表快照防误恢复；
//        恢复后从归档消账（档空删文件）；payload 契约=file(listTableArchives 回传相对路径)+tableId，mode 同族统一注入）
//
// mode 契约（关键坑）：归档 verb 的 _tMode 从 data.mode 解析（setDataActions _resolveTableMode），
//   ★不是★ data.viewMode（viewMode 只喂 loadMemoryData :750）。故这里 payload 必须送 mode=_currentViewMode()，
//   送 viewMode 会导致 code/work 表的归档落到 chat 桶。空 mode → 后端回退 chat（与本编辑器空 viewMode 语义一致）。
//
// 字段白名单：enabled / max_rows / keep_recent（snake_case，照 _TABLE_ARCHIVE_FIELDS setDataActions.mjs:527）。
//   前端表单字段名严格对齐，禁前端硬编码归档默认（默认权威源在后端引擎）。

// 归档族 verb 统一走 sendAction 通配桥（T2批23：同 saveTableToBackend/listTableSnapshots 收口到 sendAction 门面）。
//   调用方仍传 body={_action:归档verb,...}；此处把 _action 提升为 verb，其余字段进 payload。
//   charName+mode 保留（mode≠viewMode，归档桶从 data.mode 解析）；username 删除（桥 session 盖章）。
//   桥 unwrap 取 res.data=旧 res.json() 裸体，success:false 判定保形。
async function _archiveAction(body) {
  // ★ 送 mode（非 viewMode）：归档 verb 从 data.mode 解析归档桶。
  //   优先「加载时钉住的桶」_loadedMode（视图=动作同桶铁律）；两者皆空时后端 _resolveTableMode
  //   走 per-chatId active_mode 同源回退（20260712 起不再是 chat 硬默认）。
  const _mode = _currentViewMode() || _loadedMode;
  const { _action, ...rest } = body;
  const _b = await sendAction({
    verb: _action,
    target: "plugins:beilu-memory",
    source: "web",
    payload: {
      charName: currentCharId,
      ...(_mode ? { mode: _mode } : {}),
      ...rest,
    },
  });
  if (_b && _b.success === false) throw new Error(_b.error || "归档操作失败");
  return _b;
}

// 归档设置弹窗（自建 <dialog>，参照本文件 _dangerConfirm 的 showModal 范式；beiluDialog 只有 confirm/prompt 无表单弹窗）。
// [2026-07-16 凛倾「可以设置每一列(每个表)的详细归档,而不是全部一起设置」] 本模式全部表格逐表一行，
//   每行独立设置：开启开关 + max_rows + archive_batch + keep_recent + file_name_template + 保存 + 立即归档。
//   字段直落后端 per-table 权威配置（updateTableArchiveConfig patch，存储本就按 tableId 分 entry）；
//   placeholder/储存位置/默认模板全取后端 getTableArchiveConfig 回传 defaults（单源=TABLE_ARCHIVE_DEFAULTS），
//   禁前端硬编码默认。默认命名=日期+时间+表名+条目数（{date}_{time}_{tableName}_{count}条），归档落热层。
async function openArchiveDialog() {
  if (!tables.length) {
    setStatus("请先绑定角色卡");
    return;
  }

  let dlg = document.getElementById("dt-archive-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dt-archive-dialog";
    dlg.className = "modal";
    document.body.appendChild(dlg);
  }
  const _inpStyle = `width:100%;box-sizing:border-box;padding:0.25rem 0.3rem;font-size:0.72rem;background:rgba(255,255,255,0.06);border:1px solid var(--beilu-amber-25);border-radius:4px;color:inherit;`;
  // 7列网格：表名 | 开关 | max_rows | batch | keep | 命名模板 | 动作
  const _gridCols = `grid-template-columns:minmax(6.5rem,1.2fr) auto 4.2rem 4.2rem 4.2rem 4.2rem minmax(7rem,1.5fr) auto;`;
  dlg.innerHTML =
    // resize:both = 右下角可拖拽放大（凛倾 20260712「设置不可以放大,不好编辑」），overflow:auto 配套否则 resize 无效
    `<div class="modal-box" style="max-width:none;width:min(94vw,52rem);resize:both;overflow:auto;min-width:22rem;min-height:16rem;">` +
    `<h3 class="font-bold text-sm mb-1">表格归档设置（本模式全部表格，逐表独立配置）</h3>` +
    `<p class="text-xs mb-2" style="opacity:0.7;">开启后：行数超过上限时，自动把最旧的行迁移为归档文件存入热层；最近 N 行受保护不归档。每张表独立设置，字段直落后端权威配置。</p>` +
    `<div id="dtarc-storeinfo" style="font-size:0.68rem;opacity:0.6;margin-bottom:0.5rem;"></div>` +
    `<div style="display:grid;${_gridCols}gap:0.25rem 0.4rem;align-items:center;font-size:0.68rem;color:var(--beilu-amber-70);margin-bottom:0.2rem;">` +
    `<span>表格</span>` +
    `<span title="不勾=该表不参与自动归档（默认全不参与）">自动归档</span>` +
    `<span title="行数超过此上限才触发归档">超出行数</span>` +
    `<span title="每次触发最多迁移多少最旧行；留空/0=不限">每次条数</span>` +
    `<span title="最近的 N 行是保护区，永不被归档">保留最近</span>` +
    `<span title="单次归档不足这么多行就先不搬，攒够再一次性搬。防止「超出上限就搬 1 行」产生一堆只有 1 条的碎片归档文件（当上限和保留数接近时必然发生）。手动点「立即归档」不受此限">单次下限</span>` +
    `<span title="可用占位符：{date} 日期 / {time} 时间 / {tableName} 表名 / {tableId} 表号 / {count} 条目数量；后缀固定 _archive.json">文件命名</span>` +
    `<span></span>` +
    `</div>` +
    `<div id="dtarc-rows" style="display:grid;${_gridCols}gap:0.25rem 0.4rem;align-items:center;max-height:14rem;overflow:auto;font-size:0.72rem;">加载中…</div>` +
    `<div style="display:flex;align-items:center;margin:0.5rem 0 0.75rem;">` +
    `<span id="dtarc-msg" style="font-size:0.72rem;opacity:0.85;margin-left:auto;"></span>` +
    `</div>` +
    `<div style="border-top:1px solid var(--beilu-amber-15);padding-top:0.5rem;">` +
    `<div style="font-size:0.72rem;color:var(--beilu-amber-70);margin-bottom:0.3rem;display:flex;align-items:center;justify-content:space-between;">` +
    `<span>已归档文件（本模式全部表格）</span><button id="dtarc-refresh" class="btn btn-xs"><i data-ic="refresh"></i> 刷新</button></div>` +
    `<div id="dtarc-list" style="max-height:12rem;overflow:auto;font-size:0.68rem;color:var(--beilu-amber-70);">加载中…</div>` +
    `</div>` +
    `<div class="modal-action" style="display:flex;justify-content:flex-end;margin-top:0.75rem;">` +
    `<button id="dtarc-close" class="btn btn-sm">关闭</button>` +
    `</div></div>`;

  const _rowsEl = dlg.querySelector("#dtarc-rows");
  const _storeEl = dlg.querySelector("#dtarc-storeinfo");
  const _msgEl = dlg.querySelector("#dtarc-msg");
  const _listEl = dlg.querySelector("#dtarc-list");
  const _setMsg = (m) => { if (_msgEl) _msgEl.textContent = m; };

  // 拉全量 per-table 配置渲染逐表行（config 本就是 { [tableId]: {...} } map）
  try {
    const cfgResp = await _archiveAction({ _action: "getTableArchiveConfig" });
    const _cfgMap = (cfgResp && cfgResp.config) || {};
    const _defs = (cfgResp && cfgResp.defaults) || {};
    if (_storeEl) _storeEl.textContent = `储存：记忆目录/${cfgResp.storage || ""}/　·　格式：JSON（含列名+条目）　·　默认命名：${_defs.file_name_template || ""}（日期+时间+表名+条目数，每次归档独立文件）`;
    const _phMax = _defs.max_rows != null ? `默认 ${_defs.max_rows}` : "";
    const _phBatch = _defs.archive_batch != null ? (_defs.archive_batch > 0 ? `默认 ${_defs.archive_batch}` : "默认不限") : "";
    const _phMinRows = _defs.min_archive_rows != null ? (_defs.min_archive_rows > 0 ? `默认 ${_defs.min_archive_rows}` : "默认不限") : "";
    const _phKeep = _defs.keep_recent != null ? `默认 ${_defs.keep_recent}` : "";
    const _phFname = _defs.file_name_template != null ? `默认 ${_defs.file_name_template}` : "";
    _rowsEl.innerHTML = tables.map((t) => {
      const e = _cfgMap[String(t.id)] || {};
      const _v = (x) => (x != null ? escapeHtml(x) : "");
      return `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="#${t.id} ${escapeHtml(t.name || "未命名")}（当前 ${t.rows?.length ?? 0} 行）">#${t.id} ${escapeHtml(t.name || "未命名")}</span>` +
        `<input type="checkbox" class="dtarc-en" data-tid="${t.id}" ${e.enabled === true ? "checked" : ""} style="accent-color:var(--beilu-amber);cursor:pointer;justify-self:center;">` +
        `<input type="number" class="dtarc-max" data-tid="${t.id}" min="1" step="1" value="${_v(e.max_rows)}" placeholder="${_phMax}" title="行数超过此值才触发归档（主控参数，必填）" style="${_inpStyle}">` +
        `<input type="number" class="dtarc-batch" data-tid="${t.id}" min="0" step="1" value="${_v(e.archive_batch)}" placeholder="${_phBatch}" title="每次触发最多迁移多少行；0或留空=不限，一次全搬" style="${_inpStyle}">` +
        `<input type="number" class="dtarc-keep" data-tid="${t.id}" min="0" step="1" value="${_v(e.keep_recent)}" placeholder="${_phKeep}" title="0或留空=归档到上限行数为止（推荐）；填>0=额外保护最近N行不被归档" style="${_inpStyle}">` +
        `<input type="number" class="dtarc-minrows" data-tid="${t.id}" min="0" step="1" value="${_v(e.min_archive_rows)}" placeholder="${_phMinRows}" title="可归档行数不足此值时跳过本轮，攒够再搬（防碎片）；0=不限；手动归档不受此限" style="${_inpStyle}">` +
        `<input type="text" class="dtarc-fname" data-tid="${t.id}" value="${_v(e.file_name_template)}" placeholder="${escapeHtml(_phFname)}" style="${_inpStyle}">` +
        `<span style="white-space:nowrap;display:inline-flex;gap:0.25rem;">` +
        `<button class="btn btn-xs dtarc-save" data-tid="${t.id}" title="保存该表归档设置">保存</button>` +
        `<button class="btn btn-xs dtarc-now" data-tid="${t.id}" title="立即按该表上限归档超出的旧行（存入热层归档文件）"><i data-ic="package"></i></button>` +
        `</span>`;
    }).join("");
    // 初始加载后检测已有配置冲突
    for (const t of tables) _checkArchiveConflict(t.id);
  } catch (e) {
    _rowsEl.innerHTML = `<div style="grid-column:1/-1;color:rgba(239,68,68,0.8);">读取配置失败: ${escapeHtml(e.message)}</div>`;
  }

  // 行内取值：空串=不覆盖（后端已有值/引擎默认继续生效），填了才进 patch
  function _rowFields(tid) {
    const q = (cls) => _rowsEl.querySelector(`.${cls}[data-tid="${tid}"]`);
    return { en: q("dtarc-en"), max: q("dtarc-max"), batch: q("dtarc-batch"), keep: q("dtarc-keep"), minrows: q("dtarc-minrows"), fname: q("dtarc-fname") };
  }

  // 冲突检测：keep_recent > 0 且 >= max_rows 时后端会 clamp，前端即时标红+tooltip 提示
  function _checkArchiveConflict(tid) {
    const f = _rowFields(Number(tid));
    if (!f.max || !f.keep) return;
    const _maxV = f.max.value !== "" ? Number(f.max.value) : null;
    const _keepV = f.keep.value !== "" ? Number(f.keep.value) : null;
    // keep_recent=0 或留空=默认行为（归档到 max_rows 为止），不是冲突；>0 且 >= max_rows 才冲突
    const _conflict = _maxV != null && _keepV != null && _keepV > 0 && _keepV >= _maxV;
    const _warnStyle = _conflict ? "1px solid rgba(239,68,68,0.7)" : "";
    const _warnTip = _conflict ? `⚠ 保留最近(${_keepV}) ≥ 超出行数(${_maxV})，归档时保留数会被自动限制为 ${_maxV} 行` : "";
    f.keep.style.border = _warnStyle;
    f.keep.title = _warnTip || "0 或留空=归档到上限为止；>0=保护最近 N 行不被归档";
    if (_conflict) f.max.style.border = _warnStyle; else f.max.style.border = "";
  }
  _rowsEl.addEventListener("input", (ev) => {
    const _el = ev.target;
    if (_el.classList.contains("dtarc-max") || _el.classList.contains("dtarc-keep")) _checkArchiveConflict(_el.dataset.tid);
  });

  // 事件委托（行由 innerHTML 整体渲染，委托绑一次避免重复绑定泄漏）
  _rowsEl.addEventListener("click", async (ev) => {
    const _saveBtn = ev.target.closest(".dtarc-save");
    const _nowBtn = ev.target.closest(".dtarc-now");
    if (_saveBtn) {
      const _tid = Number(_saveBtn.dataset.tid);
      const f = _rowFields(_tid);
      const patch = { enabled: !!f.en?.checked };
      if (f.max?.value !== "") patch.max_rows = Number(f.max.value);
      if (f.batch?.value !== "") patch.archive_batch = Number(f.batch.value);
      if (f.keep?.value !== "") patch.keep_recent = Number(f.keep.value);
      if (f.minrows?.value !== "") patch.min_archive_rows = Number(f.minrows.value);
      if (f.fname?.value.trim() !== "") patch.file_name_template = f.fname.value.trim();
      _setMsg(`保存表 #${_tid} 设置中…`);
      try {
        await _archiveAction({ _action: "updateTableArchiveConfig", tableId: _tid, patch });
        _setMsg(`表 #${_tid} 归档设置已保存${patch.enabled ? "（自动归档开）" : "（自动归档关）"}`);
      } catch (e) {
        _setMsg(`保存失败: ${e.message}`);
      }
      return;
    }
    if (_nowBtn) {
      const _tid = Number(_nowBtn.dataset.tid);
      if (!await beiluConfirm(`立即归档表格 #${_tid} 中超出上限的旧行？被归档的行会移入热层归档文件（可恢复；快照另有保护）。`)) return;
      const f = _rowFields(_tid);
      // 表单有值传表单值（未保存的编辑也生效），缺省后端 verb 回读已存配置再回落引擎默认
      const payload = { _action: "archiveTableRows", tableId: _tid };
      if (f.max?.value !== "") payload.maxRows = Number(f.max.value);
      if (f.batch?.value !== "") payload.archiveBatch = Number(f.batch.value);
      if (f.keep?.value !== "") payload.keepRecent = Number(f.keep.value);
      if (f.minrows?.value !== "") payload.minArchiveRows = Number(f.minrows.value);
      if (f.fname?.value.trim() !== "") payload.fileNameTemplate = f.fname.value.trim();
      _setMsg(`归档表 #${_tid} 中…`);
      try {
        const r = await _archiveAction(payload);
        _setMsg(r.archived > 0 ? `表 #${_tid} 已归档 ${r.archived} 行，剩余 ${r.remaining} 行` : `表 #${_tid} 未超上限，无需归档`);
        await _reloadArchives();
        // 归档改了 live 表 → 重载前端表格数据同步瘦身结果
        if (r.archived > 0 && currentCharId) await loadTablesForChar(currentUsername, currentCharId);
      } catch (e) {
        _setMsg(`归档失败: ${e.message}`);
      }
    }
  });

  // 归档文件列表回显（不传 tableId=本模式全部表的归档文件）
  async function _reloadArchives() {
    if (_listEl) _listEl.textContent = "加载中…";
    try {
      const r = await _archiveAction({ _action: "listTableArchives" });
      const arcs = (r && r.archives) || [];
      if (!arcs.length) {
        _listEl.innerHTML = `<div style="opacity:0.6;padding:0.3rem;">暂无归档文件</div>`;
        return;
      }
      _listEl.innerHTML = arcs.map((a) =>
        `<div style="padding:0.2rem 0.3rem;border-bottom:1px solid var(--beilu-amber-10);display:flex;align-items:center;gap:0.3rem;">` +
        `<span style="flex:1;min-width:0;">` +
        `<span style="color:var(--beilu-amber);">${escapeHtml(a.date || "-")}</span> · ` +
        `${escapeHtml(a.table || ("#" + a.tableId))} · ${escapeHtml(a.count)} 行 · ` +
        `<span style="opacity:0.6;">${escapeHtml(a.file || "")}</span></span>` +
        // 恢复钮：data-* 承载后端契约参数(file+tableId+count)，恢复逻辑由 _listEl 事件委托统一处理（避免重渲染重复绑定泄漏）
        `<button class="btn btn-xs dtarc-restore" data-file="${escapeHtml(a.file || "")}" data-tid="${escapeHtml(a.tableId)}" data-count="${escapeHtml(a.count)}" title="把这份归档的行恢复回表头（还原时序，恢复后从归档消账）">↩ 恢复</button>` +
        `</div>`,
      ).join("");
    } catch (e) {
      _listEl.innerHTML = `<div style="color:rgba(239,68,68,0.8);padding:0.3rem;">加载归档失败: ${escapeHtml(e.message)}</div>`;
    }
  }
  _reloadArchives();

  // 恢复归档行：restoreTableArchiveRows（后端 setDataActions.mjs restoreTableArchiveRows case）。
  //   契约=payload{file(listTableArchives 回传相对路径), tableId(取自归档条目自述)}，mode 由 _archiveAction 统一注入。
  //   语义：把归档 entries 插回 live 表头还原时序（后端建全表快照防误恢复），
  //   恢复后从归档消账（档空删文件）——故恢复完必须刷新归档列表，条目已变/消失。
  _listEl.addEventListener("click", async (ev) => {
    const _btn = ev.target.closest(".dtarc-restore");
    if (!_btn) return;
    const _file = _btn.dataset.file;
    if (!_file) return;
    const _tid = Number(_btn.dataset.tid);
    if (!Number.isInteger(_tid)) return;
    const _cnt = _btn.dataset.count;
    if (!await beiluConfirm(`把归档「${_file}」的 ${_cnt} 行恢复回表格 #${_tid} 的表头（还原时序）？\n恢复后从归档消账（恢复前有自动快照）。`)) return;
    _setMsg("恢复中…");
    _btn.disabled = true;
    try {
      const r = await _archiveAction({ _action: "restoreTableArchiveRows", tableId: _tid, file: _file });
      _setMsg(`已恢复 ${r.restored} 行到表 #${_tid}`);
      await _reloadArchives(); // 消账后列表已变（条目减少/文件消失）
      // 恢复回 live 表 → 重载前端表格数据同步（否则界面不显新行）
      if (currentCharId) await loadTablesForChar(currentUsername, currentCharId);
    } catch (e) {
      _setMsg(`恢复失败: ${e.message}`);
      _btn.disabled = false; // 失败重开，允许重试
    }
  });

  dlg.querySelector("#dtarc-refresh").addEventListener("click", _reloadArchives);
  dlg.querySelector("#dtarc-close").addEventListener("click", () => { try { dlg.close(); } catch { /* 已关闭 */ } });
  dlg.addEventListener("cancel", () => { try { dlg.close(); } catch { /* 已关闭 */ } }, { once: true });
  dlg.showModal();
}

// ===== Dirty 状态 =====

function markDirty() {
  isDirty = true;
  updateDirtyIndicator();
}

function updateDirtyIndicator() {
  if (_dom.tableDirty) _dom.tableDirty.style.display = isDirty ? "" : "none";

  const activeTab = _dom.tableTabs?.querySelector(".dt-tab-btn.dt-tab-active");
  if (activeTab && tables[currentTableIndex]) {
    const baseText = `#${tables[currentTableIndex].id}`;
    activeTab.textContent = isDirty ? `${baseText} *` : baseText;
  }
}

// ===== 工具 =====

function setStatus(msg) {
  if (_dom.status) _dom.status.textContent = msg;
}

// ===== 事件绑定 =====

function bindEvents() {
  _dom.refreshBtn?.addEventListener("click", async () => {
    if (currentCharId) {
      await loadTablesForChar(currentUsername, currentCharId);
    }
  });
  _dom.snapshotsBtn?.addEventListener("click", toggleSnapshotsPanel);
  _dom.snapshotsRefreshBtn?.addEventListener("click", loadSnapshots);
  _dom.snapshotsCloseBtn?.addEventListener("click", () => {
    if (_dom.snapshotsPanel) _dom.snapshotsPanel.style.display = "none";
  });
  _dom.addRowBtn?.addEventListener("click", addRow);
  _dom.addColBtn?.addEventListener("click", addColumn);
  _dom.addTableBtn?.addEventListener("click", addNewTable);
  _dom.delTableBtn?.addEventListener("click", deleteCurrentTable);
  _dom.archiveBtn?.addEventListener("click", openArchiveDialog);
  _dom.saveBtn?.addEventListener("click", saveCurrentTable);

  // 表格名称双击编辑
  _dom.tableName?.addEventListener("dblclick", startTableNameEdit);

  // 启用/禁用 toggle
  _dom.enabledCheckbox?.addEventListener("change", toggleTableEnabled);

  // 规则编辑
  _dom.ruleInsert?.addEventListener("click", () =>
    startRuleEdit(_dom.ruleInsert, "insert"),
  );
  _dom.ruleUpdate?.addEventListener("click", () =>
    startRuleEdit(_dom.ruleUpdate, "update"),
  );
  _dom.ruleDelete?.addEventListener("click", () =>
    startRuleEdit(_dom.ruleDelete, "delete"),
  );
}

// ===== 公开接口 =====

/**
 * 初始化 dataTable 可视化编辑器
 * @param {HTMLElement} container - 编辑器容器 DOM
 * @param {object} data - 初始数据（兼容旧接口，可为 null）
 * @param {object} options - 配置项 { charId, username, onSave }
 */
export async function initDataTable(container, data, options = {}) {
  if (!container) return;
  _container = container;

  // 渲染编辑器 UI
  renderEditorUI(container);
  bindEvents();

  window.addEventListener("beforeunload", (e) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // 如果提供了 charId，自动绑定
  if (options.charId) {
    await bindToChar(options.charId, options.username);
  }

  // ①解耦（合并 v4）：监听「查看模式变更」自动重载表格。
  // beilu:mem-view-changed 由 layout.mjs 派发：查看按钮切换 + 真实会话 mode-switched 桥接都会派。
  // 改前监听 beilu:mode-switched（会话级）——现统一走查看模式事件，避免查看切换误触发会话级消费者。
  window.addEventListener("beilu:mem-view-changed", whenVisible("#center-tab-memory", async (e) => {
    const { viewMode, charName } = e.detail || {};
    console.log(
      `[dataTable] 收到查看模式变更: viewMode=${viewMode}, char=${charName || currentCharId}`,
    );
    // 全局 window._beiluMemViewMode 已由派发方更新，fetch/写都会带上 → 重载即拿对应模式表格
    if (currentCharId) {
      await loadTablesForChar(currentUsername, currentCharId);
    }
  }));

  diag.log(
    "initDataTable: 初始化完成",
    options.charId ? `绑定: ${options.charId}` : "等待绑定",
  );
  console.log(
    "[dataTable] 记忆表格编辑器初始化完成",
    options.charId ? `(绑定: ${options.charId})` : "(等待绑定)",
  );
}

/**
 * 动态绑定到新的角色卡（外部调用，如聊天切换角色时）
 * @param {string} charId - 角色卡名称
 * @param {string} [username] - 用户名
 */
export async function bindDataTableToChar(charId, username) {
  if (!_container) return; // 编辑器未初始化
  // ★ 修复：不再跳过同角色重新绑定
  // AI 自动操作（ReplyHandler 中的 tableEdit）可能已修改后端数据
  // 如果跳过，前端会一直显示旧数据，保存时覆盖新数据
  await bindToChar(charId, username);
}

/**
 * 获取当前所有表格数据
 * @returns {Array} 表格数据数组
 */
export function getTablesData() {
  return tables || [];
}
