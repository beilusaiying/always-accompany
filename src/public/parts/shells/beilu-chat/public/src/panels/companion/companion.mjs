/**
 * companion.mjs — 桌宠（伴随）模式活动栏与设置 cluster
 *
 * 功能链：切换到 Companion Tab → initCompanionActivityBar() 绑定活动栏按钮
 *   → 进入宠物设置面板时 initCompanionPetSettings() 懒加载（仅首次）→ GET /api/eye/pet-settings 读取当前配置
 *   → 用户调整对话框颜色/透明度/动态预设/模型等 → _petPost() POST 全量写回 /api/eye/pet-settings
 *   → 桌宠主进程（desktop-eye/main.js）轮询该端点实时应用；web 端直驱 beiluLive2d.applyUserDynamics()
 * why：桌宠是独立的 Electron 进程，配置通过 beilu 单一权威 API 传递，UI 设置面板需要隔离在专属 cluster 中
 *   以管理复杂的动态预设状态（_compDyn 对象 + 细分滑块）
 * 关联链：被 layout.mjs import（initCompanionActivityBar 在 initLayout 时调用）；
 *   import core.mjs（initSidebarResize）、api-client.mjs（pet-settings 读写）；
 *   配置写入后被 desktop-eye/main.js 消费
 * 影响范围：改动影响桌宠对话框外观（颜色/圆角/透明度）、Live2D 动态参数（拖拽/凝视/嘴型）、模型切换
 * 使用效果：用户在 Companion 面板调整设置后几秒内桌宠窗口即时生效，无需重启
 */
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（server:eye 桌宠端点 / memory 通配 gameCompanion / chars·chat 列表复用）
import { initHitEditor, hitEditorLoad } from "./hitEditor.mjs";
import { initCompanionLiveSettings } from "./live.mjs"; // 直播接入段(beilu-live 插件,0726):插件前端独立成文件的惯例同 eye.mjs
import { initCompanionChat } from "./companionChat.mjs"; // 陪伴对话面板(AIRP 形态,拉线承载对话,凛倾 2026-07-16)
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { initSidebarResize } from "../../shared/layout/core.mjs";
import { escapeHtml, BOT_CHAT_SYMBOL } from "../../shared/state/utils.mjs"; // T7：HTML 转义收口到唯一权威实现（5 字符含单引号；原本地多个 esc 变体缺单/双引号）;0715 bot 符号单源
import { beiluPrompt } from "../../shared/widgets/beiluDialog.mjs"; // 0714 扫尾：window.prompt 漏迁（全壳已统一 beiluDialog）
import { setSttRecordDevice, setSttServerDenoise } from "../../shared/state/sttSettings.mjs"; // 0722 散写收口:STT 设备/降噪双 store 写唯一 owner(扩展面板同消费)
import { applyParamSchemaToInputs } from "../../shared/state/paramSchemaCache.mjs"; // 0723 陪伴子模式实体表单:限值单源 PARAM_SCHEMA(同 bot dc-bsm 范式)
import { ENUM_FALLBACK } from "../../shared/state/enumFallback.mjs"; // 0723:后处理/预填充选项集离线退化单源(权威=getSubModes 随包 enum_schema,同 subModePanel._enumOptions 语义)
import { acceleratorFromKeyboardEvent } from "../../shared/input/accelerator.mjs";

let _ensureCompanionRenderer = null;
let _rendererRetryBound = false;

function _wireRendererRetry() {
  if (_rendererRetryBound) return;
  const retry = document.getElementById("comp-renderer-retry");
  if (!retry) return;
  _rendererRetryBound = true;
  retry.addEventListener("click", () => {
    if (typeof _ensureCompanionRenderer !== "function") return;
    _ensureCompanionRenderer().catch(() => { /* index.mjs 已将失败写入可见状态 */ });
  });
}

function configureCompanionRendererLoader(ensureRenderer) {
  if (typeof ensureRenderer !== "function") throw new TypeError("ensureRenderer 必须是函数");
  _ensureCompanionRenderer = ensureRenderer;
  _wireRendererRetry();
}

function setCompanionRendererState(state, error) {
  const host = document.getElementById("comp-renderer-state");
  const text = document.getElementById("comp-renderer-state-text");
  const retry = document.getElementById("comp-renderer-retry");
  if (!host || !text || !retry) return;
  if (state === "ready" || state === "idle") {
    host.classList.add("hidden");
    retry.classList.add("hidden");
    return;
  }
  host.classList.remove("hidden");
  if (state === "loading") {
    text.textContent = "正在加载虚拟形象…";
    retry.classList.add("hidden");
  } else {
    text.textContent = `虚拟形象加载失败：${error?.message || error || "未知错误"}`;
    retry.classList.remove("hidden");
  }
}

async function _previewSelectedModel(name) {
  if (!name) return true;
  if (typeof _ensureCompanionRenderer !== "function") throw new Error("虚拟形象加载器未配置");
  await _ensureCompanionRenderer();
  const api = window.beiluLive2d;
  if (!api || typeof api.reloadModel !== "function") throw new Error("虚拟形象渲染器未就绪");
  const ok = await api.reloadModel(name);
  if (!ok) throw new Error(`无法切换到形象: ${name}`);
  return true;
}

function _reportPreviewSelectionError(error) {
  const message = error?.message || String(error);
  window._beiluToast?.("虚拟形象预览失败: " + message, "error");
  window._reportError?.(`[companion] 虚拟形象预览失败: ${message}`, error?.stack);
}

// 🐾 桌宠设置面板(T5/T6/T8):读写 beilu 单一权威源 data/pet_settings.json(/api/eye/pet-settings)。
// 桌宠主进程轮询该端点→实时应用(对话框颜色/透明度/停留/圆角、模型切换、动态预设、穿透、开关)。
// ── 任务⑥硬编码收口(2026-07-09):预设/选项集权威=后端 /api/eye/pet-capabilities(injection_state.PET_CAPABILITIES)。
//   此处仅留【离线兜底】(后端不可达时 UI 不瘫,凛倾离线原则);后端到达即整体覆盖,托盘(main.js)读同一端点=双侧同源。
// 凛倾 2026-07-09"同一键多处散写"纠偏:预设值【零本地副本】,唯一权威=后端 PET_CAPABILITIES。
// 离线退化=只有"标准"(空覆盖),不复制数值兜底(增强可退化,数值不分叉)。
let _PET_DYN_PRESETS = { "": {} };
// 桌宠角落值域:兜底同上,capabilities.corners 到达即覆盖(读回填与 change 写回共用此表)。
let PET_CORNERS = ["br", "bl", "tr", "tl"];
const PET_CORNER_DEFAULT = "br";
let _petCaps = null; // pet-capabilities 缓存(一次拉取)
// AI 自主设置块(凛倾 2026-07-09"与屏幕感知合并,可设置反馈,不硬编码"):
//   谱=caps.aiAutonomy(开关列表+dwell 标签,单源);值=eye_config(aiAllow*/aiFeedback*)。
//   两个异步源先后不定 → 谱到=建 DOM,值到=回填,双向都调本函数汇合。change 绑定在 FT-A4 块(委托,_eyeMergePost 作用域内)。
let _aiAutoSpec = null;
let _aiAutoVals = null;
function _renderAiAutonomy() {
  const box = document.getElementById("comp-ai-autonomy");
  if (!box || !_aiAutoSpec) return;
  if (!box.dataset.built) {
    const rows = (_aiAutoSpec.toggles || []).filter(t => t && t.k);
    if (!rows.length) return; // caps 不可达/谱空=诚实降级(容器留空,不编造开关)
    box.innerHTML = rows.map(t =>
      `<label class="flex items-center justify-between text-xs bg-base-300/40 rounded px-2 py-1.5" title="${_capEsc(t.hint || "")}"><span>${_capEsc(t.label || t.k)}</span><input type="checkbox" data-ai-k="${_capEsc(t.k)}" class="toggle toggle-sm toggle-warning" /></label>`).join("");
    box.dataset.built = "1";
    const dwl = document.getElementById("comp-ai-dwell-label");
    if (dwl && _aiAutoSpec.dwell && _aiAutoSpec.dwell.label) dwl.textContent = _aiAutoSpec.dwell.label;
  }
  if (_aiAutoVals) {
    box.querySelectorAll("input[data-ai-k]").forEach(cb => { cb.checked = _aiAutoVals[cb.dataset.aiK] !== false; }); // 无键=默认放行(同后端 !== false 语义)
    const dwIn = document.getElementById("comp-ai-dwell");
    const dk = _aiAutoSpec.dwell && _aiAutoSpec.dwell.k; // dwell 键同走谱(与写侧一致,零字面量副本)
    if (dwIn && dk && typeof _aiAutoVals[dk] === "number") dwIn.value = _aiAutoVals[dk];
  }
}
const _capEsc = escapeHtml; // T7：alias 到唯一权威实现（原本地 4 字符 replace 链缺单引号，已删）
// 用 [{value,label}] 重建 select option,保持当前选中值(回填先后到达都安全)。
function _fillSelect(id, opts) {
  const sel = document.getElementById(id);
  if (!sel || !Array.isArray(opts) || !opts.length) return;
  const keep = sel.value;
  sel.innerHTML = opts.map(o => `<option value="${_capEsc(o.value)}">${_capEsc(o.label)}</option>`).join("");
  sel.value = keep;
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
}
async function _loadPetCapabilities() {
  if (_petCaps) return;
  try {
    const caps = await sendAction({ verb: "getPetCapabilities", target: "server:eye", source: "web" });
    if (!caps || typeof caps !== "object") return;
    _petCaps = caps;
    if (caps.dynPresets && typeof caps.dynPresets === "object") {
      _PET_DYN_PRESETS = caps.dynPresets;
      _fillSelect("pet-dynamics", Object.keys(caps.dynPresets).map(k => ({ value: k, label: k || "标准" })));
    }
    if (Array.isArray(caps.corners) && caps.corners.length) {
      PET_CORNERS = caps.corners.map(c => c.value);
      _fillSelect("pet-corner", caps.corners);
    }
    // creatures 已移除(凛倾 2026-07-14)
    if (Array.isArray(caps.resolutions) && caps.resolutions.length) _fillSelect("comp-resolution", caps.resolutions.map(v => ({ value: String(v), label: String(v) })));
    if (Array.isArray(caps.dynSpec)) _DYN_SPEC = caps.dynSpec.filter(s => s && s.g && s.k); // 滑块谱单源(收口二批)
    if (Array.isArray(caps.dynToggles)) _DYN_TOGGLES = caps.dynToggles.filter(t => t && t.g); // 开关谱单源(airi 对标批)
    try { if (caps.hitLimits && window.beiluLive2d && window.beiluLive2d.setHitCountResetMs) window.beiluLive2d.setHitCountResetMs(caps.hitLimits.countResetMs); } catch (e) { /* 渲染层未就绪 */ } // 次数细分窗口(web 侧注入)
    if (Array.isArray(caps.ipkDynSpec)) _IPK_DYN_SPEC = caps.ipkDynSpec.filter(s => s && s.k).map(s => [s.k, s.label || s.k]); // 包动效谱单源
    // 窗高输入值域提示=Electron 真实钳位域(同 caps 单源;此前后端静默 clamp 而前端无域提示=设了被钳的暗坑)
    const _wl = caps.petWinLimits || {};
    const _setRange = (id, r) => { const el = document.getElementById(id); if (el && r) { if (Number(r.min) > 0) el.min = r.min; if (Number(r.max) > 0) el.max = r.max; el.placeholder = `${r.min}-${r.max}(空=默认)`; } };
    _setRange("pet-height", _wl.charH);
    _setRange("pet-bubblewin-h", _wl.bubbleH);
    if (caps.aiAutonomy && typeof caps.aiAutonomy === "object") { _aiAutoSpec = caps.aiAutonomy; _renderAiAutonomy(); } // AI 自主谱到达=建块
  } catch (e) { /* 离线:HTML 既有 option + 上方兜底继续可用 */ }
}
// 完整用户 dynamics(预设 + 细分滑块 + motion 开关)。applyUserDynamics 整体替换 _userDyn,故每次必 POST 全量(非补丁)。
let _compDyn = {};
function _compDynGet(group, key, def) { const g = _compDyn[group]; return (g && g[key] != null) ? g[key] : def; }
function _compDynSet(group, key, val) { if (!_compDyn[group] || typeof _compDyn[group] !== "object") _compDyn[group] = {}; _compDyn[group][key] = val; }
// POST 全量 + 即时驱动 web 预览渲染层(桌面端经 beilu onPetConfig 同步;web 无 IPC 故直驱)。
function _applyCompDynToRenderer() {
  const api = window.beiluLive2d;
  if (api && api.applyUserDynamics) api.applyUserDynamics(_compDyn);
}
function _compDynApply() {
  _petPost({ dynamics: _compDyn });
  try { _applyCompDynToRenderer(); } catch (e) { /* 渲染层未就绪 */ }
}
// ── 动态/物理 全量细分参数(凛倾 2026-07-09:"live的参数后端做了一堆前端全部没有"):
//   谱=UI元数据(组/键/标签/范围/步长/单位),【默认值不在谱里】——单源=渲染层 DYN_DEFAULT(window.beiluLive2d._dynDefaults()),
//   前端零默认副本(防前后端默认分叉)。控件由 _buildDynControls 按谱生成,零 HTML 写死。 ──
// 值域对齐【官方 Cubism 标准参数域】(凛倾 2026-07-09:"live的参数和官方不对齐"):域说明见后端谱注释。
// 谱单源(凛倾 2026-07-09"为什么还要好多硬编码"):min/max/step/标签全来自后端 caps.dynSpec
//   (出厂默认 injection_state.PET_CAPABILITIES ← data/pet_capabilities.json 用户可覆盖),前端零数值副本。
//   离线(caps 不可达)=谱空 → 细分滑块区显示占位说明,与"设置本就需 beilu 运行才能保存"一致。
let _DYN_SPEC = [];
// 开关谱单源=caps.dynToggles(2026-07-09 同病同修:此前前端 const 副本);离线=空,滑块区占位说明同 _DYN_SPEC。
let _DYN_TOGGLES = [];
function _dynDefaults() {
  try { return (window.beiluLive2d && window.beiluLive2d._dynDefaults) ? window.beiluLive2d._dynDefaults() : {}; }
  catch (e) { return {}; }
}
let _dynControlsBuilt = false;
function _buildDynControls() {
  if (_dynControlsBuilt) return;
  const grid = document.getElementById("comp-dyn-grid");
  const tog = document.getElementById("comp-dyn-toggles");
  if (!grid || !tog) return;
  if (!_DYN_SPEC.length) { // 谱未到(离线/后端未起):占位说明,不置 built 标志=谱到后可重建
    grid.innerHTML = '<p class="text-xs opacity-40 col-span-full">细分参数谱来自 beilu 后端(可经 data/pet_capabilities.json 自定义),当前不可达。</p>';
    return;
  }
  _dynControlsBuilt = true;
  grid.innerHTML = ""; tog.innerHTML = ""; // 幂等:占位/旧控件清场再建
  for (const t of _DYN_TOGGLES) {
    const lab = document.createElement("label");
    lab.className = "flex items-center justify-between text-[11px] bg-base-300/40 rounded px-2 py-1.5";
    lab.innerHTML = `<span>${t.label}</span><input type="checkbox" id="comp-dyn-${t.g}-enabled" class="toggle toggle-xs toggle-warning" checked />`;
    tog.appendChild(lab);
    lab.querySelector("input").addEventListener("change", (e) => { _compDynSet(t.g, "enabled", e.target.checked); _compDynApply(); });
  }
  for (const s of _DYN_SPEC) {
    const id = `comp-dyn-${s.g}-${s.k}`;
    const lab = document.createElement("label");
    lab.className = "form-control";
    lab.innerHTML = `<span class="label-text text-xs mb-1">${s.label} <span class="opacity-50" id="${id}-val">${s.g}.${s.k}</span></span>` +
      `<input type="range" id="${id}" class="range range-xs range-warning" min="${s.min}" max="${s.max}" step="${s.step}">`;
    grid.appendChild(lab);
    const el = lab.querySelector("input");
    el.addEventListener("input", (ev) => { const l = document.getElementById(id + "-val"); if (l) l.textContent = `${s.g}.${s.k} ${Number(ev.target.value)}`; });
    el.addEventListener("change", (ev) => { _compDynSet(s.g, s.k, Number(ev.target.value)); _compDynApply(); });
  }
}
// 从 _compDyn 回填全部控件(空=渲染层 DYN_DEFAULT 单源值;渲染层未就绪时留谱名占位不显示假数)。
function _compDynRefreshUI() {
  _buildDynControls();
  const g = id => document.getElementById(id);
  const defs = _dynDefaults();
  for (const s of _DYN_SPEC) {
    const id = `comp-dyn-${s.g}-${s.k}`;
    const el = g(id); if (!el) continue;
    const defVal = defs[s.g] ? defs[s.g][s.k] : undefined;
    const val = _compDynGet(s.g, s.k, defVal);
    if (val != null) { el.value = val; const l = g(id + "-val"); if (l) l.textContent = `${s.g}.${s.k} ${Number(val)}`; }
  }
  for (const t of _DYN_TOGGLES) {
    const el = g(`comp-dyn-${t.g}-enabled`); if (!el) continue;
    const defOn = !(defs[t.g] && defs[t.g].enabled === false);
    el.checked = _compDynGet(t.g, "enabled", defOn) !== false;
  }
  if (g("comp-motion-idle")) g("comp-motion-idle").checked = _compDynGet("motion", "idleLoop", true) !== false;
  if (g("comp-motion-tap")) g("comp-motion-tap").checked = _compDynGet("motion", "tap", true) !== false;
}

