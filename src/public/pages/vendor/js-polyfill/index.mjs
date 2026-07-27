// js-polyfill 入口（本地化副本，避免运行时 jsdelivr CDN 依赖）
// 来源: https://cdn.jsdelivr.net/gh/steve02081504/js-polyfill/index.mjs
// 本地化日期: 2026-06-12
// 说明: 原文件中的 https://esm.sh/* 子依赖改写为 /esm-cache/*，
//       经项目 esmProxy（缓存优先 + 离线兜底，见 server/web_server/esmProxy.mjs）加载。
//       保留原 .catch 降级：任一 polyfill 缺失/离线时静默跳过，不阻塞前端启动。
if (!JSON.isRawJSON) await import('/esm-cache/core-js').catch(_ => 0)

if (globalThis.document) await import('./browser.mjs').catch(_ => 0)
