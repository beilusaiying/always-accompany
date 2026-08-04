/**
 * live2dRenderer.mjs — Live2D 桌宠渲染核心（网页端 / 桌面壳双用）
 *
 * 功能链：
 *   initLive2dRenderer() → fetch model_dict.json → _mergeUserModels（合并用户自定义模型字典）
 *     → PIXI.Application → Live2DModel.from(modelCfg.url) → _setupLoadedModel
 *     → bindEvents（注册 window 事件监听）→ startIdleFace（启动待机自然运动）
 *   WS emotion_changed（后端 AI 情感识别结果）→ websocket.mjs 派发 beilu:emotion-changed
 *     → setEmotion(expr, motion) → _applyActiveExpr（ticker 直贴 exp3 参数）+ startMotion
 *   WS companion_message / beilu:ai-reply-done（AI 开始说话）→ talkPulse() → 口型脉冲动画
 *   beilu:voice-audio-start（iframeRenderer 音频桥）→ talkWithAudio() → Web Audio API AudioContext
 *     → ScriptProcessorNode → 实时 RMS 分析 → 驱动真实口型幅度（audioVal）
 *   统一 ticker（model.autoUpdate=false）→ 每帧：
 *     internalModel.update(dt) → _applyActiveExpr（表情）→ _applyMouth（口型）
 *     → _applyFaceDir（视线）→ _applyBodyTilt（身体倾斜）→ _applyBreath（呼吸）
 *   window.beiluLive2d 全局 API → 桌面壳 / 外部代码统一驱动入口（setModel/setEmotion/talk 等）
 *
 * why（统一更新管线 / 表情直接贴参）：
 *   旧 talkPulse 用 setInterval 直接 setParam，被 SDK Idle 动作覆盖导致口型失效；
 *   统一 ticker 保证"先 internalModel.update 后写自己参数"，自己参数绝不被覆盖。
 *   SDK expressionManager 置 null，改由 _applyActiveExpr 按 exp3 Blend 语义直贴参数
 *   （克隆 airi expression-controller 方案），消灭 SDK 表情层与自定义表情的冲突。
 *   临界阻尼弹簧 + 相干噪声 + 帧率无关 dt 积分 → 自然运动不过冲/不跳变/帧率无关。
 *
 * 关联链：
 *   ← websocket.mjs（emotion_changed 事件派发，本模块消费 beilu:emotion-changed）
 *   ← iframeRenderer.mjs（voice-audio-start/end 音频桥，本模块消费）
 *   ← 桌面壳（注入 __BEILU_PET_MODEL / __BEILU_CHAR_MODELS / __BEILU_USER_MODELS / __BEILU_USER_DICT_URL）
 *   → vendor/cubism4.min.js（pixi-live2d-display：Live2DModel / MotionManager / expressionManager）
 *   → /api/eye/usermodel-dict（http 同源默认用户自定义模型字典端点，file:// 不请求）
 *   ← index.mjs（companion 首次激活后 dynamic import 并调用 initLive2dRenderer）
 *
 * 影响范围：
 *   #live2d-host 容器（PIXI Canvas 挂载点）；ResizeObserver（自适应容器大小）；
 *   window 事件监听器（beilu:emotion-changed / beilu:voice-audio-start/end / beilu:ai-reply-done）；
 *   window.beiluLive2d 全局 API 暴露（setModel/setEmotion/talk/stopTalk/reloadDict）。
 *
 * 使用效果：
 *   AI 回复带情感标记 → 模型自动切换表情和动作；AI 说话/TTS 播放 → 口型同步；
 *   桌面壳可通过 window.beiluLive2d API 程序化控制模型；关键初始化失败向调用方抛出。
 */
// 图片模式后端(2026-07-09 任务②):dict 条目 format==="image" 时代替 PIXI 渲染,本模块只做路由。
import * as imagePack from "./imagePackRenderer.mjs";
// 加载模型挂 #live2d-host(网页端=companion tab 桌宠预览位;桌面端=Electron 桌宠窗),订阅 WS 事件驱动表情/口型。
let app = null, model = null, modelCfg = null, mouthTimer = null, hostEl = null;
let _ensureVendorRuntime = null; // web 壳注入的唯一 vendor loader；图片形象全程不调用
let _unitDims = null; // 模型单位体型(relayout 回填;热区坐标系锚点=_hitFrame 用它推形象基准框)
let dict = []; // model_dict(模块级,供模型切换 reloadModel 用)
let _talking = false; // 说话中(talkPulse/talkWithAudio 期间)→ 待机微张嘴让位真实口型
// 口型统一状态:mode=idle待机/talk脉冲/audio音频RMS。所有口型在 ticker(model.update 后)按 mode 统一驱动,不再各处直接 setParam。
const _mouth = { mode: "idle", pulse: 0, lastPulse: 0, talkEnd: 0, audioVal: 0 };
const DICT_URL = "vendor/live2d-models/model_dict.json";

// 用户模型/配置 overlay 合并(自定义最多;不改 bundled model_dict)。两路来源【都】合并(不是二选一):
//   ① window.__BEILU_USER_MODELS(数组,桌面壳扫描 user-models 目录后注入)
//   ② window.__BEILU_USER_DICT_URL(调试工具"保存到用户配置"写的字典 /api/eye/usermodel-dict;
//      http(s) 同源页面未显式指定时默认指向该端点,桌面 file:// 由壳注入绝对 URL)
// 同名→用户字段覆盖内置;新名→追加。两路按数组顺序依次合并。与 _dyn 三层合并同构。
function _applyUserDict(userArr) {
  if (!Array.isArray(userArr)) return 0;
  let n = 0;
  for (const u of userArr) {
    if (!u || !u.name) continue;
    const i = dict.findIndex((m) => m.name === u.name);
    if (i >= 0) dict[i] = Object.assign({}, dict[i], u); // 字段级覆盖(用户只填要改的)
    else dict.push(u); // 新增用户模型
    n++;
  }
  return n;
}
async function _mergeUserModels() {
  let merged = 0;
  merged += _applyUserDict(window.__BEILU_USER_MODELS); // ① 壳扫描数组
  // ④→①.5 user-models 目录扫描(0722 读侧对齐):Electron 由壳扫描注入①,web 端此前无此路——
  //   user-models 里的模型(手动丢入/文件选择式导入)在 web 预览无 URL 可加载=选中显示兜底小生物。
  //   scan.webUrl 走 /api/eye/user-models 静态路由。放在字典 overlay(②)前:用户显式配置最后覆盖。
  //   file:// 不请求(①已含);端点不可达=静默(离线预览退化,桌宠端不受影响)。
  if (/^https?:$/.test(location.protocol)) {
    // R1-SKIP: 可选静默配置加载,同 usermodel-dict 范式。
    try {
      const r = await fetch("/api/eye/usermodel-scan");
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr)) merged += _applyUserDict(arr.filter((m) => m && m.name && m.webUrl && !m.error).map((m) => ({ name: m.name, url: m.webUrl })));
      }
    } catch (e) { /* 端点不可达:静默 */ }
  }
  let dictUrl = window.__BEILU_USER_DICT_URL;
  if (dictUrl === undefined && /^https?:$/.test(location.protocol)) {
    dictUrl = "/api/eye/usermodel-dict"; // ② http 同源默认端点(file:// 不默认,避免无效请求)
  }
  if (dictUrl) {
    // R1-SKIP: dictUrl 可为外部/用户配置端点(默认 /api/eye/usermodel-dict)的可选静默配置加载；apiFetch 401→/login 对外站有害。
    try { const r = await fetch(dictUrl); if (r.ok) merged += _applyUserDict(await r.json()); }
    catch (e) { /* 无用户配置/端点不可达:静默 */ }
  }
  // ③ 图片包(图片模式,任务②):http 同源默认拉 /api/eye/imagepacks(dict 同构条目,format:"image")。
  //   桌面 file:// 由壳扫 user-images 注入 __BEILU_USER_MODELS 同路合并(①已含),不重复请求。
  if (/^https?:$/.test(location.protocol)) {
    // R1-SKIP: 可选静默配置加载,同 usermodel-dict 范式。
    try { const r = await fetch("/api/eye/imagepacks"); if (r.ok) merged += _applyUserDict(await r.json()); }
    catch (e) { /* 无图片包/端点不可达:静默 */ }
  }
  if (merged) console.log("[live2d] 合并用户模型/配置:", merged, "条 → 总", dict.length);
}

/**
 * 初始化 Live2D 渲染器（本模块唯一导出函数）。
 *
 * 链路：index.mjs companion 激活 ensure → 本函数 → fetch model_dict.json → _mergeUserModels → PIXI.Application
 *       → Live2DModel.from(modelCfg.url) → _setupLoadedModel → bindEvents → startIdleFace
 * 影响：创建 PIXI.Application + Canvas、挂 ResizeObserver/window.resize、注册 window 事件监听器、
 *       暴露 window.beiluLive2d 全局 API
 * 约束：DOM 中必须有 #live2d-host；图片形象不加载 vendor，Live2D 形象通过
 *       ensureVendorRuntime 按 core→pixi→cubism4 懒加载。任一关键失败都抛出，不伪装 ready。
 */
