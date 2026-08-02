import cookieParser from "npm:cookie-parser";
import cors from "npm:cors";
import express from "npm:express";
import fileUpload from "npm:express-fileupload";

import { console } from "../../scripts/i18n.mjs";
import { auth_request } from "../../yonban/core/functions/security/auth.mjs";
import { info } from "../info.mjs";
import { webRequestHappend, config } from "../server.mjs";
import { createDiag } from "../diagLogger.mjs";

// 诊断 server 模块常驻埋点（0716 死标记接线）：403 拒绝细节 + 高频静默路径的按需可见通道
const diag = createDiag("server");

// 请求日志重复聚合按“方法 + URL + 来源”分组，避免把真实重复请求伪装成服务端自激。
// 配置位于主 config：request_log_repeat_window_ms（0=逐条打印）、
// request_log_include_source（false=不附来源字段）。
const _requestLogRepeatStates = new Map();
let _requestLogSilentPatternKey = "";
let _requestLogSilentPatternCache = [];

function _boundedRequestLogWindow(value) {
  const n = Number(value);
  // 启动时由 default/config.json 补键；若运行中配置损坏，关闭聚合并逐条记录，避免静默套另一份默认策略。
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(60000, Math.round(n)));
}

function _requestLogSilentPatterns() {
  const sources = Array.isArray(config?.request_log_silent_patterns)
    ? config.request_log_silent_patterns.filter((value) => typeof value === "string")
    : [];
  const key = JSON.stringify(sources);
  if (key === _requestLogSilentPatternKey) return _requestLogSilentPatternCache;
  const compiled = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source));
    } catch (error) {
      console.warn(`[request-log] 无效静默规则 ${JSON.stringify(source)}:`, error?.message || error);
    }
  }
  _requestLogSilentPatternKey = key;
  _requestLogSilentPatternCache = compiled;
  return compiled;
}

function _requestHeader(req, name) {
  if (typeof req.get === "function") return req.get(name) || "";
  return req.headers?.[String(name).toLowerCase()] || "";
}

function _safeRequestPage(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value), "http://local.invalid");
    return parsed.origin === "http://local.invalid"
      ? parsed.pathname
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value).slice(0, 160);
  }
}

function _requestLogSource(req) {
  const producer = String(_requestHeader(req, "x-beilu-request-source"))
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 80);
  return {
    ...(producer ? { producer } : {}),
    ip: String(req.ip || req.socket?.remoteAddress || ""),
    userAgent: String(_requestHeader(req, "user-agent")).slice(0, 160),
    origin: _safeRequestPage(_requestHeader(req, "origin")),
    referer: _safeRequestPage(_requestHeader(req, "referer")),
  };
}

function _safeRequestUrl(req) {
  return String(req.url || req.path || "").replace(/beilu-apikey=[^&]*/, "beilu-apikey=***");
}

function _emitRequestLog(request, safeUrl, source, repeat = null) {
  const includeSource = config?.request_log_include_source === true;
  const metadata = {
    ...(includeSource ? { source } : {}),
    ...(repeat ? { repeat } : {}),
  };
  const metadataText = Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : "";
  console.logI18n("beiluConsole.web.requestReceived", {
    method: request.method + " ".repeat(Math.max(0, 8 - request.method.length)),
    url: `${safeUrl}${metadataText}`,
  });
}

function _scheduleRequestLogFlush(key, state) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    const current = _requestLogRepeatStates.get(key);
    if (current !== state) return;
    const now = Date.now();
    if (state.suppressedCount > 0) {
      _emitRequestLog(state.request, state.safeUrl, state.source, {
        count: state.suppressedCount,
        suppressedCount: state.suppressedCount,
        totalCount: state.totalCount,
        firstSeenAt: new Date(state.firstSeenAt).toISOString(),
        lastSeenAt: new Date(state.lastSeenAt).toISOString(),
        elapsedMs: Math.max(0, state.lastSeenAt - state.firstSeenAt),
      });
      state.firstSeenAt = now;
      state.totalCount = 0;
      state.suppressedCount = 0;
    }
    if (now - state.lastSeenAt >= state.repeatWindowMs) {
      _requestLogRepeatStates.delete(key);
      state.timer = null;
      return;
    }
    _scheduleRequestLogFlush(key, state);
  }, state.repeatWindowMs);
  state.timer?.unref?.();
}

