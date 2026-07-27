/**
 * permissionPanel.mjs — B3 权限规则集「三层渐进披露」管理面板（FT2）
 *
 * 功能链：
 *   layout.mjs initPermissionPanel() → 挂载到 #ide-permission-rules-panel
 *   第 1 层（控制面板原位）：档位徽章（自由/协作/谨慎/只读）→ importPermissionTemplate(templateId)
 *   → A 侧同步（_syncTemplateToA）→ beilu-files 权限系统同步
 *   第 2/3 层（悬浮窗 #perm-rules-window，可拖拽/ESC 关）：
 *   → getApprovalRules → 渲染工具×路径×三态规则列表
 *   → 修改单条 → setApprovalRule（敏感规则 confirmSensitive 二次确认）
 *   → 新增/删除规则 → 后端同步 → 当前档转 ⚙custom
 *   区外访问开关 → setAllowOutsideWorkspace
 *   T5 反向同步桥：B3 档位变动 → _syncTemplateToA → beilu-files A 侧权限参数同步
 *
 * why（FT2 凛倾拍板）：
 *   三层渐进披露：普通用户只见档位徽章（第 1 层），高级用户进悬浮窗细调（第 2/3 层）；
 *   敏感规则（.env/删除类）改 allow 须二次确认，防止误操作；
 *   T5 反向同步桥补齐 A→B 已有的正向桥，保证 B3 面板与 beilu-files A 侧权限双向一致；
 *   系统硬挡（_forceApproval 危险命令）永不被覆盖，后端引擎最终裁决。
 *
 * 关联链：
 *   ← layout.mjs（initPermissionPanel 调用）
 *   → beilu-memory 插件后端（getApprovalRules/setApprovalRule/removeApprovalRule/importPermissionTemplate/setAllowOutsideWorkspace）
 *   → beilu-files 插件前端（FILES_SET_URL：T5 A 侧权限同步）
 *   → beiluDialog.mjs（beiluConfirm：敏感规则二次确认）
 *
 * 影响范围：
 *   后端权限引擎（ideClient.evaluateRuleDecision）裁决结果直接决定 AI 操作是否被放行；
 *   beilu-files A 侧 autoApprove/permissions 随档位同步变化；
 *   DOM：#ide-permission-rules-panel（档位徽章）+ #perm-rules-window（规则悬浮窗）。
 *
 * 使用效果：
 *   一键切档位即切整组规则；进悬浮窗可精细控制每条工具+路径+三态权限；
 *   敏感默认改 allow 弹二次确认弹窗防误操作。
 */

import { showToast } from "../../../../../../scripts/toast.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作；beilu-files 字段写走 updateFilesConfig）
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { renderFilesPathConfig } from "../shared/filesPathConfig.mjs"; // 凛倾0710：路径黑白名单归权限域（原设置面板入口已迁此）
import { escapeHtml } from "../../shared/state/utils.mjs"; // T7b：escapeHtml 统一二期——收口到壳权威版（原 _esc 为等价 5 字符自实现副本）
import { toolSets, syncToolSets } from "../../shared/state/toolSets.mjs"; // 0715 硬编码收口(F1)：工具清单单源

// T5 反向同步桥：IDE 权限面板(B3) → workPanel/beilu-files(A) 权限系统。
// workPanel.mjs 已有 A→B 桥(_syncPresetToB3/_syncToggleToB3)，此处补反向。
const _B3_TPL_TO_A_PRESET = {
  full: {
    autoApprove: true, autoApproveRead: true, autoApproveList: true, allowExec: true,
    permissions: { file_read: true, file_write: true, file_delete: true, file_retry: true, mcp: true, questions: true, todo: true },
  },
  collab: {
    autoApprove: false, autoApproveRead: true, autoApproveList: true, allowExec: false,
    permissions: { file_read: true, file_write: true, file_delete: false, file_retry: true, mcp: false, questions: true, todo: false },
  },
  careful: {
    autoApprove: false, autoApproveRead: true, autoApproveList: true, allowExec: false,
    permissions: { file_read: true, file_write: true, file_delete: false, file_retry: true, mcp: false, questions: true, todo: false },
  },
  readonly: {
    autoApprove: false, autoApproveRead: true, autoApproveList: true, allowExec: false,
    permissions: { file_read: true, file_write: false, file_delete: false, file_retry: false, mcp: false, questions: true, todo: false },
  },
};
// B3 tool → A 通道字段 映射（tool 级别变动 → 同步对应 beilu-files 权限开关）
const _B3_TOOL_TO_A_KEY = {
  write_file: { top: false, key: "file_write" },
  replace_lines: { top: false, key: "file_write" },
  insert_at_line: { top: false, key: "file_write" },
  fuzzy_edit: { top: false, key: "file_write" },
  run_command: { top: true, key: "allowExec" },
  todo_write: { top: false, key: "todo" },
};

async function _syncTemplateToA(templateId) {
  const preset = _B3_TPL_TO_A_PRESET[templateId];
  if (!preset) return; // custom 或未知档不同步
  try {
    // T6b：apiFetch → sendAction；beilu-files 字段写用 updateFilesConfig verb（不注入 _action，走后端 field-update 分支）
    await sendAction({ verb: "updateFilesConfig", target: "plugins:beilu-files", source: "web", payload: preset });
  } catch (e) { showToast("warning", "权限模板 A 通道同步失败（B 通道已生效）: " + (e?.message || e)); /* T021 弹出：权限是安全面，双通道不同步用户必须可见；仍不阻塞主操作 */ }
}

async function _syncRuleToA(tool, action) {
  const mapping = _B3_TOOL_TO_A_KEY[tool];
  if (!mapping) return;
  // B3 三态 → A 布尔：allow = true, ask/deny = false
  const enabled = action === "allow";
  const body = mapping.top ? { [mapping.key]: enabled } : { permissions: { [mapping.key]: enabled } };
  try {
    // T6b：apiFetch → sendAction；同 _syncTemplateToA，字段写走 updateFilesConfig
    await sendAction({ verb: "updateFilesConfig", target: "plugins:beilu-files", source: "web", payload: body });
  } catch (e) { showToast("warning", "权限规则 A 通道同步失败（B 通道已生效）: " + (e?.message || e)); /* T021 弹出：同上，安全面双通道不同步必须可见 */ }
}

