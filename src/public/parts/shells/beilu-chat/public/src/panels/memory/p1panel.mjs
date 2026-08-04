/**
 * [p1panel.mjs] — P1 自驱动召回前端 3 面板（2026-07-31 002后期任务"画圈的地方增加前端3个"）
 *
 * 功能链：
 *   mem-activity-bar 按钮(data-mem-panel=p1run/p1vocab/p1p9) → memtool._lazyLoadMemTool 分支
 *     → 本文件 loadP1RunPanel / loadP1VocabPanel / loadP1P9Panel
 *     → sendAction(plugins:beilu-p1-selfdriven 通配) → shells:p1 薄壳代理 → Python 服务
 *       p1_server.py 同名路由（0731 P1 独立服务化：旧 Deno 插件已退役，见 sendAction.mjs:171-180）
 *   参数控件全部由服务 getData.meta 单源下发渲染（0722 禁前端硬编码：min/max/desc 权威在后端）。
 *   快速测试直调服务 runP1（recallOnly 管线，不经宿主对话流、不注入、不触发主 AI）。
 *
 * why：P1 此前只有后端，运行状态/参数/词库全部黑盒。002 指令做运行展示+
 *   参数微调+快速测试+词库管理+P9 维护三模块，收口在记忆 Tab 活动栏（截图红圈位置）。
 *
 * 影响范围：仅新增面板；不改对话流/注入链。服务未启用时快速测试如实显示"未启用"，不静默。
 * 关联链：← memtool.mjs(_lazyLoadMemTool) ← index.html(#mem-activity-bar 三新钮 + 三 .mem-tool-view)
 *   → sendAction.mjs(plugins:beilu-p1-selfdriven 通配+getData 注册段)
 *   → shells/p1/service/p1_server.py（runP1/updateConfig/getStats/listVocabs/atSearch/*UserVocab/
 *     *P9Prompts/getRunLogInfo/getRunLog）
 *   → 用户插拔词库消费方 = Node stdio 每请求读取 → node2 user_vocab token/phrase 热插拔
 *
 * [0731 真机验收二次返工·002骂点] "子模式是什么你照着搬运一下就行啊,预设那边也可以搬运过来" +
 *   "做个复制按钮会死啊" + "抄代码做个放大功能会死啊" + "点击不了,查了不了" + 三次返工终版
 *   "把这两个恶心的垃圾给我删除...仿照code的子模式做前端,也就是完整的编辑前端"：
 *   P9 面板=就地完整编辑区（loadP1P9Panel）：①子模式实体区照 companion.mjs 陪伴单实体范式
 *   （getSubModes/saveSubModes 单源，参数只写 model_params 蛇形键=getPromptHandler 每轮生效载体；
 *   绑定经角色归属校验的所选对话走 activateSubMode，解绑走 expectedId compare-delete）；②提示词区就地编辑绑定预设条目
 *   （getDataForPreset / updatePresetConfig update_entry 等，与预设面板 settings/panels.mjs 同一契约），
 *   零跳转；放大编辑复用全局 expandEditor.mjs（data-expandable/expand-btn 挂法，MutationObserver
 *   自动接管，零额外接线）；复制按钮写剪贴板（clipboard 写法同 companion.mjs:514-517）。
 *   预设本体入默认预设（beilu-preset/defaults/P9词库维护.json + registry bucket:"p9" 独立分类，
 *   惰性播种同步新用户；提示词正文=用户域，默认件留白）。
 *   词库表格行加可点击浏览（atBrowse 只读路由，复用 atSearch 同款 mtime 缓存）。
 *   运行记录卡片（0731 002"每次输出都需要进行文件记录"）：服务 p1_server.py _append_run_log
 *   按天落盘 JSONL（打字联想轻量路不记），前端 getRunLogInfo/getRunLog 展示记录文件位置+点击打开分页浏览。
 */
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { applyParamSchemaToInputs, setParamSchema, setEnumSchema } from "../../shared/state/paramSchemaCache.mjs"; // 限值/枚举后端单源（同 companion/subModePanel 范式）
import { chatBelongsToChar } from "../../shared/state/utils.mjs";
import { KEYS } from "../../shared/state/storage.mjs";
import { initHorizontalSplitPane } from "../../shared/widgets/splitPane.mjs";
import { getPartList } from "../../../../../../scripts/parts.mjs";

const _P1 = "plugins:beilu-p1-selfdriven";
const _P1_CONFIG_CHANGED_EVENT = "beilu:p1-config-changed";

// P1 的 HTTP 壳会用 200 携带业务层 success:false。前端所有 P1 动作必须在
// 同一边界校验该层，不能让某个按钮把“传输成功”误显示成“业务成功”。
async function _p1Action(verb, payload) {
  const result = await sendAction({ verb, target: _P1, source: "web", ...(payload === undefined ? {} : { payload }) });
  if (result?.success === false) {
    const error = new Error(result.error || `P1 ${verb} 执行失败`);
    error.code = result.code || "E_P1_ACTION_FAILED";
    error.result = result;
    throw error;
  }
  return result;
}

const _esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * P1 主结果成功时，runLog 的主写与后续清理可能独立失败。这里只映射公开 issue，
 * 不改写 result.success/outcome/召回数据，也不读取可能含绝对路径的 path 字段。
 */
