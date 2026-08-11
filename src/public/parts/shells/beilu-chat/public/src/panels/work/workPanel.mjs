/**
 * workPanel.mjs — 工作模式侧边栏面板
 *
 * 功能链：
 *   initWorkPanel → 渲染任务概览/历史/操作/MCP 等子面板 → _loadSidebarPanel(activePanel, container)
 *     → POST beilu-memory setdata {_action:"getTasks"/"getSchedulerJobs"/"getPendingApprovals"/"getActiveDelegates"}
 *     → 渲染对应列表（进行中/待办/完成 + 进度条 / scheduler 定时任务 / 待审批操作 / 委派线程）
 *   点活动栏按钮 → _switchWorkPanel → 切换子面板内容（overview/history/operations/mcp）
 *   审批按钮点击 → _handlePanelClick → POST approveItem/rejectItem → 后端执行/丢弃
 *   对话历史面板 → fetchChatList + 按角色过滤 → 渲染对话行 → 点对话 → switchToChat 免刷切换
 *   beilu:smart-task-update 事件 → 实时重渲 overview/operations 面板（F1-2 跨模式任务推送）
 *   beilu:conv-meta-changed 事件 → 重渲 history 面板（pin/star/label 更改同步）
 *   [孤儿verb期1] 任务台面板 → 工作文件子区(#work-files-mount) → _renderWorkFilesInto
 *     → _apiCall listWorkFiles/createWorkFile/readWorkFile/archiveWorkFile/getWorkStats
 *     → sendAction plugins:beilu-memory#* 通配桥 → setDataActions.mjs:2873-2962（work/<subfolder>/ 真读写）
 *
 * why：
 *   工作 Tab 需聚合任务/调度/审批/委派多个后端数据源，统一展示当前工作状态；
 *   事件驱动实时刷新（不轮询）避免频繁请求，_initialized 一次性闸防监听器泄漏。
 *   _selfMetaWrite 防递归：本模块写 meta 后触发的 conv-meta-changed 不重复渲染 history。
 *
 * 关联链：
 *   → panels/task/taskItemPanel.mjs mountTaskItemPanel（任务台面板挂载）
 *   → panels/feature/mcpPanel.mjs initMcpPanel（MCP 连接面板）
 *   → shared/chat-core/chat.mjs switchCharacterScope / chatBelongsToChar（切卡/角色过滤）
 *   → shared/transport/sendAction.mjs（T6b：出向统一门面；数据加载）+ conversationManager.commitChatRename（对话改名提交单源）
 *   → panels/work/subModePanel.mjs（子模式切换联动）
 *   ← layout.mjs（work Tab 激活时调用 initWorkPanel）
 *   ← beilu:smart-task-update / beilu:conv-meta-changed / beilu:mode-switched（事件消费）
 *
 * 影响范围：
 *   #work-sidebar / #work-sidebar-content DOM、#task-bar 任务状态栏，
 *   layoutState.workActivePanel（记住上次活跃子面板，core.mjs 持久化；
 *   原注释所称 BEILU_LAST_WORK_PANEL 为幽灵——全库零实现，07-11 追链落地时归入 layoutState 与 ideActivePanel 同框架）。
 *
 * 使用效果：
 *   进入工作 Tab → 自动展示任务概览；点活动栏 [H] 历史显示对话列表；
 *   后台任务/审批有变化时面板实时更新，无需手动刷新。
 */

import { escapeHtml as _escHtml, mountInlineEdit } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 内联改名输入框 UI 编排收口单源
import { getCharId as _getCharId } from "../../shared/state/sharedState.mjs";
import { getSubModes as _smGetSubModes, getActiveSubModeId as _smActiveId, renderSubModeManagementInto } from "./subModePanel.mjs";
import { getTokenInfo as _getTokenInfo } from "../../shared/widgets/tokenProgressBar.mjs";
import { initMcpPanel } from "../feature/mcpPanel.mjs";
import { mountTaskItemPanel } from "../task/taskItemPanel.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b: 出向统一门面（verb=真动作；apiFetch 经门面内部走）
import { getFlowGroupStatusShared, invalidateFlowGroupStatus } from "../../shared/transport/flowGroupStatus.mjs"; // T023 Q5: 三面板共享单飞；T029: 变更后失效
import { switchCharacterScope, chatBelongsToChar } from "../../shared/chat-core/chat.mjs"; // 切卡免刷：运行时切换对话，不 reload；chatBelongsToChar=角色过滤单源
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { getCurrentMode, getModeChatIdKey, MODE_CHATID_KEYS } from "../feature/featureControls.mjs";
import { loadConvMeta, saveConvMeta, commitChatRename } from "../../shared/chat-core/conversationManager.mjs"; // D5 收口：convMeta 读写权威（无环已核：chat.mjs/conversationManager 不反向引本文件）；[合并批 0714·二] 改名提交并入 commitChatRename D2 单源（原 renameChat 直调手抄删）
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs"; // beiluPrompt: 孤儿verb期1 新建工作文件命名输入
import { renderGroupRuntimeInto } from "../feature/groupRuntimePanel.mjs";
import { renderFilesPathConfig } from "../shared/filesPathConfig.mjs"; // 凛倾0710：路径黑白名单归权限域（原设置面板入口已迁此）
import { getMonitorErrors, markMonitorErrorsRead } from "../../shared/widgets/backendMonitor.mjs"; // [📊]角标同源：监控「错误」tab 数据面+已读
import { layoutState, saveState } from "../../shared/layout/core.mjs"; // workActivePanel 子面板记忆（凛倾07-11「侧栏没有记录上次操作」）
import { PRESET_INHERIT_LABEL } from "../../shared/state/modeTabMap.mjs"; // [D6 0713] 未绑定预设显示文案单源
import { toolSets } from "../../shared/state/toolSets.mjs"; // 0715 硬编码收口(F6)：文件编辑工具清单单源（权威=后端 commandGate.mjs）

// ============================================================
// [孤儿verb期1] 工作文件 CRUD — 后端 case 早在 setDataActions.mjs:2873-2962，前端原零入口
//   凛倾 2026-07-05：「后端还有很多可以设置和已经有了但是前端没有做的内容」系统补全。
//   接入 5 verb（全走 _apiCall→sendAction→plugins:beilu-memory#* 通配桥，零新路由，与 getTasks 同链）：
//     createWorkFile(:2873) / readWorkFile(:2892) / archiveWorkFile(:2904) / listWorkFiles(:2920) / getWorkStats(:2938)
//   契约要点（亲读后端 case 得，非猜）：
//     · 字段名是 filename（非 fileName）；subfolder 白名单 = ["active","outputs","workflows"]（后端 :2881 唯一权威）
//     · chatId 决定文件落哪：后端 getModeCtxDir(...,"work",chatId)（:2877）——gate 开+有 chatId 时落 work_ctx/<chatId>/，
//       故前端必须传 work 模式当前 chatid（与 _loadWorkStats:976/_refreshTaskBar 同源 getModeChatIdKey），否则读到 char 级空目录。
//     · archiveWorkFile 只归档 active 下文件（后端 :2910 硬定 active）→ 破坏性移动，带 beiluConfirm。
//     · listWorkFiles 过滤 `_` 前缀（:2928），返回 {name,size,modified}。
//   注：subfolder 选项集本应来自后端配置源，但当前无返回该白名单的 verb（仅 :2881 case 内硬定）；
//       此处以 contract-mirror 常量落地并注明源行，待决=后端补 listWorkSubfolders 类源 verb 再改为拉取（见执行报告待决）。
const _WORK_SUBFOLDERS = ["active", "outputs", "workflows"]; // 镜像后端 setDataActions.mjs:2881 _wfValidFolders（唯一权威）

// ============================================================
// 状态
// ============================================================

let _initialized = false;
let _refreshTimer = null;
// T6b：原 API_BASE 常量已由 sendAction 门面接管（target:"plugins:beilu-memory"），不再需要

// ============================================================
// 初始化
// ============================================================

export function initWorkPanel() {
  // 空状态引导每次进入工作模式都尝试（内部用 localStorage 决定是否真显示）
  _maybeShowWorkWelcome();

  if (_initialized) return;
  _initialized = true;

  const sidebar = document.getElementById("work-sidebar");
  const sidebarContent = document.getElementById("work-sidebar-content");
  if (!sidebar || !sidebarContent) return;

  // 侧边栏内容区事件委托（审批按钮等）
  sidebarContent.addEventListener("click", _handlePanelClick);

  // 活动栏按钮事件
  document.querySelectorAll("#work-activity-bar .ide-activity-btn[data-work-panel]").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.workPanel;
      _switchWorkPanel(panel);
    });
  });

  // 0713 双头收口：侧栏头部通用刷新（唯一刷新家，重载当前面板；原任务台面板内私有刷新钮随重复标题一并删）
  document.getElementById("work-sidebar-refresh")?.addEventListener("click", () => {
    if (_activeWorkPanel === "chat") return;
    const c = document.getElementById("work-sidebar-content");
    if (c) _loadSidebarPanel(_activeWorkPanel, c);
  });

  // F1-2 子项B(2026-06-17): 订阅跨模式任务更新，实时重渲当前面板——与 smart 右栏(layout:221)消费端统一，
  //   不再需重开/手动刷新面板才看到后台任务变化。只在显示任务态的面板(任务台/操作)时重渲，避免无谓刷新。
  //   initWorkPanel 受 _initialized 一次性闸保护，监听只注册一次（无泄漏）。
  window.addEventListener("beilu:smart-task-update", () => {
    if (_activeWorkPanel === "overview" || _activeWorkPanel === "operations") {
      const c = document.getElementById("work-sidebar-content");
      if (c) _loadSidebarPanel(_activeWorkPanel, c);
    }
    _refreshTaskBar();
  });

  _injectTaskBar();
  window.addEventListener("beilu:mode-switched", () => _refreshTaskBar());

  // 根病3 修复：conversationManager / index-chatmgmt 修改 meta（pin/star/label/lastActive）后
  // 广播此事件。当 workPanel 的 history 面板正在展示时重渲染，以同步最新排序和标签。
  // _selfMetaWrite 防递归：本模块自己的 _saveConvMeta 触发的事件不重复渲染。
  window.addEventListener("beilu:conv-meta-changed", () => {
    if (_selfMetaWrite) return;
    if (_activeWorkPanel === "history") {
      const c = document.getElementById("work-sidebar-content");
      if (c) _loadSidebarPanel("history", c);
    }
  });

  // 「XX窗口在用」徽标纠偏（0714 时序滞后一拍案根修）：切对话时本面板被 conv-meta-changed 立即
  //   重渲染，其 getChatList 与 POST /using 指针写在服务端 await 边界交错——读可先于写完成 →
  //   徽标停在上一拍。服务端写落地后必广播 chat-list-changed（chatStorage.setModeActiveChat），
  //   四列表中 conversationManager/smart 已消费此纠偏事件，唯本面板漏接=输一次竞态就永不自愈。
  //   防抖 300ms 对齐 conversationManager 同事件监听口径。
  let _histChatListTimer = null;
  window.addEventListener("beilu:chat-list-changed", () => {
    if (_activeWorkPanel !== "history") return;
    if (_histChatListTimer) clearTimeout(_histChatListTimer);
    _histChatListTimer = setTimeout(() => {
      _histChatListTimer = null;
      const c = document.getElementById("work-sidebar-content");
      if (c) _loadSidebarPanel("history", c);
    }, 300);
  });

  // 恢复上次活跃子面板（layoutState.workActivePanel）——reload 后侧栏回到用户上次停留的面板；
  // "chat"=默认全宽对话不需恢复动作。_initialized 一次性闸内，仅首次进入 work tab 执行。
  const _savedWorkPanel = layoutState.workActivePanel;
  if (_savedWorkPanel && _savedWorkPanel !== "chat") _switchWorkPanel(_savedWorkPanel);
}

// ============================================================
// [WK-T3] 空状态引导 — 工作模式首次打开显示欢迎卡片
//   · 注入到 work-main-area 顶部（chat-container 在其内的 work-chat-area，
//     卡片作为同级置于上方，不干扰对话移动逻辑）
//   · 快速开始按钮：填充输入框 + 自动发送 → AI 创建对应 Skill 组
//   · 消失条件：用户发送第一条消息 / 点快速开始 / 手动关闭
//   · localStorage 记住已看过（beilu-work-welcome-seen），不再重复弹
// ============================================================

const _WORK_WELCOME_KEY = KEYS.BEILU_WORK_WELCOME_SEEN;

function _maybeShowWorkWelcome() {
  try {
    if (storage.get(_WORK_WELCOME_KEY) === "1") return;
  } catch { /* ignore */ }

  const mainArea = document.getElementById("work-main-area");
  if (!mainArea) return;
  if (document.getElementById("work-welcome-card")) return; // 已存在

  const card = document.createElement("div");
  card.id = "work-welcome-card";
  card.className = "p-4";
  card.innerHTML = `
    <div class="max-w-xl mx-auto mt-6 rounded-xl border bg-base-200/60 p-5 space-y-3 relative" style="border-color:var(--beilu-amber-30)">
      <button id="work-welcome-close" class="absolute top-2 right-3 text-base-content/40 hover:text-base-content text-sm" title="关闭引导">✕</button>
      <div class="text-lg font-bold">🏗 工作模式</div>
      <p class="text-sm text-base-content/70">工作模式用于运行 AI 工作流：</p>
      <ul class="text-sm text-base-content/70 space-y-1 list-none">
        <li><i data-ic="message"></i> 在对话框输入任务描述，AI 自动创建工作流</li>
        <li><i data-ic="clipboard"></i> 工作流执行进度在左侧 <b><i data-ic="clipboard"></i> 任务台</b> 查看</li>
      </ul>
      <div class="divider my-1 text-[10px] opacity-50">快速开始</div>
      <div class="flex gap-2 flex-wrap">
        <button class="btn btn-sm btn-outline btn-warning" data-work-quickstart="帮我翻译一份文档：先读取文件，翻译，再校对质量">翻译文档</button>
        <button class="btn btn-sm btn-outline btn-warning" data-work-quickstart="帮我做一次代码审查：分析改动，找出问题，给出修复建议">代码审查</button>
        <button class="btn btn-sm btn-outline btn-warning" data-work-quickstart="帮我设计一个自动测试流程：确认需求，编写测试，运行验证">自动测试</button>
      </div>
    </div>`;

  // 置于主区域顶部
  mainArea.insertBefore(card, mainArea.firstChild);

  const dismiss = (markSeen) => {
    if (markSeen) { try { storage.set(_WORK_WELCOME_KEY, "1"); } catch { /* ignore */ } }
    card.remove();
  };

  card.querySelector("#work-welcome-close")?.addEventListener("click", () => dismiss(true));

  card.querySelectorAll("[data-work-quickstart]").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = btn.dataset.workQuickstart;
      _fillAndSendChat(text);
      dismiss(true);
      window._beiluToast?.("已发送。执行进度在左侧任务台查看", "info");
    });
  });

  // 用户主动发送第一条消息后消失（监听发送按钮 / Ctrl+Enter）
  const chatInput = document.getElementById("send_textarea");
  const sendBtn = document.getElementById("send-button");
  const onceDismiss = () => dismiss(true);
  sendBtn?.addEventListener("click", onceDismiss, { once: true });
  if (chatInput) {
    const onSend = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        dismiss(true);
        chatInput.removeEventListener("keydown", onSend);
      }
    };
    chatInput.addEventListener("keydown", onSend);
  }
}

