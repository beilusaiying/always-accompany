/**
 * monitor.mjs — 后台监控系统（错误收集 + 路由统计 + asyncHandler 包装器）。
 *   不管业务逻辑/认证策略（那是各路由和 auth.mjs 的事）。
 *
 * 三大功能：
 *   1. 结构化错误收集：makeErrorEntry → 内存环形缓冲(1000 条) + JSONL 磁盘持久化（7 天轮转）
 *   2. 路由调用统计：recordRouteCall → 次数/错误率/延迟/最大延迟
 *   3. asyncHandler 包装器：自动 try-catch + 统计 + 500 JSON 响应（被全项目路由 handler 引用）
 *
 * 链路：web_server/index.mjs → registerMonitorRoutes(mainRouter)（必须先于 registerV1Routes，
 *        否则 /api/v1/monitor/errors/report 匿名端点会被 v1 的 apiKeyAuth 中间件 401 拦截）
 * 影响：写 data/logs/errors-*.jsonl 日志文件；installConsoleHook 替换全局 console.error/warn
 * 相交：← web_server/index.mjs(registerMonitorRoutes/installConsoleHook)
 *         / 全项目路由 handler(asyncHandler)
 *         / 各模块(logError/logWarn/logInfo)
 *       → auth.mjs(authenticate) / whitebox.mjs(getWhiteboxRing/isWhiteboxEnabled/setWhiteboxEnabled)
 *       → ratelimit.mjs(rateLimit — 前端错误上报限流)
 */

import fs from "node:fs";
import path from "node:path";
// node:timers 显式引入=全库既有约定（info.mjs:1/auth.mjs:34/timers.mjs:1 等 15 处同款）：
// 全局 setInterval 在 deno<2.7 返回 number 无 .unref，:259 顶层直崩（0719 内测包 2.6.10 实证）。
import { setInterval } from "node:timers";
import { __dirname, startTime } from "./base.mjs";
import { authenticate } from "../yonban/core/functions/security/auth.mjs";
import { getWhiteboxRing, isWhiteboxEnabled, setWhiteboxEnabled } from "./whitebox.mjs";
import { rateLimit } from "../scripts/ratelimit.mjs";
import { registerEnvCheckRoutes } from "./envCheck.mjs";

const LOG_DIR = path.join(__dirname, "data", "logs");
const MAX_MEMORY_ENTRIES = 1000;
const MAX_LOG_DAYS = 7;

// [0722 排雷] 原顶层 fs.mkdirSync(LOG_DIR)：import 期无 try 硬崩点。目录创建收敛到两个写点
//   自保（persistError/_slFlush 各自 try 内 mkdirSync，同 esmProxy.writeCache 范式），顶层删除。

// ── 结构化错误记录 ──────────────────────────────────

/** @type {Array<object>} */
const _errorBuffer = [];
let _errorIdCounter = 0;

function makeErrorEntry(level, module, message, opts = {}) {
  const entry = {
    id: `err_${Date.now()}_${++_errorIdCounter}`,
    timestamp: new Date().toISOString(),
    level,
    module: module || "unknown",
    route: opts.route || null,
    userId: opts.userId || null,
    message: typeof message === "string" ? message : String(message),
    stack: opts.stack || null,
    context: opts.context || null,
    source: opts.source || "server",
  };

  _errorBuffer.push(entry);
  if (_errorBuffer.length > MAX_MEMORY_ENTRIES) _errorBuffer.shift();

  persistError(entry);
  return entry;
}

// 同错指纹：message + stack 首行（与前端 base.mjs _reportError 去重键同口径）。
function errorFingerprint(entry) {
  const firstStackLine = (entry.stack || "").split("\n")[0] || "";
  return `${entry.message}|${firstStackLine}`;
}

