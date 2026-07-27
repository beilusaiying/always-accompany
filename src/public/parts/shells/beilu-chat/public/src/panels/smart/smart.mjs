/**
 * smart.mjs — SMART 模式全智能簇 cluster
 *
 * 功能链：切换到 SMART Tab → _populateSmartLeftPanel() 填充左栏（人设/世界书/最近对话）
 *   → _setupSmartRightPanel() 挂载任务看板/审批列表到右栏
 *   → _setupSmartPolling() 建立 WS 感知轮询（WS 健康时 60s 兜底，断线时实时拉取）拉取待审批任务
 *   → 监听 beilu:smart-task-update → _refreshSmartTaskCounters() 刷新任务角标 + 有活跃任务时自动展开右栏
 *   → 监听 beilu:monitor-error → _refreshWorkActivityBadges() 更新工作模式「监控」角标（红色错误数）
 *   → updateSmartGreeting() / _bindSmartGreetingObserver() 管理首页问候语（按时段/分类）
 * why：SMART 是跨聊天/编程/工作模式的统一概览页，任务角标需要聚合多来源（activeTasks/pendingApprovals/crossModeTasks），
 *   轮询策略与 WebSocket 状态感知耦合避免冗余 HTTP 请求
 * 关联链：被 layout.mjs import（8 个入口函数在 initLayout/switchTab 时调用）；
 *   import core.mjs（layoutState/applyRightPanel）、chat.mjs（switchCharacterScope）、sharedState.mjs（getCharId/switchPreset）
 * 影响范围：改动影响 SMART 页任务角标计数、右栏自动展开逻辑、工作模式监控角标、问候语显示
 * 使用效果：用户在 SMART 页看到当前活跃任务数角标，有新任务时右栏自动展开显示详情；问候语按早/午/晚时段变化
 */
import { escapeHtml, mountInlineEdit, latestOnly, whenVisible } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 内联改名输入框 UI 编排收口单源；latestOnly=0716 竞态收口原语；whenVisible=0718 可见性门控
import { showToast } from "../../../../../../scripts/toast.mjs"; // 0716 轮子收口：原走 _beiluPublicShowToast 二级窗口桥（该桥已删，toast.mjs 单源直连）
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作；memory 通配注 _action；worldbook/preset 字段写；server list/details 专用路由）
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { switchCharacterScope, chatBelongsToChar, charList } from "../../shared/chat-core/chat.mjs";

/**
 * smart 面板「当前角色」单源（凛倾0712 左右列表数量不一致案：smart 原三级链拿空 → 列表不过滤
 * 显示全部角色对话，而 chatmgmt 弹窗用 charList[0] 过滤出当前角色的——口径分裂）。
 * 口径对齐 chatmgmt.handleManageChats：charList[0]（当前对话运行时角色，最真）优先，
 * 再退 sharedState / localStorage / DOM dataset。
 */
function _getSmartCurChar() {
  return (charList && charList.length > 0 ? charList[0] : "")
    || window._beiluGetCharName?.()
    || storage.get(KEYS.BEILU_LAST_CHAR)
    || document.getElementById("char-name-display")?.dataset?.charId || "";
}
import { MODE_TO_TAB } from "../../shared/state/modeTabMap.mjs";
import { layoutState, applyRightPanel, saveState } from "../../shared/layout/core.mjs";
import { getNotifyPrefs } from "../../shared/widgets/crossModeNotification.mjs"; // 通知偏好：角标呈现闸
import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { getCharId, switchPreset } from "../../shared/state/sharedState.mjs";
// openWbEditor浮窗已删除，世界书统一到编辑界面Tab2
const _escHtml = escapeHtml; // 共享 alias（layout.mjs:24 同名,不随迁,此处自备）

/** F1-2 fix: 统计 _beiluCrossModeTasks 中未完成任务数，与 _refreshSmartTaskCounters 里的 crossTasks 计数口径一致 */
function _countCrossModeTasks() {
  const m = window._beiluCrossModeTasks;
  if (!m) return 0;
  let n = 0;
  for (const cid of Object.keys(m)) {
    for (const tk of (m[cid]?.tasks || [])) {
      if (tk && tk.status !== "completed") n++;
    }
  }
  return n;
}

let _prevSmartActiveCount = 0;
window.addEventListener("beilu:smart-task-update", () => {
  if (document.body.dataset.activeTab === "smart") {
    _refreshSmartTaskCounters();
    // F1-2 fix: 并入跨模式任务计数(别窗口 work/code)，与 _refreshSmartTaskCounters 口径一致
    const _crossActiveCount = _countCrossModeTasks();
    const _curActive = ((window._beiluActiveTasks || []).length) + _crossActiveCount + ((window._beiluPendingApprovals || []).length);
    if (_curActive > 0 && _prevSmartActiveCount === 0 && layoutState.rightCollapsed) {
      layoutState.rightCollapsed = false;
      // N47 自动展开也落 per-tab 记忆（panelMemory）并持久化——「任务完成后右栏可保持，用户选择」
      layoutState.panelMemory.smart = { left: layoutState.leftCollapsed, right: false };
      applyRightPanel();
      saveState();
    }
    _prevSmartActiveCount = _curActive;
  }
  _refreshWorkActivityBadges();
});

// [WK-T8] 工作模式活动栏角标
function _refreshWorkActivityBadges() {
  // 通知偏好：用户关闭「图标角标提醒」时全部角标隐藏（数据链不变，仅呈现闸）
  const badgesOn = getNotifyPrefs().badges;
  const pending = badgesOn ? (window._beiluPendingApprovals || []).length : 0;
  // F1-2 fix: 并入跨模式任务(别窗口 work/code)，与 _refreshSmartTaskCounters/通知中心 collectBackgroundTasks 口径一致
  const active = (window._beiluActiveTasks || []).length + _countCrossModeTasks();
  const setBadge = (panel, count, cls) => {
    const btn = document.querySelector(`#work-activity-bar [data-work-panel="${panel}"]`);
    if (!btn) return;
    const badge = btn.querySelector(".work-badge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.remove("hidden");
      badge.classList.remove("badge-running", "badge-warning");
      if (cls) badge.classList.add(cls);
    } else {
      badge.classList.add("hidden");
    }
  };
  setBadge("overview", pending, "badge-warning"); // 任务台: 待审批数 (warning)
  // FT-D10: 监控角标=未读错误数（backendMonitor 广播 unread；用户看过监控错误区即清零）
  setBadge("operations", badgesOn ? _monitorErrorCount : 0, "badge-warning");
}

