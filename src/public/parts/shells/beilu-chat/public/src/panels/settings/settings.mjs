/**
 * settings.mjs — 设置弹窗装配与首次引导 cluster
 *
 * 功能链：点击设置按钮 → _toggleSettingsModal() 切换 #settings-modal 可见性
 *   → _initSettingsModals() 绑定设置 Tab 导航 + 按需懒加载各 Tab 内容：
 *     - AIRP Tab：加载人设/_loadPersonaEditor、预设/_loadPresetPanel、注入/_loadInjPanel、世界书/_loadWorldbookInline、正则/initRegexEditor
 *     - 安全 Tab：_initSecurityCenter()
 *     - 备份 Tab：_initBackupPanel()
 *   → _initOutputFilterPanel() 绑定输出管控规则面板（加载/保存/编辑/删除规则）
 *   → 首次引导逻辑（firstrun）检测新用户并展示欢迎步骤
 * why：设置功能点多（人设/预设/注入/世界书/正则/安全/备份/输出过滤/显示/截图/首次引导），
 *   统一在此 cluster 按 Tab 懒加载，减少首屏 API 请求
 * 关联链：被 layout.mjs import（_toggleSettingsModal/_initOutputFilterPanel/_initSettingsModals 在 initLayout 时调用）；
 *   import panels.mjs（各 Tab 内容 loader）、security.mjs、backup.mjs、editor.mjs（_saveEditorPos）
 * 影响范围：改动影响设置弹窗的所有 Tab 内容、输出过滤规则、首次引导流程
 * 使用效果：用户点击右上角设置齿轮打开弹窗，切到各 Tab 时按需加载内容；首次使用时展示引导步骤
 */
import { escapeHtml } from "../../shared/state/utils.mjs";
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（memory 通配 outputFilter / server:eye·security·apikey·ping 专用路由）
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { bindContentFilterControls } from "../../shared/state/contentFilter.mjs"; // 内容过滤单 owner（与 bot 面板同域双向同步）
import { DEFAULTS } from "../../config/defaults.mjs"; // T6：cleanup 模式缺省单源，收口 `|| "auto"` 副本
import { setCleanupMode } from "../feature/featureControls.mjs"; // T5：清理模式唯一写点直连（featureControls 已由 conversationManager/layout 核心链先加载，无循环依赖），删 else 直写双写点
import { _saveEditorPos } from "../../shared/layout/editor.mjs";
import { _initSecurityCenter } from "./security.mjs";
import { _initBackupPanel } from "./backup.mjs";
import { _initImportExportPanel } from "./importExport.mjs"; // T033：导入导出集中管理面板（聚合层）
import { _loadPersonaEditor, _loadPresetPanel, _loadInjPanel, _loadWorldbookInline } from "./panels.mjs";
import { initRegexEditor } from "../editors/regexEditor.mjs";
const _escHtml = escapeHtml; // 共享 alias（layout.mjs:24 同名,不随迁,此处自备）

let _regexEditorLoaded = false;
async function _loadRegexInEditor() {
  const container = document.getElementById("airp-regex-container");
  if (!container || _regexEditorLoaded) return;
  _regexEditorLoaded = true;
  await initRegexEditor(container);
}

// ============================================================
// W24: 输出管控规则面板
// ============================================================

function _initOutputFilterPanel() {
  const listEl = document.getElementById("output-filter-list");
  const addBtn = document.getElementById("output-filter-add");
  if (!listEl || !addBtn) return;

  // T6b：outputFilter 读写走 memory 通配路由（verb=真动作组装 _action）。

  async function loadRules() {
    try {
      // 原 POST setdata {_action:getOutputFilterRules} + res.ok 手检 → memory 通配路由；!ok 由门面抛错走 catch（返 []）
      const data = await sendAction({ verb: "getOutputFilterRules", target: "plugins:beilu-memory", source: "web" });
      return data.rules || [];
    } catch (err) { console.error("[layout] loadOutputFilterRules:", err); return []; }
  }

  async function saveRules(rules) {
    try {
      // 原 POST setdata {_action:setOutputFilterRules, rules} → memory 通配路由；!ok 由门面抛错走 catch（原 console.warn 弱化为门面统一报错）
      await sendAction({ verb: "setOutputFilterRules", target: "plugins:beilu-memory", source: "web", payload: { rules } });
    } catch (err) {
      console.error("[layout] saveOutputFilterRules:", err);
      window._reportError?.(`[layout] saveOutputFilterRules: ${err.message}`, err.stack);
    }
  }

  async function render() {
    const rules = await loadRules();
    if (rules.length === 0) {
      listEl.innerHTML = '<p class="text-xs text-base-content/40">暂无过滤规则</p>';
      return;
    }
    listEl.innerHTML = rules.map((r, i) => `
      <div class="flex items-center gap-1 px-1 py-1 rounded hover:bg-base-200 text-xs">
        <input type="checkbox" class="checkbox checkbox-xs" data-idx="${i}" ${r.enabled ? "checked" : ""}>
        <span class="flex-1 truncate" title="${_escHtml(r.pattern)}">${_escHtml(r.name || r.pattern)}</span>
        <button class="btn btn-ghost btn-xs" data-edit="${i}" title="编辑"><i data-ic="edit"></i></button>
        <button class="btn btn-ghost btn-xs text-error" data-del="${i}" title="删除"><i data-ic="trash"></i></button>
      </div>`).join("");

    // 开关
    listEl.querySelectorAll("[data-idx]").forEach(cb => {
      cb.addEventListener("change", async () => {
        try {
          rules[+cb.dataset.idx].enabled = cb.checked;
          await saveRules(rules);
        } catch (err) { console.error("[layout] outputFilter toggle:", err); }
      });
    });
    // 删除
    listEl.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          rules.splice(+btn.dataset.del, 1);
          await saveRules(rules);
          render();
        } catch (err) { console.error("[layout] outputFilter delete:", err); }
      });
    });
    // 编辑
    listEl.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = rules[+btn.dataset.edit];
        showEditDialog(r, async (updated) => {
          try {
            rules[+btn.dataset.edit] = updated;
            await saveRules(rules);
            render();
          } catch (err) { console.error("[layout] outputFilter edit:", err); }
        });
      });
    });
  }

  async function showEditDialog(rule, onSave) {
    const name = await beiluPrompt("规则名称:", rule?.name || "");
    if (name === null) return;
    const pattern = await beiluPrompt("正则表达式:", rule?.pattern || "");
    if (pattern === null) return;
    const replacement = await beiluPrompt("替换为(空=删除):", rule?.replacement ?? "[已过滤]");
    if (replacement === null) return;
    const warnAi = await beiluConfirm("违规时是否警告AI？");
    const warnMessage = warnAi ? ((await beiluPrompt("警告消息:", rule?.warn_message || name)) || name) : "";
    onSave({
      id: rule?.id || "rule_" + Date.now(),
      name: name || pattern,
      pattern,
      type: "regex",
      replacement,
      warn_ai: warnAi,
      warn_message: warnMessage,
      enabled: rule?.enabled ?? true,
    });
  }

  addBtn.addEventListener("click", () => {
    showEditDialog(null, async (newRule) => {
      try {
        const rules = await loadRules();
        rules.push(newRule);
        await saveRules(rules);
        render();
      } catch (err) { console.error("[layout] outputFilter add:", err); }
    });
  });

  render().catch(err => console.error("[layout] outputFilter render:", err));
}