// 填充对话输入框并自动发送（快速开始按钮）
function _fillAndSendChat(text) {
  const input = document.getElementById("send_textarea");
  if (!input) {
    window._beiluToast?.("未找到输入框，请手动输入：" + text, "info");
    return;
  }
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  // 优先点发送按钮，回退到模拟 Ctrl+Enter
  const sendBtn = document.getElementById("send-button");
  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  }
}

// ============================================================
// 活动栏 → 侧边栏面板切换（对话始终可见）
// ============================================================

let _activeWorkPanel = "chat";

const _panelTitles = {
  submodes: '<i data-ic="person"></i> 子模式',
  overview: '<i data-ic="clipboard"></i> 任务台',
  toolkit: '<i data-ic="toolbox"></i> 工具箱',
  mcp: '<i data-ic="plug"></i> MCP Servers',
  history: '<i data-ic="folder-open"></i> 对话历史',
  operations: '<i data-ic="chart"></i> 监控',
  groups: '<i data-ic="layers"></i> 并行组',
};

function _switchWorkPanel(panel) {
  if (_activeWorkPanel === panel) {
    // 再次点击同一按钮：如果不是chat，折叠侧边栏回到chat
    if (panel !== "chat") {
      _switchWorkPanel("chat");
    }
    return;
  }
  _activeWorkPanel = panel;
  layoutState.workActivePanel = panel;
  saveState();

  const activityBar = document.getElementById("work-activity-bar");
  const sidebar = document.getElementById("work-sidebar");
  const sidebarContent = document.getElementById("work-sidebar-content");
  const titleEl = document.getElementById("work-sidebar-title");

  // 更新活动栏高亮
  activityBar?.querySelectorAll(".ide-activity-btn").forEach(b => b.classList.remove("ide-activity-active"));
  const activeBtn = activityBar?.querySelector(`[data-work-panel="${panel}"]`);
  if (activeBtn) activeBtn.classList.add("ide-activity-active");

  var chatArea = document.getElementById("work-chat-area");
  var subDetail = document.getElementById("work-submode-detail");

  if (panel === "chat") {
    // 对话模式：侧边栏折叠，主区域全宽
    sidebar?.classList.add("hidden");
  } else {
    // 其他面板：侧边栏展开，渲染内容
    sidebar?.classList.remove("hidden");
    if (titleEl) titleEl.innerHTML = _panelTitles[panel] || panel;
    if (sidebarContent) _loadSidebarPanel(panel, sidebarContent);
  }

  // 子模式面板：主区右栏显示编辑详情（镜像 ide.mjs _toggleIdeMainArea）
  if (panel === "submodes") {
    if (chatArea) chatArea.style.display = "none";
    if (subDetail) subDetail.style.display = "";
    window.dispatchEvent(new CustomEvent("beilu:request-submode-detail"));
  } else {
    if (chatArea) chatArea.style.display = "";
    if (subDetail) subDetail.style.display = "none";
  }
}

function _loadSidebarPanel(panel, container) {
  // [0727] 借来的单例面板先归还再清容器：MCP 面板与 code 模式共用**同一个 DOM**（_renderMcpSidebar
  //   搬移复用），若直接 innerHTML 清空 = 把那份单例连同状态一起销毁，切回 code 侧栏就没了。
  const _borrowed = container.querySelector("#ide-panel-mcp");
  if (_borrowed) {
    const _ideSidebar = document.getElementById("ide-sidebar");
    if (_ideSidebar) { _borrowed.classList.add("hidden"); _ideSidebar.appendChild(_borrowed); }
  }
  container.innerHTML = '<div class="p-4 text-sm text-base-content/50">加载中...</div>';
  const renderMap = {
    submodes: () => _renderSubmodesPanel(container),
    overview: () => _renderOverviewInPanel(container),
    toolkit: () => _renderToolkitPanel(container),
    mcp: () => _renderMcpSidebar(container),
    operations: () => _renderOperationsPanel(container),
    history: () => _renderHistoryPanel(container),
    groups: () => renderGroupRuntimeInto(container),
  };
  const render = renderMap[panel];
  if (render) render();
  else container.innerHTML = '<div class="p-4 text-sm text-base-content/50">面板开发中</div>';
}

// 界面4 工具箱 — 权限配置两层：预设=整组快捷配置 / 逐条 toggle=单项微调。
// 全部字段真实接 beilu-files 后端（顶层 autoApprove/autoApproveRead/allowExec +
// permissions{file_read…todo}），「当前可用工具」从真实权限状态推导，零硬编码假数据。
// MCP 不在此处（=左侧独立活动栏项，拍板#9）。

// beilu-files 真实权限字段清单（与 main.mjs pluginData 一一对应，permissions.exec 无人读不列）
const _PERM_TOGGLES = [
  { key: "autoApprove", top: true, label: '<i data-ic="check"></i> 自动批准全部', desc: "所有操作免确认（含下面各项）" },
  { key: "autoApproveRead", top: true, label: '<i data-ic="eye"></i> 自动批准读取', desc: "读取文件免确认" },
  { key: "autoApproveList", top: true, label: '<i data-ic="folder"></i> 自动批准列目录', desc: "列出目录免确认" },
  { key: "allowExec", top: true, label: '<i data-ic="zap"></i> 命令执行', desc: "允许 AI 执行终端命令" },
  { key: "file_read", top: false, label: '<i data-ic="book"></i> 读取文件', desc: "read / list / search" },
  { key: "file_write", top: false, label: '<i data-ic="edit"></i> 写入文件', desc: "write / create / move / fuzzy_edit / replace_lines / insert / edit_xlsx" },
  { key: "file_delete", top: false, label: '<i data-ic="trash"></i> 删除文件', desc: "delete" },
  { key: "file_retry", top: false, label: '<i data-ic="refresh"></i> 失败重试', desc: "允许 AI 重试失败操作" },
  { key: "mcp", top: false, label: '<i data-ic="plug"></i> MCP 工具', desc: "允许 AI 调用 MCP" },
  { key: "questions", top: false, label: '<i data-ic="help"></i> 向用户提问', desc: "允许 AI 发起提问" },
  { key: "todo", top: false, label: '<i data-ic="clipboard"></i> 待办管理', desc: "允许 AI 管理待办" },
];

// 预设=完整快照（显式覆盖全部字段），不是增量 patch——点档位后状态确定可预期
const _PERM_PRESETS = {
  full: {
    autoApprove: true, autoApproveRead: true, autoApproveList: true, allowExec: true,
    permissions: { file_read: true, file_write: true, file_delete: true, file_retry: true, mcp: true, questions: true, todo: true },
  },
  minimal: {
    autoApprove: false, autoApproveRead: true, autoApproveList: true, allowExec: false,
    permissions: { file_read: true, file_write: true, file_delete: false, file_retry: true, mcp: false, questions: true, todo: false },
  },
  readonly: {
    autoApprove: false, autoApproveRead: true, autoApproveList: true, allowExec: false,
    permissions: { file_read: true, file_write: false, file_delete: false, file_retry: false, mcp: false, questions: true, todo: false },
  },
};

// T5 同步桥：workPanel 预设/toggle → B3 权限系统(beilu-memory ide_approval_rules)
const _PRESET_TO_B3 = { full: "full", minimal: "collab", readonly: "readonly" };
// 0715 硬编码收口（F6）：file_write 映射改消费 toolSets 单源（权威=后端 commandGate.mjs FILE_EDIT_TOOLS，
// getApprovalRules 下发覆盖）。原字面量 4 项副本后端新增文件工具时不会跟进 → toggle 控制盲点。
// 函数化取值：toolSets 可能在本模块加载后才被后端下发覆盖，取用时读 live 值。
function _permKeyToB3Tools(key) {
  if (key === "file_write") return toolSets.fileEditTools;
  if (key === "allowExec") return ["run_command"];
  if (key === "todo") return ["todo_write"];
  return null;
}

async function _syncPresetToB3(presetName) {
  const b3Id = _PRESET_TO_B3[presetName];
  if (!b3Id) return;
  try {
    await sendAction({ verb: "importPermissionTemplate", target: "plugins:beilu-memory", source: "web", payload: { templateId: b3Id } }); // T6b
  } catch { /* B3同步失败不阻塞主操作 */ }
}

async function _syncToggleToB3(key, enabled) {
  const tools = _permKeyToB3Tools(key);
  if (!tools) return;
  const action = enabled ? "allow" : (key === "allowExec" ? "deny" : "ask");
  try {
    for (const tool of tools) {
      await sendAction({ verb: "setApprovalRule", target: "plugins:beilu-memory", source: "web", payload: { tool, action, pathPrefix: "" } }); // T6b
    }
  } catch { /* B3同步失败不阻塞主操作 */ }
}

// 判定当前后端权限状态命中哪个预设快照（全字段一致才算命中，否则=自定义不高亮）
function _matchPresetName(cfg) {
  if (!cfg) return null;
  const perms = cfg.permissions || {};
  outer: for (const [name, p] of Object.entries(_PERM_PRESETS)) {
    for (const k of ["autoApprove", "autoApproveRead", "autoApproveList", "allowExec"]) {
      if ((cfg[k] === true) !== (p[k] === true)) continue outer;
    }
    for (const [k, v] of Object.entries(p.permissions)) {
      if ((perms[k] === true) !== (v === true)) continue outer;
    }
    return name;
  }
  return null;
}

async function _fetchFilesConfig() {
  try {
    return await sendAction({ verb: "getData", target: "plugins:beilu-files", source: "web" }); // T6b：!ok 抛错入 catch 返回 null（原 raw ok 分支等价）
  } catch { /* 静默 */ }
  return null;
}

async function _renderToolkitPanel(container) {
  container.innerHTML = `
    <div class="p-3 space-y-3">
      <h4 class="font-bold text-sm"><i data-ic="toolbox"></i> 工具箱</h4>

      <div class="collapse collapse-arrow bg-base-200/50 rounded-lg">
        <input type="checkbox" checked />
        <div class="collapse-title text-xs font-bold py-2 min-h-0"><i data-ic="lock"></i> 工具权限</div>
        <div class="collapse-content text-xs space-y-1">
          <div class="text-[10px] opacity-60">快速预设（默认即可用，当前档位高亮）:</div>
          <div class="flex gap-1 flex-wrap">
            <button class="btn btn-xs btn-outline" data-perm-preset="full" title="全部开启：读写删/命令执行/MCP 全自动批准">完整</button>
            <button class="btn btn-xs btn-outline" data-perm-preset="minimal" title="可读写但写入需确认；禁删除/命令执行/MCP">最小</button>
            <button class="btn btn-xs btn-outline" data-perm-preset="readonly" title="只能读取，禁一切写入/删除/执行">只读</button>
          </div>
          <div class="text-[10px] opacity-60 mt-2">逐条微调:</div>
          <div id="toolkit-perms-list" class="space-y-1"><span class="opacity-40">加载中...</span></div>
          <div class="text-[10px] opacity-60 mt-2">路径配置（允许/屏蔽，beilu-files 真强制）:</div>
          <div id="toolkit-path-config" class="mt-1"><span class="opacity-40">加载中...</span></div>
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-200/50 rounded-lg">
        <input type="checkbox" checked />
        <div class="collapse-title text-sm font-bold py-2 min-h-0"><i data-ic="wrench"></i> 环境工具</div>
        <div class="collapse-content text-xs">
          <div class="text-[10px] opacity-40 mb-1">本机已检测到的命令行工具（只读展示，AI 执行命令时可用）</div>
          <div id="toolkit-env-tools" class="opacity-60">加载中...</div>
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-200/50 rounded-lg">
        <input type="checkbox" checked />
        <div class="collapse-title text-xs font-bold py-2 min-h-0"><i data-ic="folder-open"></i> 当前可用工具</div>
        <div class="collapse-content text-xs space-y-1">
          <div id="toolkit-active-tools" class="opacity-70 text-[10px]">加载中...</div>
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-200/50 rounded-lg">
        <input type="checkbox" />
        <div class="collapse-title text-xs font-bold py-2 min-h-0" title="控制 AI 可调用的命令分类（解释器类默认关，需显式授权）"><i data-ic="zap"></i> 命令分类授权</div>
        <div class="collapse-content text-xs space-y-1">
          <div class="text-[10px] opacity-40 mb-1">控制 AI 可调用的命令分类（解释器类默认关，需显式授权）</div>
          <div id="toolkit-cmd-categories" class="space-y-1"><span class="opacity-40">加载中...</span></div>
        </div>
      </div>
    </div>
  `;

  // 预设绑定（应用后重渲染，toggle 显示与后端同步）
  container.querySelectorAll("[data-perm-preset]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const preset = btn.dataset.permPreset;
      const body = _PERM_PRESETS[preset] || _PERM_PRESETS.minimal;
      try {
        // T6b：files raw 字段写走 updateFilesConfig（原 body 直平铺，无 _action，后端 field-update 分支）
        await sendAction({ verb: "updateFilesConfig", target: "plugins:beilu-files", source: "web", payload: body });
        _syncPresetToB3(preset);
        window._beiluToast?.(`已应用权限预设: ${preset}`, "success");
        _renderToolkitPanel(container);
      } catch (e) {
        window._beiluToast?.("应用失败: " + e.message, "error");
      }
    });
  });

  // 真实状态拉取 → 逐条 toggle + 可用工具推导 + 当前命中档位高亮
  const cfg = await _fetchFilesConfig();
  _renderPermToggles(container.querySelector("#toolkit-perms-list"), cfg);
  renderFilesPathConfig(container.querySelector("#toolkit-path-config"), cfg);
  _renderActiveTools(container.querySelector("#toolkit-active-tools"), cfg);
  const hit = _matchPresetName(cfg);
  if (hit) container.querySelector(`[data-perm-preset="${hit}"]`)?.classList.add("btn-warning", "btn-active");

  // 环境工具（真实检测，getEnvTools）
  try {
    const data = await sendAction({ verb: "getEnvTools", target: "plugins:beilu-memory", source: "web" }); // T6b：!ok 抛错入 catch（原 res.ok 分支静默失败等价）
    const detected = data?.detected || [];
    const envEl = container.querySelector("#toolkit-env-tools");
    if (envEl) {
      envEl.innerHTML = detected.length === 0
        ? '<span class="opacity-40">未检测到工具</span>'
        : detected.map(t => `<span class="inline-block px-1.5 py-0.5 bg-base-300 rounded mr-1 mb-1 text-[10px]">${_escHtml(t.cmd || t.name || t)}${t.version ? ' ' + _escHtml(t.version) : ''}</span>`).join("");
    }
  } catch { /* 静默 */ }

  _loadCommandCategories(container.querySelector("#toolkit-cmd-categories"));
}

