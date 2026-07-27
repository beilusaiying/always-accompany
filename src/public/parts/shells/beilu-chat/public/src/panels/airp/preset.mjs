/**
 * @file preset.mjs — 预设数据 API + 预设选择器 + overlay 悬浮窗 + 模型参数 UI
 *
 * 【功能链】
 *   getPresetData / setPresetData（API 通信层：GET/POST beilu-preset/config/getdata|setdata）
 *   → syncPresetRegexToPlugin（预设切换时将 extensions.regex_scripts 同步到 beilu-regex 插件，
 *       先清除旧正则再导入新正则）
 *   → initPresetSelector（填充预设下拉框 → 绑定切换事件 → switchPreset 广播切换）
 *   → 预设 overlay 悬浮窗（点击预设名称展开/收起详情，显示当前预设内容摘要）
 *   → 模型参数 UI（temperature / max_tokens 等参数输入框，读写 preset 数据联动）
 *   ⚠ 条目编辑器已迁移到 panels/settings/panels.mjs，旧编辑器 DOM 代码已删除
 *
 * 【why】
 *   预设是 AI 生成参数的核心配置，切换预设需同步触发正则脚本切换（regex_scripts 内嵌在预设 JSON 中）；
 *   switchPreset 广播确保其他模块（如脚本系统）感知预设变更；
 *   模型参数 UI 集中在此管理，避免参数散落多处。
 *
 * 【关联链】
 *   上游：index.mjs（调用 initPresetSelector）
 *   同层依赖：utils.mjs（showToast）
 *   核心依赖：apiConfig.mjs（getCurrentApiType 判断当前 API 类型）、
 *             shared/widgets/beiluDialog.mjs（beiluConfirm / beiluPrompt）、
 *             shared/transport/api-client.mjs（apiFetch）、shared/state/storage.mjs（storage / KEYS）、
 *             shared/state/sharedState.mjs（switchPreset 广播）
 *   后端接口：beilu-preset /config/getdata|setdata（预设 CRUD）；
 *             beilu-regex /config/setdata _action:syncPresetRegex（正则同步）
 *   下游事件：switchPreset 触发 beilu:preset-changed（供 charscript 等监听）
 *
 * 【影响范围】
 *   AI 生成参数（temperature / max_tokens 等）全部来自此处管理的预设；
 *   预设切换同时触发正则脚本切换和脚本系统重载，影响 AI 输出后处理管道。
 *
 * 【使用效果】
 *   import { initPresetSelector, getPresetData, setPresetData } from "./preset.mjs"
 *   初始化后预设下拉框可用，切换预设自动同步正则并广播变更；
 *   模型参数面板实时读写，修改即时生效于下一次 AI 生成。
 */
import { showToast } from "./utils.mjs";
import { getCurrentApiType, getCurrentChannelEntry } from "../settings/apiConfig.mjs" // 6c尾·根级散件归位; // 0711: 渠道条目（获取模型按渠道分发）
import { modelsRequestFor } from "../settings/apiChannels.mjs" // 0711 渠道下拉恢复：ollama=/api/tags 分发
import { normalizeModelsUrl } from "../../shared/state/utils.mjs"; // [合并批 0714] models 端点规整单源（原本地 normalizeUrl 副本删除）
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b 批2/批7：出向统一门面（verb=真动作）
import { getFlowGroupStatusShared } from "../../shared/transport/flowGroupStatus.mjs"; // 浮层 skill 组头部（单飞+TTL 共享，与 work 三面板同源）
import { storage, KEYS } from "../../shared/state/storage.mjs";

// [0720 缓存先行·charsel 同款范式] getSubModes 结果模块级缓存(按 chatId 键):再开弹窗立即渲染
//   零"子模式预设集加载中"等待,后台仍静默校准。失效=既有广播 beilu:subModesConfigChanged
//   (saveSubModes→WS)与 beilu:subModeSwitched(生效子模式变→effective_sub_modes 过期)。
let _smCache = null; // { chatId, sm } 快照
window.addEventListener("beilu:subModesConfigChanged", () => { _smCache = null; });
window.addEventListener("beilu:subModeSwitched", () => { _smCache = null; });
import { switchPreset, getCharId, getChatId, getCachedPresetData } from "../../shared/state/sharedState.mjs"; // R1：getCharId/getChatId 供后端权威解析当前模式；[0717 四格恢复] getCachedPresetData=四格数据（active_preset_by_mode，per-cid 缓存）
import { getCurrentMode, switchModeTo } from "../feature/featureControls.mjs"; // [D 收口 0713] 当前模式读点单源（原直读 localStorage 旁路，无场景特化理由；featureControls 不反向引本文件,无环）；[0717 四格恢复] switchModeTo=四格点击切换模式
import { MODE_BADGE } from "../../shared/state/modeTabMap.mjs"; // [0717 四格恢复] 四格文案派生源（纯常量无环，0716 误删随显示功能一并恢复）

// ============================================================
// beilu 管理面板 — API 通信层（T6b批7：apiFetch → sendAction 门面）
// ============================================================

/**
 * 获取预设插件配置数据
 * @returns {Promise<any>}
 */
async function getPresetData() {
  // T6b批7：原 raw fetch（手检 res.ok + 自 .json()）→ sendAction beilu-preset#getData（GET getdata）。
  // !ok 由门面统一抛错（替代原 `if(!res.ok) throw`），调用方 catch 不变。
  return sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
}

/**
 * 设置预设插件配置数据
 * @param {any} data - 要设置的数据（直接作为请求体）
 * @returns {Promise<any>}
 */
async function setPresetData(data) {
  // T6b批7：beilu-preset setdata 后端按字段分派（import_preset/create_preset/update_model_params/… 非 _action）。
  // 走专用 raw verb=updatePresetConfig（body 直等 payload=data，不注入 _action，对齐字段路由契约）。
  return sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: data });
}

// ============================================================
// 预设正则联动 — 同步预设中的 regex_scripts 到 beilu-regex
// ============================================================

/**
 * 将预设 JSON 中的正则脚本同步到 beilu-regex 插件
 * 调用 syncPresetRegex action：先清除该预设旧的正则，再导入新正则
 * @param {string} presetName - 预设名称
 * @param {object} presetJson - 完整预设 JSON（含 extensions.regex_scripts）
 */
async function syncPresetRegexToPlugin(presetName, presetJson) {
  const scripts = presetJson?.extensions?.regex_scripts;
  if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
    console.log(`[beilu-chat] 预设 "${presetName}" 无正则脚本，跳过同步`);
    return;
  }
  try {
    // T6b批7：beilu-regex setdata {_action:syncPresetRegex} → sendAction beilu-regex#*（通配组装 {_action:verb,...payload}）。
    // !ok 由门面抛错走 catch（原 `if(!resp.ok) throw` 等价并入）。
    const result = await sendAction({
      verb: "syncPresetRegex",
      target: "plugins:beilu-regex",
      source: "web",
      payload: { presetName, scripts },
    });
    const r = result?._result || result;
    console.log(
      `[beilu-chat] 预设 "${presetName}" 正则同步完成: 移除 ${r.removed || 0} 条, 导入 ${r.imported || 0} 条`,
    );
  } catch (err) {
    console.warn(
      `[beilu-chat] 预设 "${presetName}" 正则同步失败:`,
      err.message,
    );
  }
}

/**
 * 从 beilu-regex 插件移除指定预设的所有正则规则
 * @param {string} presetName - 预设名称
 */
async function removePresetRegexFromPlugin(presetName) {
  try {
    // T6b批7：beilu-regex setdata {_action:removeByPreset} → sendAction beilu-regex#*（通配组装）。
    const result = await sendAction({
      verb: "removeByPreset",
      target: "plugins:beilu-regex",
      source: "web",
      payload: { presetName },
    });
    const r = result?._result || result;
    console.log(
      `[beilu-chat] 预设 "${presetName}" 正则已清理: 移除 ${r.removed || 0} 条`,
    );
  } catch (err) {
    console.warn(
      `[beilu-chat] 清理预设 "${presetName}" 正则失败:`,
      err.message,
    );
  }
}

// ============================================================
// beilu 管理面板 — DOM 引用
// ============================================================

// 右栏 — API 设置
const apiFetchModelsBtn = document.getElementById("api-fetch-models");
const apiModelSelect = document.getElementById("api-model-select");