function refreshCompanionRendererSettings() {
  const api = window.beiluLive2d;
  if (!api) return;
  if (_petCaps?.hitLimits && api.setHitCountResetMs) api.setHitCountResetMs(_petCaps.hitLimits.countResetMs);
  _compDynRefreshUI();
  _applyCompDynToRenderer();
}
// ── 图片包编辑器(任务③,凛倾:"可以编辑图片,增加表情,增加图片") ──
//   数据单源=pack.json(读:静态端点;写:saveImagepack 整包写回;图片:uploadImagepackImage base64 落盘)。
//   表情键白检=消费端同规则(extractEmotion 值卫生 + _splitEmotionTags 分隔符):禁空格/逗号/竖线。
let _ipk = null, _ipkName = "";
let _ipkNames = new Set(); // 现存图片包名集合(模式判定/当前包回填用)
const _IPK_KEY_RE = /^[\w\u4e00-\u9fa5-]+$/;
function _ipkStatus(t, err) { const s = document.getElementById("ipk-status"); if (s) { s.textContent = t; s.className = "text-[10px] ml-auto " + (err ? "text-error" : "text-success"); } }
async function _ipkRefreshList(keep) {
  const sel = document.getElementById("ipk-select");
  let packs = [];
  try { packs = await sendAction({ verb: "getImagepacks", target: "server:eye", source: "web" }) || []; } catch (e) { /* 离线:空列表 */ }
  _ipkNames = new Set(packs.map(p => p && p.name).filter(Boolean));
  const opts = packs.map(p => `<option value="${_capEsc(p.name)}">${_capEsc(p.name)}</option>`).join("");
  if (sel) { sel.innerHTML = '<option value="">选择图片包…</option>' + opts; if (keep) sel.value = keep; }
  const act = document.getElementById("ipk-active"); // 「当前使用的图片包」下拉(图片包段,选中即切 modelName)
  if (act) { const kv = act.value; act.innerHTML = '<option value="">(未用图片包)</option>' + opts; act.value = kv; }
}
async function _ipkLoad(name) {
  _ipkName = name; _ipk = null;
  const body = document.getElementById("ipk-body");
  if (!name) { if (body) body.style.display = "none"; return; }
  try {
    // R1-SKIP: pack.json 静态资源(同 model_dict 范式),非业务端点。no-store:编辑器必须读到最新(链路修)。
    const r = await fetch(`/api/eye/user-images/${encodeURIComponent(name)}/pack.json`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    _ipk = await r.json();
  } catch (e) { _ipkStatus("包读取失败: " + e.message, true); return; }
  if (!_ipk || typeof _ipk !== "object") _ipk = {};
  if (!_ipk.expressions || typeof _ipk.expressions !== "object") _ipk.expressions = {};
  if (body) body.style.display = "flex";
  _ipkRender();
}
async function _ipkSave() {
  try {
    await sendAction({ verb: "saveImagepack", target: "server:eye", source: "web", payload: { pack: _ipkName, json: _ipk } });
    _ipkStatus("已保存 · 正在使用此包时刷新页面生效");
  } catch (e) { _ipkStatus("保存失败: " + e.message, true); }
}
// 上传管线(单源:文件选择与拖拽共用同一条链——校验→base64→upload端点→入包键→整包保存)
async function _ipkUploadFiles(key, files) { // key=表情键 或 "\u0000talk"=说话差分行
  let touched = false;
  for (const f of files || []) {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(f.name)) { _ipkStatus(`跳过 ${f.name}(仅图片)`, true); continue; }
    const maxB = Number(_petCaps && _petCaps.imagepackUploadMaxBytes) || 0; // 限值单源=capabilities;拿不到=跳过预检(端点仍强制,无本地数值副本)
    if (maxB && f.size > maxB) { _ipkStatus(`${f.name} 超过 ${Math.round(maxB / 1048576)}MB`, true); continue; }
    try {
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(f); });
      await sendAction({ verb: "uploadImagepackImage", target: "server:eye", source: "web", payload: { pack: _ipkName, filename: f.name, dataBase64: b64 } });
      if (key === "\u0000talk") { if (!Array.isArray(_ipk.talk)) _ipk.talk = []; if (!_ipk.talk.includes(f.name)) _ipk.talk.push(f.name); }
      else { if (!Array.isArray(_ipk.expressions[key])) _ipk.expressions[key] = _ipk.expressions[key] ? [_ipk.expressions[key]] : []; if (!_ipk.expressions[key].includes(f.name)) _ipk.expressions[key].push(f.name); }
      touched = true;
    } catch (e) { _ipkStatus(`${f.name} 上传失败: ` + e.message, true); break; }
  }
  if (touched) { await _ipkSave(); _ipkRender(); }
}
function _ipkUploadInput(key) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/png,image/jpeg,image/gif,image/webp"; inp.multiple = true;
  inp.className = "hidden";
  inp.addEventListener("change", () => _ipkUploadFiles(key, inp.files));
  return inp;
}
function _ipkRow(label, files, key) {
  const row = document.createElement("div");
  row.className = "flex items-start gap-2 bg-base-300/30 rounded px-2 py-1.5 text-xs";
  const isTalk = key === "\u0000talk";
  const _v = Date.now(); // 缩略图缓存 bust:换图/重传同名后立即见新图
  const chips = files.map((f, i) =>
    `<span class="inline-flex flex-col items-center gap-0.5 bg-base-100/60 rounded p-1">` +
    `<img data-prev="1" src="/api/eye/user-images/${encodeURIComponent(_ipkName)}/${encodeURIComponent(f)}?v=${_v}" class="h-16 w-14 object-contain rounded cursor-pointer" title="点击在右侧预览该表情"/>` +
    `<span class="flex items-center gap-1 max-w-[72px]"><span class="truncate text-[9px] opacity-60" title="${_capEsc(f)}">${_capEsc(f)}</span>` +
    `<button data-del="${i}" class="opacity-50 hover:text-error" title="从包移除该图(不删物理文件)">✕</button></span></span>`).join("");
  row.innerHTML = `<span class="font-bold shrink-0 pt-1 min-w-[72px]">${_capEsc(label)}</span>` +
    `<div class="flex flex-wrap gap-1 flex-1">${chips}</div>` +
    `<button data-addimg class="btn btn-xs btn-ghost shrink-0" title="上传图片到该表情">＋图</button>` +
    (isTalk ? "" : `<button data-rename class="btn btn-xs btn-ghost shrink-0" title="重命名表情键">改名</button>` +
      `<button data-delkey class="btn btn-xs btn-ghost text-error/70 shrink-0" title="删除该表情键(不删物理图片)">删键</button>`);
  const up = _ipkUploadInput(key); row.appendChild(up);
  row.querySelector("[data-addimg]").addEventListener("click", () => up.click());
  // 拖动注入(凛倾 2026-07-09):图片文件直接拖到表情行=上传入该键,复用同一条上传管线(_ipkUploadFiles)
  row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("ring-1", "ring-warning"); });
  row.addEventListener("dragleave", () => row.classList.remove("ring-1", "ring-warning"));
  row.addEventListener("drop", (e) => {
    e.preventDefault(); row.classList.remove("ring-1", "ring-warning");
    const fs = e.dataTransfer && e.dataTransfer.files;
    if (fs && fs.length) _ipkUploadFiles(key, fs);
  });
  // 点击缩略图 → 当前正用此包时右侧预览即时切到该表情(所见即所得;非当前包=只提示)
  row.querySelectorAll("[data-prev]").forEach(img => img.addEventListener("click", () => {
    if (isTalk) return;
    try {
      if (window.beiluLive2d && window.beiluLive2d.getModel && window.beiluLive2d.getModel() === _ipkName) {
        window.beiluLive2d.setEmotion(key); _ipkStatus(`预览:${key}`);
      } else { _ipkStatus("右侧预览需先把桌宠形象切到此包", true); }
    } catch (e) { /* 渲染层未就绪 */ }
  }));
  row.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    const i = Number(b.dataset.del);
    if (isTalk) _ipk.talk.splice(i, 1); else _ipk.expressions[key].splice(i, 1);
    await _ipkSave(); _ipkRender();
  }));
  if (!isTalk) {
    row.querySelector("[data-delkey]").addEventListener("click", async () => {
      delete _ipk.expressions[key];
      if (_ipk.default === key) delete _ipk.default;
      await _ipkSave(); _ipkRender();
    });
    // 键重命名:白检同新建;default 跟随;AI 指令键=改名后以新键为准(pack.json 单源)
    row.querySelector("[data-rename]").addEventListener("click", async () => {
      const nk = ((await beiluPrompt(`"${key}" 重命名为(禁空格逗号|):`, key)) || "").trim();
      if (!nk || nk === key) return;
      if (!_IPK_KEY_RE.test(nk)) { _ipkStatus("表情键只能含 字母数字下划线中文连字符", true); return; }
      if (_ipk.expressions[nk]) { _ipkStatus("目标键已存在", true); return; }
      _ipk.expressions[nk] = _ipk.expressions[key];
      delete _ipk.expressions[key];
      if (_ipk.default === key) _ipk.default = nk;
      await _ipkSave(); _ipkRender();
    });
  }
  return row;
}
function _ipkRender() {
  const list = document.getElementById("ipk-keys");
  const defSel = document.getElementById("ipk-default");
  if (!list || !_ipk) return;
  list.innerHTML = "";
  const keys = Object.keys(_ipk.expressions || {});
  for (const k of keys) {
    const v = _ipk.expressions[k];
    list.appendChild(_ipkRow(k, Array.isArray(v) ? v : (v ? [v] : []), k));
  }
  list.appendChild(_ipkRow("talk(说话差分)", Array.isArray(_ipk.talk) ? _ipk.talk : [], "\u0000talk"));
  if (defSel) {
    defSel.innerHTML = keys.map(k => `<option value="${_capEsc(k)}">${_capEsc(k)}</option>`).join("");
    if (_ipk.default && keys.includes(_ipk.default)) defSel.value = _ipk.default;
  }
  const scEl = document.getElementById("ipk-scale");
  if (scEl) scEl.value = (typeof _ipk.scale === "number" && _ipk.scale > 0) ? _ipk.scale : "";
  _ipkDynRender();
}
// 包动效参数(谱=UI元数据;默认值单源=imagePackRenderer IMG_DYN_DEFAULT 经 _imageDynDefaults 导出,只作占位)
// 谱单源=caps.ipkDynSpec(_loadPetCapabilities 填充;离线=空,编辑器本就依赖后端端点)。默认值仍单源 imagePackRenderer。
let _IPK_DYN_SPEC = [];
function _ipkDynRender() {
  const grid = document.getElementById("ipk-dyn");
  if (!grid || !_ipk) return;
  let defs = {};
  try { defs = window.beiluLive2d && window.beiluLive2d._imageDynDefaults ? window.beiluLive2d._imageDynDefaults() : {}; } catch (e) {}
  const dyn = (_ipk.dynamics && typeof _ipk.dynamics === "object") ? _ipk.dynamics : {};
  grid.innerHTML = "";
  for (const [k, label] of _IPK_DYN_SPEC) {
    const lab = document.createElement("label");
    lab.className = "form-control";
    lab.innerHTML = `<span class="label-text text-[10px] mb-0.5">${label}</span>` +
      `<input type="number" step="any" class="input input-xs input-bordered" data-ipkdyn="${k}" placeholder="${defs[k] != null ? defs[k] : "默认"}" />`;
    const inp = lab.querySelector("input");
    if (typeof dyn[k] === "number") inp.value = dyn[k];
    inp.addEventListener("change", async () => {
      if (!_ipk.dynamics || typeof _ipk.dynamics !== "object") _ipk.dynamics = {};
      const v = Number(inp.value);
      if (inp.value !== "" && Number.isFinite(v)) _ipk.dynamics[k] = v; else delete _ipk.dynamics[k];
      if (!Object.keys(_ipk.dynamics).length) delete _ipk.dynamics;
      await _ipkSave();
      try { if (window.beiluLive2d && window.beiluLive2d.getModel && window.beiluLive2d.getModel() === _ipkName && window.beiluLive2d.reloadDict) await window.beiluLive2d.reloadDict(); } catch (e) { /* 预览未就绪 */ }
    });
    grid.appendChild(lab);
  }
}
function _ipkWire() {
  document.getElementById("ipk-select")?.addEventListener("change", e => _ipkLoad(e.target.value));
  document.getElementById("ipk-create")?.addEventListener("click", async () => {
    const nm = (document.getElementById("ipk-new-name")?.value || "").trim();
    if (!nm || /[\\/]|\.\./.test(nm)) { _ipkStatus("包名不能为空/含路径符", true); return; }
    _ipkName = nm; _ipk = { default: "", expressions: {} };
    await _ipkSave(); await _ipkRefreshList(nm);
    const body = document.getElementById("ipk-body"); if (body) body.style.display = "flex";
    _ipkRender();
  });
  document.getElementById("ipk-add-key")?.addEventListener("click", async () => {
    const k = (document.getElementById("ipk-new-key")?.value || "").trim();
    if (!_IPK_KEY_RE.test(k)) { _ipkStatus("表情键只能含 字母数字下划线中文连字符(禁空格逗号|)", true); return; }
    if (!_ipk) { _ipkStatus("先选择或新建图片包", true); return; }
    if (_ipk.expressions[k]) { _ipkStatus("该表情键已存在", true); return; }
    _ipk.expressions[k] = [];
    if (!_ipk.default) _ipk.default = k;
    await _ipkSave(); _ipkRender();
    const inp = document.getElementById("ipk-new-key"); if (inp) inp.value = "";
  });
  document.getElementById("ipk-default")?.addEventListener("change", async e => { if (_ipk) { _ipk.default = e.target.value; await _ipkSave(); } });
  // 包缩放(写 pack.json.scale;imagePackRenderer 优先读包内值):保存后当前正用此包=立即重载生效
  document.getElementById("ipk-scale")?.addEventListener("change", async e => {
    if (!_ipk) return;
    const v = Number(e.target.value);
    if (v > 0) _ipk.scale = v; else delete _ipk.scale;
    await _ipkSave();
    try { if (window.beiluLive2d && window.beiluLive2d.getModel && window.beiluLive2d.getModel() === _ipkName && window.beiluLive2d.reloadDict) await window.beiluLive2d.reloadDict(); } catch (err) { /* 预览未就绪 */ }
  });
}
// ── 对话框实时演示(凛倾 2026-07-09"没有演示"):读当前控件值渲染预览气泡。
//    默认回退单源=caps.bubbleDefaults(后端出厂默认,data/pet_capabilities.json 可覆盖;
//    2026-07-09 收口二批:此前 #f5c542/#b8860b 等真值散写演示层=第三份副本)。离线字面量=出厂同值兜底。 ──
function _bubbleDefs() { return (_petCaps && _petCaps.bubbleDefaults && typeof _petCaps.bubbleDefaults === "object") ? _petCaps.bubbleDefaults : {}; }
function _bubblePreviewSync() {
  const g = id => document.getElementById(id);
  const box = g("bubble-preview"); if (!box) return;
  const D = _bubbleDefs();
  // 值链=控件值(后端回填/用户改) > caps.bubbleDefaults;两者皆缺(离线)=不设该样式(留样式表初值),零编造字面量
  //   (凛倾 2026-07-09"系统性硬编码"纠偏:此前每项都缀 ||"#f5c542" 等出厂副本=散布漂移点+假值回灌)。
  const hexToRgba = (h, a) => { const m = /^#(..)(..)(..)$/.exec(h || ""); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : h; };
  const opRaw = g("pet-bubble-opacity")?.value;
  const op = Math.max(0.1, Math.min(1, (opRaw !== "" && opRaw != null) ? Number(opRaw) / 100 : (Number(D.opacity) || 1)));
  const bgSrc = g("pet-bubble-color")?.value || D.bg || "";
  if (bgSrc) box.style.background = hexToRgba(bgSrc, op);
  const fgSrc = g("pet-bubble-text-color")?.value || D.textColor || "";
  if (fgSrc) box.style.color = fgSrc;
  const radSrc = g("pet-bubble-radius")?.value;
  const radV = (radSrc !== "" && radSrc != null) ? Number(radSrc) : Number(D.radius);
  if (Number.isFinite(radV) && radV >= 0) box.style.borderRadius = radV + "px";
  const shadowOn = g("pet-bubble-shadow") ? g("pet-bubble-shadow").checked : true;
  const borderSrc = g("pet-bubble-border-color")?.value || D.borderColor || "";
  const border = borderSrc ? hexToRgba(borderSrc, Number(D.borderAlpha) || 1) : "";
  box.style.boxShadow = (shadowOn ? "0 4px 18px rgba(180,140,40,.3)" : "") + (border ? (shadowOn ? ", " : "") + `inset 0 0 0 1px ${border}` : "");
  const fs = Number(g("pet-bubble-fontsize")?.value) || 0;
  const fsV = fs > 0 ? fs : Number(D.fontSize);
  if (Number.isFinite(fsV) && fsV > 0) box.style.fontSize = fsV + "px";
  const nm = g("bubble-preview-name");
  if (nm) {
    nm.style.display = (g("pet-bubble-name-enabled") && !g("pet-bubble-name-enabled").checked) ? "none" : "";
    const nmText = g("pet-bubble-name-text")?.value || D.nameText || "";
    if (nmText) nm.textContent = nmText;
    const nmColor = g("pet-bubble-name-color")?.value || D.nameColor || "";
    if (nmColor) nm.style.color = nmColor;
  }
  const tail = g("bubble-preview-tail");
  // 尾巴底色与气泡本体同源同透明度（收口二批改名 bgSrc 时此处漏改致 ReferenceError: bg is not defined；双缺=留样式表初值）
  if (tail) { tail.style.display = (g("pet-bubble-tail") && !g("pet-bubble-tail").checked) ? "none" : ""; if (bgSrc) tail.style.background = hexToRgba(bgSrc, op); }
}
// 所有对话框相关控件 input+change 都刷演示(一次性绑定)
function _bubblePreviewWire() {
  const ids = ["pet-bubble-opacity", "pet-bubble-dwell", "pet-bubble-radius", "pet-bubble-color", "pet-bubble-text-color",
    "pet-bubble-border-color", "pet-bubble-name-color", "pet-bubble-name-text", "pet-bubble-fontsize",
    "pet-bubble-name-enabled", "pet-bubble-tail", "pet-bubble-shadow"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", _bubblePreviewSync);
    el.addEventListener("change", _bubblePreviewSync);
  }
  document.getElementById("pet-bubble-color-reset")?.addEventListener("click", _bubblePreviewSync);
  document.getElementById("pet-bubble-text-reset")?.addEventListener("click", _bubblePreviewSync);
  _bubblePreviewSync();
}
let _petSettingsInited = false;
// 读 beilu 当前主题的浅色基底(base-100)→hex,作为"跟随系统"底色显示(凛倾:对话框浅色按系统主题)。
function _petThemeColor() {
  try {
    const probe = document.createElement("div");
    probe.className = "bg-base-100";
    probe.style.cssText = "position:absolute;left:-9999px";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const m = rgb.match(/\d+/g);
    if (m && m.length >= 3) {
      const hex = "#" + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("");
      return hex;
    }
  } catch (e) { /* 退回浅色琥珀默认 */ }
  return "#fffcf5";
}
async function _petPost(patch) {
  const status = document.getElementById("pet-settings-status");
  try {
    // 原 raw POST /api/eye/pet-settings + r.ok 手检 → 门面 setPetSettings；!ok 由门面抛错走 catch（同源默认 credentials 已带 cookie）
    await sendAction({ verb: "setPetSettings", target: "server:eye", source: "web", payload: patch });
    if (status) { status.textContent = "已保存 · 桌宠会在数秒内生效"; status.className = "text-[10px] text-success pt-1"; }
    return true;
  } catch (e) {
    if (status) { status.textContent = "保存失败(桌宠需 beilu 运行): " + e.message; status.className = "text-[10px] text-error pt-1"; }
    return false;
  }
}
async function _petPopulateModels(selected) {
  const sel = document.getElementById("pet-model");
  if (!sel) return;
  const names = [];
  try { // 内置 model_dict
    // R1-SKIP: vendor/live2d-models/model_dict.json 静态 vendor 资源，非 /api/*。
    const r = await fetch("vendor/live2d-models/model_dict.json");
    if (r.ok) { const arr = await r.json(); if (Array.isArray(arr)) arr.forEach(m => m && m.name && names.push(m.name)); }
  } catch (e) { /* 静默 */ }
  try { // 用户导入/配置的字典
    // 原 raw GET /api/eye/usermodel-dict + r.ok 手检 → 门面 getUserModelDict；!ok 由门面抛错走 catch（静默）
    const arr = await sendAction({ verb: "getUserModelDict", target: "server:eye", source: "web" });
    if (Array.isArray(arr)) arr.forEach(m => m && m.name && !names.includes(m.name) && names.push(m.name));
  } catch (e) { /* 静默 */ }
  try { // user-models 目录扫描(0722 读侧对齐:renderer _mergeUserModels 有 __BEILU_USER_MODELS 扫描路,
    // web 下拉此前只读 dict——手动丢文件夹/文件选择式导入的模型托盘可见而 web 不可见=读侧少一路源)
    const arr = await sendAction({ verb: "scanUserModels", target: "server:eye", source: "web" });
    if (Array.isArray(arr)) arr.forEach(m => m && m.name && !names.includes(m.name) && names.push(m.name));
  } catch (e) { /* 静默 */ }
  try { // 图片包(图片模式,任务②:与模型同一下拉,选中即切,renderer 按 format 路由)。T6b 门面精确 verb(防 server:eye#* 通配吞)。
    const arr = await sendAction({ verb: "getImagepacks", target: "server:eye", source: "web" });
    if (Array.isArray(arr)) arr.forEach(m => m && m.name && !names.includes(m.name) && names.push(m.name));
  } catch (e) { /* 静默 */ }
  // 保留首个"默认"option,补模型名
  sel.querySelectorAll("option:not([value=''])").forEach(o => o.remove());
  for (const n of names) { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); }
  sel.value = selected || "";
  // D-2 按角色卡绑定模型的下拉:同一份模型名,选项=模型;value 空=不绑定。回填见 initCompanionPetSettings。
  const selC = document.getElementById("pet-charmodel");
  if (selC) {
    selC.querySelectorAll("option:not([value=''])").forEach(o => o.remove());
    for (const n of names) { const o = document.createElement("option"); o.value = n; o.textContent = n; selC.appendChild(o); }
  }
}
// (触碰热区编辑器已拆独立模块 hitEditor.mjs,2026-07-09 编辑器2.0:放大画布/形状工具/分图作用域/反馈步骤/导出导入)
// 当前形象+表情宏卡片(凛倾 2026-07-09:启动处显示基于图片还是live2d;宏显眼可复制可看当前值)。
// 值单源=后端 /api/eye/pet-macros(与 preset_engine 宏注入同一取值函数);模式判定复用 _ipkNames。
async function _refreshMacroCard(modelName) {
  const av = document.getElementById("comp-cur-avatar");
  if (av) {
    const n = modelName || "";
    av.textContent = n ? `${n}（${_ipkNames.has(n) ? "图片包" : "Live2D"}）` : "(默认小生物)";
  }
  const host = document.getElementById("comp-macro-rows");
  if (!host) return;
  let m = null;
  try { m = await sendAction({ verb: "getPetMacros", target: "server:eye", source: "web" }); } catch (e) { host.innerHTML = '<span class="opacity-40">宏当前值需 beilu 运行时读取(离线)</span>'; return; }
  const rows = [
    ["{{petExpressions}}", m.petExpressions || "(当前形象无表情声明)"],
    ["{{petEmotionTag}}", m.petEmotionTag || "emotion"],
    ["{{petMotionTag}}", m.petMotionTag || "motion"],
  ];
  host.innerHTML = "";
  for (const [name, val] of rows) {
    const row = document.createElement("div");
    row.className = "flex items-start gap-2";
    const code = document.createElement("code");
    code.className = "bg-base-100/70 rounded px-1 cursor-pointer shrink-0 hover:text-warning";
    code.textContent = name; code.title = "点击复制宏名";
    code.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(name); window._beiluToast?.("已复制 " + name, "success"); }
      catch (e) { window._beiluToast?.("复制失败: " + e.message, "error"); }
    });
    const v = document.createElement("span");
    v.className = "opacity-60 truncate"; v.textContent = "= " + val; v.title = val;
    row.appendChild(code); row.appendChild(v);
    host.appendChild(row);
  }
}
// 当前角色名(D-2 绑定用):sharedState 暴露的 _beiluGetCharName()(角色卡选择时 set)。
function _petCurrentChar() {
  try { return (typeof window._beiluGetCharName === "function" ? (window._beiluGetCharName() || "") : ""); } catch (e) { return ""; }
}
// T1 语音输入设置(凛倾 0722"没有设置啊"):录音设备/降噪。设备双写=localStorage
// beilu-stt-record-device(本体/陪伴台录音读)+petSettings.sttDevice(桌宠🎤经 pet-settings 同步);
// 降噪双写=beilu-stt-server-denoise+petSettings.sttDenoise。选项来自 STT 插件 record 代理(自动拉起)。
function _initVoiceSettings(cur) {
  const $ = (id) => document.getElementById(id);
  const sel = $("pet-stt-device"), status = $("pet-stt-status");
  if (!sel) return;
  const _port = () => encodeURIComponent(localStorage.getItem("beilu-stt-port") || "7861");
  const _fill = (devices, keep) => {
    sel.innerHTML = "";
    const def = document.createElement("option"); def.value = ""; def.textContent = "系统默认输入"; sel.appendChild(def);
    for (const d of devices) {
      const o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = `[${d.id}] ${d.name}` + (d.default ? " (默认)" : "") + (d.rms != null ? ` · rms=${d.rms}` : "");
      sel.appendChild(o);
    }
    sel.value = keep ?? (localStorage.getItem("beilu-stt-record-device") || "");
    if (sel.selectedIndex < 0) sel.value = "";
  };
  _fill([]);
  // 0722 散写收口:双写(localStorage+petSettings)移交 sttSettings.mjs 唯一 owner——
  // 此前本面板双写、扩展面板只写 localStorage=写语义不等价,扩展面板改设备桌宠🎤吃旧值。
  const _save = () => {
    setSttRecordDevice(sel.value).catch(e => { if (status) status.textContent = "桌宠侧保存失败(需 beilu 运行): " + e.message; });
  };
  sel.addEventListener("change", _save);
  $("pet-stt-dev-refresh")?.addEventListener("click", async () => {
    if (status) status.textContent = "获取设备中(服务未启动会自动拉起,首次约10~20s)…";
    try {
      const r = await fetch(`/api/parts/plugins:beilu-stt/record/devices?port=${_port()}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      _fill(j.devices || []);
      if (status) status.textContent = `已列出 ${j.devices?.length ?? 0} 个输入设备`;
    } catch (e) { if (status) status.textContent = "获取设备失败: " + e.message; }
  });
  $("pet-stt-probe")?.addEventListener("click", async () => {
    if (status) status.textContent = "逐设备探测电平中(每台约1.2s;建议边说话边等)…";
    try {
      const r = await fetch(`/api/parts/plugins:beilu-stt/record/probe?port=${_port()}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const results = (j.results || []).map((x) => ({ id: x.device, name: x.name, rms: x.rms }));
      _fill(results, results.length ? String(results[0].id) : "");
      if (results.length) { _save(); if (status) status.textContent = `已选电平最高: [${results[0].id}] ${results[0].name}`; }
      else if (status) status.textContent = "没有探测到有信号的输入设备";
    } catch (e) { if (status) status.textContent = "探测失败: " + e.message; }
  });
  const dn = $("pet-stt-denoise");
  if (dn) {
    dn.checked = localStorage.getItem("beilu-stt-server-denoise") !== "false";
    dn.addEventListener("change", () => {
      // 同上收口:双写归 sttSettings.mjs 单 owner
      setSttServerDenoise(dn.checked).catch(e => { if (status) status.textContent = "桌宠侧保存失败(需 beilu 运行): " + e.message; });
    });
  }
  // 回填桌宠侧已存值(petSettings 优先=桌宠实际生效值)
  if (cur && cur.sttDevice != null) sel.value = String(cur.sttDevice);
  if (cur && typeof cur.sttDenoise === "boolean" && dn) dn.checked = cur.sttDenoise;

  // 常开语音所有字段写 pet_settings 单源，由 Electron 桌宠唯一持有麦克风 lifecycle；
  // Web 只配置，不另起浏览器录音循环与桌宠争抢 STT 单槽。
  const always = $("pet-stt-always"), quick = $("pet-stt-quick-hotkey"), quickCapture = $("pet-stt-quick-capture"), quickClear = $("pet-stt-quick-clear"), quickHint = $("pet-stt-quick-hint"), wake = $("pet-stt-wakewords"), cap = $("pet-stt-capture-question");
  const silence = $("pet-stt-silence-ms"), peak = $("pet-stt-peak");
  if (always) {
    always.checked = cur?.voiceAlwaysOn === true;
    always.addEventListener("change", () => {
      _petPost({ voiceAlwaysOn: always.checked });
      if (status) status.textContent = always.checked ? "常开模式已请求；首条语音会按已保存的陪伴角色绑定自动建立会话" : "常开模式已关闭";
    });
  }
  if (quick) {
    let stored = typeof cur?.voiceQuickHotkey === "string" ? cur.voiceQuickHotkey : "";
    let capturing = false;
    quick.value = stored;
    quick.readOnly = true;
    const setHint = (text, tone = "") => {
      if (!quickHint) return;
      quickHint.textContent = text;
      quickHint.className = "text-[10px] " + (tone === "error" ? "text-error" : tone === "ok" ? "text-success" : "opacity-60");
    };
    const beginCapture = () => {
      capturing = true;
      quick.value = "请直接按下新的组合键…";
      quick.classList.add("input-warning");
      if (quickCapture) quickCapture.textContent = "录入中";
      setHint("按下组合键；Esc 取消。普通字母/数字必须搭配修饰键。", "");
      quick.focus();
    };
    quick.addEventListener("click", beginCapture);
    quickCapture?.addEventListener("click", beginCapture);
    quick.addEventListener("keydown", async (event) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopPropagation();
      const result = acceleratorFromKeyboardEvent(event);
      if (result.pending) { setHint("继续按一个非修饰键…"); return; }
      if (result.cancelled) {
        capturing = false;
        quick.value = stored;
        quick.classList.remove("input-warning");
        if (quickCapture) quickCapture.textContent = "录入";
        setHint("已取消，原快捷键未改变。");
        return;
      }
      if (result.error) { setHint(result.error, "error"); return; }
      capturing = false;
      quick.value = result.accelerator;
      quick.classList.remove("input-warning");
      if (quickCapture) quickCapture.textContent = "录入";
      const ok = await _petPost({ voiceQuickHotkey: result.accelerator });
      if (ok) {
        stored = result.accelerator;
        setHint(`已保存 ${stored}；桌宠会尝试注册，若被占用会明确提示且保留旧快捷键。`, "ok");
      } else quick.value = stored;
    });
    quickClear?.addEventListener("click", async () => {
      capturing = false;
      const ok = await _petPost({ voiceQuickHotkey: "" });
      if (!ok) return;
      stored = "";
      quick.value = "";
      quick.classList.remove("input-warning");
      if (quickCapture) quickCapture.textContent = "录入";
      setHint("全局快捷键已关闭；桌宠对话台的麦克风按钮仍可使用。", "ok");
    });
  }
  if (wake) {
    wake.value = typeof cur?.voiceWakeWords === "string" ? cur.voiceWakeWords : "";
    wake.addEventListener("change", () => _petPost({ voiceWakeWords: wake.value.trim() }));
  }
  if (cap) {
    cap.checked = cur?.voiceCaptureWithQuestion === true;
    cap.addEventListener("change", () => _petPost({ voiceCaptureWithQuestion: cap.checked }));
  }
  if (silence) {
    if (cur?.voiceSilenceMs != null) silence.value = Number(cur.voiceSilenceMs);
    silence.addEventListener("change", () => {
      const value = Number(silence.value);
      if (!Number.isFinite(value)) { silence.value = cur?.voiceSilenceMs ?? ""; if (status) status.textContent = "静音收口必须是数字"; return; }
      _petPost({ voiceSilenceMs: Math.max(200, Math.min(5000, value)) });
    });
  }
  if (peak) {
    if (cur?.voiceActivationPeak != null) peak.value = Number(cur.voiceActivationPeak);
    peak.addEventListener("change", () => {
      const value = Number(peak.value);
      if (!Number.isFinite(value)) { peak.value = cur?.voiceActivationPeak ?? ""; if (status) status.textContent = "语音电平门限必须是数字"; return; }
      _petPost({ voiceActivationPeak: Math.max(0.001, Math.min(1, value)) });
    });
  }
}

