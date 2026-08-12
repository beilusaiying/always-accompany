/**
 * [chat-modes] — 模式面板 UI 总控。不管消息渲染/连接状态/输入发送（那是 chat-messages / chat-connection / chat.js 的事）。
 *
 * 链路：Extension(YonBanProvider) → postMessage → chat.js 消息路由 → 本模块各 onXxx handler → DOM 渲染
 *       用户点击 → vscode.postMessage → Extension → beilu 后端
 * 影响：写 localStorage(yb-token-settings)、操作 DOM、启停 setInterval 定时器(token/memory/group 轮询)
 * 相交：← chat.js(消息路由分发)  → YB 命名空间(chat-core.js 提供 dom/state/vscode/showToast 等基础设施)
 *        → Extension 的 76+ case handleMessage（所有 vscode.postMessage 最终到达 YonBanProvider.ts）
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — Token 进度条（轮询 getTokenSnapshot / onTokenSnapshot / onTokenUsage）
 *   — 压缩结果 onCompactResult
 *   — 压缩面板 showCompressPanel（6 种压缩操作 UI）
 *   — read_file 缓存面板 showReadCachePanel
 *   — 预设配置 onPresetConfig / 子模式面板 renderSubModePanel+Bar
 *   — 并行分身选择器 _showParallelPicker
 *   — switchSubMode（切子模式 → 写回后端 + 同步 API 源/模型标签）
 *   — onSubModesConfig（后端推送子模式配置 → state 同步）
 *   — showSubModeForm（子模式编辑表单 overlay）
 *   — 记忆预设面板（轮询 getMemoryConfig / 预设列表 / 注入提示词开关）
 *   — 底部选择器标签更新 updateSelectorLabels
 *   — API 源列表 + 模型列表（fetchApiSourceList / onApiSourceList / onModelList）
 *   — Token 设置面板（阈值持久化）
 *   — IDE 审批面板（onIdeApprovals / onIdeApprovalResult）
 *   — onTokenUsage（生成中实时 token 更新，与 30s 轮询互补）
 *   — Skill 组流水线 + 检查点回档面板
 *   — 权限档位徽章 onPermissionLevel
 *   — 审批跳过规则面板 showApprovalRulesPanel
 *   — F3/Y2 任务打勾卡 onTaskUpdate
 *   — 导出到 YB 命名空间
 *   — 分身 AI 管理（fetchClones / renderCloneList / showCloneForm）
 *   — 工具结果就绪 onToolResultsReady + shimmer 指示器
 *   — 审批待处理徽章 onPendingApprovals
 *   — 分身运行面板 _renderClonePanel / onCloneStatus
 *   — diff 渲染工具（_computeLineDiff / _renderDiffHtml）
 *   — 编辑历史面板 _renderEditHistoryList / showEditHistory / onEditRecord
 *   — 组管理器 showGroupManager + 组运行态条 _renderGroupRuntimeBar
 */
// =====================================================
// chat-modes.js — 模式层 (V2 两视图重构)
// Token进度条、子模式切换（底部弹出层+设置Tab）、记忆预设、记忆状态
// API源列表
// =====================================================