export function getP1RunLogIssues(result) {
  const runLog = result?.runLog;
  if (runLog?.enabled !== true) return [];
  const issues = [];
  const seen = new Set();
  const addIssue = ({ severity, kind, written, stage, code, message, file }) => {
    const normalizedSeverity = severity === "warning" ? "warning" : severity === "error" ? "error" : "";
    const normalizedCode = String(code ?? "").trim();
    if (!normalizedSeverity || !normalizedCode) return;
    const normalizedMessage = String(message ?? "").trim() || "P1 run log operation failed";
    const normalizedFile = String(file ?? "").trim() || null;
    const key = `${normalizedSeverity}\0${normalizedCode}\0${normalizedMessage}\0${normalizedFile || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      component: "runLog",
      severity: normalizedSeverity,
      kind,
      written,
      stage: stage || null,
      code: normalizedCode,
      message: normalizedMessage,
      file: normalizedFile,
    });
  };
  if (runLog.written === false && String(runLog.code).startsWith("E_")) {
    addIssue({
      severity: "error",
      kind: "write",
      written: false,
      stage: "write",
      code: runLog.code,
      message: String(runLog.error ?? "").trim() || "P1 run log write failed",
      file: runLog.file,
    });
  }
  for (const [severity, bucket] of [
    ["error", runLog?.diagnostics?.errors],
    ["warning", runLog?.diagnostics?.warnings],
  ]) {
    for (const diagnostic of Array.isArray(bucket) ? bucket : []) {
      const stage = String(diagnostic?.stage ?? "diagnostic").trim() || "diagnostic";
      const exception = String(diagnostic?.exception ?? "").trim();
      addIssue({
        severity,
        kind: "diagnostic",
        written: runLog.written === true,
        stage,
        code: diagnostic?.code,
        message: String(diagnostic?.message ?? diagnostic?.error ?? "").trim()
          || `${exception ? `${exception}: ` : ""}P1 run log ${stage} failed`,
        file: diagnostic?.file ?? runLog.file,
      });
    }
  }
  return issues;
}

/**
 * P1 当前窗口作用域读口。
 * lineManager 负责决定 code 多窗口还是本体普通对话；快速测试也允许用户显式选择
 * 角色卡、对话文件和记忆模式，但“一键使用当前窗口”仍以这里的完整绑定包为权威。
 */
function _p1CurrentBinding() {
  if (typeof window._beiluCurWinBinding !== "function") {
    const error = new Error("当前窗口绑定 producer 未就绪");
    error.code = "E_P1_WINDOW_BINDING_MISSING";
    throw error;
  }
  const raw = window._beiluCurWinBinding();
  const binding = {
    chatId: String(raw?.chatId || "").trim(),
    charName: String(raw?.charName || "").trim(),
    mode: String(raw?.mode || "").trim(),
    multiWindow: raw?.multiWindow,
  };
  const missing = [];
  if (!binding.chatId) missing.push("chatId");
  if (!binding.charName) missing.push("charName");
  if (!binding.mode) missing.push("mode");
  if (typeof binding.multiWindow !== "boolean") missing.push("multiWindow");
  if (missing.length) {
    const error = new Error(`当前窗口绑定不完整，缺少: ${missing.join(", ")}`);
    error.code = "E_P1_WINDOW_BINDING_INCOMPLETE";
    error.binding = binding;
    throw error;
  }
  return Object.freeze(binding);
}

function _p1QuickSnapshot(container) {
  const inputRaw = container.querySelector("#p1run-test-input")?.value ?? "";
  let binding = null;
  let bindingError = null;
  const scopeSource = container._p1QuickScopeMode === "manual" ? "manual" : "current";
  if (scopeSource === "manual") {
    const charName = String(container.querySelector("#p1run-test-char")?.value || "").trim();
    const chatId = String(container.querySelector("#p1run-test-chat")?.value || "").trim();
    const mode = String(container.querySelector("#p1run-test-mode")?.value || "").trim();
    const selectedChat = (container._p1QuickChats || []).find((chat) => String(chat?.chatid || chat?.id || "") === chatId);
    const missing = [];
    if (!charName) missing.push("角色卡");
    if (!chatId) missing.push("对话文件");
    if (!mode) missing.push("模式");
    if (chatId && !selectedChat) missing.push("对话文件有效性");
    if (selectedChat && !chatBelongsToChar(selectedChat, charName)) missing.push("对话归属");
    if (missing.length) {
      bindingError = new Error(`手动测试目标不完整：${missing.join("、")}`);
      bindingError.code = "E_P1_MANUAL_SCOPE_INCOMPLETE";
    } else {
      binding = { chatId, charName, mode, multiWindow: false };
    }
  } else {
    try { binding = _p1CurrentBinding(); }
    catch (error) { bindingError = error; }
  }
  return {
    inputRaw,
    input: inputRaw.trim(),
    mode: binding?.mode || "",
    charName: binding?.charName || "",
    chatid: binding?.chatId || "",
    multiWindow: binding?.multiWindow,
    scopeSource,
    bindingError,
  };
}

function _p1RenderBinding(container, snapshot = _p1QuickSnapshot(container)) {
  const box = container.querySelector("#p1run-test-binding");
  if (!box) return;
  const manual = snapshot.scopeSource === "manual";
  if (snapshot.bindingError) {
    box.innerHTML = `<span class="text-error">${manual ? "手动测试目标" : "当前窗口作用域"}不可用：${_esc(snapshot.bindingError?.message || snapshot.bindingError)}</span>`;
    return;
  }
  box.innerHTML = `<span class="opacity-60">${manual ? "手动测试目标" : "当前窗口作用域"}:</span>
    <span class="badge badge-xs badge-ghost">角色 ${_esc(snapshot.charName)}</span>
    <span class="badge badge-xs badge-ghost">对话 ${_esc(snapshot.chatid)}</span>
    <span class="badge badge-xs badge-ghost">模式 ${_esc(snapshot.mode)}</span>
    <span class="badge badge-xs ${manual || snapshot.multiWindow ? "badge-info" : "badge-ghost"}">${manual ? "手动选择" : snapshot.multiWindow ? "code 当前可见窗口" : "本体当前对话"}</span>`;
}

function _p1QuickIsCurrent(container, ticket, snapshot) {
  if (container._p1QuickTestTicket !== ticket) return false;
  const current = _p1QuickSnapshot(container);
  return current.inputRaw === snapshot.inputRaw
    && current.mode === snapshot.mode
    && current.charName === snapshot.charName
    && current.chatid === snapshot.chatid
    && current.multiWindow === snapshot.multiWindow
    && current.scopeSource === snapshot.scopeSource
    && !current.bindingError && !snapshot.bindingError;
}

function _p1QuickChatId(chat) {
  return String(chat?.chatid || chat?.id || "").trim();
}

function _p1QuickChatMode(chat, fallback = "chat") {
  const raw = String(chat?.mode || chat?.activeMode || fallback || "chat").trim().toLowerCase();
  if (raw === "ide" || raw === "files") return "code";
  if (raw === "smart" || raw === "airp") return "chat";
  return ["chat", "code", "work"].includes(raw) ? raw : "chat";
}

function _p1QuickChatLabel(chat) {
  const id = _p1QuickChatId(chat);
  const title = String(chat?.customName || chat?.title || chat?.name || chat?.firstUserMessage || id || "对话").trim();
  const shortTitle = title.length > 38 ? `${title.slice(0, 38)}…` : title;
  const shortId = id.length > 12 ? `${id.slice(0, 12)}…` : id;
  return `${shortTitle}${shortId && !title.includes(id) ? ` · ${shortId}` : ""}`;
}

/**
 * P1 面板共用的“角色卡 + 对话”目录读口。
 * 角色清单以 parts 为主、对话归属反推为辅；对话清单读取失败则不能证明 chatId 有效，直接失败。
 * 快速测试与 P9 绑定必须复用这一份目录，禁止各自散写另一套角色/对话解析。
 */
async function _p1LoadScopeCatalog(currentChar = "") {
  const [charResult, chatResult] = await Promise.allSettled([
    getPartList("chars"),
    sendAction({ verb: "getChatList", target: "shells:chat", source: "web" }),
  ]);
  if (chatResult.status === "rejected") throw chatResult.reason;
  const chats = Array.isArray(chatResult.value) ? chatResult.value : [];
  const inferredChars = new Set();
  for (const chat of chats) {
    if (chat?.primaryCharName) inferredChars.add(String(chat.primaryCharName));
    for (const name of Array.isArray(chat?.chars) ? chat.chars : []) if (name) inferredChars.add(String(name));
  }
  const listedChars = charResult.status === "fulfilled" && Array.isArray(charResult.value) ? charResult.value : [];
  const chars = [...new Set([...listedChars, ...inferredChars, currentChar])]
    .map((name) => String(name || "").trim())
    .filter((name) => name && name !== "_global")
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  return { chars, chats, charListFailed: charResult.status === "rejected" };
}

function _p1RenderQuickChats(container, preferredChatId = "") {
  const charSelect = container.querySelector("#p1run-test-char");
  const chatSelect = container.querySelector("#p1run-test-chat");
  const modeSelect = container.querySelector("#p1run-test-mode");
  if (!charSelect || !chatSelect || !modeSelect) return;
  const charName = charSelect.value;
  const chats = (container._p1QuickChats || []).filter((chat) => chatBelongsToChar(chat, charName));
  const keep = preferredChatId || chatSelect.value;
  chatSelect.innerHTML = "";
  for (const chat of chats) {
    const id = _p1QuickChatId(chat);
    if (!id) continue;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = _p1QuickChatLabel(chat);
    option.title = `${option.textContent} (${id})`;
    option.dataset.mode = _p1QuickChatMode(chat);
    chatSelect.appendChild(option);
  }
  if (keep && chats.some((chat) => _p1QuickChatId(chat) === keep)) chatSelect.value = keep;
  const selected = chats.find((chat) => _p1QuickChatId(chat) === chatSelect.value);
  if (selected) modeSelect.value = _p1QuickChatMode(selected, modeSelect.value);
  chatSelect.disabled = chats.length === 0;
  const status = container.querySelector("#p1run-test-target-status");
  if (status) status.textContent = chats.length ? `${chats.length} 个可用对话` : "该角色没有可用于测试的对话文件";
}

function _p1SyncQuickControlsToCurrent(container) {
  let current;
  try { current = _p1CurrentBinding(); } catch (_) { return; }
  const charSelect = container.querySelector("#p1run-test-char");
  const modeSelect = container.querySelector("#p1run-test-mode");
  if (charSelect && [...charSelect.options].some((option) => option.value === current.charName)) {
    charSelect.value = current.charName;
    _p1RenderQuickChats(container, current.chatId);
  }
  if (modeSelect) modeSelect.value = _p1QuickChatMode({ mode: current.mode });
}

async function _p1LoadQuickTargets(container) {
  const charSelect = container.querySelector("#p1run-test-char");
  const chatSelect = container.querySelector("#p1run-test-chat");
  const refreshBtn = container.querySelector("#p1run-test-refresh");
  const status = container.querySelector("#p1run-test-target-status");
  if (!charSelect || !chatSelect) return;
  const loadTicket = (container._p1QuickTargetTicket || 0) + 1;
  container._p1QuickTargetTicket = loadTicket;
  charSelect.disabled = true;
  chatSelect.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  if (status) status.textContent = "正在加载角色卡与对话文件…";
  const previousChar = charSelect.value;
  const previousChat = chatSelect.value;
  let current = null;
  try { current = _p1CurrentBinding(); } catch (_) { /* 手动选择仍可用 */ }
  try {
    const catalog = await _p1LoadScopeCatalog(current?.charName || "");
    if (container._p1QuickTargetTicket !== loadTicket || !container.isConnected) return;
    const { chars, chats } = catalog;
    container._p1QuickChats = chats;
    charSelect.innerHTML = "";
    for (const name of chars) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      charSelect.appendChild(option);
    }
    const wantedChar = previousChar || current?.charName || chars[0] || "";
    if (chars.includes(wantedChar)) charSelect.value = wantedChar;
    _p1RenderQuickChats(container, previousChat || current?.chatId || "");
    if (!current && chatSelect.options.length > 0) container._p1QuickScopeMode = "manual";
    if (container._p1QuickScopeMode !== "manual") _p1SyncQuickControlsToCurrent(container);
    if (catalog.charListFailed && status) status.textContent += "；角色清单读取失败，已从对话反推";
  } catch (error) {
    container._p1QuickChats = [];
    chatSelect.innerHTML = "";
    if (status) status.textContent = `目标列表加载失败：${error?.message || error}`;
  } finally {
    if (container._p1QuickTargetTicket === loadTicket) {
      charSelect.disabled = charSelect.options.length === 0;
      chatSelect.disabled = chatSelect.options.length === 0;
      if (refreshBtn) refreshBtn.disabled = false;
      _p1RenderBinding(container);
    }
  }
}

function _p1InvalidateQuickTest(container) {
  container._p1QuickTestTicket = (container._p1QuickTestTicket || 0) + 1;
  const out = container.querySelector("#p1run-test-out");
  if (!out) return;
  out.innerHTML = "";
  delete out.dataset.p1QuickState;
}

// ═══════════════════ 面板1：运行 / 测试 ═══════════════════

export async function loadP1RunPanel(container) {
  if (container._loaded) return;
  container._loaded = true;
  container.innerHTML = `<div class="p-3 text-xs space-y-3" id="p1run-root">
    <div class="card bg-base-200/40 p-3" id="p1run-status"><span class="opacity-50">状态加载中...</span></div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">🚦 各模式 P1 路由 <span class="opacity-50 font-normal">（自驱动召回与 AI P1 最多启用一个，也可全部关闭；写入用户覆盖层，下一轮对话生效。与上方"启用 P1 召回"是两层：这里是模式级路由，上面是插件级总闸）</span></div>
      <div id="p1run-modeov" class="text-[11px]"><span class="opacity-50">加载中...</span></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">⚡ 快速测试 <span class="opacity-50 font-normal">（直调召回管线，可选角色卡与对话文件，不注入对话）</span></div>
      <div class="grid grid-cols-1 md:grid-cols-[minmax(8rem,0.75fr)_minmax(12rem,1.5fr)_7rem_auto] gap-2 items-end mb-1">
        <label class="flex flex-col gap-0.5"><span class="opacity-60">角色卡</span><select id="p1run-test-char" class="select select-xs select-bordered w-full"><option>加载中…</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">对话文件</span><select id="p1run-test-chat" class="select select-xs select-bordered w-full"><option>加载中…</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">记忆模式</span><select id="p1run-test-mode" class="select select-xs select-bordered w-full"><option value="chat">chat</option><option value="code">code</option><option value="work">work</option></select></label>
        <div class="flex gap-1">
          <button id="p1run-test-current" class="btn btn-xs" title="取消手动选择，重新跟随当前可见窗口">使用当前窗口</button>
          <button id="p1run-test-refresh" class="btn btn-xs btn-ghost" title="刷新角色卡与对话文件"><i data-ic="refresh"></i></button>
        </div>
      </div>
      <div id="p1run-test-target-status" class="mb-1 text-[10px] opacity-55"></div>
      <div id="p1run-test-binding" class="mb-2 flex flex-wrap gap-1 items-center text-[11px]"></div>
      <div class="flex gap-2 items-center mb-2 flex-wrap">
        <input id="p1run-test-input" type="text" class="input input-xs input-bordered flex-1 min-w-40" placeholder="输入一句话，立即查看 P1 召回结果" />
        <button id="p1run-test-btn" class="btn btn-xs btn-primary">运行召回</button>
      </div>
      <div id="p1run-test-out" class="text-[11px] leading-relaxed"></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">📝 运行记录 <span class="opacity-50 font-normal">（每次召回输出自动落盘 JSONL；打字联想不记录）</span></div>
      <div id="p1run-log-info" class="text-[11px] mb-1 flex flex-wrap gap-1 items-center"><span class="opacity-50">加载中...</span></div>
      <div id="p1run-log-files" class="flex flex-wrap gap-1 mb-1"></div>
      <div id="p1run-log-entries" class="text-[11px]"></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">🎛️ 参数微调 <span class="opacity-50 font-normal">（meta 单源下发；保存即写盘，下次召回生效）</span></div>
      <div id="p1run-params" class="grid grid-cols-2 md:grid-cols-3 gap-2"><span class="opacity-50">加载中...</span></div>
      <div class="mt-2 flex gap-2"><button id="p1run-save" class="btn btn-xs btn-primary">保存参数</button><span id="p1run-save-msg" class="opacity-60"></span></div>
    </div>
  </div>`;
  container.querySelector("#p1run-test-btn").addEventListener("click", () => _p1QuickTest(container));
  container.querySelector("#p1run-test-input").addEventListener("keydown", (e) => { if (e.key === "Enter") _p1QuickTest(container); });
  container.querySelector("#p1run-test-input").addEventListener("input", () => _p1InvalidateQuickTest(container));
  container.querySelector("#p1run-save").addEventListener("click", () => _p1SaveParams(container));
  container._p1QuickScopeMode = "current";
  const syncManualTarget = async () => {
    _p1InvalidateQuickTest(container);
    _p1RenderBinding(container);
    const entries = container.querySelector("#p1run-log-entries");
    if (entries) entries.innerHTML = "";
    await _p1RefreshRunLog(container);
  };
  container.querySelector("#p1run-test-char").addEventListener("change", () => {
    container._p1QuickScopeMode = "manual";
    _p1RenderQuickChats(container);
    void syncManualTarget();
  });
  container.querySelector("#p1run-test-chat").addEventListener("change", (event) => {
    container._p1QuickScopeMode = "manual";
    const mode = event.target.selectedOptions?.[0]?.dataset?.mode;
    if (mode) container.querySelector("#p1run-test-mode").value = mode;
    void syncManualTarget();
  });
  container.querySelector("#p1run-test-mode").addEventListener("change", () => {
    container._p1QuickScopeMode = "manual";
    void syncManualTarget();
  });
  container.querySelector("#p1run-test-current").addEventListener("click", () => {
    container._p1QuickScopeMode = "current";
    _p1SyncQuickControlsToCurrent(container);
    void syncManualTarget();
  });
  container.querySelector("#p1run-test-refresh").addEventListener("click", async () => {
    await _p1LoadQuickTargets(container);
    await syncManualTarget();
  });
  const syncWindowScope = async () => {
    if (!container.isConnected) return;
    if (container._p1QuickScopeMode !== "manual") _p1SyncQuickControlsToCurrent(container);
    _p1InvalidateQuickTest(container);
    _p1RenderBinding(container);
    const entries = container.querySelector("#p1run-log-entries");
    if (entries) entries.innerHTML = "";
    await _p1RefreshRunLog(container);
  };
  let scopeSyncQueued = false;
  const scheduleWindowScopeSync = () => {
    if (scopeSyncQueued) return;
    scopeSyncQueued = true;
    queueMicrotask(() => {
      scopeSyncQueued = false;
      void syncWindowScope();
    });
  };
  // 当前作用域是运行时绑定，窗口/模式/角色/本体对话改变时同步刷新；
  // 请求票据会丢弃旧作用域回包，不把 A 窗口日志渲染到 B 窗口。
  // hash/mode 事件位于原生切换中途（hash 已换、角色还未提交），不在那个边沿发请求。
  // character-switched / char-changed 是本体切换收尾，window-switched 是 lineManager 完整绑定包切换。
  for (const eventName of ["beilu:window-switched", "character-switched", "beilu:char-changed"]) {
    window.addEventListener(eventName, scheduleWindowScopeSync);
  }
  _p1RenderBinding(container);
  await _p1LoadQuickTargets(container);
  // 受认证 getData 是面板真实入口，也会经 serviceRuntime 单飞确保服务就绪；
  // 不再用只读 health 抢先短路，否则冷启动时面板会永远停在“请手动启动”。
  await _p1RefreshRun(container);
  await _p1RefreshRunLog(container);
}

// ── 运行记录卡片（0731 002"每次输出都需要进行文件记录...前端加上记录文件位置,点击打开"）──
// 记录文件位置由后端 getRunLogInfo 单源下发（前端禁硬编码路径）；点击路径=打开最新记录文件，
// 点击文件名=打开该文件（卡片内分页浏览，最新在前，getRunLog 尾页读取）；复制按钮写剪贴板。
async function _p1RefreshRunLog(container) {
  const info = container.querySelector("#p1run-log-info");
  const filesBox = container.querySelector("#p1run-log-files");
  if (!info || !filesBox) return;
  const requestId = (container._p1RunLogRequestId || 0) + 1;
  container._p1RunLogRequestId = requestId;
  const snapshot = _p1QuickSnapshot(container);
  const { charName, mode, chatid, multiWindow, bindingError } = snapshot;
  _p1RenderBinding(container, snapshot);
  if (bindingError) {
    _p1RunLogError(container, info, bindingError?.message || bindingError);
    filesBox.innerHTML = "";
    return;
  }
  try {
    const r = await _p1Action("getRunLogInfo", { charName, mode, chatId: chatid });
    const current = _p1QuickSnapshot(container);
    if (container._p1RunLogRequestId !== requestId
        || current.charName !== charName || current.mode !== mode || current.chatid !== chatid
        || current.multiWindow !== multiWindow || current.bindingError) return;
    if (!r?.success) { _p1RunLogError(container, info, r?.error || "读取失败"); return; }
    const latest = r.files?.[0]?.file || "";
    info.innerHTML = `
      <span class="opacity-60">记录位置:</span>
      <a class="link link-hover break-all cursor-pointer" id="p1run-log-path" title="${latest ? "点击打开最新记录文件" : "暂无记录文件"}">${_esc(r.dir)}</a>
      <button class="btn btn-xs btn-ghost" id="p1run-log-copy" title="复制记录目录路径">复制</button>
      <span class="badge badge-sm ${r.enabled ? "badge-success" : "badge-ghost"}">${r.enabled ? "记录中" : "已关闭"}</span>
      <span class="opacity-50">保留 ${Number(r.keepDays) === 0 ? "永久" : `${r.keepDays} 天`}</span>`;
    info.querySelector("#p1run-log-copy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(r.dir); window._beiluToast?.("记录路径已复制", "success"); }
      catch (e) { window._beiluToast?.(`复制失败: ${e?.message || e}`, "error"); }
    });
    info.querySelector("#p1run-log-path")?.addEventListener("click", () => { if (latest) _p1OpenRunLog(container, latest, 0); });
    filesBox.innerHTML = (r.files || []).map((f) =>
      `<button class="btn btn-xs btn-ghost" data-runlogfile="${_esc(f.file)}" title="${_esc(f.file)}">${_esc(f.file.slice(8, 18))} <span class="opacity-50">(${(f.size / 1024).toFixed(1)}KB)</span></button>`).join("")
      || '<span class="opacity-50">暂无记录文件（有召回运行后自动生成）</span>';
    filesBox.querySelectorAll("[data-runlogfile]").forEach((btn) => btn.addEventListener("click", () => _p1OpenRunLog(container, btn.dataset.runlogfile, 0)));
  } catch (e) {
    const current = _p1QuickSnapshot(container);
    if (container._p1RunLogRequestId === requestId
        && current.charName === charName && current.mode === mode && current.chatid === chatid
        && current.multiWindow === multiWindow && !current.bindingError) {
      _p1RunLogError(container, info, e?.message || e);
    }
  }
}

// 失败态带重试按钮：P1 服务是独立进程+薄壳自愈拉起（shells/p1 main.mjs ensureServiceRunning），
// 首次访问常撞冷启动窗口（503 后几秒服务就绪）——重试一下就通，不该逼用户整页刷新。
function _p1RunLogError(container, info, msg) {
  info.innerHTML = `<span class="text-error">运行记录读取失败: ${_esc(msg)}</span> <button class="btn btn-xs btn-ghost" id="p1run-log-retry">重试</button>`;
  info.querySelector("#p1run-log-retry")?.addEventListener("click", () => _p1RefreshRunLog(container));
}

async function _p1OpenRunLog(container, file, offset) {
  const box = container.querySelector("#p1run-log-entries");
  if (!box) return;
  box.innerHTML = '<span class="opacity-50">加载记录中...</span>';
  const snapshot = _p1QuickSnapshot(container);
  const { charName, mode, chatid, multiWindow, bindingError } = snapshot;
  if (bindingError) {
    box.innerHTML = `<span class="text-error">${_esc(bindingError?.message || bindingError)}</span>`;
    return;
  }
  try {
    const r = await _p1Action("getRunLog", { file, offset, charName, mode, chatId: chatid });
    const current = _p1QuickSnapshot(container);
    if (current.charName !== charName || current.mode !== mode || current.chatid !== chatid
        || current.multiWindow !== multiWindow || current.bindingError) return;
    if (!r?.success) { box.innerHTML = `<span class="text-error">${_esc(r?.error || "加载失败")}</span>`; return; }
    const srcLabel = { bridge: "对话", "panel-test": "面板测试" };
    box.innerHTML = `<div class="font-bold mb-1">${_esc(file)} <span class="opacity-50 font-normal">（共 ${r.total} 条，最新在前，第 ${r.total ? r.offset + 1 : 0}-${Math.min(r.offset + r.limit, r.total)} 条）</span></div>` +
      (r.entries.map((en) => en.broken
        ? `<div class="bg-base-100/60 rounded px-2 py-1 mb-1 text-warning">损坏行: ${_esc(en.raw)}</div>`
        : `<div class="bg-base-100/60 rounded px-2 py-1 mb-1">
            <div class="flex flex-wrap gap-1">
              <span class="badge badge-xs badge-ghost">${_esc(en.at ? new Date(en.at).toLocaleString() : "?")}</span>
              <span class="badge badge-xs badge-ghost">${_esc(srcLabel[en.source] || en.source || "?")}</span>
              <span class="badge badge-xs badge-ghost">${_esc(en.mode || "?")}</span>
              ${en.char ? `<span class="badge badge-xs badge-ghost">${_esc(en.char)}</span>` : ""}
              ${en.chatId ? `<span class="badge badge-xs badge-ghost">${_esc(en.chatId)}</span>` : ""}
              <span class="badge badge-xs badge-ghost">${_esc(en.ms)}ms</span>
              ${en.success ? "" : '<span class="badge badge-xs badge-error">失败</span>'}
            </div>
            <div class="opacity-70 mt-0.5">输入: ${_esc(String(en.input || "").slice(0, 120)) || "—"}</div>
            ${en.success
              ? `<div class="mt-0.5"><b>方向词:</b> ${_esc((en.p1_act || []).slice(0, 30).join(" · ")) || "—"}</div>` +
                ((en.recalledRecords || []).length
                  ? `<div class="mt-0.5"><b>召回记忆 ${en.recalledRecords.length} 条:</b></div>` +
                    en.recalledRecords.map((rr) => `<div class="opacity-70 pl-2">· [${_esc(rr.layer || "?")}] ${_esc(String(rr.content || "").slice(0, 120))}</div>`).join("")
                  : "")
              : `<div class="text-warning mt-0.5">${_esc(en.error || "无输出")}</div>`}
          </div>`).join("") || '<span class="opacity-50">该文件暂无记录</span>') +
      `<div class="flex gap-2 mt-1">
        <button class="btn btn-xs" data-runlogpage="newer" ${r.offset <= 0 ? "disabled" : ""}>较新一页</button>
        <button class="btn btn-xs" data-runlogpage="older" ${r.offset + r.limit >= r.total ? "disabled" : ""}>更早一页</button>
        <button class="btn btn-xs btn-ghost" data-runlogpage="close">收起</button>
      </div>`;
    box.querySelector('[data-runlogpage="newer"]')?.addEventListener("click", () => _p1OpenRunLog(container, file, Math.max(0, offset - r.limit)));
    box.querySelector('[data-runlogpage="older"]')?.addEventListener("click", () => _p1OpenRunLog(container, file, offset + r.limit));
    box.querySelector('[data-runlogpage="close"]')?.addEventListener("click", () => { box.innerHTML = ""; });
  } catch (e) {
    const current = _p1QuickSnapshot(container);
    if (current.charName === charName && current.mode === mode && current.chatid === chatid
        && current.multiWindow === multiWindow && !current.bindingError) {
      box.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`;
    }
  }
}