export async function initLive2dRenderer({ ensureVendorRuntime } = {}) {
  if (ensureVendorRuntime !== undefined && typeof ensureVendorRuntime !== "function") {
    throw new TypeError("ensureVendorRuntime 必须是函数");
  }
  if (typeof ensureVendorRuntime === "function") _ensureVendorRuntime = ensureVendorRuntime;
  // 桌宠渲染挂自己的专属容器 #live2d-host，不抢占 #comp-preview（那是截图预览区，有截图放大功能在用）。
  // 主场=桌面 deskpet；网页端在设置界面的"桌宠形象"预览位提供 #live2d-host。
  const host = document.getElementById("live2d-host");
  if (!host) throw new Error("Live2D 渲染容器 #live2d-host 不存在");
  hostEl = host;
  // (PIXI 存在性检查移入 _ensurePixiApp:图片模式不需要 PIXI,缺库时图片包仍可渲染。)
  try {
    // R1-SKIP: DICT_URL=vendor/live2d-models/model_dict.json 静态 vendor 资源，非 /api/*。
    const r = await fetch(DICT_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    dict = await r.json();
  } catch (e) {
    console.warn("[live2d] model_dict 读取失败:", e.message);
    // [0727 可见降级] 原仅 console.warn=清单读不到时桌宠区静默空白,普通用户不开控制台完全无感;
    // 清单是模型枚举的唯一来源,读不到=live2d 整体不可用(下方 dict.find 全部落空),必须让用户看见。
    // 改经 _beiluToast(同文案在屏自动去重不刷屏,呼应下方 178/285 两处同型降级)。
    window._beiluToast?.("Live2D 模型清单读取失败: " + e.message, "error");
    throw e;
  }
  if (!Array.isArray(dict)) dict = [];
  await _mergeUserModels(); // 用户模型/配置 overlay 合并(自定义最多:用户覆盖/新增,不改内置)
  if (!dict.length) throw new Error("Live2D 模型清单为空");
  _initCharModels(); // D-2 角色卡→模型 映射(壳/设置页经 window.__BEILU_CHAR_MODELS 注入)
  // 初始模型(优先级):① 当前角色卡绑定模型(D-2) ② 全局 __BEILU_PET_MODEL(用户选择) ③ dict[0]。
  //   当前角色名:桌面壳经 query 注入 __BEILU_PET_CHAR;web 端用 sharedState 暴露的 _beiluGetCharName()。
  _curChar = window.__BEILU_PET_CHAR || (typeof window._beiluGetCharName === "function" ? (window._beiluGetCharName() || "") : "");
  // web 端初始形象读写同源修(2026-07-09 追链发现):__BEILU_PET_MODEL 只有桌面壳 query 注入,web 无生产者
  //   → web 预览初始不吃 pet_settings.modelName(用户在设置里选的形象刷新后回退 dict[0])。http 同源补读同一权威源。
  if (!window.__BEILU_PET_MODEL && /^https?:$/.test(location.protocol)) {
    // R1-SKIP: /api/eye/pet-settings localhost 可选静默源,同 usermodel-dict 范式。
    try { const r = await fetch("/api/eye/pet-settings"); if (r.ok) { const s = await r.json(); if (s && s.modelName) window.__BEILU_PET_MODEL = s.modelName; } }
    catch (e) { /* 后端未起:静默走原优先级 */ }
  }
  const _charModel = _modelForChar(_curChar);
  const _initName = _charModel || window.__BEILU_PET_MODEL;
  // 自动默认(凛倾 0722 去指名硬编码"如果用户把贝露的图包删除会怎么样"):无显式选择、或显式名资产已删
  // (find 不中)→ 首个图片包条目 → 字典首项 → (dict 空时上方已 return,小生物兜底在消费端)。
  // 按可用性选而非代码指名某个包:删包/改名自动降级,零指名残留。
  modelCfg = (_initName && dict.find((m) => m.name === _initName)) || dict.find((m) => (m.format || "live2d") === "image") || dict[0];
  imagePack.setAliases(EMOTION_ALIASES); // 图片包别名撞库与 live2d 同一单源表(不抄副本)
  // ── 形象格式路由(airi resolveBuiltInStageModelRenderer 同型):format==="image" → 图片包后端;缺省 live2d(零迁移)。 ──
  if ((modelCfg.format || "live2d") === "image") {
    const ok = await imagePack.load(modelCfg, host);
    if (!ok) throw new Error(`图片形象加载失败: ${modelCfg.name || "(未命名)"}`);
    bindEvents();
    console.log("[live2d] 图片模式就绪:", modelCfg.name);
    return true;
  }
  await _requireVendorRuntime();
  if (!_ensurePixiApp()) throw new Error("Live2D vendor 运行时未就绪");
  try {
    const M = window.PIXI.live2d.Live2DModel;
    model = await M.from(modelCfg.url, { autoInteract: false });
    _setupLoadedModel(); // 布局+默认表情+idle动作+点击(reload 复用)
    // 优化2 眨眼/呼吸：pixi-live2d-display(vendor/cubism4.min.js)在 Cubism4InternalModel 构造时
    //   ① 当 model3.json 含 EyeBlink 组(mao_pro 有 ParamEyeLOpen/ParamEyeROpen)时自动
    //      `this.eyeBlink = CubismEyeBlink.create(settings)`，每帧驱动自然眨眼；
    //   ② breath 无条件创建并以库内默认参数初始化（含 ParamBreath/ParamAngleX/Y/Z/ParamBodyAngleX），
    //      与 model3.json 是否声明 Breath 组无关。
    // 二者均随 PIXI.Ticker（已 registerTicker）每帧 update，故桌宠静止时自动眨眼+起伏呼吸，无需手动定时器。
    // 依据：cubism4.min.js 中 `…getEyeBlinkParameters())?void 0:t.length)>0&&(this.eyeBlink=l.create(this.settings)),
    //   this.breath.setParameters([new o(this.idParamAngleX,…),…,new o(this.idParamBreath,0,.5,3.2345,.5)…`
    bindEvents();    // window 情感/陪伴事件(幂等,image/live2d 两分支共用)
    console.log("[live2d] 渲染就绪:", modelCfg.name);
  } catch (e) {
    console.warn("[live2d] 模型加载失败:", e.message);
    // [0727 可见降级] 原仅 console.warn=桌宠区静默空白,普通用户不开控制台完全无感;
    // 改经 _beiluToast(错误型首个 toast 会追加报错引导),同文案在屏自动去重不刷屏。
    window._beiluToast?.("Live2D 模型加载失败: " + e.message, "error");
    throw e;
  }
  return true;
}

async function _requireVendorRuntime() {
  if (window.PIXI?.live2d?.Live2DModel && window.Live2DCubismCore) return;
  if (typeof _ensureVendorRuntime !== "function") {
    throw new Error("Live2D vendor 运行时未预加载，且未提供 ensureVendorRuntime");
  }
  await _ensureVendorRuntime();
  if (!window.PIXI?.live2d?.Live2DModel || !window.Live2DCubismCore) {
    throw new Error("ensureVendorRuntime 完成后 Live2D vendor 全局对象仍不完整");
  }
}

// ── PIXI app 懒建(图片模式不建;首个 live2d 形象时才建,ticker/observer 一次性装配) ──
let _live2dBooted = false;
function _ensurePixiApp() {
  if (app) return true;
  const PIXI = window.PIXI;
  if (!PIXI || !PIXI.live2d) { console.warn("[live2d] PIXI/cubism 未加载"); return false; }
  const canvas = document.createElement("canvas");
  canvas.id = "live2d-canvas";
  canvas.style.cssText = "width:100%;height:100%;display:block";
  hostEl.appendChild(canvas);
  PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
  app = new PIXI.Application({ view: canvas, resizeTo: hostEl, backgroundAlpha: 0, autoStart: true, antialias: true });
  if (!_live2dBooted) {
    _live2dBooted = true;
    startIdleFace(); // 统一 ticker(内部 !model 守卫,先建后载安全)
    // 桌宠常挂在初始隐藏的 companion tab(display:none → host 0×0),切换显示不触发 window.resize,
    // 故用 ResizeObserver 在 host 拿到真实尺寸时再布局。
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => relayout()).observe(hostEl);
    window.addEventListener("resize", relayout);
  }
  return true;
}
// 卸当前 live2d 模型(切形象/切格式共用)。
function _teardownLive2dModel() {
  if (!model) return;
  try { if (app) app.stage.removeChild(model); } catch (e) {}
  try { model.destroy(); } catch (e) {}
  model = null;
}
// 重载字典并强制重载当前形象(设置页保存 scale/位移/pack.json 后即时生效;兑现头注释 reloadDict 承诺)。
//   强制=先清激活态绕过 reloadModel 的同名短路(否则字典新值不重读)。
async function reloadDict() {
  try {
    // R1-SKIP: 静态 vendor 资源,同 init。
    const r = await fetch(DICT_URL);
    dict = r.ok ? await r.json() : [];
  } catch (e) { dict = []; }
  if (!Array.isArray(dict)) dict = [];
  await _mergeUserModels();
  const cur = imagePack.ready() ? imagePack.getName() : (modelCfg && model && modelCfg.name);
  if (!cur) return true;
  if (imagePack.ready()) imagePack.destroy(); else _teardownLive2dModel();
  modelCfg = null; // 清短路依据
  return await reloadModel(cur);
}

// 加载后装配(init 与模型切换 reloadModel 复用):布局 + 默认表情 + idle动作 + 点击。
//   bindEvents/startIdleFace 只在 init 绑一次(用模块 model,切换后自动指向新 model)。
function _setupLoadedModel() {
  _buildParamIds(); // 枚举该模型参数 id 全集(供 _setP 优雅降级)
  _detectLibEyeBlink(); // 检测库自带 eyeBlink 是否激活→决定是否启用兜底眨眼(每模型不同,切换后重测)
  _blink.open = 1; _blink.phase = "idle"; _blink.nextAt = 0; // 新模型眨眼态复位
  _exprIndex = null; // 表情名索引重置;表情是异步加载的,故由 _resolveExpr 在首次用时懒建(那时已加载完)
  // T-A:切模型复位表情贴参态——新 model = 新 coreModel/参数集,旧缓存/激活态不可复用。
  //   缓存(_exprParamCache/_exprDefault/_exprIndex)与 SDK expressionManager 置 null 都由下方 _preloadExpressions
  //   对新 model 重建/重捕——必须在那里做,因为枚举表情定义需要先读 expressionManager.definitions,不能提前置 null。
  _activeExpr = null; _exprParamCache = {}; _exprDefault = {}; _exprDefs = null;
  // 统一更新管线根治(非补丁):停模型自动更新,改在单一 ticker 里"先 model.update 后写我的参数",
  //   保证 视线/口型/身体倾 在动作/呼吸/物理之后写=绝不被覆盖(原 talkPulse setInterval 绕过 ticker 被 Idle 动作盖)。
  try { model.autoUpdate = false; } catch (e) {}
  relayout();
  app.stage.addChild(model);
  // 表情外置文件预载(修 pixi 懒加载按 <base> 解析致用户模型 404);完成后再应用默认表情(确保命中预载)。
  _preloadExpressions().then(() => { if (modelCfg.defaultEmotion) setEmotion(modelCfg.defaultEmotion); }).catch(() => {});
  if (modelCfg.defaultEmotion) setEmotion(modelCfg.defaultEmotion);
  _idleBound = false; // 新模型 = 新 motionManager,重绑 idle 自重启
  startIdleLoop();
  bindTap();
}

// 模型切换(D-2):按名换桌宠模型——销毁旧模型释放资源,加载新模型,复用装配。
//   桌面壳调 window.beiluLive2d.reloadModel(name) 后应重新读 _metrics 上报新比例(每模型画幅不同)。
async function reloadModel(name) {
  if (!Array.isArray(dict) || !dict.length) return false;
  const cfg = dict.find((m) => m.name === name);
  if (!cfg) return false;
  // 已是该形象(两种后端各查各的激活名)
  if (imagePack.ready() ? imagePack.getName() === cfg.name : (modelCfg && cfg.name === modelCfg.name && model)) return true;
  // ── 格式路由:目标是图片包 → 卸两侧后端走 imagePack(不需要 PIXI;app 留着供切回 live2d 复用)。 ──
  if ((cfg.format || "live2d") === "image") {
    _teardownLive2dModel();
    modelCfg = cfg;
    const ok = await imagePack.load(cfg, hostEl);
    if (ok) console.log("[live2d] 切换到图片包:", cfg.name);
    return ok;
  }
  // 目标是 live2d:清图片后端 + 懒建 PIXI(初始形象是图片包时 init 未建过 app)。
  try {
    // 先确保 vendor 就绪再卸当前图片形象；加载失败时保留旧预览，并允许 loader 重试。
    await _requireVendorRuntime();
    imagePack.destroy();
    if (!_ensurePixiApp()) throw new Error("Live2D vendor 运行时未就绪");
    const M = window.PIXI?.live2d?.Live2DModel;
    if (!M) throw new Error("Live2DModel 未就绪");
    _teardownLive2dModel();
    _lean.pos = _lean.vel = _lean.target = 0; // 重置拖动倾态
    modelCfg = cfg;
    model = await M.from(cfg.url, { autoInteract: false });
    _setupLoadedModel();
    console.log("[live2d] 切换模型:", cfg.name);
    return true;
  } catch (e) {
    console.warn("[live2d] 模型切换失败:", e.message);
    // [0727 可见降级] 同上:切换失败时旧模型仍在,但用户需要知道切换没成功及原因
    window._beiluToast?.("Live2D 模型切换失败: " + e.message, "error");
    return false;
  }
}

// ── D-2 按【当前角色卡】选模型(管道不解释语义):角色名→模型名映射是【数据】,渲染层只查表换模型。 ──
//   映射来源(合并,后者覆盖前者):① window.__BEILU_CHAR_MODELS(壳/设置页注入的 {charName: modelName})
//   ② setCharModels() 运行时设置。空映射时退回全局 modelName(__BEILU_PET_MODEL)/dict[0](旧行为)。
//   renderer 不判断"谁是当前角色"——由调用方(web 经 sharedState.getCharName / 桌面经 IPC)告诉它,它只按 map 换模型。
let _charModels = {};
let _curChar = ""; // 当前角色名(由 setCharacter 设);供重切模型时复用
function _initCharModels() {
  try { if (window.__BEILU_CHAR_MODELS && typeof window.__BEILU_CHAR_MODELS === "object") _charModels = Object.assign({}, window.__BEILU_CHAR_MODELS); }
  catch (e) { _charModels = {}; }
}
function setCharModels(map) { if (map && typeof map === "object") _charModels = Object.assign({}, map); }
// 解析角色名→模型名:角色卡有显式绑定→用之(且该模型在 dict 中可用);否则 null(调用方退回全局默认)。
function _modelForChar(charName) {
  if (!charName) return null;
  const want = _charModels[charName];
  if (want && Array.isArray(dict) && dict.find((m) => m.name === want)) return want;
  return null;
}
// 切到某角色卡绑定的模型(管道:有绑定且与当前模型不同→reloadModel;无绑定→不动,沿用全局默认)。
async function setCharacter(charName) {
  _curChar = charName || "";
  const want = _modelForChar(_curChar);
  if (!want) return false; // 该角色无绑定模型(或绑定的模型不可用)→保持当前(全局默认),不报错
  if (modelCfg && modelCfg.name === want) return true; // 已是该模型
  return await reloadModel(want);
}

