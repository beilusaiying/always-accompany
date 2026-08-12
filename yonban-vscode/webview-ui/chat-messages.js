/**
 * [chat-messages] — 消息渲染 + 流式处理 + 输入交互。不管连接/认证/模式切换（那是 chat-connection / chat-modes 的事）。
 *
 * 链路：Extension → postMessage(messageAdded/streamUpdate/...) → chat.js 路由 → 本模块 handler → DOM 渲染
 *       用户操作（发送/编辑/删除/回档）→ vscode.postMessage → Extension → beilu 后端
 * 影响：操作 DOM(#messageList)、写 state.messages/streamingContent、启停 setInterval(审批轮询)、requestAnimationFrame(流式渲染)
 * 相交：← chat.js(消息路由)  → chat-core.js(YB.dom/state/vscode/escapeHtml)
 *        → chat-modes.js(clearAllShimmers/renderSubModeBar 等跨域调用)
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — display regex 规则缓存 + thinking tag 配置（动态匹配，替代硬编码）
 *   — 渲染对齐纯函数（2026-07-10 本体权威等值移植）：_stripOuterCodeFence /
 *           _protectCodeSegments / _protectJsonSegments+restore / _computeReplacement /
 *           _applyDisplayRegex（含 priority/depth/scope/user跳过/代码块保护，规则预编译在 onRegexRules）
 *   — onRegexRules / onThinkingTagsConfig（后端推送配置回调）
 *   — 消息视图入口：switchToChat / applySwitchedChat / onChatInitialData
 *          不要把 applySwitchedChat 改成回发 switchChat——会触发死循环（防回环设计）
 *   — 消息生命周期 handler：onMessageAdded / onMessageReplaced / onMessageDeleted / onMessageEdited
 *   — 回档：onRollbackResult / showRollbackPreview（含文件变更列表 UI）
 *   — 流式处理：onStreamStart / onStreamUpdate / _extractStreamThinking（统一思维链提取器，
 *           静态/流式/parseMessageContent 三处共用）/ flushStreamRender（流式 markdown 渲染+80ms节流）
 *   — 打字指示器：onTypingStatus / updateTypingIndicator
 *   — 消息列表渲染：renderAllMessages / appendMessageRow
 *   — IDE 工具结果行：_createIdeToolResultRow / _appendIdeToolCallChips
 *   — 单条消息 DOM：createMessageRow / updateMessageRow（含操作按钮绑定）
 *   — 编辑模式：enterEditMode（textarea 就地替换 + 保存/取消）
 *   — 消息体渲染：renderMessageBody / parseMessageContent
 *   — 内容类型检测 + 占位符保护：_detectContentType / _protectHtmlBlocks
 *   — HTML 渲染管线：stripOperationTags / simpleMarkdown / _applyCodeFold / getDisplayHtml
 *          getDisplayHtml 三分支：full-html→iframe / content_for_show→marked+占位符 / fallback→parseMessageContent
 *   — 内联确认弹窗 showInlineConfirm（替代不可用的 window.confirm）
 *   — 输入区：updateInputState / sendMessage / 粘贴附件 / 代码块复制按钮
 *   — IDE 审批 dock（聊天视图内嵌审批面板，与 chat-modes 的 IDE 审批弹窗不同）
 *   — resync / reconnect / missedMessages（断线重连增量补拉）
 *   — 导出到 YB 命名空间
 */
// =====================================================
// chat-messages.js — 消息层 (V2 两视图重构)
// 消息渲染、编辑模式、流式处理、输入处理、打字指示
// =====================================================

