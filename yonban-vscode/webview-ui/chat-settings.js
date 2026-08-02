/**
 * [chat-settings] — 设置视图 UI 渲染层。不管数据获取（那是 chat-connection.js 和 Extension 的事）。
 *
 * 链路：chat-connection.js 数据 handler → 调本模块渲染函数 → DOM 更新
 *       用户操作（选角色/选对话/改预设参数）→ vscode.postMessage → Extension → 后端
 * 影响：操作 DOM(角色列表/聊天列表/预设参数面板/AI 权限面板)；写 state(selectedChar/chatListData)
 * 相交：← chat-connection.js(onCharList/onChatList 数据处理后委托渲染)
 *        → chat-messages.js(switchToChat 切对话)  → chat-modes.js(fetchClones)
 *
 * 功能域索引（行号易腐不标注，按 ═══/── 分区标记或函数名查找）：
 *   — initSettingsTabs（Tab 切换事件：connect/memory/submodes/prompt/ai-control/preset/clones）
 *   — 角色卡条状列表 renderCharStripList / selectCharInSettings
 *   — 聊天条状列表 renderChatStripList（按选中角色过滤 + 新建/删除/进入聊天）
 *   — 运行参数 Tab（loadPromptSettings / onRuntimeParams — 温度/top_p/频率惩罚等滑块）
 *   — AI 权限控制 Tab（loadAiControlSettings / onFilesConfig — 文件读写/命令执行等开关）
 *   — 预设 Tab（loadPresetTab / onPresetConfig / fillPresetParams — 预设选择/参数调节/生命周期管理）
 *   — 导出到 YB 命名空间
 */
// =====================================================
// chat-settings.js — 设置视图层 (V2 新增)
// Tab 切换 + 角色条状列表 + 聊天条状列表
// =====================================================