// ── 对齐放置(T-B):优先读模型自带的【权威对齐声明】model3.json 的 Layout(作者在 Cubism Editor 声明该模型怎么摆),
//   没有再回退现有 contain-fit。 ──
//   官方语义(实证 vendor/cubism4.min.js 的 CubismModelMatrix.setupLayout):
//     · Layout.Width/Height(默认 2)→ `localTransform.scale(Width/2,Height/2)` →【已烘焙】进 internalModel.width/height
//       (=canvasW×Width/2),故"按 internalModel.width/height 做 contain"本身就尊重了 Layout 的缩放声明。
//     · Layout.CenterX/CenterY/Top/Bottom/Left/Right → 经 `localTransform.translate(width*s,-height*r)`【已烘焙】
//       进模型内部矩阵(所有 drawable 经此渲染),把模型从画布中心平移到作者声明的摆放位置。
//       s = CenterX || X-W/2 || Left-W/2 || Right+W/2 || 0;r = CenterY || Y-H/2 || Top-H/2 || Bottom+H/2 || 0。
//   现状(改前)按【画布盒】(internalModel.width/height)contain + 锚点画布中心,无视该 translate → Layout 定位的模型偏出框。
//   修(框架级,非补丁):有 Layout 时按【model.getBounds()(drawable 实际范围,已含 localTransform 的 Layout 平移)】
//     做 contain + 居中,自然尊重作者声明的中心/边锚定;无 Layout 回退原【画布盒】contain(保 Hiyori 等不退步)。
function _hasLayout() {
  try {
    const lo = model && model.internalModel && model.internalModel.settings && model.internalModel.settings.layout;
    return !!(lo && typeof lo === "object" && Object.keys(lo).length);
  } catch (e) { return false; }
}
function relayout() {
  if (imagePack.ready()) return; // 图片模式:CSS contain 自适应,无需手工布局
  if (!model || !app) return;
  const w = hostEl ? hostEl.clientWidth : app.renderer.width;
  const h = hostEl ? hostEl.clientHeight : app.renderer.height;
  if (!w || !h) return; // host 仍隐藏（0×0），等下次 observer 回调
  app.renderer.resize(w, h);
  model.anchor.set(0.5, 0.5);
  const userScale = (modelCfg && modelCfg.scale) || 1;
  const xShift = (modelCfg && modelCfg.xShiftRatio != null) ? modelCfg.xShiftRatio : 0.5; // T-B:横向定位比(默认 0.5=居中;现 x 恒 w/2 之扩展)
  const yShift = (modelCfg && modelCfg.yShiftRatio != null) ? modelCfg.yShiftRatio : 0.5;
  _unitDims = null; // 下方两分支按各自 fit 基准回填(热区坐标系锚点,_hitFrame 消费)
  if (_hasLayout()) {
    // ── 有 Layout(权威):按 drawable 实际范围 fit。getBounds 已含库烘焙的 Layout 缩放+平移,故尊重作者声明。 ──
    //   先把 scale 归一(让 bounds 反映"模型坐标系→屏幕"前的当前比例),换算出"令实际体型 contain 进框"的 scale。
    //   bounds 随 model.scale/position 变,故用当前 scale 反推单位尺寸,再算目标 fit(与 contain 同式但基于真实体型,不留画布空边)。
    let b = model.getBounds(); // 屏幕像素范围(受当前 scale 影响)
    const curScale = model.scale.x || 1;
    // bounds 在 scale=1(模型单位)下的体型尺寸 = 当前 bounds / 当前 scale。
    const uw = (b.width / curScale) || ((model.internalModel && model.internalModel.width) || w);
    const uh = (b.height / curScale) || ((model.internalModel && model.internalModel.height) || h);
    _unitDims = { uw, uh };
    const fit = Math.min(w / uw, h / uh);
    model.scale.set(fit * userScale);
    // 重测 bounds(scale 已更新)→ 用其中心相对 model.position 的偏移,把【模型实际视觉中心】对齐到 host 的 (xShift,yShift)。
    b = model.getBounds();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const dx = (w * xShift) - cx, dy = (h * yShift) - cy;
    model.position.set(model.position.x + dx, model.position.y + dy);
  } else {
    // ── 无 Layout(回退,保持现有行为不退步):以模型【原始画布尺寸】(internalModel.width/height,不随 model.scale 漂移)
    //   做等比 contain,保证角色整体(头到脚)完整放入窗口、绝不裁切。x 用 xShiftRatio(默认 0.5=旧 w/2),y 用 yShiftRatio。 ──
    const iw = (model.internalModel && model.internalModel.width) || model.width || w;
    const ih = (model.internalModel && model.internalModel.height) || model.height || h;
    _unitDims = { uw: iw, uh: ih };
    const fit = Math.min(w / iw, h / ih);
    model.scale.set(fit * userScale);
    model.position.set(w * xShift, h * yShift);
  }
}

// ── 参数框架接入层(对接规则):语义角色→实际参数 id,缺省用 Cubism 标准名,model_dict.params 可覆盖。 ──
//   优雅降级:模型无该参数(如 mao_pro 无 ParamMouthOpenY、Wanko 非人形)→ _setP 跳过不报错(只是没该效果)。
//   参数 id 全集从 coreModel._model.parameters.ids 枚举(已 runtime 实证:getParameterId 在本 vendored 构建不可用)。
let _paramIds = null;
const STD_PARAMS = {
  eyeBallX: "ParamEyeBallX", eyeBallY: "ParamEyeBallY",
  eyeLOpen: "ParamEyeLOpen", eyeROpen: "ParamEyeROpen",   // 眨眼(库无 EyeBlink 组时由 _blink 兜底驱动)
  mouthOpen: "ParamMouthOpenY", mouthForm: "ParamMouthForm",
  angleX: "ParamAngleX", angleY: "ParamAngleY", angleZ: "ParamAngleZ",
  bodyAngleX: "ParamBodyAngleX", bodyAngleZ: "ParamBodyAngleZ", breath: "ParamBreath",
};
function _buildParamIds() {
  try { _paramIds = new Set(model.internalModel.coreModel._model.parameters.ids); }
  catch (e) { _paramIds = null; }
}
function _pid(role) { return (modelCfg && modelCfg.params && modelCfg.params[role]) || STD_PARAMS[role] || role; }
function _hasParam(id) { return _paramIds ? _paramIds.has(id) : true; }
function _setP(role, val) {
  const core = model && model.internalModel && model.internalModel.coreModel;
  if (!core) return false;
  const id = _pid(role);
  if (!_hasParam(id)) return false; // 模型无此参数 → 优雅跳过
  try { core.setParameterValueById(id, val); return true; } catch (e) { return false; }
}

// ── 自然运动【数值/曲线/参数】框架(grounded:调研_自然运动数值曲线参数框架_20260617)。 ──
//   原则:临界阻尼弹簧 ζ=1(不过冲=不抖,不拖沓=不僵)+ 帧率无关 dt 积分 + 相干噪声替随机跳 + 驱动 body 参数非整体旋转。
// 临界阻尼弹簧精确闭式解(theorangeduck);halflife=收敛半衰期(秒),dt=帧时长。任意 dt 稳定、绝不过冲。
function springCritical(x, v, xt, halflife, dt) {
  const y = (4 * Math.LN2) / ((halflife || 0.3) + 1e-6) / 2;
  const j0 = x - xt;
  const j1 = v + j0 * y;
  const e = Math.exp(-y * dt);
  return { x: e * (j0 + j1 * dt) + xt, v: e * (v - j1 * y * dt) };
}
// 1D value noise(相干噪声):相邻时刻连续可导→平滑有机漂移(替 Math.random 阶跃跳=抖/机械)。
function makeNoise1D(seed) {
  seed = seed || 1;
  const rand = (i) => { const x = Math.sin((i + seed) * 127.1) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x) => { const i = Math.floor(x), f = x - i; return rand(i) * (1 - smooth(f)) + rand(i + 1) * smooth(f); };
}
const _noiseGX = makeNoise1D(11), _noiseGY = makeNoise1D(37), _noiseMouth = makeNoise1D(91);
// 动态效果配置(可设定):model_dict.dynamics 覆盖全局默认。
const DYN_DEFAULT = {
  gaze: { enabled: true, noiseScale: 0.12, ampX: 0.6, ampY: 0.35 },
  idleMouth: { enabled: true, period: 4.0, amp: 0.04, base: 0.05, jitter: 0.15 },
  drag: { enabled: true, gain: 0.06, maxTarget: 8, deadZone: 0.5, halflife: 0.30, targetTau: 0.25 },
  // 自动眨眼兜底:仅当库自带 eyeBlink 未激活(model3.json 无 EyeBlink 组,如本批 7 测试模型/多数导入模型)时启用,
  //   随机间隔闭合再睁开,写 ParamEyeLOpen/ParamEyeROpen(无该参数的模型如 Wanko 经 _setP 优雅跳过)。
  //   minGap/maxGap=两次眨眼间隔(秒),close=闭合时长(秒)。
  blink: { enabled: true, minGap: 2.5, maxGap: 6.0, close: 0.10 },
  // 动作开关(人工自主设置 → pet-settings.dynamics.motion):idleLoop=待机动作自循环;tap=点击播 TapBody。默认全开=旧行为。
  motion: { idleLoop: true, tap: true },
  // airi 对标(2026-07-09):视线跟随鼠标(model.focus 库内置)/渲染质量帧率/投影。默认关或旧值=不改变现行为。
  eyeTrack: { enabled: false, offsetX: 0, offsetY: 0 },
  render: { scale: 0, maxFps: 0 }, // 0=不干预(保持库/设备默认)
  shadow: { enabled: false },
};
let _userDyn = {}; // 用户运行时覆盖(人工自主设置:设置页/托盘滑块 → pet-settings.dynamics → 此处)
// 合并优先级:全局默认 < model_dict.dynamics(per-model) < 用户设置。ticker 每帧读 _dyn,改即生效。
function _dyn(group) { return Object.assign({}, DYN_DEFAULT[group], (modelCfg && modelCfg.dynamics && modelCfg.dynamics[group]) || {}, _userDyn[group] || {}); }
// 人工自主设置入口:整体覆盖 或 单组 patch。
let _prevIdleLoop = true;
function applyUserDynamics(obj) {
  if (obj && typeof obj === "object") _userDyn = obj;
  // 待机循环开关翻转才动作(滑块改 dynamics 不会误触发):关→开 重启循环;开→关 立即停当前 idle
  //   (否则模型在 dynamics 到达前已起播的 idle 要等本条放完才停;含 load 时 idleLoop=false 但模型已起播的情形)。
  const il = _dyn("motion").idleLoop !== false;
  if (model && il !== _prevIdleLoop) {
    try {
      const mm = model.internalModel && model.internalModel.motionManager;
      if (il) {
        // 恢复 pixi-live2d 内置 idle 自动重启(MotionManager.update 见 isFinished+groups.idle 自动放)+ 我方循环
        if (mm && mm.groups) mm.groups.idle = _idleGroup();
        startIdleLoop();
      } else {
        // 关键:仅 _stopAllMotions 不够——pixi-live2d 的 update() 每帧见 groups.idle 会自动重放 idle(绕过我的 motionFinish 闸门)。
        //   故先清 groups.idle 断库自动 idle,再停当前动作。
        if (mm && mm.groups) mm.groups.idle = "";
        if (mm) { if (typeof mm._stopAllMotions === "function") mm._stopAllMotions(); else if (mm.queueManager && mm.queueManager.stopAllMotions) mm.queueManager.stopAllMotions(); }
      }
    } catch (e) { /* 停/起失败:忽略 */ }
  }
  _prevIdleLoop = il;
  _applyRenderDyn(); // airi 对标组(eyeTrack/render/shadow)即时生效
}
function setDynamics(group, patch) { if (!group || !patch) return; _userDyn[group] = Object.assign({}, _userDyn[group], patch); _applyRenderDyn(); }
// ── airi 对标消费(2026-07-09):视线跟随鼠标/渲染清晰度/最大帧率/投影。值域与语义见 caps.dynSpec 谱。 ──
let _eyeTrackBound = false;
function _applyRenderDyn() {
  // 帧率/清晰度(0=不干预)
  try {
    const r = _dyn("render");
    if (app) {
      if (Number(r.maxFps) > 0) app.ticker.maxFPS = Number(r.maxFps); else if (app.ticker.maxFPS) app.ticker.maxFPS = 0;
      const sc = Number(r.scale);
      if (sc > 0 && app.renderer && app.renderer.resolution !== sc) { app.renderer.resolution = sc; relayout(); }
    }
  } catch (e) { /* 渲染器未就绪 */ }
  // 投影:CSS drop-shadow(零滤镜依赖,vendor pixi 无 DropShadowFilter;对 canvas 与图片包 img 同语义)
  try {
    const on = _dyn("shadow").enabled === true;
    const el = (imagePack.ready() && document.getElementById("imagepack-avatar")) || (app && app.view) || null;
    if (el) el.style.filter = on ? "drop-shadow(0 6px 10px rgba(0,0,0,0.35))" : "";
  } catch (e) { /* 元素未就绪 */ }
  // 视线跟随鼠标(库内置 model.focus;offset=基准框比例偏移)。开关翻转即绑/停(monitor 单绑幂等)。
  try {
    if (!_eyeTrackBound && hostEl) {
      _eyeTrackBound = true;
      hostEl.addEventListener("pointermove", (e) => {
        const et = _dyn("eyeTrack");
        if (et.enabled !== true || !model || !model.focus) return;
        const hr = hostEl.getBoundingClientRect();
        model.focus(e.clientX - hr.left + (Number(et.offsetX) || 0) * hr.width, e.clientY - hr.top + (Number(et.offsetY) || 0) * hr.height, false);
      });
      hostEl.addEventListener("pointerleave", () => {
        const et = _dyn("eyeTrack");
        if (et.enabled === true && model && model.focus) { const hr = hostEl.getBoundingClientRect(); model.focus(hr.width / 2, hr.height / 2, false); } // 离开回正视
      });
    }
  } catch (e) { /* host 未就绪 */ }
}
// 拖动身体倾态(度):nudge 设目标,ticker 内临界阻尼弹簧收敛 + 目标柔和回 0。
const _lean = { pos: 0, vel: 0, target: 0 };

// 自动眨眼兜底状态(只在库自带 eyeBlink 缺失时驱动,避免与库双驱动打架)。
//   _blink.libActive=该模型库自带 eyeBlink 是否激活(model3.json 含 EyeBlink 组→true,则本兜底不介入)。
//   open=当前睁开度(1睁0闭);nextAt=下次开始闭眼的时刻;phase=idle待机/closing闭合中/opening睁开中。
const _blink = { libActive: false, open: 1, nextAt: 0, phase: "idle", t0: 0 };
// 检测库自带 eyeBlink 是否激活(pixi-live2d Cubism4InternalModel.eyeBlink;含 EyeBlink 组才创建)。
//   切模型后重测;不可读时保守视为缺失→由兜底接管(兜底写参数前仍 _hasParam 守,无害)。
function _detectLibEyeBlink() {
  try { _blink.libActive = !!(model && model.internalModel && model.internalModel.eyeBlink); }
  catch (e) { _blink.libActive = false; }
}

