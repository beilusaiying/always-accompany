/**
 * memoryPresetChat.mjs — 记忆 AI 预设交互面板 v2
 *
 * 功能链：
 *   initMemoryPresetChat → fetchPresets → 渲染工具栏横排预设切换按钮（P1-P8，过滤逻辑见 renderPresetSwitcher）
 *     → 点某预设 → selectedPresetId 更新 → 展示预设描述/提示词
 *     → 点「运行」→ runPreset → sendAction beilu-memory {_action:"runMemoryPreset", presetId,
 *       charDisplayName, chatHistory, dryRun:false} → 后端执行 AI 预设并【同步】返回结果(无 jobId)
 *       → startOutputPolling → 每 1.5s {_action:"getMemoryAIOutput", sinceId} 增量拉运行中输出
 *       → 更新运行中 AI 气泡内容 → 完成后 stopOutputPolling
 *   (注释校准 2026-07-13:原文的 runPreset/jobId/pollPresetOutput action 名全仓不存在=幽灵,以上为实链)
 *   点「文件树」按钮 → fileTreeVisible 切换 → 展开/收起 #mem-sidebar（memoryBrowser 挂载点）
 *   点「导出」→ POST {_action:"exportMemory"} → 下载 JSON
 *   点「导入」→ <input type="file"> → 读文件 → POST {_action:"importMemory"}
 *
 * why（预设轮询而非 WS 推送）：
 *   记忆预设是独立后台任务（不走主聊天流），sinceId 增量轮询是最简单的运行中输出获取方案；
 *   主聊天 WS 不干预记忆预设执行，两条通道互不影响。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（beilu-memory 所有通信统一出口）
 *   → shared/state/sharedState.mjs getCharId（当前角色 ID，决定读哪个角色的记忆）
 *   → shared/transport/endpoints.mjs currentChatId（chatid 来源）
 *   → shared/widgets/beiluDialog.mjs beiluConfirm（清空消息历史确认）
 *   ← layout.mjs（记忆 Tab 初始化时调用 initMemoryPresetChat）
 *   → memoryBrowser.mjs（文件树侧边栏由本模块控制展开/收起）
 *
 * 影响范围：
 *   #mem-toolbar-presets（预设按钮区）、#mem-ai-messages（消息气泡流）、
 *   #mem-sidebar（文件树侧边栏展开态）、isRunning/pollTimer 内存状态。
 *
 * 使用效果：
 *   选预设 → 点运行 → AI 处理记忆任务（整理/召回/分析）→ 结果以气泡形式实时追加展示；
 *   可在同一面板切换到文件树查看/编辑原始记忆文件，两视图互不干扰。
 */

import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { escapeHtml, copyWithFeedback, whenVisible } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 复制✅反馈收口单源
import { getCharId, getCharName } from "../../shared/state/sharedState.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory setdata/getdata + chat fake-send 收口
import { showToast } from "../../../../../../scripts/toast.mjs";
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { recordImportHistory } from "../settings/importExport.mjs"; // T033：导入成功上报集中历史

// ============================================================
// 状态
// ============================================================

let presets = []; // P1-P8 预设列表（从后端加载；renderPresetSwitcher 过滤逻辑只排除 P1〔恒排除〕和 P7〔仅 chat 模式排除〕，P8 未被排除，全预设可加载展示）
let selectedPresetId = null; // 当前选中的预设ID
let _persistedActiveId = ""; // p系列持久激活位（凛倾0706「切换=改绑」）：getData active_memory_preset_id 回读，用户点击写回后端
let isRunning = false; // 预设是否正在运行
let pollTimer = null; // 输出轮询定时器
let lastOutputId = 0; // 上次获取的输出ID
let messages = []; // 对话面板消息记录
let fileTreeVisible = false; // 文件树是否可见
let currentActiveMode = "chat"; // 当前活跃模式（chat/code）
let _presetsChangedListenerBound = false; // init 可能被重复调用；跨面板刷新事件只绑定一次
let _presetActivationBusy = false;
let _presetActivationTargetId = "";

// ============================================================
// DOM 引用
// ============================================================

const els = {};

function cacheDom() {
  // 界面8: 预设唯一家=主区工具栏横排 #mem-toolbar-presets（活动栏竖排已删，去两处切换重复）
  els.presetSwitcher = document.getElementById("mem-toolbar-presets");
  els.fileTreeBtn = document.getElementById("mem-file-tree-btn");
  els.exportBtn = document.getElementById("mem-export-btn");
  els.importBtn = document.getElementById("mem-import-btn");
  els.importFileInput = document.getElementById("mem-import-file-input");
  els.togglePromptBtn = document.getElementById("mem-ai-toggle-prompt");
  els.promptPreview = document.getElementById("mem-ai-prompt-preview");
  els.promptContent = document.getElementById("mem-ai-prompt-content");

  // 侧边栏
  els.sidebar = document.getElementById("mem-sidebar");

  // 主区域 - 消息流视图
  els.chatView = document.getElementById("mem-chat-view");
  els.aiCurrentPreset = document.getElementById("mem-ai-current-preset");
  els.aiPresetDesc = document.getElementById("mem-ai-preset-desc");
  els.aiMessages = document.getElementById("mem-ai-messages");
  els.aiInput = document.getElementById("mem-ai-input");
  els.aiSendBtn = document.getElementById("mem-ai-send-btn");
  els.aiRunBtn = document.getElementById("mem-ai-run-btn");
  els.aiClearBtn = document.getElementById("mem-ai-clear-btn");

  // 主区域 - 文件视图
  els.fileView = document.getElementById("mem-file-view");
}

// ============================================================
// API 通信
// ============================================================

async function memoryPost(data) {
  // T6b批7：apiFetch setdata → sendAction。data 形如 {_action:'X',...rest}；verb=真动作，
  // payload=其余字段，beilu-memory#* 通配组装回 {_action:verb,...payload}，行为等价。
  const { _action, ...rest } = data ?? {};
  return sendAction({ verb: _action, target: "plugins:beilu-memory", source: "web", payload: rest });
}

async function fetchPresets({ throwOnError = false } = {}) {
  try {
    // T6b批7：getdata → sendAction beilu-memory#getData（桥路由，unwrap 还原为旧 REST 裸数据形状），返回同结构。
    const result = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" });
    // p系列持久激活位回读（凛倾0706「切换=改绑」）：init/模式切换恢复选中的单源
    _persistedActiveId = result?.active_memory_preset_id || "";
    return result?.memory_presets || [];
  } catch (err) {
    console.error("[memoryPresetChat] 获取预设列表失败:", err);
    if (throwOnError) throw err;
    return [];
  }
}