// 0715 硬编码收口（F1）：可选工具列表改消费 toolSets 单源（权威=后端 PERMISSION_WRITE_TOOLS，
// getApprovalRules 下发覆盖）；原字面量副本后端增删工具时不会跟进。取用时读 live 值（函数化）。
const _toolOptions = () => [...toolSets.permissionWriteTools, "run_command"];
const ACTION_LABEL = { allow: "放行", ask: "询问", deny: "拒绝" };
const ACTION_ICON = { allow: "🟢", ask: "🟡", deny: "🔴" };
// 档位徽章 fallback（后端 templates[] 缺省时用）。0715 F5：desc 与后端 setDataActions.mjs
// _PERMISSION_TEMPLATES_META 逐字对齐（曾漂移：full 缺".env"、readonly 缺"（全询问）"）。
const FALLBACK_TEMPLATES = [
  { id: "full", name: "自由", color: "green", desc: "所有工具放行，敏感文件(.env)/删除仍询问" },
  { id: "collab", name: "协作", color: "blue", desc: "写/删前询问，读放行（默认档）" },
  { id: "careful", name: "谨慎", color: "yellow", desc: "几乎全询问，仅纯读放行" },
  { id: "readonly", name: "只读", color: "red", desc: "禁所有写/删/执行（全询问）" },
];
const BADGE_COLOR = {
  darkred: "border-red-800 text-red-900 bg-red-900/20",
  green: "border-green-600 text-green-700",
  blue: "border-blue-600 text-blue-700",
  yellow: "border-yellow-600 text-yellow-700",
  red: "border-red-600 text-red-700",
  gray: "border-base-content/40 text-base-content/60",
};

const _esc = escapeHtml; // T7b：alias 保调用点名不变，实现走壳权威版（原自实现与之逐字等价）

async function _post(payload) {
  // T6b：apiFetch → sendAction；payload 里 _action 字段抽取为 verb，rest 平铺进 payload（走 beilu-memory 通配 setdata 路由）
  const { _action, ...rest } = payload || {};
  let body;
  try {
    body = await sendAction({
      verb: _action, target: "plugins:beilu-memory", source: "web",
      payload: rest,
    });
  } catch (err) {
    // 门面 HTTP !ok 已抛错——rethrow 保 needConfirm/success 判断在此处走不到（需 body），
    // 保留原 throw 语义：调用方 catch 里显示 err.message
    throw err;
  }
  // needConfirm（敏感二次确认）不抛——交调用方处理。
  if (body && body.needConfirm) return body;
  if (body?.success === false) {
    throw new Error(body?.error || "未知错误");
  }
  return body;
}

let _containerId = "ide-permission-rules-panel";
let _state = { rules: [], activeTemplate: "collab", templates: FALLBACK_TEMPLATES, allowOutsideWorkspace: true };

/**
 * 初始化权限规则面板（三层渐进披露）。
 * @param {string} [containerId] 挂载容器 DOM id（默认 ide-permission-rules-panel）
 */
export async function initPermissionPanel(containerId) {
  if (containerId) _containerId = containerId;
  const container = document.getElementById(_containerId);
  if (!container) return; // 容器不在（非 IDE 模式）→ 静默跳过
  await loadRules(); // 先拉数据再渲染（徽章高亮需 activeTemplate）
  render();
}

// ── 数据加载 ──
async function loadRules() {
  try {
    const body = await _post({ _action: "getApprovalRules" });
    _state.rules = Array.isArray(body?.rules) ? body.rules : [];
    _state.activeTemplate = body?.activeTemplate || (_state.rules.some((r) => r.source === "user") ? "custom" : "collab");
    _state.templates = Array.isArray(body?.templates) && body.templates.length ? body.templates : FALLBACK_TEMPLATES;
    _state.allowOutsideWorkspace = body?.allowOutsideWorkspace !== false;
    syncToolSets(body?.toolSets); // 0715 F1/F6/D1 收口：后端工具集下发覆盖前端静态兜底

  } catch (err) {
    showToast("error", "加载权限失败: " + err.message);
  }
}