// 在缓冲上构建聚合表：fingerprint -> { count, firstSeen(最早 timestamp) }。
function buildErrorAggregate(buffer) {
  const map = new Map();
  for (const e of buffer) {
    const fp = errorFingerprint(e);
    const cur = map.get(fp);
    if (cur) {
      cur.count++;
      if (e.timestamp < cur.firstSeen) cur.firstSeen = e.timestamp;
    } else {
      map.set(fp, { count: 1, firstSeen: e.timestamp });
    }
  }
  return map;
}

function persistError(entry) {
  try {
    const dateStr = entry.timestamp.slice(0, 10);
    const filePath = path.join(LOG_DIR, `errors-${dateStr}.jsonl`);
    fs.mkdirSync(LOG_DIR, { recursive: true }); // 写点自保（顶层 mkdir 已删，0722 排雷）
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (e) {
    // T021 留痕：错误落盘通道自身失败（磁盘满/权限）只能进 console——不可递归调 logError
    console.error("[monitor] errors jsonl 落盘失败:", e?.message || e);
  }
}

/**
 * 记录 error 级别结构化错误（进内存缓冲 + 落盘 JSONL）。
 *
 * 链路：调用方 → logError → makeErrorEntry → 内存环形缓冲 + persistError 磁盘落盘
 *
 * @param {string} module - 错误来源模块标识（如 'route'/'console'/'frontend'）。
 * @param {string} message - 错误消息。
 * @param {object} [opts] - 附加上下文。
 * @param {string} [opts.route] - 出错路由。
 * @param {string} [opts.userId] - 关联用户。
 * @param {string} [opts.stack] - 堆栈。
 * @param {object} [opts.context] - 任意上下文对象。
 * @param {string} [opts.source] - 来源标识（'server'/'frontend'）。
 * @returns {object} 生成的错误条目。
 */
export function logError(module, message, opts) {
  return makeErrorEntry("error", module, message, opts);
}
/**
 * 记录 warn 级别结构化警告。参数同 logError。
 * @param {string} module
 * @param {string} message
 * @param {object} [opts]
 * @returns {object}
 */
export function logWarn(module, message, opts) {
  return makeErrorEntry("warn", module, message, opts);
}
/**
 * 记录 info 级别结构化信息。参数同 logError。
 * @param {string} module
 * @param {string} message
 * @param {object} [opts]
 * @returns {object}
 */
export function logInfo(module, message, opts) {
  return makeErrorEntry("info", module, message, opts);
}

// ── console 拦截（整合 diagLogger 和 beilu-logger 的功能）────
const _origConsoleError = console.error;
const _origConsoleWarn = console.warn;
const _origConsoleLog = console.log;
const _origConsoleInfo = console.info;
const _origConsoleDebug = console.debug;

// ── 全量控制台镜像落盘（server-<date>.log）────────────
// why：错误级早已进 errors-*.jsonl，但启动序列/wb 追踪/请求行全是 log 级，此前只活在控制台——
// 窗口一关诊断证据全灭，排障只能靠用户截图（2026-07-19 exe 链排障教训：截图无时间戳、无上文）。
// 全级别加时间戳镜像到 data/logs/server-<date>.log（ANSI 剥离；批量 2s/200行 刷盘防高频 IO；
// 进程崩溃最多丢最后 2s——崩溃前的 error 级仍有 errors-*.jsonl 兜底）。轮转与 errors 同策略。
const _ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
let _slBuf = [];
let _slTimer = null;
// 本地时间（非 UTC）：日志要与用户的截图/体感时刻直接对得上（errors-*.jsonl 用 ISO 是机器消费,
// 本文件是人排障用——2026-07-19 实测 UTC 时间戳与截图差 9h 无法对照）。
function _localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function _flushServerLog() {
  if (_slTimer) { clearTimeout(_slTimer); _slTimer = null; }
  if (!_slBuf.length) return;
  const lines = _slBuf.join("\n") + "\n";
  _slBuf = [];
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `server-${_localDate()}.log`), lines);
  } catch { /* 落盘失败静默:禁止在此 console.*(会递归进 hook) */ }
}
function _serverLogAppend(level, args) {
  try {
    const msg = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack || a.message) : String(a))).join(" ");
    _slBuf.push(`${new Date().toTimeString().slice(0, 8)} [${level}] ${msg.replace(_ANSI_RE, "")}`);
    if (_slBuf.length >= 200) _flushServerLog();
    else if (!_slTimer) _slTimer = setTimeout(_flushServerLog, 2000);
  } catch { /* 同上 */ }
}