function _flushAndDeleteRequestLogState(key, state) {
  if (state.timer) clearTimeout(state.timer);
  if (state.suppressedCount > 0) {
    _emitRequestLog(state.request, state.safeUrl, state.source, {
      count: state.suppressedCount,
      suppressedCount: state.suppressedCount,
      totalCount: state.totalCount,
      firstSeenAt: new Date(state.firstSeenAt).toISOString(),
      lastSeenAt: new Date(state.lastSeenAt).toISOString(),
      elapsedMs: Math.max(0, state.lastSeenAt - state.firstSeenAt),
    });
  }
  _requestLogRepeatStates.delete(key);
}

export function flushRequestLogAggregation() {
  for (const [key, state] of _requestLogRepeatStates) {
    _flushAndDeleteRequestLogState(key, state);
  }
}

export function logRequestWithAttribution(req) {
  const safeUrl = _safeRequestUrl(req);
  const source = _requestLogSource(req);
  const repeatWindowMs = _boundedRequestLogWindow(config?.request_log_repeat_window_ms);
  if (repeatWindowMs === 0) {
    _emitRequestLog(req, safeUrl, source);
    return;
  }

  const now = Date.now();
  const key = `${req.method}\n${safeUrl}\n${JSON.stringify(source)}`;
  let state = _requestLogRepeatStates.get(key);
  if (state && state.repeatWindowMs !== repeatWindowMs) {
    _flushAndDeleteRequestLogState(key, state);
    state = null;
  }
  if (!state) {
    const next = {
      request: { method: req.method },
      safeUrl,
      source,
      firstSeenAt: now,
      lastSeenAt: now,
      totalCount: 1,
      suppressedCount: 0,
      repeatWindowMs,
      timer: null,
    };
    _requestLogRepeatStates.set(key, next);
    _emitRequestLog(req, safeUrl, source);
    _scheduleRequestLogFlush(key, next);
  } else {
    state.lastSeenAt = now;
    state.totalCount++;
    state.suppressedCount++;
  }

  if (_requestLogRepeatStates.size > 1000) {
    for (const [entryKey, entry] of _requestLogRepeatStates) {
      if (now - entry.lastSeenAt > entry.repeatWindowMs * 2) {
        _flushAndDeleteRequestLogState(entryKey, entry);
      }
      if (_requestLogRepeatStates.size <= 800) break;
    }
  }
}

/**
 * 一个中间件，根据请求是否经过身份验证来应用不同的中间件。
 * @param {Function} if_auth - 如果请求经过身份验证，则应用的中间件。
 * @param {Function} if_not_auth - 如果请求未经过身份验证，则应用的中间件。
 * @returns {Function} 中间件函数。
 */
export function diff_if_auth(if_auth, if_not_auth) {
  return async (req, res, next) => {
    if (await auth_request(req, res)) return if_auth(req, res, next);
    return if_not_auth(req, res, next);
  };
}

/**
 * 为应用程序注册所有中间件。
 * @param {import('../../scripts/WsAbleRouter.mjs').WsAbleRouter} router - 要在其上注册中间件的 Express 路由器。
 * @returns {void}
 */
/**
 * FT7：构造 Content-Security-Policy 策略串。
 *
 * 设计原则（宽松起步，分级收紧）：本应用的核心渲染路径是把"角色卡完整 HTML 文档"
 * 通过 iframe.srcdoc 注入渲染（iframeRenderer.mjs）。srcdoc iframe **继承父页面 CSP**，
 * 因此父页面 CSP 必须放行角色卡可能用到的一切资源，否则渲染直接被打挂。
 * 每条指令的放行理由见 FT7 报告。
 *
 * 这里采用"基线宽松策略"：只挡掉最危险的 object/base/frame-ancestors，
 * 其余按现有前端 + 角色卡 srcdoc 的真实来源放行。
 * @returns {string} CSP 策略串
 */