// 情绪→表情 别名表(不完全硬编码:模型自带语义名 Smile/Angry/Sad… 时按名匹配,免逐模型手填 index)。
// 情绪→表情【别名匹配表】(EMOTION_ALIASES)：key=情绪标签(AI <emotion> 输出/角色卡 config 用的词)，
//   value=一组【小写子串】，_resolveExpr 用 exprName.indexOf(alias)>=0 去撞【模型自己 model3.json Expressions
//   里的表情名】(而非固定 canonical 集——本项目模型运行时由用户导入 user-models，无内置模型，故不锚死目标名，
//   撞不上就 return null 回退现有行为)。同一情绪聚英/日罗马音/中三套命名惯例(Live2D exp3 文件常见 EN 描述名/
//   数字名 f01·exp_01 走 config 显式映射不靠本表；galgame 表情差分惯用 照れ/困り/涙目/デフォルメ)，覆盖面越宽
//   越多用户模型能自动撞上。纯数据表——渲染/解析逻辑零改动(_resolveExpr 未动)。
// 【why 扩表】#15：原仅 neutral/happy/angry/sad/blush/surprised 6 别名，覆盖 Plutchik 8 基本情绪缺 disgust/fear/
//   trust/anticipation，也缺 galgame/Live2D 高频差分(smirk/wink/troubled/sleepy/laugh/panic 等)，多数 AI 情绪词/
//   模型表情名撞不上而落空。按 galgame 表情差分惯例(喜怒哀楽+照れ/困り/涙目…)与 Open-LLM-VTuber emotionMap
//   基准(neutral/anger/disgust/fear/joy/smirk/sadness/surprise)扩全。参照见 render 组扩表调查报告。
// 【别名撞库注意】alias 用短小写子串是为宽撞模型表情名(如 "smile" 撞 "f_smile_01"/"smiling")；越短撞面越宽但
//   须避免误撞(如不放单字 "up" 之类)。首个撞上的 alias 即命中(_resolveExpr 顺序遍历)，故把最具代表性的排前。
const EMOTION_ALIASES = {
  // ── 中性/平静 ──
  neutral: ["neutral", "normal", "default", "idle", "calm", "face_default", "sumashi", "澄まし", "平静", "普通", "中立"],
  // ── 喜(joy)系：微笑/大笑/坏笑/眨眼 ──
  happy: ["happy", "smile", "joy", "fun", "laugh", "grin", "glad", "cheer", "delight", "egao", "笑顔", "微笑", "开心", "高兴", "喜"],
  smile: ["smile", "smiling", "grin", "gentle", "hohoemi", "微笑み", "微笑"],
  laugh: ["laugh", "laughing", "lol", "haha", "warai", "笑い", "大笑", "爆笑"],
  smirk: ["smirk", "smug", "grin", "tehe", "doya", "ドヤ", "得意", "坏笑", "奸笑"],
  wink: ["wink", "winking", "uinku", "ウインク", "眨眼"],
  excited: ["excited", "thrill", "hype", "koufun", "興奮", "兴奋", "激动"],
  love: ["love", "heart", "adore", "koi", "恋", "爱心", "喜欢", "花痴"],
  // ── 怒(anger)系 ──
  angry: ["angry", "anger", "mad", "annoy", "irritate", "ikari", "怒り", "怒", "生气", "愤怒"],
  rage: ["rage", "furious", "fury", "gekido", "激怒", "暴怒", "狂怒"],
  pout: ["pout", "sulk", "puff", "fukure", "ふくれ", "むくれ", "嘟嘴", "撅嘴", "不满"],
  // ── 哀(sadness)系 ──
  sad: ["sad", "sorrow", "sadness", "depress", "gloom", "kanashi", "悲しみ", "悲", "难过", "伤心", "哀"],
  cry: ["cry", "crying", "tear", "sob", "weep", "naki", "泣き", "哭", "流泪"],
  teary: ["teary", "tearful", "namida", "涙目", "涙", "泪目", "含泪", "眼泪"],
  lonely: ["lonely", "lonesome", "sabishi", "寂しい", "孤独", "寂寞"],
  disappointed: ["disappoint", "letdown", "gakkari", "がっかり", "失望"],
  // ── 惊(surprise)系 ──
  surprised: ["surprise", "surprised", "shock", "astonish", "amaze", "odoroki", "驚き", "驚", "吃惊", "惊讶", "震惊"],
  panic: ["panic", "flustered", "awate", "慌て", "焦る", "慌张", "手忙脚乱"],
  // ── 惧(fear)系 ──
  fear: ["fear", "afraid", "scared", "terror", "kowa", "恐怖", "怖い", "害怕", "恐惧", "惊恐"],
  worried: ["worried", "worry", "anxious", "shinpai", "心配", "不安", "担心", "忧虑"],
  // ── 厌(disgust)系 ──
  disgust: ["disgust", "disgusted", "gross", "ken'o", "嫌悪", "嫌", "厌恶", "恶心", "反感"],
  contempt: ["contempt", "scorn", "sneer", "keibetsu", "軽蔑", "鄙视", "轻蔑", "不屑"],
  // ── 羞/照れ系(galgame 高频差分) ──
  blush: ["blush", "shy", "embarrass", "shame", "bashful", "tere", "照れ", "照", "害羞", "脸红", "羞涩"],
  // ── 困り/纠结系(galgame 高频差分) ──
  troubled: ["troubled", "trouble", "confused", "perplex", "komari", "困り", "困る", "困惑", "为难", "纠结"],
  // ── 期待/信赖(Plutchik 补全) ──
  anticipation: ["anticipat", "expect", "eager", "kitai", "期待", "期望", "憧憬"],
  trust: ["trust", "relief", "assured", "anshin", "安心", "信赖", "放心", "安心"],
  // ── 困倦/睡眠(galgame 差分) ──
  sleepy: ["sleepy", "sleep", "drowsy", "nemui", "眠い", "睡眠", "困", "犯困", "瞌睡"],
  // ── 无语/デフォルメ(半眼/汗) ──
  serious: ["serious", "stern", "majime", "真面目", "认真", "严肃"],
  speechless: ["speechless", "blank", "sweat", "jito", "半眼", "无语", "无奈", "汗颜"],
};
let _exprIndex = null; // 当前模型 {表情名小写: index}(名匹配用)
// ── T-A 表情直接贴参(克隆 airi expression-controller):SDK motionManager.expressionManager 在 motionManager.update
//   后每帧覆盖自定义参数,致 model.expression(idx) 贴不上(reserve=-1,脸不动)。故 _setupLoadedModel 置其为 null,
//   改由本层在 ticker(model.update 之后)按 exp3 的 Blend(Add/Multiply/Overwrite)直贴参数。airi Model.vue:435 同此。
//   _exprParamCache[i] = exp3.Parameters 数组([{Id,Value,Blend}]);_exprDefault[Id] = modelDefault(getParameterDefaultValue,
//   退 getParameterValueById,退 0);_activeExpr = 当前激活表情的 Parameters 数组(指向 cache 某项),null=无表情。
let _exprParamCache = {}; // { exprIndex(number): [{Id,Value,Blend}] }
let _exprDefault = {};    // { paramId: modelDefault }(供 Add 基值 / 失活写回清残)
let _activeExpr = null;   // 当前激活表情的 Parameters 数组(切表情/切模型时复位)
let _exprDefs = null;     // 表情定义快照 [{Name,File}](_preloadExpressions 从 expressionManager.definitions 抄存;
                          //   因随后置 expressionManager=null,_buildExprIndex 改读此快照而非已 null 的 manager)