// ============================================================
// ============================================================
// B39修复: 设置/编辑弹窗管理
// ============================================================

function _toggleSettingsModal(which, forceOpen) {
  const overlay = document.getElementById(which === "editor" ? "center-tab-editor" : "center-tab-settings");
  if (!overlay) return;
  const shouldOpen = forceOpen !== undefined ? forceOpen : overlay.classList.contains("hidden");
  if (shouldOpen) {
    // W59修复: 打开一个弹窗时自动关闭另一个，防止重叠（W49 B16）
    const other = document.getElementById(which === "editor" ? "center-tab-settings" : "center-tab-editor");
    if (other) other.classList.add("hidden");
    overlay.classList.remove("hidden");
    // 懒加载iframe
    overlay.querySelectorAll("iframe.settings-iframe[data-src]").forEach((iframe) => {
      if (!iframe.src && iframe.dataset.src) {
        iframe.src = iframe.dataset.src;
        iframe.style.display = "";
      }
    });
  } else {
    overlay.classList.add("hidden");
  }
}

function _initSettingsModals() {
  // ST-T2: 启动时应用已保存的显示选项 (背景由 backgroundSettings.mjs 自管,FT-B3)
  try { _applyDisplayToggles(); } catch {}
  // 关闭按钮
  document.getElementById("settings-modal-close")?.addEventListener("click", () => {
    _toggleSettingsModal("settings", false);
  });
  // 编辑界面返回按钮
  document.getElementById("editor-back-btn")?.addEventListener("click", () => {
    _toggleSettingsModal("editor", false);
  });
  // 点击遮罩关闭
  ["center-tab-settings", "center-tab-editor"].forEach((id) => {
    const overlay = document.getElementById(id);
    overlay?.addEventListener("click", (e) => {
      if (e.target === overlay) _toggleSettingsModal(id.includes("editor") ? "editor" : "settings", false);
    });
  });
  // FT-D7(凛倾批「做」)+T3修2(框架级升级): ESC 中央仲裁——capture 优先，每次只关「最上一层」。
  //   原"硬编码清单"升级为「注册表 + 内置清单兜底」：各弹层(popup/modal/浮窗)向 window._beiluEscRegistry
  //   注册 {priority, isOpen, close}（priority 约定：popup/下拉=40 > modal=30 > 浮窗=20，数值大者先关），
  //   仲裁器先扫注册表按 priority 降序找首个 isOpen()→close()；注册表无命中再走内置清单(保留=兜底,不删)。
  //   关掉一层即 stopImmediatePropagation。层序(高→低)：弹层菜单 > 角色卡选择 > 编辑/设置弹窗 > 浮窗。
  if (!window._beiluEscRegistry) window._beiluEscRegistry = [];
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const visible = (el) => el && !el.classList.contains("hidden");
    // A) 注册表：按 priority 降序，关首个打开的层
    const regClose = () => {
      const reg = window._beiluEscRegistry || [];
      const open = reg.filter((r) => { try { return r && typeof r.isOpen === "function" && r.isOpen(); } catch { return false; } });
      if (!open.length) return false;
      open.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      try { open[0].close(); } catch (err) { console.warn("[esc-arbiter] close 失败", err); }
      return true;
    };
    // B) 内置清单兜底（注册表未命中时）
    const closeOne = () => {
      // 1) 弹层菜单
      const modeSel = document.getElementById("mode-selector-panel");
      const extMenu = document.getElementById("extend-menu-popup");
      if (visible(modeSel)) { modeSel.classList.add("hidden"); return true; }
      if (visible(extMenu)) { extMenu.classList.add("hidden"); return true; }
      // 2) 角色卡选择悬浮窗
      const charOv = document.getElementById("char-selector-overlay");
      if (visible(charOv)) { charOv.classList.add("hidden"); return true; }
      // 3) 编辑/设置弹窗
      const editor = document.getElementById("center-tab-editor");
      if (visible(editor)) { _toggleSettingsModal("editor", false); return true; }
      const settings = document.getElementById("center-tab-settings");
      if (visible(settings)) { _toggleSettingsModal("settings", false); return true; }
      // 4) 浮窗：只关 z 最高的一个
      const fws = [...document.querySelectorAll(".floating-window")].filter(visible);
      if (fws.length) {
        fws.sort((a, b) => (parseInt(b.style.zIndex || "150", 10) || 150) - (parseInt(a.style.zIndex || "150", 10) || 150));
        fws[0].classList.add("hidden");
        return true;
      }
      return false;
    };
    if (regClose() || closeOne()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // 设置面板活动栏按钮切换section
  // FT-E2/E3/E4(凛倾 2026-06-12 模拟新用户 txt): 首次使用引导卡——
  //   检测无可用 API 配置时显示；三步全接现有真链（API设置节/编辑用户Tab/角色卡选择），不造孤儿存储
  _initFirstRunGuide();

  // FT-D9(凛倾批「做」): 通知中心——🔔 下拉 = 后台任务「进行中」区 + 通知历史区。
  //   原 floatingTaskOrb 动态小窗与通知中心职责重复，凛倾 2026-07-07「动态窗口删除,所有通知
  //   统一到通知那里」：任务实时态（collectBackgroundTasks）并入本下拉，badge=活跃任务+未读通知。
  {
    const btn = document.getElementById("notify-center-btn");
    const dd = document.getElementById("notify-center-dropdown");
    const listEl = document.getElementById("notify-center-list");
    const tasksEl = document.getElementById("notify-center-tasks");
    const badge = document.getElementById("notify-center-badge");
    const READ_KEY = KEYS.BEILU_NOTIFY_READ_AT;
    // T7b：删局部 _esc 自实现（与壳权威版等价），调用点直用 module 级 escapeHtml（已 import 于顶部）
    const _TASK_META = {
      running: { cls: "bg-warning animate-pulse", s: '<i data-ic="hourglass"></i> 进行中' },
      idle: { cls: "bg-base-content/30", s: '<i data-ic="hourglass"></i> 等待中' },
      failed: { cls: "bg-error", s: '<i data-ic="exclamation"></i> 待处理' },
      success: { cls: "bg-success", s: '<i data-ic="check"></i> 完成' },
    };
    const _TASK_ORDER = { failed: 0, running: 1, idle: 2, success: 3 };
    const render = async () => {
      const { getNotifyHistory, collectBackgroundTasks, getNotifyPrefs } = await import("../../shared/widgets/crossModeNotification.mjs");
      const list = getNotifyHistory();
      const readAt = Number(storage.get(READ_KEY) || 0);
      const unread = list.filter((n) => n.at > readAt).length;
      // 任务区：实时态无已读概念，未完成任务常驻计入 badge（原小窗徽标语义并入）
      const tasks = collectBackgroundTasks().sort((a, b) => _TASK_ORDER[a.state] - _TASK_ORDER[b.state]);
      const activeN = tasks.filter((t) => t.state !== "success").length;
      const badgeN = unread + activeN;
      // 通知偏好：「图标角标提醒」关闭时铃铛角标同步隐藏（与 work 活动栏角标同闸，下拉内容不受影响）
      const _badgesOn = getNotifyPrefs().badges;
      if (badge) { badge.textContent = badgeN > 9 ? "9+" : String(badgeN); badge.classList.toggle("hidden", badgeN === 0 || !_badgesOn); }
      if (tasksEl) {
        tasksEl.innerHTML = tasks.length
          ? '<div class="text-[10px] font-bold opacity-50 px-1">进行中任务</div>' + tasks.map((t, i) => `
            <div class="text-xs bg-base-100 rounded p-1.5 flex items-center gap-2" data-task-idx="${i}">
              <span class="w-2 h-2 rounded-full shrink-0 ${(_TASK_META[t.state] || _TASK_META.running).cls}"></span>
              <div class="flex-1 min-w-0"><div class="truncate">${escapeHtml(t.title)}</div>
                <div class="opacity-60 text-[10px]">${escapeHtml(t.src)} · ${(_TASK_META[t.state] || _TASK_META.running).s}</div></div>
              <button class="btn btn-xs btn-ghost shrink-0" data-task-goto="${i}">前往</button>
            </div>`).join("") + '<div class="border-t border-base-300 my-1"></div>'
          : "";
        tasksEl.querySelectorAll("[data-task-goto]").forEach((b) => {
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            tasks[Number(b.dataset.taskGoto)]?.onGoto?.();
            dd?.classList.add("hidden");
          });
        });
      }
      if (!listEl) return;
      const icons = { approval: '<i data-ic="bell"></i>', error: '<i data-ic="cross"></i>', info: '<i data-ic="info"></i>' };
      const modes = { work: '<i data-ic="clipboard"></i>工作', code: '<i data-ic="code"></i>代码', chat: '<i data-ic="message"></i>聊天', smart: '<i data-ic="star"></i>全智能', file: '<i data-ic="code"></i>代码' };
      listEl.innerHTML = list.length
        ? list.map((n) => `<div class="text-xs bg-base-100 rounded p-1.5 cursor-pointer hover:bg-base-300/60" data-notify-tab="${escapeHtml(n.targetTab || "")}">
            <div class="flex justify-between opacity-60 text-[10px]"><span>${icons[n.type] || '<i data-ic="info"></i>'} ${modes[n.fromMode] || escapeHtml(n.fromMode || "")}</span><span>${new Date(n.at).toLocaleTimeString()}</span></div>
            <div>${escapeHtml(n.message)}</div></div>`).join("")
        : '<p class="text-xs opacity-40 text-center py-3">暂无通知</p>';
      listEl.querySelectorAll("[data-notify-tab]").forEach((row) => {
        row.addEventListener("click", () => {
          const tab = row.dataset.notifyTab;
          if (tab) window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab } }));
          dd?.classList.add("hidden");
        });
      });
    };
    btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = dd?.classList.contains("hidden");
      dd?.classList.toggle("hidden");
      if (opening) { storage.set(READ_KEY, String(Date.now())); render(); }
    });
    document.addEventListener("click", (e) => {
      if (dd && !dd.classList.contains("hidden") && !e.target.closest("#notify-center-dropdown") && !e.target.closest("#notify-center-btn")) dd.classList.add("hidden");
    });
    document.getElementById("notify-center-clear")?.addEventListener("click", async () => {
      const { clearNotifyHistory } = await import("../../shared/widgets/crossModeNotification.mjs");
      clearNotifyHistory();
    });
    window.addEventListener("beilu:notify-history-update", () => render());
    // 任务态变化（taskOverlay/websocket/审批 producer 派发）→ 刷新任务区与 badge（原小窗的驱动信号）
    window.addEventListener("beilu:smart-task-update", () => render());
    // 通知偏好与数值策略（🔔 下拉底部，静态 DOM 绑一次；写入=setNotifyPref 单源）
    (async () => {
      const { getNotifyPrefs, setNotifyPref } = await import("../../shared/widgets/crossModeNotification.mjs");
      const prefs = getNotifyPrefs();
      document.querySelectorAll("#notify-center-prefs [data-notify-pref]").forEach((control) => {
        const key = control.dataset.notifyPref;
        const multiplier = Number(control.dataset.unitMultiplier || 1);
        if (control.type === "checkbox") control.checked = prefs[key] !== false;
        else control.value = String(Number(prefs[key]) / multiplier);
        control.addEventListener("change", () => {
          try {
            const value = control.type === "checkbox"
              ? control.checked
              : Number(control.value) * multiplier;
            setNotifyPref(key, value);
            const current = getNotifyPrefs();
            if (control.type !== "checkbox") control.value = String(Number(current[key]) / multiplier);
          } catch (error) {
            window._beiluToast?.(`通知设置无效: ${error?.message || error}`, "error");
            const current = getNotifyPrefs();
            if (control.type === "checkbox") control.checked = current[key] !== false;
            else control.value = String(Number(current[key]) / multiplier);
          }
        });
      });
    })();
    window.addEventListener("beilu:notify-prefs-update", () => render());
    render();
  }

  // FT-D6(凛倾批「做」): 浮窗点击置顶——多浮窗同开时后点的盖前面；区间 150-999，
  //   不破中央层级表「设置/编辑弹窗(--z-modal 1000)盖浮窗」原序
  let _fwTopZ = 150;
  document.addEventListener("mousedown", (ev) => {
    const fw = ev.target?.closest?.(".floating-window");
    if (!fw || fw.classList.contains("hidden")) return;
    const cur = parseInt(fw.style.zIndex || "150", 10) || 150;
    if (cur >= _fwTopZ) { _fwTopZ = cur; return; }
    _fwTopZ = Math.min(999, _fwTopZ + 1);
    fw.style.zIndex = String(_fwTopZ);
  }, true);

  // FT-D3: AIRP 右栏「完整 API 设置」跳转 → 设置弹窗 AI 服务源节
  document.getElementById("airp-open-api-settings")?.addEventListener("click", () => {
    _toggleSettingsModal("settings", true);
    document.querySelector('.settings-activity-bar [data-settings-section="api"]')?.click();
  });

  document.querySelectorAll("[data-settings-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.dataset.settingsSection;
      // (教程开发 0716 起走普通 section: 先展示说明页, 用户点「开始」才进全屏编辑画布 — 见 _initTutorialDevSection)
      // 切换活动栏高亮
      document.querySelectorAll(".settings-activity-bar .settings-activity-btn").forEach((b) => {
        b.classList.toggle("settings-activity-active", b.dataset.settingsSection === section);
      });
      // 切换section显隐
      document.querySelectorAll("#settings-content .settings-section").forEach((s) => {
        s.classList.toggle("hidden", s.dataset.section !== section);
      });
      // 更新标题
      const titleEl = document.getElementById("settings-sidebar-title");
      if (titleEl) titleEl.textContent = btn.title || section;
      // 懒加载iframe
      const activeSection = document.querySelector(`#settings-content .settings-section[data-section="${section}"]`);
      activeSection?.querySelectorAll("iframe.settings-iframe[data-src]").forEach((iframe) => {
        if (!iframe.src && iframe.dataset.src) {
          iframe.src = iframe.dataset.src;
          iframe.style.display = "";
        }
      });
      // 截图管理已移到游戏陪伴面板(comp-seg-sense)，设置页section已删
      // ST-T2: 懒加载界面设置扩展 (显示选项/内容过滤)；FT-D4: CSP 开关挪 monitor 节后该节也需触发同一初始化
      if (section === "ui" || section === "monitor") _initUiExtraSettings();
      // SEC-H: 懒加载安全中心
      if (section === "security") _initSecurityCenter().catch(err => { console.error("[layout] initSecurityCenter:", err); window._reportError?.(`[layout] initSecurityCenter: ${err.message}`, err.stack); });
      if (section === "backup") _initBackupPanel().catch(err => { console.error("[layout] initBackupPanel:", err); window._reportError?.(`[layout] initBackupPanel: ${err.message}`, err.stack); });
      // T033：导入导出集中管理（聚合层，同步渲染，无后端请求）
      if (section === "import-export") { try { _initImportExportPanel(); } catch (err) { console.error("[layout] initImportExportPanel:", err); window._reportError?.(`[layout] initImportExportPanel: ${err.message}`, err.stack); } }
      if (section === "remote") _initExtIntegration().catch(err => { console.error("[layout] initExtIntegration:", err); });
      if (section === "wiki") _initWikiPanel().catch(err => { console.error("[layout] initWikiPanel:", err); window._reportError?.(`[layout] initWikiPanel: ${err.message}`, err.stack); });
    });
  });
  _initTutorialDevSection();
  // Phase4B: 编辑界面3Tab切换 + 懒加载
  document.querySelectorAll(".editor-tab[data-editor-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const tab = btn.dataset.editorTab;
        document.querySelectorAll(".editor-tab").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".editor-section").forEach((s) => {
          s.classList.toggle("hidden", s.dataset.editorSection !== tab);
        });
        if (tab === "preset-edit") await _loadPresetPanel();
        if (tab === "worldbook-edit") await _loadWorldbookInline();
        if (tab === "persona-edit") await _loadPersonaEditor();
        if (tab === "inj-edit") await _loadInjPanel();
        if (tab === "regex-edit") await _loadRegexInEditor();
      } catch (err) {
        console.error("[layout] editor tab switch:", err);
        window._reportError?.(`[layout] editor tab switch: ${err.message}`, err.stack);
      }
    });
  });

  // 左栏世界书"编辑条目"按钮 → 打开编辑界面世界书tab
  document.getElementById("wb-edit-entries-btn")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "worldbook-edit" }));
  });

  // B7修复: 助手面板（正则/变量/脚本/插件）返回按钮
  document.getElementById("helper-back-btn")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: "chat" } }));
  });

  // EX-T3: 设置弹窗拖拽 + 自由缩放
  _bindSettingsWindowSizing();
}