async function initCompanionPetSettings() {
  if (_petSettingsInited) return; // 仅首次进面板时加载+绑定(避免重复监听)
  _petSettingsInited = true;
  await _loadPetCapabilities(); // 任务⑥:选项集/预设先于回填就位(失败=兜底,不阻塞)
  _ipkWire(); await _ipkRefreshList(); // 图片包编辑器接线+列表(await:模式判定要用 _ipkNames)
  initHitEditor({ getCaps: () => _petCaps, getIpkNames: () => _ipkNames }); // 触碰编辑器模块接线(hitEditor.mjs)
  let cur = {};
  // 原 raw GET /api/eye/pet-settings + r.ok 手检 → 门面 getPetSettings；!ok 由门面抛错走 catch（留默认值）
  try { cur = await sendAction({ verb: "getPetSettings", target: "server:eye", source: "web" }); } catch (e) { /* 桌宠/后端未起:留默认值 */ }
  _initVoiceSettings(cur); // T1 语音输入设置(凛倾 0722)
  const $ = id => document.getElementById(id);
  // 回填当前值
  if ($("pet-enabled")) $("pet-enabled").checked = !!cur.petEnabled;
  // fallbackCreature/pet-creature 已移除(凛倾 2026-07-14:删除史莱姆和青蛙)
  await _petPopulateModels(cur.modelName);
  // D-2 按角色卡绑定模型:显示当前角色名 + 回填该角色已绑定的模型(charModels[当前角色])。
  const _curChar = _petCurrentChar();
  const _charModels = (cur.charModels && typeof cur.charModels === "object") ? cur.charModels : {};
  if ($("pet-charmodel-name")) $("pet-charmodel-name").textContent = _curChar ? ("· " + _curChar) : "(未选角色)";
  if ($("pet-charmodel")) { $("pet-charmodel").value = (_curChar && _charModels[_curChar]) || ""; $("pet-charmodel").disabled = !_curChar; }
  // 假值清剿(凛倾 2026-07-09"系统性硬编码":离线时拿兜底值渲染=假数字回灌)——值缺失=不填,诚实降级。
  // 在线时 cur=后端 merge 恒有值,以下条件只在离线为假 → 控件留 HTML 初值/占位,不显示编造数。
  if (cur.bubbleOpacity != null && $("pet-bubble-opacity")) { const op = Math.round(Number(cur.bubbleOpacity) * 100); $("pet-bubble-opacity").value = op; $("pet-opacity-val").textContent = op + "%"; }
  if (cur.bubbleDwellMs != null && $("pet-bubble-dwell")) $("pet-bubble-dwell").value = Math.round(Number(cur.bubbleDwellMs) / 1000);
  // 底色:空=跟随系统浅色(读 beilu 当前主题 base-100 色显示;桌宠用其内建浅色默认),非空=自定义。
  const sysColor = _petThemeColor();
  const setColorMode = (custom) => { const m = $("pet-color-mode"); if (m) m.textContent = custom ? "(自定义)" : "(跟随系统)"; };
  if ($("pet-bubble-color")) { $("pet-bubble-color").value = cur.bubbleColor || sysColor; setColorMode(!!cur.bubbleColor); }
  if ($("pet-bubble-text-color") && cur.bubbleTextColor) $("pet-bubble-text-color").value = cur.bubbleTextColor;
  // 圆角:-1 哨兵=渲染端默认(值=caps.bubbleDefaults.radius);caps 也缺(离线)→不填假数,标签注明"默认"。
  if ($("pet-bubble-radius")) {
    const _radDef = Number(_bubbleDefs().radius);
    if (typeof cur.bubbleRadius === "number" && cur.bubbleRadius >= 0) { $("pet-bubble-radius").value = cur.bubbleRadius; $("pet-radius-val").textContent = cur.bubbleRadius + "px"; }
    else if (Number.isFinite(_radDef) && _radDef > 0) { $("pet-bubble-radius").value = _radDef; $("pet-radius-val").textContent = _radDef + "px(默认)"; }
    else { $("pet-radius-val").textContent = "默认"; }
  }
  if ($("pet-passthrough")) $("pet-passthrough").checked = !!cur.passthrough;
  // 通知与陪伴正文分别限长：短通知偏好不能截断流式回答。
  if ($("pet-banner-enabled")) $("pet-banner-enabled").checked = cur.bannerEnabled !== false;
  if ($("pet-banner-maxchars")) $("pet-banner-maxchars").value = Number(cur.bannerMaxChars) || 0;
  if ($("pet-companion-maxchars")) $("pet-companion-maxchars").value = Number(cur.companionMaxChars) || 0;
  if ($("pet-notify-sound")) $("pet-notify-sound").checked = cur.notifySound === true;
  if ($("pet-corner")) $("pet-corner").value = PET_CORNERS.includes(cur.petCorner) ? cur.petCorner : PET_CORNER_DEFAULT;
  if ($("pet-idle-expression")) $("pet-idle-expression").value = cur.idleExpression || ""; // B2-3 待机表情(orphan 真字段)
  // 指令标签名回填:后端值原样显示(默认值单源=后端 merge,前端零默认副本;空值 placeholder 提示默认)
  if ($("pet-emotion-tag")) $("pet-emotion-tag").value = cur.emotionTag || "";
  if ($("pet-motion-tag")) $("pet-motion-tag").value = cur.motionTag || "";
  if ($("pet-orb-tag")) $("pet-orb-tag").value = cur.orbMessageTag || ""; // 07-09 收口审计:orbMessage 标签补配置口(同组三标签唯它缺)
  // 对话框全项回填(任务④)
  if ($("pet-bubble-border-color") && cur.bubbleBorderColor) $("pet-bubble-border-color").value = cur.bubbleBorderColor;
  if ($("pet-bubble-name-color") && cur.bubbleNameColor) $("pet-bubble-name-color").value = cur.bubbleNameColor;
  if ($("pet-bubble-name-text")) $("pet-bubble-name-text").value = cur.bubbleNameText || "";
  if ($("pet-bubble-fontsize")) $("pet-bubble-fontsize").value = Number(cur.bubbleFontSize) || 0;
  if ($("pet-bubble-name-enabled")) $("pet-bubble-name-enabled").checked = cur.bubbleNameEnabled !== false;
  if ($("pet-bubble-tail")) $("pet-bubble-tail").checked = cur.bubbleTail !== false;
  if ($("pet-bubble-shadow")) $("pet-bubble-shadow").checked = cur.bubbleShadow !== false;
  // 桌宠窗尺寸回填(任务⑧;0=默认不显示假数)
  if ($("pet-height")) $("pet-height").value = Number(cur.petHeight) || "";
  if ($("pet-bubblewin-h")) $("pet-bubblewin-h").value = Number(cur.petBubbleWinH) || "";
  // 行为节奏回填(凛倾 2026-07-13 去硬编码;在线时 cur=后端 merge 恒有值,离线=留 placeholder 不编造)
  if (cur.orphanExitSec != null && $("pet-orphan-exit")) $("pet-orphan-exit").value = Number(cur.orphanExitSec);
  if (cur.selfHealBackoffSec != null && $("pet-selfheal-backoff")) $("pet-selfheal-backoff").value = Number(cur.selfHealBackoffSec);
  if (cur.hitPollMs != null && $("pet-hitpoll-ms")) $("pet-hitpoll-ms").value = Number(cur.hitPollMs);
  if (cur.alphaHitThreshold != null && $("pet-alpha-threshold")) $("pet-alpha-threshold").value = Number(cur.alphaHitThreshold);
  if ($("pet-capture-hotkey")) $("pet-capture-hotkey").value = cur.captureHotkey || "";
  if (cur.orbPollSec != null && $("pet-orb-poll")) $("pet-orb-poll").value = Number(cur.orbPollSec);
  // 动态/物理 细分滑块 + motion 开关:从 cur.dynamics 回填(深拷贝作完整状态,改动 POST 全量)
  _compDyn = (cur.dynamics && typeof cur.dynamics === "object") ? JSON.parse(JSON.stringify(cur.dynamics)) : {};
  refreshCompanionRendererSettings();
  // 绑定改动 → POST 单字段
  // ── 形象模式(凛倾 2026-07-09:模式选择):模式=当前 modelName 的 format 判定(图片包名集合命中=image),
  //    radio 点选→跳对应段做具体选择(不直接写值;modelName 是唯一权威,选了具体形象模式自然跟着变)。 ──
  {
    const _isPack = _ipkNames.has(cur.modelName);
    const _mr = document.querySelector(`input[name="pet-mode"][value="${_isPack ? "image" : "live2d"}"]`);
    if (_mr) _mr.checked = true;
    const _mc = $("pet-mode-cur"); if (_mc) _mc.textContent = "当前:" + (cur.modelName || "(默认)");
    _refreshMacroCard(cur.modelName); // 启动绑定段:当前形象+宏卡片(异步填充,不阻塞)
    hitEditorLoad(cur.modelName); // 触碰反馈:加载当前形象热区(异步)
    document.querySelectorAll('input[name="pet-mode"]').forEach(r => r.addEventListener("change", () => {
      if (r.checked) document.querySelector(`[data-scroll-to="${r.value === "image" ? "comp-seg-imgpack" : "comp-seg-live2d"}"]`)?.click();
    }));
    const _ia = $("ipk-active");
    if (_ia && _isPack) _ia.value = cur.modelName;
    _ia?.addEventListener("change", async e => {
      const v = e.target.value;
      if (!v) return;
      _petPost({ modelName: v });
      const mc = $("pet-mode-cur"); if (mc) mc.textContent = "当前:" + v;
      try { await _previewSelectedModel(v); } catch (err) { _reportPreviewSelectionError(err); }
      _refreshMacroCard(v); // 宏值随形象变(petExpressions=新形象表情集)
      hitEditorLoad(v); // 热区随形象变
    });
  }
  $("pet-enabled")?.addEventListener("change", e => {
    // [D5 结构版 2026-08-04] petEnabled=唯一持久开关(「用户显式想常驻桌宠」)。互动的临时要求已迁到
    //   后端运行时 lease(interaction_lease.mjs),前端不再写任何归属标记;显式关闭时后端 owner 自动
    //   吊销全部互动租约(接管),UI 零分支。
    _petPost({ petEnabled: e.target.checked });
  });
  $("pet-model")?.addEventListener("change", async e => {
    _petPost({ modelName: e.target.value });
    const mc = $("pet-mode-cur"); if (mc) mc.textContent = "当前:" + (e.target.value || "(默认)");
    // web 预览即时切(桌面端经后端轮询同步;此前只 POST 不驱动=改了看不到,假反馈)
    try { if (e.target.value) await _previewSelectedModel(e.target.value); } catch (err) { _reportPreviewSelectionError(err); }
    _refreshMacroCard(e.target.value); // 宏值随形象变
    hitEditorLoad(e.target.value); // 热区随形象变
  });
  // D-2 角色卡绑定模型:写 charModels[当前角色]=模型名(空=解绑);merge 既有映射,只动当前角色这一项(管道:存数据不解释)。
  $("pet-charmodel")?.addEventListener("change", async e => {
    const ch = _petCurrentChar();
    if (!ch) return; // 未选角色:无可绑定对象
    let map = {};
    // T021 弹出+防销毁：原"取不到既有映射从空开始"会带着空 map 继续 POST=把其他角色的绑定整表抹掉
    // （merge 源丢失还写回=数据覆盖家族）。失败即中止本次绑定并弹出，不带病提交。
    try { const s = await sendAction({ verb: "getPetSettings", target: "server:eye", source: "web" }); if (s && s.charModels && typeof s.charModels === "object") map = s.charModels; } catch (err) {
      window._beiluToast?.("绑定失败：读取既有模型映射失败（" + (err?.message || err) + "），已中止以免覆盖其他角色绑定", "error");
      e.target.value = ""; // 回滚控件显示
      return;
    }
    if (e.target.value) map[ch] = e.target.value; else delete map[ch];
    _petPost({ charModels: map });
    // web 端即时生效:若改的是当前角色,直接驱动渲染层换模型(桌面端经 beilu 同步 onPetConfig)。
    try { if (window.beiluLive2d && window.beiluLive2d.setCharModels) { window.beiluLive2d.setCharModels(map); window.beiluLive2d.setCharacter(ch); } } catch (err) { /* 渲染层未就绪:忽略 */ }
  });
  // pet-creature listener 已移除(凛倾 2026-07-14)
  $("pet-bubble-opacity")?.addEventListener("input", e => { $("pet-opacity-val").textContent = e.target.value + "%"; });
  $("pet-bubble-opacity")?.addEventListener("change", e => _petPost({ bubbleOpacity: Number(e.target.value) / 100 }));
  $("pet-bubble-dwell")?.addEventListener("change", e => _petPost({ bubbleDwellMs: Math.max(0, Number(e.target.value)) * 1000 }));
  $("pet-bubble-color")?.addEventListener("change", e => { setColorMode(true); _petPost({ bubbleColor: e.target.value }); });
  $("pet-bubble-color-reset")?.addEventListener("click", () => { if ($("pet-bubble-color")) $("pet-bubble-color").value = _petThemeColor(); setColorMode(false); _petPost({ bubbleColor: "" }); });
  $("pet-bubble-text-color")?.addEventListener("change", e => _petPost({ bubbleTextColor: e.target.value }));
  $("pet-bubble-text-reset")?.addEventListener("click", () => _petPost({ bubbleTextColor: "" }));
  $("pet-bubble-radius")?.addEventListener("input", e => { $("pet-radius-val").textContent = e.target.value + "px"; });
  $("pet-bubble-radius")?.addEventListener("change", e => _petPost({ bubbleRadius: Number(e.target.value) }));
  // 动态预设:整体载入预设到 _compDyn → 刷新细分滑块/开关 UI → POST 全量 + 驱动 web 预览。
  $("pet-dynamics")?.addEventListener("change", e => { _compDyn = JSON.parse(JSON.stringify(_PET_DYN_PRESETS[e.target.value] || {})); _compDynRefreshUI(); _compDynApply(); });
  // 细分滑块:全量谱驱动生成(_buildDynControls,含 input 标签/change 落值),此处无需逐个手接。
  //   模型值即 UI 值(step 支持小数),不再做 ×100 换算——谱与 DYN_DEFAULT 同量纲,消除换算层分叉。
  // 角色动作开关:dynamics.motion.{idleLoop,tap} → 渲染层 startIdleLoop/playTap 闸门。
  $("comp-motion-idle")?.addEventListener("change", e => { _compDynSet("motion", "idleLoop", e.target.checked); _compDynApply(); });
  $("comp-motion-tap")?.addEventListener("change", e => { _compDynSet("motion", "tap", e.target.checked); _compDynApply(); });
  $("pet-passthrough")?.addEventListener("change", e => _petPost({ passthrough: e.target.checked }));
  $("pet-banner-enabled")?.addEventListener("change", e => _petPost({ bannerEnabled: e.target.checked }));
  $("pet-banner-maxchars")?.addEventListener("change", e => _petPost({ bannerMaxChars: Math.max(0, Number(e.target.value) || 0) }));
  $("pet-companion-maxchars")?.addEventListener("change", e => _petPost({ companionMaxChars: Math.max(0, Number(e.target.value) || 0) }));
  $("pet-notify-sound")?.addEventListener("change", e => _petPost({ notifySound: e.target.checked }));
  // 行为节奏写回(凛倾 2026-07-13 去硬编码;值域与消费端 clamp 同源:orphan/backoff 0=关/每次,hitPoll 30~1000,alpha 0~255)
  $("pet-orphan-exit")?.addEventListener("change", e => _petPost({ orphanExitSec: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) }));
  $("pet-selfheal-backoff")?.addEventListener("change", e => _petPost({ selfHealBackoffSec: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) }));
  $("pet-hitpoll-ms")?.addEventListener("change", e => _petPost({ hitPollMs: Math.max(30, Math.min(1000, Number(e.target.value) || 90)) }));
  $("pet-alpha-threshold")?.addEventListener("change", e => _petPost({ alphaHitThreshold: Math.max(0, Math.min(255, Number(e.target.value) || 0)) }));
  $("pet-capture-hotkey")?.addEventListener("change", e => _petPost({ captureHotkey: e.target.value.trim() })); // 空=桌宠回退默认;非法值桌宠注册失败弹横幅(诚实反馈)
  $("pet-orb-poll")?.addEventListener("change", e => _petPost({ orbPollSec: Math.max(1, Math.min(30, Number(e.target.value) || 3)) }));
  $("pet-corner")?.addEventListener("change", e => _petPost({ petCorner: PET_CORNERS.includes(e.target.value) ? e.target.value : PET_CORNER_DEFAULT }));
  $("pet-idle-expression")?.addEventListener("change", e => _petPost({ idleExpression: e.target.value.trim() })); // B2-3 待机表情
  // 指令标签名写回:白检(词字符/中文/连字符,与后端 _safeTag 同一字符集)。空=存 ""——默认值不在前端复制(散写纠偏),
  //   消费端(extractEmotion/_extractEmotion)白检见空/非法自回退各自默认,单源=injection_state PET_SETTINGS_DEFAULT。
  const _wireTagInput = (id, field) => {
    $(id)?.addEventListener("change", e => {
      const v = e.target.value.trim();
      if (v && !/^[\w\u4e00-\u9fff-]+$/.test(v)) { window._beiluToast?.("标签名只能含 字母数字下划线中文连字符", "error"); e.target.value = ""; return; }
      _petPost({ [field]: v });
    });
  };
  _wireTagInput("pet-emotion-tag", "emotionTag");
  _wireTagInput("pet-motion-tag", "motionTag");
  _wireTagInput("pet-orb-tag", "orbMessageTag"); // 07-09:同款白检写回,消费端 extractOrbMessage _safeTag 回退默认
  // 对话框全项写回(任务④):字段名与 pet_settings 一一对应,空/复位=存空回默认(单源在后端)
  $("pet-bubble-border-color")?.addEventListener("change", e => _petPost({ bubbleBorderColor: e.target.value }));
  $("pet-bubble-border-reset")?.addEventListener("click", () => { const el = $("pet-bubble-border-color"), dv = _bubbleDefs().borderColor; if (el && dv) el.value = dv; _petPost({ bubbleBorderColor: "" }); _bubblePreviewSync(); }); // 默认值只来自 caps;caps 缺=只发空重置,控件色不编造
  $("pet-bubble-name-color")?.addEventListener("change", e => _petPost({ bubbleNameColor: e.target.value }));
  $("pet-bubble-name-reset")?.addEventListener("click", () => { const el = $("pet-bubble-name-color"), dv = _bubbleDefs().nameColor; if (el && dv) el.value = dv; _petPost({ bubbleNameColor: "" }); _bubblePreviewSync(); }); // 同上:零编造
  $("pet-bubble-name-text")?.addEventListener("change", e => _petPost({ bubbleNameText: e.target.value.trim() }));
  $("pet-bubble-fontsize")?.addEventListener("change", e => _petPost({ bubbleFontSize: Math.max(0, Math.min(32, Number(e.target.value) || 0)) }));
  $("pet-bubble-name-enabled")?.addEventListener("change", e => _petPost({ bubbleNameEnabled: e.target.checked }));
  $("pet-bubble-tail")?.addEventListener("change", e => _petPost({ bubbleTail: e.target.checked }));
  $("pet-bubble-shadow")?.addEventListener("change", e => _petPost({ bubbleShadow: e.target.checked }));
  _bubblePreviewWire(); // 实时演示:回填后初始化+全控件联动
  // 桌宠窗尺寸写回(任务⑧):0/空=回内建默认
  $("pet-height")?.addEventListener("change", e => _petPost({ petHeight: Math.max(0, Number(e.target.value) || 0) }));
  $("pet-bubblewin-h")?.addEventListener("change", e => _petPost({ petBubbleWinH: Math.max(0, Number(e.target.value) || 0) }));
  // ── Live2D 每模型微调(凛倾:"后端做了那么多不在前端调节"——scale/xShiftRatio/yShiftRatio 是 dict 既有字段,
  //    此前只有调试工具能写):读 usermodel 覆盖字典回填,保存=字段级 merge 写回,reloadDict 即时生效。 ──
  const _modelTweakFill = async (name) => {
    const s = $("pet-model-scale"), x = $("pet-model-xshift"), y = $("pet-model-yshift"), im = $("pet-model-idlemotion");
    if (!s && !x && !y && !im) return;
    let entry = null;
    if (name) {
      try { const arr = await sendAction({ verb: "getUserModelDict", target: "server:eye", source: "web" }); if (Array.isArray(arr)) entry = arr.find(m => m && m.name === name) || null; } catch (e) { /* 离线:留空 */ }
    }
    if (s) s.value = (entry && typeof entry.scale === "number") ? entry.scale : "";
    if (x) x.value = (entry && typeof entry.xShiftRatio === "number") ? Math.round(entry.xShiftRatio * 100) : "";
    if (y) y.value = (entry && typeof entry.yShiftRatio === "number") ? Math.round(entry.yShiftRatio * 100) : "";
    if (im) im.value = (entry && typeof entry.idleMotionGroup === "string") ? entry.idleMotionGroup : ""; // airi 对标:idle 动作组(per-model,渲染层 _idleGroup 既有消费)
    // 动作组候选=模型真实 motion 组(usermodel-scan 深扫)
    const dl = $("pet-model-idlemotion-list");
    if (dl && name) {
      try {
        const arr2 = await sendAction({ verb: "scanUserModels", target: "server:eye", source: "web" });
        const ent2 = Array.isArray(arr2) ? arr2.find(m => m && m.name === name) : null;
        // motions 形状=对象 {组名:[{file}]}(scanModelInfo 真实输出,亲核 endpoints;非数组——数组遍历=候选恒空的半接线)
        const groups = (ent2 && ent2.motions && typeof ent2.motions === "object") ? Object.keys(ent2.motions) : [];
        dl.innerHTML = groups.map(gn => `<option value="${_capEsc(String(gn))}"></option>`).join("");
      } catch (e) { /* 离线:候选空 */ }
    }
  };
  // 图片包不再排除(凛倾 2026-07-13"专门显示那一部分":imagePackRenderer 已消费同三字段 scale/xShift/yShift,
  // saveUserModel 用户字典按 name 覆盖 dict 条目=图片包同链生效;idleMotionGroup 对图片包无意义但存了也无消费=无害)
  _modelTweakFill(cur.modelName || "");
  $("pet-model")?.addEventListener("change", e => _modelTweakFill(e.target.value));
  $("ipk-active")?.addEventListener("change", e => { if (e.target.value) _modelTweakFill(e.target.value); });
  // ── Live2D 文件选择式导入(凛倾 2026-07-22"导入功能做成选择的那种,也就是选择文件"):
  //    选含 .model3.json 的 Cubism 导出目录 → 逐文件 uploadUserModelFile 落 user-models/<名>/ →
  //    既有 scanUserModels 深扫链自动发现+校验(零新发现机制),下拉即时刷新。
  //    .cmo3/.can3=Editor 工程,运行时引擎不可加载——不硬吞,给导出指引(诚实降级)。 ──
  {
    const _l2dStatus = (t) => { const el = $("l2d-import-status"); if (el) el.textContent = t; };
    // cmo3/can3 引导文案（两个入口共用）：从用户心理出发——他们觉得自己"已经导出了"，引导到正确操作
    const _cmo3Hint = (name) => `${name} 是 Cubism Editor 的工程文件(保存产物),不是运行时文件。请在 Editor 中选择「文件 → 导出运行时文件(.moc3)」,然后导入导出的文件夹或 zip`;

    // ── 共用上传核心：拿到 {name, relPath, File} 列表 → 逐文件 base64 上传 → 深扫 → 刷新 ──
    async function _l2dUploadFiles(modelName, fileEntries) {
      const ALLOW_RE = /\.(moc3|json|png|jpe?g|webp|wav|mp3)$/i;
      const ups = fileEntries.filter(e => ALLOW_RE.test(e.name));
      const skipped = fileEntries.length - ups.length;
      const _max = Number(_petCaps && _petCaps.live2dUploadMaxBytes) || 0;
      let done = 0;
      for (const e of ups) {
        if (_max && e.size > _max) throw new Error(`${e.name} 超过 ${Math.round(_max / 1024 / 1024)}MB 上限`);
        _l2dStatus(`上传中 ${++done}/${ups.length}: ${e.name}`);
        const b64 = await new Promise((res2, rej) => { const fr = new FileReader(); fr.onload = () => res2(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(e.file); });
        await sendAction({ verb: "uploadUserModelFile", target: "server:eye", source: "web", payload: { model: modelName, relPath: e.relPath, dataBase64: b64 } });
      }
      // 深扫校验
      let sum = "";
      try {
        const arr = await sendAction({ verb: "scanUserModels", target: "server:eye", source: "web" });
        const ent = Array.isArray(arr) ? arr.find(m => m && m.name === modelName) : null;
        if (ent && ent.error) sum = ` · 深扫报错: ${ent.error}`;
        else if (ent) sum = ` · moc ${ent.mocValid ? "✓" : "✗"} 纹理 ${ent.texturesValid ? "✓" : "✗"} · 参数 ${(ent.parameterIds || []).length} 表情 ${(ent.expressions || []).length} 动作组 ${Object.keys(ent.motions || {}).length}`;
      } catch (e2) { /* 扫描不可达 */ }
      _l2dStatus(`已导入「${modelName}」${ups.length} 个文件${skipped ? `(跳过 ${skipped} 个非模型文件)` : ""}${sum}`);
      await _petPopulateModels($("pet-model")?.value || "");
      window._beiluToast?.(`Live2D 模型「${modelName}」导入完成,可在上方下拉选用`, "success");
    }

    // ── 入口1：文件夹选择（现有逻辑，提炼共用核心） ──
    $("l2d-import-btn")?.addEventListener("click", () => $("l2d-import-input")?.click());
    $("l2d-import-input")?.addEventListener("change", async (ev) => {
      const files = Array.from(ev.target.files || []);
      ev.target.value = "";
      if (!files.length) return;
      const model3 = files.find(f => f.name.toLowerCase().endsWith(".model3.json"));
      if (!model3) {
        const editor = files.find(f => /\.(cmo3|can3)$/i.test(f.name));
        _l2dStatus(editor ? _cmo3Hint(editor.name) : "所选目录里没有 .model3.json(需选 Cubism 导出的运行时目录)");
        return;
      }
      // 模型根锚定在【含 model3.json 的目录】(不是所选顶层):扫描链(usermodel-scan/托盘)只认
      // user-models/<模型目录>根层的 *.model3.json——用户选了外层包装目录(model3 嵌套更深)时,
      // 按顶层落盘=导入"成功"但永远扫不到。锚定后 model3 恒落模型目录根,子目录结构(motions/等)保留。
      const _m3segs = (model3.webkitRelativePath || model3.name).split("/");
      const _baseSegs = _m3segs.slice(0, -1);
      const modelName = _baseSegs.length ? _baseSegs[_baseSegs.length - 1] : model3.name.replace(/\.model3\.json$/i, "");
      const _basePrefix = _baseSegs.length ? _baseSegs.join("/") + "/" : "";
      const _rel = (f) => { const rp = f.webkitRelativePath || f.name; return (!_basePrefix || rp.startsWith(_basePrefix)) ? rp.slice(_basePrefix.length) : null; };
      // 构建 {name, relPath, file, size} 列表 → 交给共用上传核心
      const entries = files.filter(f => _rel(f)).map(f => ({ name: f.name, relPath: _rel(f), file: f, size: f.size }));
      try {
        await _l2dUploadFiles(modelName, entries);
      } catch (e) {
        _l2dStatus("导入失败: " + (e?.message || e));
        window._beiluToast?.("导入失败: " + (e?.message || e), "error");
      }
    });

    // ── 入口2：zip 文件选择（参照 airi live2d-zip-loader.ts，前端 JSZip 解压后复用同一上传链路） ──
    $("l2d-import-zip-btn")?.addEventListener("click", () => $("l2d-import-zip-input")?.click());
    $("l2d-import-zip-input")?.addEventListener("change", async (ev) => {
      const zipFile = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!zipFile) return;
      _l2dStatus("正在解压 zip…");
      try {
        // 懒加载 JSZip（首次使用才加载，不影响首屏）
        if (!window.JSZip) {
          await new Promise((res2, rej) => {
            const s = document.createElement("script");
            s.src = "vendor/jszip.min.js";
            s.onload = res2; s.onerror = () => rej(new Error("JSZip 加载失败"));
            document.head.appendChild(s);
          });
        }
        const zip = await window.JSZip.loadAsync(zipFile);
        // 过滤 __MACOSX 和 ._ 前缀垃圾文件（参照 airi shouldIgnoreLive2DArchiveEntry）
        const allPaths = Object.keys(zip.files).filter(p => !zip.files[p].dir && !p.split("/").some(seg => seg === "__MACOSX" || seg.startsWith("._")));
        // 找 model3.json
        const m3Path = allPaths.find(p => p.toLowerCase().endsWith(".model3.json"));
        if (!m3Path) {
          const editorFile = allPaths.find(p => /\.(cmo3|can3)$/i.test(p));
          _l2dStatus(editorFile ? _cmo3Hint(editorFile.split("/").pop()) : "zip 内未找到 .model3.json——请确认是 Cubism「导出运行时文件」产生的包");
          return;
        }
        // 锚定模型根（model3.json 所在目录）
        const m3Segs = m3Path.split("/");
        const baseSegs = m3Segs.slice(0, -1);
        const modelName = baseSegs.length ? baseSegs[baseSegs.length - 1] : m3Path.replace(/\.model3\.json$/i, "");
        const basePrefix = baseSegs.length ? baseSegs.join("/") + "/" : "";
        // 提取文件 → 构建 entries
        const candidates = allPaths.filter(p => (!basePrefix || p.startsWith(basePrefix)));
        _l2dStatus(`解压完成，准备上传 ${candidates.length} 个文件…`);
        const entries = [];
        for (const p of candidates) {
          const relPath = p.slice(basePrefix.length);
          if (!relPath) continue;
          const blob = await zip.files[p].async("blob");
          const file = new File([blob], relPath.split("/").pop() || p);
          entries.push({ name: file.name, relPath, file, size: blob.size });
        }
        await _l2dUploadFiles(modelName, entries);
      } catch (e) {
        _l2dStatus("zip 导入失败: " + (e?.message || e));
        window._beiluToast?.("zip 导入失败: " + (e?.message || e), "error");
      }
    });
  }
  // ── 拖拽定位(airi 对标·凛倾"图形的拖动"):在预览上直接拖模型调 xShift/yShift,松手持久化(saveUserModel 同链)。 ──
  $("pet-model-dragpos")?.addEventListener("click", () => {
    const name = $("pet-model")?.value;
    if (!name || !window.beiluLive2d || !window.beiluLive2d.getShiftRatios || !window.beiluLive2d.getShiftRatios()) { window._beiluToast?.("先选 Live2D 模型且预览已渲染", "info"); return; }
    const lh = document.getElementById("live2d-host");
    if (!lh || !lh.parentElement) { window._beiluToast?.("预览容器不存在", "error"); return; }
    const ov = document.createElement("div");
    ov.style.cssText = "position:absolute;inset:0;z-index:40;cursor:move;";
    ov.title = "按住拖动模型;松手保存;Esc 取消";
    lh.parentElement.appendChild(ov);
    window._beiluToast?.("在预览上按住拖动模型定位,松手自动保存(Esc 取消)", "info");
    const start = window.beiluLive2d.getShiftRatios();
    let downX = 0, downY = 0, cur2 = { ...start }, dragging = false;
    const hr = () => lh.getBoundingClientRect();
    const down = (e) => { dragging = true; downX = e.clientX; downY = e.clientY; e.preventDefault(); };
    const move = (e) => {
      if (!dragging) return;
      const r = hr();
      cur2 = { x: start.x + (e.clientX - downX) / r.width, y: start.y + (e.clientY - downY) / r.height };
      window.beiluLive2d.setShiftRatios(cur2.x, cur2.y); // 即时预览(clamp 在渲染层)
    };
    const up = async () => {
      if (!dragging) return;
      cleanup();
      const fin = window.beiluLive2d.getShiftRatios();
      if ($("pet-model-xshift")) $("pet-model-xshift").value = Math.round(fin.x * 100);
      if ($("pet-model-yshift")) $("pet-model-yshift").value = Math.round(fin.y * 100);
      try {
        await sendAction({ verb: "saveUserModel", target: "server:eye", source: "web", payload: { name, xShiftRatio: fin.x, yShiftRatio: fin.y } });
        window._beiluToast?.("位置已保存", "success");
      } catch (e) { window._beiluToast?.("保存失败: " + e.message, "error"); }
    };
    const key = (e) => { if (e.key === "Escape") { cleanup(); window.beiluLive2d.setShiftRatios(start.x, start.y); window._beiluToast?.("已取消,位置还原", "info"); } };
    function cleanup() { ov.remove(); window.removeEventListener("keydown", key); dragging = false; }
    ov.addEventListener("pointerdown", down);
    ov.addEventListener("pointermove", move);
    ov.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  });
  // ── 待机表情候选=当前形象【真实表情集】(B4:原自由文本盲填;图片包=pack.json 键,Live2D=usermodel-scan 的 exp3 名) ──
  const _fillIdleExprSuggestions = async (name) => {
    const dl = $("pet-idle-expression-list");
    if (!dl) return;
    let keys = [];
    try {
      if (name && _ipkNames.has(name)) {
        // R1-SKIP: pack.json 静态资源(no-store 同编辑器)。
        const r = await fetch(`/api/eye/user-images/${encodeURIComponent(name)}/pack.json`, { cache: "no-store" });
        if (r.ok) { const p = await r.json(); keys = Object.keys((p && p.expressions) || {}); }
      } else if (name) {
        const arr = await sendAction({ verb: "scanUserModels", target: "server:eye", source: "web" });
        const ent = Array.isArray(arr) ? arr.find(m => m && m.name === name) : null;
        keys = (ent && Array.isArray(ent.expressions)) ? ent.expressions.map(e => e && e.name).filter(Boolean) : [];
      }
    } catch (e) { /* 离线/无扫描:候选空,输入仍自由 */ }
    dl.innerHTML = keys.map(k => `<option value="${_capEsc(k)}"></option>`).join("");
  };
  _fillIdleExprSuggestions(cur.modelName);
  $("pet-model")?.addEventListener("change", e => _fillIdleExprSuggestions(e.target.value));
  $("ipk-active")?.addEventListener("change", e => { if (e.target.value) _fillIdleExprSuggestions(e.target.value); });
  $("pet-model-tweak-save")?.addEventListener("click", async () => {
    const name = $("pet-model")?.value;
    if (!name) { window._beiluToast?.("先在上方选择一个 Live2D 模型", "info"); return; }
    const entry = { name };
    const sv = Number($("pet-model-scale")?.value); if (sv > 0) entry.scale = sv;
    const xv = $("pet-model-xshift")?.value; if (xv !== "" && xv != null) entry.xShiftRatio = Math.max(0, Math.min(1, Number(xv) / 100));
    const yv = $("pet-model-yshift")?.value; if (yv !== "" && yv != null) entry.yShiftRatio = Math.max(0, Math.min(1, Number(yv) / 100));
    const iv = $("pet-model-idlemotion")?.value; if (iv != null) entry.idleMotionGroup = iv.trim(); // 空串=清除(渲染层回退自动匹配)
    try {
      await sendAction({ verb: "saveUserModel", target: "server:eye", source: "web", payload: entry });
      window._beiluToast?.("微调已保存", "success");
      try { if (window.beiluLive2d && window.beiluLive2d.reloadDict) await window.beiluLive2d.reloadDict(); } catch (e) { /* 预览未就绪 */ }
    } catch (e) { window._beiluToast?.("保存失败: " + e.message, "error"); }
  });
}

