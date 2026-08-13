/**
 * subModePanel.mjs — 子模式系统（K2/K4，编程/工作双轨）
 *
 * 功能链：
 *   initSubModeBar → （旧底部触发栏注入已停用：_injectTriggerBar 空返）；现役子模式选择器
 *     =_injectTopBar 注入 #submode-top-bar 于 .chat-input-wrapper 正上方（凛倾2026-07-09 移位，原 T015 顶部位废）
 *     → work/code 点触发栏 → 弹出向上浮层 → 列出本 modeGroup 的子模式（chat/AIRP 只显预设名不弹列表）
 *     → 点某子模式 → _activateSubMode → POST setdata {_action:"setActiveSubMode", id}
 *       → 后端切换预设+API 源 → _resetRuntimeParamsSampling（重置采样参数到哨兵值）
 *       → 派发 beilu:subModeSwitched 事件（pipelinePanel/workPanel 消费）
 *   initSubModeManagePanel → IDE 活动栏管理面板 → 增/删/改/排序子模式配置
 *     → POST beilu-memory setdata {_action:"saveSubModes"} → 持久化
 *   listFlowGroups → 加载 skill 组列表 → 右栏展示该组子模式 → 可启动 skill 组流水线
 *
 * why（子模式切换时重置采样参数）：
 *   不同子模式（确认师/代码专家）需要不同预设，切换时必须清除前一个子模式可能残留的
 *   temperature/top_p 覆盖，否则下一个子模式的预设基线参数被污染。
 *   哨兵值（-1/null/0）让后端知道"使用预设默认值"而非"用户显式设了 0"。
 *
 * 关联链：
 *   → shared/transport/sendAction.mjs（T6b：出向统一门面；后端子模式配置读写）
 *   → panels/feature/featureControls.mjs getCurrentMode（区分 code/work modeGroup）
 *   → shared/widgets/beiluDialog.mjs beiluConfirm/beiluPrompt（子模式删除/重命名确认）
 *   ← pipelinePanel.mjs（监听 beilu:subModeSwitched 更新流水线进度）
 *   ← workPanel.mjs（监听 beilu:subModeSwitched 刷新工作面板）
 *   ← layout.mjs（初始化时调用 initSubModeBar / initSubModeManagePanel）
 *
 * 影响范围：
 *   子模式栏 DOM（#submode-top-bar，输入框正上方）、#ide-submode-manage-panel、
 *   后端 beilu-memory sub_modes 配置（saveSubModes 持久化）、
 *   全局采样参数（window._beiluSyncRuntimeParams 或直接 POST runtime-params）。
 *
 * 使用效果：
 *   点顶部子模式栏 → 弹出子模式列表 → 点切换 → 预设+API 立刻切换，采样参数自动归位；
 *   管理面板可增删改子模式，调整预设名/API 源/启用状态，保存后全局生效。
 */

import { getCurrentMode, getWindowInstanceToken } from "../feature/featureControls.mjs"; // [D3 0804] switchModeTo 已不再引：跨组切换收口后端 activateSubMode verb 内部重入 switchMode 管线；[0808] getWindowInstanceToken=跨组切换回流的本窗识别令牌
import { showToast as _toast } from "../../../../../../scripts/toast.mjs"; // 0716 轮子收口：toast 权威单源（原走 _beiluPublicShowToast 二级窗口桥+手绘 DOM 降级=第二套 toast UI）
import { TAB_TO_MODE, PRESET_INHERIT_LABEL, MODEL_SOURCE_DEFAULT_LABEL } from "../../shared/state/modeTabMap.mjs"; // tab→mode 单一权威（禁内联第二张映射表,T-3教训）；PRESET_INHERIT_LABEL=未绑定预设文案单源 [D6 0713]；MODEL_SOURCE_DEFAULT_LABEL=源默认模型选项文案单源 [0716]
import { escapeHtml as _esc, formatRelativeTime as _relTime } from "../../shared/state/utils.mjs"; // [合并批 0714] _relTime 手抄副本删除 → utils 单源（别名保调用点）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b: 出向统一门面（verb=真动作；apiFetch 经门面内部走）
import { applyParamSchemaToInputs } from "../../shared/state/paramSchemaCache.mjs"; // 链路2：参数控件值域后端单源覆盖
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { enableDragAutoScroll } from "../../shared/widgets/dragAutoScroll.mjs"; // 0722：拖拽排序中 wheel 被浏览器抑制→边缘自动滚动
import { promptFlowGroupModelChange } from "../../shared/widgets/flowGroupModelDialog.mjs"; // 组级源/模型更改（与 websocket 建组通知弹窗共用流程，操作闭环）
import { compareConvOrder, fetchChatList, switchToChat } from "../../shared/chat-core/conversationManager.mjs"; // compareConvOrder=排序单源（0715 散点合并，原本地手抄副本漏判 starred）
import { ENUM_FALLBACK } from "../../shared/state/enumFallback.mjs"; // 0715 V3 收口：pp/预填充离线退化表单源（原本文件三表+memtool 副本合并）

// ============================================================
// T072a（可操作处禁硬编码）：提示词后处理 / Claude 尾部预填充 模式选项集
// ============================================================
// 链路2扩展（2026-07-09 凛倾「要同步+映射非硬编码」）：选项集权威上移后端 paramSchema.mjs
//   ENUM_SCHEMA（getSubModes 随包下发 enum_schema，_fetchSubModes 存 _enumSchema）——后端是
//   本体与 YonBan（独立仓库，无法 import 本地 mjs）唯一共享通道，权威放前端=跨库副本必漂移。
// 0715 V3 收口：离线退化表原在本文件（ORDER/LABELS/TITLES 三表）与 memtool.mjs（_PSERIES_ENUM_FALLBACK）
//   各持一份等值副本 → 并入 shared/state/enumFallback.mjs 单源（值/文案/拍板注释随迁，一字未改）。
// _enumOptions：schema 有效则用下发选项，否则用共享退化表（同构 {value,label,title} 数组）。
function _enumOptions(key) {
  var d = _enumSchema && _enumSchema[key];
  if (d && Array.isArray(d.options) && d.options.length > 0) return d.options;
  return ENUM_FALLBACK[key] || [];
}
// 生成 <option> 串：options=同构 {value,label,title} 数组（_enumOptions 产出）；
//   opts.emptyValue/emptyLabel 提供时前置一个空/占位默认项（空项=表单自身默认语义，不属于选项集）；
//   opts.selectedValue 提供时给对应 option 加 selected（用于克劳德表单默认选中 strict，保持原默认行为不变）；
//   option.title 存在时加 title（hover 长停留提醒）。
// 用 _esc 转义 label（与本文件其它动态 option 一致），value 为受控枚举字面量无需转义但仍走 _esc 防未来扩展。
function _buildModeOptions(options, opts) {
  var sel = opts && opts.selectedValue;
  var html = "";
  if (opts && opts.emptyValue !== undefined) {
    var eSelAttr = (sel !== undefined && sel === opts.emptyValue) ? " selected" : "";
    html += '<option value="' + _esc(opts.emptyValue) + '"' + eSelAttr + ">" + _esc(opts.emptyLabel || "") + "</option>";
  }
  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    var selAttr = (sel !== undefined && sel === o.value) ? " selected" : "";
    var titleAttr = o.title ? ' title="' + _esc(o.title) + '"' : "";
    html += '<option value="' + _esc(o.value) + '"' + selAttr + titleAttr + ">" + _esc(o.label || o.value) + "</option>";
  }
  return html;
}

// ============================================================
// 状态
// ============================================================

let _subModes = [];
// 链路2扩展：后端 ENUM_SCHEMA 下发缓存（null=未下发，_enumOptions 落静态退化表）
let _enumSchema = null;
let _activeSubModeId = "前置任务专家";
let _activeSubModeWorkId = "work-task-confirm";
let _activeSubModesMap = {};
let _parallelSubModes = [];

// [T047] 走守卫单一权威 getChatId()（sharedState.mjs:108，内含 _CHATID_RE 校验）——
// 非法 hash（分段气泡锚点 comp-seg-bubble 等）返 ""，不再裸读当 chatid 传后端写脏 map key。
// [2026-07-13] 原 `|| window._beiluCurrentChatId` 次级兜底删除：全根 grep 零写点=从未被赋值的幽灵值。
function _getCurrentChatId() {
  // [0727 多窗口] 可见窗口优先：窗口并存后"当前对话"=正在显示的窗口的 chatid
  //   （lineManager._curWinId 单源，经 window._beiluCurWinChatId 桥读）；hash 只在窗口体系
  //   未启用时兜底——切窗口刻意不写 hash（hash 是 20+ 装载消费者的信号，写了=重载）。
  //   本函数是读（顶栏/触发栏显示 _getEffectiveActiveId）写（切子模式落 map key）两侧共用的
  //   "当前对话"单点，升级这一处=显示与落盘全部跟随可见窗口。
  try { const _w = window._beiluCurWinChatId?.(); if (_w) return _w; } catch { /* 桥未载=无窗口 */ }
  return window._beiluGetChatId?.() || "";
}

/**
 * T5：活跃子模式内存态单条切换的唯一写点（纯内存态收口，不改后端交互）。
 *   原 _setActiveSubMode（成功后）与 beilu:subModeSwitched 事件监听器两处同构散写
 *   （按 modeGroup 二选一写 _activeSubModeId/_activeSubModeWorkId + 若 cid 有效写 _activeSubModesMap[cid]），
 *   收成本函数消灭散写点。fetch 初始化（_fetchSubModes 从后端响应整体赋值三变量）语义不同（批量播种），另留原地。
 * @param {string} modeGroup "work" 走 work 线，其余走 code 线
 * @param {string} id 目标子模式 id
 * @param {string} cid 当前 chatId（空串则不写 map）
 */
function _writeActiveSubMode(modeGroup, id, cid) {
  if (modeGroup === "work") _activeSubModeWorkId = id;
  else _activeSubModeId = id;
  if (cid) _activeSubModesMap[cid] = id;
}
let _apiSources = [];
let _aiSetupStatus = null;
let _popupOpen = false;
let _popupTarget = "conv"; // "conv" | "api" | "model"
let _editingModeId = null;
let _presetList = [];
let _manageTab = "code"; // "code" | "work" — 管理面板当前标签页
let _skillGroups = []; // skill 组列表（从后端 listFlowGroups 加载）
let _selectedGroupFn = null; // 当前选中的组 filename（右栏显示其子模式）
// [0722 skill组隔离·每窗独立链路] 本窗有效选中组镜像 {code:<filename>, work:<filename>}——
//   后端权威落盘 _work_config.selected_groups_map（窗口层[chatid]→"_default"用户长期层，
//   写点 setSelectedFlowGroup/startFlowGroup 双层写），listFlowGroups 按请求 chatid 解析好下发
//   （同 effective_sub_modes 范式，前端零层级解析）。
//   消费：①左栏选中恢复（刷新不丢）②顶栏子模式列表按组过滤（与后端宏清单/AI 切换域同构）。
let _selectedGroups = {};

/**
 * 子模式切换后，将子模式的采样参数覆盖值叠加到 slider UI 上。
 * why: syncModelParamsUI 只显示预设层值，子模式覆盖（per-round extension）不反映。
 *   用户看 slider 0.7 实际生成用 0.3（子模式覆盖）→ 所见非所得。
 */
function _overlaySubModeParamsUI(mode) {
  if (!mode) return;
  if (mode.temperature !== undefined && mode.temperature >= 0) {
    var el = document.getElementById("param-temp");
    var vl = document.getElementById("param-temp-value");
    if (el) el.value = mode.temperature;
    if (vl) vl.textContent = parseFloat(mode.temperature).toFixed(2);
  }
  if (mode.maxContext && mode.maxContext > 0) {
    var mc = document.getElementById("param-max-context");
    if (mc) mc.value = mode.maxContext;
  }
  if (mode.maxTokens && mode.maxTokens > 0) {
    var mt = document.getElementById("param-max-tokens");
    if (mt) mt.value = mode.maxTokens;
  }
}

/**
 * 重置 runtimeParams 采样参数到哨兵值（使用预设基线）。
 * 子模式切换时调用——清除前一个子模式可能残留的 temperature/top_p 等覆盖。
 * 哨兵值：temperature/top_p/top_k/min_p=-1, penalty=null, max_tokens/max_context=0。
 * 幂等操作，多次调用无副作用。
 */
function _resetRuntimeParamsSampling() {
  var params = {
    temperature: -1, top_p: -1, top_k: -1, min_p: -1,
    frequency_penalty: null, presence_penalty: null,
    openai_max_tokens: 0, openai_max_context: 0,
  };
  var _syncFn = window._beiluSyncRuntimeParams;
  if (_syncFn) {
    _syncFn(params);
  } else {
    var _chatId = _getCurrentChatId(); // [T047] 守卫单源，非法 hash → "" 不当 chatid 传后端
    params.chatId = _chatId;
    sendAction({ verb: "setRuntimeParams", target: "plugins:beilu-preset", source: "web", payload: params, scope: { chatId: _chatId } }).catch(function (err) { // T6b
      console.warn("[subModePanel] runtimeParams 采样重置失败:", err.message);
    });
  }
}

// ============================================================
// T010 子模式单源：定义唯一源 = 后端 storage.mjs DEFAULT_CODE_SUB_MODES/DEFAULT_WORK_SUB_MODES
// （getSubModes verb 下发；后端对空配置自动播种落盘，正常链路必返回非空）。
// 原 18 个前端定义副本已删——三处副本各自演化（后端 11+11 / 本体 8+10 / YonBan 9）即双源病活体，
// 手工对齐=补丁。取数失败语义：上次成功下发的 localStorage 缓存 → 无缓存 = 明确失败态
// （_subModes 置空 + toast 提示，不拿旧假数据装正常）。
// (陪伴模式不引入子模式 — 凛倾 2026-04-22 决定: AI 自己判断风格 + 用户切顶栏预设)
// ============================================================
const SUBMODES_CACHE_KEY = KEYS.BEILU_SUBMODES_CACHE; // T041b: localStorage key 收编 KEYS 单源（原字面 "beilu-submodes-cache"）

function _readSubModesCache() {
  try {
    const arr = JSON.parse(storage.get(SUBMODES_CACHE_KEY) || "null"); // P2：裸读→门面
    return Array.isArray(arr) && arr.length > 0 ? arr : null;
  } catch (e) { return null; /* 缓存损坏视同无缓存 */ }
}

function _writeSubModesCache(modes) {
  if (!Array.isArray(modes) || modes.length === 0) return;
  storage.set(SUBMODES_CACHE_KEY, JSON.stringify(modes)); // P2：裸写→门面（配额容错在门面内）
}

// ============================================================
// 后端通信
// ============================================================

async function _fetchSubModes() {
  try {
    const data = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web" }); // T6b：!ok 抛错入 catch
    // [T7 日志瘦身] 只记摘要不 dump 整包：原 JSON.stringify(data).substring(0,500) 把模型名/温度/
    //   prefill/preset/backup_api_source 等配置全文刷进运行时日志面板（0727 截图实证，有效行被顶掉）。
    //   排查需要的是"拿到了几个/活跃是谁"，配置内容在管理面板本来就看得到。
    console.log(
      `[subModePanel] getSubModes 返回: ${data?.success ? "success" : "fail"}, sub_modes=${Array.isArray(data?.sub_modes) ? data.sub_modes.length : 0}, active=${data?.active_sub_mode || "-"}, work=${data?.active_sub_mode_work || "-"}`,
    );
    if (data && data.success && Array.isArray(data.sub_modes) && data.sub_modes.length > 0) {
      // T010：后端是唯一定义源（空配置后端自动播种，正常必非空）；成功即刷新"上次成功"缓存
      _subModes = data.sub_modes;
      _writeSubModesCache(_subModes);
      // 链路2扩展（2026-07-09）：pp/预填充选项集权威随包下发（paramSchema.mjs ENUM_SCHEMA），
      //   表单 option 渲染优先用它；本模块 T072a 静态表降级为离线退化副本
      if (data.enum_schema && typeof data.enum_schema === "object") _enumSchema = data.enum_schema;
      // T5：初始化批量播种（从后端响应整体赋值三变量+整体重置 map），语义异于单条切换，
      //   不套 _writeActiveSubMode（那是按 modeGroup 二选一的单条写）；此处两活跃线同时来+map 全量替换。
      _activeSubModeId = data.active_sub_mode || "前置任务专家";
      _activeSubModeWorkId = data.active_sub_mode_work || "work-task-confirm";
      _activeSubModesMap = data.active_sub_modes_map || {};
      _parallelSubModes = Array.isArray(data.parallel_sub_modes) ? data.parallel_sub_modes : [];
      _renderParallelChips();
      console.log(
        "[subModePanel] 加载了",
        _subModes.length,
        "个子模式, code活跃:",
        _activeSubModeId,
        "work活跃:",
        _activeSubModeWorkId,
        "并行:",
        _parallelSubModes.length,
      );
      return true;
    } else {
      console.warn(
        "[subModePanel] getSubModes 返回 success=false/空集:",
        data,
      );
    }
  } catch (e) {
    console.warn("[subModePanel] 加载子模式失败:", e.message);
  }
  // T010 失败语义：上次成功下发的缓存 → 无缓存=明确失败态（空集+提示），不拿旧副本装正常
  const _cached = _readSubModesCache();
  if (_cached) {
    _subModes = _cached;
    console.warn("[subModePanel] 使用上次成功下发的本地缓存:", _cached.length, "个");
  } else {
    _subModes = [];
    try { _showToast("❌ 子模式加载失败（后端不可达且无本地缓存）"); } catch (e2) { /* toast 未就绪不阻塞 */ }
  }
  return false;
}

async function _saveSubModes(modes) {
  try {
    // unwrap 仅 dispatch 层异常(ok:false)抛；业务级 success:false 经桥恒 HTTP 200+ok:true 不抛不入
    //   catch（2026-07-15 校准，见契约扫描留决12）——[D3 0804] 故必须显式校验 data.success，失败不更新本地。
    var data = await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: modes } });
    if (!data || data.success === false) {
      console.warn("[subModePanel] 保存子模式业务失败:", data && (data.error || data.code));
      return false;
    }
    _subModes = modes;
    // [D3 0804] 悬空预设引用可见提示（后端契约：配置已保存但引用的非 builtin 预设不存在，禁造骨架
    //   只回清单）：用户需在预设面板创建同名预设或改选，否则该子模式生成时预设回退基线。
    if (data.code === "E_PRESET_REFERENCE_MISSING" && Array.isArray(data.invalid_preset_references) && data.invalid_preset_references.length) {
      var _refs = data.invalid_preset_references.map(function (r) { return (r.id || "?") + " → " + (r.presetName || "?"); }).join("、");
      try { _showToast("⚠️ 已保存，但引用的预设不存在（未自动创建）: " + _refs, 5000); } catch (e2) { /* toast 未就绪不阻塞 */ }
    }
    return true;
  } catch (e) {
    console.warn("[subModePanel] 保存子模式失败:", e.message);
  }
  return false;
}

// ★ 单一权威写回（语义同构 YonBan F1 _writeBackToActiveSubMode，§三不变式1）：
//   把字段写回当前 activeSubMode（sub_modes[]），不另起第二份状态。
//   model 走 model_params.model 副本为权威（B18，对齐 getPromptHandler.mjs:166
//   `_mp.model ?? _activeSM.modelName`），同时回写扁平 modelName 作回退。
//   乐观更新带 Drift 回滚（参 :1058 教训：必须看 _saveSubModes 返回值，
//   后端非2xx 时还原内存值并提示）。返回 true=写回+落盘成功。
async function _writeBackToActiveSubMode(fields) {
  var modes = _subModes && _subModes.length > 0 ? _subModes : null;
  if (!modes) return false;
  var effId = _getEffectiveActiveId();
  var sm = modes.find(function (m) { return m.id === effId; });
  if (!sm) return false;
  // 快照用于回滚
  var _prev = {};
  for (var k in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
    if (k === "model") {
      _prev._mpModel = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params.model : undefined;
      if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
      sm.model_params.model = fields.model;
    } else if (k === "api_source") {
      // 补修（顶栏 api_source latent 不对称收口）：对齐 model 副本双写范式。读侧 getPromptHandler:300
      //   优先 _mp.api_source（B18 副本权威），若只写扁平 apiSource（else 分支），子模式已带 model_params
      //   时旧 _mp.api_source 会盖回顶栏新选源（顶栏切模型/AIRP 逆同步:3182 均建 model_params）。
      //   故 api_source key 走对象副本，扁平 apiSource 由调用处同传（:1184）→ 与逆同步 :3181-3183 对称。
      _prev._mpApiSource = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params.api_source : undefined;
      if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
      sm.model_params.api_source = fields.api_source;
    } else {
      _prev[k] = sm[k];
      sm[k] = fields[k];
    }
  }
  var ok = await _saveSubModes([].concat(modes));
  if (!ok) {
    // 回滚
    for (var k2 in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, k2)) continue;
      if (k2 === "model") {
        if (sm.model_params && typeof sm.model_params === "object") sm.model_params.model = _prev._mpModel;
      } else if (k2 === "api_source") {
        if (sm.model_params && typeof sm.model_params === "object") sm.model_params.api_source = _prev._mpApiSource;
      } else {
        sm[k2] = _prev[k2];
      }
    }
    window._beiluToast?.("子模式保存失败，已回滚", "error");
  }
  return ok;
}

function _renderParallelChips() {
  var container = document.getElementById("parallel-chips");
  if (!container) return;
  if (!_parallelSubModes.length) { container.innerHTML = ""; return; }
  container.innerHTML = _parallelSubModes.map(function(p) {
    return '<span style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:10px;background:rgba(79,195,247,0.15);color:color-mix(in oklch, var(--beilu-accent, #4fc3f7) 55%, var(--color-base-content));font-size:0.65rem;white-space:nowrap;">' +
      _esc(p.icon || "") + _esc(p.label || p.id) +
      '<span class="parallel-remove" data-pid="' + _esc(p.id) + '" style="cursor:pointer;opacity:0.6;margin-left:2px;" title="移除">×</span>' +
      '</span>';
  }).join("");
  container.querySelectorAll(".parallel-remove").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      _removeParallelSubMode(btn.dataset.pid);
    });
  });
}

async function _addParallelSubMode(id) {
  try {
    var data = await sendAction({ verb: "addParallelSubMode", target: "plugins:beilu-memory", source: "web", payload: { id } }); // T6b
    if (data.parallel_sub_modes) _parallelSubModes = data.parallel_sub_modes;
    _renderParallelChips();
  } catch (e) { console.warn("[subModePanel] addParallel 失败:", e.message); }
}

async function _removeParallelSubMode(id) {
  try {
    var data = await sendAction({ verb: "removeParallelSubMode", target: "plugins:beilu-memory", source: "web", payload: { id } }); // T6b
    if (data.parallel_sub_modes) _parallelSubModes = data.parallel_sub_modes;
    _renderParallelChips();
  } catch (e) { console.warn("[subModePanel] removeParallel 失败:", e.message); }
}