async function runPreset(presetId, userMessage) {
  // 获取当前角色名和用户名
  // P-A根修 2026-07-06：原读 #char-name-display textContent——未加载时是占位文案「未加载角色」，
  //   会作为 charDisplayName 直送后端 runMemoryPreset 进记忆AI提示词（与 memtool P4c / charinfo 同型病）。
  //   改 sharedState 单源：getCharName（显示名，选卡时 set + storage 恢复）→ getCharId（目录id 兜底）→ 原默认"角色"。
  const charName = getCharName() || getCharId() || "角色";
  const userName = "用户";

  // 获取聊天历史（最近的消息）
  let chatHistory = "";
  try {
    const chatMessages = document.querySelectorAll(
      "#chat-messages .chat-message .message-content",
    );
    const recentMessages = Array.from(chatMessages).slice(-10);
    chatHistory = recentMessages
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .join("\n---\n");
  } catch {
    /* ignore */
  }

  const payload = {
    _action: "runMemoryPreset",
    presetId,
    charDisplayName: charName,
    userDisplayName: userName,
    chatHistory: userMessage
      ? `${chatHistory}\n\n[用户额外要求]: ${userMessage}`
      : chatHistory,
    dryRun: false,
  };

  return memoryPost(payload);
}

async function getAIOutput(sinceId) {
  return memoryPost({
    _action: "getMemoryAIOutput",
    sinceId,
  });
}

// ============================================================
// 活动栏：预设切换器渲染
// ============================================================

const TRIGGER_LABELS = {
  auto_on_message: "自动",
  auto_on_threshold: "阈值",
  manual_button: "手动",
  manual_or_auto: "手动/自动",
};

function getVisibleManualPresets() {
  return currentActiveMode === "code" || currentActiveMode === "work"
    ? presets.filter((p) => p.id !== "P1")
    : presets.filter((p) => p.id !== "P1" && p.id !== "P7");
}

function renderPresetSwitcher() {
  if (!els.presetSwitcher) return;

  // 根据模式过滤预设：
  // - 编程/工作模式显示 P2-P7（P1 自动检索不需手动，P2-P6 有专用提示词，P7 压缩AI）
  // - 聊天模式显示 P2-P6（P1 自动检索，P7 仅编程/工作模式可见）
  const manualPresets = getVisibleManualPresets();

  if (manualPresets.length === 0) {
    els.presetSwitcher.innerHTML =
      '<div class="text-[10px] text-center opacity-50 py-2">无预设</div>';
    return;
  }

  els.presetSwitcher.innerHTML = manualPresets
    .map((p) => {
      const isActive = p.id === selectedPresetId && !fileTreeVisible;
      const triggerLabel = TRIGGER_LABELS[p.trigger] || "";
      const shortName = (p.name || "").replace(/\s*AI\s*$/, "").substring(0, 4);
      return `
			<button class="mem-switcher-btn ${isActive ? "mem-switcher-active" : ""}"
					type="button"
					data-preset-id="${escapeHtml(p.id)}"
					${_presetActivationBusy ? "disabled" : ""}
					${_presetActivationTargetId === p.id ? 'aria-busy="true"' : ""}
					title="${escapeHtml(p.name || p.id)}${p.description ? "\n" + escapeHtml(p.description) : ""}${triggerLabel ? "\n触发: " + triggerLabel : ""}">
				<span class="mem-switcher-id">${escapeHtml(p.id)}</span>
				${shortName ? `<span class="text-[8px] opacity-50 leading-none">${escapeHtml(shortName)}</span>` : ""}
			</button>
		`;
    })
    .join("");

  // 绑定点击事件
  els.presetSwitcher.querySelectorAll(".mem-switcher-btn").forEach((btn) => {
    btn.addEventListener("click", () => activatePresetFromUi(btn.dataset.presetId));
  });
}

async function handleMemoryPresetsChanged(event) {
  const previousSelectedId = selectedPresetId;
  const { presetId = "", activated = false, source = "" } = event?.detail || {};
  if (source === "memory-chat") return;
  try {
    presets = await fetchPresets({ throwOnError: true });
  } catch (e) {
    console.error("[memoryPresetChat] 创建后刷新预设列表失败:", e);
    return;
  }

  const visibleIds = new Set(getVisibleManualPresets().map((preset) => preset.id));
  if (activated && presetId && visibleIds.has(presetId)) {
    selectPreset(presetId); // 后端已完成激活；这里只同步 UI，不再次持久化
    return;
  }
  if (previousSelectedId && visibleIds.has(previousSelectedId)) {
    selectPreset(previousSelectedId); // 保持用户当前有效选择，不写后端
    return;
  }
  if (_persistedActiveId && visibleIds.has(_persistedActiveId)) {
    selectPreset(_persistedActiveId); // 当前选择已失效时回到后端真 active，不写后端
    return;
  }
  renderPresetSwitcher();
}

// ============================================================
// 预设选择
// ============================================================

async function activatePresetFromUi(presetId) {
  if (_presetActivationBusy || !presets.some((preset) => preset.id === presetId)) return;
  _presetActivationBusy = true;
  _presetActivationTargetId = presetId;
  renderPresetSwitcher();
  try {
    const result = await memoryPost({ _action: "setActiveMemoryPreset", presetId });
    if (!result?.success || result?.active_preset_id !== presetId) {
      const error = new Error(result?.error || "后端未回读到目标 presetId");
      error.isBusinessFailure = true;
      throw error;
    }
    _persistedActiveId = presetId;
    selectPreset(presetId);
    showChatView();
    window.dispatchEvent(new CustomEvent("beilu:memory-presets-changed", { detail: { presetId, activated: true, source: "memory-chat" } }));
  } catch (error) {
    console.warn("[memoryPresetChat] 激活记忆预设失败:", error);
    if (error?.isBusinessFailure) window._beiluToast?.(`切换预设失败：${error.message}`, "error");
  } finally {
    _presetActivationBusy = false;
    _presetActivationTargetId = "";
    renderPresetSwitcher();
  }
}

function selectPreset(presetId) {
  selectedPresetId = presetId;
  const preset = presets.find((p) => p.id === presetId);
  if (!preset) return;

  // 更新活动栏高亮
  renderPresetSwitcher();

  // 更新标题栏（简洁显示）
  if (els.aiCurrentPreset) {
    els.aiCurrentPreset.textContent = `${preset.id} ${preset.name || ""}`;
  }
  if (els.aiPresetDesc) {
    els.aiPresetDesc.textContent = "";
  }

  // 更新提示词预览
  updatePromptPreview(preset);
}

/** 当前提示词预览的标签页：'formatted' | 'rawjson' | 'editprompts' */
let promptPreviewTab = "formatted";
/** 最近一次 fake-send 获取的完整结果 */
let lastFakeSendResult = null;

function updatePromptPreview(preset) {
  if (!els.promptContent) return;
  if (!preset) {
    els.promptContent.textContent = "(未选择预设)";
    return;
  }
  // 如果预览面板可见，自动加载 fake-send
  if (els.promptPreview && !els.promptPreview.classList.contains("hidden")) {
    loadFakeSendPreview();
  } else {
    els.promptContent.innerHTML =
      '(点击 <i data-ic="edit"></i> 按钮展开查看完整 Chat Completion request)';
  }
}