(function () {
  "use strict";
  try {
  var YB = window.YB;
  var dom = YB.dom;
  var state = YB.state;
  var vscode = YB.vscode;
  var escapeHtml = YB.escapeHtml;
  var scrollToBottom = YB.scrollToBottom;
  var formatTimestamp = YB.formatTimestamp;
  var showView = YB.showView;

  // ── display regex 规则缓存 ──────────────────────
  var _displayRegexRules = [];
  var _displayRegexLoaded = false;

  // ── thinking tag 配置（从本体 beilu-memory 配置读取，替代硬编码） ──
  // 默认值与本体 displayRegex.mjs:32 一致：'thinking,think'
  var _thinkingTags = ["thinking", "think"];

  // （旧三个 thinking 正则构建器已删：提取统一走 _extractStreamThinking，2026-07-10 渲染对齐）

  /**
   * 解析 /pattern/flags 格式正则字符串为 RegExp
   * @param {string} input
   * @returns {RegExp|null}
   */
  function _parseRegex(input) {
    if (!input) return null;
    var m = input.match(/^\/([\s\S]+?)\/([gimsuy]*)$/);
    if (!m) {
      try { return new RegExp(input, "g"); } catch (_) { return null; }
    }
    try { return new RegExp(m[1].replace(/\\\//g, "/"), m[2]); } catch (_) { return null; }
  }

  // ══════════════════════════════════════════════════════════════
  // 渲染对齐（2026-07-10 凛倾「对话渲染也有点问题」）：以下纯函数=本体权威实现等值移植。
  // 权威源：displayRegex.mjs（stripOuterCodeFence/protectMarkdownCodeSegments/applySingleRule/
  //   applyDisplayRules）+ regexCore.mjs（computeReplacement/protectJsonSegments/
  //   restoreProtectedSegments/REGEX_MAX_INPUT_LENGTH）。改语义须两侧同改（本体是单源，此为
  //   跨库副本——YonBan 无法 import 本体前端 mjs，webview 非 module 加载）。
  // 旧"简化版"病灶：无代码块保护（规则误伤 IDE 场景大量 ``` 代码块）、无 priority 排序、
  //   user 消息也被应用、{{match}}/$<name>/trimStrings/depth/scope 全缺、每条消息重编译正则。
  // ══════════════════════════════════════════════════════════════

  /** 剥离包裹整个消息的外层代码围栏（本体 stripOuterCodeFence 同款：内部有行首```不剥） */
  function _stripOuterCodeFence(content) {
    if (!content || typeof content !== "string") return content;
    var trimmed = content.trim();
    var m = trimmed.match(/^```(\w*)\s*\n([\s\S]*)\n```\s*$/);
    if (!m) return content;
    if (/^```/m.test(m[2])) return content;
    return m[2];
  }

  /** 保护 ```块``` 与 `行内码`（本体 protectMarkdownCodeSegments 同款），返回 {text, restore} */
  function _protectCodeSegments(text) {
    if (!text || typeof text !== "string") {
      return { text: text || "", restore: function (v) { return v || ""; } };
    }
    var placeholders = [];
    function stash(segment) {
      var token = "@@BEILU_CODE_" + placeholders.length + "@@";
      placeholders.push({ token: token, segment: segment });
      return token;
    }
    var protectedText = text.replace(/```[\s\S]*?```/g, stash).replace(/`[^`\n]*`/g, stash);
    return {
      text: protectedText,
      restore: function (value) {
        var restored = value || "";
        for (var i = 0; i < placeholders.length; i++) {
          restored = restored.split(placeholders[i].token).join(placeholders[i].segment);
        }
        return restored;
      },
    };
  }

  // 受保护结构化标签 + 代码块（regexCore protectJsonSegments 同款，#75）
  var _PROTECTED_TAGS = ["UpdateVariable", "JSONPatch", "ideToolCall"];
  var _PROTECT_PREFIX = "PROTECTSEG";
  var _REGEX_MAX_INPUT_LENGTH = 1000000; // regexCore.mjs REGEX_MAX_INPUT_LENGTH 等值镜像

  function _protectJsonSegments(text) {
    if (!text || typeof text !== "string") return { text: text, segments: [] };
    var segments = [];
    var out = text.replace(/```[\s\S]*?```/g, function (m) {
      var token = _PROTECT_PREFIX + segments.length + "X";
      segments.push(m); return token;
    });
    for (var i = 0; i < _PROTECTED_TAGS.length; i++) {
      var tag = _PROTECTED_TAGS[i];
      var re = new RegExp("<" + tag + "\\b[^>]*?/>|<" + tag + "\\b[^>]*?>[\\s\\S]*?</" + tag + ">", "gi");
      out = out.replace(re, function (m) {
        var token = _PROTECT_PREFIX + segments.length + "X";
        segments.push(m); return token;
      });
    }
    return { text: out, segments: segments };
  }

  function _restoreProtectedSegments(text, segments) {
    if (!segments || segments.length === 0 || !text || typeof text !== "string") return text;
    var out = text;
    // 倒序：防 PROTECTSEG1X 被 PROTECTSEG10X 前缀吃掉
    for (var i = segments.length - 1; i >= 0; i--) {
      out = out.split(_PROTECT_PREFIX + i + "X").join(segments[i]);
    }
    return out;
  }

  /** 替换模板计算（regexCore computeReplacement 同款：{{match}}→$0、$N/$<name>、trimList、未匹配组=空串） */
  function _computeReplacement(replaceStr, match, groups, trimList, namedGroups) {
    var target = match;
    var ti;
    if (trimList && trimList.length > 0) {
      for (ti = 0; ti < trimList.length; ti++) target = target.split(trimList[ti]).join("");
    }
    var result = (replaceStr || "").replace(/\{\{match\}\}/gi, "$0");
    result = result.replace(/\$(\d+)|\$<([^>]+)>/g, function (_ph, num, groupName) {
      var value;
      if (num !== undefined) {
        var idx = Number(num);
        value = idx === 0 ? target : groups[idx - 1];
      } else if (groupName !== undefined) {
        value = namedGroups ? namedGroups[groupName] : undefined;
      }
      if (value === undefined || value === null) return "";
      var filtered = String(value);
      if (trimList && trimList.length > 0) {
        for (ti = 0; ti < trimList.length; ti++) filtered = filtered.split(trimList[ti]).join("");
      }
      return filtered;
    });
    return result;
  }

  /** 本体 _normPresetName 同款（preset scope 比对用） */
  function _normPresetName(s) {
    return s == null ? "" : String(s).replace(/\.json$/i, "").replace(/[_\s]+/g, " ").trim();
  }

  /**
   * display regex 应用（本体 applyDisplayRules 语义对齐版）。
   * @param {string} text - markdown 渲染前的文本
   * @param {{role?:string, messageDepth?:number}} [ctx] - 渲染上下文
   * 与本体差异（如实）：无 assessRegexComplexity ReDoS 静态预检（仅输入长度上限，YonBan
   *   是 owner 自用 IDE 面板威胁面小于可导入角色卡，待决）；block-level 结果占位符保护由
   *   调用方既有 YB_PH/_protectHtmlBlocks 机制承担，不另建 beilu-ph Map。
   */
  function _applyDisplayRegex(text, ctx) {
    if (!_displayRegexRules.length || !text) return text;
    if (text.length > _REGEX_MAX_INPUT_LENGTH) return text;
    // 本体 :626 同款：用户消息不应用（防美化正则吃掉用户消息）
    if (ctx && ctx.role === "user") return text;
    var depth = (ctx && typeof ctx.messageDepth === "number") ? ctx.messageDepth : 0;
    var charName = state.selectedChar || "";
    var activePreset = _normPresetName(state.activePreset || "");

    // #75-①：代码块/结构化标签保护——规则不误伤 ```代码块```/<ideToolCall> 等段
    var prot = _protectJsonSegments(text);
    var work = prot.text;

    for (var i = 0; i < _displayRegexRules.length; i++) {
      var rule = _displayRegexRules[i]; // onRegexRules 已按 priority 排序+预编译
      // 深度范围（本体 :643 同款）
      var minD = rule.minDepth != null ? rule.minDepth : -1;
      var maxD = rule.maxDepth != null ? rule.maxDepth : 0;
      if (minD >= 0 && depth < minD) continue;
      if (maxD > 0 && depth > maxD) continue;
      // 作用域（本体 :648/:654 同款）
      if (rule.scope === "scoped" && rule.boundCharName && rule.boundCharName !== charName) continue;
      if (rule.scope === "preset") {
        var rp = _normPresetName(rule.boundPresetName);
        if (rp && rp !== activePreset) continue;
      }
      var re = rule._compiledRe;
      if (!re) continue;
      var trimList = rule._trimList || [];
      try {
        work = work.replace(re, function (match) {
          var args = Array.prototype.slice.call(arguments, 1);
          // 剥离末尾 offset/fullString/namedGroups，留真捕获组（regexCore extractCaptureGroups 同款）
          var lastArg = args.length > 0 ? args[args.length - 1] : null;
          var namedGroups = (typeof lastArg === "object" && lastArg !== null) ? lastArg : null;
          var cut = namedGroups ? 3 : 2;
          var groups = args.slice(0, Math.max(0, args.length - cut));
          var result = _computeReplacement(rule.replaceString || "", match, groups, trimList, namedGroups);
          // 本体 :548 同款：剥替换结果外层围栏（美化正则惯例用```包 HTML）
          result = _stripOuterCodeFence(result);
          return (!result || result.trim() === "") ? "" : result;
        });
      } catch (_) { /* invalid regex runtime, skip */ }
    }

    return _restoreProtectedSegments(work, prot.segments);
  }

  /**
   * 处理从 extension host 收到的 regexRules 消息
   * @param {object} data - { rules, enabled }
   */
  YB.onRegexRules = function (data) {
    if (!data || !data.enabled || !Array.isArray(data.rules)) {
      _displayRegexRules = [];
      _displayRegexLoaded = true;
      return;
    }
    // 对齐本体 loadDisplayRules+applyDisplayRules：接收时一次性完成
    //   ①display 筛选（!disabled && markdownOnly && placement 含 ai_output/display/0/2 或无 placement）
    //   ②priority 稳定排序（小者先，缺省=100，本体 DEFAULT_DISPLAY_RULE_PRIORITY）
    //   ③findRegex/trimStrings 预编译缓存（旧码每条消息×每条规则重 new RegExp）
    var filtered = [];
    for (var ri = 0; ri < data.rules.length; ri++) {
      var r = data.rules[ri];
      if (r.disabled || !r.markdownOnly) continue;
      var pl = r.placement;
      if (pl && Array.isArray(pl)) {
        var hit = false;
        for (var pj = 0; pj < pl.length; pj++) {
          var p = pl[pj];
          if (p === "ai_output" || p === "display" || p === 0 || p === 2) { hit = true; break; }
        }
        if (!hit) continue;
      } else if (pl) {
        continue;
      } // placement undefined/null + markdownOnly => pass (W53-4A)
      r._compiledRe = _parseRegex(r.findRegex);
      if (!r._compiledRe) continue;
      r._trimList = r.trimStrings
        ? (Array.isArray(r.trimStrings) ? r.trimStrings : String(r.trimStrings).split("\n")).filter(function (s) { return s.length > 0; })
        : [];
      filtered.push(r);
    }
    filtered.sort(function (a, b) {
      var pa = typeof a.priority === "number" ? a.priority : 100;
      var pb = typeof b.priority === "number" ? b.priority : 100;
      return pa - pb; // Array.prototype.sort 现代引擎稳定，同优先级保持原序
    });
    _displayRegexRules = filtered;
    _displayRegexLoaded = true;
  };

  /**
   * 处理从 extension host 收到的 thinkingTagsConfig 消息
   * 同步本体 beilu-memory 配置中的思维链标签列表，替代硬编码
   * @param {object} data - { tags: string[] }
   */
  YB.onThinkingTagsConfig = function (data) {
    if (data && Array.isArray(data.tags) && data.tags.length > 0) {
      _thinkingTags = data.tags;
      // 收口到单源：本模块私有 _thinkingTags 是渲染消费点，但显示设置弹窗（chat.js
      // showDisplaySettingsPopup）读的是 YB._thinkingTags。原本此字段无任何写点=永远 undefined，
      // 弹窗只能回落写死 ["thinking","think"]，看不到后端下发的自定义标签（半接线）。此处把
      // producer 更新同步暴露到命名空间，两个 consumer（渲染 + 配置弹窗）读同一权威源。
      YB._thinkingTags = _thinkingTags;
    }
  };

  function _replaceMacros(text) {
    if (!text || typeof text !== "string" || text.indexOf("{{") === -1) return text;
    var charName = state.selectedChar || "";
    var userName = "";
    for (var mi = 0; mi < state.messages.length; mi++) {
      var mm = state.messages[mi];
      if (!charName && mm.role === "char" && mm.name) charName = mm.name;
      if (!userName && mm.role === "user" && mm.name) userName = mm.name;
      if (charName && userName) break;
    }
    return text
      .replace(/\{\{char\}\}/gi, charName || "角色")
      .replace(/\{\{user\}\}/gi, userName || "用户");
  }

  // ═══════════════════════════════════════════════════════
  // 消息视图入口
  // ═══════════════════════════════════════════════════════

  // ★ UI 同步部分（不发后端 switchChat）。switchToChat 与 applySwitchedChat 共用，
  //   后者由右板块经 chatSwitched 触发——只更新左对话 UI 态，绝不回发 switchChat（防回环，见设计第3问）。
  function _applyChatUiState(chatId, chatMeta) {
    state.messages = [];
    state.isGenerating = false;
    state.generatingMessageId = null;
    state.streamingContent = {};
    stopApprovalPoll();
    _renderPendingSends(); // [0719 中途输入] 切对话刷新待发送区（只显示本对话的排队条目）
    if (YB.clearAllShimmers) YB.clearAllShimmers();
    _lastApprovalCount = 0;
    if (dom.messageList) {
      dom.messageList.innerHTML =
        '<div class="loading-placeholder">加载中…</div>';
    }
    updateTypingIndicator([]);

    state.currentChatId = chatId;
    state.charlist = [];

    // ★ [卡↔对话归属校验 0727 凛倾实测] 「角色卡」与「当前对话」在本 webview 里是两个**分别持久化、
    //   分别恢复**的状态（chat-connection.js:328-329 / chat-core.js:551-552 各自赋值），中间没有
    //   任何一处校验「这条对话属于这张卡」。后果（实测落盘为证）：窗口标题拼的是 state.selectedChar
    //   （本窗自己的卡），内容渲染的是 chatId 那条对话——出现「标题：代码002项目修复 / 内容：代码001
    //   的 6.5MB 对话」，两个 VSCode 窗口于是看着像在显示同一份内容。
    //   【为什么以对话为准而不是以卡为准】到这一步内容已经按 chatId 拉了，卡只是个显示/上下文标签；
    //   拿对话的真实归属去校正卡，两者立刻一致。反过来（按卡改 chatId）会把用户明确点开的对话换掉。
    //   归属字段与本体 getChatList 同源（primaryCharName 优先，回退 chars[0]）；取不到就不动，
    //   不猜、不编（无 meta 的路径照旧，向后兼容）。
    //   ⚠ chatMeta 常常是 null——恢复路径（chat-connection.js:345 switchToChat(chatId, null)）与
    //   peer 跟随都不带 meta，而**恢复正是错配最常发生的时刻**（卡和对话各自从存储恢复）。
    //   只认传入 meta 的话，这个校验在最需要它的路径上永不触发＝许愿代码。故回查 state.allChats
    //   （applySwitchedChat:378 已有同款回查范式）。allChats 尚未到达时取不到 → 不动，
    //   由 onChatInitialData 那一层补校（数据到齐时必然能判）。
    var _ownerMeta = chatMeta;
    if (!_ownerMeta && Array.isArray(state.allChats)) {
      _ownerMeta = state.allChats.filter(function (c) { return c && c.chatid === chatId; })[0] || null;
    }
    var _chatOwner = _ownerMeta && (_ownerMeta.primaryCharName ||
      (Array.isArray(_ownerMeta.chars) ? _ownerMeta.chars[0] : ""));
    if (_chatOwner && _chatOwner !== state.selectedChar) {
      console.log("[chat-messages] 卡↔对话归属校正:", state.selectedChar, "→", _chatOwner, "(chat=" + chatId + ")");
      state.selectedChar = _chatOwner;
    }

    // 持久化用户选择（校正后的卡一并落盘，否则下次恢复又是错配的那一对）
    YB.saveUserState();

    _setChatTitle(_ownerMeta || chatMeta);

    showView("chat");
    updateInputState();
    YB.startTokenPoll();
    YB.startMemoryPoll();
    YB.renderSubModeBar();
  }

  /** 顶栏标题单源：「角色卡 / 对话名」。收成一处，因为卡被归属校正后**两个时点**都要重刷
   *  （切换时 + initial-data 到达时），各写一份必然漂移成两种拼法。 */
  function _setChatTitle(chatMeta) {
    var title =
      (chatMeta && chatMeta.customName) ||
      (chatMeta && chatMeta.firstUserMessage
        ? chatMeta.firstUserMessage.slice(0, 20)
        : null) ||
      "聊天";
    if (dom.chatTitle) {
      var fullTitle = state.selectedChar ? state.selectedChar + " / " + title : title;
      dom.chatTitle.textContent = fullTitle;
      dom.chatTitle.title = fullTitle;
    }
  }

  function switchToChat(chatId, chatMeta, opts) {
    // 只发切换意图；Provider 完成 IDE 绑定并提交新 WS 后，用 chatSwitched 回执提交 UI。
    // 绑定失败时保留旧对话，避免“界面已切、连接未切”的半提交状态。
    vscode.postMessage({
      type: "switchChat",
      payload: { chatId: chatId, announceActive: !opts || opts.announceActive !== false },
    });
  }

  // ★ 右板块（右副侧栏）切对话时，左 Provider 已经在后端切好并推 chatInitialData，
  //   这里只补 UI 态同步（标题/视图/轮询），不再回发 switchChat → 不会触发后端二次切换/死循环。
  function applySwitchedChat(chatId, chatMeta) {
    // chatSwitched 现在是 Provider 的成功提交回执，且固定先于 chatInitialData；即使恢复态里
    // currentChatId 已预载成同值，也必须应用一次 UI（否则会停在设置页）。
    var meta = chatMeta;
    if (!meta && Array.isArray(state.allChats)) {
      meta = state.allChats.filter(function (c) { return c.chatid === chatId; })[0] || null;
    }
    _applyChatUiState(chatId, meta);
  }

  function onChatInitialData(payload) {
    // [多窗时序 0726] 归属校验（指令带id·消费端识别同款范式）：payload.chatId=数据所属对话
    //   （switchChat/_refreshChatInitialData 发起时锚定）。await 间隙切走后晚到的旧推送若不带闸，
    //   会把旧对话的消息渲进当前对话视图。无 chatId 的旧生产端/异常体照旧放行（向后兼容）。
    if (payload && payload.chatId && state.currentChatId && payload.chatId !== state.currentChatId) {
      console.log("[YonBan] 忽略过期 chatInitialData:", payload.chatId, "当前:", state.currentChatId);
      return;
    }
    if (payload && payload.error) {
      if (dom.messageList) {
        dom.messageList.innerHTML =
          '<div class="loading-placeholder">加载失败: ' +
          escapeHtml(payload.error) +
          "</div>";
      }
      return;
    }

    state.messages = payload.initialLog || [];
    var logLength = payload.logLength || state.messages.length;
    state.logOffset = logLength - state.messages.length;
    state.charlist = payload.charlist || [];
    // ★ [卡↔对话归属校验·第二道 0727] charlist = 本对话的真实角色列表（本体 initial-data 权威）。
    //   第一道在 _applyChatUiState，但那时 allChats 可能还没到（窗口刚恢复正是这种时刻）；
    //   数据到齐的这一刻必然能判：当前卡不在本对话的角色列表里 = 标题挂着别的卡，校正过来。
    //   charlist 为空（异常/旧体）不动——不猜、不编。
    if (Array.isArray(state.charlist) && state.charlist.length) {
      var _names = state.charlist.map(function (c) { return (typeof c === "string") ? c : (c && (c.name || c.charname)) || ""; });
      if (state.selectedChar && _names.indexOf(state.selectedChar) === -1) {
        console.log("[chat-messages] 卡↔对话归属校正(initial-data):", state.selectedChar, "→", _names[0]);
        state.selectedChar = _names[0];
        YB.saveUserState();
        var _m = Array.isArray(state.allChats)
          ? state.allChats.filter(function (c) { return c && c.chatid === state.currentChatId; })[0]
          : null;
        _setChatTitle(_m);
      }
    }
    renderAllMessages();
    showView("chat");
    scrollToBottom(true);
  }

  // ═══════════════════════════════════════════════════════
  // 消息事件
  // ═══════════════════════════════════════════════════════

  function onMessageAdded(entry) {
    // [0811 幂等守卫] 同 id 消息在数据层+DOM 层至多一份（单入口不变量）：后端重发/补拉时序重叠时
    // 直接丢弃重复 add——否则同 id 双行后 onMessageReplaced/flushStreamRender 的 querySelector 只更新
    // 首行，第二行永久残留旧态（web 端双"正在想"同族病，YonBan 侧预防性封死）。
    if (entry && entry.id && state.messages.some(function (m) { return m && m.id === entry.id; })) return;
    state.messages.push(entry);
    // U06：用户自己的消息回推到达 = 后端已收下本次发送 = 成功 → 此刻才清输入框（deferred clear）。
    //   放在 system 过滤之前：用户消息 role=user 不会被下面的 system 过滤拦掉，但确认清空与渲染解耦，先确认。
    if (entry.role === "user") _clearInputAfterSendAck();
    // system 消息不渲染到UI；B4/Y3 例外：ide_tool_result 渲染为折叠卡（对用户折叠可展开=G8）
    var _isToolResult = !!(entry.extension && entry.extension._opType === "ide_tool_result");
    if ((entry.role === "system" || entry.name === "系统" || entry.name === "IDE工具结果") && !_isToolResult) return;
    if (entry.is_generating) {
      state.isGenerating = true;
      state.generatingMessageId = entry.id;
      state.streamingContent[entry.id] = "";
    }
    appendMessageRow(entry, state.messages.length - 1);
    scrollToBottom();
    updateInputState();
  }

  /**
   * 消息替换（生成完成 / swipe 切换）。
   *
   * 链路：后端 message_replaced → Extension → postMessage("messageReplaced") → chat.js 路由 → 这里
   * 影响：清除流式状态(streamingContent/isGenerating)、更新 DOM、刷 token/记忆/审批、
   *       同步 AI 触发的子模式/预设切换(W66)
   * 约束：localIdx = data.index - state.logOffset（后端发绝对索引，本地只持有尾部窗口，需减偏移）
   */
  function onMessageReplaced(data) {
    var index = data.index;
    var entry = data.entry;
    var localIdx = index - state.logOffset;
    if (localIdx >= 0 && localIdx < state.messages.length) {
      state.messages[localIdx] = entry;
    }

    if (state.generatingMessageId) {
      delete state.streamingContent[state.generatingMessageId];
    }
    state.isGenerating = false;
    state.generatingMessageId = null;
    // [0811] 生成落定即清打字指示器（对齐 web virtualQueue message_replaced 后清除）：原先只靠后端
    // 推空 typing_status，漏发/断连时指示器永不清除（无超时逃生）。落定事件本身就是权威清除信号。
    if (!entry.is_generating) updateTypingIndicator([]);

    var row = dom.messageList
      ? dom.messageList.querySelector('[data-msg-id="' + entry.id + '"]')
      : null;
    if (row) {
      updateMessageRow(row, entry);
    } else {
      var allRows = dom.messageList
        ? dom.messageList.querySelectorAll(".message-row")
        : [];
      if (allRows[localIdx]) updateMessageRow(allRows[localIdx], entry);
    }

    scrollToBottom();
    updateInputState();
    YB.fetchTokenSnapshot();
    YB.fetchMemoryStatus();
    // AI 消息完成后检查是否有待审批的写操作
    startApprovalPoll();

    // W66: AI触发的子模式/预设切换 → 同步YonBan底栏+模型
    if (!entry.is_generating && entry.role !== "user" && entry.extension) {
      var ext = entry.extension;
      // 子模式切换
      if (ext._subModeSwitch && ext._subModeSwitch.to) {
        state.activeSubMode = ext._subModeSwitch.to;
        // 查找子模式数据，同步绑定的模型
        var allModes = state.subModes.length > 0 ? state.subModes : [];
        var targetSm = allModes.find(function (m) { return m.id === ext._subModeSwitch.to; });
        if (targetSm && targetSm.modelName) {
          vscode.postMessage({ type: "switchModel", payload: { modelName: targetSm.modelName } });
          console.log("[YonBan] AI模型切换:", targetSm.modelName);
        }
        if (typeof YB.renderSubModeBar === "function") YB.renderSubModeBar();
        if (typeof YB.renderSubModePanel === "function") YB.renderSubModePanel();
        console.log("[YonBan] AI子模式切换:", ext._subModeSwitch.from, "→", ext._subModeSwitch.to);
      }
      // T046（子模式预设接入预设系统）：移除 AI 驱动切子模式的「前端强制 switchPreset」联动（YonBan 侧
      //   消费端，对应本体 websocket.mjs:314 的移除 + replyHandler 4 处生产端已停发 _subModeSwitchPreset）。
      //   why：前端强制切预设=死绑，覆盖预设系统当前态；子模式预设隔离改由后端生成时按子模式绑定完成
      //   （getPromptHandler.mjs T046 块，读 per-user 可配 sub_modes[].presetName）。生产端已停发本字段，
      //   此消费分支同步删除防死分支复活联动。
    }
  }

  function onMessageDeleted(data) {
    var index = data.index;
    var localIdx = index - state.logOffset;
    if (localIdx >= 0 && localIdx < state.messages.length) {
      if (!state.messages[localIdx].extension) state.messages[localIdx].extension = {};
      state.messages[localIdx].extension._deleted = true;
    }
    renderAllMessages();
  }

  // ★ T009 P4：编辑广播版本协商（替代旧 5s setTimeout 时序锁）。
  //   旧锁的病根=编辑回显 entry 缺 content_for_show 会覆盖本地内容（字段契约已在后端 toData 出口修复），
  //   锁用定时器赌广播 5s 内到达：>5s 慢广播穿透覆盖用户编辑、<5s 内他端合法编辑被误吞。
  //   现机制：entry._editVersion（后端 editMessage 每次 +1）——
  //     广播版本 ≤ 本地已应用版本 = 过期/乱序/回声 → 丢弃；
  //     该行正处编辑态 → 挂起最新广播，退出编辑（保存/取消）时应用，不打断输入。
  var _pendingEditedBroadcasts = {}; // chatId\0msgId → 编辑期间收到的最新权威版本

  function editAuthorityKey(chatId, messageId) {
    return String(chatId || "") + "\u0000" + String(messageId || "");
  }

  function editVersionOf(entry) {
    return entry && Number.isSafeInteger(entry._editVersion) && entry._editVersion > 0
      ? entry._editVersion
      : null;
  }

  /** HTTP ack / WS / 编辑期 pending 的唯一应用口：按 chatId+messageId 定位，版本只能前进。 */
  function applyAuthoritativeEdit(chatId, entry, options) {
    options = options || {};
    if (!chatId || chatId !== state.currentChatId || !entry || typeof entry.id !== "string" || !entry.id) {
      return { applied: false, reason: "owner_or_message_mismatch" };
    }
    var version = editVersionOf(entry);
    if (version === null) return { applied: false, reason: "invalid_edit_version" };
    var localIdx = state.messages.findIndex(function (message) {
      return message && message.id === entry.id;
    });
    if (localIdx < 0 || localIdx >= state.messages.length) {
      return { applied: false, reason: "message_not_rendered" };
    }
    var localMsg = state.messages[localIdx];
    var localVersion = editVersionOf(localMsg) || 0;
    if (version <= localVersion) {
      return { applied: false, stale: true, version: version };
    }

    var row = dom.messageList
      ? dom.messageList.querySelector('[data-msg-id="' + entry.id + '"]')
      : null;
    var key = editAuthorityKey(chatId, entry.id);
    if (options.deferWhileEditing && row && row.classList.contains("editing")) {
      var previous = _pendingEditedBroadcasts[key];
      if (!previous || version > (editVersionOf(previous.entry) || 0)) {
        _pendingEditedBroadcasts[key] = {
          chatId: chatId,
          entry: entry,
          editOperationId: options.editOperationId || null,
          payloadFingerprint: options.payloadFingerprint || null,
        };
      }
      return {
        applied: false,
        deferred: true,
        version: version,
        editOperationId: options.editOperationId || null,
      };
    }

    state.messages[localIdx] = entry;
    if (row) updateMessageRow(row, entry);
    var pending = _pendingEditedBroadcasts[key];
    if (pending && (editVersionOf(pending.entry) || 0) <= version) {
      delete _pendingEditedBroadcasts[key];
    }
    return { applied: true, version: version };
  }

  function onMessageEdited(data) {
    if (!data || typeof data !== "object") return;
    var result = applyAuthoritativeEdit(data.chatId, data.entry, {
      deferWhileEditing: true,
      editOperationId: data.editOperationId,
      payloadFingerprint: data.payloadFingerprint,
    });
    if (result.applied !== true && result.deferred !== true && result.stale !== true) {
      console.warn("[chat-messages] message_edited 未应用:", result.reason, data.chatId, data.entry && data.entry.id);
    }
  }

  /** REST 编辑事务的明确 ack：失败保留 textarea，成功只应用后端权威 entry。 */
  function onEditMessageResult(data) {
    if (!data || !data.messageId) return;
    if (data.chatId && state.currentChatId && data.chatId !== state.currentChatId) return;
    var row = dom.messageList
      ? dom.messageList.querySelector('[data-msg-id="' + data.messageId + '"]')
      : null;
    if (data.success !== true || data.applied !== true || data.chatCommitted !== true) {
      var wsReceipt = applyPendingEditedBroadcast(data.chatId, data.messageId, data.editOperationId);
      if (wsReceipt && wsReceipt.applied === true) {
        if (row) row.classList.remove("editing");
        YB.showToast("HTTP 回执丢失，但已通过同一编辑操作的权威同步确认提交", 3500);
        return;
      }
      var saveButton = row && row.querySelector(".msg-edit-actions .btn-primary");
      if (saveButton) saveButton.disabled = false;
      return;
    }

    var localIdx = state.messages.findIndex(function (message) {
      return message && message.id === data.messageId;
    });
    if (data.entry && data.entry.id === data.messageId && localIdx >= 0) {
      var ackApply = applyAuthoritativeEdit(data.chatId, data.entry, {
        deferWhileEditing: false,
        editOperationId: data.editOperationId,
        payloadFingerprint: data.payloadFingerprint,
      });
      if (ackApply.applied !== true && row) updateMessageRow(row, state.messages[localIdx]);
    } else if (row && localIdx >= 0) {
      // 已提交但响应条目缺失时不把输入内容当真值；Provider 会按原 chatId 发起权威刷新。
      updateMessageRow(row, state.messages[localIdx]);
    }
    if (row) row.classList.remove("editing");
    applyPendingEditedBroadcast(data.chatId, data.messageId);
  }

  // 退出编辑态后应用编辑期间挂起的最新广播（服务端真值，含 _editVersion/渲染字段）
  function applyPendingEditedBroadcast(chatId, msgId, expectedOperationId) {
    var key = editAuthorityKey(chatId, msgId);
    var data = _pendingEditedBroadcasts[key];
    if (!data) return { applied: false, reason: "pending_edit_missing" };
    if (expectedOperationId && data.editOperationId !== expectedOperationId) {
      return { applied: false, reason: "pending_edit_operation_mismatch" };
    }
    delete _pendingEditedBroadcasts[key];
    return applyAuthoritativeEdit(chatId, data.entry, {
      deferWhileEditing: false,
      editOperationId: data.editOperationId,
      payloadFingerprint: data.payloadFingerprint,
    });
  }

  // ═══════════════════════════════════════════════════════
  // 回档处理
  // ═══════════════════════════════════════════════════════

  function rollbackDeletedCount(data) {
    var coordinated = data && data.chat && data.chat.deletedCount;
    if (typeof coordinated === "number" && Number.isFinite(coordinated)) return coordinated;
    var legacy = data && data.deleted;
    return typeof legacy === "number" && Number.isFinite(legacy) ? legacy : null;
  }

  function rollbackFileResult(data) {
    var coordinated = data && data.memory && data.memory.fileRollback;
    if (coordinated && typeof coordinated === "object") return coordinated;
    var legacy = data && data.fileRollback;
    return legacy && typeof legacy === "object" ? legacy : null;
  }

  function rollbackMetric(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function readMemoryArchiveCoverage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.status !== "not_covered" ||
        value.coveredByLedger !== false ||
        value.affectedOperations !== null ||
        value.restoredOperations !== 0 ||
        typeof value.reason !== "string" ||
        !value.reason.trim()) return null;
    return value;
  }

  var _CONNECTED_IDE_ROUTE_KEYS = ["connected", "backendKind", "port", "instanceId", "connectionId"];

  /** 复制并冻结后端 preview 的精确连接代次；缺字段、额外字段或类型错误一律返回 null。 */
  function copyExactIdeRouteToken(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    var keys = Object.keys(value);
    if (value.connected === false) {
      return keys.length === 1 && keys[0] === "connected"
        ? Object.freeze({ connected: false })
        : null;
    }
    if (value.connected !== true || keys.length !== _CONNECTED_IDE_ROUTE_KEYS.length) return null;
    for (var i = 0; i < _CONNECTED_IDE_ROUTE_KEYS.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, _CONNECTED_IDE_ROUTE_KEYS[i])) return null;
    }
    if (value.backendKind !== null && value.backendKind !== "yonban" && value.backendKind !== "cli") return null;
    if (!Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535) return null;
    if (value.instanceId !== null && (typeof value.instanceId !== "string" || !value.instanceId)) return null;
    if (typeof value.connectionId !== "string" || !value.connectionId) return null;
    return Object.freeze({
      connected: true,
      backendKind: value.backendKind,
      port: value.port,
      instanceId: value.instanceId,
      connectionId: value.connectionId,
    });
  }

  function onRollbackResult(data) {
    var memoryArchive = readMemoryArchiveCoverage(data && data.memoryArchive);
    var backendSucceeded = !!(
      data &&
      data.success === true &&
      data.partial !== true
    );
    var backendApplied = !!(
      backendSucceeded &&
      data.applied === true &&
      data.noOp !== true
    );
    var backendNoOp = !!(
      backendSucceeded &&
      data.applied === false &&
      data.noOp === true
    );
    var detail = data && (data.warning || data.safetyRollbackError || data.rollbackWarning || data.error);
    var deletedCount = rollbackDeletedCount(data);
    if (backendSucceeded && !memoryArchive) {
      recordRollback(data);
      console.warn("[chat-messages] 回档成功结果缺少有效的归档记忆覆盖声明:", data);
      YB.showToast("⚠ 后端声称回档成功，但未提供有效的归档记忆覆盖声明；结果不确定，请刷新并人工核对。", 5000);
    } else if (backendSucceeded && data.chat && data.chat.status === "committed_derived_failed") {
      recordRollback(data);
      console.warn("[chat-messages] 主聊天截断已提交，但派生层失败:", data);
      var derivedMsg = "⚠ 主聊天截断已提交，但备份/广播等派生步骤失败；归档记忆仍未覆盖。请刷新并人工核对。";
      if (detail) derivedMsg += " " + detail;
      YB.showToast(derivedMsg, 6000);
    } else if (backendNoOp) {
      console.log("[chat-messages] 当前已处于回档目标状态，无需应用变更");
      recordRollback(data);
      var noOpMsg = "↩ 当前已处于目标状态，无需回档；归档记忆仍未覆盖";
      if (detail) noOpMsg += "：" + detail;
      YB.showToast(noOpMsg, detail ? 4000 : 2500);
    } else if (backendApplied) {
      console.log("[chat-messages] 回档已应用到已支持层，删除消息数:", deletedCount);
      recordRollback(data);
      if (detail) {
        console.warn("[chat-messages] 回档完成但后端返回警告:", detail);
        YB.showToast("⚠ 已回档对话及已支持的数据层；归档记忆文件未回档：" + detail, 4000);
        return;
      }
      var msg = "↩ 已回档对话及已支持的数据层；归档记忆文件未回档";
      msg += deletedCount === null
        ? "（后端未返回删除消息数）"
        : "；已删除 " + deletedCount + " 条消息";
      var fr = rollbackFileResult(data);
      var restored = rollbackMetric(fr && fr.totalRestored);
      var deletedFiles = rollbackMetric(fr && fr.totalDeleted);
      if (restored !== null || deletedFiles !== null) {
        msg += "；文件还原 " + (restored === null ? "未知" : restored) + " 个、删除新建 " + (deletedFiles === null ? "未知" : deletedFiles) + " 个";
      }
      YB.showToast(msg, 2000);
    } else if (data && (data.partial === true || data.safetyRollbackError)) {
      recordRollback(data);
      var partialMsg = detail || "后端报告回档仅部分完成";
      console.warn("[chat-messages] 回档部分完成:", data);
      YB.showToast("⚠ 回档部分完成：" + partialMsg, 5000);
    } else {
      var failMsg = detail || "后端未确认回档已完整应用";
      console.error("[chat-messages] 回档失败:", failMsg);
      YB.showToast("✗ " + failMsg, 3500);
    }
  }

  // ★ P3-4 持久回档记录：用 VSCode webview 官方持久状态（getState/setState），跨 hide/show 保留。
  // 只保留最近 20 条，避免无限增长。失败静默（记录非关键路径，不应影响回档反馈）。
  function recordRollback(data) {
    try {
      var st = (vscode.getState && vscode.getState()) || {};
      var hist = Array.isArray(st.rollbackHistory) ? st.rollbackHistory : [];
      var fr = rollbackFileResult(data);
      var deletedCount = rollbackDeletedCount(data);
      hist.unshift({
        t: Date.now(),
        chatId: data.chatId || "",
        anchorMessageId: data.anchorMessageId || "",
        targetIndex: data.targetIndex,
        success: data.success === true,
        applied: data.applied === true,
        partial: data.partial === true,
        deleted: deletedCount,
        filesRestored: rollbackMetric(fr && fr.totalRestored),
        filesDeleted: rollbackMetric(fr && fr.totalDeleted),
        warning: data.warning || data.safetyRollbackError || data.rollbackWarning || null,
      });
      if (hist.length > 20) hist = hist.slice(0, 20);
      YB.patchState({ rollbackHistory: hist }); // 散写收口 2026-07-13：经 chat-core 单点写

    } catch (e) {
      console.warn("[chat-messages] 记录回档历史失败:", e);
    }
  }

  // ★ P3-1/P3-2 回档预览卡片：收到后端文件层 Δ 后渲染（消息计数 + 还原绿/删除红文件列表），
  // 用户确认才真正 post rollbackToMessage；预览令牌不完整时禁止执行，必须重新预览。
  function onRollbackPreview(data) {
    if (!data) return;
    showRollbackPreview(data);
  }

  function showRollbackPreview(data) {
    var existing = document.getElementById("yb-inline-confirm");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "yb-inline-confirm";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;";

    var box = document.createElement("div");
    box.style.cssText = "background:var(--vscode-editor-background,#1e1e2e);border-radius:10px;padding:16px 20px;max-width:380px;width:88%;max-height:70vh;overflow:auto;box-shadow:0 4px 20px rgba(0,0,0,0.4);color:var(--vscode-foreground,#ccc);";

    var title = document.createElement("div");
    title.style.cssText = "font-size:14px;font-weight:600;margin:0 0 10px;text-align:center;";
    title.textContent = "↩ 回档预览";
    box.appendChild(title);

    // 消息计数（一定有）
    var msgLine = document.createElement("div");
    msgLine.style.cssText = "font-size:13px;margin:0 0 8px;";
    msgLine.textContent = "· 将删除之后 " + (data.afterCount || 0) + " 条消息";
    box.appendChild(msgLine);

    var restore = Array.isArray(data.filesToRestore) ? data.filesToRestore : [];
    var del = Array.isArray(data.filesToDelete) ? data.filesToDelete : [];
    var memoryArchive = readMemoryArchiveCoverage(data.memoryArchive);

    if (data.previewError || data.success === false) {
      var errLine = document.createElement("div");
      errLine.style.cssText = "font-size:12px;margin:0 0 8px;color:#e6a23c;";
      errLine.textContent = "⚠ 回档预览不可用（" + (data.previewError || data.error || "后端拒绝预览") + "），请关闭后重试";
      box.appendChild(errLine);
    } else if (data.expectedIdeConnected === false) {
      var noIde = document.createElement("div");
      noIde.style.cssText = "font-size:12px;margin:0 0 8px;color:#909399;";
      noIde.textContent = "· 未连接 IDE：无文件检查点；表格与消息仍由后端事务统一处理";
      box.appendChild(noIde);
    } else {
      // P3-2 红绿文件列表
      if (restore.length === 0 && del.length === 0) {
        var noFile = document.createElement("div");
        noFile.style.cssText = "font-size:12px;margin:0 0 8px;color:#909399;";
        noFile.textContent = "· 无文件变更（纯对话回档）";
        box.appendChild(noFile);
      }
      if (restore.length > 0) {
        box.appendChild(buildFileList("还原 " + restore.length + " 个文件", restore, "#67c23a"));
      }
      if (del.length > 0) {
        box.appendChild(buildFileList("删除 " + del.length + " 个新建文件", del, "#e53935"));
      }
    }

    var archiveLine = document.createElement("div");
    archiveLine.style.cssText = "font-size:12px;margin:8px 0;color:#e6a23c;font-weight:600;";
    archiveLine.textContent = memoryArchive
      ? "⚠ 归档记忆文件尚未纳入本次回档"
      : "⚠ 后端未声明归档记忆覆盖范围，本次预览不可执行";
    box.appendChild(archiveLine);

    var warn = document.createElement("div");
    warn.style.cssText = "font-size:12px;margin:10px 0 12px;color:#e53935;text-align:center;font-weight:600;";
    warn.textContent = "此操作不可撤销";
    box.appendChild(warn);

    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:center;";

    var confirmBtn = document.createElement("button");
    confirmBtn.style.cssText = "padding:6px 18px;border:none;border-radius:6px;background:#e53935;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
    confirmBtn.textContent = "确认回档";
    var expectedIdeRoute = copyExactIdeRouteToken(data.expectedIdeRoute);
    var previewReady = data.success === true &&
      !data.previewError &&
      typeof data.expectedIdeConnected === "boolean" &&
      expectedIdeRoute !== null &&
      data.expectedIdeConnected === expectedIdeRoute.connected &&
      Array.isArray(data.checkpointIds) &&
      Object.prototype.hasOwnProperty.call(data, "tableSnapshotId") &&
      memoryArchive !== null;
    if (!previewReady) {
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = "0.5";
      confirmBtn.style.cursor = "not-allowed";
      confirmBtn.title = "预览令牌不完整，请重新预览";
    }
    confirmBtn.addEventListener("click", function () {
      if (!previewReady) return;
      overlay.remove();
      vscode.postMessage({
        type: "rollbackToMessage",
        payload: {
          chatId: data.chatId,
          anchorMessageId: data.anchorMessageId,
          targetIndex: data.targetIndex,
          afterCount: data.afterCount,
          expectedIdeConnected: data.expectedIdeConnected,
          expectedIdeRoute: copyExactIdeRouteToken(expectedIdeRoute),
          checkpointIds: data.checkpointIds.slice(),
          tableSnapshotId: data.tableSnapshotId,
        },
      });
    });
    btnRow.appendChild(confirmBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.style.cssText = "padding:6px 18px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:13px;";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", function () { overlay.remove(); });
    btnRow.appendChild(cancelBtn);

    box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // 构建一组文件列表（标题 + 各文件 basename，按颜色区分还原/删除）。用 textContent 防路径注入。
  function buildFileList(heading, files, color) {
    var wrap = document.createElement("div");
    wrap.style.cssText = "margin:0 0 8px;";
    var h = document.createElement("div");
    h.style.cssText = "font-size:12px;font-weight:600;margin:0 0 4px;color:" + color + ";";
    h.textContent = heading;
    wrap.appendChild(h);
    for (var i = 0; i < files.length && i < 30; i++) {
      var item = document.createElement("div");
      item.style.cssText = "font-size:11px;padding:1px 0 1px 10px;color:var(--vscode-descriptionForeground,#aaa);word-break:break-all;";
      var p = String(files[i]);
      var base = p.split(/[\\/]/).pop() || p;
      item.textContent = "· " + base;
      item.title = p;
      wrap.appendChild(item);
    }
    if (files.length > 30) {
      var more = document.createElement("div");
      more.style.cssText = "font-size:11px;padding:1px 0 1px 10px;color:#909399;";
      more.textContent = "… 还有 " + (files.length - 30) + " 个";
      wrap.appendChild(more);
    }
    return wrap;
  }

  // ═══════════════════════════════════════════════════════
  // 流式处理
  // ═══════════════════════════════════════════════════════

  function onStreamStart(data) {
    state.isGenerating = true;
    state.generatingMessageId = data.messageId;
    state.streamingContent[data.messageId] = "";
    updateInputState();
  }

  function onStreamUpdate(data) {
    var messageId = data.messageId;
    var slices = data.slices;
    if (!state.streamingContent.hasOwnProperty(messageId)) {
      state.streamingContent[messageId] = "";
    }

    var content = state.streamingContent[messageId];
    for (var i = 0; i < slices.length; i++) {
      var slice = slices[i];
      if (slice.type === "append") {
        content += (slice.add && slice.add.content) || "";
      } else if (slice.type === "rewrite_tail") {
        if (typeof slice.index === "number" && slice.index >= 0) {
          content = content.slice(0, slice.index) + (slice.content || "");
        }
      } else if (slice.type === "set_files") {
        if (!state._streamFiles) state._streamFiles = {};
        state._streamFiles[messageId] = slice.files || [];
      }
    }
    state.streamingContent[messageId] = content;

    if (!state.streamDirty) {
      state.streamDirty = true;
      if (state.renderRAF) cancelAnimationFrame(state.renderRAF);
      state.renderRAF = requestAnimationFrame(flushStreamRender);
    }
  }

  // 渲染对齐（2026-07-10）：本体 extractThinkingContent 同款——旧版三处病灶：
  //   ①无代码段保护（代码块里出现 <thinking> 示例字样被当标签吞掉，IDE 场景高频）
  //   ②backref 模式不支持交叉闭合 <think>...</thinking>（本体显式支持）
  //   ③静态/流式两套提取器语义漂移。现统一为单函数，流式/静态/parseMessageContent 三处共用。
  function _extractStreamThinking(text) {
    if (!text || typeof text !== "string") return { cleanText: text || "", thinkingText: "", isComplete: true };
    var stripped = _stripOuterCodeFence(text);
    var prot = _protectCodeSegments(stripped);
    var work = prot.text;
    var thinkingParts = [];
    var isComplete = true;
    var openAlt = _thinkingTags.map(function (t) { return "<" + t + ">"; }).join("|");
    var closeAlt = _thinkingTags.map(function (t) { return "<\\/" + t + ">"; }).join("|");
    // 已闭合标签对（允许交叉闭合，如 <think>...</thinking>，本体 :238 同款）
    var closedRe = new RegExp("(?:" + openAlt + ")([\\s\\S]*?)(?:" + closeAlt + ")", "gi");
    var m;
    while ((m = closedRe.exec(work)) !== null) {
      var t = m[1].trim();
      if (t) thinkingParts.push(t);
    }
    work = work.replace(closedRe, "");
    // 未闭合（流式中间态）贪婪到末尾
    var unclosedRe = new RegExp("(?:" + openAlt + ")([\\s\\S]*)$", "i");
    var um = work.match(unclosedRe);
    if (um) {
      var ut = um[1].trim();
      if (ut) thinkingParts.push(ut);
      work = work.replace(unclosedRe, "");
      isComplete = false;
    }
    return { cleanText: prot.restore(work).trim(), thinkingText: thinkingParts.join("\n"), isComplete: isComplete };
  }

  // 渲染对齐（2026-07-10）：流式正文从纯 textContent 升级为 markdown 渲染。
  //   旧状=生成中用户看裸 markdown 符号+<file_op> 等操作标签原文，生成完成瞬间突变成 HTML
  //   （本体 StreamRenderer:401 流式即 renderMarkdownAsString）。节流 80ms 对齐本体
  //   StreamRenderer:124（防长消息每帧 marked 全量 parse 卡 webview 主线程）。
  //   与本体一致：流式不走 display regex/工具卡（那些留给 onMessageReplaced 终态全管线）。
  var _lastStreamFlushTs = 0;
  var _streamFlushTimer = null;
  function flushStreamRender() {
    state.renderRAF = null;
    var _now = Date.now();
    if (_now - _lastStreamFlushTs < 80) {
      if (!_streamFlushTimer) {
        _streamFlushTimer = setTimeout(function () {
          _streamFlushTimer = null;
          flushStreamRender();
        }, 80 - (_now - _lastStreamFlushTs));
      }
      return;
    }
    _lastStreamFlushTs = _now;
    state.streamDirty = false;

    var messageId = state.generatingMessageId;
    if (!messageId) return;

    var el = dom.messageList;
    // ★ 先记录滚动状态（DOM 更新前）
    var wasNearBottom = false;
    if (el) {
      wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    }

    var content = state.streamingContent[messageId] || "";
    var extracted = _extractStreamThinking(content);
    var row = el
      ? el.querySelector('[data-msg-id="' + messageId + '"]')
      : null;
    if (row) {
      var bodyEl = row.querySelector(".msg-body");
      if (bodyEl) {
        var thinkBlock = row.querySelector(".msg-body > .thinking-block");
        if (extracted.thinkingText) {
          if (!thinkBlock) {
            thinkBlock = document.createElement("div");
            thinkBlock.className = "thinking-block";
            var toggle = document.createElement("button");
            toggle.className = "thinking-toggle";
            toggle.addEventListener("click", function () {
              thinkBlock.classList.toggle("expanded");
            });
            thinkBlock.appendChild(toggle);
            var thinkContent = document.createElement("div");
            thinkContent.className = "thinking-content";
            thinkBlock.appendChild(thinkContent);
            bodyEl.insertBefore(thinkBlock, bodyEl.firstChild);
          }
          var toggleEl = thinkBlock.querySelector(".thinking-toggle");
          if (toggleEl) toggleEl.textContent = extracted.isComplete ? "💭 思考过程" : "💭 正在思考…";
          var contentEl = thinkBlock.querySelector(".thinking-content");
          if (contentEl) contentEl.textContent = extracted.thinkingText;
        } else if (thinkBlock) {
          thinkBlock.remove();
        }
        var textNode = row.querySelector(".msg-body > .msg-stream-text");
        if (!textNode) {
          // div 非 span：markdown 产物含 p/pre 等块级元素，span 容器是非法嵌套
          textNode = document.createElement("div");
          textNode.className = "msg-stream-text";
          bodyEl.appendChild(textNode);
        }
        if (extracted.cleanText) {
          // 操作标签剥离+markdown（IDE 场景消息几乎必含 <file_op> 等标签，裸文本不可读）
          var _newHtml = simpleMarkdown(_stripOpTagsRaw(extracted.cleanText));
          // [0719 流式渲染增量化·诊断_YonBan流式显示链 跳A] morphdom DOM diff 替代整树
          //   innerHTML 重建：流式追加场景绝大部分节点未变，diff 只动尾部——重建成本从
          //   O(全文节点) 降 O(变化)（与本体 StreamRenderer morphize 同范式）。
          //   details 保用户展开态（本体 onBeforeElUpdated 同款规则）；morphdom 缺席回退原路。
          if (typeof morphdom === "function") {
            var _tmpl = document.createElement("div");
            _tmpl.className = "msg-stream-text";
            _tmpl.innerHTML = _newHtml;
            morphdom(textNode, _tmpl, {
              onBeforeElUpdated: function (fromEl, toEl) {
                if (fromEl.tagName === "DETAILS" && toEl && typeof toEl.open === "boolean") {
                  toEl.open = fromEl.open;
                }
                return true;
              },
            });
          } else {
            textNode.innerHTML = _newHtml;
          }
        } else {
          textNode.textContent = "…";
        }
      }
      row.classList.add("generating");
    }

    // ★ 内容更新后，如果之前在底部附近，直接同步滚到底
    // overflow-anchor: none 已禁止浏览器自动调整，由我们全权控制
    if (wasNearBottom && el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 打字指示
  // ═══════════════════════════════════════════════════════

  function onTypingStatus(data) {
    updateTypingIndicator(data.typingList || []);
  }

  function updateTypingIndicator(names) {
    if (names.length === 0) {
      if (dom.typingIndicator) dom.typingIndicator.classList.remove("active");
      if (dom.typingNames) dom.typingNames.textContent = "";
    } else {
      if (dom.typingIndicator) dom.typingIndicator.classList.add("active");
      if (dom.typingNames) {
        dom.typingNames.textContent = names.join("、") + " 正在输入";
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 消息渲染
  // ═══════════════════════════════════════════════════════

  function renderAllMessages() {
    if (!dom.messageList) return;
    dom.messageList.innerHTML = "";
    if (state.messages.length === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "text-align:center;opacity:0.3;padding:40px 16px;font-size:13px;";
      empty.textContent = "开始新的对话...";
      dom.messageList.appendChild(empty);
    }
    for (var i = 0; i < state.messages.length; i++) {
      appendMessageRow(state.messages[i], i);
    }
    _ensureScrollAnchor();
    scrollToBottom(true);
  }

  /** 确保消息列表底部有 scroll-anchor 元素 */
  function _ensureScrollAnchor() {
    if (!dom.messageList) return;
    var anchor = dom.messageList.querySelector(".scroll-anchor");
    if (!anchor) {
      anchor = document.createElement("div");
      anchor.className = "scroll-anchor";
      dom.messageList.appendChild(anchor);
    }
  }

  function appendMessageRow(entry, localIndex) {
    if (!dom.messageList) return;
    if (entry.extension && entry.extension._deleted) return;
    var _isToolResult = !!(entry.extension && entry.extension._opType === "ide_tool_result");
    if ((entry.role === "system" || entry.name === "系统" || entry.name === "IDE工具结果") && !_isToolResult) return;
    // 插入到 scroll-anchor 之前（如果有的话），保持 anchor 在最底部
    var anchor = dom.messageList.querySelector(".scroll-anchor");
    var ownerChatId = typeof state.currentChatId === "string" ? state.currentChatId.trim() : "";
    var messageId = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    var indexHint = Number.isInteger(localIndex) && localIndex >= 0
      ? (state.logOffset || 0) + localIndex
      : -1;
    var rowIdentity = Object.freeze({
      chatId: ownerChatId,
      messageId: messageId,
      indexHint: indexHint,
      localIndex: localIndex,
    });
    var row = _isToolResult ? _createIdeToolResultRow(entry) : createMessageRow(entry, rowIdentity);
    if (anchor) {
      dom.messageList.insertBefore(row, anchor);
    } else {
      dom.messageList.appendChild(row);
    }
  }

  // ═══════════════════════════════════════════════════════
  // B4/Y3 inline 工具卡（与本体 messageList 同语义：content 里 <ideToolCall> 已被剥，结构化只走 extension）
  // ═══════════════════════════════════════════════════════

  /** 工具结果折叠卡：system(IDE工具结果) + extension._opType==="ide_tool_result"。
   *  卡头优先 extension.ideToolEvents（✅/❌ 工具 对象），缺省回退文案嗅探（旧消息容缺）。 */
  function _createIdeToolResultRow(entry) {
    var row = document.createElement("div");
    row.className = "message-row ide-tool-result-msg";
    row.dataset.msgId = entry.id || "";
    var resText = String(entry.content || entry.content_for_show || "");
    var statusCls = "ok";
    var summaryHtml = "";
    var evts = entry.extension && entry.extension.ideToolEvents;
    if (Array.isArray(evts) && evts.length > 0) {
      if (evts.some(function(e) { return e && e.ok === false; })) statusCls = "fail";
      summaryHtml = evts.map(function(e) {
        return (e && e.ok === false ? "✗" : "✓") + " <b>" + escapeHtml((e && e.tool) || "?") + "</b>" +
          (e && e.subject ? ' <span class="ide-tool-subject">' + escapeHtml(e.subject) + "</span>" : "");
      }).join(" · ");
    } else {
      var icon = "✓";
      if (resText.indexOf("❌") !== -1) { statusCls = "fail"; icon = "✗"; }
      else if (resText.indexOf("⚠️") !== -1) { statusCls = "warn"; icon = "⚠"; }
      summaryHtml = icon + " IDE 工具结果";
    }
    // ★ 对齐本体 diffRenderer 的着色意图：结果文本里的结构行（📍上下文锚 / 🗑被替换原文 / ✓✗⚠ 状态 / +- 行）
    //   按行着色，复用已有 yb-diff-add/del。注：YonBan webview 手里只有结果文本(无 old/new 内容)，
    //   故只能着色结构行，无法渲染本体那种由调用 old_string/new_string 来的真红绿 diff（架构差异，需扩展层传内容）。
    var _bodyHtml = String(resText).split("\n").map(function (ln) {
      var esc = escapeHtml(ln);
      var t = ln.trim();
      if (t.indexOf("🗑") === 0) return '<span class="yb-diff-del">' + esc + "</span>";
      if (/^\+(?!\+)/.test(t)) return '<span class="yb-diff-add">' + esc + "</span>";
      if (/^-(?!-)/.test(t)) return '<span class="yb-diff-del">' + esc + "</span>";
      if (t.indexOf("📍") === 0 || t.indexOf("定位锚") === 0) return '<span class="yb-anchor-ctx">' + esc + "</span>";
      if (t.indexOf("✓") === 0 || t.indexOf("✅") === 0) return '<span class="yb-diff-add">' + esc + "</span>";
      if (t.indexOf("✗") === 0 || t.indexOf("❌") === 0 || t.indexOf("⚠️") === 0) return '<span class="yb-diff-del">' + esc + "</span>";
      return esc;
    }).join("\n");
    row.innerHTML =
      '<details class="ide-tool-result-card ide-tool-result-' + statusCls + '">' +
        '<summary>' + summaryHtml + '</summary>' +
        '<pre class="ide-tool-result-body">' + _bodyHtml + '</pre>' +
      '</details>';
    return row;
  }

  /** 调用侧 chip 条：assistant + extension._opType==="ide_tool_call" 的 extension.ideToolCalls。 */
  function _appendIdeToolCallChips(row, entry) {
    var ext = entry && entry.extension;
    if (!ext || ext._opType !== "ide_tool_call") return;
    var calls = ext.ideToolCalls;
    if (!Array.isArray(calls) || calls.length === 0) return;
    if (row.querySelector(".ide-tool-call-strip")) return;
    var strip = document.createElement("div");
    strip.className = "ide-tool-call-strip";
    calls.forEach(function(c) {
      var chip = document.createElement("span");
      chip.className = "ide-tool-call-chip";
      chip.textContent = "🛠 " + ((c && c.tool) || "?") + ((c && c.subject) ? " " + c.subject : "");
      chip.title = "IDE 工具调用：" + ((c && c.tool) || "?") + ((c && c.subject) ? "\n" + c.subject : "") + "\n结果见下方「IDE 工具结果」折叠卡";
      strip.appendChild(chip);
    });
    row.appendChild(strip);
    // ★ 写工具：chip 条下渲真红绿 diff（diffOld/diffNew 由后端 ideToolCalls 带来），对齐本体 diffRenderer；
    //   diff 头可点击 → revealFile 在编辑器打开该文件（复用既有 revealFile 消息）。
    calls.forEach(function (c) {
      if (!c || c.diffNew === undefined) return;
      var box = document.createElement("div");
      box.className = "ide-tool-diff";
      var head = document.createElement("div");
      head.className = "ide-tool-diff-head";
      head.innerHTML = '<span class="ide-tool-diff-tool">' + escapeHtml(c.tool || "") + "</span>" +
        (c.subject ? ' <span class="ide-tool-diff-path">' + escapeHtml(c.subject) + "</span>" : "");
      if (c.subject) {
        head.classList.add("ide-tool-diff-jump");
        head.title = "点击在编辑器打开此文件";
        head.addEventListener("click", function () {
          vscode.postMessage({ type: "revealFile", payload: { path: c.subject } });
        });
      }
      box.appendChild(head);
      var body = document.createElement("div");
      body.className = "ide-tool-diff-body";
      body.innerHTML = (YB._renderDiffHtml ? YB._renderDiffHtml(c.diffOld || "", c.diffNew || "") : '<pre>' + escapeHtml(c.diffNew || "") + '</pre>');
      box.appendChild(body);
      row.appendChild(box);
    });
  }

function createMessageRow(entry, rowIdentity) {
    // 初始化content_for_edit，确保首次点击编辑时有内容
    if (entry && !entry.content_for_edit) {
      entry.content_for_edit = entry.content || entry.content_for_show || "";
    }
    var row = document.createElement("div");
    row.className = "message-row role-" + entry.role;
    // ★ 对人类不隐藏：被压缩/清理标记 _hidden 的消息灰显标识(仍可见可翻看)，对齐本体
    if (entry.extension && entry.extension._hidden) {
      row.classList.add("beilu-hidden-msg");
      row.style.opacity = "0.5";
      row.style.filter = "grayscale(0.55)";
    }
    row.dataset.msgId = entry.id || "";

    if (entry.is_generating) {
      row.classList.add("generating");
    }

    var header = document.createElement("div");
    header.className = "msg-header";

    var authorEl = document.createElement("span");
    authorEl.className = "msg-author role-" + entry.role;
    if (entry.role === "user") {
      authorEl.textContent = "You";
    } else if (entry.role === "system") {
      authorEl.textContent = "System";
    } else {
      authorEl.textContent = entry.name || "Assistant";
    }
    header.appendChild(authorEl);

    if (entry.time_stamp) {
      var timeEl = document.createElement("span");
      timeEl.className = "msg-timestamp";
      timeEl.textContent = formatTimestamp(entry.time_stamp);
      header.appendChild(timeEl);
    }

    var actions = document.createElement("div");
    actions.className = "msg-actions";

    if (entry.role === "user" || entry.role === "char") {
      var editBtn = document.createElement("button");
      editBtn.className = "msg-action-btn";
      editBtn.textContent = "✏";
      editBtn.title = "编辑";
      (function (capturedEntry, capturedIdentity) {
        editBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          enterEditMode(row, capturedEntry, capturedIdentity);
        });
      })(entry, rowIdentity);
      actions.appendChild(editBtn);
    }

    // 回档按钮
    var rollbackBtn = document.createElement("button");
    rollbackBtn.className = "msg-action-btn msg-action-rollback";
    rollbackBtn.textContent = "↩";
    rollbackBtn.title = "回档到这里（删除之后的消息）";
    (function (capturedIdentity) {
      rollbackBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!capturedIdentity.chatId || !capturedIdentity.messageId || capturedIdentity.indexHint < 0) {
          YB.showToast("✗ 回档消息身份无效，请刷新对话后重试", 3000);
          return;
        }
        var afterCount = Math.max(0, state.messages.length - capturedIdentity.localIndex - 1);
        if (afterCount <= 0) return;
        // ★ P3 先请求预览（文件层 Δ），收到 rollbackPreview 后渲染预览卡片再确认。
        // 预览失败时不提供确认入口；执行必须携带本次预览返回的完整令牌。
        vscode.postMessage({
          type: "previewRollback",
          payload: {
            chatId: capturedIdentity.chatId,
            anchorMessageId: capturedIdentity.messageId,
            targetIndex: capturedIdentity.indexHint,
            afterCount: afterCount,
          },
        });
      });
    })(rowIdentity);
    actions.appendChild(rollbackBtn);

    var hideBtn = document.createElement("button");
    hideBtn.className = "msg-action-btn";
    hideBtn.textContent = (entry.extension && entry.extension._hidden) ? "👁" : "🔇";
    hideBtn.title = (entry.extension && entry.extension._hidden) ? "恢复显示" : "隐藏（不发送AI）";
    (function (capturedEntry, capturedIdentity, capturedBtn) {
      capturedBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!capturedIdentity.chatId || !capturedIdentity.messageId || capturedIdentity.indexHint < 0) {
          YB.showToast("✗ 隐藏消息身份无效，请刷新对话后重试", 3000);
          return;
        }
        var nextHide = !(capturedEntry.extension && capturedEntry.extension._hidden);
        // 不先改本地 DOM；后端按稳定 ID 应用后，由 messages_hidden/权威 initial-data 刷新。
        vscode.postMessage({
          type: "hideMessage",
          payload: {
            chatId: capturedIdentity.chatId,
            messageId: capturedIdentity.messageId,
            indexHint: capturedIdentity.indexHint,
            hide: nextHide,
          },
        });
      });
    })(entry, rowIdentity, hideBtn);
    actions.appendChild(hideBtn);

    var delBtn = document.createElement("button");
    delBtn.className = "msg-action-btn msg-action-delete";
    delBtn.textContent = "✕";
    delBtn.title = "删除";
    (function (capturedIdentity) {
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!capturedIdentity.chatId || !capturedIdentity.messageId || capturedIdentity.indexHint < 0) {
          YB.showToast("✗ 删除消息身份无效，请刷新对话后重试", 3000);
          return;
        }
        var deletePayload = {
          chatId: capturedIdentity.chatId,
          messageId: capturedIdentity.messageId,
          indexHint: capturedIdentity.indexHint,
        };
        showInlineConfirm("确定删除此消息？", function () {
          vscode.postMessage({
            type: "deleteMessage",
            payload: deletePayload,
          });
        });
      });
    })(rowIdentity);
    actions.appendChild(delBtn);

    header.appendChild(actions);
    row.appendChild(header);

    var bodyEl = document.createElement("div");
    bodyEl.className = "msg-body";

    if (entry.is_generating) {
      // 与 flushStreamRender 同构建 .msg-stream-text 容器（旧 bodyEl.textContent 直写会与
      // 后续 flush append 的节点并存=内容重复；且初始帧也应 markdown 化避免闪裸文本）
      var streamNode = document.createElement("div");
      streamNode.className = "msg-stream-text";
      var streamContent = state.streamingContent[entry.id];
      if (streamContent) {
        var _initEx = _extractStreamThinking(streamContent);
        if (_initEx.cleanText) streamNode.innerHTML = simpleMarkdown(_stripOpTagsRaw(_initEx.cleanText));
        else streamNode.textContent = "…";
      } else {
        streamNode.textContent = "…";
      }
      bodyEl.appendChild(streamNode);
    } else {
      renderMessageBody(bodyEl, entry);
    }

    row.appendChild(bodyEl);
    _appendIdeToolCallChips(row, entry); // B4/Y3：本轮调用了什么工具（chip 条）
    return row;
  }

  function updateMessageRow(row, entry) {
    row.dataset.msgId = entry.id || "";
    row.classList.remove("generating");
    row.className = "message-row role-" + entry.role;

    var bodyEl = row.querySelector(".msg-body");
    if (bodyEl) {
      bodyEl.innerHTML = "";
      bodyEl.classList.remove("empty");
      renderMessageBody(bodyEl, entry);
    }
    _appendIdeToolCallChips(row, entry); // B4/Y3：流式完成（message_replaced）后 extension 才带 ideToolCalls

    var timeEl = row.querySelector(".msg-timestamp");
    if (entry.time_stamp) {
      if (!timeEl) {
        timeEl = document.createElement("span");
        timeEl.className = "msg-timestamp";
        var header = row.querySelector(".msg-header");
        if (header) header.appendChild(timeEl);
      }
      timeEl.textContent = formatTimestamp(entry.time_stamp);
    }
  }

  // ═══════════════════════════════════════════════════════