// 通知偏好开关变化（🔔 通知中心）→ 角标即时显隐
window.addEventListener("beilu:notify-prefs-update", () => _refreshWorkActivityBadges());

// FT-D10(凛倾批「做」): 监控角标 publisher 接线——backendMonitor pushError 广播
let _monitorErrorCount = 0;
window.addEventListener("beilu:monitor-error", (e) => {
  _monitorErrorCount = Number(e.detail?.count) || 0;
  _refreshWorkActivityBadges();
});

let _smartPollTimer = null;

// P0-1 兜底 + 点3 WS-aware 节流:
// WS 在线时, pending_approvals 走推送(websocket:565→chat.mjs:558)实时更新, 无需每 5s HTTP 拉取;
// 仅 WS 断开/重连时保持响应式拉取; WS 健康时每 60s 做一次安全再同步(防推送漏帧兜底)。
// 注(2026-06-17 改正陈旧注释): cross_mode_task_update producer 已建(replyHandler:702/1381/2127 + setDataActions:204),
//   且 F1-2 已让 websocket consumer 落地 window._beiluCrossModeTasks → 跨窗口任务实时可见; 60s 仅兜底漏帧, 非"无 producer"。
let _lastApprovalSync = 0;
// 暴露给 workPanel 等：审批操作后主动重拉（更新 _beiluPendingApprovals + 角标）
window._beiluTriggerApprovalPoll = (force) => _triggerIdeApprovalPoll(force);
async function _triggerIdeApprovalPoll(force) {
  const ws = window.__beiluWs;
  const wsHealthy = ws && ws.readyState === WebSocket.OPEN;
  const now = Date.now();
  // WS 健康且非强制: 60s 内已同步过则跳过 HTTP, 完全靠推送
  if (wsHealthy && !force && now - _lastApprovalSync < 60000) return;
  try {
    // 原 POST setdata {_action:getIdeApprovals,...} → memory 通配路由 verb=真动作组装 _action；!ok 由门面抛错走 catch（原 !ok return 等价：不更新 sync/列表）
    const data = await sendAction({ verb: "getIdeApprovals", target: "plugins:beilu-memory", source: "web", payload: { chatid: currentChatId } });
    _lastApprovalSync = Date.now();
    window._beiluPendingApprovals = data?.pendingApprovals || [];
    window.dispatchEvent(new CustomEvent("beilu:smart-task-update"));
  } catch { /* 静默 */ }
}

// 轮询计时器生命周期封装（R3-c：shell 的 switchLeftContent 调此而非直碰 _smartPollTimer state）
function _setupSmartPolling(active) {
  if (active) {
    _triggerIdeApprovalPoll(true);
    if (!_smartPollTimer) _smartPollTimer = setInterval(_triggerIdeApprovalPoll, 5000);
  } else {
    if (_smartPollTimer) { clearInterval(_smartPollTimer); _smartPollTimer = null; }
  }
}

function _refreshSmartTaskCounters() {
  const active = document.getElementById("smart-tasks-active");
  const pending = document.getElementById("smart-tasks-pending");
  const done = document.getElementById("smart-tasks-done");
  const list = document.getElementById("smart-task-list");
  const empty = document.getElementById("smart-task-empty");
  const activeTasks = window._beiluActiveTasks || [];
  const pendingTasks = window._beiluPendingApprovals || [];
  const doneTasks = window._beiluDoneTasks || [];
  // F1-2(2026-06-17): 别窗口 work/code 后台任务（cross_mode 落地 window._beiluCrossModeTasks）并入计数+列表，
  //   补「当前窗口看不到别窗口后台任务」的核心断点(G1)。task={id,content,status}(taskStore:12)。
  const _crossMap = window._beiluCrossModeTasks || {};
  const crossTasks = [];
  for (const _cid of Object.keys(_crossMap)) {
    for (const _tk of (_crossMap[_cid]?.tasks || [])) {
      if (_tk && _tk.status !== "completed") {
        crossTasks.push({ title: _tk.content, id: _tk.id, _s: "active", _cross: true, _srcChat: _cid });
      }
    }
  }
  if (active) active.textContent = String(activeTasks.length + crossTasks.length);
  if (pending) pending.textContent = String(pendingTasks.length);
  if (done) done.textContent = String(doneTasks.length);
  if (list) {
    const all = [...activeTasks.map(t => ({ ...t, _s: "active" })),
                 ...crossTasks,
                 ...pendingTasks.map(t => ({ ...t, _s: "pending" }))];
    if (all.length === 0) {
      list.innerHTML = "";
      if (empty) empty.style.display = "";
    } else {
      if (empty) empty.style.display = "none";
      list.innerHTML = all.slice(0, 5).map(t => {
        const icon = t._cross ? "⊞" : (t._s === "pending" ? '<i data-ic="warning"></i>' : "◌");
        const label = _escHtml(t.title || t.name || t.id || "任务");
        const goto = t._cross
          ? `data-goto-chat="${_escHtml(t._srcChat || "")}"`   // F1-2: 别窗口后台任务→切该 chatId 回流
          : `data-goto-mode="${_escHtml(t.mode || "")}"`;
        return `<div class="bg-base-200 rounded px-1 py-0.5 flex justify-between items-center">
          <span class="truncate">${icon} ${label}</span>
          <button class="btn btn-ghost btn-xs" ${goto}>→</button>
        </div>`;
      }).join("");
      list.querySelectorAll("[data-goto-mode]").forEach(el => {
        el.addEventListener("click", () => {
          // t.mode 是后端 mode(work/code)，需映射成 tab 名（无 "code" tab，code→files）。
          // 映射权威源 ./modeTabMap.mjs（T-3）。此处保留 `|| m` 原回退（未知 mode 直接当 tab 名）。
          const m = el.dataset.gotoMode;
          const tab = MODE_TO_TAB[m] || m;
          if (tab) window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: tab }));
        });
      });
      // F1-2: 别窗口后台任务 → 点击切到该 chatId（回流到产出该任务的对话）
      list.querySelectorAll("[data-goto-chat]").forEach(el => {
        el.addEventListener("click", () => {
          const cid = el.dataset.gotoChat;
          // T021 弹出：原双重静默（内 catch ignore + 外 catch 空）——用户点击跳转失败必须可见
          if (cid) import("../../shared/chat-core/chat.mjs").then(m => { try { m.switchCharacterScope?.(cid); } catch (e) { window._beiluToast?.("跳转对话失败: " + (e?.message || e), "error"); } }).catch((e) => window._beiluToast?.("跳转模块加载失败: " + (e?.message || e), "error"));
        });
      });
    }
  }
  // 没有任何任务时隐藏整个折叠区，避免全零统计噪音
  const section = document.getElementById("smart-task-section");
  if (section) {
    const total = activeTasks.length + crossTasks.length + pendingTasks.length + doneTasks.length;
    section.style.display = total > 0 ? "" : "none";
  }
}