// T2 感知视图: 轮询真实 getGameCompanionStatus(含 lastRoundAt) + /api/eye/screenshots → 当前观察(窗口/AI状态/
// 下次截图倒计时) + 频率自适应进度条 + 本次会话(轮数/运行时长) + 今日截图(按 timestamp 真实过滤) + 最新截图缩略预览,
// 并据真实会话态校正顶部状态灯(此前只在点启动/停止时手动改, 刷新/切回不反映真实运行态)。运行时才显示。
// 不再显示"今日AI评论/忽略数":roundCount 是本会话累计、consecutiveIgnores 是连续streak且 web 面板无 ignore producer → 显示=误导。
let _compStatPollTimer = null;
let _compCountdownTimer = null;
let _compNextCaptureAt = 0; // epoch ms, 供 1s 平滑倒计时本地递减(不额外打后端)
function _compTabVisible() {
  const tab = document.getElementById("center-tab-companion");
  return tab && !tab.classList.contains("hidden");
}
// PetOperationResult.runtime → 用户文案（D5 §4：不把 Electron spawn 写作“已启用”）。
// 单一映射点：启动/停止 toast 与状态行共用，禁止各写一份。
function _petRuntimeLabel(runtime, error) {
  switch (runtime) {
    case "running": case "adopted": return "桌宠已就绪";
    case "waiting_heartbeat": case "starting": case "adopting": return "正在启动桌宠…";
    case "installing": return "正在安装桌宠组件…";
    case "missing": return "桌宠未确认启动：Electron 未安装（联网后重试可自动安装）";
    case "stopping": return "正在停止桌宠…";
    case "stopped": return "未启用";
    case "error": case "error_unconfirmed":
      return "桌宠未确认启动：" + (error || "未知错误");
    default: return runtime ? String(runtime) : "状态未知";
  }
}
function _renderCompanionRunControls(running) {
  const start = document.getElementById("comp-start");
  const stop = document.getElementById("comp-stop");
  const label = document.getElementById("comp-start-label");
  if (start) {
    start.disabled = !!running;
    start.setAttribute("aria-disabled", running ? "true" : "false");
    // [0804 文案] "陪伴"→"互动"（凛倾：启动/关闭后面加个陪伴像临终关怀）；桌宠不再被互动隐式常驻开启
    start.title = running ? "互动会话正在运行" : "开始互动会话（桌宠未启用时本次临时开启）";
  }
  if (stop) {
    stop.disabled = !running;
    stop.setAttribute("aria-disabled", running ? "false" : "true");
  }
  if (label) label.textContent = running ? "互动进行中" : "开始互动";
}
async function _pollCompanionStatus() {
  if (!_compTabVisible()) return;
  const strip = document.getElementById("comp-perception-stats");
  const dot = document.getElementById("comp-status-dot");
  const txt = document.getElementById("comp-status-text");
  // 桌宠客户端在线灯(getdata.petClientSeenAgoMs=resolvePetToken 单点记录;审计C:此前桌宠没起保存仍"成功"=假象)。
  // 在线判据 <10s = 桌宠 orb 轮询周期(~2s)×5 容差,机制事实非用户偏好;null=后端本次启动后没见过桌宠。
  try {
    const gd = await sendAction({ verb: "getData", target: "server:eye", source: "web" });
    const ago = (gd && typeof gd.petClientSeenAgoMs === "number") ? gd.petClientSeenAgoMs : null;
    const online = ago !== null && ago < 10000;
    const pod = document.getElementById("comp-pet-online-dot");
    const pot = document.getElementById("comp-pet-online-text");
    if (pod) pod.style.background = online ? "var(--beilu-success)" : "";
    if (pot) pot.textContent = online ? "桌宠:在线" : "桌宠:离线(设置将于其启动后生效)";
  } catch { /* 后端不可达:灯保持现状,下方陪伴状态同样短路 */ }
  let st = null;
  try {
    // 原 POST setdata {_action:getGameCompanionStatus} → memory 通配路由；!ok 由门面抛错走 catch（离线保持现状）
    st = await sendAction({ verb: "getGameCompanionStatus", target: "plugins:beilu-memory", source: "web" });
  } catch { return; /* 离线: 保持现状 */ }
  if (!st || !st.running) {
    _renderCompanionRunControls(false);
    if (strip) strip.classList.add("hidden");
    if (dot) dot.style.background = "";
    if (txt) txt.textContent = "未运行"; // 单一渲染者:启停不再手写"已停止",此处无需让位特判(散写收口 2026-07-16)
    _compNextCaptureAt = 0;
    // 右侧预览列也同步未运行状态
    const prDot0 = document.getElementById("comp-preview-status-dot");
    const prTxt0 = document.getElementById("comp-preview-status-text");
    if (prDot0) prDot0.style.background = "";
    if (prTxt0) prTxt0.textContent = "未运行";
    return;
  }
  _renderCompanionRunControls(true);
  if (strip) strip.classList.remove("hidden");
  if (dot) dot.style.background = st.paused ? "var(--beilu-warning)" : "var(--beilu-success)";
  if (txt) txt.textContent = st.paused ? "已暂停" : "运行中";
  const cur = Number(st.currentInterval) || 0;
  const base = Number(st.baseInterval) || cur || 1;
  const max = Number(st.maxInterval) || base;
  // 进度条 = 降频程度: cur 在 [base, max] 的位置。未降频(cur<=base)=0%, 到 maxInterval=100%。真实区间, 无虚构。
  const pct = (max > base && cur > base) ? Math.max(0, Math.min(100, Math.round(((cur - base) / (max - base)) * 100))) : 0;
  const bar = document.getElementById("comp-freq-bar");
  if (bar) bar.style.width = pct + "%";
  const lab = document.getElementById("comp-freq-label");
  // 忽略数现在是真的(后端 _executeRound 无回复→自动 ignore 驱动),>0 才显示,解释当前降频。
  if (lab) lab.textContent = `当前${cur}秒 · 基础${base}秒${st.consecutiveIgnores ? " · 忽略" + st.consecutiveIgnores + "次" : ""}`;
  // 本次会话(真实 session 数据, 诚实标注非"今日")
  const rounds = document.getElementById("comp-stat-rounds");
  if (rounds) rounds.textContent = st.roundCount ?? 0;
  const uptime = document.getElementById("comp-stat-uptime");
  if (uptime && st.startedAt) uptime.textContent = Math.max(0, Math.round((Date.now() - st.startedAt) / 60000)) + "m";
  const aistate = document.getElementById("comp-obs-aistate");
  if (aistate) aistate.textContent = st.paused ? "已暂停" : "运行中 · 等待截图";
  // 下次截图倒计时基准 = lastRoundAt + currentInterval (后端真实暴露 lastRoundAt)
  _compNextCaptureAt = (Number(st.lastRoundAt) || Date.now()) + cur * 1000;
  // 截图: 今日数(timestamp 真实过滤) + 最新窗口 + 最新缩略预览(点击放大复用 comp-preview)
  try {
    // 原 raw GET /api/eye/screenshots?limit=200 + sr.ok 手检 → 门面 getScreenshots（payload.limit 进 query）；!ok 由门面抛错走 catch（截图取不到不阻塞）
    const sj = await sendAction({ verb: "getScreenshots", target: "server:eye", source: "web", payload: { limit: 200 } });
    {
      const shots = Array.isArray(sj.screenshots) ? sj.screenshots : [];
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayN = shots.filter((s) => (s.timestamp ?? s.mtime ?? 0) >= todayStart.getTime()).length;
      const shotsEl = document.getElementById("comp-stat-shots");
      if (shotsEl) shotsEl.textContent = todayN;
      const latest = shots[0]; // listScreenshotHistory 已 reverse, [0]=最新
      const winEl = document.getElementById("comp-obs-window");
      if (winEl) winEl.textContent = latest ? (latest.windowTitle || "(全屏)") : "—";
      if (latest && latest.filename) {
        const url = `/api/eye/screenshot/${encodeURIComponent(latest.filename)}`;
        const esc = escapeHtml; // T7：alias 到唯一权威实现（原本地缺单引号，已删）
        const prev = document.getElementById("comp-preview-content");
        if (prev && prev.dataset.shot !== latest.filename) {
          prev.dataset.shot = latest.filename;
          prev.innerHTML = `<img src="${url}" class="max-h-full max-w-full object-contain rounded" /><p class="text-xs opacity-50 mt-1">${esc(latest.windowTitle || "全屏")}${latest.message ? " · " + esc(String(latest.message).slice(0, 40)) : ""}</p>`;
        }
        // 右侧预览列截图缩略同步
        const prThumb = document.getElementById("comp-preview-thumb");
        if (prThumb && prThumb.dataset.shot !== latest.filename) {
          prThumb.dataset.shot = latest.filename;
          prThumb.innerHTML = `<img src="${url}" class="w-full h-auto max-h-[120px] object-contain rounded" />`;
        }
      }
    }
  } catch { /* 截图取不到不阻塞 */ }
  // 同步 [💬] 侧栏频率显示(同一真实源)
  const fd = document.getElementById("comp-freq-display");
  if (fd) fd.textContent = cur + "秒/次";
  // ---- 右侧预览列同步(三栏布局新增) ----
  const prDot = document.getElementById("comp-preview-status-dot");
  const prTxt = document.getElementById("comp-preview-status-text");
  if (prDot) prDot.style.background = st.running ? (st.paused ? "var(--beilu-warning)" : "var(--beilu-success)") : "";
  if (prTxt) prTxt.textContent = st.running ? (st.paused ? "已暂停" : "运行中") : "未运行";
  const prRounds = document.getElementById("comp-prev-rounds");
  if (prRounds) prRounds.textContent = st.running ? (st.roundCount ?? 0) : "—";
  const prUptime = document.getElementById("comp-prev-uptime");
  if (prUptime && st.running && st.startedAt) prUptime.textContent = Math.max(0, Math.round((Date.now() - st.startedAt) / 60000)) + "m";
}
// 1s 平滑倒计时(纯本地递减到 _compNextCaptureAt, 不打后端)
function _tickCompCountdown() {
  if (!_compTabVisible() || !_compNextCaptureAt) return;
  const el = document.getElementById("comp-obs-next");
  if (el) el.textContent = Math.max(0, Math.round((_compNextCaptureAt - Date.now()) / 1000)) + "秒后";
}