// [D3 0804] 激活成功后的本地镜像（_setActiveSubMode 与 _switchToSubMode 单请求路径共用，单函数收口）：
//   活跃态收口写 + 采样哨兵重置 + 缓存失效 + subModeSwitched 事件补发。
//   事件补发理由（0727 事件生产端补齐·凛倾实测"预设浮层两处显示打架"）：手动路径原只清自己可见的
//   两个缓存不广播事实，其他消费者（preset.mjs _smCache、订阅面板）靠事件失效——AI 驱动/workPanel/
//   skill 组三条路径本就走事件，手动缺席=同一事实两套通路。本模块监听器收到后做同值幂等写入+刷新，
//   无副作用无自激（监听器不再派发）。
function _applySubModeSwitchLocal(id, chatId) {
  var mode = _subModes.find(function (m) { return m.id === id; });
  // T5：活跃态单条切换走收口写函数（原按 modeGroup 分支散写 3 变量，与事件监听器同构）
  _writeActiveSubMode((mode && mode.modeGroup) || "code", id, chatId);
  // ★ [0716 散写收口] 原五键 runtime 推送（prompt_post_processing/prefill_enabled/claude_prefill_mode/
  //   model/api_source）删除：这些值后端每轮从 sub_modes 权威 per-request 解析（getPromptHandler B18
  //   副本优先 → mergeRuntimeParams 子模式 ext 最高优先级，跨组原子清零），推进 runtime-params=影子写——
  //   ①与生成无关（ext 恒压过 runtime）②落盘持久且无哨兵清除，切到无绑定子模式/chat 后残留生效=跨模式污染
  //   ③runtime 这几个键的合法生产者是 featureControls 全局设置面板（用户全局选择），子模式切换推送会盖掉用户设置。
  //   剩余的采样哨兵重置与事件路径同构 → 收口 _resetRuntimeParamsSampling 单源（原内联副本删除）。
  if (mode) _resetRuntimeParamsSampling();
  try { if (window._beiluInvalidatePresetCache) window._beiluInvalidatePresetCache(); } catch {}
  try { if (window._beiluInvalidateModelCache) window._beiluInvalidateModelCache(); } catch {}
  window.dispatchEvent(new CustomEvent("beilu:subModeSwitched", {
    detail: { to: id, label: (mode && (mode.label || mode.id)) || id, modeGroup: (mode && mode.modeGroup) || "code", chatId: chatId },
  }));
  return mode;
}

async function _setActiveSubMode(id) {
  try {
    var data = await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { id, chatId: _getCurrentChatId() } }); // T6b：!ok 抛错入 catch → return false
    // [D3 0804] 业务级 success:false 经桥恒 HTTP 200+ok:true 不抛（2026-07-15 校准）：core fail-closed
    //   拒绝（chat 未知/子模式不存在）必须显式校验——失败不更新本地镜像，可见提示不静默装成功。
    if (!data || data.success === false) {
      console.warn("[subModePanel] 设置活跃子模式业务失败:", data && (data.error || data.code));
      window._beiluToast?.("子模式激活被拒绝: " + ((data && data.error) || "未知错误"), "error");
      return false;
    }
    _applySubModeSwitchLocal(id, _getCurrentChatId());
    return true;
  } catch (e) {
    console.warn("[subModePanel] 设置活跃子模式失败:", e.message);
    return false;
  }
}

async function _fetchSkillGroups() {
  try {
    var data = await sendAction({ verb: "listFlowGroups", target: "plugins:beilu-memory", source: "web" }); // T6b
    _skillGroups = (data && data.groups) || [];
    _selectedGroups = (data && data.selected_groups) || {}; // [0722 skill组隔离] 长期选中组镜像
  } catch (e) {
    console.warn("[subModePanel] 加载 skill 组失败:", e.message);
    _skillGroups = [];
  }
}

/**
 * [0722 skill组隔离] 选中组持久化写点（点选组/启动组两入口共用镜像更新；启动的后端落盘
 * 由 startFlowGroup 自带，仅点选走本 verb）。失败仅告警——选中的会话内效果（右栏/顶栏过滤）
 * 已由内存镜像生效，丢的只是刷新恢复。
 */
