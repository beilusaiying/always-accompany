/**
 * beilu-eye 共享注入状态
 *
 * 这个模块是 beilu-eye 插件和 beilu-chat 端点之间的桥梁。
 * ES 模块在同一进程中是单例的，所以两边 import 同一个模块实例。
 *
 * 流程：
 * 1. Electron 客户端 POST → beilu-chat 端点 → setPendingInjection()
 * 2. 用户发送消息 → Fount 调用 GetPrompt → consumePendingInjection()
 * 3. AI 回复后，注入数据已清除，后续对话不再包含截图
 */

/** @type {{ image: string, message: string, mode: string, timestamp: number } | null} */
let _pendingInjection = null;

/** 注入数据 TTL（毫秒）：超过此时间自动视为过期并丢弃 */
const INJECTION_TTL_MS = 60_000;

/**
 * 检查 pending 数据是否已过期，过期则自动清理
 * @returns {boolean} true = 有效数据存在
 */
function checkAndExpire() {
  if (!_pendingInjection) return false;
  const age = Date.now() - _pendingInjection.timestamp;
  if (age > INJECTION_TTL_MS) {
    console.log(
      "[beilu-eye] pending 注入已过期，自动清理",
      "| age:",
      Math.round(age / 1000),
      "秒",
      "| TTL:",
      INJECTION_TTL_MS / 1000,
      "秒",
    );
    _pendingInjection = null;
    return false;
  }
  return true;
}

/**
 * 设置待注入的截图数据
 * @param {{ image: string, message: string, mode?: string }} data
 */
export function setPendingInjection(data) {
  _pendingInjection = {
    image: data.image,
    message: data.message || "",
    mode: data.mode || "passive",
    timestamp: Date.now(),
  };
  console.log(
    "[beilu-eye] 收到截图注入，大小:",
    Math.round((data.image?.length || 0) / 1024),
    "KB, 模式:",
    _pendingInjection.mode,
  );
}

/**
 * 消费（取出并清除）待注入数据
 * 调用后 pendingInjection 变为 null，实现一次性注入
 * 增加 TTL 过期检查 + 原子消费日志
 * @returns {{ image: string, message: string, mode: string, timestamp: number } | null}
 */
export function consumePendingInjection() {
  if (!checkAndExpire()) return null;
  const data = _pendingInjection;
  _pendingInjection = null;
  if (data) {
    console.log(
      "[beilu-eye] pending 已消费",
      "| age:",
      Math.round((Date.now() - data.timestamp) / 1000),
      "秒",
      "| mode:",
      data.mode,
    );
  }
  return data;
}

/**
 * 检查是否有待注入数据（不消费）
 * 含 TTL 过期检查
 * @returns {boolean}
 */
export function hasPendingInjection() {
  return checkAndExpire();
}

/**
 * 获取待注入数据的模式（不消费）
 * @returns {{ hasPending: boolean, mode: string|null, message: string|null }}
 */
export function getPendingStatus() {
  if (!checkAndExpire())
    return { hasPending: false, mode: null, message: null };
  return {
    hasPending: true,
    mode: _pendingInjection.mode,
    message: _pendingInjection.message,
  };
}

// ============================================================
// Eye 进程状态追踪（供 endpoints.mjs 的 /api/eye/* 路由使用）
// 避免前端依赖 Fount parts API（/api/parts/plugins:beilu-eye/...）
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