let _consoleHookInstalled = false;
/**
 * 拦截全局 console.error / console.warn → 自动写入错误缓冲 + 落盘 JSONL。
 * 幂等：多次调用只安装一次。原始 console 方法仍会正常输出到 stdout/stderr。
 *
 * 链路：web_server/index.mjs → installConsoleHook() → 之后全局 console.error/warn
 *        → makeErrorEntry → 内存缓冲 + 磁盘日志
 * 影响：替换全局 console.error / console.warn 实现（保留原始输出 + 额外写入监控缓冲）
 */
export function installConsoleHook() {
  if (_consoleHookInstalled) return;
  _consoleHookInstalled = true;

  console.error = (...args) => {
    _origConsoleError.apply(console, args);
    _serverLogAppend("error", args);
    const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    const stack = args.find((a) => a instanceof Error)?.stack || null;
    makeErrorEntry("error", "console", msg, { stack });
  };

  console.warn = (...args) => {
    _origConsoleWarn.apply(console, args);
    _serverLogAppend("warn", args);
    const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    makeErrorEntry("warn", "console", msg);
  };

  // log/info/debug：控制台原样输出 + 时间戳镜像落盘（不进 errors 监控缓冲——非错误级）。
  console.log = (...args) => { _origConsoleLog.apply(console, args); _serverLogAppend("log", args); };
  console.info = (...args) => { _origConsoleInfo.apply(console, args); _serverLogAppend("info", args); };
  console.debug = (...args) => { _origConsoleDebug.apply(console, args); _serverLogAppend("debug", args); };
}

// ── 路由统计 ─────────────────────────────────────────

const _routeStats = new Map();

function getRouteStat(route) {
  if (!_routeStats.has(route)) {
    _routeStats.set(route, { calls: 0, errors: 0, totalMs: 0, maxMs: 0 });
  }
  return _routeStats.get(route);
}

function recordRouteCall(route, durationMs, isError) {
  const stat = getRouteStat(route);
  stat.calls++;
  stat.totalMs += durationMs;
  if (durationMs > stat.maxMs) stat.maxMs = durationMs;
  if (isError) stat.errors++;
}

// ── asyncHandler 包装器 ──────────────────────────────

/**
 * Express 路由 handler 包装器：自动 try-catch + 路由调用统计 + 500 JSON 响应。
 * 被全项目路由 handler 引用——凡 async 路由 handler 均应通过此包装器注册。
 *
 * 链路：路由注册 → asyncHandler(fn) → Express 收到请求 → fn(req,res,next)
 *        → 成功：recordRouteCall(正常) → 继续
 *        → 异常：recordRouteCall(错误) + logError + 500 JSON 响应（含 errorId 供排障）
 *
 * @param {Function} fn - async (req, res, next) => void 路由处理函数。
 * @param {string} [routeName] - 自定义路由名（不提供则从 req.method + req.path 自动推断）。
 * @returns {Function} Express 中间件函数。
 */
export function asyncHandler(fn, routeName) {
  return async (req, res, next) => {
    const t0 = Date.now();
    const route = routeName || `${req.method} ${req.route?.path || req.path}`;
    try {
      await fn(req, res, next);
      recordRouteCall(route, Date.now() - t0, false);
    } catch (err) {
      const duration = Date.now() - t0;
      recordRouteCall(route, duration, true);
      logError("route", err.message || String(err), {
        route,
        stack: err.stack,
        userId: req.user?.username || null,
        context: { method: req.method, path: req.path, duration },
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: err.message || "Internal Server Error",
          errorId: _errorBuffer[_errorBuffer.length - 1]?.id,
        });
      }
    }
  };
}

