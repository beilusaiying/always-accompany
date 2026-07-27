/**
 * beilu-plugin-host/plugin_registry.mjs
 * ES Module 单例 — 用户级插件注册表 + 待注入数据管理
 *
 * 与 yonban/core/functions/screenshot/injection_state.mjs（原 beilu-eye 壳，T8 已删）同模式：
 * 同进程内多个模块 import 此文件时拿到的是同一个实例，
 * 用于在 plugin_host/main.mjs 和 beilu-chat/endpoints.mjs 之间共享状态。
 *
 * 职责：
 * - 注册/注销用户插件
 * - 管理每个插件的 pending 注入数据（TTL 自动过期）
 * - 提供状态查询接口
 */

/** @type {Map<string, PluginEntry>} pluginId → PluginEntry */
const _registry = new Map();

/**
 * @typedef {object} PluginEntry
 * @property {string} id - 插件 ID（与 plugin.json 的 id 一致）
 * @property {string} name - 插件显示名
 * @property {string} status - 'stopped' | 'starting' | 'running' | 'error'
 * @property {string|null} error - 错误信息
 * @property {object|null} manifest - plugin.json 完整内容
 * @property {object|null} process - Deno.ChildProcess / node child_process 引用
 * @property {number} port - 插件监听端口（0 = 未分配）
 * @property {string} token - 启动时生成的认证 token
 * @property {object|null} pendingInjection - 待注入数据 { content, hookTarget, position, timestamp }
 * @property {number} pendingTtl - pending 数据 TTL（毫秒）
 */

const DEFAULT_TTL = 60_000; // 60 秒，与 beilu-eye 的 INJECTION_TTL_MS 一致

/**
 * 生成随机认证 token
 * N18：原用 Math.random()（可预测 PRNG）生成插件↔主进程认证凭据=安全弱（validateToken 比对 + 作 --token 传子进程）。
 *   改用 crypto.randomUUID()（CSPRNG，122bit 熵，CLI 安全）。token 仅做 === 比对，UUID 格式无影响。
 * @returns {string}
 */
function generateToken() {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
}

// ============================================================
// 注册 / 注销
// ============================================================

/**
 * 注册一个用户插件
 * @param {object} manifest - plugin.json 内容
 * @param {number} [port=0] - 分配的端口
 * @returns {PluginEntry}
 */
export function registerPlugin(manifest, port = 0) {
  const id = manifest.id;
  const token = generateToken();
  const entry = {
    id,
    name: manifest.name || id,
    status: "stopped",
    error: null,
    manifest,
    process: null,
    port,
    token,
    pendingInjection: null,
    pendingTtl: DEFAULT_TTL,
  };
  _registry.set(id, entry);
  return entry;
}

/**
 * 注销一个用户插件
 * @param {string} pluginId
 */
export function unregisterPlugin(pluginId) {
  const entry = _registry.get(pluginId);
  if (entry?.process) {
    try {
      entry.process.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  _registry.delete(pluginId);
}

/**
 * 获取插件条目
 * @param {string} pluginId
 * @returns {PluginEntry|undefined}
 */
export function getPlugin(pluginId) {
  return _registry.get(pluginId);
}

/**
 * 获取所有已注册的插件列表
 * @returns {PluginEntry[]}
 */
export function getAllPlugins() {
  return Array.from(_registry.values());
}

/**
 * 更新插件状态
 * @param {string} pluginId
 * @param {Partial<PluginEntry>} updates
 */
export function updatePlugin(pluginId, updates) {
  const entry = _registry.get(pluginId);
  if (!entry) return;
  Object.assign(entry, updates);
}

// ============================================================
// Pending Injection（与 injection_state.mjs 同模式）
// ============================================================

/**
 * 设置插件的待注入数据
 * @param {string} pluginId
 * @param {object} data - { content, hookTarget?, position?, ttl? }
 */
export function setPendingInjection(pluginId, data) {
  const entry = _registry.get(pluginId);
  if (!entry) {
    console.warn(`[plugin-host] setPendingInjection: 未注册的插件 ${pluginId}`);
    return;
  }
  entry.pendingInjection = {
    content: data.content || "",
    hookTarget: data.hook_target || data.hookTarget || "GetPrompt",
    position: data.position || "system_bottom",
    timestamp: Date.now(),
  };
  if (data.ttl) entry.pendingTtl = data.ttl;
}

/**
 * 消费插件的待注入数据（原子操作：读取后清除）
 * @param {string} pluginId
 * @returns {object|null} 注入数据，或 null（不存在/已过期）
 */
export function consumePendingInjection(pluginId) {
  const entry = _registry.get(pluginId);
  if (!entry || !entry.pendingInjection) return null;

  // TTL 检查
  const age = Date.now() - entry.pendingInjection.timestamp;
  if (age > entry.pendingTtl) {
    console.log(
      `[plugin-host] ${pluginId} pending 数据已过期 (${age}ms > ${entry.pendingTtl}ms)，丢弃`,
    );
    entry.pendingInjection = null;
    return null;
  }

  const data = entry.pendingInjection;
  entry.pendingInjection = null;
  return data;
}

/**
 * 检查是否有任何插件有待注入数据
 * @returns {boolean}
 */
export function hasAnyPendingInjection() {
  for (const entry of _registry.values()) {
    if (entry.pendingInjection) {
      const age = Date.now() - entry.pendingInjection.timestamp;
      if (age <= entry.pendingTtl) return true;
    }
  }
  return false;
}

/**
 * 收集所有插件的待注入数据并消费
 * @returns {Array<{ pluginId: string, content: string, position: string }>}
 */
export function consumeAllPendingInjections() {
  const results = [];
  for (const [pluginId, entry] of _registry.entries()) {
    const data = consumePendingInjection(pluginId);
    if (data) {
      results.push({ pluginId, ...data });
    }
  }
  return results;
}

/**
 * 验证插件 token
 * @param {string} pluginId
 * @param {string} token
 * @returns {boolean}
 */
export function validateToken(pluginId, token) {
  const entry = _registry.get(pluginId);
  return !!(entry && entry.token === token);
}