// ============================================================
// T1: 从后端 runtime-params 恢复 per-char 的 API源/模型覆盖
// ============================================================

async function _restoreSmartApiOverrides() {
  const smartSrc = document.getElementById("smart-api-source");
  const smartModel = document.getElementById("smart-api-model");
  if (!smartSrc && !smartModel) return;
  const charName = getCharId();
  if (!charName) return;
  try {
    // 原 raw GET runtime-params + resp.ok 手检 → 复用 getRuntimeParams；!ok 由门面抛错走 catch（原 catch 静默不阻塞面板）
    const data = await sendAction({ verb: "getRuntimeParams", target: "plugins:beilu-preset", source: "web" });
    const overrides = data.model_overrides_by_char;
    if (!overrides || typeof overrides !== "object") return;
    // 查找匹配当前角色的覆盖项（键格式: "username/charName"）
    let match = null;
    for (const key of Object.keys(overrides)) {
      if (key.endsWith("/" + charName)) { match = overrides[key]; break; }
    }
    if (!match) return;
    if (match.api_source && smartSrc) {
      // 确认选项中有该值才设置
      const hasOpt = Array.from(smartSrc.options).some(o => o.value === match.api_source);
      if (hasOpt) smartSrc.value = match.api_source;
    }
    if (match.model && smartModel) {
      const hasOpt = Array.from(smartModel.options).some(o => o.value === match.model);
      if (hasOpt) smartModel.value = match.model;
    }
  } catch { /* 静默——恢复失败不阻塞面板 */ }
}

// ============================================================
// Smart 右栏镜像同步 — 独立DOM的控件↔原 .right-panel-content 控件
// ============================================================

const SMART_MIRROR_PAIRS = [
  // [smart_id, original_id, type: checkbox|value|select]
  ["smart-api-source",          "api-select",                "select"],
  ["smart-api-model",           "api-model-select",          "select"],
  ["smart-toggle-regex",        "toggle-regex",              "checkbox"],
  // smart-toggle-thinking-fold 镜像对已删（0714 收口）：思维链设定唯一入口 = 设置→AI服务源「思维链显示」
  ["smart-toggle-stream",       "toggle-stream-render",      "checkbox"],
  ["smart-toggle-code-fold",    "toggle-code-fold",          "checkbox"],
  ["smart-render-depth",        "render-depth",              "value"],
  ["smart-ctx-msg-limit",       "menu-context-msg-limit",    "value"],
  ["smart-msg-load-limit",      "menu-msg-load-limit",       "value"],
];

let _smartMirrorBound = false;