async function _persistSelectedGroup(group) {
  if (!group) return;
  var mg = group.modeGroup || "code";
  _selectedGroups[mg] = group.filename;
  if (_topOpen) _renderTopModeList(); // 顶栏列表开着时立即按新组过滤
  try {
    var data = await sendAction({ verb: "setSelectedFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename: group.filename, modeGroup: mg } }); // T6b
    if (!data || !data.success) throw new Error((data && data.error) || "后端未受理");
  } catch (e) { console.warn("[subModePanel] 选中组持久化失败:", e.message); }
}

async function _fetchApiSources({ force = false } = {}) {
  try {
    // 本窗口刚保存 API 时没有等待 WebSocket 回显；先主动失效 10 秒列表缓存，避免表单继续显示旧源。
    if (force) window._beiluInvalidateApiSources?.();
    var fn = window._beiluGetApiSources;
    if (fn) { _apiSources = await fn(); return; }
    const list = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" }); // T6b
    _apiSources = Array.isArray(list)
      ? list.map(function (s) { return typeof s === "string" ? s : s.name || s.id || String(s); })
      : [];
  } catch (e) {
    _apiSources = [];
  }
}

async function _fetchAISetupStatus() {
  try {
    _aiSetupStatus = await sendAction({ verb: "getAISetupStatus", target: "shells:serviceSourceManage", source: "web" });
  } catch (e) {
    // 不能把状态请求失败伪装成“没有 API”；引导会明确显示无法确认。
    _aiSetupStatus = { status: "unknown", configured: false };
    console.warn("[subModePanel] 获取 AI 配置状态失败:", e.message);
  }
  return _aiSetupStatus;
}

async function _fetchPresetList() {
  try {
    var fn = window._beiluGetPresetData;
    var data = fn ? await fn() : null;
    if (!data) { try { data = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" }); } catch { data = null; } } // T6b
    // 预设链修（凛倾07-05"绑定预设名下拉空"确诊）：原失败清空=一次init失败下拉永久定格空；
    // 改为只有真拿到数组才覆盖，失败保留旧列表（失败可见由 sendAction 门面 _report 承担）
    if (data && Array.isArray(data.preset_list)) _presetList = data.preset_list;
  } catch (e) {
    /* 保留旧 _presetList（同上，不清空） */
  }
}

// ============================================================
// 工具函数
// ============================================================

function _getEffectiveActiveId() {
  var chatId = _getCurrentChatId();
  if (chatId && _activeSubModesMap[chatId]) return _activeSubModesMap[chatId];
  var rawMode = typeof getCurrentMode === "function" ? (getCurrentMode() || "code") : "code";
  var beiluMode = (rawMode === "chat" || rawMode === "file") ? "code" : rawMode;
  // 带 chatId 但本对话无记录：从流水线起点开始，不回退到全局 active_sub_mode
  // （全局可能卡在 code-expert，会让每次刷新都跳到代码专家、循环失效）
  if (chatId) return beiluMode === "work" ? "work-task-confirm" : "前置任务专家";
  return beiluMode === "work" ? _activeSubModeWorkId : _activeSubModeId;
}

function _getActiveMode() {
  var effectiveId = _getEffectiveActiveId();
  return (
    _subModes.find(function (m) {
      return m.id === effectiveId;
    }) ||
    _subModes[0] ||
    null
  );
}

// ============================================================
// [0716 散写收口·生效绑定视图] 底栏模型选择器桥
// ============================================================
// why：底栏选择器（extendMenuW28, shared 层）原纯镜像全局 #api-model——work/code 下生成实际用
//   子模式绑定（后端每轮 per-request 解析），选择器显示/可选列表/写回全落在全局层=所见非所用、
//   选择静默无效。凛倾 0716「work和code都是子模式为主，对话这里要跟着子模式走」。
// 层向约束 shared 不 import panels → window 桥（同 _beiluSyncRuntimeParams 范式）。
// 判定与后端生成真值同源（getPromptHandler：resolveActiveSubModeId + modeGroup===当前模式 跨组原子清零；
//   值取 model_params 副本优先，容忍驼峰别名，与 :283-306 读法对齐）。
/** @returns {null|{id,label,source,model}} null=全局作用域（chat/smart/bot/跨组/无绑定） */
window._beiluResolveSubModeBinding = function () {
  var raw = typeof getCurrentMode === "function" ? (getCurrentMode() || "code") : "code";
  // file 是前端 tab，后端模式=code（TAB_TO_MODE 域）；chat 不映射——后端 chat 模式下子模式覆盖被跨组清零
  var group = raw === "file" ? "code" : raw;
  if (group !== "work" && group !== "code") return null;
  var m = _getActiveMode();
  if (!m || (m.modeGroup || "code") !== group) return null;
  var mp = (m.model_params && typeof m.model_params === "object") ? m.model_params : null;
  var model = mp ? (mp.model ?? mp.modelName ?? m.modelName ?? "") : (m.modelName || "");
  var source = mp ? (mp.api_source ?? mp.apiSource ?? m.apiSource ?? "") : (m.apiSource || "");
  if (!model && !source) return null; // 零绑定子模式=全局基线，选择器维持全局视图
  return { id: m.id, label: m.label || m.id, source: source, model: model };
};
/** 底栏选择器在子模式作用域下的写回：与触发栏模型弹窗同写点（_writeBackToActiveSubMode 双写范式+回滚） */
window._beiluWriteSubModeModel = async function (model) {
  var ok = await _writeBackToActiveSubMode({ modelName: model, model: model });
  if (ok) {
    _updateTriggerBar();
    _renderManageList();
  }
  return ok;
};

// ============================================================
// Toast 通知
// ============================================================

// 0716 轮子收口：薄转调 toast.mjs 单源（同 memoryBrowser D1 先例）。原 _beiluPublicShowToast 二级桥
//   +手绘 DOM 降级已删——本文件是 ESM 且已 import featureControls，走窗口桥无依赖上的必要性；
//   toast.mjs 无依赖底层，import 即可用，降级分支运行期不可达=死代码+第二套 toast UI。
function _showToast(message, duration) {
  _toast("info", message, duration || 2500);
}

// ============================================================
// CSS 注入
// ============================================================

function _injectStyles() {
  if (document.getElementById("submode-panel-styles")) return;
  const style = document.createElement("style");
  style.id = "submode-panel-styles";
  style.textContent = `
/* ---- 管理面板标签页 ---- */
.submode-manage-tab {
  flex: 1;
  padding: 6px 0;
  font-size: 12px;
  font-weight: 500;
  text-align: center;
  cursor: pointer;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: oklch(var(--bc) / 0.65);
  transition: all 0.15s;
}
.submode-manage-tab:hover {
  color: oklch(var(--bc) / 0.7);
  background: oklch(var(--b2));
}
.submode-manage-tab.active {
  color: oklch(var(--wa));
  border-bottom-color: oklch(var(--wa));
}

/* ---- 底部触发栏 ---- */
.submode-trigger-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 8px;
  background: oklch(var(--b2));
  border-top: 1px solid oklch(var(--b3));
  font-size: 11px;
  user-select: none;
  flex-shrink: 0;
}
.submode-trigger-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: none;
  color: oklch(var(--bc));
  font-size: 11px;
  transition: background 0.15s;
}
.submode-trigger-btn:hover {
  background: oklch(var(--b3));
}
.submode-chevron {
  font-size: 8px;
  opacity: 0.5;
}
.submode-trigger-sep {
  width: 1px;
  height: 14px;
  background: oklch(var(--b3));
  margin: 0 2px;
}

/* ---- 弹出层 ---- */
/* C2/C3 修复：不再使用 fixed overlay，改用 document click 检测 */
.submode-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 320px;
  background: oklch(var(--b1));
  border: 1px solid oklch(var(--b3));
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  box-shadow: 0 -4px 16px rgba(0,0,0,0.15);
  z-index: var(--z-popup);
  display: flex;
  flex-direction: column;
  animation: submode-slide-up 0.15s ease-out;
}
@keyframes submode-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.submode-popup-search {
  margin: 0 8px 4px;
  padding: 5px 8px;
  border: 1px solid oklch(var(--b3));
  border-radius: 4px;
  background: oklch(var(--b2));
  color: oklch(var(--bc));
  font-size: 12px;
  outline: none;
}
.submode-popup-search:focus {
  border-color: oklch(var(--p));
}
.submode-popup-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.submode-popup-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s;
}
.submode-popup-item:hover {
  background: oklch(var(--b2));
}
.submode-popup-item-active {
  background: oklch(var(--p) / 0.1);
}
.submode-popup-item-icon {
  font-size: 14px;
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}
.submode-popup-item-info {
  flex: 1;
  min-width: 0;
}
.submode-popup-item-label {
  font-size: 12px;
  font-weight: 500;
  display: block;
}
.submode-popup-item-desc {
  font-size: 10px;
  color: oklch(var(--bc) / 0.5);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.submode-popup-item-check {
  color: oklch(var(--su));
  font-size: 12px;
  flex-shrink: 0;
}
.submode-popup-empty {
  text-align: center;
  padding: 16px;
  font-size: 11px;
  color: oklch(var(--bc) / 0.55);
}

/* ---- 管理面板 ---- */
.submode-manage-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
}
.submode-manage-item:hover {
  background: oklch(var(--b3) / 0.6);
}
.submode-manage-item:hover .submode-manage-actions {
  opacity: 1;
}
.submode-manage-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

/* ---- 编辑表单竖排修复 ---- */
.submode-edit-form-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.submode-edit-form-fields .form-control {
  width: 100%;
}
.submode-form-icon-name-row {
  display: flex;
  gap: 6px;
  align-items: flex-end;
}
.submode-form-icon-name-row .form-control:first-child {
  width: 56px;
  flex-shrink: 0;
}
.submode-form-icon-name-row .form-control:last-child {
  flex: 1;
}

/* ---- Toast 通知：.submode-toast 样式已随手绘 toast 删除（0716 收口 toast.mjs 单源）---- */

/* ---- 子模式选择器（凛倾2026-07-09：移到输入对话框正上方,颜色与对话框一致,减填充；原 T015 顶部位已废） ---- */
#submode-top-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 1px 6px; flex-shrink: 0;
  /* 负 margin-bottom 吃掉 .chat-input-wrapper 的 margin-top(0.5rem)，留 2px 视觉贴合成一体 */
  margin: 0 1rem -6px;
  border: 1px solid var(--beilu-amber-15);
  border-radius: 10px;
  background: var(--color-base-200); /* 同 .chat-input-wrapper 底色 */
  font-size: 12px; user-select: none;
  position: relative;
}
body:not([data-active-tab="chat"]):not([data-active-tab="files"]):not([data-active-tab="work"]) #submode-top-bar,
body:not([data-active-tab="chat"]):not([data-active-tab="files"]):not([data-active-tab="work"]) #submode-top-list { display: none !important; }
/* chat(AIRP)：只显预设名不弹工作流列表 → 去箭头/去可点态 */
body[data-active-tab="chat"] #submode-top-bar .stb-arrow { display: none; }
body[data-active-tab="chat"] .stb-mode-btn { cursor: default; }
body[data-active-tab="chat"] .stb-mode-btn:hover { background: transparent; }
.stb-mode-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 10px 2px 6px; border-radius: 5px;
  background: transparent; border: none;
  /* on-base 文字用 --beilu-amber-fg（amber-text 是 accent 实色底上的反色，浅主题=近白，贴 base-200 不可见） */
  color: var(--beilu-amber-fg, var(--beilu-amber-text)); font-weight: 500; font-size: 12px;
  cursor: pointer; transition: 0.12s;
}
.stb-mode-btn:hover { background: var(--beilu-amber-15); }
.stb-mode-btn .stb-arrow { font-size: 8px; opacity: 0.45; }
#submode-top-list {
  max-height: 320px; overflow-y: auto; flex-shrink: 0;
  background: var(--color-base-200); border: 1px solid var(--beilu-amber-25);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  padding: 4px 8px;
  /* 栏移到输入框上方后列表向上展开（锚定 bar，列表挂 bar 内） */
  position: absolute; bottom: calc(100% + 4px); left: 0; right: 0; z-index: 100;
}
#submode-top-list .submode-popup-item { margin: 1px 0; }
  `;
  document.head.appendChild(style);
}

// ============================================================
// DOM 注入
// ============================================================

let _triggerBarEl = null;
let _popupEl = null;

// BUG-04: 综合显示条件 — 不仅看CSS class，还看模式和IDE连接状态
function _shouldShowTriggerBar(chatCont) {
  var mode = typeof getCurrentMode === "function" ? getCurrentMode() : "";
  var isCompact = chatCont && chatCont.classList.contains("compact-chat");
  return mode === "code" || mode === "work" || mode === "file" || isCompact;
}

function _injectTriggerBar() {
  return;
  const chatContainer = document.getElementById("chat-container");
  if (!chatContainer) return;

  // W40修复：HTML class 是 .chat-input-wrapper
  const inputArea = chatContainer.querySelector(".chat-input-wrapper");

  // 创建触发栏容器（包含触发栏 + 弹出层）
  const wrapper = document.createElement("div");
  wrapper.id = "submode-trigger-wrapper";
  // C2/C3 修复：给 wrapper 设置 z-index，确保弹出层在所有元素之上
  // D6 修复：初始隐藏，只在 IDE 模式（files/memory）下显示
  wrapper.style.cssText =
    "position: relative; flex-shrink: 0; z-index: 100; display: none;";

  // 弹出层
  // D1 修复：移除 popup-header（主人不需要标题栏）
  // D2 修复：用 style.display 控制显隐，避免 CSS display:flex 覆盖 .hidden 的 display:none
  _popupEl = document.createElement("div");
  _popupEl.id = "submode-popup";
  _popupEl.className = "submode-popup";
  _popupEl.style.display = "none";
  _popupEl.innerHTML =
    '<input type="text" class="submode-popup-search" id="submode-popup-search" placeholder="搜索子模式..." />' +
    '<div class="submode-popup-list" id="submode-popup-list"></div>';

  // 触发栏：对话文件选择 + API源 + 模型
  _triggerBarEl = document.createElement("div");
  _triggerBarEl.id = "submode-trigger-bar";
  _triggerBarEl.className = "submode-trigger-bar";
  _triggerBarEl.innerHTML =
    '<button id="conv-trigger-btn" class="submode-trigger-btn" title="切换对话">' +
    '<span class="submode-chevron">▲</span>' +
    '<span id="conv-trigger-icon"><i data-ic="message"></i></span>' +
    '<span id="conv-trigger-label" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>' +
    "</button>" +
    // 重复id根修 2026-07-06：原 id="conv-new-btn" 与 index.html:1471 IDE对话历史静态按钮同id（HTML违规）。
    // 此前靠"触发栏插在 chat-input-wrapper 前=文档序在前"偶然让 getElementById 命中本按钮；
    // 一旦懒加载/结构调整令静态按钮在前，绑定会静默落到IDE按钮（叠上 conversationManager [data-conv-new] handler=一次点击建两个对话）。改独立id断根。
    '<button id="submode-conv-new-btn" class="submode-trigger-btn" title="新建对话" style="padding:0 6px;font-size:14px;opacity:0.6;">+</button>' +
    '<span class="submode-trigger-sep"></span>' +
    '<button id="submode-api-trigger" class="submode-trigger-btn" title="切换 API 源（写回当前子模式）">' +
    '<span class="submode-chevron">▲</span>' +
    '<span id="submode-api-label"></span>' +
    "</button>" +
    '<span class="submode-trigger-sep"></span>' +
    '<button id="submode-model-trigger" class="submode-trigger-btn" title="切换模型（写回当前子模式）">' +
    '<span class="submode-chevron">▲</span>' +
    '<span id="submode-model-label"></span>' +
    "</button>";

  wrapper.appendChild(_popupEl);
  wrapper.appendChild(_triggerBarEl);

  // 插入位置：优先在 inputArea 前，否则追加到 chatContainer 末尾
  if (inputArea) {
    chatContainer.insertBefore(wrapper, inputArea);
  } else {
    console.warn(
      "[subModePanel] 未找到 .chat-input-wrapper 元素, wrapper 追加到 chatContainer 末尾",
    );
    chatContainer.appendChild(wrapper);
  }
}

// ============================================================
// 顶部子模式选择器
// ============================================================

let _topBarEl = null;
let _topListEl = null;
let _topOpen = false;

function _injectTopBar() {
  // 排版（凛倾2026-07-09「把顶部那个移到对话框的上面」，覆盖原 T015 顶部位）：
  // 子模式栏注入 .chat-input-wrapper 正前方；列表挂 bar 内部（bar 自带 position:relative）向上展开。
  // 事件/数据流/显隐 gate 不动。
  var chatContainer = document.getElementById("chat-container");
  if (!chatContainer || document.getElementById("submode-top-bar")) return;

  var bar = document.createElement("div");
  bar.id = "submode-top-bar";
  bar.innerHTML =
    '<button class="stb-mode-btn" id="stb-mode-btn">' +
      '<span id="stb-mode-label">--</span>' +
      '<span class="stb-arrow">▼</span>' +
    '</button>';

  var listEl = document.createElement("div");
  listEl.id = "submode-top-list";
  listEl.style.display = "none";

  bar.appendChild(listEl);
  var inputWrapper = chatContainer.querySelector(".chat-input-wrapper");
  if (inputWrapper) {
    chatContainer.insertBefore(bar, inputWrapper);
  } else {
    chatContainer.insertBefore(bar, chatContainer.firstElementChild);
  }
  _topBarEl = bar;
  _topListEl = listEl;

  bar.querySelector("#stb-mode-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    // 工作流子模式列表只归 work/code（凛倾2026-07-09：AIRP 泄漏 code 组流水线角色=bug）。
    // chat(AIRP) 下本栏只作预设名宣告（_updateTopBar chat 分支），点击不弹列表。
    if (!_workflowGroupFromTab()) return;
    _topOpen ? _closeTopList() : _openTopList();
  });
  document.addEventListener("click", function (e) {
    if (_topOpen && _topBarEl && _topListEl &&
        !_topBarEl.contains(e.target) && !_topListEl.contains(e.target)) {
      _closeTopList();
    }
  });
}

function _openTopList() {
  if (!_topListEl) return;
  _topOpen = true;
  _topListEl.style.display = "";
  _renderTopModeList();
}

function _closeTopList() {
  if (!_topListEl) return;
  _topOpen = false;
  _topListEl.style.display = "none";
}

// 工作流子模式（流水线角色）只归 work/code 两模式（凛倾2026-07-09：AIRP 泄漏 code 组列表=bug）。
// 判据用 data-active-tab 而非 getCurrentMode()：与本文件 CSS 显隐 gate 同源（单一权威）。
// getCurrentMode 是后端模式回声，tab 刚切换/后端残留旧值时有瞬态窗口（tab=chat 而 mode=code），
// 按 mode 判会在窗口期把 code 组列表泄回 AIRP；原 chat→code 硬映射更是稳态泄漏，已删。
// tab→mode 走 modeTabMap.TAB_TO_MODE 权威表（不内联第二张 tab 表）；modeGroup 值域=code/work/all，
// 与 _getEffectiveActiveId :442 同口径。[多窗口审计 2026-07-11 C2] 原 "file" 兼容分支随
// TAB_TO_MODE.files 值 "file"→"code" 三表对齐一并删除（"file" 值全前端不再产出）。
function _workflowGroupFromTab() {
  var mode = TAB_TO_MODE[document.body.dataset.activeTab];
  if (mode === "code") return "code";
  if (mode === "work") return "work";
  return null; // chat(AIRP)/smart/辅助视图：无工作流子模式
}

function _renderTopModeList() {
  if (!_topListEl) return;
  var beiluMode = _workflowGroupFromTab();
  if (!beiluMode) { _closeTopList(); return; }
  var activeId = _getEffectiveActiveId();
  // [0722 skill组隔离] 顶栏候选按当前选中 skill 组过滤（组 steps[].mode 集合），与后端宏清单/
  //   AI 切换域（resolveSkillGroupDomain）同构——用户看到的可选项=AI 被教的=门放行的。
  //   未选过组（selected_groups 空）=维持原 modeGroup 全量，优雅退化不堵死。
  var selFn = _selectedGroups[beiluMode];
  var selGroup = selFn ? _skillGroups.find(function (g) { return g.filename === selFn; }) : null;
  var allowedIds = (selGroup && Array.isArray(selGroup.steps) && selGroup.steps.length)
    ? selGroup.steps.map(function (s) { return s.mode; }).filter(Boolean)
    : null;
  var filtered = _subModes.filter(function (m) {
    if (m.enabled === false) return false;
    var group = m.modeGroup; // [D4 0713] 存储不变式已保证字段必在（getSubModes 迁移+saveSubModes 归一），内联默认删除
    if (group !== beiluMode && group !== "all") return false;
    return !allowedIds || allowedIds.indexOf(m.id) !== -1;
  });
  _topListEl.innerHTML = "";
  if (!filtered.length) {
    _topListEl.innerHTML = '<div class="submode-popup-empty">暂无子模式</div>';
    return;
  }
  filtered.forEach(function (mode) {
    var item = document.createElement("div");
    item.className = "submode-popup-item" +
      (mode.id === activeId ? " submode-popup-item-active" : "");
    item.innerHTML =
      '<span class="submode-popup-item-icon">' + _esc(mode.icon || "💻") + '</span>' +
      '<div class="submode-popup-item-info">' +
        '<span class="submode-popup-item-label">' + _esc(mode.label) + '</span>' +
        (mode.desc ? '<span class="submode-popup-item-desc">' + _esc(mode.desc) + '</span>' : '') +
        // D2 视觉反馈（凛倾操作三原则"好操作"）：子模式切换间接真活但零反馈，补显其绑定预设名。
        //   presetName 单源来自 getSubModes 下发的 sub_modes[].presetName（无缓存快照，列表每次 _renderTopModeList 现读 _subModes）。
        //   无配置=后端生成时继承大模式「当前正在使用的预设」（[0716] 绑定概念已删）；文案单源 PRESET_INHERIT_LABEL [D6 0713]。
        '<span class="submode-popup-item-desc">预设: ' + _esc(mode.presetName || PRESET_INHERIT_LABEL) + '</span>' +
      '</div>' +
      (mode.id === activeId ? '<span class="submode-popup-item-check">✓</span>' : '');
    item.addEventListener("click", function (e) {
      e.stopPropagation();
      _switchToSubMode(mode);
      _closeTopList();
    });
    _topListEl.appendChild(item);
  });
}

function _updateTopBar() {
  if (!_topBarEl) return;
  var label = _topBarEl.querySelector("#stb-mode-label");
  if (!label) return;
  var rawMode = typeof getCurrentMode === "function" ? (getCurrentMode() || "") : "";
  if (rawMode === "chat") {
    var presetEl = document.getElementById("preset-selector");
    var presetVal = presetEl ? presetEl.value : "";
    label.textContent = presetVal || document.getElementById("preset-name")?.textContent || "--";
  } else {
    var mode = _getActiveMode();
    label.textContent = mode ? ((mode.icon || '') + ' ' + (mode.label || mode.id)).trim() : '--';
  }
}

// D3 修复：直接在按钮上绑定 click 事件，不依赖 initIdeActivityBar 的批量绑定
// （因为 initIdeActivityBar 在 initSubModePanel 之前执行，此时按钮还没注入 DOM）
function _injectActivityBarBtn() {
  const activityBar = document.getElementById("ide-activity-bar");
  if (!activityBar) return;
  // 检查是否已存在
  if (activityBar.querySelector('[data-ide-panel="submodes"]')) return;

  const btn = document.createElement("button");
  btn.className = "ide-activity-btn";
  btn.setAttribute("data-ide-panel", "submodes");
  btn.title = "子模式管理";
  btn.innerHTML = '<span class="ide-activity-icon"><i data-ic="tune"></i></span>';

  activityBar.insertBefore(btn, activityBar.firstElementChild);
}

function _injectManagePanel() {
  const sidebar = document.getElementById("ide-sidebar");
  if (!sidebar) return;
  if (document.getElementById("ide-panel-submodes")) return;

  const panel = document.createElement("div");
  panel.id = "ide-panel-submodes";
  panel.className = "ide-sidebar-panel flex-1 overflow-y-auto hidden";
  sidebar.appendChild(panel);
}

// ============================================================
// 底部触发栏 UI 更新
// ============================================================

function _updateTriggerBar() {
  const mode = _getActiveMode();

  // 对话标签更新（不依赖 mode 是否存在）
  _updateConvLabel();

  // [0716 散写收口·单点通知] 本函数是子模式域状态→UI 的汇点（手动切换/事件切换/配置变更重拉/init
  //   全部路径都调）——底栏生效绑定视图（extendMenuW28）在此单点订阅重解析，禁在各调用点散发。
  try { window.dispatchEvent(new CustomEvent("beilu:effectiveModelChanged")); } catch { /* 非致命 */ }

  const apiLabel = document.getElementById("submode-api-label");
  const modelLabel = document.getElementById("submode-model-label");

  if (!mode) return;
  if (apiLabel)
    apiLabel.textContent = mode.apiSource
      ? "源: " + mode.apiSource
      : "源: 默认";
  // 模型标签：优先 model_params.model 副本（B18 权威），回退扁平 modelName
  if (modelLabel) {
    var _mn = (mode.model_params && typeof mode.model_params === "object" && mode.model_params.model)
      ? mode.model_params.model
      : (mode.modelName || "");
    // 子模式未绑模型时的回退显示（[0716 散写收口] 修正）：
    //   绑了源没绑模型 → 生成用绑定源的默认模型，_beiluGetModel 是全局源的值≠绑定源的——显示它=误导
    //     （改前靠切换时 poke 全局的污染巧合才对），如实显示「源默认」；
    //   源模型都没绑 → 生成回退全局层，回退显示 _beiluGetModel（全局 effective 模型）语义正确。
    var _fromSubMode = !!_mn;
    var _srcDefault = !_mn && !!mode.apiSource;
    if (!_mn && !mode.apiSource) {
      try { _mn = (window._beiluGetModel && window._beiluGetModel()) || ""; } catch (_) {}
    }
    modelLabel.textContent = _srcDefault ? "模型: 源默认" : (_mn ? "模型: " + _mn : "模型: 默认");
    modelLabel.title = _srcDefault ? ("使用绑定源 " + mode.apiSource + " 的默认模型")
      : (_mn ? (_fromSubMode ? "子模式绑定模型: " + _mn : "全局当前模型: " + _mn) : "默认模型");
  }
}

// ============================================================
// 对话文件选择（触发栏）
// ============================================================

let _cachedConvList = [];

function _getConvLabel(chat) {
  const id = chat.chatid || chat.id;
  try {
    const meta = JSON.parse(storage.get(KEYS.BEILU_CONVERSATION_META) || "{}");
    const cm = meta[id] || {};
    return chat.customName || cm.label || chat.firstUserMessage || id.substring(0, 10) + "…";
  } catch {
    return chat.customName || chat.firstUserMessage || id.substring(0, 10) + "…";
  }
}

function _updateConvLabel() {
  const labelEl = document.getElementById("conv-trigger-label");
  if (!labelEl) return;
  const currentId = _getCurrentChatId(); // [T047] 守卫单源，非法 hash → "" 显示"无对话"
  if (!currentId) { labelEl.textContent = "无对话"; return; }
  const match = _cachedConvList.find(c => (c.chatid || c.id) === currentId);
  labelEl.textContent = match ? _getConvLabel(match) : currentId.substring(0, 10) + "…";
}

async function _renderPopupConvList(filter, _skipFetch) {
  const list = document.getElementById("submode-popup-list");
  if (!list) return;
  if (!filter && !_skipFetch) {
    // [0720 缓存先行·charsel 同款范式] 有缓存立即渲染零"加载中",后台静默校准后重渲
    //   (_skipFetch 防校准回调递归重拉);弹窗已关时 :1037 getElementById 早退,只更缓存。
    //   仅冷缓存(首开)阻塞拉取。
    if (!_cachedConvList.length) {
      list.innerHTML = '<div style="padding:8px;opacity:0.5;font-size:0.75rem;text-align:center;">加载中...</div>';
      try { _cachedConvList = await fetchChatList(); } catch { /* use cache */ }
    } else {
      fetchChatList().then((r) => { _cachedConvList = r; _renderPopupConvList(filter, true); }).catch(() => {});
    }
  }
  const currentId = _getCurrentChatId(); // [T047] 守卫单源，非法 hash → "" 显示"无对话"
  const currentMode = getCurrentMode() || "chat";
  let meta = {};
  try { meta = JSON.parse(storage.get(KEYS.BEILU_CONVERSATION_META) || "{}"); } catch { /* ignore */ }
  let items = _cachedConvList.filter(c => {
    const id = c.chatid || c.id;
    // [病型全查批2 0713] P2 漏网第7处：过滤原读本地 convMeta.mode（0713 P2 已定唯一权威=服务端
    //   chat.mode,chat_modes,getChatList 恒注入;本地是 stale 缓存,各窗口各说各话）。对齐主列表
    //   conversationManager 过滤同款:服务端单源,无标记=旧对话全模式可见。meta 仍用于排序/置顶。
    const chatMode = c.mode;
    if (chatMode && chatMode !== currentMode) return false;
    if (!filter) return true;
    const label = _getConvLabel(c).toLowerCase();
    return label.indexOf(filter.toLowerCase()) >= 0;
  });
  // 排序单源（0715 散点合并）：原本地手抄副本漏判 starred=收藏排序在本弹窗静默失效（质量不齐副本实证）
  items.sort((a, b) => compareConvOrder(a, b, meta));
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<div style="padding:8px;opacity:0.5;font-size:0.75rem;text-align:center;">无匹配对话</div>';
    return;
  }
  for (const chat of items) {
    const id = chat.chatid || chat.id;
    const isActive = id === currentId;
    const label = _getConvLabel(chat);
    const cm = meta[id] || {};
    const lastTime = cm.lastActive ? _relTime(cm.lastActive) : "";
    const item = document.createElement("div");
    item.className = "submode-popup-item" + (isActive ? " submode-popup-item-active" : "");
    item.innerHTML =
      '<span class="submode-popup-item-icon">' + (chat.pinned ? '<i data-ic="pin"></i>' : (chat.starred ? '<i data-ic="star"></i>' : '<i data-ic="message"></i>')) + '</span>' +
      '<span class="submode-popup-item-label" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(label) + '</span>' +
      (lastTime ? '<span style="margin-left:auto;opacity:0.35;font-size:0.65rem;flex-shrink:0;">' + _esc(lastTime) + '</span>' : '');
    if (!isActive) {
      item.addEventListener("click", function () {
        // [0713 病灶审计 C2] 原 setTimeout(_updateConvLabel,300) 删除：switchToChat →
        //   switchCharacterScope 写 location.hash，本模块 hashchange 监听器（_bindTriggerEvents）
        //   已确定性触发 _updateConvLabel，定时猜测是冗余第二源。
        switchToChat(id);
        _closePopup();
      });
    }
    list.appendChild(item);
  }
}

// [合并批 0714] _relTime 手抄副本删除 → shared/state/utils.formatRelativeTime 单源（import 别名保调用点）

// ============================================================
// 弹出层逻辑
// ============================================================

function _renderPopupParallelList(filter) {
  var list = document.getElementById("submode-popup-list");
  if (!list) return;
  var parallelIds = new Set(_parallelSubModes.map(function(p) { return p.id; }));
  var available = _subModes.filter(function(m) {
    if (m.id === _getEffectiveActiveId()) return false;
    if (parallelIds.has(m.id)) return false;
    if (m.enabled === false) return false;
    if (!filter) return true;
    var f = filter.toLowerCase();
    return m.label.toLowerCase().indexOf(f) >= 0 || (m.desc || "").toLowerCase().indexOf(f) >= 0;
  });
  list.innerHTML = "";
  if (!available.length) {
    list.innerHTML = '<div style="padding:8px;opacity:0.5;font-size:0.75rem;text-align:center;">无可添加的子模式</div>';
    return;
  }
  available.forEach(function(mode) {
    var item = document.createElement("div");
    item.className = "submode-popup-item";
    item.innerHTML = '<span class="submode-popup-item-icon">' + _esc(mode.icon || "💻") + '</span>' +
      '<span class="submode-popup-item-label">' + _esc(mode.label || mode.id) + '</span>' +
      '<span style="margin-left:auto;opacity:0.4;font-size:0.65rem;">+ 并行</span>';
    item.addEventListener("click", function() {
      _addParallelSubMode(mode.id);
      _closePopup();
    });
    list.appendChild(item);
  });
}

function _renderPopupModeList(filter) {
  var list = document.getElementById("submode-popup-list");
  if (!list) return;

  // BUG-03: chat模式下子模式modeGroup无匹配，映射到code
  var rawMode = getCurrentMode() || "code";
  var beiluMode = (rawMode === "chat" || rawMode === "file") ? "code" : rawMode;
  var filtered = _subModes.filter(function (m) {
    if (m.enabled === false) return false;
    var group = m.modeGroup; // [D4 0713] 存储不变式已保证字段必在（getSubModes 迁移+saveSubModes 归一），内联默认删除
    if (group !== beiluMode && group !== "all") return false;
    if (!filter) return true;
    var f = filter.toLowerCase();
    return (
      m.label.toLowerCase().indexOf(f) >= 0 ||
      (m.desc || "").toLowerCase().indexOf(f) >= 0
    );
  });

  list.innerHTML = "";
  filtered.forEach(function (mode) {
    var item = document.createElement("div");
    item.className =
      "submode-popup-item" +
      (mode.id === _getEffectiveActiveId() ? " submode-popup-item-active" : "");
    item.dataset.modeId = mode.id;
    item.innerHTML =
      '<span class="submode-popup-item-icon">' +
      _esc(mode.icon || "💻") +
      "</span>" +
      '<div class="submode-popup-item-info">' +
      '<span class="submode-popup-item-label">' +
      _esc(mode.label) +
      "</span>" +
      (mode.desc
        ? '<span class="submode-popup-item-desc">' + _esc(mode.desc) + "</span>"
        : "") +
      "</div>" +
      (mode.id === _getEffectiveActiveId()
        ? '<span class="submode-popup-item-check">✓</span>'
        : "");

    item.addEventListener("click", function (e) {
      e.stopPropagation();
      _switchToSubMode(mode);
    });
    list.appendChild(item);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="submode-popup-empty">无匹配子模式</div>';
  }
}

function _renderPopupApiList(filter) {
  var list = document.getElementById("submode-popup-list");
  if (!list) return;

  var mode = _getActiveMode();
  var currentApi = mode ? mode.apiSource || "" : "";

  var allSources = ["（使用默认 API）"];
  _apiSources.forEach(function (s) {
    allSources.push(s);
  });

  var filtered = filter
    ? allSources.filter(function (s) {
        return s.toLowerCase().indexOf(filter.toLowerCase()) >= 0;
      })
    : allSources;

  list.innerHTML = "";
  filtered.forEach(function (src) {
    var isDefault = src === "（使用默认 API）";
    var srcValue = isDefault ? "" : src;
    var isActive = currentApi === srcValue;

    var item = document.createElement("div");
    item.className =
      "submode-popup-item" + (isActive ? " submode-popup-item-active" : "");
    item.innerHTML =
      '<span class="submode-popup-item-icon">' +
      (isDefault ? '<i data-ic="plug"></i>' : '<i data-ic="zap"></i>') +
      "</span>" +
      '<div class="submode-popup-item-info">' +
      '<span class="submode-popup-item-label">' +
      _esc(src) +
      "</span>" +
      "</div>" +
      (isActive ? '<span class="submode-popup-item-check">✓</span>' : "");

    item.addEventListener("click", async function (e) {
      e.stopPropagation();
      if (mode) {
        // 写回当前子模式 apiSource + model_params.api_source（单一权威，B18 副本权威，带 Drift 回滚 — 看返回值）。
        // 补修：对齐 :1283 model 双写范式——扁平 apiSource + 副本 api_source 同写，读侧 getPromptHandler:300 副本优先，stale 盖回链断。
        var ok = await _writeBackToActiveSubMode({ apiSource: srcValue, api_source: srcValue });
        if (ok) {
          _closePopup();
          _updateTriggerBar();
          // [0717] 原清双层缓存代码删除：第二层模块缓存已整体移除，弹层每次打开实时拉
          //   （_fetchModelListLive force），无需在此预失效
          _showToast("⚡ API 源已切换: " + (srcValue || "默认"), 2000);
        }
        // 失败已在 _writeBackToActiveSubMode 内回滚+提示
      }
    });
    list.appendChild(item);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="submode-popup-empty">无匹配 API 源</div>';
  }
}

// ── [模型▾] 弹层（语义同构 YonBan F1 renderApiPopupList :1796）──
// 列当前子模式所绑 API 源的可用模型；选中→写回当前子模式 modelName + model_params.model。
// [0717 断链修] 原 _ensureModelList 第二层无限期模块缓存（拉过一次同源永不再拉）删除——
//   凛倾定案「拉条是每次都需要访问,而不是访问一次就缓存,是每次点击都需要访问」：
//   弹层打开=用户点击，直走收口 _beiluGetModelList({force:true}) 实时访问源。
var _modelPopupReqId = 0;

async function _fetchModelListLive(apiSourceName) {
  var models = [];
  try {
    var fn = window._beiluGetModelList;
    models = fn ? await fn(apiSourceName, { force: true }) : [];
  } catch (e) {
    console.warn("[subModePanel] 模型列表获取失败:", e.message);
  }
  return Array.isArray(models) ? models : [];
}

async function _renderPopupModelList(filter) {
  var list = document.getElementById("submode-popup-list");
  if (!list) return;

  var mode = _getActiveMode();
  var curSource = mode ? (mode.apiSource || "") : "";
  var curModel = "";
  if (mode) {
    curModel = (mode.model_params && typeof mode.model_params === "object" && mode.model_params.model)
      ? mode.model_params.model
      : (mode.modelName || "");
  }

  var reqId = ++_modelPopupReqId;
  list.innerHTML = '<div class="submode-popup-empty">加载模型列表...</div>';
  var models = await _fetchModelListLive(curSource);
  // 竞态：弹层已切换/重开则丢弃
  if (reqId !== _modelPopupReqId) return;
  if (!document.getElementById("submode-popup-list")) return;

  var allModels = [MODEL_SOURCE_DEFAULT_LABEL].concat(models.filter(Boolean).map(function (m) {
    return typeof m === "string" ? m : (m.id || m.name || "");
  }).filter(Boolean));

  var filtered = filter
    ? allModels.filter(function (m) { return m.toLowerCase().indexOf(filter.toLowerCase()) >= 0; })
    : allModels;

  list.innerHTML = "";
  // 无真实模型时给一行提示（仍保留"使用源默认模型"项允许清空到源默认）
  if (models.length === 0 && !filter) {
    var hint = document.createElement("div");
    hint.className = "submode-popup-empty";
    hint.textContent = curSource ? "该 API 源暂无模型列表（可用源默认）" : "请先选择 API 源（可用源默认）";
    list.appendChild(hint);
  }
  if (filtered.length === 0) {
    if (!list.firstChild) list.innerHTML = '<div class="submode-popup-empty">无匹配模型</div>';
    return;
  }
  filtered.forEach(function (m) {
    var isDefault = m === MODEL_SOURCE_DEFAULT_LABEL;
    var mValue = isDefault ? "" : m;
    var isActive = curModel === mValue;
    var item = document.createElement("div");
    item.className = "submode-popup-item" + (isActive ? " submode-popup-item-active" : "");
    item.innerHTML =
      '<span class="submode-popup-item-icon">' + (isDefault ? '<i data-ic="puzzle"></i>' : '<i data-ic="bot"></i>') + "</span>" +
      '<div class="submode-popup-item-info">' +
      '<span class="submode-popup-item-label">' + _esc(m) + "</span>" +
      "</div>" +
      (isActive ? '<span class="submode-popup-item-check">✓</span>' : "");
    item.addEventListener("click", async function (e) {
      e.stopPropagation();
      // 写回 modelName + model_params.model（单一权威，B18 副本权威，带 Drift 回滚）
      var ok = await _writeBackToActiveSubMode({ modelName: mValue, model: mValue });
      if (ok) {
        _closePopup();
        // [0716 散写收口] 原 poke #api-model（_beiluSetModel）删除：把子模式模型灌进全局选择器=
        //   污染全局层（API 设置保存会持久化进源 config）。底栏生效绑定视图由 _updateTriggerBar 单点通知。
        _updateTriggerBar();
        _renderManageList();
        _showToast("🤖 模型已切换: " + (mValue || "源默认"), 2000);
      }
    });
    list.appendChild(item);
  });
}

// [0713 病灶审计 D3] 子模式切换的"绑定预设 UI 反馈"原在手动路径（_switchToSubMode）和事件路径
//   （beilu:subModeSwitched 监听器）各持一份同构块 → 提为单函数双路径共用；头部 subModeBindingChanged
//   仍是单点各发一次（手动口/事件口互斥，不双发）。（同批的"绑定模型应用"共享函数已于 0716 散写收口删除，见下）

/** 绑定预设的纯 UI 反馈：参数覆盖展示 + token 刷新 + 头部绑定显示位更新（T046：不切预设，只展示将生效绑定） */
function _applySubModeBindingUI(mode) {
  if (!mode || !mode.presetName) return;
  _overlaySubModeParamsUI(mode);
  if (window.refreshTokenProgress) window.refreshTokenProgress();
  // 凛倾0706「切换子模式=改头部那个」——头部（#header-current-preset）更新为将生效绑定。
  //   专用事件不复用 beilu:presetSwitched（那个会误触 loadPresetData/左栏 smart selector 同步，预设此刻未真切）。
  try { window.dispatchEvent(new CustomEvent("beilu:subModeBindingChanged", { detail: { name: mode.presetName } })); } catch { /* 头部更新失败不阻断切换 */ }
}

// [0716 散写收口] 原 _applySubModeModel（"绑定模型应用"）整函数删除：
//   ①updatePresetConfig 把子模式模型写进全局预设 model_params=污染预设基线（切回 chat/无绑定子模式后残留）
//   ②poke #api-model 把子模式模型灌进全局选择器，用户之后在 API 设置点保存 → apiConfig handleSave 把它
//     持久化进 AI源 config.model=永久污染。
//   生成链无需这两写（后端每轮从 sub_modes 权威 per-request 解析，见 _setActiveSubMode 收口注释）。
//   底栏选择器改为「生效绑定视图」（extendMenuW28 消费 window._beiluResolveSubModeBinding），
//   刷新通知由 _updateTriggerBar 单点发（两个原调用点均已调它）。

async function _switchToSubMode(mode) {
  // [D3 0804 单请求化·RC11断点3] 原两次 HTTP（switchModeTo 前置 → setActiveSubMode）存在半失败窗口
  //   （模式切了子模式没切 / 两请求间隙其他窗口插写）。改调后端单 verb activateSubMode：跨组时服务端
  //   内部重入既有 switchMode 管线（scheduler 启停 + beilu-files setMode 扇出 + mode_changed 广播全套
  //   复用）+ 激活单事务，模式切换失败=整体中止零半态（后端 E_MODE_SWITCH_FAILED，子模式不激活）。
  //   原 R4「写读键错位防护」（模式必须先就位再写预设键）由后端 verb 内序保证：switchMode 成功后才
  //   activateSubModeCore→applySubModePresetDefault。
  //   本窗 UI 模式态不在此手动翻转：mode_changed 广播回流 _beiluApplyModeFromWs 单源对齐
  //   （updateModeSwitchUI + beilu:mode-switched 派发），不造第二份本地翻转实现。
  var _swCid = _getCurrentChatId();
  var data;
  try {
    // [0808 模式=窗口身份] windowToken：跨组切换时后端 mode_changed 广播回显此令牌，
    //   本窗 _beiluApplyModeFromWs 识别为本窗回流才翻转模式态（:1451 契约的令牌化实现）。
    data = await sendAction({ verb: "activateSubMode", target: "plugins:beilu-memory", source: "web", payload: { id: mode.id, chatId: _swCid, windowToken: getWindowInstanceToken() } });
  } catch (e) {
    console.warn("[subModePanel] activateSubMode 请求失败:", e.message);
    _showToast("⚠️ 子模式切换失败: " + e.message, 3000);
    return;
  }
  // 业务级 success:false 经桥不抛（2026-07-15 校准）：显式校验，失败不更新本地不装成功
  if (!data || data.success === false) {
    console.warn("[subModePanel] activateSubMode 业务失败:", data && (data.error || data.code));
    _showToast("⚠️ 子模式未切换: " + ((data && data.error) || "未知错误"), 3000);
    return;
  }
  if (data.mode_switched) console.log("[subModePanel] 后端已随激活切换模式 →", mode.modeGroup);
  _applySubModeSwitchLocal(mode.id, _swCid);
  _closePopup();
  _updateTriggerBar();
  _updateTopBar();
  _renderManageList();

  _applySubModeBindingUI(mode);
  // [0716 散写收口] _applySubModeModel 调用删除（函数已删，见 _switchToSubMode 上方收口注释）——底栏由 _updateTriggerBar 单点通知

  // Toast 提醒
  // T073②（T046 遗留文案修）：不再把 presetName 拼进 toast。T046 拆除了「前端切子模式→强制 switchPreset」
  //   联动（见上 :1320），预设隔离改由后端生成时按 sub_modes[].presetName 决定，前端切换瞬间不改当前预设。
  //   原文案 "(预设: X)" 会误导用户以为当前预设已切成 X，实际当前预设不受前端切换影响。故仅报模式名（+已切的模型）。
  var toastMsg = (mode.icon || "⚡") + " 已切换到 " + mode.label;
  if (mode.modelName) {
    toastMsg += " (模型: " + mode.modelName + ")";
  }
  _showToast(toastMsg, 2500);
}

function _openPopup(target) {
  _popupTarget = target;
  _popupOpen = true;

  if (!_popupEl) return;
  // D2 修复：用 style.display 控制显隐
  _popupEl.style.display = "flex";

  var search = document.getElementById("submode-popup-search");

  if (search) {
    search.value = "";
    search.placeholder = target === "conv" ? "搜索对话..."
      : target === "model" ? "搜索模型..."
      : "搜索 API 源...";
  }

  if (target === "conv") {
    _renderPopupConvList("");
  } else if (target === "model") {
    _renderPopupModelList("");
  } else {
    _renderPopupApiList("");
  }

  // C2/C3 修复：不再使用 fixed overlay（会导致 z-index 层叠上下文问题）
  // 改为 document click 检测关闭；ESC 关闭走中央仲裁注册表（T3修2，priority 40），不再自注册 capture keydown
  // 用 setTimeout 延迟绑定 click，避免当前 click 事件立即触发关闭
  setTimeout(function () {
    document.addEventListener("click", _handleDocumentClickForPopup, true);
  }, 0);

  if (search) search.focus();
}

/**
 * C2/C3 修复：document click 检测关闭弹出层
 * 点击 wrapper 内部（popup + trigger bar）不关闭
 * 点击 wrapper 外部关闭
 */
function _handleDocumentClickForPopup(e) {
  var wrapper = document.getElementById("submode-trigger-wrapper");
  if (wrapper && wrapper.contains(e.target)) return;
  _closePopup();
}

// T3修2: ESC 关闭弹出层走中央仲裁注册表（priority 40，popup/下拉层）。
// 原 _handleEscapeForPopup 自注册 capture keydown 已删除，避免与仲裁器双处理。
(function _registerEscLayer() {
  const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
  if (reg.some((r) => r && r._id === "submode-popup")) return; // 去重，防模块重载重复注册
  reg.push({ _id: "submode-popup", priority: 40, isOpen: () => _popupOpen, close: () => _closePopup() });
})();

function _closePopup() {
  _popupOpen = false;
  // D2 修复：用 style.display 控制显隐
  if (_popupEl) _popupEl.style.display = "none";

  // C2/C3 修复：移除 document click 监听（ESC 已迁中央仲裁注册表，无需在此移除 keydown）
  document.removeEventListener("click", _handleDocumentClickForPopup, true);
}

// ============================================================
// 管理面板（ide-panel-submodes）
// ============================================================

// ── 单例挂载（2026-07-16 双容器重复 id 根修）──
// 病：本面板整块 markup（含固定 id 的 #submode-edit-form 及全部字段）曾被"重渲"进两个容器
//   （ide-panel-submodes 由 init/observer 渲、work 侧栏由 renderSubModeManagementInto 渲），
//   互不清理 → 全文档重复 id → 所有 getElementById 打文档序第一份（IDE 份）→ 用户操作的
//   可见份（work）下拉不回填/按钮错绑=大面积断链；_openEditForm 又把第一份表单搬进右栏，
//   与另一份静态表单同屏=「两个设置界面」（凛倾 2026-07-16 截图实证）。
// 修：面板 DOM 单例（#submode-manage-root），容器间搬移不重建（范式同 taskItemPanel mount 重指）；
//   搬移保事件绑定，仅刷数据面。
// 编辑表单位置唯一管理者=_openEditForm/_closeEditForm（既有设计）：挂载搬移不碰表单——
//   留在非活动侧右栏的表单随该右栏 display:none 天然不可见，下次 _openEditForm 会把
//   同一实例搬到当前侧并重新回填（单例下 getElementById 必中唯一份）。
function _renderManagePanel(targetContainer) {
  var container = targetContainer || document.getElementById("ide-panel-submodes");
  if (!container) return;

  var root = document.getElementById("submode-manage-root");
  if (root) {
    if (root.parentElement !== container) {
      container.appendChild(root); // 搬移=同一节点换宿主，绑定不丢
    }
    // 数据面刷新（不重建 DOM 不重绑事件）
    _renderManageList();
    _populateApiSelect();
    _populatePresetSelect();
    return;
  }

  // 重建前清孤儿表单：root 可被宿主容器 innerHTML 覆写销毁（work 侧 _loadSidebarPanel 切面板），
  //   而表单若已被 _openEditForm 搬进右栏则幸存——不清则下方 markup 再造一份=重复 id 复发。
  //   （原 renderSubModeManagementInto 的游离表单守卫收口到此唯一建点。）
  var strayForm = document.getElementById("submode-edit-form");
  if (strayForm) strayForm.remove();

  root = document.createElement("div");
  root.id = "submode-manage-root";
  container.appendChild(root);

  root.innerHTML =
    '<div class="p-3 space-y-3">' +
    '<div class="flex items-center justify-between">' +
    '<h3 class="font-bold text-sm flex items-center gap-2" style="color:var(--beilu-amber)">' +
    '<span><i data-ic="tune"></i></span> 子模式管理' +
    "</h3>" +
    '<div class="flex gap-1">' +
    '<button id="submode-reset-btn" class="btn btn-xs btn-ghost text-base-content/50" title="恢复默认子模式"><i data-ic="refresh"></i> 恢复默认</button>' +
    '<button id="submode-add-btn" class="btn btn-xs btn-outline" style="border-color:var(--beilu-amber);color:var(--beilu-amber)">' +
    '<i data-ic="plus"></i> 新建子模式' +
    "</button>" +
    "</div>" +
    "</div>" +
    // ── 标签页切换 ──
    '<div class="flex border-b border-base-300 mb-2">' +
    '<button id="submode-tab-code" class="submode-manage-tab active" data-tab="code"><i data-ic="code"></i> 编程模式</button>' +
    '<button id="submode-tab-work" class="submode-manage-tab" data-tab="work"><i data-ic="clipboard"></i> 工作模式</button>' +
    '<button id="submode-tab-clones" class="submode-manage-tab" data-tab="clones">👥 分身</button>' +
    "</div>" +
    // ── 双栏布局：左 skill 组列表 / 右 子模式详情 ──
    // 伸缩机制（凛倾 2026-07-07"解决这种伸缩有问题的情况"）：原左列 width:140px+flex-shrink:0 死占，
    // 侧栏默认 240px（index.css .ide-sidebar）减 p-3 后内容宽仅 ~216px，右列被压到 ~68px——
    // 图标堆叠/label 截零/select 压扁/横向滚动条，默认宽度下双栏必然放不下。
    // 改 flex-wrap 弹性列：容器 ≥ 140+8+220（各列 flex-basis 之和+gap）时双列（详情列 flex-grow 999 拿走余宽），
    // 不足时详情列整行换下、两列各占满宽。换行阈值由 basis 决定，换行后列宽靠 shrink 贴合容器
    // （detail min-width:0 使内部 truncate 生效而非撑出横向滚动条）——任何侧栏宽度无挤压无横向溢出，纯 CSS 无 JS 分支。
    // 原 border-right 列分隔在换行堆叠形态下会成贴边竖线，删除（列区分靠 gap+选中态背景）。
    '<div id="submode-clone-container" class="hidden" style="min-height:300px;overflow-y:auto;max-height:60vh;"></div>' +
    '<div id="submode-two-col" class="flex flex-wrap gap-2" style="min-height:300px">' +
    '<div id="submode-group-list" class="space-y-1" style="flex:1 1 140px;min-width:120px;overflow-y:auto;max-height:60vh"></div>' +
    '<div id="submode-detail-panel" style="flex:999 1 220px;min-width:0;overflow-y:auto;max-height:60vh"></div>' +
    '</div>' +
    // ── 编辑表单（竖排布局修复） ──
    '<div id="submode-edit-form" class="hidden bg-base-300/50 rounded-lg p-3 mt-2">' +
    '<div class="text-xs font-bold mb-2" id="submode-form-title" style="color:var(--beilu-amber)">新建子模式</div>' +
    '<div class="submode-edit-form-fields">' +
    // ID
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">ID（唯一标识）</span></label>' +
    '<input type="text" id="submode-form-id" class="input input-xs input-bordered w-full font-mono text-xs" placeholder="my-mode" />' +
    "</div>" +
    // 图标 + 名称（一行两列）
    '<div class="submode-form-icon-name-row">' +
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">图标</span></label>' +
    '<input type="text" id="submode-form-icon" class="input input-xs input-bordered w-full text-center text-sm" placeholder="💻" maxlength="4" />' +
    "</div>" +
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">名称</span></label>' +
    '<input type="text" id="submode-form-label" class="input input-xs input-bordered w-full text-xs" placeholder="Code" />' +
    "</div>" +
    "</div>" +
    // 描述
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">描述（可选）</span></label>' +
    '<input type="text" id="submode-form-desc" class="input input-xs input-bordered w-full text-xs" placeholder="编程实现" />' +
    "</div>" +
    // [0804 契约字段删除·凛倾定案] 原「身份专用契约」表单是 desc 之外的第二描述通道：desc 已有宏注入，
    //   contract 再走 sub_mode_contract_json 注入=同一身份描述双份散写+额外注入面（RC11 断点1）。
    //   全链删除（表单/回填/保存/存储默认/宏/模板消费）；工具权限保留为独立 sub_mode_tool_permissions_json 宏。
    // 所属模式
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">所属模式</span></label>' +
    // T072a·A5 豁免：code/work 是系统架构级固定顶层模式组（非用户可扩展的数据枚举），
    //   仅此单处、无副本，且带 UI 图标语义。后端 storage.mjs DEFAULT_CODE/WORK_SUB_MODES 以此二者为分组键，
    //   属"协议固定值"性质（同 index.html 里 system/user/assistant 角色枚举），不接后端下发。
    '<select id="submode-form-modegroup" class="select select-xs select-bordered w-full text-xs">' +
    '<option value="code">💻 编程模式</option>' +
    '<option value="work">📋 工作模式</option>' +
    "</select>" +
    "</div>" +
    // 绑定预设
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">绑定预设名（可选）</span></label>' +
    '<select id="submode-form-preset" class="select select-xs select-bordered w-full text-xs">' +
    '<option value="">（不绑定预设）</option>' +
    "</select>" +
    "</div>" +
    // 绑定 API 源
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">绑定 API 源（可选）</span></label>' +
    '<select id="submode-form-api" class="select select-xs select-bordered w-full text-xs">' +
    '<option value="">（使用默认 API）</option>' +
    "</select>" +
    "</div>" +
    // 绑定模型
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">绑定模型（可选）</span></label>' +
    '<select id="submode-form-model" class="select select-xs select-bordered w-full text-xs">' +
    '<option value="">（使用 API 源默认模型）</option>' +
    "</select>" +
    "</div>" +
    // 子模式不保存 Key/URL；这里明确“选择覆盖层”与“全局默认”的关系，并给出直达设置入口。
    '<div id="submode-api-guide" class="rounded border border-base-300 bg-base-200/50 p-2 text-[11px] leading-5"></div>' +
    // 提示词后处理
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">提示词后处理</span></label>' +
    '<select id="submode-form-postprocess" class="select select-xs select-bordered w-full text-xs">' +
    // 默认 strict 来自后端子模式种子；这里仅把同一产品默认呈现给“新建”表单，已有项照实回填。
    _buildModeOptions(_enumOptions("prompt_post_processing"), { selectedValue: "strict" }) +
    "</select>" +
    "</div>" +
    // 备用API源
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">备用 API 源（可选，主API失败时切换）</span></label>' +
    '<select id="submode-form-backup-api" class="select select-xs select-bordered w-full text-xs">' +
    '<option value="">（无备用）</option>' +
    "</select>" +
    "</div>" +
    // [D3 0804 RC11断点8] 源失败策略：子模式独立源加载失败时的行为（消费端 char-template submode_source_override 分支）。
    //   默认 fail_closed=本轮可见未发送错误，不静默改用角色绑定源（235734 病根：UI 说跟随全局、实际用角色源）。
    '<div class="form-control">' +
    '<label class="label py-0"><span class="label-text text-[11px]">源失败策略（独立 API 源加载失败时）</span></label>' +
    '<select id="submode-form-fallback-policy" class="select select-xs select-bordered w-full text-xs">' +
    '<option value="fail_closed">安全中止（默认：报错不发送，不换源）</option>' +
    '<option value="explicit_fallback">显式回退（先试备用源，再用全局默认源）</option>' +
    "</select>" +
    "</div>" +
    // 温度 + 最大上下文 + 最大输出（一行三列）
    '<div class="flex gap-2 mt-1">' +
    '<div class="form-control flex-1">' +
    '<label class="label py-0"><span class="label-text text-[11px]">温度</span></label>' +
    '<input type="number" id="submode-form-temperature" class="input input-xs input-bordered w-full text-xs" min="0" max="2" step="0.1" placeholder="默认" />' +
    "</div>" +
    '<div class="form-control flex-1">' +
    '<label class="label py-0"><span class="label-text text-[11px]">最大上下文</span></label>' +
    '<input type="number" id="submode-form-max-context" class="input input-xs input-bordered w-full text-xs" min="1000" step="1000" placeholder="默认" />' +
    "</div>" +
    '<div class="form-control flex-1">' +
    '<label class="label py-0"><span class="label-text text-[11px]">最大输出</span></label>' +
    '<input type="number" id="submode-form-max-tokens" class="input input-xs input-bordered w-full text-xs" min="100" step="100" placeholder="默认" />' +
    "</div>" +
    "</div>" +
    // 链路2扩展（2026-07-10 凛倾「用户可以掌控全部参数」）：Top-K + Min-P（消费链
    //   getPromptHandler 子模式提取→preset mergeRuntimeParams 覆盖，与温度同通路；
    //   静态 min/max/step=PARAM_SCHEMA 镜像退化，下方 applyParamSchemaToInputs 覆盖）
    '<div class="flex gap-2 mt-1">' +
    '<div class="form-control flex-1">' +
    '<label class="label py-0"><span class="label-text text-[11px]">Top-K</span></label>' +
    '<input type="number" id="submode-form-top-k" class="input input-xs input-bordered w-full text-xs" min="0" max="500" step="1" placeholder="默认" />' +
    "</div>" +
    '<div class="form-control flex-1">' +
    '<label class="label py-0"><span class="label-text text-[11px]">Min-P</span></label>' +
    '<input type="number" id="submode-form-min-p" class="input input-xs input-bordered w-full text-xs" min="0" max="1" step="0.01" placeholder="默认" />' +
    "</div>" +
    "</div>" +
    // thinking 控件已删（2026-08-01 凛倾「把子模式的思考模式删除…开关放这里(AI源面板)」）：
    //   思维链开关收口到 AI 源面板 per-源单点（settingsSlots→config→httpFetch 口6），
    //   子模式不再持有 extended_thinking/thinking_budget 覆盖口。
    // 预填充
    '<div class="flex gap-2 items-center mt-1">' +
    '<div class="form-control flex-1">' +
    '<label class="flex items-center gap-1 cursor-pointer">' +
    '<input type="checkbox" id="submode-form-prefill" class="checkbox checkbox-xs" />' +
    '<span class="text-[11px]">尾部预填充</span>' +
    "</label>" +
    "</div>" +
    '<div class="form-control flex-1">' +
    '<select id="submode-form-claude-prefill" class="select select-xs select-bordered w-full text-xs">' +
    // T072a/0715收口：从后端 enum_schema（退化=enumFallback.mjs）生成；空项="不改变"，子模式不覆盖此项时继承全局
    _buildModeOptions(_enumOptions("claude_prefill_mode"), { emptyValue: "", emptyLabel: "不改变" }) +
    "</select>" +
    "</div>" +
    "</div>" +
    // [0730] 子模式工具权限开关（系统强制，不靠AI自觉）
    '<div class="bg-base-200/50 rounded-lg p-2 mt-2 space-y-1">' +
    '<p class="text-[10px] font-bold text-base-content/60 mb-1">工具权限</p>' +
    '<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="submode-form-allow-code-edit" class="toggle toggle-xs toggle-info" checked /><span class="text-xs">代码更改</span><span class="text-[10px] text-base-content/40">write_file / fuzzy_edit / replace_lines</span></label>' +
    '<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="submode-form-allow-run-command" class="toggle toggle-xs toggle-warning" checked /><span class="text-xs">脚本运行</span><span class="text-[10px] text-base-content/40">run_command / run_script</span></label>' +
    '<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="submode-form-allow-delete" class="toggle toggle-xs toggle-error" checked /><span class="text-xs">删除操作</span><span class="text-[10px] text-base-content/40">rm / del / rmdir 命令</span></label>' +
    '</div>' +
    // 启用 + 操作按钮
    '<div class="flex items-center justify-between mt-1">' +
    '<label class="flex items-center gap-1 cursor-pointer">' +
    '<span class="text-xs">启用</span>' +
    '<input type="checkbox" id="submode-form-enabled" class="toggle toggle-xs toggle-warning" checked />' +
    "</label>" +
    '<div class="flex gap-1">' +
    '<button id="submode-form-delete" class="btn btn-xs btn-ghost text-error hidden" title="删除子模式本体（级联清理组引用/激活指针/触发栏）"><i data-ic="trash"></i> 删除</button>' +
    '<button id="submode-form-save" class="btn btn-xs btn-primary" style="background:var(--beilu-amber);border-color:var(--beilu-amber)"><i data-ic="save"></i> 保存</button>' +
    '<button id="submode-form-cancel" class="btn btn-xs btn-ghost">取消</button>' +
    "</div>" +
    "</div>" +
    // 状态提示
    '<div id="submode-form-status" class="text-[10px] text-center hidden mt-1"></div>' +
    "</div>" + // .submode-edit-form-fields
    "</div>" + // #submode-edit-form
    '<div class="text-[9px] text-base-content/50 mt-1">子模式绑定不同预设、API 源和模型，在底部触发栏切换</div>' +
    "</div>";

  _renderManageList();
  _bindManagePanelEvents();
  _populateApiSelect();
  _populatePresetSelect();
  // 链路2：表单参数控件值域从后端 param_schema 覆盖（缓存由 featureControls GetData 写入；
  // 无缓存=保留上方 innerHTML 静态 min/max/step 退化值）
  applyParamSchemaToInputs([
    ["temperature", "submode-form-temperature"],
    ["max_context", "submode-form-max-context"],
    ["top_k", "submode-form-top-k"],
    ["min_p", "submode-form-min-p"],
    ["max_tokens", "submode-form-max-tokens"],
  ]);
}

function _renderManageList() {
  var tabCode = document.getElementById("submode-tab-code");
  var tabWork = document.getElementById("submode-tab-work");
  var tabClones = document.getElementById("submode-tab-clones");
  if (tabCode) tabCode.classList.toggle("active", _manageTab === "code");
  if (tabWork) tabWork.classList.toggle("active", _manageTab === "work");
  if (tabClones) tabClones.classList.toggle("active", _manageTab === "clones");

  var twoCol = document.getElementById("submode-two-col");
  var cloneContainer = document.getElementById("submode-clone-container");
  if (_manageTab === "clones") {
    if (cloneContainer) cloneContainer.classList.add("hidden");
    if (twoCol) twoCol.style.display = "";
    var groupList = document.getElementById("submode-group-list");
    var detailPanel = document.getElementById("submode-detail-panel");
    if (groupList) _renderCloneLeftPanel(groupList);
    if (detailPanel) {
      detailPanel.innerHTML = '<div class="text-xs opacity-40 p-4 text-center">未选择分身。点击左侧分身查看/编辑</div>';
    }
    return;
  }
  if (twoCol) twoCol.style.display = "";
  if (cloneContainer) cloneContainer.classList.add("hidden");

  // ── 左栏：Skill 组列表 ──
  _renderGroupList();
  // ── 右栏：选中组的子模式 ──
  _renderGroupDetail();
}

function _renderGroupList() {
  var list = document.getElementById("submode-group-list");
  if (!list) return;
  list.innerHTML = "";

  var groups = _skillGroups.filter(function (g) {
    return g.modeGroup === _manageTab; // [D4 0713] listFlowGroups 后端投影已归一（缺省"code"）
  });

  if (!groups.length) {
    list.innerHTML = '<p class="text-[10px] text-base-content/50 py-3">暂无 Skill 组</p>';
  }

  // [0722 skill组隔离] 选中恢复：长期选中组（后端 selected_groups 镜像）优先，无/悬空才落列表首个
  if (!_selectedGroupFn || !groups.find(function (g) { return g.filename === _selectedGroupFn; })) {
    var persisted = _selectedGroups[_manageTab];
    _selectedGroupFn = (persisted && groups.find(function (g) { return g.filename === persisted; }))
      ? persisted
      : (groups.length ? groups[0].filename : null);
  }

  groups.forEach(function (g) {
    var isSelected = g.filename === _selectedGroupFn;
    var item = document.createElement("div");
    item.className = "skill-group-item flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors " +
      (isSelected ? "font-medium" : "hover:bg-base-300/40 text-base-content/70");
    if (isSelected) { item.style.background = "var(--beilu-amber-15)"; item.style.color = "var(--beilu-amber-fg, var(--beilu-amber))"; }
    item.innerHTML =
      '<span class="text-sm flex-shrink-0">🗂️</span>' +
      '<span class="flex-1 truncate">' + _esc(g.name) + '</span>' +
      (g.builtin ? '<span class="text-[8px] opacity-30"><i data-ic="lock"></i></span>' : '') +
      '<span class="text-[9px] text-base-content/50">' + (g.stepCount || 0) + '</span>';
    item.addEventListener("click", function () {
      _selectedGroupFn = g.filename;
      _persistSelectedGroup(g); // [0722 skill组隔离] 点选=长期记录（除非再切换）
      _renderGroupList();
      _renderGroupDetail();
    });
    list.appendChild(item);
  });

  // 新建 skill 组
  var newBtn = document.createElement("div");
  newBtn.className = "flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-[10px] text-base-content/40 hover:bg-base-300/30 mt-1";
  newBtn.innerHTML = '<span class="text-sm"><i data-ic="plus"></i></span><span>新建组</span>';
  newBtn.addEventListener("click", _showCreateSkillGroupForm);
  list.appendChild(newBtn);
}

function _renderGroupDetail() {
  var detail = document.getElementById("submode-detail-panel");
  if (!detail) return;
  enableDragAutoScroll(detail); // 0722：组内步骤拖拽排序边缘自动滚动（幂等注册）
  detail.innerHTML = "";

  if (!_selectedGroupFn) {
    detail.innerHTML = '<p class="text-xs text-base-content/50 text-center py-8">未选择 Skill 组。从左侧列表选择</p>';
    return;
  }

  var group = _skillGroups.find(function (g) { return g.filename === _selectedGroupFn; });
  if (!group) {
    detail.innerHTML = '<p class="text-xs text-base-content/50 text-center py-8">组不存在</p>';
    return;
  }

  // 组头：名称 + 操作按钮
  var header = document.createElement("div");
  header.className = "flex items-center gap-2 mb-2 pb-2 border-b border-base-300/30";
  header.innerHTML =
    '<span class="text-base">🗂️</span>' +
    '<span class="flex-1 text-sm font-bold truncate">' + _esc(group.name) + '</span>' +
    '<button class="btn btn-xs btn-ghost" id="sg-rename-btn" title="重命名"><i data-ic="edit"></i></button>' +
    '<button class="btn btn-xs btn-primary h-5 min-h-0 px-2 text-[10px]" id="sg-start-btn" title="启动流水线">▶ 启动</button>' +
    (group.builtin ? '' : '<button class="btn btn-xs btn-ghost text-error/60" id="sg-delete-btn" title="删除组"><i data-ic="trash"></i></button>');
  detail.appendChild(header);

  // 描述
  if (group.description) {
    var desc = document.createElement("div");
    desc.className = "text-[10px] text-base-content/40 mb-2";
    desc.textContent = group.description;
    detail.appendChild(desc);
  }

  // 组级源/模型行（AI 建组时复制自当时活跃子模式，listFlowGroups 投影 api_source/model）：
  //   执行该组期间的绑定，空=跟随全局激活源；「改」走与建组通知弹窗同一共享流程（操作闭环）。
  var srcRow = document.createElement("div");
  srcRow.className = "flex items-center gap-1 text-[10px] text-base-content/50 mb-2";
  srcRow.innerHTML =
    '<span>⚡</span>' +
    '<span class="flex-1 truncate">源/模型: ' + _esc(group.api_source ? group.api_source + (group.model ? " / " + group.model : "") : "跟随全局") + '</span>' +
    '<button class="btn btn-xs btn-ghost" id="sg-model-btn" title="更改执行期间使用的 API 源/模型">改</button>';
  detail.appendChild(srcRow);

  // 子模式列表
  var stepModes = (group.steps || []).map(function (s) {
    return _subModes.find(function (m) { return m.id === s.mode; });
  }).filter(Boolean);

  if (stepModes.length) {
    var modeList = document.createElement("div");
    modeList.className = "space-y-1";
    var _dragFromIdx = -1;
    stepModes.forEach(function (mode, idx) {
      var _mg = mode.modeGroup; // [D4 0713] 同上
      var isActive = mode.id === (_mg === "work" ? _activeSubModeWorkId : _activeSubModeId);
      var isEditing = mode.id === _editingModeId;
      var row = document.createElement("div");
      row.className = "flex items-center gap-1 px-1 py-1 rounded hover:bg-base-200/50 text-xs cursor-pointer" + (isActive ? " bg-primary/10 ring-1 ring-primary/30" : isEditing ? " bg-base-200/60 ring-1 ring-base-content/10" : "");
      row.dataset.stepIdx = idx;
      row.draggable = true;
      row.innerHTML =
        '<span class="sg-drag-handle w-4 text-center text-[9px] opacity-30 cursor-grab select-none" title="拖拽排序">⠿</span>' +
        '<span class="text-sm">' + _esc(mode.icon || "💻") + '</span>' +
        '<span class="flex-1 truncate font-medium">' + _esc(mode.label) + '</span>' +
        (isActive ? '<span class="text-[9px] px-1 rounded" style="background:var(--beilu-amber-20,rgba(245,158,11,.15));color:var(--beilu-amber,#f59e0b)">活跃</span>' : '') +
        '<span class="text-[9px] opacity-40 truncate max-w-[80px]">' + _esc(mode.presetName || "") + '</span>' +
        '<button class="btn btn-xs btn-ghost btn-square text-error/40 hover:text-error sg-remove-step" data-step-idx="' + idx + '" title="从组中移除">✕</button>';
      row.addEventListener("dragstart", function (e) {
        _dragFromIdx = idx;
        row.style.opacity = "0.4";
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));
      });
      row.addEventListener("dragend", function () { row.style.opacity = ""; _dragFromIdx = -1; });
      row.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        var rect = row.getBoundingClientRect();
        var mid = rect.top + rect.height / 2;
        row.style.borderTop = e.clientY < mid ? "2px solid var(--beilu-primary,#3b82f6)" : "";
        row.style.borderBottom = e.clientY >= mid ? "2px solid var(--beilu-primary,#3b82f6)" : "";
      });
      row.addEventListener("dragleave", function () { row.style.borderTop = ""; row.style.borderBottom = ""; });
      row.addEventListener("drop", function (e) {
        e.preventDefault();
        row.style.borderTop = ""; row.style.borderBottom = "";
        var fromIdx = _dragFromIdx;
        if (fromIdx < 0 || fromIdx === idx) return;
        var rect = row.getBoundingClientRect();
        var toIdx = e.clientY < rect.top + rect.height / 2 ? idx : idx + 1;
        if (fromIdx < toIdx) toIdx--;
        if (fromIdx === toIdx) return;
        var newSteps = (group.steps || []).slice();
        var moved = newSteps.splice(fromIdx, 1)[0];
        newSteps.splice(toIdx, 0, moved);
        sendAction({ verb: "updateFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename: group.filename, update: { steps: newSteps } } }) // T6b
          .then(function (rdata) {
            if (rdata && rdata.success) { _fetchSkillGroups().then(function () { _renderGroupList(); _renderGroupDetail(); }); }
          }).catch(function (err) { console.warn("[subModePanel] 拖拽排序失败:", err.message); });
      });
      row.addEventListener("click", function (e) {
        if (e.target.closest(".sg-remove-step") || e.target.closest(".sg-drag-handle")) return;
        _openEditForm(mode);
        _renderGroupDetail();
      });
      modeList.appendChild(row);
    });
    detail.appendChild(modeList);
  } else {
    detail.innerHTML += '<p class="text-[10px] text-base-content/50 text-center py-4">组内无子模式</p>';
  }

  // 添加步骤按钮
  var addStepRow = document.createElement("div");
  addStepRow.className = "flex items-center gap-1 mt-2 pt-2 border-t border-base-300/20";
  var availableModes = _subModes.filter(function (m) { return m.modeGroup === _manageTab; }); // [D4 0713]
  addStepRow.innerHTML =
    '<select id="sg-add-step-sel" class="select select-xs select-bordered flex-1 text-[10px]">' +
    '<option value="">选择子模式...</option>' +
    availableModes.map(function (m) { return '<option value="' + _esc(m.id) + '">' + _esc((m.icon || "") + " " + m.label) + '</option>'; }).join("") +
    '</select>' +
    '<button id="sg-add-step-btn" class="btn btn-xs btn-outline btn-success">添加</button>';
  detail.appendChild(addStepRow);

  // 绑定按钮事件
  var renameBtn = document.getElementById("sg-rename-btn");
  if (renameBtn) renameBtn.addEventListener("click", function () { _renameSkillGroup(group.filename, group.name); });
  var startBtn = document.getElementById("sg-start-btn");
  if (startBtn) startBtn.addEventListener("click", function () { _startSkillGroup(group.filename); });
  var deleteBtn = document.getElementById("sg-delete-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", function () { _deleteSkillGroup(group.filename, group.name); });
  var modelBtn = document.getElementById("sg-model-btn");
  if (modelBtn) modelBtn.addEventListener("click", async function () {
    if (await promptFlowGroupModelChange(group)) { await _fetchSkillGroups(); _renderGroupDetail(); }
  });

  // 添加步骤
  var addStepBtn = document.getElementById("sg-add-step-btn");
  if (addStepBtn) addStepBtn.addEventListener("click", async function () {
    var sel = document.getElementById("sg-add-step-sel");
    var modeId = sel ? sel.value : "";
    if (!modeId) return;
    var newSteps = (group.steps || []).concat([{ mode: modeId }]);
    try {
      var rdata = await sendAction({ verb: "updateFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename: group.filename, update: { steps: newSteps } } }); // T6b
      // [0716 E2 失败可见] 原 success:false 走假分支被静默丢弃（UI 无反馈不刷新）——对齐 workPanel:974 范式
      if (!rdata || !rdata.success) throw new Error((rdata && rdata.error) || "后端未受理");
      await _fetchSkillGroups(); _renderGroupList(); _renderGroupDetail();
    } catch (e) { console.warn("[subModePanel] 添加步骤失败:", e.message); _showToast("❌ 添加步骤失败: " + e.message); }
  });

  // 从组移除步骤
  detail.querySelectorAll(".sg-remove-step").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var stepIdx = parseInt(btn.dataset.stepIdx, 10);
      var newSteps = (group.steps || []).filter(function (_, i) { return i !== stepIdx; });
      try {
        var rdata = await sendAction({ verb: "updateFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename: group.filename, update: { steps: newSteps } } }); // T6b
        // [0716 E3 失败可见] 同 E2
        if (!rdata || !rdata.success) throw new Error((rdata && rdata.error) || "后端未受理");
        await _fetchSkillGroups(); _renderGroupList(); _renderGroupDetail();
      } catch (e) { console.warn("[subModePanel] 移除步骤失败:", e.message); _showToast("❌ 移除步骤失败: " + e.message); }
    });
  });
}

async function _renameSkillGroup(filename, currentName) {
  var newName = await beiluPrompt("重命名 Skill 组", currentName);
  if (!newName || newName.trim() === currentName) return;
  try {
    var data = await sendAction({ verb: "updateFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename, update: { name: newName.trim() } } }); // T6b
    // [0716 E4 失败可见] 同 E2
    if (!data || !data.success) throw new Error((data && data.error) || "后端未受理");
    await _fetchSkillGroups();
    _renderGroupList();
    _renderGroupDetail();
  } catch (e) { console.warn("[subModePanel] 重命名失败:", e.message); _showToast("❌ 重命名失败: " + e.message); }
}

async function _startSkillGroup(filename) {
  try {
    // 会话键：sendAction 门面统一盖章 scope.chatId→桥注入 args.chatid（键收口 2026-07-13），本处不手拼
    var data = await sendAction({ verb: "startFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename } }); // T6b
    // [0716 E5 失败可见] 同 E2
    if (!data || !data.success) throw new Error((data && data.error) || "后端未受理");
    // [0722 skill组隔离] 启动=后端已落盘 selected_groups，前端镜像同步（不再发 setSelectedFlowGroup 防双写）
    var startedGroup = _skillGroups.find(function (g) { return g.filename === filename; });
    if (startedGroup) {
      _selectedGroups[startedGroup.modeGroup || "code"] = filename;
      if (_topOpen) _renderTopModeList();
    }
    if (data.subModeSwitch && data.subModeSwitch.to) {
      var mode = _subModes.find(function (m) { return m.id === data.subModeSwitch.to; });
      if (mode) {
        await _switchToSubMode(mode);
      } else {
        window.dispatchEvent(new CustomEvent("beilu:subModeSwitched", { detail: data.subModeSwitch }));
      }
    }
  } catch (e) { console.warn("[subModePanel] 启动失败:", e.message); _showToast("❌ Skill 组启动失败: " + e.message); }
}

async function _deleteSkillGroup(filename, name) {
  if (!await beiluConfirm("删除 Skill 组「" + (name || filename) + "」？")) return;
  try {
    var data = await sendAction({ verb: "deleteFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { filename } }); // T6b
    // [0716 E6 失败可见] 同 E2
    if (!data || !data.success) throw new Error((data && data.error) || "后端未受理");
    _selectedGroupFn = null;
    await _fetchSkillGroups();
    _renderGroupList();
    _renderGroupDetail();
  } catch (e) { console.warn("[subModePanel] 删除失败:", e.message); _showToast("❌ 删除失败: " + e.message); }
}

async function _showCreateSkillGroupForm() {
  var name = await beiluPrompt("新建 Skill 组名称");
  if (!name || !name.trim()) return;
  var tabModes = _subModes.filter(function (m) { return m.modeGroup === _manageTab; }); // [D4 0713]
  var ov = document.createElement("div");
  ov.className = "fixed inset-0 bg-black/50 flex items-center justify-center"; ov.style.zIndex = "var(--z-diag)"; // 层级表单一权威(index.css)禁硬编码9999
  var opts = tabModes.map(function (m) {
    return '<label class="flex items-center gap-1.5 text-xs py-0.5"><input type="checkbox" class="sg-cb" data-mode="' + _esc(m.id) + '" data-preset="' + _esc(m.presetName || "") + '" data-label="' + _esc(m.label || m.id) + '" data-icon="' + _esc(m.icon || "") + '"/> ' + _esc((m.icon || "") + " " + (m.label || m.id)) + '</label>';
  }).join("");
  ov.innerHTML = '<div class="bg-base-200 rounded-lg p-4 w-80 max-h-[80vh] overflow-y-auto space-y-2">' +
    '<div class="font-bold text-sm">🗂️ 新建「' + _esc(name.trim()) + '」</div>' +
    '<div class="text-[11px] opacity-60">勾选子模式作为步骤：</div>' +
    '<div class="space-y-0.5">' + opts + '</div>' +
    '<div class="flex gap-2 pt-2"><button id="sg-save" class="btn btn-xs btn-primary flex-1">保存</button><button id="sg-cancel" class="btn btn-xs btn-ghost">取消</button></div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
  document.getElementById("sg-cancel").addEventListener("click", function () { ov.remove(); });
  document.getElementById("sg-save").addEventListener("click", async function () {
    var steps = [];
    ov.querySelectorAll(".sg-cb:checked").forEach(function (c) {
      steps.push({ mode: c.dataset.mode, preset_name: c.dataset.preset, label: c.dataset.label, icon: c.dataset.icon, modeGroup: _manageTab });
    });
    if (!steps.length) { _showToast("至少选一个子模式"); return; }
    try {
      var data = await sendAction({ verb: "saveFlowGroup", target: "plugins:beilu-memory", source: "web", payload: { name: name.trim(), steps, auto_advance: true, modeGroup: _manageTab } }); // T6b
      if (data && data.success) {
        ov.remove();
        _selectedGroupFn = data.filename;
        await _fetchSkillGroups();
        _renderGroupList();
        _renderGroupDetail();
      } else { _showToast("保存失败：" + (data && data.error || "")); }
    } catch (e) { _showToast("保存失败：" + e.message); }
  });
}

function _fillSubModeDetailForMode(mode) {
  _fillSubModeDetail(mode);
}

function _fillSubModeDetail(explicitMode) {
  var _activeTab = document.body.dataset.activeTab;
  var panel = _activeTab === "work"
    ? document.getElementById("work-submode-detail")
    : document.getElementById("ide-submode-detail");
  if (!panel || panel.style.display === "none") return;

  var mode = explicitMode
    || (_editingModeId ? _subModes.find(function (m) { return m.id === _editingModeId; }) : null)
    || _subModes.find(function (m) { return m.id === _getEffectiveActiveId(); });

  if (mode) {
    _openEditForm(mode);
  }
}

function _renderManageGroup(list, modes) {
  modes.forEach(function (mode, idx) {
    var isActive = mode.id === _getEffectiveActiveId();
    var item = document.createElement("div");
    item.className = "submode-manage-item group cursor-pointer";
    item.dataset.modeId = mode.id;
    item.addEventListener("click", function (e) {
      if (e.target.closest(".submode-manage-actions")) return;
      _fillSubModeDetailForMode(mode);
      _openEditForm(mode);
    });

    var metaHtml = "";
    if (mode.presetName || mode.apiSource || mode.modelName) {
      var parts = [];
      if (mode.presetName) parts.push("预设:" + mode.presetName);
      if (mode.apiSource) parts.push("API:" + mode.apiSource);
      if (mode.modelName) parts.push("模型:" + mode.modelName);
      metaHtml =
        '<div class="text-[9px] text-base-content/40 truncate">' +
        _esc(parts.join(" · ")) +
        "</div>";
    }

    var badges = "";
    if (isActive)
      badges +=
        '<span class="text-[9px] px-1 rounded" style="background:var(--beilu-amber-20);color:var(--beilu-amber)">活跃</span>';
    if (!mode.enabled && mode.enabled !== undefined)
      badges +=
        '<span class="text-[9px] bg-base-300 text-base-content/40 px-1 rounded">禁用</span>';

    item.innerHTML =
      '<span class="text-sm w-5 text-center flex-shrink-0">' +
      _esc(mode.icon || "💻") +
      "</span>" +
      '<div class="flex-1 min-w-0">' +
      '<div class="flex items-center gap-1">' +
      '<span class="text-xs font-medium truncate">' +
      _esc(mode.label) +
      "</span>" +
      badges +
      "</div>" +
      metaHtml +
      "</div>" +
      '<div class="submode-manage-actions">' +
      '<button class="btn btn-xs btn-ghost btn-square submode-set-active-btn" data-mode-id="' +
      _esc(mode.id) +
      '" title="设为活跃"><i data-ic="zap"></i></button>' +
      '<button class="btn btn-xs btn-ghost btn-square submode-edit-btn" data-mode-id="' +
      _esc(mode.id) +
      '" title="编辑"><i data-ic="edit"></i></button>' +
      '<button class="btn btn-xs btn-ghost btn-square text-error/60 submode-delete-btn" data-mode-id="' +
      _esc(mode.id) +
      '" title="删除"><i data-ic="trash"></i></button>' +
      "</div>";

    list.appendChild(item);
  });
}

function _populateApiSelect(selectedSource) {
  var sel = document.getElementById("submode-form-api");
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  _apiSources.forEach(function (src) {
    var opt = document.createElement("option");
    opt.value = src;
    opt.textContent = src;
    sel.appendChild(opt);
  });
  // API 被删/列表读失败时保留存量绑定，不能在一次编辑保存里静默清空。
  if (selectedSource && !_apiSources.includes(selectedSource)) {
    var missing = document.createElement("option");
    missing.value = selectedSource;
    missing.textContent = "⚠ " + selectedSource + "（当前绑定，未在服务源列表中找到）";
    sel.appendChild(missing);
  }
}

function _populateBackupApiSelect(selectedSource) {
  var sel = document.getElementById("submode-form-backup-api");
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  _apiSources.forEach(function (src) {
    var opt = document.createElement("option");
    opt.value = src;
    opt.textContent = src;
    sel.appendChild(opt);
  });
  if (selectedSource && !_apiSources.includes(selectedSource)) {
    var missing = document.createElement("option");
    missing.value = selectedSource;
    missing.textContent = "⚠ " + selectedSource + "（当前绑定，未在服务源列表中找到）";
    sel.appendChild(missing);
  }
}

function _renderSubModeApiGuide() {
  var guide = document.getElementById("submode-api-guide");
  if (!guide) return;
  var selectedApi = document.getElementById("submode-form-api")?.value || "";
  var setup = _aiSetupStatus;
  var message = "";
  var tone = "text-base-content/70";

  if (selectedApi) {
    var usable = Array.isArray(setup?.usableSourceNames) ? setup.usableSourceNames.includes(selectedApi) : _apiSources.includes(selectedApi);
    if (usable) {
      message = "此子模式已单独绑定 API 源「" + _esc(selectedApi) + "」——生效期间本轮请求实际使用该源（per-request 覆盖，不改角色绑定）。模型留空时使用该源的默认模型。";
    } else {
      tone = "text-warning";
      message = "此子模式绑定的 API 源「" + _esc(selectedApi) + "」当前不完整或已不存在；保存前请到 API 服务源设置修复。";
    }
  } else if (setup?.configured === true) {
    var defaults = Array.isArray(setup.usableDefaultNames) ? setup.usableDefaultNames : [];
    // [D3 0804 断点8 文案根修·235734] 原文案「将跟随全局默认源」与真实链路不符：无 override 时
    //   实际使用**当前角色绑定的 AI 源**（char-template _effSource=AIsource；角色未绑定才回退默认源）
    //   ——UI 声称权威与请求实际权威必须一致，不装"全局默认"。
    message = "此子模式未单独绑定 API，本轮请求将使用当前角色绑定的 AI 源；角色未绑定时回退全局默认源" + (defaults.length ? "「" + _esc(defaults.join("、")) + "」" : "") + "。";
  } else if (setup?.status === "default_missing") {
    tone = "text-warning";
    message = "此子模式未绑定 API；检测到服务源但尚未设置全局默认，当前不能依赖默认源回复。";
  } else if (setup?.status === "unknown") {
    tone = "text-warning";
    message = "无法确认 API 状态。子模式不保存 Key/URL，请到 AI 服务源设置检查后返回。";
  } else {
    tone = "text-warning";
    message = "此子模式未绑定 API，且没有可用的全局默认源。请先配置 AI 服务源。";
  }

  // [D3 0804 断点8] fallback 策略可见化：独立源加载失败时的真实行为随表单当前选择实时显示
  var _fbPolicy = document.getElementById("submode-form-fallback-policy")?.value || "fail_closed";
  var _fbBackup = document.getElementById("submode-form-backup-api")?.value || "";
  var fallbackLine = selectedApi
    ? (_fbPolicy === "explicit_fallback"
      ? "源失败策略：显式回退——「" + _esc(selectedApi) + "」失败时先试" + (_fbBackup ? "备用源「" + _esc(_fbBackup) + "」" : "备用源（未设）") + "，再用角色绑定/默认源（每次回退都留痕）。"
      : "源失败策略：安全中止——「" + _esc(selectedApi) + "」加载失败时本轮报错不发送，不会静默换源。")
    : "";
  guide.innerHTML =
    '<div class="' + tone + '">' + message + '</div>' +
    (fallbackLine ? '<div class="mt-1 text-base-content/60">' + fallbackLine + '</div>' : '') +
    '<div class="mt-1 text-base-content/50">API Key、地址和模型先在“AI 服务源”保存；本页只决定这个子模式是否覆盖角色绑定/全局默认。</div>' +
    '<button type="button" id="submode-api-guide-open" class="btn btn-xs btn-outline mt-1">打开 AI 服务源设置 →</button>';
  guide.querySelector("#submode-api-guide-open")?.addEventListener("click", function () {
    window.dispatchEvent(new CustomEvent("beilu:openApiSettings", { detail: { source: "submode-api-guide" } }));
  });
}

/** 根据选中的 API 源获取其可用模型列表，填充模型下拉 */
var _modelSelectReqId = 0;
async function _populateModelSelect(apiSourceName, currentModel) {
  var sel = document.getElementById("submode-form-model");
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  var reqId = ++_modelSelectReqId;

  if (!apiSourceName) return;

  // [0717 撤 0716 决定] 凛倾定案「拉条是每次都需要访问,不是访问一次就缓存」：表单打开/切源=
  //   用户点击驱动，传 force 实时访问源（失败仍回落收口内的上次成功缓存=诚实降级不空转）。
  var models = [];
  try {
    var fn = window._beiluGetModelList;
    models = fn ? await fn(apiSourceName, { force: true }) : [];
  } catch (e) { console.warn("[subModePanel] 模型列表获取失败:", e.message); }

  // 竞态检查——如果获取期间用户已切换 API 源，丢弃结果
  if (reqId !== _modelSelectReqId) return;

  // 0714 失败可见（凛倾「不会去自动请求模型」案实为请求失败被静默吞）：空结果给不可选提示项，
  //   空下拉不自解释——用户无从分辨「没自动请求」和「请求失败」。具体原因已进报错系统(_reportError)。
  if (!models.length) {
    var failOpt = document.createElement("option");
    failOpt.disabled = true;
    failOpt.textContent = "⚠ 未获取到模型列表（检查该 API 源的 URL/Key，详见运行时日志）";
    sel.appendChild(failOpt);
  }

  // 渲染（sync）——一次性填充 DOM
  models.forEach(function (id) {
    if (!id) return;
    var opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id + (id === currentModel ? "（当前配置）" : "");
    sel.appendChild(opt);
  });

  // 设置当前值
  if (currentModel) {
    sel.value = currentModel;
    // 如果当前值不在列表中，手动添加
    if (sel.value !== currentModel) {
      var extraOpt = document.createElement("option");
      extraOpt.value = currentModel;
      extraOpt.textContent = currentModel + "（已绑定）";
      sel.insertBefore(extraOpt, sel.firstChild.nextSibling);
      sel.value = currentModel;
    }
  }
}

// [0713 病灶审计] _normalizeModelUrl（API URL→/models 端点转换）全库零调用死代码，纯删；
//   模型列表现走 window._beiluGetModelList / apiChannels.modelsRequestFor 单源。

function _populatePresetSelect() {
  var sel = document.getElementById("submode-form-preset");
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  _presetList.forEach(function (name) {
    var opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

function _openEditForm(mode) {
  var form = document.getElementById("submode-edit-form");
  if (!form) return;
  // 与分身编辑共用右栏：打开子模式编辑时移除内联分身编辑表单，避免两个表单嵌套同显
  var _cfNest = document.getElementById("clone-editor-inline");
  if (_cfNest) _cfNest.remove();

  // 将编辑表单移到右栏——按当前模式选对应容器（不能靠 inline display 判断，
  // 因为切模式时对方容器的 inline style 不一定被重置）
  var _activeTab = document.body.dataset.activeTab;
  var rightPanel = _activeTab === "work"
    ? document.getElementById("work-submode-detail")
    : document.getElementById("ide-submode-detail");
  if (rightPanel && rightPanel.style.display !== "none") {
    var rightInner = rightPanel.querySelector(".p-4");
    if (rightInner) {
      var ph = rightPanel.querySelector("[id$='smd-placeholder']");
      if (ph) ph.style.display = "none";
      var titleEl = rightPanel.querySelector("[id$='smd-title']");
      if (titleEl) titleEl.textContent = (mode ? (mode.icon || "") + " " + (mode.label || mode.id) : "新建子模式");
      if (form.parentElement !== rightInner) {
        rightInner.appendChild(form);
      }
    }
  }

  _editingModeId = mode ? mode.id : null;

  // [0720 凛倾「没办法删除子模式」] 删除按钮仅编辑已有子模式时可见(新建态无删除语义)
  var _delBtnVis = document.getElementById("submode-form-delete");
  if (_delBtnVis) _delBtnVis.classList.toggle("hidden", !mode);

  document.getElementById("submode-form-title").textContent = mode
    ? "编辑子模式"
    : "新建子模式";

  var idInput = document.getElementById("submode-form-id");
  idInput.value = mode ? mode.id : "";
  idInput.disabled = !!mode;

  document.getElementById("submode-form-icon").value = mode
    ? mode.icon || ""
    : "";
  document.getElementById("submode-form-label").value = mode
    ? mode.label || ""
    : "";
  document.getElementById("submode-form-desc").value = mode
    ? mode.desc || ""
    : "";
  // 所属模式：编辑时取已有值，新建时取当前标签页
  var mgSel = document.getElementById("submode-form-modegroup");
  if (mgSel) mgSel.value = mode ? mode.modeGroup : _manageTab; // [D4 0713]
  // D7a 改进：绑定预设改为下拉选择（从后端 preset_list 获取）
  _populatePresetSelect();
  // 预设链修（凛倾07-05）：下拉原只 init 拉一次，init 失败=永久空。开表单发现空则异步重拉后重填+恢复选中值
  if (!_presetList.length) {
    _fetchPresetList().then(function () {
      _populatePresetSelect();
      var ps = document.getElementById("submode-form-preset");
      if (ps && mode && mode.presetName) ps.value = mode.presetName;
    }).catch(function () { /* 失败可见由门面 _report 承担 */ });
  }
  var presetSel = document.getElementById("submode-form-preset");
  if (presetSel) presetSel.value = mode ? mode.presetName || "" : "";
  document.getElementById("submode-form-enabled").checked = mode
    ? mode.enabled !== false
    : true;

  var selectedApiSource = mode ? mode.apiSource || "" : "";
  _populateApiSelect(selectedApiSource);
  var apiSel = document.getElementById("submode-form-api");
  if (apiSel) apiSel.value = selectedApiSource;

  // 填充模型下拉（基于当前选中的 API 源）
  var initialApi = mode ? mode.apiSource || "" : "";
  _populateModelSelect(initialApi, mode ? mode.modelName || "" : "");

  // API 源切换时联动刷新模型列表
  if (apiSel) {
    apiSel.onchange = function () {
      _populateModelSelect(apiSel.value, "");
      _renderSubModeApiGuide();
    };
  }

  // 回填提示词后处理 + 预填充
  var ppSel = document.getElementById("submode-form-postprocess");
  if (ppSel) ppSel.value = mode ? mode.promptPostProcessing || "" : "strict";
  var pfCheck = document.getElementById("submode-form-prefill");
  if (pfCheck) pfCheck.checked = mode ? !!mode.prefillEnabled : false;
  var cpSel = document.getElementById("submode-form-claude-prefill");
  if (cpSel) cpSel.value = mode ? mode.claudePrefillMode || "" : "";
  // 备用API源回填
  var backupApiSource = mode ? mode.backup_api_source || "" : "";
  _populateBackupApiSelect(backupApiSource);
  var backupApiSel = document.getElementById("submode-form-backup-api");
  if (backupApiSel) backupApiSel.value = backupApiSource;
  // [D3 0804] 源失败策略回填（缺字段=默认 fail_closed，与后端写门 normalizeSubModeForSave 同默认）
  var fbPolicySel = document.getElementById("submode-form-fallback-policy");
  if (fbPolicySel) fbPolicySel.value = mode && mode.fallbackPolicy === "explicit_fallback" ? "explicit_fallback" : "fail_closed";
  // [D3 0804 断点8] fallback 策略/备用源改选 → guide 实时反映真实失败行为（与 apiSel.onchange 同刷新范式；
  //   挂接位置必须在两 select 赋值之后——var 提升但赋值顺序在 apiSel 块之后）
  if (fbPolicySel) fbPolicySel.onchange = _renderSubModeApiGuide;
  if (backupApiSel) backupApiSel.onchange = _renderSubModeApiGuide;
  // 温度/最大上下文/最大输出回填
  var tempInput = document.getElementById("submode-form-temperature");
  if (tempInput) tempInput.value = mode && mode.temperature !== undefined ? mode.temperature : "";
  var maxCtxInput = document.getElementById("submode-form-max-context");
  if (maxCtxInput) maxCtxInput.value = mode && mode.maxContext ? mode.maxContext : "1000000";
  var maxTokInput = document.getElementById("submode-form-max-tokens");
  if (maxTokInput) maxTokInput.value = mode && mode.maxTokens ? mode.maxTokens : "30000";
  // 链路2扩展：top_k/min_p 回填（0 是合法显式值，用 !== undefined 判定同温度）
  var topKInput = document.getElementById("submode-form-top-k");
  if (topKInput) topKInput.value = mode && mode.top_k !== undefined ? mode.top_k : "";
  var minPInput = document.getElementById("submode-form-min-p");
  if (minPInput) minPInput.value = mode && mode.min_p !== undefined ? mode.min_p : "";
  // thinking 回填段已删（2026-08-01 收口到 AI 源面板，见表单处注释）

  // [0730] 工具权限开关回填（undefined/缺字段=默认允许=checked）
  var _aceEl = document.getElementById("submode-form-allow-code-edit");
  if (_aceEl) _aceEl.checked = !mode || mode.allowCodeEdit !== false;
  var _arcEl = document.getElementById("submode-form-allow-run-command");
  if (_arcEl) _arcEl.checked = !mode || mode.allowRunCommand !== false;
  var _adEl = document.getElementById("submode-form-allow-delete");
  if (_adEl) _adEl.checked = !mode || mode.allowDelete !== false;

  var status = document.getElementById("submode-form-status");
  if (status) status.classList.add("hidden");

  _renderSubModeApiGuide();
  if (!_aiSetupStatus || _aiSetupStatus.status === "unknown") {
    _fetchAISetupStatus().then(function () { _renderSubModeApiGuide(); });
  }

  form.classList.remove("hidden");
  document.getElementById("submode-form-label").focus();

  // 留空字段回退到全局运行时生效值；GET 回填生效值作为 placeholder 提示，让用户看到留空时的实际取值
  _fillEffectiveParamHints();
}

// GET beilu-preset 运行时参数（含 _effective_* 生效值），更新表单留空字段的 placeholder
async function _fillEffectiveParamHints() {
  try {
    const p = await sendAction({ verb: "getRuntimeParams", target: "plugins:beilu-preset", source: "web" }); // T6b
    var tempInput = document.getElementById("submode-form-temperature");
    if (tempInput && p._effective_temperature !== undefined) {
      tempInput.placeholder = "默认 (生效: " + p._effective_temperature + ")";
    }
    var maxCtxInput = document.getElementById("submode-form-max-context");
    if (maxCtxInput && p._effective_max_context !== undefined) {
      maxCtxInput.placeholder = "默认 (生效: " + p._effective_max_context + ")";
    }
    var maxTokInput = document.getElementById("submode-form-max-tokens");
    if (maxTokInput && p._effective_max_tokens !== undefined) {
      maxTokInput.placeholder = "默认 (生效: " + p._effective_max_tokens + ")";
    }
  } catch (e) {
    console.warn("[subModePanel] 获取运行时生效参数失败:", e.message);
  }
}

function _closeEditForm() {
  var form = document.getElementById("submode-edit-form");
  if (form) form.classList.add("hidden");
  _editingModeId = null;
  var cloneForm = document.getElementById("clone-editor-inline");
  if (cloneForm) cloneForm.remove();
  ["ide-submode-detail", "work-submode-detail"].forEach(function (panelId) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    var titleEl = panel.querySelector("[id$='smd-title']");
    if (titleEl) titleEl.textContent = "子模式详情";
    var ph = panel.querySelector("[id$='smd-placeholder']");
    if (ph) ph.style.display = "";
  });
}

function _showFormStatus(msg, type) {
  var el = document.getElementById("submode-form-status");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.className =
    "text-[10px] text-center mt-1 " +
    (type === "error" ? "text-error" : "text-success");
  el.classList.remove("hidden");
}

function _bindManagePanelEvents() {
  // 标签页切换
  var tabCode = document.getElementById("submode-tab-code");
  var tabWork = document.getElementById("submode-tab-work");
  if (tabCode) {
    tabCode.addEventListener("click", function () {
      _manageTab = "code";
      _selectedGroupFn = null;
      _closeEditForm();
      _renderManageList();
    });
  }
  if (tabWork) {
    tabWork.addEventListener("click", function () {
      _manageTab = "work";
      _selectedGroupFn = null;
      _closeEditForm();
      _renderManageList();
    });
  }
  var tabClones = document.getElementById("submode-tab-clones");
  if (tabClones) {
    tabClones.addEventListener("click", function () {
      _manageTab = "clones";
      _closeEditForm();
      _renderManageList();
    });
  }

  // 新建
  var addBtn = document.getElementById("submode-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      _openEditForm(null);
    });
  }

  // 恢复默认
  var resetBtn = document.getElementById("submode-reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", async function () {
      if (!await beiluConfirm("确定恢复为默认子模式？\n（默认集由后端定义下发，当前自定义配置将被覆盖）")) return;
      // T010 单源重置：清空配置 → 后端 getSubModes 对空配置自动播种默认集（storage.mjs 唯一定义源），
      // 前端不再持有默认副本（原副本已与后端漂移：本体18 vs 后端22）
      var ok = await _saveSubModes([]);
      if (ok) ok = await _fetchSubModes();
      if (ok) {
        _renderManageList();
        _updateTriggerBar();
        _showToast("✅ 已恢复默认子模式（" + _subModes.length + " 个，后端定义）");
      } else {
        _showToast("❌ 恢复失败");
      }
    });
  }

  // 保存
  var saveBtn = document.getElementById("submode-form-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", async function () {
      // [多窗口审计 2026-07-11 A1] cid 入口快照：下方 switch_preset 原在两次 await 之后现取 hash，
      //   保存期间用户切会话/切 tab 会把预设切换写到新会话线（写点标识时效病，同 featureControls F1 族）
      // [0727 A5 审计 leak 点] 快照源统一走同文件 _getCurrentChatId()（可见窗口优先）：原直读 hash 桥
      //   =绕开封装的第二套口径，副窗口显示时保存落到主窗口 a 的键上。
      var _saveCid = _getCurrentChatId() || undefined;
      var idVal = document.getElementById("submode-form-id").value.trim();
      var label = document.getElementById("submode-form-label").value.trim();
      if (!label) {
        _showFormStatus("名称不能为空", "error");
        return;
      }
      var id =
        idVal ||
        label
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "");
      if (!id) {
        _showFormStatus("ID 无效", "error");
        return;
      }
      if (
        !_editingModeId &&
        _subModes.some(function (m) {
          return m.id === id;
        })
      ) {
        _showFormStatus("ID 已存在", "error");
        return;
      }

      var _tempVal = document.getElementById("submode-form-temperature").value;
      var _maxCtxVal = document.getElementById("submode-form-max-context").value;
      var _maxTokVal = document.getElementById("submode-form-max-tokens").value;
      var _topKVal = document.getElementById("submode-form-top-k").value;
      var _minPVal = document.getElementById("submode-form-min-p").value;
      // 跨端字段保全（2026-07-10）：编辑时以旧对象为基底 merge——原整对象重建会抹掉本表单没有的
      //   字段（YonBan 写的 top_p/top_k/min_p/max_tokens 蛇形键、model_params 副本等），本体一编辑
      //   该子模式另一端设的值就丢。undefined 值经 JSON 序列化即字段消失，清空语义不受影响。
      var _prevMode = (_editingModeId && _subModes.find(function (m) { return m.id === _editingModeId; })) || {};
      var newMode = Object.assign({}, _prevMode, {
        id: id,
        label: label,
        icon: document.getElementById("submode-form-icon").value.trim() || "💻",
        desc: document.getElementById("submode-form-desc").value.trim(),
        modeGroup: document.getElementById("submode-form-modegroup").value || _manageTab,
        presetName: document.getElementById("submode-form-preset").value.trim(),
        apiSource: document.getElementById("submode-form-api").value,
        modelName: document.getElementById("submode-form-model").value,
        promptPostProcessing: document.getElementById("submode-form-postprocess").value,
        prefillEnabled: document.getElementById("submode-form-prefill").checked,
        claudePrefillMode: document.getElementById("submode-form-claude-prefill").value,
        temperature: _tempVal !== "" ? parseFloat(_tempVal) : undefined,
        maxContext: _maxCtxVal !== "" ? parseInt(_maxCtxVal) : undefined,
        maxTokens: _maxTokVal !== "" ? parseInt(_maxTokVal) : undefined,
        top_k: _topKVal !== "" ? parseInt(_topKVal) : undefined,   // 链路2扩展：蛇形键对齐读侧 _activeSM.top_k
        min_p: _minPVal !== "" ? parseFloat(_minPVal) : undefined, // 链路2扩展：同上
        // thinking 收口清洗（2026-08-01）：控件已删，但本表单以旧对象为基底 merge——不显式置
        //   undefined 则存量子模式里的旧 extended_thinking/thinking_budget 会被 merge 永久保留。
        //   undefined 经 JSON 序列化即键消失 = 保存一次即清掉存量覆盖。
        extended_thinking: undefined,
        thinking_budget: undefined,
        backup_api_source: document.getElementById("submode-form-backup-api").value || "",
        // [D3 0804] 源失败策略（二值枚举，非法值落安全默认；后端写门 normalizeSubModeForSave 同规则兜底）
        fallbackPolicy: document.getElementById("submode-form-fallback-policy")?.value === "explicit_fallback" ? "explicit_fallback" : "fail_closed",
        enabled: document.getElementById("submode-form-enabled").checked,
        // [0730] 工具权限开关（false=系统强制禁止，true/undefined=允许）
        allowCodeEdit: document.getElementById("submode-form-allow-code-edit")?.checked !== false ? undefined : false,
        allowRunCommand: document.getElementById("submode-form-allow-run-command")?.checked !== false ? undefined : false,
        allowDelete: document.getElementById("submode-form-allow-delete")?.checked !== false ? undefined : false,
      });
      // B18 副本同步：merge 基底保留了旧 model_params，而读侧（getPromptHandler _mp.* ?? 扁平）以副本
      //   为最高优先——不同步则表单刚改的值被旧副本盖住（写活读死）。表单管辖的键全部写入副本，
      //   undefined 经 JSON 序列化即键消失（清空=回落扁平/无覆盖，语义不变）；表单不管的键（top_p 等
      //   YonBan/顶栏写入）原样保留。
      if (newMode.model_params && typeof newMode.model_params === "object") {
        newMode.model_params = Object.assign({}, newMode.model_params, {
          model: newMode.modelName || undefined,
          api_source: newMode.apiSource || undefined,
          temperature: newMode.temperature,
          max_context: newMode.maxContext,
          max_tokens: newMode.maxTokens,
          top_k: newMode.top_k,
          min_p: newMode.min_p,
          extended_thinking: undefined, // thinking 收口清洗（2026-08-01）：副本存量键同步清除
          thinking_budget: undefined,
          prompt_post_processing: newMode.promptPostProcessing || undefined,
          claude_prefill_mode: newMode.claudePrefillMode || undefined,
          prefill_enabled: newMode.prefillEnabled,
          // 驼峰别名键清除：读侧 ?? 链副本别名（modelName/apiSource/maxContext/maxTokens）优先级高于
          //   扁平新值，残留旧别名会在主键为 undefined 时借尸还魂
          modelName: undefined, apiSource: undefined, maxContext: undefined, maxTokens: undefined,
          promptPostProcessing: undefined, claudePrefillMode: undefined, prefillEnabled: undefined,
        });
      }

      var newModes;
      if (_editingModeId) {
        newModes = _subModes.map(function (m) {
          return m.id === _editingModeId ? newMode : m;
        });
      } else {
        newModes = [].concat(_subModes, [newMode]);
      }

      saveBtn.textContent = "⏳";
      saveBtn.disabled = true;

      var ok = await _saveSubModes(newModes);

      saveBtn.textContent = "💾 保存";
      saveBtn.disabled = false;

      if (ok) {
        // [0804 根因修·RC11断点6] 原此处在保存子模式后 switchPreset + updatePresetConfig 把
        //   temperature/maxTokens 写进绑定预设的 model_params——三重跨域副作用：①改「当前激活预设」
        //   ②污染可被其他窗口/角色/子模式复用的预设基线 ③与子模式覆盖层双写分叉（maxContext 族
        //   0713 已单源化，temperature/maxTokens 当时遗留）。生效链证据：mergeRuntimeParams
        //   （preset/main.mjs:1156-1157）子模式 sub_mode_temperature/sub_mode_max_tokens 在预设
        //   model_params 之后展开=最高优先，且「每轮都有，不依赖 runtime-params」——参数只存子模式
        //   即 per-request 生效，预设写属纯冗余。原「未绑定预设参数不会生效」警告同为错误认知，一并删除。
        //   保存子模式 = 只写子模式定义；预设基线只由预设面板/导入维护。
        if (newMode.temperature !== undefined || newMode.maxTokens) {
          var _mpUpdate = {};
          if (newMode.temperature !== undefined) _mpUpdate.temperature = newMode.temperature;
          if (newMode.maxTokens) _mpUpdate.max_tokens = newMode.maxTokens;
          // 仅同步参数面板显示（子模式覆盖层的当前值），零后端预设写
          if (window.syncModelParamsUI) window.syncModelParamsUI(_mpUpdate);
          if (window.refreshTokenProgress) window.refreshTokenProgress();
        }
        // 0714 根修（凛倾「保存后转跳为空白，子模式管理也是」）：原 _closeEditForm() 把右栏踢回
        //   「未选择子模式」占位=保存即丢选中态（操作逻辑闭环：保存≠退出编辑）。改为先重渲列表
        //   （左栏名称/图标同步），再按保存后的 newMode 重开表单——右栏停留在刚保存的子模式上。
        _renderManageList();
        _openEditForm(newMode);
        _updateTriggerBar();
        _showToast("✅ " + newMode.icon + " " + newMode.label + " 已保存");
      } else {
        _showFormStatus("保存失败", "error");
      }
    });
  }

  // 取消
  // [0720 凛倾「没办法删除子模式」] 删除本体:后端 deleteSubMode 级联清理(sub_modes/激活指针/
  //   per-chat map/触发栏快捷位/当前角色流程组 steps),预设文件不删(预设域闭案)。成功后以后端
  //   返回表为权威更新本地并重渲(与 _saveSubModes Drift 教训同款:必看返回值,不盲乐观)。
  var deleteBtn = document.getElementById("submode-form-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async function () {
      if (!_editingModeId) return;
      var _delMode = _subModes.find(function (m) { return m.id === _editingModeId; });
      if (!await beiluConfirm("确定删除子模式「" + (_delMode?.label || _editingModeId) + "」？\n将同时清理其在 Skill 组/触发栏/激活指针中的引用（绑定的预设文件保留）。")) return;
      try {
        var _charName = document.getElementById("header-char-name-text")?.textContent || undefined;
        var data = await sendAction({ verb: "deleteSubMode", target: "plugins:beilu-memory", source: "web", payload: { id: _editingModeId, charName: _charName } });
        if (data && data.success) {
          if (Array.isArray(data.sub_modes)) _subModes = data.sub_modes;
          _showToast("已删除子模式");
          _closeEditForm();
          _renderManageList();
        } else {
          _showToast("删除失败：" + (data && data.error || "未知错误"));
        }
      } catch (e) { _showToast("删除失败：" + e.message); }
    });
  }

  var cancelBtn = document.getElementById("submode-form-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function () {
      _closeEditForm();
    });
  }

  // 列表操作委托
  var manageList = document.getElementById("submode-detail-panel") || document.getElementById("submode-manage-list");
  if (manageList) {
    manageList.addEventListener("click", async function (e) {
      var setActiveBtn = e.target.closest(".submode-set-active-btn");
      var editBtn = e.target.closest(".submode-edit-btn");
      var deleteBtn = e.target.closest(".submode-delete-btn");

      if (setActiveBtn) {
        var modeId = setActiveBtn.dataset.modeId;
        var mode = _subModes.find(function (m) { return m.id === modeId; });
        if (mode) {
          await _switchToSubMode(mode);
        }
      }

      if (editBtn) {
        var modeId2 = editBtn.dataset.modeId;
        console.log("[subModePanel] 编辑按钮点击:", modeId2, "_subModes长度:", _subModes.length);
        var mode2 = _subModes.find(function (m) { return m.id === modeId2; });
        if (mode2) {
          _openEditForm(mode2);
          var formEl = document.getElementById("submode-edit-form");
          if (formEl) formEl.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          console.warn("[subModePanel] 找不到模式:", modeId2, "可用模式:", _subModes.map(function(m){ return m.id; }));
        }
      }

      if (deleteBtn) {
        var modeId3 = deleteBtn.dataset.modeId;
        var mode3 = _subModes.find(function (m) { return m.id === modeId3; });
        if (!mode3) return;
        if (!await beiluConfirm("确定删除子模式「" + mode3.label + "」？")) return;
        var newModes = _subModes.filter(function (m) {
          return m.id !== modeId3;
        });
        if (await _saveSubModes(newModes)) {
          if (_getEffectiveActiveId() === mode3.id && newModes.length > 0) {
            var _sameGroup = newModes.find(function(m) { return m.modeGroup === mode3.modeGroup; });
            await _setActiveSubMode((_sameGroup || newModes[0]).id);
          }
          _renderManageList();
          _updateTriggerBar();
          _showToast("🗑 " + mode3.icon + " " + mode3.label + " 已删除");
        }
      }
    });
  }
}

// ============================================================
// 事件绑定
// ============================================================

function _bindTriggerEvents() {
  // 对话选择触发器
  var convTrigger = document.getElementById("conv-trigger-btn");
  if (convTrigger) {
    convTrigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (_popupOpen && _popupTarget === "conv") {
        _closePopup();
      } else {
        if (_popupOpen) _closePopup();
        _openPopup("conv");
      }
    });
  }

  // 新建对话按钮
  var convNewBtn = document.getElementById("submode-conv-new-btn"); // 重复id根修 2026-07-06：见 _injectTriggerBar 内注释
  if (convNewBtn) {
    convNewBtn.addEventListener("click", async function (e) {
      e.stopPropagation();
      _closePopup();
      try {
        const { doCreateNewChat, fetchChatList: _fcl } = await import("../../shared/chat-core/conversationManager.mjs");
        await doCreateNewChat();
        // [0713 病灶审计 C2] 原 setTimeout(500) 猜时机删除：hash 切换由 hashchange 监听器确定性更新标签；
        //   此处补的是数据面——新对话尚不在 _cachedConvList，刷新缓存后直接更新（无缓存命中时标签退化为 id 截断）。
        try { _cachedConvList = await _fcl(); } catch { /* 保留旧缓存，标签退化为 id 截断 */ }
        _updateConvLabel();
      } catch (err) {
        console.warn("[subModePanel] 新建对话失败:", err.message);
      }
    });
  }

  var apiTrigger = document.getElementById("submode-api-trigger");
  if (apiTrigger) {
    apiTrigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (_popupOpen && _popupTarget === "api") {
        _closePopup();
      } else {
        if (_popupOpen) _closePopup();
        _fetchApiSources().then(function () {
          _openPopup("api");
        });
      }
    });
  }

  var modelTrigger = document.getElementById("submode-model-trigger");
  if (modelTrigger) {
    modelTrigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (_popupOpen && _popupTarget === "model") {
        _closePopup();
      } else {
        if (_popupOpen) _closePopup();
        _openPopup("model");
      }
    });
  }

  // 搜索框输入 + 阻止冒泡
  var search = document.getElementById("submode-popup-search");
  if (search) {
    search.addEventListener("input", function () {
      var val = search.value.trim();
      if (_popupTarget === "conv") {
        _renderPopupConvList(val);
      } else if (_popupTarget === "model") {
        _renderPopupModelList(val);
      } else {
        _renderPopupApiList(val);
      }
    });
    search.addEventListener("click", function (e) {
      e.stopPropagation();
    });
  }

  // 监听 hashchange 更新对话标签
  window.addEventListener("hashchange", _updateConvLabel);
}

