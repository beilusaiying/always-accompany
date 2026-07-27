/**
 * doctor.mjs — 平台工具健康检查
 *
 * 遍历 PLATFORM_REGISTRY 逐平台探测可用性，缓存结果。
 * 结果供 GetData 下发前端 + GetPrompt 过滤可用平台。
 */

import { PLATFORM_REGISTRY } from "./registry.mjs";
import { wbT } from "../../../../server/wbStub.mjs"; // 白盒：探测汇总一条（逐平台 probe 走 quiet 降噪）

/** @type {Record<string, {status:string, backend?:string, version?:string, message?:string, tier:number, label:string, actions:string[]}>} */
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

/**
 * 对所有平台执行健康检查。
 * @param {boolean} [force=false] - 强制刷新（忽略缓存）
 * @returns {Promise<Record<string, object>>}
 */
export async function runDoctor(force = false) {
  if (!force && _cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  const results = {};
  const probes = Object.entries(PLATFORM_REGISTRY).map(async ([name, entry]) => {
    try {
      const probeResult = await entry.probe();
      results[name] = {
        status: probeResult.status,
        backend: probeResult.status === "ok" ? entry.backends[0] : null,
        version: probeResult.version || null,
        message: probeResult.message || null,
        tier: entry.tier,
        label: entry.label,
        actions: entry.actions,
        domains: entry.domains,
        // 凭据声明随报告下发（前端凭据区按此渲染+帮助折叠块，零前端硬编码）
        credentials: entry.credentials || [],
        credentialHelp: entry.credentialHelp || "",
      };
    } catch (err) {
      results[name] = {
        status: "error",
        backend: null,
        version: null,
        message: err.message,
        tier: entry.tier,
        label: entry.label,
        actions: entry.actions,
        domains: entry.domains,
        credentials: entry.credentials || [],
        credentialHelp: entry.credentialHelp || "",
      };
    }
  });

  await Promise.all(probes);
  _cache = results;
  _cacheTime = Date.now();
  const _byStatus = {};
  for (const r of Object.values(results)) _byStatus[r.status] = (_byStatus[r.status] || 0) + 1;
  wbT(null, "reach:doctor", "probe.done", _byStatus);
  return results;
}

/** 获取当前可用（status=ok）的平台列表 */
export async function getAvailablePlatforms() {
  const report = await runDoctor();
  return Object.entries(report)
    .filter(([, r]) => r.status === "ok")
    .map(([name, r]) => ({ name, ...r }));
}

/** 清除缓存（配置变更后调用） */
export function invalidateCache() {
  _cache = null;
  _cacheTime = 0;
}
