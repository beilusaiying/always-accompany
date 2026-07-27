/**
 * execute.mjs — 平台操作执行核心
 *
 * 独立模块：解除 main.mjs（插件入口）和 index.mjs（dispatch 注册）之间的耦合。
 * 两者都 import 本模块的 executeReach，互不依赖。
 *
 * 统一裁决点：allowedPlatforms 白名单 + config 透传在此收口——
 * AI 标签路径（main.mjs ReplyHandler）和 dispatch 路径（webSearch 钩子/URL 提取）
 * 都经过本函数，凭据/白名单不再依赖调用方各自拼参数。
 */

import { PLATFORM_REGISTRY } from "./registry.mjs";
import { getReachConfig, isPlatformAllowed } from "./config.mjs";
import { wbD } from "../../../../server/wbStub.mjs"; // 白盒：白名单/SSRF 裁决点可观测（放行不刷屏，只记拒绝）

const _adapterCache = new Map();

async function _getAdapter(platform) {
  if (_adapterCache.has(platform)) return _adapterCache.get(platform);
  const entry = PLATFORM_REGISTRY[platform];
  if (!entry) throw new Error(`reach: unknown platform "${platform}"`);
  const mod = await import(entry.module);
  const adapter = mod.default;
  _adapterCache.set(platform, adapter);
  return adapter;
}

/**
 * 执行平台操作。
 * @param {string} platform - 平台名
 * @param {string} action - 操作名
 * @param {string} query - 查询/URL/ID
 * @param {object} [opts] - 额外选项（limit/config 等）
 */
export async function executeReach(platform, action, query, opts) {
  if (!isPlatformAllowed(platform)) {
    wbD(null, "reach:exec", "whitelist.block", false, `platform "${platform}" 不在 allowedPlatforms 白名单`, { platform, action });
    throw new Error(`reach: platform "${platform}" not in allowedPlatforms whitelist`);
  }
  // [SEC 安全同步 0722] SSRF 收口：query 是 URL 形态（rss read/youtube info/jina read/
  //   xiaohongshu note 等把 query 直接交给 fetch 或 CLI 访问）时统一走 safe_fetch 权威校验，
  //   挡私网/回环/云元数据（AI 可控 URL 恒不可信，fail-closed）。纯关键词 query 不受影响。
  //   收口在此=所有适配器（原生 fetch + CLI 桥接）零遗漏，不逐适配器散修。
  if (typeof query === "string" && /^https?:\/\//i.test(query.trim())) {
    const { assertSafeUrl } = await import("../security/safe_fetch.mjs");
    await assertSafeUrl(query.trim());
  }
  const adapter = await _getAdapter(platform);
  // config 单源透传：调用方显式传的 config 字段优先（测试/覆盖场景），其余从配置单源补齐
  const cfg = getReachConfig();
  return adapter.execute(action, query, { ...opts, config: { ...cfg, ...(opts?.config || {}) } });
}