// ============================================================
// 分身AI管理 (W65)
// ============================================================

var _clones = [];
var _cloneTemplate = null; // 07-09：后端 getClones 下发的新建分身默认值单源（loadClones 填充）
var _cloneConfigRevision = null;

// A4 username 权威化：username 由后端路由层从登录态注入（单一来源）。
// 后端解析失败时返回 {success:false,error}，前端显式 toast 报错，不静默吞成空列表装正常。
async function _loadClones() {
  try {
    var data = await sendAction({ verb: "getClones", target: "plugins:beilu-memory", source: "web" }); // T6b
    if (data && data.success === false) {
      _showToast("❌ 分身加载失败：" + (data.error || "未能识别登录用户名"), 3500);
      console.warn("[subModePanel] 加载分身失败:", data.error);
      return false;
    }
    _clones = data.clones || [];
    _cloneConfigRevision = data.configRevision ?? null;
    // 07-09 使用链走查：后端 clone_template=新建分身默认值单源（表单回填/收集/权限默认全用它，
    //   原表单持 ||10/||60000/defaultPerms 等写死副本——值与后端一致但物理双写=漂移源）
    if (data.clone_template) _cloneTemplate = data.clone_template;
    return true;
  } catch (e) {
    _showToast("❌ 分身加载失败：" + (e.message || "网络错误"), 3500);
    console.warn("[subModePanel] 加载分身失败:", e.message);
    return false;
  }
}