/** 调用 fake-send API 获取完整的聊天 AI request */
async function loadFakeSendPreview() {
  if (!els.promptContent) return;
  if (!currentChatId) {
    els.promptContent.innerHTML =
      '<p class="text-xs text-error py-2"><i data-ic="cross"></i> 当前没有活跃的聊天（chatId 为空）</p>';
    return;
  }

  els.promptContent.innerHTML =
    '<p class="text-xs text-base-content/40 text-center py-2">⏳ 正在构建 Chat Completion request...</p>';

  try {
    // T6b批7：原 raw fetch（手检 res.ok + 自 .json()）→ sendAction shells:chat#getFakeSend（scope.chatId 进 URL）。
    // !ok 由门面统一抛错走下方 catch（原 !res.ok 分支的错误展示等价并入）。
    const result = await sendAction({ verb: "getFakeSend", target: "shells:chat", source: "web", scope: { chatId: currentChatId } });
    lastFakeSendResult = result;
    renderFakeSendPreview(result);
  } catch (err) {
    console.error("[memoryPresetChat] fake-send 加载失败:", err);
    els.promptContent.innerHTML = `<p class="text-xs text-error py-2">❌ 构建失败: ${escapeHtml(err.message)}</p>`;
  }
}

/** 渲染 fake-send 结果（和 promptViewer 一样的效果） */
function renderFakeSendPreview(result) {
  if (!els.promptContent) return;
  els.promptContent.innerHTML = "";

  const messages = result.messages || [];
  const meta = result._meta || {};
  const totalChars =
    meta.total_chars ??
    messages.reduce((sum, m) => sum + (m.content || "").length, 0);

  // 统计栏
  const statsDiv = document.createElement("div");
  statsDiv.className =
    "text-xs text-base-content/40 mb-2 flex flex-wrap gap-x-3";
  const parts = [
    `${messages.length} 条消息`,
    `${totalChars.toLocaleString()} 字符`,
    `≈${(meta.estimated_tokens || Math.round(totalChars / 3.5)).toLocaleString()} tokens`,
  ];
  if (meta.commander_mode) parts.push("🎖️ 司令员模式");
  if (result.model || meta.model)
    parts.push(`模型: ${result.model || meta.model}`);
  statsDiv.textContent = parts.join(" · ");
  els.promptContent.appendChild(statsDiv);

  // 标签页栏
  const tabBar = document.createElement("div");
  tabBar.className = "flex gap-1 mb-2";
  tabBar.innerHTML = `
		<button class="btn btn-xs mem-prompt-tab ${promptPreviewTab === "formatted" ? "" : "btn-outline"}" data-tab="formatted"><i data-ic="edit"></i> 消息列表</button>
		<button class="btn btn-xs mem-prompt-tab ${promptPreviewTab === "rawjson" ? "" : "btn-outline"}" data-tab="rawjson"><i data-ic="clipboard"></i> 原始 JSON</button>
		<button class="btn btn-xs mem-prompt-tab ${promptPreviewTab === "presetpreview" ? "" : "btn-outline"}" data-tab="presetpreview"><i data-ic="eye"></i> 预设预览</button>
	`;
  els.promptContent.appendChild(tabBar);

  tabBar.querySelectorAll(".mem-prompt-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      promptPreviewTab = btn.dataset.tab;
      renderFakeSendPreview(result);
    });
  });

  if (promptPreviewTab === "rawjson") {
    renderFakeSendRawJson(result);
  } else if (promptPreviewTab === "presetpreview") {
    renderPresetPreview();
  } else {
    renderFakeSendMessages(messages);
  }
}

/** 👁 预设预览Tab — 只读展示当前预设最终拼装的 prompts（previewMemoryPreset）。
 *  顶部显示 presetName + totalChars + estimatedTokens 徽章，
 *  下方逐条列出 role / identifier / enabled / charCount / 截断的 preview 文本。
 *  独立 wrap 承载，结构与 renderEditPrompts 一致，不动 tabBar。 */
async function renderPresetPreview() {
  if (!els.promptContent) return;
  const wrap = document.createElement("div");
  els.promptContent.appendChild(wrap);
  await paintPresetPreview(wrap);
}

/** 拉取 previewMemoryPreset 并渲染只读预览。 */
async function paintPresetPreview(wrap) {
  wrap.innerHTML = "";
  if (!selectedPresetId) {
    wrap.innerHTML = `<p class="text-xs text-base-content/40 text-center py-4">请先选择一个预设</p>`;
    return;
  }

  wrap.innerHTML = `<p class="text-xs text-base-content/40 text-center py-2">⏳ 正在构建预设预览...</p>`;

  let data;
  try {
    data = await memoryPost({ _action: "previewMemoryPreset", presetId: selectedPresetId });
  } catch (e) {
    wrap.innerHTML = `<p class="text-xs text-error py-4">获取预设预览失败: ${escapeHtml(e.message)}</p>`;
    return;
  }

  if (!data || data.success === false) {
    wrap.innerHTML = `<p class="text-xs text-error py-4">预设预览失败: ${escapeHtml(data?.error || "未知")}</p>`;
    return;
  }

  wrap.innerHTML = "";

  // 顶部汇总徽章：预设名 + 总字符 + 估算 tokens
  const summary = document.createElement("div");
  summary.className = "flex flex-wrap items-center gap-2 mb-3";
  summary.innerHTML = `
    <span class="badge badge-primary badge-sm">${escapeHtml(data.presetName || data.presetId || selectedPresetId)}</span>
    <span class="badge badge-ghost badge-sm">${(data.totalChars || 0).toLocaleString()} 字符</span>
    <span class="badge badge-ghost badge-sm">≈${(data.estimatedTokens || 0).toLocaleString()} tokens</span>
    <span class="text-[10px] text-base-content/40 ml-auto">${(data.prompts || []).length} 条</span>
  `;
  wrap.appendChild(summary);

  const prompts = data.prompts || [];
  if (!prompts.length) {
    const p = document.createElement("p");
    p.className = "text-xs text-base-content/40 text-center py-4";
    p.textContent = "该预设没有可预览的提示词条目";
    wrap.appendChild(p);
    return;
  }

  prompts.forEach((item) => {
    const card = document.createElement("div");
    card.className = "border border-base-content/10 rounded-lg p-3 mb-2";
    card.style.background = "oklch(var(--bc) / 0.03)";
    if (item.enabled === false) card.style.opacity = "0.5";

    const roleBadge =
      item.role === "system"
        ? "badge-info"
        : item.role === "user"
          ? "badge-success"
          : "badge-warning";

    const header = document.createElement("div");
    header.className = "flex flex-wrap items-center gap-1.5 mb-2 text-xs";
    const tags = [
      `<span class="text-[10px] text-base-content/50">#${item.index}</span>`,
      `<span class="badge badge-xs ${roleBadge} font-mono">${escapeHtml(item.role || "system")}</span>`,
      `<span class="text-[10px] font-mono text-base-content/50">${escapeHtml(item.identifier || "")}</span>`,
      `<span class="badge badge-xs ${item.enabled === false ? "badge-ghost" : "badge-outline"}">${item.enabled === false ? "停用" : "启用"}</span>`,
    ];
    if (item.builtin) tags.push(`<span class="badge badge-xs badge-ghost">内置</span>`);
    if (item.isChatHistory) tags.push(`<span class="badge badge-xs badge-accent"><i data-ic="message"></i> 聊天记录</span>`);
    tags.push(
      `<span class="text-[10px] text-base-content/50 ml-auto">${(item.charCount || 0).toLocaleString()} 字符${item.originalLength && item.originalLength !== item.charCount ? ` / 原 ${item.originalLength.toLocaleString()}` : ""}</span>`,
    );
    header.innerHTML = tags.join("");
    card.appendChild(header);

    const body = document.createElement("pre");
    body.className =
      "text-xs font-mono whitespace-pre-wrap p-2 rounded-md max-h-64 overflow-y-auto";
    body.style.cssText =
      "background: oklch(var(--bc) / 0.04); margin: 0;";
    body.textContent = item.preview || (item.isChatHistory ? "(运行时注入聊天记录)" : "(空)");
    card.appendChild(body);

    wrap.appendChild(card);
  });
}