function _setupSmartRightPanel() {
  // 首次调用时绑定镜像关系; 每次调用都把原控件值同步到 smart 控件
  SMART_MIRROR_PAIRS.forEach(([smartId, origId, type]) => {
    const smart = document.getElementById(smartId);
    const orig = document.getElementById(origId);
    if (!smart || !orig) return;
    // 原→smart 同步
    if (type === "checkbox") smart.checked = !!orig.checked;
    else smart.value = orig.value || "";
    // select 类型: 把 options 也搬过来
    if (type === "select" && orig.tagName === "SELECT") {
      const cur = orig.value;
      smart.innerHTML = "";
      for (let i = 0; i < orig.options.length; i++) {
        const opt = document.createElement("option");
        opt.value = orig.options[i].value;
        opt.textContent = orig.options[i].textContent;
        smart.appendChild(opt);
      }
      smart.value = cur;
    }
  });
  if (_smartMirrorBound) return;
  _smartMirrorBound = true;
  SMART_MIRROR_PAIRS.forEach(([smartId, origId, type]) => {
    const smart = document.getElementById(smartId);
    const orig = document.getElementById(origId);
    if (!smart || !orig) return;
    // smart→原 同步 (触发原有持久化)
    smart.addEventListener("change", () => {
      if (type === "checkbox") orig.checked = smart.checked;
      else orig.value = smart.value;
      orig.dispatchEvent(new Event("change", { bubbles: true }));
      orig.dispatchEvent(new Event("input", { bubbles: true }));
      // T1: API源/模型选择持久化到后端 runtime-params（per-char覆盖）
      if (smartId === "smart-api-source" && smart.value) {
        window._beiluSyncRuntimeParams?.({ api_source: smart.value });
        showToast("success", `AI源已切换: ${smart.value}`, 2000);
      } else if (smartId === "smart-api-model" && smart.value) {
        // ★ 走 setModel 收口同步两个 DOM（#api-model + #api-model-select）+ sharedState._model
        // why: 通用镜像只写 #api-model-select，但 #api-model-select 的 change 是死路径（只 syncModelLabel 不调 setModel）
        //   → apiConfig.handleSave 读 #api-model 时拿到旧值 → 保存覆写。走 setModel 收口堵住所有下游读取。
        if (window._beiluSetModel) window._beiluSetModel(smart.value);
        window._beiluSyncRuntimeParams?.({ model: smart.value });
        showToast("success", `模型已切换: ${smart.value}`, 2000);
      }
    });
    // 原→smart 反向同步 (原控件变更时更新 smart)
    orig.addEventListener("change", () => {
      if (type === "checkbox") smart.checked = orig.checked;
      else smart.value = orig.value;
    });
    if (type === "select" && orig.tagName === "SELECT") {
      new MutationObserver(() => {
        const prev = smart.value;
        smart.innerHTML = "";
        for (let i = 0; i < orig.options.length; i++) {
          const o = document.createElement("option");
          o.value = orig.options[i].value;
          o.textContent = orig.options[i].textContent;
          smart.appendChild(o);
        }
        smart.value = prev || orig.value;
      }).observe(orig, { childList: true });
    }
  });

  // [0717 凛倾「每次点击都需要访问」]：点击展开模型下拉=触发原侧静默实时拉当前源列表；
  //   列表未变 fetchModels 跳过重建（不收起展开中的下拉），变了经 MutationObserver 镜像过来
  document.getElementById("smart-api-model")?.addEventListener("mousedown", () => {
    const _fb = document.getElementById("api-fetch-models");
    if (_fb) { _fb.dataset.silent = "1"; _fb.click(); }
  });

  // T1: 切卡时恢复 smart 面板的 per-char API源/模型覆盖
  window.addEventListener("beilu:char-changed", whenVisible("#center-tab-smart", () => _restoreSmartApiOverrides()));

  // 外部预设切换时同步 smart 面板的预设下拉选中值
  const _syncSmartPresetSel = (name) => {
    const sel = document.getElementById("smart-preset-select");
    if (sel && name) sel.value = name;
  };
  window.addEventListener("beilu:presetSwitched", (e) => _syncSmartPresetSel(e.detail?.name));
  // [0715 串扰点2] 原直取 e.detail.preset（触发方值）回显选择器——global 切换会盖掉本窗 per-chat
  //   覆盖的显示。改调本窗生效值单源（同 layout/memswitch 订阅站）。
  window.addEventListener("beilu:preset-changed", async () => _syncSmartPresetSel(await window._beiluResolveCurrentPreset?.()));

  // 刷新模型按钮
  document.getElementById("smart-api-fetch-models")?.addEventListener("click", () => {
    document.getElementById("api-fetch-models")?.click();
  });

  // 截图 "完整管理" 跳转：已移至游戏陪伴面板(comp-seg-sense)，全智能右栏截图区已清理

  // 跨模式设置持久化 (localStorage)
  const xRef = document.getElementById("smart-xmode-refcount");
  const xFmt = document.getElementById("smart-xmode-format");
  if (xRef) {
    xRef.value = storage.get(KEYS.BEILU_XMODE_REFCOUNT) || "5";
    xRef.addEventListener("change", () => storage.set(KEYS.BEILU_XMODE_REFCOUNT, xRef.value));
  }
  if (xFmt) {
    xFmt.value = storage.get(KEYS.BEILU_XMODE_FORMAT) || "xml";
    xFmt.addEventListener("change", () => storage.set(KEYS.BEILU_XMODE_FORMAT, xFmt.value));
  }
  // FT-A1: 真预览（全智能MD §13.4「显示工作AI将看到的XML格式」），与确认师通道共用构造器
  document.getElementById("smart-xmode-preview")?.addEventListener("click", async () => {
    try {
      const { buildChatContextRef } = await import("../../shared/widgets/tempConversation.mjs");
      const ref = await buildChatContextRef();
      let dlg = document.getElementById("xmode-preview-dialog");
      if (!dlg) {
        dlg = document.createElement("dialog");
        dlg.id = "xmode-preview-dialog";
        dlg.className = "modal";
        dlg.innerHTML = `<div class="modal-box max-w-2xl"><h3 class="font-bold text-sm mb-2">跨模式引用预览（工作AI将看到的内容）</h3><pre id="xmode-preview-body" class="text-xs bg-base-200 rounded p-2 whitespace-pre-wrap max-h-96 overflow-y-auto"></pre><div class="modal-action"><form method="dialog"><button class="btn btn-sm">关闭</button></form></div></div>`;
        document.body.appendChild(dlg);
      }
      const body = dlg.querySelector("#xmode-preview-body");
      if (body) body.textContent = ref || "（当前对话无可引用消息，或引用条数为 0）";
      dlg.showModal();
    } catch (e) { window._beiluToast?.("预览失败: " + e.message, "error"); }
  });

  // 截图状态读取：截图区已移至游戏陪伴面板，不再在全智能右栏刷新
  // T1: 恢复当前角色的 per-char API源/模型覆盖值
  _restoreSmartApiOverrides();
}

// _refreshSmartEye 已删除：截图区移至游戏陪伴面板(comp-seg-sense)，全智能右栏截图DOM已清理

// [0716 竞态收口] latestOnly 原语（utils.mjs 单源，凛倾「别打补丁」定案：不再各处手抄 reqId）：
//   快速连续触发（切 tab/切角色连点）时旧轮的慢响应不再覆盖新轮已填充的左栏——段间边界自查过期即退。
const _populateSmartLeftPanel = latestOnly(async (isStale) => {
  // 当前角色单源 _getSmartCurChar（charList[0] 优先，口径对齐 chatmgmt 弹窗）
  const curCharId = _getSmartCurChar();
  // 当前 chatid：守卫单源 getChatId（sharedState.mjs:108，_CHATID_RE 校验），非法/无 hash 返 ""=诚实降级。
  // [2026-07-13 多源合并删除] 原 `|| storage.get(KEYS.BEILU_CHAT_CHATID)` 兜底删：该键是 chat 模式线
  //   [MO-ISO] 写侧缓存（featureControls.mjs:601 MODE_CHATID_KEYS，真键还带 ":charName" 后缀，此处裸键
  //   读=恒空或化石），混进显示读侧=拿"上次对话"冒充当前对话送 getPersona 分区键。
  const curChatId = window._beiluGetChatId?.() || "";

  // ========== 用户折叠区: Persona 编辑 ==========
  await _populateSmartPersona(curChatId);
  if (isStale()) return; // 段边界过期自查（latestOnly 语义）

  // ========== 预设折叠区 ==========
  try {
    // 原 raw GET preset getdata + res.ok 手检 → 复用 getData；!ok 由门面抛错走外层 catch（静默）
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
    if (isStale()) return;
    const presets = data?.preset_list || [];
    const active = (window._beiluResolveActivePreset?.(data) ?? data?.active_preset) || "";
    const sel = document.getElementById("smart-preset-select");
    if (sel) {
      sel.innerHTML = presets.map(p => {
        const name = p.replace(/\.json$/i, "");
        return `<option value="${_escHtml(p)}" ${p === active ? "selected" : ""}>${_escHtml(name)}</option>`;
      }).join("");
      // [注释校准 2026-07-12] 本口现=纯切换（switchPreset），不写 bindings。历史沿革：D1 期曾按
      //   "写 bindings+应用"设计（当时 getPromptHandler 有 mode_preset_bindings 反向盖回=半死口），
      //   反向盖回已随凛倾 07-08 生效模型移除、「先写 bindings 再切」随之撤销——绑定是默认初始值，
      //   只在浮层四格显式配置。smart 为独立模式键（凛倾 0706 四模式）。
      sel.onchange = async () => {
        const name = sel.value;
        // 生效模型（凛倾 2026-07-08「切换怎么切换?为什么要绑定?」）：切换=直接改「正在使用的预设」
        //   （switchPreset 写 active_preset_map[cid:mode]，mode 后端权威解析），生成时无强切盖回=切了即生效。
        //   原「先写 bindings 再切」已撤——绑定是默认初始值，只在浮层四格显式配置。
        try {
          const result = await switchPreset(name);
          if (result) {
            window._beiluToast?.(`已切换预设: "${name}"`, "success");
          } else {
            console.warn("[layout] preset switch: switchPreset returned null");
            window._beiluToast?.("预设切换失败", "error");
          }
        } catch (err) {
          console.error("[layout] preset switch:", err);
          window._reportError?.(`[layout] preset switch: ${err.message}`, err.stack);
          window._beiluToast?.("预设切换失败", "error");
        }
      };
    }
  } catch { /* 静默 */ }

  // ========== 世界书折叠区 (按AIRP样式: select + 当前 + 额外列表 + 编辑条目) ==========
  await _populateSmartWorldbook(curCharId);
  if (isStale()) return;

  // ========== 最近对话折叠区 ==========
  await _populateSmartRecents(curCharId);
  if (isStale()) return;

  // [+新建对话] 按钮（T3 2026-07-07：从 collapse-title 移入内容区首行，与删除并排）
  const newBtn = document.getElementById("smart-new-chat-btn");
  if (newBtn && !newBtn._bound) {
    newBtn._bound = true;
    newBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:newChat"));
    });
  }
  // [删除当前对话] 按钮——复用 conversationManager 正主实现（确认弹窗/回收站/清绑定/切对话全继承）；
  // 动态 import 防静态环（先例 chat.mjs 切卡路径同款）。删除成功后 saveConvMeta 广播
  // beilu:conv-meta-changed → 本文件 :799 监听自动刷新最近对话列表，无需手动重渲。
  const delBtn = document.getElementById("smart-del-chat-btn");
  if (delBtn && !delBtn._bound) {
    delBtn._bound = true;
    delBtn.addEventListener("click", async () => {
      try {
        const m = await import("../../shared/chat-core/conversationManager.mjs");
        const cid = m.getCurrentChatId();
        if (!cid) { window._beiluToast?.("当前没有打开的对话", "info"); return; }
        await m.deleteConversation(cid);
      } catch (err) {
        console.error("[smart] 删除对话失败:", err);
        window._beiluToast?.(`删除对话失败: ${err.message}`, "error");
      }
    });
  }
  // [更多对话→] 按钮
  const moreBtn = document.getElementById("smart-more-chats-btn");
  if (moreBtn && !moreBtn._bound) {
    moreBtn._bound = true;
    moreBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:manageChats"));
    });
  }
});