async function _saveClones() {
  try {
    var data = await sendAction({ verb: "saveClones", target: "plugins:beilu-memory", source: "web", payload: { clones: _clones, configRevision: _cloneConfigRevision } }); // T6b
    if (data && data.success === false) {
      _showToast("❌ 分身保存失败：" + (data.error || "未能识别登录用户名"), 3500);
      console.warn("[subModePanel] 保存分身失败:", data.error);
      return false;
    }
    _clones = data.clones || [];
    _cloneConfigRevision = data.configRevision;
    return true;
  } catch (e) {
    _showToast("❌ 分身保存失败：" + (e.message || "网络错误"), 3500);
    console.warn("[subModePanel] 保存分身失败:", e.message);
    return false;
  }
}

function _renderCloneLeftPanel(container) {
  container.innerHTML = "";
  var ensureClones = function(cb) {
    if (_clones.length === 0) { _loadClones().then(cb); } else { cb(); }
  };
  ensureClones(function() {
    for (var i = 0; i < _clones.length; i++) {
      var cl = _clones[i];
      var item = document.createElement("div");
      item.className = "p-2 rounded cursor-pointer text-xs hover:bg-base-300/60 flex items-center justify-between";
      item.dataset.cloneIdx = i;
      item.innerHTML =
        '<div><span class="font-bold"><i data-ic="person"></i> ' + _esc(cl.label || "未命名") + '</span>' +
        '<div class="opacity-40 text-[10px]">' + (cl.enabled ? '<i data-ic="check"></i>' : "⬜") + ' ' + (cl.modelName || "默认") + '</div></div>';
      item.addEventListener("click", (function(idx) { return function() { _renderCloneDetailPanel(idx); }; })(i));
      container.appendChild(item);
    }
    var addBtn = document.createElement("button");
    addBtn.className = "btn btn-xs btn-outline w-full mt-2";
    addBtn.style.borderColor = "var(--beilu-amber)"; addBtn.style.color = "var(--beilu-amber)";
    addBtn.innerHTML = '<i data-ic="plus"></i> 添加分身';
    addBtn.addEventListener("click", function() { _openCloneEditor(null); });
    container.appendChild(addBtn);

    // 编程表格定期清理频率是独立功能，不属于已删除的重复分身列表。
    var tableCleanSection = document.createElement("div");
    tableCleanSection.className = "mt-4 pt-3 border-t border-base-300";
    tableCleanSection.innerHTML =
      '<div class="flex items-center gap-2 text-[11px]"><span class="w-20 font-bold">🧹 表格清理</span>' +
      '<input type="number" id="tableclean-freq" class="input input-xs input-bordered w-16" value="0" min="0" max="50" />' +
      '<span class="opacity-40">轮一次(0=关，仅编程/工作模式)</span></div>';
    container.appendChild(tableCleanSection);
    _initTableCleanControl();
  });
}