function enterEditMode(row, entry, capturedIdentity) {
    var bodyEl = row.querySelector(".msg-body");
    if (!bodyEl || row.classList.contains("editing")) return;
    // 实时从state查最新entry，避免闭包旧引用导致内容为空
    var freshEntry = (state && state.messages && state.messages.find(function(m) { return m.id === entry.id; })) || entry;
    row.classList.add("editing");
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== "function") {
      row.classList.remove("editing");
      YB.showToast("✗ 当前环境不支持安全的编辑操作标识，请升级 IDE 后重试", 3500);
      return;
    }
    // 同一编辑框的失败重试复用同一 operationId；服务端用 payload 指纹拒绝已提交操作漂移。
    var editOperationId = globalThis.crypto.randomUUID();
    var originalText =
      freshEntry.content_for_edit || freshEntry.content || freshEntry.content_for_show || "";
    var editText =
      typeof originalText === "object"
        ? JSON.stringify(originalText)
        : String(originalText);

    bodyEl.innerHTML = "";

    var textarea = document.createElement("textarea");
    textarea.className = "msg-edit-textarea";
    textarea.value = editText;
    textarea.rows = Math.min(Math.max(editText.split("\n").length, 3), 15);
    bodyEl.appendChild(textarea);

    var btnRow = document.createElement("div");
    btnRow.className = "msg-edit-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "保存";
    saveBtn.style.fontSize = "12px";
    saveBtn.style.padding = "2px 10px";
    saveBtn.addEventListener("click", function () {
      var newContent = textarea.value;
      if (!capturedIdentity || !capturedIdentity.chatId || !capturedIdentity.messageId
        || capturedIdentity.indexHint < 0 || capturedIdentity.messageId !== entry.id) {
        YB.showToast("✗ 编辑消息身份无效，请刷新对话后重试", 3000);
        return;
      }
      saveBtn.disabled = true;
      vscode.postMessage({
        type: "editMessage",
        payload: {
          chatId: capturedIdentity.chatId,
          messageId: capturedIdentity.messageId,
          indexHint: capturedIdentity.indexHint,
          content: newContent,
          editOperationId: editOperationId,
        },
      });
      // 等待 Provider 的 editMessageResult；请求发出不等于提交成功，禁止永久乐观改本地。
    });
    btnRow.appendChild(saveBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-secondary";
    cancelBtn.textContent = "取消";
    cancelBtn.style.fontSize = "12px";
    cancelBtn.style.padding = "2px 10px";
    cancelBtn.addEventListener("click", function () {
      row.classList.remove("editing");
      updateMessageRow(row, entry);
      applyPendingEditedBroadcast(capturedIdentity && capturedIdentity.chatId, entry.id);
    });
    btnRow.appendChild(cancelBtn);

    bodyEl.appendChild(btnRow);
    textarea.focus();
  }

  /**
   * 解析消息内容，分离思维链和正文
   */
  /**
   * 统一渲染消息体内容到 bodyEl
   * 优先用 content_for_show（后端 HTML），fallback 纯文本
   */
  function renderMessageBody(bodyEl, entry) {
    var result = getDisplayHtml(entry);

    if (result.thinkingText) {
      var thinkBlock = document.createElement("div");
      thinkBlock.className = "thinking-block";

      var toggle = document.createElement("button");
      toggle.className = "thinking-toggle";
      toggle.textContent = "💭 思考过程";
      toggle.addEventListener("click", function () {
        thinkBlock.classList.toggle("expanded");
      });
      thinkBlock.appendChild(toggle);

      var thinkContent = document.createElement("div");
      thinkContent.className = "thinking-content";
      thinkContent.textContent = result.thinkingText;
      thinkBlock.appendChild(thinkContent);

      bodyEl.appendChild(thinkBlock);
    }

    if (result.displayHtml) {
      var textNode = document.createElement("div");
      textNode.className = "msg-text";
      if (result.isHtml) {
        textNode.innerHTML = result.displayHtml;
        // ★ 代码块复制按钮
        _addCodeCopyButtons(textNode);
      } else {
        textNode.textContent = result.displayHtml;
        textNode.classList.add("is-plain");
      }
      bodyEl.appendChild(textNode);
    } else if (!result.thinkingText) {
      // 检查原始内容是否有操作标签（内容全是标签时不该显示"空消息"）
      var rawContent = entry.content || entry.content_for_show || "";
      var hasOpTags = typeof rawContent === "string" && (
        /<ideToolCall/i.test(rawContent) ||
        /<file_op/i.test(rawContent) ||
        /<UpdateVariable/i.test(rawContent) ||
        /<tableEdit/i.test(rawContent) ||
        /<memoryArchive/i.test(rawContent) ||
        /<memoryNote/i.test(rawContent)
      );
      if (hasOpTags) {
        bodyEl.textContent = "⚙ 执行操作中…";
        bodyEl.classList.add("empty");
      } else {
        bodyEl.textContent = "(空消息)";
        bodyEl.classList.add("empty");
      }
    }

    // ★ 渲染附件图片（对齐后端 messageTransform：只显示最后一条含图片的 user 消息的图片，历史图片折叠）
    if (entry.files && Array.isArray(entry.files) && entry.files.length > 0) {
      var hasImages = entry.files.some(function(f) { return (f.mime_type || f.type || "").indexOf("image") === 0; });
      if (hasImages) {
        var isLastImageMsg = _isLastImageEntry(entry);
        var filesDiv = document.createElement("div");
        filesDiv.className = "msg-attachments";

        if (!isLastImageMsg) {
          // 历史图片：折叠占位
          filesDiv.style.cssText = "margin-top:4px;";
          var imgCount = entry.files.filter(function(f) { return (f.mime_type || f.type || "").indexOf("image") === 0; }).length;
          var collapsed = document.createElement("div");
          collapsed.style.cssText = "padding:4px 8px;background:var(--vscode-textBlockQuote-background,#252526);border-radius:4px;font-size:11px;opacity:0.6;display:inline-block;";
          collapsed.textContent = "\uD83D\uDDBC " + imgCount + " 张图片（历史图片已省略）";
          filesDiv.appendChild(collapsed);
        } else {
          // 最后一条：显示真实图片
          filesDiv.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;";
          for (var fi = 0; fi < entry.files.length; fi++) {
            var file = entry.files[fi];
            var mime = file.mime_type || file.type || "";
            if (mime.indexOf("image") !== 0) continue;
            var buf = file.buffer || file.data || "";
            if (typeof buf === "string" && buf.startsWith("file:")) {
              var ph = document.createElement("div");
              ph.style.cssText = "padding:6px 10px;background:var(--vscode-textBlockQuote-background,#252526);border-radius:6px;font-size:11px;opacity:0.7;";
              ph.textContent = "\uD83D\uDCCE " + (file.name || "图片附件");
              filesDiv.appendChild(ph);
              continue;
            }
            var img = document.createElement("img");
            img.style.cssText = "max-width:200px;max-height:200px;border-radius:6px;cursor:pointer;";
            img.alt = file.name || "附件图片";
            if (typeof buf === "string" && buf.startsWith("data:")) {
              img.src = buf;
            } else if (typeof buf === "string" && buf.length > 0) {
              img.src = "data:" + mime + ";base64," + buf;
            } else {
              continue;
            }
            filesDiv.appendChild(img);
          }
        }
        if (filesDiv.childNodes.length > 0) bodyEl.appendChild(filesDiv);
      }
    }
  }

  // 判断 entry 是否是最后一条含图片的 user 消息（对齐后端 messageTransform 只嵌入最后一条图片消息）
  function _isLastImageEntry(entry) {
    var msgs = state.messages;
    if (!msgs || msgs.length === 0) return true;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (m.role !== "user" && m.role !== "system") continue;
      if (m.files && Array.isArray(m.files) && m.files.some(function(f) { return (f.mime_type || f.type || "").indexOf("image") === 0; })) {
        return m.id === entry.id || m === entry;
      }
    }
    return true;
  }

  function parseMessageContent(entry) {
    // ★ 优先用 content（原始文本），因为 content_for_show 是后端 markdown 渲染的 HTML
    // YonBan 用 textContent 显示纯文本，处理原始文本更可靠
    var raw = _replaceMacros(entry.content || entry.content_for_show || entry.content_for_edit || "");
    if (!raw) return { displayText: "", thinkingText: "" };

    if (typeof raw === "object") {
      var t = Array.isArray(raw.text)
        ? raw.text.join("\n")
        : raw.content || JSON.stringify(raw);
      return { displayText: t, thinkingText: "" };
    }
    if (typeof raw !== "string") {
      return { displayText: String(raw), thinkingText: "" };
    }

    // 统一提取器（2026-07-10）：含外层围栏剥离+代码段保护+交叉闭合，替代旧 backref 副本
    // [2026-08-10] 用户消息不提取思维链：标签字面量保持可见、可编辑。
    var _pmEx = (entry && entry.role === "user")
      ? { cleanText: raw, thinkingText: "", isComplete: true }
      : _extractStreamThinking(raw);
    var thinkingParts = _pmEx.thinkingText ? [_pmEx.thinkingText] : [];
    var text = _pmEx.cleanText;

    // T012 操作标签单源：raw 剥离统一走 _stripOpTagsRaw（标签清单=本文件顶部 OPERATION_TAGS，原两处 12 标签冗余副本已合并）
    text = _stripOpTagsRaw(text);

    // 处理 <details> 标签：提取 summary 文本 + 内部文字
    text = text.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, function (_m, inner) {
      var summary = "";
      var body = inner.replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, function (_m2, s) {
        summary = s.trim();
        return "";
      });
      body = body.replace(/<[^>]*>/g, "").trim();
      return (summary ? "[" + summary + "]" : "") + (body ? " " + body : "");
    });

    var contentMatch = text.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch) text = contentMatch[1];

    // 清理剩余的 HTML/XML 标签（保留标签间的文字）
    text = text.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, "").trim();

    // ★ 如果清理后为空，依次尝试 content_for_show 和 content 的纯文本 fallback
    if (!text && !thinkingParts.length) {
      var sources = [entry.content_for_show, entry.content, entry.content_for_edit];
      for (var fi = 0; fi < sources.length; fi++) {
        if (sources[fi] && typeof sources[fi] === "string") {
          var fallback = sources[fi].replace(/<[^>]*>/g, "").trim();
          if (fallback) { text = fallback; break; }
        }
      }
    }

    return {
      displayText: text,
      thinkingText: thinkingParts.join("\n\n"),
    };
  }

  // ═══════════════════════════════════════════════════════
  // 内容类型检测 + 占位符保护（full-html iframe渲染 + HTML/Markdown混合保护）
  // ═══════════════════════════════════════════════════════

  /**
   * 检测内容类型（参照本体 displayRegex.mjs detectContentType）
   * @param {string} text
   * @returns {'full-html'|'script-fragment'|'markdown'}
   */
  function _detectContentType(text) {
    if (!text || typeof text !== "string") return "markdown";
    var trimmed = text.trim();
    // 完整HTML文档：以 <!doctype html> 或 <html> 开头
    if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return "full-html";
    // 剥离前置 details 后再检查（本体同逻辑：内置处理器输出可能前置于HTML文档）
    var stripped = trimmed.replace(/^(<details[^>]*>[\s\S]*?<\/details>\s*)+/i, "").trim();
    if (stripped !== trimmed && (/^<!doctype\s+html/i.test(stripped) || /^<html[\s>]/i.test(stripped))) return "full-html";
    // 含 <script> 标签的片段
    if (/<script[\s>]/i.test(trimmed)) return "script-fragment";
    return "markdown";
  }

  /**
   * 占位符保护+恢复（局部 store 模式，防嵌套调用交叉污染）。
   * 返回 { text, restore(html) }：text 是替换后文本，restore 恢复占位符。
   */
  function _protectHtmlBlocks(text) {
    var store = [];
    if (!text) return { text: text, restore: function (h) { return h; } };
    var replaced = text.replace(/<(div|table|style|details|form|section|article|header|footer|aside|nav|figure|figcaption|dl|dd|dt)\b[\s\S]*?<\/\1>/gi, function(match) {
      var idx = store.length;
      store.push(match);
      return "__YB_HTML_" + idx + "__";
    });
    return {
      text: replaced,
      restore: function (html) {
        if (!store.length) return html;
        return html.replace(/__YB_HTML_(\d+)__/g, function(_, idx) {
          var block = store[parseInt(idx)] || "";
          if (window.DOMPurify && block) {
            block = window.DOMPurify.sanitize(block, { ADD_ATTR: ["target"], FORBID_TAGS: ["script"] });
          }
          return block;
        });
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  // HTML 渲染：后端 content_for_show（已渲染 HTML）经占位符保护 + marked + DOMPurify 净化后显示（非裸 innerHTML，见下方 getDisplayHtml 注释）
  // ═══════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════
  // T012 操作标签单源（YonBan 侧唯一清单——原 parseMessageContent/stripOperationTags 两处 12 标签冗余副本合并）。
  //   本清单=「显示剥离面」12 种；后端执行面全集（35+）在 replyHandler._stripAllTags、
  //   手动清理工具子集（6 种+[已执行:x] 替换语义）在 setDataActions cleanXmlTags——三者语义不同不强行合一。
  //   跨库对照源：beilu-chat/src/lib/constants.mjs OPERATION_TAG_NAMES（浏览器/webview 无法跨库 import，
  //   两库各自单源+本注释互指；改标签清单时两处同步改）。
  //   分组=正则结构差异：paired 严格 <tag>；pairedLoose 开标签可带属性；selfClosing <tag .../>；
  //   selfClosingQuoted 属性区容引号内字面 >（与本体 cleanContent F2 同步）；orphanClose 孤立闭合标签。
  //   逐标签独立 replace（不用大交替组）：防 <UpdateVariable> 匹到 </tableEdit> 跨标签吞正文（历史 bug）。
  // ═══════════════════════════════════════════════════════
  var OPERATION_TAGS = {
    paired: ["UpdateVariable", "tableEdit", "JSONPatch", "memoryArchive", "memorySearch", "memoryNote", "question", "search", "browse"],
    pairedLoose: ["file_op", "ideToolCall"],
    selfClosing: ["file_op", "toggle"],
    selfClosingQuoted: ["ideToolCall"],
    orphanClose: ["UpdateVariable", "tableEdit", "JSONPatch", "memoryArchive", "memorySearch", "memoryNote"],
  };

  /** raw 文本操作标签剥离（parseMessageContent 与 stripOperationTags 共用） */
  function _stripOpTagsRaw(text) {
    var i, t;
    for (i = 0; i < OPERATION_TAGS.paired.length; i++) {
      t = OPERATION_TAGS.paired[i];
      text = text.replace(new RegExp("<" + t + ">[\\s\\S]*?</" + t + ">", "gi"), "");
    }
    for (i = 0; i < OPERATION_TAGS.pairedLoose.length; i++) {
      t = OPERATION_TAGS.pairedLoose[i];
      text = text.replace(new RegExp("<" + t + "[\\s\\S]*?</" + t + ">", "gi"), "");
    }
    for (i = 0; i < OPERATION_TAGS.selfClosing.length; i++) {
      t = OPERATION_TAGS.selfClosing[i];
      text = text.replace(new RegExp("<" + t + "[^>]*/>", "gi"), "");
    }
    for (i = 0; i < OPERATION_TAGS.selfClosingQuoted.length; i++) {
      t = OPERATION_TAGS.selfClosingQuoted[i];
      text = text.replace(new RegExp("<" + t + '(?:[^>"]|"(?:[^"\\\\]|\\\\.)*")*?/>', "gi"), "");
    }
    return text;
  }

  /** 操作标签清理（raw XML + HTML 转义两种形式 + 孤立闭合标签） */
  function stripOperationTags(html) {
    // raw XML 形式（与 parseMessageContent 同源同函数）
    html = _stripOpTagsRaw(html);
    // HTML 转义形式（后端 markdown 渲染器可能转义了 XML 标签）
    var escAlt = OPERATION_TAGS.paired.concat(OPERATION_TAGS.pairedLoose).join("|");
    html = html.replace(new RegExp("&lt;(?:" + escAlt + ")&gt;[\\s\\S]*?&lt;/(?:" + escAlt + ")&gt;", "gi"), "");
    // 清理孤立的闭合标签（raw 和转义）
    var orphanAlt = OPERATION_TAGS.orphanClose.join("|");
    html = html.replace(new RegExp("</(?:" + orphanAlt + ")>", "gi"), "");
    html = html.replace(new RegExp("&lt;/(?:" + orphanAlt + ")&gt;", "gi"), "");
    return html;
  }

  /** 简易 markdown → HTML（fallback用，处理表格/代码块/粗体/列表） */
  // ★ P2-8: Markdown渲染（marked + DOMPurify，替代原simpleMarkdown）
  function simpleMarkdown(text) {
    if (!text) return "";
    // 优先用marked库（vendor-markdown.js注入的window.marked）
    if (window.marked) {
      try {
        // ★ 占位符保护（局部 store，防嵌套调用交叉污染）
        var _hp = _protectHtmlBlocks(text);
        var html = window.marked.parse(_hp.text, { breaks: true, gfm: true });
        // DOMPurify防XSS
        if (window.DOMPurify) {
          html = window.DOMPurify.sanitize(html, {
            ADD_ATTR: ["target"],
            FORBID_TAGS: ["style", "script"],
          });
        }
        // ★ 恢复占位符
        html = _hp.restore(html);
        // marked 可能将占位符包在 <p> 中，清理残留空 <p> 标签
        html = html.replace(/<p>\s*<\/p>/g, "");
        // 代码块加复制按钮容器
        html = html.replace(/<pre><code/g, '<pre class="yb-code-block"><code');
        // ★ Diff渲染：检测diff代码块，给+/-行加颜色
        html = html.replace(/<pre class="yb-code-block"><code class="language-diff">([\s\S]*?)<\/code><\/pre>/gi, function(_m, code) {
          var lines = code.split("\n").map(function(line) {
            if (/^\+[^+]/.test(line)) return '<span class="yb-diff-add">' + line + '</span>';
            if (/^-[^-]/.test(line)) return '<span class="yb-diff-del">' + line + '</span>';
            if (/^@@/.test(line)) return '<span class="yb-diff-hunk">' + line + '</span>';
            return line;
          });
          return '<pre class="yb-code-block yb-diff"><code>' + lines.join("\n") + '</code></pre>';
        });
        html = _applyCodeFold(html);
        return html;
      } catch (_e) {
        // marked失败，回退到简单实现
      }
    }
    // 回退：基础Markdown渲染（无 marked 时不做占位符保护，保持简单）
    var fallback = escapeHtml(text);
    fallback = fallback.replace(/```(\w*)\n([\s\S]*?)```/g, function (_m, lang, code) {
      return '<pre class="yb-code-block"><code>' + code + '</code></pre>';
    });
    fallback = fallback.replace(/`([^`\n]+)`/g, '<code class="yb-inline-code">$1</code>');
    fallback = fallback.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    fallback = fallback.replace(/\n/g, "<br>");
    fallback = _applyCodeFold(fallback);
    return fallback;
  }

  function _applyCodeFold(html) {
    return html.replace(/<pre class="yb-code-block[^"]*"><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, function(match, code) {
      var lineCount = code.split("\n").length;
      if (lineCount <= 3) return match;
      return '<details class="yb-code-fold"><summary>代码 (' + lineCount + '行，点击展开)</summary>' + match + '</details>';
    });
  }

  /**
   * 获取消息的 HTML 显示内容
   * 优先用 content_for_show（后端渲染的 HTML），fallback 到纯文本
   * @returns {{ displayHtml: string, thinkingText: string, isHtml: boolean }}
   */
  /**
   * 消息内容 → 显示 HTML 的核心管线。三分支渲染（参照本体 messageList.mjs renderMessage 管线）：
   *
   *   1. full-html 分支：检测到完整 HTML 文档 → iframe sandbox 渲染（对齐本体 iframeRenderer 三档安全）
   *   2. content_for_show 分支：后端已渲染的 HTML → 占位符保护块级标签 → display regex → marked → 恢复占位符
   *   3. fallback 分支：纯文本 → parseMessageContent → display regex → simpleMarkdown
   *
   * 不变量：思维链标签在所有分支中都被剥离到 thinkingText，不混入 displayHtml
   *
   * @returns {{ displayHtml: string, thinkingText: string, isHtml: boolean }}
   */
  /** 构造 display regex 上下文：role + 距末深度（本体 messageDepth 语义：0=最新一条） */
  function _regexCtxOf(entry) {
    var depth = 0;
    if (entry && entry.id != null && Array.isArray(state.messages)) {
      for (var di = state.messages.length - 1; di >= 0; di--) {
        if (state.messages[di].id === entry.id) { depth = state.messages.length - 1 - di; break; }
      }
    }
    return { role: entry && entry.role, messageDepth: depth };
  }

  function getDisplayHtml(entry) {
    var cfs = entry.content_for_show;
    var raw = _replaceMacros(entry.content || "");
    if (cfs && typeof cfs === "string") cfs = _replaceMacros(cfs);

    // 思维链提取/折叠只作用于 AI 消息；用户消息中的标签字面量原样显示。
    var _skipThink = !!(entry && entry.role === "user");
    // 先从 raw content 提取思维链——统一提取器（2026-07-10 对齐本体 extractThinkingContent：
    //   外层围栏剥离+代码段保护+交叉闭合，替代旧 backref 收集三处各一套）
    var _rawEx = _skipThink
      ? { cleanText: (typeof raw === "string" ? raw : ""), thinkingText: "", isComplete: true }
      : _extractStreamThinking(typeof raw === "string" ? raw : "");
    var thinkingParts = _rawEx.thinkingText ? [_rawEx.thinkingText] : [];

    // ★ full-html 检测：完整 HTML 文档走 iframe 沙箱渲染（参照本体 iframeRenderer）
    // 检测源：优先用 raw content（AI 原始输出），cfs 可能被后端 markdown 渲染器破坏 HTML 结构
    var _cfsEx = null;
    var _contentForDetect;
    if (typeof raw === "string" && raw.trim()) {
      _contentForDetect = _rawEx.cleanText;
    } else if (cfs && typeof cfs === "string") {
      _cfsEx = _skipThink ? { cleanText: cfs, thinkingText: "", isComplete: true } : _extractStreamThinking(cfs);
      _contentForDetect = _cfsEx.cleanText;
    } else {
      _contentForDetect = "";
    }
    var _contentType = _detectContentType(_contentForDetect);

    if (_contentType === "full-html") {
      // 剥离思维链后剩余即完整 HTML 文档（统一提取器已剥外层围栏——美化正则惯例```包 HTML 文档）
      var fullHtmlContent = (typeof raw === "string" && raw.trim())
        ? _rawEx.cleanText
        : ((_cfsEx && _cfsEx.cleanText) || "").trim();
      // srcdoc 中双引号需要 HTML 实体转义
      var srcdocEscaped = fullHtmlContent
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;");
      // iframe sandbox 对齐本体 iframeRenderer 三档设计（F-D5 安全默认）:
      //   strict(默认) = allow-scripts allow-popups（无 same-origin，opaque origin，防 XSS）
      //   standard     = allow-scripts allow-same-origin allow-popups（owner 显式选择）
      //   sandbox      = allow-scripts（最严格）
      var _sandboxLevel = (typeof localStorage !== "undefined" && localStorage.getItem("beilu-iframe-sandbox")) || "strict";
      var _sandboxMap = { standard: "allow-scripts allow-same-origin allow-popups", strict: "allow-scripts allow-popups", sandbox: "allow-scripts" };
      var _sandbox = _sandboxMap[_sandboxLevel] || _sandboxMap.strict;
      var iframeHtml = '<iframe sandbox="' + _sandbox + '" srcdoc="' + srcdocEscaped + '" ' +
        'style="width:100%;border:none;min-height:200px;border-radius:6px;background:#fff;" ' +
        'onload="try{var d=this.contentDocument||this.contentWindow.document;if(d&&d.body){this.style.height=Math.max(d.body.scrollHeight,d.documentElement.scrollHeight,200)+\'px\';}}catch(e){this.style.height=\'600px\';}" ' +
        '></iframe>';
      return { displayHtml: iframeHtml, thinkingText: thinkingParts.join("\n\n"), isHtml: true };
    }

    // 如果有 content_for_show（后端渲染的 HTML 或纯文本），处理后显示
    if (cfs && typeof cfs === "string" && cfs.trim()) {
      var html = cfs;
      // 清理思维链（HTML 中可能有渲染过的 thinking 块）——动态匹配所有配置的 tag
      for (var _ti = 0; _ti < _thinkingTags.length; _ti++) {
        html = html.replace(new RegExp("<" + _thinkingTags[_ti] + "[^>]*>[\\s\\S]*?<\\/" + _thinkingTags[_ti] + ">", "gi"), "");
      }
      // 清理操作标签
      html = stripOperationTags(html);
      html = html.trim();
      if (html) {
        // ★ 占位符保护机制（参考本体beilu-chat displayRegex设计）
        // 问题：content_for_show含混合内容（<strong>文字</strong>\n下一段），
        //       直接innerHTML时\n在white-space:normal下折叠→全挤一行
        // 方案：只保护真正复杂的块级结构（table/details等），让marked处理其余内容
        //       marked开启breaks:true→\n→<br>，inline HTML原样保留
        var blockPlaceholders = [];
        var processed = html;

        // 提取复杂块级HTML，替换为占位符（inline标签如strong/em/span不保护，让marked处理）
        // 安全：iframe/form/fieldset 不在保护名单——它们走 marked+DOMPurify 正常净化，不允许原样回填
        var blockPattern = /<(table|details|figure)([\s>][\s\S]*?)<\/\1>/gi;
        processed = processed.replace(blockPattern, function(match) {
          var idx = blockPlaceholders.length;
          blockPlaceholders.push(match);
          return "\n\nYB_PH_" + idx + "\n\n";
        });

        // display regex 规则（在 markdown 渲染之前应用，与本体管道一致；
        //   ctx=role+距末深度，user 消息不应用/minDepth/maxDepth 生效，本体 :626/:643 同款）
        processed = _stripOuterCodeFence(processed);
        processed = _applyDisplayRegex(processed, _regexCtxOf(entry));

        // 走simpleMarkdown渲染（marked会正确处理换行、段落、inline HTML）
        var rendered = simpleMarkdown(processed);

        // 恢复块级占位符（marked可能把占位符包在<p>里，两种情况都处理）
        // 安全：回填前对每个块单独 DOMPurify 净化，杜绝绕过 sanitize 注入
        blockPlaceholders.forEach(function(block, idx) {
          var safeBlock = window.DOMPurify
            ? window.DOMPurify.sanitize(block, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "script"] })
            : block;
          var ph = "YB_PH_" + idx;
          rendered = rendered.replace("<p>" + ph + "</p>", safeBlock);
          rendered = rendered.replace(ph, safeBlock);
        });

        return { displayHtml: rendered || html, thinkingText: thinkingParts.join("\n\n"), isHtml: true };
      }
    }

    // fallback：用 parseMessageContent 的纯文本结果，简单markdown转HTML
    var parsed = parseMessageContent(entry);
    var fallbackText = parsed.displayText ? _applyDisplayRegex(parsed.displayText, _regexCtxOf(entry)) : "";
    var fallbackHtml = fallbackText ? simpleMarkdown(fallbackText) : "";
    // ★ P2-10: 最终保底 — 如果所有路径都返回空，用原始content
    if (!fallbackHtml && raw && typeof raw === "string") {
      var cleanRaw = raw.replace(/<[^>]+>/g, "").trim();
      if (cleanRaw) fallbackHtml = simpleMarkdown(cleanRaw);
    }
    return {
      displayHtml: fallbackHtml,
      thinkingText: parsed.thinkingText || thinkingParts.join("\n\n"),
      isHtml: !!fallbackHtml,
    };
  }

  // ═══════════════════════════════════════════════════════
  // 内联确认弹窗（替代 confirm()，VSCode webview 不支持 confirm）
  // ═══════════════════════════════════════════════════════

  function showInlineConfirm(message, onConfirm) {
    var existing = document.getElementById("yb-inline-confirm");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "yb-inline-confirm";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;";

    var box = document.createElement("div");
    box.style.cssText = "background:var(--vscode-editor-background,#1e1e2e);border-radius:10px;padding:16px 20px;max-width:320px;width:85%;box-shadow:0 4px 20px rgba(0,0,0,0.4);color:var(--vscode-foreground,#ccc);text-align:center;";

    var msg = document.createElement("p");
    msg.style.cssText = "margin:0 0 14px;font-size:13px;line-height:1.5;";
    msg.textContent = message;
    box.appendChild(msg);

    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:center;";

    var confirmBtn = document.createElement("button");
    confirmBtn.style.cssText = "padding:6px 18px;border:none;border-radius:6px;background:#e53935;color:#fff;cursor:pointer;font-size:13px;font-weight:600;";
    confirmBtn.textContent = "确认";
    confirmBtn.addEventListener("click", function () {
      overlay.remove();
      onConfirm();
    });
    btnRow.appendChild(confirmBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.style.cssText = "padding:6px 18px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:13px;";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", function () { overlay.remove(); });
    btnRow.appendChild(cancelBtn);

    box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ═══════════════════════════════════════════════════════
  // 输入处理
  // ═══════════════════════════════════════════════════════

  function updateInputState() {
    // [0719 中途输入·凛倾「ai在工作,我想继续发送对话,下次ai输出完的时候注入」] 生成中不再藏发送键：
    //   后端本就支持——POST /message 随时落盘保序，triggerCharReply userInitiated 生成中到达=排队、
    //   本轮结束补发一轮（generation.mjs:705-716）。原 UI 藏键是唯一的闸。发送与停止并存显示。
    if (dom.btnSend) dom.btnSend.classList.remove("hidden");
    if (dom.btnStop)
      dom.btnStop.classList.toggle("hidden", !state.isGenerating);
    // ping 失败(error)≠API不通：send走HTTP API不走ping，允许error态仍尝试发送（API层有自己的超时报错）
    // sendInFlight：一次发送在途时本函数（多处 WS 事件回调调用）不得中途复活按钮（复位只归 setSendIdle）
    var canSend = state.currentChatId && state.connectionStatus !== "disconnected";
    if (dom.btnSend) dom.btnSend.disabled = !canSend || !!state.sendInFlight;
    // [0719 中途输入] 收敛点 flush：生成结束/发送空闲的每次状态收敛都检查待发送队列
    //   （生成结束必经本函数——btnStop 隐藏就发生在这，单点无散写）
    _flushPendingSends();
  }

  // ★ P2-9: 图片附件管理
  var _pendingFiles = []; // 待发送的图片 [{ name, type, data(base64) }]

  // ★ U06（T049）发送失败保文本：对齐本体 messageInput.mjs「clear-on-confirmed-success」范式。
  //   原代码 postMessage 后无条件清空输入框（fire-and-forget，拿不到成败）——若 Extension/后端发送失败，
  //   文本已清、用户输入丢失且无处恢复。改为：发送后不立即清，标记"等待发送确认"；
  //   用户自己的 messageAdded(role=user) 回推到达 = 后端已收 = 成功 → 此时才清输入框；
  //   若失败（Extension 抛错 → operationError(action=sendMessage) 回来）→ 文本原样保留可重发。
  //   （YonBan postMessage 是单向的，无法 await；用回推确认作为等价的"成功信号"，与本体语义一致。）
  var _awaitingSendAck = false;

  // 发送成功确认后清空输入框（由 onMessageAdded 收到用户自身回推时调用）。
  function _clearInputAfterSendAck() {
    if (!_awaitingSendAck) return;
    _awaitingSendAck = false;
    if (dom.msgInput) dom.msgInput.value = "";
    _pendingFiles = [];
    _removeAttachmentPreview();
    autoResizeInput();
    if (YB.setSendIdle) YB.setSendIdle(); // [0719 发送状态机] WS 成功回推=完成事件之一（复位发送按钮）
  }
  // 发送失败（顶层 operationError(action=sendMessage)）→ 复位等待标记，输入框文本原样保留可重发。
  function _abortSendAck() {
    _awaitingSendAck = false;
  }

  // [0719 中途输入] 发送核（sendMessage 与待发送队列 flush 共用）：text/files 显式入参。
  function _postSend(text, files, autoReply) {
    // ★ @文件引用：检测 @路径 模式，附加到消息
    var fileRefs;
    if (text) {
      var refMatches = text.match(/@([\w\/\\\.\-]+\.\w+)/g);
      if (refMatches && refMatches.length > 0) {
        fileRefs = refMatches.map(function(r) { return r.substring(1); });
      }
    }
    vscode.postMessage({
      type: "sendMessage",
      payload: {
        reply: text || "(图片)",
        autoReply: autoReply !== false,
        chatId: state.currentChatId,
        files: files && files.length > 0 ? files : undefined,
        fileReferences: fileRefs,
      },
    });
    // U06：不再无条件清空。标记"等待发送确认"，成功回推(onMessageAdded role=user)才清、失败(operationError)保留文本。
    _awaitingSendAck = true;
  }

  function sendMessage() {
    if (!dom.msgInput) return;
    var text = dom.msgInput.value.trim();
    if (!text && _pendingFiles.length === 0) return;
    if (state.connectionStatus === "disconnected") {
      YB.showToast("未连接后端，请先在设置中连接", 2500);
      return;
    }
    if (!state.currentChatId) {
      YB.showToast("未选择对话，请先选择角色和对话", 2500);
      return;
    }
    _postSend(text, _pendingFiles, true);
  }

  // ═══ [0719 中途输入·待发送队列（凛倾「待发送的需要显示在上面,可以点×进行撤销」）] ═══
  // 生成中点发送 → 不落盘，进本地队列（可无痕撤销），显示在输入区上方；本轮输出完
  // （updateInputState 收敛点判 !isGenerating）经发送状态机逐条串行发出（保序）：
  // 前 N-1 条 autoReply:false 只落盘，最后一条触发生成 → AI 下一轮一次看到全部（注入语义）。
  // 条目绑 chatId：切对话不误发，切回再续。失败条目：operationError toast 可见但内容不回队（如实边界）。
  var _pendingSends = []; // { qid, chatId, text, files }
  var _pendingSeq = 0;

  function _renderPendingSends() {
    var host = document.getElementById("pendingSends");
    if (!host) {
      var inputArea = document.querySelector(".input-area");
      if (!inputArea || !inputArea.parentNode) return;
      host = document.createElement("div");
      host.id = "pendingSends";
      host.style.cssText = "display:none;flex-direction:column;gap:4px;padding:4px 8px 0;";
      inputArea.parentNode.insertBefore(host, inputArea);
    }
    var mine = _pendingSends.filter(function (p) { return p.chatId === state.currentChatId; });
    host.innerHTML = "";
    mine.forEach(function (p) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;opacity:.85;background:var(--vscode-editorWidget-background,rgba(128,128,128,.15));border-radius:4px;padding:3px 8px;";
      var label = document.createElement("span");
      label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      label.textContent = "⏳ 待发送: " + (p.text || "(图片)") + (p.files && p.files.length ? " [+" + p.files.length + "图]" : "");
      var x = document.createElement("button");
      x.textContent = "×";
      x.title = "撤销（尚未发送，无痕移除）";
      x.style.cssText = "background:none;border:none;cursor:pointer;color:inherit;font-size:14px;padding:0 2px;";
      x.addEventListener("click", function () {
        _pendingSends = _pendingSends.filter(function (q) { return q.qid !== p.qid; });
        _renderPendingSends();
      });
      row.appendChild(label);
      row.appendChild(x);
      host.appendChild(row);
    });
    host.style.display = mine.length ? "flex" : "none";
  }

  function queuePendingSend() {
    if (!dom.msgInput) return;
    var text = dom.msgInput.value.trim();
    if (!text && _pendingFiles.length === 0) return;
    if (!state.currentChatId) { YB.showToast("未选择对话", 2000); return; }
    _pendingSends.push({ qid: ++_pendingSeq, chatId: state.currentChatId, text: text, files: _pendingFiles.slice() });
    dom.msgInput.value = "";
    _pendingFiles = [];
    _removeAttachmentPreview();
    autoResizeInput();
    _renderPendingSends();
  }

  function _flushPendingSends() {
    if (state.isGenerating || state.sendInFlight) return;
    if (state.connectionStatus === "disconnected") return;
    var mine = _pendingSends.filter(function (p) { return p.chatId === state.currentChatId; });
    if (!mine.length) return;
    var p = mine[0];
    _pendingSends.splice(_pendingSends.indexOf(p), 1);
    // 借发送状态机锁串行化：setSendIdle（sendMessageDone/operationError）→ updateInputState → 本函数续发下一条
    state.sendInFlight = true;
    _renderPendingSends();
    var hasMore = _pendingSends.some(function (q) { return q.chatId === state.currentChatId; });
    _postSend(p.text, p.files, /* autoReply= */ !hasMore);
  }

  // ★ P2-9: 粘贴图片支持
  // magic bytes → 真实图片格式（对齐后端 imageProcessing.mjs detectImageFormat）
  function _detectImageFormat(dataUrl) {
    try {
      var b64 = dataUrl.split(",")[1];
      if (!b64) return null;
      var bin = atob(b64.substring(0, 24));
      var b = [];
      for (var i = 0; i < bin.length; i++) b.push(bin.charCodeAt(i));
      if (b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF) return { mime:"image/jpeg", ext:"jpg" };
      if (b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47) return { mime:"image/png", ext:"png" };
      if (b[0]===0x47 && b[1]===0x49 && b[2]===0x46 && b[3]===0x38) return { mime:"image/gif", ext:"gif" };
      if (b.length>=12 && b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50) return { mime:"image/webp", ext:"webp" };
      if (b[0]===0x42 && b[1]===0x4D) return { mime:"image/bmp", ext:"bmp" };
    } catch(_) {}
    return null;
  }

  function _fixImageNameAndType(name, declaredType, dataUrl) {
    var detected = _detectImageFormat(dataUrl);
    if (!detected) return { name: name, type: declaredType };
    var fixedType = detected.mime;
    var fixedName = name;
    if (fixedName) {
      var dot = fixedName.lastIndexOf(".");
      if (dot > 0) fixedName = fixedName.substring(0, dot + 1) + detected.ext;
      else fixedName = fixedName + "." + detected.ext;
    } else {
      fixedName = "clipboard." + detected.ext;
    }
    return { name: fixedName, type: fixedType };
  }

  function _initPasteHandler() {
    if (!dom.msgInput) return;
    dom.msgInput.addEventListener("paste", function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          if (!file) continue;
          var reader = new FileReader();
          reader.onload = function (ev) {
            var base64 = ev.target.result;
            var fixed = _fixImageNameAndType(file.name || "clipboard.png", file.type, base64);
            _pendingFiles.push({ name: fixed.name, type: fixed.type, data: base64 });
            _showAttachmentPreview();
          };
          reader.readAsDataURL(file);
        }
      }
    });
  }

  function _showAttachmentPreview() {
    _removeAttachmentPreview();
    if (_pendingFiles.length === 0) return;
    var preview = document.createElement("div");
    preview.id = "yb-attachment-preview";
    preview.style.cssText = "display:flex;gap:4px;padding:4px 8px;align-items:center;background:var(--vscode-input-background);border-radius:4px 4px 0 0;border:1px solid var(--vscode-panel-border);border-bottom:none;";
    for (var i = 0; i < _pendingFiles.length; i++) {
      var img = document.createElement("img");
      img.src = _pendingFiles[i].data;
      img.style.cssText = "max-height:48px;max-width:80px;border-radius:4px;object-fit:cover;";
      img.title = _pendingFiles[i].name;
      preview.appendChild(img);
    }
    var removeBtn = document.createElement("button");
    removeBtn.textContent = "\u2715";
    removeBtn.style.cssText = "background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:14px;margin-left:auto;";
    removeBtn.addEventListener("click", function () { _pendingFiles = []; _removeAttachmentPreview(); });
    preview.appendChild(removeBtn);
    // 插入到输入区域上方
    var inputArea = dom.msgInput.closest(".input-area");
    if (inputArea) inputArea.insertBefore(preview, inputArea.firstChild);
  }

  function _removeAttachmentPreview() {
    var old = document.getElementById("yb-attachment-preview");
    if (old) old.remove();
  }

  _initPasteHandler();

  // ★ 代码块复制按钮
  function _addCodeCopyButtons(container) {
    var blocks = container.querySelectorAll("pre.yb-code-block, pre");
    for (var i = 0; i < blocks.length; i++) {
      var pre = blocks[i];
      if (pre.querySelector(".yb-copy-btn")) continue;
      pre.style.position = "relative";
      var btn = document.createElement("button");
      btn.className = "yb-copy-btn";
      btn.textContent = "\uD83D\uDCCB";
      btn.title = "\u590D\u5236\u4EE3\u7801";
      btn.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(255,255,255,0.1);border:none;color:var(--vscode-foreground);cursor:pointer;padding:2px 6px;border-radius:3px;font-size:12px;opacity:0.6;";
      btn.addEventListener("mouseenter", function() { this.style.opacity = "1"; });
      btn.addEventListener("mouseleave", function() { this.style.opacity = "0.6"; });
      (function(codeBlock, copyBtn) {
        copyBtn.addEventListener("click", function() {
          var code = codeBlock.querySelector("code");
          var text = code ? code.textContent : codeBlock.textContent;
          navigator.clipboard.writeText(text).then(function() {
            copyBtn.textContent = "\u2705";
            setTimeout(function() { copyBtn.textContent = "\uD83D\uDCCB"; }, 2000);
          }).catch(function() {
            copyBtn.textContent = "\u274C";
            setTimeout(function() { copyBtn.textContent = "\uD83D\uDCCB"; }, 2000);
          });
        });
      })(pre, btn);
      pre.appendChild(btn);
    }
  }

  function autoResizeInput() {
    if (!dom.msgInput) return;
    dom.msgInput.style.height = "auto";
    dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 200) + "px";
  }

  // ═══════════════════════════════════════════════════════
  // IDE 写操作审批卡片（dock 式，显示在聊天底部，与 chat-modes.js 的汉堡菜单 IDE 审批弹窗是同一数据的不同视图）
  // 链路：生成结束 → startApprovalPoll → 轮询 getIdeApprovals → onIdeApprovals → renderApprovalDock
  // 不要把 dock 版和弹窗版混为一体——dock 版用 _operatedOpIds 过滤已操作项，弹窗版用自己的逻辑
  // ═══════════════════════════════════════════════════════

  var _approvalPollTimer = null;
  var _lastApprovalCount = 0;
  // 已操作的 opId 集合：轮询渲染时过滤掉已点击允许/拒绝的 op，防 innerHTML 重建覆盖 disabled 状态
  var _operatedOpIds = new Set();

  /** 拉取待审批操作并渲染卡片 */
  function pollIdeApprovals() {
    vscode.postMessage({ type: "getIdeApprovals" });
  }

  /** 开始轮询审批状态（AI 生成完成后启动） */
  function startApprovalPoll() {
    if (_approvalPollTimer) return;
    pollIdeApprovals();
    _approvalPollTimer = setInterval(pollIdeApprovals, YB.POLL.approval); // 单源=constants.ts APPROVAL_POLL_MS
  }

  /** 停止轮询 */
  function stopApprovalPoll() {
    if (_approvalPollTimer) {
      clearInterval(_approvalPollTimer);
      _approvalPollTimer = null;
    }
  }

  /** 处理后端返回的审批数据 */
  function onIdeApprovals(data) {
    var pending = (data && data.pendingApprovals) || [];
    _lastApprovalCount = pending.length;
    renderApprovalDock(pending);
    // 无待审批时停止轮询
    if (pending.length === 0) {
      stopApprovalPoll();
    }
  }

  /** 处理审批结果（approve/reject 完成后） */
  function onIdeApprovalResult(data) {
    // 刷新一次
    pollIdeApprovals();
    if (data && data.success !== false) {
      YB.showToast(
        data.action === "approve" || data.action === "approveAll"
          ? "操作已批准并执行"
          : "操作已拒绝",
        data.action === "approve" || data.action === "approveAll" ? 3000 : 2000
      );
    }
  }

  /** 渲染审批 dock（固定在消息列表底部） */
  function renderApprovalDock(pending) {
    // 过滤掉已操作的 op（防轮询 innerHTML 重建覆盖 disabled 状态）
    pending = pending.filter(function (op) { return !_operatedOpIds.has(op.id); });
    var existing = document.getElementById("yb-approval-dock");
    if (pending.length === 0) {
      if (existing) existing.remove();
      _operatedOpIds.clear(); // 全部清空时重置
      return;
    }

    var dock = existing || document.createElement("div");
    dock.id = "yb-approval-dock";
    dock.className = "approval-dock";

    var html = '<div class="approval-header">' +
      '<span class="approval-icon">⚠</span>' +
      '<span class="approval-title">' + pending.length + ' 个写操作待审批</span>' +
      '<div class="approval-header-actions">' +
      '<button class="approval-btn approval-btn-approve-all" title="全部批准">✓ 全部批准</button>' +
      '<button class="approval-btn approval-btn-reject-all" title="全部拒绝">✕ 全部拒绝</button>' +
      '</div></div>';

    html += '<div class="approval-list">';
    for (var i = 0; i < pending.length; i++) {
      var op = pending[i];
      var desc = op.tool || "unknown";
      var detail = op.params ? (op.params.path || op.params.command || "") : "";
      html += '<div class="approval-item" data-op-id="' + escapeHtml(op.id) + '">' +
        '<span class="approval-tool-badge">' + escapeHtml(desc) + '</span>' +
        '<span class="approval-detail" title="' + escapeHtml(detail) + '">' + escapeHtml(detail) + '</span>' +
        '<button class="approval-btn-sm approval-btn-approve" title="批准">✓</button>' +
        '<button class="approval-btn-sm approval-btn-reject" title="拒绝">✕</button>' +
        '</div>';
    }
    html += '</div>';

    dock.innerHTML = html;

    if (!existing && dom.messageList) {
      // 插入到消息列表容器的父元素中（不在滚动区内）
      dom.messageList.parentNode.insertBefore(dock, dom.messageList.nextSibling);
    }

    // 绑定事件
    var approveAllBtn = dock.querySelector(".approval-btn-approve-all");
    if (approveAllBtn) {
      approveAllBtn.onclick = function () {
        pending.forEach(function (op) { _operatedOpIds.add(op.id); });
        approveAllBtn.disabled = true;
        vscode.postMessage({ type: "approveAllIdeOps" });
        YB.showToast("正在批准全部操作…", 2000);
      };
    }
    var rejectAllBtn = dock.querySelector(".approval-btn-reject-all");
    if (rejectAllBtn) {
      rejectAllBtn.onclick = function () {
        pending.forEach(function (op) { _operatedOpIds.add(op.id); });
        rejectAllBtn.disabled = true;
        vscode.postMessage({ type: "rejectAllIdeOps" });
        YB.showToast("正在拒绝全部操作…", 2000);
      };
    }
    dock.querySelectorAll(".approval-btn-approve").forEach(function (btn) {
      btn.onclick = function () {
        var opId = btn.closest(".approval-item").dataset.opId;
        _operatedOpIds.add(opId);
        btn.disabled = true; btn.textContent = "…";
        vscode.postMessage({ type: "approveIdeOp", payload: { opId: opId } });
      };
    });
    dock.querySelectorAll(".approval-btn-reject").forEach(function (btn) {
      btn.onclick = function () {
        var opId = btn.closest(".approval-item").dataset.opId;
        _operatedOpIds.add(opId);
        btn.disabled = true; btn.textContent = "…";
        vscode.postMessage({ type: "rejectIdeOp", payload: { opId: opId } });
      };
    });
  }

  /**
   * WS重连/面板恢复时同步消息（不清空界面，只补漏）
   */
  function onChatResync(payload) {
    if (!payload || payload.error) return;
    // [归属校验 0726] 与 onChatInitialData / onChatReconnected / onMissedMessages 同款：
    //   _resyncChat 里 await getInitialData 期间用户可能已切走，晚到的 resync 会把**旧对话的消息**
    //   按 id 去重后补进当前对话（本函数下方就是直接 onMessageAdded/替换 state.messages）。
    //   provider 侧已随 payload 带 chatId，这里是最后一个漏了校验的消费端。
    if (payload.chatId && state.currentChatId && payload.chatId !== state.currentChatId) {
      console.log("[YonBan] 忽略过期 chatResync:", payload.chatId, "当前:", state.currentChatId);
      return;
    }
    var newMessages = payload.initialLog || [];
    var logLength = payload.logLength || newMessages.length;
    // resync 是服务端权威窗口，不是“只补条数”。条数相等时消息仍可能已经编辑、替换或生成落定；
    // 只比较 length 会永久保留旧内容/流式占位。若本地已向前加载历史，则仅替换服务端返回的尾窗，
    // 保留其前面的已加载区；窗口无法连续对齐时才用服务端窗口整体校正。
    var serverOffset = Math.max(0, logLength - newMessages.length);
    var localOffset = Math.max(0, state.logOffset || 0);
    var localEnd = localOffset + state.messages.length;
    if (serverOffset >= localOffset && serverOffset <= localEnd) {
      state.messages = state.messages.slice(0, serverOffset - localOffset).concat(newMessages);
      state.logOffset = localOffset;
    } else {
      state.messages = newMessages;
      state.logOffset = serverOffset;
    }
    state.streamingContent = {};
    renderAllMessages();
    scrollToBottom(true);
    // 更新生成状态
    var lastMsg = newMessages.length > 0 ? newMessages[newMessages.length - 1] : null;
    if (lastMsg && lastMsg.is_generating) {
      state.isGenerating = true;
      state.generatingMessageId = lastMsg.id;
    } else {
      state.isGenerating = false;
      state.generatingMessageId = null;
    }
    updateInputState();
  }

  /**
   * H2: WS 重连后请求增量补拉断线期漏掉的消息。
   * 计算本地已持有的「服务端绝对消息数」= logOffset + 本地消息数，回发后端按区间补拉。
   * （区别于 onChatResync 的全量窗口对账：此处按 index 精确补 [localServerCount, serverLength)，
   *   不会因 initial-data 只返回尾部窗口而误判/丢历史。）
   */
  function onChatReconnected(payload) {
    var chatId = (payload && payload.chatId) || state.currentChatId;
    if (!chatId || chatId !== state.currentChatId) return;
    var localServerCount = (state.logOffset || 0) + state.messages.length;
    vscode.postMessage({
      type: "requestMissedMessages",
      payload: { chatId: chatId, localServerCount: localServerCount },
    });
  }

  /**
   * H2: 后端返回断线期漏掉的消息区间 → 逐条追加（含去重，防与同期 message_added 推送重复）。
   * onMessageAdded 已处理 system/工具结果过滤与渲染，直接复用。
   */
  function onMissedMessages(payload) {
    if (!payload || !payload.chatId || payload.chatId !== state.currentChatId) return;
    var missed = payload.missed || [];
    if (!missed.length) return;
    // 去重：按 id 跳过本地已有的（重连瞬间 message_added 推送可能与补拉区间重叠）
    var existingIds = {};
    for (var j = 0; j < state.messages.length; j++) {
      var mid = state.messages[j] && state.messages[j].id;
      if (mid != null) existingIds[mid] = true;
    }
    for (var i = 0; i < missed.length; i++) {
      var entry = missed[i];
      if (entry && entry.id != null && existingIds[entry.id]) continue;
      onMessageAdded(entry);
    }
    // 服务端绝对长度对齐（补拉后本地与服务端一致，logOffset 不变=区间紧接本地尾部）
    if (typeof payload.serverLength === "number") {
      state.logOffset = payload.serverLength - state.messages.length;
      if (state.logOffset < 0) state.logOffset = 0;
    }
  }

  // ── 导出到 YB ─────────────────────────────────────
  YB.switchToChat = switchToChat;
  YB.applySwitchedChat = applySwitchedChat;
  YB.onChatInitialData = onChatInitialData;
  YB.onChatResync = onChatResync;
  YB.onChatReconnected = onChatReconnected;
  // ── AI 提问 dock（0714 Kilo 式改道：替代 VSCode 顶部模态 InputBox，复用审批 dock 样式）──
  // 链路：本体 WS question → IdeWsServer.onQuestion → YonBanProvider.handleAiQuestion
  //       → postMessage aiQuestion → 本 dock → 用户作答 → postMessage aiQuestionAnswer → resolve 回 WS。
  function showAiQuestionDock(payload) {
    if (!payload || !payload.id) return;
    var dockId = "yb-ai-question-dock";
    var dock = document.getElementById(dockId);
    if (!dock) {
      dock = document.createElement("div");
      dock.id = dockId;
      dock.className = "approval-dock";
      if (dom.messageList) dom.messageList.parentNode.insertBefore(dock, dom.messageList.nextSibling);
      else document.body.appendChild(dock);
    }
    var item = document.createElement("div");
    item.className = "approval-item";
    item.setAttribute("data-q-id", payload.id);
    item.style.flexWrap = "wrap";
    item.innerHTML =
      '<span class="approval-tool-badge">❓ AI 提问</span>' +
      '<span class="approval-detail" style="white-space:pre-wrap;flex:1 1 100%;">' + escapeHtml(payload.text || "") + '</span>' +
      '<input class="yb-q-input" type="text" placeholder="输入回答，回车发送…" style="flex:1 1 auto;min-width:120px;" />' +
      '<button class="approval-btn-sm approval-btn-approve" title="发送回答">✓ 回答</button>' +
      '<button class="approval-btn-sm approval-btn-reject" title="不回答（AI 将收到未回答）">✕ 忽略</button>';
    dock.appendChild(item);
    var input = item.querySelector(".yb-q-input");
    function submit(answered) {
      vscode.postMessage({ type: "aiQuestionAnswer", payload: { id: payload.id, answer: (input && input.value) || "", answered: !!answered } });
      item.remove();
      if (!dock.querySelector(".approval-item")) dock.remove();
    }
    item.querySelector(".approval-btn-approve").onclick = function () { submit(true); };
    item.querySelector(".approval-btn-reject").onclick = function () { submit(false); };
    if (input) {
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(true); });
      try { input.focus(); } catch (_) { /* 面板隐藏时 focus 失败无害 */ }
    }
  }
  function removeAiQuestionDock(qid) {
    var dock = document.getElementById("yb-ai-question-dock");
    if (!dock) return;
    if (qid) {
      var item = dock.querySelector('[data-q-id="' + qid + '"]');
      if (item) item.remove();
      if (!dock.querySelector(".approval-item")) dock.remove();
    } else {
      dock.remove();
    }
  }

  YB.onMissedMessages = onMissedMessages;
  YB.onMessageAdded = onMessageAdded;
  YB.onMessageReplaced = onMessageReplaced;
  YB.onMessageDeleted = onMessageDeleted;
  YB.onMessageEdited = onMessageEdited;
  YB.onEditMessageResult = onEditMessageResult;
  YB.onRollbackResult = onRollbackResult;
  YB.onRollbackPreview = onRollbackPreview;
  YB.onStreamStart = onStreamStart;
  YB.onStreamUpdate = onStreamUpdate;
  YB.onTypingStatus = onTypingStatus;
  YB.renderAllMessages = renderAllMessages;
  YB.updateInputState = updateInputState;
  YB.sendMessage = sendMessage;
  YB.queuePendingSend = queuePendingSend; // [0719 中途输入] 生成中排队入口（chat.js 发送按钮分流）
  YB.autoResizeInput = autoResizeInput;
  // U06：发送失败复位等待标记（chat.js operationError(action=sendMessage) 调用，文本保留可重发）
  YB.abortSendAck = _abortSendAck;
  // dock 版审批已被 chat-modes.js 悬浮窗版替代，不再导出到 YB（避免覆盖冲突）
  YB.startApprovalPoll = startApprovalPoll;
  YB.stopApprovalPoll = stopApprovalPoll;
  // 注册底部审批 dock 消费者（chat-modes.js 加载在后，会链式包装而非覆盖此注册）
  YB.onIdeApprovals = onIdeApprovals;
  YB.onIdeApprovalResult = onIdeApprovalResult;
  // AI 提问 dock（消费方 chat.js case "aiQuestion"/"aiQuestionClosed"）
  YB.showAiQuestionDock = showAiQuestionDock;
  YB.removeAiQuestionDock = removeAiQuestionDock;
  } catch(e) { try { window.YB.showToast("\uD83D\uDEA8 chat-messages 加载失败: " + e.message, 8000); } catch(_) {} console.error("[chat-messages] 加载失败:", e); }
})();