// 教程开发 section（凛倾 2026-07-16：侧栏点入=说明页，用户点「开始」才进全屏编辑画布，不再直跳）。
//   「帮助教程」顶栏按钮功能可用但引导内容尚未制作完善 → 默认隐藏，由本节开关控制显隐并持久化（启动时恢复，divider 随按钮同显隐）。
function _initTutorialDevSection() {
  document.getElementById("tutorial-dev-start")?.addEventListener("click", () => {
    _toggleSettingsModal("settings", false); // 关设置弹窗让出真实界面(=编辑画布)
    import("../tutorial/tutorialPanel.mjs").then(m => m.openTutorialPanel())
      .catch(err => console.warn("[settings] 教程编辑器:", err.message));
  });
  const applyHelpBtn = (show) => {
    document.querySelector('[data-aux="tutorial-play"]')?.classList.toggle("hidden", !show);
    document.getElementById("aux-tutorial-divider")?.classList.toggle("hidden", !show);
  };
  const toggle = document.getElementById("tutorial-help-btn-toggle");
  const saved = storage.get(KEYS.BEILU_TUTORIAL_HELP_BTN) === "true"; // 无存值=默认隐藏
  if (toggle) {
    toggle.checked = saved;
    toggle.addEventListener("change", () => {
      storage.set(KEYS.BEILU_TUTORIAL_HELP_BTN, String(toggle.checked));
      applyHelpBtn(toggle.checked);
    });
  }
  applyHelpBtn(saved);
}