async function _populateSmartPersona(chatid) {
  const selectEl = document.getElementById("smart-persona-select");
  const descEl = document.getElementById("smart-persona-desc");
  const editBtn = document.getElementById("smart-persona-edit-btn");
  const actions = document.getElementById("smart-persona-actions");
  const saveBtn = document.getElementById("smart-persona-save");
  const cancelBtn = document.getElementById("smart-persona-cancel");
  if (!selectEl || !descEl) return;

  // 拉取 persona 列表
  let personas = [];
  let currentPersona = "";
  try {
    // 原 raw GET /api/getlist/personas + listRes.ok 手检 → 门面 getList（payload.type）；!ok 由门面抛错走 catch（personas 保持 []）
    const listData = await sendAction({ verb: "getList", target: "server:list", source: "web", payload: { type: "personas" } });
    personas = Array.isArray(listData) ? listData : (listData?.list || []);
  } catch (e) {
    // 0714 吞错扫尾：原全静默——列表拉不到时下拉只剩"(无人设)"，用户无从分辨"没有人设"和"拉取失败"
    console.warn("[smart] persona 列表拉取失败:", e.message);
    window._reportError?.(`[smart] persona 列表拉取失败: ${e.message}`);
  }
  if (chatid) {
    try {
      // 原 raw GET persona + curRes.ok 手检 → 门面 getPersona（scope.chatId 进 URL）；!ok 由门面抛错走 catch
      const curData = await sendAction({ verb: "getPersona", target: "shells:chat", source: "web", scope: { chatId: chatid } });
      currentPersona = typeof curData === "string" ? curData : (curData?.personaname || "");
    } catch { /* 静默 */ }
  }

  selectEl.innerHTML = '<option value="">(无人设)</option>' + personas.map(p => {
    const name = typeof p === "string" ? p : (p.name || p);
    return `<option value="${_escHtml(name)}" ${name === currentPersona ? "selected" : ""}>${_escHtml(name)}</option>`;
  }).join("");

  async function loadDesc(name) {
    if (!name) { descEl.value = ""; return; }
    try {
      // 原 raw GET /api/getdetails/personas/${name} + res.ok 手检 → 门面 getDetails（payload.type/name 进 URL）；!ok 由门面抛错走 catch（descEl 置空）
      const d = await sendAction({ verb: "getDetails", target: "server:details", source: "web", payload: { type: "personas", name } });
      descEl.value = d?.info?.description || d?.description || "";
    } catch { descEl.value = ""; }
  }
  await loadDesc(currentPersona);

  if (!selectEl._bound) {
    selectEl._bound = true;
    selectEl.addEventListener("change", async () => {
      const _cid = window._beiluGetChatId?.() || ""; // [T047] 去裸 hash 回退：守卫返 "" 表非法 hash，不再绕过守卫拿脏 chatid 传 setPersona
      try {
        await loadDesc(selectEl.value);
        if (_cid) {
          // 原 raw PUT persona {personaname} → 门面 setPersona（scope.chatId 进 URL）；!ok 由门面抛错走 catch（原 console.warn 弱化为门面统一报错）
          await sendAction({ verb: "setPersona", target: "shells:chat", source: "web", scope: { chatId: _cid }, payload: { personaname: selectEl.value } });
          window._beiluToast?.("已切换用户人设", "success");
        }
      } catch (err) {
        console.error("[layout] persona switch:", err);
        window._reportError?.(`[layout] persona switch: ${err.message}`, err.stack);
      }
    });
  }

  if (editBtn && !editBtn._bound) {
    editBtn._bound = true;
    let _origDesc = "";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _origDesc = descEl.value;
      descEl.removeAttribute("readonly");
      descEl.focus();
      if (actions) actions.style.display = "";
    });
    saveBtn?.addEventListener("click", async () => {
      const name = selectEl.value;
      if (!name) { window._beiluToast?.("请先选择人设", "warning"); return; }
      try {
        const fd = new FormData();
        fd.append("description", descEl.value);
        // 原 raw PUT persona/${name}/update（FormData body）→ 复用分身S updatePersona（payload.personaName 进 URL，formData 直传 body，apiFetch 识别 FormData 不 JSON 化）；!ok 由门面抛错走 catch
        await sendAction({ verb: "updatePersona", target: "shells:chat", source: "web", payload: { personaName: name, formData: fd } });
        window._beiluToast?.("人设已保存", "success");
        descEl.setAttribute("readonly", "readonly");
        if (actions) actions.style.display = "none";
      } catch (err) {
        window._beiluToast?.("保存失败: " + err.message, "error");
      }
    });
    cancelBtn?.addEventListener("click", () => {
      descEl.value = _origDesc;
      descEl.setAttribute("readonly", "readonly");
      if (actions) actions.style.display = "none";
    });
  }
}