/** 消息列表视图（和 promptViewer 一致的可折叠消息卡片） */
function renderFakeSendMessages(messages) {
  if (!messages.length) {
    const p = document.createElement("p");
    p.className = "text-xs text-base-content/40 text-center py-4";
    p.textContent = "没有消息";
    els.promptContent.appendChild(p);
    return;
  }

  // 检测是否有 _source 标记（commanderMode）
  const hasSourceInfo = messages.some((m) => m._source);
  const hasSectionInfo = messages.some((m) => m._section);

  const sectionLabels = {
    beforeChat: "── ▼ 头部预设 (beforeChat) ▼ ──",
    injectionAbove: "── ▼ 注入上方 (@D≥1) ▼ ──",
    chatHistory: "── ▼ 聊天记录 ▼ ──",
    injectionBelow: "── ▼ 注入下方 (@D=0) ▼ ──",
    afterChat: "── ▼ 尾部预设 (afterChat) ▼ ──",
    before: "── ▼ 预设(头) ▼ ──",
    chat: "── ▼ 聊天记录 ▼ ──",
    after: "── ▼ 预设(尾) ▼ ──",
  };

  let currentSection = null;

  messages.forEach((msg, idx) => {
    // section 分隔线
    if (hasSectionInfo && msg._section && msg._section !== currentSection) {
      const divider = document.createElement("div");
      divider.className =
        "text-[10px] text-center text-base-content/50 py-1 my-1";
      divider.style.cssText = "border-top: 1px dashed oklch(var(--bc) / 0.1);";
      divider.textContent =
        sectionLabels[msg._section] || `── ▼ ${msg._section} ▼ ──`;
      els.promptContent.appendChild(divider);
      currentSection = msg._section;
    }

    const card = document.createElement("div");
    card.className =
      "rounded-md border border-base-content/10 overflow-hidden mb-1";
    if (msg._is_marker) card.style.opacity = "0.5";

    const roleColor =
      msg.role === "system"
        ? "text-blue-400"
        : msg.role === "user"
          ? "text-green-400"
          : "text-purple-400";
    const roleBg =
      msg.role === "system"
        ? "bg-blue-500/5"
        : msg.role === "user"
          ? "bg-green-500/5"
          : "bg-purple-500/5";
    const content = msg.content || "";
    const preview = content.substring(0, 80).replace(/\n/g, " ");

    // source 标签
    let sourceTag = "";
    if (hasSourceInfo && msg._source) {
      const sourceMap = {
        preset: '<i data-ic="clipboard"></i>预设',
        injection: '<i data-ic="syringe"></i>注入',
        chat_log: '<i data-ic="message"></i>对话',
      };
      sourceTag = `<span class="text-[9px] opacity-50">${sourceMap[msg._source] || escapeHtml(msg._source)}</span>`;
    }

    // identifier 标签
    const identTag = msg._identifier
      ? `<span class="text-[9px] opacity-40 font-mono">${escapeHtml(msg._identifier)}</span>`
      : "";

    const header = document.createElement("div");
    header.className = `flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer ${roleBg}`;
    header.innerHTML = `
			<span class="text-[10px] text-base-content/50">#${idx + 1}</span>
			<span class="badge badge-xs ${roleColor} font-mono">${escapeHtml(msg.role)}</span>
			${sourceTag}
			${identTag}
			<span class="flex-grow truncate text-base-content/50 text-[10px]">${escapeHtml(preview)}${content.length > 80 ? "..." : ""}</span>
			<span class="text-base-content/50 text-[10px] shrink-0">${content.length.toLocaleString()}</span>
			<span class="text-base-content/50 text-[10px] mem-msg-chevron">▶</span>
		`;

    const body = document.createElement("pre");
    body.className =
      "text-xs font-mono whitespace-pre-wrap p-2 max-h-64 overflow-y-auto";
    body.style.cssText =
      "background: oklch(var(--bc) / 0.03); margin: 0; display: none;";
    body.textContent = content;

    // 点击展开/折叠
    header.addEventListener("click", () => {
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "";
      header.querySelector(".mem-msg-chevron").textContent = isOpen ? "▶" : "▼";
    });

    card.appendChild(header);
    card.appendChild(body);
    els.promptContent.appendChild(card);
  });
}

/** 原始 JSON 视图 — 显示完整 JSON（不截断） */
function renderFakeSendRawJson(result) {
  const copyBar = document.createElement("div");
  copyBar.className = "flex justify-end mb-1";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-xs btn-outline";
  copyBtn.innerHTML = '<i data-ic="clipboard"></i> 复制完整 JSON';
  copyBar.appendChild(copyBtn);
  els.promptContent.appendChild(copyBar);

  const jsonStr = JSON.stringify(result, null, 2);
  const pre = document.createElement("pre");
  pre.className =
    "text-xs font-mono whitespace-pre-wrap p-3 rounded-md overflow-y-auto select-all";
  pre.style.cssText =
    "background: oklch(var(--bc) / 0.05); border: 1px solid oklch(var(--bc) / 0.1); max-height: 60vh;";
  pre.textContent = jsonStr;
  els.promptContent.appendChild(pre);

  copyBtn.addEventListener("click", () => copyWithFeedback(jsonStr, copyBtn, '<i data-ic="check"></i> 已复制'));
}

/** W61: 编辑提示词Tab — 直接编辑P系列预设的prompts内容（含增/删/排序/模板初始化）。
 *  外层 tabBar 已在 promptContent 顶部，这里用独立 wrap 承载编辑器，
 *  结构变更后只重绘 wrap（paintPromptEditor），不动 tabBar。 */
async function renderEditPrompts() {
  if (!els.promptContent) return;
  const wrap = document.createElement("div");
  els.promptContent.appendChild(wrap);
  await paintPromptEditor(wrap);
}

/** 重绘提示词编辑器：清空自身 wrap 后从后端拉取最新 prompts 重建。
 *  增/删/排序/模板初始化后调用以即时刷新（无需整页刷新）。 */
