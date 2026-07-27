/**
 * ESM 缓存代理 v2 — 缓存优先 + 镜像回退 + 加载诊断
 *
 * 策略：
 * 1. 缓存优先：本地有缓存 → 立即返回（毫秒级），后台静默刷新
 * 2. 缓存未命中 → esm.sh (10s) → esm.run (10s) → 502/504
 * 3. /esm-cache/_diagnostic 端点查看缓存状态和上游连通性
 */

import fs from "node:fs";
import path from "node:path";

import { __dirname } from "../base.mjs";

const CACHE_DIR = path.join(__dirname, ".esm-cache");
const CACHE_VERSION = 3;
const FETCH_TIMEOUT = 10_000; // 10s — 缓存优先后无需长超时

const UPSTREAMS = [
  { name: "esm.sh", base: "https://esm.sh" },
  { name: "esm.run", base: "https://esm.run" },
];

// 后台刷新节流：同一路径 24h 内只刷新一次
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
const _lastRefresh = new Map();

// 正在进行的后台刷新（防重复）
const _pendingRefresh = new Set();

// [0722 排雷] 原顶层 fs.mkdirSync(CACHE_DIR)：import 期无 try 硬崩点（只读/受限文件系统=服务器
//   起不来），且冗余——写侧 writeCache 自带 mkdirSync+try（写点自保），读侧全 try 包裹，无消费方
//   依赖启动时目录已存在。故整行删除，目录创建收敛到写点。

// ── 统计 ──────────────────────────────────────────────
const _stats = { cacheHit: 0, cacheMiss: 0, upstreamOk: 0, mirrorOk: 0, error: 0, bgRefresh: 0 };
let _statsTimer = null;
function _logStats() {
  if (_statsTimer) clearTimeout(_statsTimer);
  _statsTimer = setTimeout(() => {
    const s = _stats;
    const parts = [];
    if (s.cacheHit) parts.push(`${s.cacheHit} cache-hit`);
    if (s.cacheMiss) parts.push(`${s.cacheMiss} cache-miss`);
    if (s.upstreamOk) parts.push(`${s.upstreamOk} upstream`);
    if (s.mirrorOk) parts.push(`${s.mirrorOk} mirror`);
    if (s.bgRefresh) parts.push(`${s.bgRefresh} bg-refresh`);
    if (s.error) parts.push(`${s.error} errors`);
    if (parts.length) console.log(`[esm-proxy] ${parts.join(", ")}`);
    s.cacheHit = s.cacheMiss = s.upstreamOk = s.mirrorOk = s.error = s.bgRefresh = 0;
  }, 2000);
}

// ── URL 重写 ──────────────────────────────────────────
/**
 * 重写上游返回的 JS 代码中的 URL 引用，统一指向 /esm-cache/
 */
function rewriteEsmUrls(body) {
  let result = body;

  // esm.sh 完整 URL
  result = result.replace(/https:\/\/esm\.sh\//g, "/esm-cache/");

  // esm.run 完整 URL
  result = result.replace(/https:\/\/esm\.run\//g, "/esm-cache/");

  // Node.js polyfill: "/node/buffer.mjs" → "/esm-cache/node/buffer.mjs"
  result = result.replace(
    /(["'])\/node\/([a-zA-Z0-9_.-]+\.mjs)/g,
    "$1/esm-cache/node/$2",
  );

  // esm.sh 内部绝对路径（带 @版本号 或 ?target=）
  result = result.replace(
    /(["'])\/((?!esm-cache\/)((?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+(?:@[^\s"']*|(?=\?target=)[^\s"']*)))/g,
    (match, quote, fullPath) => {
      if (fullPath.includes("@") || fullPath.includes("?target=")) {
        return `${quote}/esm-cache/${fullPath}`;
      }
      return match;
    },
  );

  return result;
}

// ── 缓存路径 ─────────────────────────────────────────
function getCachePath(urlPath) {
  const cleaned = urlPath.replace(/\.\./g, "__").replace(/[<>"|?*]/g, "_");
  const hasExt = /\.[a-zA-Z0-9]+$/.test(cleaned);
  const filePart = hasExt ? cleaned : cleaned + "/index.mjs";
  return path.join(CACHE_DIR, filePart);
}

// ── 二进制资产判定 ───────────────────────────────────
// T018：.wasm 等二进制资产必须走 Buffer 管道——文本管道（response.text() + utf-8 写盘 + URL 重写）
// 会把二进制体按 UTF-8 解码损坏。首个消费者 = markdownConvertor sql.js 的 sql-wasm.wasm。
function isBinaryPath(p) {
  return /\.wasm$/i.test(p);
}

// ── 从上游拉取 ───────────────────────────────────────
async function fetchFromUpstream(esmPath) {
  for (const upstream of UPSTREAMS) {
    const url = upstream.base + esmPath;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { "User-Agent": "beilu-esm-proxy/2.0" },
        redirect: "follow",
      });

      if (!response.ok) {
        if (response.status === 404 && esmPath.endsWith(".map")) {
          return { status: 404, body: null, source: upstream.name };
        }
        continue;
      }

      const binary = isBinaryPath(esmPath);
      const body = binary
        ? Buffer.from(await response.arrayBuffer())
        : rewriteEsmUrls(await response.text());
      const contentType = response.headers.get("content-type") || (binary ? "application/wasm" : "application/javascript");

      return { status: 200, body, contentType, source: upstream.name };
    } catch (_) {
      // 当前上游失败，尝试下一个
    }
  }
  return null;
}

// ── 写缓存 ───────────────────────────────────────────
function writeCache(cachePath, content) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, content, "utf-8");
    fs.writeFileSync(cachePath + ".v" + CACHE_VERSION, "", "utf-8");
  } catch (_) {
    // 写入失败不影响响应
  }
}