const _CMD_CATEGORY_LABELS = {
  git: { label: "Git", desc: "git 版本控制命令" },
  npm: { label: "npm/yarn", desc: "包管理器命令" },
  node: { label: 'Node.js <i data-ic="warning"></i>', desc: "解释器（图灵完备，默认关）" },
  python: { label: 'Python <i data-ic="warning"></i>', desc: "解释器（图灵完备，默认关）" },
  pip: { label: 'pip <i data-ic="warning"></i>', desc: "Python 包安装（可执行 setup.py，默认关）" },
  filesystem: { label: "文件系统", desc: "ls/cat/find 等文件操作" },
  editor: { label: "编辑器", desc: "vim/nano/code 等编辑器启动" },
};

async function _loadCommandCategories(el) {
  if (!el) return;
  try {
    const data = await sendAction({ verb: "getCommandConfig", target: "plugins:beilu-memory", source: "web" }); // T6b：!ok 抛错入 catch
    const cats = data?.categories || {};
    el.innerHTML = Object.entries(_CMD_CATEGORY_LABELS).map(([key, meta]) => {
      const enabled = cats[key] === true;
      const isInterpreter = key === "node" || key === "python" || key === "pip";
      return `<label class="flex items-center gap-2 px-1 py-1 rounded hover:bg-base-200 cursor-pointer">
        <input type="checkbox" class="toggle toggle-xs ${isInterpreter ? "toggle-error" : "toggle-warning"}" data-cmd-cat="${key}" ${enabled ? "checked" : ""} />
        <div class="flex-1 min-w-0">
          <div class="text-[11px] font-medium">${meta.label}</div>
          <div class="text-[9px] text-base-content/40">${meta.desc}</div>
        </div>
      </label>`;
    }).join("");
    el.querySelectorAll("[data-cmd-cat]").forEach(toggle => {
      toggle.addEventListener("change", async () => {
        const cat = toggle.dataset.cmdCat;
        const enabled = toggle.checked;
        const isInterpreter = cat === "node" || cat === "python" || cat === "pip";
        if (enabled && isInterpreter && !await beiluConfirm(`⚠ 开启 ${cat} = 允许 AI 执行任意 ${cat} 脚本。仅在受信本地环境使用。确定？`)) {
          toggle.checked = false;
          return;
        }
        try {
          await sendAction({ verb: "setCommandConfig", target: "plugins:beilu-memory", source: "web", payload: { categories: { [cat]: enabled } } }); // T6b
          window._beiluToast?.(`${enabled ? "✅ 已启用" : "🔒 已禁用"} ${cat}`, "success");
        } catch (e) {
          toggle.checked = !enabled;
          window._beiluToast?.("命令配置保存失败: " + e.message, "error");
        }
      });
    });
  } catch {
    el.innerHTML = '<span class="opacity-40">命令配置加载失败</span>';
  }
}

// 高手层：逐条 toggle，全部真实字段（顶层字段直发，permissions 子项发嵌套结构）
function _renderPermToggles(listEl, cfg) {
  if (!listEl) return;
  if (!cfg) { listEl.innerHTML = '<span class="text-error/60">权限状态读取失败</span>'; return; }
  const perms = cfg.permissions || {};

  listEl.innerHTML = _PERM_TOGGLES.map(p => {
    const enabled = p.top ? cfg[p.key] === true : perms[p.key] === true;
    return `<label class="flex items-center gap-2 px-1 py-1 rounded hover:bg-base-200 cursor-pointer">
      <input type="checkbox" class="toggle toggle-xs toggle-warning" data-perm-key="${p.key}" data-perm-top="${p.top ? 1 : 0}" ${enabled ? "checked" : ""} />
      <div class="flex-1 min-w-0">
        <div class="text-[11px] font-medium">${p.label}</div>
        <div class="text-[9px] text-base-content/40">${p.desc}</div>
      </div>
    </label>`;
  }).join("");

  listEl.querySelectorAll("[data-perm-key]").forEach(toggle => {
    toggle.addEventListener("change", async () => {
      const key = toggle.dataset.permKey;
      const isTop = toggle.dataset.permTop === "1";
      const enabled = toggle.checked;
      const body = isTop ? { [key]: enabled } : { permissions: { [key]: enabled } };
      try {
        // T6b：files raw 字段写走专用 verb=updateFilesConfig（无 _action，后端进 field-update 分支）
        await sendAction({ verb: "updateFilesConfig", target: "plugins:beilu-files", source: "web", payload: body });
        _syncToggleToB3(key, enabled);
        window._beiluToast?.(`${enabled ? "✅ 已启用" : "🔒 已禁用"} ${key}`, "success");
        _renderActiveTools(document.getElementById("toolkit-active-tools"), await _fetchFilesConfig());
      } catch (e) {
        toggle.checked = !enabled;
        window._beiluToast?.("权限设置失败: " + e.message, "error");
      }
    });
  });
}

// 「当前可用工具」= 从真实权限状态推导（permissionMap 同口径），不写死数字
function _renderActiveTools(el, cfg) {
  if (!el) return;
  if (!cfg) { el.innerHTML = '<span class="opacity-40">权限状态读取失败</span>'; return; }
  const perms = cfg.permissions || {};
  const groups = [];
  const fileOps = [];
  if (perms.file_read) fileOps.push("read", "list", "search");
  if (perms.file_write) fileOps.push("write", "create", "move", "fuzzy_edit", "replace_lines", "insert", "edit_xlsx");
  if (perms.file_delete) fileOps.push("delete");
  if (fileOps.length) groups.push(`<i data-ic="folder-open"></i> 文件操作(${fileOps.length}): ${fileOps.join(" / ")}`);
  if (cfg.allowExec) groups.push('<i data-ic="zap"></i> 命令执行: exec');
  if (perms.mcp) groups.push('<i data-ic="plug"></i> MCP 工具');
  if (perms.questions) groups.push('<i data-ic="help"></i> 提问');
  if (perms.todo) groups.push('<i data-ic="clipboard"></i> 待办');
  el.innerHTML = groups.length
    ? groups.map(g => `<div>${g}</div>`).join("") +
      `<div class="opacity-40 mt-1">写入${cfg.autoApprove ? "免确认" : "需确认"} · 读取${cfg.autoApproveRead ? "免确认" : "需确认"}</div>`
    : '<span class="opacity-40">所有工具通道已关闭</span>';
}

// 界面4: MCP 独立侧栏面板（拍板#9），复用 mcpPanel 多实例（内部 ID 全前缀化）
function _renderMcpSidebar(container) {
  // [0727 凛倾「work 的直接拉线,直接复刻 code 的,也不用缓存隔离」] 单例 DOM 搬移，不建第二个实例。
  //   原来 work 自建 #work-mcp-panel 容器 + 再跑一次 initMcpPanel = 两套 DOM/两份加载状态/两份缓存，
  //   于是要给面板做多实例适配（容器集、id 前缀化、各自 hashchange 重载），并派生出重复标题与
  //   "永远加载中"（work 初始化期换 hash → 那一轮加载被守卫丢弃且不重来）两个病。
  //   现按项目既有范式（subModePanel #submode-manage-root 0716 同款）：**同一个面板 DOM 在容器间搬家**，
  //   code 与 work 模式互斥不可能同屏，搬移安全；加载状态/缓存天然只有一份，无需隔离。
  const _mcpRoot = document.getElementById("ide-panel-mcp");
  if (_mcpRoot) {
    container.innerHTML = "";
    container.appendChild(_mcpRoot); // 搬家不重建：内容/滚动/已展开的详情原样带过来
    // ide 侧靠 .hidden 控制显隐，搬到 work 侧栏后必须去掉，否则搬来一个隐身的面板
    _mcpRoot.classList.remove("hidden");
    if (!_mcpRoot.dataset.mcpInited) { initMcpPanel("ide-panel-mcp"); _mcpRoot.dataset.mcpInited = "1"; }
  } else {
    container.innerHTML = '<div class="p-4 text-sm text-base-content/50">MCP 面板容器未就绪（IDE 侧栏未加载）</div>';
  }
}

// ============================================================
// [WK-T3] 子模式面板 — 镜像 IDE 侧子模式管理面板（含编辑）
// ============================================================

async function _renderSubmodesPanel(container) {
  // 单例挂载（2026-07-16）：面板改为节点搬移（appendChild）而非重渲，须先清掉
  //   _loadSidebarPanel 写入的「加载中...」占位，否则占位残留在面板上方。
  container.innerHTML = "";
  await renderSubModeManagementInto(container, "work");
}

// ============================================================
// [WK-T3] 对话历史面板 — 复用 IDE 对话历史逻辑
//   conversationManager.mjs 仅导出 initConversationManager()，且绑定到 IDE
//   面板的固定 DOM ID（conv-list 等，单实例）。为避免重复 ID 冲突与重复绑定，
//   这里复用其同源能力：相同后端端点（getchatlist / chat new / delete）+
//   相同 localStorage meta key（beilu-conversation-meta）+ 相同 hash 切换方式。
// ============================================================

// [D5 收口 0713] 原 JSON.parse/storage.set 手抄=convMeta 同键第 4 套写路径（5 份实现质量不齐）。
//   接 conversationManager 权威（静态引安全：chat.mjs/conversationManager 均不反向引 workPanel，
//   无环；chatmgmt 静态引同模块先例）。_selfMetaWrite 保留=本模块监听器"自写跳过"语义，
//   薄壳内设/清——权威 saveConvMeta 同步派发事件，监听器执行时 flag 仍为 true，时序不变。
// 防递归标记：_saveConvMeta 广播后本模块监听器跳过自触发
let _selfMetaWrite = false;

function _loadConvMeta() {
  return loadConvMeta();
}
function _saveConvMeta(meta) {
  try {
    _selfMetaWrite = true;
    saveConvMeta(meta); // 权威内含 storage 写 + conv-meta-changed 广播
  } catch { /* ignore */ }
  finally { _selfMetaWrite = false; }
}

async function _renderHistoryPanel(container) {
  container.innerHTML = `
    <div class="p-3 space-y-2">
      <div class="flex items-center justify-between">
        <h4 class="font-bold text-sm">🗂️ 对话历史</h4>
        <div class="flex gap-1">
          <button id="work-conv-search-btn" class="btn btn-xs btn-ghost" title="搜索"><i data-ic="search"></i></button>
          <button id="work-conv-new-btn" class="btn btn-xs btn-ghost" title="新建对话"><i data-ic="plus"></i></button>
        </div>
      </div>
      <input id="work-conv-search-input" type="text" placeholder="🔍 搜索对话..." class="input input-xs input-bordered w-full hidden" />
      <div id="work-conv-list" class="space-y-1 mt-1 max-h-[60vh] overflow-y-auto"><p class="text-xs text-base-content/40">加载中...</p></div>
    </div>`;

  const listEl = container.querySelector("#work-conv-list");
  const searchInput = container.querySelector("#work-conv-search-input");

  // 搜索切换
  container.querySelector("#work-conv-search-btn")?.addEventListener("click", () => {
    if (!searchInput) return;
    const hidden = searchInput.classList.toggle("hidden");
    if (!hidden) searchInput.focus();
    else { searchInput.value = ""; _filterHistory(listEl, ""); }
  });
  searchInput?.addEventListener("input", () => _filterHistory(listEl, searchInput.value.trim().toLowerCase()));

  // 新建对话收口（0712）：原手抄路径漏 bindCharToChat（新对话 primaryCharName 空=列表按角色过滤下隐身）
  // 且分类只写本地漏服务端 chat_modes。doCreateNewChat 单源=创建+绑卡+classifyNewChat(三写)+切换全含。
  container.querySelector("#work-conv-new-btn")?.addEventListener("click", async () => {
    try {
      const { doCreateNewChat } = await import("../../shared/chat-core/conversationManager.mjs");
      await doCreateNewChat();
    } catch (e) {
      window._beiluToast?.("新建对话失败: " + e.message, "error");
    }
  });

  await _loadHistoryList(listEl, container);
}