function _buildExprIndex() {
  _exprIndex = null;
  try {
    // T-A:优先用 _preloadExpressions 抄存的定义快照(expressionManager 已置 null,不能再读 manager);
    //   快照未就绪(预载未跑完/早调)时回退实时 manager。
    let defs = _exprDefs;
    if (!defs || !defs.length) {
      const em = model.internalModel.motionManager.expressionManager;
      defs = em && em.definitions;
    }
    if (defs && defs.length) {
      _exprIndex = {};
      defs.forEach((d, i) => { const nm = d && (d.name || d.Name); if (nm) _exprIndex[String(nm).toLowerCase()] = i; });
    }
  } catch (e) { _exprIndex = null; }
}
// 表情外置文件(.exp3.json)预加载修复:pixi-live2d 的表情懒加载用【原始相对路径】(如 "exp/Angry.exp3.json"),
//   浏览器按文档 <base>(=beilu-chat public)解析 → 用户导入模型(model3.json 在别处)的表情文件 404、表情无效。
//   纹理无此问题(pixi 按 model URL 正确解析)。修:加载后按【model3.json 绝对 URL】预取每个表情,CubismExpressionMotion.create
//   后注入 em.expressions[i],使 model.expression(i) 直接命中预载(不再走会 404 的懒加载)。失败单表情跳过(优雅降级)。
async function _preloadExpressions() {
  try {
    const mm = model && model.internalModel && model.internalModel.motionManager;
    const em = mm && mm.expressionManager;
    if (!em || !em.definitions || !em.definitions.length) {
      // 无 SDK 表情管理器(模型无表情/非人形):无表情可贴,直接返回(不影响其余渲染)。
      _exprDefs = null; return;
    }
    // ① 抄存表情定义快照(随后置 expressionManager=null,_buildExprIndex 改读此快照做名→index)。
    _exprDefs = em.definitions.map((d) => ({ Name: (d && (d.Name || d.name)) || "", File: (d && (d.File || d.file)) || "" }));
    const baseUrl = (model.internalModel.settings && model.internalModel.settings.url) || (modelCfg && modelCfg.url) || "";
    const core = model.internalModel.coreModel;
    // 捕获某参数的 modelDefault:优先 getParameterDefaultValueById(Cubism4),退当前值(加载后即默认),退 0。失活写回/Add 基值用。
    const _grabDefault = (id) => {
      if (Object.prototype.hasOwnProperty.call(_exprDefault, id)) return; // 已捕获
      let v = null;
      try { if (typeof core.getParameterDefaultValueById === "function") v = core.getParameterDefaultValueById(id); } catch (e) {}
      if (v == null) { try { v = core.getParameterValueById(id); } catch (e) {} }
      _exprDefault[id] = (typeof v === "number" && !Number.isNaN(v)) ? v : 0;
    };
    // ② 逐表情 fetch exp3 → 缓存 Parameters([{Id,Value,Blend}]),并为涉及的每个 Id 记 modelDefault。
    //   按【model3.json 绝对 URL】解析(修 pixi 懒加载按 <base> 解析致用户模型 404)。单表情失败跳过(优雅降级)。
    if (baseUrl) {
      for (let i = 0; i < _exprDefs.length; i++) {
        const file = _exprDefs[i].File;
        if (!file) continue;
        let url; try { url = new URL(file, baseUrl).href; } catch (e) { continue; }
        try {
          // R1-SKIP: url=Live2D 模型表情 json(new URL(file,baseUrl)) 静态模型资源，非 /api/*。
          const res = await fetch(url); if (!res.ok) continue;
          const json = await res.json();
          const params = (json && Array.isArray(json.Parameters)) ? json.Parameters : [];
          _exprParamCache[i] = params;
          for (const p of params) { if (p && p.Id) _grabDefault(p.Id); }
        } catch (e) { /* 单表情失败:跳过 */ }
      }
    }
    // ③ 根因修:置 SDK expressionManager=null,禁其在 motionManager.update 后每帧覆盖我们贴的表情参数。
    //   此后表情完全由 ticker 的 _applyActiveExpr 直贴(airi Model.vue:435 同此)。
    try { mm.expressionManager = null; } catch (e) {}
  } catch (e) { /* 整体失败:不置 null(保留库路径),表情可能不生效但不崩 */ }
}
// T-A 每帧贴参(克隆 airi computeTargetValue:209 的 Blend 三态 + noop 跳过 + 失活写回清残)。
//   在 ticker model.update 之后、我方 gaze/blink/mouth 之前调:让表情管眉/颊/口型基线,我方眼/口型再最终覆盖。
//   Add=modelDefault+Value / Multiply=当前帧值×Value / Overwrite=Value;noop(恒等:Add Value=0 / Mul Value=1 /
//   Over Value=modelDefault)跳过。缺参由 _hasParam 守(非人形如 Wanko 不崩)。
function _applyActiveExpr() {
  if (!_activeExpr || !_activeExpr.length) return;
  const core = model && model.internalModel && model.internalModel.coreModel;
  if (!core) return;
  for (const p of _activeExpr) {
    if (!p || !p.Id) continue;
    const id = p.Id;
    if (!_hasParam(id)) continue; // 模型无此参数 → 优雅跳过(不硬编码,从 exp3 来)
    const blend = p.Blend, val = (typeof p.Value === "number") ? p.Value : 0;
    const def = Object.prototype.hasOwnProperty.call(_exprDefault, id) ? _exprDefault[id] : 0;
    let target;
    if (blend === "Add") {
      if (val === 0) continue;                 // noop:加 0 无效果
      target = def + val;
    } else if (blend === "Multiply") {
      if (val === 1) continue;                 // noop:乘 1 无效果
      let cur = 0; try { cur = core.getParameterValueById(id); } catch (e) { cur = 0; }
      target = cur * val;
    } else { // Overwrite(含未知 Blend 归此)
      if (val === def) continue;               // noop:写回默认无效果
      target = val;
    }
    try { core.setParameterValueById(id, target); } catch (e) {}
  }
}
// 失活清残:把一组表情参数写回 modelDefault(切表情/清表情时调,防上一个表情的 Add/Overwrite 残值留在脸上)。
function _revertExprParams(params) {
  if (!params || !params.length) return;
  const core = model && model.internalModel && model.internalModel.coreModel;
  if (!core) return;
  for (const p of params) {
    if (!p || !p.Id) continue;
    if (!_hasParam(p.Id)) continue;
    const def = Object.prototype.hasOwnProperty.call(_exprDefault, p.Id) ? _exprDefault[p.Id] : 0;
    try { core.setParameterValueById(p.Id, def); } catch (e) {}
  }
}
// 多重情况解析 emotion→表情 index:① 显式 emotionMap(config 覆盖,最高) ② 表情名别名匹配(自动) ③ 无→null。
function _resolveExpr(emotion) {
  // emotionMap 键大小写不敏感(2026-07-09 一致性补齐:extractEmotion 出口 toLowerCase,手工编辑 json 大写键会 miss;
  //   图片包 _resolveKey 早已不敏感,此处对齐)。精确键优先,再小写扫。
  let cfgVal = modelCfg && modelCfg.emotionMap && modelCfg.emotionMap[emotion];
  if (cfgVal == null && modelCfg && modelCfg.emotionMap && typeof emotion === "string") {
    const _lo = emotion.toLowerCase();
    for (const k in modelCfg.emotionMap) { if (k.toLowerCase() === _lo) { cfgVal = modelCfg.emotionMap[k]; break; } }
  }
  if (!_exprIndex || !Object.keys(_exprIndex).length) _buildExprIndex(); // 懒建/重建(表情异步加载完后)
  // ① 显式 emotionMap:支持 number(index) 或 string(表情名,更稳更自定义友好)。
  if (cfgVal != null) {
    if (typeof cfgVal === "number") return cfgVal;
    if (typeof cfgVal === "string") {
      const i = _exprIndex && _exprIndex[cfgVal.toLowerCase()];
      if (i != null) return i; // 名字匹配上;没匹配上则继续走 ② 别名兜底
    }
  }
  // ② 表情名别名自动匹配。用户可覆盖(2026-07-09):usermodel 条目 aliases[情绪]=数组 优先于内建表
  //   (字段级 merge 已通任意字段,_applyUserDict:64)——别名不再是改源码才能扩的常量。
  if (_exprIndex) {
    const aliases = (modelCfg && modelCfg.aliases && Array.isArray(modelCfg.aliases[emotion]) && modelCfg.aliases[emotion]) || EMOTION_ALIASES[emotion] || [emotion];
    for (const a of aliases) {
      for (const nm in _exprIndex) { if (nm.indexOf(a) >= 0) return _exprIndex[nm]; }
    }
  }
  return null;
}
// 自定义表情(用户在调试工具设计的【任意参数+值】组):emotionMap[emotion]="custom:<name>"
//   → modelCfg.customExpressions[name] = [{Id,Value,Blend}]。复用 _applyActiveExpr 每帧贴参,
//   无 exp3 的模型(Hiyori)也能做参数级表情。超 airi(airi 不能新建绑定)。返回参数数组或 null。
function _resolveCustomExpr(emotion) {
  const v = modelCfg && modelCfg.emotionMap && modelCfg.emotionMap[emotion];
  if (typeof v === "string" && v.startsWith("custom:")) {
    const name = v.slice(7);
    const arr = modelCfg.customExpressions && modelCfg.customExpressions[name];
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return null;
}
// 为自定义表情数组涉及的每个参数补 modelDefault(Add 基值 + 失活写回清残用);缺则从 core 捕获。
function _ensureExprDefaults(arr) {
  const core = model && model.internalModel && model.internalModel.coreModel;
  if (!core || !Array.isArray(arr)) return;
  for (const p of arr) {
    if (!p || !p.Id || Object.prototype.hasOwnProperty.call(_exprDefault, p.Id)) continue;
    let v = null;
    try { if (typeof core.getParameterDefaultValueById === "function") v = core.getParameterDefaultValueById(p.Id); } catch (e) {}
    if (v == null) { try { v = core.getParameterValueById(p.Id); } catch (e) {} }
    _exprDefault[p.Id] = (typeof v === "number" && !Number.isNaN(v)) ? v : 0;
  }
}
// 多标签可配(管道不解释语义):name 可为单标签、数组、或逗号/空格/竖线分隔的多标签串
//   (如 "happy blush" / ["happy","blush"] / "happy,wave")。每个标签都经角色卡 config(emotionMap/
//   emotionMotionMap)解析——映射【交角色卡定义】,渲染层只查表执行,不内置"哪个标签=什么"的语义。
//   规则:首个解析出表情的标签 → 设表情(表情是持续态,只取一个避免互相覆盖);所有解析出动作的标签 → 依次播动作。
function _splitEmotionTags(name) {
  if (Array.isArray(name)) return name.map((s) => String(s || "").trim()).filter(Boolean);
  return String(name || "").split(/[\s,|]+/).map((s) => s.trim()).filter(Boolean);
}
/**
 * 设置桌宠表情（情绪→表情+动作的管道入口，window.beiluLive2d.setEmotion 直接调此）。
 *
 * 链路：WS emotion_changed → beilu:emotion-changed → 本函数
 *       → _splitEmotionTags（拆多标签）→ 首个标签解析表情(setExpr) + 所有标签解析动作(playMotion)
 * 影响：修改 _activeExpr（表情持续态，ticker 每帧贴参）、播放 motion（动作一次性）
 *
 * @param {string|string[]} name - 情绪标签，支持单标签/数组/逗号空格竖线分隔的多标签串
 * @returns {boolean|undefined} 是否成功设置了表情
 */
function setEmotion(name) {
  if (!name) return;
  const tags = _splitEmotionTags(name);
  if (!tags.length) return;
  // 图片模式:键由图片包定义(AI 特定指令直达,管道不解释语义),包内做 精确键>文件passthrough>别名兜底。
  if (imagePack.ready()) return imagePack.setEmotion(tags);
  if (!model || !modelCfg) return;
  // ① 表情:取【首个】能解析出表情 index 的标签(显式 emotionMap 优先,否则名字别名匹配);表情是持续态,多设会互盖。
  //   T-A:不再走 SDK model.expression(idx)(被 expressionManager 每帧覆盖,已置 null);改设 _activeExpr 指向
  //   exp3 缓存,由 ticker 的 _applyActiveExpr 每帧按 Blend 直贴。切换前把上一个表情参数写回 modelDefault 清残。
  let exprSet = false;
  for (const tag of tags) {
    // ①a 自定义表情(用户设计的参数组,emotionMap[tag]="custom:<name>")优先——复用 _applyActiveExpr 贴参
    const _custom = _resolveCustomExpr(tag);
    if (_custom) {
      if (_custom !== _activeExpr) { _revertExprParams(_activeExpr); _ensureExprDefaults(_custom); _activeExpr = _custom; }
      exprSet = true;
      break;
    }
    // ①b exp3 表情(模型自带,原路径不变)
    const idx = _resolveExpr(tag);
    if (idx != null) {
      const next = _exprParamCache[idx] || null;
      if (next !== _activeExpr) { _revertExprParams(_activeExpr); _activeExpr = next; } // 切换:先清旧表情残值再激活新表情
      exprSet = true;
      break;
    }
  }
  // ② 情绪动作:【每个】config 配了 emotionMotionMap 的标签都播对应 motion(无表情模型如 Hiyori 用情绪驱动动作;多标签可叠播)。
  const mm = modelCfg.emotionMotionMap;
  if (mm) {
    for (const tag of tags) {
      const mGrp = mm[tag];
      if (mGrp) playMotion(mGrp, undefined, _motionPriority("NORMAL"));
    }
  }
  return exprSet;
}

// 说话口型(无音频):只设 mode/时长,实际口型在统一 ticker 里按 mode 算(model.update 后写=不被动作覆盖)。
function talkPulse(ms) {
  if (imagePack.ready()) return imagePack.talk(ms); // 图片模式:说话差分/摇摆
  if (!model || !(ms > 0)) return;
  _mouth.mode = "talk";
  _mouth.talkEnd = performance.now() / 1000 + ms / 1000;
  _talking = true;
}

// 优化3 真实音频口型（预留接口，借 Soul-of-Waifu / Duix 的振幅口型思路）：
//   用 Web Audio AnalyserNode 取播放音频的实时 RMS 幅度驱动 ParamMouthOpenY，
//   替代 talkPulse 的 Math.random 随机占位，消费侧用真实音频故不漂移。
//   入参可为 <audio>/<video> 元素 或 MediaStream。talkPulse 保留作无音频时的回退。
//   *** 接 TTS 音频时调 talkWithAudio(ttsAudioElement) 即可让口型随真实声音开合 ***
//   beilu 是否有 TTS 出声未定，此处只实现好接口、不强行接线到任何事件。
let audioCtx = null, audioRaf = null, audioSource = null, audioAnalyser = null;
// MediaElementSource 缓存(按元素身份):一个 <audio> 只能 createMediaElementSource 一次,
//   二次调用浏览器抛 InvalidStateError。voice 轨复用同一 <audio> 元素(单实例配音),
//   故每个元素首次建 source 后缓存,后续复播直接复用同一 source 节点。
//   MediaStream 不入缓(每次可新建,且非元素无身份)。WeakMap 让元素销毁时自动回收。
const _elemSourceCache = (typeof WeakMap !== "undefined") ? new WeakMap() : null;
let _audioSourceIsElem = false; // 当前 source 是否元素源(缓存常驻,stopAudioMouth 不断它,只断 analyser 取数支)
/**
 * 真实音频口型驱动（Web Audio AnalyserNode 取播放音频的实时 RMS 幅度驱动 ParamMouthOpenY）。
 *
 * 链路：beilu:voice-audio-start(iframeRenderer 音频桥) → 本函数
 *       → AudioContext.createMediaElementSource/createMediaStreamSource → AnalyserNode
 *       → RAF 循环取 getFloatTimeDomainData → _mouth.audioVal → ticker 统一写 mouthOpen
 * 影响：创建/复用 AudioContext、连接 AnalyserNode、启动 RAF 循环、设 _mouth.mode="audio"
 * 约束：同一 <audio> 元素只能 createMediaElementSource 一次（InvalidStateError），故用 WeakMap 缓存；
 *       音频自然结束时自动 stopAudioMouth
 *
 * @param {HTMLMediaElement|MediaStream} audioElementOrStream - 音频源
 * @returns {boolean} 是否成功启用音频口型（失败时内部已 warn，调用方无需处理）
 */
function talkWithAudio(audioElementOrStream) {
  if (imagePack.ready()) { imagePack.talk(6000); return true; } // 图片模式无口型参:差分/摇摆代真口型,voice-audio-end 停
  if (!model) return false;
  const core = model.internalModel && model.internalModel.coreModel;
  if (!core) return false;
  // 有真实音频接管时切到 audio 模式(统一 ticker 按 mode 驱动口型)。
  stopAudioMouth();
  _talking = true;
  _mouth.mode = "audio"; _mouth.audioVal = 0;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { console.warn("[live2d] 无 Web Audio，回退 talkPulse"); return false; }
  try {
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    // MediaStream → createMediaStreamSource；HTMLMediaElement → createMediaElementSource(缓存)。
    let _isElem = false;
    if (typeof MediaStream !== "undefined" && audioElementOrStream instanceof MediaStream) {
      audioSource = audioCtx.createMediaStreamSource(audioElementOrStream);
    } else {
      _isElem = true;
      // ★ 一个 <audio> 只能 createMediaElementSource 一次:命中缓存复用,否则首建并入缓。
      const cached = _elemSourceCache && _elemSourceCache.get(audioElementOrStream);
      if (cached) {
        audioSource = cached;
      } else {
        audioSource = audioCtx.createMediaElementSource(audioElementOrStream);
        audioSource.connect(audioCtx.destination); // 元素源接回 destination 才出声(只需接一次,缓存后常驻)
        if (_elemSourceCache) _elemSourceCache.set(audioElementOrStream, audioSource);
      }
    }
    audioAnalyser = audioCtx.createAnalyser();
    const analyser = audioAnalyser;
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    audioSource.connect(analyser); // source→analyser 仅取数据(analyser 不接 destination=不二次出声)
    _audioSourceIsElem = _isElem;   // stopAudioMouth 据此决定是否 disconnect source(元素源缓存常驻,不断)
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);          // 0~1 的能量
      _mouth.audioVal = Math.min(1, rms * 6);           // 增益放大;实际写参在统一 ticker(model.update 后)
      audioRaf = requestAnimationFrame(tick);
    };
    // 音频自然结束时归零并停掉分析。
    if (audioElementOrStream && audioElementOrStream.addEventListener) {
      audioElementOrStream.addEventListener("ended", stopAudioMouth, { once: true });
    }
    tick();
    return true;
  } catch (e) {
    console.warn("[live2d] talkWithAudio 失败，回退 talkPulse:", e.message);
    stopAudioMouth();
    return false;
  }
}