async function _populateSmartWorldbook(curCharId) {
  const sel = document.getElementById("smart-wb-select");
  const statusEl = document.getElementById("smart-wb-status");
  const extraList = document.getElementById("smart-wb-extra-list");
  const addBtn = document.getElementById("smart-wb-add-btn");
  const editBtn = document.getElementById("smart-wb-edit-entries-btn");
  if (!sel) return;

  try {
    // 原 raw GET worldbook getdata + res.ok 手检 → 复用分身S getData；!ok 由门面抛错走外层 catch（statusEl="加载失败"）
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-worldbook", source: "web" });
    const wbList = data?.worldbook_list || [];
    const wbDetails = data?.worldbook_details || {};
    const activeWb = data?.active_worldbook || "";
    let boundWb = "";
    if (curCharId) {
      for (const [name, detail] of Object.entries(wbDetails)) {
        if (detail?.boundCharName === curCharId) { boundWb = name; break; }
      }
    }
    const currentWb = boundWb || activeWb;
    sel.innerHTML = '<option value="">(无世界书)</option>' + wbList.map(n => {
      const detail = wbDetails[n];
      const suffix = detail?.boundCharName ? ` [${_escHtml(detail.boundCharName)}]` : "";
      const cnt = detail?.entry_count != null ? ` (${detail.entry_count}条)` : "";
      return `<option value="${_escHtml(n)}" ${n === currentWb ? "selected" : ""}>${_escHtml(n)}${cnt}${suffix}</option>`;
    }).join("");
    if (statusEl) {
      statusEl.textContent = currentWb || "未绑定";
      statusEl.className = currentWb ? "font-bold" : "opacity-40";
      if (currentWb) statusEl.style.color = "var(--beilu-amber)";
    }

    // 额外世界书列表 (非主世界书，与AIRP口径一致)
    if (extraList) {
      const extras = wbList.filter(n => n !== currentWb);
      if (extras.length === 0) {
        extraList.innerHTML = '<span class="text-xs opacity-40">无</span>';
      } else {
        extraList.innerHTML = extras.slice(0, 5).map(n => {
          const detail = wbDetails[n];
          const cnt = detail?.entry_count ?? 0;
          return `<div class="flex items-center gap-1 text-xs">
            <input type="checkbox" class="checkbox checkbox-xs" data-extra-wb="${_escHtml(n)}" ${detail?.enabled ? "checked" : ""} title="${detail?.enabled ? "取消勾选=停用" : "勾选=启用"}此世界书" />
            <span class="truncate flex-1">${_escHtml(n)}</span>
            <span class="opacity-50 text-[10px]">${cnt}条</span>
          </div>`;
        }).join("");
        // 真实开关：取消勾选 → 后端 toggle_worldbook 停用（汽车理念：开关必须真有效）
        extraList.querySelectorAll("[data-extra-wb]").forEach(cb => {
          cb.addEventListener("change", async () => {
            try {
              // 原 POST setdata {toggle_worldbook:{...}} → 复用分身S 字段写路由 toggle_worldbook（buildBody 组装 {toggle_worldbook:payload}，不注入 _action）；!ok 由门面抛错走 catch（原回滚 cb.checked 保留）
              await sendAction({ verb: "toggle_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: cb.dataset.extraWb, enabled: cb.checked } });
              window._beiluToast?.(`${cb.checked ? "已启用" : "已停用"} ${cb.dataset.extraWb}`, "success");
              await _populateSmartWorldbook(curCharId);
            } catch (err) {
              cb.checked = !cb.checked;
              window._beiluToast?.("世界书开关失败: " + err.message, "error");
            }
          });
        });
      }
    }
  } catch { if (statusEl) statusEl.textContent = "加载失败"; }

  if (!sel._bound) {
    sel._bound = true;
    sel.addEventListener("change", async () => {
      const _char = window._beiluGetCharName?.() || storage.get(KEYS.BEILU_LAST_CHAR) || "";
      try {
        const newName = sel.value;
        if (newName) {
          // 原 POST setdata {switch_worldbook:{...}} → 复用分身S 字段写路由 switch_worldbook；!ok 由门面抛错走外层 catch（原 console.warn 弱化为门面统一报错）
          await sendAction({ verb: "switch_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: newName } });
          if (_char) {
            // 原 POST setdata {bind_worldbook:{...}} → 复用分身S 字段写路由 bind_worldbook
            await sendAction({ verb: "bind_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name: newName, charName: _char } });
          }
        }
        window._beiluToast?.("世界书已切换", "success");
        await _populateSmartWorldbook(_char);
      } catch (err) {
        console.error("[layout] worldbook switch:", err);
        window._reportError?.(`[layout] worldbook switch: ${err.message}`, err.stack);
      }
    });
  }

  if (addBtn && !addBtn._bound) {
    addBtn._bound = true;
    addBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "worldbook-edit" }));
    });
  }

  if (editBtn && !editBtn._bound) {
    editBtn._bound = true;
    editBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "worldbook-edit" }));
    });
  }
}

// 根病3 修复：layout-smart 点击对话时写 lastActive 到共享 meta（与 conversationManager/workPanel 同 key）
// [D5 收口 0713] 原 JSON.parse+storage.set 手抄读写=同键第二套写路径。改走 loadConvMeta/saveConvMeta
//   权威（动态 import 防静态环——smart 若静态引 conversationManager 需核依赖向,沿用面板先例动态取）。
//   _selfSmartMetaWrite 保留：smart 自己的监听按它跳过自触发（各模块自防自，语义不变）。
let _selfSmartMetaWrite = false; // 防递归：_updateLastActive 触发的事件不让 smart 自己重渲染
async function _updateLastActive(chatid) {
  try {
    _selfSmartMetaWrite = true;
    const { loadConvMeta, saveConvMeta } = await import("../../shared/chat-core/conversationManager.mjs");
    const meta = loadConvMeta();
    if (!meta[chatid]) meta[chatid] = {};
    meta[chatid].lastActive = Date.now();
    saveConvMeta(meta);
  } catch { /* ignore */ }
  finally { _selfSmartMetaWrite = false; }
}