// 左栏 — 预设选择器
const presetSelector = document.getElementById("preset-selector");
const presetCreateBtn = document.getElementById("preset-create-btn");
const presetDeleteBtn = document.getElementById("preset-delete-btn");
const presetRestoreBtn = document.getElementById("preset-restore-btn");
let _builtinPresets = new Set();
// T050·U04：记录"上次已知的稳定预设值"（= 后端真实生效的预设）。
// why：浏览器 change 事件触发时 presetSelector.value 已变成用户新选值，切换失败时
// 无法从 selector 本身读回旧值，故需模块级缓存真源。更新时机=applyPresetData 权威刷新
// + beilu:presetSwitched 成功广播；失败分支复位 selector.value 回此值，使显示与后端一致。
let _lastStablePreset = presetSelector?.value || "";

// 预设面板
const presetName = document.getElementById("preset-name");
const presetImportBtn = document.getElementById("preset-import-btn");
const presetExportBtn = document.getElementById("preset-export-btn");
const presetFileInput = document.getElementById("preset-file-input");
const presetStats = document.getElementById("preset-stats");
const presetStatTotal = document.getElementById("preset-stat-total");
const presetStatEnabled = document.getElementById("preset-stat-enabled");
const presetStatSystem = document.getElementById("preset-stat-system");
const presetStatInject = document.getElementById("preset-stat-inject");
// 模型参数
const paramTemp = document.getElementById("param-temp");
const paramTempValue = document.getElementById("param-temp-value");
const paramTopP = document.getElementById("param-top-p");
const paramTopPValue = document.getElementById("param-top-p-value");
const paramTopK = document.getElementById("param-top-k");
const paramTopKValue = document.getElementById("param-top-k-value");
const paramMinP = document.getElementById("param-min-p");
const paramMinPValue = document.getElementById("param-min-p-value");
const paramMaxContext = document.getElementById("param-max-context");
const paramMaxTokens = document.getElementById("param-max-tokens");
// T11-A penalty 接链：范围 -2~2，空=用预设值。哨兵 null（不能用 -1，-1 合法）。
const paramFrequencyPenalty = document.getElementById("param-frequency-penalty");
const paramPresencePenalty = document.getElementById("param-presence-penalty");
const modelParamsSave = document.getElementById("model-params-save");
const modelParamsStatus = document.getElementById("model-params-status");

// ============================================================
// beilu 管理面板 — 状态
// ============================================================

// ============================================================
// 模型获取逻辑 (移植自 proxy/display.mjs)
// [合并批 0714] 本地 normalizeUrl（三副本之一的逻辑源）删除 → shared/state/utils.normalizeModelsUrl 单源
// ============================================================