function stopAudioMouth() {
  if (imagePack.ready()) { imagePack.stopTalk(); return; } // 图片模式:停差分回当前表情
  if (audioRaf) { cancelAnimationFrame(audioRaf); audioRaf = null; }
  // analyser 是每次新建的取数支:断它(从 source 摘下),不影响 source→destination 出声。
  if (audioSource && audioAnalyser) { try { audioSource.disconnect(audioAnalyser); } catch (e) {} }
  if (audioAnalyser) { try { audioAnalyser.disconnect(); } catch (e) {} audioAnalyser = null; }
  // 元素源缓存常驻(连着 destination 继续出声),不断;仅 MediaStream 源(非缓存)整体断开。
  if (audioSource && !_audioSourceIsElem) { try { audioSource.disconnect(); } catch (e) {} }
  audioSource = null;
  _talking = false;
  if (_mouth.mode === "audio") _mouth.mode = "idle";
}

// 待机+拖动动态(数值框架):全帧率无关(用 ticker dt),柔和不抖。
//   ① 视线=相干噪声漂移(连续可导,非随机跳)②待机嘴=sin+噪声微调(破机械周期)
//   ③拖动身体倾=临界阻尼弹簧(ζ=1 不过冲=不抖)驱动 ParamBodyAngleZ(非整体旋转,头发 physics 自动二次摆)。
//   眨眼/呼吸/头发 physics 库自动(保留);talkWithAudio RMS 口型保留。无对应参数的模型(如 mao_pro 无 mouthOpen/Wanko 非人形)优雅跳过。
let _expElapsedMs = 0; // 累计毫秒(供 internalModel.update 的 elapsed 入参;我方直跑真管线,不再用库累加器)
function startIdleFace() {
  if (!app || !app.ticker) return;
  app.ticker.add(() => {
    if (!model) return;
    const deltaMS = app.ticker.deltaMS || 16.7;
    // ★ 统一管线第①步:手动跑【真·更新管线】(动作/呼吸/物理/眨眼/表情)。
    //   根因(实测 vendor/cubism4.min.js):Live2DModel.update(t) 只 `this.deltaTime+=t` 累加,【不】跑管线;
    //   真正的 internalModel.update(=motion→saveParameters→…→coreModel.update→loadParameters)被 pixi-live2d-display
    //   推迟到 _render 里执行(`this.deltaTime&&(this.internalModel.update(...),this.deltaTime=0)`)。
    //   故原"model.update(deltaMS) 之后写参"= 写在【真管线尚未跑】之时:随后 _render 跑管线,其末尾 coreModel.loadParameters()
    //   把【saveParameters 快照(=我写参之前的值)】恢复,Add 表情参(如 ParamBrowLForm)被抹回基值 → 表情切换后丢、读值随相位漂移。
    //   修(框架级):此处直接调 internalModel.update 跑真管线,并消费掉 deltaTime(置 0)使 _render 不再重复跑管线;
    //   之后写的【我的参数】(表情/眼/口型/身体倾)落在真管线之后 → 必成渲染前最终值,不被 loadParameters 覆盖。
    try {
      const im = model.internalModel;
      if (im && typeof im.update === "function") {
        // internalModel.update(deltaMS, elapsedMS):内部自行 /1000 转秒。elapsed 累计毫秒,我方自维护(不再走累加器)。
        _expElapsedMs += deltaMS;
        im.update(deltaMS, _expElapsedMs);
        model.deltaTime = 0; // 消费:阻止 _render 再次 internalModel.update(避免双更新 + 表情被二次 loadParameters 抹除)
      } else {
        model.update(deltaMS); // 兜底(非预期构建):退回旧行为,不崩
      }
    } catch (e) {}
    const core = model.internalModel && model.internalModel.coreModel;
    if (!core) return;
    // ★ 第②步:在 update 之后写【我的参数】=绝不被动作覆盖(根治 mao 口型被 Idle 动作盖)。
    const dt = Math.min(0.05, deltaMS / 1000);
    const t = performance.now() / 1000;
    // T-A 表情贴参:先于我方 gaze/blink/mouth 贴表情(管眉/颊/口型基线),让我方眼/口型随后最终覆盖。
    //   按 exp3 的 Blend 直写 coreModel(SDK expressionManager 已置 null,不再覆盖)。
    _applyActiveExpr();
    // 视线:相干噪声(时间函数,帧率无关)。eyeTrack(跟随鼠标,库 focusController 驱动同参数)开启时自主游移让位——防双驱动打架。
    const g = _dyn("gaze");
    if (g.enabled && _dyn("eyeTrack").enabled !== true) {
      _setP("eyeBallX", _noiseGX(t * g.noiseScale) * g.ampX);
      _setP("eyeBallY", _noiseGY(t * g.noiseScale) * g.ampY);
    }
    // 自动眨眼兜底:仅当库自带 eyeBlink 未激活时驱动(否则交库,避免双驱动)。状态机:idle→closing→opening→idle。
    //   写 ParamEyeLOpen/ParamEyeROpen(model.update 之后写=不被动作覆盖;无该参数的模型由 _setP 优雅跳过)。
    const bl = _dyn("blink");
    if (bl.enabled && !_blink.libActive) {
      if (_blink.phase === "idle") {
        if (_blink.nextAt === 0) _blink.nextAt = t + bl.minGap + Math.random() * (bl.maxGap - bl.minGap);
        if (t >= _blink.nextAt) { _blink.phase = "closing"; _blink.t0 = t; }
      } else if (_blink.phase === "closing") {
        const p = Math.min(1, (t - _blink.t0) / bl.close);
        _blink.open = 1 - p;
        if (p >= 1) { _blink.phase = "opening"; _blink.t0 = t; }
      } else if (_blink.phase === "opening") {
        const p = Math.min(1, (t - _blink.t0) / bl.close);
        _blink.open = p;
        if (p >= 1) { _blink.phase = "idle"; _blink.open = 1; _blink.nextAt = t + bl.minGap + Math.random() * (bl.maxGap - bl.minGap); }
      }
      _setP("eyeLOpen", _blink.open);
      _setP("eyeROpen", _blink.open);
    }
    // 口型:统一按 mode 驱动(audio RMS / talk 脉冲 / idle 呼吸)。
    if (_mouth.mode === "audio") {
      _setP("mouthOpen", _mouth.audioVal);
    } else if (_mouth.mode === "talk") {
      if (t > _mouth.talkEnd) { _mouth.mode = "idle"; _talking = false; _setP("mouthOpen", 0); }
      else {
        if (t - _mouth.lastPulse > 0.09) { _mouth.lastPulse = t; _mouth.pulse = Math.random() * 0.85; } // 90ms 换一次开合
        _setP("mouthOpen", _mouth.pulse);
      }
    } else {
      const m = _dyn("idleMouth");
      if (m.enabled) {
        const jit = 1 + m.jitter * _noiseMouth(t * 0.5);
        _setP("mouthOpen", Math.max(0, m.base + m.amp * Math.sin(t * 2 * Math.PI / m.period) * jit));
      }
    }
    // 拖动身体倾:目标柔和回 0 + 临界阻尼弹簧 → ParamBodyAngleZ(无则极轻 rotation 兜底)。
    const d = _dyn("drag");
    _lean.target *= Math.exp(-dt / d.targetTau);
    const s = springCritical(_lean.pos, _lean.vel, _lean.target, d.halflife, dt);
    _lean.pos = s.x; _lean.vel = s.v;
    if (Math.abs(_lean.pos) > 1e-4 || Math.abs(_lean.target) > 1e-4) {
      if (_hasParam(_pid("bodyAngleZ"))) _setP("bodyAngleZ", _lean.pos);
      else if (model) model.rotation = (_lean.pos * Math.PI / 180) * 0.5;
    } else if (model && model.rotation) { model.rotation = 0; }
  });
}

// ── 动作(motion)系统(借 airi 单一驱动口 + idle motionFinish 自重启范式;pixi-live2d model.motion API) ──
//   缺口:renderer 原本无 model.motion/idle 循环/点击,idleMotionGroup 配了从不读(三模型动作组全死)。
//   优先级:pixi-live2d MotionPriority NONE0/IDLE1/NORMAL2/FORCE3。idle 用 IDLE,被 tap/emotion(NORMAL)覆盖,其结束 motionFinish 回 idle。
function _motionPriority(name) {
  const MP = window.PIXI && PIXI.live2d && PIXI.live2d.MotionPriority;
  if (MP && MP[name] != null) return MP[name];
  return { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 }[name] != null ? { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 }[name] : 2;
}
function _hasMotionGroup(group) {
  try {
    const defs = model && model.internalModel && model.internalModel.motionManager && model.internalModel.motionManager.definitions;
    return !!(defs && defs[group] && defs[group].length);
  } catch (e) { return false; }
}
// 动作组多策略解析(不完全硬编码):配置 > 动作组名别名匹配 > 位置回退。免逐模型写死 "Idle"/"TapBody"。
function _motionGroupNames() {
  try { const defs = model.internalModel.motionManager.definitions; return defs ? Object.keys(defs) : []; } catch (e) { return []; }
}
function _matchGroup(groups, aliases) {
  for (const a of aliases) { const g = groups.find((n) => n.toLowerCase().indexOf(a) >= 0); if (g) return g; }
  return null;
}
function _idleGroup() {
  const cfg = modelCfg && modelCfg.idleMotionGroup;
  if (cfg && _hasMotionGroup(cfg)) return cfg;
  const groups = _motionGroupNames();
  return _matchGroup(groups, ["idle", "wait", "loop", "stand"]) || groups[0] || "Idle";
}
function _tapGroup() {
  const cfg = modelCfg && modelCfg.tapMotionGroup;
  if (cfg && _hasMotionGroup(cfg)) return cfg;
  const groups = _motionGroupNames();
  const idle = _idleGroup();
  return _matchGroup(groups, ["tap", "touch", "body", "click", "poke", "head"]) || groups.find((g) => g !== idle) || groups[0] || "TapBody";
}
// 播放动作。group=动作组名(model3.json Motions 的键,如 Idle/TapBody);index 省略=组内随机;priority 省略=NORMAL。
function playMotion(group, index, priority) {
  if (imagePack.ready()) return false; // 图片模式无动作系统(优雅跳过)
  if (!model || !group) return false;
  if (!_hasMotionGroup(group)) return false;
  try {
    model.motion(group, index, priority != null ? priority : _motionPriority("NORMAL"));
    return true;
  } catch (e) { console.warn("[live2d] playMotion 失败:", e.message); return false; }
}
// idle 循环:播 idle 组,motionFinish 后自重启(airi 范式)。autoInteract:false 不自动放 idle,故手动接。
let _idleBound = false;
function startIdleLoop() {
  const grp = _idleGroup();
  if (!_hasMotionGroup(grp)) return; // 无 idle 组:靠库自带 eyeBlink/breath 微动
  const mm = model.internalModel.motionManager;
  // 待机动作循环开关(dynamics.motion.idleLoop):关则不放 idle(motionFinish 也不重启=自然停);开则照旧。
  const playIdle = () => { if (_dyn("motion").idleLoop === false) return; playMotion(grp, undefined, _motionPriority("IDLE")); };
  if (!_idleBound && mm && mm.on) {
    mm.on("motionFinish", () => { try { playIdle(); } catch (e) {} });
    _idleBound = true;
  }
  playIdle();
}
// 点击角色 → tap 动作(model_dict.tapMotionGroup,默认 TapBody)。dynamics.motion.tap=false 时不响应点击。
function playTap() {
  if (_dyn("motion").tap === false) return false;
  if (imagePack.ready()) return imagePack.tap(); // 图片模式:轻弹反馈
  const tapGrp = _tapGroup();
  return playMotion(tapGrp, undefined, _motionPriority("NORMAL"));
}
// airi model.on('hit') 范式。注:autoInteract:false 下 pixi 不装指针监听、'hit' 不派发,
//   故桌面壳(live2d-pet.html)点击时直接调 window.beiluLive2d.tap();此处 'hit' 作 autoInteract:true 时的兜底。
function bindTap() {
  if (!model || !model.on) return;
  try { model.on("hit", () => playTap()); } catch (e) { /* 不支持 hit 则靠壳侧 tap() */ }
}

