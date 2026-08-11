/**
 * [sharedState.mjs] — 前端跨模块共享状态的单一权威源。不管消息数据（那是 virtualQueue 的事），
 *   不管聊天初始化流程（那是 chat.mjs 的事），不管后端状态持久化（那是后端 chatStorage 的事）。
 *
 * 功能链：
 *   状态写入：chat.mjs / index.mjs → set*(value) → 内部变量更新 + DOM 同步（单向，DOM 只展示）
 *   状态读取：各 UI 模块 → get*() → 返回内存变量（不读 DOM，DOM 不再是数据源）
 *   缓存 fetch：各 UI 模块 → getCachedPresetData/getCachedApiSources/getCachedModelList()
 *             → TTL 内返回缓存 / 超时则 sendAction 门面出向（T6b批9 收口）→ 更新缓存 → 返回数据
 *   预设切换：UI → switchPreset(name) → POST 后端 → 清缓存 → 更新 DOM + dispatch beilu:presetSwitched
 *   chatId 解析：任意模块 → getChatId() → 解析 window.location.hash → 返回 chatId（per-chat 隔离依赖此）
 *   全局桥接：window._beilu* → 供非 ESM 模块（如 SillyTavern 兼容层、旧脚本）调用
 *
 * why：前端多个模块都需要知道"当前角色/预设/模型是什么"，历史上各模块各自读 DOM 或各自 fetch，
 *   导致状态不一致（DOM 改了但内存没同步 / 多处并发 fetch 同一接口）。本模块将这四个核心状态
 *   收口为唯一内存变量，setter 驱动 DOM 更新（而非 DOM 驱动状态），缓存层消除重复 fetch。
 *   getChatId() 从 hash 读（而非 localStorage）是因为同一浏览器可开多窗口对话，
 *   hash 天然 per-window 隔离，用 localStorage 会多窗口互相覆盖。
 *
 * 关联链：
 *   import → shared/transport/sendAction.mjs（出向门面）/ storage.mjs（storage/KEYS）
 *   被 import → chat.mjs / index.mjs / featureControls.mjs / apiConfig.mjs / presetPanel 等几乎所有前端模块
 *   window._beilu* → 非 ESM 模块桥接（SillyTavern 兼容层 / 旧内联脚本）
 *
 * 影响范围：
 *   - 改动 setModel() → 影响页面顶部模型输入框和下拉选择器的同步显示
 *   - 改动 setPresetName() → 影响页面 #preset-name 文本（#header-current-preset 已归 layout.mjs 顶部订阅站，经 beilu:presetSwitched 事件更新）
 *   - 改动 setCharId() → 影响 #char-name-display dataset，角色头像/功能卡依赖此读 charId
 *   - 改动 getChatId() 解析逻辑 → 影响所有 per-chatId 预设/子模式隔离（全局性影响）
 *   - 改动 switchPreset() → 影响所有预设切换入口的行为（POST 失败/事件不发均会导致 UI 不同步）
 *   - 改动缓存 TTL → 影响 UI 看到的预设/AI源/模型列表的新鲜度
 *
 * 使用效果：
 *   - 用户切换角色卡时：chat.mjs 调 setCharId/setCharName → DOM 实时更新角色名 → 其他 UI 读 getCharId() 获最新值
 *   - 用户切换预设时：switchPreset() → 后端持久化 → 前端 DOM 立即同步预设名 → beilu:presetSwitched 事件广播
 *   - 打开模型选择器时：getCachedModelList(sourceName) → 10s 内复用缓存，不重复请求后端
 *   - 用户开多窗口对话时：每个窗口的 getChatId() 从各自 hash 读，互相独立不干扰
 */

import { sendAction } from "../transport/sendAction.mjs"; // T6b批9：出向统一门面（verb=真动作）
import { storage, KEYS } from "./storage.mjs"; // R2: localStorage 集中（行为镜像+集中key）
import { modelsRequestFor } from "/scripts/modelListRequest.mjs"; // 无浏览器依赖的模型端点/响应形状单一契约

let _charId = "";
let _charName = "";
let _presetName = "";
let _model = "";

// ============================================================
// charId
// ============================================================

export function getCharId() { return _charId; }

