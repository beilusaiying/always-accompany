/**
 * diagProbes.mjs — dom / perf 两个诊断模块的常驻探针（0716 死标签接线批）
 *
 * why：诊断面板 15 个前端模块标签中 dom/perf 无自然宿主文件（其余模块埋点直接进各自宿主：
 *   template→pages/scripts/template.mjs、api→api-client、config→storage 写路、sidebar/layout/
 *   fileExplorer→同名文件），这两个是横切观测面，收口进本模块，index.mjs 启动链调用 installDiagProbes()。
 *
 * 功能链：
 *   perf：PerformanceObserver(longtask/paint) + navigation timing → diag('perf') 输出。
 *     事件驱动零轮询，观察器常驻（浏览器不支持的 entryType 静默跳过），输出由 diagLogger
 *     模块过滤门控（perf 未启用=零 console 输出）。
 *   dom：MutationObserver(document.body 全子树) → 5s 聚合计数 → diag('dom') 输出。
 *     观察器本体有真实开销（流式渲染期回调高频），故只在启动时 dom 模块已启用才安装——
 *     面板开启 dom 后需刷新页面生效（与 diagLogger 头注释的 localStorage 语义一致）。
 *
 * 关联链：← index.mjs init()（唯一调用方）
 *   → diagLogger.mjs createDiag / storage.mjs（读 BEILU_DIAG_MODULES 判 dom 安装门槛）
 *
 * 影响范围：仅 console 诊断输出与 diagLogger logBuffer；不碰业务 DOM、不发请求。
 */

import { createDiag } from "./diagLogger.mjs";
import { storage, KEYS } from "./storage.mjs";

let _installed = false;

/** 安装 dom/perf 常驻探针（幂等）。 */
export function installDiagProbes() {
  if (_installed || typeof window === "undefined") return;
  _installed = true;
  _installPerfProbe();
  _installDomProbe();
}

function _installPerfProbe() {
  const diag = createDiag("perf");
  // 长任务（主线程阻塞 >50ms）：流式渲染卡顿/rAF 覆盖类问题的第一手时序证据
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        diag.throttled("longtask", 5, `longtask ${e.duration.toFixed(0)}ms @${e.startTime.toFixed(0)}`);
        if (e.duration > 300) diag.warn(`长任务阻塞 ${e.duration.toFixed(0)}ms（主线程卡顿可感知）`);
      }
    }).observe({ type: "longtask", buffered: true });
  } catch { /* 浏览器不支持 longtask：跳过 */ }
  // 首帧指标（一次性）
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) diag.log(`${e.name}: ${e.startTime.toFixed(0)}ms`);
    }).observe({ type: "paint", buffered: true });
  } catch { /* 不支持 paint：跳过 */ }
  // 导航计时（load 后一次）：DCL/load 总耗时
  try {
    const _logNav = () => {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) diag.log(`navigation: DCL ${nav.domContentLoadedEventEnd.toFixed(0)}ms · load ${nav.loadEventEnd.toFixed(0)}ms · transfer ${(nav.transferSize / 1024).toFixed(0)}KB`);
    };
    if (document.readyState === "complete") _logNav();
    else window.addEventListener("load", () => setTimeout(_logNav, 0), { once: true });
  } catch { /* 计时不可用：跳过 */ }
}

function _installDomProbe() {
  // 安装门槛：MutationObserver 全子树观察在流式渲染期有真实回调开销，仅 dom 模块启用时常驻
  let enabled = false;
  try {
    const v = storage.get(KEYS.BEILU_DIAG_MODULES) || "";
    enabled = v.trim() === "*" || v.split(",").map((s) => s.trim()).includes("dom");
  } catch { /* storage 不可用视为未启用 */ }
  if (!enabled) return;

  const diag = createDiag("dom");
  diag.log("dom 探针已安装（body 全子树变更聚合，5s 一报）");
  let added = 0, removed = 0, attrs = 0, batches = 0;
  const observer = new MutationObserver((records) => {
    batches++;
    let batchNodes = 0;
    for (const r of records) {
      added += r.addedNodes.length;
      removed += r.removedNodes.length;
      batchNodes += r.addedNodes.length + r.removedNodes.length;
      if (r.type === "attributes") attrs++;
    }
    // 单批巨量变更 = 全量重建信号（差量更新失效/innerHTML 大面积覆写）
    if (batchNodes > 500) diag.warn(`单批 DOM 变更 ${batchNodes} 节点（疑似全量重建）`, records[0]?.target?.id || records[0]?.target?.nodeName);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  setInterval(() => {
    if (added || removed || attrs) {
      diag.debug(`5s 聚合: +${added} 节点 / -${removed} 节点 / ${attrs} 属性变更 / ${batches} 批`);
      added = removed = attrs = batches = 0;
    }
  }, 5000);
}