async function paintPromptEditor(wrap) {
  wrap.innerHTML = "";
  if (!selectedPresetId) {
    wrap.innerHTML = `<p class="text-xs text-base-content/40 text-center py-4">请先选择一个预设</p>`;
    return;
  }

  let presetData;
  try {
    presetData = await memoryPost({ _action: "getMemoryPresetDetail", presetId: selectedPresetId });
  } catch (e) {
    wrap.innerHTML = `<p class="text-xs text-error py-4">获取预设详情失败: ${escapeHtml(e.message)}</p>`;
    return;
  }

  const prompts = presetData?.prompts || presetData?.preset?.prompts || [];

  // 工具栏：添加 / 从模板初始化（始终显示，空列表也能填充）
  const toolbar = document.createElement("div");
  toolbar.className = "flex items-center gap-2 mb-2";
  toolbar.innerHTML = `
    <button class="btn btn-xs btn-primary" data-act="add"><i data-ic="plus"></i> 添加提示词</button>
    <button class="btn btn-xs btn-ghost" data-act="init"><i data-ic="clipboard"></i> 从模板初始化</button>
    <span class="text-[10px] text-base-content/40 ml-auto">${prompts.length} 条</span>
  `;
  toolbar.querySelector('[data-act="add"]').addEventListener("click", async () => {
    try {
      await memoryPost({ _action: "addPresetPrompt", presetId: selectedPresetId, promptSet: "prompts", role: "system", content: "" });
      await paintPromptEditor(wrap);
    } catch (e) { console.error("[memoryPresetChat] 添加提示词失败:", e); }
  });
  toolbar.querySelector('[data-act="init"]').addEventListener("click", async () => {
    if (!await beiluConfirm("从模板重置该预设的提示词组？当前自定义内容将被覆盖。")) return;
    try {
      const r = await memoryPost({ _action: "initPresetPromptsFromTemplate", presetId: selectedPresetId, promptSet: "prompts" });
      if (r && r.success === false) { showToast("error", "初始化失败: " + (r.error || "未知")); return; }
      await paintPromptEditor(wrap);
    } catch (e) { console.error("[memoryPresetChat] 模板初始化失败:", e); }
  });
  wrap.appendChild(toolbar);

  if (!prompts.length) {
    const p = document.createElement("p");
    p.className = "text-xs text-base-content/40 text-center py-4";
    p.textContent = "该预设没有提示词条目，点击「添加提示词」或「从模板初始化」";
    wrap.appendChild(p);
    return;
  }

  // 当前顺序的 identifier 列表，供排序构造 order 数组
  const orderIds = prompts.map((p, i) => p.identifier || `__idx_${i}`);

  // 结构变更（排序/删除）会重绘并丢弃未保存的文本编辑，先静默批量持久化文本字段
  const persistEdits = async () => {
    const updated = prompts.map((p, idx) => {
      const nameInput = wrap.querySelector(`[data-field="name"][data-idx="${idx}"]`);
      const contentArea = wrap.querySelector(`textarea[data-idx="${idx}"]`);
      const enabledCheck = wrap.querySelector(`[data-field="enabled"][data-idx="${idx}"]`);
      return {
        ...p,
        name: nameInput?.value ?? p.name,
        content: contentArea?.value ?? p.content,
        enabled: enabledCheck?.checked ?? p.enabled,
      };
    });
    try {
      await memoryPost({ _action: "updateMemoryPresetPrompts", presetId: selectedPresetId, prompts: updated });
    } catch (e) { console.error("[memoryPresetChat] 结构变更前保存文本失败:", e); }
  };

  // 渲染可编辑的提示词列表
  prompts.forEach((prompt, idx) => {
    const card = document.createElement("div");
    card.className = "border border-base-content/10 rounded-lg p-3 mb-2";
    card.style.background = "oklch(var(--bc) / 0.03)";

    const deletable = prompt.deletable !== false && !prompt.builtin;
    const header = document.createElement("div");
    header.className = "flex items-center gap-2 mb-2";
    header.innerHTML = `
      <span class="badge badge-sm ${prompt.role === "system" ? "badge-info" : prompt.role === "user" ? "badge-success" : "badge-warning"}">${escapeHtml(prompt.role || "system")}</span>
      <input class="input input-xs input-bordered flex-1" value="${escapeHtml(prompt.name || prompt.identifier || `提示词${idx + 1}`)}" data-field="name" data-idx="${idx}" />
      <label class="flex items-center gap-1 text-xs">
        <input type="checkbox" class="checkbox checkbox-xs" ${prompt.enabled !== false ? "checked" : ""} data-field="enabled" data-idx="${idx}" />
        启用
      </label>
      <div class="flex items-center gap-0.5">
        <button class="btn btn-xs btn-ghost btn-square" data-move="up" title="上移" ${idx === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn-xs btn-ghost btn-square" data-move="down" title="下移" ${idx === prompts.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn-xs btn-ghost btn-square text-error" data-del title="删除" ${deletable ? "" : "disabled"}><i data-ic="trash"></i></button>
      </div>
    `;
    card.appendChild(header);

    // 排序：交换相邻 identifier 顺序 → reorderPresetPrompts
    const reorder = async (from, to) => {
      if (to < 0 || to >= orderIds.length) return;
      await persistEdits();
      const ids = orderIds.slice();
      [ids[from], ids[to]] = [ids[to], ids[from]];
      try {
        await memoryPost({ _action: "reorderPresetPrompts", presetId: selectedPresetId, promptSet: "prompts", order: ids });
        await paintPromptEditor(wrap);
      } catch (e) { console.error("[memoryPresetChat] 排序失败:", e); }
    };
    header.querySelector('[data-move="up"]').addEventListener("click", () => reorder(idx, idx - 1));
    header.querySelector('[data-move="down"]').addEventListener("click", () => reorder(idx, idx + 1));
    header.querySelector("[data-del]").addEventListener("click", async () => {
      if (!deletable) return;
      if (!await beiluConfirm("删除该提示词条目？")) return;
      await persistEdits();
      try {
        await memoryPost({ _action: "removePresetPrompt", presetId: selectedPresetId, promptSet: "prompts", promptIndex: idx });
        await paintPromptEditor(wrap);
      } catch (e) { console.error("[memoryPresetChat] 删除提示词失败:", e); }
    });

    const textarea = document.createElement("textarea");
    textarea.className = "textarea textarea-bordered w-full text-xs font-mono";
    textarea.style.minHeight = "80px";
    textarea.value = prompt.content || "";
    textarea.dataset.field = "content";
    textarea.dataset.idx = String(idx);
    // 内置条目内容锁定（后端三条写路同守卫；不锁=编辑后静默不落盘的分叉）——开关/名称/排序仍可改
    if (prompt.builtin) {
      textarea.disabled = true;
      const lockHint = document.createElement("div");
      lockHint.className = "text-[10px] text-base-content/40 italic mt-1";
      lockHint.textContent = "内置条目：内容由系统运行时生成，不可编辑；开关、名称、排序可改。";
      card.appendChild(textarea);
      card.appendChild(lockHint);
    } else {
      card.appendChild(textarea);
    }

    wrap.appendChild(card);
  });

  // 保存按钮（批量保存 name/content/enabled）
  const saveBar = document.createElement("div");
  saveBar.className = "flex justify-end gap-2 mt-3";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-sm btn-primary";
  saveBtn.innerHTML = '<i data-ic="save"></i> 保存提示词';
  saveBtn.addEventListener("click", async () => {
    const updatedPrompts = prompts.map((p, idx) => {
      const nameInput = wrap.querySelector(`[data-field="name"][data-idx="${idx}"]`);
      const contentArea = wrap.querySelector(`textarea[data-idx="${idx}"]`);
      const enabledCheck = wrap.querySelector(`[data-field="enabled"][data-idx="${idx}"]`);
      return {
        ...p,
        name: nameInput?.value || p.name,
        content: contentArea?.value || p.content,
        enabled: enabledCheck?.checked ?? p.enabled,
      };
    });
    try {
      await memoryPost({
        _action: "updateMemoryPresetPrompts",
        presetId: selectedPresetId,
        prompts: updatedPrompts,
      });
      saveBtn.innerHTML = '<i data-ic="check"></i> 已保存';
      setTimeout(() => { saveBtn.innerHTML = '<i data-ic="save"></i> 保存提示词'; }, 1500);
    } catch (e) {
      saveBtn.innerHTML = '<i data-ic="cross"></i> 保存失败';
      console.error("[memoryPresetChat] 保存提示词失败:", e);
    }
  });
  saveBar.appendChild(saveBtn);
  wrap.appendChild(saveBar);
}