function _renderCloneDetailPanel(idx) {
  var panel = document.getElementById("submode-detail-panel");
  if (!panel) return;
  var cl = _clones[idx];
  if (!cl) { panel.innerHTML = '<div class="p-4 text-xs opacity-40">分身不存在</div>'; return; }
  var perms = [];
  if (cl.permissions?.read_file) perms.push("读文件");
  if (cl.permissions?.list_files) perms.push("列目录");
  if (cl.permissions?.search_files) perms.push("搜索");
  if (cl.permissions?.run_command) perms.push("运行脚本");
  if (cl.permissions?.write_md) perms.push("写MD");
  if (cl.permissions?.write_code) perms.push("写代码");
  if (cl.permissions?.delete) perms.push("删除");
  panel.innerHTML =
    '<div class="p-3 space-y-3 text-xs">' +
    '<div class="flex items-center justify-between">' +
    '<span class="font-bold text-sm"><i data-ic="person"></i> 分身' + cl.id + ' — ' + _esc(cl.label || "未命名") + '</span>' +
    '<div class="flex gap-1">' +
    '<label class="flex items-center gap-1 cursor-pointer"><span class="opacity-50">启用</span><input type="checkbox" class="checkbox checkbox-xs" id="clone-detail-enable" ' + (cl.enabled ? "checked" : "") + ' /></label>' +
    '<button class="btn btn-xs btn-ghost" id="clone-detail-edit">✏ 编辑</button>' +
    '<button class="btn btn-xs btn-ghost text-error" id="clone-detail-del">✕ 删除</button>' +
    '</div></div>' +
    '<div class="grid grid-cols-2 gap-2">' +
    '<div><span class="opacity-50">预设:</span> ' + _esc(cl.presetName || "无") + '</div>' +
    '<div><span class="opacity-50">模型:</span> ' + _esc(cl.modelName || "默认") + '</div>' +
    '<div><span class="opacity-50">API源:</span> ' + _esc(cl.apiSource || "默认") + '</div>' +
    '<div><span class="opacity-50">上下文:</span> ' + (cl.contextMessages || 10) + '条</div>' +
    '<div><span class="opacity-50">最大token:</span> ' + (cl.maxTokens || 60000) + '</div>' +
    '<div><span class="opacity-50">温度:</span> ' + (cl.temperature !== undefined ? cl.temperature : "默认") + '</div>' +
    '</div>' +
    '<div><span class="opacity-50">权限:</span> ' + (perms.length ? perms.join(" / ") : "仅只读") + '</div>' +
    '<div id="clone-effective-permissions" class="rounded bg-base-300/30 p-2"><span class="opacity-50">正在读取真实生效权限…</span></div>' +
    '<div id="clone-runtime-controls" class="rounded bg-base-300/30 p-2"><span class="opacity-50">正在读取在飞任务与续接点…</span></div>' +
    '<div class="border-t border-base-300/50 pt-2 mt-2">' +
    '<div class="font-bold mb-1">🧪 分身测试</div>' +
    '<textarea id="clone-detail-test-input" class="textarea textarea-xs textarea-bordered w-full" rows="3" placeholder="输入指令直接触发此分身..."></textarea>' +
    '<div class="flex gap-1 mt-1">' +
    '<button id="clone-detail-test-run" class="btn btn-xs btn-warning flex-1">▶ 运行</button>' +
    '<button id="clone-detail-test-clear" class="btn btn-xs btn-ghost">清空</button>' +
    '</div>' +
    '<pre id="clone-detail-test-output" class="text-[10px] bg-base-300/30 rounded p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap hidden"></pre>' +
    '</div></div>';
  var enableCb = document.getElementById("clone-detail-enable");
  if (enableCb) enableCb.addEventListener("change", async function() {
    _clones[idx].enabled = enableCb.checked;
    var ok = await _saveClones();
    if (!ok) { _clones[idx].enabled = !enableCb.checked; enableCb.checked = _clones[idx].enabled; }
    var groupList = document.getElementById("submode-group-list");
    if (groupList) _renderCloneLeftPanel(groupList);
  });
  var editBtn = document.getElementById("clone-detail-edit");
  if (editBtn) editBtn.addEventListener("click", function() { _openCloneEditor(cl); });
  var delBtn = document.getElementById("clone-detail-del");
  if (delBtn) delBtn.addEventListener("click", async function() {
    if (!await beiluConfirm("确定删除分身「" + (cl.label || "未命名") + "」？")) return;
    var removed = _clones.splice(idx, 1)[0];
    var ok = await _saveClones();
    if (!ok) { _clones.splice(idx, 0, removed); return; }
    var groupList = document.getElementById("submode-group-list");
    if (groupList) _renderCloneLeftPanel(groupList);
    panel.innerHTML = '<div class="text-xs opacity-40 p-4 text-center">已删除</div>';
  });
  var testRunBtn = document.getElementById("clone-detail-test-run");
  if (testRunBtn) testRunBtn.addEventListener("click", async function() {
    var input = document.getElementById("clone-detail-test-input")?.value?.trim();
    if (!input) return;
    var outputEl = document.getElementById("clone-detail-test-output");
    outputEl.classList.remove("hidden");
    outputEl.textContent = "⏳ 执行中...\n";
    testRunBtn.disabled = true;
    try {
      var data = await sendAction({ verb: "testClone", target: "plugins:beilu-memory", source: "web", payload: { instruction: input, cloneId: cl.id } }); // T6b
      if (data.success) {
        outputEl.textContent = "✅ " + (data.cloneLabel || "?") + " | " + data.totalRounds + "轮/" + data.totalTools + "次工具\n\n" + (data.reply || "(无输出)");
      } else {
        outputEl.textContent = "❌ " + (data.error || "未知错误");
      }
    } catch(e) { outputEl.textContent = "❌ " + e.message; }
    testRunBtn.disabled = false;
  });
  var testClearBtn = document.getElementById("clone-detail-test-clear");
  if (testClearBtn) testClearBtn.addEventListener("click", function() {
    var inp = document.getElementById("clone-detail-test-input"); if (inp) inp.value = "";
    var out = document.getElementById("clone-detail-test-output"); if (out) { out.textContent = ""; out.classList.add("hidden"); }
  });
  _renderCloneEffectivePermissions(cl);
  _renderCloneRuntimeControls(cl);
}