// EX-T3: 设置弹窗可拖拽 + 右下角 resize
function _bindSettingsWindowSizing() {
  const win = document.getElementById("settings-modal-window");
  if (!win) return;
  const POS_KEY = KEYS.BEILU_SETTINGS_WINDOW_POS;
  // 启动时恢复位置
  try {
    const saved = JSON.parse(storage.get(POS_KEY) || "null");
    if (saved && saved.left != null) {
      win.classList.add("settings-floating");
      win.style.left = saved.left + "px";
      win.style.top = saved.top + "px";
      if (saved.width) win.style.width = saved.width + "px";
      if (saved.height) win.style.height = saved.height + "px";
    }
  } catch {}

  // 拖拽
  const dragBar = document.getElementById("settings-drag-bar");
  if (dragBar) {
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    dragBar.addEventListener("mousedown", (e) => {
      dragging = true;
      win.classList.add("settings-dragging");
      const r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      win.classList.add("settings-floating");
      win.style.left = sl + "px"; win.style.top = st + "px";
      win.style.width = r.width + "px"; win.style.height = r.height + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const newLeft = Math.max(-win.offsetWidth + 100, Math.min(window.innerWidth - 100, sl + e.clientX - sx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, st + e.clientY - sy));
      win.style.left = newLeft + "px";
      win.style.top = newTop + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      win.classList.remove("settings-dragging");
      _saveEditorPos(win, POS_KEY);
    });
  }

  // Resize 右下角
  const handle = document.getElementById("settings-resize-handle");
  if (handle) {
    let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      const r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      if (!win.classList.contains("settings-floating")) {
        win.classList.add("settings-floating");
        win.style.left = r.left + "px"; win.style.top = r.top + "px";
      }
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      win.style.width = Math.max(500, sw + (e.clientX - sx)) + "px";
      win.style.height = Math.max(400, sh + (e.clientY - sy)) + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      _saveEditorPos(win, POS_KEY);
    });
  }
}

