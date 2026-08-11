/**
 * tokenProgressBar.mjs — Token 进度条 + 上下文管理面板 + 压缩入口
 *
 * 功能链：
 *   index.mjs init → initTokenProgressBar() → createProgressBarDOM（注入 #top-bar-left）
 *   + observeChatMessages（MutationObserver）+ 5s 定时器
 *   → _doRefresh → fake-send API → updateProgressBarUI（进度条着色/数字）
 *   压缩按钮 → showCompressPanel → executeFullCompact / executeSmartClean / executeCleanInjections
 *   压缩完成 → initializeVirtualQueue（增量重渲染，替代 location.reload）
 *
 * why：
 *   Token 用量须含系统提示词+注入内容，前端无法精确计算，必须走 fake-send API 获取后端估算值；
 *   分母权威源为后端 _effective_max_context（子模式 > runtime > 预设 三层合并），防止前后端不一致；
 *   本模块只显示/清理，不管理上下文窗口——上下文入口在子模式面板与 AIRP 模型参数面板（凛倾 2026-07-07）；
 *   阈值自动弹窗通知已删（凛倾 2026-07-07"关闭上下文通知"），清理一律由用户主动打开上下文管理面板。
 *   不管消息渲染（messageList）、不管 WS 通信（websocket.mjs）、不管记忆/归档后端逻辑（beilu-memory）。
 *
 * 关联链：
 *   ← index.mjs（initTokenProgressBar 调用入口）
 *   ← websocket.mjs EventBus generation_ended（AI 生成完成后立即刷新）
 *   ← beilu:tokenUsage CustomEvent（API 响应缓存命中统计）
 *   → shared/transport/endpoints.mjs（currentChatId）
 *   → shared/render/virtualQueue.mjs（initializeVirtualQueue：压缩后增量刷新）
 *   → beilu-memory 插件后端（compactContext / smartCleanChat / clearInjections）
 *   → memAiBubble.mjs（压缩面板内 AI 输出气泡渲染）
 *
 * 影响范围：
 *   DOM：#token-progress-container 系列节点（顶栏 Token 插槽）；
 *   事件：beilu:code-token-status CustomEvent（供其它模块监听 Token 状态）；
 *   后端：fake-send / beilu-memory setdata 请求（压缩操作不可逆，执行前需用户确认）。
 *
 * 使用效果：
 *   顶栏实时显示 Token 用量百分比；超阈值弹压缩面板；压缩后消息列表增量刷新无需整页重载。
 *
 * Token 计数策略（优先级）：
 *   1. fake-send API 返回的后端精确 estimated_tokens（含系统提示词+注入）
 *   2. 回退：DOM 字符数 × 0.4 粗估（仅对话消息部分）
 */

import { currentChatId } from "../transport/endpoints.mjs";
import { escapeHtml as _escapeHtml } from "../state/utils.mjs";
import { getCharId } from "../state/sharedState.mjs";
import { renderMemAiBubble } from "../render/memAiBubble.mjs";
import { showToast as _publicShowToast } from "../../../../../../scripts/toast.mjs";
import { wbDetect } from "./whitebox.mjs";
import { sendAction } from "../transport/sendAction.mjs"; // T6b：出向统一门面
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { mirrorReasoningTagsFromConfig } from "../state/reasoningTags.mjs"; // P2并口：思维链编辑唯一家=设置→AI服务源「思维链显示」（0714收口）；本模块只留开机镜像回填
import { initializeVirtualQueue } from "../render/virtualQueue.mjs"; // 增量刷新：清理/压缩后重渲染消息列表，替代 location.reload
import { DEFAULTS } from "../../config/defaults.mjs"; // 缺省值单源（刷新间隔缺省/值域，用户设置优先）
import { onEventBus } from "../state/eventBusCore.mjs"; // [0807 转接二期#6] 总线订阅单源

// ============================================================
// 状态
// ============================================================

let _maxContext = 200000;
let _effectiveMaxContext = 0; // 单一权威源：从后端 runtime-params API 获取的生效值
let _currentChars = 0;
let _currentTokens = 0;
let _observer = null;
let _refreshTimer = null;
let _fakeSendInFlight = false;
let _fakeSendCooldownUntil = 0;
let _lastCacheUsage = null;
/** 最近一次**后端真值**（fake-send）。粗估兜底不得覆盖它——见 _doRefresh 兜底分支注释。 */
let _lastRealTokens = 0;
let _lastRealChars = 0;
/** 定时刷新句柄（凛倾 0727：一般 10 秒刷新；上下文变动直接刷新） */
let _pollTimer = null;
/** 刷新间隔（秒）单点读取：用户设置优先，缺省来自 DEFAULTS.token.pollSec；0=关闭定时。
 *  钳制在 [pollMin, pollMax]，防手改 localStorage 成 0.01 打爆后端（值域也归 DEFAULTS 单源）。 */
function _pollSec() {
  const raw = storage.get(KEYS.BEILU_TOKEN_POLL_SEC);
  const n = raw === null || raw === undefined || raw === "" ? DEFAULTS.token.pollSec : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0/非法 = 关闭定时（事件驱动仍在）
  return Math.min(Math.max(n, DEFAULTS.token.pollMin), DEFAULTS.token.pollMax);
}

async function _loadStartupConfig() {
  try {
    // T6b：走 beilu-memory#getData（HTTP !ok → 抛错走 catch）
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" });
    // T027 启动同步（P2 归位 reasoningTags.mjs）：后端 reasoning 配置 → 本地折叠标签镜像
    mirrorReasoningTagsFromConfig(data?.config);
  } catch { /* 配置加载失败保持默认值 */ }
}
// ============================================================
// DOM 创建
// ============================================================

/**
 * 创建进度条 DOM 并注入到顶部栏左侧（追加到 #top-bar-left 末尾）
 * IDE 模式显示，聊天模式隐藏整个容器
 */
function createProgressBarDOM() {
  // Phase4A: 注入到右区Token插槽（fallback到top-bar-left兼容旧版）
  const slot = document.getElementById("token-indicator-slot") || document.getElementById("top-bar-left");
  if (!slot) {
    console.warn("[tokenProgressBar] Token注入目标未找到，跳过");
    return false;
  }

  // Phase4A 复原: 顶栏只常驻圆点;进度条+按钮族收进「展开面板」(token-expand-wrap),点圆点才展开
  let wrap = document.getElementById("token-expand-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "token-expand-wrap";
    wrap.className = "token-expand-wrap hidden";
    slot.appendChild(wrap);
    // ESC 接中央仲裁注册表(FT-D7),与浮窗/弹层同序
    const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
    if (!reg.some((r) => r._id === "token-expand")) {
      reg.push({
        _id: "token-expand",
        priority: 40,
        isOpen: () => !wrap.classList.contains("hidden"),
        close: () => wrap.classList.add("hidden"),
      });
    }
    // N26 同族收口：token 按钮族动态弹窗（上下文管理/归档/P1/P1诊断）接 ESC 仲裁——
    // 动态创建节点不在仲裁器内置兜底清单里，注册存在性条目（存在即视为打开）；
    // P1 诊断层叠在 P1 面板上层，优先级更高先被 ESC 关。
    for (const [oid, pri] of [
      ["compress-panel-overlay", 30],
      ["archive-panel-overlay", 30],
      ["p1-panel-overlay", 30],
      ["p1-diag-overlay", 45],
    ]) {
      if (!reg.some((r) => r._id === oid)) {
        reg.push({
          _id: oid,
          priority: pri,
          isOpen: () => !!document.getElementById(oid),
          close: () => document.getElementById(oid)?.remove(),
        });
      }
    }
    // 点外关闭
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target) && e.target?.id !== "token-indicator-dot") {
        wrap.classList.add("hidden");
      }
    });
  }

  // Phase4A: 圆点指示器（始终可见，不受 container 显隐控制）
  let dot = document.getElementById("token-indicator-dot");
  if (!dot) {
    dot = document.createElement("span");
    dot.id = "token-indicator-dot";
    dot.className = "token-indicator-dot";
    dot.title = "Token用量(点击展开详情)";
    dot.textContent = "●";
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = wrap.classList.contains("hidden");
      wrap.classList.toggle("hidden");
      if (opening) refreshTokenProgressImmediate();
    });
    slot.appendChild(dot);
  }
  // 常驻改造：进度条本体直接钉在顶栏(下方 slot.appendChild(container))，圆点冗余 → 隐藏。
  dot.style.display = "none";

  const container = document.createElement("div");
  container.id = "token-progress-container";
  container.className = "token-progress-container";

  container.innerHTML = `
     <div class="token-progress-bar-wrapper" id="token-progress-bar-wrapper"
          title="Token 用量 · 事件驱动刷新 · 点击立即刷新">
       <div class="token-progress-cache" id="token-progress-cache"></div>
       <div class="token-progress-fill" id="token-progress-fill"></div>
     </div>
     <span class="token-progress-text" id="token-progress-text">—</span>
     <button class="token-compress-btn menu_button" id="token-compress-btn" title="上下文管理" aria-label="上下文管理"><i data-ic="broom" aria-hidden="true"></i></button>
     <button class="token-compress-btn token-p1-btn menu_button" id="token-p1-btn" title="P1检索AI输出" aria-label="P1检索AI输出">P1</button>
     <button class="token-compress-btn menu_button" id="token-settings-btn" title="Token设置" aria-label="Token设置"><i data-ic="settings" aria-hidden="true"></i></button>
   `;

  // 常驻改造：container(进度条+读数+按钮族)直接挂顶栏 slot，内联常驻可见(原收进 hidden 的 token-expand-wrap 里=要点圆点才出现)。
  // .token-progress-container 自带 display:flex+背景，独立内联渲染正常；token-expand-wrap 仍保留(空)以兼容 ESC 仲裁/点外关闭逻辑。
  slot.appendChild(container);
  // 绑定事件 — 点击立即刷新（跳过防抖）
  document
    .getElementById("token-progress-bar-wrapper")
    ?.addEventListener("click", () => refreshTokenProgressImmediate());

  // 绑定压缩按钮 — 弹出选择面板
  document
    .getElementById("token-compress-btn")
    ?.addEventListener("click", () => showCompressPanel());

  // 绑定P1按钮 — 弹出P1检索AI输出面板
  document
    .getElementById("token-p1-btn")
    ?.addEventListener("click", () => showP1Panel());

  // 绑定设置按钮 — 弹出Token设置悬浮窗
  document
    .getElementById("token-settings-btn")
    ?.addEventListener("click", () => _showTokenSettingsPopup());

  return true;
}