export function buildCspPolicy() {
  // self + 常用 CDN（前端 index.html 直接引用）
  const cdn = "https://cdn.jsdelivr.net https://testingcf.jsdelivr.net https://api.iconify.design";
  const directives = [
    // 默认回退：本站 + 上述 CDN
    `default-src 'self' ${cdn}`,
    // 脚本：内联脚本(index.html <script> + onclick + srcdoc earlyScript/bridgeScript)、
    //        eval(Vue 运行时编译 / EJS 模板编译)、CDN(tailwind/daisyui browser 版)
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${cdn}`,
    // 样式：大量行内 style= + daisyui.css(CDN) + tailwind 运行时注入 <style>
    `style-src 'self' 'unsafe-inline' ${cdn}`,
    // 图片：iconify svg、角色卡可引用任意图床/data:/blob:、头像
    `img-src 'self' data: blob: https: http:`,
    // 字体：角色卡可引用 CDN 字体 + data: 内联字体
    `font-src 'self' data: https: ${cdn}`,
    // 连接：WS(自身 ws/wss) + 角色卡/前端 fetch 用户自配 API(任意 https)
    `connect-src 'self' ws: wss: https: http:`,
    // 媒体：角色卡 beiluAudio 可播放任意来源音视频
    `media-src 'self' data: blob: https: http:`,
    // 子框架：srcdoc(同源) + blob，角色卡内嵌 iframe
    `frame-src 'self' data: blob:`,
    // 危险面收紧：禁插件对象、禁 <base> 劫持、禁被第三方页面嵌套(防点击劫持)
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'self'`,
  ];
  return directives.join("; ");
}