export function setCharId(id) {
  _charId = id || "";
  const el = document.getElementById("char-name-display");
  if (el) el.dataset.charId = _charId;
}

// ============================================================
// charName（独立于 charList[0]，由角色卡选择时 set）
// ============================================================

export function getCharName() { return _charName; }

export function setCharName(name) {
  _charName = name || "";
}

/**
 * 「当前角色」身份提交单源（运行时 _charName + 持久键 BEILU_LAST_CHAR 一次写齐）。
 * 【why · R6 身份收口 0713】原两源各自散写且只有 charsel 选卡三条路径写——init/切对话/刷新
 *   永不补写，BEILU_LAST_CHAR 一空则所有按它取 char 的消费链（模式指针本地键/删除清键/
 *   切模式预读/搜索过滤）整体跑在死键上，而显示链（charList[0]）照常有角色=两界分叉。
 *   收口后：写身份=调本函数，别处禁再直写 storage BEILU_LAST_CHAR。
 * @param {string} name - 角色目录名（part 名，与 primaryCharName 同域）；空=清除身份
 */
export function commitCurrentChar(name) {
  const _n = String(name ?? "").trim();
  setCharName(_n);
  try {
    if (_n) storage.set(KEYS.BEILU_LAST_CHAR, _n);
    else storage.remove(KEYS.BEILU_LAST_CHAR);
  } catch { /* localStorage 不可用时运行时态仍生效 */ }
}

// ============================================================
// presetName
// ============================================================

export function getPresetName() { return _presetName; }

export function setPresetName(name) {
  _presetName = name || "";
  const el = document.getElementById("preset-name");
  if (el) el.textContent = _presetName;
}

// ============================================================
// model
// ============================================================

export function getModel() { return _model; }

export function setModel(name) {
  _model = name || "";
  const input = document.getElementById("api-model");
  if (input && input.value !== _model) {
    input.value = _model;
    input.dispatchEvent(new Event("change"));
  }
  const select = document.getElementById("api-model-select");
  if (select && select.value !== _model) {
    select.value = _model;
  }
}

// ============================================================
// username —— ⚠ 非 authority 显示读点（D6 §1 2026-08-04 降级定性）。
// [合并批 0714] 原 cardsPanel/taskCard/taskItemPanel/pipelinePanel 四处 _getUsername 手抄副本
//   + index.mjs/memoryBrowser 两处内联同构读法（meta → window._beiluUsername → ""），收口本处。
// [D6 §1] 全树无 meta[name="beilu-username"] / window._beiluUsername 生产者（假契约，E 现场
//   _default 冲突实证）——本函数恒返 "" 属正常。它只可用于本地显示/去重键，
//   【禁止】进入任何请求 payload 当身份字段（后端身份唯一权威=认证会话 scope.user，
//   桥 yonban_bridge 强制②盖章）。需要认证用户名的前端逻辑走
//   shared/state/sessionIdentity.mjs（/api/whoami 服务端权威 + epoch 代际）。
// ============================================================

export function getUsername() {
  const meta = document.querySelector('meta[name="beilu-username"]');
  if (meta) return meta.content;
  return window._beiluUsername || "";
}

// ============================================================
// chatId（per-chatId 预设/子模式隔离的单一权威来源：hash 即当前窗口对话）
// ============================================================

const _CHATID_RE = /^[a-z0-9]{7,15}$/;
export function isValidChatId(id) { return typeof id === "string" && _CHATID_RE.test(id); }