// [0717 链路修] 乱序守卫序号：apiConfig 切源现在每次都静默触发本函数（原一次性门闩已删），
//   快速连切 A→B 时 A 的慢响应后至会用 A 源的模型列表覆盖 B 已填好的下拉——后发压前发
//   （同 subModePanel._modelSelectReqId 范式）。
let _fetchModelsSeq = 0;
async function fetchModels({ silent = false } = {}) {
  const _seq = ++_fetchModelsSeq;
  const apiUrlInput = document.getElementById("api-url");
  const apiKeyInput = document.getElementById("api-key");
  const url = apiUrlInput?.value;
  const apikey = apiKeyInput?.value;
  const btn = apiFetchModelsBtn;
  const select = apiModelSelect;

  if (!url) {
    if (!silent) showToast("请先填写 API URL", "error");
    return;
  }

  // 0711: 列表端点按渠道分发（ollama=/api/tags，响应 {models:[{name}]}；其余走 normalizeModelsUrl 单源惯例）
  const _chEntry = getCurrentChannelEntry();
  const _req = _chEntry?.generator === "ollama" ? modelsRequestFor(_chEntry, url) : null;
  const modelsUrl = _req ? _req.url : normalizeModelsUrl(url);
  if (!modelsUrl) {
    if (!silent) showToast("无效的 API URL", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add("loading");
  }
  if (!silent) showToast("正在获取模型列表...", "info");

  try {
    let models = [];

    // 1. 尝试直接请求
    try {
      // R1-SKIP: modelsUrl=用户填的外部 API 端点(自管 Authorization Bearer)；apiFetch 401→/login 对外站有害。
      const response = await fetch(modelsUrl, {
        headers: { Authorization: apikey ? "Bearer " + apikey : undefined },
      });
      if (response.ok) {
        const result = await response.json();
        models = _req ? _req.normalize(result).map((id) => ({ id })) : (result.data || result);
      } else {
        throw new Error(`Direct fetch failed: ${response.status}`);
      }
    } catch (directError) {
      console.warn(
        "[beilu-chat] Direct fetch failed, trying proxy...",
        directError,
      );

      // 2. 尝试通过 beilu-memory 代理请求
      try {
        // T6b 批2：raw fetch（无超时/401 保护）→ sendAction 门面（memory 通配路由；!ok 抛错并入 catch）
        const proxyResult = await sendAction({
          verb: "getModels", target: "plugins:beilu-memory", source: "web",
          payload: { apiConfig: { url: url, key: apikey } },
        });
        if (proxyResult.success && Array.isArray(proxyResult.models)) {
          models = proxyResult.models.map((id) => ({ id }));
        } else {
          throw new Error(proxyResult.error || "Proxy returned invalid data");
        }
      } catch (proxyError) {
        console.error("[beilu-chat] Proxy fetch also failed:", proxyError);
        throw new Error(`获取模型失败: ${directError.message}`);
      }
    }

    if (!Array.isArray(models)) throw new Error("返回数据格式错误");

    const modelIds = [...new Set(models.map((m) => m.id))].sort();

    // 更新下拉框（乱序守卫：本轮已被更新的调用超越 → 丢弃，不覆盖新源列表）
    if (select && _seq === _fetchModelsSeq) {
      // [0717] 列表未变则跳过 DOM 重建：下拉 mousedown 每次实时刷新（凛倾「每次点击都需要访问」），
      //   重建 options 会把刚展开的原生下拉强制收起——同列表时静默跳过=既实时又不打断操作
      const _oldIds = Array.from(select.options).map((o) => o.value).filter(Boolean);
      const _sameList = !select.classList.contains("hidden") &&
        _oldIds.length === modelIds.length && _oldIds.every((v, i) => v === modelIds[i]);
      if (!_sameList) {
        select.innerHTML =
          '<option value="" disabled selected>选择模型...</option>';
        modelIds.forEach((id) => {
          const opt = document.createElement("option");
          opt.value = id;
          opt.textContent = id;
          select.appendChild(opt);
        });
        // [0717 链路修] 回选当前已配模型：原重填后停在 placeholder，镜像方（smart 面板）
        //   拿到空选中值=显示与生效模型分叉；#api-model 是模型单源（sharedState.setModel 双写点）
        const _curModel = document.getElementById("api-model")?.value?.trim();
        if (_curModel && modelIds.includes(_curModel)) select.value = _curModel;
        select.classList.remove("hidden");
      }
    }

    if (!silent) showToast(`✅ 获取成功，共 ${modelIds.length} 个模型`, "success");
  } catch (err) {
    console.error("[beilu-chat] 获取模型失败:", err);
    if (!silent) showToast("❌ " + err.message, "error");

    // B1修复: 获取失败时，如果已有保存的模型名，将其作为fallback选项
    const savedModel = document.getElementById("api-model")?.value?.trim();
    if (savedModel && select && _seq === _fetchModelsSeq) {
      select.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = savedModel;
      opt.textContent = savedModel;
      opt.selected = true;
      select.appendChild(opt);
      select.classList.remove("hidden");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }
}

// ============================================================
// 预设管理
// ============================================================

/**
 * 将后端返回的预设数据应用到 UI
 * @param {object} data - getPresetData() 的返回值
 */
/** 预设描述缓存（从 GetData 获取） */
let presetDescriptions = {};
// [隔离架构 2026-07-24] 原 F5 乱序守卫序号 _hdrUsingPresetSeq 已随 using_preset 跨域第二源删除
// 预设 bucket 缓存（从 GetData preset_buckets 获取，registry 权威单源）——分组显示优先消费，
// 替代名字关键词推断（分身系/前端美化/大项目协调 名字不命中关键词被误归 chat 的病灶）
let presetBuckets = {};

/**
 * 预设标签推断 — 根据名字和自定义标签推断预设分类
 * 用户自定义标签存localStorage("beilu-preset-tags")，格式: {presetName: "标签"}
 */
// [0716 分类扩容·凛倾原话] "需要细分,去增加多个自定义,增加分身,bot自定义.然后ppt制作那些需要再创建一个skill"
//   → 新增 clone/bot/ppt 三 bucket 分类；tab/tagOrder 全走本表派生（Object.values），
//   加分类=只扩本 map 零新分支。撤 2026-07-11 "clone→code 显示映射"旧指示，clone 有独立 tab。
const _CAT_TO_TAG = { chat: "🎭聊天", code: "💻编程", work: "📋工作", clone: "🤖分身", bot: "📨Bot", ppt: "📊PPT" };
// 单源派生：内置分类顺序（Object.values 保序=对象字面量声明序）+ 通用兜底尾。
// 加/减分类=只改 _CAT_TO_TAG 一处，tagOrder/顶部tab/归档下拉/浮层分组全联动。
const TAG_ORDER = [...Object.values(_CAT_TO_TAG), "📦通用"];
// 导出给设置面板（settings/panels.mjs 的分类 tab / 归档下拉共用同源）
export const PRESET_CATEGORIES = Object.keys(_CAT_TO_TAG); // ["chat","code","work","clone","bot","ppt"]
export const PRESET_CATEGORY_LABELS = { ..._CAT_TO_TAG };  // 键=bucket，值=带 emoji 标签
const _CODE_KW = ["任务确认师","前置设计师","框架审查员","代码专家","前置错误生产师","测试专家","纠错专家","任务交接员","深度思考师","算法","code","代码"];
const _WORK_KW = ["beilu-work-","工作","work"];
const _CHAT_KW = ["贝露","gemini","claude","预设"];

// [0713 单源化] 预设分类判定唯一实现：编辑面板(settings/panels.mjs)与选择器共用本函数。
// 判定链：用户自定义(localStorage) → 后端 registry bucket(权威) → 旧 tags → 名字关键词 → chat 兜底。
// 曾各持一份不同质副本（编辑面板缺 bucket 链 → 分身预设兜底进聊天，分类数两边对不上）。
// [0716 二级细化·凛倾原话] "注意我们有很多区分.然后细化我是说全部都细化.比如code可以细化大中小项目,等等"
//   → 一级/二级路径式分类：bucket 值可用 "一级/二级"（如 "code/大型项目"），二级组名完全自由字符串。
//   兼容规则：无"/"=纯一级（现有值全兼容零迁移）。一级必须∈_CAT_TO_TAG 键或用户自定义分类名，
//   否则整值当自定义一级。判定链所有返回值均可能是路径式；classifyPresetName 保持返回**一级**
//   （tab/optgroup/浮层大分组消费一级，二级由 subCategoryOf 单独取），旧消费者零改。
//   代码零处枚举二级名——只做拆分与显示，加/减二级=只改数据 zero code change。
function _classifyPresetRaw(name) {
  try {
    const custom = JSON.parse(storage.get(KEYS.BEILU_PRESET_CATEGORIES) || "{}");
    if (custom[name]) return custom[name];
  } catch {}
  // 后端 registry bucket 权威优先（用户显式自定义仍居首）。放行任何一级在 _CAT_TO_TAG 里的 bucket，
  // 加分类=只扩 _CAT_TO_TAG 零改本函数；二级完全自由不参与放行判定。
  const _bkt = presetBuckets[name];
  if (_bkt) {
    const _pri = String(_bkt).split("/", 2)[0];
    if (_CAT_TO_TAG[_pri]) return _bkt;
  }
  try {
    const legacy = JSON.parse(storage.get(KEYS.BEILU_PRESET_TAGS) || "{}");
    if (legacy[name]) {
      const v = legacy[name];
      if (v.includes("编程") || v === "code") return "code";
      if (v.includes("工作") || v === "work") return "work";
      if (v.includes("聊天") || v === "chat") return "chat";
      return v;
    }
  } catch {}
  const n = name.replace(/\.json$/i, "").toLowerCase();
  if (_WORK_KW.some(k => n.includes(k))) return "work";
  if (_CODE_KW.some(k => n.includes(k))) return "code";
  if (_CHAT_KW.some(k => n.includes(k))) return "chat";
  return "chat";
}

export function classifyPresetName(name) {
  const raw = _classifyPresetRaw(name);
  return String(raw).split("/", 2)[0]; // 只返回一级，兼容旧消费者（tab/optgroup/浮层大分组）
}

// [0716 二级路径] 取二级组名（bucket 中 "/" 后段）；无二级或无 bucket 返回空串。
//   浮层/下拉小节标题消费；空串=归入"未分组"节尾。二级值域完全自由，代码不枚举。
export function subCategoryOf(name) {
  const raw = _classifyPresetRaw(name);
  const parts = String(raw).split("/", 2);
  return parts[1] || "";
}

function _inferPresetTag(name) {
  const cat = classifyPresetName(name);
  return _CAT_TO_TAG[cat] || `📦${cat}`;
}

function applyPresetData(data) {
  // 缓存预设描述
  if (data.preset_descriptions) {
    presetDescriptions = data.preset_descriptions;
  }
  // 缓存预设 bucket（registry 权威单源，分组显示消费）
  if (data.preset_buckets) {
    presetBuckets = data.preset_buckets;
  }

  // 填充预设选择器下拉框（带标签分类）
  if (presetSelector && data.preset_list) {
    const prevValue = presetSelector.value;
    presetSelector.innerHTML = "";
    if (data.preset_list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(无预设)";
      presetSelector.appendChild(opt);
    } else {
      // 按标签分组显示：每一级分类一个 optgroup。
      // [0716 凛倾「没有起到分类作用,可以直接删除…完全多此一举」] 原 0716 二级细化在此拆
      //   "tag — 二级"小节 optgroup 已删：native select 的组标题行不可点，二级小节让 1-2 个
      //   条目也顶一行标题=被误认成选项的死行；二级分组只保留在浮层卡片视图（renderPresets
      //   的 preset-subgroup-title，标题样式明确不致误认）。本下拉维持一级 optgroup
      //   （左栏无分类 tabs，一级组是此处唯一分类手段）。
      const grouped = {};
      data.preset_list.forEach((name) => {
        const tag = _inferPresetTag(name);
        if (!grouped[tag]) grouped[tag] = [];
        grouped[tag].push(name);
      });
      const tagOrder = TAG_ORDER; // 单源派生（_CAT_TO_TAG 顺序 + 📦通用），加分类零改本处
      tagOrder.forEach((tag) => {
        if (!grouped[tag] || grouped[tag].length === 0) return;
        const grp = document.createElement("optgroup");
        grp.label = tag;
        grouped[tag].forEach((name) => {
          const opt = document.createElement("option"); opt.value = name; opt.textContent = name; grp.appendChild(opt);
        });
        presetSelector.appendChild(grp);
      });
      // 未分组的归入通用（前缀显示 [tag] name）
      Object.keys(grouped).forEach((tag) => {
        if (tagOrder.includes(tag)) return;
        grouped[tag].forEach((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = `[${tag}] ${name}`;
          presetSelector.appendChild(opt);
        });
      });
    }
    // [0725 单源] resolved 为权威(空=本窗无在用预设,选择器清空,禁 prevValue 顶旧值冒充);
    //   仅字段整体缺失(旧调用面)才保留 prevValue 兜底。
    const _selResolved = window._beiluResolveActivePreset?.(data);
    presetSelector.value = _selResolved === undefined ? (prevValue || "") : _selResolved;
    // T050·U04：权威刷新后同步稳定真源，供切换失败回滚使用
    _lastStablePreset = presetSelector.value;
  }

  if (presetName) presetName.textContent = data.preset_name || "未加载";
  // W28: 同步预设名到顶部info栏
  const headerPreset = document.getElementById("header-current-preset");
  if (headerPreset) {
    // [隔离架构 2026-07-24 双源收口] 顶栏=【正在使用的预设】,取同一 GetData 响应的
    //   active_preset_resolved（后端与生成读键同函数解析;读同源批后 preset_name 也已是线级值）。
    //   原实现再异步拉 beilu-memory getSubModes.using_preset = 跨域第二解析源+独立时序——
    //   F5 序号守卫、三处跨源作废 bump 全是为这条第二源打的护栏,源删护栏亡（高内聚低耦合）。
    //   事件流更新仍由 layout 订阅站承担（0706 单写者纪律不变）。
    // [0725 凛倾「没有全局」] resolved 字段存在即为唯一真值——为空("")就显示空,禁回落 preset_name
    //   (主引擎名,启动时可能载着盘上残值=全局漏出口)。字段缺失(无 cid 旧调用面)才用 preset_name。
    const _hdrName = data.active_preset_resolved !== undefined ? data.active_preset_resolved : (data.preset_name || "");
    headerPreset.textContent = _hdrName;
    headerPreset.style.cursor = "pointer";
    headerPreset.title = _hdrName ? `当前预设: ${_hdrName}\n点击打开预设管理` : "点击打开预设管理";
  }
  if (data.model_params) syncModelParamsUI(data.model_params);
  if (Array.isArray(data.builtin_presets)) _builtinPresets = new Set(data.builtin_presets);
  if (presetRestoreBtn) {
    const curName = presetSelector?.value || data.preset_name;
    presetRestoreBtn.classList.toggle("hidden", !_builtinPresets.has(curName));
  }
}

async function loadPresetData() {
  try {
    const data = await getPresetData();
    applyPresetData(data);
  } catch (err) {
    console.error("[beilu-chat] 加载预设数据失败:", err);
    if (presetName) presetName.textContent = "加载失败";
  }
}

// 导入
presetImportBtn?.addEventListener("click", () => presetFileInput?.click());
presetFileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const presetName_ = file.name.replace(/\.json$/i, "");

    // 首次导入（不强制覆盖）
    // [预设切换互斥 2026-07-13 S7] 带窗口坐标：后端按 [cid:mode] 激活到本窗口，不夺全局槽
    const _impCoord = { chatid: getChatId() || undefined, charName: getCharId() || undefined };
    const result = await setPresetData({
      import_preset: { json, name: presetName_, ..._impCoord },
    });

    // 检查重名
    if (result.duplicate) {
      const overwrite = await beiluConfirm(
        `预设 "${presetName_}" 已存在，是否覆盖？\n选择"取消"将跳过导入。`,
      );
      if (overwrite) {
        await setPresetData({
          import_preset: { json, name: presetName_, force_overwrite: true, ..._impCoord },
        });
        showToast(`预设 "${presetName_}" 已覆盖导入`, "success");
      } else {
        showToast("导入已取消", "info");
        presetFileInput.value = "";
        return;
      }
    } else {
      showToast(`预设 "${file.name}" 导入成功`, "success");
    }

    // 同步预设中的正则脚本到 beilu-regex 插件
    await syncPresetRegexToPlugin(presetName_, json);

    await loadPresetData();
  } catch (err) {
    showToast("导入失败: " + err.message, "error");
  }
  presetFileInput.value = "";
});