async function _loadHistoryList(listEl, container) {
  if (!listEl) return;
  let chats = [];
  try {
    chats = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" }); // T6b：门面成功=返回解析后 body（原 res.ok 分支等价）
    if (!Array.isArray(chats)) chats = [];
  } catch (e) {
    listEl.innerHTML = '<p class="text-xs text-error/60">对话列表加载失败: ' + _escHtml(e.message) + '</p>';
    return;
  }

  // 角色卡过滤：只显示属于当前角色的对话（与 layout-smart / conversationManager 一致）
  const _curChar = _getCharId() || storage.get(KEYS.BEILU_LAST_CHAR) || "";
  if (_curChar) chats = chats.filter(c => chatBelongsToChar(c, _curChar));

  const meta = _loadConvMeta();
  // 确诊 C-2：走守卫单源 getChatId()（sharedState.mjs:108）——currentId 仅作 UI 高亮(:isActive) + 点击防重复切换比较；
  //   非法 hash 返 "" 时与合法 chatid 恒不等，行为=不高亮/都可切（当前窗口本无有效对话，语义正确）。对齐 cardsPanel.mjs:62。
  const currentId = window._beiluGetChatId?.() || "";

  // 排序：compareConvOrder 单源（0715 散点合并：原三份同构手抄比较器收进 conversationManager）——
  //   消费下移到下方动态 import 块之后（同 buildModeBadge 等经 _cm 取，防静态环通道不变）。
  if (chats.length === 0) {
    listEl.innerHTML = '<div class="text-xs text-base-content/40 text-center py-4">暂无对话<br><span class="opacity-60">点击右上角 <i data-ic="plus"></i> 新建</span></div>';
    return;
  }

  // 模式徽章 + 「XX窗口在用」单源（动态 import 防静态环，smart._populateSmartRecents 同款先例）
  // 0713 补丁删除：getModeInUseMap 本地收集已废，在用标签唯一权威=服务端 chat.usedByModes（P4）。
  let _buildInUseLabel = () => "";
  let _buildModeBadge = () => "";
  let _buildOtherWindowBadge = () => "";
  try {
    const _cm = await import("../../shared/chat-core/conversationManager.mjs");
    _buildInUseLabel = _cm.buildInUseLabel;
    _buildModeBadge = _cm.buildModeBadge;
    _buildOtherWindowBadge = _cm.buildOtherWindowBadge; // D4 收口
    // 排序单源（0715 散点合并）：置顶>收藏>最近活跃，语义只在 compareConvOrder 一份
    chats.sort((a, b) => _cm.compareConvOrder(a, b, meta));
  } catch { /* 单源不可达时徽章/在用标签降级空、列表保持后端时间序 */ }

  listEl.innerHTML = chats.map(chat => {
    const id = chat.chatid || chat.id;
    const cm = meta[id] || {};
    const isActive = id === currentId;
    const label = chat.customName || cm.label || chat.firstUserMessage || (id.substring(0, 10) + "…");
    const preview = chat.lastMessageContent ? chat.lastMessageContent.substring(0, 40) : "";
    // 0713 补丁删除：模式徽标唯一权威=服务端 chat.mode（`|| cm.mode` 本地回退=多源合并，P4 删）。
    const _mIcon = _buildModeBadge(chat.mode);
    // 「另一窗口在用」角标：buildOtherWindowBadge 单源（D4 收口）
    const _inUse = _buildOtherWindowBadge(id, chat.inUseCount);
    return `<div class="work-conv-item px-2 py-1.5 rounded text-xs hover:bg-base-200 cursor-pointer group" ${isActive ? 'style="background:var(--beilu-amber-10)"' : ''} data-chatid="${_escHtml(id)}">
      <div class="flex items-center gap-1 flex-wrap">
        ${chat.pinned ? '<i data-ic="pin"></i>' : ''}${chat.starred ? '<i data-ic="star"></i>' : ''}${_inUse}
        <span class="work-conv-label flex-1 truncate font-medium" style="min-width:6em;">${_mIcon} ${_escHtml(label)}</span>${_buildInUseLabel(chat.usedByModes)}
        <button class="text-[10px] opacity-40 group-hover:opacity-60 hover:opacity-100" data-conv-action="rename" title="改名"><i data-ic="edit"></i></button>
        <button class="text-[10px] opacity-40 group-hover:opacity-60 hover:opacity-100" data-conv-action="mark" title="标记模式图标">🏷️</button>
        <button class="text-[10px] opacity-40 group-hover:opacity-60 hover:opacity-100" data-conv-action="delete" title="删除"><i data-ic="trash"></i></button>
      </div>
      ${preview ? `<div class="work-conv-preview text-[10px] text-base-content/40 truncate">${_escHtml(preview)}</div>` : ''}
    </div>`;
  }).join("");

  listEl.querySelectorAll(".work-conv-item").forEach(item => {
    const id = item.dataset.chatid;
    item.addEventListener("click", async (e) => {
      if (e.target.closest("[data-conv-action]")) return;
      if (id === currentId) return;
      const m = _loadConvMeta();
      if (!m[id]) m[id] = {};
      m[id].lastActive = Date.now();
      _saveConvMeta(m);
      // 0713 直写收口(系统病型审计·批1):原 getModeChatIdKey+storage.set 裸写本地模式键,
      //   绕过 markModeActiveChat=只写本地不写服务端 → 双源漂移(「XX窗口在用」错标同族病)。
      //   删直写,模式作入口快照传 switchCharacterScope——[MO-ISO] 收口双写+广播,与
      //   switchToChat A1 范式一致(消灭 await 间隙 getCurrentMode 飞行期错键)。
      await switchCharacterScope(id, undefined, { mode: getCurrentMode() });
    });
    item.querySelector('[data-conv-action="rename"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      _renameHistoryConv(id, listEl, container);
    });
    // 🏷️标记模式（四渲染点操作一致性收口 0712）
    item.querySelector('[data-conv-action="mark"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { showConvModeMenu } = await import("../../shared/chat-core/conversationManager.mjs");
      showConvModeMenu(e, id);
    });
    item.querySelector('[data-conv-action="delete"]')?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!await beiluConfirm("删除此对话？（删除后进回收站，可找回）")) return; // 缺陷5：对齐后端 safeUnlink 回收站行为
      try {
        await sendAction({ verb: "deleteChat", target: "shells:chat", source: "web", payload: { chatids: [id] } }); // T6b
        const m = _loadConvMeta();
        delete m[id];
        _saveConvMeta(m);
        const _charName = storage.get(KEYS.BEILU_LAST_CHAR) || "";
        // 数据驱动收口（六域纠察缺陷4b）：原硬编码三值漏 smart，同 chatmgmt.mjs 删除链同批修（0706）。
        for (const [_mode] of Object.entries(MODE_CHATID_KEYS)) {
          const _mk = getModeChatIdKey(_mode, _charName);
          if (_mk && storage.get(_mk) === id) storage.remove(_mk);
        }
        // 删的是当前对话时切到列表中下一个可用对话
        // 确诊 C-3：走守卫单源 getChatId()（sharedState.mjs:108）——比较两侧同源；非法 hash 返 "" 时 "" === id 恒 false，
        //   不误触发切换，"删的是当前对话才切换" 语义不变（无有效当前对话时删任意对话不强制切走）。对齐 cardsPanel.mjs:62。
        const _curHash = window._beiluGetChatId?.() || "";
        if (_curHash === id) {
          const _remaining = listEl.querySelectorAll("[data-chatid]");
          const _nextId = [..._remaining].map(el => el.dataset.chatid).find(cid => cid !== id);
          if (_nextId) {
            // 0713 直写收口(批1):同上,删裸写 work 键,mode:"work" 入口快照(原直写键即 work 字面,语义不变)
            switchCharacterScope(_nextId, _charName, { mode: "work" });
          }
        }
        _loadHistoryList(listEl, container);
      } catch (err) {
        window._beiluToast?.("删除失败: " + err.message, "error");
      }
    });
  });
}

function _renameHistoryConv(chatid, listEl, container) {
  const item = listEl.querySelector(`[data-chatid="${chatid}"]`);
  const labelEl = item?.querySelector(".work-conv-label");
  const meta = _loadConvMeta();
  // [合并批 0714·二] UI 编排收口 mountInlineEdit 单源（4 处同构副本；原版 blur 无 contains 守卫，
  //   Escape 恢复原文移除 input 触发 blur 仍会提交改名——统一形态顺带修掉）。
  // 提交段原为 commitChatRename 的手抄（renameChat+warning toast+meta.label 写）——并入 D2 单源；
  // _selfMetaWrite 包裹保留"自写跳过"语义（权威 saveConvMeta 同步派发，监听器执行时 flag 仍 true）。
  mountInlineEdit(labelEl, {
    value: meta[chatid]?.label || "",
    className: "input input-xs input-bordered w-full",
    onCommit: async (name) => {
      _selfMetaWrite = true;
      try { await commitChatRename(chatid, name); }
      finally { _selfMetaWrite = false; }
      _loadHistoryList(listEl, container);
    },
  });
}

function _filterHistory(listEl, q) {
  if (!listEl) return;
  listEl.querySelectorAll(".work-conv-item").forEach(item => {
    const label = item.querySelector(".work-conv-label")?.textContent || "";
    const preview = item.querySelector(".work-conv-preview")?.textContent || "";
    const match = !q || label.toLowerCase().includes(q) || preview.toLowerCase().includes(q);
    item.style.display = match ? "" : "none";
  });
}

function _renderOverviewInPanel(container) {
  // 界面4: 任务条目区=界面2 taskItemPanel 同款组件（taskStore 唯一权威，挂载重指）；
  // W0 统计/活跃任务两区删（与 taskStore 双源，工作表格数据在监控[上下文]仍可见）
  container.innerHTML = `
    <div class="work-panel p-4">
      <div id="work-stats-card" class="work-section">
        <div class="flex gap-3 text-center text-xs">
          <div class="flex-1 bg-base-200/50 rounded p-2"><div class="text-lg font-bold" id="ws-total">-</div><div class="opacity-60">总任务</div></div>
          <div class="flex-1 bg-base-200/50 rounded p-2"><div class="text-lg font-bold text-warning" id="ws-active">-</div><div class="opacity-60">进行中</div></div>
          <div class="flex-1 bg-base-200/50 rounded p-2"><div class="text-lg font-bold text-success" id="ws-completed">-</div><div class="opacity-60">已完成</div></div>
        </div>
      </div>
      <div class="work-section">
        <div class="work-section-title">AI 任务清单（对话内待办 · 与回档）</div>
        <div id="work-task-panel-mount"></div>
      </div>
      <div class="work-section">
        <div class="work-section-title">工作文件（work/ 目录 · 与 AI 共享）</div>
        <div id="work-files-mount" class="work-section-body"></div>
      </div>
      <div id="work-delegates2" class="work-section">
        <div class="work-section-title">委派状态</div>
        <div id="work-delegates-content2" class="work-section-body"></div>
      </div>
      <div id="work-approvals2" class="work-section">
        <div class="work-section-title">待审批</div>
        <div id="work-approvals-content2" class="work-section-body"></div>
      </div>
      <div id="work-scheduler2" class="work-section">
        <div class="work-section-title flex items-center justify-between">
          <span>定时任务</span>
          <span class="flex gap-1">
            <button class="btn btn-xs btn-success btn-outline" data-sched-start="1" title="启动调度器">▶ 启动</button>
            <button class="btn btn-xs btn-warning btn-outline" data-sched-stop="1" title="停止调度器"><i data-ic="pause"></i> 停止</button>
            <button class="btn btn-xs btn-outline" data-sched-add="1" title="添加任务"><i data-ic="plus"></i> 添加任务</button>
          </span>
        </div>
        <div id="work-scheduler-form" class="hidden"></div>
        <div id="work-scheduler-content2" class="work-section-body"></div>
      </div>
      <div class="work-section">
        <div class="work-section-title flex items-center justify-between">
          <span>运维</span>
          <span class="flex gap-1">
            <button class="btn btn-xs btn-outline" id="work-diagnose" title="诊断 work 模式目录/配置健康">🩺 诊断</button>
            <button class="btn btn-xs btn-error btn-outline" id="work-clear-queues" title="清空委派/审批/结果队列"><i data-ic="trash"></i> 清空工作队列</button>
          </span>
        </div>
        <div class="text-[10px] opacity-40">诊断：检查 work 目录结构/配置/子模式健康。清空：委派、审批和待处理结果队列（不影响任务记录和定时任务）</div>
        <!-- [F3 0714] 字号消费用户字体设置的唯一活链 --beilu-font-size（滑块写 documentElement 变量，
             fallback 14px=滑块默认值；×0.72≈周围 10px 初始一致且随设置缩放）。追链结论：em 不可用
             （body.font-size-* 类零 producer=死 CSS，body 字号从未被设置驱动）；周围 text-[10px]
             绝对值不吃设置=系统性病灶另行登记，新代码不复制病。 -->
        <div id="work-clone-concurrency-row" class="flex items-center justify-between mt-2" style="font-size:calc(var(--beilu-font-size, 14px)*0.72)">
          <span class="opacity-60" title="流水线/委派并行执行分身时的并发上限；0=无限多开，>0 按池限流">分身并发上限（0=无限）</span>
          <span class="opacity-40">加载中…</span>
        </div>
        <!-- [T4 0805] work 模式自动继续设置（凛倾方案B独立配置：yonban_config.work_auto_continue）。
             读写走 setAutoContinueConfig/getAutoContinueConfig verb 对（user 级 yonban_config，与消费端
             generation.getAutoContinueConfig(username,"work") 同文件同键）；禁走 updateConfig——那写
             per-char memory/_config.json，消费端读不到（读写不同源死配置）。缺 work 键时后端回退全局
             auto_continue，UI 显示的即当前实际生效值。数据先行渲染，范式=_loadCloneConcurrency。 -->
        <div id="work-auto-continue-row" class="mt-2 space-y-1" style="font-size:calc(var(--beilu-font-size, 14px)*0.72)">
          <div class="flex items-center justify-between">
            <span class="opacity-60" title="work 模式独立的操作后自动继续开关（不影响 code 面板设置）">自动继续（work 独立）</span>
            <span class="opacity-40">加载中…</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="opacity-60" title="连续自动续轮上限熔断；0=不限">连续续轮上限（0=不限）</span>
            <span class="opacity-40">—</span>
          </div>
        </div>
        <div id="work-diagnose-result" class="hidden mt-2 space-y-0.5 max-h-64 overflow-auto"></div>
      </div>
    </div>
  `;
  // 0713 双头收口：面板内标题+刷新已删（同屏与 #work-sidebar-title 重复出两个"任务台"），
  //   刷新唯一家=侧栏头部 #work-sidebar-refresh（initWorkPanel 绑定，对所有面板通用重载）。
  // 点击委托已由 initWorkPanel 绑在 sidebarContent（本 container 即其内），不重复绑定
  // 任务条目组件重指到任务台（切回 ide 时 moveChatContainer 归位回 ide-task-panel）
  mountTaskItemPanel("work-task-panel-mount");
  // 加载数据
  _loadDelegatesTo("work-delegates-content2");
  _loadApprovalsTo("work-approvals-content2");
  _loadSchedulerTo("work-scheduler-content2");
  _loadWorkStats();
  _renderWorkFilesInto(container.querySelector("#work-files-mount")); // 孤儿verb期1：工作文件 CRUD 子区
  container.querySelector("#work-clear-queues")?.addEventListener("click", async () => {
    if (!await beiluConfirm("确定清空委派、审批和待处理结果队列？任务记录和定时任务不受影响。")) return;
    try {
      await sendAction({ verb: "clearWorkQueues", target: "plugins:beilu-memory", source: "web" }); // T6b
      window._beiluToast?.("工作队列已清空", "success");
      _renderOverviewInPanel(container);
    } catch (e) { window._beiluToast?.("清空失败: " + e.message, "error"); }
  });
  // S1: work 模式健康诊断（diagnoseWorkMode 早在后端:2766，前端零入口——补按钮渲染 check 列表）
  container.querySelector("#work-diagnose")?.addEventListener("click", () => _runDiagnose());
  _loadCloneConcurrency(container); // [F3 接线 0714] 与 _loadWorkStats 等 _load* 家族并列的数据先行加载
  _loadAutoContinue(container); // [T4 0805] work 模式自动继续设置行——数据先行渲染，同 _load* 家族
}