// ── 渲染骨架：第 1 层在 control 原位；第 2/3 层在悬浮窗（开着时同步重画） ──
function render() {
  const container = document.getElementById(_containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="bg-base-300/50 rounded-lg p-2 space-y-1.5">
      <div class="flex items-center justify-between mb-1">
        <p class="text-xs font-medium" style="color:var(--beilu-amber)"><i data-ic="shield"></i> AI 操作权限</p>
        <div class="flex items-center gap-1">
          <button id="perm-open-rules" class="btn btn-xs btn-ghost" style="color:var(--beilu-amber)" title="弹出详细规则窗口（工具×路径×三态逐条微调）">详细规则 <i data-ic="settings"></i></button>
          <button id="perm-rules-refresh" class="btn btn-xs btn-ghost text-base-content/40" title="刷新"><i data-ic="refresh"></i></button>
        </div>
      </div>

      <!-- 第 1 层：档位徽章 -->
      <div id="perm-badges" class="flex flex-wrap gap-1"></div>
      <p id="perm-active-desc" class="text-[9px] text-base-content/60 leading-snug"></p>

      <!-- 区外访问开关（KILO 式） -->
      <label class="flex items-center gap-1 text-[9px] text-base-content/70 mt-1 cursor-pointer">
        <input type="checkbox" id="perm-allow-outside" class="checkbox checkbox-xs" ${_state.allowOutsideWorkspace ? "checked" : ""} />
        允许 AI 访问工作区外（默认开放；关闭后区外操作改为询问）
      </label>

      <!-- 路径黑白名单（beilu-files isPathAllowed 真强制；共享单源 filesPathConfig.mjs） -->
      <details class="mt-1">
        <summary class="text-[10px] cursor-pointer text-base-content/70"><i data-ic="folder"></i> 路径配置（允许/屏蔽）</summary>
        <div id="perm-path-config" class="mt-1"></div>
      </details>
    </div>
  `;

  renderBadges();
  renderFilesPathConfig(container.querySelector("#perm-path-config"));

  container.querySelector("#perm-open-rules")?.addEventListener("click", () => openRulesWindow());
  container.querySelector("#perm-rules-refresh")?.addEventListener("click", async () => { await loadRules(); render(); });
  container.querySelector("#perm-allow-outside")?.addEventListener("change", (e) => toggleOutside(e.target.checked));

  // 悬浮窗开着 → 规则数据可能已变，只刷规则列表（不重建整个窗体，保住用户正填的新增表单）
  const win = document.getElementById("perm-rules-window");
  if (win && !win.classList.contains("hidden")) renderRulesList();
}

// ── 第 2/3 层悬浮窗（拍板#3：详细权限配置=code 原档位选择处的悬浮窗） ──

function _ensureRulesWindow() {
  let win = document.getElementById("perm-rules-window");
  if (win) return win;
  win = document.createElement("div");
  win.id = "perm-rules-window";
  win.className = "floating-window hidden";
  win.style.width = "460px";
  win.style.height = "440px";
  // 0715 凛倾：界面需要可以放大——右下角拖拽缩放（CSS resize，floating-window 已 overflow:hidden 满足条件）
  //   + 标题栏最大化按钮（复用既有 .fw-maximized 样式）。min/max 由 .floating-window 类约束。
  win.style.resize = "both";
  win.innerHTML = `
    <div class="floating-window-header" id="perm-rules-header">
      <div class="fw-title text-sm"><i data-ic="shield"></i> AI 操作权限 · 详细规则</div>
      <div class="flex items-center gap-0.5">
        <button class="fw-ctrl-btn btn btn-xs btn-ghost" id="perm-rules-max" title="最大化/还原">🗖</button>
        <button class="fw-ctrl-btn btn btn-xs btn-ghost" id="perm-rules-close" title="关闭">✕</button>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-2 space-y-1" id="perm-rules-window-body"></div>
  `;
  document.body.appendChild(win);
  win.querySelector("#perm-rules-close").addEventListener("click", () => win.classList.add("hidden"));
  win.querySelector("#perm-rules-max").addEventListener("click", () => win.classList.toggle("fw-maximized"));
  // T3修2: ESC 走中央仲裁注册表（浮窗 priority 20），不再自注册 document keydown（避免与仲裁器共存场景冲突）
  {
    const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
    if (!reg.some((r) => r && r._id === "perm-rules-window")) {
      reg.push({
        _id: "perm-rules-window",
        priority: 20,
        isOpen: () => win && !win.classList.contains("hidden"),
        close: () => win.classList.add("hidden"),
      });
    }
  }
  // 拖拽简版（T013 校准：原注"injectionEditor 同款"——该文件已被 T006 死码批整文件删除，此处是幸存的独立实现）
  const hdr = win.querySelector("#perm-rules-header");
  let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
  hdr.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    if (win.classList.contains("fw-maximized")) return; // 最大化态不可拖
    const r = win.getBoundingClientRect();
    win.style.transform = "none";
    win.style.left = r.left + "px";
    win.style.top = r.top + "px";
    dragging = true; sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
    win.classList.add("fw-dragging");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // clamp：标题栏始终留在视口内，防止拖出屏幕找不回来
    const l = Math.min(Math.max(sl + e.clientX - sx, 60 - win.offsetWidth), window.innerWidth - 60);
    const t = Math.min(Math.max(st + e.clientY - sy, 0), window.innerHeight - 40);
    win.style.left = l + "px";
    win.style.top = t + "px";
  });
  document.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; win.classList.remove("fw-dragging"); }
  });
  // FT-D8(凛倾批「做」): 触屏拖拽（同 clamp）
  hdr.addEventListener("touchstart", (e) => {
    if (e.target.closest("button")) return;
    if (win.classList.contains("fw-maximized")) return; // 最大化态不可拖
    const t0 = e.touches[0];
    const r = win.getBoundingClientRect();
    win.style.transform = "none";
    win.style.left = r.left + "px";
    win.style.top = r.top + "px";
    dragging = true; sx = t0.clientX; sy = t0.clientY; sl = r.left; st = r.top;
    win.classList.add("fw-dragging");
    e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const t0 = e.touches[0];
    const l = Math.min(Math.max(sl + t0.clientX - sx, 60 - win.offsetWidth), window.innerWidth - 60);
    const t = Math.min(Math.max(st + t0.clientY - sy, 0), window.innerHeight - 40);
    win.style.left = l + "px";
    win.style.top = t + "px";
    e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchend", () => {
    if (dragging) { dragging = false; win.classList.remove("fw-dragging"); }
  });
  return win;
}

function openRulesWindow() {
  const win = _ensureRulesWindow();
  _renderWindowBody();
  win.classList.remove("hidden");
  // 上次被拖到视口外 → 拉回可见范围
  const r = win.getBoundingClientRect();
  if (r.left > window.innerWidth - 60 || r.right < 60 || r.top < 0 || r.top > window.innerHeight - 40) {
    win.style.left = "50%";
    win.style.top = "50%";
    win.style.transform = "translate(-50%, -50%)";
  }
}

function _renderWindowBody() {
  const body = document.getElementById("perm-rules-window-body");
  if (!body) return;
  body.innerHTML = `
    <div class="flex items-center justify-between">
      <p class="text-[10px] text-base-content/50">规则：工具×路径×三态。<i data-ic="lock"></i>=敏感默认(改放行需确认) <i data-ic="edit"></i>=自定义</p>
      <button id="perm-new-toggle" class="btn btn-xs btn-ghost text-[10px]" style="color:var(--beilu-amber)">+ 新增</button>
    </div>
    <div id="perm-rules-list" class="space-y-1 text-[10px]"></div>
    <div id="perm-new-form" class="hidden flex-col gap-1 p-1 bg-base-200/50 rounded">
      <select id="perm-new-tool" class="select select-xs select-bordered text-[10px]">
        ${_toolOptions().map((t) => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <input id="perm-new-path" class="input input-xs input-bordered text-[10px]" placeholder="路径前缀(如 src/) 或 glob(如 *.env)" title="路径前缀(如 src/) 或 glob(如 *.env)" />
      <label class="flex items-center gap-1 text-[9px]">
        <input type="checkbox" id="perm-new-isglob" class="checkbox checkbox-xs" /> 按 glob 匹配(含 * ?)
      </label>
      <select id="perm-new-action" class="select select-xs select-bordered text-[10px]">
        <option value="allow">🟢 放行 allow</option>
        <option value="ask" selected>🟡 询问 ask</option>
        <option value="deny">🔴 拒绝 deny</option>
      </select>
      <button id="perm-new-add" class="btn btn-xs btn-warning">添加规则</button>
    </div>
    <div class="divider my-1 text-[9px] text-base-content/40">命令执行能力（全局，owner）</div>
    <div id="perm-gate-section" class="space-y-1 text-[10px]">
      <p class="text-[9px] text-base-content/50 leading-snug">脚本解释器默认关闭：AI 的 run_script / node / python 命令即使「完全信任」也会要求审批。在此开启对应能力后才免审批（仅建议在自己受信电脑上开）。</p>
      <div id="perm-gate-caps" class="flex flex-wrap gap-2"></div>
      <label class="flex items-center gap-1 text-[9px] cursor-pointer" title="关闭后：不在任何名单里的未知命令直接询问（fail-closed，默认开）">
        <input type="checkbox" id="perm-gate-failclosed" class="checkbox checkbox-xs" /> 未知命令需审批（fail-closed，建议开）
      </label>
      <label class="flex items-center gap-1 text-[9px] cursor-pointer" title="开启后：前端直连/分身通道的命令类工具不再强制审批（默认关）">
        <input type="checkbox" id="perm-gate-channelb" class="checkbox checkbox-xs" /> 允许前端/分身通道直接执行命令
      </label>
    </div>
  `;
  renderRulesList();
  _renderGateSection();
  body.querySelector("#perm-new-toggle")?.addEventListener("click", () => {
    const f = document.getElementById("perm-new-form");
    if (f) f.classList.toggle("hidden");
  });
  body.querySelector("#perm-new-add")?.addEventListener("click", () => addRule());
}

// ── 命令执行能力 + 闸行为开关（0714，单源接线不建新存储）──
// 能力授权（node/python/pip…）单源 = per-user command_config.json：消费方=replyHandler:1555
// checkCommandSecurity(cmd, userConfig)（AI 通道免 forced ask 的唯一放宽面），既有读写动作
// get/setCommandConfig（workPanel:511/534 同链）。本面板只是同一真值源的第二个入口，零新键。
// failClosedUnknown/allowChannelBExec = commandGate 段真全局行为开关，走 server:security 端点。
const _GATE_CAPS = [
  { key: "node", label: "node/deno/bun", hint: "JS/TS 脚本解释器" },
  { key: "python", label: "python", hint: "Python 解释器" },
  { key: "pip", label: "pip", hint: "pip 安装（可执行任意 setup.py）" },
];

async function _renderGateSection() {
  const capsEl = document.getElementById("perm-gate-caps");
  const fcEl = document.getElementById("perm-gate-failclosed");
  const cbEl = document.getElementById("perm-gate-channelb");
  if (!capsEl || !fcEl || !cbEl) return;
  let caps = {};
  let gate = {};
  let _soMbFromCfg = 10; // [0726] 会话输出上限（后端单源下发，此值仅 catch 前未赋值时的等值退化）
  try {
    const [capRes, gateRes] = await Promise.all([
      _post({ _action: "getCommandConfig" }),
      sendAction({ verb: "getCommandGate", target: "server:security", source: "web" }),
    ]);
    caps = capRes?.categories || {};
    gate = gateRes || {};
    _soMbFromCfg = Number(capRes?.session_output_limit_mb) || 10;
  } catch (e) {
    capsEl.innerHTML = `<span class="text-[9px] text-error">命令闸配置加载失败: ${_esc(e?.message || String(e))}</span>`;
    return;
  }
  capsEl.innerHTML = _GATE_CAPS.map((c) => `
    <label class="flex items-center gap-1 text-[9px] cursor-pointer" title="${_esc(c.hint)}">
      <input type="checkbox" class="checkbox checkbox-xs perm-gate-cap" data-cap="${_esc(c.key)}" ${caps[c.key] === true ? "checked" : ""} />
      ${_esc(c.label)}
    </label>`).join("");
  // [0726 会话输出上限可调·凛倾] 持久会话(session)单条命令输出上限：单源=后端 getCommandConfig
  // 下发（command_config.json session_output_limit_mb，后端缺省 10、钳 1-100），UI 只消费/回写。
  {
    const _soMb = _soMbFromCfg;
    capsEl.insertAdjacentHTML("beforeend", `
    <label class="flex items-center gap-1 text-[9px]" title="持久会话(session)单条命令的输出上限：超限即销毁该线会话（防内存/上下文爆量的熔断器）。范围 1-100 MB。">
      会话输出上限
      <input type="number" min="1" max="100" step="1" id="perm-gate-sessout" class="input input-xs w-14" value="${_soMb}" /> MB
    </label>`);
    const soEl = document.getElementById("perm-gate-sessout");
    soEl?.addEventListener("change", async () => {
      const v = Math.min(Math.max(parseInt(soEl.value, 10) || 10, 1), 100);
      soEl.value = String(v);
      try {
        await _post({ _action: "setCommandConfig", session_output_limit_mb: v });
        showToast("info", `持久会话输出上限已设为 ${v} MB`);
      } catch (e) {
        showToast("error", "输出上限设置失败: " + (e?.message || e));
      }
    });
  }
  fcEl.checked = gate?.failClosedUnknown !== false;
  cbEl.checked = gate?.allowChannelBExec === true;
  capsEl.querySelectorAll(".perm-gate-cap").forEach((el) => {
    el.addEventListener("change", () => _saveCapability(el.dataset.cap, el.checked, el));
  });
  fcEl.addEventListener("change", () => _saveGate({ failClosedUnknown: fcEl.checked }, fcEl));
  cbEl.addEventListener("change", () => _saveGate({ allowChannelBExec: cbEl.checked }, cbEl));

  _renderCommandRulesSection();
}

// 0715 硬编码改选项：命令安全规则从只读展示升级为可编辑（后端单源，UI 只消费/回写）。
// 数据形状（getCommandRules）：blacklist/graylist=[{pattern可读串, regex原串, flags}]，
// gitPushAllowedRemotes=[string]（"*"=不限制），customized={各清单是否已覆盖默认}。
// 写回（setCommandRules）：整清单覆盖（条目 {pattern:regex原串, flags}）；null=恢复代码默认。
let _cmdRules = null;

async function _renderCommandRulesSection() {
  const body = document.getElementById("perm-rules-window-body");
  if (!body) return;
  let anchor = document.getElementById("perm-cmd-rules-section");
  if (!anchor) {
    anchor = document.createElement("div");
    anchor.id = "perm-cmd-rules-section";
    body.appendChild(anchor);
  }
  anchor.innerHTML = `<div class="divider my-1 text-[9px] text-base-content/40">命令安全规则（后端单源 · 可编辑）</div>
    <div id="perm-cmd-rules-body" class="text-[10px]"><p class="text-base-content/40 text-center">加载中...</p></div>`;
  try {
    const data = await sendAction({ verb: "getCommandRules", target: "server:security", source: "web" });
    _setCmdRules(data);
    _renderCmdRulesBody();
  } catch (e) {
    const el = document.getElementById("perm-cmd-rules-body");
    if (el) el.innerHTML = `<p class="text-[9px] text-error">加载失败: ${_esc(e?.message || String(e))}</p>`;
  }
}

function _setCmdRules(data) {
  _cmdRules = {
    rulesEnabled: data?.rulesEnabled !== false, // 0715 总开关（黑/灰名单整体启停）
    blacklist: Array.isArray(data?.blacklist) ? data.blacklist : [],
    graylist: Array.isArray(data?.graylist) ? data.graylist : [],
    gitPushAllowedRemotes: Array.isArray(data?.gitPushAllowedRemotes) ? data.gitPushAllowedRemotes : [],
    customized: data?.customized || {},
  };
}

// 0715 开关化：条目 UI 态 → 写回形状（enabled 缺省 true 不落盘；forced 仅灰名单条目携带）
function _entryOut(r) {
  return {
    pattern: r.regex, flags: r.flags || "i",
    ...(r.enabled === false ? { enabled: false } : {}),
    ...(typeof r.forced === "boolean" ? { forced: r.forced } : {}),
  };
}

function _renderCmdRulesBody() {
  const el = document.getElementById("perm-cmd-rules-body");
  if (!el || !_cmdRules) return;
  // 重渲染保留折叠态：连续编辑时保存触发重画，details 不回弹关闭
  const _openKinds = new Set([...el.querySelectorAll("details[data-kind]")].filter((d) => d.open).map((d) => d.dataset.kind));
  // 0715 开关化：每条规则前置启用开关（关=不参与匹配但保留）；灰名单条目另带「L4也问」开关
  //（勾=即使 L4 完全信任也确认；不勾=最多限到 L3，L4 免审批——凛倾拍板"v4不用限制,最多v3"）。
  const _masterOff = !_cmdRules.rulesEnabled;
  const mkSection = (kind, list, boxCls, titleCls, icon, title, subtitle) => `
    <details class="collapse collapse-arrow ${boxCls} rounded mb-1 ${_masterOff ? "opacity-50" : ""}" data-kind="${kind}" ${_openKinds.has(kind) ? "open" : ""}>
      <summary class="collapse-title min-h-0 py-1 px-2 text-[10px] font-medium ${titleCls}">
        ${icon} ${title}（${list.length} 条）— ${subtitle}${_cmdRules.customized[kind] ? ' <span class="opacity-50">·已自定义</span>' : ""}</summary>
      <div class="collapse-content px-2 py-0"><div class="space-y-0.5 pb-1">
        ${list.map((r, i) => `
          <div class="flex items-center gap-1 text-[9px] ${r.enabled === false ? "opacity-40" : ""}">
            <input type="checkbox" class="checkbox checkbox-xs cmd-rule-toggle" data-kind="${kind}" data-idx="${i}"
                   title="启用/停用此条（停用=不参与匹配，保留在清单）" ${r.enabled === false ? "" : "checked"} />
            <code class="flex-1 break-all ${r.enabled === false ? "line-through" : ""}" title="可读形式: ${_esc(r.pattern)}">${_esc(r.regex)}</code>
            ${kind === "graylist" ? `
            <label class="flex items-center gap-0.5 shrink-0 cursor-pointer" title="勾=即使 L4 完全信任也要确认；不勾=最多限到 L3（L4 免审批）">
              <input type="checkbox" class="checkbox checkbox-xs cmd-rule-forced" data-idx="${i}" ${r.forced === false ? "" : "checked"} /> L4也问
            </label>` : ""}
            <button class="btn btn-xs btn-ghost text-error cmd-rule-del" data-kind="${kind}" data-idx="${i}" title="删除此条">✕</button>
          </div>`).join("")}
        <div class="flex items-center gap-1 pt-1">
          <input class="input input-xs input-bordered flex-1 text-[9px] font-mono" data-add-input="${kind}"
                 placeholder="新增正则（JS RegExp 源串，按 i 匹配）" />
          <button class="btn btn-xs btn-ghost cmd-rule-add" data-kind="${kind}" style="color:var(--beilu-amber)">+ 添加</button>
        </div>
        ${_cmdRules.customized[kind] ? `<button class="btn btn-xs btn-ghost text-[9px] cmd-rule-reset" data-kind="${kind}">↺ 恢复默认清单</button>` : ""}
      </div></div>
    </details>`;
  el.innerHTML = `
    <label class="flex items-center gap-1 text-[10px] font-medium cursor-pointer mb-1" title="关闭后黑/灰名单全部停用（git push 远程白名单、解释器授权、未知命令 fail-closed 不受影响，各有独立开关）">
      <input type="checkbox" id="cmd-rules-master" class="checkbox checkbox-xs" ${_cmdRules.rulesEnabled ? "checked" : ""} />
      启用命令安全规则（总开关）${_masterOff ? '<span class="text-error">·已停用</span>' : ""}
    </label>
    ${mkSection("blacklist", _cmdRules.blacklist, "bg-error/5", "text-error", "🔴", "永久阻止", "严重破坏类，任何档位都不放行")}
    ${mkSection("graylist", _cmdRules.graylist, "bg-warning/5", "text-warning", "🟡", "需要审批", "勾「L4也问」=完全信任也确认；不勾=最多限到 L3")}
    <div class="flex items-center flex-wrap gap-1 pt-1">
      <span class="text-[9px] text-base-content/40">git push 允许的远程（<code>*</code>=不限制）：</span>
      ${_cmdRules.gitPushAllowedRemotes.map((r, i) => `
        <span class="badge badge-sm gap-1 font-mono text-[9px]">${_esc(r)}
          <button class="cmd-remote-del text-error" data-idx="${i}" title="删除">✕</button></span>`).join("")}
      <input id="cmd-add-remote" class="input input-xs input-bordered text-[9px] font-mono" style="width:80px" placeholder="远程名/*" />
      <button class="btn btn-xs btn-ghost cmd-remote-add" style="color:var(--beilu-amber)">+ 添加</button>
      ${_cmdRules.customized.gitPushAllowedRemotes ? `<button class="btn btn-xs btn-ghost text-[9px] cmd-remote-reset">↺ 恢复默认</button>` : ""}
    </div>`;

  // 总开关：关=放宽（黑/灰名单全停）需确认；开=收紧直接保存
  el.querySelector("#cmd-rules-master")?.addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (!on && !(await _confirmRelax())) { e.target.checked = true; return; }
    _saveCmdRules({ rulesEnabled: on });
  });
  // 单条启停：停用=放宽需确认；启用=收紧直接保存。整清单写回（触发 customized）。
  el.querySelectorAll(".cmd-rule-toggle").forEach((tg) => tg.addEventListener("change", async () => {
    const kind = tg.dataset.kind, idx = Number(tg.dataset.idx);
    const on = tg.checked;
    if (!on && !(await _confirmRelax())) { tg.checked = true; return; }
    const next = _cmdRules[kind].map((r, i) => _entryOut(i === idx ? { ...r, enabled: on } : r));
    _saveCmdRules({ [kind]: next });
  }));
  // 灰名单「L4也问」：取消勾选=放宽（L4 免审）需确认；勾选=收紧直接保存
  el.querySelectorAll(".cmd-rule-forced").forEach((tg) => tg.addEventListener("change", async () => {
    const idx = Number(tg.dataset.idx);
    const on = tg.checked;
    if (!on && !(await _confirmRelax())) { tg.checked = true; return; }
    const next = _cmdRules.graylist.map((r, i) => _entryOut(i === idx ? { ...r, forced: on } : r));
    _saveCmdRules({ graylist: next });
  }));
  el.querySelectorAll(".cmd-rule-del").forEach((btn) => btn.addEventListener("click", async () => {
    const kind = btn.dataset.kind, idx = Number(btn.dataset.idx);
    if (!(await _confirmRelax())) return; // 删安全规则=放宽防线
    const next = _cmdRules[kind].filter((_, i) => i !== idx);
    _saveCmdRules({ [kind]: next.map(_entryOut) });
  }));
  el.querySelectorAll(".cmd-rule-add").forEach((btn) => btn.addEventListener("click", () => {
    const kind = btn.dataset.kind;
    const input = el.querySelector(`[data-add-input="${kind}"]`);
    const val = (input?.value || "").trim();
    if (!val) { showToast("error", "请输入正则"); return; }
    try { new RegExp(val, "i"); } catch (e) { showToast("error", "非法正则: " + (e?.message || e)); return; }
    const next = _cmdRules[kind].map(_entryOut);
    // 新增灰名单条目默认 forced=true（最严），可再用「L4也问」开关放宽
    next.push({ pattern: val, flags: "i", ...(kind === "graylist" ? { forced: true } : {}) });
    _saveCmdRules({ [kind]: next }); // 加规则=收紧，无需确认
  }));
  el.querySelectorAll(".cmd-rule-reset").forEach((btn) => btn.addEventListener("click", async () => {
    if (!(await beiluConfirm("恢复此清单为代码默认值（丢弃你的自定义条目）？"))) return;
    _saveCmdRules({ [btn.dataset.kind]: null });
  }));
  el.querySelectorAll(".cmd-remote-del").forEach((btn) => btn.addEventListener("click", () => {
    const idx = Number(btn.dataset.idx);
    const next = _cmdRules.gitPushAllowedRemotes.filter((_, i) => i !== idx);
    _saveCmdRules({ gitPushAllowedRemotes: next }); // 删远程=收紧，无需确认
  }));
  el.querySelector(".cmd-remote-add")?.addEventListener("click", async () => {
    const input = el.querySelector("#cmd-add-remote");
    const val = (input?.value || "").trim();
    if (!val) { showToast("error", "请输入远程名"); return; }
    if (_cmdRules.gitPushAllowedRemotes.includes(val)) { showToast("info", "该远程已在白名单"); return; }
    if (!(await _confirmRelax())) return; // 加远程=放宽 push 面
    _saveCmdRules({ gitPushAllowedRemotes: [..._cmdRules.gitPushAllowedRemotes, val] });
  });
  el.querySelector(".cmd-remote-reset")?.addEventListener("click", async () => {
    if (!(await beiluConfirm("恢复 git push 远程白名单为代码默认值？"))) return;
    _saveCmdRules({ gitPushAllowedRemotes: null });
  });
}

async function _saveCmdRules(patch) {
  try {
    const data = await sendAction({ verb: "setCommandRules", target: "server:security", source: "web", payload: patch });
    _setCmdRules(data); // 用后端回读的 live 真值重渲染（读写同源，不回显本地猜测）
    _renderCmdRulesBody();
    showToast("info", "命令安全规则已更新");
  } catch (e) {
    showToast("error", "规则保存失败: " + (e?.message || e));
  }
}

// 放宽确认共用（开解释器/开通道B/关fail-closed 均是降防线动作）
async function _confirmRelax() {
  return beiluConfirm("⚠ 此设置将放宽命令执行防线（AI 可不经审批执行对应类别的命令/脚本）。\n\n仅建议在自己受信的本机开启。确认放宽？");
}

async function _saveCapability(cat, enabled, el) {
  if (enabled && !(await _confirmRelax())) { if (el) el.checked = false; return; }
  try {
    // 既有 setCommandConfig 动作（per-user command_config.json 单源，workPanel 同链）
    await _post({ _action: "setCommandConfig", categories: { [cat]: enabled } });
    showToast("info", `命令能力 ${cat} 已${enabled ? "开启" : "关闭"}`);
  } catch (e) {
    showToast("error", "能力设置失败: " + (e?.message || e));
    if (el) el.checked = !enabled;
  }
}

async function _saveGate(patch, el) {
  const relaxing = patch.allowChannelBExec === true || patch.failClosedUnknown === false;
  if (relaxing && !(await _confirmRelax())) { if (el) el.checked = !el.checked; return; }
  try {
    await sendAction({ verb: "setCommandGate", target: "server:security", source: "web", payload: patch });
    showToast("info", "命令执行闸配置已更新");
  } catch (e) {
    showToast("error", "命令闸设置失败: " + (e?.message || e));
    if (el) el.checked = !el.checked;
  }
}

// ── 第 1 层：档位徽章 ──
function renderBadges() {
  const el = document.getElementById("perm-badges");
  const descEl = document.getElementById("perm-active-desc");
  if (!el) return;
  const tpls = _state.templates.slice();
  // custom 档位（用户逐条改后生成）作为额外灰徽章。
  const all = tpls.concat([{ id: "custom", name: "自定义", color: "gray", desc: "你逐条微调后的规则集" }]);
  el.innerHTML = all.map((t) => {
    const active = t.id === _state.activeTemplate;
    const color = BADGE_COLOR[t.color] || BADGE_COLOR.gray;
    return `<button class="btn btn-xs border ${color} ${active ? "ring-1 ring-offset-0" : "btn-ghost"}"
      data-tpl="${_esc(t.id)}" style="font-size:10px">${active ? "● " : ""}${_esc(t.name)}</button>`;
  }).join("");
  const cur = all.find((t) => t.id === _state.activeTemplate);
  if (descEl) descEl.textContent = cur ? `当前：${cur.name} — ${cur.desc}` : "";
  el.querySelectorAll("[data-tpl]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tpl;
      if (id === "custom") {
        // custom 不是可导入模板——打开详细规则悬浮窗让用户微调。
        openRulesWindow();
        return;
      }
      switchTemplate(id);
    });
  });
}

async function switchTemplate(templateId) {
  if (templateId === "unrestricted") {
    const ok = await _confirmUnrestricted();
    if (!ok) return;
  }
  try {
    const body = await _post({ _action: "importPermissionTemplate", templateId });
    showToast("info", `已切换到 ${_tplName(templateId)} 档`);
    _state.activeTemplate = body?.activeTemplate || templateId;
    _syncTemplateToA(templateId); // T5反向桥：IDE档位 → beilu-files权限预设
    await loadRules();
    render();
  } catch (err) {
    showToast("error", "切档失败: " + err.message);
  }
}

function _confirmUnrestricted() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    // [0727] z-index 原硬编码 99999 违反中央层级表 → --z-critical(安全确认必须盖住一切,index.css 表内新档);
    // --bg-2/--text-normal 为全库未定义的死变量(永走深色 fallback,亮主题下突兀)→ 主题语义变量
    overlay.style.cssText = "position:fixed;inset:0;z-index:var(--z-critical);background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
    overlay.innerHTML = `<div style="background:var(--color-base-200, #1e1e2e);border:2px solid #d00;border-radius:12px;padding:24px;max-width:400px;color:var(--color-base-content, #ccc);font-size:14px;">
      <h3 style="margin:0 0 12px;color:#f44;font-size:16px;">⚠️ 全部放行模式（L5）</h3>
      <p style="margin:0 0 8px;">此模式下 <b>所有操作将自动执行</b>，包括：</p>
      <ul style="margin:0 0 12px;padding-left:20px;line-height:1.8;">
        <li>危险命令（rm、format、force push 等）</li>
        <li>敏感文件操作（.env 等）</li>
        <li>工作区外文件访问</li>
        <li>未知/未授权命令</li>
      </ul>
      <p style="margin:0 0 16px;color:#f59e0b;font-weight:600;">AI 的任何操作都不会被拦截或询问。请确保你了解风险。</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="_l5cancel" style="padding:6px 16px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:none;color:var(--text-normal, #ccc);cursor:pointer;">取消</button>
        <button id="_l5confirm" style="padding:6px 16px;border:none;border-radius:6px;background:#d00;color:#fff;cursor:pointer;font-weight:600;">确认启用 L5</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#_l5cancel").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.querySelector("#_l5confirm").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

function _tplName(id) {
  const t = (_state.templates || []).find((x) => x.id === id);
  return t ? t.name : id;
}

// ── 区外访问开关 ──
async function toggleOutside(enabled) {
  try {
    if (!enabled) {
      // 关闭=收紧（区外改询问），无破坏性，直接执行；提示语义。
      await _post({ _action: "setAllowOutsideWorkspace", allowOutsideWorkspace: false });
      showToast("info", "已关闭：AI 访问工作区外将改为询问");
    } else {
      await _post({ _action: "setAllowOutsideWorkspace", allowOutsideWorkspace: true });
      showToast("info", "已开放：AI 可完全访问工作区外");
    }
    _state.allowOutsideWorkspace = enabled;
  } catch (err) {
    showToast("error", "设置失败: " + err.message);
    await loadRules();
    render();
  }
}

// ── 第 2 层：规则列表（来源图标 + 异常高亮 + 三态切换 + 删除） ──
function renderRulesList() {
  const listEl = document.getElementById("perm-rules-list");
  if (!listEl) return;
  const rules = _state.rules;
  if (rules.length === 0) {
    listEl.innerHTML = '<p class="text-base-content/50 text-center py-2">暂无规则（走默认：写操作要审批）</p>';
    return;
  }
  listEl.innerHTML = rules.map((r, i) => {
    const action = (r.action === "deny" || r.action === "ask" || r.action === "allow") ? r.action : "allow";
    const pathDisp = r.glob ? `glob: ${r.glob}` : (r.pathPrefix ? r.pathPrefix : "(全部)");
    // 来源图标：user=edit 可删 / template=档位默认 / 敏感目标=lock。（L430 srcIcon 进 innerHTML）
    const sensitive = _looksSensitive(r);
    const srcIcon = r.source === "user" ? '<i data-ic="edit"></i>' : (sensitive ? '<i data-ic="lock"></i>' : "");
    const srcLabel = r.source === "user" ? "自定义" : (sensitive ? "敏感默认" : "档位默认");
    // 异常高亮：敏感目标被改成 allow（放宽保护）→ 黄底警示。
    const warn = sensitive && action === "allow";
    return `
      <div class="flex items-center gap-1 p-1 rounded ${warn ? "bg-yellow-100/60 border border-yellow-400" : "bg-base-200/40"}" data-rule-idx="${i}"
           data-tool="${_esc(r.tool)}" data-path="${_esc(r.pathPrefix || "")}" data-glob="${_esc(r.glob || "")}">
        <span class="font-mono truncate" style="color:var(--beilu-amber);min-width:60px;max-width:80px" title="${_esc(r.tool)}">${_esc(r.tool)}</span>
        <span class="font-mono text-base-content/60 truncate flex-1" title="${_esc(pathDisp)}">${_esc(pathDisp)}</span>
        <span class="text-[8px] text-base-content/40" title="${srcLabel}">${srcIcon}</span>
        <select class="select select-xs select-bordered text-[9px] perm-action-sel" style="min-width:52px">
          <option value="allow" ${action === "allow" ? "selected" : ""}>${ACTION_ICON.allow}放行</option>
          <option value="ask" ${action === "ask" ? "selected" : ""}>${ACTION_ICON.ask}询问</option>
          <option value="deny" ${action === "deny" ? "selected" : ""}>${ACTION_ICON.deny}拒绝</option>
        </select>
        <button class="btn btn-xs btn-ghost text-error perm-del-btn" title="删除">✕</button>
      </div>`;
  }).join("");

  listEl.querySelectorAll(".perm-action-sel").forEach((sel) => {
    const prev = sel.value;
    sel.addEventListener("change", () => {
      const row = sel.closest("[data-rule-idx]");
      if (row) updateAction(row, sel.value, prev);
    });
  });
  listEl.querySelectorAll(".perm-del-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-rule-idx]");
      if (row) deleteRule(row);
    });
  });
}