export function getChatId() {
  try {
    const h = window.location.hash.replace(/^#/, "");
    return isValidChatId(h) ? h : "";
  } catch { return ""; }
}

/** 按当前窗口解析 preset GetData 里的激活预设。
 *  2026-07-09 收口审计：优先读后端权威解析 active_preset_resolved（GetData 带 chatid 时下发，
 *  精确键[cid:mode]>裸键 与生成链 resolveActivePresetName 同源）——原只读裸键，同 cid 跨模式
 *  （code/work 共 chatId）时读到别模式最后切的预设。裸键回退仅服务无 resolved 字段的旧数据。 */
export function resolveActivePresetFor(data) {
  if (!data) return "";
  // [0725 凛倾「没有全局」+解析单源] resolved 字段存在即唯一真值——空串=本窗该模式无在用预设,
  //   原样返回,禁回落镜像解析(原"非空才认"让 none 漏进裸键镜像+active_preset 残值链)。
  //   原裸键 map 镜像 + data.active_preset 回退 = 前端第三份解析实现(散写),整体删除:
  //   后端 resolveActivePresetWithSource 是唯一解析点(线级→code/work 子模式→none),
  //   active_preset 已恒空下发。字段缺失(无 cid 旧调用面)诚实返 ""。
  if (typeof data.active_preset_resolved === "string") return data.active_preset_resolved;
  return "";
}

// 暴露给非 ESM 模块
window._beiluSetModel = setModel;
window._beiluGetModel = getModel;
window._beiluGetCharName = getCharName;
// [R6 身份收口 0713] 桥指向提交单源：charsel/删角色等桥调用方写身份即持久（原 setCharName 只写
//   运行时态，持久键靠调用方各自 storage.set 散写）。
window._beiluSetCharName = commitCurrentChar;
window._beiluGetChatId = getChatId;
// [R6 身份收口 0713] 角色真变事件的持久化消费点：生产者（chat.mjs switchCharacterScope 角色真变
//   判据 / charinfo loadCharInfo init 路径）在系统确认「当前角色是 X」的时刻派发，身份持有者在此
//   跟随提交 → 持久键随运行时真相自愈，任何未来生产者自动闭环，消费链不再读死键。
//   只认 detail.charId（两生产者均为角色目录名）；charName 在 charinfo 路径是显示名（info.name），
//   与 part 目录名不同域，禁用于持久身份。
window.addEventListener("beilu:char-changed", (e) => {
  const _cid = e?.detail?.charId || "";
  if (_cid) commitCurrentChar(_cid);
});
// [预设隔离 2026-07-11] 供 sendAction 桥注入 getData charName（禁反向 import 成环，同 _beiluGetChatId 范式）：
//   线级 active_modes_map 存 per-char _config.json，GetData 解析 active_preset_resolved 需同桶 charName
window._beiluGetCharId = getCharId;
window._beiluResolveActivePreset = resolveActivePresetFor;
window._beiluResolveCurrentPreset = resolveCurrentPresetName; // [0715 串扰点2] 本窗生效预设名单源（preset-changed 消费方经桥调）

// ============================================================
// 缓存层：preset getdata / API 源列表（带 TTL，避免多处独立 fetch）
// ============================================================

// [0715 串扰点2] per-cid 缓存（原单槽 _presetDataCache/_presetDataTime：带 cid 请求后单槽会跨对话串值）
const _presetDataCacheByCid = new Map(); // Map<cid|"", {data, time}>
const PRESET_CACHE_TTL = 5000;

/**
 * 获取预设 getdata（带 5s TTL 缓存，避免多处独立 fetch）。
 *
 * 链路：各 UI 模块 → 本函数 → sendAction(beilu-preset#getData) → 后端 beilu-preset
 * 影响：缓存到模块级 _presetDataCache（invalidatePresetCache() 可清）
 *
 * @returns {Promise<object|null>} 预设配置数据（含 preset_list / active_preset / active_preset_map 等）
 */
export async function getCachedPresetData() {
  // [0715 串扰点2] 缓存按 cid 分键：chatid 由 sendAction 桥层统一注入（sendAction.mjs:243 收口，
  //   前端禁散拼），后端 GetData 据此下发 active_preset_resolved（per-cid 值）——原单槽缓存会把
  //   A 对话的 resolved 在 5s TTL 内串给切换后的 B 对话。
  const _cid = getChatId() || "";
  const _hit = _presetDataCacheByCid.get(_cid);
  if (_hit && Date.now() - _hit.time < PRESET_CACHE_TTL) return _hit.data;
  // [0725 时序竞态修·凛倾「a切到b,a还是原来的,切到c又行了」] 代数守卫：请求发起时记当前代数,
  //   响应回来若已被 invalidate 换代(切换/WS广播先行失效)→ 结果只还给本次调用者,【无权写缓存】——
  //   原病:切换前发起的慢请求晚返回,把旧值快照连同新鲜时间戳写回缓存,之后 5s 内全部显示口
  //   (四格/顶栏/左栏重解析)命中还魂旧值;再切一次才被新请求顶掉(="又行了")。
  const _gen = _presetCacheGen;
  try {
    // T6b批9：原 raw GET+手检 res.ok → 门面（!ok 抛错并入 catch，旧缓存兜底语义不变）
    const data = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
    if (_gen === _presetCacheGen) _presetDataCacheByCid.set(_cid, { data, time: Date.now() });
    return data;
  } catch (e) { console.warn("[sharedState] preset getdata 失败:", e.message); }
  return _hit?.data ?? null;
}

let _presetCacheGen = 0; // [0725] 失效代数——invalidate 即换代,在飞旧请求丧失缓存写权

export function invalidatePresetCache() {
  _presetCacheGen++;
  _presetDataCacheByCid.clear();
}

/**
 * 解析【本窗口】当前生效预设名（0715 串扰点2 单源）。
 * 【why】beilu:preset-changed 是"权威预设已变"的通知，payload.preset 是【触发方】的值
 *   （global 切换=全局名）——本窗有 per-chat 覆盖时拿它直刷 DOM = 前端显示与后端生成用的预设分叉。
 *   消费方收到通知后应调本函数重解析本窗生效值再显示（getCachedPresetData 缓存已被广播
 *   _beiluInvalidatePresetCache 先行失效，此处拉到的即新值）。
 * @returns {Promise<string>} 本窗生效预设名；后端不可达时 ""
 */
export async function resolveCurrentPresetName() {
  return resolveActivePresetFor(await getCachedPresetData());
}

let _apiSourcesCache = null;
let _apiSourcesTime = 0;
const API_CACHE_TTL = 10000;

/**
 * 获取 AI 服务源名称列表（带 10s TTL 缓存）。
 *
 * 链路：apiConfig.mjs / 模型选择器 → 本函数 → sendAction(serviceSourceManage#getAISources) → 后端
 * 影响：缓存到模块级 _apiSourcesCache（invalidateApiSourcesCache() 可清）
 *
 * @returns {Promise<string[]>} AI 源名称数组
 */
export async function getCachedApiSources() {
  if (_apiSourcesCache && Date.now() - _apiSourcesTime < API_CACHE_TTL) return _apiSourcesCache;
  try {
    // T6b批9：原 raw GET+手检 → 门面（复用批3 getAISources 路由；!ok 抛错并入 catch，旧缓存兜底不变）
    const list = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
    _apiSourcesCache = Array.isArray(list) ? list.map(s => typeof s === "string" ? s : s.name || s.id || String(s)) : [];
    _apiSourcesTime = Date.now();
    return _apiSourcesCache;
  } catch (e) { console.warn("[sharedState] API源列表 失败:", e.message); }
  return _apiSourcesCache || [];
}

export function invalidateApiSourcesCache() {
  _apiSourcesCache = null;
  _apiSourcesTime = 0;
}

// ============================================================
// 模型列表缓存（per sourceName，统一 10 条独立获取路径）
// ============================================================

const _modelListCache = new Map();
const MODEL_CACHE_TTL = 30000;

/**
 * 获取指定 AI 源的模型列表（带 30s TTL、per-sourceName 独立缓存）。
 * 统一 10 条独立获取路径为一个缓存口。
 *
 * 链路：模型选择器 / apiConfig → 本函数 → sendAction(beilu-memory#getModels 通配) → 后端代理 AI 源查模型
 * 影响：缓存到模块级 _modelListCache Map（invalidateModelCache() 可清）
 *
 * @param {string} sourceName - AI 源名称
 * @param {{force?: boolean}} [opts] - force=true 跳过 TTL 读（仍写缓存供失败兜底）。
 *   [0717 凛倾原话「拉条是每次都需要访问,而不是访问一次就缓存,是每次点击都需要访问」]——
 *   用户点击打开的下拉一律传 force 实时访问源；TTL 只服务非点击驱动的后台读。
 * @returns {Promise<string[]>} 模型名称数组（去重+排序）
 */
export async function getCachedModelList(sourceName, opts) {
  if (!sourceName) return [];
  const cached = _modelListCache.get(sourceName);
  if (!(opts && opts.force) && cached && Date.now() - cached.time < MODEL_CACHE_TTL) return cached.models;
  try {
    // T6b批9：原 raw POST(_action:getModels)+手检 → memory 通配路由（verb=真动作组装 _action）
    const data = await sendAction({ verb: "getModels", target: "plugins:beilu-memory", source: "web", payload: { sourceName } });
    if (data?.success && Array.isArray(data.models)) {
      const models = [...new Set(data.models)].sort();
      _modelListCache.set(sourceName, { models, time: Date.now() });
      return models;
    }
    // 0714 吞错修：后端 T008 特意结构化了失败原因（源名+原因），原 success:false 走静默 []=
    //   诊断链断在最后一格（「子模式不自动请求模型」案：URL 格式无效被吞，用户只见空下拉）。
    if (data && data.success === false) {
      console.warn("[sharedState] 模型列表获取失败:", data.error || "(后端未给原因)");
      window._reportError?.(`[sharedState] getModels(${sourceName}): ${data.error || "unknown"}`);
    }
  } catch (e) { console.warn("[sharedState] 模型列表获取失败:", e.message); }
  // 0716 链路统一（凛倾「work不成功但是ide成功,链路不对」案）：proxy 腿失败 → 浏览器直连兜底。
  //   病灶=双链分叉：API设置面板（settingsSlots:1410-1424）一直有 proxy→direct 双保险，
  //   本收口（子模式等 10 条路径）只有 proxy 单腿——后端 Deno 出网被本机安全软件拦
  //   （errors 日志实证 tls handshake eof / 8s 超时，userId/URL 均正确）时 work 链必死、IDE 链必活。
  //   直连从浏览器网络栈发（不被拦），url/key 经既有 getAISource 读路（本人源，apiConfig 面板同链先例）；
  //   raw fetch 不走 apiFetch（R1-SKIP 同由：外部端点自管 Authorization，401→/login 对外站有害）。
  try {
    // Quiet 档（sendAction:884 凛倾拍板分级）：后台兜底读失败不弹 toast，进报错系统可见
    const src = await sendAction({ verb: "getAISourceQuiet", target: "shells:serviceSourceManage", source: "web", payload: { name: sourceName } });
    const cfg = src?.config || {};
    const rawUrl = (cfg.url || cfg.base_url || cfg.host || "").trim();
    const key = (cfg.apikey || cfg.key || "").trim();
    const request = rawUrl ? modelsRequestFor({
      generator: src?.generator,
      provider: cfg.convert_config?.provider || "",
    }, rawUrl) : null;
    const modelsUrl = request?.url;
    if (modelsUrl) {
      const res = await fetch(modelsUrl, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      if (res.ok) {
        const d = await res.json();
        const models = [...new Set(request.normalize(d))].sort();
        if (models.length) {
          _modelListCache.set(sourceName, { models, time: Date.now() });
          return models;
        }
      }
    }
  } catch (e) { console.warn("[sharedState] 模型列表直连兜底失败:", e.message); }
  return cached ? cached.models : [];
}

export function invalidateModelCache(sourceName) {
  if (sourceName) _modelListCache.delete(sourceName);
  else _modelListCache.clear();
}

// ============================================================
// 统一预设切换（所有入口收口到此函数）
// ============================================================

/**
 * 统一预设切换入口。POST switch_preset → 刷新缓存 → 更新 DOM → dispatch 事件通知全局同步。
 * @param {string} name - 预设名
 * @param {object} [opts] - 可选参数
 * @param {string} [opts.chatid] - 对话ID（per-chat 隔离）
 * @returns {Promise<object|null>} 后端响应（含 model_params 等），失败返回 null
 */
export async function switchPreset(name, opts = {}) {
  const chatid = opts.chatid || getChatId() || undefined;
  // [隔离架构 2026-07-24 容错] 无窗口坐标=可见拒绝，不再静默滑向后端全局分支——本函数语义=
  //   线级切换（UI 会话内入口专用）；无 hash 场景下滑全局 = 一次点击污染所有无线级记录的窗口/模式
  //   （跨窗口耦合源）。全局默认的显式切换走各自明示无坐标的调用面（bot 面板无线分支等）。
  if (!chatid) {
    console.warn(`[sharedState] switchPreset("${name}") 拒绝：无会话窗口坐标（线级切换需 chatid）`);
    window._beiluToast?.("当前无会话窗口，无法切换预设", "error");
    return null;
  }
  // [0725 凛倾「如果遇到真实使用,也就是ai正在输出的情况就需要给提醒」] 本窗口有在途流式输出时
  //   切换先弹确认——切换即写线级记录,影响本轮之后的生成读点;所有切换入口收口本函数=一处生效。
  if (window._beiluHasActiveStream?.()) {
    let _ok = false;
    try {
      const { beiluConfirm } = await import("../widgets/beiluDialog.mjs");
      _ok = await beiluConfirm(`AI 正在输出中——现在切换到「${name}」会影响接下来的生成。确认切换？`);
    } catch {
      // 对话框不可用=降级 toast 提醒后放行(提醒义务已尽,不阻断)
      window._beiluToast?.("提示：AI 正在输出中，切换预设将影响后续生成", "warning");
      _ok = true;
    }
    if (!_ok) return null;
  }
  // R1 模式单源化（2026-07-08 断链审计病根一，替代 T059 前端推算）：mode 不再从 localStorage
  //   BEILU_ACTIVE_MODE 推——它与后端 active_mode 是两个独立源（实证：前端=chat 后端=code，
  //   写 [cid:chat] 生成读 [cid:code] 永 miss）。改为：显式 opts.mode 仍优先（调用方已知模式，
  //   如浮层绑定别模式的会话）；缺省不传，由后端 switch_preset 用 getActiveMode（与生成读键
  //   getPromptHandler:220 同一解析函数）自解析——写键=读键单源。charName 供后端命中 per-char/
  //   per-cid 权威桶（active_modes_map 存 per-char _config.json）。
  const mode = opts.mode || undefined;
  const charName = getCharId() || undefined;
  try {
    // T6b批9：原 raw POST 字段写+手检 !ok→null → updatePresetConfig raw verb（preset 后端按字段分派不吃 _action）；
    // 门面 !ok 抛错并入 catch→return null，语义等价
    const result = await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { switch_preset: { name, chatid, ...(mode ? { mode } : {}), ...(charName ? { charName } : {}) } } });
    invalidatePresetCache();
    setPresetName(name);
    // [20260706 顶部订阅站] 原此处直改 #header-current-preset 已移除——顶部显示统一由
    //   layout.mjs 订阅站监听 beilu:presetSwitched 更新（单写者，杜绝"口负责制"漏更新族病）。
    // [多窗口审计 2026-07-11 A4] detail 补 mode（有则带）：原 mode 只进后端 payload 没进事件 detail，
    //   6 个 consumer 想按模式过滤也没字段。缺省(后端自解析)时无值，consumer 按"无坐标=本窗口动作"处理。
    window.dispatchEvent(new CustomEvent("beilu:presetSwitched", { detail: { name, chatid, ...(mode ? { mode } : {}) } }));
    return result;
  } catch (e) {
    console.error("[sharedState] switchPreset 失败:", e.message);
    return null;
  }
}

