/**
 * beilu-eye 共享注入状态
 *
 * 这个模块是 beilu-eye 插件和 beilu-chat 端点之间的桥梁。
 * ES 模块在同一进程中是单例的，所以两边 import 同一个模块实例。
 *
 * 流程：
 * 1. Electron 客户端 POST → beilu-chat 端点 → setPendingInjection()
 * 2. 前端 pollEyeStatus 轮询 → /api/eye 端点 → consumePendingInjection()（GetPrompt 路径已移除）
 * 3. AI 回复后，注入数据已清除，后续对话不再包含截图
 */

/**
 * 按 username 分区的待注入截图数据。
 *
 * ⚠️ 串台修复（J6）：模块单例在整个进程内被所有 user 共享。原 `_pendingInjection` 是模块级单槽，
 *   多用户共用一个 beilu 实例时，A 用户截图会被 B 用户的轮询消费/注入。
 *   现按 username 分区（Map<username|"", state>），范式源自原 beilu-browser injection_state（N9，该插件 2026-07-16 已删）：
 *   精确键优先 → 缺失回落兜底键 ""。
 *   分区维度=username：截图安全/配置（eye_config.json）本就按 username 存，注入语义=用户级。
 *   有 username 上下文的调用点（/api/eye/* 认证路由、/api/eye/inject 的 body.username、gameCompanion）传精确键；
 *   无 username 上下文的调用点（beilu-eye/main.mjs 的 GetData/SetData parts 接口）落兜底键 ""。
 * @type {Map<string, { image: string, message: string, mode: string, requestId: string, timestamp: number, ttlMs: number }>}
 */
const _pendingInjections = new Map(); // Map<username|"", state>

/** 注入数据默认 TTL（毫秒）：用户未配置 injectionTtlMs 时的兜底值 */
const INJECTION_TTL_MS_DEFAULT = 60_000;

/** 归一化分区键（null/undefined/非字符串 → 兜底键 ""）。 */
function _scopeKey(username) {
  return typeof username === "string" && username ? username : "";
}

/**
 * 取本用户有效 pending（含 TTL 过期清理）：精确键 → 兜底键 ""。
 * 过期或缺失返回 null（并清掉命中的过期键）。
 * FT5 A-③: TTL 读 per-injection ttlMs（来自用户 eye_config.json.injectionTtlMs），不再写死 60s。
 * @param {string} [username]
 * @returns {object|null}
 */
function _getValid(username) {
  const k = _scopeKey(username);
  let entry = _pendingInjections.has(k) ? _pendingInjections.get(k) : null;
  let hitKey = k;
  if (!entry && k !== "" && _pendingInjections.has("")) {
    entry = _pendingInjections.get("");
    hitKey = "";
  }
  if (!entry) return null;
  const age = Date.now() - entry.timestamp;
  const ttl = entry.ttlMs || INJECTION_TTL_MS_DEFAULT;
  if (age > ttl) {
    console.log(
      "[beilu-eye] pending 注入已过期，自动清理",
      "| age:",
      Math.round(age / 1000),
      "秒",
      "| TTL:",
      Math.round(ttl / 1000),
      "秒",
      "| user:",
      hitKey || "(兜底)",
    );
    _pendingInjections.delete(hitKey);
    return null;
  }
  return entry;
}

/**
 * 设置待注入的截图数据（按 username 分区）
 * FT5 A-③: 单槽模型 — 每用户分区内每次 set 直接覆盖旧值，故"旧截图全 hide 只发最新一张"由
 * 每用户队列深度恒 1 天然保证。ttlMs 由用户 injectionTtlMs 传入，缺省走兜底 60s。
 * @param {{ image: string, message: string, mode?: string, ttlMs?: number }} data
 * @param {string} [username] 无则落兜底键 ""
 */
export function setPendingInjection(data, username) {
  const entry = {
    image: data.image,
    message: data.message || "",
    mode: data.mode || "passive",
    // 陪伴“本句话附图”的关联键。空串表示普通主动感知/手动截图，不属于某个等待中的陪伴轮。
    requestId: typeof data.requestId === "string" ? data.requestId : "",
    timestamp: Date.now(),
    ttlMs: Number(data.ttlMs) > 0 ? Number(data.ttlMs) : INJECTION_TTL_MS_DEFAULT,
  };
  _pendingInjections.set(_scopeKey(username), entry);
  console.log(
    "[beilu-eye] 收到截图注入，大小:",
    Math.round((data.image?.length || 0) / 1024),
    "KB, 模式:",
    entry.mode,
    "| TTL:",
    Math.round(entry.ttlMs / 1000),
    "秒",
    "| user:",
    _scopeKey(username) || "(兜底)",
  );
}

/**
 * 消费（取出并清除）待注入数据（按 username 分区）
 * 调用后该用户分区 pending 清空，实现一次性注入。
 * 含 TTL 过期检查 + 原子消费日志。
 * @param {string} [username]
 * @returns {{ image: string, message: string, mode: string, timestamp: number } | null}
 */
export function consumePendingInjection(username, requestId = "") {
  const data = _getValid(username);
  if (!data) return null;
  // 指定 requestId 时只允许发起该请求的轮消费；不匹配的普通截图/别轮截图留在原槽，
  // 不能再用“这个用户恰好有一张图”冒充“这句话请求的那张图”。
  if (requestId && data.requestId !== requestId) return null;
  // 删除命中的键（精确键优先，未命中精确键时删兜底键）
  const k = _scopeKey(username);
  if (_pendingInjections.get(k) === data) _pendingInjections.delete(k);
  else _pendingInjections.delete("");
  console.log(
    "[beilu-eye] pending 已消费",
    "| age:",
    Math.round((Date.now() - data.timestamp) / 1000),
    "秒",
    "| mode:",
    data.mode,
    "| user:",
    k || "(兜底)",
  );
  return data;
}

/**
 * 检查是否有待注入数据（不消费，按 username 分区）
 * 含 TTL 过期检查
 * @param {string} [username]
 * @returns {boolean}
 */
export function hasPendingInjection(username, requestId = "") {
  const data = _getValid(username);
  return !!data && (!requestId || data.requestId === requestId);
}

/**
 * 获取待注入数据的模式（不消费，按 username 分区）
 * @param {string} [username]
 * @returns {{ hasPending: boolean, mode: string|null, message: string|null }}
 */
export function getPendingStatus(username) {
  const entry = _getValid(username);
  if (!entry)
    return { hasPending: false, mode: null, message: null };
  return {
    hasPending: true,
    mode: entry.mode,
    message: entry.message,
    requestId: entry.requestId || "",
  };
}

// ============================================================
// 截图历史归档（CP-N3: 供 endpoints.mjs 的截图API使用）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs";
import { readJsonSafeSync } from "../../../../scripts/safeJsonIO.mjs"; // T019：_index.json损坏不静默重建，备份后抛错
import { getEyeConfigPath, getScreenshotsDir } from "../memory/storage_mod/storage.mjs"; // T7 批2：eye_config.json 路径收口到权威函数（projectRoot 参数保留，dirname 由权威路径派生）

