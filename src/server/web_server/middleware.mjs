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
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
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

  // ★ 高频轮询路径过滤：eye/files 等轮询接口每几秒一次，不逐条打印
  const HIGH_FREQ_PATH_PATTERNS = [
    /\/api\/eye\/status/,
    /\/api\/parts\/plugins:beilu-files\/config\/setdata/,
    /\/api\/user-plugins\/status/,
    /\/api\/parts\/plugins:beilu-memory\/config\/(getdata|setdata)/,
    /\/api\/parts\/plugins:beilu-preset\/config\/(runtime-params|setdata|getdata)/,
    /\/api\/parts\/shells:chat\/[^/]+\/fake-send/,
    /\/api\/getdetails\//,
    /\/api\/parts\/shells:chat\/[^/]+\/log/,
    // ── 2026-06-25 追加：调查报告 P0/P1 高频轮询 + 静态资源 ──
    /\/api\/parts\/shells:chat\/groups/,        // groupRuntimePanel 4s轮询（含 groups/engine）
    /\/api\/eye\/getdata/,                      // eye 监控数据轮询
    /\/api\/v1\/monitor\/plugins/,              // backendMonitor 面板周期轮询
    /\/api\/parts\/shells:chat\/getchatlist/,   // 聊天列表查询
    /^\/(esm-cache)\//,                         // ESM 缓存代理请求（冷启动 ~231 行）
    /^\/(public|pages|assets)\//,               // 静态资源目录
    /\.(mjs|js|css|html|woff2?|ttf|svg|png|jpg|ico)(\?|$)/,  // 静态资源扩展名
    // ── 2026-07-05 追加（dispatch 刷屏事故根修）：中间站桥统一入口 ──
    //   根因=迁移脱节（半链）：T6b（2026-07-02 sendAction.mjs）把 beilu-memory/browser/preset 等原走
    //   REST 的高频轮询（getData/getMemoryAIOutput/getRuntimeParams/consumeBrowser 等，2~3s 一次 + 切卡/切模式
    //   十余监听者 fan-out）统一切桥到 POST /api/yonban/dispatch。但本白名单当初只匹配它们的【旧 REST 路径】
    //   （:158/:161/:162），dispatch 桥入口未纳入 → 所有轮询请求全经此单点、全部逐条打印 → 控制台高频刷屏
    //   （凛倾 2026-07-05 19:27 实测：无间隔感的连续 requestReceived）。非自激励环、非 interval 叠加、非逻辑 bug，
    //   前端事件环与全部走 dispatch 的 setInterval 均已核为收敛/有防重闸（poll:57/memoryai:185/eye:223/companion:397/
    //   fileExplorer:1673 等），char-changed↔loadCharInfo 有 _loadedCharId+_skipCharChangedEvent 双防重。
    //   静默整个桥入口=与旧 REST 轮询路径入白名单同构决策（切桥前这些写/读路径本就在本表被静默）；桥请求可观测性
    //   由 wbSpan 白盒埋点承担（yonban_bridge.mjs:7，backendMonitor 面板可见），不依赖本条 requestReceived。
    //   代价：低频写 verb（addRouteNote/setActiveSubMode 等）也不再打印于此——如需按 verb 精筛可见性，
    //   后续把本日志中间件下移到 express.json(:188) 之后读 req.body.verb 精确静默高频只读 verb（框架级增强，非本次事故最小修范围）。
    /^\/api\/yonban\/dispatch/,                 // 中间站桥：所有过桥 verb 的统一 dispatch 入口（高频轮询主力已全切此路）
    // ── 2026-07-22 追加(凛倾"无限制重复和噪音"实拍刷屏):桌宠 Electron 端 orbPollSec(默认3s)节律轮询——
    //   显示同步(pet-settings GET,含?raw=1)+AI消息拉取(orb-consume)+托盘/滚轮回写(pet-settings POST 停轮防抖),
    //   加 web 陪伴面板 discordbot 运行清单轮询。均为已知节律请求,逐条打印=噪音;可观测性走 :204 diag.debug 通道。
    /\/api\/eye\/pet-settings/,
    /\/api\/eye\/orb-consume/,
    /\/api\/parts\/shells:discordbot\/getrunningbotlist/,
  ];

  router.use((req, res, next) => {
    res.setHeader("X-Powered-By", info.xPoweredBy);
    const isHighFreq = HIGH_FREQ_PATH_PATTERNS.some((p) => p.test(req.path));
    if (!req.path.endsWith("/heartbeat") && !isHighFreq)
      console.logI18n("beiluConsole.web.requestReceived", {
        method: req.method + " ".repeat(Math.max(0, 8 - req.method.length)),
        url: req.url.replace(/beilu-apikey=[^&]*/, "beilu-apikey=45450721"),
      });
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