/**
 * 更新进度条容器的显隐
 * T01 起所有模式都显示进度条，参数 _isIdeMode 已废弃不参与判断
 * @param {boolean} _isIdeMode - 已废弃，保留以兼容调用方签名
 */
function updateCompressBtnVisibility(_isIdeMode) {
  const container = document.getElementById("token-progress-container");
  if (!container) return;
  // T01: 所有模式都显示进度条，不再按模式隐藏
  container.classList.remove("hidden");
}
// ============================================================

/**
 * 从 DOM 聊天消息统计字符数（fallback 用）
 * @returns {number} 总字符数
 */
function countCharsFromDOM() {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return 0;

  let totalChars = 0;
  // 统计所有消息的文本内容（包括 user 和 assistant）
  chatMessages.querySelectorAll(".message-content").forEach((el) => {
    totalChars += (el.textContent || "").length;
  });

  return totalChars;
}

/**
 * 格式化 token/字符 数量为可读字符串
 * @param {number} n - 数量
 * @returns {string} 格式化后的字符串
 */
function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toString();
}

/**
 * 读取最大上下文值（从 DOM 输入框）
 * @returns {number}
 */
function readMaxContext() {
  return _effectiveMaxContext || 200000;
}

// ============================================================
// UI 更新
// ============================================================

/**
 * 刷新进度条显示（防抖调度入口）
 * 每次调用会延迟 1000ms 执行，多次调用只执行最后一次
 */
function refreshTokenProgress() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(_doRefresh, 1000);
}

/**
 * 立即刷新（跳过防抖，供初始化和手动点击使用）
 */
function refreshTokenProgressImmediate() {
  clearTimeout(_refreshTimer);
  _doRefresh();
}

/**
 * 实际刷新逻辑（异步，refreshTokenProgress 防抖后的真正执行体）。
 *
 * 链路：1. GET runtime-params → 取 _effective_max_context（分母单一权威源）
 *       2. GET fake-send → 取 estimated_tokens + total_chars + code_token_status（精确计数）
 *       3. 失败回退 → countCharsFromDOM × 0.4（粗估）
 *       → updateProgressBarUI（更新进度条+颜色+文案+tooltip）
 * 影响：修改 _currentTokens/_currentChars/_effectiveMaxContext、更新 DOM、可能派发 beilu:code-token-status
 *
 * 不要在此函数中写 _maxContext 的本地值——分母唯一来源是后端 _effective_max_context
 */
async function _doRefresh() {
  // 从后端 runtime-params 获取生效值（单一权威源：后端已合并 子模式 > runtime > 预设）
  try {
    // T6b：走 plugins:beilu-preset#getRuntimeParams（HTTP !ok → 抛错走 catch，用上次缓存值）
    const rp = await sendAction({ verb: "getRuntimeParams", target: "plugins:beilu-preset", source: "web" });
    if (rp?._effective_max_context > 0) _effectiveMaxContext = rp._effective_max_context;
  } catch { /* 静默，用上次缓存值 */ }
  _maxContext = readMaxContext();

  if (
    currentChatId &&
    !_fakeSendInFlight &&
    Date.now() >= _fakeSendCooldownUntil
  ) {
    _fakeSendInFlight = true;
    try {
      // T6b：走 shells:chat#getFakeSend（原 raw+手 res.ok/res.status 语义并入门面；
      //   HTTP 404/500 的 60s 冷却分辨在门面模式下弱化——统一 catch 走 60s 冷却上限或 fallback）
      const data = await sendAction({ verb: "getFakeSend", target: "shells:chat", source: "web", scope: { chatId: currentChatId } });
      const meta = data?._meta || {};
      _currentTokens = meta.estimated_tokens || 0;
      _currentChars = meta.total_chars || 0;
      _lastRealTokens = _currentTokens; // 真值留底：兜底分支据此避免用粗估假值覆盖
      _lastRealChars = _currentChars;
      const _cts = meta.code_token_status;
      // 同轮一致性：limit 与分子 estimated_tokens 出自同一次 fake-send 构建（同 chat 同轮快照），
      //   分子分母同快照 → percentage 自洽；getRuntimeParams 作冷启动/fake-send 冷却期的实时值。
      //   [P3 已修 2026-07-13] getRuntimeParams 桥层已注入 chatid/charName（sendAction.mjs:283），
      //   后端同走 resolveEffectiveMaxContextLive(user, mode, cid) 精确解析——两源同函数同参，
      //   此覆盖不再是"精确救 best-effort"的补丁，只保同轮一致性语义。
      if (_cts && Number(_cts.limit) > 0) {
        _effectiveMaxContext = Number(_cts.limit);
        _maxContext = readMaxContext();
      }
      updateProgressBarUI(_currentTokens, _maxContext, _currentChars);
      if (_cts && typeof _cts.percentage === "number") {
        window.dispatchEvent(new CustomEvent("beilu:code-token-status", { detail: {
          exceeded: _cts.percentage >= 80,
          usedPercent: _cts.percentage,
          usedTokens: _cts.used, // 语义修正：后端 used=注入+chatLog 的 token 估算（原名 hotLayerChars=任务G热层字符时代遗名，值早已不是字符）
          limit: _cts.limit,
        }}));
      }
      _fakeSendCooldownUntil = Date.now() + 3000;
      return;
    } catch (err) {
      // [0727] 冷却 60s → 20s：与 10s 定时刷新协调（60s 内 6 次刷新全被冷却挡掉=看着在刷其实停摆）
      _fakeSendCooldownUntil = Date.now() + 20000;
      console.warn(
        "[tokenProgressBar] fake-send 请求失败（20秒内暂停重试）:",
        err.message,
      );
    } finally {
      _fakeSendInFlight = false;
    }
  }

  // ══ 兜底分支（拿不到后端真值时）══
  // [0727 假值根修·凛倾实测 3.0k vs 真值 72,641] 原来无条件用「DOM 字符数 × 0.4」粗估并覆盖显示：
  //   ① iframe 渲染的消息（美化卡/全屏 HTML）内容在 iframe 文档里，父文档 textContent **数不到** →
  //      粗估≈只数了外面零星文字 → 得出与真值差 20 倍以上的假数，用户据此判断上下文余量就是错的；
  //   ② 即便没有 iframe，粗估也只覆盖对话正文，不含系统提示词/注入（真值的大头）。
  //   诚实降级：有过真值就保留真值显示（标 stale，不用假值覆盖）；从未取到过真值才显示粗估，
  //   且此时若页面存在 iframe 消息，直接显示"—"（数不到就说数不到，不编造）。
  if (_lastRealTokens > 0) {
    updateProgressBarUI(_lastRealTokens, _maxContext, _lastRealChars, { stale: true });
    return;
  }
  const _hasIframeMsg = !!document.querySelector("#chat-messages .iframe-content, #chat-messages iframe");
  if (_hasIframeMsg) {
    updateProgressBarUI(0, _maxContext, 0, { unknown: true });
    return;
  }
  _currentChars = countCharsFromDOM();
  _currentTokens = Math.round(_currentChars * 0.4);
  updateProgressBarUI(_currentTokens, _maxContext, _currentChars, { rough: true });
}

/**
 * 更新进度条 DOM
 * @param {number} currentTokens - 当前估算 token
 * @param {number} maxTokens - 最大上下文 token
 * @param {number} totalChars - 原始字符数
 */