// ── 读缓存 ───────────────────────────────────────────
function readCache(cachePath) {
  if (!fs.existsSync(cachePath)) return null;
  try {
    // T018：二进制直接返回 Buffer，跳过 utf-8 解码与 URL 重写（writeFileSync 对 Buffer 忽略 encoding，写侧无需分支）
    if (isBinaryPath(cachePath)) return fs.readFileSync(cachePath);
    let content = fs.readFileSync(cachePath, "utf-8");
    const versionPath = cachePath + ".v" + CACHE_VERSION;
    if (!fs.existsSync(versionPath)) {
      content = rewriteEsmUrls(content);
      writeCache(cachePath, content);
    }
    return content;
  } catch (_) {
    return null;
  }
}

// ── 后台刷新 ─────────────────────────────────────────
function backgroundRefresh(esmPath, cachePath) {
  const now = Date.now();
  const lastTime = _lastRefresh.get(esmPath) || 0;
  if (now - lastTime < REFRESH_INTERVAL) return;
  if (_pendingRefresh.has(esmPath)) return;

  _pendingRefresh.add(esmPath);
  _lastRefresh.set(esmPath, now);

  fetchFromUpstream(esmPath)
    .then((result) => {
      if (result && result.status === 200) {
        writeCache(cachePath, result.body);
        _stats.bgRefresh++;
        _logStats();
      }
    })
    .catch(() => {})
    .finally(() => _pendingRefresh.delete(esmPath));
}

// ── Content-Type 推断 ────────────────────────────────
function guessContentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".css") return "text/css";
  if (ext === ".json") return "application/json";
  if (ext === ".wasm") return "application/wasm";
  return "application/javascript";
}

// ── 诊断端点 ─────────────────────────────────────────
async function handleDiagnostic(_req, res) {
  const diag = {
    timestamp: new Date().toISOString(),
    cache: { dir: CACHE_DIR, version: CACHE_VERSION, files: 0, totalBytes: 0 },
    upstreams: [],
    stats: { ..._stats },
  };

  // 统计缓存
  try {
    const countFiles = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          countFiles(full);
        } else if (!e.name.startsWith(".v")) {
          diag.cache.files++;
          try { diag.cache.totalBytes += fs.statSync(full).size; } catch (_) {}
        }
      }
    };
    countFiles(CACHE_DIR);
    diag.cache.totalMB = (diag.cache.totalBytes / 1048576).toFixed(1);
  } catch (_) {
    diag.cache.error = "Failed to scan cache directory";
  }

  // 测试上游连通性
  for (const upstream of UPSTREAMS) {
    const testUrl = upstream.base + "/unified@11.0.5";
    const t0 = Date.now();
    try {
      const resp = await fetch(testUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "beilu-esm-proxy/2.0" },
        redirect: "follow",
      });
      diag.upstreams.push({
        name: upstream.name,
        url: upstream.base,
        status: resp.status,
        latencyMs: Date.now() - t0,
        ok: resp.ok,
      });
    } catch (err) {
      diag.upstreams.push({
        name: upstream.name,
        url: upstream.base,
        status: "FAIL",
        latencyMs: Date.now() - t0,
        error: err.message || String(err),
      });
    }
  }

  // 检查关键依赖缓存
  const criticalDeps = [
    "unified", "remark-parse", "remark-gfm", "remark-math",
    "remark-breaks", "remark-rehype", "rehype-raw", "rehype-stringify",
    "rehype-katex", "rehype-pretty-code", "rehype-mermaid",
    "shiki", "hast-util-from-html", "hast-util-to-html",
    "hastscript", "lang-map", "md5", "unist-util-visit",
  ];
  diag.criticalDeps = criticalDeps.map((dep) => {
    const cp = getCachePath("/" + dep);
    return { name: dep, cached: fs.existsSync(cp) };
  });
  const cachedCount = diag.criticalDeps.filter((d) => d.cached).length;
  diag.criticalDeps.summary = `${cachedCount}/${criticalDeps.length} cached`;

  res.type("application/json");
  res.send(JSON.stringify(diag, null, 2));
}