// 按当前窗口绑定 chatId 拉对话尾部消息作 chatHistory（start 负数=尾部 slice）。
async function _p1FetchChatTail(chatid, n) {
  if (n <= 0) return [];
  const res = await fetch(`/api/parts/shells:chat/${encodeURIComponent(chatid)}/log?start=-${n}`);
  if (!res.ok) throw new Error(`对话历史读取失败（HTTP ${res.status}）`);
  const log = await res.json();
  if (!Array.isArray(log)) throw new Error("对话历史响应格式错误（应为消息数组）");
  return log
    .map((m) => ({ role: m.role || (m.name ? "assistant" : "user"), content: String(m.content ?? m.text ?? "") }))
    .filter((m) => m.content);
}

// 后端按 user 角色取最近 N 条；前端必须确保传入的尾部里确实包含 N 条 user。
// 不能用 N×2 猜一问一答，因为工具消息、多段 assistant 和隐藏消息都会打破交替假设。
async function _p1FetchRecentUserContext(chatid, userCount) {
  if (userCount <= 0) return [];
  const maxTail = 200;
  let tailSize = Math.min(maxTail, Math.max(10, userCount * 2));
  while (true) {
    const history = await _p1FetchChatTail(chatid, tailSize);
    const userSeen = history.filter((m) => m.role === "user").length;
    if (userSeen >= userCount || history.length < tailSize || tailSize >= maxTail) return history;
    tailSize = Math.min(maxTail, tailSize * 2);
  }
}

let _p1Meta = [];
let _p1Config = {}; // getData 平铺配置快照（快速测试等按配置驱动，禁前端硬编码条数/上限）

function _p1MetaOptions(meta) {
  if (!Array.isArray(meta?.options)) return [];
  return meta.options.map((option) => {
    if (option && typeof option === "object") {
      const value = option.value ?? option.id ?? "";
      return { value: String(value), label: String(option.label ?? value) };
    }
    return { value: String(option), label: String(option) };
  });
}

function _p1RenderParamControl(meta, value) {
  const title = _esc(meta.desc);
  const key = _esc(meta.key);
  const common = `data-p1key="${key}" data-p1type="${_esc(meta.type)}"`;
  const labelOpen = `<label class="flex items-center justify-between gap-1 bg-base-100/60 rounded px-2 py-1" title="${title}"><span>${_esc(meta.label)}</span>`;
  if (meta.type === "toggle") {
    return `${labelOpen}<input type="checkbox" class="toggle toggle-xs" ${common} ${value ? "checked" : ""}/></label>`;
  }
  if (meta.type === "number") {
    const numericValue = typeof value === "number" && Number.isFinite(value) ? value : "";
    return `${labelOpen}<input type="number" class="input input-xs input-bordered w-24" ${common} value="${_esc(numericValue)}" ${meta.min != null ? `min="${_esc(meta.min)}"` : ""} ${meta.max != null ? `max="${_esc(meta.max)}"` : ""} ${meta.step != null ? `step="${_esc(meta.step)}"` : ""}/></label>`;
  }
  if (meta.type === "select") {
    const options = _p1MetaOptions(meta);
    return `${labelOpen}<select class="select select-xs select-bordered w-28" ${common}>${options.map((option) =>
      `<option value="${_esc(option.value)}" ${String(value ?? "") === option.value ? "selected" : ""}>${_esc(option.label)}</option>`).join("")}</select></label>`;
  }
  if (meta.type === "text") {
    return `${labelOpen}<input type="text" class="input input-xs input-bordered w-36" ${common} value="${_esc(value)}"/></label>`;
  }
  return `<div class="bg-error/10 text-error rounded px-2 py-1" title="${title}">${_esc(meta.label || meta.key)}：不支持的控件类型 ${_esc(meta.type)}</div>`;
}

async function _p1RefreshRun(container) {
  const requestId = (container._p1RunRequestId || 0) + 1;
  container._p1RunRequestId = requestId;
  try {
    const d = await _p1Action("getData");
    if (container._p1RunRequestId !== requestId) return;
    _p1Meta = Array.isArray(d?.meta) ? d.meta : [];
    _p1Config = d && typeof d === "object" ? d : {};
    const st = d?.stats || {};
    const box = container.querySelector("#p1run-status");
    if (box) box.innerHTML = `
      <div class="flex flex-wrap gap-2 items-center">
        <label class="flex items-center gap-1"><input type="checkbox" id="p1run-enabled" class="toggle toggle-xs" ${d.enabled ? "checked" : ""}/><b>启用 P1 召回</b></label>
        ${/* [0804 根因修·P1 假绿] 主状态色只认 readyForRecall——pipelineLoaded=true 但 readyForRecall=false
             会同时成立（管线模块已加载但资源 warmup 未过，E 现场 DomainWords stale 即此态），原实现拿
             pipelineLoaded 画绿=假绿（「第二次打开像生效」的产地）。只有 readyForRecall 才允许绿；
             pipelineLoaded 降为旁边诊断字段，不承担成功主视觉。*/""}
        <span class="badge badge-sm ${st.readyForRecall ? "badge-success" : "badge-warning"}">${st.readyForRecall ? "可召回" : "未就绪"}</span>
        <span class="badge badge-xs badge-ghost" title="管线模块是否已加载（≠可召回：资源 warmup 未过时仍显示已加载）">管线${st.pipelineLoaded ? "已加载" : "未加载"}</span>
        <span class="badge badge-sm badge-ghost">最近 ${st.lastRunMs != null ? st.lastRunMs + "ms" : "—"}</span>
        <span class="badge badge-sm badge-ghost">运行中 ${st.activeRuns ?? 0}</span>
        <span class="badge badge-sm badge-ghost">空闲卸载 ${st.idleUnloadMinutes ?? "—"}min</span>
        <label class="flex items-center gap-1" title="输入框打字停顿时用 P1 轻量召回展示联想词（不扫记忆 data，不影响正式召回）"><input type="checkbox" id="p1run-typing" class="toggle toggle-xs" ${(() => { try { return localStorage.getItem("beilu-typing-suggest-enabled") === "true" ? "checked" : ""; } catch { return ""; } })()}/><span>打字联想</span></label>
        <button id="p1run-once" class="btn btn-xs" title="INJ-p1 条目被关闭时：排队让下一条消息单次注入 P1 结果（仅该轮）">单次注入下轮</button>
        <button id="p1run-clear" class="btn btn-xs">清缓存</button>
        <button id="p1run-refresh" class="btn btn-xs btn-ghost">刷新</button>
      </div>`;
    box?.querySelector("#p1run-typing")?.addEventListener("change", (e) => {
      try { localStorage.setItem("beilu-typing-suggest-enabled", e.target.checked ? "true" : "false"); } catch { /* 私隐模式等存储失败静默 */ }
    });
    // 单次注入（0731 002）：P1 条目被用户在 INJ 面板关闭时，此按钮把两条 INJ-p1-* 排进下一次发送
    // 的 single_inject_ids（走注入坞同一条队列/发送链，但条目不进坞候选——凛倾0726域边界）。
    box?.querySelector("#p1run-once")?.addEventListener("click", async () => {
      try {
        const m = await import("../../shared/chat-core/injectDock.mjs");
        const ok = m.queueOnceInject("INJ-p1-retrieval-data") && m.queueOnceInject("INJ-p1-act-data");
        const el = box.querySelector("#p1run-once");
        if (el) el.textContent = ok ? "已排队（下条消息生效一次）" : "排队失败";
      } catch (e) { console.warn("[p1panel] 单次注入排队失败:", e?.message || e); }
    });
    box?.querySelector("#p1run-clear")?.addEventListener("click", async () => {
      try { await _p1Action("unloadCaches"); await _p1RefreshRun(container); } catch { /* _p1Action 已统一报错 */ }
    });
    box?.querySelector("#p1run-refresh")?.addEventListener("click", () => { _p1RefreshRun(container); _p1RefreshRunLog(container); }); // 刷新=全面板（含运行记录卡片：P1 服务冷启动期首拉失败后由此恢复）
    box?.querySelector("#p1run-enabled")?.addEventListener("change", async (e) => {
      try { await _p1Action("updateConfig", { enabled: e.target.checked }); } catch { /* 已报错 */ }
    });
    // 参数区：按 meta.group 分组渲染（跳过 enabled——状态条已有）
    const pWrap = container.querySelector("#p1run-params");
    if (pWrap) {
      const groups = new Map();
      for (const m of _p1Meta) {
        if (m.key === "enabled") continue;
        if (!groups.has(m.group)) groups.set(m.group, []);
        groups.get(m.group).push(m);
      }
      let html = "";
      for (const [g, items] of groups) {
        html += `<div class="col-span-full text-[10px] opacity-50 border-b border-base-300/40 pb-0.5 mt-1">${_esc(g)}</div>`;
        for (const m of items) html += _p1RenderParamControl(m, d[m.key]);
      }
      pWrap.innerHTML = html || '<span class="opacity-50">插件未返回 meta</span>';
    }
  } catch (e) {
    if (container._p1RunRequestId !== requestId) return;
    const box = container.querySelector("#p1run-status");
    if (box) {
      box.innerHTML = `<span class="text-error">状态加载失败: ${_esc(e?.message || e)}</span> <button class="btn btn-xs btn-ghost" id="p1run-refresh-retry">重试</button>`;
      box.querySelector("#p1run-refresh-retry")?.addEventListener("click", () => _p1RefreshRun(container));
    }
  }
  _p1RefreshModeOverrides(container);
}

// per-mode P1 互斥路由：读写 beilu-memory 的 mode_feature_overrides 用户覆盖层。
// 注意 target 是 plugins:beilu-memory（mode 级路由门在 memory 侧），不是本插件（插件 enabled 是另一层总闸）。
// 生效值由后端单源下发（声明默认 ⊕ 用户覆盖 ⊕ XOR 归一化），前端只渲染和提交用户选择。
async function _p1RefreshModeOverrides(container) {
  const box = container.querySelector("#p1run-modeov");
  if (!box) return;
  const requestId = (container._p1ModeOverridesRequestId || 0) + 1;
  container._p1ModeOverridesRequestId = requestId;
  try {
    const r = await sendAction({ verb: "getModeFeatureOverrides", target: "plugins:beilu-memory", source: "web" });
    if (container._p1ModeOverridesRequestId !== requestId) return;
    const effAll = r?.effective || {};
    box.innerHTML = `<table class="table table-xs"><thead><tr><th>模式</th><th>自驱动召回（10）</th><th>AI P1（01）</th></tr></thead><tbody>${
      Object.keys(effAll).map((m) => {
        const eff = effAll[m] || {};
        return `<tr><td>${_esc(m)}</td>
          <td><input type="checkbox" class="toggle toggle-xs" data-mfov-mode="${_esc(m)}" data-mfov-route="selfDriven" ${eff.selfDriven ? "checked" : ""}/></td>
          <td><input type="checkbox" class="toggle toggle-xs" data-mfov-mode="${_esc(m)}" data-mfov-route="aiP1" ${eff.aiP1 ? "checked" : ""}/></td></tr>`;
      }).join("")}</tbody></table>`;
    box.querySelectorAll("[data-mfov-route]").forEach((el) => el.addEventListener("change", async () => {
      const mode = el.dataset.mfovMode;
      const rowInputs = [...(el.closest("tr")?.querySelectorAll("[data-mfov-route]") || [])];
      const selfInput = rowInputs.find((input) => input.dataset.mfovRoute === "selfDriven");
      const aiInput = rowInputs.find((input) => input.dataset.mfovRoute === "aiP1");
      if (el.checked) {
        if (el.dataset.mfovRoute === "selfDriven" && aiInput) aiInput.checked = false;
        if (el.dataset.mfovRoute === "aiP1" && selfInput) selfInput.checked = false;
      }
      const selfDriven = !!selfInput?.checked;
      const aiP1 = !!aiInput?.checked;
      rowInputs.forEach((input) => { input.disabled = true; });
      try {
        await sendAction({
          verb: "saveModeFeatureOverride",
          target: "plugins:beilu-memory",
          source: "web",
          payload: { mode, lib: "p1", selfDriven, aiP1 },
        });
        _p1RefreshModeOverrides(container);
      } catch { /* sendAction 已统一报错；失败时刷新回真值 */ _p1RefreshModeOverrides(container); }
    }));
  } catch (e) {
    if (container._p1ModeOverridesRequestId !== requestId) return;
    box.innerHTML = `<span class="text-error">开关读取失败: ${_esc(e?.message || e)}</span>`;
  }
}

async function _p1SaveParams(container) {
  const patch = {};
  const msg = container.querySelector("#p1run-save-msg");
  const metaByKey = new Map(_p1Meta.map((meta) => [String(meta.key), meta]));
  for (const el of container.querySelectorAll("[data-p1key]")) {
    const key = el.dataset.p1key;
    const meta = metaByKey.get(key);
    if (!meta) { if (msg) msg.textContent = `保存失败: 参数 ${key} 缺少 meta`; return; }
    if (meta.type === "toggle") {
      patch[key] = !!el.checked;
    } else if (meta.type === "number") {
      const raw = String(el.value ?? "").trim();
      const value = raw === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) { if (msg) msg.textContent = `保存失败: ${meta.label || key} 必须是有限数`; return; }
      patch[key] = value;
    } else if (meta.type === "select") {
      const allowed = _p1MetaOptions(meta).map((option) => option.value);
      if (!allowed.includes(el.value)) { if (msg) msg.textContent = `保存失败: ${meta.label || key} 不是后端下发的可选值`; return; }
      patch[key] = el.value;
    } else if (meta.type === "text") {
      patch[key] = el.value;
    } else {
      if (msg) msg.textContent = `保存失败: ${meta.label || key} 的控件类型 ${meta.type} 不受支持`;
      return;
    }
  }
  try {
    const result = await _p1Action("updateConfig", patch);
    if (result?.success === false) throw new Error(result.error || "后端拒绝保存参数");
    if (!result?.config || typeof result.config !== "object" || Array.isArray(result.config)) {
      throw new Error("后端未返回生效配置，无法确认保存结果");
    }
    // 后端回包是用户 overlay 与服务配置合成后的真实生效值；禁止把提交 patch 乐观写入运行缓存。
    _p1Config = { ...result.config };
    window.dispatchEvent(new CustomEvent(_P1_CONFIG_CHANGED_EVENT, { detail: { config: result.config } }));
    await _p1RefreshRun(container);
    if (msg) msg.textContent = "已保存（写盘生效）";
  } catch (e) { if (msg) msg.textContent = `保存失败: ${e?.message || e}`; }
}

function _p1WordBadges(words) {
  return words.length ? words.map((word) => `<span class="badge badge-xs badge-ghost mr-0.5 mb-0.5">${_esc(typeof word === "object" ? word.word : word)}</span>`).join("") : '<span class="opacity-50">无</span>';
}