// T006死码批: ST-T1 截图管理 section（_initScreenshotSettings/_refreshScreenshotStatus，原:446-513）已删——
// _initScreenshotSettings 全库零调用点（连懒加载入口都没有）+ settings-screenshot-slot 与 12 个 screenshot-* DOM
// 在 index.html 零存在=从未执行的孤儿段。桌面截图设置正路=beilu-eye（凛倾终判"以桌面的eye为主"）。
// 后端 server:eye getEyeConfig/setEyeConfig/getStatus verb 不受影响（eye.mjs 等仍消费）。

// 内容过滤读写/后端同步已收口 shared/state/contentFilter.mjs（0722：bot 面板加同域窗口，
// 私有实现会成同键双写路；本文件只作消费方 bindContentFilterControls）

// ST-T2: 界面设置扩展 - 聊天背景 / 显示选项 / 内容过滤 (纯前端 localStorage)
let _uiExtraInited = false;
function _initUiExtraSettings() {
  if (_uiExtraInited) return;
  const root = document.querySelector('[data-section="ui"]');
  if (!root || !root.querySelector("#ui-show-charname")) return;
  _uiExtraInited = true;

  const LS = {
    showCharname: KEYS.BEILU_SHOW_CHARNAME,
    showSysinfo: KEYS.BEILU_SHOW_SYSINFO,
    showEntryCtrl: KEYS.BEILU_SHOW_ENTRY_CTRL,
  };

  // FT-B3: 聊天背景假链（ui-bg-* → --beilu-chat-bg* CSS变量,全库无消费规则）已删；
  //        设置弹窗「聊天背景」区现直挂真机制控件（backgroundSettings.mjs #bg1）
  const bind = (id, key, evt, getter, setter) => {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = storage.get(key);
    if (saved !== null && setter) setter(el, saved);
    el.addEventListener(evt, () => {
      const v = getter(el);
      storage.set(key, v);
      _applyDisplayToggles();
    });
  };
  const setCheckbox = (el, v) => { el.checked = v === "true" || v === "1"; };

  bind("ui-show-charname", LS.showCharname, "change", (el) => String(el.checked), setCheckbox);
  bind("ui-show-sysinfo", LS.showSysinfo, "change", (el) => String(el.checked), setCheckbox);
  bind("ui-show-entry-ctrl", LS.showEntryCtrl, "change", (el) => String(el.checked), setCheckbox);

  // T4补链：多窗口跟流开关（beilu-peer-follow）。纯前端 localStorage，无后端。
  //   消费点=transport/websocket.mjs peer_active_chat case（0714 起 !==\"false\" 即跟随=默认开）。
  //   语义=另一客户端(YonBan)切对话/开始生成 → 本窗口跟随切到该 chat；显式关闭后多窗口各自独立。
  //   不复用上方 bind()：bind 的 change 回调会跑 _applyDisplayToggles（display 类计算），
  //   而 peer-follow 是行为开关无 body class，故独立绑定（同 cleanup/sandbox 范式）。
  const peerFollowEl = document.getElementById("ui-peer-follow");
  if (peerFollowEl) {
    // 0714：默认跟随（与消费端/producer 语义对齐），显式存 "false" 才算关。
    peerFollowEl.checked = storage.get(KEYS.BEILU_PEER_FOLLOW) !== "false";
    peerFollowEl.addEventListener("change", () => {
      storage.set(KEYS.BEILU_PEER_FOLLOW, String(peerFollowEl.checked));
    });
  }
  // FT-A3: 切换清理=单权威 key beilu-cleanup-mode（与 cleanup-mode-select/ide-cleanup-mode 同源）
  const cleanupSel = document.getElementById("ui-cleanup-mode");
  if (cleanupSel) {
    cleanupSel.value = storage.get(KEYS.BEILU_CLEANUP_MODE) || DEFAULTS.cleanup.mode; // T6：前端运行参数单源，删字面量 "auto" 副本
    cleanupSel.addEventListener("change", () => {
      // T5：唯一写点直连 featureControls.setCleanupMode（写键+同步全部三入口控件）。
      //   删原 else storage.set 直写兜底——它绕过入口同步逻辑=病2散写点，且 featureControls
      //   已由核心链静态加载，setCleanupMode 恒可用，无需桥兜底。
      setCleanupMode(cleanupSel.value);
    });
  }
  // 内容过滤（黑名单+范围 radio）：收口 contentFilter.mjs 单 owner——回显/写 localStorage/后端同步/
  // 与 bot 面板窗口双向镜像全在模块内；onChange 保留原 bind() 的 display 类刷新行为
  bindContentFilterControls({
    msgId: "ui-msg-blacklist",
    userId: "ui-user-blacklist",
    radioName: "blacklist-filter-mode",
    onChange: _applyDisplayToggles,
  });
  // F-T4: iframe sandbox 等级 - localStorage key 固定为 "beilu-iframe-sandbox" (iframeRenderer.mjs 读的)
  // 缺省单源 DEFAULTS.iframe.sandboxLevel（0719 收口：原本控件与渲染侧各写一份字面量=双源；
  //   原 SEC-T4b 注释称默认 strict 已腐烂——0719 角色卡渲染修复拍板 standard，strict 的
  //   opaque origin 曾致高度/音频链全断）。
  const sandboxEl = document.getElementById("ui-iframe-sandbox");
  if (sandboxEl) {
    sandboxEl.value = storage.get(KEYS.BEILU_IFRAME_SANDBOX) || DEFAULTS.iframe.sandboxLevel;
    sandboxEl.addEventListener("change", () => {
      storage.set(KEYS.BEILU_IFRAME_SANDBOX, sandboxEl.value);
    });
  }

  // FT7: CSP 开关 — 后端持久化(config.csp_enabled), 非 localStorage
  const cspEl = document.getElementById("ui-csp-enabled");
  if (cspEl) {
    const hintEl = document.getElementById("ui-csp-hint");
    // 原 raw GET /api/security/csp → 门面 getCsp（返回已解析体，不再 .then(r.json())）；失败 catch 静默
    sendAction({ verb: "getCsp", target: "server:security", source: "web" })
      .then((d) => {
        if (!d || d.success === false) return;
        cspEl.checked = d.enabled !== false;
        if (d.envForcedOff) {
          cspEl.checked = false;
          cspEl.disabled = true;
          if (hintEl) hintEl.insertAdjacentHTML("afterbegin",
            '<span class="text-warning">· 已被环境变量 BEILU_CSP=off 强制关闭，此开关只读。</span><br/>');
        }
      })
      .catch(() => {});
    cspEl.addEventListener("change", () => {
      const want = cspEl.checked;
      cspEl.disabled = true;
      // 原 raw POST /api/security/csp {enabled} → 门面 setCsp（返回已解析体，不再 .then(r.json())）
      sendAction({ verb: "setCsp", target: "server:security", source: "web", payload: { enabled: want } })
        .then((d) => { cspEl.checked = (d && d.success) ? d.enabled !== false : !want; })
        .catch(() => { cspEl.checked = !want; })
        .finally(() => { cspEl.disabled = false; });
    });
  }

  const requestLogWindowEl = document.getElementById("ui-request-log-repeat-window");
  const requestLogSourceEl = document.getElementById("ui-request-log-include-source");
  const requestLogPatternsEl = document.getElementById("ui-request-log-silent-patterns");
  const requestLogSaveEl = document.getElementById("ui-request-log-save");
  const requestLogStatusEl = document.getElementById("ui-request-log-status");
  if (requestLogWindowEl && requestLogSourceEl && requestLogPatternsEl && requestLogSaveEl) {
    const dirty = new Set();
    const setRequestLogDisabled = (disabled) => {
      requestLogWindowEl.disabled = disabled;
      requestLogSourceEl.disabled = disabled;
      requestLogPatternsEl.disabled = disabled;
      requestLogSaveEl.disabled = disabled;
    };
    const setRequestLogStatus = (text, isError = false) => {
      if (!requestLogStatusEl) return;
      requestLogStatusEl.textContent = text;
      requestLogStatusEl.classList.toggle("text-error", isError);
      requestLogStatusEl.classList.toggle("text-base-content/50", !isError);
    };
    const applyRequestLogConfig = (data) => {
      if (!Number.isFinite(Number(data.repeatWindowMs))) {
        throw new Error("后端未返回有效的重复聚合窗口");
      }
      if (typeof data.includeSource !== "boolean") {
        throw new Error("后端未返回有效的请求来源开关");
      }
      requestLogWindowEl.value = String(data.repeatWindowMs);
      requestLogSourceEl.checked = data.includeSource;
      requestLogPatternsEl.value = Array.isArray(data.silentPatterns)
        ? data.silentPatterns.join("\n")
        : "";
    };
    requestLogWindowEl.addEventListener("input", () => dirty.add("repeatWindowMs"));
    requestLogSourceEl.addEventListener("change", () => dirty.add("includeSource"));
    requestLogPatternsEl.addEventListener("input", () => dirty.add("silentPatterns"));
    setRequestLogDisabled(true);
    sendAction({ verb: "getRequestLogConfig", target: "server:diagnostics", source: "web" })
      .then((data) => {
        if (!data || data.success === false) throw new Error(data?.error || "读取请求日志设置失败");
        applyRequestLogConfig(data);
        dirty.clear();
        setRequestLogDisabled(false);
        setRequestLogStatus("配置来自后端");
      })
      .catch((error) => {
        setRequestLogDisabled(true);
        setRequestLogStatus(error?.message || String(error), true);
      });
    requestLogSaveEl.addEventListener("click", async () => {
      if (dirty.size === 0) {
        setRequestLogStatus("没有待保存的修改");
        return;
      }
      const payload = {};
      if (dirty.has("repeatWindowMs")) {
        const value = Number(requestLogWindowEl.value);
        if (!Number.isFinite(value) || value < 0 || value > 60000) {
          setRequestLogStatus("聚合窗口必须是 0 到 60000 的数字", true);
          return;
        }
        payload.repeatWindowMs = value;
      }
      if (dirty.has("includeSource")) payload.includeSource = requestLogSourceEl.checked;
      if (dirty.has("silentPatterns")) {
        payload.silentPatterns = requestLogPatternsEl.value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }
      setRequestLogDisabled(true);
      setRequestLogStatus("正在保存…");
      try {
        const data = await sendAction({
          verb: "setRequestLogConfig",
          target: "server:diagnostics",
          source: "web",
          payload,
        });
        if (!data || data.success === false) throw new Error(data?.error || "保存请求日志设置失败");
        applyRequestLogConfig(data);
        dirty.clear();
        setRequestLogStatus("已保存并立即生效");
      } catch (error) {
        setRequestLogStatus(error?.message || String(error), true);
      } finally {
        setRequestLogDisabled(false);
      }
    });
  }

  _applyDisplayToggles();
}