// W55: 预设大悬浮窗
function _openPresetOverlay() {
  let overlay = document.getElementById("preset-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "preset-overlay";
    overlay.className = "hidden";
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");

  // 获取当前预设列表
  const options = Array.from(presetSelector?.options || []);
  // 选中高亮真源：非一次性快照——订阅 beilu:presetSwitched（switchPreset 唯一成功出口）随切换重渲，
  // 否则点卡片应用成功后"✓ 当前使用"仍停在旧卡（2026-07-11 凛倾实测病灶）
  let activePreset = presetSelector?.value || "";
  // 按标签分组
  const grouped = {};
  const tagOrder = TAG_ORDER; // 单源派生
  options.forEach((opt) => {
    if (!opt.value) return;
    const tag = _inferPresetTag(opt.value);
    if (!grouped[tag]) grouped[tag] = [];
    grouped[tag].push(opt.value);
  });

  overlay.innerHTML = `<div class="preset-modal" style="position:relative">
    <button class="preset-modal-close" title="关闭">✕</button>
    <div class="preset-modal-header">
      <input type="text" id="preset-search-input" placeholder="🔍 搜索预设..." />
      <span style="font-size:0.8rem;opacity:0.5">${options.filter(o => o.value).length} 个预设</span>
    </div>
    <div id="preset-modal-modes" class="preset-modal-modes" style="display:none"></div>
    <div id="preset-modal-skillgroup"></div>
    <div class="preset-modal-body" id="preset-modal-body"></div>
  </div>`;

  function escHandler(ev) {
    if (ev.key === "Escape") closeOverlay();
  }
  const closeOverlay = () => { overlay.classList.add("hidden"); document.removeEventListener("keydown", escHandler); window.removeEventListener("beilu:presetSwitched", _onSwitchedRerender); window.removeEventListener("beilu:presetSwitched", _onSwitchedTiles); window.removeEventListener("beilu:preset-changed", _onSwitchedTiles); window.removeEventListener("beilu:mode-switched", _onModeSwitchedTiles); window.removeEventListener("beilu:subModeSwitched", _onSubModeSwitchedHere); window._beiluPresetOverlayReopen = null; }; // [0717 四格恢复] 三个四格监听成对清理；[0727] +子模式切换监听同批成对清理
  overlay.querySelector(".preset-modal-close")?.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) closeOverlay(); });
  document.addEventListener("keydown", escHandler);

  const bodyEl = document.getElementById("preset-modal-body");
  const searchInput = document.getElementById("preset-search-input");

  // 切换成功广播 → 更新选中真源 + 重渲列表（覆盖本浮层点卡应用 + 左栏下拉等一切切换入口）
  const _onSwitchedRerender = (ev) => {
    if (!ev.detail?.name) return;
    activePreset = ev.detail.name;
    renderPresets(searchInput?.value || "");
  };
  window.addEventListener("beilu:presetSwitched", _onSwitchedRerender);

  // [0716 刷新机制] 名单变化重开钩子：弹窗 options/grouped 是开窗快照，名单变了要重建快照。
  //   由模块级 presetListChanged 订阅者在 loadPresetData 完成后调用（保证重开读到新下拉）；保留搜索词。
  //   closeOverlay 置 null 成对清理；重开路径内 _openPresetOverlay 会重新设置本钩子。
  window._beiluPresetOverlayReopen = () => {
    const _f = searchInput?.value || "";
    closeOverlay();
    _openPresetOverlay();
    if (_f) {
      const si = document.getElementById("preset-search-input");
      if (si) { si.value = _f; si.dispatchEvent(new Event("input")); }
    }
  };

  // ============================================================
  // [0716 凛倾定案] 原 T020 模式绑定格的「绑定写口」（mode_preset_bindings）删除——
  //   「绑定」概念不存在，只有「当前正在使用的预设」。点卡片=直接切换应用（switchPreset）。
  //   保留的两个独立功能改为跟随实时当前模式（_getCurTile()，getCurrentMode 单源）：
  //   ① code/work 视图过滤（凛倾原话"code和work那边只可以看到绑定了子模式的预设"，集合取 getSubModes.presetName）
  //   ② skill 组头部（code/work 专属）
  // [0717 凛倾纠偏「4个模式的预设显示被错误删除」] 0716 把四格的【显示功能】连带删了=超出原话范围
  //   （0716 原话只否定"绑定"概念）。恢复四格：显示 4 个模式各自「当前正在使用的预设」
  //   （凛倾 0701「中间是每个模式的切换…同时也是显示4个模式各绑定的是什么预设」/0706「4个模式
  //   就是现在前端的4个模式」）。数据=后端 GetData active_preset_by_mode（resolveActivePresetName
  //   与生成读键同函数，禁前端镜像解析 map）；点格=切换到该模式（switchModeTo 就地切换，零绑定写口）。
  // ============================================================
  const _getCurTile = () => {
    // [D 收口 0713] getCurrentMode() 单源（featureControls 内存实时态,updateModeSwitchUI 写点同步）——
    //   每次调用现取非快照，浮层期间 tab 联动仍即时反映。
    const m = getCurrentMode() || "chat";
    return (m === "smart" || m === "code" || m === "work") ? m : "chat";
  };
  const modesEl = document.getElementById("preset-modal-modes");
  const _TILE_ICONS = { chat: '<i data-ic="drama"></i>', smart: '<i data-ic="sparkles"></i>', code: '<i data-ic="code"></i>', work: '<i data-ic="clipboard"></i>' };
  const MODE_TILES = Object.entries(_TILE_ICONS).map(([key, icon]) => ({ key, icon, label: MODE_BADGE[key]?.label || key }));
  let _byMode = null; // 后端 active_preset_by_mode（本窗口四模式生效预设，单源下发）
  let _byModeSrc = null; // [隔离架构 0724] 来源层级 exact/bare/global/none（与 by_mode 同批下发）
  async function _loadModeTiles() {
    try {
      const pd = await getCachedPresetData();
      _byMode = pd?.active_preset_by_mode || null;
      _byModeSrc = pd?.active_preset_by_mode_src || null;
    } catch { _byMode = null; _byModeSrc = null; }
    renderModeTiles();
  }
  function renderModeTiles() {
    if (!modesEl) return;
    if (!_byMode) { modesEl.innerHTML = ""; modesEl.style.display = "none"; return; } // 无 cid/后端字段缺省=诚实不渲染，不拿全局值凑
    const _cur = getCurrentMode() || "chat";
    modesEl.style.display = "";
    modesEl.innerHTML = MODE_TILES.map((m) => {
        const isCur = m.key === _cur;
        // [隔离架构 2026-07-24 · 凛倾「储存/功能/传导都要隔离」] 按来源层级诚实渲染：
        //   exact=该模式线级真有记录（正常显示）；global=无记录、跟随全局默认（弱化+标注——
        //   原先与真值同样显示，全局槽一变四格齐变还以为"每个模式的预设都被改了"，0724 实证）；
        //   bare=旧裸键跨模式共享记录（标注）；空=—。值不变只标来源，判断权交给用户。
        const _pName = _byMode[m.key] || "";
        const _pSrc = _byModeSrc?.[m.key] || (_pName ? "exact" : "none");
        // [0725 凛倾「我们没有全局」] 标注词全删——四格只显示【当前窗口该模式在用的预设】。
        //   exact(线级记录)/submode(code/work 当前子模式默认,后端回退链 0725 修)=正常显示;
        //   user 级回退残值(chat/smart 未单独选过时)=仅弱化+title 说明,不造"全局/共享"概念词。
        let _pHtml;
        if (!_pName) _pHtml = "—";
        else if (_pSrc === "global" || _pSrc === "bare") _pHtml = `<span style="opacity:.45">${_pName}</span>`;
        else _pHtml = _pName;
        const _pTitle = (_pSrc === "global" || _pSrc === "bare") ? `${_pName}（本窗口此模式尚未单独选择预设）` : _pName;
        return `<div class="pm-mode-tile ${isCur ? "selected" : ""}" data-mode="${m.key}" title="点击切换到${m.label}模式">
          <div class="pm-m-head"><span>${m.icon} ${m.label}${isCur ? "（当前）" : ""}</span></div>
          <div class="pm-m-preset" title="${_pTitle}">${_pHtml}</div>
        </div>`;
      }).join("");
    modesEl.querySelectorAll(".pm-mode-tile").forEach((tile) => {
      tile.addEventListener("click", async () => {
        const _mk = tile.dataset.mode;
        if (_mk === (getCurrentMode() || "chat")) return; // 已是当前模式=幂等
        const _ok = await switchModeTo(_mk); // 就地切换（无 opts.tab=当前会话切到该模式，switchMode 已含 preset-changed resync）
        if (_ok === false) { showToast("模式切换失败", "error"); return; }
        // 模式换轴后过滤集/skill 头部/高亮全部随 _getCurTile 重取；预设缓存已由 resync 链失效
        await _loadModeTiles();
        renderSkillGroupHeader();
        renderPresets(searchInput?.value || "");
      });
    });
  }
  // 预设切换成功（本浮层点卡/左栏/AI）→ 四格值可能变化，随缓存失效后重拉
  const _onSwitchedTiles = () => { _loadModeTiles(); };
  window.addEventListener("beilu:presetSwitched", _onSwitchedTiles);
  window.addEventListener("beilu:preset-changed", _onSwitchedTiles);
  // 浮层开着时外部切模式（顶部 tab 联动等）→ 当前格高亮/过滤集/skill 头部随轴重渲
  const _onModeSwitchedTiles = () => { renderModeTiles(); renderSkillGroupHeader(); renderPresets(searchInput?.value || ""); };
  window.addEventListener("beilu:mode-switched", _onModeSwitchedTiles);
  // [0727 消费端补齐·凛倾实测"浮层两处显示打架"] 浮层开着时切子模式 → 重拉子模式生效值并重渲。
  //   病史：`_smActives` 只在浮层打开那一刻的 IIFE(:784) 填一次，浮层生命周期内**没有任何刷新入口**——
  //   于是「模式卡预设名」（订阅了 presetSwitched/preset-changed）已更新、「当前子模式」还是打开时的旧值。
  //   本监听与 subModePanel._setActiveSubMode 补发的生产端配对；模块缓存 _smCache 已由 :52 同事件清空，
  //   这里只负责把新值取回来重渲（同 _onSwitchedTiles 范式，关闭时成对移除）。
  const _onSubModeSwitchedHere = async () => {
    try {
      const sm = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web", payload: { chatId: getChatId() || undefined } });
      _smCache = { chatId: getChatId() || null, sm };
      _applySm(sm);
    } catch (e) {
      console.warn("[preset] 子模式切换后重拉失败（头部保持上次值）:", e?.message || e);
    }
    renderSkillGroupHeader();
    renderPresets(searchInput?.value || "");
  };
  window.addEventListener("beilu:subModeSwitched", _onSubModeSwitchedHere);
  // presetName → [绑定它的子模式 label]（卡片标注消费；过滤=has）。加载态三值防时序闪变：
  //   loading 期间 code/work 视图渲加载占位（原先集合空=不过滤 → 先闪全量再缩水）；
  //   failed 才退化为不过滤（诚实降级，不装正常空列表）。
  const _subModePresets = { code: new Map(), work: new Map() };
  let _smState = "loading"; // loading | ready | failed
  let _smAll = []; // getSubModes 全量（当前激活子模式 label 反查）
  let _smActives = null; // { effective: { code, work } } — 后端 getSubModes effective_sub_modes 下发（键收口 2026-07-13）
  let _flowStatus = null; // getFlowGroupStatus 结果（当前 skill 组 + steps + 进度）

  function _passModeFilter(name) {
    const _vt = _getCurTile();
    if (_vt !== "code" && _vt !== "work") return true;
    if (_smState !== "ready") return true; // loading 由 renderPresets 占位拦截；failed=退化不过滤
    const map = _subModePresets[_vt];
    return map.size === 0 ? true : map.has(name);
  }

  // [键收口 2026-07-13] 单源=后端 getSubModes 下发的 effective_sub_modes（resolveActiveSubModeId 按请求
  //   chatId 算好）——原地镜像解析链是后端 storage.mjs 的第 3 份同构副本，语义一漂即出口不同步，删。
  function _resolveActiveSubModeId(group) {
    if (!_smActives?.effective) return "";
    return group === "work" ? _smActives.effective.work : _smActives.effective.code;
  }

  function _subModeLabel(id) {
    const m = _smAll.find((x) => x.id === id);
    return m ? (m.label || m.id) : (id || "");
  }

  // skill 组头部（code/work 模式专属）：当前 skill 组 + 组内步骤子目录 + 当前激活子模式名。
  // 数据=getFlowGroupStatusShared(与 work 三面板同源) + getSubModes 激活态镜像解析。
  const skillEl = document.getElementById("preset-modal-skillgroup");
  function renderSkillGroupHeader() {
    if (!skillEl) return;
    const _vt = _getCurTile();
    if (_vt !== "code" && _vt !== "work") { skillEl.innerHTML = ""; return; }
    const curSmLabel = _smState === "ready" ? _subModeLabel(_resolveActiveSubModeId(_vt)) : "";
    let fgHtml = "";
    const fg = _flowStatus;
    if (fg?.active) {
      const st = fg.state || {};
      const cur = st.current_step || 0;
      const statusLabel = { running: "▶ 运行中", awaiting_approval: "⚠ 等待审批", stopped: "⏹ 已停止", completed: "✓ 完成" }[st.status] || st.status || "";
      const stepsHtml = (fg.steps || []).map((s, i) => {
        const icon = st.status === "completed" || i < cur ? "✓" : i === cur ? "▶" : "·";
        const isCur = i === cur && st.status !== "completed";
        return `<span style="font-size:0.72rem;padding:1px 6px;border-radius:6px;${isCur ? "background:var(--beilu-amber-10,rgba(255,180,0,.12));color:var(--beilu-amber,#c80);font-weight:600" : "opacity:.55"}" title="${s.preset_name ? `预设: ${s.preset_name}` : ""}">${icon} ${i + 1}.${s.label || s.mode || ""}</span>`;
      }).join("");
      fgHtml = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:3px">
        <span style="font-size:0.75rem;font-weight:600">Skill组: ${fg.name || fg.filename || ""}</span>
        <span style="font-size:0.7rem;opacity:.6">${statusLabel} ${cur + 1}/${st.total_steps || (fg.steps || []).length}</span>
        ${stepsHtml}
      </div>`;
    } else if (fg) {
      fgHtml = `<div style="font-size:0.72rem;opacity:.45;margin-top:3px">无运行中的 skill 组</div>`;
    }
    skillEl.innerHTML = `<div style="padding:4px 8px;border-radius:8px;background:rgba(128,128,128,.06);margin:4px 0">
      <span style="font-size:0.75rem">当前子模式: <b>${curSmLabel || (_smState === "loading" ? "加载中…" : "—")}</b></span>
      ${fgHtml}
    </div>`;
  }

  // 异步拉子模式预设集 + skill 组运行态（不阻塞首屏；到达后重渲头部/列表）
  //   [0716 凛倾定案] 原「拉 mode_preset_bindings」已随「绑定」概念删除。
  _loadModeTiles(); // [0717 四格恢复] 首拉四格数据（独立异步，不阻塞列表）
  // 填充闭包态单源（缓存先行与后台校准两路共用,防两份填充逻辑漂移）
  const _applySm = (sm) => {
    _smAll = sm?.sub_modes || [];
    _smActives = { effective: sm?.effective_sub_modes || null }; // 键收口 2026-07-13：只存后端算好的生效值，原始三字段不再本地解析
    _subModePresets.code.clear();
    _subModePresets.work.clear();
    for (const m of _smAll) {
      if (!m?.presetName) continue;
      const map = _subModePresets[m.modeGroup === "work" ? "work" : "code"];
      map.set(m.presetName, [...(map.get(m.presetName) || []), m.label || m.id]);
    }
    _smState = "ready";
  };
  // [0720 缓存先行] 同 chatId 的上次结果立即就绪渲染,下方 IIFE 照常后台校准
  if (_smCache && _smCache.chatId === (getChatId() || null)) {
    _applySm(_smCache.sm);
    renderSkillGroupHeader();
    renderPresets(searchInput?.value || "");
  }
  (async () => {
    try {
      const sm = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web", payload: { chatId: getChatId() || undefined } });
      _smCache = { chatId: getChatId() || null, sm }; // 模块缓存快照(下次打开秒显)
      _applySm(sm);
    } catch (e) {
      _smState = _smState === "ready" ? "ready" : "failed"; // 缓存已就绪时校准失败不降级显示
      console.warn("[preset] 子模式预设集加载失败（code/work 过滤退化为不过滤）:", e?.message || e);
    }
    try {
      _flowStatus = await getFlowGroupStatusShared({ chatid: getChatId() || undefined });
    } catch (e) { console.warn("[preset] skill 组状态加载失败（头部退化为不显示）:", e?.message || e); }
    renderSkillGroupHeader();
    renderPresets(searchInput?.value || "");
  })();

  function renderPresets(filter) {
    const f = (filter || "").toLowerCase();
    // 时序修：code/work 过滤集未就绪时渲占位不渲全量（原先集合空=不过滤 → 先闪 16 张再缩 11 张）；
    // 数据到达（IIFE 尾）/失败置 failed 后重渲，failed 走 _passModeFilter 退化全显
    const _vt = _getCurTile();
    if ((_vt === "code" || _vt === "work") && _smState === "loading") {
      bodyEl.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.4">子模式预设集加载中…</div>';
      return;
    }
    // 卡片标注：code/work 模式下显示配了该预设的子模式名（presetName→label 反查）
    const _subLabelOf = (name) => {
      if (_vt !== "code" && _vt !== "work") return "";
      const labels = _subModePresets[_vt].get(name);
      return labels?.length ? labels.join("/") : "";
    };
    let html = "";
    // 0716 二级细化：一级组标题下按二级组名拆小节（h4 级），二级为空归"未分组"节尾；
    //   全一级=不拆节，与旧视觉零差异。二级值域完全自由（用户从 registry bucket "一级/二级" 或
    //   自定义分类映射输入），代码不枚举二级名。
    const _renderCards = (items, tagName) => {
      let out = `<div class="preset-grid">`;
      items.forEach((name) => {
        const isActive = name === activePreset;
        const subLabel = _subLabelOf(name);
        out += `<div class="preset-card ${isActive ? "active" : ""}" data-preset="${name}">
          <div class="preset-card-name" title="${name}">${name}</div>
          <div class="preset-card-tag">${isActive ? "✓ 当前使用" : tagName}${subLabel ? ` · 子模式:${subLabel}` : ""}</div>
        </div>`;
      });
      out += `</div>`;
      return out;
    };
    const _renderTagGroup = (tag, filteredItems) => {
      if (filteredItems.length === 0) return "";
      // 按二级组名拆小节
      const sub = {}; const subOrder = [];
      filteredItems.forEach((n) => { const s = subCategoryOf(n) || ""; if (!(s in sub)) { sub[s] = []; subOrder.push(s); } sub[s].push(n); });
      const nonEmpty = subOrder.filter((s) => s !== "");
      let out = `<div class="preset-group-title">${tag} (${filteredItems.length})</div>`;
      if (nonEmpty.length === 0) { out += _renderCards(filteredItems, tag); return out; }
      const ordered = [...nonEmpty, ...(sub[""] ? [""] : [])];
      ordered.forEach((s) => {
        const label = s || "未分组";
        out += `<div class="preset-subgroup-title" style="font-size:0.72rem;opacity:0.55;margin:6px 0 2px 8px">— ${label} (${sub[s].length})</div>`;
        out += _renderCards(sub[s], tag);
      });
      return out;
    };
    // 按分组渲染
    tagOrder.forEach((tag) => {
      const items = (grouped[tag] || []).filter((n) => (!f || n.toLowerCase().includes(f)) && _passModeFilter(n)); // T020：code/work 绑定目标只显子模式预设集
      html += _renderTagGroup(tag, items);
    });
    // 未分类
    Object.keys(grouped).forEach((tag) => {
      if (tagOrder.includes(tag)) return;
      const items = (grouped[tag] || []).filter((n) => (!f || n.toLowerCase().includes(f)) && _passModeFilter(n));
      html += _renderTagGroup(tag, items);
    });
    if (!html) html = '<div style="text-align:center;padding:40px;opacity:0.4">无匹配预设</div>';
    bodyEl.innerHTML = html;

    // 点击卡片（[0716 凛倾定案] 绑定概念已删）：直接切换「当前正在使用的预设」并应用到当前会话。
    // [预设隔离 2026-07-11] 不显式传 mode：缺省交后端 switch_preset 用 getActiveMode 自解析
    //   （写键=读键单源，防前端 localStorage 与后端 active_modes_map 双源错位）。
    bodyEl.querySelectorAll(".preset-card").forEach((card) => {
      card.addEventListener("click", async () => {
        const name = card.dataset.preset;
        const result = await switchPreset(name);
        if (result) {
          showToast(`已切换到 "${name}"`, "success");
        } else {
          // T050·U04：应用失败 → selector 复位回后端真实生效的旧预设
          if (presetSelector) presetSelector.value = _lastStablePreset;
          showToast(`切换 "${name}" 失败`, "error");
        }
      });
    });
  }

  renderPresets("");
  searchInput?.addEventListener("input", () => renderPresets(searchInput.value));
  searchInput?.focus();
}

// W55: 顶栏预设名点击 → 打开悬浮窗
document.getElementById("header-current-preset")?.addEventListener("click", _openPresetOverlay);
// W55: 预设选择器双击 → 打开悬浮窗
presetSelector?.addEventListener("dblclick", (e) => { e.preventDefault(); _openPresetOverlay(); });
// 全局挂载以便调试
window._openPresetOverlay = _openPresetOverlay;

// [隔离架构 2026-07-24] 原 [F5 补链 2026-07-12] 三处跨源作废 bump 监听已删——它们防的是顶栏
//   using_preset 异步第二源(beilu-memory getSubModes)的旧响应晚到覆盖,第二源已收口到 GetData
//   active_preset_resolved 单源(applyPresetData 同步写),竞态面消亡,护栏随源删除。

// 外部预设切换时同步 chat 左栏选中值
window.addEventListener("beilu:presetSwitched", (e) => {
  if (presetSelector && e.detail?.name) presetSelector.value = e.detail.name;
  // T050·U04：切换成功（唯一成功出口）后更新稳定真源
  if (e.detail?.name) _lastStablePreset = e.detail.name;
});
// [0725 同步断点①修·分身E对照表] preset-changed 通道补接线——AI/后端切换(WS 命中本窗)原只有
//   presetSwitched(前端切换通道)有 selector 写者,通道不对称=左栏停旧值(layout.mjs:665/
//   subModePanel.mjs:1379 注释断言"左栏有同步订阅者"只对 presetSwitched 成立)。
//   同 smart.mjs 范式:重解析本窗生效值归位,值同=幂等。
window.addEventListener("beilu:preset-changed", async () => {
  try {
    const _n = await window._beiluResolveCurrentPreset?.();
    if (presetSelector && _n !== undefined) { presetSelector.value = _n; _lastStablePreset = presetSelector.value; }
  } catch { /* 解析失败保持现值,不拿旧值凑 */ }
});

// [0716 刷新机制] 预设名单变化（新建/删除/复制/重命名，本窗或跨窗 ws 广播）→ 重填左栏下拉；
//   弹窗开着时随后重开快照（钩子由弹窗自持，见 _openPresetOverlay；先 await 重填保证重开读到新名单）。
//   缓存已在 websocket 桥收到事件前失效（_beiluInvalidatePresetCache）。
window.addEventListener("beilu:presetListChanged", async () => {
  try { await loadPresetData(); } catch (e) { console.warn("[preset] 预设名单刷新失败:", e?.message || e); }
  window._beiluPresetOverlayReopen?.();
});

// [0717 预设三症·R3 窗口切换重解析] 切对话（hashchange=窗口坐标变化）后本窗生效预设变了，
//   但全链只有事件订阅者（presetSwitched/preset-changed/listChanged），hashchange 上零预设重解析
//   → 左栏选择器/顶栏停留前一窗口的值（凛倾 0717「两端不同步…a 会被变成硬编码之前的」显示端病根）。
//   重解析走 GetData 权威链（桥自动注入新 cid → 后端 active_preset_resolved 与生成读键同源），
//   applyPresetData 一次归位左栏 selector + 顶栏（0724 双源收口后顶栏=同响应 active_preset_resolved 同步写）。
//   时序守卫：await 期间用户又切窗 → 本次快照过时丢弃，由后一次 hashchange 负责（后发赢，防旧盖新）。
let _lastHashPresetCid = getChatId() || "";
window.addEventListener("hashchange", async () => {
  const _cidAtFire = getChatId();
  // 守卫①：非会话 hash（分段气泡锚点等 getChatId()=""）不触发——否则无 cid 请求拿回全局值盖掉本窗显示；
  // 守卫②：cid 未变（同窗锚点跳动）不重复拉取。
  if (!_cidAtFire || _cidAtFire === _lastHashPresetCid) return;
  _lastHashPresetCid = _cidAtFire;
  try {
    const data = await getPresetData();
    if (getChatId() !== _cidAtFire) return; // 已再切窗，丢弃过时快照（后发赢，防旧盖新）
    applyPresetData(data);
  } catch (e) { console.warn("[preset] 窗口切换预设重解析失败:", e?.message || e); }
});

// 预设选择器 — 切换「当前正在使用的预设」
//   生效模型（凛倾 2026-07-08）：切换=直接改「正在使用的预设」（switchPreset 写
//   active_preset_map[cid:mode]，mode 由后端权威解析），生成时无强切盖回=切了即生效。
//   [0716 凛倾定案] 「绑定」概念整体删除，本口只剩切换一义。
presetSelector?.addEventListener("change", async () => {
  const name = presetSelector.value;
  if (!name) return;
  const result = await switchPreset(name);
  if (result) {
    // 成功：稳定真源由 beilu:presetSwitched 广播监听器更新（switchPreset 内 dispatch）
    showToast(`已切换预设: "${name}"`, "success");
  } else {
    // T050·U04：切换失败 → selector.value 复位回后端真实生效的旧预设，显示与后端一致（禁靠刷新盖过去）
    presetSelector.value = _lastStablePreset;
    showToast("预设切换失败", "error");
  }
});

// 新建预设
presetCreateBtn?.addEventListener("click", async () => {
  const name = await beiluPrompt("请输入新预设名称:");
  if (!name?.trim()) return;
  try {
    await setPresetData({ create_preset: { name: name.trim() } });
    showToast(`预设 "${name.trim()}" 已创建`, "success");
    await loadPresetData();
  } catch (err) {
    showToast("创建失败: " + err.message, "error");
  }
});

// 删除预设
presetDeleteBtn?.addEventListener("click", async () => {
  const name = presetSelector?.value;
  if (!name) {
    showToast("没有选中的预设", "warning");
    return;
  }
  if (!await beiluConfirm(`确定删除预设 "${name}" 吗？此操作不可撤销。`)) return;
  try {
    await setPresetData({ delete_preset: { name } });
    // 清理该预设在 beilu-regex 中绑定的正则规则
    await removePresetRegexFromPlugin(name);
    showToast(`预设 "${name}" 已删除`, "success");
    await loadPresetData();
  } catch (err) {
    showToast("删除失败: " + err.message, "error");
  }
});

// 恢复内置默认预设
presetRestoreBtn?.addEventListener("click", async () => {
  const name = presetSelector?.value;
  if (!name || !_builtinPresets.has(name)) return;
  if (!await beiluConfirm(`恢复预设 "${name}" 到内置默认版本？\n你的修改将被覆盖。`)) return;
  try {
    await setPresetData({ restore_preset: { name } });
    showToast(`预设 "${name}" 已恢复默认`, "success");
    await loadPresetData();
  } catch (err) {
    showToast("恢复失败: " + err.message, "error");
  }
});

// 预设选择器切换时更新恢复按钮可见性
presetSelector?.addEventListener("change", () => {
  if (presetRestoreBtn) {
    presetRestoreBtn.classList.toggle("hidden", !_builtinPresets.has(presetSelector.value));
  }
});

// 导出（走后端 export_st_preset 单一权威序列化，enabled 从 prompt_order 权威回写进 prompts[]）
presetExportBtn?.addEventListener("click", async () => {
  try {
    const res = await setPresetData({ export_st_preset: {} });
    if (!res?.success || !res.st_json) {
      showToast("导出失败: " + (res?.error || "无 st_json"), "error");
      return;
    }
    const blob = new Blob([res.st_json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${res.name || "preset"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("预设已导出", "success");
  } catch (err) {
    showToast("导出失败: " + err.message, "error");
  }
});

// ============================================================
// 模型参数
// ============================================================

paramTemp?.addEventListener("input", () => {
  if (paramTempValue) paramTempValue.textContent = parseFloat(paramTemp.value).toFixed(2);
});
paramTopP?.addEventListener("input", () => {
  if (paramTopPValue) paramTopPValue.textContent = parseFloat(paramTopP.value).toFixed(2);
});
paramTopK?.addEventListener("input", () => {
  if (paramTopKValue) paramTopKValue.textContent = paramTopK.value;
});
paramMinP?.addEventListener("input", () => {
  if (paramMinPValue) paramMinPValue.textContent = parseFloat(paramMinP.value).toFixed(2);
});

// Claude Extended Thinking: 开关联动 budget 显隐
document
  .getElementById("param-claude-thinking")
  ?.addEventListener("change", (e) => {
    const budgetRow = document.getElementById("claude-thinking-budget-row");
    if (budgetRow) budgetRow.style.display = e.target.checked ? "" : "none";
  });
// budget slider 实时显示值
document
  .getElementById("param-thinking-budget")
  ?.addEventListener("input", (e) => {
    const valEl = document.getElementById("param-thinking-budget-value");
    if (valEl) valEl.textContent = e.target.value;
  });

window.syncModelParamsUI = syncModelParamsUI;
function syncModelParamsUI(params) {
  if (!params) return;
  if (params.temperature != null) {
    if (paramTemp) paramTemp.value = params.temperature;
    if (paramTempValue) paramTempValue.textContent = parseFloat(params.temperature).toFixed(2);
  }
  if (params.top_p != null) {
    if (paramTopP) paramTopP.value = params.top_p;
    if (paramTopPValue) paramTopPValue.textContent = parseFloat(params.top_p).toFixed(2);
  }
  if (params.top_k != null) {
    if (paramTopK) paramTopK.value = params.top_k;
    if (paramTopKValue) paramTopKValue.textContent = params.top_k;
  }
  if (params.min_p != null) {
    if (paramMinP) paramMinP.value = params.min_p;
    if (paramMinPValue) paramMinPValue.textContent = parseFloat(params.min_p).toFixed(2);
  }
  if (params.max_context != null && paramMaxContext) paramMaxContext.value = params.max_context;
  if (params.max_tokens != null && paramMaxTokens) paramMaxTokens.value = params.max_tokens;
  // T11-A penalty 回显（model_params 层）：非空即显（含 0）；仅 null/undefined 留空（预设无此键）。
  if (params.frequency_penalty != null && paramFrequencyPenalty) paramFrequencyPenalty.value = params.frequency_penalty;
  if (params.presence_penalty != null && paramPresencePenalty) paramPresencePenalty.value = params.presence_penalty;
  // 同步 Claude Extended Thinking 回显
  const thinkingToggle = document.getElementById("param-claude-thinking");
  const thinkingBudgetSlider = document.getElementById("param-thinking-budget");
  const thinkingBudgetValue = document.getElementById(
    "param-thinking-budget-value",
  );
  const thinkingBudgetRow = document.getElementById(
    "claude-thinking-budget-row",
  );
  if (thinkingToggle && params.extended_thinking != null) {
    thinkingToggle.checked = !!params.extended_thinking;
    if (thinkingBudgetRow)
      thinkingBudgetRow.style.display = params.extended_thinking ? "" : "none";
  }
  if (thinkingBudgetSlider && params.thinking_budget != null) {
    thinkingBudgetSlider.value = params.thinking_budget;
    if (thinkingBudgetValue)
      thinkingBudgetValue.textContent = params.thinking_budget;
  }
  // 同步 Claude 专属 UI（top_p 提示 + 预填充下拉显隐）
  updateClaudeUI();
}

/**
 * 根据当前 API 类型显示/隐藏 Claude 专属 UI 元素
 * - Claude top_p 互斥提示
 * - 尾部预填充模式下拉（全渠道通用）
 * - Claude Extended Thinking 开关
 */
function updateClaudeUI() {
  const apiType = getCurrentApiType();
  // openrouter-claude 同为 Claude 系（后端 patchBodyForClaude 门控 provider===claude||openrouter-claude）
  const isClaude = apiType === "claude" || apiType === "openrouter-claude";

  // top_p 互斥提示
  const hint = document.getElementById("claude-top-p-hint");
  if (hint) hint.style.display = isClaude ? "" : "none";

  // 尾部预填充四模式下拉：常驻可见（2026-07-08 凛倾「为什么不做前端」——原按 apiType
  // 判定隐藏，模型别名/自定义中转判不中=用户永远看不到；生效范围由后端
  // patchBodyForClaude 的 isClaude 把关，前端不再隐藏）
  const claudePrefillGroup = document.getElementById("claude-prefill-group");
  if (claudePrefillGroup) claudePrefillGroup.style.display = "";

  // Extended Thinking 开关：常驻可见（与预填充同铁律——0708 凛倾「不按名字猜渠道」；
  //   后端 httpFetch:162 extended_thinking/thinking_budget 已无条件提取，不门控渠道名；
  //   前端按 isClaude 藏=网关/自定义源用户永远看不到。生效范围由后端把关，前端不隐藏）。
  const thinkingGroup = document.getElementById("claude-thinking-group");
  if (thinkingGroup) thinkingGroup.style.display = "";
}

// 监听 api-type 变更以更新 Claude UI
document.getElementById("api-type")?.addEventListener("change", updateClaudeUI);

async function loadModelParams() {
  try {
    const data = await getPresetData();
    if (data.model_params) syncModelParamsUI(data.model_params);
  } catch (err) {
    console.error("[beilu-chat] 加载模型参数失败:", err);
  }
}

modelParamsSave?.addEventListener("click", async () => {
  const params = {
    temperature: parseFloat(paramTemp?.value ?? 0),
    top_p: parseFloat(paramTopP?.value ?? 0),
    top_k: parseInt(paramTopK?.value ?? 0, 10),
    min_p: parseFloat(paramMinP?.value ?? 0),
    max_context: parseInt(paramMaxContext?.value ?? 0, 10),
    max_tokens: parseInt(paramMaxTokens?.value ?? 0, 10),
  };

  // T11-A penalty 收集（model_params 预设层）：本层语义=预设基线实际惩罚值，0=无惩罚（与
  //   PARAM_SCHEMA default 一致，extractModelParams:768 `?? 0` 兜底）。空值落 0 而非 null——
  //   null 落盘后 extractModelParams 会 `null ?? 0`=0，留空反成 0 造成回显漂移；且 requestBuilder:513
  //   透传，null 会误发 null 到 API。runtime_params 层的 null 哨兵（不覆盖）是另一条独立链
  //   （featureControls/subModePanel → setRuntimeParams），本收集不涉及。范围 -2~2 由 input 约束。
  const _fp = paramFrequencyPenalty?.value?.trim();
  const _fpNum = _fp ? parseFloat(_fp) : 0;
  params.frequency_penalty = Number.isNaN(_fpNum) ? 0 : _fpNum;
  const _pp = paramPresencePenalty?.value?.trim();
  const _ppNum = _pp ? parseFloat(_pp) : 0;
  params.presence_penalty = Number.isNaN(_ppNum) ? 0 : _ppNum;

  // 收集 Claude Extended Thinking 参数
  const thinkingToggle = document.getElementById("param-claude-thinking");
  const thinkingBudgetSlider = document.getElementById("param-thinking-budget");
  if (thinkingToggle) {
    params.extended_thinking = thinkingToggle.checked;
    params.thinking_budget = thinkingBudgetSlider
      ? parseInt(thinkingBudgetSlider.value, 10)
      : 8000;
  }

  // （2026-07-09 删"后端会自动删除 top_p"提示——静默参数改写 2026-07-08 已从
  //   patchBodyForClaude 删除，冲突时 API 报错直达前端，UI 不再宣称不存在的自动处理；
  //   互斥事实提示由 #claude-top-p-hint 承担）

  try {
    await setPresetData({ update_model_params: params });
    // 保存即刷新 token 条：分母(_effective_max_context)权威在后端，改 max_context 后立即拉新，
    // 不等 5s 轮询（tokenProgressBar.mjs 挂的 window 全局，避免 import 环）
    window.refreshTokenProgress?.();
    const successMsg = "✅ 参数已保存";
    if (modelParamsStatus) {
      modelParamsStatus.textContent = successMsg;
      modelParamsStatus.className = "text-xs text-center mt-1 text-success";
      modelParamsStatus.classList.remove("hidden");
      setTimeout(() => modelParamsStatus.classList.add("hidden"), 3000);
    }
  } catch (err) {
    if (modelParamsStatus) {
      modelParamsStatus.textContent = "❌ 保存失败: " + err.message;
      modelParamsStatus.className = "text-xs text-center mt-1 text-error";
      modelParamsStatus.classList.remove("hidden");
    }
  }
});

export { getPresetData, fetchModels, applyPresetData, loadPresetData };