function _p1RenderNode1Units(node1) {
  const units = Array.isArray(node1?.units) ? node1.units : [];
  if (!units.length) return '<div class="pl-2 text-error">Node1 units 未返回</div>';
  return units.map((unit) => {
    const tokens = Array.isArray(unit.tokens) ? unit.tokens : [];
    return `<div class="mt-1 rounded bg-base-100/50 p-1">
      <div class="font-semibold">unit ${unit.index ?? "?"} · ${_esc(unit.type || "?")} · ${tokens.length} token</div>
      ${tokens.length ? `<div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>词</th><th>最终 POS</th><th>POS 来源</th><th>分词器 POS</th><th>模型 POS / tag</th><th>Core POS</th><th>裁决</th></tr></thead><tbody>${tokens.map((token) => `<tr class="${token.filtered ? "opacity-60" : ""}">
        <td>${_esc(token.word)}</td>
        <td>${_esc(token.pos ?? "—")}${token.upos ? ` / ${_esc(token.upos)}` : ""}</td>
        <td>${_esc(token.posSource ?? "—")}</td>
        <td>${_esc(token.segmenterPos ?? "—")}</td>
        <td>${_esc(token.modelPos ?? "—")} / ${_esc(token.modelTag ?? "—")}</td>
        <td>${_esc(token.corePos ?? "—")}</td>
        <td class="${token.filtered ? "text-warning" : "text-success"}">${token.filtered ? `过滤: ${_esc(token.reason ?? "未给原因")}` : `保留: ${_esc(token.keptBy ?? "未给依据")}`}</td>
      </tr>`).join("")}</tbody></table></div>` : '<div class="opacity-50 pl-2">该单元没有 token</div>'}
    </div>`;
  }).join("");
}

function _p1RenderDiagnostics(items) {
  if (!items.length) return '<div class="rounded border border-success/30 bg-success/10 px-2 py-1 text-success">输入回显、Node0、Node1 阶段契约已通过</div>';
  return items.map((item) => `<div class="rounded border ${item.level === "error" ? "border-error/40 bg-error/10 text-error" : "border-warning/40 bg-warning/10 text-warning"} px-2 py-1 mb-1"><b>${item.stage}</b>：${_esc(item.message)}</div>`).join("");
}

function _p1Node2ResourceDiagnostics(recall, mechanisms) {
  const badStatuses = new Set(["degraded", "unavailable", "error", "failed"]);
  const node2 = recall?.node2 && typeof recall.node2 === "object" ? recall.node2 : null;
  if (!node2) return [];
  const status = String(node2.status || "").trim().toLowerCase();
  const errors = Array.isArray(node2.errors) ? node2.errors : [];
  if (!badStatuses.has(status) && !errors.length) return [];
  const details = errors.map((error) => {
    const source = [error?.mechanism, error?.resource].filter(Boolean).join("/");
    return `${error?.code || "E_P1_NODE2_RESOURCE"}${source ? `[${source}]` : ""}: ${error?.message || error}`;
  });
  for (const mechanism of mechanisms) {
    const status = String(mechanism?.status || "").trim().toLowerCase();
    const errors = Array.isArray(mechanism?.errors) ? mechanism.errors : [];
    const note = String(mechanism?.note || "").trim();
    // mechanisms 只作 node2 一级状态的明细；是否提升为显眼诊断只由 trace.recall.node2 裁决。
    const stableCodeInNote = /\bE_P1_[A-Z0-9_]+\b/.test(note);
    if (!badStatuses.has(status) && !errors.length && !stableCodeInNote) continue;
    const detail = errors.map((error) => `${error?.code || "E_P1_NODE2_RESOURCE"}: ${error?.message || error}`).join("; ") || note;
    details.push(`${mechanism?.name || mechanism?.mechanism || "unknown"}[${status || "degraded"}]${detail ? `: ${detail}` : ""}`);
  }
  return [{
    level: status === "error" || status === "failed" ? "error" : "warning",
    stage: "Node2 资源状态",
    message: `${status || "degraded"}${details.length ? ` · ${details.join("; ")}` : ""}`,
  }];
}

// 存储诊断是用户判断“为什么没有召回到记忆”的一级结果，不能只藏在底部 whitebox 文本。
function _p1RenderStorageDiagnostics(items) {
  if (!Array.isArray(items)) {
    return '<div class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning"><b>🗄️ 存储读取诊断</b>：服务未返回 storageDiagnostics，无法确认存储读取状态</div>';
  }
  if (!items.length) {
    return '<div class="rounded border border-success/30 bg-success/10 px-2 py-1 text-success"><b>🗄️ 存储读取诊断</b>：未发现存储读取异常</div>';
  }
  const hasError = items.some((item) => item?.kind === "error");
  return `<div class="rounded border ${hasError ? "border-error/50 bg-error/10 text-error" : "border-warning/50 bg-warning/10 text-warning"} px-2 py-2">
    <div class="font-bold mb-1">🗄️ 存储读取诊断（${items.length}）</div>
    ${items.map((item) => `<div class="rounded bg-base-100/50 px-2 py-1 mb-1 last:mb-0">
      <b>${_esc(item?.code || "P1_STORAGE_DIAGNOSTIC")}</b>
      <span class="badge badge-xs badge-ghost ml-1">${_esc(item?.kind || "unknown")}</span>
      <div>${_esc(item?.message || "存储读取异常")}</div>
      <div class="opacity-70 break-all">${_esc(item?.path || ".")}</div>
    </div>`).join("")}
  </div>`;
}

async function _p1QuickTest(container) {
  const ticket = (container._p1QuickTestTicket || 0) + 1;
  container._p1QuickTestTicket = ticket;
  const snapshot = _p1QuickSnapshot(container);
  const { input, mode, charName, chatid, multiWindow, bindingError } = snapshot;
  const out = container.querySelector("#p1run-test-out");
  _p1RenderBinding(container, snapshot);
  if (bindingError) {
    if (out) {
      out.dataset.p1QuickState = "error";
      out.innerHTML = `<span class="text-error">无法提交 P1 请求：${_esc(bindingError?.message || bindingError)}</span>`;
    }
    return;
  }
  if (!input) {
    if (out) { delete out.dataset.p1QuickState; out.textContent = "请输入测试文本"; }
    return;
  }
  if (out) {
    out.dataset.p1QuickState = "loading";
    out.innerHTML = '<span class="opacity-50">召回中...</span>';
  }
  const t0 = Date.now();
  try {
    // 0 是合法配置，不能用 || 改写；仅在配置缺失/非法时回到框架默认最近 5 条 user。
    const configuredContext = Number(_p1Config.contextMessages);
    const contextMessages = Number.isFinite(configuredContext) && configuredContext >= 0 ? Math.trunc(configuredContext) : 5;
    let chatHistory = [];
    if (contextMessages > 0) {
      try {
        chatHistory = await _p1FetchRecentUserContext(chatid, contextMessages);
      } catch (e) {
        if (_p1QuickIsCurrent(container, ticket, snapshot) && out) {
          out.dataset.p1QuickState = "error";
          out.innerHTML = `<span class="text-error">对话历史加载失败，本次快测已中止: ${_esc(e?.message || e)}</span>`;
        }
        return;
      }
    }
    if (!_p1QuickIsCurrent(container, ticket, snapshot)) return;
    const r = await _p1Action("runP1", {
      inputText: input,
      chatHistory,
      historyChatId: chatid,
      mode,
      activeMode: mode,
      charName,
      chatId: chatid,
      multiWindow,
      source: "panel-test",
      whitebox: true,
    });
    if (!_p1QuickIsCurrent(container, ticket, snapshot)) return;
    const ms = Date.now() - t0;
    if (!r?.success) {
      if (out) {
        out.dataset.p1QuickState = "error";
        out.innerHTML = `<span class="text-error">${_esc(r?.error || "召回失败（服务未返回原因）")}</span>`;
      }
      return;
    }

    const trace = r.trace && typeof r.trace === "object" ? r.trace : {};
    const request = trace.request && typeof trace.request === "object" ? trace.request : null;
    const node1 = trace.node1 && typeof trace.node1 === "object" ? trace.node1 : null;
    const rec = trace.recall && typeof trace.recall === "object" ? trace.recall : null;
    const node0Units = Array.isArray(request?.node0Units) ? request.node0Units : [];
    const node1Units = Array.isArray(node1?.units) ? node1.units : [];
    const keptFor = (types) => node1Units.filter((unit) => types.includes(unit.type)).flatMap((unit) => (unit.tokens || []).filter((token) => !token.filtered).map((token) => token.word));
    const node1CurrentWords = keptFor(["user_current"]);
    const currentInputWords = Array.isArray(rec?.currentInputWords) ? rec.currentInputWords : node1CurrentWords;
    const contextWords = Array.isArray(rec?.contextWords) ? rec.contextWords : keptFor(["user_context"]);
    const dataWords = Array.isArray(rec?.dataWords) ? rec.dataWords : keptFor(["data"]);
    const pool = Array.isArray(rec?.swowPool) ? rec.swowPool : [];
    const scored = Array.isArray(rec?.scoredPool) ? rec.scoredPool : [];
    const anchors = Array.isArray(rec?.anchors) ? rec.anchors : [];
    const records = Array.isArray(r.recalledRecords) ? r.recalledRecords : [];
    const mechs = Array.isArray(rec?.mechanisms) ? rec.mechanisms : [];
    const sp2 = Array.isArray(rec?.secondPassRemoved) ? rec.secondPassRemoved : [];
    const blqD = Array.isArray(rec?.blqDropped) ? rec.blqDropped : [];
    const nbD = Array.isArray(rec?.nbDropped) ? rec.nbDropped : [];
    const wnD = Array.isArray(rec?.wnDropped) ? rec.wnDropped : [];
    const idx = rec?.index || null;
    const storageDiagnostics = Array.isArray(rec?.storageDiagnostics)
      ? rec.storageDiagnostics
      : (Array.isArray(r?.memory?.storageDiagnostics) ? r.memory.storageDiagnostics : null);
    const fr = rec?.filterByReason && typeof rec.filterByReason === "object" ? rec.filterByReason : {};
    const frStr = Object.entries(fr).map(([key, value]) => `${key}:${value}`).join(" ");
    const diagnostics = [];
    if (!request) diagnostics.push({ level: "error", stage: "请求回显", message: "缺少 trace.request，无法证明服务收到的输入" });
    else if (String(request.inputText ?? "") !== input) diagnostics.push({ level: "error", stage: "请求回显", message: `服务回显与用户输入不一致（回显: ${String(request.inputText ?? "") || "空"}）` });
    const node0Current = node0Units.find((unit) => unit?.type === "user_current");
    if (request && !node0Current) diagnostics.push({ level: "error", stage: "Node0", message: "Node0 units 缺少 user_current" });
    else if (node0Current && String(node0Current.raw ?? "") !== input) diagnostics.push({ level: "error", stage: "Node0", message: `user_current 原文与用户输入不一致（Node0: ${String(node0Current.raw ?? "") || "空"}）` });
    if (!node1) diagnostics.push({ level: "error", stage: "Node1", message: "缺少 trace.node1，无法审计逐词 POS 与过滤原因" });
    else if (!node1Units.some((unit) => unit?.type === "user_current")) diagnostics.push({ level: "error", stage: "Node1", message: "Node1 units 缺少 user_current" });
    else if (!node1CurrentWords.length) diagnostics.push({ level: "error", stage: "Node1", message: "当前输入经过 Node1 后为 0 个保留 token；历史/Data 词不能冒充当前输入" });
    else if (Array.isArray(rec?.currentInputWords) && JSON.stringify(rec.currentInputWords) !== JSON.stringify(node1CurrentWords)) diagnostics.push({ level: "error", stage: "Node1", message: "trace.recall.currentInputWords 与逐词 Node1 user_current 裁决不一致" });
    if (!rec) diagnostics.push({ level: "error", stage: "Node2-4", message: "缺少 trace.recall，无法判断发散、审查与排序阶段" });
    else if (!pool.length) diagnostics.push({ level: "warning", stage: "Node2", message: "发散池为 0；请检查 Node1 输入词和机制资源状态" });
    else if (!scored.length) diagnostics.push({ level: "warning", stage: "Node3", message: "Node2 有候选，但 Node3 审查后 0 存活；请查看各淘汰原因" });
    diagnostics.push(..._p1Node2ResourceDiagnostics(rec, mechs));
    if (typeof r.whitebox !== "string" || !r.whitebox.trim()) diagnostics.push({ level: "warning", stage: "白盒", message: "请求已要求 whitebox=true，但响应未返回完整 whitebox" });

    const node0Html = node0Units.length ? node0Units.map((unit) => `<div class="rounded bg-base-100/50 px-2 py-1 mt-1"><b>unit ${unit.index ?? "?"} · ${_esc(unit.type || "?")}</b> ${unit.excluded ? `<span class="text-warning">已排除: ${_esc(unit.excludeReason || "未给原因")}</span>` : '<span class="text-success">已进入</span>'}<div class="break-words opacity-80">${_esc(unit.raw ?? "") || "—"}</div></div>`).join("") : '<div class="text-error">Node0 units 未返回</div>';
    const whiteboxText = typeof r.whitebox === "string" ? r.whitebox : "";
    const runLogIssues = getP1RunLogIssues(r);
    const runLogErrors = runLogIssues.filter((issue) => issue.severity === "error");
    const runLogWarnings = runLogIssues.filter((issue) => issue.severity === "warning");
    const renderRunLogIssues = (issues, tone, title) => issues.length ? `<div class="mb-2 rounded border border-${tone}/60 bg-${tone}/10 p-2 text-${tone}">
      <div class="font-bold">⚠ ${title}（召回结果仍有效）</div>
      ${issues.map((issue) => `<div class="mt-1"><span class="font-mono">${_esc(issue.code)}</span> · ${_esc(issue.message)}${issue.file ? ` · file: <span class="font-mono">${_esc(issue.file)}</span>` : ""}</div>`).join("")}
    </div>` : "";
    if (out) {
      out.dataset.p1QuickState = "done";
      out.innerHTML = `
      ${renderRunLogIssues(runLogErrors, "error", r?.runLog?.written === true ? "记录已写入但清理错误" : "运行记录写入失败")}
      ${renderRunLogIssues(runLogWarnings, "warning", "记录已写入但清理警告")}
      <div class="flex flex-wrap gap-1 mb-1">
        <span class="badge badge-sm badge-ghost">${ms}ms</span>
        <span class="badge badge-sm badge-ghost">角色 ${_esc(charName || "—")}</span>
        <span class="badge badge-sm badge-ghost">模式 ${_esc(mode)}</span>
        <span class="badge badge-sm badge-ghost">历史 ${chatHistory.length}</span>
        <span class="badge badge-sm badge-ghost">记忆 ${records.length}</span>
        ${idx ? `<span class="badge badge-sm ${idx.hit ? "badge-success" : "badge-warning"}">索引${idx.hit ? "命中" : "重建"} · ${_esc(idx.version || "—")}</span>` : ""}
      </div>
      <div class="mb-1">${_p1RenderDiagnostics(diagnostics)}</div>
      <div class="mb-1">${_p1RenderStorageDiagnostics(storageDiagnostics)}</div>
      <details open class="mt-1"><summary class="cursor-pointer font-bold text-xs">请求原始输入 / Node0 units (${node0Units.length})</summary>
        <div class="pl-2 mt-1"><b>用户输入:</b> <span class="break-words">${_esc(input)}</span></div>
        <div class="pl-2"><b>服务回显:</b> <span class="break-words">${_esc(request?.inputText ?? "") || "—"}</span></div>
        <div class="pl-2 mt-1">${node0Html}</div>
      </details>
      <details open class="mt-1"><summary class="cursor-pointer font-bold text-xs">① Node1 逐词 POS / 来源 / 过滤裁决 (${rec?.totalTokens ?? 0} token，过滤 ${rec?.filteredCount ?? 0})</summary>
        <div class="pl-2 text-[11px] opacity-80">provider: ${_esc(JSON.stringify(node1?.provider ?? null))} · 过滤分布: ${_esc(frStr || "无")}</div>
        <div class="pl-2 mt-1"><b>当前输入词 (${currentInputWords.length}):</b> ${_p1WordBadges(currentInputWords)}</div>
        <div class="pl-2"><b>历史上下文词 (${contextWords.length}):</b> ${_p1WordBadges(contextWords)}</div>
        <div class="pl-2"><b>Data 记忆词 (${dataWords.length}):</b> ${_p1WordBadges(dataWords)}</div>
        <div class="pl-2">${_p1RenderNode1Units(node1)}</div>
      </details>
      <details class="mt-1"><summary class="cursor-pointer font-bold text-xs">② Node2 发散摘要：原始池 ${rec?.rawPoolCount ?? pool.length} → 二次过滤 ${sp2.length} → 池 ${pool.length}</summary>
        <div class="pl-2 text-[11px] opacity-80">机制: ${_esc(mechs.map((mechanism) => `${mechanism.name}:${mechanism.produced}${mechanism.note ? ` ⚠${mechanism.note}` : ""}`).join(" | ") || "—")}</div>
        ${sp2.length ? `<div class="pl-2 text-[11px] text-warning">二次过滤: ${_esc(sp2.slice(0, 20).map((item) => `${item.word}(${item.reason})`).join(" "))}</div>` : ""}
        <div class="pl-2">${pool.length ? pool.slice(0, 50).map((item) => `<span class="badge badge-xs ${typeof item === "object" && item?.resonance >= 2 ? "badge-warning" : "badge-ghost"} mr-0.5 mb-0.5" title="${_esc(typeof item === "object" ? `来源:${(item.sources || []).join("+")} str:${item.strength} via:${(item.via || []).join(",")}` : "")}">${_esc(typeof item === "object" ? item.word : item)}</span>`).join("") + (pool.length > 50 ? `<span class="opacity-50">…+${pool.length - 50}</span>` : "") : '<span class="text-warning">Node2 未产出候选</span>'}</div>
      </details>
      <details class="mt-1"><summary class="cursor-pointer font-bold text-xs">③ Node3 审查摘要：池 ${pool.length} → BLQ预筛 ${blqD.filter((item) => item.reason === "blq_pre").length} → NB ${nbD.length} → WN ${wnD.length} → BLQ终筛 ${blqD.filter((item) => item.reason === "blq_final").length} → 存活 ${scored.length} ${rec?.nbAvailable ? "" : "⚠NB离线"}</summary>
        ${blqD.length ? `<div class="pl-2 text-[11px] text-warning">BLQ淘汰(${blqD.length}): ${_esc(blqD.slice(0, 15).map((item) => `${item.word}=${item.score}`).join(" "))}</div>` : ""}
        ${nbD.length ? `<div class="pl-2 text-[11px] text-warning">NB丢弃(${nbD.length}): ${_esc(nbD.slice(0, 15).map((item) => `${item.word}(cos=${item.cos})`).join(" "))}</div>` : ""}
        ${wnD.length ? `<div class="pl-2 text-[11px] text-warning">WN丢弃(${wnD.length}): ${_esc(wnD.slice(0, 15).map((item) => `${item.word}(cos=${item.cos},wn=${item.wn})`).join(" "))}</div>` : ""}
        <div class="pl-2">${scored.length ? scored.slice(0, 30).map((item) => `<span class="badge badge-xs ${item.resonance >= 2 ? "badge-warning" : "badge-success"} mr-0.5 mb-0.5" title="${_esc(`score:${item.score} cos:${item.cos ?? "-"} gold:${item.gold} [${(item.sources || []).join("+")}]`)}">${_esc(item.word)}</span>`).join("") + (scored.length > 30 ? `<span class="opacity-50">…+${scored.length - 30}</span>` : "") : `<span class="${pool.length ? "text-warning" : "opacity-50"}">${pool.length ? "Node3 审查后没有存活候选" : "Node2 无候选，Node3 无输入"}</span>`}</div>
      </details>
      <details open class="mt-1"><summary class="cursor-pointer font-bold text-xs">④ Node4 排序 / 召回摘要：锚点 ${anchors.length} · 匹配 ${rec?.rankedCount ?? 0} · 记忆 ${records.length}</summary>
        <div class="pl-2"><b>锚点:</b> ${_esc(anchors.map((anchor) => typeof anchor === "string" ? anchor : anchor?.word || anchor?.raw || "").filter(Boolean).join(" · ")) || "—"}</div>
        ${idx ? `<div class="pl-2 text-[11px] opacity-80">索引作用域: ${_esc(idx.scope?.username || "—")} / ${_esc(idx.scope?.charName || "—")} / ${_esc(idx.scope?.mode || mode)} · Markdown ${idx.scope?.includeMarkdown ? "开" : "关"} · ${idx.docCount || 0}条 · 对话上下文${idx.chatContextBound ? "已关联" : "未关联"}</div>` : '<div class="pl-2 text-[11px] text-warning">索引诊断未返回</div>'}
        ${records.map((record) => `<div class="bg-base-100/60 rounded px-2 py-1 mt-1"><span class="badge badge-xs badge-ghost mr-1">${_esc(record.layer || "?")}</span><span class="opacity-60">[${_esc((record.matchedTerms || []).slice(0, 6).join(","))}]</span> ${_esc(String(record.content || "").slice(0, 160))}</div>`).join("") || '<span class="opacity-50 pl-2">没有命中记忆记录</span>'}
      </details>
      <details class="mt-1"><summary class="cursor-pointer font-bold text-xs">完整 whitebox（Node0→Node4）</summary>
        ${whiteboxText ? `<pre class="mt-1 p-2 rounded bg-base-300/30 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed">${_esc(whiteboxText)}</pre>` : '<div class="pl-2 text-warning">响应未返回完整 whitebox</div>'}
      </details>`;
    }
    if (!_p1QuickIsCurrent(container, ticket, snapshot)) return;
    await _p1RefreshRunLog(container);
  } catch (e) {
    if (_p1QuickIsCurrent(container, ticket, snapshot) && out) {
      out.dataset.p1QuickState = "error";
      out.innerHTML = `<span class="text-error">召回异常: ${_esc(e?.message || e)}</span>`;
    }
  }
}