function togglePromptPreview() {
  if (!els.promptPreview) return;
  const isHidden = els.promptPreview.classList.contains("hidden");
  els.promptPreview.classList.toggle("hidden");
  if (els.togglePromptBtn) {
    els.togglePromptBtn.title = isHidden ? "收起提示词" : "查看提示词";
  }
  // 展开时自动加载 fake-send
  if (isHidden) {
    loadFakeSendPreview();
  }
}

// ============================================================
// 视图切换
// ============================================================

function showChatView() {
  if (els.chatView) els.chatView.style.display = "";
  if (els.fileView) els.fileView.style.display = "none";
  if (els.sidebar) els.sidebar.style.display = "none";
  // 3层重做：与活动栏共用主区，必须同时收起工具面板，否则对话台/文件树会盖在工具面板上（堆叠回归）
  const _tp = document.getElementById("mem-tool-panel");
  if (_tp) _tp.style.display = "none";
  fileTreeVisible = false;
  els.fileTreeBtn?.classList.remove("ide-activity-active");
}

function toggleFileTree() {
  fileTreeVisible = !fileTreeVisible;
  if (fileTreeVisible) {
    // 显示文件树侧边栏 + 文件视图
    if (els.sidebar) els.sidebar.style.display = "";
    if (els.fileView) els.fileView.style.display = "";
    if (els.chatView) els.chatView.style.display = "none";
    // 同上：收起工具面板，避免文件视图与工具面板堆叠
    const _tp = document.getElementById("mem-tool-panel");
    if (_tp) _tp.style.display = "none";
    els.fileTreeBtn?.classList.add("ide-activity-active");
    // 更新活动栏（取消预设高亮）
    renderPresetSwitcher();
  } else {
    showChatView();
    renderPresetSwitcher();
  }
}

// ============================================================
// 消息面板
// ============================================================

function addMessage(role, content, meta) {
  const msg = { role, content, meta, timestamp: Date.now() };
  messages.push(msg);
  renderMessages();
  scrollToBottom();
}

function addSystemMessage(text) {
  addMessage("system", text);
}

function addUserMessage(text) {
  addMessage("user", text);
}

function addAIMessage(text, meta) {
  addMessage("ai", text, meta);
}

function renderMessages() {
  if (!els.aiMessages) return;

  if (messages.length === 0) {
    els.aiMessages.innerHTML =
      '<p class="text-xs text-base-content/40 text-center py-4">选择一个预设并运行，AI输出将显示在这里</p>';
    return;
  }

  els.aiMessages.innerHTML = messages
    .map((msg) => {
      const isUser = msg.role === "user";
      const isSystem = msg.role === "system";
      const isAI = msg.role === "ai";

      // 系统消息：居中简短提示
      if (isSystem) {
        return `<div class="mem-msg-system text-xs text-center text-base-content/50 py-1 my-1">${escapeHtml(msg.content)}</div>`;
      }

      // 头像和名称
      const avatarIcon = isUser ? '<i data-ic="person"></i>' : '<i data-ic="brain"></i>';
      const name = isUser ? "用户" : msg.meta?.presetName || "记忆AI";
      const avatarBg = isUser ? "bg-base-300" : "";
      const avatarStyle = isUser ? "" : `style="background:color-mix(in srgb, var(--beilu-amber-dark,#8b6914) 30%, transparent)"`;
      const nameColor = isUser ? "text-base-content" : "";
      const nameStyle = isUser ? "" : `style="color:var(--beilu-amber)"`;

      // AI 状态标签
      let statusHtml = "";
      if (isAI && msg.meta) {
        const parts = [];
        if (msg.meta.status === "running") parts.push('<i data-ic="hourglass"></i> 处理中...');
        if (msg.meta.status === "done") parts.push('<i data-ic="check"></i> 完成');
        if (msg.meta.status === "error") parts.push('<i data-ic="cross"></i> 错误');
        if (msg.meta.rounds) parts.push(`${msg.meta.rounds}轮`);
        if (msg.meta.timeMs) parts.push(`${msg.meta.timeMs}ms`);
        if (parts.length) {
          statusHtml = `<span class="text-[10px] opacity-40 ml-2">${parts.join(" · ")}</span>`;
        }
      }

      return `
			<div class="chat-message mb-3 group" data-template-type="memory-message">
				<div class="message-header flex items-center gap-2 px-1 mb-1">
					<div class="message-avatar w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ${avatarBg} flex items-center justify-center text-lg" ${avatarStyle}>
						${avatarIcon}
					</div>
					<span class="char-name text-sm font-bold ${nameColor}" ${nameStyle}>${escapeHtml(name)}</span>
					<span class="message-timestamp text-xs opacity-40">${formatTime(msg.timestamp)}</span>
					${statusHtml}
				</div>
				<div class="chat-bubble relative p-[15px] ml-10 rounded-lg">
					<div class="message-content markdown-body text-sm whitespace-pre-wrap break-words">${escapeHtml(msg.content)}</div>
				</div>
			</div>
		`;
    })
    .join("");
}

function scrollToBottom() {
  if (els.aiMessages) {
    requestAnimationFrame(() => {
      els.aiMessages.scrollTop = els.aiMessages.scrollHeight;
    });
  }
}

function clearMessages() {
  messages = [];
  renderMessages();
}

// ============================================================
// 运行预设
// ============================================================

async function handleRun() {
  if (!selectedPresetId) {
    addSystemMessage("⚠️ 请先在左侧选择一个预设");
    return;
  }
  if (isRunning) {
    addSystemMessage("⚠️ 正在运行中，请等待完成");
    return;
  }

  const preset = presets.find((p) => p.id === selectedPresetId);
  const presetName = preset?.name || selectedPresetId;

  isRunning = true;
  updateRunButton();
  addAIMessage("正在运行...", { presetName, status: "running" });

  // 开始轮询输出
  startOutputPolling();

  try {
    const result = await runPreset(selectedPresetId);

    // 更新最后一条AI消息
    const lastAI = messages.filter((m) => m.role === "ai").pop();
    if (lastAI) {
      lastAI.content = result?.reply || "(无输出)";
      lastAI.meta = {
        presetName,
        status: result?.error ? "error" : "done",
        rounds: result?.totalRounds,
        timeMs: result?.totalTimeMs,
      };
    }
    renderMessages();
    scrollToBottom();
  } catch (err) {
    const lastAI = messages.filter((m) => m.role === "ai").pop();
    if (lastAI) {
      lastAI.content = `运行失败: ${err.message}`;
      lastAI.meta = { presetName, status: "error" };
    }
    renderMessages();
  } finally {
    isRunning = false;
    updateRunButton();
    stopOutputPolling();
  }
}

