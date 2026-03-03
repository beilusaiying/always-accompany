/**
 * ESM 缓存代理
 *
 * 解决大陆网络 esm.sh 访问超时导致前端页面卡死的问题。
 *
 * 工作原理：
 * 1. 前端 import('https://esm.sh/xxx') 改为 import('/esm-cache/xxx')
 * 2. 后端收到 /esm-cache/xxx 请求时：
 *    a. 先查本地磁盘缓存（__dirname/.esm-cache/）
 *    b. 缓存命中 → 直接返回（毫秒级）
 *    c. 缓存未命中 → 从 esm.sh 拉取，存入缓存，再返回
 * 3. 缓存永不过期（esm.sh URL 自带版本锁定）
 * 4. 拉取超时 15s → 返回 504，前端用 .catch() 处理降级
 * 5. 回退代理：未走 /esm-cache/ 的 esm.sh 子依赖请求自动重定向
 */

import fs from "node:fs";
import path from "node:path";

import { __dirname } from "../base.mjs";

const CACHE_DIR = path.join(__dirname, ".esm-cache");
const UPSTREAM = "https://esm.sh";
const FETCH_TIMEOUT = 60_000; // 60秒超时 — 优先从上游加载，超时才用缓存

// 缓存格式版本 — 修改 rewriteEsmUrls 逻辑后递增此值，自动使旧缓存失效
const CACHE_VERSION = 3;

// 确保缓存目录存在
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ESM 代理统计 — 减少日志噪音，只在关键事件时输出
const _esmStats = { hit: 0, rewritten: 0, miss: 0, error: 0, fallback: 0 };
let _esmStatsTimer = null;
function _esmLog() {
  // 延迟 2 秒汇总输出，避免逐条刷屏
  if (_esmStatsTimer) clearTimeout(_esmStatsTimer);
  _esmStatsTimer = setTimeout(() => {
    const s = _esmStats;
    const parts = [];
    if (s.hit) parts.push(`${s.hit} hit`);
    if (s.rewritten) parts.push(`${s.rewritten} rewritten`);
    if (s.miss) parts.push(`${s.miss} fetched`);
    if (s.fallback) parts.push(`${s.fallback} redirected`);
    if (s.error) parts.push(`${s.error} errors`);
    if (parts.length) console.log(`[esm-proxy] Summary: ${parts.join(", ")}`);
    _esmStats.hit =
      _esmStats.rewritten =
      _esmStats.miss =
      _esmStats.error =
      _esmStats.fallback =
        0;
  }, 2000);
}

/**
 * 重写 esm.sh 返回的 JS 代码中的 URL 引用
 *
 * esm.sh 返回的代码中有多种内部引用方式：
 * 1. 完整 URL: `https://esm.sh/xxx` → `/esm-cache/xxx`
 * 2. 绝对路径（带 @scope + 版本）: `"/@shikijs/core@4.0.0/..."` → `"/esm-cache/@shikijs/core@4.0.0/..."`
 * 3. 绝对路径（包名 + 版本）: `"/bail@^2.0.0"` → `"/esm-cache/bail@^2.0.0"`
 * 4. 绝对路径（包名 + ?target=）: `"/acorn?target=es2022"` → `"/esm-cache/acorn?target=es2022"`
 * 5. 绝对路径（@scope + ?target=）: `"/@scope/pkg?target=es2022"` → `"/esm-cache/@scope/pkg?target=es2022"`
 *
 * @param {string} body - esm.sh 返回的响应体
 * @returns {string} 重写后的内容
 */