function updateProgressBarUI(currentTokens, maxTokens, totalChars, quality = {}) {
  const fill = document.getElementById("token-progress-fill");
  const text = document.getElementById("token-progress-text");
  const wrapper = document.getElementById("token-progress-bar-wrapper");
  const cacheFill = document.getElementById("token-progress-cache");
  if (!fill || !text) return;
  // [0727 数据质量可见] 后端真值取不到时不装作正常：unknown=完全数不到（显示 —）、
  //   stale=显示上次真值（值真但可能过期）、rough=DOM 粗估（不含系统提示词/注入，只在无 iframe 时用）。
  if (quality.unknown) {
    fill.style.width = "0%";
    text.textContent = `— / ${formatTokenCount(maxTokens)}`;
    if (wrapper) wrapper.title = "Token 用量暂不可用：后端估算接口未返回，且本对话含 iframe 渲染消息（页面侧数不到字数）。\n点击重试";
    return;
  }

  const ratio = maxTokens > 0 ? currentTokens / maxTokens : 0;
  const percent = Math.min(ratio * 100, 100);

  fill.style.width = percent + "%";

  // ★ 缓存段：浅蓝色底层显示缓存命中部分占总量的比例
  if (cacheFill && _lastCacheUsage) {
    const _cacheRead = _lastCacheUsage.cache_read_input_tokens || 0;
    if (_cacheRead > 0 && maxTokens > 0) {
      const _cachePercent = Math.min((_cacheRead / maxTokens) * 100, 100);
      cacheFill.style.width = _cachePercent + "%";
    } else {
      cacheFill.style.width = "0%";
    }
  }

  // 颜色阶梯：绿 → 黄 → 红
  const dot = document.getElementById("token-indicator-dot");
  if (ratio < 0.6) {
    fill.className = "token-progress-fill tp-green";
    if (dot) dot.className = "token-indicator-dot token-green";
  } else if (ratio < 0.8) {
    fill.className = "token-progress-fill tp-yellow";
    if (dot) dot.className = "token-indicator-dot token-yellow";
  } else {
    fill.className = "token-progress-fill tp-red";
    if (dot) dot.className = "token-indicator-dot token-red";
  }

  // 格式化显示文本
  const currentStr = formatTokenCount(currentTokens);
  const maxStr = formatTokenCount(maxTokens);
  const charsStr = totalChars.toLocaleString();

  // ★ 如果有缓存信息，显示缓存命中情况
  const _qMark = quality.stale ? " ·上次值" : (quality.rough ? " ·粗估" : "");
  if (_lastCacheUsage && _lastCacheUsage.cache_read_input_tokens > 0) {
    const _cacheRead = _lastCacheUsage.cache_read_input_tokens;
    const _totalInput = _lastCacheUsage.input_tokens + _cacheRead;
    const _hitRate = _totalInput > 0 ? Math.round(_cacheRead / _totalInput * 100) : 0;
    text.textContent = `${currentStr} / ${maxStr} (缓存${_hitRate}%)${_qMark}`;
  } else {
    text.textContent = `${currentStr} / ${maxStr}${_qMark}`;
  }

  // 更新 tooltip
  if (wrapper) {
    let _tooltipLines = [
      `总字符: ${charsStr}`,
      `预估 Token: ~${currentStr}`,
      `最大上下文: ${maxStr} tokens`,
      `使用率: ${percent.toFixed(1)}%`,
    ];
    // ★ 缓存详情
    if (_lastCacheUsage) {
      const _cr = _lastCacheUsage.cache_read_input_tokens || 0;
      const _cw = _lastCacheUsage.cache_creation_input_tokens || 0;
      const _in = _lastCacheUsage.input_tokens || 0;
      const _out = _lastCacheUsage.output_tokens || 0;
      _tooltipLines.push("");
      _tooltipLines.push(`--- 上次API调用 ---`);
      _tooltipLines.push(`输入: ${formatTokenCount(_in)} (新增付费)`);
      _tooltipLines.push(`输出: ${formatTokenCount(_out)}`);
      if (_cr > 0) _tooltipLines.push(`缓存命中: ${formatTokenCount(_cr)} (0.1x价格)`);
      if (_cw > 0) _tooltipLines.push(`缓存创建: ${formatTokenCount(_cw)} (1.25x价格)`);
      if (_cr > 0 || _cw > 0) {
        const _total = _in + _cr;
        const _hitRate = _total > 0 ? Math.round(_cr / _total * 100) : 0;
        _tooltipLines.push(`命中率: ${_hitRate}%`);
      }
    }
    _tooltipLines.push("");
    _tooltipLines.push("点击刷新");
    wrapper.title = _tooltipLines.join("\n");
  }
}

// ============================================================
// 自动观察
// ============================================================

/**
 * 使用 MutationObserver 监听聊天消息变化
 */
function observeChatMessages() {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;

  // 如果已有 observer，先断开
  if (_observer) {
    _observer.disconnect();
  }

  _observer = new MutationObserver(() => {
    // 消息变化后触发防抖刷新（refreshTokenProgress 内部有 1000ms 防抖）
    refreshTokenProgress();
  });

  _observer.observe(chatMessages, {
    childList: true,
    subtree: false,
  });
}

// ============================================================
// 上下文管理面板（任务C）
// ============================================================

/**
 * 获取当前聊天消息总数
 */
async function getChatMessageCount() {
  // 优先通过 API 获取
  if (currentChatId) {
    try {
      // T6b：走 shells:chat#getLogLengthVisible（HTTP !ok → 抛错走 catch，与原 else fallback DOM 计数语义等价）
      const data = await sendAction({ verb: "getLogLengthVisible", target: "shells:chat", source: "web", scope: { chatId: currentChatId } });
      const count = typeof data === "number" ? data : data?.length || data?.count || 0;
      if (count > 0) return count;
    } catch {
      /* ignore */
    }
  }
  // 回退：从 DOM 中计算消息数量（排除隐藏的系统消息）
  const msgItems = document.querySelectorAll("#chat-messages .chat-message:not(.system-hidden):not(.beilu-hidden-msg)");
  if (msgItems.length > 0) return msgItems.length;
  // 再试不带过滤
  const allMsgs = document.querySelectorAll("#chat-messages .chat-message");
  if (allMsgs.length > 0) return allMsgs.length;
  console.warn("[tokenProgressBar] getChatMessageCount: currentChatId =", currentChatId, " → 无法获取消息数");
  return 0;
}

function showToast(type, msg) {
  _publicShowToast(type || "info", msg || "", 3000);
}

/**
 * 弹出上下文管理面板（两步式：全量清理 / 自由清理）。
 *
 * 链路：#token-compress-btn 点击 → 本函数 → overlay+panel DOM → 用户选择
 *       → executeFullCompact（AI摘要→屏蔽旧对话→注入摘要→initializeVirtualQueue 增量刷新）
 *       → executeSmartClean（保留最近N条，屏蔽其余→initializeVirtualQueue）
 *       → executeCleanInjections（清除P1/搜索/工具/XML/分身注入）
 *       → showReadCachePanel（文件缓存管理，勾选清理）
 * 影响：创建 overlay DOM（#compress-panel-overlay）、调后端 beilu-memory 插件的多个 _action
 * 约束：所有清理操作使用 _hidden 屏蔽，不物理删除消息（可恢复）
 */