async function _populateSmartRecents(curCharId) {
  const listEl = document.getElementById("smart-recents-list");
  if (!listEl) return;
  try {
    // 模式徽章复用 conversationManager.buildModeBadge 单源（凛倾0709 图标必须用上 + 0712 徽章带文字自解释）；
    // 动态 import 防静态环（先例 :444 删除路径同款）
    // 0713 补丁删除：getModeInUseMap 本地收集已废，在用标签唯一权威=服务端 c.usedByModes（P5）。
    const { buildInUseLabel, buildModeBadge, buildOtherWindowBadge } = await import("../../shared/chat-core/conversationManager.mjs");
    // 原 raw GET getchatlist + res.ok 手检 → 复用 getChatList；!ok 由门面抛错走外层 catch（"加载失败"）
    const list = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
    const arr = Array.isArray(list) ? list : [];
    const filtered = curCharId
      ? arr.filter(c => chatBelongsToChar(c, curCharId))
      : arr;
    if (filtered.length === 0) {
      listEl.innerHTML = '<span class="text-xs opacity-40">暂无对话</span>';
      return;
    }
    listEl.innerHTML = filtered.slice(0, 15).map(c => {
      const title = c.customName || c.firstUserMessage || c.summary || c.chatid || "对话"; // N39:customName(服务端权威)优先,对齐 conversationManager/workPanel/cardsPanel
      const short = _escHtml(String(title).slice(0, 28));
      const ts = c.lastMessageTime ? new Date(c.lastMessageTime).toLocaleDateString() : "";
      // 0713 补丁删除：模式徽标唯一权威=服务端 c.mode（`|| convMeta.mode` 本地回退=多源合并，P5 删）。
      const badge = buildModeBadge(c.mode);
      // 「另一窗口在用」角标：buildOtherWindowBadge 单源（D4 收口，原内联判定+文案已分叉两套）
      const inUseBadge = buildOtherWindowBadge(c.chatid, c.inUseCount);
      const usingLabel = buildInUseLabel(c.usedByModes);
      return `<div class="flex items-center gap-1 py-0.5 cursor-pointer hover:bg-base-300/30 rounded px-1 text-xs group flex-wrap" data-chat-id="${_escHtml(c.chatid)}" title="${_escHtml(title)}">
        ${badge}${inUseBadge}<span class="smart-conv-label truncate flex-1" style="min-width:6em;">${short}</span>${usingLabel}<span class="opacity-50 text-[10px]">${ts}</span>
        <button class="text-[10px] opacity-40 group-hover:opacity-60 hover:opacity-100" data-conv-rename title="改名"><i data-ic="edit"></i></button>
        <button class="text-[10px] opacity-40 group-hover:opacity-60 hover:opacity-100" data-conv-mark title="标记模式图标">🏷️</button>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-chat-id]").forEach(el => {
      el.addEventListener("click", async (e) => {
        if (e.target.closest("[data-conv-rename]")) return; // 点改名按钮不切对话
        const cid = el.dataset.chatId;
        if (!cid) return;
        // [R5 0713] 切换收口 switchToChat 单源（lastActive+模式入口快照+[MO-ISO] 指针双写全继承）——
        //   原 _updateLastActive+直调 switchCharacterScope 不传 mode=四列表切换三种写法之一（质量不齐）。
        //   动态 import 防静态环（本文件 :700 徽章单源同款先例）。
        const { switchToChat } = await import("../../shared/chat-core/conversationManager.mjs");
        await switchToChat(cid);
      });
      el.querySelector("[data-conv-rename]")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _renameSmartRecent(el.dataset.chatId, el, curCharId);
      });
      // 🏷️标记模式（四渲染点操作一致性收口 0712：原只有主壳侧栏有此入口）
      el.querySelector("[data-conv-mark]")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { showConvModeMenu } = await import("../../shared/chat-core/conversationManager.mjs");
        showConvModeMenu(e, el.dataset.chatId);
      });
    });
  } catch { listEl.innerHTML = '<span class="text-xs opacity-40">加载失败</span>'; }
}

/**
 * smart 最近对话内联改名——对齐 workPanel._renameHistoryConv / conversationManager.commitRename：
 * N39 单源:先后端 renameChat 持久化(服务端 chat_names 权威,只改文件内记录的显示名,不改磁盘文件名),本地 label 仅离线兜底。
 */
async function _renameSmartRecent(chatid, itemEl, curCharId) {
  if (!chatid) return;
  const labelEl = itemEl?.querySelector(".smart-conv-label");
  if (!labelEl) return;
  let meta = {};
  // [D5 收口 0713] 读也走权威（原 _CONV_META_KEY 手抄常量随收口移除）
  try { meta = (await import("../../shared/chat-core/conversationManager.mjs")).loadConvMeta(); } catch { meta = {}; }
  // [合并批 0714·二] UI 编排收口 mountInlineEdit 单源（4 处同构副本）；
  // 提交段原为 commitChatRename 的手抄第三份（renameChat+warning toast+meta.label 写）——并入 D2 单源。
  // 动态 import 防静态环（本文件对 conversationManager 的既有惯例）。
  mountInlineEdit(labelEl, {
    value: meta[chatid]?.label || "",
    placeholder: "输入对话名称…",
    className: "input input-xs input-bordered w-full",
    onCommit: async (name) => {
      const { commitChatRename } = await import("../../shared/chat-core/conversationManager.mjs");
      // _selfSmartMetaWrite：commitChatRename 内 saveConvMeta 广播 conv-meta-changed，自写不自刷
      _selfSmartMetaWrite = true;
      try { await commitChatRename(chatid, name); }
      finally { _selfSmartMetaWrite = false; }
      await _populateSmartRecents(curCharId);
    },
  });
}

// ============================================================
// W28: Smart Greeting 显隐控制
// ============================================================

function updateSmartGreeting() {
  const panel = document.getElementById("smart-greeting-panel");
  if (!panel) return;
  // 检查聊天区域是否有消息
  const msgList = document.getElementById("chat-messages") || document.querySelector(".message-list");
  const hasMessages = msgList && msgList.children.length > 0;
  panel.classList.toggle("hidden", hasMessages);
}

// 监听消息变化，自动更新greeting显隐
let _smartGreetingObserver = null;
function _bindSmartGreetingObserver() {
  _smartGreetingObserver?.disconnect();
  const target = document.getElementById("chat-messages") || document.querySelector(".message-list");
  if (target) {
    _smartGreetingObserver = new MutationObserver(updateSmartGreeting);
    _smartGreetingObserver.observe(target, { childList: true });
  }
}
_bindSmartGreetingObserver();

// ============================================================
// Greeting 两级分类 (设计13.1)
// ============================================================

const SMART_GREETING_SUBS = {
  chat:   ["随便聊聊", "给我讲个故事", "今天心情不好", "陪我聊天"],
  code:   ["帮我写一段代码", "帮我review代码", "修复一个bug", "解释这段代码"],
  work:   ["帮我翻译文档", "整理笔记要点", "总结会议内容", "写一封邮件"],
  search: ["搜索最新AI资讯", "查一个技术概念", "找一本书推荐", "搜索新闻"],
  write:  ["写一篇短文", "写一首诗", "帮我润色文字", "写产品介绍"],
  play:   ["玩个文字游戏", "出一道谜语", "角色扮演", "唱首歌吧"],
};
const SMART_GREETING_TITLES = {
  chat: '<i data-ic="message"></i> 聊天', code: '<i data-ic="code"></i> 编程', work: '<i data-ic="clipboard"></i> 工作',
  search: '<i data-ic="search"></i> 搜索', write: '<i data-ic="edit"></i> 写作', play: '<i data-ic="gamepad"></i> 娱乐',
};

function _initSmartGreetingCategories() {
  const cats = document.getElementById("smart-categories");
  const subPanel = document.getElementById("smart-sub-panel");
  const subTitle = document.getElementById("smart-sub-title");
  const subList = document.getElementById("smart-sub-list");
  const subBack = document.getElementById("smart-sub-back");
  if (!cats || !subPanel || !subList) return;

  cats.querySelectorAll(".smart-cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const items = SMART_GREETING_SUBS[cat] || [];
      if (subTitle) subTitle.textContent = SMART_GREETING_TITLES[cat] || "";
      subList.innerHTML = items.map(t => `<button class="smart-suggestion" data-prompt="${t.replace(/"/g, "&quot;")}">${t}</button>`).join("");
      subList.querySelectorAll(".smart-suggestion").forEach(b => {
        b.addEventListener("click", () => {
          const input = document.getElementById("message-input");
          if (input) {
            input.value = b.dataset.prompt || b.textContent;
            input.focus();
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
      });
      cats.style.display = "none";
      subPanel.style.display = "";
    });
  });
  subBack?.addEventListener("click", () => {
    subPanel.style.display = "none";
    cats.style.display = "";
  });
}