async function _renderCloneRuntimeControls(clone) {
  var el = document.getElementById("clone-runtime-controls");
  if (!el || !clone) return;
  var chatid = window._beiluGetChatId?.() || "";
  if (!chatid) { el.innerHTML = '<span class="text-error">当前会话身份缺失，不能查询或续接</span>'; return; }
  try {
    var results = await Promise.all([
      sendAction({ verb: "getActiveClones", target: "plugins:beilu-memory", source: "web", payload: { chatid: chatid } }),
      sendAction({ verb: "getCloneResumes", target: "plugins:beilu-memory", source: "web", payload: { chatid: chatid, cloneId: clone.id } })
    ]);
    if (results[0]?.success === false) throw new Error(results[0].error || "在飞查询失败");
    if (results[1]?.success === false) throw new Error(results[1].error || "续接查询失败");
    var active = results[0]?.clones || [];
    var resumes = results[1]?.resumes || [];
    var html = '<div class="flex items-center justify-between"><b>运行与续接</b><button id="clone-runtime-refresh" class="btn btn-xs btn-ghost">刷新</button></div>';
    html += '<div class="text-[10px] opacity-60">在飞 ' + active.length + ' · 可续接 ' + resumes.length + '</div>';
    html += active.map(function(job) {
      return '<div class="text-[10px] leading-5">⚡ #' + _esc(String(job.taskId)) + ' ' + _esc(job.jobId) +
        ' <button class="btn btn-xs btn-error clone-runtime-stop" data-job="' + _esc(job.jobId) + '" data-batch="' + _esc(job.cloneBatchId) + '" data-task="' + _esc(String(job.taskId)) + '">停止</button></div>';
    }).join('');
    html += resumes.map(function(resume) {
      return '<div class="text-[10px] leading-5">↩ #' + _esc(String(resume.taskId)) + ' [' + _esc(resume.terminalReason) + '] R' + resume.rounds +
        ' <button class="btn btn-xs btn-outline clone-runtime-resume" data-job="' + _esc(resume.jobId) + '" data-task="' + _esc(String(resume.taskId)) + '">续接</button>' +
        '<div class="opacity-50">' + _esc(resume.instruction || "") + '</div></div>';
    }).join('');
    el.innerHTML = html;
    el.querySelector("#clone-runtime-refresh")?.addEventListener("click", function() { _renderCloneRuntimeControls(clone); });
    el.querySelectorAll(".clone-runtime-stop").forEach(function(btn) {
      btn.addEventListener("click", async function() {
        btn.disabled = true;
        try {
          var stopped = await sendAction({ verb: "stopCloneTask", target: "plugins:beilu-memory", source: "web", payload: {
            chatid: chatid, jobId: btn.dataset.job, cloneBatchId: btn.dataset.batch, taskId: btn.dataset.task
          } });
          if (!stopped?.success || stopped.aborted !== 1) throw new Error(stopped?.error || "目标任务未停止");
          await _renderCloneRuntimeControls(clone);
        } catch (error) { btn.disabled = false; _showToast("❌ 停止失败：" + (error?.message || error), 3000); }
      });
    });
    el.querySelectorAll(".clone-runtime-resume").forEach(function(btn) {
      btn.addEventListener("click", async function() {
        var instruction = await beiluPrompt("续接分身任务", "请从保存的中断点继续完成原任务");
        if (!instruction?.trim()) return;
        btn.disabled = true;
        try {
          var resumed = await sendAction({ verb: "testClone", target: "plugins:beilu-memory", source: "web", payload: {
            chatid: chatid, cloneId: clone.id, instruction: instruction.trim(),
            resumeTaskId: btn.dataset.task, resumeJobId: btn.dataset.job
          } });
          if (!resumed?.success) throw new Error(resumed?.error || "续接未完成");
          _showToast("✅ 续接完成：" + (resumed.terminalReason || resumed.status), 3000);
          await _renderCloneRuntimeControls(clone);
        } catch (error) { btn.disabled = false; _showToast("❌ 续接失败：" + (error?.message || error), 3500); }
      });
    });
  } catch (error) {
    el.innerHTML = '<span class="text-error">运行/续接读取失败：' + _esc(error?.message || String(error)) + '</span>';
  }
}

async function _renderCloneEffectivePermissions(clone) {
  var el = document.getElementById("clone-effective-permissions");
  if (!el || !clone) return;
  try {
    var data = await sendAction({
      verb: "inspectClonePermissions",
      target: "plugins:beilu-memory",
      source: "web",
      payload: { cloneId: clone.id, sourceDetail: "test" }
    });
    if (!data?.success || !data.inspection) throw new Error(data?.error || "权限检查无返回");
    var inspection = data.inspection;
    var rows = inspection.capabilities || [];
    var blocked = rows.filter(function(row) { return row.checked && !row.allowed; });
    var html = '<div class="font-bold mb-1">有效权限（配置版本 ' + _esc(String(inspection.configRevision ?? _cloneConfigRevision ?? "?")) + '）</div>';
    html += '<div class="text-[10px] mb-1">来源 ' + _esc(inspection.source + "/" + inspection.sourceDetail) +
      ' · IDE ' + (inspection.route?.connected ? ('已连接 ' + _esc(inspection.route.backendKind || "")) : '未连接') + '</div>';
    html += rows.map(function(row) {
      var icon = row.allowed ? '✅' : (row.checked ? '⛔' : '⬜');
      return '<div class="text-[10px] leading-4" title="' + _esc(row.reason || "") + '">' + icon + ' ' +
        _esc(row.key) + '：' + _esc(row.allowed ? '可执行' : row.reason) + '</div>';
    }).join('');
    if (blocked.some(function(row) { return row.repairTarget === "permission_panel"; })) {
      html += '<button id="clone-open-permission-panel" class="btn btn-xs btn-outline mt-2">打开全局命令权限</button>';
    }
    el.innerHTML = html;
    el.querySelector("#clone-open-permission-panel")?.addEventListener("click", function() {
      var open = document.getElementById("perm-open-rules");
      if (open) { open.click(); open.scrollIntoView({ block: "center" }); }
      else _showToast("权限面板当前未挂载，请切到 IDE 设置中的“AI 操作权限”", 3000);
    });
  } catch (error) {
    el.innerHTML = '<span class="text-error">有效权限读取失败：' + _esc(error?.message || String(error)) + '</span>';
  }
}

function _closeCloneEditor() {
  var f = document.getElementById("clone-editor-inline");
  if (f) f.remove();
  ["ide-submode-detail", "work-submode-detail"].forEach(function (panelId) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    var ph = panel.querySelector("[id$='smd-placeholder']");
    if (ph) ph.style.display = "";
    var titleEl = panel.querySelector("[id$='smd-title']");
    if (titleEl) titleEl.textContent = "子模式详情";
  });
}