// ═══════════════════ 面板2：词库管理 ═══════════════════

export async function loadP1VocabPanel(container) {
  if (container._loaded) return;
  container._loaded = true;
  container.innerHTML = `<div class="p-3 text-xs space-y-3">
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">📚 AT 自更新词库 <span class="opacity-50 font-normal">（管线自学习写入；此处只读查询）</span></div>
      <div id="p1vocab-at" class="mb-2"><span class="opacity-50">加载中...</span></div>
      <div class="flex gap-2 items-center">
        <select id="p1vocab-at-mode" class="select select-xs select-bordered"><option>chat</option><option>code</option><option>work</option><option>airp</option></select>
        <input id="p1vocab-at-q" type="text" class="input input-xs input-bordered flex-1" placeholder="搜索术语（包含匹配，最多50条）" />
        <button id="p1vocab-at-search" class="btn btn-xs">搜索</button>
      </div>
      <div id="p1vocab-at-hits" class="mt-1 text-[11px]"></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">🔌 用户插拔词库 <span class="opacity-50 font-normal">（登录用户级共享；该用户的所有角色卡与对话互通，modes 控制在哪类记忆模式中参与召回）</span></div>
      <div id="p1vocab-user"><span class="opacity-50">加载中...</span></div>
      <div class="mt-2"><button id="p1vocab-new" class="btn btn-xs btn-primary">＋ 新建 / 编辑词库</button></div>
      <div id="p1vocab-editor" class="mt-2 hidden">
        <div class="flex gap-2 items-center mb-1">
          <input id="p1vocab-ed-file" type="text" class="input input-xs input-bordered w-52" placeholder="文件名，如 我的领域词库.json" />
          <button id="p1vocab-ed-save" class="btn btn-xs btn-primary">保存</button>
          <span class="opacity-50">格式: {"_meta":{"name":"...","modes":["all"],"enabled":true},"entries":{"词":["关联词1","关联词2"]}}</span>
        </div>
        <div class="relative expandable-container">
          <textarea id="p1vocab-ed-content" class="textarea textarea-bordered w-full font-mono text-[11px]" rows="8" data-expandable data-expand-title="用户插拔词库编辑">{
  "_meta": { "name": "我的词库", "modes": ["all"], "enabled": true },
  "entries": { "示例词": ["关联词1", "关联词2"] }
}</textarea>
          <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
        </div>
        <div id="p1vocab-ed-msg" class="opacity-60"></div>
      </div>
    </div>
  </div>`;
  container.querySelector("#p1vocab-at-search").addEventListener("click", () => _p1AtSearch(container));
  container.querySelector("#p1vocab-at-q").addEventListener("keydown", (e) => { if (e.key === "Enter") _p1AtSearch(container); });
  container.querySelector("#p1vocab-new").addEventListener("click", () => container.querySelector("#p1vocab-editor").classList.toggle("hidden"));
  container.querySelector("#p1vocab-ed-save").addEventListener("click", () => _p1SaveVocab(container));
  await _p1RefreshVocabs(container);
}

async function _p1RefreshVocabs(container) {
  try {
    const r = await _p1Action("listVocabs");
    // AT 词库行可点击浏览（0731 002骂点"点击不了,查了不了"）：点行→展开该模式维度列表（atBrowse 无 dim）
    // →点维度→分页词条（atBrowse 带 dim，每页50，复用 atSearch 同款 mtime 缓存，见插件 main.mjs atBrowse action）。
    const atBox = container.querySelector("#p1vocab-at");
    if (atBox) atBox.innerHTML = `<table class="table table-xs"><thead><tr><th>模式</th><th>文件</th><th>大小</th><th>更新时间</th></tr></thead><tbody>${(r?.at || []).map((a) => `
      <tr class="cursor-pointer hover:bg-base-100/60" data-atrow="${_esc(a.mode)}" title="点击浏览该模式词库维度/词条"><td>${_esc(a.mode)}</td><td class="opacity-60">${_esc(a.file)}</td><td>${a.missing ? '<span class="text-warning">缺失</span>' : (a.size / 1048576).toFixed(1) + "MB"}</td><td>${a.mtime ? new Date(a.mtime).toLocaleString() : "—"}</td></tr>
      <tr class="hidden" data-atdetail="${_esc(a.mode)}"><td colspan="4"><div class="p-2 bg-base-100/40 rounded text-[11px]" data-atbody></div></td></tr>`).join("")}</tbody></table>`;
    atBox?.querySelectorAll("[data-atrow]").forEach((tr) => tr.addEventListener("click", () => _p1AtToggleRow(container, tr.dataset.atrow)));
    const uBox = container.querySelector("#p1vocab-user");
    const users = r?.user || [];
    if (uBox) uBox.innerHTML = users.length
      ? `<table class="table table-xs"><thead><tr><th>词库</th><th>模式</th><th>词条</th><th>启用</th><th></th></tr></thead><tbody>${users.map((u) => u.broken
          ? `<tr><td>${_esc(u.file)}</td><td colspan="3" class="text-error">文件损坏（JSON 解析失败）</td><td><button class="btn btn-xs btn-ghost text-error" data-vdel="${_esc(u.file)}">删除</button></td></tr>`
          : `<tr><td title="${_esc(u.file)}">${_esc(u.name)}</td><td>${_esc((u.modes || []).join(","))}</td><td>${u.entryCount}</td><td><input type="checkbox" class="toggle toggle-xs" data-vtoggle="${_esc(u.file)}" ${u.enabled ? "checked" : ""}/></td><td><button class="btn btn-xs btn-ghost" data-vedit="${_esc(u.file)}">编辑</button><button class="btn btn-xs btn-ghost text-error" data-vdel="${_esc(u.file)}">删除</button></td></tr>`).join("")}</tbody></table>`
      : '<span class="opacity-50">暂无用户词库。新建后启用，召回池自动多一路 mode:user 扩展。</span>';
    uBox?.querySelectorAll("[data-vtoggle]").forEach((el) => el.addEventListener("change", async (e) => {
      const requested = e.target.checked;
      try {
        const result = await _p1Action("toggleUserVocab", { file: el.dataset.vtoggle, enabled: requested });
        if (result?.cacheInvalidated === false) window._beiluToast?.(result.cacheWarning || "词库状态已落盘，但召回缓存尚未确认刷新", "warning");
      }
      catch (error) {
        e.target.checked = !requested;
        window._beiluToast?.(`词库启停失败: ${error?.message || error}`, "error");
      }
    }));
    uBox?.querySelectorAll("[data-vdel]").forEach((el) => el.addEventListener("click", async () => {
      if (!confirm(`删除词库 ${el.dataset.vdel}？`)) return;
      try {
        const result = await _p1Action("deleteUserVocab", { file: el.dataset.vdel });
        if (result?.cacheInvalidated === false) window._beiluToast?.(result.cacheWarning || "词库已删除，但召回缓存尚未确认刷新", "warning");
        await _p1RefreshVocabs(container);
      } catch { /* 已报错 */ }
    }));
    uBox?.querySelectorAll("[data-vedit]").forEach((el) => el.addEventListener("click", async () => {
      try {
        const g = await _p1Action("getUserVocab", { file: el.dataset.vedit });
        if (!g?.success) return;
        container.querySelector("#p1vocab-editor").classList.remove("hidden");
        container.querySelector("#p1vocab-ed-file").value = g.file;
        container.querySelector("#p1vocab-ed-content").value = JSON.stringify(g.content, null, 2);
      } catch { /* 已报错 */ }
    }));
  } catch (e) {
    const b = container.querySelector("#p1vocab-user");
    if (b) b.innerHTML = `<span class="text-error">词库列表加载失败: ${_esc(e?.message || e)}</span>`;
  }
}