(function () {
  "use strict";
  try {
  var YB = window.YB;
  var dom = YB.dom;
  var state = YB.state;
  var vscode = YB.vscode;
  // T010 子模式单源：前端定义副本已删（原 YB.DEFAULT_SUB_MODES 9 个 vs 后端 11 个=副本漂移活体）。
  // 统一取数：后端下发的 state.subModes → 上次成功缓存 → []（失败态，renderSubModeBar 显式提示）
  function subModesOrCache() { return YB.getSubModes() || []; }

  // ── 枚举选项集单源（链路2扩展 2026-07-09，凛倾「子模式/参数要同步+映射非硬编码」）──
  // 权威=后端 paramSchema.mjs ENUM_SCHEMA（getSubModes 随包下发 enum_schema → state.enumSchema）。
  // 下方 _FALLBACK 表仅离线退化：与后端表等值镜像（含 0708 正名定稿——旧 "off/prefill/claude"
  // 三项集与 "Claude模式" 自造词已废，"claude" 值经消费端 applyTailPrefill 归 to_user 自愈）。
  // 改选项集改后端 paramSchema.mjs，禁在此新增值。
  var PP_OPTIONS_FALLBACK = [
    { value: "none",   label: "关闭" },
    { value: "merge",  label: "合并 (Merge)" },
    { value: "semi",   label: "半严格 (Semi)" },
    { value: "strict", label: "严格 (Strict)" },
  ];
  var PREFILL_OPTIONS_FALLBACK = [
    { value: "prefill",        label: "尾部 assistant（渠道支持预填充）",
      title: "尾部 assistant 原样发送=真预填充。需渠道支持 prefill；Claude 官方新模型已移除该能力，不支持的渠道会返回错误" },
    { value: "to_user",        label: "尾部直接改 user",
      title: "尾部 assistant 直接改为 user 发送，内容不变。适用于强制 user 结尾的渠道（Claude 系新模型）" },
    { value: "user_assistant", label: "user 后加 assistant:（加强有效性）",
      title: "尾部改为 user 且内容末尾追加 assistant: 引导，在强制 user 结尾的渠道上加强预填充有效性" },
  ];
  function enumOptions(key, fallback) {
    var d = state.enumSchema && state.enumSchema[key];
    return (d && Array.isArray(d.options) && d.options.length > 0) ? d.options : fallback;
  }
  // 把选项集填进 select：emptyLabel 非 undefined 时前置空项（空=不覆盖/继承，语义归表单）
  function fillEnumSelect(sel, key, fallback, emptyLabel, currentVal) {
    while (sel.options.length > 0) sel.remove(0);
    if (emptyLabel !== undefined) {
      var eOpt = document.createElement("option");
      eOpt.value = ""; eOpt.textContent = emptyLabel;
      sel.appendChild(eOpt);
    }
    enumOptions(key, fallback).forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.label || o.value;
      if (o.title) opt.title = o.title;
      sel.appendChild(opt);
    });
    if (currentVal) sel.value = currentVal; // 旧存量值不在集内=落回首项（消费端归一自愈，与本体同策略）
  }
  var DEFAULT_MODE = YB.DEFAULT_MODE; // T003：默认模式单源（chat-core.js 单点，与 src/constants.ts 对齐）
  var closePopup = YB.closePopup;
var showToast = YB.showToast;
  // 分身运行时状态（非配置，运行期间维护）
  // _runningClones 已移除（旧版分身面板），使用 _cloneMap（功能B）
  // ═══════════════════════════════════════════════════════
  // Token 进度条
  // ═══════════════════════════════════════════════════════

  // warning/urgent 阈值真源=beilu-memory token_reminder.thresholds。
  // localStorage 只留 YonBan 本地显示便利值 maxTokens，不复制本体策略。

  function startTokenPoll() {
    stopTokenPoll();
    fetchTokenSnapshot();
    state.tokenPollTimer = setInterval(fetchTokenSnapshot, YB.POLL.token); // 单源=constants.ts TOKEN_POLL_MS（data-poll-cfg 注入）
  }

  function stopTokenPoll() {
    if (state.tokenPollTimer !== null) {
      clearInterval(state.tokenPollTimer);
      state.tokenPollTimer = null;
    }
  }

  function fetchTokenSnapshot() {
    vscode.postMessage({ type: "getTokenSnapshot" });
  }

  function onTokenSnapshot(payload) {
    if (!state._trFetched) { state._trFetched = true; vscode.postMessage({ type: "getTokenReminder" }); }
    if (!payload || !payload.available || !payload.snapshot) {
      // 常驻：无快照时不再隐藏整条，显示占位读数(对齐本体 token 条常驻)，避免「时有时无」。
      if (dom.tokenBar) dom.tokenBar.classList.remove("hidden");
      if (dom.tokenBarLabel) dom.tokenBarLabel.textContent = "— / —";
      if (dom.tokenBarFill) dom.tokenBarFill.style.width = "0%";
      state.tokenUsed = null;
      state.tokenTotal = null;
      return;
    }

    var snap = payload.snapshot;
    var used = snap.estimated_tokens || 0;
    var total =
      (snap.model_params && snap.model_params.max_context) ||
      (snap.model_params && snap.model_params.max_tokens) ||
      // 分母兜底=后端 extractModelParams 实际生效默认（param_schema.max_context.default），
      // 旧写死 8192 与后端 200000 打架=进度条百分比谎报
      (state.paramSchema && state.paramSchema.max_context && state.paramSchema.max_context.default) ||
      200000;

    state.tokenUsed = used;
    state.tokenTotal = total;

    var pct = Math.min((used / total) * 100, 100);
    var warnPct = Number(state._warnPct);
    var dangerPct = Number(state._dangerPct);
    if (dom.tokenBarFill) {
      dom.tokenBarFill.style.width = pct + "%";
      dom.tokenBarFill.classList.remove("warn", "danger");
      if (Number.isFinite(dangerPct) && pct >= dangerPct) {
        dom.tokenBarFill.classList.add("danger");
      } else if (Number.isFinite(warnPct) && pct >= warnPct) {
        dom.tokenBarFill.classList.add("warn");
      }
    }

    var usedK = used >= 1000 ? (used / 1000).toFixed(1) + "K" : String(used);
    var totalK =
      total >= 1000 ? (total / 1000).toFixed(0) + "K" : String(total);
    if (dom.tokenBarLabel) {
      dom.tokenBarLabel.textContent = usedK + " / " + totalK;
    }
    if (dom.tokenBar) dom.tokenBar.classList.remove("hidden");
  }

  function onCompactResult(payload) {
    if (payload && payload.error) {
      console.warn("[chat-modes] 压缩失败:", payload.error);
      showToast("✗ 清理失败: " + payload.error, 3000);
      return;
    } else if (payload && payload.action === "fullCompact") {
      fetchTokenSnapshot();
      var info = payload.summaryChars ? ("摘要 " + payload.summaryChars + " 字") : "完成";
      showToast("✓ 全量清理完成 — " + info, 3000);
    } else if (payload && payload.action === "smartCleanChat") {
      fetchTokenSnapshot();
      showToast("✓ 已屏蔽 " + (payload.hidden || 0) + " 条，保留 " + (payload.kept || 0) + " 条", 3000);
    } else if (payload && payload.action === "clearInjections") {
      fetchTokenSnapshot();
      showToast("✓ 系统注入清理完成", 2000);
    } else if (payload && payload.action === "hideContextNoise") {
      fetchTokenSnapshot();
      var b = payload.breakdown || {};
      showToast("✓ 已隐藏 " + (payload.hidden || 0) + " 条噪声（读取" + (b.read || 0) + "·操作" + (b.op || 0) + "·分身" + (b.clone || 0) + "，可撤销）", 3000);
    } else if (payload && payload.action === "hideCloneMessages") {
      fetchTokenSnapshot();
      showToast("✓ 已屏蔽 " + (payload.hidden || 0) + " 条分身记录", 2000);
    } else if (payload && payload.action === "cleanXmlTags") {
      fetchTokenSnapshot();
      showToast("✓ XML标签清理完成", 2000);
    } else {
      fetchTokenSnapshot();
      showToast("✓ 操作完成", 2000);
    }
    // 压缩/清理后重新加载消息列表（灰显 _hidden 消息）
    if (state.currentChatId) {
      vscode.postMessage({ type: "switchChat", payload: { chatId: state.currentChatId, announceActive: false } });
    }
  }

  // ═══════════════════════════════════════════════════════
  // 压缩面板（两步式：全量清理 / 自由清理）
  // 所有清理操作使用 _hidden 屏蔽，不物理删除消息
  // ═══════════════════════════════════════════════════════

  function showCompressPanel() {
    if (document.getElementById("yb-compress-overlay")) return;

    // ⚠ FIX: 用 logOffset + messages.length 算出真实总数，不做 DOM 计数
    var totalMessages = (state.logOffset || 0) + (state.messages ? state.messages.length : 0);
    if (totalMessages <= 0) totalMessages = 50;

    var overlay = document.createElement("div");
    overlay.id = "yb-compress-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;";

    var panel = document.createElement("div");
    panel.id = "yb-cmp-panel";
    panel.style.cssText = "background:var(--vscode-editor-background,#1e1e2e);border-radius:12px;padding:20px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);color:var(--vscode-foreground,#ccc);max-height:80vh;overflow-y:auto;";
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // ── 样式模板 ──
    var btnS = "width:100%;padding:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.15);border-radius:8px;background:none;color:inherit;cursor:pointer;text-align:left;";
    var execS = "flex:1;padding:8px;border:none;border-radius:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-weight:600;font-size:13px;";
    var backS = "padding:8px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:12px;";
    var cancelS = "width:100%;padding:8px;border:none;background:none;color:inherit;cursor:pointer;opacity:0.5;font-size:12px;";

    // ── 滑块HTML ──
    function sliderHtml(id, max, val) {
      if (val > max) val = max;
      return '<div style="margin-bottom:10px;">' +
        '<label style="font-size:12px;opacity:0.7;">保留最后几条消息：</label>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
          '<input type="range" id="' + id + '" min="1" max="' + max + '" value="' + val + '" style="flex:1;" />' +
          '<span id="' + id + '-lbl" style="font-size:13px;font-weight:600;min-width:40px;text-align:center;">' + val + '</span>' +
        '</div>' +
        '<div style="font-size:11px;opacity:0.5;margin-top:2px;">将屏蔽前 <span id="' + id + '-hide">' + Math.max(0, max - val) + '</span> 条，保留后 <span id="' + id + '-keep">' + val + '</span> 条</div>' +
      '</div>';
    }
    function bindSlider(id, max) {
      var s = document.getElementById(id);
      if (!s) return;
      s.addEventListener("input", function() {
        var v = parseInt(s.value);
        var lbl = document.getElementById(id + "-lbl");
        var hide = document.getElementById(id + "-hide");
        var keep = document.getElementById(id + "-keep");
        if (lbl) lbl.textContent = v;
        if (hide) hide.textContent = Math.max(0, max - v);
        if (keep) keep.textContent = v;
      });
    }

    // ── 主菜单 ──
    function renderMain() {
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:15px;">🗜️ 上下文管理</h3>' +
        '<p style="margin:0 0 16px;font-size:12px;opacity:0.5;">当前对话共 ' + totalMessages + ' 条消息（清理 = 上下文屏蔽，历史可回溯）</p>' +
        '<button id="yb-full" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">📦 全量清理</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">AI总结旧对话 → 屏蔽原文 → 摘要注入上下文。保留完整历史。</div>' +
        '</button>' +
        '<button id="yb-free" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">🎯 自由清理</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">手动选择要清理的内容类型：对话/文件读取/系统注入/隐藏噪声。</div>' +
        '</button>' +
        '<button id="yb-skill" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">🗂️ skill 组流水线</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">启动多子模式工作流（大型项目=8角色流水线 / 小型项目）。</div>' +
        '</button>' +
        '<button id="yb-ckpt" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">📍 检查点回档</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">查看 AI 改动检查点的逐行 diff，单点回档（仅文件层）。</div>' +
        '</button>' +
        '<button id="yb-cancel" style="' + cancelS + '">取消</button>';

      document.getElementById("yb-full").addEventListener("click", renderFullClean);
      document.getElementById("yb-free").addEventListener("click", renderFreeMenu);
      document.getElementById("yb-skill").addEventListener("click", function() { overlay.remove(); showSkillGroupPanel(); });
      document.getElementById("yb-ckpt").addEventListener("click", function() { overlay.remove(); showCheckpointPanel(); });
      document.getElementById("yb-cancel").addEventListener("click", function() { overlay.remove(); });
    }

    // ── 全量清理 ──
    function renderFullClean() {
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:15px;">📦 全量清理</h3>' +
        '<p style="margin:0 0 12px;font-size:12px;opacity:0.6;">AI分析旧对话生成摘要，旧消息被屏蔽，摘要注入上下文。</p>' +
        sliderHtml("yb-full-slider", totalMessages, Math.min(10, totalMessages)) +
        '<div style="display:flex;gap:8px;margin-top:12px;">' +
          '<button id="yb-full-exec" style="' + execS + '">执行全量清理</button>' +
          '<button id="yb-full-back" style="' + backS + '">返回</button>' +
        '</div>';

      bindSlider("yb-full-slider", totalMessages);
      document.getElementById("yb-full-back").addEventListener("click", renderMain);
      document.getElementById("yb-full-exec").addEventListener("click", function() {
        var keepN = parseInt(document.getElementById("yb-full-slider").value, 10) || 10;
        // ⚠ FIX: 从 state.messages 读取真实数据，不做 DOM 抓取（DOM textContent 会丢失 markdown/代码内容）
        // ★ 只取要压缩的旧对话(前 hideCount 条可见对话)：排除已隐藏(_hidden)+系统/工具结果(role=system)，
        //   避免把已压缩消息/工具输出喂给摘要 AI；[消息#i] 用可见对话序，对齐 compactRange + keep_indices。
        var hideCount = Math.max(0, totalMessages - keepN);
        var parts = [];
        var msgs = state.messages || [];
        var taken = 0;
        for (var i = 0; i < msgs.length && taken < hideCount; i++) {
          var m = msgs[i];
          if (m.extension && m.extension._hidden) continue;
          if (m.role === "system") continue;
          var name = m.role === "user" ? "用户" : (m.name || "助手");
          var content = m.content || m.content_for_show || m.content_for_edit || "";
          content = content.replace(/<ideToolCall[\s\S]*?<\/ideToolCall>/g, "[工具调用]")
                           .replace(/<tableEdit[\s\S]*?<\/tableEdit>/g, "[表格操作]")
                           .replace(/<think>[\s\S]*?<\/think>/g, "")
                           .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
                           .trim();
          if (content) { parts.push("[消息#" + taken + "] " + name + ": " + content); taken++; }
        }
        overlay.remove();
        showToast("AI正在生成摘要...", 5000);
        vscode.postMessage({
          type: "compactContext",
          payload: { action: "fullCompact", chatHistory: parts.join("\n\n"), messageCount: totalMessages, keepLastN: keepN, chatId: state.currentChatId }
        });
      });
    }

    // ── 自由清理菜单 ──
    function renderFreeMenu() {
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:15px;">🎯 自由清理</h3>' +
        '<p style="margin:0 0 12px;font-size:12px;opacity:0.6;">选择要清理的内容类型：</p>' +
        '<button id="yb-free-chat" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">💬 对话消息</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">屏蔽旧的对话轮次，保留最近N条消息。</div>' +
        '</button>' +
        '<button id="yb-free-files" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">📂 文件读取</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">查看AI读取的文件，选择性屏蔽不再需要的。</div>' +
        '</button>' +
        '<button id="yb-free-inject" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">🔧 系统注入</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">清理P1记忆搜索、联网搜索、工具调用结果、XML操作标签等。</div>' +
        '</button>' +
        '<button id="yb-free-noise" style="' + btnS + '">' +
          '<div style="font-weight:600;font-size:13px;">🧹 隐藏噪声</div>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">可逆隐藏 AI读取/AI操作(YonBan命令)/分身 三类噪声，各保留最近N条。不调AI、即时省token。</div>' +
        '</button>' +
        '<button id="yb-free-back" style="' + cancelS + '">返回主菜单</button>';

      document.getElementById("yb-free-chat").addEventListener("click", renderFreeChat);
      document.getElementById("yb-free-files").addEventListener("click", function() { showReadCachePanel(overlay); });
      document.getElementById("yb-free-inject").addEventListener("click", renderFreeInject);
      document.getElementById("yb-free-noise").addEventListener("click", renderHideNoise);
      document.getElementById("yb-free-back").addEventListener("click", renderMain);
    }

    // ── 自由清理 - 隐藏噪声（AI读取/AI操作/分身，对齐本体 hideContextNoise）──
    function renderHideNoise() {
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:15px;">🧹 隐藏噪声</h3>' +
        '<p style="margin:0 0 12px;font-size:12px;opacity:0.6;">可逆隐藏三类占token的噪声：AI读取/工具结果、AI操作(YonBan命令)、分身输入。各类保留最近N条，不调AI、即时生效、可在消息上撤销。</p>' +
        '<div style="margin-bottom:10px;">' +
          '<label style="font-size:12px;opacity:0.7;">每类保留最近几条：</label>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
            '<input type="range" id="yb-noise-keep" min="0" max="5" value="2" style="flex:1;" />' +
            '<span id="yb-noise-keep-lbl" style="font-size:13px;font-weight:600;min-width:40px;text-align:center;">2</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;">' +
          '<button id="yb-noise-exec" style="' + execS + '">执行隐藏</button>' +
          '<button id="yb-noise-back" style="' + backS + '">返回</button>' +
        '</div>';

      var ks = document.getElementById("yb-noise-keep");
      ks.addEventListener("input", function() {
        document.getElementById("yb-noise-keep-lbl").textContent = ks.value;
      });
      document.getElementById("yb-noise-back").addEventListener("click", renderFreeMenu);
      document.getElementById("yb-noise-exec").addEventListener("click", function() {
        var keepLast = parseInt(ks.value, 10);
        if (isNaN(keepLast)) keepLast = 2;
        overlay.remove();
        showToast("正在隐藏噪声...", 2000);
        vscode.postMessage({
          type: "hideContextNoise",
          payload: { chatId: state.currentChatId, keepLast: keepLast }
        });
      });
    }

    // ── 自由清理 - 对话消息 ──
    function renderFreeChat() {
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:15px;">💬 对话消息清理</h3>' +
        '<p style="margin:0 0 12px;font-size:12px;opacity:0.6;">屏蔽旧的对话轮次，AI将不再看到被屏蔽的消息。</p>' +
        sliderHtml("yb-chat-slider", totalMessages, Math.min(10, totalMessages)) +
        '<div style="display:flex;gap:8px;margin-top:12px;">' +
          '<button id="yb-chat-exec" style="' + execS + '">执行</button>' +
          '<button id="yb-chat-back" style="' + backS + '">返回</button>' +
        '</div>';

      bindSlider("yb-chat-slider", totalMessages);
      document.getElementById("yb-chat-back").addEventListener("click", renderFreeMenu);
      document.getElementById("yb-chat-exec").addEventListener("click", function() {
        var keepN = parseInt(document.getElementById("yb-chat-slider").value, 10) || 10;
        overlay.remove();
        showToast("正在屏蔽旧对话...", 3000);
        vscode.postMessage({
          type: "compactContext",
          payload: { action: "smartCleanChat", chatId: state.currentChatId, keepRecent: keepN }
        });
      });
    }

    // ── 自由清理 - 系统注入 ──
    function renderFreeInject() {
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:15px;">🔧 系统注入清理</h3>' +
        '<p style="margin:0 0 12px;font-size:12px;opacity:0.6;">选择要清理的注入内容（清除后端缓存 + 屏蔽上下文）：</p>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' +
          '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">' +
            '<input type="checkbox" id="yb-inj-p1" checked style="margin-top:2px;" />' +
            '<div><div style="font-weight:500;">P1 记忆搜索结果</div><div style="font-size:11px;opacity:0.5;">P1检索AI的搜索结果缓存</div></div>' +
          '</label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">' +
            '<input type="checkbox" id="yb-inj-web" checked style="margin-top:2px;" />' +
            '<div><div style="font-weight:500;">联网搜索结果</div><div style="font-size:11px;opacity:0.5;">P8 Web搜索注入的内容</div></div>' +
          '</label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">' +
            '<input type="checkbox" id="yb-inj-tool" checked style="margin-top:2px;" />' +
            '<div><div style="font-weight:500;">工具调用结果</div><div style="font-size:11px;opacity:0.5;">IDE工具(read_file/search_files等)的返回结果</div></div>' +
          '</label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">' +
            '<input type="checkbox" id="yb-inj-xml" checked style="margin-top:2px;" />' +
            '<div><div style="font-weight:500;">XML 操作标签</div><div style="font-size:11px;opacity:0.5;">消息中的 &lt;tableEdit&gt; &lt;memoryArchive&gt; &lt;ideToolCall&gt; 等标签</div></div>' +
          '</label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer;">' +
            '<input type="checkbox" id="yb-inj-clone" style="margin-top:2px;" />' +
            '<div><div style="font-weight:500;">分身委派记录</div><div style="font-size:11px;opacity:0.5;">分身任务的委派和返回结果</div></div>' +
          '</label>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button id="yb-inj-exec" style="' + execS + '">执行清理</button>' +
          '<button id="yb-inj-back" style="' + backS + '">返回</button>' +
        '</div>';

      document.getElementById("yb-inj-back").addEventListener("click", renderFreeMenu);
      document.getElementById("yb-inj-exec").addEventListener("click", function() {
        var p1 = document.getElementById("yb-inj-p1").checked;
        var web = document.getElementById("yb-inj-web").checked;
        var tool = document.getElementById("yb-inj-tool").checked;
        var xml = document.getElementById("yb-inj-xml").checked;
        var clone = document.getElementById("yb-inj-clone").checked;
        overlay.remove();
        showToast("正在清理系统注入...", 3000);

        // 分步发送清理请求
        if (p1 || web || tool) {
          vscode.postMessage({
            type: "compactContext",
            payload: { action: "clearInjections", clearP1: p1, clearWeb: web, clearTool: tool, chatId: state.currentChatId }
          });
        }
        if (xml) {
          vscode.postMessage({
            type: "compactContext",
            payload: { action: "cleanXmlTags", chatId: state.currentChatId }
          });
        }
        if (clone) {
          vscode.postMessage({
            type: "compactContext",
            payload: { action: "hideCloneMessages", chatId: state.currentChatId }
          });
        }
      });
    }

    // ── 初始渲染 ──
    renderMain();

    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
  }

  // ═══════════════════════════════════════════════════════
  // 文件缓存管理面板
  // ═══════════════════════════════════════════════════════

  function showReadCachePanel(overlay) {
    // 通过 vscode 消息获取缓存数据（从chatLog扫描）
    vscode.postMessage({ type: "getReadCache" });

    // 监听返回
    function onMessage(event) {
      // 面板已关闭则自行解绑，避免监听器+陈旧DOM闭包泄漏
      if (!overlay.isConnected) { window.removeEventListener("message", onMessage); return; }
      var msg = event.data;
      if (msg.type !== "readCacheData") return;
      window.removeEventListener("message", onMessage);

      var cacheEntries = msg.payload || [];
      var panelEl = overlay.querySelector("div");
      if (!panelEl) return;

      if (cacheEntries.length === 0) {
        panelEl.innerHTML =
          '<h3 style="margin:0 0 12px;font-size:15px;">📂 文件缓存</h3>' +
          '<p style="font-size:13px;opacity:0.7;margin-bottom:16px;">当前没有文件读取缓存。</p>' +
          '<button id="yb-rc-back" style="width:100%;padding:8px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:12px;">返回</button>';
        document.getElementById("yb-rc-back").addEventListener("click", function () { overlay.remove(); });
        return;
      }

      var totalTokens = 0;
      var listHtml = "";
      for (var i = 0; i < cacheEntries.length; i++) {
        var entry = cacheEntries[i];
        totalTokens += entry.tokens || 0;
        var ageMin = Math.round((entry.age || 0) / 60000);
        var ageStr = ageMin < 1 ? "<1分钟前" : ageMin < 60 ? ageMin + "分钟前" : Math.round(ageMin / 60) + "小时前";
        var shortPath = entry.path.length > 45 ? "..." + entry.path.slice(-42) : entry.path;
        listHtml +=
          '<label style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;font-size:12px;" title="' + entry.path + '">' +
            '<input type="checkbox" data-idx="' + i + '" style="margin-top:2px;" />' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-weight:500;word-break:break-all;">' + shortPath + '</div>' +
              '<div style="opacity:0.5;font-size:11px;">' + entry.tool + ' · ' + entry.lines + '行 · ~' + entry.tokens + ' token · ' + ageStr + '</div>' +
            '</div>' +
          '</label>';
      }

      panelEl.innerHTML =
        '<h3 style="margin:0 0 4px;font-size:15px;">📂 文件缓存管理</h3>' +
        '<p style="margin:0 0 12px;font-size:12px;opacity:0.5;">共 ' + cacheEntries.length + ' 项, ~' + totalTokens + ' token — 勾选要清理的文件</p>' +
        '<div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">' + listHtml + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
          '<label style="font-size:11px;opacity:0.7;cursor:pointer;display:flex;align-items:center;gap:4px;">' +
            '<input type="checkbox" id="yb-rc-all" /> 全选' +
          '</label>' +
          '<span id="yb-rc-info" style="font-size:11px;opacity:0.5;margin-left:auto;">已选 0 项</span>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button id="yb-rc-exec" style="flex:1;padding:8px;border:none;border-radius:6px;background:var(--vscode-errorForeground);color:var(--vscode-button-foreground);cursor:pointer;font-weight:600;font-size:13px;" disabled>清理选中文件</button>' +
          '<button id="yb-rc-back" style="padding:8px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:12px;">返回</button>' +
        '</div>';

      var allCbs = panelEl.querySelectorAll("input[data-idx]");
      var selectAllCb = document.getElementById("yb-rc-all");
      var infoEl = document.getElementById("yb-rc-info");
      var execBtn = document.getElementById("yb-rc-exec");

      function updateInfo() {
        var checked = panelEl.querySelectorAll("input[data-idx]:checked");
        var count = checked.length;
        var tokens = 0;
        for (var j = 0; j < checked.length; j++) tokens += cacheEntries[parseInt(checked[j].dataset.idx)]?.tokens || 0;
        if (infoEl) infoEl.textContent = "已选 " + count + " 项 (~" + tokens + " token)";
        if (execBtn) execBtn.disabled = count === 0;
      }

      if (selectAllCb) selectAllCb.addEventListener("change", function () {
        allCbs.forEach(function (cb) { cb.checked = selectAllCb.checked; });
        updateInfo();
      });
      allCbs.forEach(function (cb) { cb.addEventListener("change", updateInfo); });

      if (execBtn) execBtn.addEventListener("click", function () {
        var checked = panelEl.querySelectorAll("input[data-idx]:checked");
        var paths = [];
        var chatLogIndices = [];
        for (var j = 0; j < checked.length; j++) {
          var entry = cacheEntries[parseInt(checked[j].dataset.idx)];
          if (!entry) continue;
          if (entry.path && !entry.path.startsWith("(")) paths.push(entry.path);
          if (typeof entry.chatLogIndex === "number" && entry.chatLogIndex >= 0) chatLogIndices.push(entry.chatLogIndex);
        }
        if (paths.length === 0 && chatLogIndices.length === 0) return;
        overlay.remove();
        vscode.postMessage({ type: "compactContext", payload: { action: "cleanReadCache", paths: paths, chatLogIndices: chatLogIndices } });
        showToast("✓ 已清理 " + checked.length + " 个文件缓存", 2000);
      });

      document.getElementById("yb-rc-back").addEventListener("click", function () { overlay.remove(); });
    }

    window.addEventListener("message", onMessage);
  }

  // ═══════════════════════════════════════════════════════
  // 子模式管理
  // ═══════════════════════════════════════════════════════

  function onPresetConfig(payload) {
    if (payload && payload.error) {
      console.warn("[chat-modes] 预设配置获取失败:", payload.error);
      showToast("⚠ 预设配置加载失败", 2000);
      return;
    }
    // ★ per-chatId 预设解析（对齐本体 resolveActivePresetFor:active_preset_map[cid]||active_preset）。
    //   原只取全局 active_preset → 多对话下显示/匹配的是别的对话的预设。无 map 时 fallback 全局=零回归。
    var _cidP = state.currentChatId || "";
    state.activePreset = (_cidP && payload.active_preset_map && payload.active_preset_map[_cidP]) || payload.active_preset || "";
    // 同步到 AI 控制面板
    var _presetLabel = document.getElementById("aiActivePreset");
    if (_presetLabel) _presetLabel.textContent = state.activePreset || "—";

    // ★ 存储预设名列表，供子模式表单下拉用
    var presetList = payload.preset_list || payload.presets || [];
    state.presetNames = presetList.map(function (p) {
      return typeof p === "string" ? p : (p.name || p.id || "");
    }).filter(function (n) { return !!n; });

    var allModes = subModesOrCache();
    var matched = allModes.find(function (m) {
      return state.activePreset.toLowerCase().includes(m.id);
    });
    if (matched) state.activeSubMode = matched.id;
    renderSubModePanel();
    renderSubModeBar();
  }

  var _selectedSkillGroup = null; // 当前选中的 skill 组 filename
  var _cachedGroups = []; // 缓存的 skill 组列表

  /** 渲染 skill 组栏 */
  function renderSkillGroupBar() {
    var bar = document.getElementById("skillGroupBar");
    if (!bar) return;
    if (_cachedGroups.length === 0) {
      vscode.postMessage({ type: "listFlowGroups" });
      bar.innerHTML = '<div style="font-size:11px;opacity:0.4;">加载 skill 组...</div>';
      return;
    }
    var html = '';
    _cachedGroups.sort(function(a,b) { if (a.builtin && !b.builtin) return -1; if (!a.builtin && b.builtin) return 1; return (a.name||"").localeCompare(b.name||""); });
    _cachedGroups.forEach(function(g) {
      var sel = g.filename === _selectedSkillGroup;
      html += '<button class="yb-sg-btn" data-fn="' + _esc(g.filename) + '" style="' +
        'display:inline-block;padding:4px 10px;margin:0 4px 4px 0;border-radius:6px;border:1px solid ' +
        (sel ? 'var(--vscode-focusBorder, #d4a017)' : 'rgba(255,255,255,0.15)') + ';background:' +
        (sel ? 'rgba(212,160,23,0.15)' : 'none') + ';color:inherit;cursor:pointer;font-size:11px;' +
        (sel ? 'font-weight:600;' : '') + '">' +
        '🗂️ ' + _esc(g.name) + ' <span style="opacity:0.4;">(' + (g.stepCount||0) + ')</span>' +
        (g.builtin ? ' 🔒' : '') +
        '</button>';
    });
    html += '<button id="yb-sg-all" style="display:inline-block;padding:4px 10px;margin:0 4px 4px 0;border-radius:6px;border:1px solid ' +
      (!_selectedSkillGroup ? 'var(--vscode-focusBorder, #d4a017)' : 'rgba(255,255,255,0.15)') + ';background:' +
      (!_selectedSkillGroup ? 'rgba(212,160,23,0.15)' : 'none') + ';color:inherit;cursor:pointer;font-size:11px;' +
      (!_selectedSkillGroup ? 'font-weight:600;' : '') + '">全部</button>';
    bar.innerHTML = html;
    bar.querySelectorAll(".yb-sg-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        _selectedSkillGroup = btn.getAttribute("data-fn");
        renderSkillGroupBar();
        renderSubModePanel();
      });
    });
    var allBtn = document.getElementById("yb-sg-all");
    if (allBtn) allBtn.addEventListener("click", function() {
      _selectedSkillGroup = null;
      renderSkillGroupBar();
      renderSubModePanel();
    });
  }

  /** 渲染设置Tab中的子模式列表 */
  function renderSubModePanel() {
    var list = dom.submodeList;
    if (!list) return;
    list.innerHTML = "";

    renderSkillGroupBar();

    var allModes = subModesOrCache();
    // 按选中的 skill 组过滤
    var modes;
    if (_selectedSkillGroup && _cachedGroups.length > 0) {
      var group = _cachedGroups.find(function(g) { return g.filename === _selectedSkillGroup; });
      if (group && group.steps) {
        var stepIds = {};
        group.steps.forEach(function(s) { if (s.mode) stepIds[s.mode] = true; });
        modes = allModes.filter(function(m) { return !!stepIds[m.id]; });
      } else {
        modes = allModes;
      }
    } else {
      modes = allModes;
    }

    for (var i = 0; i < modes.length; i++) {
      var sm = modes[i];
      var isActive = sm.id === state.activeSubMode;
      var item = document.createElement("div");
      item.className = "submode-panel-item" + (isActive ? " active" : "");
      item.dataset.submodeId = sm.id;

      var iconEl = document.createElement("span");
      iconEl.className = "submode-icon";
      iconEl.textContent = sm.icon || "⚡";
      item.appendChild(iconEl);

      var textEl = document.createElement("div");
      textEl.className = "submode-text";

      var labelRow = document.createElement("div");
      labelRow.className = "submode-label";

      var nameSpan = document.createElement("span");
      nameSpan.textContent = sm.label;
      labelRow.appendChild(nameSpan);

      if (isActive) {
        var badge = document.createElement("span");
        badge.className = "preset-active-badge";
        badge.textContent = "当前";
        labelRow.appendChild(badge);
      }

      // 绑定预设名
      if (sm.presetName) {
        var presetTag = document.createElement("span");
        presetTag.className = "submode-preset-tag";
        presetTag.textContent = sm.presetName;
        presetTag.title = "绑定预设: " + sm.presetName;
        labelRow.appendChild(presetTag);
      }

      // 绑定 API 源
      if (sm.apiSource) {
        var apiTag = document.createElement("span");
        apiTag.className = "submode-api-tag";
        apiTag.textContent = "API:" + sm.apiSource;
        apiTag.title = "绑定 API: " + sm.apiSource;
        labelRow.appendChild(apiTag);
      }

      // 绑定模型
      if (sm.modelName) {
        var modelTag = document.createElement("span");
        modelTag.className = "submode-api-tag";
        modelTag.textContent = "模型:" + sm.modelName;
        modelTag.title = "绑定模型: " + sm.modelName;
        labelRow.appendChild(modelTag);
      }

      textEl.appendChild(labelRow);

      if (sm.desc || sm.description) {
        var descEl = document.createElement("div");
        descEl.className = "submode-desc";
        descEl.textContent = sm.desc || sm.description;
        textEl.appendChild(descEl);
      }

      item.appendChild(textEl);

      // 编辑/删除按钮（始终可用）
      var actionsEl = document.createElement("div");
      actionsEl.className = "submode-item-actions";

      var editBtn = document.createElement("button");
      editBtn.className = "icon-btn submode-edit-btn";
      editBtn.textContent = "✏";
      editBtn.title = "编辑";
      (function (capturedSm) {
        editBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          try {
            showSubModeForm(capturedSm);
          } catch (err) {
            showToast("✗ 编辑表单错误: " + err.message, 5000);
            console.error("[chat-modes] showSubModeForm error:", err);
          }
        });
      })(sm);
      actionsEl.appendChild(editBtn);

      // 删除按钮（仅动态模式可删）
      if (state.subModes.length > 0) {
        var delBtn = document.createElement("button");
        delBtn.className = "icon-btn submode-del-btn";
        delBtn.textContent = "✕";
        delBtn.title = "删除";
        (function (capturedId) {
          delBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            deleteSubMode(capturedId);
          });
        })(sm.id);
        actionsEl.appendChild(delBtn);
      }

      item.appendChild(actionsEl);

      if (!isActive) {
        item.style.cursor = "pointer";
        (function (capturedId) {
          item.addEventListener("click", function () {
            switchSubMode(capturedId);
          });
        })(sm.id);
      }

      list.appendChild(item);
    }

    // 添加模式按钮
    var addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary submode-add-btn";
    addBtn.textContent = "+ 添加模式";
    addBtn.style.marginTop = "8px";
    addBtn.style.width = "100%";
    addBtn.addEventListener("click", function () {
      showSubModeForm(null);
    });
    list.appendChild(addBtn);
  }

  /** 渲染聊天视图底部弹出层中的模式选择栏 */
  function renderSubModeBar() {
    var bar = dom.submodeBar;
    if (!bar) return;
    bar.innerHTML = "";

    var barModes = subModesOrCache();
    // T010 失败态：后端未下发且无缓存——显式提示而非空条装正常
    if (barModes.length === 0) {
      var failTip = document.createElement("span");
      failTip.className = "submode-load-failed";
      failTip.style.cssText = "font-size:12px;opacity:0.7;padding:4px 8px;";
      failTip.textContent = "⚠ 子模式未加载（后端不可达且无本地缓存）";
      bar.appendChild(failTip);
      return;
    }
    for (var i = 0; i < barModes.length; i++) {
      var sm = barModes[i];
      var btn = document.createElement("button");
      btn.className =
        "submode-btn" + (sm.id === state.activeSubMode ? " active" : "");
      btn.dataset.submodeId = sm.id;
      btn.textContent = (sm.icon || "") + " " + sm.label;
      btn.title = sm.desc || sm.description || "";
      (function (capturedId) {
        btn.addEventListener("click", function () {
          switchSubMode(capturedId);
          closePopup();
        });
      })(sm.id);
      bar.appendChild(btn);
    }

    // 并行子模式 chips
    var pModes = state.parallelSubModes || [];
    for (var pi = 0; pi < pModes.length; pi++) {
      (function(pm) {
        var chip = document.createElement("span");
        chip.style.cssText = "display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:10px;background:rgba(79,195,247,0.15);color:var(--vscode-charts-blue,#4fc3f7);font-size:11px;margin:0 2px;";
        chip.innerHTML = _esc((pm.icon || "") + (pm.label || pm.id));
        // F-G 语义澄清：chip=同会话协作角色标记，不是开窗并行
        chip.title = "协作角色：" + (pm.label || pm.id) + "。同会话内并行参与的子模式；跨会话并行由组管理提供";
        var x = document.createElement("span");
        x.textContent = "×";
        x.style.cssText = "cursor:pointer;opacity:0.6;margin-left:2px;";
        x.title = "移除并行子模式";
        x.addEventListener("click", function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: "groupAction", payload: { action: "removeParallelSubMode", body: { id: pm.id }, _callbackId: "psmr_" + (++_groupApiSeq) } });
          state.parallelSubModes = state.parallelSubModes.filter(function(p) { return p.id !== pm.id; });
          renderSubModeBar();
        });
        chip.appendChild(x);
        bar.appendChild(chip);
      })(pModes[pi]);
    }

    // "+" 按钮
    var addBtn = document.createElement("button");
    addBtn.className = "submode-btn";
    addBtn.style.cssText = "opacity:0.5;font-size:14px;padding:0 8px;";
    addBtn.textContent = "+";
    addBtn.title = "添加并行子模式";
    addBtn.addEventListener("click", function() {
      _showParallelPicker();
    });
    bar.appendChild(addBtn);

    updateSelectorLabels();
  }

  function _showParallelPicker() {
    var overlay = document.createElement("div");
    overlay.className = "submode-form-overlay";
    var panel = document.createElement("div");
    panel.className = "submode-form";
    panel.style.maxWidth = "320px";
    panel.style.maxHeight = "60vh";
    panel.style.overflowY = "auto";

    var barModes = subModesOrCache();
    var parallelIds = {};
    (state.parallelSubModes || []).forEach(function(p) { parallelIds[p.id] = true; });
    var available = barModes.filter(function(m) {
      return m.id !== state.activeSubMode && !parallelIds[m.id] && m.enabled !== false;
    });

    var html = '<div style="font-weight:600;font-size:13px;margin-bottom:8px;">+ 添加并行子模式</div>';
    if (!available.length) {
      html += '<div style="opacity:0.5;font-size:12px;text-align:center;padding:16px 0;">无可添加的子模式</div>';
    } else {
      available.forEach(function(m) {
        html += '<div class="yb-parallel-pick" data-id="' + _esc(m.id) + '" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-size:12px;display:flex;align-items:center;gap:6px;">';
        html += '<span>' + _esc((m.icon || "💻") + " " + m.label) + '</span>';
        html += '<span style="margin-left:auto;opacity:0.4;font-size:10px;">+ 并行</span>';
        html += '</div>';
      });
    }
    html += '<div style="text-align:center;margin-top:8px;"><button id="yb-parallel-close" style="padding:4px 16px;border:1px solid var(--vscode-panel-border);background:none;color:inherit;border-radius:4px;cursor:pointer;font-size:11px;">关闭</button></div>';
    panel.innerHTML = html;

    panel.querySelectorAll(".yb-parallel-pick").forEach(function(el) {
      el.addEventListener("mouseenter", function() { el.style.background = "var(--vscode-list-hoverBackground)"; });
      el.addEventListener("mouseleave", function() { el.style.background = ""; });
      el.addEventListener("click", function() {
        var pickId = el.dataset.id;
        var sm = barModes.find(function(m) { return m.id === pickId; });
        if (!state.parallelSubModes) state.parallelSubModes = [];
        state.parallelSubModes.push({ id: pickId, label: sm ? sm.label : pickId, icon: sm ? (sm.icon || "") : "" });
        vscode.postMessage({ type: "groupAction", payload: { action: "addParallelSubMode", body: { id: pickId }, _callbackId: "psma_" + (++_groupApiSeq) } });
        renderSubModeBar();
        overlay.remove();
      });
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
    var closeBtn = panel.querySelector("#yb-parallel-close");
    if (closeBtn) closeBtn.addEventListener("click", function() { overlay.remove(); });
  }

  /**
   * 切换子模式（编程 code / 工作 work 下的细分模式如"任务确认师""代码专家"等）。
   *
   * 步骤：
   *   1. 停止当前生成（若在生成中） → 防旧配置生成完成回弹
   *   2. 更新 state + per-chat 记忆 → renderSubModePanel + renderSubModeBar
   *   3. 发 setActiveSubMode 给 Extension
   *   4. 发 setActiveMode（根据 modeGroup 切 code/work）
   *   5. 切 API 源到子模式绑定源（若不同） → 重拉模型列表
   *   6. 切预设（仅当子模式绑定了非空 presetName）
   *   7. 切模型（仅当子模式绑定了非空 modelName）
   *   8. 更新底部选择器标签
   *
   * 影响：发 5 种 postMessage(setActiveSubMode/setActiveMode/switchApiSource/switchPreset/switchModel)
   */
  function switchSubMode(submodeId) {
    if (submodeId === state.activeSubMode) return;

    // 生成中切模式 → 先停止当前生成（防切换后旧配置生成完成时回弹模式）
    if (state.isGenerating && state.generatingMessageId) {
      vscode.postMessage({ type: "stopGeneration", payload: { messageId: state.generatingMessageId } });
      state.isGenerating = false;
      state.generatingMessageId = null;
    }

    var prevId = state.activeSubMode;
    state.activeSubMode = submodeId;
    if (state.currentChatId) {
      if (!state.activeSubModesMap) state.activeSubModesMap = {};
      state.activeSubModesMap[state.currentChatId] = submodeId;
    }
    renderSubModePanel();
    renderSubModeBar();

    vscode.postMessage({
      type: "setActiveSubMode",
      payload: { id: submodeId, chatId: state.currentChatId || "" },
    });

    var modes = subModesOrCache();
    var sm = modes.find(function (m) {
      return m.id === submodeId;
    });
    // 与本体 subModePanel.mjs 一致：presetName 为空则不切预设、不回退到 id（回退会把 pre-designer 等
    // 当预设名发后端→切不存在预设静默失败）——该语义由下方 :1004 新路径的 `sm && sm.presetName` 条件承载。

    // YonBan 是 IDE 端，永远 code 模式，不发 setActiveMode 给后端（避免影响本体的模式状态）

    // ★ 切 API 源到子模式绑定的源 + 重拉该源模型列表。原 switchSubMode 只切预设+模型、漏切源：
    //   → state.activeApiSource 不同步成子模式源、模型列表(state._modelList)停在旧源
    //   → 切到「官方克」子模式后模型下拉仍列旧源(如 deepseek)。这是源/模型对不上的真根。
    //   B10 注释本就说「编程子模式 API 固定=子模式绑定源」，此处把它真正落实。
    if (sm && sm.apiSource) {
      switchApiSource(sm.apiSource);
      vscode.postMessage({ type: "getModelList", payload: { sourceName: sm.apiSource } });
    }

    // T022：原"旧路径 switchPreset（payload 仅 presetName）"已删——它与下方 :1004 新路径同条件双发，
    // 且不带 chatid → 后端走全局分支（engine.load+写全局 active_preset+bindings）＝每次切子模式
    // 都污染所有 tab 的激活预设（读A写B族残口）。per-chat 切换由下方新路径全参调用覆盖。

    // 切换模型（绑定了模型就用绑定的，没有就用预设默认）
    if (sm && sm.modelName) {
      vscode.postMessage({
        type: "switchModel",
        payload: { modelName: sm.modelName },
      });
      // 同步底部栏标签
      var modelInput = document.getElementById("paramModel");
      if (modelInput) modelInput.value = sm.modelName;
      updateSelectorLabels();
    }

    // ★ 对齐本体 _setActiveSubMode：把子模式绑定的 model/apiSource/采样参数推到后端 runtime-params。
    //   本体通过 _beiluSyncRuntimeParams 做这一步，后端 fake-send 读 runtime-params 得到正确的 max_context。
    //   此前 YonBan 漏了这步 → 后端 runtime-params 停在旧值 → token 进度条上限错（如 4K 而非 1M）。
    var _rtParams = {
      temperature: -1, top_p: -1, top_k: -1, min_p: -1,
      frequency_penalty: null, presence_penalty: null,
      openai_max_tokens: 0, openai_max_context: 0,
    };
    if (sm && sm.modelName) _rtParams.model = sm.modelName;
    if (sm && sm.apiSource) _rtParams.api_source = sm.apiSource;
    if (state.selectedChar) _rtParams.charName = state.selectedChar;
    if (sm && sm.promptPostProcessing) _rtParams.prompt_post_processing = sm.promptPostProcessing;
    if (sm && sm.prefillEnabled !== undefined) _rtParams.prefill_enabled = sm.prefillEnabled;
    if (sm && sm.claudePrefillMode) _rtParams.claude_prefill_mode = sm.claudePrefillMode;
    if (state.currentChatId) _rtParams.chatId = state.currentChatId;
    vscode.postMessage({ type: "setRuntimeParams", payload: _rtParams });

    // T046（子模式预设接入预设系统）：拆除「切子模式→前端强制 switchPreset 联动」（与本体 subModePanel
    //   T046 + 大模式 T040b 同构）。why：原前端强制写 active_preset_map[chatId:mode] = 死绑，覆盖预设系统
    //   当前态。现改为**后端生成时按子模式绑定隔离**（getPromptHandler.mjs T046 块，读 per-user 可配的
    //   sub_modes[].presetName），前端切子模式不再动预设。

    // Toast 提醒
    var icon = (sm && sm.icon) || "⚡";
    var label = (sm && sm.label) || submodeId;
    var toastMsg = icon + " 已切换到 " + label;
    if (sm && sm.presetName) {
      toastMsg += " (预设: " + sm.presetName + ")";
    }
    if (sm && sm.modelName) {
      toastMsg += " (模型: " + sm.modelName + ")";
    }
    showToast(toastMsg, 2500);

    // ★ B10: 编程模式隐藏API选择器（编程模式API固定，无需切换）
    var _smLabel = ((sm && sm.label) || submodeId).toLowerCase();
    var _isCoding = _smLabel.indexOf("编程") >= 0 || _smLabel.indexOf("coding") >= 0;
    if (dom.activeApiLabel) {
      var _apiParent = dom.activeApiLabel.closest(".selector-btn") || dom.activeApiLabel.parentElement;
      if (_apiParent) _apiParent.style.display = _isCoding ? "none" : "";
    }
  }

  // ═══════════════════════════════════════════════════════
  // 子模式动态管理
  // ═══════════════════════════════════════════════════════

  function onSubModesConfig(payload) {
    if (payload && payload.error) {
      console.warn("[chat-modes] 获取子模式配置失败:", payload.error);
      showToast("⚠ 子模式配置加载失败", 2000);
      return;
    }
    if (Array.isArray(payload.sub_modes)) {
      // 全量表留给 label 查找（activeSubMode 可能属非 code 组，过滤表查不到会显裸 id）
      state.allSubModes = payload.sub_modes;
      // YonBan是IDE端，只显示编程模式子模式（modeGroup为code或无modeGroup的）
      state.subModes = payload.sub_modes.filter(function (m) {
        return !m.modeGroup || m.modeGroup === DEFAULT_MODE; // T003 同类补漏：无modeGroup视作默认组
      });
      YB.cacheSubModes(state.subModes); // T010：记"上次成功下发"，供离线/后端不可达时回落
    }
    if (payload.active_sub_mode) {
      state.activeSubMode = payload.active_sub_mode;
    }
    if (payload.active_sub_mode_work) {
      state.activeSubModeWork = payload.active_sub_mode_work;
    }
    if (payload.active_sub_modes_map) {
      state.activeSubModesMap = payload.active_sub_modes_map;
    }
    if (state.currentChatId && state.activeSubModesMap && state.activeSubModesMap[state.currentChatId]) {
      state.activeSubMode = state.activeSubModesMap[state.currentChatId];
    }
    if (Array.isArray(payload.parallel_sub_modes)) {
      state.parallelSubModes = payload.parallel_sub_modes;
    }
    // 链路2（2026-07-08 可操作处禁硬编码）：后端随 getSubModes 下发参数元数据单源
    //   （yonban paramSchema.mjs），子模式表单 min/max/step 据此渲染，替代本文件写死副本
    //   （旧 max_tokens 上限 131072 与 beilu-chat 1000000 两侧打架的根源）。
    if (payload.param_schema && typeof payload.param_schema === "object") {
      state.paramSchema = payload.param_schema;
    }
    // 链路2扩展：枚举选项集下发（pp/预填充），运行参数面板 pp select 立即重建
    //   （其静态 option 只是加载前退化，见 YonBanProvider T002 块）
    if (payload.enum_schema && typeof payload.enum_schema === "object") {
      state.enumSchema = payload.enum_schema;
      var _rtPp = document.getElementById("promptPostProcessing");
      if (_rtPp) {
        // 保持当前值（getRuntimeParams 下发的权威值）；重建前无值=落首项 none（=后端 RUNTIME_PARAMS_DEFAULTS）
        fillEnumSelect(_rtPp, "prompt_post_processing", PP_OPTIONS_FALLBACK, undefined, _rtPp.value);
      }
    }
    renderSubModePanel();
    renderSubModeBar();

    // ★ 传导链修复：子模式配置加载后，根据当前活跃子模式的绑定同步 API 源和模型列表。
    //   此前只更新了 UI 标签，没有把子模式绑定的 apiSource 同步到 state.activeApiSource
    //   → 模型列表一直显示旧源的模型（如 deepseek），而不是子模式绑定的源（如 官方克）。
    var _allModes = subModesOrCache();
    var _activeSm = _allModes.find(function (m) { return m.id === state.activeSubMode; });
    if (!_activeSm && Array.isArray(state.allSubModes)) {
      _activeSm = state.allSubModes.find(function (m) { return m.id === state.activeSubMode; });
    }
    if (_activeSm && _activeSm.apiSource) {
      state.activeApiSource = _activeSm.apiSource;
      vscode.postMessage({ type: "getModelList", payload: { sourceName: _activeSm.apiSource } });
    }
    // T046：启动时不再强制注册预设映射（原为兜 switchSubMode 首启不经过的场景）——预设隔离改由后端
    //   生成时按子模式绑定完成（getPromptHandler T046 块），前端启动不动 active_preset_map。
    updateSelectorLabels();
  }

  /** 编辑/新增子模式表单（优化布局，不再挤在一起） */
  function showSubModeForm(existingMode) {
    var isEdit = !!existingMode;
    var overlay = document.createElement("div");
    overlay.className = "submode-form-overlay";

    var form = document.createElement("div");
    form.className = "submode-form";

    // 标题
    var title = document.createElement("div");
    title.className = "submode-form-title";
    title.textContent = isEdit ? "编辑模式" : "添加模式";
    form.appendChild(title);

    // ID 字段
    var idGroup = createFormGroup("ID (唯一标识)", "text", "smFormId",
      existingMode ? existingMode.id : "", isEdit);
    form.appendChild(idGroup);

    // 图标 + 名称 一行两列
    var row1 = document.createElement("div");
    row1.className = "submode-form-row";

    var iconGroup = createFormGroup("图标", "text", "smFormIcon",
      existingMode ? existingMode.icon || "⚡" : "⚡", false);
    iconGroup.classList.add("form-group-icon");
    row1.appendChild(iconGroup);

    var labelGroup = createFormGroup("名称", "text", "smFormLabel",
      existingMode ? existingMode.label : "", false);
    labelGroup.classList.add("form-group-flex");
    row1.appendChild(labelGroup);

    form.appendChild(row1);

    // 描述
    var descGroup = createFormGroup("描述 (可选)", "text", "smFormDesc",
      existingMode ? (existingMode.desc || existingMode.description || "") : "", false);
    form.appendChild(descGroup);

    // ★ F3修复：绑定预设名 — 改为下拉选择器
    var presetGroup = document.createElement("div");
    presetGroup.className = "submode-form-group";
    var presetLabel = document.createElement("label");
    presetLabel.className = "form-group-label";
    presetLabel.textContent = "绑定预设名 (可选)";
    presetLabel.setAttribute("for", "smFormPreset");
    presetGroup.appendChild(presetLabel);

    var presetSelect = document.createElement("select");
    presetSelect.id = "smFormPreset";
    presetSelect.className = "input-field";

    // 默认选项：不绑定
    var defaultPresetOpt = document.createElement("option");
    defaultPresetOpt.value = "";
    defaultPresetOpt.textContent = "（不绑定预设）";
    presetSelect.appendChild(defaultPresetOpt);

    // 从 state.presetNames 填充选项
    if (state.presetNames && state.presetNames.length > 0) {
      for (var pi = 0; pi < state.presetNames.length; pi++) {
        var pOpt = document.createElement("option");
        pOpt.value = state.presetNames[pi];
        pOpt.textContent = state.presetNames[pi];
        presetSelect.appendChild(pOpt);
      }
    }

    // 设置当前值
    if (existingMode && existingMode.presetName) {
      presetSelect.value = existingMode.presetName;
      // 如果当前值不在列表中，添加为额外选项
      if (presetSelect.value !== existingMode.presetName) {
        var extraOpt = document.createElement("option");
        extraOpt.value = existingMode.presetName;
        extraOpt.textContent = existingMode.presetName + " (当前)";
        presetSelect.insertBefore(extraOpt, presetSelect.firstChild.nextSibling);
        presetSelect.value = existingMode.presetName;
      }
    }

    presetGroup.appendChild(presetSelect);
    form.appendChild(presetGroup);

    // 绑定 API 源（下拉）
    var apiGroup = document.createElement("div");
    apiGroup.className = "submode-form-group";
    var apiLabel = document.createElement("label");
    apiLabel.className = "form-group-label";
    apiLabel.textContent = "绑定 API 源 (可选)";
    apiGroup.appendChild(apiLabel);
    var apiSelect = document.createElement("select");
    apiSelect.id = "smFormApiSource";
    apiSelect.className = "input-field";
    var defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "（默认 API）";
    apiSelect.appendChild(defaultOpt);
    if (state.apiSources) {
      for (var i = 0; i < state.apiSources.length; i++) {
        var opt = document.createElement("option");
        opt.value = state.apiSources[i];
        opt.textContent = state.apiSources[i];
        apiSelect.appendChild(opt);
      }
    }
    if (existingMode && existingMode.apiSource) {
      apiSelect.value = existingMode.apiSource;
    }
    apiGroup.appendChild(apiSelect);
    form.appendChild(apiGroup);

    // 绑定模型（可选）— 根据 API 源动态加载模型列表
    var modelGroup = document.createElement("div");
    modelGroup.className = "submode-form-group";
    var modelLabel = document.createElement("label");
    modelLabel.className = "form-group-label";
    modelLabel.textContent = "绑定模型 (可选)";
    modelGroup.appendChild(modelLabel);
    var modelSelect = document.createElement("select");
    modelSelect.id = "smFormModel";
    modelSelect.className = "input-field";
    var defaultModelOpt = document.createElement("option");
    defaultModelOpt.value = "";
    defaultModelOpt.textContent = "（使用 API 源默认模型）";
    modelSelect.appendChild(defaultModelOpt);
    modelGroup.appendChild(modelSelect);
    form.appendChild(modelGroup);

    // 初始填充模型列表
    // ★ 模型列表填充函数（不覆盖全局 handler，用 _pendingModelFill 匹配）
    var _pendingModelFill = null;
    function populateModelSelect(sel, sourceName, currentVal) {
      while (sel.options.length > 1) sel.remove(1);
      if (!sourceName) return;
      _pendingModelFill = { sel: sel, source: sourceName, val: currentVal };
      vscode.postMessage({ type: "getModelList", payload: { sourceName: sourceName } });
    }
    // 全局 onModelList 已处理底部栏弹出层；这里在 overlay 内拦截
    var _origOnModelList = YB.onModelList;
    var _formModelListHandler = function(payload) {
      if (_pendingModelFill && _pendingModelFill.sel && _pendingModelFill.sel.isConnected) {
        var pf = _pendingModelFill;
        _pendingModelFill = null;
        var models = (payload && (payload.models || payload.list)) || [];
        var added = {};
        models.forEach(function(m) {
          var name = typeof m === "string" ? m : (m.id || m.name || "");
          if (!name || added[name]) return;
          added[name] = true;
          var opt = document.createElement("option");
          opt.value = name; opt.textContent = name.split("/").pop();
          pf.sel.appendChild(opt);
        });
        if (pf.val) pf.sel.value = pf.val;
      }
      if (_origOnModelList) _origOnModelList(payload);
    };
    YB.onModelList = _formModelListHandler;
    function _restoreModelListHandler() {
      if (YB.onModelList === _formModelListHandler) YB.onModelList = _origOnModelList;
      _pendingModelFill = null;
    }

    var initialApiSource = (existingMode && existingMode.apiSource) || "";
    var initialModel = (existingMode && existingMode.modelName) || "";
    populateModelSelect(modelSelect, initialApiSource, initialModel);

    // API 源切换时联动刷新模型列表
    apiSelect.addEventListener("change", function () {
      populateModelSelect(modelSelect, apiSelect.value, "");
    });

    // -- 参数行1：温度 + Top-P --
    var paramRow1 = document.createElement("div");
    paramRow1.className = "submode-form-row";
    var tempGroup = document.createElement("div");
    tempGroup.className = "submode-form-group form-group-flex";
    var tempLabel = document.createElement("label");
    tempLabel.className = "form-group-label";
    tempLabel.textContent = "\u6E29\u5EA6";
    tempLabel.setAttribute("for", "smFormTemperature");
    // 链路2：值域从后端 param_schema 读（state.paramSchema，getSubModes 下发；静态值仅离线退化）；
    //   新建不再预填 0.7——预填=用户不改也写覆盖值进配置，与 beilu-chat 同表单"空=继承预设"语义打架
    var _ps = state.paramSchema || {};
    var tempInput = document.createElement("input");
    tempInput.type = "number"; tempInput.id = "smFormTemperature"; tempInput.className = "input-field";
    tempInput.min = String((_ps.temperature && _ps.temperature.min) != null ? _ps.temperature.min : 0);
    tempInput.max = String((_ps.temperature && _ps.temperature.max) != null ? _ps.temperature.max : 2);
    tempInput.step = String((_ps.temperature && _ps.temperature.step) || 0.01); // 退化值=PARAM_SCHEMA 等值镜像
    tempInput.placeholder = "\u9ED8\u8BA4\uFF08\u7EE7\u627F\u9884\u8BBE\uFF09";
    tempInput.value = existingMode && existingMode.temperature !== undefined ? existingMode.temperature : "";
    tempGroup.appendChild(tempLabel); tempGroup.appendChild(tempInput); paramRow1.appendChild(tempGroup);
    var topPGroup = document.createElement("div");
    topPGroup.className = "submode-form-group form-group-flex";
    var topPLabel = document.createElement("label");
    topPLabel.className = "form-group-label";
    topPLabel.textContent = "Top-P";
    topPLabel.setAttribute("for", "smFormTopP");
    var topPInput = document.createElement("input");
    topPInput.type = "number"; topPInput.id = "smFormTopP"; topPInput.className = "input-field";
    topPInput.min = String((_ps.top_p && _ps.top_p.min) != null ? _ps.top_p.min : 0);
    topPInput.max = String((_ps.top_p && _ps.top_p.max) != null ? _ps.top_p.max : 1);
    topPInput.step = String((_ps.top_p && _ps.top_p.step) || 0.01); // 退化值=PARAM_SCHEMA 等值镜像
    topPInput.placeholder = "\u9ED8\u8BA4\uFF08\u7EE7\u627F\u9884\u8BBE\uFF09";
    topPInput.value = existingMode && existingMode.top_p !== undefined ? existingMode.top_p : "";
    topPGroup.appendChild(topPLabel); topPGroup.appendChild(topPInput); paramRow1.appendChild(topPGroup);
    form.appendChild(paramRow1);
    // -- 参数行2：最大输出Token + 备用API源 --
    var paramRow2 = document.createElement("div");
    paramRow2.className = "submode-form-row";
    var maxTokGroup = document.createElement("div");
    maxTokGroup.className = "submode-form-group form-group-flex";
    var maxTokLabel = document.createElement("label");
    maxTokLabel.className = "form-group-label";
    maxTokLabel.textContent = "\u6700\u5927\u8F93\u51FAToken";
    maxTokLabel.setAttribute("for", "smFormMaxTokens");
    var maxTokInput = document.createElement("input");
    maxTokInput.type = "number"; maxTokInput.id = "smFormMaxTokens"; maxTokInput.className = "input-field";
    maxTokInput.min = String((_ps.max_tokens && _ps.max_tokens.min) != null ? _ps.max_tokens.min : 256);
    maxTokInput.max = String((_ps.max_tokens && _ps.max_tokens.max) != null ? _ps.max_tokens.max : 1000000); // 退化值=PARAM_SCHEMA 等值镜像（旧 131072 即两侧打架根源）
    maxTokInput.step = String((_ps.max_tokens && _ps.max_tokens.step) || 256);
    maxTokInput.placeholder = "\u9ED8\u8BA4\uFF08\u7EE7\u627F\u9884\u8BBE\uFF09";
    // 键名归一（2026-07-10）：正名键=本体驼峰 maxTokens（后端读侧 maxTokens ?? max_tokens 驼峰优先，
    //   YonBan 旧蛇形键在驼峰残留时会被压住且两侧表单互相看不见对方的值）；读兼容旧蛇形存量
    maxTokInput.value = existingMode && (existingMode.maxTokens !== undefined || existingMode.max_tokens !== undefined)
      ? (existingMode.maxTokens !== undefined ? existingMode.maxTokens : existingMode.max_tokens) : "";
    maxTokGroup.appendChild(maxTokLabel); maxTokGroup.appendChild(maxTokInput); paramRow2.appendChild(maxTokGroup);
    // -- 参数行2b：Top-K + Min-P（链路2扩展 2026-07-10「用户可以掌控全部参数」；消费链=
    //    getPromptHandler 子模式提取→preset mergeRuntimeParams 覆盖，与温度同通路）--
    var paramRow2b = document.createElement("div");
    paramRow2b.className = "submode-form-row";
    var topKGroup = document.createElement("div");
    topKGroup.className = "submode-form-group form-group-flex";
    var topKLabel = document.createElement("label");
    topKLabel.className = "form-group-label";
    topKLabel.textContent = "Top-K";
    topKLabel.setAttribute("for", "smFormTopK");
    var topKInput = document.createElement("input");
    topKInput.type = "number"; topKInput.id = "smFormTopK"; topKInput.className = "input-field";
    topKInput.min = String((_ps.top_k && _ps.top_k.min) != null ? _ps.top_k.min : 0);
    topKInput.max = String((_ps.top_k && _ps.top_k.max) != null ? _ps.top_k.max : 500);
    topKInput.step = String((_ps.top_k && _ps.top_k.step) || 1);
    topKInput.placeholder = "\u9ED8\u8BA4\uFF08\u7EE7\u627F\u9884\u8BBE\uFF09";
    topKInput.value = existingMode && existingMode.top_k !== undefined ? existingMode.top_k : "";
    topKGroup.appendChild(topKLabel); topKGroup.appendChild(topKInput); paramRow2b.appendChild(topKGroup);
    var minPGroup = document.createElement("div");
    minPGroup.className = "submode-form-group form-group-flex";
    var minPLabel = document.createElement("label");
    minPLabel.className = "form-group-label";
    minPLabel.textContent = "Min-P";
    minPLabel.setAttribute("for", "smFormMinP");
    var minPInput = document.createElement("input");
    minPInput.type = "number"; minPInput.id = "smFormMinP"; minPInput.className = "input-field";
    minPInput.min = String((_ps.min_p && _ps.min_p.min) != null ? _ps.min_p.min : 0);
    minPInput.max = String((_ps.min_p && _ps.min_p.max) != null ? _ps.min_p.max : 1);
    minPInput.step = String((_ps.min_p && _ps.min_p.step) || 0.01);
    minPInput.placeholder = "\u9ED8\u8BA4\uFF08\u7EE7\u627F\u9884\u8BBE\uFF09";
    minPInput.value = existingMode && existingMode.min_p !== undefined ? existingMode.min_p : "";
    minPGroup.appendChild(minPLabel); minPGroup.appendChild(minPInput); paramRow2b.appendChild(minPGroup);
    var backupApiGroup = document.createElement("div");
    backupApiGroup.className = "submode-form-group form-group-flex";
    var backupApiLabel = document.createElement("label");
    backupApiLabel.className = "form-group-label";
    backupApiLabel.textContent = "\u5907\u7528API\u6E90";
    backupApiLabel.setAttribute("for", "smFormBackupApi");
    var backupApiSelect = document.createElement("select");
    backupApiSelect.id = "smFormBackupApi"; backupApiSelect.className = "input-field";
    var noBackupOpt = document.createElement("option");
    noBackupOpt.value = ""; noBackupOpt.textContent = "\uFF08\u65E0\u5907\u7528\uFF09";
    backupApiSelect.appendChild(noBackupOpt);
    if (state.apiSources && state.apiSources.length > 0) {
      state.apiSources.forEach(function(src) {
        var opt = document.createElement("option");
        opt.value = src.id || src.name || src; opt.textContent = src.name || src.id || src;
        backupApiSelect.appendChild(opt);
      });
    }
    if (existingMode && existingMode.backup_api_source) backupApiSelect.value = existingMode.backup_api_source;
    backupApiGroup.appendChild(backupApiLabel); backupApiGroup.appendChild(backupApiSelect); paramRow2.appendChild(backupApiGroup);
    form.appendChild(paramRow2);
    form.appendChild(paramRow2b);

    // -- 参数行3：最大上下文 + 提示词后处理 --
    var paramRow3 = document.createElement("div");
    paramRow3.className = "submode-form-row";
    var maxCtxGroup = document.createElement("div");
    maxCtxGroup.className = "submode-form-group form-group-flex";
    var maxCtxLabel = document.createElement("label");
    maxCtxLabel.className = "form-group-label";
    maxCtxLabel.textContent = "最大上下文";
    maxCtxLabel.setAttribute("for", "smFormMaxContext");
    var maxCtxInput = document.createElement("input");
    maxCtxInput.type = "number"; maxCtxInput.id = "smFormMaxContext"; maxCtxInput.className = "input-field";
    // 链路2：值域接 param_schema.max_context（旧 min/step/预填 1000000 全写死且预填=用户不改
    //   也写覆盖值，与"空=继承预设"语义打架——温度/top_p 同表单早已改空，此处补齐）
    maxCtxInput.min = String((_ps.max_context && _ps.max_context.min) != null ? _ps.max_context.min : 1024);
    maxCtxInput.max = String((_ps.max_context && _ps.max_context.max) != null ? _ps.max_context.max : 10000000);
    maxCtxInput.step = String((_ps.max_context && _ps.max_context.step) || 1);
    maxCtxInput.placeholder = "\u9ED8\u8BA4\uFF08\u7EE7\u627F\u9884\u8BBE\uFF09";
    maxCtxInput.value = existingMode && existingMode.maxContext !== undefined ? existingMode.maxContext : "";
    maxCtxGroup.appendChild(maxCtxLabel); maxCtxGroup.appendChild(maxCtxInput); paramRow3.appendChild(maxCtxGroup);
    var ppGroup = document.createElement("div");
    ppGroup.className = "submode-form-group form-group-flex";
    var ppLabel = document.createElement("label");
    ppLabel.className = "form-group-label";
    ppLabel.textContent = "提示词后处理";
    ppLabel.setAttribute("for", "smFormPostProcess");
    var ppSelect = document.createElement("select");
    ppSelect.id = "smFormPostProcess"; ppSelect.className = "input-field";
    // 链路2扩展：选项集后端单源（旧 innerHTML 写死副本已删）；空项=不覆盖继承全局，文案对齐本体
    fillEnumSelect(ppSelect, "prompt_post_processing", PP_OPTIONS_FALLBACK, "（使用默认）",
      (existingMode && existingMode.promptPostProcessing) || "");
    ppGroup.appendChild(ppLabel); ppGroup.appendChild(ppSelect); paramRow3.appendChild(ppGroup);
    form.appendChild(paramRow3);

    // -- 尾部预填充 --
    var prefillRow = document.createElement("div");
    prefillRow.className = "submode-form-row";
    var prefillCheckGroup = document.createElement("div");
    prefillCheckGroup.className = "submode-form-group form-group-flex submode-form-toggle";
    var prefillCheckLabel = document.createElement("label");
    prefillCheckLabel.className = "form-group-label";
    prefillCheckLabel.textContent = "尾部预填充";
    var prefillCheck = document.createElement("input");
    prefillCheck.type = "checkbox"; prefillCheck.id = "smFormPrefill"; prefillCheck.className = "memory-preset-checkbox";
    // 对齐本体 subModePanel 回填语义：新建默认不启用（旧默认 true=新建即覆盖全局，双侧行为漂移）
    prefillCheck.checked = existingMode ? !!existingMode.prefillEnabled : false;
    prefillCheckGroup.appendChild(prefillCheckLabel); prefillCheckGroup.appendChild(prefillCheck); prefillRow.appendChild(prefillCheckGroup);
    var cpGroup = document.createElement("div");
    cpGroup.className = "submode-form-group form-group-flex";
    var cpSelect = document.createElement("select");
    cpSelect.id = "smFormClaudePrefill"; cpSelect.className = "input-field";
    // 链路2扩展：选项集后端单源。旧写死集 off/prefill/claude 是 0708 正名前的漂移活体
    //   （"Claude模式"=已废自造词，且默认强写 "claude"=每个子模式被迫覆盖全局）。
    //   现对齐本体：空项 ""=不改变（继承全局），旧存量 off/claude 落回空项显示、消费端归一自愈。
    fillEnumSelect(cpSelect, "claude_prefill_mode", PREFILL_OPTIONS_FALLBACK, "不改变",
      (existingMode && existingMode.claudePrefillMode) || "");
    cpGroup.appendChild(cpSelect); prefillRow.appendChild(cpGroup);
    form.appendChild(prefillRow);

    // 启用开关
    var enableGroup = document.createElement("div");
    enableGroup.className = "submode-form-group submode-form-toggle";
    var enableLabel = document.createElement("label");
    enableLabel.className = "form-group-label";
    enableLabel.textContent = "启用";
    enableGroup.appendChild(enableLabel);
    var enableCheckbox = document.createElement("input");
    enableCheckbox.type = "checkbox";
    enableCheckbox.id = "smFormEnabled";
    enableCheckbox.checked = existingMode ? existingMode.enabled !== false : true;
    enableCheckbox.className = "memory-preset-checkbox";
    enableGroup.appendChild(enableCheckbox);
    form.appendChild(enableGroup);

    // 操作按钮
    var actions = document.createElement("div");
    actions.className = "submode-form-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "保存";
    actions.appendChild(saveBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-secondary";
    cancelBtn.textContent = "取消";
    actions.appendChild(cancelBtn);

    form.appendChild(actions);
    overlay.appendChild(form);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { _restoreModelListHandler(); overlay.remove(); }
    });

    cancelBtn.addEventListener("click", function () {
      _restoreModelListHandler(); overlay.remove();
    });

    saveBtn.addEventListener("click", function () {
      var id = form.querySelector("#smFormId").value.trim();
      var label = form.querySelector("#smFormLabel").value.trim();
      var icon = form.querySelector("#smFormIcon").value.trim() || "⚡";
      var desc = form.querySelector("#smFormDesc").value.trim();
      var presetName = form.querySelector("#smFormPreset").value;
      var apiSource = form.querySelector("#smFormApiSource").value;
      var modelName = form.querySelector("#smFormModel").value.trim(); // 0714 trim 扫尾：同函数 id/label/icon/desc 均 trim，唯 model 漏（脏值曾致模型请求解析炸族病）
      var enabled = form.querySelector("#smFormEnabled").checked;

      if (!id || !label) {
        showToast("✗ ID 和名称不能为空");
        return;
      }

      // T001/H3 守卫：数值字段取不到/无效 = 报错中止保存，禁塞默认值静默覆盖用户设置
      // （旧码 ||0.7/||1.0/||8192：DOM 取值失败、甚至合法 temperature=0 都会被静默改成固定值）
      var _nfDefs = [
        ["#smFormTemperature", "Temperature", parseFloat, "temperature"],
        ["#smFormTopP", "Top-P", parseFloat, "top_p"],
        ["#smFormMaxTokens", "Max Tokens", function (v) { return parseInt(v, 10); }, "max_tokens"],
        ["#smFormTopK", "Top-K", function (v) { return parseInt(v, 10); }, "top_k"],
        ["#smFormMinP", "Min-P", parseFloat, "min_p"],
      ];
      var _numFields = {};
      for (var _nfI = 0; _nfI < _nfDefs.length; _nfI++) {
        var _nfEl = form.querySelector(_nfDefs[_nfI][0]);
        if (!_nfEl) {
          showToast("✗ " + _nfDefs[_nfI][1] + " 字段缺失，保存已中止");
          return;
        }
        // 链路2：空 = 不覆盖（继承预设），对齐 beilu-chat 同表单语义与后端三层合并
        //   （子模式层缺字段=不覆盖）；编辑时清空 = 取消覆盖（undefined 经 JSON 序列化即字段消失）。
        //   非空但无效仍中止（防 DOM 值异常被静默写入）。
        var _nfRaw = String(_nfEl.value == null ? "" : _nfEl.value).trim();
        if (_nfRaw === "") { _numFields[_nfDefs[_nfI][3]] = undefined; continue; }
        var _nfV = _nfDefs[_nfI][2](_nfRaw);
        if (isNaN(_nfV)) {
          showToast("✗ " + _nfDefs[_nfI][1] + " 填写无效，保存已中止");
          return;
        }
        _numFields[_nfDefs[_nfI][3]] = _nfV;
      }

      var modes = subModesOrCache().slice();

      if (isEdit) {
        var idx = modes.findIndex(function (m) {
          return m.id === existingMode.id;
        });
        if (idx >= 0) {
          modes[idx] = Object.assign({}, modes[idx], {
            label: label,
            icon: icon,
            desc: desc,
            description: desc,
            presetName: presetName,
            apiSource: apiSource,
            modelName: modelName,
            enabled: enabled,
            temperature: _numFields.temperature,
            top_p: _numFields.top_p,
            top_k: _numFields.top_k,   // 链路2扩展：蛇形键对齐后端读侧 _activeSM.top_k
            min_p: _numFields.min_p,   // 链路2扩展：同上
            // 键名归一：正名键=本体驼峰 maxTokens（后端 maxTokens ?? max_tokens 驼峰优先），
            // 旧蛇形键置 undefined 序列化即消失，防双键并存旧值压新值
            maxTokens: _numFields.max_tokens,
            max_tokens: undefined,
            maxContext: parseInt((form.querySelector("#smFormMaxContext") || {}).value, 10) || undefined,
            promptPostProcessing: (form.querySelector("#smFormPostProcess") || {}).value || "",
            // 对齐本体写入语义：prefill 勾选原样写（旧 !==false 在 DOM 缺失时误写 true）；
            // 预填充模式空=不改变（旧 ||"claude" 强写已废值=每次保存都覆盖）
            prefillEnabled: !!(form.querySelector("#smFormPrefill") || {}).checked,
            claudePrefillMode: (form.querySelector("#smFormClaudePrefill") || {}).value || "",
            backup_api_source: (form.querySelector("#smFormBackupApi") || {}).value || "",
          });
          // B18 副本同步（与本体 subModePanel 同款）：merge 保留的旧 model_params 是读侧最高优先，
          //   不把表单值写入副本则刚改的值被旧副本盖住。undefined 键序列化消失=清空回落扁平。
          var _smMp = modes[idx].model_params;
          if (_smMp && typeof _smMp === "object") {
            modes[idx].model_params = Object.assign({}, _smMp, {
              model: modelName || undefined,
              api_source: apiSource || undefined,
              temperature: _numFields.temperature,
              top_p: _numFields.top_p,
              top_k: _numFields.top_k,
              min_p: _numFields.min_p,
              max_tokens: _numFields.max_tokens,
              max_context: modes[idx].maxContext,
              prompt_post_processing: modes[idx].promptPostProcessing || undefined,
              claude_prefill_mode: modes[idx].claudePrefillMode || undefined,
              prefill_enabled: modes[idx].prefillEnabled,
              // 驼峰别名键清除：副本别名在读侧 ?? 链先于扁平，残留旧值会借尸还魂
              modelName: undefined, apiSource: undefined, maxContext: undefined, maxTokens: undefined,
              promptPostProcessing: undefined, claudePrefillMode: undefined, prefillEnabled: undefined,
            });
          }
        }
      } else {
        if (
          modes.some(function (m) {
            return m.id === id;
          })
        ) {
          showToast("✗ ID \"" + id + "\" 已存在");
          return;
        }
        modes.push({
          id: id,
          label: label,
          icon: icon,
          desc: desc,
          description: desc,
          presetName: presetName,
          apiSource: apiSource,
          modelName: modelName,
          enabled: enabled,
          temperature: _numFields.temperature,
          top_p: _numFields.top_p,
          top_k: _numFields.top_k,   // 链路2扩展
          min_p: _numFields.min_p,   // 链路2扩展
          maxTokens: _numFields.max_tokens, // 键名归一：正名键=本体驼峰（新建无旧键无需清除）
          // T061：补齐与编辑分支同构的四字段（原新建分支缺 → 新建子模式这四项永远缺省，
          //   后端 getPromptHandler:297/306 读 sub_modes[].claudePrefillMode/promptPostProcessing，
          //   proxy 消费 maxContext/prefillEnabled，缺省即行为不一致）。字段读取来源与编辑分支同一 DOM。
          maxContext: parseInt((form.querySelector("#smFormMaxContext") || {}).value, 10) || undefined,
          promptPostProcessing: (form.querySelector("#smFormPostProcess") || {}).value || "",
          prefillEnabled: !!(form.querySelector("#smFormPrefill") || {}).checked,
          claudePrefillMode: (form.querySelector("#smFormClaudePrefill") || {}).value || "",
          backup_api_source: (form.querySelector("#smFormBackupApi") || {}).value || "",
        });
      }

      state.subModes = modes;
      YB.cacheSubModes(modes); // T010：本地保存同步刷新缓存
      vscode.postMessage({
        type: "saveSubModes",
        payload: { subModes: modes },
      });
      _restoreModelListHandler();
      overlay.remove();
      renderSubModePanel();
      renderSubModeBar();
      showToast("✓ 模式 " + icon + " " + label + " 已保存");
    });

    document.body.appendChild(overlay);

    // 自动聚焦
    var focusEl = isEdit ? form.querySelector("#smFormLabel") : form.querySelector("#smFormId");
    if (focusEl) setTimeout(function () { focusEl.focus(); }, 100);
  }

  /** 创建表单字段组 */
  function createFormGroup(labelText, inputType, inputId, value, disabled) {
    var group = document.createElement("div");
    group.className = "submode-form-group";

    var label = document.createElement("label");
    label.className = "form-group-label";
    label.textContent = labelText;
    label.setAttribute("for", inputId);
    group.appendChild(label);

    var input = document.createElement("input");
    input.type = inputType;
    input.id = inputId;
    input.className = "input-field";
    input.value = value || "";
    if (disabled) {
      input.disabled = true;
      input.style.opacity = "0.6";
    }
    group.appendChild(input);

    return group;
  }

  // ★ VSCode webview 不支持 confirm()，用 _pendingDelete 双击确认代替
  var _pendingDeleteId = null;
  var _pendingDeleteTimer = null;
  function deleteSubMode(smId) {
    if (_pendingDeleteId !== smId) {
      _pendingDeleteId = smId;
      showToast("再次点击确认删除", 2000);
      if (_pendingDeleteTimer) clearTimeout(_pendingDeleteTimer);
      _pendingDeleteTimer = setTimeout(function () { _pendingDeleteId = null; }, 3000);
      return;
    }
    _pendingDeleteId = null;
    var modes = state.subModes.filter(function (m) {
      return m.id !== smId;
    });
    state.subModes = modes;
    YB.cacheSubModes(modes); // T010：本地保存同步刷新缓存
    vscode.postMessage({
      type: "saveSubModes",
      payload: { subModes: modes },
    });
    renderSubModePanel();
    renderSubModeBar();
    showToast("模式已删除");
  }

  // ═══════════════════════════════════════════════════════
  // 记忆预设配置 + P1/P8 状态
  // ═══════════════════════════════════════════════════════

  function startMemoryPoll() {
    stopMemoryPoll();
    state.lastMemoryOutputId = 0;
    fetchMemoryStatus();
    state.memoryPollTimer = setInterval(fetchMemoryStatus, YB.POLL.memory); // 单源=constants.ts MEMORY_POLL_MS
  }

  function stopMemoryPoll() {
    if (state.memoryPollTimer !== null) {
      clearInterval(state.memoryPollTimer);
      state.memoryPollTimer = null;
    }
    state.memoryStatusMsg = null;
    if (dom.memoryStatusBar) {
      dom.memoryStatusBar.classList.add("hidden");
    }
  }

  function fetchMemoryStatus() {
    vscode.postMessage({
      type: "getMemoryAIOutput",
      payload: { sinceId: state.lastMemoryOutputId },
    });
  }

  /** ★ F2修复：同时读取 memory_presets 和 injection_prompts */
  function onMemoryConfig(payload) {
    if (payload && payload.error) {
      console.warn("[chat-modes] 获取记忆配置失败:", payload.error);
      if (dom.memoryPresetList) {
        dom.memoryPresetList.innerHTML =
          '<div class="memory-error">获取配置失败</div>';
      }
      return;
    }
    // ★ BUG#3 修复：后端 beilu-memory GetData 返回 memory_presets，不是 presets
    var presets = payload.memory_presets || payload.presets || [];
    var injections = payload.injection_prompts || [];
    state.memoryPresets = presets;
    state.injectionPrompts = injections;
    renderMemoryPresets();
  }

  function onMemoryAIOutput(payload) {
    if (payload && payload.error) {
      if (dom.memoryStatusBar) dom.memoryStatusBar.classList.add("hidden");
      return;
    }

    // ★ BUG#4 修复：后端 getMemoryAIOutput 返回 outputs，不是 items/queue
    var items = payload.outputs || payload.items || payload.queue || [];
    if (items.length === 0) return;

    var last = items[items.length - 1];
    if (last.id && last.id > state.lastMemoryOutputId) {
      state.lastMemoryOutputId = last.id;
    }

    var presetLabel = last.presetId || last.preset || "记忆";
    var statusText = last.status || last.state || "done";
    var statusMap = {
      running: "运行中",
      pending: "等待中",
      error: "✗ 错误",
      done: "✓ 完成",
      completed: "✓ 完成",
      skipped: "跳过",
    };
    var displayStatus = statusMap[statusText] || statusText;
    state.memoryStatusMsg = presetLabel + ": " + displayStatus;

    updateMemoryStatusBar();
  }

  function onDiagSnapshot(payload) {
    if (payload && payload.error) {
      console.warn("[chat-modes] 诊断快照获取失败:", payload.error);
      return;
    }
    if (payload.presets) {
      state.memoryPresets = payload.presets;
      renderMemoryPresets();
    }
  }

  /** ★ F2修复 + BUG#5修复：分组渲染 memory_presets（P系列）和 injection_prompts（IN系列） */
  function renderMemoryPresets() {
    var list = dom.memoryPresetList;
    if (!list) return;
    list.innerHTML = "";

    var hasPresets = state.memoryPresets.length > 0;
    var hasInjections = state.injectionPrompts && state.injectionPrompts.length > 0;

    if (!hasPresets && !hasInjections) {
      list.innerHTML = '<div class="memory-empty">无可用记忆预设</div>';
      return;
    }

    // ── 记忆AI预设（P系列）──
    if (hasPresets) {
      var presetHeader = document.createElement("div");
      presetHeader.className = "memory-group-header";
      presetHeader.textContent = "记忆AI预设";
      list.appendChild(presetHeader);

      for (var i = 0; i < state.memoryPresets.length; i++) {
        var preset = state.memoryPresets[i];
        // ★ BUG#5 修复：P系列传 isInjection=false
        list.appendChild(createMemoryPresetItem(preset, false));
      }
    }

    // ── 注入提示词（IN系列）— YonBan 不显示 ──
    // YonBan 始终为 code 模式，注入提示词由后端根据模式自动决定
    // （INJ-2-code/INJ-1-code 等自动启用，用户无需手动切换）
  }

  /**
   * 创建单个记忆预设/注入提示词条目
   * ★ BUG#5 修复：新增 isInjection 参数
   * - P系列 (isInjection=false) → 发 toggleMemoryPreset { presetId, enabled }
   * - IN系列 (isInjection=true) → 发 toggleInjectionPrompt { injectionId, enabled }
   */
  function createMemoryPresetItem(preset, isInjection) {
    var item = document.createElement("div");
    item.className = "memory-preset-item";

    var label = document.createElement("label");
    label.className = "memory-preset-label";

    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "memory-preset-checkbox";
    checkbox.checked = !!preset.enabled;
    // ★ BUG#5 修复：根据 isInjection 发送不同的消息类型
    // ★ 互斥：同编号注入提示词（如 INJ-2 vs INJ-2-code）开启一个时关闭另一个
    (function (capturedPreset, capturedIsInjection) {
      checkbox.addEventListener("change", function () {
        var checked = this.checked;
        if (capturedIsInjection) {
          // IN系列 → 使用 toggleInjectionPrompt
          vscode.postMessage({
            type: "toggleInjectionPrompt",
            payload: {
              injectionId: capturedPreset.id,
              enabled: checked,
            },
          });

          // ★ 互斥逻辑：开启时，关闭同编号的其他变体
          if (checked) {
            var myId = capturedPreset.id;
            // 模式后缀集：优先从后端下发的子模式 modeGroup 动态收集（真源=chatStorage.mjs
            // _VALID_CHAT_MODES 4 值集），静态表为等值镜像退化——旧写死 3 值集缺 "smart"
            // 是与后端枚举的漂移点（2026-07-13 收口）
            var _modeSuffixes = ["code", "chat", "work", "smart"];
            if (Array.isArray(state.allSubModes)) {
              state.allSubModes.forEach(function (m) {
                if (m.modeGroup && _modeSuffixes.indexOf(m.modeGroup) < 0) _modeSuffixes.push(m.modeGroup);
              });
            }
            var suffixMatch = myId.match(new RegExp("^(.+)-(" + _modeSuffixes.join("|") + ")$"));
            var counterparts = [];
            if (suffixMatch) {
              // 我是变体（如 INJ-2-code），找基础版和其他变体
              var baseId = suffixMatch[1];
              counterparts.push(baseId);
              _modeSuffixes.forEach(function (s) {
                var v = baseId + "-" + s;
                if (v !== myId) counterparts.push(v);
              });
            } else {
              // 我是基础版（如 INJ-2），找所有变体
              _modeSuffixes.forEach(function (s) {
                counterparts.push(myId + "-" + s);
              });
            }
            // 关闭互斥项并更新 UI
            counterparts.forEach(function (cId) {
              var counterpart = state.injectionPrompts.find(function (p) { return p.id === cId; });
              if (counterpart && counterpart.enabled) {
                counterpart.enabled = false;
                vscode.postMessage({
                  type: "toggleInjectionPrompt",
                  payload: { injectionId: cId, enabled: false },
                });
              }
            });
            // 刷新 UI 以反映互斥变化
            setTimeout(renderMemoryPresets, 50);
          }
        } else {
          // P系列 → 使用 toggleMemoryPreset
          vscode.postMessage({
            type: "toggleMemoryPreset",
            payload: {
              presetId: capturedPreset.id,
              enabled: checked,
            },
          });
        }
      });
    })(preset, isInjection);
    label.appendChild(checkbox);

    var nameSpan = document.createElement("span");
    nameSpan.className = "memory-preset-name";
    nameSpan.textContent = preset.name || preset.id;
    label.appendChild(nameSpan);

    item.appendChild(label);

    if (preset.description) {
      var descEl = document.createElement("div");
      descEl.className = "memory-preset-desc";
      descEl.textContent = preset.description;
      item.appendChild(descEl);
    }

    return item;
  }

  function updateMemoryStatusBar() {
    if (!state.memoryStatusMsg) {
      if (dom.memoryStatusBar) dom.memoryStatusBar.classList.add("hidden");
      return;
    }
    if (dom.memoryStatusText) {
      dom.memoryStatusText.textContent = state.memoryStatusMsg;
    }
    if (dom.memoryStatusBar) dom.memoryStatusBar.classList.remove("hidden");
  }

  // ═══════════════════════════════════════════════════════
  // 底部选择器标签更新
  // ═══════════════════════════════════════════════════════

  function updateSelectorLabels() {
    var modes = subModesOrCache();
    var active = modes.find(function (m) {
      return m.id === state.activeSubMode;
    });
    if (!active && Array.isArray(state.allSubModes)) {
      active = state.allSubModes.find(function (m) {
        return m.id === state.activeSubMode;
      });
    }
    if (dom.activeModeLabel) {
      var modeText = active ? (active.icon || "⚡") + " " + active.label : "⚡ " + state.activeSubMode;
      dom.activeModeLabel.textContent = modeText;
      dom.activeModeLabel.title = active ? active.label + (active.desc ? " — " + active.desc : "") : state.activeSubMode;
    }
    if (dom.activeApiLabel) {
      // 优先显示当前子模式自身绑定的模型（model_params.model 副本 > 扁平 modelName）；
      // 子模式没绑才回退 paramModel 输入框的 effective 模型；都没有才「默认」。
      // （与本体 subModePanel.mjs _updateTriggerBar 同口径：用户要看「当前子模式绑定的 api 的模型」。）
      var _smModel = active
        ? ((active.model_params && typeof active.model_params === "object" && active.model_params.model)
            ? active.model_params.model
            : (active.modelName || ""))
        : "";
      var currentModel = _smModel;
      if (!currentModel) {
        try {
          var modelInput = document.getElementById("paramModel");
          if (modelInput) currentModel = modelInput.value || "";
        } catch (_) {}
      }
      var apiText = currentModel ? "模型: " + currentModel : "模型: 默认";
      dom.activeApiLabel.textContent = apiText;
      dom.activeApiLabel.title = currentModel ? (_smModel ? "子模式绑定模型: " + currentModel : "源当前模型: " + currentModel) : "默认模型";
    }
    // ★ 追加：API 源标签（优先取当前子模式 apiSource，回退运行态 activeApiSource）
    if (dom.activeApiSourceLabel) {
      var curSource = (active && active.apiSource) || state.activeApiSource || "";
      dom.activeApiSourceLabel.textContent = curSource ? "源: " + curSource : "源: 默认";
      dom.activeApiSourceLabel.title = curSource || "默认 API 源";
    }
  }

  // ═══════════════════════════════════════════════════════
  // API 源列表（保留后台用，不在底部栏展示）
  // ═══════════════════════════════════════════════════════

  function fetchApiSourceList() {
    vscode.postMessage({ type: "getApiSourceList" });
  }

  // ★ 单一权威写回：把字段写回当前 activeSubMode（yonman_config sub_modes[]），
  //   并 postMessage saveSubModes 局部更新。选择器只是子模式字段的快捷编辑视图，
  //   不另起第二份状态（§三 不变式1 单一权威）。
  function _writeBackToActiveSubMode(fields) {
    var modes = state.subModes && state.subModes.length > 0 ? state.subModes : null;
    if (!modes) return false;
    var sm = modes.find(function (m) { return m.id === state.activeSubMode; });
    if (!sm) return false;
    for (var k in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
      if (k === "model") {
        // model_params 副本为权威（B18）：写回 model_params.model
        if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
        sm.model_params.model = fields.model;
      } else {
        sm[k] = fields[k];
      }
    }
    state.subModes = modes;
    YB.cacheSubModes(modes); // T010：本地保存同步刷新缓存
    vscode.postMessage({ type: "saveSubModes", payload: { subModes: modes } });
    return true;
  }

  function onApiSourceList(payload) {
    var list = (payload && payload.list) || [];
    state.apiSources = list;
    // 渲染底部栏 API 源弹层（#apiSourceList）
    renderApiSourcePopupList(list);
    // 同时获取模型列表用于底部栏模型弹层
    // ★ 修复（对齐本体 subModePanel._renderPopupModelList 用 mode.apiSource）：模型列表必须按
    //   「当前子模式绑定的源」拉，而非 state.activeApiSource||list[0]——否则 activeApiSource 未同步时
    //   回退 list[0]（源列表第一个，可能是别的源）→ 显示错源的模型（如官方克子模式却列出 deepseek）。
    //   优先级：当前子模式 apiSource → 运行态 activeApiSource → list[0]。与源标签 updateSelectorLabels 同口径。
    if (list.length > 0) {
      var _modes = subModesOrCache();
      var _active = _modes.find(function (m) { return m.id === state.activeSubMode; });
      if (!_active && Array.isArray(state.allSubModes)) {
        _active = state.allSubModes.find(function (m) { return m.id === state.activeSubMode; });
      }
      var _src = (_active && _active.apiSource) || state.activeApiSource || list[0];
      vscode.postMessage({ type: "getModelList", payload: { sourceName: _src } });
    }
    updateSelectorLabels();
  }

  /** 渲染底部栏弹出层 — API 源列表，选中写回当前子模式 apiSource + 重拉该源模型 */
  function renderApiSourcePopupList(list) {
    var container = dom.apiSourceList;
    if (!container) return;
    container.innerHTML = "";

    var sources = list || state.apiSources || [];
    if (sources.length === 0) {
      var hint = document.createElement("div");
      hint.style.cssText = "font-size:12px;opacity:0.6;padding:8px;text-align:center;";
      hint.textContent = "暂无 API 源，请先配置";
      container.appendChild(hint);
      return;
    }

    for (var i = 0; i < sources.length; i++) {
      var srcName = typeof sources[i] === "string" ? sources[i] : (sources[i].name || sources[i].id || "");
      if (!srcName) continue;
      var btn = document.createElement("button");
      btn.className = "submode-btn" + (srcName === state.activeApiSource ? " active" : "");
      btn.textContent = srcName;
      (function (name) {
        btn.addEventListener("click", function () {
          // 1) 写回当前子模式 apiSource（单一权威）
          _writeBackToActiveSubMode({ apiSource: name });
          // 2) 切换运行态 API 源（既有链路）
          switchApiSource(name);
          // 3) 重拉该源模型列表（onModelList → renderApiPopupList）
          vscode.postMessage({ type: "getModelList", payload: { sourceName: name } });
          updateSelectorLabels();
          closePopup();
          showToast("API 源已切换: " + name, 2000);
        });
      })(srcName);
      container.appendChild(btn);
    }
  }

  function onApiSourceSwitched(payload) {
    if (payload && payload.success) {
      state.activeApiSource = payload.sourceName || "";
      updateSelectorLabels();
      fetchTokenSnapshot();
    } else {
      // 0714 吞错扫尾：失败原完全静默（对照同文件 onModelList 的 error 分支）——用户点了切源以为成功
      console.warn("[chat-modes] API 源切换失败:", (payload && payload.error) || "(后端未给原因)");
      showToast("⚠ API 源切换失败" + ((payload && payload.error) ? ": " + payload.error : ""), 3000);
    }
  }

  function onModelList(payload) {
    if (payload && payload.error) {
      console.warn("[chat-modes] 获取模型列表失败:", payload.error);
      showToast("⚠ 模型列表加载失败", 2000);
      return;
    }
    var models = payload.models || payload.list || [];
    state._modelList = models;
    renderApiPopupList(models);
    updateSelectorLabels();
  }

  /** 渲染底部栏弹出层 — 模型列表（API绑定在子模式设置中） */
  function renderApiPopupList(list) {
    var container = dom.apiList;
    if (!container) return;
    container.innerHTML = "";

    // 标题说明
    var title = document.createElement("div");
    title.style.cssText = "font-size:11px;opacity:0.5;padding:4px 8px;";
    title.textContent = "切换模型（API源绑定在子模式设置中）";
    container.appendChild(title);

    // 模型列表
    var modelList = state._modelList || [];
    if (modelList.length === 0) {
      var hint = document.createElement("div");
      hint.style.cssText = "font-size:12px;opacity:0.6;padding:8px;text-align:center;";
      hint.textContent = "暂无模型列表，请先配置API源";
      container.appendChild(hint);
      return;
    }

    for (var i = 0; i < modelList.length; i++) {
      var btn = document.createElement("button");
      var modelId = typeof modelList[i] === "string" ? modelList[i] : (modelList[i].id || modelList[i].name || "");
      btn.className = "submode-btn";
      btn.textContent = modelId;
      (function (name) {
        btn.addEventListener("click", function () {
          vscode.postMessage({ type: "switchModel", payload: { modelName: name } });
          // 写回当前子模式 modelName + model_params.model（单一权威，B18 副本为权威）
          _writeBackToActiveSubMode({ modelName: name, model: name });
          // 更新本地显示
          var modelInput = document.getElementById("paramModel");
          if (modelInput) modelInput.value = name;
          updateSelectorLabels();
          closePopup();
          showToast("模型已切换: " + name, 2000);
        });
      })(modelId);
      container.appendChild(btn);
    }
  }

  function switchApiSource(sourceName) {
    state.activeApiSource = sourceName;
    updateSelectorLabels();

    if (!sourceName) return;
    var charNames = state.charlist || [];
    if (charNames.length === 0 && state.selectedChar) {
      charNames = [state.selectedChar];
    }
    if (charNames.length > 0) {
      vscode.postMessage({
        type: "switchApiSource",
        payload: { sourceName: sourceName, charNames: charNames },
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // Token 设置悬浮窗
  // ═══════════════════════════════════════════════════════

  /** 加载 Token 设置到悬浮窗 */
  function loadTokenSettings() {
    var dom = YB.dom;
    // 链路2：min/step/placeholder 从 param_schema 覆盖（HTML 静态值仅离线退化）
    var _tps = state.paramSchema || {};
    if (dom.fpMaxContext && _tps.max_context) {
      if (_tps.max_context.min != null) dom.fpMaxContext.min = String(_tps.max_context.min);
      if (_tps.max_context.step != null) dom.fpMaxContext.step = String(_tps.max_context.step);
      if (_tps.max_context.default != null) dom.fpMaxContext.placeholder = String(_tps.max_context.default);
    }
    if (dom.fpMaxTokens && _tps.max_tokens) {
      if (_tps.max_tokens.min != null) dom.fpMaxTokens.min = String(_tps.max_tokens.min);
      if (_tps.max_tokens.step != null) dom.fpMaxTokens.step = String(_tps.max_tokens.step);
      if (_tps.max_tokens.default != null) dom.fpMaxTokens.placeholder = String(_tps.max_tokens.default);
    }
    if (dom.fpMaxContext && state.tokenTotal) {
      dom.fpMaxContext.value = state.tokenTotal;
    }
    // localStorage 只保留 maxTokens 本地便利值；阈值由后端异步回填。
    try {
      var saved = JSON.parse(localStorage.getItem("yb-token-settings") || "{}");
      if (dom.fpMaxTokens && saved.maxTokens) dom.fpMaxTokens.value = saved.maxTokens;
    } catch (_) { /* ignore */ }
    vscode.postMessage({ type: "getTokenReminder" });
  }

  /** 后端生效 Token 提醒配置回填；保留 thresholds 整体，写回时只改指定 level 的 percent。 */
  function onTokenReminderConfig(tr) {
    var dom = YB.dom;
    if (!tr || !Array.isArray(tr.thresholds)) return;
    state._tokenReminderThresholds = tr.thresholds;
    for (var i = 0; i < tr.thresholds.length; i++) {
      var t = tr.thresholds[i] || {};
      if (t.level === "warning" && Number.isFinite(Number(t.percent))) state._warnPct = Number(t.percent);
      if (t.level === "urgent" && Number.isFinite(Number(t.percent))) state._dangerPct = Number(t.percent);
    }
    if (dom.fpWarnPct && Number.isFinite(state._warnPct)) dom.fpWarnPct.value = String(state._warnPct);
    if (dom.fpDangerPct && Number.isFinite(state._dangerPct)) dom.fpDangerPct.value = String(state._dangerPct);
  }

  /** 保存 Token 设置 */
  function saveTokenSettings() {
    var dom = YB.dom;
    var maxCtx = dom.fpMaxContext ? parseInt(dom.fpMaxContext.value, 10) : 0;
    var maxTok = dom.fpMaxTokens ? parseInt(dom.fpMaxTokens.value, 10) : 0;
    var warnPct = dom.fpWarnPct ? parseInt(dom.fpWarnPct.value, 10) : NaN;
    var dangerPct = dom.fpDangerPct ? parseInt(dom.fpDangerPct.value, 10) : NaN;

    // 本地只保存 maxTokens；warning/urgent 不建第二份状态。
    try {
      localStorage.setItem("yb-token-settings", JSON.stringify({ maxTokens: maxTok || undefined }));
    } catch (_) { /* ignore */ }

    // 保存 maxContext/maxTokens 到后端
    var params = {};
    if (maxCtx > 0) params.openai_max_context = maxCtx;
    if (maxTok > 0) params.openai_max_tokens = maxTok;
    if (Object.keys(params).length > 0) {
      if (state.currentChatId) params.chatId = state.currentChatId;
      vscode.postMessage({ type: "setRuntimeParams", payload: params });
    }

    // 克隆后端返回数组，只修改 warning/urgent percent，text 等旁字段不丢失。
    if (Number.isFinite(warnPct) && Number.isFinite(dangerPct) && Array.isArray(state._tokenReminderThresholds)) {
      var nextThresholds = state._tokenReminderThresholds.map(function (t) {
        var copy = {};
        for (var key in t) { if (Object.prototype.hasOwnProperty.call(t, key)) copy[key] = t[key]; }
        if (copy.level === "warning") copy.percent = Math.min(Math.max(warnPct, 0), 100);
        if (copy.level === "urgent") copy.percent = Math.min(Math.max(dangerPct, 0), 100);
        return copy;
      });
      state._tokenReminderThresholds = nextThresholds;
      state._warnPct = warnPct;
      state._dangerPct = dangerPct;
      vscode.postMessage({ type: "updateTokenReminder", payload: { thresholds: nextThresholds } });
    }

    if (dom.fpStatus) {
      dom.fpStatus.textContent = "已保存";
      setTimeout(function () { if (dom.fpStatus) dom.fpStatus.textContent = ""; }, 2000);
    }

    showToast("Token 设置已保存", 1500);
    YB.closeAllFloatingPopups();
    fetchTokenSnapshot();
  }

  // ═══════════════════════════════════════════════════════
  // IDE 审批悬浮窗
  // ═══════════════════════════════════════════════════════

  function onIdeApprovals(payload) {
    var dom = YB.dom;
    var list = dom.ideApprovalsList;
    if (!list) return;

    if (payload && payload.error) {
      list.innerHTML = '<div style="color:var(--vscode-errorForeground);padding:8px;font-size:11px;">✗ ' + payload.error + '</div>';
      return;
    }

    var approvals = (payload && payload.pendingApprovals) || [];
    if (approvals.length === 0) {
      list.innerHTML = '<div style="color:var(--vscode-descriptionForeground);text-align:center;padding:12px;font-size:11px;">没有待审批的操作</div>';
      return;
    }

    list.innerHTML = "";
    var _esc = YB.escapeHtml; // 转义单源收口 2026-07-13：chat-core 必先加载，本地劣化 fallback（缺 单引号 转义）已删

    // ★ F6 内联审批卡（KILO approval-box 形态）：操作类型 + 目标对象（文件显绝对路径、工作区外强提示不截断）
    //   选项集：[批准][拒绝][全部允许][全部跳过][此类不再问]（aider 选项集；前两个 per-op，后三个队列级/规则级）
    var _wrap = document.createElement("div");
    _wrap.className = "approval-cards";
    var _wrapHtml = '<div class="approval-batch-bar">' +
      '<span class="approval-batch-count">' + approvals.length + ' \u9879\u5F85\u5BA1\u6279</span>' +
      '<button class="approval-batch-btn approval-allow-all" title="\u5168\u90E8\u5141\u8BB8\uFF08\u6267\u884C\u5F53\u524D\u961F\u5217\u5168\u90E8\uFF09">\u2713 \u5168\u90E8\u5141\u8BB8</button>' +
      '<button class="approval-batch-btn approval-skip-all" title="\u5168\u90E8\u8DF3\u8FC7\uFF08\u62D2\u6267\u884C\u5F53\u524D\u961F\u5217\u5168\u90E8\uFF09">\u2715 \u5168\u90E8\u8DF3\u8FC7</button>' +
      '</div>';
    _wrap.innerHTML = _wrapHtml;

    for (var i = 0; i < approvals.length; i++) {
      var op = approvals[i];
      var card = document.createElement("div");
      card.className = "approval-card" + (op.outsideWorkspace ? " approval-card-outside" : "");
      // 目标对象：文件优先显后端解析的绝对路径(absPath)，无则相对 path，再无则命令；工作区外不截断 + 强提示
      var _target = op.absPath || (op.params && op.params.path) || op.path || (op.params && op.params.command) || op.command || "";
      var _isCmd = (op.tool === "run_command");
      var _outsideBadge = op.outsideWorkspace
        ? '<span class="approval-outside-flag" title="\u76EE\u6807\u5728\u5DE5\u4F5C\u533A\u5916\uFF0C\u8BF7\u8C28\u614E">\u26A0 \u5DE5\u4F5C\u533A\u5916</span>'
        : "";
      var _forceBadge = op._forceApproval
        ? '<span class="approval-force-flag" title="\u5371\u9669/\u4E0D\u53EF\u9006\u64CD\u4F5C\uFF0C\u5F3A\u5236\u5BA1\u6279">\u26A1 \u5371\u9669</span>'
        : "";
      // ★ Diff渲染——复用统一 LCS 渲染器 _renderDiffHtml（系统性重复收口 2026-07-13：
      //   原本地"旧全标删+新全标增"糙版与改动历史/工具卡的真 diff 质量不齐，同文件已有权威实现）
      var diffHtml = "";
      if (op.params && (op.params.old_string || op.params.new_string)) {
        diffHtml = '<div class="approval-diff" style="display:none;">' +
          _renderDiffHtml(op.params.old_string || "", op.params.new_string || "") +
          '</div>';
      }
      card.dataset.opId = op.id;
      card.innerHTML =
        '<div class="approval-card-head">' +
          '<span class="approval-tool-badge">' + _esc(op.tool || "?") + '</span>' +
          _forceBadge + _outsideBadge +
        '</div>' +
        '<div class="approval-card-target' + (_isCmd ? " is-cmd" : "") + '" title="' + _esc(_target) + '">' + _esc(_target) + '</div>' +
        (diffHtml ? '<div class="approval-diff-toggle">\u{1F4DD} \u67E5\u770B\u6539\u52A8</div>' + diffHtml : '') +
        '<div class="approval-card-actions">' +
          '<button class="approval-btn approval-btn-approve" data-op-id="' + _esc(op.id) + '">\u2713 \u6279\u51C6</button>' +
          '<button class="approval-btn approval-btn-reject" data-op-id="' + _esc(op.id) + '">\u2715 \u62D2\u7EDD</button>' +
          '<button class="approval-btn approval-btn-skiprule" data-op-id="' + _esc(op.id) + '" title="\u4EE5\u540E\u8FD9\u7C7B\u64CD\u4F5C\uFF08\u540C\u7C7B\u578B+\u8DEF\u5F84\u524D\u7F00\uFF09\u4E0D\u518D\u8BE2\u95EE">\u{1F507} \u6B64\u7C7B\u4E0D\u518D\u95EE</button>' +
        '</div>';
      _wrap.appendChild(card);
    }
    list.appendChild(_wrap);

    // ★ Diff折叠切换
    list.querySelectorAll(".approval-diff-toggle").forEach(function(toggle) {
      toggle.addEventListener("click", function() {
        var diff = this.nextElementSibling;
        if (diff) diff.style.display = (diff.style.display === "none" || !diff.style.display) ? "block" : "none";
      });
    });

    // 单项：批准 / 拒绝 / 此类不再问
    list.querySelectorAll(".approval-btn-approve").forEach(function (btn) {
      btn.addEventListener("click", function () {
        vscode.postMessage({ type: "approveIdeOp", payload: { opId: btn.dataset.opId } });
        var c = btn.closest(".approval-card"); if (c) c.remove();
      });
    });
    list.querySelectorAll(".approval-btn-reject").forEach(function (btn) {
      btn.addEventListener("click", function () {
        vscode.postMessage({ type: "rejectIdeOp", payload: { opId: btn.dataset.opId } });
        var c = btn.closest(".approval-card"); if (c) c.remove();
      });
    });
    list.querySelectorAll(".approval-btn-skiprule").forEach(function (btn) {
      btn.addEventListener("click", function () {
        vscode.postMessage({ type: "addApprovalSkipRule", payload: { opId: btn.dataset.opId } });
        var c = btn.closest(".approval-card"); if (c) c.remove();
        showToast("\u{1F507} \u5DF2\u8BB0\u4F4F\uFF1A\u6B64\u7C7B\u64CD\u4F5C\u4E0D\u518D\u8BE2\u95EE", 2000);
      });
    });

    // 队列级：全部允许 / 全部跳过
    var _allowAll = list.querySelector(".approval-allow-all");
    if (_allowAll) _allowAll.addEventListener("click", function () {
      vscode.postMessage({ type: "approveAllIdeOps" });
      showToast("\u23F3 \u6B63\u5728\u5168\u90E8\u5141\u8BB8\u2026", 2000);
    });
    var _skipAll = list.querySelector(".approval-skip-all");
    if (_skipAll) _skipAll.addEventListener("click", function () {
      vscode.postMessage({ type: "rejectAllIdeOps" });
      showToast("\u23F3 \u6B63\u5728\u5168\u90E8\u8DF3\u8FC7\u2026", 2000);
    });
  }

  function onIdeApprovalResult(payload) {
    if (payload && !payload.success) {
      showToast("✗ 审批操作失败: " + (payload.error || ""), 3000);
    } else if (payload && payload.success) {
      showToast("✓ 操作已执行", 1500);
    }
    // 重新获取列表
    vscode.postMessage({ type: "getIdeApprovals" });
  }

  // ★ Cache token统计
  var _lastCacheUsage = null;
  function onTokenUsage(payload) {
    _lastCacheUsage = payload;
    // 立即刷新token bar显示
    if (state.tokenUsed != null && state.tokenTotal != null) {
      _updateTokenBarWithCache(state.tokenUsed, state.tokenTotal);
    }
    var cr = (payload && payload.cache_read_input_tokens) || 0;
    var cw = (payload && payload.cache_creation_input_tokens) || 0;
    if (cr > 0 || cw > 0) {
      console.log("[chat-modes] 缓存统计: 命中=" + cr + ", 创建=" + cw);
    }
  }

  function _updateTokenBarWithCache(used, total) {
    if (!dom.tokenBarLabel) return;
    var usedK = used >= 1000 ? (used / 1000).toFixed(1) + "K" : String(used);
    var totalK = total >= 1000 ? (total / 1000).toFixed(0) + "K" : String(total);
    if (_lastCacheUsage && _lastCacheUsage.cache_read_input_tokens > 0) {
      var cr = _lastCacheUsage.cache_read_input_tokens;
      var inp = _lastCacheUsage.input_tokens;
      var hitRate = (inp + cr) > 0 ? Math.round(cr / (inp + cr) * 100) : 0;
      dom.tokenBarLabel.textContent = usedK + " / " + totalK + " (缓存" + hitRate + "%)";
    } else {
      dom.tokenBarLabel.textContent = usedK + " / " + totalK;
    }
    // tooltip
    if (dom.tokenBar && _lastCacheUsage) {
      var cr2 = _lastCacheUsage.cache_read_input_tokens || 0;
      var cw2 = _lastCacheUsage.cache_creation_input_tokens || 0;
      var inp2 = _lastCacheUsage.input_tokens || 0;
      var out2 = _lastCacheUsage.output_tokens || 0;
      var lines = ["Token: " + usedK + " / " + totalK];
      lines.push("输入: " + inp2 + " (新增)");
      lines.push("输出: " + out2);
      if (cr2 > 0) lines.push("缓存命中: " + cr2 + " (0.1x)");
      if (cw2 > 0) lines.push("缓存创建: " + cw2 + " (1.25x)");
      dom.tokenBar.title = lines.join("\n");
    }
  }

  // ═══════════════════════════════════════════════════════
  // Skill 组流水线 + 检查点回档（壳层 UI，后端 action 全在本体）
  // 链路：用户点面板按钮 → vscode.postMessage(listFlowGroups/startFlowGroup/listCheckpoints/...)
  //       → Extension → 后端 skill group 管线 → 回推结果 → 本区渲染
  // ═══════════════════════════════════════════════════════
  var _skillPanelEl = null, _skillOv = null;
  var _ckptPanelEl = null;
  // P3/Y4: 待确认回档的检查点 id（点↩回档→先出 diff 预览卡+确认条，非纯文字二次点击）
  var _pendingRevertId = null;
  // 转义单源收口 2026-07-13：原本地 map 法与 chat-core escapeHtml 重复（后者已升级同款 5 字符），改引单源。
  // var 而非 function：本文件顶层同步路径不触达 _esc（首个调用点在异步回包渲染），无提升依赖。
  var _esc = YB.escapeHtml;
  function _modalShell(title) {
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;";
    var p = document.createElement("div");
    p.style.cssText = "background:var(--vscode-editor-background,#1e1e2e);border-radius:12px;padding:18px;max-width:480px;width:92%;box-shadow:0 8px 32px rgba(0,0,0,0.4);color:var(--vscode-foreground,#ccc);max-height:82vh;overflow-y:auto;";
    p.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h3 style="margin:0;font-size:15px;">' + title + '</h3><button class="yb-modal-x" style="border:none;background:none;color:inherit;cursor:pointer;font-size:16px;opacity:0.6;">✕</button></div><div class="yb-modal-body"><p style="opacity:0.5;font-size:12px;">加载中…</p></div>';
    ov.appendChild(p);
    document.body.appendChild(ov);
    p.querySelector(".yb-modal-x").addEventListener("click", function() { ov.remove(); });
    ov.addEventListener("click", function(e) { if (e.target === ov) ov.remove(); });
    return { ov: ov, body: p.querySelector(".yb-modal-body") };
  }

  // skill 组：列出 + 启动
  function showSkillGroupPanel() {
    var m = _modalShell("🗂️ skill 组流水线");
    _skillPanelEl = m.body;
    _skillOv = m.ov;
    vscode.postMessage({ type: "listFlowGroups" });
  }
  function onFlowGroupList(payload) {
    // 缓存 skill 组列表（供子模式面板 skill 组栏使用）
    if (payload && payload.success !== false && Array.isArray(payload.groups)) {
      _cachedGroups = payload.groups;
      renderSkillGroupBar();
    }
    if (!_skillPanelEl) return;
    if (payload && payload.success === false) {
      _skillPanelEl.innerHTML = '<p style="color:var(--vscode-errorForeground);font-size:12px;">skill组加载失败：' + _esc(payload.error || "未知错误") + '</p>';
      return;
    }
    var groups = (payload && payload.groups) || [];
    var html = "";
    groups.forEach(function(g) {
      var steps = (g.steps || []).map(function(s) { return _esc((s.icon || "") + s.label); }).join(" → ");
      var tag = g.builtin
        ? '<span title="内置组，不可删除" style="opacity:0.6;">🔒</span>'
        : '<button class="yb-skill-del" data-fn="' + _esc(g.filename) + '" data-nm="' + _esc(g.name) + '" title="删除自建组" style="border:none;background:none;color:var(--vscode-errorForeground);cursor:pointer;font-size:13px;">✕</button>';
      html += '<div style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px;margin-bottom:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<div style="font-weight:600;font-size:13px;">🗂️ ' + _esc(g.name) + ' <span style="opacity:0.5;font-weight:400;">(' + (g.stepCount || 0) + '步)</span></div>' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            '<button class="yb-skill-rename" data-fn="' + _esc(g.filename) + '" data-nm="' + _esc(g.name) + '" title="重命名" style="border:none;background:none;color:inherit;cursor:pointer;font-size:13px;opacity:0.6;">✏️</button>' +
            '<button class="yb-skill-start" data-fn="' + _esc(g.filename) + '" style="padding:5px 12px;border:none;border-radius:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-size:12px;font-weight:600;">▶启动</button>' +
            tag +
          '</div>' +
        '</div>' +
        '<div style="font-size:11px;opacity:0.55;margin-top:5px;">' + _esc(g.description || "") + '</div>' +
        (steps ? '<div style="font-size:11px;opacity:0.4;margin-top:5px;">' + steps + '</div>' : "") +
      '</div>';
    });
    html += '<button id="yb-skill-new" style="width:100%;padding:8px;border:1px dashed rgba(255,255,255,0.2);border-radius:8px;background:none;color:inherit;cursor:pointer;font-size:12px;">➕ 新建组</button>';
    _skillPanelEl.innerHTML = html;
    var btns = _skillPanelEl.querySelectorAll(".yb-skill-start");
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", function() {
      vscode.postMessage({ type: "startFlowGroup", payload: { filename: this.getAttribute("data-fn") } });
    });
    var dels = _skillPanelEl.querySelectorAll(".yb-skill-del");
    for (var j = 0; j < dels.length; j++) dels[j].addEventListener("click", function() {
      var fn = this.getAttribute("data-fn");
      var nm = this.getAttribute("data-nm");
      var btn = this;
      if (btn._delPending) { vscode.postMessage({ type: "deleteFlowGroup", payload: { filename: fn } }); btn._delPending = false; btn.textContent = "✕"; return; }
      btn._delPending = true; btn.textContent = "确认?"; btn.style.color = "var(--vscode-errorForeground)";
      setTimeout(function() { btn._delPending = false; btn.textContent = "✕"; btn.style.color = ""; }, 3000);
    });
    var renames = _skillPanelEl.querySelectorAll(".yb-skill-rename");
    for (var k = 0; k < renames.length; k++) renames[k].addEventListener("click", function() {
      var oldNm = this.getAttribute("data-nm");
      var fn = this.getAttribute("data-fn");
      YB.showInputDialog("重命名 Skill 组", oldNm, function(newNm) {
        if (!newNm || newNm.trim() === oldNm) return;
        vscode.postMessage({ type: "updateFlowGroup", payload: { filename: fn, update: { name: newNm.trim() } } });
      });
    });
    var nb = document.getElementById("yb-skill-new");
    if (nb) nb.addEventListener("click", _renderSkillCreateForm);
  }
  // 新建组表单：勾选 code 子模式（步骤顺序=列表自上而下）+ 组名 → saveFlowGroup
  function _renderSkillCreateForm() {
    if (!_skillPanelEl) return;
    var modes = subModesOrCache();
    var opts = modes.map(function(m) {
      return '<label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 0;">' +
        '<input type="checkbox" class="yb-sk-cb" data-mode="' + _esc(m.id) + '" data-preset="' + _esc(m.presetName || "") + '" data-label="' + _esc(m.label || m.id) + '" data-icon="' + _esc(m.icon || "") + '"/> ' +
        _esc((m.icon || "") + (m.label || m.id)) + '</label>';
    }).join("");
    _skillPanelEl.innerHTML =
      '<input id="yb-sk-name" placeholder="组名（如：我的流程）" style="width:100%;padding:7px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;box-sizing:border-box;" />' +
      '<div style="font-size:11px;opacity:0.6;margin-bottom:6px;">勾选子模式（步骤顺序=下表自上而下）：</div>' +
      '<div style="max-height:40vh;overflow-y:auto;margin-bottom:8px;">' + (opts || '<div style="opacity:0.5;font-size:12px;">无可用子模式</div>') + '</div>' +
      '<div style="display:flex;gap:8px;"><button id="yb-sk-save" style="flex:1;padding:8px;border:none;border-radius:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-weight:600;">保存</button>' +
      '<button id="yb-sk-cancel" style="padding:8px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;">返回</button></div>';
    document.getElementById("yb-sk-cancel").addEventListener("click", function() { vscode.postMessage({ type: "listFlowGroups" }); });
    document.getElementById("yb-sk-save").addEventListener("click", function() {
      var name = document.getElementById("yb-sk-name").value.trim();
      if (!name) { showToast("组名不能为空", 2000); return; }
      var cbs = _skillPanelEl.querySelectorAll(".yb-sk-cb"), steps = [];
      for (var i = 0; i < cbs.length; i++) if (cbs[i].checked) steps.push({
        mode: cbs[i].getAttribute("data-mode"), preset_name: cbs[i].getAttribute("data-preset"),
        label: cbs[i].getAttribute("data-label"), icon: cbs[i].getAttribute("data-icon")
      });
      if (!steps.length) { showToast("需至少选择一个子模式", 2000); return; }
      var modeGroup = steps.length > 0 && steps[0].modeGroup ? steps[0].modeGroup : DEFAULT_MODE;
      vscode.postMessage({ type: "saveFlowGroup", payload: { name: name, steps: steps, auto_advance: true, modeGroup: modeGroup } });
    });
  }
  function onFlowGroupChanged(payload) {
    if (payload && payload.success) {
      var _opMsg = payload.op === "delete" ? "✓ 已删除" : payload.op === "update" ? "✓ 已更新" : "✓ 已新建「" + (payload.name || "") + "」";
      showToast(_opMsg, 2000);
      if (_skillPanelEl) vscode.postMessage({ type: "listFlowGroups" }); // 刷新列表
    } else {
      showToast("✗ " + (payload && payload.op === "delete" ? "删除" : "保存") + "失败：" + ((payload && payload.error) || "未知错误"), 3000);
    }
  }
  function onFlowGroupStarted(payload) {
    if (payload && payload.success) {
      showToast("✓ 已启动「" + (payload.name || "") + "」流水线（" + (payload.totalSteps || 0) + "步）", 3000);
      if (typeof renderSubModeBar === "function") renderSubModeBar();
      if (typeof renderSubModePanel === "function") renderSubModePanel();
      if (_skillOv) { _skillOv.remove(); _skillOv = null; }
      _skillPanelEl = null;
    } else {
      showToast("✗ 启动失败：" + ((payload && payload.error) || "未知错误"), 3000);
    }
  }

  // checkpoint：列表 + 逐行 diff + 单点回档
  function showCheckpointPanel() {
    var m = _modalShell("📍 检查点回档");
    _ckptPanelEl = m.body;
    _pendingRevertId = null;
    vscode.postMessage({ type: "listCheckpoints" });
  }
  function onCheckpointList(payload) {
    if (!_ckptPanelEl) return;
    if (payload && payload.success === false) {
      _ckptPanelEl.innerHTML = '<p style="color:var(--vscode-errorForeground);font-size:12px;">检查点加载失败：' + _esc(payload.error || "未知错误") + '</p>';
      return;
    }
    var cps = ((payload && payload.checkpoints) || []).slice().reverse();
    if (!cps.length) { _ckptPanelEl.innerHTML = '<p style="opacity:0.5;font-size:12px;">无检查点（或 IDE 未连接）</p>'; return; }
    var html = '<div id="yb-ckpt-list">';
    cps.forEach(function(cp) {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:6px;border-bottom:1px solid rgba(255,255,255,0.08);">' +
        '<span class="yb-ckpt-row" data-id="' + _esc(cp.id) + '" style="flex:1;cursor:pointer;font-size:12px;word-break:break-all;" title="查看逐行 diff">🗂️ ' + _esc(cp.id) + ' <span style="opacity:0.4;">(' + (cp.fileCount || 0) + '文件)</span></span>' +
        '<button class="yb-ckpt-revert" data-id="' + _esc(cp.id) + '" style="padding:4px 8px;border:1px solid rgba(255,80,80,0.4);border-radius:5px;background:none;color:var(--vscode-errorForeground);cursor:pointer;font-size:11px;">↩回档</button>' +
      '</div>';
    });
    html += '</div><div id="yb-ckpt-diff" style="margin-top:10px;font-family:monospace;font-size:11px;"></div>';
    _ckptPanelEl.innerHTML = html;
    var rows = _ckptPanelEl.querySelectorAll(".yb-ckpt-row");
    for (var i = 0; i < rows.length; i++) rows[i].addEventListener("click", function() {
      _pendingRevertId = null; // 仅查看 diff，不进确认流
      var d = document.getElementById("yb-ckpt-diff"); if (d) d.innerHTML = '<p style="opacity:0.5;">加载 diff…</p>';
      vscode.postMessage({ type: "getCheckpointFileDiff", payload: { id: this.getAttribute("data-id") } });
    });
    var rbs = _ckptPanelEl.querySelectorAll(".yb-ckpt-revert");
    for (var j = 0; j < rbs.length; j++) rbs[j].addEventListener("click", function() {
      // P3/Y4: 回档确认流=先拉该检查点彩色逐行 diff，diff 顶部出确认条（onCheckpointDiff 渲染）
      _pendingRevertId = this.getAttribute("data-id");
      var d = document.getElementById("yb-ckpt-diff"); if (d) d.innerHTML = '<p style="opacity:0.5;">加载回档预览…</p>';
      vscode.postMessage({ type: "getCheckpointFileDiff", payload: { id: _pendingRevertId } });
    });
  }
  function onCheckpointDiff(payload) {
    var d = document.getElementById("yb-ckpt-diff");
    if (!d) return;
    if (!payload || payload.success === false) { _pendingRevertId = null; d.innerHTML = '<p style="color:var(--vscode-errorForeground);">' + _esc((payload && payload.error) || "取 diff 失败") + '</p>'; return; }
    var files = payload.files || [];
    var _confirming = !!(payload.id && payload.id === _pendingRevertId);
    if (!files.length && !_confirming) { d.innerHTML = '<p style="opacity:0.5;">该检查点无文件变更</p>'; return; }
    var html = "";
    files.forEach(function(f) {
      var badge = f.author === "human" ? ' <span style="color:var(--vscode-charts-orange, #f59e0b);">[人/外部改]</span>' : ' <span style="color:var(--vscode-charts-blue, #60a5fa);">[AI]</span>';
      html += '<div style="margin-bottom:8px;"><div style="font-weight:600;opacity:0.85;">' + _esc(f.file) + badge + (f.binary ? " (二进制)" : "") + (f.deletedNow ? " (已删除)" : "") + '</div>';
      if (!f.binary) (f.hunks || []).forEach(function(h) {
        var col = h.type === "del" ? "var(--vscode-errorForeground);background:rgba(255,80,80,0.08)" : h.type === "add" ? "var(--vscode-charts-green, #8f8);background:rgba(80,255,80,0.08)" : "inherit";
        var pre = h.type === "del" ? "−" : h.type === "add" ? "+" : " ";
        html += '<div style="color:' + col + ';white-space:pre-wrap;">' + pre + _esc(h.content) + '</div>';
      });
      html += '</div>';
    });
    // P3/Y4: 确认流——diff 顶部出确认条（红删绿增看完再点确认，替代纯文字二次点击）
    if (_confirming) {
      var _fileCount = files.length;
      html =
        '<div id="yb-ckpt-confirm" style="position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:8px;border:1px solid rgba(255,80,80,0.5);border-radius:6px;background:var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.12));">' +
          '<span style="flex:1;font-size:12px;">⚠ 回档将按上述 diff 还原 ' + _fileCount + ' 个文件（不可逆，仅文件层，不动对话/表格）</span>' +
          '<button id="yb-ckpt-confirm-yes" style="padding:4px 10px;border:none;border-radius:5px;background:var(--vscode-errorForeground,#f44);color:#fff;cursor:pointer;font-size:11px;font-weight:600;">↩ 确认回档</button>' +
          '<button id="yb-ckpt-confirm-no" style="padding:4px 10px;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:none;color:inherit;cursor:pointer;font-size:11px;">取消</button>' +
        '</div>' +
        (files.length ? html : '<p style="opacity:0.5;">该检查点无文件变更（回档将不产生改动）</p>');
    }
    d.innerHTML = html;
    if (_confirming) {
      var _yes = document.getElementById("yb-ckpt-confirm-yes");
      var _no = document.getElementById("yb-ckpt-confirm-no");
      if (_yes) _yes.addEventListener("click", function() {
        var id = _pendingRevertId; _pendingRevertId = null;
        if (id) vscode.postMessage({ type: "revertCheckpoint", payload: { id: id } });
        var bar = document.getElementById("yb-ckpt-confirm"); if (bar) bar.remove();
      });
      if (_no) _no.addEventListener("click", function() {
        _pendingRevertId = null;
        var bar = document.getElementById("yb-ckpt-confirm"); if (bar) bar.remove();
      });
    }
  }
  function onCheckpointReverted(payload) {
    if (payload && payload.success) {
      showToast("✓ 已回档：还原 " + (payload.restored || 0) + " 个、删除 " + (payload.deleted || 0) + " 个", 3000);
      if (_ckptPanelEl) vscode.postMessage({ type: "listCheckpoints" }); // 刷新列表
    } else {
      showToast("✗ 回档失败：" + ((payload && payload.error) || "未知错误"), 3000);
    }
  }

  // ═══════════════════════════════════════════════════════
  // B3/Y6 权限档位外显（顶栏徽章：颜色+一句话；档位=本体 permission_level.json L0-L4 规则集模板）
  // 点击徽章→审批跳过规则面板（Y5）。per-子模式档位绑定缺本体 seam，缺口已登记 05B §三。
  // T011 权限档位元数据单源：本地 _PERM_LEVEL_META 副本已删（权限是安全面，双源不同步=授权误导）。
  // 元数据随 getPermissionLevel 响应 payload.levels 下发（真源=后端 storage.mjs PERM_LEVEL_META）；
  // 未下发（后端未重启窗口期）→ 纯数字 "L{n}" 回退（非语义副本，不冒充档位说明）。
  // ═══════════════════════════════════════════════════════
  function onPermissionLevel(payload) {
    var badge = dom.permBadge || document.getElementById("permBadge");
    if (!badge) return;
    if (!payload || payload.success === false) { badge.classList.add("hidden"); return; }
    var lv = Number(payload.level) || 0;
    var meta = (payload.levels || []).find(function (m) { return m.level === lv; }) ||
      { label: "L" + lv, desc: "档位说明未下发（后端未更新或重启前）", color: "var(--vscode-descriptionForeground, #888)" };
    badge.innerHTML = '<span class="perm-dot" style="background:' + meta.color + ';"></span>' + _esc(meta.label);
    badge.title = "权限档位 — " + meta.desc + "\n点击查看审批跳过规则";
    badge.classList.remove("hidden");
    if (!badge._wired) {
      badge._wired = true;
      badge.addEventListener("click", function() { showApprovalRulesPanel(); });
    }
  }

  // ═══════════════════════════════════════════════════════
  // F6/Y5 审批跳过规则管理面板（列/删；规则=「此类不再问」产生，单一权威=本体 ide_approval_rules.json）
  // ═══════════════════════════════════════════════════════
  var _apRulesPanelEl = null;

  function showApprovalRulesPanel() {
    var m = _modalShell("🛡️ 审批跳过规则");
    _apRulesPanelEl = m.body;
    _apRulesPanelEl.innerHTML = '<p style="opacity:0.5;font-size:12px;">加载中…</p>';
    vscode.postMessage({ type: "getApprovalRules" });
  }

  function onApprovalRulesList(payload) {
    if (!_apRulesPanelEl || !document.body.contains(_apRulesPanelEl)) return;
    if (!payload || payload.success === false) {
      _apRulesPanelEl.innerHTML = '<p style="color:var(--vscode-errorForeground);font-size:12px;">规则加载失败：' + _esc((payload && payload.error) || "未知错误") + '</p>';
      return;
    }
    var rules = payload.rules || [];
    if (!rules.length) {
      _apRulesPanelEl.innerHTML = '<p style="opacity:0.5;font-size:12px;">暂无规则。审批卡上点「此类不再问」即可生成（区外/危险操作不受规则影响，仍必问）。</p>';
      return;
    }
    var html = '<p style="opacity:0.55;font-size:11px;margin:0 0 6px;">命中 (工具, 路径前缀) 的同类操作免审批放行；区外/危险操作硬挡不受影响。</p>';
    rules.forEach(function(r) {
      var when = r.createdAt ? new Date(r.createdAt).toLocaleString() : "";
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;">' +
        '<span style="flex:1;word-break:break-all;">🔧 <b>' + _esc(r.tool || "") + '</b>' +
          (r.pathPrefix ? ' <span style="opacity:0.7;">· ' + _esc(r.pathPrefix) + '</span>' : ' <span style="opacity:0.4;">· 无路径限定</span>') +
          (when ? '<br><span style="opacity:0.4;font-size:10px;">' + _esc(when) + '</span>' : '') +
        '</span>' +
        '<button class="yb-aprule-del" data-tool="' + _esc(r.tool || "") + '" data-prefix="' + _esc(r.pathPrefix || "") + '" style="padding:4px 8px;border:1px solid rgba(255,80,80,0.4);border-radius:5px;background:none;color:var(--vscode-errorForeground);cursor:pointer;font-size:11px;">删除</button>' +
      '</div>';
    });
    _apRulesPanelEl.innerHTML = html;
    var dels = _apRulesPanelEl.querySelectorAll(".yb-aprule-del");
    for (var i = 0; i < dels.length; i++) dels[i].addEventListener("click", function() {
      vscode.postMessage({ type: "removeApprovalRule", payload: { tool: this.getAttribute("data-tool"), pathPrefix: this.getAttribute("data-prefix") } });
    });
  }

  // ═══════════════════════════════════════════════════════
  // F3/Y2 任务打勾卡（照抄本体 taskCard.mjs 语义：勾/改/删/加 + 剩余 N 项）
  // 数据单一权威=本体 taskStore；本端只渲染+发 action，回包/推送统一走 onTaskUpdate
  // ═══════════════════════════════════════════════════════
  // ⚠ 同键散写标注(07-09 审计):icon 值另有一份 cards.js _TASK_ICON(卡片板块 webview 无共享模块)，改图标两处同改。
  var _TASK_STATUS_META = {
    completed: { icon: "✓", cls: "task-done" },
    in_progress: { icon: "▶", cls: "task-active" },
    pending: { icon: "○", cls: "task-pending" }
  };
  // 任务卡折叠态（跨 re-render 保留；与本体 taskCard 同款）
  var _taskCollapsed = false;

  function onTaskUpdate(payload) {
    var card = dom.taskCard || document.getElementById("taskCard");
    if (!card) return;
    if (!payload || payload.success === false) {
      if (payload && payload.error) showToast("✗ 任务操作失败：" + payload.error, 3000);
      return;
    }
    // per-chatId 隔离：推送带 chatid 且不是当前会话时忽略（broadcastChatEvent 本就按会话发，双保险）
    if (payload.chatid && state.currentChatId && payload.chatid !== state.currentChatId) return;
    _renderTaskCard(payload.tasks || []);
  }

  function _renderTaskCard(tasks) {
    var card = dom.taskCard || document.getElementById("taskCard");
    if (!card) return;
    if (!tasks.length) { card.classList.add("hidden"); card.innerHTML = ""; return; }

    var remaining = 0, total = tasks.length;
    for (var i = 0; i < tasks.length; i++) if (tasks[i].status !== "completed") remaining++;

    var rows = "";
    tasks.forEach(function(t) {
      var meta = _TASK_STATUS_META[t.status] || _TASK_STATUS_META.pending;
      var next = t.status === "completed" ? "pending" : "completed";
      rows += '<div class="task-row ' + meta.cls + '" data-id="' + _esc(t.id) + '">' +
        '<button class="task-toggle" data-id="' + _esc(t.id) + '" data-next="' + next + '" title="点击切换完成状态">' + meta.icon + '</button>' +
        '<span class="task-content" data-id="' + _esc(t.id) + '" data-content="' + _esc(t.content) + '" title="' + _esc(t.content) + '（双击编辑）">' + _esc(t.content) + '</span>' +
        '<button class="task-del" data-id="' + _esc(t.id) + '" title="删除此项">✕</button>' +
      '</div>';
    });

    card.innerHTML =
      '<div class="task-card-head" id="taskCardHead" style="cursor:pointer" title="点击折叠/展开任务清单">' +
        '<span class="task-card-title"><span id="taskCaret">' + (_taskCollapsed ? "▸" : "▾") + '</span> 📋 任务清单</span>' +
        '<span class="task-card-count' + (remaining === 0 ? " task-all-done" : "") + '">' +
          (remaining === 0 ? "全部完成" : "剩余 " + remaining + " 项") + ' / 共 ' + total + '</span>' +
      '</div>' +
      '<div id="taskCardBody"' + (_taskCollapsed ? ' class="hidden"' : '') + '>' +
        '<div class="task-rows">' + rows + '</div>' +
        '<div class="task-card-foot"><button id="taskAddBtn" class="task-add-btn">➕ 添加</button></div>' +
      '</div>';
    card.classList.remove("hidden");
    // 折叠：点 header 切换 body（caret ▾/▸），与本体 taskCard 同款
    var _tHead = document.getElementById("taskCardHead");
    if (_tHead) _tHead.addEventListener("click", function() {
      _taskCollapsed = !_taskCollapsed;
      var _b = document.getElementById("taskCardBody"); if (_b) _b.classList.toggle("hidden", _taskCollapsed);
      var _c = document.getElementById("taskCaret"); if (_c) _c.textContent = _taskCollapsed ? "▸" : "▾";
    });

    var toggles = card.querySelectorAll(".task-toggle");
    for (var j = 0; j < toggles.length; j++) toggles[j].addEventListener("click", function() {
      var _next = this.getAttribute("data-next");
      // 即时反馈：先乐观更新本行 + toast，再发后端（回推 task_update 会以权威态重渲）
      var _row = this.closest(".task-row");
      if (_row) { _row.classList.toggle("task-done", _next === "completed"); }
      showToast(_next === "completed" ? "✓ 已完成" : "○ 取消完成", 1000);
      vscode.postMessage({ type: "checkTask", payload: { id: this.getAttribute("data-id"), status: _next } });
    });
    var dels = card.querySelectorAll(".task-del");
    for (var k = 0; k < dels.length; k++) dels[k].addEventListener("click", function() {
      // 即时反馈：先隐藏本行 + toast，再发后端
      var _row = this.closest(".task-row");
      if (_row) _row.style.opacity = "0.4";
      showToast("✕ 已删除", 1000);
      vscode.postMessage({ type: "deleteTask", payload: { id: this.getAttribute("data-id") } });
    });
    var spans = card.querySelectorAll(".task-content");
    for (var l = 0; l < spans.length; l++) spans[l].addEventListener("dblclick", function() { _taskEditInline(this); });
    var addBtn = document.getElementById("taskAddBtn");
    if (addBtn) addBtn.addEventListener("click", _taskAddInline);
  }

  /** 双击就地编辑任务内容（Enter 提交 / Esc 还原，blur 提交）。 */
  function _taskEditInline(spanEl) {
    var id = spanEl.getAttribute("data-id");
    var old = spanEl.getAttribute("data-content") || "";
    var input = document.createElement("input");
    input.type = "text"; input.value = old; input.className = "task-edit-input";
    spanEl.replaceWith(input);
    input.focus(); input.select();
    var done = false;
    function commit() {
      if (done) return; done = true;
      var val = input.value.trim();
      if (!val || val === old) { vscode.postMessage({ type: "getTasks" }); return; }
      vscode.postMessage({ type: "updateTask", payload: { id: id, content: val } });
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") { done = true; vscode.postMessage({ type: "getTasks" }); }
    });
  }

  /** 用户手动新增一项（webview 无 window.prompt，卡内就地输入；提交走 planTasks 追加）。 */
  function _taskAddInline() {
    var card = dom.taskCard || document.getElementById("taskCard");
    if (!card || card.querySelector(".task-new-input")) return;
    var foot = card.querySelector(".task-card-foot");
    if (!foot) return;
    var input = document.createElement("input");
    input.type = "text"; input.placeholder = "新任务内容…（Enter 提交 / Esc 取消）";
    input.className = "task-edit-input task-new-input";
    foot.insertBefore(input, foot.firstChild);
    input.focus();
    var done = false;
    function commit() {
      if (done) return; done = true;
      var val = input.value.trim();
      input.remove();
      if (!val) return;
      var tasks = [];
      var rows = card.querySelectorAll(".task-row");
      for (var i = 0; i < rows.length; i++) {
        var sp = rows[i].querySelector(".task-content");
        tasks.push({
          id: rows[i].getAttribute("data-id"),
          content: sp ? sp.getAttribute("data-content") : "",
          status: rows[i].classList.contains("task-done") ? "completed" : rows[i].classList.contains("task-active") ? "in_progress" : "pending"
        });
      }
      tasks.push({ content: val, status: "pending", priority: "normal" });
      vscode.postMessage({ type: "planTasks", payload: { tasks: tasks } });
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") { done = true; input.remove(); }
    });
  }

  // ═══════════════════════════════════════════════════════
  // 导出到 YB 命名空间（chat.js 消息路由通过 YB.onXxx 调用本模块 handler）
  // ═══════════════════════════════════════════════════════
  YB.startTokenPoll = startTokenPoll;
  YB.stopTokenPoll = stopTokenPoll;
  YB.fetchTokenSnapshot = fetchTokenSnapshot;
  YB.onTokenSnapshot = onTokenSnapshot;
  YB.onTokenUsage = onTokenUsage;
  YB.onCompactResult = onCompactResult;
  YB.clearAllShimmers = _clearAllShimmers;
  YB.onModeChanged = function(payload) {
    if (!payload) return;
    var newMode = payload.mode || payload.active_mode || "";
    if (newMode) {
      // 找匹配的子模式并同步
      var modes = subModesOrCache();
      // 组内不回退：当前 activeSubMode 已属于 newMode 组（或就是它）时尊重精确值，
      // 只有不属于该组时才回退到组内首个子模式（修"切模式后子模式条被拉回首项"）
      var current = modes.find(function(m) { return m.id === state.activeSubMode; });
      var belongs = current && (current.id === newMode || current.modeGroup === newMode || (!current.modeGroup && newMode === DEFAULT_MODE));
      if (!belongs) {
        var matched = modes.find(function(m) { return m.id === newMode || m.modeGroup === newMode; });
        if (matched) { state.activeSubMode = matched.id; }
      }
      renderSubModeBar();
      renderSubModePanel();
    }
  };
  YB.showCompressPanel = showCompressPanel;
  YB.showSkillGroupPanel = showSkillGroupPanel;
  YB.showCheckpointPanel = showCheckpointPanel;
  YB.onFlowGroupList = onFlowGroupList;
  YB.onFlowGroupStarted = onFlowGroupStarted;
  YB.onFlowGroupChanged = onFlowGroupChanged;
  YB.onCheckpointList = onCheckpointList;
  YB.onCheckpointDiff = onCheckpointDiff;
  YB.onCheckpointReverted = onCheckpointReverted;
  YB.onTaskUpdate = onTaskUpdate;
  YB.showApprovalRulesPanel = showApprovalRulesPanel;
  YB.onApprovalRulesList = onApprovalRulesList;
  YB.onPermissionLevel = onPermissionLevel;
  // 订阅者模式：多模块可注册 onPresetConfig 回调，不再依赖 JS 加载顺序
  if (!YB._presetConfigHandlers) YB._presetConfigHandlers = [];
  YB._presetConfigHandlers.push(onPresetConfig);
  YB.onPresetConfig = function (data) {
    for (var i = 0; i < YB._presetConfigHandlers.length; i++) {
      try { YB._presetConfigHandlers[i](data); } catch (e) { console.error("[onPresetConfig] handler error:", e); }
    }
  };
  YB.renderSubModePanel = renderSubModePanel;
  YB.renderSubModeBar = renderSubModeBar;
  YB.onSubModesConfig = onSubModesConfig;
  YB.startMemoryPoll = startMemoryPoll;
  YB.stopMemoryPoll = stopMemoryPoll;
  YB.fetchMemoryStatus = fetchMemoryStatus;
  YB.onMemoryConfig = onMemoryConfig;
  YB.onMemoryAIOutput = onMemoryAIOutput;
  YB.onDiagSnapshot = onDiagSnapshot;
  YB.updateSelectorLabels = updateSelectorLabels;
  YB.fetchApiSourceList = fetchApiSourceList;
  YB.onApiSourceList = onApiSourceList;
  YB.onApiSourceSwitched = onApiSourceSwitched;
  YB.onModelList = onModelList;
  YB.loadTokenSettings = loadTokenSettings;
  YB.saveTokenSettings = saveTokenSettings;
  YB.onTokenReminderConfig = onTokenReminderConfig;
  // 链式包装：保留 chat-messages.js 先注册的底部 dock 消费者，先调旧再调本面板渲染（照 _modesOnPresetConfig / _origOnConn 模式，避免后注册覆盖前注册）
  var _msgsOnIdeApprovals = YB.onIdeApprovals; // chat-messages.js 注册的底部 dock 渲染
  YB.onIdeApprovals = function(payload) {
    if (_msgsOnIdeApprovals) _msgsOnIdeApprovals(payload);
    onIdeApprovals(payload);
  };
  var _msgsOnIdeApprovalResult = YB.onIdeApprovalResult; // chat-messages.js 注册的审批结果处理
  YB.onIdeApprovalResult = function(payload) {
    if (_msgsOnIdeApprovalResult) _msgsOnIdeApprovalResult(payload);
    onIdeApprovalResult(payload);
  };

  // ═══════════════════════════════════════════════════════
  // 分身AI管理 (W65)
  // ═══════════════════════════════════════════════════════

  state._clones = [];

  function fetchClones() {
    vscode.postMessage({ type: "getClones" });
  }

  function onClonesConfig(payload) {
    // A4 username 权威化：后端解析登录用户名失败返回 {success:false,error}，显式报错不静默装空列表。
    if (payload && (payload.error || payload.success === false)) {
      YB.showToast("⚠ 分身加载失败：" + (payload.error || "未能识别登录用户名"), 3500);
      return;
    }
    state._clones = payload.clones || [];
    // 07-09 收口审计：后端下发新建分身模板（14 权限键+contextMessages/maxContext/maxTokens 拍板值单源），
    //   showCloneForm 新建默认用它——原前端写死 7 键旧结构+maxTokens=4096 与后端 14 键+60000 分叉。
    if (payload.clone_template) state._cloneTemplate = payload.clone_template;
    renderCloneList();
  }

  function renderCloneList() {
    var container = document.getElementById("yb-clone-list");
    if (!container) return;
    var _esc = YB.escapeHtml; // 转义单源收口 2026-07-13：chat-core 必先加载，本地劣化 fallback（缺 单引号 转义）已删
    container.innerHTML = "";
    var clones = state._clones;
    for (var i = 0; i < clones.length; i++) {
      var cl = clones[i];
      var item = document.createElement("div");
      item.className = "submode-panel-item";
      item.innerHTML =
        '<span class="submode-icon">👤</span>' +
        '<div class="submode-text">' +
        '<div class="submode-label">' + _esc(cl.label) + (cl.enabled ? "" : " <span style=\"opacity:0.4\">(禁用)</span>") + "</div>" +
        '<div class="submode-desc">' +
        (cl.presetName ? "预设:" + _esc(cl.presetName) + " " : "") +
        (cl.modelName ? "模型:" + _esc(cl.modelName) : "") +
        "</div></div>" +
        '<div class="submode-item-actions">' +
        '<button class="icon-btn submode-edit-btn" data-cl-edit="' + i + '">✏</button>' +
        '<button class="icon-btn submode-del-btn" data-cl-del="' + i + '">✕</button>' +
        "</div>";
      container.appendChild(item);
    }
    // 添加按钮
    var addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary submode-add-btn";
    addBtn.textContent = "+ 添加分身";
    addBtn.style.cssText = "margin-top:8px;width:100%;";
    addBtn.addEventListener("click", function () { showCloneForm(null); });
    container.appendChild(addBtn);

    // 事件
    container.querySelectorAll("[data-cl-edit]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        showCloneForm(clones[parseInt(el.dataset.clEdit)]);
      });
    });
    container.querySelectorAll("[data-cl-del]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(el.dataset.clDel);
        state._clones.splice(idx, 1);
        vscode.postMessage({ type: "saveClones", payload: { clones: state._clones } });
        renderCloneList();
        showToast("已删除分身", 1500);
      });
    });
  }

  function showCloneForm(existing) {
    var isEdit = !!existing;
    var overlay = document.createElement("div");
    overlay.className = "submode-form-overlay";
    var form = document.createElement("div");
    form.className = "submode-form";
    // 分身字段为用户输入，回填进 value 属性必须转义，否则含引号/尖括号会破坏属性甚至注入
    var _esc = YB.escapeHtml; // 转义单源收口 2026-07-13：chat-core 必先加载，本地劣化 fallback（缺 单引号 转义）已删
    // 07-09 凛倾拍板：分身参数需可编辑 UI——同一模式的分身可能同时间多次调用，权限/上下文/输出须 per-分身可配。
    //   默认值单源=后端 clone_template（getClones 下发）；permissions 键集=模板键∪已有键（后端 14 键结构镜像，前端不写死清单）。
    var _tpl = state._cloneTemplate || {};
    var _tplPerms = _tpl.permissions || {};
    var _curPerms = existing ? (existing.permissions || {}) : _tplPerms;
    var _permKeys = Object.keys(_tplPerms);
    Object.keys(_curPerms).forEach(function (k) { if (_permKeys.indexOf(k) < 0) _permKeys.push(k); });
    var _permBoxes = _permKeys.map(function (k) {
      var on = _curPerms[k] === true;
      return '<label style="display:flex;align-items:center;gap:4px;font-size:0.72rem;">' +
        '<input type="checkbox" class="clf-perm memory-preset-checkbox" data-perm="' + _esc(k) + '" ' + (on ? "checked" : "") + ' />' + _esc(k) + "</label>";
    }).join("");
    // 数值默认全部取自后端模板，前端零数字字面量（模板缺失=留空，由用户填/后端兜）
    var _numVal = function (field) {
      var v = existing ? existing[field] : _tpl[field];
      if (typeof v !== "number" || !isFinite(v)) v = _tpl[field];
      return (typeof v === "number" && isFinite(v)) ? v : "";
    };
    form.innerHTML =
      '<div class="submode-form-title">' + (isEdit ? "编辑分身" : "添加分身") + "</div>" +
      '<div style="display:grid;gap:8px;">' +
      '<label class="form-group-label">名称</label><input id="clf-label" class="input-field" value="' + _esc(existing ? existing.label : "") + '" />' +
      '<label class="form-group-label">绑定预设</label><input id="clf-preset" class="input-field" value="' + _esc(existing ? existing.presetName || "" : "") + '" />' +
      '<label class="form-group-label">API源</label><input id="clf-api" class="input-field" placeholder="(默认)" value="' + _esc(existing ? existing.apiSource || "" : "") + '" />' +
      '<label class="form-group-label">模型</label><input id="clf-model" class="input-field" placeholder="(默认)" value="' + _esc(existing ? existing.modelName || "" : "") + '" />' +
      '<label class="form-group-label">上下文条数</label><input id="clf-ctxmsgs" class="input-field" type="number" min="1" value="' + _numVal("contextMessages") + '" />' +
      '<label class="form-group-label">最大上下文(tokens)</label><input id="clf-maxctx" class="input-field" type="number" min="1" value="' + _numVal("maxContext") + '" />' +
      '<label class="form-group-label">最大输出(tokens)</label><input id="clf-maxtok" class="input-field" type="number" min="1" value="' + _numVal("maxTokens") + '" />' +
      (_permKeys.length ? '<label class="form-group-label">权限</label><div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;">' + _permBoxes + "</div>" : "") +
      '<div class="submode-form-toggle"><label class="form-group-label">启用</label><input type="checkbox" id="clf-enabled" ' + (existing ? (existing.enabled ? "checked" : "") : "checked") + ' class="memory-preset-checkbox" /></div>' +
      "</div>" +
      '<div class="submode-form-actions">' +
      '<button class="btn btn-primary" id="clf-save">保存</button>' +
      '<button class="btn btn-secondary" id="clf-cancel">取消</button>' +
      "</div>";
    overlay.appendChild(form);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
    form.querySelector("#clf-cancel").addEventListener("click", function () { overlay.remove(); });
    form.querySelector("#clf-save").addEventListener("click", function () {
      // 07-09：permissions/数值从表单控件收集（原写死 7 键旧结构+maxTokens=4096 与后端模板分叉，编辑不可改）。
      //   兜底链=表单值→已有值→后端模板值，前端零数字字面量。
      var _formPerms = {};
      form.querySelectorAll(".clf-perm").forEach(function (cb) { _formPerms[cb.getAttribute("data-perm")] = cb.checked; });
      var _num = function (id, field) {
        var v = Number(form.querySelector(id).value);
        if (isFinite(v) && v > 0) return v;
        var fb = existing ? existing[field] : undefined;
        return (typeof fb === "number" && isFinite(fb)) ? fb : _tpl[field];
      };
      var cloneData = {
        id: isEdit ? existing.id : (state._clones.length > 0 ? Math.max.apply(null, state._clones.map(function (c) { return c.id; })) + 1 : 1),
        label: form.querySelector("#clf-label").value.trim() || "分身",
        enabled: form.querySelector("#clf-enabled").checked,
        presetName: form.querySelector("#clf-preset").value.trim(),
        apiSource: form.querySelector("#clf-api").value.trim(),
        modelName: form.querySelector("#clf-model").value.trim(),
        permissions: Object.keys(_formPerms).length ? _formPerms : (existing ? existing.permissions : _tplPerms),
        contextMessages: _num("#clf-ctxmsgs", "contextMessages"),
        maxContext: _num("#clf-maxctx", "maxContext"),
        maxTokens: _num("#clf-maxtok", "maxTokens"),
      };
      if (isEdit) {
        var idx = state._clones.findIndex(function (c) { return c.id === existing.id; });
        if (idx >= 0) state._clones[idx] = cloneData;
      } else {
        state._clones.push(cloneData);
      }
      vscode.postMessage({ type: "saveClones", payload: { clones: state._clones } });
      overlay.remove();
      renderCloneList();
      showToast((isEdit ? "已更新" : "已添加") + " " + cloneData.label, 1500);
    });
    document.body.appendChild(overlay);
  }

  // W65: 工具结果就绪通知（自动继续由后端generation.mjs统一处理，前端只做UI通知）
  function onToolResultsReady(payload) {
    // ★ shimmer动画：工具完成→更新状态
    // 通过管理者清理所有 shimmer
    Object.keys(_activeShimmers).forEach(function(key) {
      var entry = _activeShimmers[key];
      if (!entry) return;
      var failed = payload && payload.failedTools ? payload.failedTools.find(function(f) { return f.tool === key; }) : null;
      clearTimeout(entry.timer);
      if (failed) {
        entry.el.className = "yb-tool-status yb-tool-failed";
        entry.el.textContent = "\u274C " + key + ": " + (failed.error || "failed").substring(0, 50);
      } else {
        entry.el.className = "yb-tool-status yb-tool-done";
        entry.el.textContent = "\u2705 " + key + " done";
      }
      delete _activeShimmers[key];
      setTimeout(function() { if (entry.el.isConnected) entry.el.remove(); }, 3000);
    });
    // ★ P2-5: 工具失败时显示toast提示
    if (payload && payload.failedTools && payload.failedTools.length > 0) {
      var failMsg = payload.failedTools.map(function(f) { return f.tool + ": " + (f.error || "failed"); }).join("\n");
      showToast("\u274C \u5DE5\u5177\u6267\u884C\u5931\u8D25:\n" + failMsg, 4000);
    }
    console.log("[chat-modes] 工具结果就绪(" + (payload.count || 0) + ")，等待后端触发继续");
    // ★ 不再前端独立触发triggerReply — 后端generation.mjs在consumePendingResults后
    // 已经注入结果到chatLog并触发下一轮，前端重复触发会被_generatingChats拦截但浪费请求
  }

  // ★ shimmer 管理者——单一创建+清理入口，超时兜底
  var _activeShimmers = {};
  function _showToolRunning(toolName) {
    var key = toolName || "tool";
    if (_activeShimmers[key]) return;
    var container = document.getElementById("messageList");
    if (!container) return;
    var el = document.createElement("div");
    el.className = "yb-tool-status yb-tool-running";
    el.dataset.tool = key;
    el.textContent = "\uD83D\uDD27 " + key + "...";
    var timer = setTimeout(function() { _removeToolRunning(key); }, 60000);
    _activeShimmers[key] = { el: el, timer: timer };
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }
  function _removeToolRunning(key) {
    var entry = _activeShimmers[key];
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.el.isConnected) entry.el.remove();
    delete _activeShimmers[key];
  }
  function _clearAllShimmers() {
    Object.keys(_activeShimmers).forEach(_removeToolRunning);
  }

  // W66: 收到审批通知→自动拉取审批列表并显示+shimmer
  function onPendingApprovals(payload) {
    console.log("[chat-modes] 收到审批通知: " + (payload.count || 0) + " 个待审批");
    // ★ shimmer：审批等待中显示动画
    _showToolRunning("write (" + (payload.count || 0) + " pending)");
    showToast("\u26A0\uFE0F " + (payload.count || 0) + " \u4E2A\u5199\u64CD\u4F5C\u5F85\u5BA1\u6279", 3000);
    vscode.postMessage({ type: "getIdeApprovals" });
  }

  YB.onToolResultsReady = onToolResultsReady;
  YB.onPendingApprovals = onPendingApprovals;
  YB.fetchClones = fetchClones;
  YB.onClonesConfig = onClonesConfig;

  // ★ 功能B：分身面板
  var _cloneMap = {};

  function _renderClonePanel() {
    var panel = document.getElementById("yb-clone-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "yb-clone-panel";
      panel.className = "yb-clone-panel";
      var container = document.getElementById("messageList");
      if (container && container.parentNode) {
        container.parentNode.insertBefore(panel, container);
      }
    }
    var ids = Object.keys(_cloneMap);
    if (!ids.length) { panel.style.display = "none"; return; }
    panel.style.display = "block";
    var html = '<div class="yb-clone-panel-header">\uD83E\uDD16 \u5206\u8EAB\u8FDB\u5EA6' +
      '<span class="yb-clone-close" data-action="close-clone-panel">\u00D7</span></div>';
    ids.forEach(function(id) {
      var c = _cloneMap[id];
      var icon = c.status === "completed" || c.status === "done" ? "\u2705"
        : c.status === "error" ? "\u274C"
        : c.status === "stopped" ? "\u23F9"
        : "\u23F3";
      // [0724 \u5206\u8EAB\u53EF\u505C\u00B7002] \u975E\u7EC8\u6001\uFF08\u8FD8\u5728\u8DD1/\u91CD\u8BD5/\u544A\u8B66\uFF09\u7684\u5361\u5E26 \u23F9 \u505C\u6B62\u6309\u94AE
      var running = !(c.status === "completed" || c.status === "done" || c.status === "error" || c.status === "stopped");
      html += '<div class="yb-clone-card' +
        (c.status === "completed" || c.status === "done" ? " done" : c.status === "error" ? " error" : "") + '">' +
        '<span>' + icon + '</span>' +
        '<span class="yb-clone-label">' + _esc(c.label || id) + '</span>' +
        '<span class="yb-clone-stats">\u7B2C' + (c.round || 0) + '\u8F6E &nbsp; ' + _esc(c.detail || "") + '</span>' +
        (running ? '<span class="yb-clone-stop" data-action="stop-clone" data-task="' + _esc(id) + '" title="\u505C\u6B62\u8BE5\u5206\u8EAB">\u23F9</span>' : '') +
        '</div>';
    });
    panel.innerHTML = html;
    var closeBtn = panel.querySelector('[data-action="close-clone-panel"]');
    if (closeBtn) closeBtn.addEventListener("click", function() { panel.style.display = "none"; });
    // [0724 \u5206\u8EAB\u53EF\u505C] \u23F9 \u2192 Extension stopCloneTask \u2192 \u540E\u7AEF SetData\uFF08cloneAbort abort \u8BE5\u4EFB\u52A1\uFF09\u3002
    //   \u4E0D\u9884\u5199\u672C\u5730\u72B6\u6001\uFF1A\u7EC8\u6001 stopped \u7531\u540E\u7AEF clone_status \u5E7F\u64AD\u56DE\u6D41\uFF08onCloneStatus\uFF09\u5237\u65B0\uFF0C\u8BDA\u5B9E\u5916\u663E\u3002
    panel.querySelectorAll('[data-action="stop-clone"]').forEach(function(btn) {
      btn.addEventListener("click", function() {
        var tid = btn.getAttribute("data-task");
        btn.textContent = "\u2026"; // \u70B9\u51FB\u53CD\u9988\uFF1A\u23F9 \u2192 \u2026\uFF08\u7B49\u5E7F\u64AD\u56DE\u6D41\u5237\u65B0\uFF09
        vscode.postMessage({ type: "stopCloneTask", payload: { taskId: tid } });
      });
    });
  }

  YB.onCloneStatus = function(payload) {
    if (!payload || !payload.taskId) return;
    var id = payload.taskId;
    if (!_cloneMap[id]) {
      _cloneMap[id] = { label: id, round: 0, status: "started", detail: "" };
    }
    var c = _cloneMap[id];
    c.status = payload.status || c.status;
    c.round = payload.round || c.round;
    c.detail = typeof payload.detail === "string" ? payload.detail.substring(0, 60) : c.detail;
    // 分身标签从后端task.id提取（格式如 "clone_审查分身_0"）
    if (!c.label || c.label === id) {
      var parts = String(id).split("_");
      if (parts.length >= 2) c.label = parts.slice(1, -1).join("_") || id;
    }
    _renderClonePanel();
    // 完成后10秒自动隐藏
    if (payload.status === "completed" || payload.status === "error" || payload.status === "stopped") {
      setTimeout(function() {
        delete _cloneMap[id];
        _renderClonePanel();
      }, 10000);
    }
  };  // ← 闭合 YB.onCloneStatus

  // ★ 功能C：AI改动历史记录
  var _editHistory = [];
  var _editHistoryId = 0;
  var _MAX_EDIT_HISTORY = 50;

  function _computeLineDiff(oldLines, newLines) {
    var result = [];
    var oi = 0, ni = 0;
    while (oi < oldLines.length || ni < newLines.length) {
      if (oi < oldLines.length && ni < newLines.length) {
        if (oldLines[oi] === newLines[ni]) {
          result.push({ type: "context", text: oldLines[oi] }); oi++; ni++;
        } else {
          var lookAhead = 5;
          var foundOld = -1, foundNew = -1;
          for (var j = ni + 1; j < Math.min(ni + lookAhead, newLines.length); j++) {
            if (newLines[j] === oldLines[oi]) { foundNew = j; break; }
          }
          for (var k = oi + 1; k < Math.min(oi + lookAhead, oldLines.length); k++) {
            if (oldLines[k] === newLines[ni]) { foundOld = k; break; }
          }
          if (foundNew >= 0 && (foundOld < 0 || foundNew - ni <= foundOld - oi)) {
            while (ni < foundNew) { result.push({ type: "add", text: newLines[ni] }); ni++; }
          } else if (foundOld >= 0) {
            while (oi < foundOld) { result.push({ type: "remove", text: oldLines[oi] }); oi++; }
          } else {
            result.push({ type: "remove", text: oldLines[oi] });
            result.push({ type: "add", text: newLines[ni] });
            oi++; ni++;
          }
        }
      } else if (oi < oldLines.length) {
        result.push({ type: "remove", text: oldLines[oi] }); oi++;
      } else {
        result.push({ type: "add", text: newLines[ni] }); ni++;
      }
    }
    return result;
  }

  function _renderDiffHtml(oldText, newText) {
    // escapeHtml 单源=YB.escapeHtml（chat-core.js 先于本文件加载，必然存在）；本地 fallback 副本已删（残留清理 2026-07-15）
    var esc = YB.escapeHtml;
    var diff = _computeLineDiff((oldText||"").split("\n"), (newText||"").split("\n"));
    var added = diff.filter(function(l){return l.type==="add";}).length;
    var removed = diff.filter(function(l){return l.type==="remove";}).length;
    var linesHtml = diff.map(function(line) {
      var cls = line.type === "remove" ? "yb-diff-del" : line.type === "add" ? "yb-diff-add" : "yb-diff-ctx";
      var prefix = line.type === "remove" ? "\u2212" : line.type === "add" ? "+" : " ";
      return '<div class="' + cls + '"><span class="diff-pfx">' + prefix + '</span>' + esc(line.text) + '</div>';
    }).join("");
    return '<div class="eh-diff-stats"><span class="yb-diff-add">+' + added + '</span> <span class="yb-diff-del">\u2212' + removed + '</span></div>' +
      '<div class="eh-diff-body">' + linesHtml + '</div>';
  }
  // ★ 暴露给 chat-messages.js：工具调用卡渲真红绿 diff 复用此渲染器(对齐本体 diffRenderer，不重写)。
  YB._renderDiffHtml = _renderDiffHtml;

  function _renderEditHistoryList() {
    var list = document.getElementById("editHistoryList");
    if (!list) return;
    if (!_editHistory.length) {
      list.innerHTML = '<div class="edit-history-empty">\u6682\u65E0\u6539\u52A8\u8BB0\u5F55</div>';
      return;
    }
    list.innerHTML = "";
    _editHistory.forEach(function(rec) {
      var item = document.createElement("div");
      item.className = "eh-item";

      var _esc = YB.escapeHtml; // 转义单源收口 2026-07-13：chat-core 必先加载，本地劣化 fallback（缺 单引号 转义）已删
      var header = document.createElement("div");
      header.className = "eh-item-header";
      header.innerHTML =
        '<span class="eh-tool-badge">' + _esc(rec.tool) + '</span>' +
        '<span class="eh-filename">' + _esc(rec.fileName) + '</span>' +
        '<span class="eh-line">L' + _esc(String(rec.matchLine)) + '</span>' +
        '<span class="eh-time">' + _esc(rec.timestamp) + '</span>';
      header.addEventListener("click", function() {
        vscode.postMessage({ type: "revealFile", payload: { path: rec.path, line: rec.matchLine } });
      });
      item.appendChild(header);

      var diffEl = document.createElement("div");
      diffEl.className = "eh-diff hidden";
      diffEl.innerHTML = _renderDiffHtml(rec.oldString, rec.newString);
      item.appendChild(diffEl);

      var toggle = document.createElement("div");
      toggle.className = "eh-diff-toggle";
      toggle.textContent = "\u67E5\u770B\u6539\u52A8";
      toggle.addEventListener("click", function() {
        var hidden = diffEl.classList.toggle("hidden");
        toggle.textContent = hidden ? "\u67E5\u770B\u6539\u52A8" : "\u6536\u8D77";
      });
      item.appendChild(toggle);
      list.appendChild(item);
    });
  }

  YB.showEditHistory = function() {
    YB.showFloatingPopup("editHistoryPopup");
    _renderEditHistoryList();
    var clearBtn = document.getElementById("editHistoryClearBtn");
    if (clearBtn) {
      clearBtn.onclick = function() {
        _editHistory = [];
        _editHistoryId = 0;
        var badge = document.getElementById("editHistoryCount");
        if (badge) badge.classList.add("hidden");
        _renderEditHistoryList();
      };
    }
  };

  YB.onEditRecord = function(payload) {
    if (!payload) return;
    var absPath = payload.path || "";
    var fileName = absPath.split(/[\\/]/).pop() || absPath;
    var rec = {
      id: ++_editHistoryId,
      tool: payload.tool || "?",
      path: absPath,
      fileName: fileName,
      matchLine: payload.matchLine || 1,
      lineCount: payload.lineCount || 1,
      oldString: (payload.oldString || "").substring(0, 500),
      newString: (payload.newString || "").substring(0, 500),
      timestamp: payload.timestamp || new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    };
    _editHistory.unshift(rec);
    if (_editHistory.length > _MAX_EDIT_HISTORY) _editHistory.pop();
    var badge = document.getElementById("editHistoryCount");
    if (badge) {
      badge.textContent = _editHistory.length;
      badge.classList.remove("hidden");
    }
  };
  // ═══════════════════════════════════════════════════════
  // 并行组管理面板（v4 §4 — YonBan 端三栏，对应本体 groupPanel.mjs）
  // 通过后端 groups API 管理组 CRUD + 绑定当前对话到组角色
  // ═══════════════════════════════════════════════════════

  // ── 组运行态指示条（顶部常驻，4s 轮询）──
  var _groupCache = [];
  var _groupPollTimer = null;

  function _renderGroupRuntimeBar() {
    var bar = document.getElementById("groupRuntimeBar");
    var content = document.getElementById("groupRuntimeContent");
    if (!bar || !content) return;
    if (!_groupCache.length) { bar.classList.add("hidden"); return; }
    console.log("[YB/groups] renderBar:", _groupCache.length, "组");
    bar.classList.remove("hidden");
    var chatId = YB.state.currentChatId || "";
    content.innerHTML = _groupCache.map(function(g) {
      var isCurrent = false;
      var roles = g.roles || {};
      Object.keys(roles).forEach(function(r) { if (roles[r] === chatId) isCurrent = true; });
      var dotClass = g.status === "running" ? "grp-dot-running" : g.status === "stopped" ? "grp-dot-stopped" : "grp-dot-idle";
      var roleCount = Object.keys(roles).length;
      return '<span class="grp-chip' + (isCurrent ? " grp-current" : "") + '" title="' + _esc(g.groupId) + '">' +
        '<span class="grp-dot ' + dotClass + '"></span>' +
        _esc(g.projectName || "组") + ' <span style="opacity:0.5;">(' + roleCount + ')</span>' +
        '</span>';
    }).join("");
  }

  function _startGroupPoll() {
    if (_groupPollTimer) return;
    // T10: 子模式同步改走 WS 推送（onSubModeSwitched），interval 不再拉 getSubModes；
    // P0.3: 组运行态已接 WS 推送（onGroupRuntimeUpdate，本体 group_runtime_update）——主刷新路径走推送。
    //   轮询从 15s 降为 60s 兜底（仅防推送漏发/连接抖动失活），不再承担实时刷新职责。
    _groupPollTimer = setInterval(function() {
      _fetchGroups(function() { _renderGroupRuntimeBar(); });
    }, YB.POLL.group); // 单源=constants.ts GROUP_POLL_MS
    _fetchGroups(function() { _renderGroupRuntimeBar(); });
  }

  // T10: 子模式切换实时推送 → 拉一次最新子模式配置刷新条（复用 onSubModesConfig 渲染链）
  YB.onSubModeSwitched = function(payload) {
    try {
      if (payload && payload.label) YB.showToast("子模式: " + payload.label, 1500);
    } catch (e) { /* toast 失败不阻断 */ }
    vscode.postMessage({ type: "getSubModes" });
  };

  // 启动/停止必须在同一收口点配对：原只有 connected→start、无任何 stop（全库零 clearInterval），
  // 断连后每 60s 持续空转发 listGroups 直到 webview 销毁（病型扫描 3-B 硬残留）。
  function _stopGroupPoll() {
    if (_groupPollTimer) {
      clearInterval(_groupPollTimer);
      _groupPollTimer = null;
    }
    // 断连后组运行态已不可信，清缓存并隐藏指示条，防 stale 展示
    _groupCache = [];
    _renderGroupRuntimeBar();
  }

  // 连接成功后启动组轮询；断连/错误停止
  var _origOnConn = YB.onConnectionState;
  YB.onConnectionState = function(payload) {
    if (_origOnConn) _origOnConn(payload);
    if (payload && payload.status === "connected" && !_groupPollHidden) _startGroupPoll();
    else if (!(payload && payload.status === "connected")) _stopGroupPoll();
  };

  // 多开资源优化（2026-07-26）：面板隐藏时停组轮询（与 token/memory/approval 同款生命周期）——
  // 原只跟连接状态走，4 开 VSCode 时 4 份 60s 兜底轮询在后台空转打后端。可见恢复时若仍连接则重启。
  var _groupPollHidden = false;
  YB.stopGroupPoll = function () { _groupPollHidden = true; _stopGroupPoll(); };
  YB.startGroupPoll = function () {
    _groupPollHidden = false;
    if (state.connectionStatus === "connected") _startGroupPoll(); // 真源=chat-connection.js:46 state.connectionStatus
  };

  // 通过 postMessage 转发组 API（CSP 禁止 webview 直接 XHR 到后端）
  var _groupApiCallbacks = {};
  var _groupApiSeq = 0;

  // 后端 getGroupRegistry 返回对象映射 {groupId: group}，前端按数组消费——边界归一一处。
  function _normalizeGroups(groups) {
    if (Array.isArray(groups)) return groups;
    if (groups && typeof groups === "object") {
      return Object.keys(groups).map(function(k) {
        var g = groups[k] || {};
        if (!g.groupId) g.groupId = k;
        return g;
      });
    }
    return [];
  }

  function _fetchGroups(cb) {
    var id = "grp_" + (++_groupApiSeq);
    _groupApiCallbacks[id] = function(payload) {
      delete _groupApiCallbacks[id];
      if (payload && payload.error) { cb(new Error(payload.error)); return; }
      _groupCache = _normalizeGroups(payload && payload.groups);
      cb(null, _groupCache);
    };
    vscode.postMessage({ type: "listGroups", payload: { _callbackId: id } });
  }

  function _groupApi(action, body, cb) {
    var id = "grp_" + (++_groupApiSeq);
    _groupApiCallbacks[id] = function(payload) {
      delete _groupApiCallbacks[id];
      if (payload && payload.error) { cb(new Error(payload.error)); return; }
      cb(null, payload);
    };
    vscode.postMessage({ type: "groupAction", payload: { action: action, body: body || {}, _callbackId: id } });
  }

  // 接收 Provider 回传的组 API 结果
  YB.onGroupApiResult = function(payload) {
    var id = payload && payload._callbackId;
    if (id && _groupApiCallbacks[id]) _groupApiCallbacks[id](payload);
  };

  var _engineEnabled = false;

  YB.showGroupManager = function() {
    var overlay = document.createElement("div");
    overlay.className = "submode-form-overlay";
    var panel = document.createElement("div");
    panel.className = "submode-form";
    panel.style.maxWidth = "420px";
    panel.style.maxHeight = "80vh";
    panel.style.overflowY = "auto";

    function render() {
      _groupApi("getEngine", {}, function(err, engineData) {
        if (!err && engineData) _engineEnabled = !!engineData.enabled;
        _fetchGroups(function(err2) {
          if (err2) { panel.innerHTML = '<div style="color:var(--vscode-errorForeground);">加载失败: ' + _esc(err2.message) + '</div>'; return; }
          var chatId = YB.state.currentChatId || "";
          var html = '<div style="font-weight:600;font-size:14px;margin-bottom:12px;">🗂️ 并行组管理</div>';

          // 引擎开关
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:6px 8px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,0.04));">';
          html += '<span style="flex:1;font-size:12px;">⚡ 并行引擎</span>';
          html += '<button id="yb-engine-toggle" style="padding:3px 12px;font-size:11px;border-radius:4px;border:1px solid ' + (_engineEnabled ? 'var(--vscode-charts-green)' : 'var(--vscode-panel-border)') + ';background:' + (_engineEnabled ? 'var(--vscode-charts-green)' : 'transparent') + ';color:' + (_engineEnabled ? '#000' : 'inherit') + ';cursor:pointer;font-weight:600;">' + (_engineEnabled ? 'ON' : 'OFF') + '</button>';
          html += '</div>';

          // 建组
          html += '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
            '<input id="yb-grp-name" type="text" placeholder="新组名称" style="flex:1;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;font-size:12px;" />' +
            '<button id="yb-grp-create" class="btn btn-primary" style="font-size:12px;padding:4px 12px;">建组</button></div>';

          if (_groupCache.length === 0) {
            html += '<div style="opacity:0.5;font-size:12px;text-align:center;padding:16px 0;">暂无并行组<br><span style="font-size:11px;">建一个组 → 绑定对话 → 启动并行执行</span></div>';
          } else {
            _groupCache.forEach(function(g) {
              var isMember = false;
              var myRole = "";
              var roles = g.roles || {};
              var roleKeys = Object.keys(roles);
              Object.keys(roles).forEach(function(role) { if (roles[role] === chatId) { isMember = true; myRole = role; } });
              var statusColor = g.status === "running" ? "var(--vscode-charts-green)" : g.status === "stopped" ? "var(--vscode-errorForeground)" : "var(--vscode-descriptionForeground)";
              var statusText = g.status === "running" ? "运行中" : g.status === "stopped" ? "已停" : "空闲";

              html += '<div class="yb-clone-card" style="margin-bottom:8px;padding:8px;border-radius:6px;border:1px solid var(--vscode-panel-border);">';
              html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
              html += '<span style="width:7px;height:7px;border-radius:50%;background:' + statusColor + ';flex-shrink:0;' + (g.status === "running" ? 'animation:pulse 1.5s infinite;' : '') + '"></span>';
              html += '<span style="font-weight:600;font-size:13px;flex:1;">' + _esc(g.projectName || g.groupId) + '</span>';
              html += '<span style="font-size:10px;color:' + statusColor + ';">' + statusText + '</span>';
              html += '<button class="yb-grp-execute" data-gid="' + _esc(g.groupId) + '"' + (roleKeys.length === 0 ? ' disabled' : '') + ' style="font-size:11px;padding:2px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:' + (roleKeys.length === 0 ? 'not-allowed' : 'pointer') + ';opacity:' + (roleKeys.length === 0 ? '0.4' : '1') + ';">▶ 启动</button>';
              html += '<button class="yb-grp-delete" data-gid="' + _esc(g.groupId) + '" style="background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);font-size:11px;">✕</button>';
              html += '</div>';

              // 角色列表
              if (roleKeys.length > 0) {
                roleKeys.forEach(function(role) {
                  var rid = roles[role];
                  var isMe = rid === chatId;
                  html += '<div style="display:flex;align-items:center;gap:4px;font-size:11px;padding:2px 0;">';
                  html += '<span style="opacity:0.6;">' + _esc(role) + ':</span>';
                  html += '<span' + (isMe ? ' style="font-weight:600;color:var(--vscode-charts-green);"' : '') + '>' + _esc(String(rid).substring(0, 10)) + (isMe ? " (当前)" : "") + '</span>';
                  if (isMe) html += ' <button class="yb-grp-unbind" data-gid="' + _esc(g.groupId) + '" data-role="' + _esc(role) + '" style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--vscode-errorForeground);">解绑</button>';
                  html += '</div>';
                });
              } else {
                html += '<div style="font-size:11px;opacity:0.4;">无绑定角色（先绑定对话再启动）</div>';
              }

              // 绑定按钮
              if (!isMember && chatId) {
                html += '<div style="display:flex;gap:4px;margin-top:6px;">';
                html += '<input class="yb-grp-role-input" data-gid="' + _esc(g.groupId) + '" type="text" placeholder="角色名(如 代码指挥)" style="flex:1;padding:2px 6px;font-size:11px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;" />';
                html += '<button class="yb-grp-bind" data-gid="' + _esc(g.groupId) + '" style="font-size:11px;padding:2px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;">绑定当前对话</button>';
                html += '</div>';
              }
              html += '</div>';
            });
          }

          html += '<div style="text-align:center;margin-top:12px;"><button id="yb-grp-close" style="padding:6px 24px;border:1px solid var(--vscode-panel-border);background:none;color:inherit;border-radius:4px;cursor:pointer;font-size:12px;">关闭</button></div>';
          panel.innerHTML = html;

          // 事件：引擎开关
          var engineBtn = panel.querySelector("#yb-engine-toggle");
          if (engineBtn) engineBtn.addEventListener("click", function() {
            _groupApi("setEngine", { enabled: !_engineEnabled }, function(err3, data) {
              if (!err3 && data) _engineEnabled = !!data.enabled;
              render();
            });
          });

          // 事件：建组
          var createBtn = panel.querySelector("#yb-grp-create");
          var nameInput = panel.querySelector("#yb-grp-name");
          if (createBtn) createBtn.addEventListener("click", function() {
            var name = (nameInput ? nameInput.value.trim() : "") || "组" + Date.now();
            _groupApi("create", { projectName: name }, function(err4) {
              if (err4) { YB.showToast("建组失败: " + err4.message, 2000); return; }
              render();
            });
          });

          // 事件：执行
          panel.querySelectorAll(".yb-grp-execute").forEach(function(btn) {
            btn.addEventListener("click", function() {
              _groupApi("executeGroup", { groupId: btn.dataset.gid }, function(err5, data) {
                if (err5) { YB.showToast("启动失败: " + err5.message, 2000); return; }
                var triggered = (data && data.triggered) || [];
                var ok = triggered.filter(function(t) { return t.ok; }).length;
                var fail = triggered.filter(function(t) { return !t.ok; }).length;
                YB.showToast("已触发 " + ok + " 个对话" + (fail ? "，" + fail + " 个失败" : ""), 2000);
                render();
              });
            });
          });

          panel.querySelectorAll(".yb-grp-delete").forEach(function(btn) {
            btn.addEventListener("click", function() {
              _groupApi("delete", { groupId: btn.dataset.gid }, function() { render(); });
            });
          });

          panel.querySelectorAll(".yb-grp-bind").forEach(function(btn) {
            btn.addEventListener("click", function() {
              var roleInput = panel.querySelector('.yb-grp-role-input[data-gid="' + btn.dataset.gid + '"]');
              var role = (roleInput ? roleInput.value.trim() : "") || "worker";
              _groupApi("setRole", { groupId: btn.dataset.gid, role: role, chatid: chatId }, function(err6) {
                if (err6) { YB.showToast("绑定失败: " + err6.message, 2000); return; }
                render();
              });
            });
          });

          panel.querySelectorAll(".yb-grp-unbind").forEach(function(btn) {
            btn.addEventListener("click", function() {
              _groupApi("clearRole", { groupId: btn.dataset.gid, role: btn.dataset.role }, function() { render(); });
            });
          });

          var closeBtn = panel.querySelector("#yb-grp-close");
          if (closeBtn) closeBtn.addEventListener("click", function() { overlay.remove(); });
        });
      });
    }

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
    render();
  };

  // 组列表更新（后端推送）
  YB.onGroupList = function(payload) { _groupCache = _normalizeGroups(payload && payload.groups); _renderGroupRuntimeBar(); };
  YB.onGroupUpdated = function() { _fetchGroups(function() { _renderGroupRuntimeBar(); }); };
  // P0.3: 本体组运行态 WS 推送（group_runtime_update，payload 仅 {username}）→ 重拉组注册表刷新条。
  //   推送到达即刷新，去掉 15s 轮询延迟；轮询降级为 60s 兜底（见 _startGroupPoll）。
  YB.onGroupRuntimeUpdate = function() { _fetchGroups(function() { _renderGroupRuntimeBar(); }); };

  } catch(e) { try { window.YB.showToast("\uD83D\uDEA8 chat-modes 加载失败: " + e.message, 8000); } catch(_) {} console.error("[chat-modes] 加载失败:", e); }
})();