// B2-1 emoji→Lucide：陪伴设置中心 0 emoji。path 取自 lucide-static v1.21.0(分身 curl unpkg 原始字节,见 B2_Lucide图标path.md)。
// 内联离线 SVG 注入所有 [data-ic] 占位 span(幂等)。ban/check 为简单稳定图标,用 Lucide 标准 path 直填。
const _COMP_ICON_PATHS = {
  "link": '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  "smile": '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
  "message-circle": '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  "waves": '<path d="M2 12q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 19q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 5q2.5 2 5 0t5 0 5 0 5 0"/>',
  "scan-eye": '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="1"/><path d="M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0"/>',
  "filter": '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
  "shield": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  "bot": '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  "play": '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  "square": '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  "search": '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  "sliders-horizontal": '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  "sparkles": '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  "puzzle": '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  "drama": '<path d="M10 11h.01"/><path d="M14 6h.01"/><path d="M18 6h.01"/><path d="M6.5 13.1h.01"/><path d="M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3"/><path d="M17.4 9.9c-.8.8-2 .8-2.8 0"/><path d="M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7"/><path d="M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4"/>',
  "gamepad-2": '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  "ban": '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  "check": '<path d="M20 6 9 17l-5-5"/>',
  "image": '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', // 2026-07-09 断链修:index.html "最新截图" data-ic="image" 此前无键=图标空
  "pointer-click": '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>', // lucide mouse-pointer-click(触碰反馈段)
  // 0725 emoji→UI 补批(凛倾"前端大量使用表情符号而不是ui,破坏美感"):此前 HTML 已引用 data-ic="mic"/"send"
  //   但表内无键=图标静默空白(语音导航项/发送钮);mic/square 同时服务对话台录音钮双态(companionChat._micUI 切换)。
  "mic": '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  "send": '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  "upload": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  // 0727 直播接入段图标改用 antenna(mdi__access-point.svg)走 themes-accents.css 注册表,
  //   不走 _COMP_ICON_PATHS 内联注入——原 lucide radio 条目已删除。
};
function _compInjectIcons(root) {
  const scope = root || document.getElementById("center-tab-companion");
  if (!scope) return;
  // 全站 themes-accents.css 已以 [data-ic]::before 作为唯一图标渲染器。旧版本曾向同一个
  // data-ic 容器再塞一份 SVG，形成伪元素+子 SVG 的套娃；这里不再注入，只负责热更新时清掉
  // 旧 DOM 残留，刷新与不刷新都回到同一 CSS 单源。
  scope.querySelectorAll("[data-ic]").forEach((el) => {
    if (el.dataset.icDone || el.querySelector(":scope > svg")) el.replaceChildren();
    delete el.dataset.icDone;
  });
}