async function showCompressPanel() {
  document.getElementById("compress-panel-overlay")?.remove();

  let totalMessages = await getChatMessageCount();
  console.log("[compress] showCompressPanel: totalMessages =", totalMessages, "currentChatId =", currentChatId);
  if (totalMessages <= 0) totalMessages = 50;

  const overlay = document.createElement("div");
  overlay.id = "compress-panel-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:var(--z-overlay);display:flex;align-items:center;justify-content:center;";

  const panel = document.createElement("div");
  panel.id = "compress-panel";
  panel.style.cssText = "background:oklch(var(--b2,0.2 0 0));border-radius:12px;padding:20px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);color:oklch(var(--bc,0.9 0 0));max-height:80vh;overflow-y:auto;";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // ── 按钮样式模板 ──
  const btnStyle = "width:100%;padding:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.15);border-radius:8px;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;text-align:left;";
  const execBtnStyle = "flex:1;padding:8px;border:none;border-radius:6px;background:var(--beilu-accent);color:var(--beilu-accent-text);cursor:pointer;font-weight:600;font-size:13px;";
  const backBtnStyle = "padding:8px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:12px;";
  const cancelBtnStyle = "width:100%;padding:8px;border:none;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;opacity:0.6;font-size:12px;";

  // ── 滑块组件 ──
  function sliderHtml(id, max, defaultVal, label) {
    const val = Math.min(defaultVal, max);
    return `
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;opacity:0.7;">${label}</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
          <input type="range" id="${id}" min="1" max="${max}" value="${val}" style="flex:1;" />
          <span id="${id}-label" style="font-size:13px;font-weight:600;min-width:40px;text-align:center;">${val}</span>
        </div>
        <div style="font-size:11px;opacity:0.5;margin-top:2px;">
          将屏蔽前 <span id="${id}-hide">${Math.max(0, max - val)}</span> 条消息，保留后 <span id="${id}-keep">${val}</span> 条
        </div>
      </div>`;
  }
  function bindSlider(id, max) {
    const slider = document.getElementById(id);
    if (!slider) return;
    slider.addEventListener("input", () => {
      const v = parseInt(slider.value);
      const lbl = document.getElementById(id + "-label");
      const hide = document.getElementById(id + "-hide");
      const keep = document.getElementById(id + "-keep");
      if (lbl) lbl.textContent = v;
      if (hide) hide.textContent = Math.max(0, max - v);
      if (keep) keep.textContent = v;
    });
  }

  // ── 视图渲染 ──
  function renderMain() {
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:15px;"><i data-ic="broom"></i> 上下文管理</h3>
      <p style="margin:0 0 16px;font-size:12px;opacity:0.5;">当前对话共 ${totalMessages} 条消息（清理 = 上下文屏蔽，历史可回溯）</p>

      <button id="cmp-full" style="${btnStyle}">
        <div style="font-weight:600;font-size:13px;"><i data-ic="package"></i> 全量清理</div>
        <div style="font-size:11px;opacity:0.6;margin-top:4px;">AI总结旧对话 → 屏蔽原文 → 摘要注入上下文。保留完整历史。</div>
      </button>
      <button id="cmp-free" style="${btnStyle}">
        <div style="font-weight:600;font-size:13px;"><i data-ic="target"></i> 自由清理</div>
        <div style="font-size:11px;opacity:0.6;margin-top:4px;">手动选择要清理的内容类型：对话/文件读取/系统注入。</div>
      </button>

      <button id="cmp-cancel" style="${cancelBtnStyle}">取消</button>`;

    document.getElementById("cmp-full")?.addEventListener("click", renderFullClean);
    document.getElementById("cmp-free")?.addEventListener("click", renderFreeMenu);
    document.getElementById("cmp-cancel")?.addEventListener("click", () => overlay.remove());
  }

  // ── 全量清理 ──
  function renderFullClean() {
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:15px;"><i data-ic="package"></i> 全量清理</h3>
      <p style="margin:0 0 12px;font-size:12px;opacity:0.6;">AI分析旧对话生成摘要，旧消息被屏蔽，摘要注入上下文。</p>
      ${sliderHtml("cmp-full-slider", totalMessages, Math.min(10, totalMessages), "保留最后几条消息：")}
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button id="cmp-full-exec" style="${execBtnStyle}">执行全量清理</button>
        <button id="cmp-full-back" style="${backBtnStyle}">返回</button>
      </div>`;

    bindSlider("cmp-full-slider", totalMessages);
    document.getElementById("cmp-full-back")?.addEventListener("click", renderMain);
    document.getElementById("cmp-full-exec")?.addEventListener("click", async () => {
      const keepCount = parseInt(document.getElementById("cmp-full-slider")?.value || "10");
      overlay.remove();
      await executeFullCompact(keepCount, totalMessages);
    });
  }

  // ── 自由清理菜单 ──
  function renderFreeMenu() {
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:15px;"><i data-ic="target"></i> 自由清理</h3>
      <p style="margin:0 0 12px;font-size:12px;opacity:0.6;">选择要清理的内容类型：</p>

      <button id="cmp-free-chat" style="${btnStyle}">
        <div style="font-weight:600;font-size:13px;"><i data-ic="message"></i> 对话消息</div>
        <div style="font-size:11px;opacity:0.6;margin-top:4px;">屏蔽旧的对话轮次，保留最近N条消息。</div>
      </button>
      <button id="cmp-free-files" style="${btnStyle}">
        <div style="font-weight:600;font-size:13px;"><i data-ic="folder-open"></i> 文件读取</div>
        <div style="font-size:11px;opacity:0.6;margin-top:4px;">查看AI读取的文件，选择性屏蔽不再需要的。</div>
      </button>
      <button id="cmp-free-inject" style="${btnStyle}">
        <div style="font-weight:600;font-size:13px;"><i data-ic="wrench"></i> 系统注入</div>
        <div style="font-size:11px;opacity:0.6;margin-top:4px;">清理P1记忆搜索、联网搜索、工具调用结果、XML操作标签等。</div>
      </button>

      <button id="cmp-free-back" style="${cancelBtnStyle}">返回主菜单</button>`;

    document.getElementById("cmp-free-chat")?.addEventListener("click", renderFreeChat);
    document.getElementById("cmp-free-files")?.addEventListener("click", () => showReadCachePanel(overlay));
    document.getElementById("cmp-free-inject")?.addEventListener("click", renderFreeInject);
    document.getElementById("cmp-free-back")?.addEventListener("click", renderMain);
  }

  // ── 自由清理 - 对话消息 ──
  function renderFreeChat() {
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:15px;"><i data-ic="message"></i> 对话消息清理</h3>
      <p style="margin:0 0 12px;font-size:12px;opacity:0.6;">屏蔽旧的对话轮次，AI将不再看到被屏蔽的消息。</p>
      ${sliderHtml("cmp-chat-slider", totalMessages, Math.min(10, totalMessages), "保留最后几条消息：")}
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button id="cmp-chat-exec" style="${execBtnStyle}">执行</button>
        <button id="cmp-chat-back" style="${backBtnStyle}">返回</button>
      </div>`;

    bindSlider("cmp-chat-slider", totalMessages);
    document.getElementById("cmp-chat-back")?.addEventListener("click", renderFreeMenu);
    document.getElementById("cmp-chat-exec")?.addEventListener("click", async () => {
      const keepCount = parseInt(document.getElementById("cmp-chat-slider")?.value || "10");
      overlay.remove();
      await executeSmartClean(keepCount);
    });
  }

  // ── 自由清理 - 系统注入 ──
  function renderFreeInject() {
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:15px;"><i data-ic="wrench"></i> 系统注入清理</h3>
      <p style="margin:0 0 12px;font-size:12px;opacity:0.6;">选择要清理的注入内容（清除后端缓存 + 屏蔽上下文）：</p>

      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="cmp-inj-p1" checked style="margin-top:2px;" />
          <div>
            <div style="font-weight:500;">P1 记忆搜索结果</div>
            <div style="font-size:11px;opacity:0.5;">P1检索AI的搜索结果缓存</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="cmp-inj-web" checked style="margin-top:2px;" />
          <div>
            <div style="font-weight:500;">联网搜索结果</div>
            <div style="font-size:11px;opacity:0.5;">P8 Web搜索注入的内容</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="cmp-inj-tool" checked style="margin-top:2px;" />
          <div>
            <div style="font-weight:500;">工具调用结果</div>
            <div style="font-size:11px;opacity:0.5;">IDE工具(read_file/search_files等)的返回结果</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="cmp-inj-xml" checked style="margin-top:2px;" />
          <div>
            <div style="font-weight:500;">XML 操作标签</div>
            <div style="font-size:11px;opacity:0.5;">消息中的 &lt;tableEdit&gt; &lt;memoryArchive&gt; &lt;ideToolCall&gt; 等标签</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="cmp-inj-clone" style="margin-top:2px;" />
          <div>
            <div style="font-weight:500;">分身委派记录</div>
            <div style="font-size:11px;opacity:0.5;">分身任务的委派和返回结果</div>
          </div>
        </label>
      </div>

      <div style="display:flex;gap:8px;">
        <button id="cmp-inj-exec" style="${execBtnStyle}">执行清理</button>
        <button id="cmp-inj-back" style="${backBtnStyle}">返回</button>
      </div>`;

    document.getElementById("cmp-inj-back")?.addEventListener("click", renderFreeMenu);
    document.getElementById("cmp-inj-exec")?.addEventListener("click", async () => {
      const opts = {
        p1: document.getElementById("cmp-inj-p1")?.checked ?? false,
        web: document.getElementById("cmp-inj-web")?.checked ?? false,
        tool: document.getElementById("cmp-inj-tool")?.checked ?? false,
        xml: document.getElementById("cmp-inj-xml")?.checked ?? false,
        clone: document.getElementById("cmp-inj-clone")?.checked ?? false,
      };
      overlay.remove();
      await executeCleanInjections(opts);
    });
  }

  // ── 初始渲染 ──
  renderMain();

  // 点击遮罩关闭
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ============================================================
// P1 检索AI输出面板
// ============================================================

/** @type {number} 上次拉取的P1 output id */
let _p1LastSinceId = 0;
/** @type {Array} P1输出历史（前端累积） */
let _p1OutputHistory = [];
/** @type {number|null} 自动刷新定时器 */
let _p1PollTimer = null;


// 归档管理面板已删除（T5 2026-07-07 凛倾:「自动归档这个是错误的...那个可以删除.
// 我们只归档data,冷归档那些是p系列做的事情」）。data 归档=dataTable 表级/列级归档（dataTable.mjs）。


/**
 * 弹出P1检索AI输出查看面板
 */
async function showP1Panel() {
  document.getElementById("p1-panel-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "p1-panel-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:var(--z-overlay);display:flex;align-items:center;justify-content:center;";

  const panel = document.createElement("div");
  panel.id = "p1-panel";
  panel.style.cssText = "background:oklch(var(--b2,0.2 0 0));border-radius:12px;padding:20px;max-width:560px;width:92%;max-height:80vh;box-shadow:0 8px 32px rgba(0,0,0,0.4);color:oklch(var(--bc,0.9 0 0));display:flex;flex-direction:column;";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // 渲染面板
  function render() {
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <h3 style="margin:0;font-size:15px;flex:1;">P1 检索AI输出</h3>
        <span id="p1-status-dot" style="width:8px;height:8px;border-radius:50%;background:${_p1OutputHistory.some(o => o.status === "running") ? "var(--beilu-accent)" : "var(--beilu-dot-inactive)"};"></span>
        <button id="p1-refresh" style="border:none;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:14px;opacity:0.7;" title="刷新"><i data-ic="refresh"></i></button>
        <button id="p1-diag" style="border:none;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:11px;opacity:0.5;" title="诊断快照">DIAG</button>
      </div>
      <div id="p1-output-list" style="flex:1;overflow-y:auto;min-height:100px;max-height:60vh;"></div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button id="p1-clear" style="padding:6px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:12px;opacity:0.7;">清空历史</button>
        <div style="flex:1;"></div>
        <button id="p1-close" style="padding:6px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:12px;">关闭</button>
      </div>`;

    // 合并 v4 ②：列表项气泡改用共享渲染器（与 #1 index.mjs 同源消重）。
    // 保留原行为：最新在上（reverse）、thinking/operations/展开全文（展开内置于渲染器）。
    const listEl = panel.querySelector("#p1-output-list");
    if (_p1OutputHistory.length === 0) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px;">暂无P1输出记录。<br>P1在每次用户发送消息时自动触发。</div>';
    } else {
      for (let i = _p1OutputHistory.length - 1; i >= 0; i--) {
        listEl.appendChild(renderMemAiBubble(_p1OutputHistory[i], { showThinking: true, showOperations: true, expandable: true }));
      }
    }

    // 事件绑定（DIAG/刷新/清空/关闭原样保留；展开 delegation 已并入共享渲染器内部）
    document.getElementById("p1-refresh")?.addEventListener("click", () => fetchP1Output().then(render));
    document.getElementById("p1-close")?.addEventListener("click", () => { stopP1Poll(); overlay.remove(); });
    document.getElementById("p1-clear")?.addEventListener("click", () => { _p1OutputHistory = []; _p1LastSinceId = 0; render(); });
    document.getElementById("p1-diag")?.addEventListener("click", () => showP1Diag(panel));
  }

  // 拉取P1输出
  async function fetchP1Output() {
    try {
      // T6b：走 beilu-memory 通配 setdata（verb=getMemoryAIOutput）
      const data = await sendAction({
        verb: "getMemoryAIOutput", target: "plugins:beilu-memory", source: "web",
        payload: { sinceId: _p1LastSinceId },
      });
      if (data?.outputs && data.outputs.length > 0) {
        for (const o of data.outputs) {
          if (o.id > _p1LastSinceId) _p1LastSinceId = o.id;
          // 更新已有的 running 记录或追加新记录
          const existing = _p1OutputHistory.find(h => h.presetId === o.presetId && h.status === "running");
          if (existing && o.status !== "running") {
            Object.assign(existing, o);
          } else if (!existing || o.status === "running") {
            _p1OutputHistory.push(o);
          }
        }
        // 只保留最近20条
        while (_p1OutputHistory.length > 20) _p1OutputHistory.shift();
      }
    } catch { /* ignore */ }
  }

  // 诊断快照
  async function showP1Diag(panelEl) {
    try {
      // T6b：走 beilu-memory 通配 setdata（verb=getDiagSnapshot）
      const diag = await sendAction({ verb: "getDiagSnapshot", target: "plugins:beilu-memory", source: "web" });
      const diagText = [
        `pluginEnabled: ${diag.pluginEnabled}`,
        `autoTrigger: ${diag.autoTrigger}`,
        `isP1Running: ${diag.isP1Running}`,
        `hasP1Cache: ${diag.hasP1Cache} (${diag.p1CacheLength || 0}字)`,
        `p1CacheTimestamp: ${diag.p1CacheTimestamp || "无"}`,
        `enabledPresets: ${(diag.enabledPresets || []).join(", ")}`,
        `cooldown: ${JSON.stringify(diag.presetSwitchCooldown || {})}`,
        `outputQueueLength: ${diag.outputQueueLength}`,
        `---`,
        `P1缓存内容:`,
        diag.p1CacheContent || "(空)",
      ].join("\n");

      const diagOverlay = document.createElement("div");
      diagOverlay.id = "p1-diag-overlay";
      diagOverlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:var(--z-diag);display:flex;align-items:center;justify-content:center;";
      // [0727] 面板底/文字原为硬编码深色(#1a1a2e/#ccc)而关闭钮文字跟随主题(--bc):
      // 亮主题下 --bc=深色 → 深字贴深底不可读。收口成整面板跟随主题变量(桥保证任意主题可解析)。
      diagOverlay.innerHTML = `<div style="background:var(--color-base-200);border-radius:12px;padding:20px;max-width:500px;width:90%;max-height:70vh;overflow-y:auto;color:var(--color-base-content);">
        <h3 style="margin:0 0 12px;font-size:14px;">P1 诊断快照</h3>
        <pre style="font-size:11px;white-space:pre-wrap;word-break:break-all;line-height:1.5;opacity:0.9;">${_escapeHtml(diagText)}</pre>
        <button id="p1-diag-close" style="margin-top:12px;width:100%;padding:6px;border:1px solid oklch(var(--bc) / 0.2);border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:12px;">关闭</button>
      </div>`;
      document.body.appendChild(diagOverlay);
      document.getElementById("p1-diag-close")?.addEventListener("click", () => diagOverlay.remove());
      diagOverlay.addEventListener("click", (e) => { if (e.target === diagOverlay) diagOverlay.remove(); });
    } catch (e) {
      showToast("error", "诊断失败: " + e.message);
    }
  }

  // 自动刷新
  function startP1Poll() {
    stopP1Poll();
    _p1PollTimer = setInterval(async () => {
      await fetchP1Output();
      if (document.getElementById("p1-panel")) render();
    }, 3000);
  }
  function stopP1Poll() {
    if (_p1PollTimer) { clearInterval(_p1PollTimer); _p1PollTimer = null; }
  }

  // 初始加载 + 开始轮询
  await fetchP1Output();
  render();
  startP1Poll();

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { stopP1Poll(); overlay.remove(); }
  });
}