// ── 用户自制触碰热区(凛倾 2026-07-09:"用户基于展示圈角色的点击范围""画出来区域然后选区",类似游戏角色点击) ──
//   数据随形象单源:图片包=pack.json.hitAreas / Live2D=usermodel 条目.hitAreas(dict 合并后进 modelCfg)。
//   区形状=用户手绘套索多边形:{name, poly:[[x,y],...] 归一化 0-1,action:{type:"say"|"emotion"|"motion"|"tap", value}}。
//   坐标系锚定【形象基准框 _hitFrame】(live2d=模型实际体型 fit 框/图片=图片显示框),非渲染容器——
//   容器留白与宽高比在 web 预览和桌面窗不同,按容器切割=跨端命中错位(凛倾纠偏"机械切割")。
//   消费:桌面壳点击先 hitAt(clientX,clientY),命中(射线法点在多边形内)=执行动作返回 true;未命中=false 壳回落默认 tap。
function _currentHitAreas() {
  if (imagePack.ready()) return imagePack.getHitAreas();
  return (modelCfg && Array.isArray(modelCfg.hitAreas)) ? modelCfg.hitAreas : [];
}
// ── Live2D 部件级命中(2026-07-09 凛倾"看游戏触碰怎么识别范围"后重做):范围=ArtMesh drawable 集合,非静态多边形。 ──
//   vendor cubism4.min.js(pixi-live2d-display)实证链:model3.json HitAreas:[{Id,Name}] → internalModel.hitAreas
//   → hitTest(x,y)=对每区 getDrawableBounds(index)【实时包围盒,随动作变形】判点在内 → 返回区名数组;
//   另暴露 getDrawableIDs()/getDrawableBounds(i) → 未标 HitAreas 的模型同样可做任意部件识别。
//   故 live2d 区数据={name, drawables:[部件id,...]},命中随模型动作实时跟形;图片包(静态图无部件)用套索多边形。
function _toModelXY(clientX, clientY) { // host 客户坐标 → 模型局部坐标(hitTest/isHit 同一变换)
  try {
    const hr = hostEl.getBoundingClientRect();
    const px = clientX - hr.left, py = clientY - hr.top; // canvas 填满 host → stage 坐标
    const pt = model.toModelPosition ? model.toModelPosition({ x: px, y: py }) : null;
    return pt ? [pt.x, pt.y] : null;
  } catch (e) { return null; }
}
function _drawableIndexOf(id) {
  try { return model.internalModel.coreModel.getDrawableIndex ? model.internalModel.coreModel.getDrawableIndex(id) : -1; } catch (e) { return -1; }
}
function _pointInDrawable(mx, my, index) {
  try {
    const b = model.internalModel.getDrawableBounds(index); // 实时 bounds(模型局部系)
    return b && mx >= b.x && mx <= b.x + b.width && my >= b.y && my <= b.y + b.height;
  } catch (e) { return false; }
}
/** 点击点命中的全部部件 id(编辑器"点选部件"用;返回按 bounds 面积升序=最贴合的排前)。 */
function drawablesAt(clientX, clientY) {
  if (imagePack.ready() || !model) return [];
  const m = _toModelXY(clientX, clientY);
  if (!m) return [];
  const out = [];
  try {
    const ids = model.internalModel.getDrawableIDs ? model.internalModel.getDrawableIDs() : [];
    for (let i = 0; i < ids.length; i++) {
      if (_pointInDrawable(m[0], m[1], i)) {
        const b = model.internalModel.getDrawableBounds(i);
        out.push({ id: ids[i], index: i, area: (b && b.width * b.height) || 0 });
      }
    }
    out.sort((a, b2) => a.area - b2.area);
  } catch (e) { /* 枚举失败:空 */ }
  return out.map(d => ({ id: d.id, index: d.index }));
}
/** 部件实时 bounds → host px 框(编辑器高亮/可视化)。 */
function drawableBoundsHost(id) {
  try {
    if (imagePack.ready() || !model) return null;
    const i = _drawableIndexOf(id);
    if (i < 0) return null;
    const b = model.internalModel.getDrawableBounds(i); // 模型局部系
    // 局部→host:两角经 localTransform+model 世界变换。pixi-live2d-display 的 toModelPosition 是逆变换,
    // 这里用 model.localTransform? 稳妥路:用 model.getBounds 同源的 worldTransform 应用两角。
    const wt = model.transform && model.transform.worldTransform;
    if (!wt) return null;
    const drawMx = model.internalModel.localTransform; // 模型局部 → model 容器坐标
    const p1 = drawMx.apply({ x: b.x, y: b.y }); const p2 = drawMx.apply({ x: b.x + b.width, y: b.y + b.height });
    const w1 = wt.apply(p1); const w2 = wt.apply(p2);
    return { x: Math.min(w1.x, w2.x), y: Math.min(w1.y, w2.y), w: Math.abs(w2.x - w1.x), h: Math.abs(w2.y - w1.y) };
  } catch (e) { return null; }
}
/** 模型自带 HitAreas 声明名(作者在 Cubism Editor 标注;有=现成部位区可直接选用)。 */
function modelHitAreaNames() {
  try { return (!imagePack.ready() && model) ? Object.keys(model.internalModel.hitAreas || {}) : []; } catch (e) { return []; }
}
// 形象基准框(host 内 px):图片=img 真实显示框;live2d=relayout 同式推导(单位体型×fit×userScale,中心=xShift/yShift)。
// 两端(web 预览/桌面窗)同一公式 → 同一归一化坐标 → 圈哪打哪。
function _hitFrame() {
  if (imagePack.ready()) return imagePack.fitRect();
  if (!model || !hostEl || !_unitDims) return null;
  const w = hostEl.clientWidth, h = hostEl.clientHeight;
  if (!w || !h) return null;
  const userScale = (modelCfg && modelCfg.scale) || 1;
  const xShift = (modelCfg && modelCfg.xShiftRatio != null) ? modelCfg.xShiftRatio : 0.5;
  const yShift = (modelCfg && modelCfg.yShiftRatio != null) ? modelCfg.yShiftRatio : 0.5;
  const fit = Math.min(w / _unitDims.uw, h / _unitDims.uh) * userScale;
  const fw = _unitDims.uw * fit, fh = _unitDims.uh * fit;
  return { x: w * xShift - fw / 2, y: h * yShift - fh / 2, w: fw, h: fh };
}
// 形状命中(归一化基准框坐标):poly=射线法;rect=包围盒;circle=cx,cy,r(r 归一化于宽,dy 按框宽高比校正=屏幕真圆)。
function _shapeHit(nx, ny, sh, f) {
  try {
    if (sh.kind === "poly" && Array.isArray(sh.points) && sh.points.length >= 3) return _pointInPoly(nx, ny, sh.points);
    if (sh.kind === "rect") return nx >= sh.x && nx <= sh.x + sh.w && ny >= sh.y && ny <= sh.y + sh.h;
    if (sh.kind === "circle") {
      const dx = nx - sh.cx, dy = (ny - sh.cy) * (f.h / f.w);
      return dx * dx + dy * dy <= sh.r * sh.r;
    }
  } catch (e) { /* 形状数据异常:视为未命中 */ }
  return false;
}
// 射线法点在多边形内(标准 even-odd ray casting)。
function _pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function hitAt(clientX, clientY, gesture) {
  // gesture(壳侧识别,判据=caps.hitLimits):"click"|"press"|"stroke";缺省 click。识别层产出={区,手势},
  // 反馈层结构=凛倾自设计——查找口:区.actions[手势] 优先,无则区.action(不分手势)。
  gesture = gesture || "click";
  try {
    if (!hostEl) return false;
    const areas = _currentHitAreas();
    if (!areas.length) return false;
    const hr = hostEl.getBoundingClientRect();
    // live2d 命中素材(一次算,循环复用):模型局部点 + 自带 HitArea 命中名
    let mxy = null, hitNames = [];
    if (!imagePack.ready() && model) {
      mxy = _toModelXY(clientX, clientY);
      try { hitNames = model.hitTest ? model.hitTest(clientX - hr.left, clientY - hr.top) : []; } catch (e) { hitNames = []; }
    }
    // 套索兜底素材(图片包主路/live2d 无部件区时)
    const f = _hitFrame();
    for (const a of areas) {
      if (!a) continue;
      // ① 部件集合区(live2d 首选:实时随动作变形)
      if (Array.isArray(a.drawables) && a.drawables.length && mxy) {
        for (const id of a.drawables) {
          const i = _drawableIndexOf(id);
          if (i >= 0 && _pointInDrawable(mxy[0], mxy[1], i)) { _execHitAction(a, gesture); return true; }
        }
        continue;
      }
      // ② 模型自带 HitArea 名(作者声明区,hitTest 已实时判定)
      if (a.hitArea && hitNames.includes(a.hitArea)) { _execHitAction(a, gesture); return true; }
      // ③ 形状区(编辑器2.0:shape={kind:poly|circle|rect};旧 poly 字段=poly 形状兼容),坐标锚定形象基准框
      const sh = (a.shape && typeof a.shape === "object") ? a.shape
        : ((Array.isArray(a.poly) && a.poly.length >= 3) ? { kind: "poly", points: a.poly } : null);
      if (sh && f && f.w && f.h) {
        const nx = (clientX - hr.left - f.x) / f.w, ny = (clientY - hr.top - f.y) / f.h;
        if (_shapeHit(nx, ny, sh, f)) { _execHitAction(a, gesture); return true; }
      }
    }
  } catch (e) { /* 命中失败不影响默认点击 */ }
  return false;
}
// 触发计数(凛倾触碰设计③"次数的细分"):同区同手势在窗口(countResetMs,数据经区或宿主无从取——
//   窗口值随区数据 a.countResetMs 优先,缺省用注入的 _hitCountResetMs,再缺省=不重置只累计)。
let _hitCounters = {}; // {区名/手势: {n, at}}
let _hitCountResetMs = 0; // 宿主注入(web=caps;桌面=pet-config 下发 hitLimits.countResetMs)
function setHitCountResetMs(ms) { _hitCountResetMs = Number(ms) || 0; }
function _hitCount(a, gesture) {
  const key = `${(a && a.name) || "?"}\u0000${gesture}`;
  const now = Date.now();
  const win = Number(a && a.countResetMs) || _hitCountResetMs; // 区级可覆盖(用户数据),缺省宿主注入值
  let rec = _hitCounters[key];
  if (!rec || (win > 0 && now - rec.at > win)) rec = { n: 0, at: now };
  rec.n++; rec.at = now;
  _hitCounters[key] = rec;
  return rec.n;
}
function _execHitAction(a, gesture) {
  gesture = gesture || "click";
  // 反馈结构(凛倾 2026-07-09 触碰设计):区.reactions[手势]=[{step:第N次起生效,type,value}] 按累计次数取
  //   ≤count 的最大 step 档(step 缺省 1);无 reactions 回落 区.actions[手势] > 区.action(简单单反应)。
  let act = null;
  const list = a && a.reactions && a.reactions[gesture];
  if (Array.isArray(list) && list.length) {
    const count = _hitCount(a, gesture);
    let best = null;
    for (const it of list) {
      const st = Number(it && it.step) || 1;
      if (st <= count && (!best || st >= (Number(best.step) || 1))) best = it;
    }
    act = best;
  }
  if (!act) act = (a && a.actions && a.actions[gesture]) || (a && a.action) || {};
  const v = act.value != null ? String(act.value) : "";
  switch (act.type) {
    case "say": { // 台词池(设计①):值=多行,每行一条,随机说一条。文本全来自用户配置,代码不产生。
      const lines = v.split("\n").map(s => s.trim()).filter(Boolean);
      const t = lines.length ? lines[Math.floor(Math.random() * lines.length)] : "";
      if (t) {
        try { window.dispatchEvent(new CustomEvent("beilu:pet-hit-say", { detail: { text: t, area: (a && a.name) || "", gesture } })); } catch (e) { /* 宿主未监听:静默 */ }
        talkPulse(Math.min(6000, 600 + t.length * 90));
      }
      break;
    }
    case "send": { // 发给 AI(设计②):用户预设内容作为用户消息,回应走陪伴气泡链。渲染层只发事件,链路在宿主。
      const t = v.trim();
      if (t) { try { window.dispatchEvent(new CustomEvent("beilu:pet-hit-send", { detail: { text: t, area: (a && a.name) || "", gesture } })); } catch (e) { /* 宿主未监听:静默 */ } }
      break;
    }
    case "emotion": if (v) setEmotion(v); break;
    case "motion": if (v) playMotion(v); break;
    default: playTap();
  }
}

// ── 拖动跟随(数值框架):拖桌宠时身体软倾(驱动 ParamBodyAngleZ,非整体旋转),松手临界阻尼柔和归位。 ──
//   nudge 只设倾斜【目标】(deadZone 防微抖 + 映射 + clamp);收敛在 startIdleFace 的临界阻尼弹簧里(ζ=1 不过冲=不抖,帧率无关)。
//   驱动 body 参数 → physics3.json 头发/衣服自动二次摆(Disney follow-through),自然柔和。
function nudge(vx) {
  if (imagePack.ready()) return imagePack.nudge(vx); // 图片模式:CSS 轻倾回正
  if (!model) return;
  const d = _dyn("drag");
  if (!d.enabled) return;
  if (Math.abs(vx || 0) < d.deadZone) return; // dead-zone:手微动不触发,防抖
  _lean.target += (vx || 0) * d.gain;
  _lean.target = Math.max(-d.maxTarget, Math.min(d.maxTarget, _lean.target));
}