// 直播接入(beilu-live)前端已迁出至 panels/companion/live.mjs（0726）——
//   插件前端独立成 panels/<tab>/<name>.mjs 的惯例同 eye.mjs，样式同 css/live.css 同 airp.css。
//   本文件只保留 initCompanionActivityBar 内的一处调用（见下方接线段）。











function initCompanionActivityBar() {
  // 设计稿重构(20260618): companion tab 从「活动栏+6侧栏切换」改为「8 段设置中心(全段常显)」。
  // 本函数实为整个 companion tab 的接线入口(eye config / 启停 / 设置 / WS 事件)。
  // (旧活动栏 companion-activity-bar 及其面板切换/侧栏拖宽/截图历史绑定=挂在恒 null 元素上的死码,2026-07-09 纯删;
  //  设计稿 20260618 起为 8 段设置中心,历史截图入口由"屏幕感知"段最新截图承载。)
  // T6b：COMP_API 常量随 apiFetch 收口删除——gameCompanion 动作走 memory 通配路由（verb=真动作组装 _action）。

  _compInjectIcons(); // 图标单源=themes-accents.css；同时清理热更新前遗留的内联 SVG
  _wireRendererRetry();

  // 形象字典/用户模型/图片包只在 companion 首次激活后读取。
  // initLayout 在首屏会无条件调用本函数，因此不能在此处直接启动 initCompanionPetSettings。
  const activatePetSettings = () => {
    initCompanionPetSettings().catch((error) => {
      const message = error?.message || String(error);
      window._beiluToast?.("陪伴设置加载失败: " + message, "error");
      window._reportError?.(`[companion] 设置加载失败: ${message}`, error?.stack);
    });
  };
  window.addEventListener("beilu:tab-activated", (event) => {
    if (event.detail === "companion") activatePetSettings();
  });
  if (document.body.dataset.activeTab === "companion") activatePetSettings();

  // 段导航=隔离切换(凛倾 2026-07-09:"我让你做隔离"——不是滚动锚,同刻只显示目标段,其余段隐藏)。
  const _compShowSeg = (segId) => {
    // data-seg-group:从段挂到别的导航项(如 动态/物理 挂 Live2D)=同组同屏显示(凛倾:调参不和 live 分开)
    document.querySelectorAll("#center-tab-companion .seg").forEach(s => s.classList.toggle("hidden", s.id !== segId && s.dataset.segGroup !== segId));
    document.querySelectorAll(".comp-navbtn").forEach(b => b.classList.toggle("active", b.dataset.scrollTo === segId));
  };
  document.querySelectorAll("[data-scroll-to]").forEach(a => {
    a.addEventListener("click", (e) => { e.preventDefault(); _compShowSeg(a.dataset.scrollTo); });
  });
  // 初始只显示导航当前 active 段(HTML 默认=启动绑定)
  { const _act = document.querySelector("[data-scroll-to].active"); if (_act) _compShowSeg(_act.dataset.scrollTo); }

  // pet-* 控件由上方 companion 激活门控一次性初始化。
  // 直播接入段(beilu-live,0726)。双重捕获——本函数是整个 companion tab 的接线入口,
  //   任何未捕获异常会被 initLayout 的 catch 吞掉 → 后续接线全断且无提示(:1388 同款事故)。
  //   ⚠ initCompanionLiveSettings 是 async:同步 try 只挡得住它【第一个 await 之前】的异常,
  //     await 之后抛出的会变成 unhandled rejection(浏览器里静默,只在 console 留警告)——
  //     故必须再挂 .catch()。缺了它 = 注释承诺的"不连累其他段"只兑现一半。
  try { initCompanionLiveSettings()?.catch((e) => console.warn("[live] 异步初始化失败(不影响其他段):", e)); }
  catch (e) { console.warn("[live] 同步初始化失败(不影响其他段):", e); }
  // 教程开发面板已移至 beilu-home 设置面板(凛倾 2026-07-15)
  // T7 三栏可调(凛倾 2026-07-09 圈注:左右两边要可以调整):左段导航(手柄右缘) + 右预览列(手柄左缘,invert)。
  //   持久化经 layoutState(storage);min 降到 96/200 适配窄导航与预览列。
  initSidebarResize(
    document.getElementById("comp-nav-col"),
    document.getElementById("comp-nav-resize"),
    "companionNavWidth",
    { min: 96 },
  );
  initSidebarResize(
    document.getElementById("comp-preview-col"),
    document.getElementById("comp-preview-resize"),
    "companionPreviewWidth",
    { invert: true, min: 200 },
  );
  // 任务⑧:预览区【高度】可拖(320 只是初始值;持久化 localStorage 经 storage 收口)
  {
    const box = document.getElementById("comp-preview-box");
    const handle = document.getElementById("comp-preview-hresize");
    if (box && handle) {
      // P2（一致性审计②）：野键收编 KEYS + 旧键一次性迁移（旧驼峰名逃逸 beilu- 前缀域）
      const KEY = KEYS.BEILU_COMPANION_PREVIEW_H;
      const _legacy = storage.get("beiluCompanionPreviewBoxH");
      if (_legacy !== null) {
        if (storage.get(KEY) === null) storage.set(KEY, _legacy);
        storage.remove("beiluCompanionPreviewBoxH");
      }
      try { const saved = Number(storage.get(KEY)); if (saved >= 160) box.style.height = saved + "px"; } catch (e) { /* 无存值 */ }
      let drag = false, sy = 0, sh = 0;
      handle.addEventListener("mousedown", (e) => { drag = true; sy = e.clientY; sh = box.offsetHeight; document.body.style.cursor = "row-resize"; document.body.style.userSelect = "none"; e.preventDefault(); });
      document.addEventListener("mousemove", (e) => { if (!drag) return; box.style.height = Math.max(160, Math.min(720, sh + e.clientY - sy)) + "px"; });
      document.addEventListener("mouseup", () => { if (!drag) return; drag = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; try { storage.set(KEY, String(box.offsetHeight)); } catch (e) { /* 存失败忽略 */ } });
    }
  }

  // T2 感知视图: 仅 companion tab 可见时轮询真实 status(5s) + 本地平滑倒计时(1s)。
  _pollCompanionStatus();
  if (!_compStatPollTimer) _compStatPollTimer = setInterval(_pollCompanionStatus, 5000);
  if (!_compCountdownTimer) _compCountdownTimer = setInterval(_tickCompCountdown, 1000);

  // FT-A4: [📷] 感知设置控件绑 eye config 既有 API（陪伴MD [📷] 字符画；后端字段=captureFrequency/captureWindow）
  {
    const autoCb = document.getElementById("comp-auto-capture");
    const intervalIn = document.getElementById("comp-interval");
    const targetIn = document.getElementById("comp-target-window");
    const detectBtn = document.getElementById("comp-detect-window");
    const resoIn = document.getElementById("comp-resolution");   // 分辨率(captureResolution, 后端 clamp 480~2160)
    const blIn = document.getElementById("comp-blacklist");       // 安全黑名单(blacklistPatterns, 后端 checkScreenshotBlacklist 拦截)
    const wlIn = document.getElementById("comp-whitelist");       // 安全白名单(whitelistPatterns, 后端 checkScreenshotWhitelist 准入)
    const wlEn = document.getElementById("comp-whitelist-enabled"); // 白名单总开关:关→下发空数组(不启用);开→下发 textarea 内容
    // 智能过滤(设计稿"智能过滤"段): 字段名严格对齐 beilu_eye.py _get_filter_config 读点 + endpoints /api/eye/config 写点
    const fPhash = document.getElementById("comp-filter-phash");  // L1 去重阈值 → dedupHammingThreshold
    const fL2 = document.getElementById("comp-filter-l2");        // L2 自适应区域差分 → l2RegionDiff
    const fL3 = document.getElementById("comp-filter-l3");        // L3 变化分级 → l3Grading
    const fTs = document.getElementById("comp-filter-ts");        // 时间戳元数据 → metaTimestamp
    const ttlIn = document.getElementById("comp-sense-ttl");      // B2-2 注入有效期 → eye_config.injectionTtlMs(SEC-F 10~600s)
    const jpegIn = document.getElementById("comp-jpeg-quality");  // 截图 JPEG 质量 → eye_config.captureJpegQuality(去硬编码 2026-07-13,消费=autoCapture._getJpegQuality)
    const pollIn = document.getElementById("comp-capture-poll");  // A1 截图请求轮询秒 → eye_config.capturePollSec(消费=autoCapture,改后重启桌宠生效)
    const waitIn = document.getElementById("comp-shot-wait");     // A2 陪伴等图窗秒 → eye_config.gcShotWaitSec(消费=gameCompanion)
    const keepNIn = document.getElementById("comp-shot-keepn");   // T4 对话截图保留张数 → eye_config.gcShotKeepN(消费=gameCompanion 落条后 trimEntryFiles;0=关)
    // T3修3(FT-A4 并发丢更新): 单链 promise 队列串行化 GET→merge→POST（与后端 _withWriteLock 同型最小版）。
    // 两控件近同时 change 时排队执行，每个回调 GET 最新服务器态再 merge，避免后 POST 覆盖先 POST。
    let _eyeCfgQueue = Promise.resolve();
    const _eyeMergePost = (patch) => {
      _eyeCfgQueue = _eyeCfgQueue.then(async () => {
        let cfg = {};
        // T021 弹出+防销毁：原"GET 失败用空 cfg"会把只含 patch 的对象整包 POST=其他 eye 配置键全部抹掉
        // （merge 源丢失还写回=数据覆盖家族）。失败即中止本次写入并弹出，不带病提交。
        try { cfg = await sendAction({ verb: "getEyeConfig", target: "server:eye", source: "web" }) || {}; } catch (err) {
          window._beiluToast?.("眼睛配置保存中止：读取现有配置失败（" + (err?.message || err) + "），以免覆盖其他设置", "error");
          return;
        }
        Object.assign(cfg, patch);
        await sendAction({ verb: "setEyeConfig", target: "server:eye", source: "web", payload: cfg });
      }).catch((e) => { console.warn("[eye-config] merge-post 失败", e); window._beiluToast?.("眼睛配置保存失败: " + (e?.message || e), "error"); });
      return _eyeCfgQueue;
    };
    // 初始回填（captureFrequency>0 = 自动截图开）
    (async () => {
      try {
        // 原 raw GET /api/eye/config + r.ok 手检 → 门面 getEyeConfig；!ok 由门面抛错走 catch（原 !ok return 等价：不回填）
        const cfg = await sendAction({ verb: "getEyeConfig", target: "server:eye", source: "web" });
        const freq = Number(cfg.captureFrequency) || 0;
        if (autoCb) autoCb.checked = freq > 0;
        if (intervalIn && freq > 0) intervalIn.value = freq;
        if (targetIn) targetIn.value = cfg.captureWindow || "";
        if (resoIn && cfg.captureResolution) resoIn.value = String(cfg.captureResolution);
        if (blIn) blIn.value = Array.isArray(cfg.blacklistPatterns) ? cfg.blacklistPatterns.join("\n") : "";
        // 白名单回填:whitelistPatterns 非空 = 已启用(toggle 勾上),回填到 textarea;空数组 = 未启用(toggle 关)。
        {
          const wp = Array.isArray(cfg.whitelistPatterns) ? cfg.whitelistPatterns : [];
          if (wlIn && wp.length) wlIn.value = wp.join("\n");
          if (wlEn) wlEn.checked = wp.length > 0;
        }
        // 智能过滤回填(默认: 阈值5, 三项全开 = 后端默认行为)
        if (fPhash) fPhash.value = (typeof cfg.dedupHammingThreshold === "number") ? cfg.dedupHammingThreshold : 5;
        if (fL2) fL2.checked = cfg.l2RegionDiff !== false;
        if (fL3) fL3.checked = cfg.l3Grading !== false;
        if (fTs) fTs.checked = cfg.metaTimestamp !== false;
        if (ttlIn) ttlIn.value = Math.round((Number(cfg.injectionTtlMs) || 60000) / 1000); // B2-2 ms→秒回填
        if (jpegIn) jpegIn.value = (typeof cfg.captureJpegQuality === "number") ? cfg.captureJpegQuality : 60; // 质量回填(权威默认=DEFAULT_EYE_CONFIG 60)
        if (pollIn) pollIn.value = (typeof cfg.capturePollSec === "number") ? cfg.capturePollSec : 5; // A1 轮询节奏回填
        if (waitIn) waitIn.value = (typeof cfg.gcShotWaitSec === "number") ? cfg.gcShotWaitSec : 10; // A2 等图窗回填
        if (keepNIn) keepNIn.value = (typeof cfg.gcShotKeepN === "number") ? cfg.gcShotKeepN : 10; // T4 截图保留张数回填(权威默认=DEFAULT_EYE_CONFIG 10)
        // BR1: 感知模式回填（passive/active/quiet，缺省 passive）
        const pm = (cfg.perceptionMode === "active" || cfg.perceptionMode === "quiet") ? cfg.perceptionMode : "passive";
        const pmRadio = document.querySelector(`input[name="comp-sense-mode"][value="${pm}"]`);
        if (pmRadio) pmRadio.checked = true;
        // AI 自主值回填(谱可能后到,存值后由 _renderAiAutonomy 双向汇合;dwell 回填也在彼处走谱键,零字面量)
        _aiAutoVals = cfg;
        _renderAiAutonomy();
      } catch { /* 离线时保持默认 */ }
    })();
    // AI 自主开关(容器委托:开关由 caps 谱动态生成,谱键即 eye_config 键,零映射副本)
    document.getElementById("comp-ai-autonomy")?.addEventListener("change", (e) => {
      const k = e.target?.dataset?.aiK;
      if (k) _eyeMergePost({ [k]: !!e.target.checked });
    });
    // 反馈停留时长:用户设什么存什么(仅拒负数/非数,后端同语义)。键走谱 dwell.k(审计B:此前字面量=半谱化,改谱即断)
    document.getElementById("comp-ai-dwell")?.addEventListener("change", (e) => {
      const v = Number(e.target.value);
      const k = _aiAutoSpec?.dwell?.k;
      if (k && Number.isFinite(v) && v >= 0) _eyeMergePost({ [k]: Math.round(v) });
    });
    autoCb?.addEventListener("change", () => {
      const _rawFreq = Number(intervalIn?.value);
      const freq = autoCb.checked ? (Number.isFinite(_rawFreq) ? _rawFreq : 30) : 0;
      _eyeMergePost({ captureFrequency: freq });
    });
    intervalIn?.addEventListener("change", () => {
      const _iv = Number(intervalIn.value);
      if (autoCb?.checked) _eyeMergePost({ captureFrequency: Number.isFinite(_iv) ? _iv : 30 });
      // 双键同步:同字段第一入口(启动绑定区 comp-capture-frequency)即时镜像。
      const _m = document.getElementById("comp-capture-frequency"); if (_m && autoCb?.checked) _m.value = Number.isFinite(_iv) ? _iv : 30;
    });
    targetIn?.addEventListener("change", () => {
      _eyeMergePost({ captureWindow: targetIn.value.trim() || null });
    });
    // 分辨率 → captureResolution(后端 endpoints.mjs:678 clamp 480~2160 后写 eye_config,Python 截图按此压)
    resoIn?.addEventListener("change", () => {
      // D5 分叉修(2026-07-13):clamp 边界读 caps 单源(离线兜底=同值)
      const _crl = (_petCaps && _petCaps.captureResolutionLimits) || {};
      _eyeMergePost({ captureResolution: Math.max(Number(_crl.min) > 0 ? Number(_crl.min) : 480, Math.min(Number(_crl.max) > 0 ? Number(_crl.max) : 2160, Number(resoIn.value) || 1080)) });
    });
    // 安全黑名单 → blacklistPatterns(每行一关键词;后端 checkScreenshotBlacklist 命中即 {blocked:true} 不截图)
    blIn?.addEventListener("change", () => {
      _eyeMergePost({ blacklistPatterns: blIn.value.split("\n").map((s) => s.trim()).filter(Boolean) });
    });
    // 安全白名单 → whitelistPatterns(allowlist:后端 checkScreenshotWhitelist 只放行命中名单的窗口,其余 {blocked:true})。
    // 总开关 wlEn:关 = 下发空数组(不启用白名单,旧行为);开 = 下发 textarea 每行关键词(trim 去空)。
    // 后端语义=「whitelistPatterns 非空即启用」,故空数组天然=未启用,与开关关闭一致。
    const _postWhitelist = () => {
      const lines = wlIn ? wlIn.value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      _eyeMergePost({ whitelistPatterns: (wlEn && wlEn.checked) ? lines : [] });
    };
    wlIn?.addEventListener("change", _postWhitelist);
    wlEn?.addEventListener("change", _postWhitelist);
    // 智能过滤 4 控件 → /api/eye/config(字段名对齐 beilu_eye.py _get_filter_config 读点)
    fPhash?.addEventListener("change", () => _eyeMergePost({ dedupHammingThreshold: Math.max(0, Math.min(20, Number(fPhash.value) || 5)) }));
    fL2?.addEventListener("change", () => _eyeMergePost({ l2RegionDiff: fL2.checked }));
    fL3?.addEventListener("change", () => _eyeMergePost({ l3Grading: fL3.checked }));
    fTs?.addEventListener("change", () => _eyeMergePost({ metaTimestamp: fTs.checked }));
    ttlIn?.addEventListener("change", () => _eyeMergePost({ injectionTtlMs: Math.max(10000, Math.min(600000, (Number(ttlIn.value) || 60) * 1000)) })); // B2-2 秒→ms clamp
    // 0715 收口(近期diff审计后端#1):四字段 clamp 值域改读 caps 单源 eyeConfigLimits(同 captureResolution
    //   _petCaps.captureResolutionLimits 范式);数字参数=离线兜底(与 PET_CAPABILITIES 出厂值同值,分叉即病)。
    const _eyeClamp = (key, v, defMin, defMax) => {
      const L = (_petCaps && _petCaps.eyeConfigLimits && _petCaps.eyeConfigLimits[key]) || {};
      const lo = Number.isFinite(Number(L.min)) ? Number(L.min) : defMin;
      const hi = Number.isFinite(Number(L.max)) ? Number(L.max) : defMax;
      return Math.max(lo, Math.min(hi, v));
    };
    jpegIn?.addEventListener("change", () => _eyeMergePost({ captureJpegQuality: _eyeClamp("captureJpegQuality", Number(jpegIn.value) || 60, 1, 100) }));
    pollIn?.addEventListener("change", () => _eyeMergePost({ capturePollSec: _eyeClamp("capturePollSec", Number(pollIn.value) || 5, 2, 60) })); // A1
    waitIn?.addEventListener("change", () => _eyeMergePost({ gcShotWaitSec: _eyeClamp("gcShotWaitSec", Number(waitIn.value) || 0, 0, 120) })); // A2
    keepNIn?.addEventListener("change", () => _eyeMergePost({ gcShotKeepN: _eyeClamp("gcShotKeepN", Number(keepNIn.value) || 0, 0, 100) })); // T4(0=关)
    // 手动刷新检测 = 取最新截图的当前前台窗口标题(真实数据, 无新后端)。
    document.getElementById("comp-detect-game")?.addEventListener("click", async () => {
      const el = document.getElementById("comp-detected-game");
      if (el) el.textContent = "检测中…";
      try {
        // 原 raw GET /api/eye/screenshots?limit=1 + r.ok 手检 → 门面 getScreenshots（payload.limit）；!ok 由门面抛错走 catch
        const j = await sendAction({ verb: "getScreenshots", target: "server:eye", source: "web", payload: { limit: 1 } });
        const w = j.screenshots?.[0]?.windowTitle;
        if (el) el.textContent = w || "无(暂无截图,先开始互动或手动截图)";
      } catch (e) { if (el) el.textContent = "检测失败: " + e.message; }
    });
    // 检测当前窗口 = 取最新截图的 windowTitle（/api/eye/screenshots 已带）
    detectBtn?.addEventListener("click", async () => {
      try {
        // 原 raw GET /api/eye/screenshots + r.ok 手检 → 门面 getScreenshots（无 limit）；!ok 由门面抛错走 catch
        const j = await sendAction({ verb: "getScreenshots", target: "server:eye", source: "web" });
        const list = Array.isArray(j) ? j : (j.screenshots || j.list || []);
        const latest = list[0];
        if (latest?.windowTitle) {
          if (targetIn) { targetIn.value = latest.windowTitle; targetIn.dispatchEvent(new Event("change")); }
          window._beiluToast?.("已检测: " + latest.windowTitle, "success");
        } else {
          window._beiluToast?.("暂无截图记录，先手动截一张", "info");
        }
      } catch (e) { window._beiluToast?.("检测失败: " + e.message, "error"); }
    });
    // BR1: 感知模式接活 — 后端 eye_config.perceptionMode 已实装并在 /api/eye/inject 真消费
    // (passive=存pending不主动发, active=自动发AI, quiet=只归档不写pending)。radio 值与后端枚举一致。
    document.querySelectorAll('input[name="comp-sense-mode"]').forEach((radio) => {
      const lab = radio.closest("label");
      if (lab) lab.title = "被动=AI只观察不主动说 · 主动=AI看到自动评论 · 安静=只截图不发给AI";
      radio.addEventListener("change", () => {
        if (radio.checked) _eyeMergePost({ perceptionMode: radio.value });
      });
    });
  }

  // 启动/停止按钮
  document.getElementById("comp-start")?.addEventListener("click", async () => {
    // FT5 A-①: 轮询间隔覆盖字段 (留空=后端跟随截图频率 captureFrequency), 单位秒→毫秒
    const _ovRaw = document.getElementById("comp-interval-override")?.value || "";
    const interval = _ovRaw.trim() ? parseInt(_ovRaw) * 1000 : undefined;
    // 当前 chatid (用于 gameCompanion 把 AI 回复广播回来)
    // 补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，内含 _CHATID_RE 校验）——
    //   非法 hash（分段气泡/IDE 内部锚点）返 ""，不再裸读 substring 当 chatid 送后端 startGameCompanion 分区键；
    //   空值时后端按 :543 bindWarnings 语义回退到当前对话。对齐 cardsPanel.mjs:62 _cur() 范式（window 全局桥单源）。
    const _chatid = window._beiluGetChatId?.() || "";
    // [D5 结构版 2026-08-04] UI 不再预写 petEnabled（原 0804 iter6 标记方案整体删除）：
    //   「开始互动」只发 startGameCompanion 一个事务；后端 gameCompanion 成功后 acquire 互动租约,
    //   PetLifecycle owner 按 effectiveDesired=explicit||lease 拉起桌宠。UI 是 PetOperationResult
    //   DTO 的消费者：session 与 pet 分项显示,不用一个 success toast 抹平（互动可成功而桌宠未就绪）。
    try {
      // D-1:绑定的角色/对话失效 → 后端回退并随 startGameCompanion 返回 bindWarnings,前端不静默提示
      //   (独立模式未选对话、或绑定目标被删,都会回退到当前角色/对话)。
      const _startRes = await sendAction({ verb: "startGameCompanion", target: "plugins:beilu-memory", source: "web", payload: { interval, chatid: _chatid } }) || {};
      if (_startRes && Array.isArray(_startRes.bindWarnings)) {
        for (const w of _startRes.bindWarnings) {
          const _f = w.field === "bindChar" ? "角色卡" : "绑定对话";
          window._beiluToast?.(`${_f}已失效,陪伴已回退到当前${w.field === "bindChar" ? "角色" : "对话"}`, "warning");
        }
      }
      if (_startRes && _startRes.success === false) throw new Error(_startRes.error || "启动失败");
      const _pet = _startRes.pet || {};
      const _shortChat = String(_startRes.chatid || "").slice(0, 8);
      const _petLabel = _petRuntimeLabel(_pet.runtime, _pet.error);
      if (_pet.runtime === "running" || _pet.runtime === "adopted" || !_pet.interactionLease) {
        window._beiluToast?.(`互动已开始，承载对话：${_shortChat}。桌宠：${_petLabel}`, "success");
      } else {
        // 桌宠未就绪:如实分项提示,不报纯 success(D5 §4)
        window._beiluToast?.(`互动已开始，桌宠尚未就绪：${_petLabel}`, "warning");
      }
      // 显式开关镜像:后端真值回填(lease 不改 petEnabled,checkbox 保持服务端显式值)
      const _tg = document.getElementById("pet-enabled");
      if (_tg && typeof _pet.explicitEnabled === "boolean") _tg.checked = _pet.explicitEnabled;
    } catch (e) { window._beiluToast?.("互动启动失败: " + e.message, "error"); }
    // 散写收口(凛倾 2026-07-16"多处散写,启动不同步"):状态灯不再手写 DOM——唯一渲染者=_pollCompanionStatus
    // (后端 getGameCompanionStatus 真值),启停后立即回读,左灯/右列灯/运行区一次同步,消灭双灯打架窗口。
    _pollCompanionStatus();
  });

  document.getElementById("comp-stop")?.addEventListener("click", async () => {
    // [D5 结构版 2026-08-04] 停止=单事务:后端 stopGameCompanion 内 release 本次互动租约,
    //   PetLifecycle owner 走优雅停止(10s ack);回包已含 session 与 pet 分项收束结果——
    //   UI 只消费 DTO,不再读标记/不再自己写 petEnabled(原 iter6 标记回滚逻辑整体删除)。
    const _stopLabel = document.getElementById("comp-start-label");
    const _prevLabel = _stopLabel?.textContent;
    if (_stopLabel) _stopLabel.textContent = "正在停止互动与本次临时桌宠…";
    try {
      const _stopRes = await sendAction({ verb: "stopGameCompanion", target: "plugins:beilu-memory", source: "web" }) || {};
      if (_stopRes.success === false) throw new Error(_stopRes.error || "停止失败");
      const _pet = _stopRes.pet || {};
      if (_pet.explicitEnabled && (_pet.runtime === "running" || _pet.runtime === "adopted" || _pet.runtime === "waiting_heartbeat")) {
        window._beiluToast?.("互动已停止。桌宠仍按你的「启用桌宠」设置运行，可在桌宠形象区关闭", "info");
      } else if (_stopRes.petLeaseReleased && _pet.runtime === "stopped") {
        window._beiluToast?.("互动已停止，本次临时开启的桌宠已确认关闭", "info");
      } else if (_pet.stopTimeout) {
        window._beiluToast?.("互动已停止；桌宠退出暂未确认（仍在收束观察中，稍后自动关闭）", "warning");
      } else {
        window._beiluToast?.("互动已停止", "info");
      }
    } catch (e) { window._beiluToast?.("停止失败: " + e.message, "error"); }
    finally { if (_stopLabel && _prevLabel !== undefined) _stopLabel.textContent = _prevLabel; }
    _pollCompanionStatus(); // 同上:停止后立即回读真值,不手写状态灯
  });

  // 手动截图
  document.getElementById("comp-manual-capture")?.addEventListener("click", async () => {
    try {
      // 原 POST setdata {_action:gameCompanionAction,...} → memory 通配路由；!ok 由门面抛错走 catch
      const r = await sendAction({ verb: "gameCompanionAction", target: "plugins:beilu-memory", source: "web", payload: { action: "captureNow" } });
      if (!r?.success) throw new Error(r?.error || "截图请求未被接受");
      window._beiluToast?.(r.screenshot === "attached" ? "截图已附入陪伴轮" : "截图未到达，已按当前状态处理", r.screenshot === "attached" ? "success" : "warning");
    } catch (e) { window._beiluToast?.("截图失败: " + e.message, "error"); }
  });

  // (对话台 AIRP 形态已落地 2026-07-16:companionChat.mjs(承载对话 getLog 轮询+气泡渲染+发送);
  //  P 切换条同日删除——凛倾"p系列删除,不要把记忆系统搬运到这里"。)

  // (截图历史缩略图网格 CP-N3 已删,2026-07-09:绑定挂在旧活动栏[data-comp-panel="history"]上,
  //  设计稿移除活动栏后 UI(comp-screenshot-list)与触发按钮均不存在=不可达死码;
  //  截图数据入口仍在:屏幕感知段"最新截图"(getScreenshots,本文件下方)。)

  // 设置面板 (FT5 A-①): 字段与后端 game_companion_config.json 4 权威字段严格对齐;
  // 截图频率与 settings 截图面板双读同源 eye_config.json.captureFrequency (经 /api/eye/config),
  // 不另存第三处。删去 ignorePenalty/maxInterval/showOrb/bannerDuration 4 个后端零读的发明字段。
  const settingsPanel = document.getElementById("comp-side-settings");
  if (settingsPanel) {
    // 初始化: 填充下拉选项 + 回填已存配置 (一次性)
    _initCompanionSettings(); // P1 修（07-03 巡检确诊）：COMP_API 常量 T6b 已删而此处仍引用=ReferenceError 被 initLayout catch 吞→companion 设置初始化静默失败；形参函数体内零使用，删死引用

    settingsPanel.addEventListener("change", async (ev) => {
      const tgt = ev.target;
      try {
        // 1. 截图频率 → eye_config.json (与截图设置面板同一权威源, GET-merge-POST 防覆盖其他 eye 字段)
        if (tgt && tgt.id === "comp-capture-frequency") {
          const freq = Number(document.getElementById("comp-capture-frequency")?.value) || 0;
          let eyeCfg = {};
          // T021 同族补修(2026-07-09 走查抓到):原"GET 失败用空 cfg 继续 POST"=只含本字段整包写回,其他 eye 配置键全抹
          //   (数据覆盖家族,与感知区 _eyeMergePost :864 同病同修)。失败即中止+弹出,不带病提交。
          try { eyeCfg = await sendAction({ verb: "getEyeConfig", target: "server:eye", source: "web" }) || {}; } catch (err) {
            window._beiluToast?.("截图频率保存中止：读取现有配置失败（" + (err?.message || err) + "），以免覆盖其他设置", "error");
            return;
          }
          eyeCfg.captureFrequency = freq;
          await sendAction({ verb: "setEyeConfig", target: "server:eye", source: "web", payload: eyeCfg });
          // 双键同步(凛倾 2026-07-09"双键不同步"):同字段第二入口(感知区 comp-interval)即时镜像,不等下次回填。
          const _mirror = document.getElementById("comp-interval"); if (_mirror) _mirror.value = freq;
          const _mirrorCb = document.getElementById("comp-auto-capture"); if (_mirrorCb) _mirrorCb.checked = freq > 0;
          return; // 截图频率不进 game_companion_config
        }
        // 2. 轮询间隔覆盖字段不持久化 (仅 comp-start 时读), change 不触发保存
        if (tgt && tgt.id === "comp-interval-override") return;
        // D-1 选择闭环(凛倾 0725"绑定对话文件工作不了"):原"独立模式才解禁下拉"把选对话的入口
        // 锁在另一个状态里(操作逻辑闭环反例)——下拉常可用,选中对话=自动切"锁定指定对话",
        // 清空=回专门陪伴对话;模式切回专门=对话选择同步清空。同步在读 cfg 前完成,一次落盘。
        if (tgt && tgt.id === "comp-bind-chat") {
          const _ms = document.getElementById("comp-bind-mode");
          if (_ms) _ms.value = tgt.value ? "independent" : "follow";
        }
        if (tgt && tgt.id === "comp-bind-mode" && tgt.value !== "independent") {
          const _cs = document.getElementById("comp-bind-chat");
          if (_cs) _cs.value = "";
        }
        // 3. D-1 bindChar/bindChat/bindMode → game_companion_config.json(后端 merge,其余字段保留)。
        //    presetName 已删(凛倾 2026-07-16 P 系列删除):陪伴轮走主对话链,提示词/API=承载对话自身 AIRP 配置。
        const cfg = {
          bindChar: document.getElementById("comp-bind-char")?.value || null,
          bindChat: document.getElementById("comp-bind-chat")?.value || null,
          bindMode: document.getElementById("comp-bind-mode")?.value === "independent" ? "independent" : "follow",
        };
        // B2-4 频率自适应倍率(仅控件存在时带上,后端 isFinite 校验+clamp;缺省=原硬编码值)
        const _smEl = document.getElementById("comp-silence-mult"); if (_smEl) cfg.silenceMultiplier = Number(_smEl.value);
        const _cmEl = document.getElementById("comp-close-mult"); if (_cmEl) cfg.closeMultiplier = Number(_cmEl.value);
        const _miEl = document.getElementById("comp-max-interval-min"); if (_miEl) cfg.maxIntervalMin = Number(_miEl.value);
        // 原 POST setdata {_action:setGameCompanionConfig, ...cfg} → memory 通配路由（cfg 平铺进 payload）；!ok 由门面抛错走 catch（原 console.warn+return 弱化为门面统一报错）
        const j = await sendAction({ verb: "setGameCompanionConfig", target: "plugins:beilu-memory", source: "web", payload: { ...cfg } }) || {};
        if (j && j.success === false) {
          window._beiluToast?.("陪伴设置保存失败: " + (j.error || "字段未识别"), "error");
        }
      } catch (e) {
        console.error("[layout] comp-settings save error:", e);
        window._reportError?.(`[layout] comp-settings save error: ${e.message}`);
      }
    });
  }

  // ---- 陪伴专属 API 设置(单一子模式实体)(凛倾 0723 陪伴子模式化;0725"游戏只绑定一个子模式,
  //      直接把子模式那条线拿出来用,不需要出现模式") ----
  // 陪伴=chat 组【固定单实体】的消费者:实体读写走子模式单源 verb 链(getSubModes/saveSubModes,零副本),
  // 不做多实体选择/新建——实体 id 恒为 COMPANION_SM_ID,缺失自动补建(enabled 默认关=完全跟随承载对话)。
  // 生成侧机制零新增:启用=写 active_sub_modes_map[承载chatid](启动后 _soSyncActivation 自动绑定,
  // setActiveSubMode 应用实体 presetName);停用=清除该键(只清自己的 id,不动他方写入)。
  // getPromptHandler 每轮解析 model_params 覆盖(B18 副本权威)。
  // INJ/联网/记忆不随子模式(统一功能层,机制事实=acceptedScopes 签名不含 subMode)。
  // 备用API源 backup_api_source 刻意不上表单:消费端只有记忆 aiRunner(runMemoryPresetAI:1011),
  // 陪伴轮走主对话链(triggerCharReply)不经它——做了就是死控件(半接线),等链路真通了再上。
  {
    const COMPANION_SM_ID = "chat-companion"; // 固定单实体 id(0725 单实体化;旧多实体数据不迁,启动后本实体接管承载对话映射)
    const _soHint = document.getElementById("comp-submode-hint");
    let _soAll = [];
    let _soEntity = null;
    let _soEnumSchema = null; // getSubModes 随包 enum_schema(后端 paramSchema 权威;离线退 ENUM_FALLBACK)
    const _soEnum = (key) => {
      const d = _soEnumSchema && _soEnumSchema[key];
      if (d && Array.isArray(d.options) && d.options.length > 0) return d.options;
      return ENUM_FALLBACK[key] || [];
    };
    const _soFillEnumSel = (elId, key) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const keep = el.value;
      el.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
      for (const opt of _soEnum(key)) { const o = document.createElement("option"); o.value = opt.value; o.textContent = opt.label || opt.value; if (opt.title) o.title = opt.title; el.appendChild(o); }
      el.value = keep;
    };
    // 预设候选(凛倾 0723"设置的便捷性":免手打预设名)——单源=beilu-preset#getData.preset_list(与 AIRP 预设面板同源);失败=纯文本输入退化
    let _soPresetsFilled = false;
    const _soFillPresetList = async () => {
      if (_soPresetsFilled) return;
      const dl = document.getElementById("comp-sm-preset-list");
      if (!dl) return;
      try {
        const d = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
        if (Array.isArray(d?.preset_list) && d.preset_list.length) {
          dl.innerHTML = d.preset_list.map((n) => `<option value="${_capEsc(String(n))}"></option>`).join("");
          _soPresetsFilled = true;
        }
      } catch (e) { /* 后端未起:候选空,手输仍可用 */ }
    };
    const _soChatid = async () => {
      try { const st = await sendAction({ verb: "getGameCompanionStatus", target: "plugins:beilu-memory", source: "web" }) || {}; return st.chatid || ""; } catch (e) { return ""; }
    };
    const _SO_NUM_FIELDS = [
      ["temperature", "comp-sm-temperature", "temperature"], ["max_tokens", "comp-sm-max-tokens", "max_tokens"],
      ["max_context", "comp-sm-max-context", "max_context"], ["top_p", "comp-sm-top-p", "top_p"],
      ["top_k", "comp-sm-top-k", "top_k"], ["min_p", "comp-sm-min-p", "min_p"],
    ];
    let _soApiSources = null;
    const _soFetchApiSources = async () => {
      if (_soApiSources) return _soApiSources;
      try {
        const list = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
        _soApiSources = Array.isArray(list) ? list.map((s) => (typeof s === "string" ? s : s.name || s.id || String(s))) : [];
      } catch (e) { _soApiSources = []; }
      return _soApiSources;
    };
    // 绑定模型候选=所绑 API 源实时拉取(window._beiluGetModelList 单源,同 subModePanel._populateModelSelect:2152 范式:
    //   force 实时访问,失败回落收口内缓存=诚实降级;竞态 reqId 丢弃过期结果)
    let _soModelReq = 0;
    const _soFillModelSel = async (apiSource, currentModel) => {
      const sel = document.getElementById("comp-sm-model");
      if (!sel) return;
      sel.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
      const _cur = currentModel || "";
      if (_cur) { const o = document.createElement("option"); o.value = _cur; o.textContent = _cur + "(已绑定)"; sel.appendChild(o); }
      sel.value = _cur;
      if (!apiSource) return; // 未绑源:仅保留已绑定项(模型覆盖仍可经保存留存)
      const req = ++_soModelReq;
      let models = [];
      try { models = window._beiluGetModelList ? await window._beiluGetModelList(apiSource, { force: true }) : []; } catch (e) { /* 拉取失败:下拉仅保留已绑定项 */ }
      if (req !== _soModelReq) return;
      for (const id of models) {
        if (!id || id === _cur) continue;
        const o = document.createElement("option"); o.value = id; o.textContent = id; sel.appendChild(o);
      }
      sel.value = _cur; // 重填后保持选中
    };
    // 实体确保:getSubModes 读全量,无 COMPANION_SM_ID 即补建落盘(幂等;enabled 默认 false=行为不变量:
    //   未显式启用前陪伴完全跟随承载对话,与旧"(不覆盖·跟随承载对话)"缺省等价)
    const _soEnsureEntity = async () => {
      const data = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web" });
      _soAll = Array.isArray(data?.sub_modes) ? data.sub_modes : [];
      if (data?.enum_schema) _soEnumSchema = data.enum_schema; // 选项集权威随包下发(paramSchema 后端单源)
      _soEntity = _soAll.find((m) => m && m.id === COMPANION_SM_ID) || null;
      if (!_soEntity) {
        _soEntity = { id: COMPANION_SM_ID, label: "陪伴", modeGroup: "chat", enabled: false, model_params: {} };
        _soAll = [..._soAll, _soEntity];
        await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _soAll } });
      }
    };
    // 启用态↔承载对话激活映射同步(读写同源=active_sub_modes_map[cid];未运行=只存实体,启动后自动补绑。
    //   只接管自己的 id:act 为其他 id(他方写入)不清除,防越权覆盖)
    const _soSyncActivation = async (force) => { // force=已绑定也重绑一次(保存后 presetName 变更即刻应用)
      const cid = await _soChatid();
      const _on = _soEntity && _soEntity.enabled === true;
      if (!cid) { if (_soHint) _soHint.textContent = _on ? "已启用:开始互动后自动绑定生效" : "未启用:互动完全跟随承载对话配置"; return; }
      let act = "";
      try { const st = await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: {} }); act = st?.active_sub_modes_map?.[cid] || ""; } catch (e) { return; /* 读不到真值不盲写 */ }
      try {
        if (_on && (force || act !== COMPANION_SM_ID)) {
          await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { id: COMPANION_SM_ID, chatId: cid } });
          if (_soHint) _soHint.textContent = "已绑定承载对话(预设即刻应用,参数每轮生效)";
        } else if (!_on && act === COMPANION_SM_ID) {
          await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { clear: true, clearPreset: true, modeGroup: "chat", chatId: cid } });
          if (_soHint) _soHint.textContent = "已解除覆盖(回承载对话预设/runtime 基线)";
        } else if (_soHint) {
          _soHint.textContent = _on ? "已绑定承载对话(预设即刻应用,参数每轮生效)" : "未启用:陪伴完全跟随承载对话配置";
        }
      } catch (e) { if (_soHint) _soHint.textContent = "绑定同步失败: " + (e?.message || e); }
    };
    // ── 单实体表单(字段对齐子模式编辑器 subModePanel:1610-1688,不含所属模式/身份字段;
    //    空=删键不覆盖,显式值(含 0)原样存;presetName=预设名指针,绑定时 setActiveSubMode 链应用) ──
    const _soFillForm = async () => {
      const form = document.getElementById("comp-sm-form");
      if (!form) return;
      const sm = _soEntity;
      if (!sm) { form.style.display = "none"; return; }
      // 未启用时的真实语义是复用承载对话 AIRP/角色 API 源/模型；隐藏空覆盖表单，避免把
      // “没有覆盖值”显示成“没有同步到 API”。只有用户打开专属覆盖后才加载并展示这些字段。
      form.style.display = sm.enabled === true ? "flex" : "none";
      const enEl = document.getElementById("comp-sm-enabled"); if (enEl) enEl.checked = sm.enabled === true;
      if (sm.enabled !== true) return;
      const mp = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params : {};
      const pEl = document.getElementById("comp-sm-preset"); if (pEl) pEl.value = sm.presetName || "";
      const srcSel = document.getElementById("comp-sm-api-source");
      if (srcSel) {
        const sources = await _soFetchApiSources();
        srcSel.innerHTML = `<option value="">(跟随 AIRP / 角色 API 源)</option>`;
        for (const s of sources) { const o = document.createElement("option"); o.value = s; o.textContent = s; srcSel.appendChild(o); }
        srcSel.value = sources.includes(mp.api_source) ? mp.api_source : "";
      }
      _soFillModelSel(mp.api_source || "", mp.model || "");
      for (const [key, elId] of _SO_NUM_FIELDS) { const el = document.getElementById(elId); if (el) el.value = (mp[key] !== undefined && mp[key] !== null) ? mp[key] : ""; }
      // 后处理/预填充三键(0723 补缺口:getPromptHandler:303-304 每轮在读,此前前端没给操控面)
      _soFillEnumSel("comp-sm-pp", "prompt_post_processing");
      _soFillEnumSel("comp-sm-prefill-mode", "claude_prefill_mode");
      _soFillPresetList();
      const ppEl = document.getElementById("comp-sm-pp"); if (ppEl) ppEl.value = mp.prompt_post_processing ?? "";
      const pmEl = document.getElementById("comp-sm-prefill-mode"); if (pmEl) pmEl.value = mp.claude_prefill_mode ?? "";
      const peEl = document.getElementById("comp-sm-prefill-enabled"); if (peEl) peEl.value = (mp.prefill_enabled === true) ? "on" : (mp.prefill_enabled === false) ? "off" : "";
      applyParamSchemaToInputs(_SO_NUM_FIELDS.map(([, elId, schemaKey]) => [schemaKey, elId]));
    };
    const _soRefresh = async () => {
      try { await _soEnsureEntity(); } catch (e) { if (_soHint) _soHint.textContent = "陪伴配置加载失败(后端未起?)"; return; }
      await _soFillForm();
      await _soSyncActivation();
    };
    // 切换绑定 API 源 → 模型候选跟随该源重拉(当前绑定模型项保留,同子模式编辑器 :2297 语义)
    document.getElementById("comp-sm-api-source")?.addEventListener("change", (e) => { _soFillModelSel(e.target.value, ""); });
    // 启用开关:实体 enabled 落盘 + 立即同步承载对话绑定(运行中即刻生效,未运行启动后自动补绑)
    document.getElementById("comp-sm-enabled")?.addEventListener("change", async (e) => {
      if (!_soEntity) return;
      _soEntity.enabled = !!e.target.checked;
      try {
        await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _soAll } });
      } catch (err) { window._beiluToast?.("保存失败: " + (err?.message || err), "error"); e.target.checked = !e.target.checked; _soEntity.enabled = e.target.checked; return; }
      await _soFillForm();
      await _soSyncActivation();
    });
    document.getElementById("comp-sm-save")?.addEventListener("click", async () => {
      const sm = _soEntity;
      if (!sm) return;
      const pv = document.getElementById("comp-sm-preset")?.value?.trim() || "";
      if (pv) sm.presetName = pv; else delete sm.presetName;
      if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
      const mp = sm.model_params;
      const modelV = document.getElementById("comp-sm-model")?.value?.trim() || "";
      if (modelV) mp.model = modelV; else delete mp.model;
      const srcV = document.getElementById("comp-sm-api-source")?.value || "";
      if (srcV) mp.api_source = srcV; else delete mp.api_source;
      for (const [key, elId] of _SO_NUM_FIELDS) {
        const raw = document.getElementById(elId)?.value;
        // 空=不覆盖(删键);显式值原样存(0 是 temperature/top_p 合法值,禁 truthy 判定)
        if (raw === "" || raw === undefined || raw === null) delete mp[key];
        else { const n = Number(raw); if (Number.isFinite(n)) mp[key] = n; else delete mp[key]; }
      }
      const ppV = document.getElementById("comp-sm-pp")?.value || ""; if (ppV) mp.prompt_post_processing = ppV; else delete mp.prompt_post_processing;
      const pmV = document.getElementById("comp-sm-prefill-mode")?.value || ""; if (pmV) mp.claude_prefill_mode = pmV; else delete mp.claude_prefill_mode;
      const peV = document.getElementById("comp-sm-prefill-enabled")?.value || "";
      if (peV === "on") mp.prefill_enabled = true; else if (peV === "off") mp.prefill_enabled = false; else delete mp.prefill_enabled;
      // 表单里改了开关但没触发 change 的兜底:保存一并落 enabled 当前控件真值
      const enEl = document.getElementById("comp-sm-enabled"); if (enEl) sm.enabled = !!enEl.checked;
      try {
        await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _soAll } });
        window._beiluToast?.("陪伴专属配置已保存(参数下轮生效;预设在绑定时应用)", "success");
        await _soSyncActivation(true); // 已绑定也重绑一次=presetName 变更即刻应用(applySubModePresetDefault 链)
      } catch (e) { window._beiluToast?.("保存失败: " + (e?.message || e), "error"); }
    });
    _soRefresh();
    document.getElementById("comp-start")?.addEventListener("click", () => setTimeout(_soRefresh, 1200)); // 启动后承载对话就位,自动绑定+回显
  }

  // ---- 陪伴对话面板(凛倾 2026-07-13"前端看着airp那种做"/2026-07-16"参照airp,做个前端拉线接后端") ----
  // 渲染/发送/轮询全在 companionChat.mjs:陪伴轮走主对话链落 chats/{chatid}.json,
  // 本面板=承载对话的 AIRP 形态前端(getLog 拉历史+3s 增量轮询+gameCompanionSay 发送)。
  // 旧 WS companion_message 回显链已随 aiRunner 临时轮删除(producer 已不存在);
  // WS 按 currentChatId 门控(websocket.mjs:603)收不到后台对话事件,轮询=唯一可靠通路。
  initCompanionChat();

  window.addEventListener("beilu:orb-message", (e) => {
    const { text } = e.detail || {};
    if (!text) return;
    // FT5 A-② 通路3: 横幅接口占位 — 凛倾自留横幅样式。若注入了 _beiluOrbBanner 则优先调它(单参契约),
    // 否则 fallback 现有网页 toast。本设计只留接口不写横幅 DOM/CSS (样式留白给凛倾)。
    // (原 comp-chat-log 回显已删:该区现渲染承载对话本体,orbMessage 从 AI 回复标签提取=正文已在对话里,再插一行=重复显示。)
    if (typeof window._beiluOrbBanner === "function") {
      window._beiluOrbBanner(text); // ← 凛倾横幅渲染器接口占位 (样式由凛倾实现)
    } else if (window._beiluToast) {
      window._beiluToast(text, "info", 3000); // fallback: Electron 悬浮球/横幅未接时网页 toast(0725 去 emoji 前缀)
    }
  });

  // AI 自主动作反馈(WS capture_control_applied→websocket.mjs 转发;凛倾 2026-07-09"设置区给反馈…停留"):
  //   ①感知段提示行(comp-ai-feedback)显示生效项,停留 dwellMs(用户设置,0=常驻)
  //   ②回填被 AI 改动的感知控件(不留旧值假象)。producer=replyHandler captureControl(gate 后实际生效项)。
  //   (原"记入陪伴消息区"已删:comp-chat-log 现渲染承载对话本体,系统调整行混进对话流=污染,toast+提示行已够。)
  window.addEventListener("beilu:capture-control-applied", (e) => {
    const { applied, dwellMs } = e.detail || {};
    if (!applied || typeof applied !== "object") return;
    const parts = [];
    if (applied.frequency !== undefined) parts.push(`截图频率→${applied.frequency}秒`);
    if (applied.window !== undefined) parts.push(`目标窗口→${applied.window || "全屏"}`);
    if (applied.perceptionMode !== undefined) {
      const pmLabel = { passive: "被动", active: "主动", quiet: "安静" }[applied.perceptionMode] || applied.perceptionMode;
      parts.push(`感知模式→${pmLabel}`);
    }
    if (!parts.length) return;
    const text = "AI 自主调整: " + parts.join(", ");
    const fb = document.getElementById("comp-ai-feedback");
    if (fb) {
      fb.textContent = text;
      fb.classList.remove("hidden");
      clearTimeout(fb._dwellTimer);
      const dw = Number(dwellMs);
      if (Number.isFinite(dw) && dw > 0) fb._dwellTimer = setTimeout(() => fb.classList.add("hidden"), dw);
    }
    if (applied.frequency !== undefined) {
      const iv = document.getElementById("comp-interval"); if (iv && applied.frequency > 0) iv.value = applied.frequency;
      const ac = document.getElementById("comp-auto-capture"); if (ac) ac.checked = applied.frequency > 0;
      const m = document.getElementById("comp-capture-frequency"); if (m && applied.frequency > 0) m.value = applied.frequency;
    }
    if (applied.window !== undefined) {
      const tw = document.getElementById("comp-target-window"); if (tw) tw.value = applied.window || "";
    }
    if (applied.perceptionMode !== undefined) {
      const r = document.querySelector(`input[name="comp-sense-mode"][value="${applied.perceptionMode}"]`); if (r) r.checked = true;
    }
  });
}