/**
 * [T4 0805] work 模式自动继续设置行（凛倾方案B独立配置：「前端的话复用，储存单独拉线」）。
 * 读=getAutoContinueConfig verb + mode:"work"（返回 work 生效值：work_auto_continue 覆盖、缺键回退全局，
 *   与消费端 generation.getAutoContinueConfig(username,"work") 同一函数同一口径）；
 * 写=setAutoContinueConfig verb + mode:"work"（写 yonban_config.work_auto_continue，全量覆写语义——
 *   UI 未暴露的 delay/loop 字段随写回填当前生效值防半写，范式=idePanel:1082 同 verb 全字段发送）。
 * 数据先行渲染：拿到值才连值渲染控件；读失败显示"读取失败"不留空框；保存失败回滚到最近确认值+toast。
 */
async function _loadAutoContinue(container) {
  const row = container.querySelector("#work-auto-continue-row");
  if (!row) return;
  let _eff = null;
  try {
    const r = await sendAction({ verb: "getAutoContinueConfig", target: "plugins:beilu-memory", source: "web", payload: { mode: "work" } });
    _eff = r?.auto_continue || null;
  } catch { _eff = null; }
  if (!row.isConnected) return; // 面板已重渲染/切走，本次结果作废
  if (!_eff) {
    for (const _ph of row.querySelectorAll(".opacity-40")) _ph.textContent = "读取失败";
    return;
  }
  let _savedEnabled = _eff.enabled !== false;
  let _savedMaxRounds = Math.max(0, parseInt(_eff.max_auto_rounds, 10) || 0);
  // 全量覆写防半写：UI 只暴露 enabled/max_auto_rounds，其余字段回填当前生效值
  const _save = async (enabled, maxRounds) => {
    const r = await sendAction({
      verb: "setAutoContinueConfig", target: "plugins:beilu-memory", source: "web",
      payload: { mode: "work", enabled, max_auto_rounds: maxRounds, delay_ms: _eff.delay_ms, loop_enabled: _eff.loop_enabled, loop_inject_text: _eff.loop_inject_text, loop_stop_threshold: _eff.loop_stop_threshold },
    });
    if (!r?.success) throw new Error(r?.error || "后端未确认");
  };
  const _lines = row.children;
  _lines[0].lastElementChild.outerHTML =
    `<input type="checkbox" id="work-auto-continue-enabled" class="toggle toggle-xs" ${_savedEnabled ? "checked" : ""} />`;
  _lines[1].lastElementChild.outerHTML =
    `<input type="number" id="work-auto-continue-max-rounds" min="0" step="1" class="input input-xs input-bordered w-20" value="${_savedMaxRounds}" />`;
  const _cb = row.querySelector("#work-auto-continue-enabled");
  const _input = row.querySelector("#work-auto-continue-max-rounds");
  _cb?.addEventListener("change", async () => {
    const _enabled = _cb.checked;
    try {
      await _save(_enabled, _savedMaxRounds);
      _savedEnabled = _enabled;
      window._beiluToast?.(`work 自动继续已${_enabled ? "开启" : "关闭"}`, "success");
    } catch (e) {
      _cb.checked = !_enabled; // 回滚
      window._beiluToast?.("自动继续设置保存失败：" + (e?.message || e), "error");
    }
  });
  _input?.addEventListener("change", async () => {
    const raw = _input.value.trim();
    const n = parseInt(raw, 10);
    if (raw === "" || !Number.isFinite(n) || n < 0) {
      _input.value = String(_savedMaxRounds);
      window._beiluToast?.("续轮上限需为 ≥0 的整数（0=不限），已恢复原值", "warning");
      return;
    }
    _input.value = String(n);
    try {
      await _save(_cb?.checked ?? _savedEnabled, n);
      _savedMaxRounds = n;
      window._beiluToast?.(`连续续轮上限已设为 ${n === 0 ? "不限" : n}`, "success");
    } catch (e) {
      _input.value = String(_savedMaxRounds);
      window._beiluToast?.("续轮上限保存失败：" + (e?.message || e), "error");
    }
  });
}

/**
 * [F3 接线 0714] 分身并发上限设置行。消费端 replyHandler:2327/3587 `config.clone_concurrency ?? 0`
 * （0=无限多开，>0 池限流），写口=updateConfig（同批补的后端白名单分支），per-char 域
 * （_apiCall 自动补 charName=消费端 loadMemoryData 同键）。
 * 数据先行渲染：拿到值才把输入框连 value 渲染进占位（范式=本文件 _renderToolkitPanel
 * await 数据后 _renderPermToggles 控件连值渲染），不存在「空框→异步回填」竞态窗口；
 * 缺键/读失败（_apiCall 返 null 且已留痕上报）显示 0=消费端 ?? 0 的当前实际生效值，不留空框；
 * 保存失败回滚到最近确认值（范式=_renderPermToggles 的 toggle.checked=!enabled 回滚+toast）。
 */
async function _loadCloneConcurrency(container) {
  const row = container.querySelector("#work-clone-concurrency-row");
  if (!row) return;
  const d = await _apiCall("getData");
  if (!row.isConnected) return; // 面板已重渲染/切走，本次结果作废
  let _saved = Math.max(0, parseInt(d?.config?.clone_concurrency, 10) || 0);
  row.lastElementChild.outerHTML =
    `<input type="number" id="work-clone-concurrency" min="0" step="1" class="input input-xs input-bordered w-20" value="${_saved}" />`;
  const input = row.querySelector("#work-clone-concurrency");
  input.addEventListener("change", async () => {
    const raw = input.value.trim();
    const n = parseInt(raw, 10);
    // 空串/非数/负数=无效输入：回显上次确认值并可见提示，禁静默落 0——
    // 0=无限多开是本配置最危险的值，不允许由清空/乱敲隐式触达（凛倾 0714：清空≠设为无限）
    if (raw === "" || !Number.isFinite(n) || n < 0) {
      input.value = String(_saved);
      window._beiluToast?.("并发上限需为 ≥0 的整数（0=无限），已恢复原值", "warning");
      return;
    }
    input.value = String(n);
    try {
      const r = await _apiCall("updateConfig", { clone_concurrency: n });
      if (!r?.success) throw new Error(r?.error || "后端未确认");
      _saved = n;
      window._beiluToast?.(`分身并发上限已设为 ${n === 0 ? "无限" : n}`, "success");
    } catch (e) {
      input.value = String(_saved);
      window._beiluToast?.("并发上限保存失败：" + (e?.message || e), "error");
    }
  });
}

// S1 诊断：调 diagnoseWorkMode 渲染 {summary, results:[{status,msg}]} 到运维区。
// 只读诊断（后端不写数据），无需二次确认。charName 由 _apiCall 补，username 走桥 session。
async function _runDiagnose() {
  const box = document.getElementById("work-diagnose-result");
  const btn = document.getElementById("work-diagnose");
  if (!box) return;
  box.classList.remove("hidden");
  box.innerHTML = '<span class="text-xs opacity-50">诊断中...</span>';
  if (btn) btn.disabled = true;
  try {
    const data = await _apiCall("diagnoseWorkMode");
    if (!data?.success || !Array.isArray(data.results)) {
      box.innerHTML = `<span class="text-xs text-error">诊断失败${data?.error ? "：" + _escHtml(data.error) : ""}</span>`;
      return;
    }
    const rows = data.results.map((r) => {
      const st = r.status || "";
      const cls = st === "❌" ? "text-error" : st === "⚠️" ? "text-warning" : "text-success";
      return `<div class="flex items-start gap-1 text-[11px]"><span class="${cls} shrink-0">${_escHtml(st)}</span><span class="opacity-80">${_escHtml(r.msg || "")}</span></div>`;
    }).join("");
    box.innerHTML = `<div class="text-[11px] font-semibold opacity-70 mb-1">${_escHtml(data.summary || "")}</div>${rows}`;
  } catch (e) {
    box.innerHTML = `<span class="text-xs text-error">诊断异常：${_escHtml(e?.message || String(e))}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _loadWorkStats() {
  try {
    const charName = _getCharId() || "";
    const modeKey = getModeChatIdKey("work", charName);
    const chatid = modeKey ? storage.get(modeKey) : undefined;
    const data = await _apiCall("getTasks", { chatid });
    if (!data?.success || !Array.isArray(data.tasks)) {
      // 诚实失败态（2026-07-16 断链修）：原静默 return 让统计永远停在初始 "-"，
      //   与"加载中"不可区分（截图实证）。失败显式标 "?"，原因已由 _apiCall 留痕错误中心。
      for (const _id of ["ws-total", "ws-active", "ws-completed"]) {
        const _el = document.getElementById(_id);
        if (_el) { _el.textContent = "?"; _el.title = "任务统计读取失败（详见监控→错误）"; }
      }
      return;
    }
    const tasks = data.tasks;
    const total = tasks.length;
    const active = tasks.filter(t => t.status === "in_progress").length;
    const completed = tasks.filter(t => t.status === "completed").length;
    const el = (id) => document.getElementById(id);
    if (el("ws-total")) el("ws-total").textContent = total;
    if (el("ws-active")) el("ws-active").textContent = active;
    if (el("ws-completed")) el("ws-completed").textContent = completed;
  } catch { /* 统计加载失败不阻塞 */ }
}

// ============================================================
// [孤儿verb期1] 工作文件 CRUD 子区 — 5 verb 前端入口
//   数据链：控件 → _apiCall(verb,{chatid,...}) → sendAction plugins:beilu-memory#* 通配桥
//     → setDataActions.handleSetData(:631) → case createWorkFile/... → work/<subfolder>/ 真读写。
//   状态：当前展示的 subfolder（active/outputs/workflows），默认 active。
// ============================================================

let _workFilesSubfolder = "active";

// 取 work 模式当前 chatid（与 _loadWorkStats:991 同源）——决定后端读写哪个 work_ctx。
// 无绑定时返回 undefined，后端落 char 级（向后兼容），不报错。
function _getWorkChatid() {
  try {
    const charName = _getCharId() || "";
    const modeKey = getModeChatIdKey("work", charName);
    return modeKey ? storage.get(modeKey) : undefined;
  } catch { return undefined; }
}

// 列 work/<subfolder> 下文件 → {success, files:[{name,size,modified}]}（后端过滤 `_` 前缀 :2928）
async function _wfList(subfolder) {
  return _apiCall("listWorkFiles", { chatid: _getWorkChatid(), subfolder });
}
// 读文件内容 → {success, content}
async function _wfRead(filename, subfolder) {
  return _apiCall("readWorkFile", { chatid: _getWorkChatid(), filename, subfolder });
}
// 新建文件 → {success, path}（后端拒 filename 含 ../\ 及非白名单 subfolder）
async function _wfCreate(filename, content, subfolder) {
  return _apiCall("createWorkFile", { chatid: _getWorkChatid(), filename, content, subfolder });
}
// 归档 active 下文件（破坏性移动到 work/archive/<YYYY-MM>/）→ {success, archived_to}
async function _wfArchive(filename) {
  return _apiCall("archiveWorkFile", { chatid: _getWorkChatid(), filename });
}
// work_tables.json 任务统计 → {success, stats:{total,active,completed}}
async function _wfStats() {
  return _apiCall("getWorkStats", { chatid: _getWorkChatid() });
}

function _fmtSize(n) {
  if (typeof n !== "number") return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

// 渲染工作文件子区（列表 + 工具栏）到指定容器。renderOverview 挂载，刷新自身用递归重渲。
async function _renderWorkFilesInto(host) {
  if (!host) return;
  // 工具栏：subfolder 选择器（选项来自白名单单源 _WORK_SUBFOLDERS）+ 新建 + 刷新
  const _opts = _WORK_SUBFOLDERS
    .map(f => `<option value="${_escHtml(f)}" ${f === _workFilesSubfolder ? "selected" : ""}>${_escHtml(f)}</option>`)
    .join("");
  host.innerHTML = `
    <div class="flex items-center gap-1 mb-1">
      <select id="wf-subfolder" class="select select-xs select-bordered" title="工作文件子目录">${_opts}</select>
      <button id="wf-new" class="btn btn-xs btn-outline" title="在当前子目录新建工作文件"><i data-ic="plus"></i> 新建</button>
      <button id="wf-refresh" class="btn btn-xs btn-ghost" title="刷新文件列表"><i data-ic="refresh"></i></button>
      <span id="wf-stat" class="text-[10px] opacity-40 ml-auto"></span>
    </div>
    <div id="wf-list" class="space-y-0.5 max-h-56 overflow-auto text-xs">
      <div class="opacity-40 p-1">加载中...</div>
    </div>`;

  host.querySelector("#wf-subfolder")?.addEventListener("change", (e) => {
    _workFilesSubfolder = e.target.value;
    _renderWorkFilesInto(host);
  });
  host.querySelector("#wf-refresh")?.addEventListener("click", () => _renderWorkFilesInto(host));
  host.querySelector("#wf-new")?.addEventListener("click", () => _createWorkFileFlow(host));

  // 顶部统计（getWorkStats，work_tables 任务表——与任务台 getTasks 不同源，展示 work 表记录量）
  _wfStats().then(s => {
    const el = host.querySelector("#wf-stat");
    if (el && s?.success && s.stats) el.textContent = `任务表 ${s.stats.total || 0} 条（进行 ${s.stats.active || 0} · 完成 ${s.stats.completed || 0}）`;
  }).catch(() => { /* 统计失败不阻塞列表 */ });

  // 文件列表
  const listEl = host.querySelector("#wf-list");
  const data = await _wfList(_workFilesSubfolder);
  if (!data?.success) {
    listEl.innerHTML = `<div class="text-error/60 p-1">加载失败${data?.error ? "：" + _escHtml(data.error) : ""}</div>`;
    return;
  }
  const files = data.files || [];
  if (files.length === 0) {
    listEl.innerHTML = '<div class="opacity-40 p-1">该目录暂无文件</div>';
    return;
  }
  listEl.innerHTML = files.map(f => {
    const name = f.name || "";
    const meta = [_fmtSize(f.size), f.modified ? new Date(f.modified).toLocaleString() : ""].filter(Boolean).join(" · ");
    // 仅 active 目录给归档按钮（后端 archiveWorkFile 只处理 active :2910）
    const archiveBtn = _workFilesSubfolder === "active"
      ? `<button class="btn btn-xs btn-ghost px-1 wf-archive shrink-0" data-name="${_escHtml(name)}" title="归档到 work/archive/"><i data-ic="package"></i></button>`
      : "";
    return `<div class="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-base-200">
      <span class="wf-open flex-1 truncate cursor-pointer" data-name="${_escHtml(name)}" title="点击查看内容"><i data-ic="file"></i> ${_escHtml(name)}</span>
      <span class="opacity-40 text-[10px] shrink-0 truncate max-w-[45%]">${_escHtml(meta)}</span>
      ${archiveBtn}
    </div>`;
  }).join("");

  listEl.querySelectorAll(".wf-open").forEach(el => {
    el.addEventListener("click", () => _openWorkFileViewer(el.dataset.name, _workFilesSubfolder));
  });
  listEl.querySelectorAll(".wf-archive").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      if (!await beiluConfirm(`归档「${name}」到 work/archive/？文件将从 active 移出。`)) return;
      btn.disabled = true;
      const r = await _wfArchive(name);
      if (r?.success) {
        window._beiluToast?.(`已归档到 ${r.archived_to || "archive"}`, "success");
        _renderWorkFilesInto(host);
      } else {
        window._beiluToast?.("归档失败" + (r?.error ? "：" + r.error : ""), "error");
        btn.disabled = false;
      }
    });
  });
}

// 新建工作文件流程：输入文件名（后端拒含 ../\，白名单 subfolder），空内容起步，成功后刷新。
async function _createWorkFileFlow(host) {
  const raw = await beiluPrompt(`在 work/${_workFilesSubfolder}/ 新建文件（如 note.md）`, "");
  if (raw === null) return; // 取消
  const filename = String(raw).trim();
  if (!filename) { window._beiluToast?.("文件名不能为空", "warning"); return; }
  // 前端最小校验对齐后端 :2884（含路径穿越字符即拒），提前给友好提示而非等后端报错
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    window._beiluToast?.("文件名不能含 .. / \\ 等路径字符", "warning");
    return;
  }
  const r = await _wfCreate(filename, "", _workFilesSubfolder);
  if (r?.success) {
    window._beiluToast?.(`已创建 ${r.path || filename}`, "success");
    _renderWorkFilesInto(host);
  } else {
    window._beiluToast?.("创建失败" + (r?.error ? "：" + r.error : ""), "error");
  }
}

// 查看工作文件内容（readWorkFile）——只读弹窗，复用 beiluDialog 无法承载长文本，故用轻量 modal 覆盖层。
async function _openWorkFileViewer(filename, subfolder) {
  const r = await _wfRead(filename, subfolder);
  if (!r?.success) { window._beiluToast?.("读取失败" + (r?.error ? "：" + r.error : ""), "error"); return; }
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[4000] flex items-center justify-center bg-black/40 p-4";
  overlay.innerHTML = `
    <div class="bg-base-100 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
        <span class="font-bold text-sm truncate"><i data-ic="file"></i> ${_escHtml(subfolder)}/${_escHtml(filename)}</span>
        <button class="btn btn-xs btn-ghost wf-close">✕</button>
      </div>
      <pre class="p-3 overflow-auto text-xs whitespace-pre-wrap flex-1">${_escHtml(r.content || "")}</pre>
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".wf-close")?.addEventListener("click", close);
  document.body.appendChild(overlay);
}

