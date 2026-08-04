/**
 * readiness.mjs — 启动 Readiness 单源注册表（D5 §2.4，2026-08-04）。零重依赖叶子（可单测）。
 *
 * 【功能链】
 *   server.mjs init()（唯一编排 owner）按真实时序打标：
 *     PROCESS_START → LISTENING(/api/ping 可答=transport liveness) → SHELL_READY(HTTP/static/auth/router
 *     + 默认部件浅加载完成，页面可打开可登录) → BACKGROUND_PRELOAD(fullLoadAllParts 转可观察后台任务)
 *   parts_loader.fullLoadAllPartsForUser 逐 Part 上报 loading/loaded/failed → 本表 parts 明细
 *   endpoints GET /api/readiness → getReadinessSnapshot(username) → 启动器(等 shellReady 开浏览器)/前端消费
 *
 * 【与 D5 阶段机的对应】
 *   USER_BOOTSTRAPPING / CHAT_INTERACTIVE 是【per-user】维度，不是全局阶段——用户何时登录/选卡由请求驱动，
 *   编排者无法预知。故全局 stage 走到 SHELL_READY/BACKGROUND_PRELOAD 为止；chatInteractive 按请求所属
 *   user 经注入的探针实时计算（server.mjs setChatInteractiveProbe：该 user 的 chat shell + memory 插件
 *   完整生命周期已在 parts_set 落定）。DEGRADED_PARTS 不倒退任何阶段，只累积在 backgroundPreload.degraded。
 *
 * 【why】/api/ping 只证明 transport 活着（endpoints.mjs:407），launcher 拿它当"应用 ready"开浏览器
 *   → 用户在 24-60s 全量预加载期间面对黑屏（01 §P1-3 / 03 §六实测 24-29s）。分层后：
 *   浏览器在 shellReady 即可打开登录；重部件后台加载且逐 Part 可观察；失败 Part 记 degraded 不装死。
 *
 * 【关联链】← server.mjs(打标/探针注入) ← parts_loader.mjs(逐 Part 上报) ← endpoints.mjs(/api/readiness)
 *   ← path/beilu-always-accompany.ps1(Open-BrowserWhenReady 消费 shellReady)
 *   ← tests/startup_readiness_contract_test.mjs(直接 import 本叶子)
 * 【使用效果】冷启动看到阶段文案；进入聊天可输入时后台仍在准备 N 个扩展；失败 Part 有名称可见。
 * 【边界】P1 召回 warmup 是独立状态机（memory/main.mjs Load 对 tokenizer/scheduler 不 await），
 *   本表不把「full preload 返回」写成「P1 已可召回」（D5 §1.4 不得误归因）。
 */

const STAGE_ORDER = ["PROCESS_START", "LISTENING", "SHELL_READY", "BACKGROUND_PRELOAD"];

const _state = {
  startedAt: Date.now(),
  stage: "PROCESS_START",
  stages: [{ stage: "PROCESS_START", at: Date.now(), sinceStartMs: 0 }],
  backgroundPreload: { state: "pending", startedAt: null, endedAt: null }, // pending|running|done
  /** @type {Map<string, {username:string, partpath:string, state:string, error:string|null, updatedAt:number}>} */
  parts: new Map(),
};

let _chatInteractiveProbe = null;

/** server.mjs 注入 per-user chat 可交互探针（username → boolean）。 */
export function setChatInteractiveProbe(fn) {
  if (typeof fn === "function") _chatInteractiveProbe = fn;
}

/** 阶段打标（只前进不倒退，重复打标幂等；未知阶段名拒绝，防拼写产出幽灵阶段）。 */
export function markReadinessStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return false;
  if (STAGE_ORDER.indexOf(_state.stage) >= idx) return false;
  _state.stage = stage;
  _state.stages.push({ stage, at: Date.now(), sinceStartMs: Date.now() - _state.startedAt });
  return true;
}

/** 后台全量预加载状态（server.mjs 编排调用）。 */
export function setBackgroundPreloadState(state) {
  if (state === "running" && _state.backgroundPreload.state === "pending") {
    _state.backgroundPreload.state = "running";
    _state.backgroundPreload.startedAt = Date.now();
  } else if (state === "done" && _state.backgroundPreload.state !== "done") {
    _state.backgroundPreload.state = "done";
    _state.backgroundPreload.endedAt = Date.now();
  }
}

/** parts_loader 逐 Part 上报预加载状态：loading | loaded | failed。 */
export function reportPartPreloadState(username, partpath, state, error = null) {
  const key = `${username}\0${partpath}`;
  const prev = _state.parts.get(key);
  // DEGRADED 不倒退：已 failed 的 Part 不被后续 loading 覆盖成"看起来在恢复"，除非真实 loaded
  if (prev?.state === "failed" && state === "loading") return;
  _state.parts.set(key, {
    username, partpath, state,
    error: error ? String(error).slice(0, 500) : null,
    updatedAt: Date.now(),
  });
}

/**
 * 手动重试恢复上报（/api/loadpart 成功后调用）：只更新【已在册】条目——
 * 预加载清单外的普通懒加载不进本表（否则计数被请求路径噪声污染）。
 */
export function markPartPreloadRecovered(username, partpath) {
  const key = `${username}\0${partpath}`;
  if (!_state.parts.has(key)) return false;
  _state.parts.set(key, { username, partpath, state: "loaded", error: null, updatedAt: Date.now() });
  return true;
}

/** 全量快照（/api/readiness 响应体）。username 缺省=不含 per-user 维度。 */
export function getReadinessSnapshot(username = null) {
  const parts = [..._state.parts.values()];
  const counts = { total: parts.length, loaded: 0, failed: 0, loading: 0 };
  for (const p of parts) counts[p.state] = (counts[p.state] || 0) + 1;
  const degraded = parts.filter((p) => p.state === "failed").map((p) => ({
    username: p.username, partpath: p.partpath, error: p.error,
  }));
  let chatInteractive = null;
  if (username && _chatInteractiveProbe) {
    try { chatInteractive = !!_chatInteractiveProbe(username); } catch { chatInteractive = null; }
  }
  return {
    stage: _state.stage,
    stages: [..._state.stages],
    startedAt: _state.startedAt,
    uptimeMs: Date.now() - _state.startedAt,
    shellReady: STAGE_ORDER.indexOf(_state.stage) >= STAGE_ORDER.indexOf("SHELL_READY"),
    backgroundPreload: { ..._state.backgroundPreload, counts, degraded },
    user: username || null,
    chatInteractive, // null=未认证/探针未注入；true/false=该 user 的 chat shell+memory 完整生命周期是否落定
  };
}

/** 最小快照（非本机且未认证的请求）：只回答阶段与 shellReady，不暴露 Part 明细/用户维度。 */
export function getReadinessSnapshotMinimal() {
  return {
    stage: _state.stage,
    shellReady: STAGE_ORDER.indexOf(_state.stage) >= STAGE_ORDER.indexOf("SHELL_READY"),
    uptimeMs: Date.now() - _state.startedAt,
  };
}