function _applyDisplayToggles() {
  const body = document.body;
  // hide-charname 默认显示(checked=true),只有用户显式存 false 才隐藏
  body.classList.toggle("beilu-hide-charname", storage.get(KEYS.BEILU_SHOW_CHARNAME) === "false");
  // hide-sysinfo 默认显示(checked=true),只有用户显式存 false 才隐藏(同 charname 负逻辑)
  body.classList.toggle("beilu-hide-sysinfo", storage.get(KEYS.BEILU_SHOW_SYSINFO) === "false");
  body.classList.toggle("beilu-show-entry-ctrl", storage.get(KEYS.BEILU_SHOW_ENTRY_CTRL) === "true");
}

// FT-E2/E3/E4: 首次使用引导卡（凛倾模拟新用户黄金路径：API→身份→角色卡→开聊）
// ============================================================

const _GUIDE_KEY = KEYS.BEILU_FIRST_RUN_GUIDE_DONE;

function _initFirstRunGuide() {
  // 凛倾 0716：新用户（注册时 login 页写 beiluNewUser 标志）首次进入自动打开「设置→语言」，只出现一次；
  // 老用户登录不写标志故不触发。语言 slot 本体见 settingsSlots.mjs initLanguageSlot（覆盖式 i18n 消费方）。
  if (localStorage.getItem("beiluNewUser") === "1") {
    localStorage.removeItem("beiluNewUser");
    setTimeout(() => {
      _toggleSettingsModal("settings", true);
      document.querySelector('.settings-activity-bar [data-settings-section="language"]')?.click();
    }, 600);
  }
  if (storage.get(_GUIDE_KEY) === "1") return;
  const chatContainer = document.getElementById("chat-container");
  if (!chatContainer || document.getElementById("first-run-guide-card")) return;
  // 检测是否已有可用 API（api-url 由 apiConfig.mjs 启动回填；延迟检测等它先跑）
  setTimeout(() => {
    if (storage.get(_GUIDE_KEY) === "1") return;
    const hasApi = !!(document.getElementById("api-url")?.value || "").trim();
    if (hasApi) { storage.set(_GUIDE_KEY, "1"); return; } // 已配过=老用户，不打扰
    const card = document.createElement("div");
    card.id = "first-run-guide-card";
    card.className = "mx-auto mt-3 mb-1 max-w-xl w-full rounded-xl border bg-base-200/70 p-4 space-y-2 text-sm shrink-0";
    card.style.borderColor = "var(--beilu-amber-30)";
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="font-bold">👋 欢迎使用 beilu — 三步开始</span>
        <button id="frg-close" class="btn btn-xs btn-ghost" title="不再显示">✕</button>
      </div>
      <p class="text-xs opacity-60">beilu 在你的电脑本地运行。先连一个 AI 服务就能开聊：</p>
      <div class="space-y-1.5">
        <button id="frg-api" class="btn btn-sm btn-warning btn-outline w-full justify-start">① 配置 AI 服务（API 地址 + Key）</button>
        <button id="frg-persona" class="btn btn-sm btn-outline w-full justify-start">② 介绍一下你自己（可选,AI 会更懂你）</button>
        <button id="frg-char" class="btn btn-sm btn-outline w-full justify-start">③ 选择/创建你的 AI 助手角色卡</button>
      </div>
      <p class="text-[10px] opacity-40">完成 ① 后直接在下方输入框打字即可开聊；左右侧栏都可以先不管。</p>`;
    // T062 更新（凛倾2026-07-09）：子模式栏已从「#chat-container 最顶」移到输入框正上方（subModePanel._injectTopBar），
    //   顶部锚定冲突不复存在 → 引导卡恢复 firstChild 插入（chat 内容顶部=引导卡语义位）。
    //   原「锚定子模式栏之后」写法在栏移位后会把引导卡拖到输入框上方，故删。
    chatContainer.insertBefore(card, chatContainer.firstChild);
    const done = () => { storage.set(_GUIDE_KEY, "1"); card.remove(); };
    card.querySelector("#frg-close")?.addEventListener("click", done);
    card.querySelector("#frg-api")?.addEventListener("click", () => {
      _toggleSettingsModal("settings", true);
      document.querySelector('.settings-activity-bar [data-settings-section="api"]')?.click();
    });
    card.querySelector("#frg-persona")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "persona-edit" }));
    });
    card.querySelector("#frg-char")?.addEventListener("click", () => {
      document.getElementById("header-char-name")?.click();
    });
  }, 1500);
}

// ============================================================
// Wiki 使用手册面板
// ============================================================
let _wikiInited = false;
async function _initWikiPanel() {
  if (_wikiInited) return;
  _wikiInited = true;
  const { initWiki } = await import("./wikiViewer.mjs");
  await initWiki();
}

// 外部应用集成面板（API Key 管理）
// ============================================================
let _extInited = false;
async function _initExtIntegration() {
  if (_extInited) { _refreshExtKeys(); return; }
  _extInited = true;

  // 端口和地址
  try {
    // 原 raw GET /api/ping → 门面 ping；!ok 由门面抛错走 catch
    const d = await sendAction({ verb: "get", target: "server:ping", source: "web" });
    const portEl = document.getElementById("ext-port");
    const addrEl = document.getElementById("ext-address");
    if (portEl) portEl.textContent = location.port || "80";
    if (addrEl) {
      const addr = d.hosturl_in_local_ip || location.origin;
      addrEl.textContent = addr;
      addrEl.addEventListener("click", () => { navigator.clipboard.writeText(addr); import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("success", "已复制")); });
    }
  } catch {}

  // 新建 Key
  document.getElementById("ext-add-key")?.addEventListener("click", async () => {
    const dialog = document.getElementById("ext-new-key-dialog");
    const scopeList = document.getElementById("ext-scope-list");
    if (!dialog || !scopeList) return;
    // 加载可用 scope
    try {
      // 原 raw GET /api/apikey/available-scopes → 门面 getAvailableScopes；!ok 由门面抛错走 catch
      const d = await sendAction({ verb: "getAvailableScopes", target: "server:apikey", source: "web" });
      const scopes = d.scopes || [];
      const groups = {};
      for (const s of scopes) { (groups[s.group] ||= []).push(s); }
      scopeList.innerHTML = Object.entries(groups).map(([g, items]) =>
        `<div class="col-span-2 text-xs font-semibold text-base-content/50 mt-1">${escapeHtml(g)}</div>` +
        items.map(s => `<label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" value="${escapeHtml(s.value)}" ${s.value === "*" ? "checked" : ""}/><span>${escapeHtml(s.label)}</span></label>`).join("")
      ).join("");
    } catch {}
    document.getElementById("ext-new-desc").value = "";
    dialog.showModal();
  });

  document.getElementById("ext-new-cancel")?.addEventListener("click", () => {
    document.getElementById("ext-new-key-dialog")?.close();
  });

  document.getElementById("ext-new-create")?.addEventListener("click", async () => {
    const desc = document.getElementById("ext-new-desc")?.value?.trim();
    if (!desc) { import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("error", "请输入应用名称")); return; }
    const checks = document.querySelectorAll("#ext-scope-list input:checked");
    const scopes = [...checks].map(c => c.value);
    if (scopes.length === 0) { import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("error", "请选择至少一个权限")); return; }
    try {
      // 原 raw POST /api/apikey/create {description,scopes} → 门面 create；!ok 由门面抛错走 catch
      const d = await sendAction({ verb: "create", target: "server:apikey", source: "web", payload: { description: desc, scopes } });
      if (!d.success) throw new Error(d.error || "创建失败");
      document.getElementById("ext-new-key-dialog")?.close();
      // 显示新 Key
      const showDialog = document.getElementById("ext-show-key-dialog");
      const keyVal = document.getElementById("ext-new-key-value");
      if (showDialog && keyVal) {
        keyVal.textContent = d.apiKey;
        showDialog.showModal();
      }
      _refreshExtKeys();
    } catch (e) {
      import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("error", "创建失败: " + e.message));
    }
  });

  document.getElementById("ext-copy-key")?.addEventListener("click", () => {
    const v = document.getElementById("ext-new-key-value")?.textContent;
    if (v) navigator.clipboard.writeText(v);
    import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("success", "已复制"));
  });
  document.getElementById("ext-close-key")?.addEventListener("click", () => {
    document.getElementById("ext-show-key-dialog")?.close();
  });

  _refreshExtKeys();
}