// ============================================================
// [WK-T6] Tasks 状态栏 — 替代 subModePanel 触发栏(work 模式下隐藏)
//   输入框上方一行：显示当前对话任务计数，点击切到任务台面板
// ============================================================

let _taskBarEl = null;

function _injectTaskBar() {
  const chatContainer = document.getElementById("chat-container");
  if (!chatContainer || _taskBarEl) return;
  const inputArea = chatContainer.querySelector(".chat-input-wrapper");

  _taskBarEl = document.createElement("div");
  _taskBarEl.id = "work-task-bar";
  _taskBarEl.style.cssText = "flex-shrink:0;display:none;padding:3px 10px;font-size:11px;cursor:pointer;opacity:0.7;border-top:1px solid var(--beilu-border,rgba(128,128,128,0.15));";
  _taskBarEl.title = "点击打开任务台";
  _taskBarEl.innerHTML = '<span id="work-task-bar-text"><i data-ic="clipboard"></i> 加载任务...</span>';
  _taskBarEl.addEventListener("click", () => _switchWorkPanel("overview"));

  if (inputArea) chatContainer.insertBefore(_taskBarEl, inputArea);
  else chatContainer.appendChild(_taskBarEl);

  _refreshTaskBar();
}

async function _refreshTaskBar() {
  if (!_taskBarEl) return;
  const mode = getCurrentMode();
  const triggerWrapper = document.getElementById("submode-trigger-wrapper");
  const triggerVisible = triggerWrapper && triggerWrapper.style.display !== "none";
  if (mode !== "work" || triggerVisible) { _taskBarEl.style.display = "none"; return; }
  _taskBarEl.style.display = "";
  try {
    const charName = _getCharId() || "";
    const modeKey = getModeChatIdKey("work", charName);
    const chatid = modeKey ? storage.get(modeKey) : undefined;
    const data = await _apiCall("getTasks", { chatid });
    if (!data?.success || !Array.isArray(data.tasks)) {
      _taskBarEl.querySelector("#work-task-bar-text").innerHTML = '<i data-ic="clipboard"></i> 暂无任务';
      return;
    }
    const t = data.tasks;
    const done = t.filter(x => x.status === "completed").length;
    const prog = t.filter(x => x.status === "in_progress").length;
    const open = t.length - done - prog;
    _taskBarEl.querySelector("#work-task-bar-text").innerHTML =
      t.length === 0 ? '<i data-ic="clipboard"></i> 暂无任务' : `<i data-ic="clipboard"></i> ${t.length} 任务（${done} 完成 · ${prog} 进行中 · ${open} 待办）`;
  } catch { /* 静默 */ }
}

// ============================================================
// [WK-T1] 监控面板 — 3 Tab：操作记录 / 执行日志 / 上下文
//   设计源 工作模式_界面设计.md §[M]监控 (line 275-300)
//   · 操作记录: getOperationHistory (beilu-files) — 既有逻辑
//   · 执行日志: getFlowGroupStatus (beilu-memory) — Skill组步骤推进状态
//   · 上下文:   getTokenInfo() (tokenProgressBar) + 当前子模式/模型 (DOM)
//   全部前端可取数据源，无新增后端依赖。
// ============================================================

let _opsActiveTab = "ops";

async function _renderOperationsPanel(container) {
  container.innerHTML = `
    <div class="p-3 space-y-2">
      <div class="flex items-center justify-between">
        <h4 class="font-bold text-sm"><i data-ic="clipboard"></i> 监控</h4>
        <button id="work-ops-refresh" class="btn btn-xs btn-ghost" title="刷新"><i data-ic="refresh"></i></button>
      </div>
      <div class="tabs tabs-boxed tabs-xs bg-base-200/50">
        <a class="tab" data-ops-tab="ops">操作记录</a>
        <a class="tab" data-ops-tab="log">执行日志</a>
        <a class="tab" data-ops-tab="err">错误</a>
        <a class="tab" data-ops-tab="ctx">上下文</a>
      </div>
      <div id="work-ops-tabbody" class="text-xs"></div>
    </div>`;

  container.querySelector("#work-ops-refresh")?.addEventListener("click", () => _renderOperationsPanel(container));
  container.querySelectorAll("[data-ops-tab]").forEach(tab => {
    tab.addEventListener("click", () => {
      _opsActiveTab = tab.dataset.opsTab;
      _switchOpsTab(container);
    });
  });
  _switchOpsTab(container);
}

function _switchOpsTab(container) {
  const body = container.querySelector("#work-ops-tabbody");
  if (!body) return;
  container.querySelectorAll("[data-ops-tab]").forEach(t =>
    t.classList.toggle("tab-active", t.dataset.opsTab === _opsActiveTab));
  body.innerHTML = '<p class="text-base-content/40 p-2">加载中...</p>';
  if (_opsActiveTab === "ops") _renderOpsTabOperations(body);
  else if (_opsActiveTab === "log") _renderOpsTabExecLog(body);
  else if (_opsActiveTab === "err") _renderOpsTabErrors(body);
  else _renderOpsTabContext(body);
}

// Tab: 错误 — backendMonitor 全局错误缓冲（[📊]角标同源数据面：角标数的错误在这里可见；打开即置已读→角标熄灭）
function _renderOpsTabErrors(body) {
  const errs = getMonitorErrors();
  markMonitorErrorsRead();
  if (errs.length === 0) {
    body.innerHTML = '<p class="text-base-content/40 p-2">无错误</p>';
    return;
  }
  body.innerHTML = '<div class="space-y-0.5 max-h-96 overflow-y-auto">' +
    errs.slice(-50).reverse().map(en => `
      <div class="text-[10px] px-1 py-0.5 border-b border-base-300/30" style="color:var(--beilu-error)">
        <span class="opacity-40">${_escHtml(en.time)}</span> ${_escHtml(en.text)}
      </div>`).join("") + '</div>';
}

// Tab1: 操作记录 — getOperationHistory
async function _renderOpsTabOperations(body) {
  try {
    const data = await sendAction({ verb: "getOperationHistory", target: "plugins:beilu-files", source: "web" }); // T6b：files 通配路由 verb→_action
    const history = data.history || [];
    const statsHtml = data.stats
      ? `<div class="text-xs text-base-content/40 mb-1">共${data.stats.total || 0}次 | <i data-ic="check"></i>${data.stats.success || 0} | <i data-ic="cross"></i>${data.stats.failed || 0}</div>`
      : "";
    if (history.length === 0) {
      body.innerHTML = statsHtml + '<p class="text-base-content/40 p-2">暂无操作记录</p>';
      return;
    }
    body.innerHTML = statsHtml + '<div class="space-y-1 max-h-96 overflow-y-auto">' +
      history.slice(-30).reverse().map(op => {
        const icon = op.success ? '<i data-ic="check"></i>' : '<i data-ic="cross"></i>';
        const time = op.timestamp ? new Date(op.timestamp).toLocaleTimeString() : '';
        return `<div class="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-base-200">
          <span>${icon}</span>
          <span class="font-mono">${_escHtml(op.type || op.tool || '?')}</span>
          <span class="text-base-content/40 truncate flex-1">${_escHtml(op.path || op.command || '')}</span>
          <span class="text-base-content/50 shrink-0">${time}</span>
        </div>`;
      }).join("") + '</div>';
  } catch (e) {
    body.innerHTML = '<p class="text-error/60 p-2">加载失败: ' + _escHtml(e.message) + '</p>';
  }
}

// Tab2: 执行日志 — getFlowGroupStatus (Skill组步骤推进)
async function _renderOpsTabExecLog(body) {
  try {
    const data = await getFlowGroupStatusShared(); // T023 Q5：三面板共享单飞+TTL（原各自 sendAction 三倍拉取）
    if (!data.active) {
      body.innerHTML = '<div class="text-base-content/40 p-2 text-center">无运行中的 Skill 组<br><span class="opacity-60 text-[10px]">启动工作流后这里显示步骤执行进度</span></div>';
      return;
    }
    const st = data.state || {};
    const steps = data.steps || [];
    const cur = st.current_step || 0;
    const total = st.total_steps || steps.length || 0;
    const statusLabel = { running: "▶ 运行中", awaiting_approval: '<i data-ic="warning"></i> 等待审批', stopped: "⏹ 已停止", completed: '<i data-ic="check"></i> 完成' }[st.status] || st.status || "";
    // T029 状态驱动按钮组：后端 advance(:3490)/approve(:3580)/stop(:3599) handler 全已存在，前端原零入口
    // =awaiting_approval 永久冻结（高危6条唯一未修项）。按 status 条件渲染防误操作
    // （advanceFlowGroup 校验 status==="running"，awaiting 态给推进按钮=必然报错）。
    const _fgBtns = st.status === "awaiting_approval"
      ? `<button class="btn btn-xs btn-success work-fg-approve">✓ 批准继续</button><button class="btn btn-xs btn-error btn-outline work-fg-stop">⏹ 停止</button>`
      : st.status === "running"
        ? `<button class="btn btn-xs btn-primary btn-outline work-fg-advance">⏭ 推进下一步</button><button class="btn btn-xs btn-error btn-outline work-fg-stop">⏹ 停止</button>`
        : "";
    body.innerHTML = `
      <div class="mb-2">
        <div class="font-bold text-xs">${_escHtml(data.name || data.filename || "Skill组")}</div>
        <div class="text-[10px] text-base-content/50">${statusLabel} — 步骤 ${cur + 1}/${total}</div>
        ${_fgBtns ? `<div class="flex gap-1 mt-1">${_fgBtns}</div>` : ""}
      </div>
      <div class="space-y-0.5">${steps.map((s, i) => {
        const icon = st.status === "completed" || i < cur ? '<i data-ic="check"></i>' : i === cur ? "▶" : "⬜";
        const active = i === cur && st.status !== "completed";
        return `<div class="text-[10px] px-1 py-0.5 rounded ${active ? 'font-bold' : 'text-base-content/50'}" ${active ? 'style="background:var(--beilu-amber-10);color:var(--beilu-amber)"' : ''}>
          ${icon} ${i + 1}. ${_escHtml(s.label || s.mode || s.preset_name || "步骤" + (i + 1))}${s.executor === "clone" ? ' <span class="opacity-50">[分身]</span>' : ''}
        </div>`;
      }).join("")}</div>`;
  } catch (e) {
    body.innerHTML = '<p class="text-error/60 p-2">加载失败: ' + _escHtml(e.message) + '</p>';
  }
}