function rewriteEsmUrls(body) {
  // 第一步：替换完整的 https://esm.sh/ URL
  let result = body.replace(/https:\/\/esm\.sh\//g, "/esm-cache/");

  // 第二步：替换 esm.sh Node.js polyfill 路径
  // esm.sh 会将 Node 内置模块引用转为 "/node/buffer.mjs"、"/node/process.mjs" 等
  result = result.replace(
    /(["'])\/node\/([a-zA-Z0-9_.-]+\.mjs)/g,
    "$1/esm-cache/node/$2",
  );

  // 第三步：替换 JS 代码中以 "/" 开头的 esm.sh 内部绝对路径引用
  // 模式 A：有 @版本号 — "/bail@^2.0.0" 或 "/@shikijs/core@4.0.0/es2022/core.mjs"
  // 模式 B：无版本号但有 ?target= — "/acorn?target=es2022"
  // 排除已重写的 "/esm-cache/" 路径
  result = result.replace(
    /(["'])\/((?!esm-cache\/)((?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+(?:@[^\s"']*|(?=\?target=)[^\s"']*)))/g,
    (match, quote, fullPath, _inner) => {
      // 只重写包含 @ 版本号或 ?target= 的路径（esm.sh 内部引用特征）
      if (fullPath.includes("@") || fullPath.includes("?target=")) {
        return `${quote}/esm-cache/${fullPath}`;
      }
      return match;
    },
  );

  return result;
}

/**
 * 将 URL 路径转为安全的缓存文件路径
 * /esm-cache/@xterm/addon-fit → .esm-cache/@xterm/addon-fit/index.mjs
 * /esm-cache/chroma-js → .esm-cache/chroma-js/index.mjs
 * @param {string} urlPath - 去掉 /esm-cache/ 前缀后的路径
 * @returns {string} 缓存文件的完整路径
 */
function getCachePath(urlPath) {
  // 对路径进行清理，防止目录遍历
  const cleaned = urlPath.replace(/\.\./g, "__").replace(/[<>"|?*]/g, "_");
  // 如果路径不以文件扩展名结尾，加上 /index.mjs
  const hasExt = /\.[a-zA-Z0-9]+$/.test(cleaned);
  const filePart = hasExt ? cleaned : cleaned + "/index.mjs";
  return path.join(CACHE_DIR, filePart);
}

/**
 * 注册 ESM 缓存代理路由
 * @param {import('npm:express').Router} router
 */
export function registerEsmProxy(router) {
  router.use("/esm-cache", async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).send("Method Not Allowed");
    }

    const esmPath = req.path; // 已经去掉了 /esm-cache 前缀
    if (!esmPath || esmPath === "/") {
      return res.status(400).send("Missing package path");
    }

    const cachePath = getCachePath(esmPath);
    const versionPath = cachePath + ".v" + CACHE_VERSION;
    const upstreamUrl = UPSTREAM + esmPath;

    // 策略：优先从 esm.sh 拉取，超过 60s 才回退到本地缓存
    try {
      const response = await fetch(upstreamUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { "User-Agent": "beilu-esm-proxy/1.0" },
        redirect: "follow",
      });

      if (!response.ok) {
        // .map 文件 404 是正常情况（esm.sh 不一定提供 source map），静默返回
        if (response.status === 404 && esmPath.endsWith(".map")) {
          return res.status(404).send("Not Found");
        }
        // 上游返回错误码 — 抛出让 catch 统一处理回退
        throw new Error(`Upstream ${response.status}: ${response.statusText}`);
      }

      // 上游成功 — 读取、重写、缓存、返回
      const body = await response.text();
      const rewritten = rewriteEsmUrls(body);

      // 更新本地缓存（下次超时时可用）
      const cacheDir = path.dirname(cachePath);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, rewritten, "utf-8");
      fs.writeFileSync(versionPath, "", "utf-8");

      const contentType =
        response.headers.get("content-type") || "application/javascript";
      res.type(contentType);
      res.setHeader("X-ESM-Cache", "UPSTREAM");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(rewritten);

      _esmStats.miss++;
      _esmLog();
    } catch (err) {
      // esm.sh 失败（超时 60s / 网络错误 / HTTP 错误）— 回退到本地缓存
      if (fs.existsSync(cachePath)) {
        try {
          let content = fs.readFileSync(cachePath, "utf-8");
          // 旧版本缓存需要重写
          if (!fs.existsSync(versionPath)) {
            content = rewriteEsmUrls(content);
            fs.writeFileSync(cachePath, content, "utf-8");
            fs.writeFileSync(versionPath, "", "utf-8");
          }

          const ext = path.extname(cachePath);
          if (ext === ".mjs" || ext === ".js")
            res.type("application/javascript");
          else if (ext === ".css") res.type("text/css");
          else res.type("application/javascript");
          res.setHeader("X-ESM-Cache", "FALLBACK");
          res.setHeader("Cache-Control", "public, max-age=3600");
          res.send(content);

          _esmStats.hit++;
          _esmLog();
          return;
        } catch (_) {
          /* 缓存读取失败，继续到下面返回错误 */
        }
      }

      // 无缓存可用 — 返回错误
      _esmStats.error++;
      _esmLog();
      const isTimeout =
        err.name === "TimeoutError" || err.name === "AbortError";
      if (isTimeout) {
        console.error(
          `[esm-proxy] ⏱ Timeout (${FETCH_TIMEOUT / 1000}s), no cache: ${esmPath}`,
        );
        return res
          .status(504)
          .send("ESM proxy: upstream timeout, no cache available");
      }
      console.error(`[esm-proxy] ❌ No cache: ${esmPath} — ${err.message}`);
      return res
        .status(502)
        .send("ESM proxy: upstream error, no cache available");
    }
  });
}

/**
 * 注册 ESM 回退代理路由
 *
 * 兜住那些没走 /esm-cache/ 路径的 esm.sh 子依赖请求。
 * 这些请求的特征是：路径包含 @版本号 或 ?target= 参数，
 * 且不是项目自身的 API/资源路径。
 *
 * 匹配到的请求会被 302 重定向到 /esm-cache/xxx，
 * 由 esmProxy 统一处理缓存和代理逻辑。
 *
 * @param {import('npm:express').Router} router
 */
export function registerEsmFallback(router) {
  router.use((req, res, next) => {
    if (req.method !== "GET") return next();

    const p = req.path;
    const q = req.originalUrl;

    // 跳过项目自身的路径
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

    // 匹配 esm.sh 子依赖特征：
    // 1. 路径包含 @（版本号或 scope），如 /ccount@^2.0.0 或 /@shikijs/core@4.0.0
    // 2. 路径包含 ?target=（esm.sh 构建参数）
    // 3. /node/ 前缀的 Node.js polyfill，如 /node/buffer.mjs
    const looksLikeEsm =
      /^\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+[@]/.test(p) ||
      q.includes("?target=") ||
      /^\/node\/[a-zA-Z0-9_.-]+\.mjs$/.test(p);

    if (looksLikeEsm) {
      // 重定向到 /esm-cache/ 路径
      const esmCacheUrl = "/esm-cache" + q.slice(q.indexOf(p));
      _esmStats.fallback++;
      _esmLog();
      return res.redirect(302, esmCacheUrl);
    }

    next();
  });
}