// ── 插件状态追踪 ─────────────────────────────────────

const _pluginStatus = new Map();

/**
 * 上报插件运行状态（供 /api/v1/monitor/plugins 端点查询）。
 *
 * @param {string} name - 插件标识。
 * @param {string} status - 状态字符串（如 'ok'/'error'/'loading'）。
 * @param {string} [detail] - 附加描述。
 */
export function reportPluginStatus(name, status, detail) {
  _pluginStatus.set(name, {
    name,
    status,
    detail: detail || null,
    lastUpdate: new Date().toISOString(),
  });
}

// ── 日志轮转 ─────────────────────────────────────────

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) =>
      (f.startsWith("errors-") && f.endsWith(".jsonl")) || (f.startsWith("server-") && f.endsWith(".log")));
    const cutoff = Date.now() - MAX_LOG_DAYS * 86400000;
    for (const file of files) {
      const dateStr = file.replace("errors-", "").replace("server-", "").replace(".jsonl", "").replace(".log", "");
      const fileDate = new Date(dateStr).getTime();
      if (fileDate < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, file));
      }
    }
  } catch (_) {}
}

// 每小时清理一次旧日志
setInterval(cleanOldLogs, 3600000).unref();
cleanOldLogs();

// ── API 端点 ─────────────────────────────────────────

/**
 * 注册 /api/v1/monitor/* 端点族到给定 router 上。
 *
 * 约束：必须在 registerV1Routes 之前注册到 mainRouter——否则 v1 路由的 apiKeyAuth 全局中间件
 *   会拦截 /api/v1/monitor/errors/report（该端点需匿名可达，供登录前页面上报错误）。
 *
 * 端点清单：
 *   GET  /health — 健康检查（authenticate）
 *   GET  /errors — 查询错误日志 + 同错聚合（authenticate）
 *   GET  /stats — 运行时统计（authenticate）
 *   GET  /plugins — 插件状态（authenticate）
 *   GET  /routes — 路由统计（authenticate）
 *   GET  /whitebox — 白盒环读出（authenticate）
 *   POST /whitebox/toggle — 白盒开关（authenticate）
 *   POST /errors/report — 前端错误上报（匿名 + rateLimit 60/min/IP）
 *   GET  /logs/:date — 读磁盘日志（authenticate）
 *   GET  /logs — 日志文件列表（authenticate）
 *
 * @param {import('npm:express').Router} router - 要挂载端点的路由器（通常是 mainRouter）。
 */