export function registerMiddleware(router) {
  // ★ 安全层：Host + Origin 验证（防DNS重绑定 — CVE-2025-59159）
  router.use((req, res, next) => {
    const allowedHosts = [
      'localhost', '127.0.0.1', '::1', '[::1]',
      ...(config?.hostWhitelist || [])
    ];

    // 1. Host Header 验证（缺 Host 头也拒绝：合法浏览器/fetch/WS 握手必带 Host，
    //    空 Host 仅来自裸客户端或构造攻击，放行会掏空 DNS 重绑定防护）
    const host = req.headers.host?.split(':')[0]?.toLowerCase();
    if (!host || !allowedHosts.includes(host)) {
      diag.warn("拒绝非法 Host:", host ?? "(缺失)", "path:", req.path, "ip:", req.ip);
      console.warn(`[security] 拒绝非法Host: "${host ?? '(缺失)'}" (IP: ${req.ip})`);
      if (typeof res.status === 'function') return res.status(403).json({ error: 'Invalid Host header' });
      if (typeof res.end === 'function') return res.end();
      return;
    }

    // 2. Origin 验证（主要防WS跨域，HTTP由CORS处理）
    //   ★ EXT-CORS：/api/v1 外部接口层的用户可配跨域白名单（config.cors_allowed_origins，默认 []）。
    //     - 设计权威（外部接口_设计 §7.3 + 凛倾拍板 2026-06-12）：v1 服务外部网页 SDK 需跨域；
    //       但「白名单只要空白的，交给用户」=> 默认空数组 = 拒绝所有外部 origin（与改前行为等价安全）。
    //     - 命中白名单的 origin：放行全局 Origin 校验 + 由本中间件回显 CORS 头并处理 OPTIONS 预检。
    //     - 本机/同源/localhost（落在 allowedHosts）行为零变化；无任何外网依赖（纯本地 config 读取）。
    const origin = req.headers.origin;
    const isV1 = req.path?.startsWith('/api/v1');
    const corsAllowedOrigins = Array.isArray(config?.cors_allowed_origins) ? config.cors_allowed_origins : [];
    const v1OriginAllowed = isV1 && origin && corsAllowedOrigins.includes(origin);

    if (v1OriginAllowed) {
      // 用户已显式把该外部 origin 加入 v1 白名单 → 回显 CORS 头 + 处理预检，绕过全局 Origin 拒绝。
      // ★ CORS 单源（测试轮 2026-06-12 确诊）：标记本请求 CORS 头已由 EXT-CORS 决定，
      //   下游 legacy cors()（:178 附近）必须跳过——否则其默认配置会把这里的精确
      //   ACAO+Allow-Credentials 覆盖成 `*`，预检与实际响应不一致，带 cookie 跨域被浏览器拒收。
      req._extCorsHandled = true;
      if (typeof res.setHeader === 'function') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key, X-Beilu-Request-Source');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      // CORS 预检请求直接 204 结束（不进后续认证/路由）。
      if (req.method === 'OPTIONS') {
        if (typeof res.status === 'function') return res.status(204).end();
        if (typeof res.end === 'function') return res.end();
        return;
      }
      return next();
    }

    if (origin) {
      try {
        const originHost = new URL(origin).hostname.toLowerCase();
        if (!allowedHosts.includes(originHost)) {
          diag.warn("拒绝非法 Origin:", origin, "path:", req.path, "ip:", req.ip);
          console.warn(`[security] 拒绝非法Origin: "${origin}" (IP: ${req.ip})`);
          if (typeof res.status === 'function') return res.status(403).json({ error: 'Invalid Origin' });
          if (typeof res.end === 'function') return res.end();
          return;
        }
      } catch {
        if (typeof res.status === 'function') return res.status(403).json({ error: 'Invalid Origin format' });
        if (typeof res.end === 'function') return res.end();
        return;
      }
    }

    next();
  });

  // ★ FT7：Content-Security-Policy 响应头（真实实装，用户可开关）
  //   开关优先级：env BEILU_CSP=off 强制关 > config.csp_enabled(默认 true)。
  //   策略由 buildCspPolicy() 生成，已兼容现有前端 + 角色卡 srcdoc 渲染（见 FT7 报告）。
  router.use((req, res, next) => {
    const envOff = process.env.BEILU_CSP === "off";
    // config.csp_enabled 默认值 = 开（undefined / null 视为开）
    const cfgEnabled = config?.csp_enabled !== false;
    if (!envOff && cfgEnabled && typeof res.setHeader === "function") {
      res.setHeader("Content-Security-Policy", buildCspPolicy());
    }
    return next();
  });

  router.use(cookieParser());

  router.use((req, res, next) => {
    res.setHeader("X-Powered-By", info.xPoweredBy);
    const isHighFreq = _requestLogSilentPatterns().some((pattern) => pattern.test(req.path));
    if (!req.path.endsWith("/heartbeat") && !isHighFreq)
      logRequestWithAttribution(req);
    // 被高频白名单静默的请求走 diag 按需可见通道（BEILU_DIAG=server + debug 级），
    // 补上"静默即不可观测"的洞（:183 注释预留的按 verb 精筛之前的过渡观测口）
    else if (isHighFreq) diag.debug(req.method, req.url.replace(/beilu-apikey=[^&]*/, "beilu-apikey=***"));
    webRequestHappend();
    return next();
  });

  router.use(
    diff_if_auth(
      express.json({ limit: 100 * 1024 * 1024 }), // 100MB: 已认证用户上限
      express.json({ limit: 20 * 1024 * 1024 }), // 20MB: beilu-eye 截图 base64 可能超过 5MB
    ),
  );

  // ★ CORS 单源：EXT-CORS（上方 v1 白名单分支）已写头的请求跳过 legacy cors()，
  //   保证每个请求只有一个 ACAO 写入者。未命中 EXT-CORS 的请求（localhost 跨端口/
  //   hostWhitelist/无 Origin）行为与原先完全一致。
  const _skipIfExtCors = (mw) => (req, res, next) => req._extCorsHandled ? next() : mw(req, res, next);
  router.use(diff_if_auth(_skipIfExtCors(cors()), _skipIfExtCors(cors({ origin: false }))));

  router.use(
    diff_if_auth(
      express.urlencoded({ limit: 100 * 1024 * 1024, extended: true }),
      express.urlencoded({ limit: 5 * 1024 * 1024, extended: true }),
    ),
  );

  router.use(
    diff_if_auth(
      fileUpload({ limits: { fileSize: 200 * 1024 * 1024 } }), // 200MB
      fileUpload({ limits: { fileSize: 5 * 1024 * 1024 } }),
    ),
  );
}