// 行展开/收起（手风琴：同一时刻只开一行）→ 拉该模式维度列表（atBrowse 不带 dim）
async function _p1AtToggleRow(container, mode) {
  const detailRow = container.querySelector(`[data-atdetail="${mode}"]`);
  if (!detailRow) return;
  const wasHidden = detailRow.classList.contains("hidden");
  container.querySelectorAll("[data-atdetail]").forEach((el) => el.classList.add("hidden"));
  if (!wasHidden) return; // 点已展开的行=收起，不重新加载
  detailRow.classList.remove("hidden");
  const body = detailRow.querySelector("[data-atbody]");
  if (body) body.innerHTML = '<span class="opacity-50">加载维度中（首次需解析词库文件）...</span>';
  try {
    const r = await _p1Action("atBrowse", { mode });
    if (!r?.success) { if (body) body.innerHTML = `<span class="text-error">${_esc(r?.error || "加载失败")}</span>`; return; }
    if (body) body.innerHTML = `<div class="opacity-50 mb-1">共 ${r.dims.length} 个维度，点击浏览词条：</div>
      <div class="flex flex-wrap gap-1 max-h-32 overflow-y-auto">${r.dims.map((d) => `<button class="btn btn-xs btn-ghost" data-atdim="${_esc(d.dim)}">${_esc(d.dim)} <span class="opacity-50">(${d.count})</span></button>`).join("")}</div>
      <div data-atterms class="mt-2"></div>`;
    body.querySelectorAll("[data-atdim]").forEach((btn) => btn.addEventListener("click", () => _p1AtLoadDim(container, mode, btn.dataset.atdim, 0)));
  } catch (e) { if (body) body.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

// 维度下词条分页浏览（atBrowse 带 dim，每页50，offset 翻页）
async function _p1AtLoadDim(container, mode, dim, offset) {
  const detailRow = container.querySelector(`[data-atdetail="${mode}"]`);
  const termsBox = detailRow?.querySelector("[data-atterms]");
  if (!termsBox) return;
  termsBox.innerHTML = '<span class="opacity-50">加载词条中...</span>';
  try {
    // limit 单源=后端 atBrowseLimitDefault（getData 平铺配置，_p1Config 快照）；未拉到时用同值兜底，零行为变化
    const _limit = Number(_p1Config.atBrowseLimitDefault) || 50;
    const r = await _p1Action("atBrowse", { mode, dim, offset, limit: _limit });
    if (!r?.success) { termsBox.innerHTML = `<span class="text-error">${_esc(r?.error || "加载失败")}</span>`; return; }
    const { entries, total, limit } = r;
    termsBox.innerHTML = `<div class="font-bold mb-1">${_esc(dim)}（共 ${total} 词，第 ${offset + 1}-${Math.min(offset + limit, total)} 条）</div>` +
      (entries.map((en) => `<div class="bg-base-200/40 rounded px-2 py-1 mb-1"><b>${_esc(en.term)}</b> <span class="opacity-60">${_esc((en.concepts || []).slice(0, 8).join(" · "))}</span></div>`).join("") || '<span class="opacity-50">该维度无词条</span>') +
      `<div class="flex gap-2 mt-1">
        <button class="btn btn-xs" data-atpage="prev" ${offset <= 0 ? "disabled" : ""}>上一页</button>
        <button class="btn btn-xs" data-atpage="next" ${offset + limit >= total ? "disabled" : ""}>下一页</button>
      </div>`;
    termsBox.querySelector('[data-atpage="prev"]')?.addEventListener("click", () => _p1AtLoadDim(container, mode, dim, Math.max(0, offset - limit)));
    termsBox.querySelector('[data-atpage="next"]')?.addEventListener("click", () => _p1AtLoadDim(container, mode, dim, offset + limit));
  } catch (e) { termsBox.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

async function _p1AtSearch(container) {
  const q = container.querySelector("#p1vocab-at-q")?.value?.trim();
  const mode = container.querySelector("#p1vocab-at-mode")?.value || "chat";
  const box = container.querySelector("#p1vocab-at-hits");
  if (!q) { if (box) box.innerHTML = '<span class="opacity-50">请输入搜索词</span>'; return; }
  if (box) box.innerHTML = '<span class="opacity-50">搜索中（首次需解析词库文件）...</span>';
  try {
    const r = await _p1Action("atSearch", { mode, q });
    if (box) box.innerHTML = r?.success
      ? (r.hits.length ? r.hits.map((h) => `<span class="badge badge-sm badge-ghost mr-1 mb-1" title="维度: ${_esc(h.dim)}">${_esc(h.term)}</span>`).join("") + (r.truncated ? '<span class="opacity-50">（已截断50条）</span>' : "")
        : '<span class="opacity-50">无匹配术语</span>')
      : `<span class="text-error">${_esc(r?.error)}</span>`;
  } catch (e) { if (box) box.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

async function _p1SaveVocab(container) {
  const file = container.querySelector("#p1vocab-ed-file")?.value?.trim();
  const msg = container.querySelector("#p1vocab-ed-msg");
  let content;
  try { content = JSON.parse(container.querySelector("#p1vocab-ed-content").value); }
  catch (e) { if (msg) msg.textContent = `JSON 格式错误: ${e.message}`; return; }
  try {
    const r = await _p1Action("saveUserVocab", { file, content });
    if (msg) msg.textContent = r?.cacheInvalidated === false
      ? `已保存（${r.entryCount} 词条），但召回缓存未确认刷新：${r.cacheWarning || "请稍后重试"}`
      : `已保存（${r.entryCount} 词条；下一次召回立即读取）`;
    if (r?.success) await _p1RefreshVocabs(container);
  } catch (e) { if (msg) msg.textContent = `保存失败: ${e?.message || e}`; }
}

// ═══════════════════ 面板3：P9 词库维护（就地完整编辑区） ═══════════════════
//
// [0731 002 终版] "把这两个恶心的垃圾给我删除...仿照code的子模式做前端,也就是完整的编辑前端.
//   把那两个垃圾给我替换"：原绿条"已注册"横幅 + "使用与编辑"跳转指路块删除（旧死代码
//   _p1P9EnsureSubMode 一并清），改为完整编辑前端，两块就地编辑、零跳转：
//   ① 子模式实体区（照 companion.mjs 单实体范式 :1614-1718）：缺失即注册（append→saveSubModes，
//      后端 _ensureSubModePresetsFor 幂等补建同名预设；默认预设已随播种存在时跳过）；参数只写
//      model_params 蛇形键（getPromptHandler:299-336 每轮生效载体，空=删键不覆盖、0 合法）；
//      绑定=activateSubMode{id,chatId} 受控对齐 chat 模式后写 active_sub_modes_map[所选对话]（目标优先跟随当前窗口，
//      无法证明时由用户从同一角色归属清单显式选择；chat 组子模式刻意
//      不进 code/work 选择器——subModePanel:940-944 组过滤，本面板即其唯一管理 UI）。
//   ② 提示词区：就地编辑绑定预设条目，与预设面板同一数据契约（getDataForPreset 读 /
//      updatePresetConfig{_target_preset, update_entry|toggle_entry|add_entry|delete_entry|
//      reorder_entries} 写，settings/panels.mjs:296-513 同源）；marker 条目内容锁定（运行时
//      从模块提取）。放大=data-expandable（expandEditor 自动接管）；复制按钮写剪贴板。
//   提示词正文=用户域（铁律：代码禁产生进对话的文本）——本面板与默认件均不写正文。

const _P9_SM_ID = "P9词库维护";
// ST 8 marker 位（与预设面板 MARKERS 同集合）：内容运行时从对应模块提取，编辑器只放行名称/角色/启用/顺序
const _P9_MARKERS = ["personaDescription", "worldInfoBefore", "charDescription", "charPersonality", "scenario", "worldInfoAfter", "dialogueExamples", "chatHistory"];
const _P9_NUM_FIELDS = [ // [model_params 蛇形键=param_schema 键, DOM id]
  ["temperature", "p9-sm-temperature"], ["max_tokens", "p9-sm-max-tokens"],
  ["max_context", "p9-sm-max-context"], ["top_p", "p9-sm-top-p"],
  ["top_k", "p9-sm-top-k"], ["min_p", "p9-sm-min-p"],
];
let _p9All = [];      // getSubModes 全表引用（saveSubModes 整表覆盖语义：必须持全量写回）
let _p9Entity = null; // P9 实体（_p9All 内成员引用）
let _p9EnumSchema = null;
let _p9ApiSources = null;
let _p9ModelReq = 0;  // 模型下拉竞态票据（同 companion._soModelReq）
let _p9Entries = [];  // 绑定预设条目工作副本
let _p9EntrySel = null;

function _p9ChatCharName(chat) {
  return String(chat?.primaryCharName || "").trim();
}

function _p9ChatBelongsToPrimaryChar(chat, charName) {
  const expected = String(charName || "").trim();
  return !!expected && _p9ChatCharName(chat) === expected;
}

// P9 的实体 modeGroup 固定为 chat。这里使用服务端 getChatList 下发的原始 mode / usedByModes
// 证明该对话确属 chat 组，不复用快速测试的 smart→chat 等展示归一，避免写入一个真实消费不到的 map。
function _p9ChatSupportsChatGroup(chat) {
  const storedMode = String(chat?.mode || "").trim().toLowerCase();
  const usedByModes = Array.isArray(chat?.usedByModes)
    ? chat.usedByModes.map((mode) => String(mode || "").trim().toLowerCase())
    : [];
  return storedMode === "chat" || usedByModes.includes("chat");
}

function _p9TargetSnapshot(container) {
  const charName = String(container.querySelector("#p9-sm-target-char")?.value || "").trim();
  const chatId = String(container.querySelector("#p9-sm-target-chat")?.value || "").trim();
  const selectedChat = (container._p9TargetChats || []).find((chat) => _p1QuickChatId(chat) === chatId);
  const missing = [];
  if (!charName) missing.push("角色卡");
  if (!chatId) missing.push("对话 ID");
  if (chatId && !selectedChat) missing.push("对话有效性");
  if (selectedChat && !_p9ChatBelongsToPrimaryChar(selectedChat, charName)) missing.push("对话归属");
  if (selectedChat && !_p9ChatSupportsChatGroup(selectedChat)) missing.push("聊天组归属");
  return {
    charName,
    chatId,
    chat: selectedChat || null,
    mode: selectedChat ? "chat" : "",
    error: missing.length ? new Error(`绑定目标不完整：${missing.join("、")}`) : null,
  };
}

function _p9SetTargetStatus(container, message, tone = "") {
  const status = container.querySelector("#p9-sm-target-status");
  if (!status) return;
  const warning = container._p9CatalogWarning ? `；${container._p9CatalogWarning}` : "";
  status.className = `text-[10px] ${tone === "error" ? "text-error" : tone === "warning" ? "text-warning" : "opacity-60"}`;
  status.textContent = `${message}${warning}`;
}

function _p9RenderTargetChats(container, preferredChatId = "") {
  const charSelect = container.querySelector("#p9-sm-target-char");
  const chatSelect = container.querySelector("#p9-sm-target-chat");
  if (!charSelect || !chatSelect) return;
  const charName = String(charSelect.value || "").trim();
  const chats = (container._p9TargetChats || []).filter((chat) => _p9ChatBelongsToPrimaryChar(chat, charName) && _p9ChatSupportsChatGroup(chat));
  chatSelect.innerHTML = '<option value="">请选择对话 ID…</option>';
  for (const chat of chats) {
    const id = _p1QuickChatId(chat);
    if (!id) continue;
    const option = document.createElement("option");
    const title = String(chat?.customName || chat?.title || chat?.name || chat?.firstUserMessage || "对话").trim();
    const storedMode = String(chat?.mode || "").trim() || "未分类";
    const usedBy = Array.isArray(chat?.usedByModes) && chat.usedByModes.length ? ` / 在用:${chat.usedByModes.join(",")}` : "";
    option.value = id;
    option.textContent = `${title} · ${id} · ${storedMode}${usedBy}`;
    option.title = `${charName} / ${id} / chat 组（存储分类:${storedMode}${usedBy}）`;
    chatSelect.appendChild(option);
  }
  if (preferredChatId && chats.some((chat) => _p1QuickChatId(chat) === preferredChatId)) {
    chatSelect.value = preferredChatId;
  }
  chatSelect.disabled = !charName || chats.length === 0;
}

/**
 * P9 是配置面板，不是 code 对话窗口本身：先采纳 lineManager 完整绑定；没有活动线时，
 * 只允许采用“当前 hash/主窗口 chatId 在服务端清单中存在且能反查角色”的目标。
 * 不能证明当前对话时只预选已知角色，不猜第一条对话，由用户显式选择 ID。
 */
function _p9ResolveCurrentTarget(container) {
  const chats = container._p9TargetChats || [];
  let strict = null;
  let strictError = null;
  try { strict = _p1CurrentBinding(); } catch (error) { strictError = error; }
  const observedBinding = strict || strictError?.binding || null;
  const observedMode = String(observedBinding?.mode || "").trim().toLowerCase();
  // lineManager 已明确当前是 code/work/smart，或明确是多窗口但绑定尚未齐全时，主 hash 可能仍停在
  // 另一条旧 chat 线。此时禁止把 hash 伪装成“当前窗口”；仅保留角色预选，要求用户显式选 chat。
  const hashFallbackBlocked = observedBinding?.multiWindow === true || (!!observedMode && observedMode !== "chat");
  const candidates = [];
  if (strict?.chatId && String(strict.mode || "").trim().toLowerCase() === "chat") {
    candidates.push({ id: strict.chatId, source: "本体当前聊天" });
  }
  if (!hashFallbackBlocked) {
    try {
      const id = String(window._beiluGetChatId?.() || "").trim();
      if (id) candidates.push({ id, source: "本体当前对话" });
    } catch { /* hash 未就绪 */ }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const chat = chats.find((item) => _p1QuickChatId(item) === candidate.id);
    const charName = _p9ChatCharName(chat);
    if (!chat || !charName || !_p9ChatBelongsToPrimaryChar(chat, charName) || !_p9ChatSupportsChatGroup(chat)) continue;
    return { charName, chatId: candidate.id, source: candidate.source };
  }
  const knownChars = [];
  if (observedBinding?.charName) knownChars.push(observedBinding.charName);
  try { knownChars.push(String(window._beiluGetCharName?.() || "").trim()); } catch { /* 未就绪 */ }
  try { knownChars.push(String(window._beiluGetCharId?.() || "").trim()); } catch { /* 未就绪 */ }
  const available = new Set([...container.querySelectorAll("#p9-sm-target-char option")].map((option) => option.value));
  const charName = knownChars.find((name) => name && available.has(name)) || "";
  return { charName, chatId: "", source: "" };
}

async function _p9UseCurrentTarget(container) {
  const charSelect = container.querySelector("#p9-sm-target-char");
  if (!charSelect) return;
  container._p9TargetMode = "current";
  const target = _p9ResolveCurrentTarget(container);
  if (target.charName && [...charSelect.options].some((option) => option.value === target.charName)) {
    charSelect.value = target.charName;
  } else charSelect.value = "";
  _p9RenderTargetChats(container, target.chatId);
  if (target.chatId) {
    _p9SetTargetStatus(container, `已自动识别：${target.source}；可手动改选角色卡与对话 ID`);
  } else if (target.charName) {
    _p9SetTargetStatus(container, `已识别角色卡「${target.charName}」，当前对话无法从窗口绑定中证明，请手动选择对话 ID`, "warning");
  } else {
    _p9SetTargetStatus(container, "当前窗口没有可验证的角色/对话绑定，请手动选择角色卡与对话 ID", "warning");
  }
  await _p9RefreshBindStatus(container);
}

async function _p9LoadTargets(container) {
  const charSelect = container.querySelector("#p9-sm-target-char");
  const chatSelect = container.querySelector("#p9-sm-target-chat");
  const refresh = container.querySelector("#p9-sm-target-refresh");
  if (!charSelect || !chatSelect) return;
  const ticket = (container._p9TargetTicket || 0) + 1;
  container._p9TargetTicket = ticket;
  const previousChar = charSelect.value;
  const previousChat = chatSelect.value;
  charSelect.disabled = true;
  chatSelect.disabled = true;
  if (refresh) refresh.disabled = true;
  _p9SetTargetStatus(container, "正在加载角色卡与对话清单…");
  try {
    const catalog = await _p1LoadScopeCatalog("");
    if (container._p9TargetTicket !== ticket || !container.isConnected) return;
    container._p9TargetChats = catalog.chats.filter(_p9ChatSupportsChatGroup);
    container._p9CatalogWarning = catalog.charListFailed ? "角色清单读取失败，已从对话归属反推" : "";
    charSelect.innerHTML = '<option value="">请选择角色卡…</option>';
    for (const name of catalog.chars) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      charSelect.appendChild(option);
    }
    if (container._p9TargetMode === "manual" && catalog.chars.includes(previousChar)) {
      charSelect.value = previousChar;
      _p9RenderTargetChats(container, previousChat);
      _p9SetTargetStatus(container, "已保留手动选择；修改角色卡或对话 ID 后会重新读取绑定状态");
      await _p9RefreshBindStatus(container);
    } else {
      await _p9UseCurrentTarget(container);
    }
  } catch (error) {
    container._p9TargetChats = [];
    container._p9CatalogWarning = "";
    charSelect.innerHTML = '<option value="">角色清单不可用</option>';
    chatSelect.innerHTML = '<option value="">对话清单不可用</option>';
    _p9SetTargetStatus(container, `绑定目标加载失败：${error?.message || error}`, "error");
    const bindStatus = container.querySelector("#p9-sm-status");
    if (bindStatus) bindStatus.innerHTML = '<span class="text-error">无法读取对话清单，绑定操作已禁用</span>';
    for (const button of [container.querySelector("#p9-sm-bind"), container.querySelector("#p9-sm-unbind")]) {
      if (button) button.disabled = true;
    }
  } finally {
    if (container._p9TargetTicket === ticket) {
      charSelect.disabled = charSelect.options.length <= 1;
      chatSelect.disabled = chatSelect.options.length <= 1;
      if (refresh) refresh.disabled = false;
    }
  }
}

export async function loadP1P9Panel(container) {
  if (container._loaded) {
    if (container._p9CatalogDirty) {
      container._p9CatalogDirty = false;
      await _p9LoadTargets(container);
    }
    return;
  }
  container._loaded = true;
  container.innerHTML = `<div class="p-3 text-xs space-y-3" id="p1p9-root">
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">⚙️ P9 子模式配置 <span class="opacity-50 font-normal">（聊天组子模式；参数每轮生效，预设在绑定对话时应用）</span></div>
      <div id="p9-sm-status" class="mb-2 text-[11px]"><span class="opacity-50">加载中...</span></div>
      <div class="mb-3 p-2 rounded border border-base-300/40 bg-base-100/30">
        <div class="font-semibold mb-1">绑定目标 <span class="opacity-50 font-normal">（优先自动识别；无法证明当前窗口时由用户选择）</span></div>
        <div class="grid grid-cols-1 md:grid-cols-[minmax(8rem,0.75fr)_minmax(14rem,1.6fr)_auto] gap-2 items-end">
          <label class="flex flex-col gap-0.5"><span class="opacity-60">角色卡</span><select id="p9-sm-target-char" class="select select-xs select-bordered w-full"><option>加载中…</option></select></label>
          <label class="flex flex-col gap-0.5"><span class="opacity-60">对话 ID</span><select id="p9-sm-target-chat" class="select select-xs select-bordered w-full"><option>加载中…</option></select></label>
          <div class="flex gap-1"><button id="p9-sm-target-current" class="btn btn-xs">使用当前窗口</button><button id="p9-sm-target-refresh" class="btn btn-xs btn-ghost" title="刷新角色卡与对话清单"><i data-ic="refresh"></i></button></div>
        </div>
        <div id="p9-sm-target-status" class="mt-1 text-[10px] opacity-60">加载中...</div>
      </div>
      <div id="p9-sm-form" class="grid grid-cols-2 md:grid-cols-3 gap-2 hidden">
        <label class="flex flex-col gap-0.5"><span class="opacity-60">描述</span><input id="p9-sm-desc" type="text" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">绑定预设</span><input id="p9-sm-preset" type="text" list="p9-sm-preset-list" class="input input-xs input-bordered" placeholder="${_P9_SM_ID}" /><datalist id="p9-sm-preset-list"></datalist></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">API 源（空=不覆盖）</span><select id="p9-sm-api" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">绑定模型（空=源默认）</span><select id="p9-sm-model" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">提示词后处理</span><select id="p9-sm-pp" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">尾部预填充模式</span><select id="p9-sm-prefill-mode" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">预填充启用</span><select id="p9-sm-prefill-enabled" class="select select-xs select-bordered"><option value="">（不覆盖）</option><option value="on">开</option><option value="off">关</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">温度</span><input id="p9-sm-temperature" type="number" min="0" max="2" step="0.01" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">最大上下文</span><input id="p9-sm-max-context" type="number" min="0" step="1024" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">最大输出</span><input id="p9-sm-max-tokens" type="number" min="0" step="256" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">Top-P</span><input id="p9-sm-top-p" type="number" min="0" max="1" step="0.01" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">Top-K</span><input id="p9-sm-top-k" type="number" min="0" max="500" step="1" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">Min-P</span><input id="p9-sm-min-p" type="number" min="0" max="1" step="0.01" placeholder="默认" class="input input-xs input-bordered" /></label>
      </div>
      <div class="mt-2 flex gap-2 items-center flex-wrap">
        <button id="p9-sm-save" class="btn btn-xs btn-primary">保存配置</button>
        <button id="p9-sm-bind" class="btn btn-xs">绑定所选对话</button>
        <button id="p9-sm-unbind" class="btn btn-xs btn-ghost">解绑所选对话</button>
        <span id="p9-sm-msg" class="opacity-60"></span>
      </div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">📝 提示词编辑 <span class="opacity-50 font-normal">（就地编辑绑定预设条目，与预设面板同一数据源）</span></div>
      <div id="p9-pr-split-pane" class="flex border border-base-300/40 rounded" style="min-height:200px;max-height:440px;">
        <div id="p9-pr-list" class="shrink-0 border-r border-base-300/30 overflow-y-auto" style="width:34%;"></div>
        <div id="p9-pr-split" class="flex-none bg-base-content/10 hover:bg-warning/50 rounded mx-1" style="width:5px;cursor:col-resize;touch-action:none;" title="拖动调整条目列表与编辑区宽度"></div>
        <div id="p9-pr-editor" class="flex-1 overflow-y-auto p-2 min-w-0"><div class="text-center opacity-40 py-8">未选择条目。从左侧列表选择后在此编辑</div></div>
      </div>
      <div class="mt-2 flex gap-2 items-center"><button id="p9-pr-add" class="btn btn-xs btn-outline">＋ 添加条目</button><button id="p9-pr-refresh" class="btn btn-xs btn-ghost">刷新</button><button id="p9-pr-restore" class="btn btn-xs btn-warning btn-outline">恢复默认预设</button><span id="p9-pr-msg" class="opacity-60"></span></div>
    </div>
  </div>`;
  initHorizontalSplitPane({
    container: container.querySelector("#p9-pr-split-pane"),
    primary: container.querySelector("#p9-pr-list"),
    handle: container.querySelector("#p9-pr-split"),
    storageKey: KEYS.BEILU_P9_PRESET_SPLIT,
    defaultPercent: 34,
    minPercent: 18,
    maxPercent: 72,
    keyboardStep: 5,
  });
  container.querySelector("#p9-sm-save").addEventListener("click", () => _p9SaveEntity(container));
  container.querySelector("#p9-sm-bind").addEventListener("click", () => _p9Bind(container, true));
  container.querySelector("#p9-sm-unbind").addEventListener("click", () => _p9Bind(container, false));
  container._p9TargetMode = "current";
  container.querySelector("#p9-sm-target-char").addEventListener("change", () => {
    container._p9TargetMode = "manual";
    _p9RenderTargetChats(container);
    _p9SetTargetStatus(container, "已切换为手动目标，请选择对话 ID");
    void _p9RefreshBindStatus(container);
  });
  container.querySelector("#p9-sm-target-chat").addEventListener("change", () => {
    container._p9TargetMode = "manual";
    _p9SetTargetStatus(container, "已使用手动选择的角色卡与对话 ID");
    void _p9RefreshBindStatus(container);
  });
  container.querySelector("#p9-sm-target-current").addEventListener("click", () => { void _p9UseCurrentTarget(container); });
  container.querySelector("#p9-sm-target-refresh").addEventListener("click", () => { void _p9LoadTargets(container); });
  let targetSyncQueued = false;
  const scheduleTargetSync = () => {
    if (targetSyncQueued || container._p9TargetMode === "manual") return;
    targetSyncQueued = true;
    queueMicrotask(() => {
      targetSyncQueued = false;
      if (container.isConnected && container._p9TargetMode !== "manual") void _p9UseCurrentTarget(container);
    });
  };
  for (const eventName of ["beilu:window-switched", "character-switched", "beilu:char-changed"]) {
    window.addEventListener(eventName, scheduleTargetSync);
  }
  let catalogRefreshTimer = null;
  window.addEventListener("beilu:chat-list-changed", () => {
    if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
    catalogRefreshTimer = setTimeout(() => {
      catalogRefreshTimer = null;
      if (!container.isConnected) return;
      if (container.classList.contains("hidden")) {
        container._p9CatalogDirty = true;
        return;
      }
      void _p9LoadTargets(container);
    }, 300);
  });
  container.querySelector("#p9-sm-api").addEventListener("change", (e) => _p9FillModels(container, e.target.value, ""));
  container.querySelector("#p9-pr-add").addEventListener("click", () => _p9AddEntry(container));
  container.querySelector("#p9-pr-refresh").addEventListener("click", () => _p9LoadEntries(container));
  container.querySelector("#p9-pr-restore")?.addEventListener("click", async () => {
    const msg = container.querySelector("#p9-pr-msg");
    const presetName = _p9PresetName();
    if (!confirm(`恢复预设「${presetName}」的核心默认内容？\n\n当前自定义修改会被覆盖。`)) return;
    try {
      if (msg) msg.textContent = "正在恢复默认预设...";
      const result = await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { restore_preset: { name: presetName } } });
      if (result?.success === false) throw new Error(result.error || result.message || "恢复失败");
      if (!result?.restored) { if (msg) msg.textContent = result?.message || "后端未确认预设已恢复"; return; }
      if (msg) msg.textContent = result.message || "已从核心默认件恢复";
      window._beiluToast?.(result.message || "P9 预设已从核心默认件恢复", "success");
      await _p9LoadEntries(container);
    } catch (e) { if (msg) msg.textContent = `恢复失败: ${e?.message || e}`; }
  });
  const ok = await _p9EnsureEntity(container);
  if (!ok) return; // 后端不可达：状态行已显示错误，不渲染半态表单
  await _p9FillForm(container);
  await _p9LoadTargets(container);
  _p9LoadEntries(container);
}

// 实体确保（幂等；照 companion._soEnsureEntity 序列）：缺失=append→saveSubModes 落盘，
// 后端写入路径同步补建同名预设（_ensureSubModePresetsFor；默认预设播种在先时命中跳过）。
async function _p9EnsureEntity(container) {
  const st = container.querySelector("#p9-sm-status");
  try {
    const d = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web" });
    _p9All = Array.isArray(d?.sub_modes) ? d.sub_modes : [];
    if (d?.enum_schema) { _p9EnumSchema = d.enum_schema; setEnumSchema(d.enum_schema); }
    if (d?.param_schema) setParamSchema(d.param_schema); // 数值控件限值后端单源（共享缓存）
    _p9Entity = _p9All.find((m) => m && m.id === _P9_SM_ID) || null;
    if (!_p9Entity) {
      _p9Entity = { id: _P9_SM_ID, label: "P9 词库维护", desc: "根据最近对话与记忆维护 P1 插拔词库", modeGroup: "chat", presetName: _P9_SM_ID, model_params: {} };
      _p9All = [..._p9All, _p9Entity];
      const saved = await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _p9All } });
      if (saved?.success !== true) throw new Error(saved?.error || "子模式注册未获得成功确认");
    }
    return true;
  } catch (e) {
    if (st) st.innerHTML = `<span class="text-error">P9 子模式加载失败: ${_esc(e?.message || e)}</span>`;
    return false;
  }
}