function _openCloneEditor(existing) {
  var isEdit = !!existing;

  var _activeTab2 = document.body.dataset.activeTab;
  var rightPanel = _activeTab2 === "work"
    ? document.getElementById("work-submode-detail")
    : document.getElementById("ide-submode-detail");
  var rightInner = rightPanel ? rightPanel.querySelector(".p-4") : null;
  var _oldForm = document.getElementById("clone-editor-inline");
  if (_oldForm) _oldForm.remove();
  // 与子模式编辑共用右栏：打开分身编辑时隐藏子模式编辑表单，避免两个表单嵌套同显
  var _smFormNest = document.getElementById("submode-edit-form");
  if (_smFormNest) _smFormNest.classList.add("hidden");
  _editingModeId = null;
  var _ph = document.getElementById("smd-placeholder");
  if (_ph) _ph.style.display = "none";
  var _titleEl = document.getElementById("smd-title");
  if (_titleEl) _titleEl.textContent = (isEdit ? "✏ 编辑分身" : "➕ 添加分身");

  var form = document.createElement("div");
  form.id = "clone-editor-inline";
  form.style.cssText = "font-size:12px;";
  form.innerHTML =
    '<div style="display:grid;gap:8px;font-size:12px;">' +
    '<label>名称 <input id="cl-label" class="input input-xs input-bordered w-full" value="' + _esc(existing?.label || "") + '" /></label>' +
    '<label>绑定预设 <select id="cl-preset" class="select select-xs select-bordered w-full"><option value="">（不绑定）</option></select></label>' +
    '<label>API源 <select id="cl-api" class="select select-xs select-bordered w-full"><option value="">(默认API)</option></select></label>' +
    '<label>模型 <select id="cl-model" class="select select-xs select-bordered w-full"><option value="">(API源默认)</option></select></label>' +
    // 标签消歧（凛倾 2026-07-07"上下文有两处,没有说明是输出最大token还是上下文"）：
    // cl-ctx=携带的历史消息条数（replyHandler:2785）；cl-tokens=API max_tokens 输出上限（:2983）；
    // cl-max-context=模型上下文窗口声明，决定每条历史消息截取长度（:2790）
    // 07-09 使用链走查：数值默认全取后端 clone_template（_clNum），表单不再持写死副本（原 ||10/||60000 等与后端一致但物理双写）
    '<label title="带给分身的最近几条聊天消息（不是 token）">携带对话条数（最近N条） <input id="cl-ctx" type="number" class="input input-xs input-bordered w-full" value="' + _clNum(existing, "contextMessages") + '" /></label>' +
    '<label title="单次回复的输出 token 上限（传给 API 的 max_tokens），不是上下文窗口">最大生成Token（单次输出上限） <input id="cl-tokens" type="number" class="input input-xs input-bordered w-full" value="' + _clNum(existing, "maxTokens") + '" /></label>' +
    '<label title="分身可执行的工作轮数；0 表示不设轮数上限，直到完成或被停止">最大工作轮次（0=无限） <input id="cl-max-rounds" type="number" min="0" max="10000" step="1" class="input input-xs input-bordered w-full" value="' + _clNum(existing, "maxRounds") + '" /></label>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
    '<label>温度 <input id="cl-temperature" type="number" step="0.05" min="0" max="2" class="input input-xs input-bordered w-full" value="' + _clNum(existing, "temperature") + '" /></label>' +
    '<label title="分身所用模型的上下文窗口容量（token）；填 200000 及以上时，携带的历史消息每条截取更长">模型上下文窗口（token容量） <input id="cl-max-context" type="number" step="1000" min="1000" class="input input-xs input-bordered w-full" value="' + _clNum(existing, "maxContext") + '" /></label>' +
    '</div>' +
    // T072a：与建模表单同源（POST_PROCESS_MODE_*）；克劳德分身无空项、默认 strict（写入侧 :2975 `|| "strict"`），故 selectedValue=strict 保持原默认不变
    '<label>后处理 <select id="cl-post-process" class="select select-xs select-bordered w-full">' + _buildModeOptions(_enumOptions("prompt_post_processing"), { selectedValue: "strict" }) + "</select></label>" +
    // T072a：与建模表单同源（PREFILL_MODE_*）；含空项"不改变"且默认选中空（写入侧 :2976 `|| ""`），零默认行为变化
    '<label>尾部预填充 <select id="cl-claude-prefill" class="select select-xs select-bordered w-full">' + _buildModeOptions(_enumOptions("claude_prefill_mode"), { emptyValue: "", emptyLabel: "不改变", selectedValue: "" }) + "</select></label>" +
    '<div style="font-weight:600;margin-top:4px;">权限</div>' +
    Object.keys((_cloneTemplate && _cloneTemplate.permissions) || {}).map(function(key) { return _clonePermCheckbox(key, key, existing); }).join("") +
    "</div>" +
    '<div style="display:flex;gap:8px;margin-top:12px;">' +
    '<button id="cl-save" class="btn btn-sm btn-primary flex-1">💾 保存</button>' +
    '<button id="cl-cancel" class="btn btn-sm btn-ghost flex-1">取消</button>' +
    "</div>";

  form.querySelector("#cl-cancel").addEventListener("click", function () { _closeCloneEditor(); });

  // 获取模型列表
  // [0716 E1 修] 原：raw getModels + catch{/*ignore*/}——绕过 getCachedModelList 收口（缓存/
  //   proxy→浏览器直连双腿/失败上报全缺），失败后下拉只剩空项，用户无从分辨「没请求」和「请求失败」。
  //   改走收口 window._beiluGetModelList（同 _populateModelSelect :2101 范式）+ 空结果不可选提示项
  //   （失败可见，具体原因经收口 _reportError 进报错系统）+ reqId 令牌（同 :2092 范式防切源乱序）。
  var _clModelReqId = 0;
  async function _loadModels(sourceName) {
    var modelSel = form.querySelector("#cl-model");
    var prev = modelSel.value;
    modelSel.innerHTML = '<option value="">(API源默认)</option>';
    if (!sourceName) return;
    var reqId = ++_clModelReqId;
    var models = [];
    try {
      var fn = window._beiluGetModelList;
      // [0717] force：下拉打开/切源=点击驱动，每次实时访问源（凛倾「每次点击都需要访问」）
      models = fn ? await fn(sourceName, { force: true }) : [];
    } catch (e) { console.warn("[subModePanel] 克隆编辑器模型列表获取失败:", e.message); }
    if (reqId !== _clModelReqId) return; // 期间已切别的源，丢弃旧响应
    if (!models.length) {
      var warnOpt = document.createElement("option");
      warnOpt.disabled = true;
      warnOpt.textContent = "⚠ 未获取到模型列表（检查该 API 源的 URL/Key，详见运行时日志）";
      modelSel.appendChild(warnOpt);
      return;
    }
    models.forEach(function (m) {
      var name = typeof m === "string" ? m : (m.id || m.name || "");
      if (!name) return;
      var opt = document.createElement("option");
      opt.value = name; opt.textContent = name.split("/").pop();
      modelSel.appendChild(opt);
    });
    if (prev) modelSel.value = prev;
  }

  // 加载API源下拉列表
  (async function () {
    try {
      var _gas = window._beiluGetApiSources;
      var names = _gas ? await _gas() : null;
      if (!names) { try { var sources = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" }); names = Array.isArray(sources) ? sources : Object.keys(sources || {}); } catch (e) { _showToast("⚠ API源列表加载失败: " + (e?.message || e)); /* T021 弹出：原静默空回填=用户看到空下拉无从得知失败；names=null 仍走空回填 */ } } // T6b
      if (names) {
        var apiSel = form.querySelector("#cl-api");
        names.forEach(function (name) {
          var opt = document.createElement("option");
          opt.value = name; opt.textContent = name;
          apiSel.appendChild(opt);
        });
        if (existing?.apiSource) apiSel.value = existing.apiSource;
        // API源切换时刷新模型列表
        apiSel.addEventListener("change", function () { _loadModels(apiSel.value); });
        // 初始加载模型列表
        if (existing?.apiSource) {
          await _loadModels(existing.apiSource);
          if (existing?.modelName) form.querySelector("#cl-model").value = existing.modelName;
        }
      }
    } catch (e) { /* ignore */ }
    // 回填后处理选择
    if (existing?.promptPostProcessing) {
      var ppSel = form.querySelector("#cl-post-process");
      if (ppSel) ppSel.value = existing.promptPostProcessing;
    }
    if (existing?.claudePrefillMode) {
      var cpfSel = form.querySelector("#cl-claude-prefill");
      if (cpfSel) cpfSel.value = existing.claudePrefillMode;
    }
  })();

  // 加载预设下拉列表
  (async function () {
    try {
      var _gpd2 = window._beiluGetPresetData;
      var data = _gpd2 ? await _gpd2() : null;
      if (!data) { try { data = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" }); } catch { data = null; } } // T6b
      if (data) {
        var presets = data?.preset_list || [];
        var presetSel = form.querySelector("#cl-preset");
        presets.forEach(function (name) {
          var opt = document.createElement("option");
          opt.value = name; opt.textContent = name.replace(/\.json$/i, "");
          presetSel.appendChild(opt);
        });
        if (existing?.presetName) presetSel.value = existing.presetName;
      }
    } catch (e) { /* ignore */ }
  })();

  form.querySelector("#cl-save").addEventListener("click", async function () {
    // 编辑以服务端读回对象为基底，新建以 clone_template 为基底；表单只覆盖自己拥有的字段。
    // 这样未来新增的根字段/权限键不会被旧前端一次编辑抹掉。
    var cloneBase = isEdit ? existing : (_cloneTemplate || {});
    var perms = Object.assign({}, (_cloneTemplate && _cloneTemplate.permissions) || {}, (cloneBase && cloneBase.permissions) || {});
    form.querySelectorAll("[data-perm-key]").forEach(function (el) {
      perms[el.dataset.permKey] = el.checked;
    });
    var cloneData = Object.assign({}, cloneBase, {
      id: isEdit ? existing.id : (_clones.length > 0 ? Math.max(..._clones.map(function (c) { return c.id; })) + 1 : 1),
      label: form.querySelector("#cl-label").value.trim() || "分身",
      enabled: isEdit ? existing.enabled : true,
      presetName: form.querySelector("#cl-preset").value.trim(),
      apiSource: form.querySelector("#cl-api").value.trim(),
      modelName: form.querySelector("#cl-model").value.trim(),
      // 07-09：收集兜底链=表单值→已有值→后端模板值，前端零数字字面量（原 ||10/||60000 等写死副本已删）
      permissions: perms,
      contextMessages: _clCollectNum(form, "#cl-ctx", existing, "contextMessages"),
      maxTokens: _clCollectNum(form, "#cl-tokens", existing, "maxTokens"),
      maxRounds: _clCollectNum(form, "#cl-max-rounds", existing, "maxRounds"),
      temperature: _clCollectNum(form, "#cl-temperature", existing, "temperature", true),
      maxContext: _clCollectNum(form, "#cl-max-context", existing, "maxContext"),
      promptPostProcessing: form.querySelector("#cl-post-process").value || "strict",
      claudePrefillMode: form.querySelector("#cl-claude-prefill").value || "",
    });
    var _prevClone = null;
    var _prevIdx = -1;
    if (isEdit) {
      _prevIdx = _clones.findIndex(function (c) { return c.id === existing.id; });
      if (_prevIdx >= 0) { _prevClone = _clones[_prevIdx]; _clones[_prevIdx] = cloneData; }
    } else {
      _clones.push(cloneData);
    }
    var ok = await _saveClones();
    if (!ok) {
      if (isEdit && _prevIdx >= 0 && _prevClone) _clones[_prevIdx] = _prevClone;
      else if (!isEdit) _clones.pop();
      return;
    }
    _closeCloneEditor();
    var _clGroupList = document.getElementById("submode-group-list");
    if (_clGroupList) _renderCloneLeftPanel(_clGroupList);
    _showToast((isEdit ? "已更新" : "已添加") + " 分身" + cloneData.id + " " + cloneData.label, 2000);
  });

  if (rightInner) rightInner.appendChild(form);
  else document.body.appendChild(form);
}

// 07-09 使用链走查：新建默认权限=后端 clone_template.permissions（_readMd 职能基线），删除原 11 键
//   手工副本（注释自陈"与后端一致"=靠人工对齐的物理双写）。表单入口必经 loadClones=模板必达。
function _clonePermCheckbox(key, label, existing) {
  var _tplPerms = (_cloneTemplate && _cloneTemplate.permissions) || {};
  var checked = existing?.permissions?.[key] ?? _tplPerms[key] ?? false;
  return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-perm-key="' + key + '" ' + (checked ? "checked" : "") + ' class="checkbox checkbox-xs" /> ' + label + "</label>";
}

// 数值默认单源：编辑=已有值，新建=后端模板值，都缺=留空（不在前端写数字字面量）
function _clNum(existing, field) {
  var v = existing ? existing[field] : (_cloneTemplate ? _cloneTemplate[field] : undefined);
  if (typeof v !== "number" || !isFinite(v)) v = _cloneTemplate ? _cloneTemplate[field] : undefined;
  return (typeof v === "number" && isFinite(v)) ? v : "";
}

// 收集兜底链：表单值→已有值→后端模板值（temperature 与 maxRounds 的 0 均为合法配置）。
function _clCollectNum(form, sel, existing, field, isFloat) {
  var raw = form.querySelector(sel).value;
  var v = isFloat ? parseFloat(raw) : parseInt(raw);
  var ok = isFloat || field === "maxRounds" ? (isFinite(v) && v >= 0) : (isFinite(v) && v > 0);
  if (ok) return v;
  var fb = existing ? existing[field] : undefined;
  if (typeof fb === "number" && isFinite(fb)) return fb;
  return _cloneTemplate ? _cloneTemplate[field] : undefined;
}

// ============================================================
// 初始化入口
// ============================================================

let _subModePanelInited = false;
export async function initSubModePanel() {
  if (_subModePanelInited) return;
  _subModePanelInited = true;
  console.log("[subModePanel] 初始化子模式面板...");

  _injectStyles();
  try { _injectTopBar(); } catch (e) { console.warn("[subModePanel] _injectTopBar:", e.message); }
  _injectTriggerBar();
  _injectActivityBarBtn();

  // BUG-01+04 修复：D6逻辑移到wrapper创建之后 + 综合显示条件
  var chatCont = document.getElementById("chat-container");
  if (chatCont) {
    var wrapper0 = document.getElementById("submode-trigger-wrapper");
    if (wrapper0) {
      wrapper0.style.display = _shouldShowTriggerBar(chatCont) ? "" : "none";
    }
    var chatObserver = new MutationObserver(function () {
      var w = document.getElementById("submode-trigger-wrapper");
      if (w) {
        var show = _shouldShowTriggerBar(chatCont);
        w.style.display = show ? "" : "none";
        if (!show) _closePopup();
      }
    });
    chatObserver.observe(chatCont, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  _injectManagePanel();

  // 加载数据
  await Promise.all([_fetchSubModes(), _fetchApiSources(), _fetchAISetupStatus(), _fetchPresetList(), _fetchSkillGroups()]);
  try { _cachedConvList = await fetchChatList(); } catch { /* non-fatal */ }

  // 渲染
  _updateTriggerBar();
  _updateTopBar();
  _renderManagePanel();

  // maxContext 由 getEffectiveMaxContext() 统一计算，不在此处写 DOM

  // 绑定事件
  _bindTriggerEvents();

  // API 保存/删改在本窗和跨窗都统一派发 resource:api-changed。
  // 先失效来源缓存再读权威状态；表单正在编辑时保留选择值，绝不借刷新静默清空用户绑定。
  window.addEventListener("resource:api-changed", async function () {
    await Promise.all([_fetchApiSources({ force: true }), _fetchAISetupStatus()]);
    var form = document.getElementById("submode-edit-form");
    if (!form || form.classList.contains("hidden")) return;
    var apiSel = document.getElementById("submode-form-api");
    var selectedApi = apiSel?.value || "";
    _populateApiSelect(selectedApi);
    if (apiSel) apiSel.value = selectedApi;
    var backupSel = document.getElementById("submode-form-backup-api");
    var selectedBackup = backupSel?.value || "";
    _populateBackupApiSelect(selectedBackup);
    if (backupSel) backupSel.value = selectedBackup;
    _renderSubModeApiGuide();
  });

  // 响应外部打开请求（layout.mjs / workPanel dispatch beilu:openSubModePanel）
  window.addEventListener("beilu:openSubModePanel", function () {
    var rawMode = typeof getCurrentMode === "function" ? getCurrentMode() : "";
    if (rawMode === "work") _manageTab = "work";
    var currentTab = document.body.dataset.activeTab;
    var _clickSubmodesBtn = function () {
      var btn = document.querySelector('[data-ide-panel="submodes"]');
      if (btn) btn.click();
    };
    // [0713 病灶审计 C1] 原 setTimeout(200) 猜切换完成时机删除：dispatchEvent 同步执行
    // layout 的 switchTab handler（DOM tab 切换在 dispatch 返回前完成，后端模式同步是其异步尾巴、
    // 与本按钮无关），活动栏按钮常驻 DOM，切完即可点。
    if (currentTab !== "files") {
      window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: "files" }));
    }
    _clickSubmodesBtn();
  });

  // 监听 ide-activity-bar 面板切换（如果 layout.mjs 已有 initIdeActivityBar 处理此事件，新按钮自动生效）
  // 额外：监听面板显示时刷新列表
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mut) {
      if (mut.type === "attributes" && mut.attributeName === "class") {
        var panel = document.getElementById("ide-panel-submodes");
        if (panel && !panel.classList.contains("hidden")) {
          // 单例挂载（2026-07-16 根修）：_renderManagePanel 自判「已建→搬移+刷数据 / 未建→首建」，
          //   不再按 #submode-two-col 在场与否分支重渲——那正是双容器各持一份重复 id 的制造点。
          _renderManagePanel(panel);
        }
      }
    });
  });
  var panel = document.getElementById("ide-panel-submodes");
  if (panel) {
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
  }

  // chat 模式下预设切换时同步更新输入区子模式条
  window.addEventListener("beilu:presetSwitched", function () { _updateTopBar(); });
  window.addEventListener("beilu:preset-changed", function () { _updateTopBar(); });
  window.addEventListener("beilu:mode-switched", function () { _updateTopBar(); });
  // [0727 多窗口] 切窗口=纯显示交换：换了可见窗口就按它的 chatid 重绘子模式条/触发栏——
  //   全部读缓存（_activeSubModesMap[cid] 经 _getEffectiveActiveId，其读点已窗口化），
  //   不 fetch、不写活跃态（切窗没有"切到哪个子模式"的信息，写=乱写）。
  window.addEventListener("beilu:window-switched", function () {
    _updateTopBar();
    _updateTriggerBar();
  });

  // W56-3b: 监听后端AI触发/workPanel/pipelinePanel/flowGroup 的子模式切换事件
  // ★ 功能链：所有非手动路径（AI驱动/workPanel点击/skill组启动）都走此事件路径。
  //   必须与 _switchToSubMode 的步骤对齐：状态更新 + 采样重置 + 预设切换 + 模型同步 + UI 刷新。
  //   why: 原监听器只做状态更新和采样重置，缺预设/模型切换 → AI驱动切换后下一轮仍用旧预设。
  window.addEventListener("beilu:subModeSwitched", async (e) => {
    const detail = e.detail;
    if (detail?.to) {
      console.log("[subModePanel] 收到subModeSwitched事件:", detail.to, "label:", detail.label);
      // T5：活跃态单条切换走收口写函数（与 _setActiveSubMode 同构，消灭第二处散写点）
      // [键收口 2026-07-13] 镜像键=事件自带的真实落盘键（""=全局字段、"_default"=无对话归属）。
      //   全部生产点已带 chatId：setActiveSubMode/flowGroup 返回体（setDataActions）、replyHandler 四个
      //   ext._subModeSwitch 点、facade 广播——原一律盖浏览器当前 cid=后端写 A 键前端镜像写 B 键的回灌错位。
      _writeActiveSubMode(detail.modeGroup, detail.to, detail.chatId || "");
      _resetRuntimeParamsSampling();
      _updateTriggerBar();
      _updateTopBar();
      const mode = _subModes.find(function (m) { return m.id === detail.to; });
      if (!mode) {
        const modeLabel = document.getElementById("submode-mode-label");
        if (modeLabel) modeLabel.textContent = detail.label || detail.to;
      }
      // T046：事件路径同样拆除前端强制 switchPreset 联动（与上方 D7b 对齐）——预设隔离由后端生成时按
      //   子模式绑定完成（getPromptHandler T046 块）。[D3 0713] UI 反馈走共享函数（与手动路径同源）；
      //   [0716 散写收口] 模型应用（_applySubModeModel）已删，底栏由 _updateTriggerBar 单点通知。
      _applySubModeBindingUI(mode);
      _renderManageList();
    }
  });

  // A: 右栏子模式详情填充
  window.addEventListener("beilu:request-submode-detail", _fillSubModeDetail);
  // [0713 病灶审计 C1] 原 setTimeout(200) 删除：主监听器（上方 async handler）的活跃态写入
  //   （_writeActiveSubMode）在其首个 await 之前同步完成，监听器按注册序执行——本监听器运行时
  //   _getEffectiveActiveId 已是新值，直接填充即可。
  window.addEventListener("beilu:subModeSwitched", function () {
    _fillSubModeDetail();
  });

  // 同步断链修复（2026-07-10）：另一端（YonBan/本体其他窗口）保存子模式配置 → 重拉落盘真值刷新 UI。
  //   自己保存也会收到（广播不排除发起端）→ 重拉读回刚写的值=幂等无害。
  window.addEventListener("beilu:subModesConfigChanged", async function () {
    try {
      await _fetchSubModes();
      _updateTriggerBar();
      _updateTopBar();
      _renderManageList();
      _fillSubModeDetail();
      console.log("[subModePanel] 配置变更广播 → 已重拉刷新");
    } catch (e) {
      console.warn("[subModePanel] 配置变更重拉失败:", e.message);
    }
  });

  // [2026-07-13 反向回灌删除（补丁形式识别·形式二）] 原 C-2「runtime-params-changed → 回写当前活跃
  //   子模式定义并落盘」整体删除。事件 producer 有 3 个（featureControls:73 本窗口改参 /
  //   websocket.mjs:360 AI 切子模式推参 / websocket.mjs:1002 跨窗口 WS 广播），后两者不是
  //   「本窗口用户为当前子模式设参数」——AI 切换时序窗内会把新子模式参数灌进旧活跃子模式定义、
  //   别窗口改参会串灌本窗口子模式，均为下游运行时层写上游定义层（箭头接反）。该监听器曾挂
  //   哨兵过滤/写活读死双写/maxContext 停灌三层例外补丁=堵一个开一个的证据。
  //   子模式定义唯一写入口=编辑器表单（_renderManageList/detail → _saveSubModes）。

  // BUG-02: 监听IDE连接/断连事件，更新trigger-bar显示
  // 凛倾 2026-06-28「这个不需要」——IDE连接也不再强制显示触发栏，走统一的 _shouldShowTriggerBar
  window.addEventListener("beilu:ide-connected", function () {
    var w = document.getElementById("submode-trigger-wrapper");
    var chatCont = document.getElementById("chat-container");
    if (w && chatCont) {
      w.style.display = _shouldShowTriggerBar(chatCont) ? "" : "none";
    }
    _updateTriggerBar();
    console.log("[subModePanel] IDE已连接，trigger-bar按 _shouldShowTriggerBar 评估");
  });
  window.addEventListener("beilu:ide-disconnected", function () {
    var w = document.getElementById("submode-trigger-wrapper");
    var chatCont = document.getElementById("chat-container");
    if (w && chatCont) {
      w.style.display = _shouldShowTriggerBar(chatCont) ? "" : "none";
    }
    console.log("[subModePanel] IDE已断连，重新评估trigger-bar显示");
  });

  console.log(
    "[subModePanel] 初始化完成，加载了",
    _subModes.length,
    "个子模式",
  );
}

// 导出供外部调用
export function getActiveSubMode() {
  return _getActiveMode();
}
export function getSubModes() {
  return _subModes;
}
export function getActiveSubModeId() {
  return _getEffectiveActiveId();
}

export async function renderSubModeManagementInto(container, forceTab) {
  if (forceTab) _manageTab = forceTab;
  if (!_subModes.length || !_skillGroups.length) {
    await Promise.all([_fetchSubModes(), _fetchApiSources(), _fetchPresetList(), _fetchSkillGroups()]);
  }
  // 单例挂载（2026-07-16 根修）：原「清空 idePanel + remove 游离表单」是对双份重复 id 的
  //   单向补救（只在 work 渲染时清 IDE 份，IDE observer 渲染时不清 work 份=必复发）。
  //   现 _renderManagePanel 单例搬移自身保证全文档唯一，无需手清。
  _renderManagePanel(container);
}

// ============================================================
// 编程表格清理频率配置
// ============================================================

async function _initTableCleanControl() {
  var el = document.getElementById("tableclean-freq");
  if (!el) return;
  // 加载当前频率（yonban_config.json 顶层 tableCleanFrequency）
  try {
    var data = await sendAction({ verb: "getTableCleanConfig", target: "plugins:beilu-memory", source: "web" }); // T6b
    el.value = data.tableCleanFrequency || 0;
  } catch (e) { /* 加载失败静默 */ }
  // 改动即时保存
  el.addEventListener("change", async function () {
    try {
      await sendAction({ verb: "saveTableCleanConfig", target: "plugins:beilu-memory", source: "web", payload: { tableCleanFrequency: parseInt(el.value || "0") } }); // T6b
    } catch (e) { /* 静默 */ }
  });
}