// 前端粗判规则是否针对敏感目标（.env / 删除类命令）——与后端 _isSensitiveOverrideRule 同口径。
function _looksSensitive(r) {
  const subj = String(r.glob || r.pathPrefix || "").replace(/\\/g, "/").toLowerCase();
  if (r.tool === "run_command") {
    const first = (subj.trim().split(/\s+/)[0] || "").replace(/[*?].*$/, "");
    return new Set(["rm", "rmdir", "del", "erase", "unlink", "remove-item", "ri"]).has(first);
  }
  if (!subj) return false;
  const base = subj.slice(subj.lastIndexOf("/") + 1).replace(/[*?]/g, "");
  if (base === ".env.example") return false;
  return base === ".env" || base.startsWith(".env.") || base.startsWith(".env");
}

// ── 第 3 层动作：三态切换 / 删除 / 新增（均含敏感二次确认） ──
async function updateAction(row, action, prevValue) {
  const tool = row.dataset.tool;
  const glob = row.dataset.glob;
  const pathPrefix = row.dataset.path;
  const payload = { _action: "setApprovalRule", tool, action };
  if (glob) payload.glob = glob; else payload.pathPrefix = pathPrefix;
  await _saveRuleWithConfirm(payload, () => {
    // 二次确认被取消 → 回滚下拉显示。
    const sel = row.querySelector(".perm-action-sel");
    if (sel && prevValue) sel.value = prevValue;
  });
}