// 暴露给非 ESM 模块
window._beiluGetPresetData = getCachedPresetData;
window._beiluInvalidatePresetCache = invalidatePresetCache;
window._beiluGetApiSources = getCachedApiSources;
window._beiluInvalidateApiSources = invalidateApiSourcesCache; // [0716 W3] ws 桥 aisource_changed 失效用
window._beiluGetModelList = getCachedModelList;
window._beiluInvalidateModelCache = invalidateModelCache;
window._beiluSwitchPreset = switchPreset;

// ============================================================
// 初始化：从现有 DOM 读取当前值（页面已渲染后调用）
// ============================================================

/**
 * 从现有 DOM + localStorage 读取初始值（页面已渲染后由 index.mjs init() 调用一次）。
 * 之后 DOM 只用于显示，不再作为数据源——状态变更统一走 set*() setter。
 */
export function initSharedState() {
  const charEl = document.getElementById("char-name-display");
  if (charEl?.dataset?.charId) _charId = charEl.dataset.charId;

  const savedCharName = storage.get(KEYS.BEILU_LAST_CHAR);
  if (savedCharName) _charName = savedCharName;

  const presetEl = document.getElementById("preset-name");
  if (presetEl?.textContent) _presetName = presetEl.textContent.trim();

  const modelEl = document.getElementById("api-model");
  if (modelEl?.value) _model = modelEl.value;
}