// Tab3: 上下文 — getTokenInfo() + 当前子模式/模型 (Dify Variable Inspect 风格)
function _renderOpsTabContext(body) {
  let tok = { chars: 0, tokens: 0, maxContext: 200000, ratio: 0 };
  try { tok = _getTokenInfo?.() || tok; } catch { /* 模块未就绪 */ }
  const pct = Math.round((tok.ratio || 0) * 100);
  const usedK = (tok.tokens / 1000).toFixed(1);
  const maxK = Math.round(tok.maxContext / 1000);
  const barColor = pct >= 85 ? "bg-error" : pct >= 60 ? "bg-warning" : "";
  const barStyle = pct < 60 ? `style="background:var(--beilu-amber)"` : "";

  // 当前子模式/模型（subModePanel 内存态优先，镜像后端生效链）
  let subLabel = "";
  let _smMp = null, _smFlat = null;
  try {
    const activeId = _smActiveId?.() || "";
    const modes = _smGetSubModes?.() || [];
    const m = modes.find(x => x.id === activeId);
    subLabel = m ? `${m.icon || ''} ${m.label || m.id}` : activeId;
    _smMp = (m?.model_params && typeof m.model_params === "object") ? m.model_params : null;
    _smFlat = m || null;
  } catch { /* ignore */ }
  // 断链修复（前端断链批 20260706）：原 api-source-select 全库零定义=幽灵 DOM，恒显"默认"。
  // 权威=生效链镜像（getPromptHandler:298-301 优先级 _mp.api_source ?? _mp.apiSource ?? sm.apiSource）：
  // 子模式带覆盖→显示覆盖值；无覆盖→"默认"=跟随全局源（与后端回退 runtime/preset 基线语义一致）。
  const _srcVal = (_smMp ? (_smMp.api_source ?? _smMp.apiSource ?? _smFlat?.apiSource) : _smFlat?.apiSource) || "";
  const apiSource = _srcVal || "默认";
  // model 同链镜像：子模式覆盖优先。[0716 散写收口] 回退分叉：绑了源没绑模型=生成用绑定源默认模型，
  //   回退全局 #api-model（全局源的值）会误标——如实显示「源默认」；源模型都没绑才回退全局输入框。
  const _mVal = (_smMp ? (_smMp.model ?? _smMp.modelName ?? _smFlat?.modelName) : _smFlat?.modelName) || "";
  const model = _mVal ? (_mVal.split("/").pop() || "未配置")
    : (_srcVal ? "源默认" : ((document.getElementById("api-model")?.value || "").split("/").pop() || "未配置"));

  body.innerHTML = `
    <div class="space-y-2">
      <div>
        <div class="flex justify-between text-[10px] text-base-content/50 mb-0.5">
          <span>上下文 Token</span><span>${usedK}K / ${maxK}K (${pct}%)</span>
        </div>
        <div class="w-full bg-base-300 rounded-full h-1.5">
          <div class="${barColor} h-1.5 rounded-full transition-all" style="width:${Math.min(pct, 100)}%${pct < 60 ? ';background:var(--beilu-amber)' : ''}"></div>
        </div>
      </div>
      <div class="bg-base-200/50 rounded-lg p-2 space-y-1">
        <div class="flex justify-between"><span class="text-base-content/50">当前子模式</span><span class="font-medium">${_escHtml(subLabel || "—")}</span></div>
        <div class="flex justify-between"><span class="text-base-content/50">API 源</span><span class="font-mono">${_escHtml(apiSource)}</span></div>
        <div class="flex justify-between"><span class="text-base-content/50">模型</span><span class="font-mono">${_escHtml(model)}</span></div>
        <div class="flex justify-between"><span class="text-base-content/50">字符数</span><span class="font-mono">${tok.chars || 0}</span></div>
      </div>
      ${pct >= 85 ? '<div class="text-[10px] text-error"><i data-ic="warning"></i> 上下文接近上限，建议清理或新建对话</div>' : ''}
    </div>`;
}

export function destroyWorkPanel() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  _initialized = false;
}

// ============================================================
// API 调用
// ============================================================

async function _apiCall(action, extra = {}) {
  try {
    // N28：统一补传 charName——后端 setDataActions 不传 charName 落 "_global" 桶，而审批/队列/委派
    // 由 replyHandler 按会话角色写 per-char 桶（创建/读取作用域不对称，指令链二轮 #1）。
    // 取不到角色时不传（JSON 序列化丢 undefined），后端兜底行为不变；显式 extra.charName 可覆盖。
    // T6b: memory 通配 setdata 路由 verb=真动作；!ok 抛错走 catch → null（原 res.ok 校验静默等价）
    return await sendAction({
      verb: action, target: "plugins:beilu-memory", source: "web",
      payload: { charName: _getCharId() || undefined, ...extra },
    });
  } catch (e) {
    // T021 留痕（非弹出）：_apiCall 被 _refreshTimer 周期轮询复用，逐次弹出=风暴；
    // 改带 verb 的留痕+errors 上报，用户操作路径的可见性由调用方按需补
    console.warn(`[workPanel] ${action} 调用失败:`, e?.message || e);
    window._reportError?.(`[workPanel] ${action} 失败: ${e?.message || e}`, e?.stack);
    return null;
  }
}

// ============================================================
// 刷新各区块
// ============================================================

async function _loadDelegatesTo(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const data = await _apiCall("getWorkDelegates");
  if (!data?.success) { el.textContent = "无数据"; return; }

  const active = data.active || [];
  const recent = (data.completed || []).slice(-3);

  if (active.length === 0 && recent.length === 0) {
    el.innerHTML = '<div class="work-empty">无委派任务</div>';
    return;
  }

  let html = "";
  if (active.length > 0) {
    html += active.map(d => `
      <div class="work-delegate-item active">
        <span><i data-ic="clipboard"></i> ${_escHtml(d.from)} → ${_escHtml(d.to)}</span>
        <span class="work-delegate-round">轮次 ${d.currentRound || 0}/${d.maxRounds || 10}</span>
        <button class="btn btn-xs btn-error work-cancel-delegate" data-id="${d.id}">取消</button>
      </div>
    `).join("");
  }
  if (recent.length > 0) {
    html += '<div class="work-subsection-title">最近完成</div>';
    html += recent.map(d => {
      const statusLabel = { completed: "✅ 完成", timeout: "⏰ 超时", cancelled: "❌ 取消", blocked: "🚫 受阻" }[d.status] || d.status;
      return `<div class="work-delegate-item done">
        <span>${_escHtml(d.from)} → ${_escHtml(d.to)}: ${_escHtml(statusLabel)}</span>
      </div>`;
    }).join("");
  }
  el.innerHTML = html;
}

async function _loadApprovalsTo(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const data = await _apiCall("getWorkApprovals");
  if (!data?.success) { el.textContent = "无数据"; return; }

  const approvals = data.approvals || [];
  // [T]角标同源：任务台角标数的是 IDE 写审批（window._beiluPendingApprovals，chat.mjs/smart.mjs 轮询+WS 推送维护），
  // 但审批浮窗 dock 挂在 #center-tab-chat 内、work Tab 下不可见 → 红点亮而面板"无待审批"= 断链。
  // 此处聚合展示两条队列：IDE 写审批（approveIdeOp/rejectIdeOp）+ work 审批（resolveWorkApproval），
  // 角标数的东西在它指向的面板里可见可处理。
  const ideOps = window._beiluPendingApprovals || [];
  if (approvals.length === 0 && ideOps.length === 0) {
    el.innerHTML = '<div class="work-empty">无待审批项</div>';
    return;
  }

  const ideHtml = ideOps.map(op => {
    const target = op.absPath || op.params?.path || op.params?.command || "";
    return `
    <div class="work-approval-card">
      <div class="work-approval-title"><i data-ic="warning"></i> IDE 写操作：${_escHtml(op.tool || "?")}${op._forceApproval ? ' <span class="text-error text-[10px] font-bold">危险</span>' : ""}</div>
      <div class="work-approval-desc font-mono break-all">${_escHtml(target)}</div>
      <div class="work-approval-actions">
        <button class="btn btn-xs btn-success work-ide-approve-btn" data-id="${_escHtml(op.id)}">✓ 允许一次</button>
        <button class="btn btn-xs btn-error work-ide-reject-btn" data-id="${_escHtml(op.id)}">✕ 拒绝</button>
      </div>
    </div>`;
  }).join("");

  el.innerHTML = ideHtml + approvals.map(a => `
    <div class="work-approval-card">
      <div class="work-approval-title"><i data-ic="hourglass"></i> ${_escHtml(a.title || "审批请求")}</div>
      <div class="work-approval-desc">${_escHtml(a.description || "")}</div>
      <div class="work-approval-actions">
        <button class="btn btn-xs btn-success work-approve-btn" data-id="${a.id}">✓ 批准</button>
        <button class="btn btn-xs btn-error work-reject-btn" data-id="${a.id}">✕ 拒绝</button>
      </div>
    </div>
  `).join("");
}

// S6: 缓存 listJobs 完整 job（含 description/action/schedule 全字段），编辑表单据此预填。
// 列表渲染只显示部分字段，编辑需回原始完整对象，故在拉取时缓存（按 id 索引）。
let _schedJobsCache = new Map();

async function _loadSchedulerTo(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const data = await _apiCall("scheduler_listJobs");
  if (!data?.success) { el.textContent = "无数据"; return; }

  const jobs = data.jobs || [];
  _schedJobsCache = new Map(jobs.map((j) => [j.id, j]));
  // 调度器运行态如实显示（2026-07-16 断链修配套）：后端 listJobs 未启动时改读盘投影+回传 running:false，
  //   任务不再隐身；此处提示"已停"让用户知道到期不会触发，需点 ▶ 启动。
  const _runHint = data.running === false && jobs.length > 0
    ? '<div class="text-[10px] text-warning/80 mb-1">⏸ 调度器未启动（任务到期不会触发，点上方 ▶ 启动）</div>'
    : "";
  if (jobs.length === 0) {
    el.innerHTML = '<div class="work-empty">无定时任务</div>';
    return;
  }

  el.innerHTML = _runHint + jobs.map(j => {
    const enabledClass = j.enabled ? "" : "disabled";
    // [BE-T6] scheduler 字段在 j.schedule 下
    const sched = j.schedule || {};
    const typeIcon = { cron: '<i data-ic="clock"></i>', interval: '<i data-ic="refresh"></i>', once: '<i data-ic="one"></i>' }[sched.type || j.type] || '<i data-ic="clock"></i>';
    const scheduleLabel = sched.cron || j.cron
      || ((sched.intervalMinutes || j.intervalMinutes) ? (sched.intervalMinutes || j.intervalMinutes) + "分钟" : "")
      || (sched.runAt || j.runAt || "");
    return `<div class="work-scheduler-item ${enabledClass}">
      <span>${typeIcon} ${_escHtml(j.name || j.label || j.id)}</span>
      <span class="work-scheduler-schedule">${_escHtml(scheduleLabel)}</span>
      <label class="work-toggle">
        <input type="checkbox" class="work-toggle-job" data-id="${j.id}" ${j.enabled ? "checked" : ""}>
        <span class="work-toggle-slider"></span>
      </label>
      <button class="btn btn-xs btn-ghost work-sched-edit" data-id="${j.id}" title="编辑任务"><i data-ic="edit"></i></button>
      <button class="btn btn-xs btn-ghost text-error work-sched-del" data-id="${j.id}" title="删除任务"><i data-ic="trash"></i></button>
    </div>`;
  }).join("");
}

// ============================================================
// 事件处理
// ============================================================

let _panelBusy = false;
async function _handlePanelClick(e) {
  if (_panelBusy) return;
  _panelBusy = true;
  try { return await _handlePanelClickInner(e); } finally { _panelBusy = false; }
}
async function _handlePanelClickInner(e) {
  // T029 流程组运行控制（批准/推进/停止）。
  // [键收口 2026-07-13] 槽一致性：显示链 getFlowGroupStatusShared 已单点注入当前 cid（helper 内），
  //   动作链此处同带 cid——启动/显示/动作三链同键（per-chat 全隔离蓝图）。后端 D09 槽解析
  //   per-chatid 优先、_default 兜底，旧 _default 槽流水线仍可批/推/停。禁用 _apiCall（自动补 charName 会落错槽）。
  const fgBtn = e.target.closest(".work-fg-approve, .work-fg-advance, .work-fg-stop");
  if (fgBtn) {
    const verb = fgBtn.classList.contains("work-fg-approve") ? "approveFlowGroup"
      : fgBtn.classList.contains("work-fg-advance") ? "advanceFlowGroup" : "stopFlowGroup";
    fgBtn.disabled = true;
    try {
      const r = await sendAction({ verb, target: "plugins:beilu-memory", source: "web", payload: {} }); // 会话键由 sendAction scope 盖章→桥 args.chatid（键收口 2026-07-13）
      if (r && r.success === false) throw new Error(r.error || verb + " 返回失败");
      window._beiluToast?.(verb === "approveFlowGroup" ? "✓ 已批准，流程组继续" : verb === "advanceFlowGroup" ? "⏭ 已推进下一步" : "⏹ 流程组已停止", "success");
    } catch (err) {
      window._beiluToast?.(`流程组操作失败(${verb}): ${err?.message || err}`, "error"); // T021 弹出规范
    }
    invalidateFlowGroupStatus(); // 变更后清共享缓存，立即刷新取到新状态而非 TTL 旧值
    const _logBody = document.getElementById("work-ops-tabbody");
    if (_logBody && _opsActiveTab === "log") _renderOpsTabExecLog(_logBody);
    return;
  }

  // 审批 — 批准
  const approveBtn = e.target.closest(".work-approve-btn");
  if (approveBtn) {
    const id = approveBtn.dataset.id;
    approveBtn.disabled = true;
    await _apiCall("resolveWorkApproval", { approvalId: id, decision: "approved" });
    await _loadApprovalsTo("work-approvals-content2");
    // 重拉审批数据源 → 活动栏角标/smart 计数随之更新（不是只刷本地列表）
    window._beiluTriggerApprovalPoll?.(true);
    return;
  }

  // 审批 — 拒绝
  const rejectBtn = e.target.closest(".work-reject-btn");
  if (rejectBtn) {
    const id = rejectBtn.dataset.id;
    rejectBtn.disabled = true;
    await _apiCall("resolveWorkApproval", { approvalId: id, decision: "rejected" });
    await _loadApprovalsTo("work-approvals-content2");
    window._beiluTriggerApprovalPoll?.(true);
    return;
  }

  // IDE 写审批 — 允许一次 / 拒绝（后端 approveIdeOp/rejectIdeOp，与 chat.mjs 审批 dock 同 verb 同队列；
  // chatid 供后端 tool_results_ready 广播定位会话。处理后重拉全局 → 角标/列表同步）
  const ideApproveBtn = e.target.closest(".work-ide-approve-btn");
  const ideRejectBtn = e.target.closest(".work-ide-reject-btn");
  if (ideApproveBtn || ideRejectBtn) {
    const btn = ideApproveBtn || ideRejectBtn;
    btn.disabled = true;
    const r = await _apiCall(ideApproveBtn ? "approveIdeOp" : "rejectIdeOp", { opId: btn.dataset.id, chatid: _getWorkChatid() });
    if (r && r.success === false) window._beiluToast?.("审批操作失败" + (r.error ? "：" + r.error : ""), "error");
    window._beiluTriggerApprovalPoll?.(true); // 触发 beilu:smart-task-update → 本面板重渲 + 角标更新
    return;
  }

  // 取消委派
  const cancelBtn = e.target.closest(".work-cancel-delegate");
  if (cancelBtn) {
    const id = cancelBtn.dataset.id;
    cancelBtn.disabled = true;
    await _apiCall("cancelWorkDelegate", { delegateId: id });
    await _loadDelegatesTo("work-delegates-content2");
    return;
  }

  // 定时任务开关
  const toggle = e.target.closest(".work-toggle-job");
  if (toggle) {
    const id = toggle.dataset.id;
    await _apiCall("scheduler_toggleJob", { jobId: id, enabled: toggle.checked });
    return;
  }

  // 调度器 — 启动
  const schedStartBtn = e.target.closest("[data-sched-start]");
  if (schedStartBtn) {
    const r = await _apiCall("scheduler_start");
    if (r?.success) window._beiluToast?.("调度器已启动", "success");
    else window._beiluToast?.("启动失败" + (r?.error ? "：" + r.error : ""), "error");
    await _loadSchedulerTo("work-scheduler-content2");
    return;
  }

  // 调度器 — 停止
  const schedStopBtn = e.target.closest("[data-sched-stop]");
  if (schedStopBtn) {
    const r = await _apiCall("scheduler_stop");
    if (r?.success) window._beiluToast?.("调度器已停止", "success");
    else window._beiluToast?.("停止失败" + (r?.error ? "：" + r.error : ""), "error");
    await _loadSchedulerTo("work-scheduler-content2");
    return;
  }

  // 调度器 — 显示/隐藏添加任务表单
  const schedAddBtn = e.target.closest("[data-sched-add]");
  if (schedAddBtn) {
    _toggleSchedulerForm();
    return;
  }

  // 调度器 — 取消添加
  const schedCancelBtn = e.target.closest("[data-sched-cancel]");
  if (schedCancelBtn) {
    _toggleSchedulerForm(true);
    return;
  }

  // 调度器 — 提交添加任务
  const schedCreateBtn = e.target.closest("[data-sched-create]");
  if (schedCreateBtn) {
    await _submitSchedulerJob(schedCreateBtn);
    return;
  }

  // 调度器 — 删除任务
  const schedDelBtn = e.target.closest(".work-sched-del");
  if (schedDelBtn) {
    const id = schedDelBtn.dataset.id;
    if (!await beiluConfirm("删除此定时任务？")) return;
    const r = await _apiCall("scheduler_removeJob", { jobId: id });
    if (r?.success) window._beiluToast?.("任务已删除", "success");
    else window._beiluToast?.("删除失败" + (r?.error ? "：" + r.error : ""), "error");
    await _loadSchedulerTo("work-scheduler-content2");
    return;
  }

  // S6 调度器 — 编辑任务（打开预填表单，提交走 scheduler_updateJob）
  const schedEditBtn = e.target.closest(".work-sched-edit");
  if (schedEditBtn) {
    const id = schedEditBtn.dataset.id;
    _openSchedulerEditForm(id);
    return;
  }

  // S6 调度器 — 提交编辑（更新已建任务）
  const schedUpdateBtn = e.target.closest("[data-sched-update]");
  if (schedUpdateBtn) {
    await _submitSchedulerEdit(schedUpdateBtn);
    return;
  }
}