async function deleteRule(row) {
  const tool = row.dataset.tool;
  const pathPrefix = row.dataset.path;
  const glob = row.dataset.glob;
  try {
    await _post({ _action: "removeApprovalRule", tool, pathPrefix, glob });
    showToast("info", "已删除规则");
    await loadRules();
    render();
  } catch (err) {
    showToast("error", "删除失败: " + err.message);
  }
}

async function addRule() {
  const tool = document.getElementById("perm-new-tool")?.value;
  const pathVal = (document.getElementById("perm-new-path")?.value || "").trim();
  const isGlob = document.getElementById("perm-new-isglob")?.checked;
  const action = document.getElementById("perm-new-action")?.value;
  if (!tool) { showToast("error", "请选工具"); return; }
  const payload = { _action: "setApprovalRule", tool, action };
  if (isGlob && pathVal) payload.glob = pathVal;
  else payload.pathPrefix = pathVal;
  await _saveRuleWithConfirm(payload, null, () => {
    const pathInput = document.getElementById("perm-new-path");
    if (pathInput) pathInput.value = "";
  });
}

// 统一保存：处理后端 needConfirm（敏感放宽）→ 弹二次确认 → 带 confirmSensitive 重发。
async function _saveRuleWithConfirm(payload, onCancel, onSuccess) {
  try {
    let body = await _post(payload);
    if (body && body.needConfirm) {
      const ok = await beiluConfirm(
        "⚠ 此规则将放宽敏感文件(.env)/删除类操作的保护，AI 可能未经询问执行敏感操作。\n\n确认放宽？"
      );
      if (!ok) { if (onCancel) onCancel(); return; }
      body = await _post({ ...payload, confirmSensitive: true });
    }
    showToast("info", `已设为「${ACTION_LABEL[payload.action] || payload.action}」`);
    _syncRuleToA(payload.tool, payload.action); // T5反向桥：IDE逐条规则 → beilu-files权限开关
    if (onSuccess) onSuccess();
    await loadRules();
    render();
  } catch (err) {
    showToast("error", "设置失败: " + err.message);
    if (onCancel) onCancel();
    await loadRules();
    render();
  }
}