// ── 像素级命中二级判定(T3 airi 式,凛倾拍板 tasks#11) ──
// 包围盒(_metrics().bounds=model.getBounds)是矩形,Live2D 角色四肢间大片透明区也算"命中"→挡住桌面点击。
// 本探针读渲染结果单点 alpha:透明=穿透。实现=PIXI ticker 的渲染回调【之后】(UTILITY 优先级<render 的 LOW)
// 同帧 gl.readPixels 默认帧缓冲——同一 JS task 内读,不需要 preserveDrawingBuffer(合成器换帧前缓冲仍持本帧内容)。
// latest-wins:同帧只留最新探针(旧的以 null 解决=降级包围盒);任何异常=null,诚实降级不编造。
// 阈值与图片包魔法棒同源(imagePack.alphaHitThreshold,pet_settings.alphaHitThreshold 单源下发),不抄副本。
let _pxProbe = null; // {x,y,resolve} 挂起探针(client px)
let _pxTickerOn = false;
function _ensurePixelTicker() {
  if (_pxTickerOn || !app) return;
  _pxTickerOn = true;
  const PIXI = window.PIXI;
  const pri = (PIXI && PIXI.UPDATE_PRIORITY && typeof PIXI.UPDATE_PRIORITY.UTILITY === "number") ? PIXI.UPDATE_PRIORITY.UTILITY : -50;
  app.ticker.add(() => {
    if (!_pxProbe) return;
    const { x, y, resolve } = _pxProbe;
    _pxProbe = null;
    try {
      const gl = app.renderer && app.renderer.gl;
      const view = app.view;
      if (!gl || !view) { resolve(null); return; }
      const r = view.getBoundingClientRect();
      if (!r.width || !r.height) { resolve(null); return; }
      // client px → 物理缓冲 px(drawingBuffer 尺寸=CSS 尺寸×resolution,resolution 运行时可变:441 行动态设);
      // GL 原点在左下 → y 翻转。
      const px = Math.round((x - r.x) * (gl.drawingBufferWidth / r.width));
      const py = Math.round(gl.drawingBufferHeight - (y - r.y) * (gl.drawingBufferHeight / r.height) - 1);
      if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) { resolve(false); return; }
      const buf = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      resolve(buf[3] > imagePack.alphaHitThreshold());
    } catch (e) { resolve(null); }
  }, null, pri);
}
/** 像素级命中:Promise<true 不透明/false 透明/null 无法判定(调用方降级包围盒)>。图片包走 canvas 单点采样同语义。 */
function pixelHitAt(clientX, clientY) {
  if (imagePack.ready()) return Promise.resolve(imagePack.pixelHitAt(clientX, clientY));
  if (!app || !model) return Promise.resolve(null);
  _ensurePixelTicker();
  return new Promise((resolve) => {
    if (_pxProbe) _pxProbe.resolve(null); // 顶掉旧探针(latest-wins)
    _pxProbe = { x: Number(clientX), y: Number(clientY), resolve };
  });
}

// 优化1 语义 API（借 Soul-of-Waifu 统一接口层，给桌面壳/外部统一驱动 Live2D）：
//   桌宠 deskpet 窗口或外部可 `window.beiluLive2d.setEmotion('happy')` / `.talk(1200)` 直接驱动，
//   内部复用现有 setEmotion/talkPulse/relayout，不另起渲染。
window.beiluLive2d = {
  setEmotion: (name) => setEmotion(name),
  talk: (ms) => talkPulse(ms),
  talkWithAudio: (audioElementOrStream) => talkWithAudio(audioElementOrStream),
  relayout: () => relayout(),
  getModel: () => (imagePack.ready() ? imagePack.getName() : ((modelCfg && modelCfg.name) || "")),
  listModels: () => (Array.isArray(dict) ? dict.map((m) => m.name) : []),
  listImageKeys: () => imagePack.listKeys(),                 // 图片包可用表情键(编辑器/提示词侧读单源;非图片模式=[])
  reloadModel: (name) => reloadModel(name),
  reloadDict: () => reloadDict(),                            // 字典重读+当前形象强制重载(设置页保存微调后即时生效)
  setCharacter: (charName) => setCharacter(charName),        // D-2 按角色卡换模型(经 charModels 映射;无绑定则不动)
  setCharModels: (map) => setCharModels(map),                // 设置 角色名→模型名 映射(设置页/壳运行时下发)
  getCharacter: () => _curChar,                              // 当前角色名(观测/调试)
  getCharModels: () => Object.assign({}, _charModels),       // 当前映射(设置页回显)
  ready: () => !!model || imagePack.ready(),
  playMotion: (group, index, priority) => playMotion(group, index, priority),
  tap: () => playTap(),
  hitAt: (x, y, g) => hitAt(x, y, g),                             // 触碰热区命中(壳传手势 click/press/stroke;false=回落 tap)
  pixelHitAt: (x, y) => pixelHitAt(x, y),                         // 像素级命中二级判定(T3):Promise<true/false/null 无法判定→壳降级包围盒>;live2d=gl.readPixels 单点,图片包=canvas 单点
  hitFrame: () => _hitFrame(),                                    // 形象基准框(host 内 px;套索编辑/坐标换算同源)
  setShiftRatios: (x, y) => { if (modelCfg) { if (x != null) modelCfg.xShiftRatio = Math.max(0, Math.min(1, x)); if (y != null) modelCfg.yShiftRatio = Math.max(0, Math.min(1, y)); if (imagePack.ready()) imagePack.setViewport(modelCfg.xShiftRatio ?? 0.5, modelCfg.yShiftRatio ?? 0.5); else relayout(); } }, // 拖拽定位即时预览(持久化=saveUserModel 同链;图片包走 setViewport,凛倾 2026-07-13"专门显示那一部分")
  getShiftRatios: () => modelCfg ? { x: modelCfg.xShiftRatio != null ? modelCfg.xShiftRatio : 0.5, y: modelCfg.yShiftRatio != null ? modelCfg.yShiftRatio : 0.5 } : null,
  drawablesAt: (x, y) => drawablesAt(x, y),                       // 点选部件:点击点命中的 ArtMesh id 列表(编辑器)
  drawableBoundsHost: (id) => drawableBoundsHost(id),             // 部件实时框(host px;编辑器高亮)
  modelHitAreaNames: () => modelHitAreaNames(),                   // 模型自带 HitArea 声明名(现成部位区)
  setHitCountResetMs: (ms) => setHitCountResetMs(ms),             // 次数细分计数窗口(宿主注入 caps 值;区级 countResetMs 可覆盖)
  setAlphaHitThreshold: (v) => imagePack.setAlphaHitThreshold(v), // 魔法棒 alpha 阈值(pet_settings 单源经 pet-config 下发;去硬编码 2026-07-13)
  imageCurrentFile: () => imagePack.currentFile(),                // 图片包当前显示文件(编辑器 scope 用)
  imageCurrentKey: () => imagePack.currentKey(),                  // 图片包当前表情键(同上)
  snapshot: () => { try { return app && app.view ? app.view.toDataURL("image/png") : ""; } catch (e) { return ""; } }, // live2d 当前帧快照(放大编辑底图)
  nudge: (vx) => nudge(vx),
  setDynamics: (group, patch) => setDynamics(group, patch),       // 人工自主设置:单组(如 drag/gaze/idleMouth)局部调
  applyUserDynamics: (obj) => applyUserDynamics(obj),             // 整体覆盖(pet-settings.dynamics)
  getDynamics: () => ({ gaze: _dyn("gaze"), idleMouth: _dyn("idleMouth"), drag: _dyn("drag") }), // 当前生效值(设置页回显)
  _dynDefaults: () => JSON.parse(JSON.stringify(DYN_DEFAULT)),  // 默认值单源导出(设置页全量滑块回填用,前端不再抄默认副本)
  _imageDynDefaults: () => imagePack.dynDefaults(),             // 图片包动效默认(编辑器占位单源)
  resolveEmotion: (name) => _resolveExpr(name), // 情绪→表情 index 解析(显式配置/名匹配),调试+调试工具用
  _exprDump: () => {
    const out = { mmEm: null, imEm: null, exprIndex: _exprIndex, defs: null, sample: null };
    try {
      const mm = model && model.internalModel && model.internalModel.motionManager;
      out.mmEm = !!(mm && mm.expressionManager);
      const im = model && model.internalModel;
      out.imEm = !!(im && im.expressionManager);
      const em = (mm && mm.expressionManager) || (im && im.expressionManager);
      if (em) {
        const defs = em.definitions || em._definitions || em.expressions;
        out.defs = defs ? (Array.isArray(defs) ? "array:" + defs.length : "obj:" + Object.keys(defs).length) : "none";
        if (defs && defs.length) out.sample = defs.slice(0, 3).map((d) => (d && (d.name || d.Name || d.file || d.File)) || JSON.stringify(d).slice(0, 40));
        out.emKeys = Object.keys(em).slice(0, 15);
      }
    } catch (e) { out.err = e.message; }
    return out;
  },
  _motionInfo: () => {
    if (!model || !model.internalModel) return null;
    const mm = model.internalModel.motionManager;
    const defs = mm && mm.definitions;
    const groups = defs ? Object.keys(defs).reduce((o, g) => { o[g] = (defs[g] && defs[g].length) || 0; return o; }, {}) : null;
    return {
      groups,
      idleGroup: _idleGroup(),
      playing: mm ? !mm.isFinished() : null, // 是否有动作在播(idle 接上即 true)
      current: (mm && mm.state && mm.state.currentGroup != null) ? mm.state.currentGroup : null, // 当前动作组(测试观测用)
    };
  },
  _motionGate: () => ({ effective: _dyn("motion"), user: _userDyn.motion || null }), // 调控接口自省:当前 motion 闸门生效值 + 用户覆盖(诊断/测试)
  _paramVal: (id) => { try { const core = model.internalModel.coreModel; return core.getParameterValueById(id); } catch (e) { return null; } }, // 读单参实时值(白盒验证/调试工具:看参数真动)
  _metrics: () => {
    if (imagePack.ready()) return imagePack.metrics(); // 图片模式:img 天然尺寸+渲染盒(壳侧命中测试/比例上报同形状)
    if (!model) return null;
    const b = model.getBounds();
    return {
      internal: { w: model.internalModel && model.internalModel.width, h: model.internalModel && model.internalModel.height },
      container: { w: model.width, h: model.height, scale: model.scale.x },
      bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      host: { w: hostEl && hostEl.clientWidth, h: hostEl && hostEl.clientHeight },
      rotation: model.rotation,
      lean: _lean.pos,          // 拖动身体倾当前值(度=驱动 ParamBodyAngleZ 的值,观测用)
    };
  },
  _dumpParams: () => {
    const core = model && model.internalModel && model.internalModel.coreModel;
    if (!core) return null;
    // 底层 Live2DCubismCore.Model.parameters: { ids:string[], values/min/max/defaultValues:Float32Array }。
    const raw = core._model || core;
    const p = raw && raw.parameters;
    const out = { hasRaw: !!p, ids: [], coreKeys: [] };
    try { out.coreKeys = Object.keys(core).slice(0, 20); } catch (e) {}
    if (p && p.ids) {
      for (let i = 0; i < p.ids.length; i++) {
        out.ids.push({ id: p.ids[i], val: p.values ? p.values[i] : null, min: p.minimumValues ? p.minimumValues[i] : null, max: p.maximumValues ? p.maximumValues[i] : null, def: p.defaultValues ? p.defaultValues[i] : null });
      }
    }
    return out;
  },
  _faceProbe: () => {
    const core = model && model.internalModel && model.internalModel.coreModel;
    if (!core) return null;
    const g = (id) => { try { return core.getParameterValueById(id); } catch (e) { return null; } };
    return { eyeX: g(_pid("eyeBallX")), eyeY: g(_pid("eyeBallY")), mouth: g(_pid("mouthOpen")), mouthParam: _pid("mouthOpen"), mode: _mouth.mode, talking: _talking };
  },
};

let _eventsBound = false;
function bindEvents() {
  if (_eventsBound) return; // 幂等:image/live2d 两分支入口都调,只绑一次
  _eventsBound = true;
  window.addEventListener("beilu:emotion-changed", (e) => {
    const em = e && e.detail && e.detail.emotion;
    if (em) setEmotion(em);
  });
  // ★ <motion> 标签独立消费：AI 输出 <motion>group</motion> → 后端提取 → WS motion_triggered → 此处直接 playMotion。
  //   与 emotion→emotionMotionMap 路径正交：emotion 改表情+可能播关联动作，motion 只播动作不改表情。
  window.addEventListener("beilu:motion-triggered", (e) => {
    if (e.detail?.motion) playMotion(e.detail.motion);
  });
  // D-2 角色卡切换→换桌宠模型(web 端):订阅既有 producer `beilu:char-changed`(index.mjs:1704 收口派发),
  //   按 charModels 映射换模型(无绑定则不动)。renderer 只查表换模型,不解释"谁是角色"。
  window.addEventListener("beilu:char-changed", (e) => {
    const cn = e && e.detail && e.detail.charName;
    if (cn) setCharacter(cn);
  });
  window.addEventListener("beilu:companion-message", (e) => {
    const t = e && e.detail && e.detail.text;
    if (t) talkPulse(Math.min(6000, 600 + t.length * 90));
  });
  // 口型同步(R-Lip):订阅 iframeRenderer 音频桥派发的 voice 轨播放事实。
  //   start → 把 voice <audio> 交给 talkWithAudio(AudioContext+RMS 真实口型,替待机微张嘴);
  //   end(pause/ended)→ 停 RMS 分析,回 idle 待机微张嘴(stopAudioMouth 把 mode 设回 idle)。
  //   renderer 不认识音频桥,只消费事件;音频元素由桥提供(beilu 管道:TTS/配音生成是角色内容的事)。
  window.addEventListener("beilu:voice-audio-start", (e) => {
    const el = e && e.detail && e.detail.audioEl;
    if (el) talkWithAudio(el); // 失败(无 Web Audio/跨源)内部已回退,不抛
  });
  window.addEventListener("beilu:voice-audio-end", () => {
    stopAudioMouth(); // 停口型 RMS → mode 回 idle(待机微张嘴接管)
  });
  // G1修复: 普通聊天AI文字回复完成时触发口型(文字长度驱动,同companion_message机制)
  window.addEventListener("beilu:ai-reply-done", (e) => {
    const len = e && e.detail && e.detail.contentLength;
    if (len > 0) talkPulse(Math.min(6000, 600 + len * 30));
  });
}
