/**
 * pipelinePanel.mjs — IDE skill 组启动面板
 *
 * 功能链：
 *   initPipelinePanel → _initSkillGroupPicker → _listFlowGroups → 渲染 skill 组卡片
 *     → 点某 skill 组「启动」→ _startGroup → POST setdata {_action:"startFlowGroup"}
 *     → 成功后派发 beilu:subModeSwitched（subModePanel/workPanel 消费刷新）
 *
 * why（2026-07-09 凛倾）：
 *   原面板的「当前角色 第N/M位」角色位次进度显示已删——工作组织形态是 tasks（AI 列任务，
 *   进度归聊天流顶部任务卡），不是链式流程展示；skill 组「启动」保留（一键按序切子模式有用）。
 *
 * 关联链：
 *   → shared/transport/sendAction.mjs（T6b：出向统一门面，verb=真动作；plugins:beilu-memory 通配 setdata 路由）
 *   → shared/state/utils.mjs escapeHtml（组名/步骤标签 XSS 安全）
 *   → shared/widgets/beiluDialog.mjs beiluConfirm（删除自建组二次确认）
 *   ← layout.mjs（IDE 初始化时调用 initPipelinePanel）
 *
 * 影响范围：
 *   #ide-pipeline-panel / #skill-group-picker DOM。
 *
 * 使用效果：
 *   skill 组卡片列出可启动的自动化流程，点启动后后端按序切换子模式执行；可新建/删除自建组。
 */

import { showToast } from "../../../../../../scripts/toast.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b: 出向统一门面（verb=真动作，失败统一报错可见；apiFetch 经门面内部走）
import { beiluConfirm } from "../../shared/widgets/beiluDialog.mjs";
import { getUsername as _getUsername } from "../../shared/state/sharedState.mjs"; // [合并批 0714] username 读点单源（别名保调用点）

let _panelEl = null;
// 防止热重载或多次调用initPipelinePanel时重复注册
let _initialized = false;

export function initPipelinePanel() {
  if (_initialized) return;
  _initialized = true;

  _panelEl = document.getElementById("ide-pipeline-panel");
  if (!_panelEl) return;

  _initSkillGroupPicker();
}

async function _sd(action, body) {
  // T6b：verb=真动作，通配路由组装 _action；原 raw:true + resp.json() 由门面统一（!ok 抛错，成功返回解析体）
  // 会话键：sendAction 门面统一盖章 scope.chatId→桥注入 args.chatid（键收口 2026-07-13），本处不再手拼
  return await sendAction({
    verb: action, target: "plugins:beilu-memory", source: "web",
    payload: { username: _getUsername(), ...body },
  });
}

/** skill 组库：内置组(🔒不可删)+自建组(可删)+新建。列表式。 */
async function _initSkillGroupPicker() {
  if (!_panelEl) return;
  let bar = document.getElementById("skill-group-picker");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "skill-group-picker";
    bar.className = "mb-1 space-y-0.5";
    _panelEl.appendChild(bar);
  }
  await _renderSkillGroups();
}

async function _renderSkillGroups() {
  const bar = document.getElementById("skill-group-picker");
  if (!bar) return;
  let groups = [];
  try {
    const _r = await _sd("listFlowGroups", {});
    if (_r && _r.success === false) { bar.innerHTML = `<div class="text-[10px] text-error/70">skill组加载失败：${escapeHtml(_r.error || "")}</div>`; return; }
    // [D4 0713] `|| "code"` 内联默认删除：listFlowGroups 后端投影已归一 modeGroup（缺省"code"），字段必在
    groups = (_r?.groups || []).filter((g) => g.modeGroup === "code");
  } catch (e) {
    bar.innerHTML = `<div class="text-[10px] text-error/70">skill组加载失败：${escapeHtml(e.message || "网络错误")}</div>`;
    return;
  }
  let html = "";
  for (const g of groups) {
    const tip = (g.steps || []).map((s) => `${s.icon || ""}${s.label}`).join(" → ");
    const tag = g.builtin ? '<span title="内置组，不可删除"><i data-ic="lock"></i></span>' : `<button class="skill-del text-error/70 hover:text-error" data-fn="${escapeHtml(g.filename)}" data-nm="${escapeHtml(g.name)}" title="删除自建组"><i data-ic="trash"></i></button>`;
    html += `<div class="flex items-center gap-1 text-[11px]" title="${escapeHtml(tip)}">` +
      `<span class="flex-1 truncate">🗂️ ${escapeHtml(g.name)} <span class="text-base-content/40">(${g.stepCount}步)</span></span>` +
      `<button class="skill-start btn btn-xs btn-primary h-5 min-h-0 px-1.5 text-[10px]" data-fn="${escapeHtml(g.filename)}">▶</button>` +
      tag +
      `</div>`;
  }
  html += `<button id="skill-new" class="btn btn-xs btn-ghost h-5 min-h-0 text-[10px] w-full"><i data-ic="plus"></i> 新建组</button>`;
  bar.innerHTML = html;
  bar.querySelectorAll(".skill-start").forEach((b) => b.addEventListener("click", () => _startGroup(b.dataset.fn)));
  bar.querySelectorAll(".skill-del").forEach((b) => b.addEventListener("click", () => _deleteGroup(b.dataset.fn, b.dataset.nm)));
  document.getElementById("skill-new")?.addEventListener("click", _showCreateForm);
}