function _initSmartCollapseMemory() {
  const KEY = KEYS.BEILU_SMART_COLLAPSE_STATE;
  let saved = {};
  try { saved = JSON.parse(storage.get(KEY) || "{}"); } catch { saved = {}; }

  document.querySelectorAll("[data-smart-collapse]").forEach(input => {
    const id = input.dataset.smartCollapse;
    // 恢复状态 (若曾手动改过)
    if (Object.prototype.hasOwnProperty.call(saved, id)) {
      input.checked = !!saved[id];
    }
    input.addEventListener("change", () => {
      saved[id] = !!input.checked;
      try { storage.set(KEY, JSON.stringify(saved)); } catch { /* 容量满,忽略 */ }
    });
  });
}

// 根病3 修复：conversationManager / workPanel / index-chatmgmt 修改 meta 后广播此事件，
// layout-smart 的最近对话列表需同步更新（rename 后 customName 变了 / lastActive 排序变了）。
// 防抖 500ms 避免高频重刷（pin+star 连续操作）。
let _smartMetaTimer = null;
window.addEventListener("beilu:conv-meta-changed", () => {
  if (_selfSmartMetaWrite) return; // 本模块 _updateLastActive 触发的事件不自刷
  if (_smartMetaTimer) clearTimeout(_smartMetaTimer);
  _smartMetaTimer = setTimeout(() => {
    _smartMetaTimer = null;
    _populateSmartRecents(_getSmartCurChar()); // 角色口径单源（对齐 chatmgmt 弹窗）
  }, 500);
});

// 服务端列表变更（AI <chatRename> 改名 / 另一端新建、删除、改名）经 websocket 桥成本事件——
// smart 最近对话原只听 conv-meta-changed（本地 meta 写），服务端权威 customName 变更走这条，缺听=AI改名后 smart 列表不刷新。
// 防抖复用同一 timer（两事件常同批到达，合并一次重渲）。
window.addEventListener("beilu:chat-list-changed", () => {
  if (_smartMetaTimer) clearTimeout(_smartMetaTimer);
  _smartMetaTimer = setTimeout(() => {
    _smartMetaTimer = null;
    _populateSmartRecents(_getSmartCurChar()); // 角色口径单源（对齐 chatmgmt 弹窗）
  }, 500);
});

// 0713 角色过滤断链闭合：初始填充只在切 tab 时跑一次（layout.mjs switchLeftContent），常跑在
// 角色/聊天异步加载完成之前 → _getSmartCurChar 四级链全空 → :702 过滤不生效，列表显示全部角色
// 对话且永不重渲（chatmgmt 弹窗开得晚拿得到 charList[0]，故弹窗过滤正常=左右口径分裂复发）。
// char-changed 生产者（index.mjs loadCharInfo 启动路径 + chat.mjs switchCharacterScope 切卡路径）
// 都在角色解析完成后派发，此时重渲必拿到非空角色。防抖复用同一 timer（与上两监听同批合并）。
window.addEventListener("beilu:char-changed", whenVisible("#center-tab-smart", () => {
  if (_smartMetaTimer) clearTimeout(_smartMetaTimer);
  _smartMetaTimer = setTimeout(() => {
    _smartMetaTimer = null;
    _populateSmartRecents(_getSmartCurChar());
  }, 500);
}));

export { _setupSmartPolling, _refreshSmartTaskCounters, _setupSmartRightPanel, _populateSmartLeftPanel, updateSmartGreeting, _bindSmartGreetingObserver, _initSmartGreetingCategories, _initSmartCollapseMemory };