// 调度器：显示/隐藏添加任务表单
function _toggleSchedulerForm(forceHide = false) {
  const formEl = document.getElementById("work-scheduler-form");
  if (!formEl) return;
  if (forceHide || !formEl.classList.contains("hidden")) {
    formEl.classList.add("hidden");
    formEl.innerHTML = "";
    return;
  }
  formEl.classList.remove("hidden");
  formEl.innerHTML = `
    <div class="card bg-base-200/60 p-3 my-2 space-y-2">
      <input id="sched-name" type="text" placeholder="任务名称" class="input input-xs input-bordered w-full" />
      <input id="sched-desc" type="text" placeholder="描述（可选）" class="input input-xs input-bordered w-full" />
      <select id="sched-type" class="select select-xs select-bordered w-full">
        <option value="interval">间隔执行 (interval)</option>
        <option value="cron">Cron 表达式 (cron)</option>
        <option value="once">单次 (once)</option>
      </select>
      <div id="sched-param-field"></div>
      <select id="sched-action-type" class="select select-xs select-bordered w-full">
        <option value="inject">注入提醒（下次对话时AI看到）</option>
        <option value="auto_reply">自动回复（AI主动发消息，仅work/code模式）</option>
      </select>
      <label class="flex items-center gap-2 text-xs cursor-pointer">
        <input id="sched-enabled" type="checkbox" class="checkbox checkbox-xs checkbox-warning" checked /> 启用 (enabled)
      </label>
      <div class="flex gap-2">
        <button class="btn btn-xs btn-success" data-sched-create="1">创建</button>
        <button class="btn btn-xs btn-ghost" data-sched-cancel="1">取消</button>
      </div>
    </div>`;
  _renderSchedParamField("interval");
  // schedule.type 切换直接绑定 change（select 不走 click 委托）
  formEl.querySelector("#sched-type")?.addEventListener("change", (ev) => {
    _renderSchedParamField(ev.target.value);
  });
}

// 调度器：根据 schedule.type 渲染对应参数输入
function _renderSchedParamField(type) {
  const fieldEl = document.getElementById("sched-param-field");
  if (!fieldEl) return;
  if (type === "cron") {
    fieldEl.innerHTML = `<input id="sched-cron" type="text" placeholder="Cron 表达式（如 0 9 * * *）" class="input input-xs input-bordered w-full" />`;
  } else if (type === "once") {
    fieldEl.innerHTML = `<input id="sched-runat" type="datetime-local" class="input input-xs input-bordered w-full" />`;
  } else {
    fieldEl.innerHTML = `<input id="sched-interval" type="number" min="1" placeholder="间隔分钟数" class="input input-xs input-bordered w-full" />`;
  }
}

// 调度器：提交添加任务（scheduler_addJob）
async function _submitSchedulerJob(btn) {
  const name = (document.getElementById("sched-name")?.value || "").trim();
  const description = (document.getElementById("sched-desc")?.value || "").trim();
  const type = document.getElementById("sched-type")?.value || "interval";
  const enabled = !!document.getElementById("sched-enabled")?.checked;
  if (!name) { window._beiluToast?.("请填写任务名称", "warning"); return; }

  const schedule = { type };
  if (type === "cron") {
    const cron = (document.getElementById("sched-cron")?.value || "").trim();
    if (!cron) { window._beiluToast?.("请填写 Cron 表达式", "warning"); return; }
    schedule.cron = cron;
  } else if (type === "once") {
    const runAt = (document.getElementById("sched-runat")?.value || "").trim();
    if (!runAt) { window._beiluToast?.("请选择执行时间", "warning"); return; }
    schedule.runAt = runAt;
  } else {
    const mins = parseInt(document.getElementById("sched-interval")?.value || "0", 10);
    if (!mins || mins < 1) { window._beiluToast?.("请填写有效的间隔分钟数", "warning"); return; }
    schedule.intervalMs = mins * 60000;
    schedule.intervalMinutes = mins;
  }

  const actionType = document.getElementById("sched-action-type")?.value || "inject";
  const job = { name, description, schedule, action: { type: actionType }, enabled };
  if (btn) btn.disabled = true;

  let r = await _apiCall("scheduler_addJob", { job });
  // 若调度器未启动，先启动再重试一次
  if (r && !r.success && /未启动|not started|未启用/.test(r.error || "")) {
    const startR = await _apiCall("scheduler_start");
    if (startR?.success) r = await _apiCall("scheduler_addJob", { job });
  }
  if (r?.success) {
    window._beiluToast?.(`已添加任务：${r.job?.name || name}`, "success");
    _toggleSchedulerForm(true);
    await _loadSchedulerTo("work-scheduler-content2");
  } else {
    if (btn) btn.disabled = false;
    window._beiluToast?.("添加失败" + (r?.error ? "：" + r.error : ""), "error");
  }
}

// ============================================================
// S6 调度器：编辑已建任务（scheduler_updateJob）
//   缺口=调度列表已有 toggle/删除/添加，唯独缺"编辑"入口（后端 updateJob:301 早在，前端零调用）。
//   复用添加表单的 DOM 结构与 _renderSchedParamField；打开时按 _schedJobsCache 里的完整 job 预填，
//   提交组 updates 对象走 scheduler_updateJob（后端 Object.assign(job,updates)，含 schedule 重算 nextRunAt）。
// ============================================================
function _openSchedulerEditForm(jobId) {
  const job = _schedJobsCache.get(jobId);
  if (!job) { window._beiluToast?.("任务数据缺失，请刷新后重试", "warning"); return; }
  const formEl = document.getElementById("work-scheduler-form");
  if (!formEl) return;
  const sched = job.schedule || {};
  const schedType = sched.type || job.type || "interval";
  const actionType = job.action?.type || "inject";
  formEl.classList.remove("hidden");
  formEl.innerHTML = `
    <div class="card bg-base-200/60 p-3 my-2 space-y-2" data-sched-edit-id="${_escHtml(jobId)}">
      <div class="text-xs opacity-60"><i data-ic="edit"></i> 编辑任务 <span class="font-mono opacity-40">${_escHtml(jobId)}</span></div>
      <input id="sched-name" type="text" placeholder="任务名称" class="input input-xs input-bordered w-full" value="${_escHtml(job.name || job.label || "")}" />
      <input id="sched-desc" type="text" placeholder="描述（可选）" class="input input-xs input-bordered w-full" value="${_escHtml(job.description || "")}" />
      <select id="sched-type" class="select select-xs select-bordered w-full">
        <option value="interval" ${schedType === "interval" ? "selected" : ""}>间隔执行 (interval)</option>
        <option value="cron" ${schedType === "cron" ? "selected" : ""}>Cron 表达式 (cron)</option>
        <option value="once" ${schedType === "once" ? "selected" : ""}>单次 (once)</option>
      </select>
      <div id="sched-param-field"></div>
      <select id="sched-action-type" class="select select-xs select-bordered w-full">
        <option value="inject" ${actionType === "inject" ? "selected" : ""}>注入提醒（下次对话时AI看到）</option>
        <option value="auto_reply" ${actionType === "auto_reply" ? "selected" : ""}>自动回复（AI主动发消息，仅work/code模式）</option>
      </select>
      <label class="flex items-center gap-2 text-xs cursor-pointer">
        <input id="sched-enabled" type="checkbox" class="checkbox checkbox-xs checkbox-warning" ${job.enabled ? "checked" : ""} /> 启用 (enabled)
      </label>
      <div class="flex gap-2">
        <button class="btn btn-xs btn-primary" data-sched-update="1">保存修改</button>
        <button class="btn btn-xs btn-ghost" data-sched-cancel="1">取消</button>
      </div>
    </div>`;
  _renderSchedParamField(schedType);
  // 预填参数字段现值（_renderSchedParamField 只建空输入，值在此回填）
  if (schedType === "cron") {
    const el = document.getElementById("sched-cron");
    if (el) el.value = sched.cron || job.cron || "";
  } else if (schedType === "once") {
    const el = document.getElementById("sched-runat");
    // datetime-local 需 "YYYY-MM-DDTHH:mm"；后端存的可能是该格式或时间戳，尽量原样回填
    if (el) el.value = _toDatetimeLocal(sched.runAt || job.runAt || "");
  } else {
    const el = document.getElementById("sched-interval");
    if (el) el.value = sched.intervalMinutes || job.intervalMinutes || (sched.intervalMs ? Math.round(sched.intervalMs / 60000) : "");
  }
  formEl.querySelector("#sched-type")?.addEventListener("change", (ev) => {
    _renderSchedParamField(ev.target.value);
  });
}

// datetime-local 输入要求本地时间格式 "YYYY-MM-DDTHH:mm"。原值已是该格式则原样返回；
// 是时间戳/ISO 则转本地格式；无法解析返回空串（不硬塞非法值）。
function _toDatetimeLocal(v) {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// S6 提交编辑：组装 updates（仅可编辑字段）走 scheduler_updateJob。
async function _submitSchedulerEdit(btn) {
  const card = btn.closest("[data-sched-edit-id]");
  const jobId = card?.getAttribute("data-sched-edit-id");
  if (!jobId) { window._beiluToast?.("任务 id 丢失，无法保存", "error"); return; }
  const name = (document.getElementById("sched-name")?.value || "").trim();
  const description = (document.getElementById("sched-desc")?.value || "").trim();
  const type = document.getElementById("sched-type")?.value || "interval";
  const enabled = !!document.getElementById("sched-enabled")?.checked;
  if (!name) { window._beiluToast?.("请填写任务名称", "warning"); return; }

  const schedule = { type };
  if (type === "cron") {
    const cron = (document.getElementById("sched-cron")?.value || "").trim();
    if (!cron) { window._beiluToast?.("请填写 Cron 表达式", "warning"); return; }
    schedule.cron = cron;
  } else if (type === "once") {
    const runAt = (document.getElementById("sched-runat")?.value || "").trim();
    if (!runAt) { window._beiluToast?.("请选择执行时间", "warning"); return; }
    schedule.runAt = runAt;
  } else {
    const mins = parseInt(document.getElementById("sched-interval")?.value || "0", 10);
    if (!mins || mins < 1) { window._beiluToast?.("请填写有效的间隔分钟数", "warning"); return; }
    schedule.intervalMs = mins * 60000;
    schedule.intervalMinutes = mins;
  }

  const actionType = document.getElementById("sched-action-type")?.value || "inject";
  // T054b：后端 updateJob(scheduler.mjs:308) 是 Object.assign 浅合并——updates.action 会整体替换 job.action。
  //   编辑表单只暴露 action.type 一个可编辑字段（sched-action-type），target/自定义 payload 用户不可编辑，
  //   语义上应保留原值。若只提交 {type} 则原 action.target/payload 被清空丢失。故从 _schedJobsCache 取原
  //   job.action 展开，仅覆盖 type：{...原action, type}。（侵入最小方案：前端展开，不改后端浅合并契约）
  const _origAction = _schedJobsCache.get(jobId)?.action || {};
  const updates = { name, description, schedule, action: { ..._origAction, type: actionType }, enabled };
  btn.disabled = true;

  const r = await _apiCall("scheduler_updateJob", { jobId, updates });
  if (r?.success) {
    window._beiluToast?.("任务已更新", "success");
    _toggleSchedulerForm(true);
    await _loadSchedulerTo("work-scheduler-content2");
  } else {
    btn.disabled = false;
    window._beiluToast?.("更新失败" + (r?.error ? "：" + r.error : ""), "error");
  }
}