(function () {
  "use strict";
  try {
  const {
    dom,
    state,
    vscode,
    switchSettingsTab,
    showView,
    escapeHtml,
    formatTime,
  } = window.YB;

  // ═══════════════════════════════════════════════════════
  // Tab 切换事件
  // ═══════════════════════════════════════════════════════

  function initSettingsTabs() {
    dom.settingsTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabName = tab.dataset.tab;
        if (tabName) {
          switchSettingsTab(tabName);
          // 切换到特定tab时加载数据
          if (tabName === "memory") {
            vscode.postMessage({ type: "getMemoryConfig" });
          } else if (tabName === "submodes") {
            vscode.postMessage({ type: "getSubModes" });
          } else if (tabName === "prompt") {
            loadPromptSettings();
          } else if (tabName === "ai-control") {
            loadAiControlSettings();
          } else if (tabName === "preset") {
            loadPresetTab();
          } else if (tabName === "clones") {
            YB.fetchClones();
          }
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // 角色卡条状列表（替代旧的角色网格）
  // ═══════════════════════════════════════════════════════

  function renderCharStripList() {
    const list = dom.charList;
    if (!list) return;
    list.innerHTML = "";

    if (state.charNames.length === 0) {
      list.innerHTML = '<div class="strip-empty">连接后加载角色列表</div>';
      return;
    }

    for (const name of state.charNames) {
      const meta = state.charMeta[name] || { name, chatCount: 0 };
      const item = document.createElement("div");
      item.className =
        "strip-item" + (name === state.selectedChar ? " active" : "");
      item.dataset.charName = name;

      const nameEl = document.createElement("span");
      nameEl.className = "strip-item-name";
      nameEl.textContent = name;
      nameEl.title = name;
      item.appendChild(nameEl);

      const countEl = document.createElement("span");
      countEl.className = "strip-item-meta";
      countEl.textContent = meta.chatCount + " 个聊天";
      item.appendChild(countEl);

      item.addEventListener("click", () => {
        selectCharInSettings(name);
      });

      list.appendChild(item);
    }
  }

  function selectCharInSettings(charName) {
    state.selectedChar = charName;
    state.hasBoundChar = true;

    // 持久化用户选择
    YB.saveUserState();

    // 更新角色列表高亮
    renderCharStripList();

    // 过滤并显示聊天列表
    state.chatListData = state.allChats.filter((chat) => {
      const chars = chat.chars || [];
      return chars.includes(charName);
    });

    if (dom.chatListSection) {
      dom.chatListSection.classList.remove("hidden");
    }
    if (dom.chatListTitle) {
      dom.chatListTitle.textContent = charName + " 的聊天";
    }

    renderChatStripList();
  }

  // ═══════════════════════════════════════════════════════
  // 聊天条状列表
  // ═══════════════════════════════════════════════════════

  // 模式展示文案（镜像本体 modeTabMap.mjs MODE_BADGE labels，改必双侧同步）。
  // getchatlist 每条注入 chat.mode（模式归属徽标）+ chat.usedByModes（「XX窗口在用」指针反查），
  // 本体四列表已消费，此前 YonBan 条状列表未消费=徽标缺失（0714 案）。
  var MODE_BADGE_LABELS = { chat: "聊天", smart: "全智能", code: "编程", work: "工作" };

  function renderChatStripList() {
    const list = dom.chatList;
    if (!list) return;
    list.innerHTML = "";

    if (state.chatListData.length === 0) {
      list.innerHTML = '<div class="strip-empty">暂无聊天，点击 + 新建</div>';
      return;
    }

    state.chatListData.sort(function(a, b) { return (b.lastMessageTime || 0) - (a.lastMessageTime || 0); });
    for (const chat of state.chatListData) {
      const item = document.createElement("div");
      item.className =
        "strip-item chat-strip-item" +
        (chat.chatid === state.currentChatId ? " active" : "");
      item.dataset.chatId = chat.chatid;

      const topRow = document.createElement("div");
      topRow.className = "strip-item-top";

      // 模式归属徽标（服务端 chat.mode 单源，空串=未分类不显示，口径同本体 buildModeBadge）
      if (chat.mode && MODE_BADGE_LABELS[chat.mode]) {
        const modeEl = document.createElement("span");
        modeEl.className = "strip-mode-badge";
        modeEl.title = "此对话属于" + MODE_BADGE_LABELS[chat.mode] + "窗口";
        modeEl.textContent = MODE_BADGE_LABELS[chat.mode];
        topRow.appendChild(modeEl);
      }

      const titleEl = document.createElement("span");
      titleEl.className = "strip-item-name";
      titleEl.textContent =
        chat.customName ||
        (chat.firstUserMessage
          ? chat.firstUserMessage.slice(0, 40)
          : (chat.chatid ? chat.chatid.slice(0, 12) : "新对话"));
      topRow.appendChild(titleEl);

      // 「XX窗口在用」徽标（服务端 chat.usedByModes 单源，口径同本体 buildInUseLabel）
      for (const um of (chat.usedByModes || [])) {
        const label = MODE_BADGE_LABELS[um] || um;
        const useEl = document.createElement("span");
        useEl.className = "strip-using-badge";
        useEl.title = label + "窗口当前正在使用此对话文件";
        useEl.textContent = label + "·在用";
        topRow.appendChild(useEl);
      }

      if (chat.lastMessageTime) {
        const timeEl = document.createElement("span");
        timeEl.className = "strip-item-meta";
        timeEl.textContent = formatTime(chat.lastMessageTime) || "";
        topRow.appendChild(timeEl);
      }

      item.appendChild(topRow);

      if (chat.lastMessageContent) {
        const previewEl = document.createElement("div");
        previewEl.className = "strip-item-preview";
        const sender = chat.lastMessageSender
          ? chat.lastMessageSender + ": "
          : "";
        previewEl.textContent = sender + chat.lastMessageContent.slice(0, 60);
        item.appendChild(previewEl);
      }

      // 操作按钮区
      const actionsEl = document.createElement("div");
      actionsEl.className = "strip-item-actions";

      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn strip-del-btn";
      delBtn.textContent = "✕";
      delBtn.title = "删除此聊天";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!delBtn._confirmPending) {
          delBtn._confirmPending = true;
          delBtn.textContent = "\u786E\u8BA4?";
          delBtn.style.color = "#ef5350";
          setTimeout(function() {
            if (delBtn) { delBtn._confirmPending = false; delBtn.textContent = "\u2715"; delBtn.style.color = ""; }
          }, 3000);
        } else {
          vscode.postMessage({
            type: "deleteChat",
            payload: { chatId: chat.chatid },
          });
        }
      });
      actionsEl.appendChild(delBtn);
      item.appendChild(actionsEl);

      // 点击进入聊天
      item.addEventListener("click", () => {
        item.style.opacity = "0.5";
        item.style.pointerEvents = "none";
        YB.showToast("切换中…", 1500);
        YB.switchToChat(chat.chatid, chat);
        // 自动切到聊天视图
        showView("chat");
      });

      list.appendChild(item);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════════════════════

  initSettingsTabs();

  // ═══════════════════════════════════════════════════════
  // 提示词设置（后处理 + 预填充）
  // ═══════════════════════════════════════════════════════

  function loadPromptSettings() {
    vscode.postMessage({ type: "getRuntimeParams" });
  }

  function onRuntimeParams(data) {
    var pp = document.getElementById("promptPostProcessing");
    var pe = document.getElementById("prefillEnabled");
    // T002：删本地 fallback "none"——后端 GET runtime-params 恒返回含默认的合并对象
    // （preset/main.mjs loadRuntimeParams 铺 RUNTIME_PARAMS_DEFAULTS），下发值即唯一权威。
    if (pp && data.prompt_post_processing !== undefined) pp.value = data.prompt_post_processing;
    if (pe) pe.checked = !!data.prefill_enabled;
  }

  // 保存按钮
  var saveBtn = document.getElementById("savePromptSettings");
  if (saveBtn) {
    saveBtn.addEventListener("click", function () {
      var pp = document.getElementById("promptPostProcessing");
      var pe = document.getElementById("prefillEnabled");
      // T002/H3同型守卫：DOM 取不到=报错中止保存，禁塞默认值静默覆盖用户设置
      if (!pp || !pe) {
        YB.showToast("✗ 后处理设置控件缺失，保存已中止");
        return;
      }
      // ★ claude_prefill_mode 由子模式配置决定，YonBan 不重复发送
      vscode.postMessage({
        type: "setRuntimeParams",
        payload: {
          prompt_post_processing: pp.value,
          prefill_enabled: pe.checked,
        },
      });
      var status = document.getElementById("promptSettingsStatus");
      if (status) {
        status.textContent = "已保存";
        setTimeout(function () { status.textContent = ""; }, 2000);
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  // AI 控制面板
  // ═══════════════════════════════════════════════════════

  function loadAiControlSettings() {
    vscode.postMessage({ type: "getFilesConfig" });
    vscode.postMessage({ type: "getRuntimeParams" });
    // 显示当前预设名
    var presetEl = document.getElementById("aiActivePreset");
    if (presetEl && state.activePreset) {
      presetEl.textContent = state.activePreset;
    }
  }

  // ── AI 文件处理能力：权限项目录后端单源（同步+映射） ──
  // 键集=getFilesConfig 下发的 permissions 对象键（beilu-files main.mjs _makeUserData
  //   file_read/file_write/file_delete/file_retry/mcp/questions/todo）+ allowExec 特例。
  // why：旧 HTML 写死 data-perm="read/write/question/cleanup..." 与后端真键全对不上——
  //   perms[key] 恒 undefined → 开关显示 HTML 假 checked（谎报），改动还把无消费者的
  //   垃圾键 merge 进后端配置。后端键集驱动生成后，后端增删权限项 UI 自动跟随。
  // PERM_LABELS 只是已知键的显示文案映射，未知新键裸键名显示（不挡新功能）。
  var PERM_LABELS = {
    file_read: "📖 读取",
    file_write: "✏️ 写入",
    file_delete: "🗑️ 删除",
    file_retry: "🔄 重试",
    mcp: "🔌 MCP",
    questions: "❓ 问题",
    todo: "📋 待办",
    exec: "⚡ 命令执行",
  };
  function renderAiPermList(data) {
    var box = document.getElementById("aiPermList");
    if (!box) return;
    var perms = data.permissions || {};
    var entries = Object.keys(perms).map(function (k) {
      return { key: k, checked: !!perms[k], isExec: false };
    });
    if (data.allowExec !== undefined) {
      entries.push({ key: "exec", checked: !!data.allowExec, isExec: true });
    }
    if (entries.length === 0) return; // 下发无权限字段=保留等待态，不摆空面板
    box.innerHTML = "";
    entries.forEach(function (en) {
      var label = document.createElement("label");
      label.className = "perm-toggle-row";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "ai-perm-toggle";
      cb.dataset.perm = en.key;
      cb.checked = en.checked;
      cb.addEventListener("change", function () {
        if (en.isExec) {
          vscode.postMessage({ type: "setFilesConfig", payload: { allowExec: cb.checked } });
        } else {
          var permissions = {};
          permissions[en.key] = cb.checked;
          vscode.postMessage({ type: "setFilesConfig", payload: { permissions: permissions } });
        }
      });
      var span = document.createElement("span");
      span.textContent = PERM_LABELS[en.key] || en.key;
      label.appendChild(cb);
      label.appendChild(span);
      box.appendChild(label);
    });
  }

  function onFilesConfig(data) {
    renderAiPermList(data);
    // 模式切换清理 & 自动继续（从VSCode状态读取，不在beilu-files中）
    var savedState = vscode.getState() || {};
    var msc = document.getElementById("aiModeSwitchClean");
    if (msc) msc.checked = !!savedState.modeSwitchCleanup;
    var ac = document.getElementById("aiAutoContinue");
    if (ac) ac.checked = !!savedState.autoContinue;
    // （联网搜索开关恢复已迁 webSearchState 消息（真源 beilu-memory），此处 filesConfig 从不含
    //   web_search 字段——旧读点=双源分叉残留，0714 镜像删除）
  }

  // fillModelSettings removed — 模型参数已移到预设 tab

  // （权限开关即时同步的 change 监听已随行生成绑定在 renderAiPermList 内——静态绑定块删除：
  //   动态重建行后旧节点监听随节点销毁，顶层一次性 querySelectorAll 绑不到新行）

  // 保存按钮（模式清理 + 自动继续 → VSCode状态持久化）
  var saveAiBtn = document.getElementById("saveAiControlSettings");
  if (saveAiBtn) {
    saveAiBtn.addEventListener("click", function () {
      var msc = document.getElementById("aiModeSwitchClean");
      var ac = document.getElementById("aiAutoContinue");

      // 保存到VSCode状态（webview持久化，不依赖后端；经 patchState 单点写，散写收口 2026-07-13）
      var currentState = window.YB.patchState({
        modeSwitchCleanup: msc ? msc.checked : false,
        autoContinue: ac ? ac.checked : false,
      });
      // 同步到扩展后端持久化
      vscode.postMessage({ type: "saveUserState", payload: currentState });

      var status = document.getElementById("aiControlStatus");
      if (status) {
        status.textContent = "已保存";
        setTimeout(function () { status.textContent = ""; }, 2000);
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  // 预设 & 模型参数 tab
  // 链路：loadPresetTab → getPresetConfig + getRuntimeParams → 后端返回 → onPresetConfig / onRuntimeParams
  //       预设切换/参数修改 → vscode.postMessage(switchPreset / setRuntimeParams)
  // 生命周期管理：createPreset / duplicatePreset / renamePreset / deletePreset → 经 Extension 统一路由
  // ═══════════════════════════════════════════════════════

  function loadPresetTab() {
    vscode.postMessage({ type: "getPresetConfig" });
    vscode.postMessage({ type: "getRuntimeParams" });
  }

  /** 填充预设下拉框和当前预设参数 */
  function onPresetConfig(data) {
    var sel = document.getElementById("presetSelector");
    if (!sel) return;
    sel.innerHTML = "";
    var presetList = (data.preset_list || []).slice().sort();
    // ★ per-chatId 预设(对齐本体 resolveActivePresetFor)：选中项按当前对话解析,无 map fallback 全局=零回归。
    var _cidPS = (state && state.currentChatId) || "";
    var active = (_cidPS && data.active_preset_map && data.active_preset_map[_cidPS]) || data.active_preset || "";
    for (var i = 0; i < presetList.length; i++) {
      var opt = document.createElement("option");
      opt.value = presetList[i];
      opt.textContent = presetList[i];
      if (presetList[i] === active) opt.selected = true;
      sel.appendChild(opt);
    }
    // 也更新 AI 控制面板的预设名
    var presetLabel = document.getElementById("aiActivePreset");
    if (presetLabel) presetLabel.textContent = active || "—";
  }

  // 预设选择变化 → 切换预设
  // T022 Q1：补 chatid/mode（照 chat-modes.js :1009 样板）——原 payload 只有 name → 后端走全局分支
  // 污染所有 tab 的激活预设（读A写B族）；带 chatid 后只写 active_preset_map[chatId:mode] 本会话隔离。
  var presetSel = document.getElementById("presetSelector");
  if (presetSel) {
    presetSel.addEventListener("change", function () {
      var _sm = (state.allSubModes || state.subModes || []).find(function (m) { return m.id === state.activeSubMode; });
      vscode.postMessage({
        type: "switchPreset",
        payload: { name: presetSel.value, chatid: state.currentChatId || "", mode: (_sm && _sm.modeGroup) || YB.DEFAULT_MODE },
      });
      YB.showToast("预设切换中…", 1500);
    });
  }

  // 预设管理按钮
  var _presetNew = document.getElementById("presetNew");
  if (_presetNew) {
    _presetNew.addEventListener("click", function () {
      YB.showInputDialog("\u65B0\u9884\u8BBE\u540D\u79F0", "", function(name) {
        if (!name || !name.trim()) return;
        vscode.postMessage({ type: "createPreset", payload: { name: name.trim() } });
        YB.showToast("新建预设中…", 1500);
      });
    });
  }
  var _presetDup = document.getElementById("presetDup");
  if (_presetDup) {
    _presetDup.addEventListener("click", function () {
      var sel = document.getElementById("presetSelector");
      var current = sel ? sel.value : "";
      if (!current) return;
      vscode.postMessage({ type: "duplicatePreset", payload: { name: current } });
      YB.showToast("复制预设中…", 1500);
    });
  }
  var _presetRename = document.getElementById("presetRename");
  if (_presetRename) {
    _presetRename.addEventListener("click", function () {
      var sel = document.getElementById("presetSelector");
      var current = sel ? sel.value : "";
      if (!current) return;
      YB.showInputDialog("\u65B0\u540D\u79F0", current, function(newName) {
        if (!newName || !newName.trim() || newName.trim() === current) return;
        vscode.postMessage({ type: "renamePreset", payload: { oldName: current, newName: newName.trim() } });
        YB.showToast("重命名中…", 1500);
      });
    });
  }
  var _presetDel = document.getElementById("presetDel");
  if (_presetDel) {
    _presetDel.addEventListener("click", function () {
      var sel = document.getElementById("presetSelector");
      var current = sel ? sel.value : "";
      if (!current) return;
      if (!_presetDel._confirmPending) {
        _presetDel._confirmPending = true;
        var origText = _presetDel.textContent;
        _presetDel.textContent = "\u786E\u8BA4\u5220\u9664?";
        _presetDel.style.color = "#ef5350";
        setTimeout(function() { _presetDel._confirmPending = false; _presetDel.textContent = origText; _presetDel.style.color = ""; }, 3000);
      } else {
        vscode.postMessage({ type: "deletePreset", payload: { name: current } });
        YB.showToast("删除中…", 1500);
      }
    });
  }

  // 预设参数由子模式编辑控制，此处不再需要保存按钮

  // ── 导出到 YB ─────────────────────────────────────
  YB.renderCharStripList = renderCharStripList;
  YB.selectCharInSettings = selectCharInSettings;
  YB.renderChatStripList = renderChatStripList;
  YB.onRuntimeParams = onRuntimeParams;
  YB.onFilesConfig = onFilesConfig;
  // 订阅者模式注册（不再依赖 chat-modes.js 先加载）
  if (!YB._presetConfigHandlers) YB._presetConfigHandlers = [];
  YB._presetConfigHandlers.push(onPresetConfig);
  YB.loadAiControlSettings = loadAiControlSettings;
  } catch(e) { try { window.YB.showToast("\uD83D\uDEA8 chat-settings 加载失败: " + e.message, 8000); } catch(_) {} console.error("[chat-settings] 加载失败:", e); }
})();