// ── 预热(构建期/发布前) ────────────────────────────────
/**
 * 按静态引用清单把模块拉进缓存,不经 HTTP 服务(warm_esm_cache.mjs 消费)。
 * why:缓存"按使用积累"原理上永不完整(条件加载件在开发机动线上不触发,2026-07-19 实核 16/37 缺),
 * 发布前必须按代码静态清单预热;逻辑复用本模块私有件,不在脚本里复制取件/写缓存实现。
 * @param {string[]} esmPaths - /esm-cache/ 后的路径清单(如 "/@xterm/addon-fit@^0.11.0")。
 * @returns {Promise<{ok:string[],cached:string[],failed:string[]}>}
 */
export async function warmEsmCache(esmPaths) {
  const results = { ok: [], cached: [], failed: [] };
  for (const p of esmPaths) {
    const cachePath = getCachePath(p);
    if (readCache(cachePath) !== null) { results.cached.push(p); continue; }
    const got = await fetchFromUpstream(p);
    if (got && got.status === 200) { writeCache(cachePath, got.body); results.ok.push(p); }
    else results.failed.push(p);
  }
  return results;
}

// ── 主路由 ───────────────────────────────────────────
export function registerEsmProxy(router) {
  // 诊断端点
  router.get("/esm-cache/_diagnostic", handleDiagnostic);

  router.use("/esm-cache", async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).send("Method Not Allowed");
    }

    const esmPath = req.path;
    if (!esmPath || esmPath === "/") {
      return res.status(400).send("Missing package path");
    }

    const cachePath = getCachePath(esmPath);

    // ═══ 阶段1：缓存优先 ═══
    const cached = readCache(cachePath);
    if (cached) {
      res.type(guessContentType(cachePath));
      res.setHeader("X-ESM-Cache", "HIT");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(cached);

      _stats.cacheHit++;
      _logStats();

      // 后台静默刷新（不阻塞响应）
      backgroundRefresh(esmPath, cachePath);
      return;
    }

    // ═══ 阶段2：缓存未命中 → 上游链 ═══
    _stats.cacheMiss++;

    const result = await fetchFromUpstream(esmPath);

    if (result && result.status === 404) {
      return res.status(404).send("Not Found");
    }

    if (result && result.status === 200) {
      writeCache(cachePath, result.body);

      res.type(result.contentType);
      res.setHeader("X-ESM-Cache", `MISS-${result.source}`);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(result.body);

      if (result.source === UPSTREAMS[0].name) {
        _stats.upstreamOk++;
      } else {
        _stats.mirrorOk++;
      }
      _logStats();
      return;
    }

    // ═══ 全部失败 ═══
    _stats.error++;
    _logStats();
    console.error(`[esm-proxy] All upstreams failed, no cache: ${esmPath}`);
    return res.status(502).send("ESM proxy: all upstreams failed, no cache available");
  });
}

// ── 回退路由（兜底未走 /esm-cache/ 的子依赖请求）────
export function registerEsmFallback(router) {
  router.use((req, res, next) => {
    if (req.method !== "GET") return next();

    const p = req.path;
    const q = req.originalUrl;

    if (
      p.startsWith("/esm-cache/") ||
      p.startsWith("/api/") ||
      p.startsWith("/ws/") ||
      p.startsWith("/parts/") ||
      p.startsWith("/scripts/") ||
      p.startsWith("/pages/") ||
      p.startsWith("/vendor/") ||
      p.startsWith("/.well-known/") ||
      p === "/" ||
      p === "/favicon.ico"
    ) {
      return next();
    }

    const looksLikeEsm =
      /^\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+[@]/.test(p) ||
      q.includes("?target=") ||
      /^\/node\/[a-zA-Z0-9_.-]+\.mjs$/.test(p);

    if (looksLikeEsm) {
      const esmCacheUrl = "/esm-cache" + q.slice(q.indexOf(p));
      return res.redirect(302, esmCacheUrl);
    }

    next();
  });
}