// 陪伴设置面板: D-1 角色卡/对话/对话模式 + 截图频率回填 (一次性)。
// 绑定预设/P 系列已删(凛倾 2026-07-16"不要把记忆系统搬运到这里"):陪伴轮走主对话链,
//   API/模型/温度/后处理/提示词全用承载对话自身的 AIRP 配置,陪伴零独立提示词配置。
// (D-1 _compApplyBindModeUI 灰显门控已删,凛倾 0725"工作不了":禁用态把选对话入口锁死在另一状态,
//  改为 settingsPanel change 委托里的选择闭环同步——选中即锁定,清空即回专门对话。)
let _companionSettingsInited = false;
async function _initCompanionSettings() {
  if (_companionSettingsInited) return;
  _companionSettingsInited = true;
  const freqIn = document.getElementById("comp-capture-frequency");
  const charSel = document.getElementById("comp-bind-char");   // D-1 角色卡绑定
  const chatSel = document.getElementById("comp-bind-chat");   // D-1 对话绑定
  const modeSel = document.getElementById("comp-bind-mode");   // D-1 对话路由模式
  const esc = escapeHtml; // T7：alias 到唯一权威实现（原本地 4 字符缺单引号，已删）
  // (绑定预设下拉 comp-preset + 对话台 P 系列切换条 comp-say-presets 已删,凛倾 2026-07-16
  //  "p系列删除,不要把记忆系统搬运到这里"——记忆预设归记忆面板,陪伴轮走主对话链零预设绑定。)
  // D-1 角色卡下拉:复用顶栏同源 /api/getallcacheddetails/chars(names = cachedDetails 键 + uncachedNames)
  if (charSel) {
    try {
      // 原 raw GET chars 缓存详情 + r.ok 手检 → 复用 listAllCached；!ok 由门面抛错走 catch（离线保留占位）
      const j = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
      const names = [...Object.keys(j.cachedDetails || {}), ...(Array.isArray(j.uncachedNames) ? j.uncachedNames : [])];
      charSel.innerHTML = '<option value="">(跟随当前角色卡)</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    } catch { /* 离线:保留占位 option */ }
  }
  // D-1 对话下拉:/api/parts/shells:chat/getchatlist(每条 {chatid,primaryCharName,customName,firstUserMessage}),label=[角色] 对话名
  if (chatSel) {
    try {
      // 原 raw GET getchatlist + r.ok 手检 → 复用 getChatList；!ok 由门面抛错走 catch（离线保留占位）
      const arr = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
      {
        // bot 对话滤除（凛倾 07-09 屏蔽全入口；本下拉不走 chatBelongsToChar 单源，单独补）0715:符号单源
        const list = (Array.isArray(arr) ? arr : []).filter(c => !(c.customName || "").startsWith(BOT_CHAT_SYMBOL));
        // 占位对齐 0722 框架决策(跟随当前对话已删,缺省=自动专门陪伴对话;此前残留"(用当前对话)"=已删语义的假标签)
        chatSel.innerHTML = '<option value="">(自动专门陪伴对话)</option>' + list.map(c => {
          const _label = c.customName || c.firstUserMessage || c.chatid;
          const _pfx = c.primaryCharName ? `[${c.primaryCharName}] ` : "";
          return `<option value="${esc(c.chatid)}">${esc(_pfx + _label)}</option>`;
        }).join("");
      }
    } catch { /* 离线:保留占位 option */ }
  }
  // 回填 game_companion_config.json 已存的 D-1 bindChar/bindChat/bindMode
  try {
    // 原 POST setdata {_action:getGameCompanionConfig} → memory 通配路由；!ok 由门面抛错走 catch（无已存配置用默认）
    const cfg = await sendAction({ verb: "getGameCompanionConfig", target: "plugins:beilu-memory", source: "web" });
    {
      if (charSel && cfg.bindChar) charSel.value = cfg.bindChar;
      if (chatSel && cfg.bindChat) chatSel.value = cfg.bindChat;
      const _mode = (cfg.bindMode === "independent") ? "independent" : "follow";
      if (modeSel) modeSel.value = _mode;
      // B2-4 频率自适应倍率回填
      const _sm = document.getElementById("comp-silence-mult"); if (_sm && cfg.silenceMultiplier != null) _sm.value = cfg.silenceMultiplier;
      const _cm = document.getElementById("comp-close-mult"); if (_cm && cfg.closeMultiplier != null) _cm.value = cfg.closeMultiplier;
      const _mi = document.getElementById("comp-max-interval-min"); if (_mi && cfg.maxIntervalMin != null) _mi.value = cfg.maxIntervalMin;
    }
  } catch { /* 无已存配置, 用默认 */ }
  // 回填截图频率 (eye_config.json, 与截图设置面板双读同源)
  try {
    // 原 raw GET /api/eye/config + er.ok 手检 → 门面 getEyeConfig；!ok 由门面抛错走 catch（用默认 30）
    const ec = await sendAction({ verb: "getEyeConfig", target: "server:eye", source: "web" });
    if (freqIn) { const _cf = Number(ec.captureFrequency); freqIn.value = Number.isFinite(_cf) ? _cf : 30; }
  } catch { /* 用默认 30 */ }
}

export {
  configureCompanionRendererLoader,
  initCompanionActivityBar,
  refreshCompanionRendererSettings,
  setCompanionRendererState,
};