async function _startGroup(filename) {
  if (!filename) return;
  try {
    const data = await _sd("startFlowGroup", { filename });
    if (data?.success) {
      if (data.subModeSwitch?.to) window.dispatchEvent(new CustomEvent("beilu:subModeSwitched", { detail: data.subModeSwitch }));
      showToast("success", `已启动「${data.name}」（${data.totalSteps} 步）`);
    } else showToast("error", "启动失败：" + (data?.error || "未知错误"));
  } catch (e) { showToast("error", "启动失败：" + (e.message || "网络错误")); }
}

async function _deleteGroup(filename, name) {
  if (!filename) return;
  if (!await beiluConfirm(`删除自建 skill 组「${name || filename}」？`)) return;
  try {
    const data = await _sd("deleteFlowGroup", { filename });
    if (data?.success) { showToast("success", "已删除"); await _renderSkillGroups(); }
    else showToast("error", "删除失败：" + (data?.error || "未知错误"));
  } catch (e) { showToast("error", "删除失败：" + (e.message || "网络错误")); }
}

/** 新建组：勾选子模式（按勾选顺序为步骤）+ 组名 → saveFlowGroup。 */
async function _showCreateForm() {
  let subs = [];
  try { subs = (await _sd("getSubModes", {}))?.sub_modes || []; } catch (_) {}
  // 按 modeGroup 分组展示所有子模式（code + work），不再只显示 code
  // [D4 0713] getSubModes 读路径（W64 迁移）+ saveSubModes 写路径均已归一 modeGroup，内联默认删除
  const codeSubs = subs.filter((m) => m.modeGroup === "code");
  const workSubs = subs.filter((m) => m.modeGroup === "work");
  const ov = document.createElement("div");
  ov.className = "fixed inset-0 bg-black/50 flex items-center justify-center"; ov.style.zIndex = "var(--z-diag)"; // 层级表单一权威(index.css)禁硬编码9999
  const _mkOpts = (arr) => arr.map((m) => `<label class="flex items-center gap-1 text-xs py-0.5"><input type="checkbox" class="skill-cb" data-mode="${escapeHtml(m.id)}" data-preset="${escapeHtml(m.presetName || "")}" data-label="${escapeHtml(m.label || m.id)}" data-icon="${escapeHtml(m.icon || "")}"/> ${escapeHtml((m.icon || "") + (m.label || m.id))}</label>`).join("");
  let opts = "";
  if (codeSubs.length) opts += `<div class="text-[10px] opacity-50 pt-1">Code 子模式</div>` + _mkOpts(codeSubs);
  if (workSubs.length) opts += `<div class="text-[10px] opacity-50 pt-1">Work 子模式</div>` + _mkOpts(workSubs);
  ov.innerHTML = `<div class="bg-base-200 rounded-lg p-4 w-80 max-h-[80vh] overflow-y-auto space-y-2">` +
    `<div class="font-bold text-sm"><i data-ic="plus"></i> 新建 skill 组</div>` +
    `<input id="skill-name" class="input input-xs input-bordered w-full" placeholder="组名（如：我的流程）"/>` +
    `<div class="text-[11px] opacity-60">勾选子模式（步骤顺序 = 下面列表自上而下被勾选的顺序）：</div>` +
    `<div class="space-y-0.5">${opts || '<div class="opacity-50 text-xs">无可用子模式</div>'}</div>` +
    `<div class="flex gap-2 pt-1"><button id="skill-save" class="btn btn-xs btn-primary flex-1">保存</button><button id="skill-cancel" class="btn btn-xs btn-ghost">取消</button></div>` +
    `</div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  document.getElementById("skill-cancel").addEventListener("click", () => ov.remove());
  document.getElementById("skill-save").addEventListener("click", async () => {
    const name = document.getElementById("skill-name").value.trim();
    if (!name) { showToast("error", "请填组名"); return; }
    const steps = [...ov.querySelectorAll(".skill-cb")].filter((c) => c.checked).map((c) => ({ mode: c.dataset.mode, preset_name: c.dataset.preset, label: c.dataset.label, icon: c.dataset.icon }));
    if (!steps.length) { showToast("error", "至少选一个子模式"); return; }
    try {
      const data = await _sd("saveFlowGroup", { name, steps, auto_advance: true });
      if (data?.success) { showToast("success", `已新建「${name}」`); ov.remove(); await _renderSkillGroups(); }
      else showToast("error", "保存失败：" + (data?.error || "未知错误"));
    } catch (e) { showToast("error", "保存失败：" + (e.message || "网络错误")); }
  });
}

// [合并批 0714] _getUsername 手抄副本删除 → sharedState.getUsername 单源