function _screenshotDir(username, dirname) { // T7 尾段收口：路径引权威 getScreenshotsDir（dirname 参数保留调用点不动；ensure 副作用留本地=行为零漂移）
  const dir = getScreenshotsDir(username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 归档截图到磁盘（data/users/{username}/screenshots/）。
 *
 * 链路：endpoints.mjs /api/eye/inject → 本函数
 * 影响：写 shot_{timestamp}.jpg + 更新 _index.json（上限 500 条，超出截老）
 * 约束：base64 data URI 前缀被剥离后写入裸二进制；_index.json 损坏时从空数组重建
 *
 * @param {string} username
 * @param {string} dirname - __dirname（beilu-eye 插件目录，用于定位项目根 → data/users/）
 * @param {{ image: string, message: string, mode: string, windowTitle: string }} data
 */
export function archiveScreenshot(username, dirname, data) {
  try {
    const dir = _screenshotDir(username, dirname);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fname = `shot_${ts}.jpg`;
    const base64 = (data.image || "").replace(/^data:image\/\w+;base64,/, "");
    if (!base64) return;
    fs.writeFileSync(path.join(dir, fname), Buffer.from(base64, "base64"));
    const meta = { filename: fname, timestamp: Date.now(), message: data.message || "", mode: data.mode || "passive", windowTitle: data.windowTitle || "" };
    const metaPath = path.join(dir, "_index.json");
    // T019：损坏→备份.corrupt.bak后抛错（外层catch warn），不空数组顶上写回截断500条历史；不存在→[]首装。
    let index = readJsonSafeSync(metaPath, []); // let：:193 截断重赋值（第二AI核验抓的 const 重赋 TypeError）
    index.push(meta);
    if (index.length > 500) index = index.slice(-500);
    nicerWriteFileSync(metaPath, JSON.stringify(index));
  } catch (e) {
    console.warn("[beilu-eye] archiveScreenshot failed:", e.message);
  }
}

export function listScreenshotHistory(username, dirname, limit = 50) {
  try {
    const dir = _screenshotDir(username, dirname);
    const metaPath = path.join(dir, "_index.json");
    if (!fs.existsSync(metaPath)) return [];
    const index = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return index.slice(-limit).reverse();
  } catch { return []; }
}

export function readScreenshotFile(username, dirname, filename) {
  try {
    const safeName = path.basename(filename);
    const filePath = path.join(_screenshotDir(username, dirname), safeName);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch { return null; }
}

// ============================================================
// 悬浮球消息（Orb message — AI→桌面端推送）
// ============================================================

/**
 * 按 username 分区的待消费 orb 消息（AI→桌面端推送）。
 *
 * ⚠️ 串台/越权修复（B 方案，2026-06-18）：原 `_pendingOrbMessage` 是模块级单槽，
 *   多用户共用一个 beilu 实例时，A 用户对话的 AI 回复会被 B 用户的桌宠 orb-consume 取走，
 *   且任意本机进程都能裸读/注入（orb 三端点仅 is_local_ip，无身份核验）。
 *   现按 username 分区（Map<username|"__default__", state>），范式同 _pendingInjections(:25)：
 *   精确键优先；username 空(单用户/旧桌宠/orb-set 旧调用者)落兜底键 "__default__"，不崩、向后兼容。
 *   配合启动令牌(_petTokens)：桌宠经 env BEILU_PET_TOKEN 持令牌 → 端点 resolvePetToken 反解 username
 *   → 只取/存该 user 的 orb 槽，实现用户隔离。
 * @type {Map<string, { text: string, emotion: string, charName: string, timestamp: number }>}
 */
const _pendingOrbMessages = new Map(); // Map<username|"__default__", state>

/** orb 分区兜底键（username 空时用）：与截图注入的 "" 区分开，语义上更显式。 */
const _ORB_DEFAULT_KEY = "__default__";

/** 归一化 orb 分区键（null/undefined/非字符串/空 → 兜底键）。 */
function _orbKey(username) {
  return typeof username === "string" && username ? username : _ORB_DEFAULT_KEY;
}

/**
 * 写入一条 AI→桌面端的 orb 推送消息（按 username 分区，单槽覆盖）。
 *
 * 链路：replyHandler.mjs AI 回复后 → 本函数 → 写 _pendingOrbMessages
 *       → endpoints.mjs /api/eye/orb-consume → Electron 桌宠 poll 消费
 * 影响：_pendingOrbMessages.set（覆盖该用户旧 orb 消息）
 *
 * @param {string} username - 本轮回复所属用户（replyHandler 从 args.username 取）；空时落兜底键
 * @param {string} text - AI 回复文本
 * @param {string} [emotion] - 表情标签（桌宠表情随聊天同步）
 * @param {string} [charName] - 当前说话角色名（桌宠按角色卡换模型）
 */
export function setPendingOrbMessage(username, text, emotion, charName) {
  _pendingOrbMessages.set(_orbKey(username), {
    text,
    emotion: emotion || "",
    charName: charName || "",
    timestamp: Date.now(),
  });
}

/**
 * 取出并清除本用户 orb 消息（consume-once）：精确键 → 兜底键 "__default__"。
 * @param {string} [username]
 * @returns {{ text: string, emotion: string, charName: string, timestamp: number } | null}
 */
export function consumePendingOrbMessage(username) {
  const k = _orbKey(username);
  let hitKey = k;
  if (!_pendingOrbMessages.has(k) && k !== _ORB_DEFAULT_KEY && _pendingOrbMessages.has(_ORB_DEFAULT_KEY)) {
    hitKey = _ORB_DEFAULT_KEY;
  }
  const msg = _pendingOrbMessages.has(hitKey) ? _pendingOrbMessages.get(hitKey) : null;
  if (msg) _pendingOrbMessages.delete(hitKey);
  return msg;
}

export function hasPendingOrbMessage(username) {
  const k = _orbKey(username);
  if (_pendingOrbMessages.has(k)) return true;
  if (k !== _ORB_DEFAULT_KEY && _pendingOrbMessages.has(_ORB_DEFAULT_KEY)) return true;
  return false;
}

// ============================================================
// 桌宠启动令牌注册表（token → username）
// ============================================================
//
// beilu-eye/main.mjs 拉起 Electron 桌宠前生成随机 token 并 registerPetToken(token, ownerUsername)，
// 经 env BEILU_PET_TOKEN 传给桌宠。桌宠 orb 请求带 header x-pet-token，端点 resolvePetToken 反解
// 出 username → 只访问该 user 的 orb 槽。killElectronPet 时 revokePetToken 回收。
// 进程级单例(ES 模块同进程单例)，与 orb store 同模块共享，端点 import 即可直接 resolve。
const _petTokens = new Map(); // Map<token, username>

/** 注册桌宠启动令牌 → 拥有者 username（拉起桌宠时调用）。 */
export function registerPetToken(token, username) {
  if (!token || typeof token !== "string") return;
  _petTokens.set(token, typeof username === "string" ? username : "");
}

/** 桌宠客户端最近露面时刻(username→epoch ms)。resolvePetToken 命中即记(orb 轮询 ~2s=新鲜度上限);
 *  供 web 面板"桌宠在线"灯(2026-07-10 审计C修:此前 beilu 在+桌宠未起,面板保存显示成功=假象,零在线可见性)。 */
const _petClientSeen = new Map();

/** 反解令牌 → username；无效/缺失返回 null（端点据此 403）。命中顺记 lastSeen(单点,所有 pet-token 请求共用)。 */
export function resolvePetToken(token) {
  if (!token || typeof token !== "string") return null;
  if (!_petTokens.has(token)) return null;
  const u = _petTokens.get(token);
  _petClientSeen.set(typeof u === "string" ? u : "", Date.now());
  return u;
}

/** 桌宠客户端距上次露面的毫秒数;从没见过=null。精确键→兜底键 ""(与 token 注册同口径)。 */
export function getPetClientSeenAgoMs(username) {
  const t = getPetClientSeenAtMs(username);
  return typeof t === "number" ? Date.now() - t : null;
}

/** 桌宠客户端最近露面【时刻】(epoch ms;从没见过=null)。spawn 后心跳确认(WAITING_HEARTBEAT→RUNNING)
 *  需要比较"露面时刻 vs spawn 时刻",距今毫秒数无法区分"spawn 前的旧心跳"——故单独暴露时刻。 */
export function getPetClientSeenAtMs(username) {
  const k = typeof username === "string" && username ? username : "";
  const t = _petClientSeen.get(k) ?? (k !== "" ? _petClientSeen.get("") : undefined);
  return typeof t === "number" ? t : null;
}

/** 回收桌宠令牌（killElectronPet 时调用）。 */
export function revokePetToken(token) {
  if (!token || typeof token !== "string") return;
  _petTokens.delete(token);
}

// ============================================================
// Eye 进程状态追踪（供 endpoints.mjs 的 /api/eye/* 路由使用）
// 避免前端依赖 beilu parts API（/api/parts/plugins:beilu-eye/...）
// ============================================================

/** @type {{ status: string, error: string|null, desktopEyeDir: string }} */
let _eyeProcessState = {
  status: "stopped",
  error: null,
  desktopEyeDir: "",
};

/**
 * 更新 eye 进程状态（由 beilu-eye/main.mjs 调用）
 * @param {{ status?: string, error?: string|null, desktopEyeDir?: string }} update
 */
export function setEyeProcessState(update) {
  if (update.status !== undefined) _eyeProcessState.status = update.status;
  if (update.error !== undefined) _eyeProcessState.error = update.error;
  if (update.desktopEyeDir !== undefined)
    _eyeProcessState.desktopEyeDir = update.desktopEyeDir;
}

/**
 * 获取 eye 进程状态（供 endpoints.mjs 使用）
 * @returns {{ status: string, error: string|null, desktopEyeDir: string }}
 */
export function getEyeProcessState() {
  return { ..._eyeProcessState };
}

// ============================================================
// PetLifecycle 运行时镜像 + 互动租约（D5 §2.1 结构版，2026-08-04）
// ============================================================
//
// 唯一进程 owner = screenshot/main.mjs（spawn/kill 只在那里发生）；它把每次状态迁移推进本镜像，
// setDataActions/endpoints 只读镜像组装 PetOperationResult DTO——与 setEyeProcessState 同范式，
// 避免 memory handler 直接 import 会 spawn 的插件模块（import 副作用隔离）。
// 互动租约本体在 interaction_lease.mjs 叶子（零依赖可单测），此处 re-export 作单点门面。
export {
  acquireInteractionLease,
  computeEffectiveDesired,
  hasActiveInteractionLease,
  listInteractionLeases,
  onInteractionLeaseChange,
  releaseInteractionLease,
  resolveHeartbeatConfirm,
  resolveStopOutcome,
  revokeInteractionLeases,
  STOP_ACK_DEADLINE_MS,
} from "./interaction_lease.mjs";
import { hasActiveInteractionLease as _hasLease } from "./interaction_lease.mjs";

/** @type {{ status: string, pid: number|null, error: string|null, updatedAt: number,
 *           stopRequestedAt: number, stopDeadlineMs: number, stopTimeout: boolean, operationId: string|null }} */
let _petRuntimeState = {
  status: "stopped", // stopped|installing|missing|starting|waiting_heartbeat|running|adopting|adopted|stopping|error|error_unconfirmed
  pid: null,
  error: null,
  updatedAt: 0,
  stopRequestedAt: 0,
  stopDeadlineMs: 0,
  stopTimeout: false,
  operationId: null,
};

/** owner（screenshot/main.mjs）每次状态迁移推入；字段级 patch。 */
export function setPetRuntimeState(update) {
  if (!update || typeof update !== "object") return;
  _petRuntimeState = { ..._petRuntimeState, ...update, updatedAt: Date.now() };
}

/** 读运行时镜像（DTO 组装/诊断）。 */
export function getPetRuntimeState() {
  return { ..._petRuntimeState };
}

/**
 * 等待运行时镜像满足谓词（有界轮询；DTO 组装方用，如 stopGameCompanion 等 pet 收束 ≤10s）。
 * 谓词抛错视为不满足；到期返回当时快照，不抛——调用方按快照如实上报（不谎报 stopped）。
 * @param {(state: object) => boolean} predicate
 * @param {number} [timeoutMs]
 * @param {number} [pollMs]
 * @returns {Promise<{ settled: boolean, state: object }>}
 */
export async function waitPetRuntimeSettled(predicate, timeoutMs = 11_000, pollMs = 200) {
  const t0 = Date.now();
  while (true) {
    const state = getPetRuntimeState();
    let ok = false;
    try { ok = !!predicate(state); } catch { ok = false; }
    if (ok) return { settled: true, state };
    if (Date.now() - t0 >= timeoutMs) return { settled: false, state };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * effective desired 快照（explicit 持久开关 || 活跃互动 lease）。
 * 消费点：GET /api/eye/pet-settings（Electron 退出判据）/ DTO 组装。
 * @param {string} projectRoot
 */
export function getPetEffectiveDesired(projectRoot) {
  return !!loadPetSettingsStore(projectRoot).petEnabled || _hasLease();
}

// ============================================================
// 截图安全配置（W13 + W18 Q3=C）
// 用户级全局配置，存储在 data/users/{user}/eye_config.json
// ============================================================

/** 默认截图安全配置 */
export const DEFAULT_EYE_CONFIG = {
  /** URL黑名单 — 窗口标题/URL包含这些关键词时不截图 */
  blacklistPatterns: [
    "银行", "bank", "billing", "payment", "支付",
    "password", "密码", "credential",
  ],
  /**
   * 截图白名单 — allowlist：仅当窗口标题命中名单内某关键词才允许截图，其余一律拒绝。
   * 空数组 = 不启用白名单（向后兼容，旧行为不变，只走黑名单）。
   * 与黑名单可叠加：先黑名单排除，再白名单限定（白名单是「正向准入」收紧）。
   */
  whitelistPatterns: [],
  /** 是否需要AI询问后才截图（false = 被动模式自动截图） */
  askBeforeCapture: false,
  /** 截图最大分辨率（宽度px，W18: 默认1080） */
  captureResolution: 1080,
  /** 游戏陪伴：截图间隔秒数（0=禁用自动截图） */
  captureFrequency: 0,
  /** 游戏陪伴：只捕捉指定窗口名（null=全屏） */
  captureWindow: null,
  /**
   * 感知模式（陪伴MD「感知模式」三态）— 决定截图注入语义，是 /api/eye/inject 的权威覆盖源。
   *   "passive" 被动：截图存为 pending 但前端 pollEyeStatus 不主动发给 AI（仅 mode==="active" 才发，index.mjs:4065）
   *   "active"  主动：注入 mode 强制为 "active"，前端轮询自动发给 AI 触发回复
   *   "quiet"   安静：只归档截图，根本不写 pending（AI 永远看不到，只在历史面板可查）
   * 注入 mode 不再仅由截图客户端单方决定：客户端给 mode 时本字段优先（用户持久偏好 > 单次截图标记）。
   */
  perceptionMode: "passive",
  /**
   * AI 自主(<captureControl> 标签)权限 gate(凛倾 2026-07-09"ai自主需要可以设置"):
   *   关=AI 输出的该字段被忽略(用户主权)。执行点=replyHandler captureControl 块(唯一 gate 点)。
   *   语义用 !== false 判(旧 eye_config.json 无这些键=默认放行,零迁移)。
   */
  aiAllowFrequency: true,
  aiAllowWindow: true,
  aiAllowPerceptionMode: true,
  /** AI 可立即截一张(凛倾 2026-07-13 拍板"1做":captureControl.captureNow=true→写既有截图请求标记,autoCapture 轮询消费;此前 AI 只能调参等定时点) */
  aiAllowCaptureNow: true,
  /** 截图请求标记有效期秒(写入方负责 unlink 契约;覆盖≥一个 autoCapture 轮询周期即达) */
  captureRequestTtlSec: 10,
  /** 自截图请求轮询间隔秒(A1 去硬编码:原 5s 写死 autoCapture.js startGcPolling;消费端 clamp 2~60) */
  capturePollSec: 5,
  /** 陪伴轮等截图到达窗口秒(A2 去硬编码:原 10s 写死 gameCompanion;等不到=本轮无图照常进行) */
  gcShotWaitSec: 10,
  /** T4 防膨胀:绑定对话保最近 N 条截图轮的图片附件,更旧的剥引用(条目文字仍在=占位);0=关(不清理)。
   *  blob 回收=beilu-chat files.mjs cleanFiles 既有每小时孤儿 GC(引用消失→1h 宽限后删),零新删除机制。
   *  只剥 extension.gameCompanionShot 标记条(截图轮产者标记),用户手动附件零波及。消费=gameCompanion 落条后修剪 */
  gcShotKeepN: 10,
  /** AI 自主动作反馈:开=每次 AI 调整广播 capture_control_applied 给设置区显示(关=静默应用) */
  aiFeedbackPanel: true,
  /** 反馈提示停留时长(毫秒),0=常驻不自动消失。无值域 clamp——用户手动设置什么就是什么(凛倾 2026-07-09),端点仅拒负数 */
  aiFeedbackDwellMs: 6000,
  // 智能过滤/注入 TTL 出厂默认(2026-07-10 审计D9修:此前缺键,出厂值散落 beilu_eye.py/前端/端点三端副本;
  // 收进单源后 GET /api/eye/config 回填即有值,消费端兜底成死支不再分叉。值=原三端一致的既有默认,零行为变化)
  dedupHammingThreshold: 5,
  l2RegionDiff: true,
  l3Grading: true,
  metaTimestamp: true,
  injectionTtlMs: 60000,
  /** 自截图 JPEG 质量 1~100(凛倾 2026-07-13"为什么要设置硬编码":原 q60 写死 autoCapture.js;默认=原值零行为变化) */
  captureJpegQuality: 60,
};

/** 运行时配置缓存（按用户名） */
const _eyeConfigCache = new Map();

/**
 * 加载用户的截图配置（与 DEFAULT_EYE_CONFIG 合并）。
 *
 * 链路：endpoints.mjs /api/eye/inject → 本函数（读黑白名单 + 感知模式）
 * 影响：结果缓存到 _eyeConfigCache（clearEyeConfigCache 清除）
 * 约束：blacklistPatterns/whitelistPatterns 数组不走浅合并——用户配置有这俩字段时整体覆盖默认
 *
 * @param {string} username
 * @param {string} projectRoot
 * @returns {object} 合并后的配置
 */
/**
 * 读用户 JSON 配置(损坏保全,2026-07-10 审计C修):
 *   文件不存在=合法首启→null;存在但解析失败=用户数据危险态——先把原文快照成 <path>.corrupt-<ts>
 *   再返回 null(后续任何写覆盖的都是已快照过的文件,手改坏 JSON 不再无声蒸发)+console.error 可诊断。
 *   此前两读点 catch 静默回默认,下一次 patch 写回=历史设置永久丢失零提示(违"诚实降级")。
 */
const _quarantined = new Set(); // 每路径每进程只快照一次(损坏文件在被写修复前每次读都会失败,防 3s 轮询刷盘)
function _readJsonQuarantine(path) {
  if (typeof Deno === "undefined") return null;
  let text;
  try { text = Deno.readTextFileSync(path); } catch { return null; } // 不存在=首启,默认合法
  try {
    const v = JSON.parse(text);
    _quarantined.delete(path); // 恢复合法后复位(再次损坏可再快照)
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
  } catch (e) {
    if (!_quarantined.has(path)) {
      _quarantined.add(path);
      try { Deno.writeTextFileSync(`${path}.corrupt-${Date.now()}`, text); } catch { /* 快照失败仍留日志 */ }
      console.error(`[beilu-eye] 配置文件损坏,已快照 .corrupt-* 供恢复: ${path} | ${e.message}`);
    }
    return null;
  }
}

export function loadEyeConfig(username, projectRoot) {
  if (_eyeConfigCache.has(username)) return _eyeConfigCache.get(username);

  const userConfig = _readJsonQuarantine(getEyeConfigPath(username)) || {};

  const merged = { ...DEFAULT_EYE_CONFIG, ...userConfig };
  if (userConfig.blacklistPatterns) {
    merged.blacklistPatterns = userConfig.blacklistPatterns;
  }
  if (userConfig.whitelistPatterns) {
    merged.whitelistPatterns = userConfig.whitelistPatterns;
  }
  _eyeConfigCache.set(username, merged);
  return merged;
}

/**
 * 保存用户截图配置
 * @param {string} username
 * @param {string} projectRoot
 * @param {object} config
 */
export function saveEyeConfig(username, projectRoot, config) {
  try {
    const configPath = getEyeConfigPath(username);
    const dirPath = path.dirname(configPath);
    if (typeof Deno !== "undefined") {
      try { Deno.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
      Deno.writeTextFileSync(configPath, JSON.stringify(config, null, 2));
    }
    _eyeConfigCache.set(username, { ...DEFAULT_EYE_CONFIG, ...config });
  } catch (err) {
    console.error("[beilu-eye] 保存 eye_config 失败:", err.message);
  }
}

/**
 * 清除用户配置缓存
 * @param {string} [username] 省略则清除所有
 */
export function clearEyeConfigCache(username) {
  if (username) _eyeConfigCache.delete(username);
  else _eyeConfigCache.clear();
}

// ── Live2D 用户自定义模型字典(桌宠调试工具"保存到用户配置"闭环) ──
// 调试工具(live2d-debug.html)配好模型(params/emotionMap/dynamics 等)→保存→写此文件;
// renderer 经 __BEILU_USER_DICT_URL(→/api/eye/usermodel-dict)加载,与内置 model_dict overlay 合并(不改内置)。
// 单机桌宠级、无 session(同 orb 范式),故全局单文件;放 data/(用户数据区,与源码分离=开源升级不覆盖用户)。
function _userModelDictPath(projectRoot) {
  return `${projectRoot}/data/live2d_user_models.json`;
}

/**
 * 读取用户自定义模型字典(数组)。文件不存在/损坏→[]。
 * @param {string} projectRoot
 * @returns {Array<object>}
 */
export function loadUserModelDict(projectRoot) {
  try {
    if (typeof Deno !== "undefined") {
      const arr = JSON.parse(Deno.readTextFileSync(_userModelDictPath(projectRoot)));
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* 不存在或损坏→空字典 */ }
  return [];
}

/**
 * 保存模型条目到用户字典,按 name 字段级合并(与 renderer _mergeUserModels 同构:同名覆盖、新名追加)。
 * @param {string} projectRoot
 * @param {object|Array<object>} entry 单条或多条 model_dict 条目(需含 name)
 * @returns {Array<object>} 合并后的完整用户字典
 */
export function saveUserModelEntry(projectRoot, entry) {
  const incoming = Array.isArray(entry) ? entry : [entry];
  const dict = loadUserModelDict(projectRoot);
  for (const e of incoming) {
    if (!e || !e.name) continue;
    const i = dict.findIndex((m) => m && m.name === e.name);
    if (i >= 0) dict[i] = { ...dict[i], ...e }; // 字段级覆盖(用户只填要改的)
    else dict.push(e); // 新增用户模型
  }
  if (typeof Deno !== "undefined") {
    const dirPath = `${projectRoot}/data`;
    try { Deno.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
    Deno.writeTextFileSync(_userModelDictPath(projectRoot), JSON.stringify(dict, null, 2));
  }
  return dict;
}

// ── 桌宠设置(单一 beilu 侧权威源 data/pet_settings.json;单机全局单文件,无 username) ──
// 凛倾决策:桌宠默认【开启】(2026-06-28 改),用户开/关需【操作储存】(持久化),下次按上次选择走,不每次回默认。
// 这是 web 设置中心 ↔ 桌宠 的桥:
//   - 插件(Deno)读 petEnabled 决定是否并存拉起 Electron 桌宠。
//   - web 设置中心经 /api/eye/pet-settings(GET/POST,localhost)读写本文件。
//   - Electron 桌宠主进程轮询 GET 本文件(经 beilu 端点)→ 应用显示设置(对话框/动态/模型);托盘改动 POST 回此文件(双写和解,避免回退打架)。
// 放 data/(用户数据区,与源码分离=开源升级不覆盖用户)。
const PET_SETTINGS_DEFAULT = {
  petEnabled: false,        // 桌宠开关(插件读;默认关,用户开/关持久化)。语义固定=「用户显式想常驻桌宠」,
                            //   互动开始不得改写它(D5 §2.1)。互动的临时要求走运行时 lease(interaction_lease.mjs),
                            //   不落盘——重启后没有恢复的互动 session 就没有 lease,不遗留自动启用。
                            //   (0804 iter6 的持久化标记 petAutoEnabledByInteraction 已被 lease 结构版替代删除;
                            //   旧盘残留键无消费者,无害。)
  modelName: "",            // 形象(空=自动:按可用性选,不指名)。[凛倾 0722"为什么有硬编码?如果用户把贝露的图包删除
                            //   会怎么样"] 原默认写死"贝露"=代码指名用户可删资产;改空+读侧动态解析——渲染层:首个
                            //   图片包条目→字典首项→兜底小生物(live2dRenderer 初始选模);后端宏/env:resolvePetModelName
                            //   同语义(首个 user-images 包目录)。删包/改名自动降级,零指名残留。
  bubbleOpacity: 0.95,      // 对话框透明度 0.1~1
  bubbleDwellMs: 6000,      // 对话框停留毫秒(0=常驻)
  bubbleColor: "",          // 对话框底色(空=主题琥珀默认;CSS 颜色)
  bubbleTextColor: "",      // 对话框文字色(空=默认)
  bubbleRadius: -1,         // 对话框圆角 px(-1=默认 14)
  idleExpression: "",       // 待机表情(空=模型 defaultEmotion)
  dynamics: {},             // 动态/物理(人工自主;空=默认)
  passthrough: false,       // 游戏穿透
  // fallbackCreature 已移除(凛倾 2026-07-14:删除史莱姆和青蛙,贝露图片包为唯一默认形象)
  bannerEnabled: true,      // 是否显示 AI orbMessage 横幅/对话框(关=只截图不弹横幅)。设计⚙通知"横幅显示AI消息"
  bannerMaxChars: 0,        // 横幅最大字数(0=不限制,完整显示;>0=超出截断加…)。设计⚙通知"横幅最大字数",默认0不改变现有行为
  companionMaxChars: 0,     // 陪伴正文独立最大字数；不能复用通知截断，否则用户只看到流式回答前几个字
  petCorner: "br",          // 桌宠初始角位(br右下/bl左下/tr右上/tl左上;默认br=旧位置)。仍可拖拽覆盖。悬浮球已删除(凛倾 2026-07-09),orbVisible/orbSize 键随之移除
  notifySound: false,       // AI 消息声音(设计⚙通知"AI消息声音",默认关=旧行为)。开=有新 orbMessage 时系统提示音(shell.beep)
  emotionTag: "emotion",    // 表情指令标签名(凛倾 2026-07-09"禁止硬编码,包括标签":AI 输出 <此标签>键</此标签> 驱动表情;replyHandler/桌宠剥离双读)
  motionTag: "motion",      // 动作指令标签名(同上;Live2D motion 组触发)
  orbMessageTag: "orbMessage", // 悬浮球/桌宠文本标签名(同上;2026-07-09 收口审计补齐——同组三标签唯它漏配;replyHandler 抽取用,桌宠经 orb-consume 拿已抽取 text 不消费标签名)
  // ── 对话框自由调整全项(任务④,凛倾 2026-07-09:原描边/阴影/名标/字号/尖角写死在 pet-bubble.html) ──
  bubbleBorderColor: "",    // 描边色(空=默认琥珀 rgba(245,197,66,.55))
  bubbleShadow: true,       // 外阴影开关
  bubbleNameEnabled: true,  // 名字标签显隐
  bubbleNameText: "",       // 名字标签文字(空=默认 AI)
  bubbleNameColor: "",      // 名字标签色(空=默认 #b8860b)
  bubbleFontSize: 0,        // 字号 px(0=默认 14)
  bubbleTail: true,         // 指向尖角开关
  petHeight: 0,             // 桌宠角色窗高 px(0=Electron 内建默认 440;滚轮缩放仍可临时改,此为持久基准)
  petBubbleWinH: 0,         // 桌宠气泡窗高 px(0=内建默认 92)
  // ── 行为节奏(凛倾 2026-07-13"为什么要设置硬编码而不是用户可以自己关闭":原四值写死代码;默认=原值零行为变化) ──
  orphanExitSec: 45,        // beilu 失联多少秒桌宠自退(0=关闭自退,桌宠常驻;消费=desktop-eye orb 轮询)
  hitPollMs: 90,            // 主进程命中轮询间隔 ms(消费=desktop-eye _petHoverTick;30~1000 消费端 clamp)
  alphaHitThreshold: 10,    // 魔法棒 alpha 阈值 0~255(图片包命中盒扫描;消费=imagePackRenderer 经 pet-config 下发)
  captureHotkey: "Alt+Shift+S", // 框选截图全局快捷键(B1 去硬编码 2026-07-13:原写死不可改,与游戏/系统冲突无路;Electron accelerator 格式,注册失败回退默认并通知)
  orbPollSec: 3,            // 桌宠拉取 AI 消息/设置同步的轮询秒数(C1 去硬编码:原 3s 写死=AI 消息上气泡最大延迟;1~30 消费端 clamp,越小越即时、请求越频)
  companionStreamPollMs: 200, // 陪伴正文流轮询间隔；与低频 orb/config 轮询分离，100~2000ms
  voiceAlwaysOn: false,    // 常开语音必须用户显式开启；桌宠进程拥有唯一录音 lifecycle
  voiceQuickHotkey: "Alt+Shift+V", // 快速语音发送：按一次开始、再按一次结束并自动发送
  voiceWakeWords: "beilu,贝露", // 逗号分隔，可由用户改名/扩展；命中后才把问题送入陪伴对话
  voiceCaptureWithQuestion: false, // 每个唤醒问题是否请求同轮截图（仍受截图安全门约束）
  voiceActivationPeak: 0.02, // 常开录音电平门限（STT continuous 模式消费）
  voiceSilenceMs: 1000,    // 人声后连续静音多久收口一句
  voiceMinSpeechMs: 300,   // 过滤点击/瞬时噪声
  voiceMaxUtteranceSec: 20,// 单句最长时间，防持续噪声不收口
  // (手势开关三键已删,凛倾 2026-07-13 纠偏"菜单只可以右键.双击还有其他手势都是用户自己设置的":
  //  菜单入口=右键固定;双击并入触碰热区手势体系(caps.hitGestures 加 dblclick 档,用户在编辑器配动作);
  //  Ctrl+拖缩放=窗口操作惯例保持固定。开关式设计是错的——手势该配"做什么",不是配"开不开"。)
  selfHealBackoffSec: 30,   // 桌宠崩溃自愈重试退避秒数(消费=本文件同目录 main.mjs reconcilePet;0=每次对账都重试)
  // (idleMotionGroup 不进此处:待机动作组是 per-model 语义,单源=usermodel 条目.idleMotionGroup,渲染层 _idleGroup 已消费)
};
// ── 桌宠能力/选项单源(任务⑥硬编码收口,2026-07-09):前端选项集/限值的唯一权威。 ──
// why:动态预设此前在 companion.mjs:23 与 desktop-eye/main.js:586 各写死一份(双副本必漂移);
//   creature/corner/resolution 选项写死在 index.html;upload 限值写死在端点——凛倾原则"选项/限值来自后端单源"。
// 消费:GET /api/eye/pet-capabilities(web 面板填充下拉 + Electron 托盘构建菜单,均带本地兜底=离线可跑,后端优先)。
// 框架(凛倾 2026-07-09"为什么要写硬编码"):本常量=出厂默认,不是终点——data/pet_capabilities.json
//   用户可整键覆盖(loadPetCapabilities 顶层键 merge),端点只下发合并结果。改档位/值域/预设=改数据文件,不改源码。
export const PET_CAPABILITIES = {
  // 动态/物理预设(值形状=live2dRenderer _userDyn;""=标准即空覆盖)
  dynPresets: {
    "": {},
    "柔和": { drag: { maxTarget: 5, halflife: 0.4 }, gaze: { ampX: 0.4, ampY: 0.25, noiseScale: 0.09 }, idleMouth: { amp: 0.03 } },
    "活泼": { drag: { maxTarget: 14, halflife: 0.24 }, gaze: { ampX: 0.85, ampY: 0.5, noiseScale: 0.16 }, idleMouth: { amp: 0.06 } },
    "安静": { drag: { enabled: false }, gaze: { enabled: false }, idleMouth: { enabled: false } },
  },
  // creatures 已移除(凛倾 2026-07-14:删除史莱姆和青蛙)
  corners: [{ value: "br", label: "右下角" }, { value: "bl", label: "左下角" }, { value: "tr", label: "右上角" }, { value: "tl", label: "左上角" }],
  resolutions: [720, 1080, 1440, 2160],
  // D5 分叉修(2026-07-13):captureResolution 值域此前 480~2160 三处副本(endpoints 写口/前端 clamp/autoCapture 读口)。
  // 此处=权威(经 pet-capabilities 下发前端);endpoints 引下方导出常量;autoCapture 离线兜底同值(分叉即病)。
  captureResolutionLimits: { min: 480, max: 2160 },
  // 0715 收口(近期diff审计后端#1):0713 去硬编码批五个 eye_config 数值字段的值域,此前魔法数双写
  //   (endpoints.mjs 写口 clamp / companion.mjs 前端 clamp 各一份)——与 captureResolutionLimits 同范式归此权威,
  //   两侧读口带同值离线兜底(分叉即病)。改值域=改 data/pet_capabilities.json 整键覆盖,不改源码。
  eyeConfigLimits: {
    captureJpegQuality: { min: 1, max: 100 },
    capturePollSec: { min: 2, max: 60 },
    gcShotWaitSec: { min: 0, max: 120 },
    gcShotKeepN: { min: 0, max: 100 },
    captureRequestTtlSec: { min: 1, max: 120 },
  },
  imagepackUploadMaxBytes: 8 * 1024 * 1024,
  // Live2D 模型文件选择式导入(凛倾 2026-07-22)单文件上限:moc3/4K 纹理常见数十 MB(参 airi validator >30MB warn/>100MB critical)。
  // 消费=endpoints usermodel-upload 写口校验+web 面板预检同源;改值=data/pet_capabilities.json 整键覆盖。
  live2dUploadMaxBytes: 64 * 1024 * 1024,
  // ── 气泡视觉默认(2026-07-09 收口二批,凛倾"为什么还要好多硬编码"):此前真值散写三处副本
  //    (pet-bubble.html CSS 内建 / web 预览 companion.mjs / 重置按钮),此处为唯一权威;
  //    pet-bubble.html CSS 初值保留=离线渲染地板,值必须与此处一致(分叉即病)。 ──
  bubbleDefaults: {
    bg: "#fffcf5", textColor: "#3a2c12", opacity: 0.95, dwellMs: 6000, radius: 14,
    borderColor: "#f5c542", borderAlpha: 0.55, nameText: "AI", nameColor: "#b8860b", fontSize: 14,
  },
  // 动态/物理细分滑块谱(值域=官方 Cubism 参数域;此前 min/max/step 是 companion.mjs 前端孤本)
  dynSpec: [
    { g: "gaze", k: "ampX", label: "视线幅度X(ParamEyeBallX)", min: 0, max: 1, step: 0.01 },
    { g: "gaze", k: "ampY", label: "视线幅度Y(ParamEyeBallY)", min: 0, max: 1, step: 0.01 },
    { g: "gaze", k: "noiseScale", label: "视线游移速度", min: 0.02, max: 0.5, step: 0.01 },
    { g: "idleMouth", k: "amp", label: "待机呼吸幅度(ParamMouthOpenY)", min: 0, max: 1, step: 0.01 },
    { g: "idleMouth", k: "period", label: "呼吸周期(秒)", min: 1, max: 10, step: 0.1 },
    { g: "idleMouth", k: "base", label: "嘴基线开度(ParamMouthOpenY)", min: 0, max: 1, step: 0.01 },
    { g: "idleMouth", k: "jitter", label: "呼吸抖动", min: 0, max: 0.5, step: 0.01 },
    { g: "drag", k: "maxTarget", label: "拖动摆动幅度°(ParamBodyAngleZ≤10)", min: 0, max: 10, step: 0.5 },
    { g: "drag", k: "halflife", label: "回正快慢(秒)", min: 0.1, max: 0.8, step: 0.01 },
    { g: "drag", k: "gain", label: "拖动增益", min: 0, max: 0.2, step: 0.005 },
    { g: "drag", k: "deadZone", label: "拖动死区(px)", min: 0, max: 3, step: 0.1 },
    { g: "drag", k: "targetTau", label: "目标衰减(秒)", min: 0.05, max: 1, step: 0.05 },
    { g: "blink", k: "minGap", label: "眨眼最短间隔(秒)", min: 0.5, max: 8, step: 0.1 },
    { g: "blink", k: "maxGap", label: "眨眼最长间隔(秒)", min: 1, max: 12, step: 0.1 },
    { g: "blink", k: "close", label: "眨眼闭合时长(秒)", min: 0.05, max: 0.3, step: 0.01 },
    // airi 对标(2026-07-09):视线跟随偏移/渲染质量/帧率——渲染层 applyUserDynamics 消费(eyeTrack/render 组)
    { g: "eyeTrack", k: "offsetX", label: "跟随视线偏移X(比例)", min: -1, max: 1, step: 0.01 },
    { g: "eyeTrack", k: "offsetY", label: "跟随视线偏移Y(比例)", min: -1, max: 1, step: 0.01 },
    { g: "render", k: "scale", label: "渲染清晰度(resolution)", min: 0.5, max: 2, step: 0.25 },
    { g: "render", k: "maxFps", label: "最大帧率(0=不限)", min: 0, max: 120, step: 30 },
  ],
  // 开关谱(此前 _DYN_TOGGLES 是前端 const=同病同修):g.enabled 布尔;渲染层各组 enabled 语义已有
  dynToggles: [
    { g: "gaze", label: "视线游移(自主)" }, { g: "idleMouth", label: "待机呼吸" },
    { g: "drag", label: "拖动摆动" }, { g: "blink", label: "自动眨眼(兜底)" },
    { g: "eyeTrack", label: "视线跟随鼠标" }, { g: "shadow", label: "投影(阴影)" },
  ],
  // 图片包动效8参谱(默认值单源仍=imagePackRenderer IMG_DYN_DEFAULT,web/Electron 共用同一文件;此谱只管键序+标签)
  ipkDynSpec: [
    { k: "fadeMs", label: "换图渐变ms" }, { k: "talkWobbleDeg", label: "说话摇摆°" },
    { k: "talkCapMs", label: "说话上限ms" }, { k: "nudgeGain", label: "拖动增益" },
    { k: "nudgeMaxDeg", label: "拖动最大倾°" }, { k: "nudgeResetMs", label: "回正ms" },
    { k: "tapLiftPx", label: "点击弹跳px" }, { k: "tapMs", label: "点击时长ms" },
  ],
  // 桌宠窗尺寸值域(=Electron main.js clamp 真域;web 输入框 min/max 提示同源,免"设了被静默钳"暗坑)
  petWinLimits: { charH: { min: 220, max: 820, stepH: 56 }, bubbleH: { min: 40, max: 300 } }, // stepH=滚轮缩放步进(B2 去硬编码 2026-07-13:原写死 main.js PET_GROUP)
  // 托盘/右键快捷档位(此前硬编码在 buildPetMenuItems;Electron 读 caps 缓存,离线兜底同值)
  trayBubbleOpacityOptions: [["不透明 100%", 1.0], ["85%", 0.85], ["70%", 0.7], ["半透明 50%", 0.5]],
  trayBubbleDwellOptions: [["停留 3 秒", 3000], ["停留 5 秒", 5000], ["停留 8 秒", 8000], ["常驻 (不自动消失)", 0]],
  // 触碰热区(凛倾 2026-07-09 用户自制触碰反馈):动作类型/提示文案/限值/编辑器辅助线样式全单源
  //   (渲染层命中不读此,只按热区数据执行;sayMaxChars 唯一执行点=编辑器 maxlength,渲染链零限值副本)
  hitActionTypes: [
    { value: "say", label: "台词(气泡随机说一条)", hint: "台词池:每行一条,触发时随机选一条显示" },
    { value: "send", label: "发送给 AI", hint: "该内容作为用户消息发送给 AI,回应显示在气泡(需陪伴运行中)" },
    { value: "emotion", label: "换表情", hint: "表情键(见上方宏 petExpressions 的可用键)" },
    { value: "motion", label: "播动作", hint: "Live2D motion 组名(图片包无动作,回落弹跳)" },
    { value: "tap", label: "默认弹跳", hint: "留空即可" },
  ],
  // 手势判据(Live2DPet 同源默认:click<pressMs 且未拖;≥pressMs=长按;角色上滑动累计≥strokePx=抚摸,带冷却);
  // countResetMs=同区同手势触发计数窗口(次数细分档用:窗口内累计,超时归零)
  hitLimits: { sayMaxChars: 500, minPolyPoints: 3, lassoSamplePx: 6, pressMs: 300, strokePx: 160, strokeCooldownMs: 3000, countResetMs: 60000, dragPx: 4 }, // dragPx=点击/拖动判定阈值(B5 去硬编码 2026-07-13:原写死 live2d-pet:399,高DPI灵敏度可调)
  hitEditor: { strokeWidth: 1.5, lineWidth: 2, dash: "4 3", fillOpacity: 0.12 },
  // 形状工具集/手势集(编辑器 2.0,凛倾:"可以有圆圈,还有其他"):枚举单源,前端零副本
  hitShapes: [{ value: "poly", label: "套索(手绘)" }, { value: "circle", label: "圆" }, { value: "rect", label: "矩形" }],
  hitGestures: [{ value: "click", label: "点击" }, { value: "press", label: "长按" }, { value: "stroke", label: "抚摸" }, { value: "dblclick", label: "双击" }], // dblclick(凛倾 2026-07-13"菜单只可以右键.双击还有其他手势都是用户自己设置的"):双击从"固定开菜单"改为用户可配的热区手势
  // AI 自主设置谱(凛倾 2026-07-09"ai自主需要可以设置反馈,比如设置区给反馈,比如停留等等.不要有硬编码"):
  //   开关谱=UI 单源(前端零副本);值存 eye_config.json(用户层,出厂默认=DEFAULT_EYE_CONFIG);
  //   gate 执行点=replyHandler captureControl。停留时长不设值域——用户手动设置什么就是什么(凛倾同日拍板)
  aiAutonomy: {
    toggles: [
      { k: "aiAllowFrequency", label: "AI 可调节截图频率", hint: "AI 按画面内容输出调频指令,运行中的陪伴下一轮生效" },
      { k: "aiAllowWindow", label: "AI 可切换目标窗口", hint: "AI 可指定只截某窗口(空=全屏),下一张截图生效" },
      { k: "aiAllowPerceptionMode", label: "AI 可切换感知模式", hint: "被动/主动/安静三态" },
      { k: "aiAllowCaptureNow", label: "AI 可立即截一张", hint: "AI 想看当前画面时即时补拍(不等定时),去重/名单安全门照常" },
      { k: "aiFeedbackPanel", label: "AI 调整后给我反馈", hint: "AI 每次自主调整,在设置区提示+记入陪伴消息" },
    ],
    dwell: { k: "aiFeedbackDwellMs", label: "反馈提示停留(毫秒,0=常驻)" },
  },
};

/**
 * 能力/选项的运行时真值:出厂默认 PET_CAPABILITIES ← data/pet_capabilities.json 顶层键覆盖。
 * 所有消费方(端点下发/上传限值校验)一律走本函数,禁直读常量——否则用户覆盖被绕过。
 * @param {string} projectRoot
 * @returns {object}
 */
export function loadPetCapabilities(projectRoot) {
  let user = {};
  try {
    if (typeof Deno !== "undefined") {
      const cfg = JSON.parse(Deno.readTextFileSync(`${projectRoot}/data/pet_capabilities.json`));
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) user = cfg;
    }
  } catch { /* 不存在或损坏→出厂默认 */ }
  return { ...PET_CAPABILITIES, ...user };
}
function _petSettingsPath(projectRoot) {
  return `${projectRoot}/data/pet_settings.json`;
}

/**
 * 当前形象的可用表情输出词(凛倾 2026-07-09:AI 要知道能输出哪些表情键——机制层提供数据,
 * 经宏 {{petExpressions}} 进提示词,提示词内容本身由用户/预设写,代码不产生进对话的文本)。
 * 单源:pet_settings.modelName → 图片包=pack.json 表情键;Live2D=usermodel 字典该模型 emotionMap 显式键
 * (用户在调试工具配的语义映射=该模型明确可用的情绪词)。读不到=空串(宏展开为空,不编造)。
 * @param {string} projectRoot
 * @returns {string} 逗号分隔的表情键列表,如 "平静, 开心, 害羞"
 */
/**
 * 当前生效形象名解析(凛倾 0722 去指名硬编码):显式选择原样返回(名字资产已删时渲染层 dict-miss
 * 自回退,后端不代猜);空=自动 → 首个 user-images 图片包目录名 → 无包返 ""(宏为空=诚实降级)。
 * 与渲染层 live2dRenderer 初始选模(首个图片包条目→字典首项)同语义:按可用性选,不指名。
 * @param {string} projectRoot
 * @returns {string}
 */
export function resolvePetModelName(projectRoot) {
  const explicit = String(loadPetSettingsStore(projectRoot).modelName || "");
  if (explicit) return explicit;
  try {
    if (typeof Deno !== "undefined") {
      for (const e of Deno.readDirSync(`${projectRoot}/desktop-eye/user-images`)) {
        if (e.isDirectory) return e.name;
      }
    }
  } catch { /* 无 user-images 目录:无包 */ }
  return "";
}

export function getPetExpressionWords(projectRoot) {
  try {
    const name = resolvePetModelName(projectRoot);
    if (!name || typeof Deno === "undefined") return "";
    try { // 图片包优先(pack.json 是包的权威声明)
      const pj = JSON.parse(Deno.readTextFileSync(`${projectRoot}/desktop-eye/user-images/${name}/pack.json`));
      const keys = Object.keys((pj && pj.expressions) || {});
      if (keys.length) return keys.join(", ");
    } catch { /* 非图片包/无包:走 Live2D 路 */ }
    const ent = loadUserModelDict(projectRoot).find((m) => m && m.name === name);
    const keys = (ent && ent.emotionMap && typeof ent.emotionMap === "object") ? Object.keys(ent.emotionMap) : [];
    return keys.join(", ");
  } catch { return ""; }
}

/**
 * 读取桌宠设置(与默认合并)。文件不存在/损坏→默认(petEnabled:true)。
 * @param {string} projectRoot
 * @returns {object} 合并后的完整设置
 */
export function loadPetSettingsStore(projectRoot) {
  return { ...PET_SETTINGS_DEFAULT, ...loadPetSettingsStoreRaw(projectRoot) };
}

/**
 * 盘上原始存量(只含用户显式设置过的键,不合并默认)。
 * why:Electron 对账需要分辨"用户设过 vs 默认"——旧法拿"值≠默认"猜,用户改回默认值时被误判成
 *   "没设过"并被 Electron 旧值回灌覆盖(2026-07-09 确诊)。显式键单源在盘,raw 读即真相,无需猜。
 * @param {string} projectRoot
 * @returns {object} 盘上原始对象(不存在/损坏={})
 */
export function loadPetSettingsStoreRaw(projectRoot) {
  // 损坏保全:坏文件先快照 .corrupt-* 再回空(savePetSettingsStore 随后的覆盖写不再蒸发用户历史)
  return _readJsonQuarantine(_petSettingsPath(projectRoot)) || {};
}

// ── 写侧变更订阅(凛倾 2026-07-22"两处启动,不同步的散写"收口) ──
// why:petEnabled 的启动副作用(对账基线同步/安装冷却清零/立即拉起进程)此前只挂在 SetData('pet-set-enabled')
//   入口,而实际唯一活入口 web POST /api/eye/pet-settings 只落盘、等 4s 周期对账才生效——同一开关两套写语义。
// 收口:所有入口都经本文件 savePetSettingsStore 单 funnel,变更在此广播;进程生杀订阅方=screenshot/main.mjs,
//   新增入口零分支自动获得完整启动语义。订阅方异常/返回的 promise 拒绝均不阻断写。
const _petSettingsListeners = new Set();
export function onPetSettingsChange(fn) { if (typeof fn === "function") _petSettingsListeners.add(fn); }

/**
 * 写入桌宠设置(字段级 patch 合并,只改传入字段)。写后广播变更给订阅方(见 onPetSettingsChange)。
 * @param {string} projectRoot
 * @param {object} patch
 * @returns {object} 合并后的完整设置
 */
export function savePetSettingsStore(projectRoot, patch) {
  // 盘上只存显式键(raw+patch),不烙默认快照——否则存过一次后默认值永久冻结、且"设过/默认"不可分辨。
  const raw = { ...loadPetSettingsStoreRaw(projectRoot), ...(patch && typeof patch === "object" ? patch : {}) };
  if (typeof Deno !== "undefined") {
    const dirPath = `${projectRoot}/data`;
    try { Deno.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
    Deno.writeTextFileSync(_petSettingsPath(projectRoot), JSON.stringify(raw, null, 2));
  }
  const merged = { ...PET_SETTINGS_DEFAULT, ...raw };
  for (const fn of _petSettingsListeners) {
    try { const r = fn(patch, merged); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* 订阅方异常不阻断写 */ }
  }
  return merged;
}

/**
 * 检查窗口标题/URL是否在黑名单中
 * @param {string} windowTitle - 窗口标题
 * @param {string[]} blacklistPatterns - 黑名单关键词
 * @returns {{ blocked: boolean, matchedPattern?: string }}
 */
export function checkScreenshotBlacklist(windowTitle, blacklistPatterns) {
  if (!windowTitle || !blacklistPatterns?.length) return { blocked: false };
  const lower = windowTitle.toLowerCase();
  for (const pattern of blacklistPatterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return { blocked: true, matchedPattern: pattern };
    }
  }
  return { blocked: false };
}

/**
 * 检查窗口标题是否在白名单（allowlist）内 —— 黑名单的「反向」准入。
 * 白名单非空时：仅当 windowTitle 命中任一 pattern（小写子串匹配）才允许截图；
 * 否则一律拒绝（含 windowTitle 为空的情况，由调用方做 fail-closed 缺标题判定）。
 * 白名单为空（未启用）→ 始终放行（向后兼容，旧行为不变）。
 * @param {string} windowTitle - 窗口标题
 * @param {string[]} whitelistPatterns - 白名单关键词
 * @returns {{ allowed: boolean, matchedPattern?: string }}
 */
// 用户删除后清理 per-user 缓存
try {
  const { events } = await import("../../../../server/events.mjs");
  events.on("AfterUserDeleted", ({ username }) => {
    _pendingInjections.delete(username);
    _pendingInjections.delete(""); // 兜底键
    _eyeConfigCache.delete(username);
  });
} catch {}

export function checkScreenshotWhitelist(windowTitle, whitelistPatterns) {
  if (!whitelistPatterns?.length) return { allowed: true };   // 未启用白名单 → 放行
  if (!windowTitle) return { allowed: false };                // 启用白名单但无标题 → 拒绝（无法核实）
  const lower = windowTitle.toLowerCase();
  for (const pattern of whitelistPatterns) {
    if (lower.includes(pattern.toLowerCase())) {              // 命中任一白名单词 → 准入
      return { allowed: true, matchedPattern: pattern };
    }
  }
  return { allowed: false };                                  // 启用白名单但未命中 → 拒绝
}