function _p9FillEnumSel(container, elId, key) {
  const el = container.querySelector(`#${elId}`);
  if (!el) return;
  const keep = el.value;
  el.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
  const opts = Array.isArray(_p9EnumSchema?.[key]?.options) ? _p9EnumSchema[key].options : [];
  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label || opt.value;
    if (opt.title) o.title = opt.title;
    el.appendChild(o);
  }
  el.value = keep;
}

// 模型候选跟随所选 API 源实时拉（force+竞态票据丢弃，同 companion._soFillModelSel/memtool._populatePseriesModels）
async function _p9FillModels(container, apiSource, currentModel) {
  const sel = container.querySelector("#p9-sm-model");
  if (!sel) return;
  sel.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
  const cur = currentModel || "";
  if (cur) { const o = document.createElement("option"); o.value = cur; o.textContent = `${cur}（已绑定）`; sel.appendChild(o); }
  sel.value = cur;
  if (!apiSource) return; // 未绑源：无从拉列表，仅保留已绑定项
  const req = ++_p9ModelReq;
  let models = [];
  try { models = window._beiluGetModelList ? await window._beiluGetModelList(apiSource, { force: true }) : []; } catch { /* 拉取失败：仅保留已绑定项 */ }
  if (req !== _p9ModelReq) return;
  if (!(models || []).length) {
    const warn = document.createElement("option");
    warn.disabled = true;
    warn.textContent = "⚠ 未获取到模型列表（检查该 API 源的 URL/Key）";
    sel.appendChild(warn);
    return;
  }
  for (const id of models) {
    if (!id || id === cur) continue;
    const o = document.createElement("option"); o.value = id; o.textContent = id; sel.appendChild(o);
  }
  sel.value = cur;
}

async function _p9FillForm(container) {
  const form = container.querySelector("#p9-sm-form");
  const sm = _p9Entity;
  if (!form || !sm) return;
  form.classList.remove("hidden");
  const mp = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params : {};
  const descEl = container.querySelector("#p9-sm-desc"); if (descEl) descEl.value = sm.desc || "";
  const pEl = container.querySelector("#p9-sm-preset"); if (pEl) pEl.value = sm.presetName || "";
  // 预设候选 datalist（同 companion._soFillPresetList 单源；失败=手输退化）
  try {
    const d = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
    const dl = container.querySelector("#p9-sm-preset-list");
    if (dl && Array.isArray(d?.preset_list)) dl.innerHTML = d.preset_list.map((n) => `<option value="${_esc(String(n))}"></option>`).join("");
  } catch { /* 候选空，手输仍可用 */ }
  // API 源下拉（getAISources 面板生命周期单次缓存；存储值不在列表也保留可选=诚实显示）
  const srcSel = container.querySelector("#p9-sm-api");
  if (srcSel) {
    if (!Array.isArray(_p9ApiSources)) {
      try {
        const list = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
        _p9ApiSources = Array.isArray(list) ? list.map((s) => (typeof s === "string" ? s : s.name || s.id || String(s))) : [];
      } catch { _p9ApiSources = []; }
    }
    const names = [..._p9ApiSources];
    if (mp.api_source && !names.includes(mp.api_source)) names.unshift(mp.api_source);
    srcSel.innerHTML = '<option value="">（不覆盖）</option>' + names.map((n) => `<option value="${_esc(n)}" ${n === mp.api_source ? "selected" : ""}>${_esc(n)}</option>`).join("");
  }
  _p9FillModels(container, mp.api_source || "", mp.model || "");
  for (const [key, elId] of _P9_NUM_FIELDS) {
    const el = container.querySelector(`#${elId}`);
    if (el) el.value = (mp[key] !== undefined && mp[key] !== null) ? mp[key] : "";
  }
  _p9FillEnumSel(container, "p9-sm-pp", "prompt_post_processing");
  _p9FillEnumSel(container, "p9-sm-prefill-mode", "claude_prefill_mode");
  const ppEl = container.querySelector("#p9-sm-pp"); if (ppEl) ppEl.value = mp.prompt_post_processing ?? "";
  const pmEl = container.querySelector("#p9-sm-prefill-mode"); if (pmEl) pmEl.value = mp.claude_prefill_mode ?? "";
  const peEl = container.querySelector("#p9-sm-prefill-enabled"); if (peEl) peEl.value = (mp.prefill_enabled === true) ? "on" : (mp.prefill_enabled === false) ? "off" : "";
  applyParamSchemaToInputs(_P9_NUM_FIELDS.map(([key, elId]) => [key, elId]));
}

// 保存实体：参数只写 model_params 蛇形键；空=删键不覆盖、显式值（含 0）原样存（companion :1701-1710 同语义）
async function _p9SaveEntity(container) {
  const sm = _p9Entity;
  const msg = container.querySelector("#p9-sm-msg");
  if (!sm) return;
  const descV = container.querySelector("#p9-sm-desc")?.value?.trim() ?? "";
  if (descV) sm.desc = descV;
  const pv = container.querySelector("#p9-sm-preset")?.value?.trim() || "";
  if (pv) sm.presetName = pv; else delete sm.presetName;
  if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
  const mp = sm.model_params;
  const modelV = container.querySelector("#p9-sm-model")?.value?.trim() || "";
  if (modelV) mp.model = modelV; else delete mp.model;
  const srcV = container.querySelector("#p9-sm-api")?.value || "";
  if (srcV) mp.api_source = srcV; else delete mp.api_source;
  for (const [key, elId] of _P9_NUM_FIELDS) {
    const raw = container.querySelector(`#${elId}`)?.value;
    if (raw === "" || raw === undefined || raw === null) delete mp[key];
    else { const n = Number(raw); if (Number.isFinite(n)) mp[key] = n; else delete mp[key]; }
  }
  const ppV = container.querySelector("#p9-sm-pp")?.value || ""; if (ppV) mp.prompt_post_processing = ppV; else delete mp.prompt_post_processing;
  const pmV = container.querySelector("#p9-sm-prefill-mode")?.value || ""; if (pmV) mp.claude_prefill_mode = pmV; else delete mp.claude_prefill_mode;
  const peV = container.querySelector("#p9-sm-prefill-enabled")?.value || "";
  if (peV === "on") mp.prefill_enabled = true; else if (peV === "off") mp.prefill_enabled = false; else delete mp.prefill_enabled;
  try {
    const saved = await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _p9All } });
    if (saved?.success !== true) throw new Error(saved?.error || "保存未获得成功确认");
    if (msg) msg.textContent = "已保存（参数下轮生效；预设在绑定对话时应用）";
    _p9LoadEntries(container); // presetName 可能改了：提示词区跟随新绑定预设
  } catch (e) { if (msg) msg.textContent = `保存失败: ${e?.message || e}`; }
}