async function handleSend() {
  const text = els.aiInput?.value?.trim();
  if (!text) return;

  if (!selectedPresetId) {
    addSystemMessage("⚠️ 请先在左侧选择一个预设");
    return;
  }
  if (isRunning) {
    addSystemMessage("⚠️ 正在运行中，请等待完成");
    return;
  }

  // 显示用户消息
  addUserMessage(text);
  els.aiInput.value = "";

  const preset = presets.find((p) => p.id === selectedPresetId);
  const presetName = preset?.name || selectedPresetId;

  isRunning = true;
  updateRunButton();
  addAIMessage("正在处理...", { presetName, status: "running" });

  startOutputPolling();

  try {
    const result = await runPreset(selectedPresetId, text);

    const lastAI = messages.filter((m) => m.role === "ai").pop();
    if (lastAI) {
      lastAI.content = result?.reply || "(无输出)";
      lastAI.meta = {
        presetName,
        status: result?.error ? "error" : "done",
        rounds: result?.totalRounds,
        timeMs: result?.totalTimeMs,
      };
    }
    renderMessages();
    scrollToBottom();
  } catch (err) {
    const lastAI = messages.filter((m) => m.role === "ai").pop();
    if (lastAI) {
      lastAI.content = `运行失败: ${err.message}`;
      lastAI.meta = { presetName, status: "error" };
    }
    renderMessages();
  } finally {
    isRunning = false;
    updateRunButton();
    stopOutputPolling();
  }
}

function updateRunButton() {
  if (els.aiRunBtn) {
    els.aiRunBtn.disabled = isRunning;
    els.aiRunBtn.innerHTML = isRunning ? '<i data-ic="hourglass"></i> 运行中...' : "▶ 运行当前预设";
  }
  if (els.aiSendBtn) {
    els.aiSendBtn.disabled = isRunning;
  }
}

// ============================================================
// 异步运行（runAsyncAI / getAsyncAITasks）— 后台跑预设，不阻塞当前会话
// ============================================================

async function handleRunAsync() {
  if (!selectedPresetId) {
    addSystemMessage("⚠️ 请先在左侧选择一个预设");
    return;
  }
  const preset = presets.find((p) => p.id === selectedPresetId);
  const presetName = preset?.name || selectedPresetId;
  try {
    const r = await memoryPost({
      _action: "runAsyncAI",
      presetId: selectedPresetId,
      taskLabel: presetName,
    });
    if (r && r.success === false) {
      addSystemMessage("⚠️ 异步任务启动失败: " + (r.error || "未知"));
      return;
    }
    addSystemMessage(`⚡ 已在后台启动异步任务「${presetName}」，可点「📋 异步任务」查看状态`);
  } catch (e) {
    addSystemMessage("⚠️ 异步任务启动失败: " + e.message);
  }
}

async function showAsyncTasks() {
  let r;
  try {
    r = await memoryPost({ _action: "getAsyncAITasks" });
  } catch (e) {
    addSystemMessage("⚠️ 获取异步任务失败: " + e.message);
    return;
  }
  const tasks = (r && r.tasks) || [];
  if (!tasks.length) {
    addSystemMessage("📋 当前没有异步任务");
    return;
  }
  const STATUS_LABEL = { running: "⏳ 运行中", done: "✅ 完成", completed: "✅ 完成", error: "❌ 失败" };
  const lines = tasks.map((t) => {
    const st = STATUS_LABEL[t.status] || t.status || "?";
    const err = t.error ? `（${t.error}）` : "";
    return `· ${st} ${t.id}${err}`;
  });
  addSystemMessage(`📋 异步任务（${tasks.length}）\n` + lines.join("\n"));
}

// ============================================================
// 输出轮询
// ============================================================

function startOutputPolling() {
  stopOutputPolling();
  lastOutputId = 0;
  pollTimer = setInterval(async () => {
    try {
      const result = await getAIOutput(lastOutputId);
      if (result?.outputs?.length) {
        for (const output of result.outputs) {
          if (output.id > lastOutputId) lastOutputId = output.id;
          // 更新正在运行的AI消息的内容
          const lastAI = messages
            .filter((m) => m.role === "ai" && m.meta?.status === "running")
            .pop();
          if (lastAI && output.content) {
            lastAI.content = output.content;
            renderMessages();
            scrollToBottom();
          }
        }
      }
    } catch (e) {
      console.warn("[memoryPresetChat] 轮询失败（下轮重试）:", e?.message || e); // T021 留痕
    }
  }, 2000);
}

function stopOutputPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ============================================================
// 导入导出
// ============================================================

