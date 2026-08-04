/**
 * [sessionIdentity.mjs] — 前端只读会话身份代际（D6 §1，2026-08-04 窗口A）。
 *   不管认证本身（那是服务端 auth.mjs 的事），不管显示用名（那是 sharedState.getUsername 的事，
 *   非 authority），不管 401 跳转（那是 api-client.mjs 的事）。
 *
 * 功能链：
 *   受保护 shell 内任意消费方 → ensureSessionIdentity() → GET /api/whoami（服务端认证唯一
 *   username 权威源）→ 与当前身份比对 → 用户变化时铸新 epoch + 派发
 *   `beilu:session-epoch-changed` → 各 user-scoped 易失 UI（memoryBrowser 等）清树/丢在飞结果。
 *   异步消费范式：请求发起前 `const ep = getSessionEpoch()`，await 回来后
 *   `if (!isEpochCurrent(ep)) return;` —— 旧用户的在飞响应不写进新用户的 UI/store。
 *
 * why（D6 契约 §1）：
 *   Principal{username} 的唯一生产者是服务端认证（getUserByReq / /api/whoami）。前端不存在
 *   username 生产者（meta/window 假契约，E 现场 _default 冲突实证），故前端只持有"身份代际"：
 *   epoch = 服务端 username + 本页随机代号。同 origin 换用户（A 登出→B 登录且 SPA 状态未整页
 *   重建）时，A 的在飞 list/read 结果必须因 epoch 不匹配被丢弃，B 的树不含 A 的文件。
 *   登录完成的整页跳转 / logout / 401（api-client 强制跳 /login）都使页面状态整体消亡，
 *   epoch 天然失效；本模块补的是"跳转未发生/失败"的同页残留窗口。
 *   只清 user-scoped 易失 UI 状态；设备级 theme/locale/deviceId 不在本模块清理域（D6 §1.2）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（/api/whoami 读路；401 由其统一跳转）
 *   ← panels/memory/memoryBrowser.mjs（epoch 守卫 + 换用户清树）
 *   ← 其他 user-scoped 面板可逐步接入（同一范式）
 *
 * 影响范围：新增模块，无副作用 import；epoch 变化仅派发事件，不主动改任何 DOM/存储。
 *
 * 使用效果：双用户同 origin 切换时，前一个用户的记忆树/在飞结果不会渲染进后一个用户的界面
 *   （D6 白盒矩阵动线 B）。
 */

import { apiFetch } from "../transport/api-client.mjs";

/** 当前身份：username 来自服务端认证；epoch 为该 username 在本页面的代际标识。 */
let _identity = { username: null, epoch: "" };
/** 单飞：并发 ensure 共享同一次 whoami。 */
let _ensureInflight = null;
/** whoami 结果短 TTL（ms）：同一交互串内不重复打认证端点；换用户由下次交互的 ensure 发现。 */
const _IDENTITY_TTL_MS = 10_000;
let _lastVerifiedAt = 0;

function _mintEpoch(username) {
  const nonce = (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  return `${username}#${nonce}`;
}

function _applyIdentity(username) {
  if (_identity.username === username && _identity.epoch) return _identity;
  const previousEpoch = _identity.epoch;
  const previousUsername = _identity.username;
  _identity = { username, epoch: _mintEpoch(username) };
  try {
    window.dispatchEvent(new CustomEvent("beilu:session-epoch-changed", {
      detail: { username, epoch: _identity.epoch, previousUsername, previousEpoch },
    }));
  } catch { /* 事件派发失败不影响身份本体 */ }
  return _identity;
}

/**
 * 确认当前会话身份（TTL 内直接返回缓存；过期则重新经 /api/whoami 核对）。
 * 401 时 api-client 会强制跳 /login；跳转失败的残留页上本函数抛错且 epoch 被作废，
 * 消费方的 isEpochCurrent 守卫随之全部拒绝渲染（fail-closed）。
 * @returns {Promise<{username: string, epoch: string}>}
 */
export async function ensureSessionIdentity() {
  if (_identity.epoch && Date.now() - _lastVerifiedAt < _IDENTITY_TTL_MS) return _identity;
  if (_ensureInflight) return _ensureInflight;
  _ensureInflight = (async () => {
    try {
      const who = await apiFetch("/api/whoami");
      const username = typeof who?.username === "string" ? who.username : "";
      if (!username) {
        invalidateSessionEpoch("whoami_no_username");
        throw new Error("[sessionIdentity] /api/whoami 未返回认证用户名");
      }
      _lastVerifiedAt = Date.now();
      return _applyIdentity(username);
    } catch (e) {
      // 401（api-client 已发起跳转）/网络失败：作废 epoch，守卫端全部不渲染，不猜身份。
      invalidateSessionEpoch("whoami_failed");
      throw e;
    } finally {
      _ensureInflight = null;
    }
  })();
  return _ensureInflight;
}

/** 当前 epoch（""=尚未建立或已失效）。异步消费方在请求发起前捕获。 */
export function getSessionEpoch() {
  return _identity.epoch;
}

/** 捕获的 epoch 是否仍是当前代际（在飞结果写入 UI 前的守卫）。 */
export function isEpochCurrent(epoch) {
  return !!epoch && epoch === _identity.epoch;
}

/** 当前认证用户名（服务端权威的本地缓存；""=未建立）。仅读，不可当写路身份用。 */
export function getSessionUsername() {
  return _identity.username || "";
}

/**
 * 显式作废当前 epoch（logout 流程/401 残留页/调用方自知身份已变时用）。
 * 作废后 isEpochCurrent 对一切旧值返回 false；下次 ensureSessionIdentity 重建。
 */
export function invalidateSessionEpoch(reason = "manual") {
  if (!_identity.epoch && _identity.username === null) return;
  const previousEpoch = _identity.epoch;
  const previousUsername = _identity.username;
  _identity = { username: null, epoch: "" };
  _lastVerifiedAt = 0;
  try {
    window.dispatchEvent(new CustomEvent("beilu:session-epoch-changed", {
      detail: { username: null, epoch: "", previousUsername, previousEpoch, reason },
    }));
  } catch { /* 同上 */ }
}