async function _refreshExtKeys() {
  const list = document.getElementById("ext-key-list");
  if (!list) return;
  try {
    // 原 raw GET /api/apikey/list → 门面 list；!ok 由门面抛错走 catch（"加载失败"）
    const d = await sendAction({ verb: "list", target: "server:apikey", source: "web" });
    const keys = d.apiKeys || [];
    if (keys.length === 0) {
      list.innerHTML = '<p class="text-xs text-base-content/40">暂无外部应用</p>';
      return;
    }
    list.innerHTML = `<div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>No</th><th>名称</th><th>权限</th><th>创建时间</th><th></th></tr></thead><tbody>` +
      keys.map((k, i) => `<tr>
        <td class="text-xs">${i + 1}</td>
        <td class="text-xs font-medium">${escapeHtml(k.description || "—")}</td>
        <td class="text-xs"><span class="badge badge-xs badge-ghost">${escapeHtml((k.scopes || ["*"]).join(", "))}</span></td>
        <td class="text-xs text-base-content/50">${k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "—"}</td>
        <td><button class="btn btn-xs btn-ghost btn-error" data-revoke-jti="${escapeHtml(k.jti)}">撤销</button></td>
      </tr>`).join("") +
      `</tbody></table></div>`;
    list.querySelectorAll("[data-revoke-jti]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const jti = btn.dataset.revokeJti;
        const ok = await beiluConfirm("确定撤销此 Key？撤销后使用该 Key 的外部应用将无法访问。");
        if (!ok) return;
        const pw = await beiluPrompt("请输入密码确认");
        if (!pw) return;
        try {
          // 原 raw POST /api/apikey/revoke {jti,password} → 门面 revoke；!ok 由门面抛错走 catch
          const d2 = await sendAction({ verb: "revoke", target: "server:apikey", source: "web", payload: { jti, password: pw } });
          if (!d2.success) throw new Error(d2.error || d2.message || "撤销失败");
          import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("success", "已撤销"));
          _refreshExtKeys();
        } catch (e) {
          import("../../../../../../../scripts/toast.mjs").then(m => m.showToast("error", e.message));
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="text-xs text-error">加载失败: ${escapeHtml(e.message)}</p>`;
  }
}

export { _initOutputFilterPanel, _toggleSettingsModal, _initSettingsModals };