async function handleExport() {
  addSystemMessage("📤 正在导出记忆文件...");
  try {
    // 获取当前角色 ID（从 data-char-id 属性读取，而非显示名）
    const charName =
      getCharId();
    const result = await memoryPost({ _action: "exportMemory", charName });
    if (!result?.success) {
      addSystemMessage("❌ 导出失败: " + (result?.error || "未知错误"));
      return;
    }

    if (result.zipBase64) {
      // zip 格式导出：解码 base64 → Blob → 下载
      const binaryStr = atob(result.zipBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        result.fileName || `beilu-memory_${charName || "export"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addSystemMessage(
        `✅ 导出成功: ${result.fileCount} 个文件 → ${a.download}`,
      );
    } else {
      addSystemMessage("❌ 导出失败: 未知响应格式");
    }
  } catch (err) {
    addSystemMessage("❌ 导出失败: " + err.message);
  }
}

function handleImportClick() {
  els.importFileInput?.click();
}

async function handleImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ""; // 清空以允许重复选择同一文件

  addSystemMessage(`📥 正在读取 ${file.name}...`);

  try {
    // 获取当前角色 ID（从 data-char-id 属性读取，而非显示名）
    const charName =
      getCharId();

    if (file.name.endsWith(".zip")) {
      // ZIP 格式导入：读取为 base64 发送给后端
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const zipBase64 = btoa(binary);

      const confirmMsg = `确认导入 zip 记忆文件？\n文件: ${file.name}\n大小: ${(file.size / 1024).toFixed(1)} KB\n\n现有文件将被备份为 .import_bak`;
      if (!await beiluConfirm(confirmMsg)) {
        addSystemMessage("⏹ 已取消导入");
        return;
      }

      addSystemMessage("📥 正在导入记忆文件 (zip)...");
      const result = await memoryPost({
        _action: "importMemory",
        charName,
        zipBase64,
        backupExisting: true,
      });

      if (result?.success) {
        addSystemMessage(
          `✅ 导入完成: 成功 ${result.imported} 个, 跳过 ${result.skipped} 个`,
        );
        recordImportHistory("记忆包", file.name); // T033：上报集中导入历史
        if (result.errors?.length) {
          addSystemMessage("⚠️ 部分错误:\n" + result.errors.join("\n"));
        }
      } else {
        addSystemMessage("❌ 导入失败: " + (result?.error || "未知错误"));
      }
    } else {
      // JSON 格式导入（旧格式兼容）
      const text = await file.text();
      let importData;
      try {
        importData = JSON.parse(text);
      } catch {
        addSystemMessage("❌ 文件不是有效的 JSON 或 ZIP");
        return;
      }

      if (importData._format !== "beilu-memory-export") {
        addSystemMessage("❌ 文件格式不正确（缺少 beilu-memory-export 标识）");
        return;
      }

      const fileCount = Object.keys(importData.files || {}).length;
      const source = importData.charName || "未知角色";
      const exportedAt = importData.exportedAt || "未知时间";
      const confirmMsg = `确认导入 ${fileCount} 个记忆文件？\n来源: ${source}\n导出时间: ${exportedAt}\n\n现有文件将被备份为 .import_bak`;

      if (!await beiluConfirm(confirmMsg)) {
        addSystemMessage("⏹ 已取消导入");
        return;
      }

      addSystemMessage("📥 正在导入记忆文件...");
      const result = await memoryPost({
        _action: "importMemory",
        charName,
        importData,
        backupExisting: true,
      });

      if (result?.success) {
        addSystemMessage(
          `✅ 导入完成: 成功 ${result.imported} 个, 跳过 ${result.skipped} 个`,
        );
        recordImportHistory("记忆包", file.name); // T033：上报集中导入历史
        if (result.errors?.length) {
          addSystemMessage("⚠️ 部分错误:\n" + result.errors.join("\n"));
        }
      } else {
        addSystemMessage("❌ 导入失败: " + (result?.error || "未知错误"));
      }
    }
  } catch (err) {
    addSystemMessage("❌ 导入失败: " + err.message);
  }
}

// ============================================================
// 工具函数
// ============================================================

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

// ============================================================
// 初始化
// ============================================================

export async function initMemoryPresetChat() {
  cacheDom();

  if (!_presetsChangedListenerBound) {
    window.addEventListener("beilu:memory-presets-changed", handleMemoryPresetsChanged);
    _presetsChangedListenerBound = true;
  }

  // 绑定事件
  els.aiRunBtn?.addEventListener("click", handleRun);
  els.aiSendBtn?.addEventListener("click", handleSend);

  // 异步运行按钮（动态注入到运行按钮旁，不改 HTML）
  if (els.aiRunBtn && els.aiRunBtn.parentElement && !document.getElementById("mem-ai-run-async-btn")) {
    const asyncBtn = document.createElement("button");
    asyncBtn.id = "mem-ai-run-async-btn";
    asyncBtn.className = els.aiRunBtn.className;
    asyncBtn.innerHTML = '<i data-ic="zap"></i> 异步运行';
    asyncBtn.title = "在后台运行当前预设，不阻塞会话";
    asyncBtn.addEventListener("click", handleRunAsync);
    const tasksBtn = document.createElement("button");
    tasksBtn.id = "mem-ai-async-tasks-btn";
    tasksBtn.className = els.aiRunBtn.className;
    tasksBtn.innerHTML = '<i data-ic="clipboard"></i> 异步任务';
    tasksBtn.title = "查看后台异步任务状态";
    tasksBtn.addEventListener("click", showAsyncTasks);
    els.aiRunBtn.insertAdjacentElement("afterend", tasksBtn);
    els.aiRunBtn.insertAdjacentElement("afterend", asyncBtn);
  }
  els.aiClearBtn?.addEventListener("click", clearMessages);
  els.fileTreeBtn?.addEventListener("click", toggleFileTree);
  els.exportBtn?.addEventListener("click", () => {
    const w = document.getElementById("mem-io-window");
    if (w) w.classList.remove("hidden");
  });
  els.importBtn?.addEventListener("click", () => {
    const w = document.getElementById("mem-io-window");
    if (w) w.classList.remove("hidden");
  });
  els.importFileInput?.addEventListener("change", handleImportFile);
  // 记忆管理浮窗按钮接线
  document.getElementById("mem-io-close")?.addEventListener("click", () => {
    document.getElementById("mem-io-window")?.classList.add("hidden");
  });
  document.getElementById("mem-io-export-btn")?.addEventListener("click", async () => {
    await handleExport();
    const s = document.getElementById("mem-io-status");
    if (s) { s.style.display = ""; s.innerHTML = '<i data-ic="check"></i> 导出完成'; }
  });
  document.getElementById("mem-io-import-input")?.addEventListener("change", async (e) => {
    await handleImportFile(e);
    const s = document.getElementById("mem-io-status");
    if (s) { s.style.display = ""; s.innerHTML = '<i data-ic="check"></i> 导入完成'; }
  });
  els.togglePromptBtn?.addEventListener("click", togglePromptPreview);

  // 输入框回车发送
  els.aiInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // 加载预设列表
  presets = await fetchPresets();
  renderPresetSwitcher();

  // 选中恢复：优先用户已存持久激活位（凛倾0706「切换=改绑」，getData 回读），无/失效才落默认（P2）
  const _restored = _persistedActiveId && presets.find((p) => p.id === _persistedActiveId);
  const defaultPreset = _restored || (
    currentActiveMode === "code" || currentActiveMode === "work"
      ? presets.find((p) => p.id !== "P1") // 编程/工作模式：P2
      : presets.find((p) => p.id !== "P1" && p.id !== "P7")); // 聊天模式：P2
  if (defaultPreset) {
    selectPreset(defaultPreset.id); // 恢复/默认不 persist（防兜底覆盖用户绑定）
  }

  // 监听模式切换事件——预设列表不重拉（全局不变），只用缓存的 presets 重新选择默认预设
  window.addEventListener("beilu:mode-switched", whenVisible("#center-tab-memory", async (e) => {
    const { newMode } = e.detail || {};
    currentActiveMode = newMode || "chat";
    console.log(`[memoryPresetChat] 模式切换: ${currentActiveMode}`);

    // 预设列表是全局的，模式切换不改预设集——用已有 presets 缓存重渲染，不重拉
    if (!presets || !presets.length) presets = await fetchPresets();
    renderPresetSwitcher();

    // 选中恢复优先持久激活位（凛倾0706「切换=改绑」，在当前模式可见列表内才恢复），无才按模式默认
    const _pRestored = _persistedActiveId && presets.find((p) => p.id === _persistedActiveId);
    if (_pRestored) {
      selectPreset(_pRestored.id); // 恢复不 persist
    } else if (currentActiveMode === "code" || currentActiveMode === "work") {
      const defaultCode =
        presets.find((p) => p.id === "P2") ||
        presets.find((p) => p.id !== "P1");
      if (defaultCode) selectPreset(defaultCode.id);
    } else {
      const firstManual = presets.find((p) => p.id !== "P1" && p.id !== "P7");
      if (firstManual) selectPreset(firstManual.id);
    }
  }));

  console.log("[memoryPresetChat] 记忆AI预设交互模块已初始化");
}