/**
 * 执行「对话消息清理」— 屏蔽旧对话轮次，保留最近N条
 */
async function executeSmartClean(keepRecent) {
  showToast("info", "⏳ 正在屏蔽旧对话...");
  try {
    // T6b：走 beilu-memory 通配 setdata（verb=smartCleanChat）
    const result = await sendAction({
      verb: "smartCleanChat", target: "plugins:beilu-memory", source: "web",
      payload: { chatid: currentChatId, keepRecent },
    });
    if (result?.success) {
      showToast("success", `✅ 已屏蔽 ${result.hidden} 条旧对话，保留 ${result.kept} 条`);
      refreshTokenProgressImmediate();
      // 增量刷新：重渲染消息列表（替代 location.reload，避免切窗口回来整页闪白）
      await initializeVirtualQueue({});
    } else {
      showToast("error", "清理失败: " + (result.error || result.message));
    }
  } catch (e) {
    showToast("error", "清理失败: " + e.message);
  }
}

/**
 * 显示文件缓存管理面板（从压缩面板进入）
 */
async function showReadCachePanel(overlay) {
  // 从chatLog扫描所有文件读取（包括重启前的历史记录）
  let cacheEntries = [];
  try {
    // T6b：走 beilu-memory 通配 setdata（verb=getReadCacheFromChat）
    const data = await sendAction({
      verb: "getReadCacheFromChat", target: "plugins:beilu-memory", source: "web",
      payload: { chatid: currentChatId },
    });
    cacheEntries = data?.entries || [];
  } catch (e) {
    console.warn("[compress] 获取文件缓存失败:", e);
  }

  const panel = overlay.querySelector("#compress-panel");
  if (!panel) return;

  if (cacheEntries.length === 0) {
    panel.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:15px;"><i data-ic="folder-open"></i> 文件缓存</h3>
      <p style="font-size:13px;opacity:0.7;margin-bottom:16px;">当前没有文件读取缓存。</p>
      <button id="rc-back" style="width:100%;padding:8px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:12px;">返回</button>
    `;
    panel.querySelector("#rc-back")?.addEventListener("click", () => overlay.remove());
    return;
  }

  // 计算总token
  const totalTokens = cacheEntries.reduce((s, e) => s + (e.tokens || 0), 0);

  // 生成文件列表（带勾选框）
  const listHtml = cacheEntries.map((entry, idx) => {
    const ageMin = Math.round(entry.age / 60000);
    const ageStr = ageMin < 1 ? "<1分钟前" : ageMin < 60 ? `${ageMin}分钟前` : `${Math.round(ageMin / 60)}小时前`;
    const shortPath = entry.path.length > 45 ? "..." + entry.path.slice(-42) : entry.path;
    return `
      <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;font-size:12px;" title="${_escapeHtml(entry.path)}">
        <input type="checkbox" data-idx="${idx}" style="margin-top:2px;" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;word-break:break-all;">${_escapeHtml(shortPath)}</div>
          <div style="opacity:0.5;font-size:11px;">${_escapeHtml(entry.tool)} · ${entry.lines}行 · ~${entry.tokens} token · ${ageStr}</div>
        </div>
      </label>`;
  }).join("");

  panel.innerHTML = `
    <h3 style="margin:0 0 4px;font-size:15px;"><i data-ic="folder-open"></i> 文件缓存管理</h3>
    <p style="margin:0 0 12px;font-size:12px;opacity:0.5;">共 ${cacheEntries.length} 项, ~${totalTokens} token — 勾选要清理的文件</p>
    <div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
      ${listHtml}
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <label style="font-size:11px;opacity:0.7;cursor:pointer;display:flex;align-items:center;gap:4px;">
        <input type="checkbox" id="rc-select-all" /> 全选
      </label>
      <span id="rc-selected-info" style="font-size:11px;opacity:0.5;margin-left:auto;">已选 0 项</span>
    </div>
    <div style="display:flex;gap:8px;">
      <button id="rc-execute" style="flex:1;padding:8px;border:none;border-radius:6px;background:var(--beilu-error);color:var(--beilu-error-text);cursor:pointer;font-weight:600;font-size:13px;" disabled>清理选中文件</button>
      <button id="rc-back" style="padding:8px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:oklch(var(--bc,0.9 0 0));cursor:pointer;font-size:12px;">返回</button>
    </div>
  `;

  // 全选
  const selectAllCb = panel.querySelector("#rc-select-all");
  const allCbs = panel.querySelectorAll("input[data-idx]");
  const selectedInfo = panel.querySelector("#rc-selected-info");
  const executeBtn = panel.querySelector("#rc-execute");

  function updateSelectedInfo() {
    const checked = panel.querySelectorAll("input[data-idx]:checked");
    const count = checked.length;
    const tokens = Array.from(checked).reduce((s, cb) => s + (cacheEntries[parseInt(cb.dataset.idx)]?.tokens || 0), 0);
    if (selectedInfo) selectedInfo.textContent = `已选 ${count} 项 (~${tokens} token)`;
    if (executeBtn) executeBtn.disabled = count === 0;
  }

  selectAllCb?.addEventListener("change", () => {
    allCbs.forEach(cb => { cb.checked = selectAllCb.checked; });
    updateSelectedInfo();
  });
  allCbs.forEach(cb => cb.addEventListener("change", updateSelectedInfo));

  // 执行清理
  executeBtn?.addEventListener("click", async () => {
    const checked = panel.querySelectorAll("input[data-idx]:checked");
    const selectedEntries = Array.from(checked).map(cb => cacheEntries[parseInt(cb.dataset.idx)]).filter(Boolean);
    if (selectedEntries.length === 0) return;

    const paths = selectedEntries.map(e => e.path).filter(p => p && !p.startsWith("("));
    const chatLogIndices = selectedEntries.map(e => e.chatLogIndex).filter(i => typeof i === "number" && i >= 0);

    overlay.remove();
    try {
      // T6b：走 beilu-memory 通配 setdata（verb=cleanReadCache）
      await sendAction({
        verb: "cleanReadCache", target: "plugins:beilu-memory", source: "web",
        payload: { paths, chatLogIndices, chatid: currentChatId },
      });
      showToast("success", `✅ 已清理 ${selectedEntries.length} 个文件缓存`);
      refreshTokenProgressImmediate();
    } catch (e) {
      console.error("[compress] 清理文件缓存失败:", e);
      showToast("error", "清理失败: " + e.message);
    }
  });

  panel.querySelector("#rc-back")?.addEventListener("click", () => overlay.remove());
}

/**
 * 执行「系统注入清理」— 清除后端缓存 + 屏蔽相关消息中的内容
 * @param {object} opts - { p1, web, tool, xml, clone }
 */
async function executeCleanInjections(opts) {
  showToast("info", "⏳ 正在清理系统注入...");
  const results = [];

  try {
    // 1. 清除后端注入缓存（P1/搜索/工具结果）
    if (opts.p1 || opts.web || opts.tool) {
      try {
        // T6b：走 beilu-memory 通配 setdata（verb=clearInjections）；原 cacheRes.ok 分支简化：门面成功即视为清除
        await sendAction({
          verb: "clearInjections", target: "plugins:beilu-memory", source: "web",
          payload: { clearSummary: false, clearP1: opts.p1, clearWeb: opts.web, clearTool: opts.tool, chatid: currentChatId },
        });
        results.push("缓存已清除");
      } catch { /* 失败不阻塞后续步骤 */ }
    }

    // 2. 清理消息中的XML操作标签
    if (opts.xml && currentChatId) {
      try {
        // T6b：走 beilu-memory 通配 setdata（verb=cleanXmlTags）
        const xmlResult = await sendAction({
          verb: "cleanXmlTags", target: "plugins:beilu-memory", source: "web",
          payload: { chatid: currentChatId },
        });
        if (xmlResult?.cleanedCount > 0) results.push(`${xmlResult.cleanedCount}条XML标签已清理`);
      } catch { /* 失败不阻塞 */ }
    }

    // 3. 屏蔽分身委派记录（标记含分身标签的系统消息为_hidden）
    if (opts.clone && currentChatId) {
      try {
        // T6b：走 beilu-memory 通配 setdata（verb=hideCloneMessages）
        const cloneResult = await sendAction({
          verb: "hideCloneMessages", target: "plugins:beilu-memory", source: "web",
          payload: { chatid: currentChatId },
        });
        if (cloneResult?.hidden > 0) results.push(`${cloneResult.hidden}条分身记录已屏蔽`);
      } catch { /* 失败不阻塞 */ }
    }

    showToast("success", `✅ ${results.length > 0 ? results.join("，") : "注入清理完成"}`);
    refreshTokenProgressImmediate();
  } catch (e) {
    console.error("[compress] 清理系统注入失败:", e);
    showToast("error", "清理失败: " + e.message);
  }
}

/**
 * 执行「全量清理」— AI总结旧对话 → 屏蔽原文 → 摘要注入上下文
 */
async function executeFullCompact(keepCount, totalMessages) {
  const hideCount = totalMessages - keepCount;

  if (hideCount <= 0) {
    showToast("info", "没有需要清理的消息");
    return;
  }

  try {
    showToast("info", "⏳ 正在收集对话内容...");

    // 收集要压缩的消息文本
    const chatMsgsEl = document.getElementById("chat-messages");
    if (!chatMsgsEl) {
      showToast("error", "无法读取对话消息");
      return;
    }
    // ★ 只取可见对话(排除已隐藏灰显/系统display:none/工具结果卡)，与可见数 hideCount + smartCleanChat 可见序对齐，
    //   避免把已压缩的旧对话/系统消息/工具输出当对话喂给摘要 AI。
    const allMsgs = chatMsgsEl.querySelectorAll(".chat-message:not(.system-hidden):not(.beilu-hidden-msg):not(.ide-tool-result-msg)");
    const parts = [];
    const sourceMessageIds = [];
    for (let i = 0; i < Math.min(hideCount, allMsgs.length); i++) {
      const msgEl = allMsgs[i];
      const identity = msgEl._beiluActionIdentity;
      if (!identity
        || typeof identity.messageId !== "string"
        || !identity.messageId
        || identity.chatId !== currentChatId) {
        throw new Error("消息身份已过期或缺失，请刷新当前对话后重试压缩");
      }
      sourceMessageIds.push(identity.messageId);
      const name = msgEl.querySelector(".char-name")?.textContent?.trim() || "未知";
      const content = msgEl.querySelector(".message-content")?.textContent?.trim() || "";
      if (content) parts.push("[消息#" + i + "] " + name + ": " + content);
    }
    const chatHistory = parts.join("\n\n");

    if (!chatHistory || chatHistory.length < 50) {
      showToast("info", "对话内容太少，无需清理");
      return;
    }

    showToast("info", "⏳ AI正在生成摘要...");
    // T6b：走 beilu-memory 通配 setdata（verb=compactContext）
    const result = await sendAction({
      verb: "compactContext", target: "plugins:beilu-memory", source: "web",
      payload: { chatHistory, sourceMessageIds, messageCount: totalMessages, keepLastN: keepCount },
    });
    if (!result?.success) throw new Error(result?.error || "生成摘要失败");

    const summaryText = result.summary;

    // 使用 _hidden 屏蔽旧消息（而不是物理删除）
    showToast("info", "⏳ 正在屏蔽旧消息...");
    // T6b：走 beilu-memory 通配 setdata（verb=smartCleanChat）；原 !hideRes.ok "屏蔽旧消息失败" 由门面统一抛错
    const hideResult = await sendAction({
      verb: "smartCleanChat", target: "plugins:beilu-memory", source: "web",
      payload: {
        chatid: currentChatId, keepRecent: keepCount,
        // keep_indices：AI 摘要指定保留的旧对话原文下标（不 hide），坐标=上面 chatHistory 的 [消息#i] 序
        keepIndices: result.keep_indices || [],
      },
    });

    // 将摘要追加到第一条可见消息前（注入为系统消息）
    if (currentChatId && summaryText) {
      try {
        // T6b：走 beilu-memory 通配 setdata（verb=injectSummaryMessage）
        await sendAction({
          verb: "injectSummaryMessage", target: "plugins:beilu-memory", source: "web",
          payload: {
            chatid: currentChatId, summary: summaryText,
            hiddenCount: hideResult?.hidden || hideCount,
            originalChars: result.originalChars,
            summaryChars: result.summaryChars,
          },
        });
      } catch (appendErr) {
        console.warn("[compress] 注入摘要失败:", appendErr.message);
      }
    }

    showToast(
      "success",
      `✅ 全量清理完成：屏蔽${hideResult?.hidden || hideCount}条 · ${result.originalChars} → ${result.summaryChars}字`,
    );
    refreshTokenProgressImmediate();
    // 增量刷新：重渲染消息列表（替代 location.reload，避免切窗口回来整页闪白）
    await initializeVirtualQueue({});
  } catch (e) {
    wbDetect("token", "executeFullCompact", false, e?.message);
    console.error("[compress] 全量清理失败:", e);
    showToast("error", "清理失败: " + e.message);
  }
}

// ============================================================
// 预设切换 Toast 提醒
// ============================================================

/**
 * 显示预设切换提醒（底部右侧，2秒淡出）
 * 用于模式切换后显示当前绑定的预设名称
 * @param {string} presetName - 预设名称
 */
function showPresetToast(presetName) {
  if (!presetName) return;

  // 移除旧的 toast（如果有）
  const existing = document.getElementById("beilu-preset-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "beilu-preset-toast";
  toast.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "right:24px",
    "display:flex",
    "align-items:center",
    "gap:8px",
    "background:rgba(30,60,40,0.92)",
    "color:#e2e8f0",
    "padding:10px 18px",
    "border-radius:8px",
    "font-size:13px",
    "font-weight:500",
    "z-index:var(--z-toast)",
    "pointer-events:none",
    "transition:opacity 0.4s ease",
    "opacity:1",
    "box-shadow:0 2px 12px rgba(0,0,0,0.4)",
  ].join(";");

  toast.innerHTML = `已切换到预设: "${_escapeHtml(presetName)}" <img src="/parts/shells:beilu-chat/icons/line-md__confirm-circle.svg" style="height:18px;width:18px;filter:invert(1);">`;

  document.body.appendChild(toast);

  // 2秒后开始淡出，2.4秒后移除
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 400);
  }, 2000);
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 初始化 Token 进度条（总装配入口，由 index.mjs init 调用一次）。
 *
 * 链路：index.mjs init() → 本函数 → createProgressBarDOM + refreshTokenProgressImmediate
 *       + observeChatMessages + 注册事件监听器 + 5s 定时器
 * 影响：创建 DOM 元素（#token-progress-container 系列）、注册 MutationObserver、
 *       注册 window 事件监听器（char-changed/mode-switched/chat-switched/subModeSwitched/tokenUsage 等）、
 *       注册 EventBus generation_ended 监听器（0719 批6：5s 轮询已删，纯事件驱动刷新）
 */
export function initTokenProgressBar() {
  const created = createProgressBarDOM();
  if (!created) return;

  _loadStartupConfig();

  // T01: 所有模式都显示进度条
  updateCompressBtnVisibility(true);

  // 初始刷新（立即执行，不走防抖）
  refreshTokenProgressImmediate();

  // 自动观察消息变化
  observeChatMessages();

  // ══ 定时刷新（凛倾 0727「token条应该动态刷新,一般10秒进行刷新,如果出现上下文变动那么需要直接刷新」）══
  //   0719 曾按凛倾当时的「每次都要进行5秒的访问」删掉 5s 轮询、改纯事件驱动；本次凛倾改口径为 10s，
  //   故恢复定时器但按 10s，并加两道省流门控（不打折刷新，只避免纯无效请求）：
  //     · 页面不可见（切到别的浏览器标签）不发——回到前台时立即补一次；
  //     · 走 refreshTokenProgress（防抖 1s）而非 Immediate，与事件面共用同一条节流。
  //   "上下文变动直接刷新"由既有事件面承担（MutationObserver 消息增删 / generation_ended /
  //   模式·子模式·预设·runtime-params·API源 切换），本定时器只兜"事件面没覆盖到的变化"。
  //   间隔由用户定（Token设置 → 刷新间隔，0=只事件驱动），改完即时重启定时器（下方 beilu:token-poll-changed）。
  const _startPoll = () => {
    _stopPoll();
    const sec = _pollSec();
    if (!sec) return; // 用户设为 0 = 关闭定时刷新
    _pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshTokenProgress();
    }, sec * 1000);
  };
  const _stopPoll = () => { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } };
  _startPoll();
  // 设置里改了间隔 → 立刻按新值重启（不必刷新页面）
  window.addEventListener("beilu:token-poll-changed", _startPoll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      _fakeSendCooldownUntil = 0; // 回前台立刻要新鲜值，不等冷却
      refreshTokenProgressImmediate();
      _startPoll();
    } else {
      _stopPoll(); // 后台标签页不空转（省的是纯无效请求，不是刷新频率）
    }
  });

  // 监听角色切换 → 清除冷却（下次 5s 轮询时自然刷新，不立即发 HTTP——切角色不改 token 设置）
  window.addEventListener("beilu:char-changed", () => {
    _fakeSendCooldownUntil = 0;
  });

  // 监听模式切换 — 刷新进度条 + 更新显隐
  // [0716 凛倾定案] 原 boundPreset toast 消费块已删（「绑定」概念删除，detail 字段已清；该字段恒 null=死代码）。
  window.addEventListener("beilu:mode-switched", (e) => {
    refreshTokenProgressImmediate();
    const newMode = e.detail?.newMode;
    const isIdeMode = newMode === "code" || newMode === "work";
    updateCompressBtnVisibility(isIdeMode);
  });

  // 任务G：监听 token 状态 → 只做进度条容器警示光晕（被动视觉态）。
  //   原"编程记忆已达N%（N字符）建议归档到温层"Toast 已删：阈值自动弹窗通知按凛倾 2026-07-07
  //   「关闭上下文通知」决策全删（本监听器是当时漏扫的入口，且文案语义已烂——值是注入+chatLog
  //   token 估算，非编程记忆热层字符）。
  window.addEventListener("beilu:code-token-status", (e) => {
    const status = e.detail;
    if (!status) return;
    const container = document.getElementById("token-progress-container");
    if (!container) return;
    container.classList.toggle("token-warning-glow", !!status.exceeded);
  });

  // [0719 病征修·凛倾「每次都要进行5秒的访问」] 原每 5s setInterval 轮询已删——
  //   _doRefresh 每跑一次=2 个 HTTP（getRuntimeParams 无冷却 + getFakeSend），后者后端执行
  //   完整提示词组装（getChatRequest+全插件 GetPrompt+TweakPrompt×3+逐条 countTokens），
  //   常驻每 5s 只为刷一个数字、多窗口×N、生成中还叠加最重负载。
  //   token 用量只在事实变化时变，事件面已完备（本函数上下文的 8 个触发器）：
  //   消息增删=observeChatMessages MutationObserver（防抖1s）/ 回合完成=generation_ended /
  //   模式=mode-switched / 子模式=subModeSwitched / 角色=char-changed / API源=resource:api-changed
  //   / 模型输入=change / 预设=beilu:preset-changed（下方本批补挂）。
  //   已知残差（如实标注）：流式生成中途不再逐 5s 增长（generation_ended 终态对齐，且免去生成期最重叠加）。

  // 预设切换/内容变更 → 刷新（max_context/model 可能变；WS 侧已按窗口 cid 过滤，见 websocket.mjs preset_changed）
  window.addEventListener("beilu:preset-changed", () => {
    refreshTokenProgress();
  });
  // runtime-params 变更 → 刷新（max_context/model 覆盖可能变）。链全活：applyRuntimeParams 尾部
  // 单点广播(preset main.mjs:903) → websocket.mjs:1100 case → 本事件；此前全链无 token 条订阅。
  window.addEventListener("beilu:runtime-params-changed", () => {
    refreshTokenProgress();
  });

  // 监听子模式切换 → 刷新（子模式可能改了 max_context/model）
  window.addEventListener("beilu:subModeSwitched", () => {
    refreshTokenProgressImmediate();
  });

  // 监听 AI 生成完成 → 立即刷新（通过 EventBus）
  // [0807 转接二期#6] 手拼 push → eventBusCore.onEventBus 单源（原"bus 不存在就静默不挂"的
  //   初始化时序坑一并消除：getEventBus 保证 bus 存在）
  onEventBus("generation_ended", () => {
    refreshTokenProgressImmediate();
  });

  // 监听 API源/模型 切换 → 刷新进度条（上下文窗口值不由本模块写——入口在子模式/AIRP 面板）
  window.addEventListener("resource:api-changed", () => {
    refreshTokenProgressImmediate();
  });
  // 模型输入框变更也触发
  const _apiModelEl = document.getElementById("api-model");
  if (_apiModelEl) {
    _apiModelEl.addEventListener("change", () => {
      refreshTokenProgressImmediate();
    });
  }

  // ★ 监听cache token统计事件（从API响应获取）
  window.addEventListener("beilu:tokenUsage", (e) => {
    _lastCacheUsage = e.detail;
    // 收到新的usage后立即刷新显示
    updateProgressBarUI(_currentTokens, _maxContext, _currentChars);
    const _cr = e.detail?.cache_read_input_tokens || 0;
    const _cw = e.detail?.cache_creation_input_tokens || 0;
    if (_cr > 0 || _cw > 0) {
      console.log(`[tokenProgressBar] 缓存统计: 命中=${formatTokenCount(_cr)}, 创建=${formatTokenCount(_cw)}`);
    }
  });

  console.log(
    "[tokenProgressBar] 已初始化（fake-send 精确计数 + cache统计，所有模式显示，事件驱动刷新）",
  );
}

/**
 * 手动刷新进度条（供外部调用，带防抖）
 */
export { refreshTokenProgress };
window.refreshTokenProgress = refreshTokenProgress;

/**
 * 获取当前 token 信息（供外部模块读取）
 * @returns {{ chars: number, tokens: number, maxContext: number, ratio: number }}
 */
export function getTokenInfo() {
  return {
    chars: _currentChars,
    tokens: _currentTokens,
    maxContext: _maxContext,
    ratio: _maxContext > 0 ? _currentTokens / _maxContext : 0,
  };
}

// ============================================================
// Token设置悬浮窗
// ============================================================

async function _showTokenSettingsPopup() {
  // 如果已打开则关闭
  const existing = document.getElementById("token-settings-popup");
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement("div");
  overlay.id = "token-settings-popup";
  overlay.style.cssText = "position:fixed;inset:0;z-index:var(--z-overlay);display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const panel = document.createElement("div");
  panel.style.cssText = "background:oklch(var(--b1));border:1px solid oklch(var(--b3));border-radius:12px;padding:20px;max-width:420px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3)";
  panel.innerHTML = '<div class="flex items-center justify-between mb-3"><h3 class="text-sm font-bold"><i data-ic="settings" aria-hidden="true"></i> Token设置</h3><button id="token-popup-close" class="btn btn-xs btn-ghost">✕</button></div><div id="token-popup-body">加载中...</div>';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // ESC 接中央仲裁注册表（N26：动态节点不在内置兜底清单里，此前 Esc 关不掉——测试轮 #7）。
  // priority 41 > token-expand(40)：设置弹窗叠在展开面板上层，ESC 先关上层再关面板。
  {
    const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
    if (!reg.some((r) => r._id === "token-settings-popup")) {
      reg.push({
        _id: "token-settings-popup",
        priority: 41,
        isOpen: () => !!document.getElementById("token-settings-popup"),
        close: () => document.getElementById("token-settings-popup")?.remove(),
      });
    }
  }

  panel.querySelector("#token-popup-close").addEventListener("click", () => overlay.remove());

  // 加载配置
  try {
    // T6b：走 beilu-memory#getData（HTTP !ok → 抛错走 catch）
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web" });
    const config = data?.config || {};
    const tr = config.token_reminder || {};
    const enabled = tr.enabled !== false;
    const customText = tr.custom_text || "";
    // AI清理最低占用（%）：配置缺键时镜像后端 DEFAULT_TOKEN_REMINDER.ai_clean_min_percent=5
    // （与下方 thresholds 默认数组同为"UI 镜像后端默认"既有模式）；0=不限制
    const aiCleanMinPct = Number.isFinite(Number(tr.ai_clean_min_percent)) ? Number(tr.ai_clean_min_percent) : 5;
    const thresholds = tr.thresholds || [
      { percent: 50, level: "info" },
      { percent: 70, level: "warning" },
      { percent: 85, level: "urgent" },
    ];

    const body = panel.querySelector("#token-popup-body");
    body.innerHTML = `
      <div class="flex flex-col gap-3">
        <label class="flex items-center gap-2">
          <input type="checkbox" class="toggle toggle-sm" id="tp-enabled" ${enabled ? "checked" : ""} />
          <span class="text-xs">启用Token提醒</span>
        </label>
        <div>
          <span class="text-[11px] font-bold">阈值设置</span>
          <div class="flex flex-col gap-1 mt-1" id="tp-thresholds">
            ${thresholds.map((t, i) => `
              <div class="flex items-center gap-2">
                <input type="number" class="input input-xs input-bordered w-14" value="${t.percent}" min="10" max="99" data-idx="${i}" data-f="p" />
                <span class="text-[10px]">%</span>
                <select class="select select-xs select-bordered flex-1" data-idx="${i}" data-f="l">
                  <option value="info" ${t.level === "info" ? "selected" : ""}>信息</option>
                  <option value="warning" ${t.level === "warning" ? "selected" : ""}>警告</option>
                  <option value="urgent" ${t.level === "urgent" ? "selected" : ""}>紧急</option>
                </select>
              </div>`).join("")}
          </div>
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-bold">自定义提醒内容</span>
          <input type="text" class="input input-xs input-bordered w-full" id="tp-custom" value="${customText.replace(/"/g, '&quot;')}" placeholder="留空使用默认提醒" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-bold">AI清理最低占用（%）</span>
          <div class="flex items-center gap-2">
            <input type="number" class="input input-xs input-bordered w-20" id="tp-clean-min" value="${aiCleanMinPct}" min="0" max="99" step="1" />
            <span class="text-[10px] opacity-60">占用低于此比例时拒绝AI的contextClean清理；0 = 不限制</span>
          </div>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-bold">刷新间隔（秒）</span>
          <div class="flex items-center gap-2">
            <input type="number" class="input input-xs input-bordered w-20" id="tp-poll" value="${_pollSec()}"
                   min="${DEFAULTS.token.pollMin}" max="${DEFAULTS.token.pollMax}" step="1"
                   title="默认 ${DEFAULTS.token.pollSec}（${DEFAULTS.token.pollMin}–${DEFAULTS.token.pollMax}）" />
            <span class="text-[10px] opacity-60">0 = 只在上下文变动时刷新（不定时轮询）</span>
          </div>
          <span class="text-[10px] opacity-50">机器好可以调到 ${DEFAULTS.token.pollMin} 秒；每次刷新后端要跑一遍完整提示词组装，弱机建议保持默认 ${DEFAULTS.token.pollSec} 秒。</span>
        </label>
        <button class="btn btn-xs btn-primary w-fit" id="tp-save"><i data-ic="save"></i> 保存</button>
      </div>`;

    // （P2 并口：思维链标签编辑器块已删——唯一编辑家=设置→AI服务源「思维链显示」（0714 收口，settingsSlots 装配）；
    //   同一后端配置双处编辑是散写病根，本弹窗只留 Token 提醒本职）
    body.querySelector("#tp-save").addEventListener("click", async () => {
      const btn = body.querySelector("#tp-save");
      // 上下文窗口不在此配置（token_reminder.max_tokens 后端零消费——分母单源=resolveEffectiveMaxContext，
      // 上下文入口在子模式面板与 AIRP 模型参数面板）
      const newCfg = {
        enabled: body.querySelector("#tp-enabled")?.checked ?? true,
        custom_text: body.querySelector("#tp-custom")?.value?.trim() || "",
        thresholds: [],
      };
      body.querySelectorAll('#tp-thresholds [data-f="p"]').forEach(inp => {
        const idx = inp.dataset.idx;
        const lSel = body.querySelector('#tp-thresholds [data-idx="' + idx + '"][data-f="l"]');
        // [0811] 保留条目 text（原保存只存 percent/level=把配置里的提醒文案丢掉，后端渲染 undefined 病根）
        const _tSrc = thresholds[Number(idx)] || {};
        newCfg.thresholds.push({ percent: parseInt(inp.value), level: lSel?.value || "warning", ...(_tSrc.text ? { text: _tSrc.text } : {}) });
      });
      // AI清理最低占用（%）：0=不限制；非法输入回退默认 5（镜像后端 DEFAULT_TOKEN_REMINDER.ai_clean_min_percent）
      {
        const _cmv = Number(body.querySelector("#tp-clean-min")?.value);
        newCfg.ai_clean_min_percent = Number.isFinite(_cmv) ? Math.min(Math.max(Math.round(_cmv), 0), 99) : 5;
      }
      // [0727 刷新间隔] 纯前端本地偏好（每台机器性能不同，不进后端 per-user 配置）：
      //   存 localStorage 单键，派事件让运行中的定时器立刻按新值重启，不必刷新页面。
      const _pollInput = body.querySelector("#tp-poll");
      if (_pollInput) {
        const _v = Number(_pollInput.value);
        storage.set(KEYS.BEILU_TOKEN_POLL_SEC, String(Number.isFinite(_v) && _v > 0
          ? Math.min(Math.max(_v, DEFAULTS.token.pollMin), DEFAULTS.token.pollMax)
          : 0));
        window.dispatchEvent(new CustomEvent("beilu:token-poll-changed"));
      }
      try {
        btn.innerHTML = '<i data-ic="hourglass"></i>';
        // T6b：走 beilu-memory 通配 setdata（verb=updateConfig）
        await sendAction({ verb: "updateConfig", target: "plugins:beilu-memory", source: "web", payload: { token_reminder: newCfg } });
        btn.innerHTML = '<i data-ic="check"></i> 已保存';
        refreshTokenProgressImmediate();
        setTimeout(() => overlay.remove(), 800);
      } catch (e) { btn.innerHTML = '<i data-ic="cross"></i> 失败'; }
    });
  } catch (e) {
    panel.querySelector("#token-popup-body").textContent = "\u52A0\u8F7D\u5931\u8D25: " + e.message;
  }
}