// 绑定状态回显：读 active_sub_modes_map[所选对话]（setActiveSubMode 空 payload=纯读，companion :1632 同法）
async function _p9RefreshBindStatus(container) {
  const st = container.querySelector("#p9-sm-status");
  if (!st) return;
  const ticket = (container._p9BindStatusTicket || 0) + 1;
  container._p9BindStatusTicket = ticket;
  const target = _p9TargetSnapshot(container);
  for (const button of [container.querySelector("#p9-sm-bind"), container.querySelector("#p9-sm-unbind")]) {
    if (button) button.disabled = !!target.error || !!container._p9MutationPromise;
  }
  if (target.error) {
    st.innerHTML = `<span class="text-warning">${_esc(target.error.message)}；请选择后再绑定</span>`;
    return;
  }
  try {
    const r = await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: {} });
    if (container._p9BindStatusTicket !== ticket || !container.isConnected) return;
    const current = _p9TargetSnapshot(container);
    if (current.error || current.chatId !== target.chatId || current.charName !== target.charName) return;
    if (r?.success !== true || !r?.active_sub_modes_map || typeof r.active_sub_modes_map !== "object") {
      throw new Error(r?.error || "后端未返回完整绑定状态");
    }
    const act = r?.active_sub_modes_map?.[target.chatId] || "";
    if (act === _P9_SM_ID) {
      st.innerHTML = `<span class="badge badge-sm badge-success">已绑定所选对话</span> <span class="opacity-60">${_esc(target.charName)} / ${_esc(target.chatId)} 每轮使用 P9 参数；预设以绑定操作回执和当前预设显示为准</span>`;
    } else if (act) {
      const boundEntity = _p9All.find((item) => item?.id === act);
      const boundGroup = String(boundEntity?.modeGroup || "").trim();
      st.innerHTML = !boundEntity
        ? `<span class="text-warning">所选对话已有来源不可验证的子模式「${_esc(act)}」，不会覆盖</span>`
        : boundGroup !== "chat"
          ? `<span class="text-warning">所选对话已由 ${_esc(boundGroup || "code")} 组子模式「${_esc(act)}」占用；为防丢失别组绑定，请先在对应模式解除</span>`
          : `<span class="opacity-60">所选对话绑定的是「${_esc(act)}」——点「绑定所选对话」可在 chat 组内改绑 P9</span>`;
    } else {
      st.innerHTML = '<span class="opacity-60">所选对话未绑定子模式——点「绑定所选对话」启用 P9</span>';
    }
  } catch (e) {
    if (container._p9BindStatusTicket === ticket && container.isConnected) st.innerHTML = `<span class="text-error">绑定状态读取失败: ${_esc(e?.message || e)}</span>`;
  }
}

// 绑定/解绑所选对话（companion._soSyncActivation 同链）：解绑只清自己的 id，不动他方写入（防越权覆盖）
async function _p9Bind(container, on) {
  if (container._p9MutationPromise) return container._p9MutationPromise;
  const msg = container.querySelector("#p9-sm-msg");
  const target = _p9TargetSnapshot(container);
  if (target.error) { if (msg) msg.textContent = `${target.error.message}；请先选择角色卡与对话 ID`; return; }
  const controls = ["#p9-sm-bind", "#p9-sm-unbind", "#p9-sm-target-char", "#p9-sm-target-chat", "#p9-sm-target-current", "#p9-sm-target-refresh"]
    .map((selector) => container.querySelector(selector)).filter(Boolean);
  for (const control of controls) control.disabled = true;
  const operation = (async () => {
    try {
      if (on) {
        // P9 固定属于 chat 组；统一走 activateSubMode，让后端在写 map 前按目标实体受控切换
        // 所选对话的生成模式。这样手动选择的 chat 候选不依赖前端 shell 徽标与 memory mode 恰好同步。
        const result = await sendAction({ verb: "activateSubMode", target: "plugins:beilu-memory", source: "web", payload: { id: _P9_SM_ID, chatId: target.chatId, charName: target.charName } });
        if (result?.success !== true) throw new Error(result?.error || "后端未返回绑定成功回执");
        if (result?.active_sub_modes_map?.[target.chatId] !== _P9_SM_ID) throw new Error("后端回执与所选对话的实际绑定不一致");
        const modeNote = result?.mode_switched === true ? "；所选对话已切换到聊天模式" : "";
        if (msg) msg.textContent = result?.preset_applied === true
          ? `已绑定 ${target.charName} / ${target.chatId}（预设已确认应用，参数每轮生效${modeNote}）`
          : `已绑定 ${target.charName} / ${target.chatId}${modeNote}，但预设未确认应用；请检查当前预设`;
      } else {
        const cleared = await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: {
          clear: true,
          expectedId: _P9_SM_ID,
          chatId: target.chatId,
          charName: target.charName,
        } });
        if (cleared?.success !== true || typeof cleared?.cleared !== "boolean" || typeof cleared?.conflict !== "boolean") {
          throw new Error(cleared?.error || "后端未返回完整解绑回执");
        }
        if (cleared?.conflict) {
          if (msg) msg.textContent = cleared.actual_sub_mode
            ? `所选对话现已绑定「${cleared.actual_sub_mode}」，未删除他方绑定`
            : "绑定已变化，未执行删除";
        } else if (!cleared?.cleared) {
          if (msg) msg.textContent = "所选对话本就未绑定 P9";
        } else if (cleared?.active_sub_modes_map?.[target.chatId] === _P9_SM_ID) {
          throw new Error("解绑回执与 active_sub_modes_map 不一致");
        } else if (msg) {
          msg.textContent = `已解绑 ${target.charName} / ${target.chatId}；当前预设保持不变`;
        }
      }
    } catch (e) {
      if (msg) msg.textContent = `绑定操作失败: ${e?.message || e}`;
    }
  })();
  container._p9MutationPromise = operation;
  try {
    await operation;
  } finally {
    if (container._p9MutationPromise === operation) container._p9MutationPromise = null;
    for (const control of controls) control.disabled = false;
    await _p9RefreshBindStatus(container);
  }
}

// ── 提示词区：绑定预设条目就地编辑（与预设面板 settings/panels.mjs 同一契约） ──

function _p9PresetName() { return _p9Entity?.presetName || _P9_SM_ID; }

async function _p9LoadEntries(container) {
  const list = container.querySelector("#p9-pr-list");
  if (!list) return;
  list.innerHTML = '<div class="p-2 opacity-50">加载中...</div>';
  try {
    const d = await sendAction({ verb: "getDataForPreset", target: "plugins:beilu-preset", source: "web", payload: { preset: _p9PresetName() } });
    if (d?.error) { list.innerHTML = `<div class="p-2 text-error">${_esc(d.error)}</div>`; return; }
    _p9Entries = Array.isArray(d?.entries) ? d.entries : [];
    _p9EntrySel = null;
    const ed = container.querySelector("#p9-pr-editor");
    if (ed) ed.innerHTML = '<div class="text-center opacity-40 py-8">未选择条目。从左侧列表选择后在此编辑</div>';
    _p9RenderEntryList(container);
  } catch (e) { list.innerHTML = `<div class="p-2 text-error">${_esc(e?.message || e)}</div>`; }
}

function _p9RenderEntryList(container) {
  const list = container.querySelector("#p9-pr-list");
  if (!list) return;
  list.innerHTML = _p9Entries.map((en, i) => {
    const id = en.identifier || en.name || `entry_${i}`;
    const enabled = en.enabled !== false;
    const isMarker = _P9_MARKERS.includes(id);
    const roleBadge = en.role === "user" ? "U" : en.role === "assistant" ? "A" : "S";
    return `<div class="flex items-center gap-1 px-2 py-1 text-[11px] cursor-pointer hover:bg-base-200/50 border-b border-base-300/30 ${i === _p9EntrySel ? "bg-warning/15" : ""} ${enabled ? "" : "opacity-40"}" data-p9idx="${i}">
      <span class="badge badge-xs badge-ghost" title="身份: ${_esc(en.role || "system")}">${roleBadge}</span>
      <span class="flex-1 truncate" title="${_esc(en.name || id)}">${_esc(en.name || id)}</span>
      ${isMarker ? '<span class="badge badge-xs badge-ghost" title="位置标记：内容运行时从模块提取，顺序参与组装">标记</span>' : ""}
      <span class="flex flex-col leading-none shrink-0">
        <button class="opacity-40 hover:opacity-100" data-p9move="${i}:-1" title="上移（顺序=组装顺序）">▲</button>
        <button class="opacity-40 hover:opacity-100" data-p9move="${i}:1" title="下移">▼</button>
      </span>
    </div>`;
  }).join("") || '<div class="p-2 opacity-40">无条目（绑定预设不存在或为空）</div>';
  list.querySelectorAll("[data-p9idx]").forEach((el) => el.addEventListener("click", () => {
    _p9EntrySel = Number(el.dataset.p9idx);
    _p9RenderEntryList(container);
    _p9RenderEntryEditor(container);
  }));
  list.querySelectorAll("[data-p9move]").forEach((btn) => btn.addEventListener("click", (ev) => {
    ev.stopPropagation(); // 别触发行选中
    const [i, d] = btn.dataset.p9move.split(":").map(Number);
    _p9MoveEntry(container, i, d);
  }));
}

// 上/下移=整表 reorder_entries 提交（marker 同样可移动：位置决定组装顺序，同预设面板语义）
async function _p9MoveEntry(container, i, delta) {
  const j = i + delta;
  if (i < 0 || i >= _p9Entries.length || j < 0 || j >= _p9Entries.length) return;
  const sel = _p9EntrySel != null ? _p9Entries[_p9EntrySel] : null;
  [_p9Entries[i], _p9Entries[j]] = [_p9Entries[j], _p9Entries[i]];
  if (sel) _p9EntrySel = _p9Entries.indexOf(sel);
  _p9RenderEntryList(container);
  try {
    await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), reorder_entries: { order: _p9Entries.map((x) => x.identifier || x.name) } } });
  } catch (e) {
    const m = container.querySelector("#p9-pr-msg");
    if (m) m.textContent = `排序保存失败: ${e?.message || e}`;
    _p9LoadEntries(container); // 失败回读真值，防 UI 与盘不一致
  }
}

function _p9RenderEntryEditor(container) {
  const host = container.querySelector("#p9-pr-editor");
  const en = _p9Entries[_p9EntrySel];
  if (!host || !en) return;
  const id = en.identifier || en.name || `entry_${_p9EntrySel}`;
  const isMarker = _P9_MARKERS.includes(id);
  const isInj = !!en.injection_position;
  host.innerHTML = `<div class="space-y-2 text-xs">
    <div class="flex items-center justify-between">
      <span class="font-bold">${isMarker ? "位置标记（内容运行时从模块提取）" : "条目编辑"}</span>
      <span class="flex gap-1">
        ${isMarker ? "" : '<button id="p9-pr-copy" class="btn btn-xs btn-ghost" title="复制条目内容">复制</button><button id="p9-pr-del" class="btn btn-xs btn-ghost text-error" title="删除条目">删除</button>'}
      </span>
    </div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">名称</label><input id="p9-pr-name" type="text" class="input input-xs input-bordered flex-1" value="${_esc(en.name || id)}" /></div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">启用</label><input id="p9-pr-enabled" type="checkbox" class="toggle toggle-xs" ${en.enabled !== false ? "checked" : ""} /></div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">角色</label><select id="p9-pr-role" class="select select-xs select-bordered flex-1">
      <option value="system" ${en.role === "system" || !en.role ? "selected" : ""}>system</option>
      <option value="user" ${en.role === "user" ? "selected" : ""}>user</option>
      <option value="assistant" ${en.role === "assistant" ? "selected" : ""}>assistant</option>
    </select></div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">类型</label><select id="p9-pr-type" class="select select-xs select-bordered flex-1" ${isMarker ? 'disabled title="位置标记按列表顺序参与组装，类型不可改"' : ""}>
      <option value="system_prompt" ${!isInj ? "selected" : ""}>系统提示词</option>
      <option value="injection" ${isInj ? "selected" : ""}>注入 (Injection)</option>
    </select></div>
    <div id="p9-pr-depth-row" class="flex items-center gap-2 ${isInj ? "" : "hidden"}"><label class="opacity-60 w-10 shrink-0">深度</label><input id="p9-pr-depth" type="number" min="0" max="999" class="input input-xs input-bordered w-20" value="${en.depth || 0}" ${isMarker ? "disabled" : ""} /></div>
    ${isMarker ? '<div class="p-2 rounded border border-base-300/40 bg-base-200/30 text-[10px] opacity-60">此条目内容运行时从对应模块提取，无法在此编辑；名称/启用/角色/顺序可改。</div>' : `<div class="relative expandable-container">
      <textarea id="p9-pr-content" class="textarea textarea-bordered w-full font-mono text-[11px]" rows="9" data-expandable data-expand-title="${_esc(en.name || id)}">${_esc(en.content ?? en.content_preview ?? "")}</textarea>
      <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
    </div>`}
    <button id="p9-pr-save" class="btn btn-xs btn-primary w-full">保存条目</button>
  </div>`;
  host.querySelector("#p9-pr-type")?.addEventListener("change", (ev) => {
    host.querySelector("#p9-pr-depth-row")?.classList.toggle("hidden", ev.target.value !== "injection");
  });
  host.querySelector("#p9-pr-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(host.querySelector("#p9-pr-content")?.value ?? "");
      window._beiluToast?.("条目内容已复制", "success");
    } catch (e) { window._beiluToast?.(`复制失败: ${e?.message || e}`, "error"); }
  });
  host.querySelector("#p9-pr-del")?.addEventListener("click", async () => {
    const isCore = id.startsWith("p9-");
    if (isCore) {
      const restore = confirm(`「${en.name || id}」是 P9 核心预设条目。\n\n删除后可能影响 P9 词库维护功能。\n确定删除？删除后可在面板底部点击「恢复默认预设」从核心恢复。`);
      if (!restore) return;
    } else {
      if (!confirm(`删除条目「${en.name || id}」？`)) return;
    }
    try {
      await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), delete_entry: { identifier: id } } });
      await _p9LoadEntries(container);
      if (isCore) window._beiluToast?.("核心条目已删除。如需恢复，点击面板底部「恢复默认预设」", "warning");
    } catch (e) { const m = container.querySelector("#p9-pr-msg"); if (m) m.textContent = `删除失败: ${e?.message || e}`; }
  });
  // 保存：enabled 走 toggle_entry（引擎真值在 prompt_order，禁塞进 props——settings/panels.mjs:483-501 同口径）
  host.querySelector("#p9-pr-save")?.addEventListener("click", async () => {
    const enabled = !!host.querySelector("#p9-pr-enabled")?.checked;
    const props = {
      name: host.querySelector("#p9-pr-name")?.value?.trim() || id,
      role: host.querySelector("#p9-pr-role")?.value || "system",
    };
    const updatePayload = { identifier: id, props };
    if (!isMarker) {
      const inj = host.querySelector("#p9-pr-type")?.value === "injection";
      updatePayload.content = host.querySelector("#p9-pr-content")?.value ?? "";
      props.system_prompt = !inj;
      props.injection_position = inj ? 1 : 0;
      props.injection_depth = inj ? (parseInt(host.querySelector("#p9-pr-depth")?.value) || 0) : 0;
    }
    const m = container.querySelector("#p9-pr-msg");
    try {
      await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), toggle_entry: { identifier: id, enabled } } });
      await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), update_entry: updatePayload } });
      if (m) m.textContent = "条目已保存";
      const keepSel = _p9EntrySel;
      await _p9LoadEntries(container);
      _p9EntrySel = keepSel != null && keepSel < _p9Entries.length ? keepSel : null;
      if (_p9EntrySel != null) { _p9RenderEntryList(container); _p9RenderEntryEditor(container); }
    } catch (e) { if (m) m.textContent = `保存失败: ${e?.message || e}`; }
  });
}

async function _p9AddEntry(container) {
  const m = container.querySelector("#p9-pr-msg");
  try {
    // identifier 生成同预设面板 add_entry 语义：唯一即可（时间戳足够，用户可改名称）
    const newId = `p9_entry_${Date.now()}`;
    await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), add_entry: { identifier: newId, name: "新条目", role: "system", content: "", system_prompt: true, enabled: true } } });
    await _p9LoadEntries(container);
    const idx = _p9Entries.findIndex((x) => (x.identifier || x.name) === newId);
    if (idx >= 0) { _p9EntrySel = idx; _p9RenderEntryList(container); _p9RenderEntryEditor(container); }
  } catch (e) { if (m) m.textContent = `添加失败: ${e?.message || e}`; }
}