export function registerMonitorRoutes(router) {
  registerEnvCheckRoutes(router, authenticate);
  // 聚合健康检查
  router.get("/api/v1/monitor/health", authenticate, (_req, res) => {
    const memUsage = process.memoryUsage();
    const recentErrors = _errorBuffer.filter(
      (e) => e.level === "error" && Date.now() - new Date(e.timestamp).getTime() < 300000,
    );

    res.json({
      status: recentErrors.length > 10 ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
      memory: {
        heapUsedMB: (memUsage.heapUsed / 1048576).toFixed(1),
        heapTotalMB: (memUsage.heapTotal / 1048576).toFixed(1),
        rssMB: (memUsage.rss / 1048576).toFixed(1),
      },
      errors: {
        last5min: recentErrors.length,
        totalBuffered: _errorBuffer.length,
      },
      plugins: Object.fromEntries(_pluginStatus),
      logDir: LOG_DIR,
    });
  });

  // 查询错误日志
  router.get("/api/v1/monitor/errors", authenticate, (req, res) => {
    const since = req.query.since ? new Date(req.query.since).getTime() : 0;
    const level = req.query.level || null;
    const module = req.query.module || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, MAX_MEMORY_ENTRIES);
    const source = req.query.source || null;
    const dedupe = req.query.dedupe === "1" || req.query.dedupe === "true";

    let filtered = _errorBuffer;
    if (since) filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= since);
    if (level) filtered = filtered.filter((e) => e.level === level);
    if (module) filtered = filtered.filter((e) => e.module === module);
    if (source) filtered = filtered.filter((e) => e.source === source);

    // 同错聚合：在查询边界对整个缓冲（非过滤子集）做一次权威聚合，
    // key = message + stack 首行。每条返回项附 count（该指纹累计出现次数）/firstSeen。
    // 缓冲是原始逐条日志，聚合只读不改写缓冲（单一权威派生，不污染落盘/installConsoleHook）。
    const aggregate = buildErrorAggregate(_errorBuffer);

    // dedupe=1（导出用）：同指纹折叠为一条，保留过滤集内最新出现的那条实体
    //   （filtered 按时间升序，Map 后写覆盖 = 留最新），count/firstSeen 仍取整缓冲权威聚合，
    //   lastSeen = 该指纹在过滤集内最后一次出现时间。面板列表路径不带 dedupe，行为不变。
    if (dedupe) {
      const byFp = new Map();
      for (const e of filtered) byFp.set(errorFingerprint(e), e);
      const folded = Array.from(byFp.values());
      const entries = folded.slice(-limit).reverse().map((e) => {
        const agg = aggregate.get(errorFingerprint(e));
        return agg ? { ...e, count: agg.count, firstSeen: agg.firstSeen, lastSeen: e.timestamp } : e;
      });
      return res.json({ total: folded.length, rawTotal: filtered.length, entries });
    }

    const entries = filtered.slice(-limit).reverse().map((e) => {
      const agg = aggregate.get(errorFingerprint(e));
      return agg ? { ...e, count: agg.count, firstSeen: agg.firstSeen } : e;
    });

    res.json({
      total: filtered.length,
      entries,
    });
  });

  // 运行时统计
  router.get("/api/v1/monitor/stats", authenticate, (_req, res) => {
    const memUsage = process.memoryUsage();
    const routeEntries = [];
    for (const [route, stat] of _routeStats) {
      routeEntries.push({
        route,
        calls: stat.calls,
        errors: stat.errors,
        errorRate: stat.calls > 0 ? (stat.errors / stat.calls * 100).toFixed(1) + "%" : "0%",
        avgMs: stat.calls > 0 ? (stat.totalMs / stat.calls).toFixed(0) : 0,
        maxMs: stat.maxMs,
      });
    }
    routeEntries.sort((a, b) => b.calls - a.calls);

    res.json({
      uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
      startTime: startTime.toISOString(),
      memory: {
        heapUsedMB: (memUsage.heapUsed / 1048576).toFixed(1),
        rssMB: (memUsage.rss / 1048576).toFixed(1),
      },
      errorBuffer: {
        size: _errorBuffer.length,
        maxSize: MAX_MEMORY_ENTRIES,
        errorCount: _errorBuffer.filter((e) => e.level === "error").length,
        warnCount: _errorBuffer.filter((e) => e.level === "warn").length,
      },
      routes: routeEntries,
      plugins: Object.fromEntries(_pluginStatus),
    });
  });

  // 插件状态（匿名可达：该端点只返回插件名+状态文本，无敏感数据。
  //   根因修复：此前挂 authenticate → 崩溃波及认证链时返回 401 →
  //   前端 pollPartLoadErrors 静默 return → 监控面板零信号。
  //   改为 rateLimit 防灌，与 errors/report 同策略）
  router.get("/api/v1/monitor/plugins", rateLimit({ maxRequests: 60, windowMs: "1m" }), (_req, res) => {
    res.json({
      plugins: Object.fromEntries(_pluginStatus),
      count: _pluginStatus.size,
    });
  });

  // 路由统计
  router.get("/api/v1/monitor/routes", authenticate, (_req, res) => {
    const entries = [];
    for (const [route, stat] of _routeStats) {
      entries.push({
        route,
        ...stat,
        errorRate: stat.calls > 0 ? (stat.errors / stat.calls * 100).toFixed(1) + "%" : "0%",
        avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
      });
    }
    entries.sort((a, b) => b.errors - a.errors || b.calls - a.calls);
    res.json({ routes: entries });
  });

  // 白盒线路追踪环读出（断点①修复）：此前 server/whitebox.mjs RING 只走 console+广播，
  // 无 HTTP 出口，导出/离线分析拿不到回合外(chatid=null)的后端线路。此端点是 RING 的权威读出口。
  router.get("/api/v1/monitor/whitebox", authenticate, (_req, res) => {
    const ring = getWhiteboxRing();
    res.json({ enabled: isWhiteboxEnabled(), total: ring.length, ring });
  });

  // 白盒开关（断点②修复）：setWhiteboxEnabled 此前无任何调用方，_enabled 恒 true 无法关。
  router.post("/api/v1/monitor/whitebox/toggle", authenticate, (req, res) => {
    setWhiteboxEnabled(!!req.body?.enabled);
    res.json({ enabled: isWhiteboxEnabled() });
  });

  // 前端错误上报：匿名可达——登录前页面(pages/base.mjs _reportError 监听 window.error/unhandledrejection)
  //   的未捕获异常也要能上报，故刻意不挂 authenticate。但"匿名 + 每请求 appendFileSync 落盘(persistError)"
  //   在 server 多用户部署下可被远端灌盘(DoS)。框架级收口（复用既有原语，不改匿名契约）：
  //     ① rateLimit 按 IP 限流——本地 IP 自动放行(ratelimit.mjs:76)，本机前端上报不受影响；
  //        server 模式下远端封顶 60/min/IP。
  //     ② message/stack 落盘前长度封顶，杜绝单条超大 payload 撑爆日志。
  router.post("/api/v1/monitor/errors/report", rateLimit({ maxRequests: 60, windowMs: "1m" }), (req, res) => {
    const { message, stack, url, line, col, userAgent, chatid } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });

    const entry = makeErrorEntry("error", "frontend", String(message).slice(0, 2000), {
      stack: stack ? String(stack).slice(0, 8000) : null,
      source: "frontend",
      userId: req.user?.username || null,
      // [多线归属 0726] 补 chatid（base.mjs 上报侧同批加）：多线并行时原条目只有 url，
      //   分不开是哪条线出的错。形态与前端 _CHATID_RE 同规则（上报侧已校验），此处只做长度兜底。
      context: { url, line, col, userAgent, chatid: chatid ? String(chatid).slice(0, 32) : null },
    });

    res.json({ ok: true, errorId: entry.id });
  });

  // 读取磁盘日志文件
  router.get("/api/v1/monitor/logs/:date", authenticate, (req, res) => {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "Invalid date format, use YYYY-MM-DD" });
    }
    const filePath = path.join(LOG_DIR, `errors-${dateStr}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return res.json({ date: dateStr, entries: [] });
    }
    try {
      const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
      const entries = lines.map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
      res.json({ date: dateStr, count: entries.length, entries });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 日志文件列表
  router.get("/api/v1/monitor/logs", authenticate, (_req, res) => {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter((f) => f.startsWith("errors-") && f.endsWith(".jsonl"))
        .map((f) => {
          const full = path.join(LOG_DIR, f);
          const stat = fs.statSync(full);
          return {
            file: f,
            date: f.replace("errors-", "").replace(".jsonl", ""),
            sizeKB: (stat.size / 1024).toFixed(1),
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
      res.json({ logs: files });
    } catch (err) {
      res.json({ logs: [], error: err.message });
    }
  });
}
